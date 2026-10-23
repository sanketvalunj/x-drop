"""Local web dashboard backed by xdrop's existing discovery and transfer services."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .config import Config
from .discovery import DiscoveryService, _primary_ipv4, parse_peer_endpoint
from .logger import init_logging
from .transfer import CHUNK_SIZE, IncomingTransfer, ReceiverServer, probe_peer, sanitize_filename, send_file

try:
    import qrcode
    HAS_QR = True
except ImportError:
    qrcode = None
    HAS_QR = False

WEB_DIR = Path(__file__).with_name("static")
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024


def _transfer_data(transfer: IncomingTransfer) -> dict:
    return {
        "id": transfer.id,
        "sender": transfer.sender_name,
        "address": transfer.sender_addr,
        "filename": transfer.filename,
        "size": transfer.size,
        "received": transfer.received,
        "status": transfer.status,
        "verified": transfer.verified,
        "save_path": str(transfer.save_path) if transfer.save_path else None,
        "error": transfer.error,
        "speed_bps": transfer.speed_bps,
        "duration_s": transfer.duration_s,
        "throughput_bps": transfer.speed_bps if transfer.status == "done" else None,
        "resumed_bytes": transfer.resume_offset,
        "started_at": transfer.started_at,
    }


class Dashboard:
    def __init__(self) -> None:
        init_logging()
        self.config = Config.load()
        if not self.config.has_device_name:
            self.config.device_name = self.config.device_name
            self.config.save()
        self.config.ensure_download_dir()
        self.receiver = ReceiverServer(
            get_download_dir=self.config.ensure_download_dir,
            get_device_name=lambda: self.config.device_name,
        )
        self.receiver.start()
        self.discovery = DiscoveryService(self.config.device_name, self.receiver.port)
        self.discovery.start()
        self.outgoing: list[dict] = []
        self.cancel_events: Dict[str, threading.Event] = {}
        self.quality: Dict[str, dict] = {}
        self.lock = threading.Lock()

    def state(self) -> dict:
        diagnostics = self.discovery.diagnostics()
        incoming = [_transfer_data(t) for t in self.receiver.history()]
        with self.lock:
            outgoing = []
            for item in self.outgoing:
                public = {key: value for key, value in item.items() if not key.startswith("_")}
                public["can_cancel"] = item.get("status") == "sending"
                public["can_resume"] = item.get("status") in {"failed", "cancelled"} and Path(item.get("_source_path", "")).is_file()
                outgoing.append(public)
        return {
            "app": "xdrop",
            "version": __version__,
            "device_name": self.config.device_name,
            "download_dir": str(self.config.download_dir),
            "local_ip": diagnostics.get("local_ip") or _primary_ipv4(),
            "port": self.receiver.port,
            "qr_available": HAS_QR,
            "discovery": diagnostics,
            "peers": [
                {"name": peer.name, "address": peer.address, "port": peer.port, "last_seen": peer.last_seen,
                 "quality": self.quality.get(f"{peer.address}:{peer.port}")}
                for peer in self.discovery.peers()
            ],
            "discovered_peers": [
                {"name": peer.name, "address": peer.address, "port": peer.port,
                 "last_seen": peer.last_seen, "online": peer.online,
                 "quality": self.quality.get(f"{peer.address}:{peer.port}")}
                for peer in self.discovery.discovered_peers()
            ],
            "incoming": incoming,
            "outgoing": outgoing,
            "protocol": {"version": 1, "chunk_size": CHUNK_SIZE, "handshake": "X25519 + HKDF-SHA256", "cipher": "AES-256-GCM", "integrity": "SHA-256"},
        }

    def check_peer_quality(self, address: str, port: int) -> dict:
        endpoint = f"{address}:{port}"
        checked_at = time.time()
        try:
            latency_ms = probe_peer(address, port)
            success, error = True, None
        except Exception as exc:
            latency_ms = None
            success, error = False, str(exc)
        with self.lock:
            record = self.quality.setdefault(endpoint, {"attempts": 0, "successes": 0, "last_ms": None, "last_checked": None, "error": None})
            record["attempts"] += 1
            record["successes"] += int(success)
            record["last_ms"] = latency_ms
            record["last_checked"] = checked_at
            record["error"] = error
            record["success_rate"] = record["successes"] / record["attempts"] * 100
            return dict(record)

    def stop(self) -> None:
        self.discovery.stop()
        self.receiver.stop()

    def cancel_outgoing(self, transfer_id: str) -> bool:
        with self.lock:
            item = next((entry for entry in self.outgoing if entry["id"] == transfer_id), None)
            cancel_event = self.cancel_events.get(transfer_id)
            if not item or item.get("status") != "sending" or cancel_event is None:
                return False
            cancel_event.set()
            return True

    def resume_outgoing(self, transfer_id: str) -> bool:
        with self.lock:
            item = next((entry for entry in self.outgoing if entry["id"] == transfer_id), None)
            if not item or item.get("status") not in {"failed", "cancelled"}:
                return False
            source = Path(item.get("_source_path", ""))
            if not source.is_file():
                return False
            item["sent"] = 0
            item["resumed_bytes"] = 0
            item["speed_bps"] = 0
            item["duration_s"] = None
            item["throughput_bps"] = None
            item["status"] = "connecting"
            item["error"] = None
            item["started_at"] = time.time()
        self._start_outgoing(item)
        return True

    def _start_outgoing(self, item: dict) -> None:
        cancel_event = threading.Event()
        with self.lock:
            self.cancel_events[item["id"]] = cancel_event
        def worker() -> None:
            progress_started = None
            progress_last_at = None
            resumed_bytes = None
            def progress(sent: int, total: int) -> None:
                nonlocal progress_started, progress_last_at, resumed_bytes
                now = time.time()
                if progress_started is None:
                    progress_started = now
                    resumed_bytes = sent
                progress_last_at = now
                with self.lock:
                    item["sent"] = sent
                    item["size"] = total
                    item["resumed_bytes"] = resumed_bytes or 0
                    item["status"] = "sending"
                    elapsed = max(now - progress_started, 0.001)
                    item["speed_bps"] = max(0, sent - (resumed_bytes or 0)) / elapsed
                    item["duration_s"] = elapsed
            try:
                result = send_file(
                    item["peer"], item["port"], Path(item["_source_path"]),
                    self.config.device_name, progress=progress,
                    cancel_event=cancel_event, display_filename=item["filename"],
                )
                with self.lock:
                    item["status"] = "done" if result.get("ok") else (
                        "cancelled" if result.get("reason") == "transfer cancelled by user" else "failed"
                    )
                    item["error"] = result.get("reason") or None
                    item["resumed_bytes"] = int(resumed_bytes or 0)
                    item["duration_s"] = max(0.0, progress_last_at - progress_started) if progress_started and progress_last_at else None
                    duration = item["duration_s"]
                    item["throughput_bps"] = (
                        max(0, int(result.get("bytes_sent", 0)) - item["resumed_bytes"]) / duration
                        if result.get("ok") and duration else None
                    )
                    if duration and item["throughput_bps"] is not None:
                        item["speed_bps"] = item["throughput_bps"]
                    if result.get("ok"):
                        try:
                            Path(item["_source_path"]).unlink(missing_ok=True)
                        except OSError:
                            pass
            except Exception as exc:
                with self.lock:
                    item["status"] = "failed"
                    item["error"] = str(exc)
            finally:
                with self.lock:
                    self.cancel_events.pop(item["id"], None)
        threading.Thread(target=worker, name="xdrop-web-send", daemon=True).start()

    def clear_finished_history(self) -> int:
        incoming_count = self.receiver.clear_finished_history()
        terminal = {"done", "failed", "cancelled", "rejected"}
        with self.lock:
            before = len(self.outgoing)
            for item in self.outgoing:
                if item.get("status") in terminal:
                    try:
                        Path(item.get("_source_path", "")).unlink(missing_ok=True)
                    except OSError:
                        pass
            self.outgoing = [item for item in self.outgoing if item.get("status") not in terminal]
            for transfer_id in list(self.cancel_events):
                if not any(item["id"] == transfer_id for item in self.outgoing):
                    self.cancel_events.pop(transfer_id, None)
            return incoming_count + before - len(self.outgoing)

    @staticmethod
    def open_download_folder(folder: Path) -> None:
        if os.name == "nt":
            os.startfile(str(folder))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(["xdg-open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, dashboard: Dashboard):
        self.dashboard = dashboard
        super().__init__(address, DashboardHandler)


class DashboardHandler(BaseHTTPRequestHandler):
    server: DashboardServer

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep HTTP polling from flooding the terminal; app diagnostics go to xdrop's log.
        return

    def _send(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        # Inline style attributes drive measured progress/chart widths. Allowing
        # inline styles does not enable inline JavaScript under this policy.
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, value: Any) -> None:
        self._send(status, json.dumps(value).encode("utf-8"), "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1024 * 1024:
            raise ValueError("Request is too large")
        value = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(value, dict):
            raise ValueError("Expected a JSON object")
        return value

    def _local_request(self) -> bool:
        host = self.headers.get("Host", "").split(":", 1)[0].strip("[]").lower()
        if host not in {"localhost", "127.0.0.1", "::1"}:
            return False
        origin = self.headers.get("Origin")
        return not origin or origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:")

    def do_GET(self) -> None:
        if not self._local_request():
            self._json(403, {"error": "Local dashboard requests only"})
            return
        path = urlsplit(self.path).path
        if path == "/api/pairing.svg":
            dashboard = self.server.dashboard
            if not HAS_QR:
                self._json(503, {"error": "QR support is missing. Install the project dependencies with pip install -e ."})
                return
            address = dashboard.discovery.local_ip or _primary_ipv4()
            if not address:
                self._json(503, {"error": "No local network address was detected"})
                return
            qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=0)
            qr.add_data(f"{address}:{dashboard.receiver.port}")
            qr.make(fit=True)
            matrix = qr.get_matrix()
            quiet_zone = 4
            side = len(matrix) + quiet_zone * 2
            path = "".join(
                f"M{x + quiet_zone},{y + quiet_zone}h1v1h-1z"
                for y, row in enumerate(matrix)
                for x, dark in enumerate(row)
                if dark
            )
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" '
                f'shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>'
                f'<path fill="#20271e" d="{path}"/></svg>'
            ).encode("utf-8")
            self._send(200, svg, "image/svg+xml; charset=utf-8")
            return
        if path == "/api/state":
            self._json(200, self.server.dashboard.state())
            return
        assets = {"/": "index.html", "/style.css": "style.css", "/app.js": "app.js"}
        filename = assets.get(path)
        if filename:
            content_type = "text/html; charset=utf-8" if filename.endswith("html") else (
                "text/css; charset=utf-8" if filename.endswith("css") else "text/javascript; charset=utf-8"
            )
            try:
                self._send(200, (WEB_DIR / filename).read_bytes(), content_type)
            except OSError:
                self._json(404, {"error": "Dashboard asset not found"})
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self._local_request():
            self._json(403, {"error": "Local dashboard requests only"})
            return
        parsed = urlsplit(self.path)
        dashboard = self.server.dashboard
        try:
            if parsed.path == "/api/settings":
                body = self._read_json()
                if "device_name" in body:
                    requested_name = str(body["device_name"]).strip()
                    if not requested_name:
                        raise ValueError("Device name cannot be empty")
                    old_name = dashboard.config.device_name
                    dashboard.config.device_name = requested_name
                    if dashboard.config.device_name != old_name:
                        dashboard.discovery.update_device_name(dashboard.config.device_name)
                if "download_dir" in body:
                    value = str(body["download_dir"]).strip()
                    if not value:
                        raise ValueError("Download folder cannot be empty")
                    dashboard.config.download_dir = value
                    dashboard.config.ensure_download_dir()
                if not dashboard.config.save():
                    raise OSError("Could not save settings")
                self._json(200, {"ok": True})
                return

            if parsed.path == "/api/validate-peer":
                endpoint = str(self._read_json().get("endpoint", "")).strip()
                if not re.fullmatch(r"[^:]+:\d+", endpoint):
                    raise ValueError("Enter an IP address or hostname followed by a port, such as 192.168.1.24:50000")
                peer = parse_peer_endpoint(endpoint, 0)
                if not peer:
                    raise ValueError("That address or port is not valid. Check both and try again.")
                self._json(200, {"ok": True, "address": peer.address, "port": peer.port, "label": f"{peer.address}:{peer.port}"})
                return

            if parsed.path == "/api/quality":
                endpoint = str(self._read_json().get("endpoint", "")).strip()
                peer = parse_peer_endpoint(endpoint, 0)
                if not peer:
                    raise ValueError("Enter a valid peer address and port")
                self._json(200, dashboard.check_peer_quality(peer.address, peer.port))
                return

            if parsed.path == "/api/history/clear":
                removed = dashboard.clear_finished_history()
                self._json(200, {"ok": True, "removed": removed})
                return

            if parsed.path.startswith("/api/incoming/"):
                transfer_id = parsed.path.rsplit("/", 1)[-1]
                accept = bool(self._read_json().get("accept"))
                if not dashboard.receiver.decide(transfer_id, accept):
                    self._json(404, {"error": "Incoming offer is no longer pending"})
                    return
                self._json(200, {"ok": True})
                return

            if parsed.path.startswith("/api/outgoing/") and parsed.path.endswith("/cancel"):
                transfer_id = parsed.path.split("/")[-2]
                if not dashboard.cancel_outgoing(transfer_id):
                    self._json(409, {"error": "This transfer can no longer be cancelled"})
                    return
                self._json(200, {"ok": True})
                return

            if parsed.path.startswith("/api/outgoing/") and parsed.path.endswith("/resume"):
                transfer_id = parsed.path.split("/")[-2]
                if not dashboard.resume_outgoing(transfer_id):
                    self._json(409, {"error": "This transfer cannot be resumed because its source file is unavailable"})
                    return
                self._json(200, {"ok": True})
                return

            if parsed.path == "/api/open-download-folder":
                dashboard.config.ensure_download_dir()
                dashboard.open_download_folder(dashboard.config.download_dir)
                self._json(200, {"ok": True})
                return

            if parsed.path == "/api/send":
                query = parse_qs(parsed.query)
                address = query.get("address", [""])[0].strip()
                try:
                    port = int(query.get("port", [""])[0])
                except ValueError:
                    raise ValueError("Choose a valid peer")
                if not address or not 1 <= port <= 65535:
                    raise ValueError("Choose a valid peer")
                peer = parse_peer_endpoint(f"{address}:{port}", port)
                if not peer:
                    raise ValueError("Enter a valid IP address or hostname and port")
                address = peer.address
                length = int(self.headers.get("Content-Length", "-1"))
                if length < 0 or length > MAX_UPLOAD_BYTES:
                    raise ValueError("File is too large (maximum 2 GB)")
                filename = sanitize_filename(query.get("filename", ["file.bin"])[0])
                fd, temp_name = tempfile.mkstemp(prefix="xdrop-send-")
                try:
                    with os.fdopen(fd, "wb") as target:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ConnectionError("Upload ended before the whole file arrived")
                            target.write(chunk)
                            remaining -= len(chunk)
                    temp_path = Path(temp_name)
                    # Preserve the browser-provided filename for the transfer offer.
                    renamed_path = temp_path.with_name(temp_path.name + "-" + filename)
                    temp_path.replace(renamed_path)
                    item: Dict[str, Any] = {
                        "id": str(time.time_ns()), "filename": filename, "size": length,
                        "sent": 0, "status": "connecting", "peer": address,
                        "port": port, "_source_path": str(renamed_path),
                        "error": None, "started_at": time.time(), "speed_bps": 0,
                    }
                    with dashboard.lock:
                        dashboard.outgoing.append(item)
                        dashboard.outgoing = dashboard.outgoing[-100:]
                    dashboard._start_outgoing(item)
                except Exception:
                    try:
                        os.unlink(temp_name)
                    except OSError:
                        pass
                    raise
                self._json(202, {"ok": True, "id": item["id"]})
                return

            self._json(404, {"error": "Not found"})
        except (ValueError, OSError, json.JSONDecodeError, ConnectionError) as exc:
            self._json(400, {"error": str(exc)})


def main() -> None:
    dashboard = Dashboard()
    server = None
    try:
        server = DashboardServer(("127.0.0.1", 8765), dashboard)
        url = "http://127.0.0.1:8765"
        print(f"xdrop dashboard is running at {url} (local computer only)")
        webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
        dashboard.stop()


if __name__ == "__main__":
    main()
