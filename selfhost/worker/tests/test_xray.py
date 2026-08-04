"""Tests for X-Ray discovery helpers (no live Search API calls)."""

import sys
from pathlib import Path

_worker = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_worker))

from sources.xray import build_xray_query, extract_slug


def test_extract_greenhouse():
    assert extract_slug("https://boards.greenhouse.io/stripe/jobs/123") == ("greenhouse", "stripe")
    assert extract_slug("https://job-boards.greenhouse.io/figma/jobs/1") == ("greenhouse", "figma")


def test_extract_lever_ashby():
    assert extract_slug("https://jobs.lever.co/shopify/abc-def") == ("lever", "shopify")
    assert extract_slug("https://jobs.ashbyhq.com/linear/job/uuid") == ("ashby", "linear")


def test_extract_workable_recruitee_personio():
    assert extract_slug("https://apply.workable.com/acme/j/ABC/") == ("workable", "acme")
    assert extract_slug("https://acme.recruitee.com/o/engineer") == ("recruitee", "acme")
    assert extract_slug("https://acme.jobs.personio.de/job/1") == ("personio", "acme")


def test_extract_rejects_noise():
    assert extract_slug("https://example.com/jobs") is None
    assert extract_slug("https://linkedin.com/jobs/view/1") is None


def test_build_xray_query_quotes_phrases():
    q = build_xray_query("jobs.lever.co", "product manager")
    assert "site:jobs.lever.co" in q
    assert '"product manager"' in q


def test_build_xray_query_bare_token():
    q = build_xray_query("boards.greenhouse.io", "remote")
    assert q == "site:boards.greenhouse.io remote"
