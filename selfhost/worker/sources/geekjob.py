"""GeekJob — Russian IT job board (server-rendered HTML).
Selectors confirmed against tests/fixtures/geekjob.html (2026-06-11).

Vacancy list URL:  https://geekjob.ru/vacancies          (plain listing)
Search URL:        https://geekjob.ru/vacancies?qs=<q>   (query-filtered)

Each card is a <li class="collection-item avatar"> inside
<ul class="collection serp-list" id="serplist">.
"""

from copy import copy
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "geekjob"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

BASE = "https://geekjob.ru"
URL = "https://geekjob.ru/vacancies"

# Selectors confirmed against fixture 2026-06-11
SELECTOR_LIST = "ul#serplist"                    # outer list container
SELECTOR_CARD = "ul#serplist li.collection-item" # each job card
SELECTOR_TITLE = "p.vacancy-name a.title"        # title anchor, text = job title
SELECTOR_COMPANY = "p.company-name a"            # company name anchor
SELECTOR_INFO = "div.info a"                     # first info div holds location + salary span
SELECTOR_SALARY = "span.salary"                  # salary inside div.info a
SELECTOR_DATE = "time.datetime-info a"           # date text (Russian, e.g. "11 июня")
SELECTOR_REMOTE = ".remote-label"                # present when remote
SELECTOR_RELOCATE = ".relocate-label"            # present when relocation offered
SELECTOR_INHOUSE = ".inhouse-label"              # present when office required


def _parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    jobs: list[dict] = []
    seen_urls: set[str] = set()

    for card in soup.select(SELECTOR_CARD):
        # --- URL (from title anchor) ---
        title_el = card.select_one(SELECTOR_TITLE)
        if not title_el:
            continue
        href = title_el.get("href") or ""
        if not href:
            continue
        url = urljoin(BASE, href)
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

        # --- Location: extracted from first div.info > a, stripping the salary span ---
        location = "—"
        info_a = card.select_one(SELECTOR_INFO)
        if info_a:
            # Clone to avoid mutating the soup; strip salary span to isolate location text
            info_clone = copy(info_a)
            sal_el = info_clone.find("span", class_="salary")
            if sal_el:
                sal_el.decompose()
            loc_text = info_clone.get_text(strip=True)
            if loc_text:
                location = loc_text

        # --- Remote / office / relocate flags ---
        remote = bool(card.select_one(SELECTOR_REMOTE))
        has_inhouse = bool(card.select_one(SELECTOR_INHOUSE))
        has_relocate = bool(card.select_one(SELECTOR_RELOCATE))

        # If explicit inhouse label, override location detection
        if location == "—" and remote:
            location = "Remote"

        description = strip_html(card.get_text(" "))[:5000]
        office, relocate = derive_location_flags(title, description, location, remote)

        # If the site marks inhouse or relocate explicitly, honour those flags
        if has_inhouse:
            office = True
        if has_relocate:
            relocate = True

        # --- Salary ---
        salary_el = card.select_one(SELECTOR_SALARY)
        salary = salary_el.get_text(strip=True) if salary_el else None
        if salary == "":
            salary = None

        # --- Date ---
        date_el = card.select_one(SELECTOR_DATE)
        posted_at = None
        if date_el:
            date_text = date_el.get_text(strip=True)
            if date_text:
                posted_at = parse_date(date_text)

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
    """Fetch jobs from GeekJob for each query in config, dedup by URL."""
    seen_urls: set[str] = set()
    all_jobs: list[dict] = []

    for query in config.get("queries", []):
        html = http_get(URL, params={"qs": query})
        for job in _parse(html):
            if job["url"] not in seen_urls:
                seen_urls.add(job["url"])
                all_jobs.append(job)

    return all_jobs
