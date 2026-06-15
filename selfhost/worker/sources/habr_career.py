"""Habr Career — Russian IT job board (server-rendered HTML).
Selectors confirmed against tests/fixtures/habr_career.html (2026-06-11)."""

from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "habr_career"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

URL = "https://career.habr.com/vacancies"
BASE = "https://career.habr.com"

# Selectors confirmed against fixture 2026-06-11
SELECTOR_CARD = ".vacancy-card"                       # each job listing card
SELECTOR_BACKDROP = ".vacancy-card__backdrop-link"    # main href → /vacancies/<id>
SELECTOR_TITLE = ".vacancy-card__title-link"          # job title text
SELECTOR_COMPANY = ".vacancy-card__company a"         # company name anchor
SELECTOR_META = ".vacancy-meta"                       # meta chips (grade, remote, cities)
SELECTOR_DATE = "time.basic-date"                     # <time datetime="ISO"> element

# Remote work chip uses the #format SVG icon; location chips use #placemark.
# We detect remote by checking for the text "Можно удалённо" or "удал"/"remote"
# (case-insensitive) inside the meta block.
_REMOTE_TEXTS = ("можно удалённо", "удал", "remote")


def _parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    seen_urls: set[str] = set()

    for card in soup.select(SELECTOR_CARD):
        # --- URL ---
        backdrop = card.select_one(SELECTOR_BACKDROP)
        if not backdrop:
            continue
        href = backdrop.get("href") or ""
        if not href:
            continue
        url = urljoin(BASE, href)
        if not url.startswith("http"):
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)

        # --- Title ---
        title_el = card.select_one(SELECTOR_TITLE)
        title = title_el.get_text(strip=True) if title_el else ""
        if not title:
            continue

        # --- Company ---
        company_el = card.select_one(SELECTOR_COMPANY)
        company = company_el.get_text(strip=True) if company_el else "—"
        if not company:
            company = "—"

        # --- Meta block: remote flag and location chips ---
        meta_el = card.select_one(SELECTOR_META)
        meta_text = meta_el.get_text(" ", strip=True) if meta_el else ""
        meta_lower = meta_text.lower()

        remote = any(t in meta_lower for t in _REMOTE_TEXTS)

        # Collect location city names from placemark chips
        city_names: list[str] = []
        if meta_el:
            for chip in meta_el.select(".basic-chip"):
                use_el = chip.find("use")
                if use_el:
                    icon_href = use_el.get("xlink:href", "") or use_el.get("href", "")
                    if "#placemark" in icon_href:
                        city_text = chip.get_text(strip=True)
                        if city_text:
                            city_names.append(city_text)

        if city_names:
            location = ", ".join(city_names)
        elif remote:
            location = "Remote"
        else:
            location = "—"

        # --- Description (full card text, stripped) ---
        description = strip_html(card.get_text(" "))[:5000]

        # --- Derive flags ---
        office, relocate = derive_location_flags(title, description, location, remote)

        # --- Date ---
        date_el = card.select_one(SELECTOR_DATE)
        posted_at = None
        if date_el:
            dt_attr = date_el.get("datetime") or ""
            if dt_attr:
                # ISO datetime like "2026-06-11T14:30:11+03:00" — take first 10 chars
                posted_at = dt_attr[:10]
            else:
                posted_at = parse_date(date_el.get_text(strip=True))

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
    """Fetch jobs from Habr Career for each query in config, dedup by URL."""
    seen_urls: set[str] = set()
    all_jobs: list[dict] = []

    for query in config.get("queries", []):
        html = http_get(URL, params={"q": query, "type": "all"})
        for job in _parse(html):
            if job["url"] not in seen_urls:
                seen_urls.add(job["url"])
                all_jobs.append(job)

    return all_jobs
