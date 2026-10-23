"""Keep a last-seen record after an mDNS peer goes offline."""
from __future__ import annotations

from xdrop import discovery


class _FakeInfo:
    properties = {b"name": b"Test phone"}
    port = 54321

    @staticmethod
    def parsed_addresses(_version):
        return ["192.168.1.42"]


class _FakeZeroconf:
    @staticmethod
    def get_service_info(_service_type, _name, timeout):
        assert timeout == 1500
        return _FakeInfo()


def test_discovered_peer_remains_with_last_seen_after_removal(monkeypatch) -> None:
    class _IPVersion:
        V4Only = object()

    monkeypatch.setattr(discovery, "IPVersion", _IPVersion)
    service = discovery.DiscoveryService("local", 50000)
    listener = discovery._Listener(
        service._peers,
        service._peer_history,
        lambda: "self._xdrop._tcp.local.",
        service._lock,
    )
    peer_name = "test._xdrop._tcp.local."

    listener.add_service(_FakeZeroconf(), discovery.SERVICE_TYPE, peer_name)
    online = service.discovered_peers()
    assert len(online) == 1
    last_seen = online[0].last_seen
    assert online[0].online is True
    assert service.peers()

    listener.remove_service(_FakeZeroconf(), discovery.SERVICE_TYPE, peer_name)
    assert service.peers() == []
    history = service.discovered_peers()
    assert len(history) == 1
    assert history[0].online is False
    assert history[0].last_seen == last_seen
