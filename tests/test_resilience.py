"""Reliability checks: exercise xdrop's error handling and fallback behavior.

Covers:
  - Direct IP/Port endpoint parsing (manual connect fallback)
  - Atomic write and cleanup of partial (.part) files on network drop/truncation
  - User cancellation signaling and instant teardown
  - Pre-flight storage rejection
  - Concurrency bounding / server busy rejection
  - Unrecognized connection handling (fuzzing / port scanning)
  - Diagnostic and logging subsystems
"""
from __future__ import annotations

import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xdrop.discovery import DiscoveryService, parse_peer_endpoint
from xdrop.logger import get_recent_logs, init_logging
from xdrop.transfer import (
    MAX_CONCURRENT_SESSIONS,
    STATUS_DONE,
    STATUS_FAILED,
    IncomingTransfer,
    ReceiverServer,
    send_file,
)


def test_direct_endpoint_parsing():
    """Verify manual IP:port endpoint parser handles standard, custom, and malformed inputs."""
    # Valid IP with default port
    p1 = parse_peer_endpoint("192.168.1.100", default_port=52341)
    assert p1 is not None
    assert p1.address == "192.168.1.100"
    assert p1.port == 52341
    assert p1.endpoint == "192.168.1.100:52341"

    # Valid IP with explicit port
    p2 = parse_peer_endpoint("10.0.0.5:8080", default_port=52341)
    assert p2 is not None
    assert p2.address == "10.0.0.5"
    assert p2.port == 8080

    # Localhost resolution
    p3 = parse_peer_endpoint("127.0.0.1:9999", default_port=52341)
    assert p3 is not None
    assert p3.address == "127.0.0.1"
    assert p3.port == 9999

    # Invalid inputs
    assert parse_peer_endpoint("", 5000) is None
    assert parse_peer_endpoint("   ", 5000) is None
    assert parse_peer_endpoint("999.999.999.999", 5000) is None
    assert parse_peer_endpoint("192.168.1.1:999999", 5000) is None  # Port out of bounds
    assert parse_peer_endpoint("192.168.1.1:invalid", 5000) is None


def test_atomic_write_and_cleanup_on_truncation():
    """Verify that if a socket drops mid-transfer:
    1. The partial .part file is immediately unlinked.
    2. No corrupt final file is created.
    3. Status is marked STATUS_FAILED.
    """
    tmp = Path(tempfile.mkdtemp(prefix="pdit_test_atomic_"))
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()

    src = tmp / "sample.dat"
    src.write_bytes(os.urandom(500_000))  # 500 KB

    rx = ReceiverServer(get_download_dir=lambda: dst_dir, get_device_name=lambda: "receiver")
    rx.start()

    # Automatically accept transfer
    rx.on_offer = lambda t: rx.decide(t.id, True)

    # We will simulate a crash/disconnect by closing the sender socket halfway
    cancel_event = threading.Event()
    chunks_sent = [0]

    def progress(sent, total):
        chunks_sent[0] = sent
        if sent >= 65536 * 2:  # After 2 chunks, trigger abrupt cancellation
            cancel_event.set()

    result = send_file(
        peer_addr="127.0.0.1",
        peer_port=rx.port,
        filepath=src,
        sender_name="sender",
        progress=progress,
        cancel_event=cancel_event,
    )

    assert result["ok"] is False
    assert "cancel" in result["reason"].lower()

    # Allow receiver thread to process disconnect and cleanup
    deadline = time.time() + 3.0
    while time.time() < deadline:
        h = rx.history()
        if h and h[-1].status == STATUS_FAILED:
            break
        time.sleep(0.05)

    rx.stop()

    # Verify no partial files or final files exist in download directory
    remaining_files = list(dst_dir.iterdir())
    assert len(remaining_files) == 0, f"Expected clean dir, found {remaining_files}"

    h = rx.history()
    assert len(h) == 1
    assert h[0].status == STATUS_FAILED


def test_storage_preflight_rejection():
    """Verify that if target directory does not have enough storage, offer is rejected."""
    tmp = Path(tempfile.mkdtemp(prefix="pdit_test_storage_"))
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()

    src = tmp / "huge.dat"
    src.write_bytes(b"A" * 1024)

    rx = ReceiverServer(get_download_dir=lambda: dst_dir, get_device_name=lambda: "receiver")
    rx.start()

    # Mock check_disk_space to return False
    with patch("xdrop.transfer.check_disk_space", return_value=False):
        result = send_file(
            peer_addr="127.0.0.1",
            peer_port=rx.port,
            filepath=src,
            sender_name="sender",
        )

    rx.stop()

    assert result["ok"] is False
    assert "storage" in result["reason"].lower() or "insufficient" in result["reason"].lower()


def test_fuzzed_connection_does_not_disrupt_server():
    """Verify that random port scanners or malformed TCP packets do not crash ReceiverServer."""
    tmp = Path(tempfile.mkdtemp(prefix="pdit_test_fuzz_"))
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()

    rx = ReceiverServer(get_download_dir=lambda: dst_dir, get_device_name=lambda: "receiver")
    rx.start()

    # Send garbage HTTP GET request
    s1 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s1.connect(("127.0.0.1", rx.port))
    s1.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
    s1.close()

    # Send random binary garbage
    s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s2.connect(("127.0.0.1", rx.port))
    s2.sendall(os.urandom(256))
    s2.close()

    time.sleep(0.2)

    # Server should still be running and accept a valid transfer!
    src = tmp / "valid.txt"
    src.write_bytes(b"hello world")
    rx.on_offer = lambda t: rx.decide(t.id, True)

    res = send_file("127.0.0.1", rx.port, src, "valid_sender")
    rx.stop()

    assert res["ok"] is True
    assert (dst_dir / "valid.txt").read_bytes() == b"hello world"


def test_diagnostics_and_logging():
    """Verify system diagnostics reporting and in-memory log capture."""
    init_logging()
    disc = DiscoveryService("test_device", 52341)
    diag = disc.diagnostics()

    assert "local_ip" in diag
    assert "registered" in diag
    assert "port" in diag
    assert diag["port"] == 52341

    logs = get_recent_logs(20)
    assert isinstance(logs, list)


def test_direct_ip_transfer_end_to_end():
    """Verify that a manual direct IP:port transfer works completely without mDNS discovery."""
    tmp = Path(tempfile.mkdtemp(prefix="pdit_test_direct_"))
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()

    src = tmp / "manual_payload.bin"
    src.write_bytes(b"A" * 65536 + b"B" * 65536)

    rx = ReceiverServer(get_download_dir=lambda: dst_dir, get_device_name=lambda: "rx_direct")
    rx.start()
    rx.on_offer = lambda t: rx.decide(t.id, True)

    peer = parse_peer_endpoint(f"127.0.0.1:{rx.port}", default_port=5000)
    assert peer is not None

    res = send_file(peer.address, peer.port, src, "tx_direct")
    rx.stop()

    assert res["ok"] is True
    saved_file = dst_dir / "manual_payload.bin"
    assert saved_file.is_file()
    assert saved_file.read_bytes() == src.read_bytes()


def test_concurrency_saturation_rejection():
    """Verify that when the receiver has reached max concurrent sessions, new offers are rejected cleanly."""
    tmp = Path(tempfile.mkdtemp(prefix="pdit_test_concurr_"))
    dst_dir = tmp / "downloads"
    dst_dir.mkdir()

    rx = ReceiverServer(get_download_dir=lambda: dst_dir, get_device_name=lambda: "rx_busy")
    rx.start()

    # Exhaust semaphore
    for _ in range(MAX_CONCURRENT_SESSIONS):
        assert rx._semaphore.acquire(blocking=False)

    src = tmp / "sample.txt"
    src.write_bytes(b"testing concurrency limits")

    res = send_file("127.0.0.1", rx.port, src, "sender")
    assert res["ok"] is False
    assert "busy" in res["reason"].lower()

    # Release semaphore
    for _ in range(MAX_CONCURRENT_SESSIONS):
        rx._semaphore.release()

    # Now verify server accepts new transfer normally
    rx.on_offer = lambda t: rx.decide(t.id, True)
    res2 = send_file("127.0.0.1", rx.port, src, "sender")
    rx.stop()

    assert res2["ok"] is True


def test_zeroconf_missing_fallback():
    """Verify DiscoveryService gracefully degrades when zeroconf library is unavailable."""
    with patch("xdrop.discovery.HAS_ZEROCONF", False):
        disc = DiscoveryService("fallback_node", 54321)
        disc.start()

        diag = disc.diagnostics()
        assert diag["registered"] is False
        assert "not installed" in diag["last_error"]
        # Peers list should still be safely queryable
        assert disc.peers() == []
        disc.stop()

