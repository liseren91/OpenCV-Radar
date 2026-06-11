import json
import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
_worker_dir = _tests_dir.parent
sys.path.insert(0, str(_worker_dir))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import jooble


def test_parses_fixture_into_valid_jobs(fixture_text):
    raw = json.loads(fixture_text("jooble.json"))
    jobs = jooble._parse(raw, location="Serbia")
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="jooble")
