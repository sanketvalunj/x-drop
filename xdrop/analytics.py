"""Network analytics: record every xdrop record ("packet") on the wire and explain it.

What is *measured* (real data from this process / the OS):
  * every encrypted xdrop frame sent or received: type, plaintext size,
    ciphertext size, frame size, timing, the real 16-byte frame header
    (nonce + length), the GCM authentication tag, and a ciphertext preview;
  * control messages (offer / response / done / ack) in readable JSON —
    they are your own metadata (file name, size, SHA-256), never file bytes;
  * kernel TCP counters for the connection where the OS exposes them
    (Linux ``TCP_INFO``, macOS ``TCP_CONNECTION_INFO``): MSS, RTT,
    segments/packets sent and received, retransmissions, congestion window;
  * the network path: local interface, default gateway, peer MAC (ARP).

What is *estimated* (clearly labelled in the UI):
  * how one frame is cut into TCP segments, IP packets and Wi-Fi/Ethernet
    frames, using the measured MSS and standard header sizes. TCP is a byte
    stream, so the OS may split or merge records differently.

No raw packet capture (pcap) and no admin/root rights are needed.
"""
from __future__ import annotations

import ipaddress
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
from collections import Counter, deque
from typing import Dict, List, Optional

from .logger import get_logger

log = get_logger("analytics")

# Standard header sizes (bytes) used for the encapsulation estimate.
IPV4_HEADER = 20
TCP_BASE_HEADER = 20
ETHERNET_HEADER = 14 + 4           # MAC header + FCS
WIFI_HEADER = 26 + 8 + 4           # 802.11 QoS data header + LLC/SNAP + FCS
DEFAULT_MTU = 1500
DEFAULT_MSS = 1460

KEEP_FIRST = 200        # first N records of every transfer are always kept
KEEP_RECENT = 300       # plus a rolling window of the most recent ones
TIMELINE_BUCKET_S = 0.25


# ---------------------------------------------------------------------------
# Kernel TCP statistics
# ---------------------------------------------------------------------------

def socket_mss(sock: socket.socket) -> Optional[int]:
    try:
        if hasattr(socket, "TCP_MAXSEG"):
            value = sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG)
            if 88 <= value <= 65495:
                return int(value)
    except OSError:
        pass
    return None


def tcp_kernel_stats(sock: socket.socket) -> Optional[dict]:
    """Read real per-connection TCP counters from the OS (Linux / macOS)."""
    try:
        if sys.platform.startswith("linux"):
            raw = sock.getsockopt(socket.IPPROTO_TCP, getattr(socket, "TCP_INFO", 11), 256)
            if len(raw) < 104:
                return None
            u32 = lambda off: struct.unpack_from("=I", raw, off)[0]
            u64 = lambda off: struct.unpack_from("=Q", raw, off)[0] if len(raw) >= off + 8 else None
            stats = {
                "source": "Linux TCP_INFO",
                "state": raw[0],
                "rto_ms": u32(8) / 1000,
                "snd_mss": u32(16),
                "rcv_mss": u32(20),
                "unacked": u32(24),
                "lost": u32(32),
                "retrans_now": u32(36),
                "pmtu": u32(60),
                "rtt_ms": u32(68) / 1000,
                "rttvar_ms": u32(72) / 1000,
                "snd_cwnd": u32(80),
                "advmss": u32(84),
                "total_retrans": u32(100),
            }
            if len(raw) >= 144:
                stats.update({
                    "bytes_acked": u64(120),
                    "bytes_received": u64(128),
                    "segs_out": u32(136),
                    "segs_in": u32(140),
                })
            return stats
        if sys.platform == "darwin":
            raw = sock.getsockopt(socket.IPPROTO_TCP, 0x106, 112)  # TCP_CONNECTION_INFO
            if len(raw) < 112:
                return None
            u32 = lambda off: struct.unpack_from("=I", raw, off)[0]
            u64 = lambda off: struct.unpack_from("=Q", raw, off)[0]
            return {
                "source": "macOS TCP_CONNECTION_INFO",
                "state": raw[0],
                "rto_ms": u32(16),
                "snd_mss": u32(20),
                "rcv_mss": u32(20),
                "snd_cwnd": u32(28),
                "snd_wnd": u32(32),
                "rcv_wnd": u32(40),
                "rtt_ms": u32(48),          # smoothed RTT
                "rttvar_ms": u32(52),
                "segs_out": u64(56),
                "bytes_acked": u64(64),
                "retrans_bytes": u64(72),
                "segs_in": u64(80),
                "bytes_received": u64(88),
                "total_retrans": u64(104),
            }
    except (OSError, struct.error, ValueError):
        return None
    return None  # Windows does not expose these counters to Python


# ---------------------------------------------------------------------------
# Path discovery (gateway, ARP)
# ---------------------------------------------------------------------------

def _run(cmd: List[str], timeout: float = 3.0) -> str:
    exe = shutil.which(cmd[0])
    if not exe:
        return ""
    try:
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.run([exe, *cmd[1:]], capture_output=True, text=True, timeout=timeout, check=False, **kwargs)
        return (out.stdout or "") + "\n" + (out.stderr or "")
    except (OSError, subprocess.TimeoutExpired):
        return ""


_MAC_RE = re.compile(r"([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}")
_IP_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")


def default_gateway() -> Optional[str]:
    if sys.platform.startswith("linux"):
        text = _run(["ip", "-4", "route", "show", "default"])
        m = re.search(r"default via (\S+)", text)
        return m.group(1) if m else None
    if sys.platform == "darwin":
        text = _run(["route", "-n", "get", "default"])
        m = re.search(r"gateway:\s*(\S+)", text)
        return m.group(1) if m else None
    if os.name == "nt":
        text = _run(["route", "print", "-4", "0.0.0.0"])
        m = re.search(r"^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)", text, re.M)
        return m.group(1) if m else None
    return None


def arp_lookup(ip: str) -> Optional[str]:
    """Return the peer's MAC address from the OS neighbour (ARP) table."""
    try:
        ipaddress.IPv4Address(ip)
    except ValueError:
        return None
    if sys.platform.startswith("linux"):
        text = _run(["ip", "neigh", "show", ip]) or _run(["arp", "-n", ip])
    elif os.name == "nt":
        text = _run(["arp", "-a", ip])
    else:
        text = _run(["arp", "-n", ip])
    for line in text.splitlines():
        if ip in line:
            m = _MAC_RE.search(line)
            if m:
                mac = m.group(0).replace("-", ":").lower()
                return ":".join(part.zfill(2) for part in mac.split(":"))
    return None


def interface_for(ip: Optional[str], interfaces: List[dict]) -> Optional[dict]:
    if not ip:
        return None
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return None
    for iface in interfaces:
        if addr in ipaddress.IPv4Network(iface["network"]):
            return iface
    return None


def network_path(local_ip: Optional[str], remote_ip: Optional[str], interfaces: List[dict]) -> dict:
    """Describe the hop-by-hop path a packet takes between this device and the peer."""
    iface = interface_for(remote_ip, interfaces)
    gateway = default_gateway()
    mac = arp_lookup(remote_ip) if remote_ip else None
    same_link = iface is not None
    src_ip = (iface or {}).get("ip") or local_ip
    hops = [{
        "kind": "source", "title": "This device", "ip": src_ip,
        "detail": f"Interface {(iface or {}).get('name', 'default')} · {(iface or {}).get('network', 'unknown subnet')}",
    }]
    if same_link:
        ap = gateway if gateway and interface_for(gateway, [iface]) else None
        hops.append({
            "kind": "switch", "title": "Wi-Fi access point / hotspot", "ip": ap,
            "detail": "Same subnet: frames are forwarded at Layer 2 (MAC addresses). "
                      "No IP router hop, the IP TTL is not decreased.",
        })
    else:
        hops.append({
            "kind": "router", "title": "Default gateway (router)", "ip": gateway,
            "detail": "Peer is on a different subnet, so packets are routed at Layer 3.",
        })
    hops.append({
        "kind": "destination", "title": "Peer device", "ip": remote_ip,
        "detail": f"MAC {mac}" if mac else "MAC not in the ARP table yet",
        "mac": mac,
    })
    return {"same_link": same_link, "gateway": gateway, "peer_mac": mac,
            "interface": iface, "hops": hops}


# ---------------------------------------------------------------------------
# Per-transfer recorder
# ---------------------------------------------------------------------------

def encapsulation(frame_bytes: int, mss: int, link: str = "wifi") -> dict:
    """Estimate how one xdrop frame is carried by TCP, IPv4 and the link layer."""
    mss = max(88, int(mss or DEFAULT_MSS))
    tcp_header = max(TCP_BASE_HEADER, DEFAULT_MTU - IPV4_HEADER - mss) if mss <= DEFAULT_MTU - 40 else TCP_BASE_HEADER
    segments = max(1, -(-frame_bytes // mss))
    link_header = WIFI_HEADER if link == "wifi" else ETHERNET_HEADER
    per_packet = tcp_header + IPV4_HEADER + link_header
    return {
        "mss": mss, "tcp_header": tcp_header, "ip_header": IPV4_HEADER, "link_header": link_header,
        "segments": segments, "last_segment_payload": frame_bytes - (segments - 1) * mss,
        "header_overhead": segments * per_packet,
        "wire_bytes": frame_bytes + segments * per_packet,
    }


class PacketRecorder:
    """Record every xdrop frame of one connection plus kernel TCP counters."""

    def __init__(self, transfer_id: str = "", role: str = "sender") -> None:
        self.transfer_id = transfer_id
        self.role = role
        self.started_at = time.time()
        self.lock = threading.Lock()
        self.sequence = 0
        self.first: List[dict] = []
        self.recent: deque = deque(maxlen=KEEP_RECENT)
        self.total = Counter()
        self.by_type: Dict[tuple, Counter] = {}
        self.chunk_sizes: Counter = Counter()
        self.timeline: Dict[int, Counter] = {}
        self.sock: Optional[socket.socket] = None
        self.mss: Optional[int] = None
        self.local: Optional[tuple] = None
        self.remote: Optional[tuple] = None
        self.tcp_start: Optional[dict] = None
        self.tcp_last: Optional[dict] = None
        self.tcp_samples: deque = deque(maxlen=240)
        self._last_sample = 0.0
        self.finished_at: Optional[float] = None
        self.listeners: List = []   # callables(record) – e.g. the global live feed

    # ---- socket ----------------------------------------------------------
    def attach_socket(self, sock: socket.socket) -> None:
        self.sock = sock
        try:
            self.local = sock.getsockname()[:2]
            self.remote = sock.getpeername()[:2]
        except OSError:
            pass
        self.mss = socket_mss(sock)
        self.tcp_start = tcp_kernel_stats(sock)
        self.tcp_last = self.tcp_start

    def sample_tcp(self, force: bool = False) -> None:
        if not self.sock:
            return
        now = time.time()
        if not force and now - self._last_sample < 0.5:
            return
        self._last_sample = now
        stats = tcp_kernel_stats(self.sock)
        if stats:
            self.tcp_last = stats
            self.tcp_samples.append({"t": round(now - self.started_at, 3),
                                     "rtt_ms": stats.get("rtt_ms"), "cwnd": stats.get("snd_cwnd"),
                                     "segs_out": stats.get("segs_out"), "segs_in": stats.get("segs_in"),
                                     "retrans": stats.get("total_retrans")})
        mss = socket_mss(self.sock)
        if mss:
            self.mss = mss

    def finish(self) -> None:
        self.sample_tcp(force=True)
        self.finished_at = time.time()
        self.sock = None

    # ---- frames ----------------------------------------------------------
    def record(self, event: dict) -> None:
        direction = str(event.get("direction", "unknown"))
        record_type = str(event.get("record_type", "record"))
        plaintext = max(0, int(event.get("plaintext_bytes", 0)))
        ciphertext = max(0, int(event.get("ciphertext_bytes", 0)))
        frame_bytes = max(0, int(event.get("frame_bytes", 0)))
        overhead = max(0, int(event.get("overhead_bytes", 0)))
        stamp = float(event.get("timestamp", time.time()))
        enc = encapsulation(frame_bytes, self.mss or DEFAULT_MSS)
        with self.lock:
            self.sequence += 1
            item = {
                "sequence": self.sequence,
                "time_ms": round(max(0.0, stamp - self.started_at) * 1000, 2),
                "timestamp": stamp,
                "direction": direction,
                "record_type": record_type,
                "plaintext_bytes": plaintext,
                "ciphertext_bytes": ciphertext,
                "frame_bytes": frame_bytes,
                "overhead_bytes": overhead,
                "encrypted": bool(event.get("encrypted")),
                "tcp_segments_est": enc["segments"],
                "wire_bytes_est": enc["wire_bytes"],
                "mss": enc["mss"],
                "header_hex": event.get("header_hex"),
                "tag_hex": event.get("tag_hex"),
                "cipher_preview_hex": event.get("cipher_preview_hex"),
                "raw_hex": event.get("raw_hex"),
                "control": event.get("control"),
                "src": f"{self.local[0]}:{self.local[1]}" if self.local else None,
                "dst": f"{self.remote[0]}:{self.remote[1]}" if self.remote else None,
            }
            if direction == "received" and self.local and self.remote:
                item["src"], item["dst"] = item["dst"], item["src"]
            if len(self.first) < KEEP_FIRST:
                self.first.append(item)
            else:
                self.recent.append(item)
            self.total.update({
                "records": 1, "plaintext_bytes": plaintext, "ciphertext_bytes": ciphertext,
                "frame_bytes": frame_bytes, "overhead_bytes": overhead,
                "encrypted_records": int(item["encrypted"]),
                "tcp_segments_est": enc["segments"], "wire_bytes_est": enc["wire_bytes"],
                f"{direction}_records": 1, f"{direction}_frame_bytes": frame_bytes,
            })
            counter = self.by_type.setdefault((direction, record_type), Counter())
            counter.update({"records": 1, "plaintext_bytes": plaintext, "ciphertext_bytes": ciphertext,
                            "frame_bytes": frame_bytes, "overhead_bytes": overhead,
                            "tcp_segments_est": enc["segments"]})
            if record_type == "file_chunk":
                self.chunk_sizes[plaintext] += 1
            bucket = int((stamp - self.started_at) / TIMELINE_BUCKET_S)
            self.timeline.setdefault(bucket, Counter()).update({f"{direction}_bytes": frame_bytes, "records": 1})
        self.sample_tcp()
        for listener in list(self.listeners):
            try:
                listener(self.transfer_id, item)
            except Exception:
                pass

    # ---- reporting -------------------------------------------------------
    def records(self, offset: int = 0, limit: int = 200, record_type: str = "", direction: str = "") -> dict:
        with self.lock:
            rows = self.first + list(self.recent)
            dropped = self.sequence - len(rows)
        if record_type:
            rows = [r for r in rows if r["record_type"] == record_type]
        if direction:
            rows = [r for r in rows if r["direction"] == direction]
        return {"rows": rows[offset: offset + limit], "total": len(rows), "dropped": max(0, dropped)}

    def snapshot(self, include_rows: bool = True) -> dict:
        with self.lock:
            totals = dict(self.total)
            by_type = [{"direction": d, "record_type": t, **dict(v)} for (d, t), v in sorted(self.by_type.items())]
            chunk_sizes = [{"plaintext_bytes": a, "records": c} for a, c in sorted(self.chunk_sizes.items())]
            timeline = [{"t": round(k * TIMELINE_BUCKET_S, 2), **dict(v)} for k, v in sorted(self.timeline.items())]
            rows = (self.first + list(self.recent)) if include_rows else []
            sequence = self.sequence
        tcp = None
        if self.tcp_last:
            tcp = {"start": self.tcp_start, "last": self.tcp_last, "samples": list(self.tcp_samples)}
            start, last = self.tcp_start or {}, self.tcp_last
            for key in ("segs_out", "segs_in", "total_retrans", "bytes_acked", "bytes_received"):
                if last.get(key) is not None and start.get(key) is not None:
                    tcp[f"delta_{key}"] = last[key] - start[key]
        duration = (self.finished_at or time.time()) - self.started_at
        return {
            "role": self.role,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_s": round(duration, 3),
            "mss": self.mss or DEFAULT_MSS,
            "mss_measured": self.mss is not None,
            "local": f"{self.local[0]}:{self.local[1]}" if self.local else None,
            "remote": f"{self.remote[0]}:{self.remote[1]}" if self.remote else None,
            "totals": totals,
            "by_type": by_type,
            "chunk_sizes": chunk_sizes,
            "timeline": timeline,
            "tcp": tcp,
            "recent_records": rows,
            "records_total": sequence,
            "records_kept": len(rows) if include_rows else None,
            "sample_limit": KEEP_FIRST + KEEP_RECENT,
            "constants": {"ipv4_header": IPV4_HEADER, "tcp_base_header": TCP_BASE_HEADER,
                          "wifi_header": WIFI_HEADER, "ethernet_header": ETHERNET_HEADER, "mtu": DEFAULT_MTU},
        }


class PacketHub:
    """Global live feed of records across all transfers (for the Packets page)."""

    def __init__(self, maxlen: int = 400) -> None:
        self.lock = threading.Lock()
        self.feed: deque = deque(maxlen=maxlen)
        self.counter = Counter()
        self.recorders: Dict[str, PacketRecorder] = {}

    def register(self, transfer_id: str, recorder: PacketRecorder, label: str = "") -> PacketRecorder:
        recorder.transfer_id = transfer_id
        recorder.label = label  # type: ignore[attr-defined]
        recorder.listeners.append(self._on_record)
        with self.lock:
            self.recorders[transfer_id] = recorder
            if len(self.recorders) > 150:
                for key in list(self.recorders)[:len(self.recorders) - 150]:
                    self.recorders.pop(key, None)
        return recorder

    def get(self, transfer_id: str) -> Optional[PacketRecorder]:
        with self.lock:
            return self.recorders.get(transfer_id)

    def forget(self, transfer_id: str) -> None:
        with self.lock:
            self.recorders.pop(transfer_id, None)

    def _on_record(self, transfer_id: str, item: dict) -> None:
        with self.lock:
            self.feed.append({**item, "transfer_id": transfer_id,
                              "label": getattr(self.recorders.get(transfer_id), "label", "")})
            self.counter.update({"records": 1, "frame_bytes": item["frame_bytes"],
                                 "wire_bytes_est": item["wire_bytes_est"],
                                 "tcp_segments_est": item["tcp_segments_est"],
                                 f"type:{item['record_type']}": 1,
                                 f"dir:{item['direction']}": 1})

    def snapshot(self, since: int = 0) -> dict:
        with self.lock:
            feed = [r for r in self.feed if r["timestamp"] * 1000 > since] if since else list(self.feed)
            counter = dict(self.counter)
            transfers = [{"id": k, "label": getattr(r, "label", ""), "role": r.role,
                          "records": r.sequence, "started_at": r.started_at, "finished_at": r.finished_at}
                         for k, r in self.recorders.items()]
        return {"feed": feed, "totals": counter, "transfers": transfers}
