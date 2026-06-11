"""Workable public job-board search API.
Field paths confirmed against the captured fixture (2026-06-11).

Real shape:
  GET https://jobs.workable.com/api/v1/jobs?query=<q>
  → {"title":..., "totalSize":N, "jobs":[...], "autoAppliedFilters":{...}}

Per-job fields used:
  title        str
  url          str   (absolute https://jobs.workable.com/view/...)
  company      dict  company["title"] is the company name
  location     dict  {city, subregion, countryName}
  locations    list  [str]  (fallback)
  created      str   ISO-8601 datetime
  description  str   HTML
  workplace    str   "remote" | "hybrid" | "on_site"

Note: Workable already searches server-side by query, so _parse does NOT apply
title_matches_queries — the query was applied at the HTTP level in fetch().
"""

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_json

NAME = "workable"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

API = "https://jobs.workable.com/api/v1/jobs"


def _job_url(r):
    if r.get("url"):
        return str(r["url"])
    shortcode = r.get("shortcode") or r.get("id")
    return f"https://jobs.workable.com/view/{shortcode}" if shortcode else ""


def _location_str(r):
    loc = r.get("location") or {}
    if isinstance(loc, str):
        return loc
    if isinstance(loc, dict):
        parts = [loc.get("city"), loc.get("subregion"), loc.get("countryName")]
        joined = ", ".join(p for p in parts if p)
        if joined:
            return joined
    # fallback: locations list (list of strings)
    locs = r.get("locations")
    if isinstance(locs, list) and locs:
        return str(locs[0])
    return "—"


def _company_name(r):
    company = r.get("company")
    if isinstance(company, dict):
        return company.get("title") or company.get("name") or "—"
    return str(company or "—")


def _parse(payload):
    rows = payload.get("jobs") or payload.get("results") or []
    jobs = []
    for r in rows:
        title = str(r.get("title") or "").strip()
        url = _job_url(r)
        if not title or not url:
            continue
        if not url.startswith("http"):
            continue
        company = _company_name(r)
        description = strip_html(str(r.get("description") or ""))[:5000]
        location = _location_str(r)
        workplace = str(r.get("workplace") or "").lower()
        remote = workplace == "remote" or "remote" in f"{title} {location}".lower()
        office, relocate = derive_location_flags(title, description, location, remote)
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": str(company).strip() or "—",
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(r.get("created") or r.get("created_at") or r.get("published_on")),
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    jobs = []
    seen = set()
    for query in config.get("queries", []):
        payload = http_json(API, params={"query": query})
        for job in _parse(payload):
            if job["url"] in seen:
                continue
            seen.add(job["url"])
            jobs.append(job)
    return jobs
