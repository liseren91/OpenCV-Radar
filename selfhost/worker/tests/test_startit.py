import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_tests_dir.parent))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import startit


def test_parses_into_valid_jobs(fixture_text):
    jobs = startit._parse(fixture_text("startit.xml"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="startit")


def test_remote_detection(fixture_text):
    """PHP Developer job has 'remote' in categories → remote=True."""
    jobs = startit._parse(fixture_text("startit.xml"))
    # The PHP Developer item has 'remote' category
    php_jobs = [j for j in jobs if "PHP" in j["title"]]
    assert php_jobs, "Expected a PHP Developer job in fixture"
    assert php_jobs[0]["remote"] is True


def test_company_extracted_from_categories(fixture_text):
    """Company name is extracted from the capitalized proper-noun category."""
    jobs = startit._parse(fixture_text("startit.xml"))
    # Senior React Developer → company should be Merkle
    react_jobs = [j for j in jobs if "React" in j["title"]]
    assert react_jobs, "Expected a React Developer job in fixture"
    assert react_jobs[0]["company"] == "Merkle"
