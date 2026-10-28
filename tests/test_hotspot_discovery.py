"""Discovery must keep working when mDNS is blocked (phone hotspots)."""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

from xdrop import discovery
from xdrop.transfer import ReceiverServer, identify_peer


def _receiver(name: str, instance: str) -> ReceiverServer:
    rx = ReceiverServer(get_download_dir=lambda: Path(tempfile.mkdtemp()), get_device_name=lambda: name, port=0)
    rx.identity = lambda: {"instance_id": instance}
    rx.start()
    return rx


def test_identify_peer_returns_name_and_instance() -> None:
    rx = _receiver("Phone", "inst-1")
    try:
        info = identify_peer("127.0.0.1", rx.port)
        assert info == {"name": "Phone", "instance_id": "inst-1"}
        assert identify_peer("127.0.0.1", 1, timeout=0.3) is None
    finally:
        rx.stop()


def test_subnet_scan_finds_receiver_without_mdns(monkeypatch) -> None:
    rx = _receiver("Hotspot laptop", "peer-xyz")
    monkeypatch.setattr(discovery, "_scan_targets", lambda _ifaces: ["127.0.0.1", "127.0.0.2"])
    disc = discovery.DiscoveryService("me", 1, identify=identify_peer, enable_beacon=False, enable_auto_scan=False)
    try:
        result = disc.scan_network(ports=[rx.port])
        assert result["ok"] and result["found"] >= 1
        peers = disc.peers()
        # Two addresses answered for the same instance: merged into one peer.
        assert len(peers) == 1
        assert peers[0].name == "Hotspot laptop" and peers[0].via == "scan"
    finally:
        disc.stop()
        rx.stop()


def test_beacon_peers_merge_with_mdns_and_expire(monkeypatch) -> None:
    disc = discovery.DiscoveryService("me", 47474, enable_beacon=False, enable_auto_scan=False)
    now = time.time()
    disc._peers["svc"] = discovery.Peer("Phone", "svc", "192.168.43.9", 47474, now, via="mdns", instance_id="p1")
    disc._beacon_peers["beacon-p1"] = discovery.Peer("Phone", "beacon-p1", "192.168.43.9", 47474, now,
                                                     via="broadcast", instance_id="p1")
    peers = disc.peers()
    assert len(peers) == 1 and peers[0].via == "broadcast+mdns"
    disc._peers.clear()
    disc._beacon_peers["beacon-p1"].last_seen = now - discovery.BEACON_TTL_S - 1
    assert disc.peers() == []


def test_scan_targets_cover_hotspot_subnets() -> None:
    ifaces = [{"name": "wlan0", "ip": "172.20.10.3", "prefix": 28, "network": "172.20.10.0/28", "broadcast": "172.20.10.15"},
              {"name": "wlan1", "ip": "10.0.0.5", "prefix": 8, "network": "10.0.0.0/8", "broadcast": "10.255.255.255"}]
    targets = discovery._scan_targets(ifaces)
    assert "172.20.10.1" in targets and "172.20.10.3" not in targets
    assert "10.0.0.1" in targets and "10.0.1.1" not in targets  # /8 is clamped to the local /24
    assert len(targets) <= discovery.MAX_SCAN_HOSTS
