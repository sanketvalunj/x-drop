"""Packet analytics records every frame on both sides of a real transfer."""
from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

from xdrop.analytics import PacketHub, PacketRecorder, encapsulation
from xdrop.transfer import CHUNK_SIZE, ReceiverServer, send_file


def test_both_sides_capture_frames_and_bytes() -> None:
    hub = PacketHub()
    rx = ReceiverServer(get_download_dir=lambda: Path(tempfile.mkdtemp()), get_device_name=lambda: "B", port=0)
    rx.recorder_factory = lambda: PacketRecorder(role="receiver")
    rx.on_recorder = lambda t, rec: hub.register(t.id, rec, "in")
    rx.on_offer = lambda t: threading.Timer(0.05, lambda: rx.decide(t.id, True)).start()
    rx.start()
    try:
        src = Path(tempfile.mkdtemp()) / "f.bin"
        src.write_bytes(os.urandom(CHUNK_SIZE * 2 + 100))
        sender = hub.register("out", PacketRecorder(role="sender"), "out")
        assert send_file("127.0.0.1", rx.port, src, "A", recorder=sender)["ok"]
        snap = sender.snapshot()
        types = {(r["direction"], r["record_type"]) for r in snap["by_type"]}
        assert {("sent", "handshake_hello"), ("sent", "offer"), ("received", "response"),
                ("sent", "file_chunk"), ("sent", "done"), ("received", "ack")} <= types
        chunks = [r for r in snap["recent_records"] if r["record_type"] == "file_chunk"]
        assert len(chunks) == 3
        for r in chunks:
            assert r["frame_bytes"] == r["plaintext_bytes"] + 32      # 12 nonce + 4 len + 16 tag
            assert len(r["header_hex"]) == 32 and len(r["tag_hex"]) == 32
            assert r.get("control") is None                           # file bytes never exposed
        offer = next(r for r in snap["recent_records"] if r["record_type"] == "offer")
        assert '"filename":"f.bin"' in offer["control"]
        hello = next(r for r in snap["recent_records"] if r["record_type"] == "handshake_hello")
        assert hello["raw_hex"].startswith("50444954")                 # "PDIT"
        incoming = rx.history()[0]
        assert incoming.recorder is not None
        assert incoming.recorder.snapshot()["totals"]["records"] == snap["totals"]["records"]
        assert hub.snapshot()["feed"]
    finally:
        rx.stop()


def test_encapsulation_math() -> None:
    enc = encapsulation(65568, 1448, "wifi")
    assert enc["segments"] == 46 and enc["tcp_header"] == 32
    assert enc["wire_bytes"] == 65568 + 46 * (32 + 20 + 38)
    assert encapsulation(56, 1460, "ethernet")["segments"] == 1
