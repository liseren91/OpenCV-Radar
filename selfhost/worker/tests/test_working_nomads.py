import json
import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
_worker_dir = _tests_dir.parent
sys.path.insert(0, str(_worker_dir))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import working_nomads


def test_parses_fixture_into_valid_jobs(fixture_text):
    raw = json.loads(fixture_text("working_nomads.json"))
    jobs = working_nomads._parse(raw, queries=["product manager", "developer"])
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="working_nomads")


def test_query_filter_excludes_unrelated(fixture_text):
    raw = json.loads(fixture_text("working_nomads.json"))
    jobs = working_nomads._parse(raw, queries=["zzzznomatch"])
    assert jobs == []
