import json
import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_tests_dir.parent))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import workable


def test_parses_fixture_into_valid_jobs(fixture_text):
    raw = json.loads(fixture_text("workable.json"))
    jobs = workable._parse(raw)
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="workable")
