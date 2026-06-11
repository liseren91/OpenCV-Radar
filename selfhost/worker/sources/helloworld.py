"""HelloWorld.rs — Serbian IT job board (server-rendered HTML).
Selectors confirmed against tests/fixtures/helloworld.html (2026-06-11)."""

import re
from datetime import datetime
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, derive_location_flags, derive_tags, parse_salary_text,
)
from .base import http_get

NAME = "helloworld"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

BASE = "https://www.helloworld.rs"
URL = "https://www.helloworld.rs/oglasi-za-posao"

# Search param confirmed from form input name: ?q=product+manager
SEARCH_PARAM = "q"

# Selectors confirmed against fixture 2026-06-11
# Job cards are direct children of div.__search-results that contain a job title link
SELECTOR_RESULTS = "div.__search-results"

# Job title anchor carries class __ga4_job_title
SELECTOR_TITLE = "a.__ga4_job_title"

# Company anchor carries class __ga4_job_company
SELECTOR_COMPANY = "a.__ga4_job_company"

# Location and date are in consecutive <p class="text-sm font-semibold"> inside the card
# First = location, last = date (DD.MM.YYYY. with optional trailing dot)
_DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}\.?$")

# Salary: span with class containing 'font-semibold' and text containing RSD or EUR
_SALARY_RE = re.compile(r"RSD|EUR", re.IGNORECASE)

# Remote detection on card text or location
_REMOTE_RE = re.compile(
    r"remote|rad od ku[ćc]e|daljinski|na daljinu|work from home",
    re.IGNORECASE,
)


def _parse_date(text: str) -> str | None:
    """Parse DD.MM.YYYY. or DD.MM.YYYY → ISO date string, or return None."""
    cleaned = text.strip().rstrip(".")
    try:
        return datetime.strptime(cleaned, "%d.%m.%Y").date().isoformat()
    except ValueError:
        return None


def _parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    seen_urls: set[str] = set()

    # Find the search-results container
    results_div = soup.find("div", class_="__search-results")
    if not results_div:
        return jobs

    for card in results_div.find_all("div", recursive=False):
        # Only process cards that contain a job title anchor
        title_el = card.select_one(SELECTOR_TITLE)
        if not title_el:
            continue

        # --- URL ---
        href = title_el.get("href") or ""
        # Strip tracking query-string
        href_clean = re.sub(r"\?.*", "", href)
        url = urljoin(BASE, href_clean)
        if not url.startswith("http"):
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)

        # --- Title ---
        title = title_el.get_text(strip=True)
        if not title:
            continue

        # --- Company ---
        company_el = card.select_one(SELECTOR_COMPANY)
        company = company_el.get_text(strip=True) if company_el else "—"
        if not company:
            company = "—"

        # --- Location and Date ---
        # Both stored in <p class="text-sm font-semibold"> elements
        semibolds = card.find_all(
            "p",
            class_=lambda c: c and "text-sm" in c and "font-semibold" in c,
        )
        semibold_texts = [p.get_text(strip=True) for p in semibolds]

        location = "—"
        date_str = None

        if semibold_texts:
            # Last element that matches date pattern is the date
            for i in range(len(semibold_texts) - 1, -1, -1):
                if _DATE_RE.match(semibold_texts[i]):
                    date_str = semibold_texts[i]
                    # Location is everything before the date
                    loc_parts = semibold_texts[:i]
                    if loc_parts:
                        location = loc_parts[-1]
                    break
            else:
                # No date found; first semibold is location
                if semibold_texts:
                    location = semibold_texts[0]

        if not location:
            location = "—"

        # --- Remote detection ---
        card_text = card.get_text(" ", strip=True)
        remote = bool(_REMOTE_RE.search(card_text)) or bool(_REMOTE_RE.search(location))

        # --- Derive office / relocate flags ---
        description = strip_html(card_text)[:5000]
        office, relocate = derive_location_flags(title, description, location, remote)

        # --- Date ---
        posted_at = _parse_date(date_str) if date_str else None

        # --- Salary ---
        salary = None
        for span in card.find_all("span"):
            txt = span.get_text(strip=True)
            if _SALARY_RE.search(txt):
                salary = parse_salary_text(txt, NAME, default_currency="RSD")
                break

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
            "salary": salary,
            "description": description,
            "tags": derive_tags(title, description),
        })

    return jobs


def fetch(config: dict) -> list[dict]:
    """Fetch jobs from HelloWorld.rs for each query in config, dedup by URL."""
    seen_urls: set[str] = set()
    all_jobs: list[dict] = []

    for query in config.get("queries", []):
        html = http_get(URL, params={SEARCH_PARAM: query})
        for job in _parse(html):
            if job["url"] not in seen_urls:
                seen_urls.add(job["url"])
                all_jobs.append(job)

    return all_jobs
