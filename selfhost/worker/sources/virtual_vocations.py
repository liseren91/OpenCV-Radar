"""Virtual Vocations — embedded JSON (Vue :job attribute) remote-jobs listing.
Selectors confirmed against tests/fixtures/virtual_vocations.html (2026-06-11).

The page is a Vue SPA but the server inlines full job data as JSON inside
<job-result :job='...'> component attributes, so no headless browser is needed.

Company is not included in the embedded JSON; falls back to "—".
"""

import json
import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "virtual_vocations"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

URL = "https://www.virtualvocations.com/jobs/"
BASE = "https://www.virtualvocations.com"

# Pattern that matches valid job-detail URLs (not category/filter pages)
_JOB_URL_RE = re.compile(r"/job/[^/]+-\d+", re.I)


def _is_valid_job_url(url: str) -> bool:
    """Return True if the URL looks like a real job-detail page."""
    return bool(_JOB_URL_RE.search(url))


def _parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    jobs: list[dict] = []
    seen_urls: set[str] = set()

    for el in soup.find_all("job-result"):
        raw = el.get(":job") or ""
        if not raw:
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue

        # --- URL ---
        url = (item.get("url") or "").strip()
        if not url:
            continue
        url = urljoin(BASE, url)
        if not url.startswith("http"):
            continue
        if not _is_valid_job_url(url):
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)

        # --- Title ---
        title = (item.get("title") or "").strip()
        if not title:
            continue

        # --- Description (truncated snippet from the server) ---
        description = strip_html(item.get("description") or "")[:5000]

        # --- Company (not present in embedded JSON) ---
        company = "—"

        # --- Location ---
        # All Virtual Vocations listings are remote; description may hint at
        # region requirements or hybrid/office flags.
        location = "Remote"
        remote = True
        office, relocate = derive_location_flags(title, description, location, remote)

        # --- Date ---
        time_ago = (item.get("time_ago") or "").strip()
        posted_at = parse_date(time_ago) if time_ago else None

        # --- Skills / Tags ---
        skills: list[str] = item.get("skills") or []
        tags = list(dict.fromkeys(
            derive_tags(title, description) + [s for s in skills if isinstance(s, str)]
        ))

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
            "tags": tags,
        })

    return jobs


def fetch(config: dict) -> list[dict]:
    return _parse(http_get(URL))
