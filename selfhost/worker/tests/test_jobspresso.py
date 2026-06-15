import sys
from pathlib import Path

_tests_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_tests_dir.parent))
sys.path.insert(0, str(_tests_dir))

from helpers import assert_valid_jobs
from sources import jobspresso


def test_parses_feed_into_valid_jobs(fixture_text):
    jobs = jobspresso._parse(fixture_text("jobspresso.xml"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="jobspresso")


def test_company_extracted_from_author(fixture_text):
    """Company name must come from the dc:creator field, not the title."""
    jobs = jobspresso._parse(fixture_text("jobspresso.xml"))
    # Every job should have a non-empty company (not just "—")
    companies = [j["company"] for j in jobs]
    assert any(c != "—" for c in companies), f"all companies are fallback: {companies}"


def test_urls_are_absolute(fixture_text):
    jobs = jobspresso._parse(fixture_text("jobspresso.xml"))
    for j in jobs:
        assert j["url"].startswith("https://"), f"non-absolute url: {j['url']}"


def test_all_remote_true(fixture_text):
    """Jobspresso is a remote-only board — every job must be remote=True."""
    jobs = jobspresso._parse(fixture_text("jobspresso.xml"))
    for j in jobs:
        assert j["remote"] is True, f"expected remote=True for {j['title']}"


def test_extract_company_helper():
    assert jobspresso._extract_company("Acme Corp<br>⚲&nbsp;US") == "Acme Corp"
    assert jobspresso._extract_company("Zapier<br>⚲&nbsp;Worldwide") == "Zapier"
    assert jobspresso._extract_company("") == "—"
    assert jobspresso._extract_company("NoBreakTag") == "NoBreakTag"
