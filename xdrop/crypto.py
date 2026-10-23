"""Secure transport layer: agree on a session key and encrypt framed messages.

ECDH (X25519) handshake + AES-256-GCM streaming framing.

Wire format after handshake — every frame is:
    [12 bytes nonce][4 bytes big-endian ciphertext length][ciphertext]

The ciphertext includes the 16-byte GCM tag (as produced by cryptography's
AESGCM.encrypt).
"""
from __future__ import annotations

import os
import json
import socket
import struct
import time
from dataclasses import dataclass
from typing import Callable, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"PDIT"
VERSION = 1
NONCE_LEN = 12
LEN_LEN = 4
GCM_TAG_LEN = 16
PUBKEY_LEN = 32
HANDSHAKE_LEN = len(MAGIC) + 1 + PUBKEY_LEN  # 4 + 1 + 32 = 37


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed connection during read")
        buf.extend(chunk)
    return bytes(buf)


@dataclass
class SecureChannel:
    """AES-256-GCM framed channel over a connected TCP socket."""

    sock: socket.socket
    aes: AESGCM
    frame_observer: Optional[Callable[[dict], None]] = None

    def _record(self, direction: str, record_type: str, plaintext_bytes: int,
                ciphertext_bytes: int, frame_bytes: int, encrypted: bool) -> None:
        if not self.frame_observer:
            return
        try:
            self.frame_observer({
                "timestamp": time.time(),
                "direction": direction,
                "record_type": record_type,
                "plaintext_bytes": plaintext_bytes,
                "ciphertext_bytes": ciphertext_bytes,
                "frame_bytes": frame_bytes,
                "overhead_bytes": max(0, frame_bytes - plaintext_bytes),
                "encrypted": encrypted,
            })
        except Exception:
            pass

    # ---- framing ----
    def send(self, plaintext: bytes, record_type: str = "data") -> None:
        nonce = os.urandom(NONCE_LEN)
        ct = self.aes.encrypt(nonce, plaintext, None)
        header = nonce + struct.pack(">I", len(ct))
        frame = header + ct
        self.sock.sendall(frame)
        self._record("sent", record_type, len(plaintext), len(ct), len(frame), True)

    def recv(self, record_type: str = "data") -> bytes:
        header = _recv_exact(self.sock, NONCE_LEN + LEN_LEN)
        nonce = header[:NONCE_LEN]
        (length,) = struct.unpack(">I", header[NONCE_LEN:])
        # A zero-length ciphertext is technically valid (empty plaintext) but
        # the protocol never sends empty frames, so treat it as a framing error.
        if length == 0 or length > 16 * 1024 * 1024:
            raise ValueError(f"invalid frame length: {length}")
        ct = _recv_exact(self.sock, length)
        plaintext = self.aes.decrypt(nonce, ct, None)
        if record_type == "control":
            try:
                message = json.loads(plaintext.decode("utf-8"))
                if isinstance(message, dict) and isinstance(message.get("type"), str):
                    record_type = message["type"]
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
        self._record("received", record_type, len(plaintext), len(ct), NONCE_LEN + LEN_LEN + len(ct), True)
        return plaintext


def _derive_key(shared_secret: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"xdrop/v1/aes-256-gcm",
    ).derive(shared_secret)


def handshake(sock: socket.socket, frame_observer: Optional[Callable[[dict], None]] = None) -> SecureChannel:
    """Symmetric X25519 handshake. Either side may call this on a connected socket.

    Both sides send their hello simultaneously (TCP is full-duplex) and then
    read the peer's hello. The 37-byte hello fits comfortably in the TCP send
    buffer, so there is no deadlock risk.
    """
    priv = X25519PrivateKey.generate()
    pub_bytes = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    # send our hello
    hello = MAGIC + bytes([VERSION]) + pub_bytes
    sock.sendall(hello)
    if frame_observer:
        try:
            frame_observer({"timestamp": time.time(), "direction": "sent", "record_type": "handshake_hello", "plaintext_bytes": len(hello), "ciphertext_bytes": 0, "frame_bytes": len(hello), "overhead_bytes": 0, "encrypted": False})
        except Exception:
            pass
    # read peer hello
    hello = _recv_exact(sock, HANDSHAKE_LEN)
    if frame_observer:
        try:
            frame_observer({"timestamp": time.time(), "direction": "received", "record_type": "handshake_hello", "plaintext_bytes": len(hello), "ciphertext_bytes": 0, "frame_bytes": len(hello), "overhead_bytes": 0, "encrypted": False})
        except Exception:
            pass
    if hello[: len(MAGIC)] != MAGIC:
        raise ValueError("peer is not a xdrop instance")
    if hello[len(MAGIC)] != VERSION:
        raise ValueError(f"unsupported protocol version: {hello[len(MAGIC)]}")
    peer_pub = X25519PublicKey.from_public_bytes(hello[len(MAGIC) + 1 :])
    shared = priv.exchange(peer_pub)
    key = _derive_key(shared)
    return SecureChannel(sock=sock, aes=AESGCM(key), frame_observer=frame_observer)
