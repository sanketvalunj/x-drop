"""Regression tests for fail-closed receiver integrity checks."""
from __future__ import annotations

import socket
import tempfile
import threading
import time
from pathlib import Path

from xdrop.crypto import handshake
from xdrop.transfer import STATUS_FAILED, ReceiverServer, _integrity_failure, _recv_json, _send_json


def test_integrity_check_requires_digest_and_matches_offer() -> None:
    digest = "a" * 64
    assert _integrity_failure(digest, None) is not None
    assert _integrity_failure(digest, "not-a-digest") is not None
    assert _integrity_failure(digest, "b" * 64) is not None
    assert _integrity_failure(digest, digest, "b" * 64) is not None
    assert _integrity_failure(digest, digest, digest) is None


def test_receiver_rejects_complete_payload_without_final_digest() -> None:
    destination = Path(tempfile.mkdtemp(prefix="xdrop_missing_digest_"))
    receiver = ReceiverServer(get_download_dir=lambda: destination, get_device_name=lambda: "receiver")
    receiver.on_offer = lambda transfer: receiver.decide(transfer.id, True)
    payload = b"complete bytes without a digest"
    sock, receiver_sock = socket.socketpair()
    sock.settimeout(5)
    worker = threading.Thread(target=receiver._handle, args=(receiver_sock, ("local", 0)), daemon=True)
    worker.start()

    try:
        channel = handshake(sock)
        _send_json(channel, {
            "type": "offer",
            "sender": "sender",
            "filename": "payload.bin",
            "size": len(payload),
        })
        response = _recv_json(channel)
        assert response.get("accept") is True
        channel.send(payload)
        sock.close()

        deadline = time.time() + 5
        while time.time() < deadline:
            history = receiver.history()
            if history and history[-1].status == STATUS_FAILED:
                break
            time.sleep(0.02)
        worker.join(timeout=1)

        history = receiver.history()
        assert history
        assert history[-1].status == STATUS_FAILED
        assert "digest" in (history[-1].error or "").lower()
        assert not list(destination.iterdir())
    finally:
        sock.close()
        receiver_sock.close()
