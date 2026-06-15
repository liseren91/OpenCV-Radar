import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sources import load_sources


def test_load_sources_returns_modules_with_contract(monkeypatch):
    monkeypatch.delenv("SOURCES_ENABLED", raising=False)
    monkeypatch.delenv("SOURCES_DISABLED", raising=False)
    srcs = load_sources()
    assert len(srcs) >= 1
    for s in srcs:
        assert isinstance(s.NAME, str) and s.NAME
        assert hasattr(s, "fetch") and callable(s.fetch)
        assert isinstance(getattr(s, "REQUIRES_ENV", []), list)


def test_disabled_whitelist_and_blacklist(monkeypatch):
    all_names = {s.NAME for s in load_sources()}
    a_name = sorted(all_names)[0]
    monkeypatch.setenv("SOURCES_ENABLED", a_name)
    assert {s.NAME for s in load_sources()} == {a_name}
    monkeypatch.delenv("SOURCES_ENABLED")
    monkeypatch.setenv("SOURCES_DISABLED", a_name)
    assert a_name not in {s.NAME for s in load_sources()}
