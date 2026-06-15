import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_tests_dir.parent))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import justremote


def test_parses_into_valid_jobs(fixture_text):
    jobs = justremote._parse(fixture_text("justremote.html"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="justremote")
