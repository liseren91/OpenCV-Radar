import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # selfhost/worker importable


@pytest.fixture
def fixture_text():
    def _load(name):
        return (Path(__file__).parent / "fixtures" / name).read_text(encoding="utf-8")
    return _load
