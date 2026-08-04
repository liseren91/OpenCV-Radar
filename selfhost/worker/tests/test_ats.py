"""Tests for ATS board parsers (fixtures, no live network)."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

_tests = Path(__file__).resolve().parent
_worker = _tests.parent
sys.path.insert(0, str(_worker))
sys.path.insert(0, str(_tests))

from helpers import assert_valid_jobs
from sources import ats


def test_greenhouse_parse_and_filter(fixture_text):
    raw = json.loads(fixture_text("ats_greenhouse.json"))
    with patch.object(ats, "http_json", return_value=raw):
        jobs = ats.fetch_greenhouse("stripe")
    assert_valid_jobs(jobs, source_name="ats")
    titles = {j["title"] for j in jobs}
    assert "Product Manager" in titles
    filtered = ats._parse_platform_jobs("greenhouse", jobs, ["product manager"])
    assert len(filtered) == 1
    assert filtered[0]["title"] == "Product Manager"
    assert "ats:greenhouse" in filtered[0]["tags"]


def test_lever_parse(fixture_text):
    raw = json.loads(fixture_text("ats_lever.json"))
    with patch.object(ats, "http_json", return_value=raw):
        jobs = ats.fetch_lever("shopify")
    assert_valid_jobs(jobs, source_name="ats")
    assert any(j["title"] == "Senior Product Manager" for j in jobs)
    assert all(j["remote"] or "Warehouse" in j["title"] for j in jobs)


def test_seed_companies_include_greenhouse():
    companies = ats._load_companies()
    assert "stripe" in companies["greenhouse"]
    assert "shopify" in companies["lever"]
