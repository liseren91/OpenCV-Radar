import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_tests_dir.parent))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import hubstaff


def test_parses_into_valid_jobs(fixture_text):
    raw = fixture_text("hubstaff.html")
    jobs = hubstaff._parse(raw)
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="hubstaff")
