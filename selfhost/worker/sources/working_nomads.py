"""Working Nomads — public JSON feed of remote jobs.
Endpoint returns the full feed; we filter client-side by a whole-word title match
(the same predicate the central worker filter uses).
"""

from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries,
)
from .base import http_json

NAME = "working_nomads"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

API = "https://www.workingnomads.com/api/exposed_jobs/"


def _parse(rows, queries):
    jobs = []
    for r in rows:
        title = str(r.get("title") or "").strip()
        url = str(r.get("url") or "").strip()
        if not title or not url:
            continue
        # Ensure url is absolute (the feed returns absolute URLs, but guard anyway)
        if url.startswith("/"):
            url = "https://www.workingnomads.com" + url
        description = strip_html(str(r.get("description") or ""))[:5000]
        # Working Nomads is a remote board -> treat as remote unless location says otherwise.
        location = str(r.get("location") or "Remote").strip() or "Remote"
        remote = True
        office, relocate = derive_location_flags(title, description, location, remote)
        # Volume filter for this full-feed endpoint: whole-word title match only.
        # Description substring matching is deliberately avoided — it readmits the
        # full-text noise (jobs that merely *mention* a query) the title guard removes.
        if queries and not title_matches_queries(title, queries):
            continue
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": str(r.get("company_name") or "—").strip() or "—",
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(r.get("pub_date")),
            "salary": None,
            "description": description,
            # derive_tags (title/description) for cross-source consistency;
            # the API's own `tags`/`category_name` fields are intentionally ignored.
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    rows = http_json(API)
    if not isinstance(rows, list):
        rows = rows.get("jobs", []) if isinstance(rows, dict) else []
    return _parse(rows, config.get("queries", []))
