"""Peer discovery layer: find xdrop devices on a LAN and parse direct endpoints.

Three discovery methods run side by side, because hotspots and campus Wi-Fi
often block one or more of them:

1. **mDNS / zeroconf** — advertises ``_xdrop._tcp.local.`` on *every* IPv4
   interface. Works on most home routers. Phone hotspots frequently drop
   multicast between clients, so it is not enough on its own.
2. **UDP broadcast beacons** — every few seconds each device broadcasts a tiny
   JSON "hello" on UDP port 47475 to 255.255.255.255 *and* to every
   interface's directed broadcast address (e.g. 192.168.43.255). Any device
   that hears it replies directly (unicast), so discovery still works when
   only one side's broadcast gets through.
3. **Subnet scan** — if nothing was found after a few seconds (or when the
   user presses *Scan network*), every address in the local /24 is probed on
   the xdrop TCP port. If a TCP connection works, file transfer will work too,
   so this is the most reliable fallback on locked-down hotspots.

Results from all three are merged into one peer list (deduplicated by a
per-run instance id or by ``ip:port``).
"""
from __future__ import annotations

import ipaddress
import json
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

try:
    from zeroconf import IPVersion, InterfaceChoice, ServiceBrowser, ServiceInfo, ServiceListener, Zeroconf
    HAS_ZEROCONF = True
except ImportError:
    HAS_ZEROCONF = False
    IPVersion = None  # type: ignore
    InterfaceChoice = None  # type: ignore
    ServiceBrowser = None  # type: ignore
    ServiceInfo = None  # type: ignore
    ServiceListener = object  # type: ignore
    Zeroconf = None  # type: ignore

from .logger import get_logger

log = get_logger("discovery")

SERVICE_TYPE = "_xdrop._tcp.local."
DEFAULT_TRANSFER_PORT = 47474      # keep in sync with transfer.DEFAULT_RECEIVER_PORT
BEACON_PORT = 47475                # UDP broadcast discovery port
BEACON_INTERVAL_S = 2.0            # how often a hello is broadcast
BEACON_TTL_S = 9.0                 # a beacon peer is "online" this long after its last hello
SCAN_TTL_S = 75.0                  # a scanned peer is "online" this long after it answered
AUTO_SCAN_DELAY_S = 5.0            # first automatic subnet scan if nothing was found
AUTO_SCAN_INTERVAL_S = 30.0        # repeat the automatic scan while no peers are visible
SCAN_CONNECT_TIMEOUT_S = 0.45
SCAN_WORKERS = 64
MAX_SCAN_HOSTS = 1024              # never sweep more than this many addresses


def _service_key(name: str) -> str:
    """Canonical key for a DNS service name (DNS names are case-insensitive)."""
    return name.rstrip(".").casefold()


@dataclass
class Peer:
    name: str           # human-readable device name
    service: str        # unique key (zeroconf service name, or "beacon-…"/"scan-…")
    address: str        # IPv4 string
    port: int
    last_seen: float = 0.0
    online: bool = True
    via: str = "mdns"   # which discovery method(s) found it: mdns, broadcast, scan, direct
    instance_id: Optional[str] = None

    @property
    def endpoint(self) -> str:
        return f"{self.address}:{self.port}"


# ---------------------------------------------------------------------------
# Interface helpers
# ---------------------------------------------------------------------------

def _primary_ipv4() -> Optional[str]:
    """Best-effort guess of the LAN IPv4 address (no packets actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return None
    finally:
        s.close()


def local_interfaces() -> List[dict]:
    """Return usable IPv4 interfaces: name, ip, prefix, network, broadcast."""
    result: List[dict] = []
    seen: set = set()
    try:
        import ifaddr  # dependency of zeroconf

        for adapter in ifaddr.get_adapters():
            for item in adapter.ips:
                if not item.is_IPv4:
                    continue
                try:
                    addr = ipaddress.IPv4Address(item.ip)
                except ValueError:
                    continue
                if addr.is_loopback or addr.is_link_local or addr.is_unspecified or addr.is_multicast:
                    continue
                if str(addr) in seen:
                    continue
                seen.add(str(addr))
                prefix = int(item.network_prefix or 24)
                net = ipaddress.IPv4Network(f"{addr}/{prefix}", strict=False)
                result.append({
                    "name": str(adapter.nice_name or adapter.name),
                    "ip": str(addr),
                    "prefix": prefix,
                    "network": str(net),
                    "broadcast": str(net.broadcast_address) if prefix < 31 else None,
                })
    except Exception as e:
        log.debug(f"Unable to enumerate local IPv4 interfaces: {e}")
    if not result:
        fallback = _primary_ipv4()
        if fallback and not fallback.startswith("127."):
            net = ipaddress.IPv4Network(f"{fallback}/24", strict=False)
            result.append({"name": "default", "ip": fallback, "prefix": 24,
                           "network": str(net), "broadcast": str(net.broadcast_address)})
    primary = _primary_ipv4()
    result.sort(key=lambda i: (i["ip"] != primary, i["ip"]))
    return result


def _local_ipv4_details() -> Tuple[List[str], List[ipaddress.IPv4Network]]:
    interfaces = local_interfaces()
    return ([i["ip"] for i in interfaces],
            [ipaddress.IPv4Network(i["network"]) for i in interfaces])


def _choose_peer_address(
    addresses: List[str], local_networks: List[ipaddress.IPv4Network], preferred_local_ip: Optional[str] = None,
) -> Optional[str]:
    """Prefer the peer address that shares a subnet with one of our interfaces."""
    usable: List[str] = []
    for raw in addresses:
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if addr.version == 4 and not (addr.is_loopback or addr.is_link_local or addr.is_unspecified or addr.is_multicast):
            usable.append(str(addr))
    preferred_network = None
    if preferred_local_ip:
        try:
            preferred = ipaddress.ip_address(preferred_local_ip)
            preferred_network = next((n for n in local_networks if preferred in n), None)
        except ValueError:
            pass
    if preferred_network:
        for address in usable:
            if ipaddress.ip_address(address) in preferred_network:
                return address
    for address in usable:
        if any(ipaddress.ip_address(address) in n for n in local_networks):
            return address
    return usable[0] if usable else None


def _scan_targets(interfaces: List[dict]) -> List[str]:
    """Hosts to probe: each interface's subnet, clamped to the /24 around our IP."""
    targets: List[str] = []
    own = {i["ip"] for i in interfaces}
    for iface in interfaces:
        prefix = iface["prefix"]
        net = ipaddress.IPv4Network(f"{iface['ip']}/{max(prefix, 24)}", strict=False)
        if net.num_addresses > 2 and not net.is_private:
            continue  # never sweep public address space
        for host in net.hosts():
            text = str(host)
            if text not in own and text not in targets:
                targets.append(text)
            if len(targets) >= MAX_SCAN_HOSTS:
                return targets
    return targets


def parse_peer_endpoint(endpoint: str, default_port: int) -> Optional[Peer]:
    """Parse a manual IP or IP:port string into a Peer object for direct transfers.

    Supports:
      - '192.168.1.10' (uses default_port)
      - '192.168.1.10:54321'
      - 'localhost:5000'
    """
    raw = (endpoint or "").strip()
    if not raw:
        return None

    port = default_port
    if ":" in raw:
        parts = raw.rsplit(":", 1)
        addr = parts[0].strip()
        try:
            port = int(parts[1])
        except ValueError:
            return None
    else:
        addr = raw
    if not (1 <= port <= 65535):
        return None

    try:
        socket.inet_aton(addr)
    except (socket.error, OSError):
        try:
            addr = socket.gethostbyname(addr)
        except Exception:
            return None

    return Peer(
        name=f"Direct ({addr}:{port})",
        service=f"direct-{addr}:{port}",
        address=addr,
        port=port,
        via="direct",
    )


# ---------------------------------------------------------------------------
# mDNS listener
# ---------------------------------------------------------------------------

class _Listener(ServiceListener):
    def __init__(self, peers: Dict[str, Peer], peer_history: Dict[str, Peer], get_self_service,
                 lock: threading.Lock, get_self_instance: Optional[Callable[[], Optional[str]]] = None):
        self._peers = peers
        self._peer_history = peer_history
        self._get_self = get_self_service
        self._get_self_instance = get_self_instance or (lambda: None)
        self._lock = lock

    def _refresh(self, zc, type_: str, name: str) -> None:
        try:
            info = zc.get_service_info(type_, name, timeout=1500)
            if not info:
                # Service records can arrive before address/TXT records. Retry
                # without blocking zeroconf's browser thread.
                threading.Thread(target=self._retry_refresh, args=(zc, type_, name),
                                 name="xdrop-discovery-retry", daemon=True).start()
                return
            self._store_info(info, name)
        except Exception as e:
            log.warning(f"Error refreshing service {name}: {e}")

    def _retry_refresh(self, zc, type_: str, name: str) -> None:
        for _ in range(3):
            time.sleep(0.5)
            with self._lock:
                if _service_key(name) in self._peers:
                    return
            try:
                info = zc.get_service_info(type_, name, timeout=2500)
            except Exception as e:
                log.debug(f"Retry resolving service {name}: {e}")
                continue
            if info:
                self._store_info(info, name)
                return
        log.info(f"mDNS service {name} did not resolve; broadcast/scan discovery will still try")

    def _store_info(self, info, name: str) -> None:
        try:
            addrs = info.parsed_addresses(IPVersion.V4Only) or []
            _, networks = _local_ipv4_details()
            address = _choose_peer_address(addrs, networks, _primary_ipv4())
            if not address:
                return
            props = info.properties or {}
            raw_instance = props.get(b"instance_id")
            remote_instance = raw_instance.decode("ascii", errors="ignore") if raw_instance else None
            local_instance = self._get_self_instance()
            if (_service_key(name) == _service_key(self._get_self())
                    or (local_instance and remote_instance == local_instance)):
                return
            raw = props.get(b"name")
            txt_name = raw.decode("utf-8", errors="replace") if raw else None
            display = txt_name or (
                name[:-len(SERVICE_TYPE)].rstrip(".") if name.endswith(SERVICE_TYPE) else name.rstrip(".")
            )
            peer = Peer(name=display, service=name, address=address, port=info.port or 0,
                        last_seen=time.time(), via="mdns", instance_id=remote_instance)
            key = _service_key(name)
            with self._lock:
                self._peers[key] = peer
                self._peer_history[key] = peer
            log.info(f"mDNS peer {peer.name} @ {peer.endpoint}")
        except Exception as e:
            log.warning(f"Error storing service {name}: {e}")

    def add_service(self, zc, type_: str, name: str) -> None:
        self._refresh(zc, type_, name)

    def update_service(self, zc, type_: str, name: str) -> None:
        self._refresh(zc, type_, name)

    def remove_service(self, zc, type_: str, name: str) -> None:
        try:
            key = _service_key(name)
            with self._lock:
                removed = self._peers.pop(key, None)
                if removed:
                    removed.online = False
                    self._peer_history[key] = removed
            if removed:
                log.debug(f"mDNS peer removed: {removed.name} ({name})")
        except Exception as e:
            log.warning(f"Error removing service {name}: {e}")


# ---------------------------------------------------------------------------
# Discovery service
# ---------------------------------------------------------------------------

class DiscoveryService:
    """Advertises this device and tracks peers via mDNS, UDP broadcast and subnet scan."""

    def __init__(self, device_name: str, port: int,
                 identify: Optional[Callable[[str, int], Optional[dict]]] = None,
                 enable_beacon: bool = True, enable_auto_scan: bool = True):
        self.device_name = device_name
        self.port = port
        self._identify = identify          # (ip, port) -> {"name":..} if an xdrop receiver answers
        self._enable_beacon = enable_beacon
        self._enable_auto_scan = enable_auto_scan
        self._zc = None
        self._info = None
        self._browser = None
        self._peers: Dict[str, Peer] = {}           # mDNS peers (live)
        self._peer_history: Dict[str, Peer] = {}    # every peer seen this run
        self._beacon_peers: Dict[str, Peer] = {}
        self._scan_peers: Dict[str, Peer] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._instance_id = uuid.uuid4().hex
        self._service_name = self._make_service_name(device_name)
        self._beacon_sock: Optional[socket.socket] = None
        self._beacon_bound = False
        self._threads: List[threading.Thread] = []
        self.beacon_stats = {"sent": 0, "received": 0, "replies": 0, "errors": 0, "last_error": None}
        self.scan_state = {"running": False, "last_started": None, "last_finished": None,
                           "hosts": 0, "found": 0, "last_error": None}
        # Diagnostics surfaced to the CLI / dashboard.
        self.local_ip: Optional[str] = None
        self.registered: bool = False
        self.last_error: Optional[str] = None
        self.interfaces: List[dict] = []

    @property
    def instance_id(self) -> str:
        return self._instance_id

    @staticmethod
    def _make_service_name(device_name: str) -> str:
        safe = "".join(c if (c.isalnum() or c in "-_ ") else "_" for c in device_name)[:48]
        suffix = uuid.uuid4().hex[:6]
        return f"{safe or 'device'} [{suffix}].{SERVICE_TYPE}"

    def _service_properties(self, device_name: str) -> dict:
        return {b"name": device_name.encode("utf-8"), b"instance_id": self._instance_id.encode("ascii")}

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        self.local_ip = _primary_ipv4()
        self.interfaces = local_interfaces()
        log.info(f"Starting discovery. Primary IP {self.local_ip}, port {self.port}, "
                 f"interfaces {[i['ip'] + '/' + str(i['prefix']) for i in self.interfaces]}")
        self._start_mdns()
        if self._enable_beacon:
            self._start_beacon()
        if self._enable_auto_scan and self._identify:
            self._spawn(self._auto_scan_loop, "xdrop-autoscan")

    def _spawn(self, target, name: str) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads.append(thread)

    def _start_mdns(self) -> None:
        if not HAS_ZEROCONF:
            self.last_error = "zeroconf package not installed (mDNS discovery disabled)"
            log.warning(self.last_error)
            return
        try:
            self._zc = Zeroconf(interfaces=InterfaceChoice.All, ip_version=IPVersion.V4Only)
        except Exception as e:
            try:
                self._zc = Zeroconf(ip_version=IPVersion.V4Only)
            except Exception:
                self.last_error = f"zeroconf init failed: {e}"
                log.error(self.last_error)
                return
        self._register()
        self._start_browser()

    def _register(self) -> None:
        addresses = []
        for iface in self.interfaces:
            try:
                addresses.append(socket.inet_aton(iface["ip"]))
            except OSError:
                pass
        self._info = ServiceInfo(
            type_=SERVICE_TYPE, name=self._service_name, addresses=addresses, port=self.port,
            properties=self._service_properties(self.device_name), server=None,
        )
        try:
            self._zc.register_service(self._info)
            self.registered = True
            log.info(f"mDNS registered {self._service_name}")
        except Exception as e:
            self.last_error = f"service register failed: {e}"
            log.warning(self.last_error)

    def _start_browser(self) -> None:
        listener = _Listener(self._peers, self._peer_history, lambda: self._service_name, self._lock,
                             lambda: self._instance_id)
        try:
            self._browser = ServiceBrowser(self._zc, SERVICE_TYPE, listener)
        except Exception as e:
            self.last_error = f"service browse failed: {e}"
            log.warning(self.last_error)

    # ---- UDP broadcast beacons -------------------------------------------
    def _start_beacon(self) -> None:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
                except OSError:
                    pass
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            try:
                sock.bind(("", BEACON_PORT))
                self._beacon_bound = True
            except OSError as e:
                # Another app owns the port; we can still send and get unicast replies.
                log.warning(f"Beacon port {BEACON_PORT} busy ({e}); using an ephemeral port")
                sock.bind(("", 0))
            sock.settimeout(1.0)
            self._beacon_sock = sock
        except OSError as e:
            self.beacon_stats["last_error"] = str(e)
            log.warning(f"UDP beacon disabled: {e}")
            return
        self._spawn(self._beacon_send_loop, "xdrop-beacon-send")
        self._spawn(self._beacon_recv_loop, "xdrop-beacon-recv")
        log.info(f"UDP beacon discovery active on port {BEACON_PORT}")

    def _beacon_payload(self, kind: str) -> bytes:
        return json.dumps({"xdrop": 1, "t": kind, "id": self._instance_id,
                           "name": self.device_name[:64], "port": self.port},
                          separators=(",", ":")).encode("utf-8")

    def _broadcast_targets(self) -> List[str]:
        targets = ["255.255.255.255"]
        for iface in self.interfaces:
            if iface.get("broadcast") and iface["broadcast"] not in targets:
                targets.append(iface["broadcast"])
        return targets

    def _beacon_send_loop(self) -> None:
        refresh_at = 0.0
        while not self._stop.is_set():
            now = time.time()
            if now >= refresh_at:  # interfaces change when Wi-Fi/hotspot reconnects
                self.interfaces = local_interfaces() or self.interfaces
                self.local_ip = _primary_ipv4() or self.local_ip
                refresh_at = now + 15
            payload = self._beacon_payload("hello")
            for target in self._broadcast_targets():
                try:
                    self._beacon_sock.sendto(payload, (target, BEACON_PORT))
                    self.beacon_stats["sent"] += 1
                except OSError as e:
                    self.beacon_stats["errors"] += 1
                    self.beacon_stats["last_error"] = f"{target}: {e}"
            self._stop.wait(BEACON_INTERVAL_S)

    def _beacon_recv_loop(self) -> None:
        own_ips = lambda: {i["ip"] for i in self.interfaces}
        while not self._stop.is_set():
            try:
                data, (src_ip, src_port) = self._beacon_sock.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                if self._stop.is_set():
                    return
                time.sleep(0.2)
                continue
            try:
                msg = json.loads(data.decode("utf-8"))
                if not isinstance(msg, dict) or msg.get("xdrop") != 1:
                    continue
                remote_id = str(msg.get("id") or "")[:64]
                if not remote_id or remote_id == self._instance_id:
                    continue
                port = int(msg.get("port") or 0)
                if not 1 <= port <= 65535:
                    continue
                name = str(msg.get("name") or "xdrop device")[:64]
            except (ValueError, TypeError, UnicodeDecodeError):
                continue
            self.beacon_stats["received"] += 1
            key = f"beacon-{remote_id}"
            with self._lock:
                known = key in self._beacon_peers
                peer = Peer(name=name, service=key, address=src_ip, port=port,
                            last_seen=time.time(), via="broadcast", instance_id=remote_id)
                self._beacon_peers[key] = peer
                self._peer_history[key] = peer
            if not known:
                log.info(f"Broadcast peer {name} @ {src_ip}:{port}")
            # Answer hellos directly so discovery works even if only one direction's
            # broadcast gets through the access point.
            if msg.get("t") == "hello" and src_ip not in own_ips():
                try:
                    self._beacon_sock.sendto(self._beacon_payload("reply"), (src_ip, src_port))
                    self.beacon_stats["replies"] += 1
                except OSError:
                    pass

    # ---- subnet scan -----------------------------------------------------
    def _auto_scan_loop(self) -> None:
        if self._stop.wait(AUTO_SCAN_DELAY_S):
            return
        while not self._stop.is_set():
            if not self.peers():
                self.scan_network()
            if self._stop.wait(AUTO_SCAN_INTERVAL_S):
                return

    def scan_network(self, ports: Optional[List[int]] = None) -> dict:
        """Probe every host in the local subnet(s) for an xdrop receiver. Blocking."""
        if not self._identify:
            return {"ok": False, "error": "scan not available"}
        with self._lock:
            if self.scan_state["running"]:
                return {"ok": False, "error": "scan already running"}
            self.scan_state["running"] = True
        started = time.time()
        found = 0
        try:
            self.interfaces = local_interfaces() or self.interfaces
            targets = _scan_targets(self.interfaces)
            port_list = sorted({p for p in (ports or [DEFAULT_TRANSFER_PORT, self.port]) if p})
            self.scan_state.update({"last_started": started, "hosts": len(targets) * len(port_list)})
            log.info(f"Scanning {len(targets)} hosts on ports {port_list}")

            def probe(job: Tuple[str, int]) -> Optional[Peer]:
                ip, port = job
                if self._stop.is_set():
                    return None
                try:
                    with socket.create_connection((ip, port), timeout=SCAN_CONNECT_TIMEOUT_S):
                        pass
                except OSError:
                    return None
                try:
                    info = self._identify(ip, port) or {}
                except Exception as e:
                    log.debug(f"Port open on {ip}:{port} but identify failed: {e}")
                    return None
                if not info:
                    return None
                return Peer(name=str(info.get("name") or f"xdrop @ {ip}")[:64], service=f"scan-{ip}:{port}",
                            address=ip, port=port, last_seen=time.time(), via="scan",
                            instance_id=info.get("instance_id"))

            jobs = [(ip, port) for ip in targets for port in port_list]
            with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
                for peer in pool.map(probe, jobs):
                    if peer and peer.instance_id != self._instance_id:
                        found += 1
                        with self._lock:
                            self._scan_peers[peer.service] = peer
                            self._peer_history[peer.service] = peer
                        log.info(f"Scan found {peer.name} @ {peer.endpoint}")
            return {"ok": True, "hosts": len(jobs), "found": found, "seconds": round(time.time() - started, 2)}
        except Exception as e:
            self.scan_state["last_error"] = str(e)
            log.warning(f"Subnet scan failed: {e}")
            return {"ok": False, "error": str(e)}
        finally:
            self.scan_state.update({"running": False, "last_finished": time.time(), "found": found})

    def scan_async(self) -> bool:
        if self.scan_state["running"]:
            return False
        threading.Thread(target=self.scan_network, name="xdrop-scan", daemon=True).start()
        return True

    # ---- rename ------------------------------------------------------------
    def update_device_name(self, new_name: str) -> None:
        log.info(f"Updating device name to: {new_name}")
        self.device_name = new_name
        if not self._zc:
            self._service_name = self._make_service_name(new_name)
            return
        try:
            if self._info:
                self._zc.unregister_service(self._info)
        except Exception as e:
            log.debug(f"Unregister on rename: {e}")
        with self._lock:
            self._peers.pop(_service_key(self._service_name), None)
        self._service_name = self._make_service_name(new_name)
        self.interfaces = local_interfaces() or self.interfaces
        self._register()
        try:
            if self._browser:
                self._browser.cancel()
        except Exception:
            pass
        self._start_browser()

    # ---- queries -------------------------------------------------------------
    def _merged(self) -> List[Peer]:
        now = time.time()
        own_ips = {i["ip"] for i in self.interfaces}
        with self._lock:
            sources = (
                [(p, "mdns") for p in self._peers.values()]
                + [(p, "broadcast") for p in self._beacon_peers.values() if now - p.last_seen <= BEACON_TTL_S]
                + [(p, "scan") for p in self._scan_peers.values() if now - p.last_seen <= SCAN_TTL_S]
            )
        merged: Dict[str, Peer] = {}
        by_endpoint: Dict[str, str] = {}
        for peer, via in sources:
            if peer.instance_id and peer.instance_id == self._instance_id:
                continue
            if peer.address in own_ips and peer.port == self.port:
                continue
            key = peer.instance_id or peer.endpoint
            key = by_endpoint.get(peer.endpoint, key)
            existing = merged.get(key)
            if existing:
                vias = set(existing.via.split("+")) | {via}
                existing.via = "+".join(sorted(vias))
                existing.last_seen = max(existing.last_seen, peer.last_seen)
                # Broadcast / scan addresses are the real source IP, so prefer them.
                if via in ("broadcast", "scan"):
                    existing.address, existing.port = peer.address, peer.port
                if existing.name.startswith("xdrop @") and not peer.name.startswith("xdrop @"):
                    existing.name = peer.name
            else:
                merged[key] = Peer(name=peer.name, service=peer.service, address=peer.address, port=peer.port,
                                   last_seen=peer.last_seen, online=True, via=via, instance_id=peer.instance_id)
            by_endpoint[peer.endpoint] = key
        return list(merged.values())

    def peers(self) -> List[Peer]:
        return sorted(self._merged(), key=lambda p: p.name.lower())

    def discovered_peers(self) -> List[Peer]:
        """Return peers seen during this run, including those now offline."""
        live = self._merged()
        live_keys = {p.instance_id or p.endpoint for p in live} | {p.endpoint for p in live}
        result = list(live)
        seen = set(live_keys)
        with self._lock:
            history = list(self._peer_history.values())
        for peer in sorted(history, key=lambda p: -p.last_seen):
            key = peer.instance_id or peer.endpoint
            if key in seen or peer.endpoint in seen:
                continue
            seen.update({key, peer.endpoint})
            result.append(Peer(name=peer.name, service=peer.service, address=peer.address, port=peer.port,
                               last_seen=peer.last_seen, online=False, via=peer.via, instance_id=peer.instance_id))
        return sorted(result, key=lambda p: p.name.lower())

    def diagnostics(self) -> dict:
        peers = self._merged()
        return {
            "local_ip": self.local_ip,
            "registered": self.registered,
            "port": self.port,
            "service_name": self._service_name,
            "instance_id": self._instance_id,
            "peer_count": len(peers),
            "last_error": self.last_error,
            "zeroconf_active": self._zc is not None,
            "beacon_active": self._beacon_sock is not None,
            "beacon_port": BEACON_PORT,
            "beacon_bound": self._beacon_bound,
            "beacon_stats": dict(self.beacon_stats),
            "scan": dict(self.scan_state),
            "interfaces": list(self.interfaces),
            "methods": {
                "mdns": sum(1 for p in peers if "mdns" in p.via),
                "broadcast": sum(1 for p in peers if "broadcast" in p.via),
                "scan": sum(1 for p in peers if "scan" in p.via),
            },
        }

    def stop(self) -> None:
        log.info("Stopping discovery service")
        self._stop.set()
        try:
            if self._zc and self._info:
                self._zc.unregister_service(self._info)
        except Exception:
            pass
        try:
            if self._zc:
                self._zc.close()
        except Exception:
            pass
        self._zc = None
        try:
            if self._beacon_sock:
                self._beacon_sock.close()
        except Exception:
            pass
        self._beacon_sock = None
