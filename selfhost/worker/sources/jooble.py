"""Jooble — official aggregator API. One POST per query. Requires a free API key."""

import os

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_json

NAME = "jooble"
REQUIRES_ENV = ["JOOBLE_API_KEY"]
ENABLED_BY_DEFAULT = True

BASE = "https://jooble.org/api/"


def _parse(payload, location):
    jobs = []
    for r in (payload.get("jobs") or []):
        title = str(r.get("title") or "").strip()
        url = str(r.get("link") or "").strip()
        if not title or not url:
            continue
        description = strip_html(str(r.get("snippet") or ""))[:5000]
        loc = str(r.get("location") or location or "—").strip() or "—"
        remote = "remote" in f"{title} {loc}".lower()
        office, relocate = derive_location_flags(title, description, loc, remote)
        salary_text = str(r.get("salary") or "").strip()
        salary = None
        if salary_text:
            try:
                from price_parser import Price
                p = Price.fromstring(salary_text)
                if p.amount and p.amount > 1000:
                    salary = {"min": int(p.amount), "max": int(p.amount),
                              "currency": p.currency or "EUR", "source": NAME}
            except Exception:  # noqa: BLE001 — salary text is best-effort
                salary = None
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": str(r.get("company") or "—").strip() or "—",
            "location": loc,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(r.get("updated")),
            "salary": salary,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    key = os.environ["JOOBLE_API_KEY"]
    location = config.get("location", "")
    jobs = []
    seen = set()
    for query in config.get("queries", []):
        payload = http_json(BASE + key, method="POST",
                            json_body={"keywords": query, "location": location})
        for job in _parse(payload, location):
            if job["url"] in seen:
                continue
            seen.add(job["url"])
            jobs.append(job)
    return jobs
