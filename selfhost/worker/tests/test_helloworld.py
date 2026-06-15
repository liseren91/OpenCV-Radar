import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_tests_dir.parent))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import helloworld


def test_parses_html_into_valid_jobs(fixture_text):
    jobs = helloworld._parse(fixture_text("helloworld.html"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="helloworld")
