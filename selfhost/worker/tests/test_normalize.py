import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # selfhost/worker on path

from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries, parse_salary_text,
)


def test_stable_id_is_deterministic_and_short():
    a = stable_id("src", "https://x/1")
    b = stable_id("src", "https://x/1")
    assert a == b and len(a) == 16


def test_strip_html_collapses_tags_and_whitespace():
    assert strip_html("<p>Hello   <b>world</b></p>") == "Hello world"


def test_parse_date_handles_iso_and_relative():
    from datetime import datetime
    assert parse_date("2026-06-01") == "2026-06-01"
    assert parse_date("2026-06-01T10:00:00Z") == "2026-06-01"
    assert parse_date(datetime(2026, 6, 1, 10, 0, 0)) == "2026-06-01"  # JobSpy returns datetimes
    assert parse_date(None) is None
    assert parse_date("") is None


def test_derive_location_flags_remote_only_is_not_office():
    office, relocate = derive_location_flags(
        title="Product Manager", description="Fully remote role.",
        location="Remote, EU", remote=True,
    )
    assert office is False and relocate is False


def test_derive_location_flags_onsite_default_and_relocation_signal():
    office, relocate = derive_location_flags(
        title="PM", description="We sponsor visas and help you relocate.",
        location="Belgrade, Serbia", remote=False,
    )
    assert office is True and relocate is True


def test_derive_tags_role_from_title_only():
    tags = derive_tags("Senior Product Manager", "work with sales and engineers")
    assert "Product" in tags and "Senior" in tags
    assert "Sales" not in tags  # sales mentioned only in description


def test_title_matches_queries_requires_all_words():
    assert title_matches_queries("Senior Product Manager", ["product manager"]) is True
    assert title_matches_queries("Sales Executive", ["product manager"]) is False


def test_parse_salary_text_returns_dict_or_none():
    s = parse_salary_text("neto 150.000,00 - 400.000,00 RSD", "poslovi", default_currency="RSD")
    assert s == {"min": 150000, "max": 400000, "currency": "RSD", "source": "poslovi"}
    eur = parse_salary_text("€60k", "x", default_currency="EUR")
    assert eur["currency"] == "EUR" and eur["min"] == 60000
    rub = parse_salary_text("от 200 000 ₽", "geekjob", default_currency="RUB")
    assert rub["currency"] == "RUB" and rub["min"] == 200000
    assert parse_salary_text("", "x") is None
    assert parse_salary_text("Competitive", "x") is None
