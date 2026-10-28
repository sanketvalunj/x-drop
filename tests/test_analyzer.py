"""Tests for the Network Packet & Transfer Analyzer.

Covers:
- TransferEvent dataclass and as_dict()
- IncomingTransfer.add_event() thread safety and size cap
- IncomingTransfer.events_snapshot() pagination
- Lifecycle event recording (connection, handshake, offer, decision, data,
  integrity, done) for accepted, rejected, and failed transfers
- peer_port, local_port, and finished_sha256 fields on IncomingTransfer
- No encryption keys or file content appear in event details
- send_file() event_log parameter captures sender-side events
- Concurrent transfer event isolation
- Regression: existing loopback transfer still passes with new fields
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xdrop.transfer import (
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_REJECTED,
    MAX_EVENTS_PER_TRANSFER,
    IncomingTransfer,
    ReceiverServer,
    TransferEvent,
    send_file,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_transfer(**kwargs) -> IncomingTransfer:
    defaults = dict(
        id="test0001",
        sender_name="Alice",
        sender_addr="192.168.1.10",
        filename="photo.jpg",
        size=1_000_000,
        started_at=time.time(),
    )
    defaults.update(kwargs)
    return IncomingTransfer(**defaults)


def _loopback(size_bytes: int = 300_000, auto_accept: bool = True):
    """Run a full loopback transfer and return (result_dict, last_incoming, event_log)."""
    tmp = Path(tempfile.mkdtemp(prefix="xdrop_az_test_"))
    src = tmp / "payload.bin"
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()
    src.write_bytes(os.urandom(size_bytes))

    rx = ReceiverServer(
        get_download_dir=lambda: dst_dir,
        get_device_name=lambda: "test-receiver",
    )
    rx.start()

    if auto_accept:
        rx.on_offer = lambda t: rx.decide(t.id, True)

    event_log: List[TransferEvent] = []
    result = send_file(
        peer_addr="127.0.0.1",
        peer_port=rx.port,
        filepath=src,
        sender_name="test-sender",
        event_log=event_log,
    )

    deadline = time.time() + 10
    while time.time() < deadline:
        history = rx.history()
        if history and history[-1].status in (STATUS_DONE, STATUS_FAILED, STATUS_REJECTED):
            break
        time.sleep(0.05)
    rx.stop()

    history = rx.history()
    last = history[-1] if history else None
    return result, last, event_log


# ---------------------------------------------------------------------------
# Unit tests: TransferEvent
# ---------------------------------------------------------------------------

def test_transfer_event_as_dict():
    now = time.time()
    ev = TransferEvent(timestamp=now, category="connection", details="TCP connected")
    d = ev.as_dict()
    assert d["timestamp"] == now
    assert d["category"] == "connection"
    assert d["details"] == "TCP connected"
    assert set(d.keys()) == {"timestamp", "category", "details"}


# ---------------------------------------------------------------------------
# Unit tests: IncomingTransfer.add_event / events_snapshot
# ---------------------------------------------------------------------------

def test_add_event_basic():
    t = _make_transfer()
    t.add_event("connection", "TCP connected from 192.168.1.10")
    t.add_event("handshake", "X25519 complete")
    page, total = t.events_snapshot()
    assert total == 2
    assert len(page) == 2
    assert page[0]["category"] == "connection"
    assert page[1]["category"] == "handshake"


def test_add_event_size_cap():
    """Events beyond MAX_EVENTS_PER_TRANSFER are silently dropped."""
    t = _make_transfer()
    for i in range(MAX_EVENTS_PER_TRANSFER + 50):
        t.add_event("progress", f"chunk {i}")
    _, total = t.events_snapshot()
    assert total == MAX_EVENTS_PER_TRANSFER


def test_events_snapshot_pagination():
    t = _make_transfer()
    for i in range(10):
        t.add_event("progress", f"chunk {i}")
    page, total = t.events_snapshot(offset=3, limit=4)
    assert total == 10
    assert len(page) == 4
    assert page[0]["details"] == "chunk 3"
    assert page[-1]["details"] == "chunk 6"


def test_add_event_thread_safety():
    """Concurrent add_event calls from many threads must not raise or corrupt state."""
    t = _make_transfer()
    errors: List[Exception] = []

    def writer(index: int):
        try:
            for j in range(20):
                t.add_event("progress", f"thread {index} chunk {j}")
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(10)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert not errors, f"Thread errors: {errors}"
    _, total = t.events_snapshot()
    assert 0 < total <= MAX_EVENTS_PER_TRANSFER


# ---------------------------------------------------------------------------
# Unit tests: peer_port / local_port / finished_sha256
# ---------------------------------------------------------------------------

def test_incoming_transfer_endpoint_fields_defaults():
    t = _make_transfer()
    assert t.peer_port is None
    assert t.local_port is None
    assert t.finished_sha256 is None


def test_incoming_transfer_endpoint_fields_set():
    t = _make_transfer(peer_port=54321, local_port=50000)
    assert t.peer_port == 54321
    assert t.local_port == 50000


# ---------------------------------------------------------------------------
# Integration tests: loopback transfer with new fields
# ---------------------------------------------------------------------------

def test_loopback_with_analyzer_fields():
    """Full loopback: IncomingTransfer now has peer_port, local_port, finished_sha256."""
    result, last, event_log = _loopback(size_bytes=200_000)

    assert result.get("ok"), f"send_file failed: {result}"
    assert last is not None
    assert last.status == STATUS_DONE

    assert last.local_port is not None and last.local_port > 0
    assert last.peer_port is not None and last.peer_port > 0
    assert last.finished_sha256 is not None and len(last.finished_sha256) == 64
    assert last.finished_sha256 == result.get("sha256")


def test_loopback_src_dst_port_in_result():
    """send_file result should contain src_port and dst_port."""
    result, last, event_log = _loopback(size_bytes=100_000)
    assert result.get("ok")
    assert "src_port" in result
    assert "dst_port" in result
    assert isinstance(result["src_port"], int) and result["src_port"] > 0
    assert isinstance(result["dst_port"], int) and result["dst_port"] > 0


def test_incoming_events_lifecycle():
    """After a successful loopback, IncomingTransfer should have lifecycle events."""
    _, last, _ = _loopback(size_bytes=150_000)
    assert last is not None and last.status == STATUS_DONE

    events, total = last.events_snapshot(limit=200)
    assert total > 0
    categories = {ev["category"] for ev in events}

    for cat in ("connection", "handshake", "offer", "decision", "done"):
        assert cat in categories, f"Missing event category: {cat}. Found: {categories}"
    assert "integrity" in categories


def test_sender_event_log():
    """send_file event_log should receive lifecycle events from the sender side."""
    _, _, event_log = _loopback(size_bytes=150_000)
    assert len(event_log) > 0

    categories = {ev.category for ev in event_log}
    for cat in ("connection", "handshake", "offer", "decision", "done"):
        assert cat in categories, f"Missing sender event category: {cat}"


def test_event_security_no_keys_or_plaintext():
    """Events must not contain raw key material or file content."""
    _, last, event_log = _loopback(size_bytes=200_000)

    suspicious_patterns = ["-----BEGIN", "private", "secret", "nonce=", "key=0x"]

    # last._events are TransferEvent dataclass instances; event_log is also List[TransferEvent]
    all_details = [ev.details for ev in last._events]
    all_details += [ev.details for ev in event_log]

    for detail in all_details:
        for pattern in suspicious_patterns:
            assert pattern.lower() not in detail.lower(), \
                f"Suspicious pattern '{pattern}' found in event: {detail!r}"


def test_rejected_transfer_events():
    """Rejected transfer records connection, handshake, offer, decision."""
    tmp = Path(tempfile.mkdtemp(prefix="xdrop_az_reject_"))
    src = tmp / "payload.bin"
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()
    src.write_bytes(os.urandom(50_000))

    rx = ReceiverServer(
        get_download_dir=lambda: dst_dir,
        get_device_name=lambda: "test-receiver-reject",
    )
    rx.start()
    rx.on_offer = lambda t: rx.decide(t.id, False)

    send_file(
        peer_addr="127.0.0.1",
        peer_port=rx.port,
        filepath=src,
        sender_name="test-sender-reject",
    )

    deadline = time.time() + 6
    while time.time() < deadline:
        history = rx.history()
        if history and history[-1].status == STATUS_REJECTED:
            break
        time.sleep(0.05)
    rx.stop()

    history = rx.history()
    assert history
    last = history[-1]
    assert last.status == STATUS_REJECTED
    assert last.finished_sha256 is None

    events, total = last.events_snapshot(limit=100)
    categories = {ev["category"] for ev in events}
    assert "connection" in categories
    assert "offer" in categories
    assert "decision" in categories


def test_concurrent_transfer_event_isolation():
    """Events from concurrent transfers must not bleed into each other."""
    tmp = Path(tempfile.mkdtemp(prefix="xdrop_az_concurrent_"))
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()

    sizes = [100_123, 200_456]
    sources = []
    for i, sz in enumerate(sizes):
        src = tmp / f"payload_{i}.bin"
        src.write_bytes(os.urandom(sz))
        sources.append(src)

    rx = ReceiverServer(
        get_download_dir=lambda: dst_dir,
        get_device_name=lambda: "test-receiver-concurrent",
    )
    rx.start()
    rx.on_offer = lambda t: rx.decide(t.id, True)

    def do_send(src: Path):
        send_file(
            peer_addr="127.0.0.1",
            peer_port=rx.port,
            filepath=src,
            sender_name="test-sender-concurrent",
        )

    threads = [threading.Thread(target=do_send, args=(src,)) for src in sources]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    deadline = time.time() + 12
    while time.time() < deadline:
        history = rx.history()
        done = [t for t in history if t.status == STATUS_DONE]
        if len(done) >= 2:
            break
        time.sleep(0.05)
    rx.stop()

    history = rx.history()
    done_transfers = [t for t in history if t.status == STATUS_DONE]
    assert len(done_transfers) >= 2

    for t in done_transfers:
        evts, total = t.events_snapshot(limit=200)
        for ev in evts:
            if ev["category"] == "offer":
                assert t.filename in ev["details"], \
                    f"Offer event for {t.id} references wrong filename: {ev['details']!r}"


# ---------------------------------------------------------------------------
# Regression guard
# ---------------------------------------------------------------------------

def test_loopback_regression():
    """Existing loopback transfer must still pass with all new fields."""
    result, last, _ = _loopback(size_bytes=1_500_000)
    assert result.get("ok"), f"send_file failed: {result}"
    assert last is not None and last.status == STATUS_DONE
    assert last.verified
    assert result.get("sha256") == last.finished_sha256
