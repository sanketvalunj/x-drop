"""Local web dashboard backed by xdrop's existing discovery and transfer services."""
from __future__ import annotations

import json
import os
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
from .discovery import DiscoveryService, _primary_ipv4
from .logger import init_logging
from .transfer import IncomingTransfer, ReceiverServer, sanitize_filename, send_file

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
        self.lock = threading.Lock()

    def state(self) -> dict:
        diagnostics = self.discovery.diagnostics()
        incoming = [_transfer_data(t) for t in self.receiver.history()]
        with self.lock:
            outgoing = [dict(item) for item in self.outgoing]
        return {
            "app": "xdrop",
            "version": __version__,
            "device_name": self.config.device_name,
            "download_dir": str(self.config.download_dir),
            "local_ip": diagnostics.get("local_ip") or _primary_ipv4(),
            "port": self.receiver.port,
            "discovery": diagnostics,
            "peers": [
                {"name": peer.name, "address": peer.address, "port": peer.port}
                for peer in self.discovery.peers()
            ],
            "incoming": incoming,
            "outgoing": outgoing,
        }

    def stop(self) -> None:
        self.discovery.stop()
        self.receiver.stop()


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
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
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

            if parsed.path.startswith("/api/incoming/"):
                transfer_id = parsed.path.rsplit("/", 1)[-1]
                accept = bool(self._read_json().get("accept"))
                if not dashboard.receiver.decide(transfer_id, accept):
                    self._json(404, {"error": "Incoming offer is no longer pending"})
                    return
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
                        "error": None, "started_at": time.time(),
                    }
                    with dashboard.lock:
                        dashboard.outgoing.append(item)
                        dashboard.outgoing = dashboard.outgoing[-100:]

                    def worker() -> None:
                        with dashboard.lock:
                            item["status"] = "sending"

                        def progress(sent: int, total: int) -> None:
                            with dashboard.lock:
                                item["sent"] = sent
                                item["size"] = total

                        try:
                            result = send_file(
                                address, port, renamed_path, dashboard.config.device_name, progress=progress
                            )
                            with dashboard.lock:
                                item["status"] = "done" if result.get("ok") else "failed"
                                item["error"] = result.get("reason") or None
                        except Exception as exc:
                            with dashboard.lock:
                                item["status"] = "failed"
                                item["error"] = str(exc)
                        finally:
                            try:
                                renamed_path.unlink()
                            except OSError:
                                pass

                    threading.Thread(target=worker, name="xdrop-web-send", daemon=True).start()
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
