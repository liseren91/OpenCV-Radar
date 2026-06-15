"""JustRemote — embedded JSON (window.__PRELOADED_STATE__) remote-jobs listing.
Selectors confirmed against tests/fixtures/justremote.html (2026-06-11).

The page is a React SPA, but the server inlines the full job list as a JSON
blob inside a <script> tag, so no headless browser is required.
"""

import json
import re

from normalize import (
    stable_id, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "justremote"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

URL = "https://justremote.co/remote-jobs"
BASE = "https://justremote.co"

# Regex to extract the preloaded state JSON blob from the HTML.
_STATE_RE = re.compile(
    r'window\.__PRELOADED_STATE__\s*=\s*(\{.*?\})\s*</script>',
    re.DOTALL,
)


def _extract_jobs_json(html: str) -> list[dict]:
    """Return the raw job dicts from window.__PRELOADED_STATE__."""
    m = _STATE_RE.search(html)
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    # jobsState.entity.all is the full listing (90 jobs in fixture)
    try:
        return data["jobsState"]["entity"]["all"] or []
    except (KeyError, TypeError):
        return []


def _parse(html: str) -> list[dict]:
    raw_jobs = _extract_jobs_json(html)
    jobs: list[dict] = []
    seen_urls: set[str] = set()

    for item in raw_jobs:
        # --- URL ---
        href = (item.get("href") or "").strip()
        if not href:
            continue
        # hrefs are relative without leading slash, e.g.
        # "remote-developer-jobs/senior-engineer-acme"
        url = f"{BASE}/{href}"
        if url in seen_urls:
            continue
        seen_urls.add(url)

        # --- Title ---
        title = (item.get("title") or "").strip()
        if not title:
            continue

        # --- Company ---
        company = (item.get("company_name") or "").strip() or "—"

        # --- Location ---
        # location_restrictions lists countries/regions the job is open to.
        # Use the first entry as location label if present; else "Remote".
        restrictions: list[str] = item.get("location_restrictions") or []
        if len(restrictions) == 1:
            location = restrictions[0]
        elif len(restrictions) > 1:
            # Many restrictions = worldwide-ish remote
            location = "Remote"
        else:
            location = "Remote"

        remote = True  # All listings on JustRemote are remote positions

        description = title  # No per-listing description in the listing JSON
        office, relocate = derive_location_flags(title, description, location, remote)

        # --- Date ---
        raw_date = (item.get("date") or "").strip()
        posted_at = parse_date(raw_date) if raw_date else None

        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": company,
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": posted_at,
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })

    return jobs


def fetch(config: dict) -> list[dict]:
    return _parse(http_get(URL))
