"""Hubstaff Talent — remote jobs board.

The search page is server-rendered as a Rails UJS response: requesting
  GET /search/jobs?search[keywords]=<query>
with header  Accept: text/javascript  and  X-Requested-With: XMLHttpRequest
returns JavaScript of the form:
  $('#results').html("...escaped HTML...");

We extract and unescape that HTML fragment, then parse it with BeautifulSoup.

Selectors confirmed against tests/fixtures/hubstaff.html (2026-06-11).
"""

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import stable_id, strip_html, parse_date, derive_location_flags, derive_tags
from .base import http_get

NAME = "hubstaff"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

BASE = "https://talent.hubstaff.com"
SEARCH_URL = f"{BASE}/search/jobs"

# Rails UJS response format: $('selector').html("ESCAPED_HTML");
_JS_HTML_RE = re.compile(r"html\(\"(.+)\"\)", re.DOTALL)

# Selectors confirmed against fixture 2026-06-11
SELECTOR_CARD = "div.search-result"
SELECTOR_TITLE_LINK = "a.name"          # href=/jobs/<slug>, text=title
SELECTOR_COMPANY = "a.job-agency"       # company name link
SELECTOR_LOCATION = "span.location"     # "HQ: City, Region, Country"
SELECTOR_REMOTE_ICON = "i.hi-remote"    # present when job is remote
SELECTOR_DATE_ICON = "i.hi-calendar"    # preceding sibling gives date text


def _extract_html(js_text: str) -> str:
    """Extract the HTML fragment from a Rails UJS JS response string."""
    m = _JS_HTML_RE.search(js_text)
    if not m:
        return js_text  # already plain HTML, return as-is
    escaped = m.group(1)
    # Unescape: \" -> "  and  \/ -> /
    return escaped.replace('\\"', '"').replace('\\/', '/')


def _parse(js_text: str) -> list[dict]:
    html = _extract_html(js_text)
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    seen_urls: set[str] = set()

    for card in soup.select(SELECTOR_CARD):
        # Title and URL
        title_el = card.select_one(SELECTOR_TITLE_LINK)
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        if not title:
            continue
        href = title_el.get("href") or ""
        if not href.startswith("/jobs/"):
            continue
        url = urljoin(BASE, href)
        if url in seen_urls:
            continue
        seen_urls.add(url)

        # Company
        company_el = card.select_one(SELECTOR_COMPANY)
        company = company_el.get_text(strip=True) if company_el else "—"

        # Location — strip the "HQ:" prefix if present
        location_el = card.select_one(SELECTOR_LOCATION)
        raw_location = location_el.get_text(strip=True) if location_el else ""
        raw_location = re.sub(r"^HQ:\s*", "", raw_location).strip()
        location = raw_location or "Remote"

        # Remote flag — icon is present when the listing is marked "Remote job"
        remote = card.select_one(SELECTOR_REMOTE_ICON) is not None

        # Date — the span that follows the hi-calendar icon
        posted_at = None
        cal_icon = card.select_one(SELECTOR_DATE_ICON)
        if cal_icon and cal_icon.parent:
            date_text = cal_icon.parent.get_text(strip=True)
            if date_text and date_text.lower() not in ("remote job", "created"):
                posted_at = parse_date(date_text)

        description = strip_html(card.get_text(" "))[:5000]
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
            "posted_at": posted_at,
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })

    return jobs


def fetch(config: dict) -> list[dict]:
    queries = config.get("queries") or ["product manager"]
    all_jobs: list[dict] = []
    seen_urls: set[str] = set()

    for query in queries:
        js_text = http_get(
            SEARCH_URL,
            params={"search[keywords]": query},
            headers={
                "Accept": "text/javascript, application/javascript",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": SEARCH_URL,
            },
        )
        for job in _parse(js_text):
            if job["url"] not in seen_urls:
                seen_urls.add(job["url"])
                all_jobs.append(job)

    return all_jobs
