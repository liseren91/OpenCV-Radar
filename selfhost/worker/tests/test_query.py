"""Tests for the Boolean query language (query.py)."""

import sys
from pathlib import Path

_worker = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_worker))

from normalize import title_matches_queries
from query import (
    expand_to_api_terms,
    job_matches_queries,
    matches_any_query,
    matches_query,
    parse_query,
    queries_to_api_terms,
    tokenize,
    try_parse_query,
)


def _job(**kw):
    base = {
        "title": "",
        "company": "",
        "location": "",
        "description": "",
        "tags": [],
    }
    base.update(kw)
    return base


# ---------- Tokenizer / parser ----------

def test_tokenize_plain_words():
    assert tokenize("product manager") == [("WORD", "product"), ("WORD", "manager")]


def test_tokenize_phrase_and_ops():
    toks = tokenize('(product manager OR "product owner") -sales')
    kinds = [k for k, _ in toks]
    assert "LPAREN" in kinds and "RPAREN" in kinds
    assert ("OP", "OR") in toks
    assert ("OP", "NOT") in toks
    assert ("PHRASE", "product owner") in toks
    assert ("WORD", "sales") in toks


def test_tokenize_field_phrase():
    toks = tokenize('title:"product manager" desc:AI')
    assert ("FIELD", "title") in toks
    assert ("PHRASE", "product manager") in toks
    assert ("FIELD", "desc") in toks
    assert ("WORD", "AI") in toks


def test_parse_plain_is_and_of_terms():
    ast = parse_query("product manager")
    assert ast["type"] == "AND"
    assert len(ast["children"]) == 2
    assert all(c["type"] == "TERM" and c["field"] == "title" for c in ast["children"])


def test_parse_or_and_not():
    ast = parse_query("(product manager OR product owner) -sales")
    assert ast["type"] == "AND"
    assert ast["children"][0]["type"] == "OR"
    assert ast["children"][1]["type"] == "NOT"


def test_parse_error_unbalanced():
    ast, err = try_parse_query("(product manager")
    assert ast is None and err


# ---------- Matching ----------

def test_plain_and_on_title():
    job = _job(title="Senior Product Manager")
    assert matches_query(parse_query("product manager"), job)
    assert not matches_query(parse_query("product manager"), _job(title="Sales Manager"))


def test_phrase_match():
    job = _job(title="Head of Product, Growth")
    assert matches_query(parse_query('"head of product"'), job)
    assert not matches_query(parse_query('"head of product"'), _job(title="Product Head"))


def test_or_and_not():
    pm = _job(title="Product Manager")
    po = _job(title="Product Owner")
    sales = _job(title="Product Manager, Sales")
    q = parse_query("(product manager OR product owner) -sales")
    assert matches_query(q, pm)
    assert matches_query(q, po)
    assert not matches_query(q, sales)


def test_field_company_and_desc():
    job = _job(title="Engineer", company="Stripe", description="We use AI daily")
    assert matches_query(parse_query("company:stripe"), job)
    assert matches_query(parse_query("desc:AI"), job)
    assert not matches_query(parse_query("company:figma"), job)


def test_field_loc_negation():
    us = _job(title="Product Manager", location="United States")
    eu = _job(title="Product Manager", location="Berlin, Germany")
    q = parse_query('product manager -loc:"United States"')
    assert not matches_query(q, us)
    assert matches_query(q, eu)


def test_tag_field():
    job = _job(title="PM", tags=["AI", "Remote"])
    assert matches_query(parse_query("tag:AI"), job)
    assert not matches_query(parse_query("tag:Sales"), job)


def test_matches_any_query_or_across_list():
    job = _job(title="Marketing Technology Lead")
    assert matches_any_query(job, ["product manager", "marketing technology"])
    assert not matches_any_query(job, ["product manager", "data scientist"])


# ---------- Legacy parity ----------

def test_legacy_parity_plain_queries():
    titles = [
        "Senior Product Manager",
        "Product Owner",
        "Sales Account Executive",
        "Head of Product",
        "AI Product Manager",
        "Junior Developer",
    ]
    queries = ["product manager", "product owner", "head of product"]
    for title in titles:
        job = _job(title=title)
        legacy = title_matches_queries(title, queries)
        modern = job_matches_queries(job, queries, title_only_compat=True)
        assert modern == legacy, f"mismatch on {title!r}: legacy={legacy} modern={modern}"


def test_legacy_parity_via_matches_query():
    """Plain 'product manager' must equal title_matches_queries for that single query."""
    for title in ["Product Manager", "Sales Manager", "product  manager", "PRODUCT MANAGER role"]:
        legacy = title_matches_queries(title, ["product manager"])
        modern = matches_query(parse_query("product manager"), _job(title=title))
        assert modern == legacy, f"{title!r}: {legacy=} {modern=}"


# ---------- expandToApiTerms ----------

def test_expand_plain():
    assert expand_to_api_terms(parse_query("product manager")) == ["product manager"]


def test_expand_or():
    terms = expand_to_api_terms(parse_query("product manager OR product owner"))
    assert set(terms) == {"product manager", "product owner"}


def test_expand_or_with_not():
    terms = expand_to_api_terms(parse_query("(product manager OR product owner) -sales"))
    assert set(terms) == {"product manager", "product owner"}


def test_queries_to_api_terms_dedupes():
    terms = queries_to_api_terms(["product manager", "product manager OR pm"])
    lower = [t.lower() for t in terms]
    assert lower.count("product manager") == 1


def test_job_matches_boolean():
    job = _job(title="Product Owner", description="No sales")
    assert job_matches_queries(job, ["(product manager OR product owner) -sales"])
    assert not job_matches_queries(
        _job(title="Product Manager Sales"),
        ["(product manager OR product owner) -sales"],
    )
