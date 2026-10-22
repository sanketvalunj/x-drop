"""File-transfer layer: send offers, stream encrypted file data, and verify results.

Transfer protocol on top of the encrypted channel.

Session lifecycle (after `crypto.handshake` completes):

  sender → receiver : JSON {"type":"offer","sender":"<name>","filename":"...","size":N}
  receiver → sender : JSON {"type":"response","accept":bool,"reason":"..."}
  if accepted:
      sender → receiver : N bytes of file content (split into many encrypted frames)
      sender → receiver : JSON {"type":"done","sha256":"<hex>"}
      receiver → sender : JSON {"type":"ack","ok":bool,"reason":"..."}

Features & Robustness:
  - Atomic writing via temporary `.part` file, with interrupted resumable transfers retained.
  - Pre-flight storage validation before accepting transfers.
  - Graceful cancellation signaling between peers.
  - Bounded concurrency with Semaphore to prevent resource exhaustion / DoS.
  - Thread-safe transfer tracking with bounded in-memory history.
  - Structured rotating file logging for all events.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .crypto import SecureChannel, handshake
from .logger import get_logger

log = get_logger("transfer")

CHUNK_SIZE = 64 * 1024
OFFER_TIMEOUT = 120.0       # seconds the sender waits for accept/reject
DATA_TIMEOUT = 300.0        # seconds allowed for the full data transfer (5 min)
SENDER_NAME_MAX = 128       # cap peer-supplied sender name to prevent DoS
MAX_CONCURRENT_SESSIONS = 4 # maximum simultaneous incoming transfers
MAX_HISTORY = 100           # maximum retained transfers in memory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _send_json(ch: SecureChannel, obj: dict) -> None:
    ch.send(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _recv_json(ch: SecureChannel) -> dict:
    """Receive one encrypted frame and decode it as a JSON object (dict)."""
    raw = ch.recv()
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"expected JSON object, got {type(parsed).__name__}")
    return parsed


_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitize_filename(name: str) -> str:
    """Make a peer-supplied filename safe to write to disk on any OS.

    - Strips path separators from both Windows and POSIX so a Windows sender
      cannot escape the download dir on a Linux receiver (or vice versa).
    - Removes leading dots ('.', '..', and 'dotfiles' that could overwrite
      configuration), null bytes, and ASCII control chars.
    - Replaces characters Windows forbids in filenames with '_'.
    - Falls back to 'file.bin' if nothing usable remains.
    - Caps the length to 200 characters (filesystems vary; 255 is typical).
    """
    if not isinstance(name, str):
        name = str(name or "")
    # Reduce any path-like input to its tail component on either OS.
    name = name.replace("\\", "/").split("/")[-1]
    # Strip ASCII control chars (incl. tabs/newlines) and null bytes.
    name = "".join(c for c in name if ord(c) >= 32)
    name = name.strip().strip(".").strip()
    # Replace characters Windows forbids: <>:"/\|?*
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    if not name or name in (".", ".."):
        name = "file.bin"
    # Reserved Windows device names (case-insensitive, with or without ext).
    stem = name.split(".", 1)[0].upper()
    if stem in _WIN_RESERVED:
        name = "_" + name
    return name[:200]


def _resume_id(filename: str, size: int, sha256_hex: str) -> str:
    """Create a stable resume key from the transmitted filename and file digest."""
    identity = f"{filename}\0{size}\0{sha256_hex}".encode("utf-8")
    return hashlib.sha256(identity).hexdigest()


def human_size(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024.0 or unit == "TB":
            return f"{f:.1f} {unit}" if unit != "B" else f"{int(f)} {unit}"
        f /= 1024.0
    return f"{n} B"


def check_disk_space(target_dir: Path, required_bytes: int) -> bool:
    """Check if target filesystem has enough free storage (+10MB buffer)."""
    try:
        usage = shutil.disk_usage(target_dir)
        return usage.free >= (required_bytes + 10 * 1024 * 1024)
    except Exception as e:
        log.warning(f"Could not determine disk usage for {target_dir}: {e}")
        return True  # fallback: allow if check fails


def get_free_disk_space(target_dir: Path) -> int:
    """Get free disk space in bytes for the specified directory."""
    try:
        return shutil.disk_usage(target_dir).free
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

STATUS_PENDING = "pending"
STATUS_ACTIVE = "active"
STATUS_DONE = "done"
STATUS_REJECTED = "rejected"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"


class IncomingTransfer:
    """Represents an incoming transfer with thread-safe property access."""

    def __init__(
        self,
        id: str,
        sender_name: str,
        sender_addr: str,
        filename: str,
        size: int,
        started_at: float,
        resume_offset: int = 0,
    ):
        self.id = id
        self.sender_name = sender_name
        self.sender_addr = sender_addr
        self.filename = filename
        self.size = size
        self.started_at = started_at
        self.resume_offset = resume_offset
        self._status = STATUS_PENDING
        self._received = 0
        self._save_path: Optional[Path] = None
        self._temp_path: Optional[Path] = None
        self._error: Optional[str] = None
        self._verified = False
        self._finished_at: Optional[float] = None
        self._decision = threading.Event()
        self._accepted = False
        self._lock = threading.RLock()

    # Thread-safe properties
    @property
    def status(self) -> str:
        with self._lock:
            return self._status

    @status.setter
    def status(self, val: str) -> None:
        with self._lock:
            self._status = val

    @property
    def received(self) -> int:
        with self._lock:
            return self._received

    @received.setter
    def received(self, val: int) -> None:
        with self._lock:
            self._received = val

    @property
    def save_path(self) -> Optional[Path]:
        with self._lock:
            return self._save_path

    @save_path.setter
    def save_path(self, val: Optional[Path]) -> None:
        with self._lock:
            self._save_path = val

    @property
    def temp_path(self) -> Optional[Path]:
        with self._lock:
            return self._temp_path

    @temp_path.setter
    def temp_path(self, val: Optional[Path]) -> None:
        with self._lock:
            self._temp_path = val

    @property
    def error(self) -> Optional[str]:
        with self._lock:
            return self._error

    @error.setter
    def error(self, val: Optional[str]) -> None:
        with self._lock:
            self._error = val

    @property
    def verified(self) -> bool:
        with self._lock:
            return self._verified

    @verified.setter
    def verified(self, val: bool) -> None:
        with self._lock:
            self._verified = val

    @property
    def finished_at(self) -> Optional[float]:
        with self._lock:
            return self._finished_at

    @finished_at.setter
    def finished_at(self, val: Optional[float]) -> None:
        with self._lock:
            self._finished_at = val

    @property
    def speed_bps(self) -> float:
        with self._lock:
            if not self._received or not self.started_at:
                return 0.0
            end = self._finished_at or time.time()
            elapsed = max(end - self.started_at, 1e-6)
            return self._received / elapsed


# ---------------------------------------------------------------------------
# Sender
# ---------------------------------------------------------------------------

def send_file(
    peer_addr: str,
    peer_port: int,
    filepath: Path,
    sender_name: str,
    progress: Optional[Callable[[int, int], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    display_filename: Optional[str] = None,
) -> dict:
    """Send `filepath` to peer. Blocking. Returns a result dict.

    Result keys: ok (bool), reason (str), bytes_sent (int), sha256 (str, on success).
    """
    filepath = Path(filepath)
    if not filepath.is_file():
        log.error(f"Send failed: {filepath} is not a valid file")
        return {"ok": False, "reason": f"not a file: {filepath}", "bytes_sent": 0}
    size = filepath.stat().st_size
    filename = sanitize_filename(display_filename or filepath.name)
    # The stable digest-derived key lets a retry identify the receiver's partial file.
    source_hasher = hashlib.sha256()
    try:
        with filepath.open("rb") as source:
            while True:
                chunk = source.read(CHUNK_SIZE)
                if not chunk:
                    break
                source_hasher.update(chunk)
        file_digest = source_hasher.hexdigest()
        if filepath.stat().st_size != size:
            return {"ok": False, "reason": "file changed while preparing transfer", "bytes_sent": 0}
    except Exception as e:
        return {"ok": False, "reason": f"could not read file: {e}", "bytes_sent": 0}
    transfer_id = _resume_id(filename, size, file_digest)
    sent = 0

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10.0)
    try:
        sock.connect((peer_addr, peer_port))
    except Exception as e:
        sock.close()
        log.warning(f"Connect to {peer_addr}:{peer_port} failed: {e}")
        return {"ok": False, "reason": f"connect failed: {e}", "bytes_sent": 0}

    ch: Optional[SecureChannel] = None
    try:
        sock.settimeout(30.0)
        ch = handshake(sock)
        _send_json(ch, {
            "type": "offer",
            "sender": sender_name[:SENDER_NAME_MAX],
            "filename": filename,
            "size": size,
            "sha256": file_digest,
            "transfer_id": transfer_id,
        })
        log.info(f"Offered {filename} ({size} bytes) to {peer_addr}:{peer_port}")

        # Wait for receiver decision
        sock.settimeout(OFFER_TIMEOUT)
        resp = _recv_json(ch)
        if resp.get("type") != "response" or not resp.get("accept"):
            reason = resp.get("reason") or "rejected by peer"
            log.info(f"Offer for {filename} rejected by peer: {reason}")
            return {
                "ok": False,
                "reason": reason,
                "bytes_sent": 0,
            }

        # Data transfer phase
        sock.settimeout(DATA_TIMEOUT)
        hasher = hashlib.sha256()
        with filepath.open("rb") as f:
            try:
                offset = int(resp.get("offset", 0))
            except (TypeError, ValueError):
                raise ValueError("receiver returned an invalid resume offset")
            if offset < 0 or offset > size:
                raise ValueError("receiver returned an out-of-range resume offset")
            # Rehash the prefix to keep end-to-end verification correct on resume.
            remaining_prefix = offset
            while remaining_prefix:
                prefix = f.read(min(CHUNK_SIZE, remaining_prefix))
                if not prefix:
                    raise ValueError("file ended while preparing resumed transfer")
                hasher.update(prefix)
                remaining_prefix -= len(prefix)
            sent = offset
            if progress:
                try:
                    progress(sent, size)
                except Exception:
                    pass
            while sent < size:
                if cancel_event and cancel_event.is_set():
                    log.info(f"Send of {filepath.name} cancelled by user")
                    return {
                        "ok": False,
                        "reason": "transfer cancelled by user",
                        "bytes_sent": sent,
                    }

                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                ch.send(chunk)
                hasher.update(chunk)
                sent += len(chunk)
                if progress:
                    try:
                        progress(sent, size)
                    except Exception:
                        pass

        if hasher.hexdigest() != file_digest:
            _send_json(ch, {"type": "done", "sha256": hasher.hexdigest()})
            return {"ok": False, "reason": "file changed during transfer", "bytes_sent": sent}

        _send_json(ch, {"type": "done", "sha256": hasher.hexdigest()})
        log.info(f"Sent all {sent} bytes of {filename}, awaiting acknowledgement")

        # Best-effort wait for receiver's ack
        try:
            sock.settimeout(15.0)
            ack = _recv_json(ch)
            if ack.get("type") == "ack" and ack.get("ok") is False:
                reason = ack.get("reason") or "receiver verification failed"
                log.warning(f"Receiver failed verification for {filename}: {reason}")
                return {
                    "ok": False,
                    "reason": reason,
                    "bytes_sent": sent,
                }
        except Exception as e:
            log.warning(f"Timed out or failed awaiting ack: {e}")

        log.info(f"Successfully transferred {filename} ({sent} bytes)")
        return {"ok": True, "reason": "", "bytes_sent": sent, "sha256": hasher.hexdigest(), "transfer_id": transfer_id}
    except Exception as e:
        log.error(f"Transfer error for {filename}: {e}")
        return {"ok": False, "reason": f"transfer error: {e}", "bytes_sent": sent}
    finally:
        try:
            sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Receiver
# ---------------------------------------------------------------------------

class ReceiverServer:
    """TCP listener. Each accepted socket runs a session in its own thread.

    Pending offers wait for a user decision via ``decide(transfer_id, accept)``.
    The CLI consumes ``transfers`` for both pending and historical entries.
    """

    def __init__(self, get_download_dir: Callable[[], Path], get_device_name: Callable[[], str]):
        self._get_dir = get_download_dir
        self._get_name = get_device_name
        self._sock: Optional[socket.socket] = None
        self.port: int = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.transfers: List[IncomingTransfer] = []
        self._semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_SESSIONS)
        self.on_offer: Optional[Callable[[IncomingTransfer], None]] = None
        self.on_update: Optional[Callable[[IncomingTransfer], None]] = None

    # ------------------------------------------------------------------
    def start(self) -> None:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", 0))
        s.listen(8)
        self.port = s.getsockname()[1]
        self._sock = s
        log.info(f"ReceiverServer listening on port {self.port}")
        self._thread = threading.Thread(target=self._accept_loop, name="pdit-accept", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        log.info("Stopping ReceiverServer")
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)

    # ------------------------------------------------------------------
    def pending(self) -> List[IncomingTransfer]:
        with self._lock:
            return [t for t in self.transfers if t.status == STATUS_PENDING]

    def history(self) -> List[IncomingTransfer]:
        with self._lock:
            return list(self.transfers)

    def clear_finished_history(self) -> int:
        """Remove completed incoming transfers while keeping active and pending ones."""
        with self._lock:
            before = len(self.transfers)
            self.transfers = [
                transfer for transfer in self.transfers
                if transfer.status in (STATUS_PENDING, STATUS_ACTIVE)
            ]
            return before - len(self.transfers)

    def download_dir(self) -> Path:
        """Public accessor for the configured download directory."""
        return self._get_dir()

    def decide(self, transfer_id: str, accept: bool) -> bool:
        with self._lock:
            t = next((x for x in self.transfers if x.id == transfer_id), None)
        if not t or t.status != STATUS_PENDING:
            return False
        t._accepted = accept
        t._decision.set()
        log.info(f"Transfer {transfer_id} decided: {'accepted' if accept else 'rejected'}")
        return True

    # ------------------------------------------------------------------
    def _accept_loop(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                conn, addr = self._sock.accept()
            except OSError:
                break
            except Exception as e:
                log.warning(f"Error in accept loop: {e}")
                continue

            # Concurrency limit check
            if not self._semaphore.acquire(blocking=False):
                log.warning(f"Connection from {addr} rejected: max concurrent sessions ({MAX_CONCURRENT_SESSIONS}) reached")
                threading.Thread(
                    target=self._reject_busy, args=(conn, addr), name="pdit-busy", daemon=True
                ).start()
                continue

            threading.Thread(
                target=self._handle_wrapper, args=(conn, addr), name="pdit-session", daemon=True
            ).start()

    def _reject_busy(self, conn: socket.socket, addr) -> None:
        try:
            conn.settimeout(10.0)
            ch = handshake(conn)
            # Drain the offer packet sent by the sender
            try:
                _recv_json(ch)
            except Exception:
                pass
            _send_json(ch, {
                "type": "response",
                "accept": False,
                "reason": "server busy: max concurrent transfers reached",
            })
            time.sleep(0.05)
        except Exception as e:
            log.warning(f"Error sending busy response to {addr}: {e}")
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _handle_wrapper(self, conn: socket.socket, addr) -> None:
        try:
            self._handle(conn, addr)
        finally:
            self._semaphore.release()

    def _handle(self, conn: socket.socket, addr) -> None:
        sender_addr = f"{addr[0]}:{addr[1]}"
        t: Optional[IncomingTransfer] = None
        temp_path: Optional[Path] = None
        resumable = False
        meta_path: Optional[Path] = None
        try:
            conn.settimeout(30.0)
            ch = handshake(conn)
            offer = _recv_json(ch)
            if offer.get("type") != "offer":
                log.warning(f"Expected offer message from {sender_addr}, got: {offer.get('type')}")
                return

            filename = sanitize_filename(str(offer.get("filename") or "file.bin"))

            # Validate size
            raw_size = offer.get("size")
            try:
                size = int(raw_size)
            except (TypeError, ValueError):
                log.warning(f"Invalid size in offer from {sender_addr}: {raw_size}")
                return
            if size < 0 or size > 1024 ** 4:  # 1 TB sanity cap
                log.warning(f"Size out of bounds in offer from {sender_addr}: {size}")
                return

            sender_name = str(offer.get("sender") or "unknown")[:SENDER_NAME_MAX]
            offered_digest = str(offer.get("sha256") or "")
            offered_id = str(offer.get("transfer_id") or "")
            resumable = bool(
                re.fullmatch(r"[0-9a-f]{64}", offered_digest)
                and re.fullmatch(r"[0-9a-f]{64}", offered_id)
                and _resume_id(filename, size, offered_digest) == offered_id
            )
            dest_dir = self._get_dir()
            dest_dir.mkdir(parents=True, exist_ok=True)

            part_path = dest_dir / f".xdrop_{offered_id}.part" if resumable else None
            meta_path = dest_dir / f".xdrop_{offered_id}.json" if resumable else None
            resume_offset = 0
            if resumable and part_path and meta_path:
                try:
                    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
                    if (metadata == {"filename": filename, "size": size, "sha256": offered_digest}
                            and part_path.is_file() and part_path.stat().st_size <= size):
                        resume_offset = part_path.stat().st_size
                    else:
                        part_path.unlink(missing_ok=True)
                        meta_path.unlink(missing_ok=True)
                except (OSError, ValueError, TypeError):
                    part_path.unlink(missing_ok=True)
                    meta_path.unlink(missing_ok=True)

            t = IncomingTransfer(
                id=uuid.uuid4().hex[:8],
                sender_name=sender_name,
                sender_addr=sender_addr,
                filename=filename,
                size=size,
                started_at=time.time(),
                resume_offset=resume_offset,
            )
            t.received = resume_offset

            # Pre-flight storage check
            if not check_disk_space(dest_dir, size - resume_offset):
                free_bytes = get_free_disk_space(dest_dir)
                reason = f"insufficient storage (needs {human_size(size - resume_offset)}, available {human_size(free_bytes)})"
                log.warning(f"Rejecting {filename} from {sender_name}: {reason}")
                t.status = STATUS_FAILED
                t.error = reason
                t.finished_at = time.time()
                with self._lock:
                    self._add_transfer(t)
                _send_json(ch, {"type": "response", "accept": False, "reason": reason})
                if self.on_update:
                    self.on_update(t)
                return

            with self._lock:
                self._add_transfer(t)

            log.info(f"Incoming offer {t.id}: {filename} ({size} bytes) from {sender_name}")
            if self.on_offer:
                try:
                    self.on_offer(t)
                except Exception as err:
                    log.error(f"Error in on_offer callback: {err}")

            # Wait for decision
            conn.settimeout(OFFER_TIMEOUT + 5)
            decided = t._decision.wait(timeout=OFFER_TIMEOUT)
            if not decided:
                t.status = STATUS_REJECTED
                t.error = "timed out waiting for user decision"
                t.finished_at = time.time()
                log.info(f"Transfer {t.id} timed out waiting for decision")
                try:
                    _send_json(ch, {"type": "response", "accept": False, "reason": "timeout"})
                except Exception:
                    pass
                if self.on_update:
                    self.on_update(t)
                return

            if not t._accepted:
                t.status = STATUS_REJECTED
                t.finished_at = time.time()
                log.info(f"Transfer {t.id} rejected by user")
                try:
                    _send_json(ch, {"type": "response", "accept": False, "reason": "rejected"})
                except Exception:
                    pass
                if self.on_update:
                    self.on_update(t)
                return

            # Accepted transfers keep a stable partial file so the same sender can resume.
            temp_path = part_path if resumable and part_path else dest_dir / f".xdrop_tmp_{t.id}.part"
            t.temp_path = temp_path
            t.status = STATUS_ACTIVE
            if self.on_update:
                self.on_update(t)
            if resumable and meta_path:
                meta_tmp = meta_path.with_suffix(".json.tmp")
                meta_tmp.write_text(json.dumps({"filename": filename, "size": size, "sha256": offered_digest}), encoding="utf-8")
                os.replace(meta_tmp, meta_path)
                temp_path.touch(exist_ok=True)
            _send_json(ch, {"type": "response", "accept": True, "offset": resume_offset})
            log.info(f"Transfer {t.id} accepted. Staging to temporary file {temp_path.name}")

            # Data transfer phase
            conn.settimeout(DATA_TIMEOUT)
            received = resume_offset
            hasher = hashlib.sha256()
            if resume_offset:
                with temp_path.open("rb") as prefix_file:
                    for prefix in iter(lambda: prefix_file.read(CHUNK_SIZE), b""):
                        hasher.update(prefix)
            with temp_path.open("ab" if resume_offset else "wb") as out:
                while received < size:
                    frame = ch.recv()
                    if not frame:
                        continue
                    remaining = size - received
                    if len(frame) > remaining:
                        frame = frame[:remaining]
                    out.write(frame)
                    hasher.update(frame)
                    received += len(frame)
                    t.received = received
                    if self.on_update:
                        self.on_update(t)

            # Tail "done" with sha256
            expected_sha: Optional[str] = None
            try:
                conn.settimeout(15.0)
                tail = _recv_json(ch)
                if tail.get("type") == "done":
                    expected_sha = tail.get("sha256")
            except Exception as e:
                log.warning(f"Error receiving done frame for {t.id}: {e}")

            if received < size:
                t.status = STATUS_FAILED
                t.error = f"truncated: got {received}/{size} bytes"
                log.error(f"Transfer {t.id} truncated: {received}/{size} bytes")
            elif ((expected_sha and hasher.hexdigest() != expected_sha)
                  or (resumable and hasher.hexdigest() != offered_digest)):
                t.status = STATUS_FAILED
                t.error = "integrity check failed (sha256 mismatch)"
                log.error(f"Transfer {t.id} sha256 mismatch (expected {expected_sha}, computed {hasher.hexdigest()})")
                try:
                    _send_json(ch, {"type": "ack", "ok": False, "reason": t.error})
                except Exception:
                    pass
            else:
                # SUCCESS: Atomically promote .part to final destination path
                final_path = _unique_path(dest_dir / filename)
                os.replace(temp_path, final_path)
                temp_path = None  # Successfully promoted
                if meta_path:
                    meta_path.unlink(missing_ok=True)
                t.save_path = final_path
                t.status = STATUS_DONE
                t.verified = bool(expected_sha and hasher.hexdigest() == expected_sha and (not resumable or hasher.hexdigest() == offered_digest))
                log.info(f"Transfer {t.id} verified and saved to {final_path}")
                try:
                    _send_json(ch, {"type": "ack", "ok": True})
                except Exception:
                    pass

            t.finished_at = time.time()
            if self.on_update:
                self.on_update(t)
        except Exception as e:
            log.error(f"Error handling session for {sender_addr}: {e}")
            if t is not None:
                t.status = STATUS_FAILED
                t.error = str(e)
                t.finished_at = time.time()
                if self.on_update:
                    self.on_update(t)
        finally:
            # Clean up partial temporary file if it wasn't promoted
            preserve_partial = bool(
                resumable and temp_path and temp_path.exists()
                and t is not None and t.status == STATUS_FAILED
                and not (t.error or "").startswith("integrity check failed")
            )
            if temp_path and temp_path.exists() and not preserve_partial:
                try:
                    temp_path.unlink()
                    log.info(f"Cleaned up partial file {temp_path.name}")
                except Exception as err:
                    log.warning(f"Failed to clean up partial file {temp_path}: {err}")
            if resumable and not preserve_partial and meta_path:
                try:
                    meta_path.unlink(missing_ok=True)
                except OSError:
                    pass
            try:
                conn.close()
            except Exception:
                pass

    def _add_transfer(self, t: IncomingTransfer) -> None:
        """Add transfer and cap history to MAX_HISTORY entries (lock must be held)."""
        if len(self.transfers) >= MAX_HISTORY:
            # Prune oldest non-pending entry
            for idx, item in enumerate(self.transfers):
                if item.status != STATUS_PENDING:
                    self.transfers.pop(idx)
                    break
            else:
                self.transfers.pop(0)
        self.transfers.append(t)


def _unique_path(p: Path) -> Path:
    """Return p if it doesn't exist, otherwise p with a (1), (2), … suffix."""
    if not p.exists():
        return p
    stem, suffix = p.stem, p.suffix
    for i in range(1, 10_001):
        cand = p.with_name(f"{stem} ({i}){suffix}")
        if not cand.exists():
            return cand
    return p.with_name(f"{stem}_{uuid.uuid4().hex[:8]}{suffix}")
