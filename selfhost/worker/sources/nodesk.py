"""NoDesk — static HTML remote-jobs listing.
Selectors confirmed against tests/fixtures/nodesk.html (2026-06-11)."""

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "nodesk"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

URL = "https://nodesk.co/remote-jobs/"
BASE = "https://nodesk.co"

# Selectors confirmed against fixture 2026-06-11
SELECTOR_CARD = "li.dt-s.dt-ns"   # each job listing row
SELECTOR_LINK = "h2 a[href]"       # anchor inside h2 — href is the job URL, text is the title
SELECTOR_TITLE = "h2 a"            # same element; .get_text() gives the title
SELECTOR_COMPANY = "h3"            # company name beneath the title

# Category/filter slugs that share the /remote-jobs/<slug>/ pattern but are
# NOT individual job postings.
_CATEGORY_SLUGS = frozenset({
    "collections", "new", "customer-support", "design", "engineering",
    "marketing", "non-tech", "operations", "product", "sales", "other",
    "asia", "canada", "europe", "full-time", "freelance", "part-time",
    "north-america", "us", "australia", "uk", "entry-level",
})
_JOB_HREF_RE = re.compile(r"^/remote-jobs/([^/]+)/?$")


def _is_job_href(href: str) -> bool:
    """Return True if href looks like a job-detail slug (not a category page)."""
    m = _JOB_HREF_RE.match(href)
    return bool(m) and m.group(1) not in _CATEGORY_SLUGS


def _parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    seen_urls: set[str] = set()

    for card in soup.select(SELECTOR_CARD):
        link_el = card.select_one(SELECTOR_LINK)
        if not link_el:
            continue
        href = link_el.get("href") or ""
        if not _is_job_href(href):
            continue

        url = urljoin(BASE, href)
        if url in seen_urls:
            continue
        seen_urls.add(url)

        title_el = card.select_one(SELECTOR_TITLE)
        title = title_el.get_text(strip=True) if title_el else ""
        if not title:
            continue

        company_el = card.select_one(SELECTOR_COMPANY)
        company = company_el.get_text(strip=True) if company_el else "—"

        description = strip_html(card.get_text(" "))[:5000]
        location = "Remote"
        remote = True
        office, relocate = derive_location_flags(title, description, location, remote)

        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": company or "—",
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": None,
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })

    return jobs


def fetch(config: dict) -> list[dict]:
    return _parse(http_get(URL))
