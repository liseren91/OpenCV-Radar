"""Poslovi Infostud — largest Serbian job board (server-rendered HTML).
Selectors confirmed against tests/fixtures/poslovi.html (2026-06-11)."""

import re
from datetime import datetime
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "poslovi"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

URL = "https://poslovi.infostud.com/oglasi-za-posao"
BASE = "https://poslovi.infostud.com"

# Search param confirmed from canonical link: ?keyword=product+manager
SEARCH_PARAM = "keyword"

# Selectors confirmed against fixture 2026-06-11
# Each job card carries a data-job-id attribute
SELECTOR_CARD = "[data-job-id]"

# Two card layouts exist:
#   "regular"  – company is wrapped in div.flex.items-center.gap-6 inside the
#                flex-col.gap-1 meta container; direct <p> children of the
#                container are [location, date].
#   "featured" – company <p class="notranslate"> is a DIRECT child of the
#                flex-col.gap-1 container; direct <p> children are
#                [company, location, date].
# The presence of the company p as a direct child distinguishes the two.

# Remote detection: location text or card body contains these Serbian/English terms
_REMOTE_RE = re.compile(
    r"remote|rad od ku[ćc]e|daljinski|na daljinu|hibrid",
    re.IGNORECASE,
)

# Date stored as DD.MM.YYYY in the third meta <p>
_DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")


def _parse_date(text: str) -> str | None:
    """Parse DD.MM.YYYY → ISO date string, or return None."""
    try:
        return datetime.strptime(text.strip(), "%d.%m.%Y").date().isoformat()
    except ValueError:
        return None


def _get_meta_ps(company_p):
    """Walk up the DOM to find the flex-col gap-1 meta container,
    returning (direct_p_list, company_is_direct_child)."""
    node = company_p
    for _ in range(6):
        node = node.parent
        if node is None:
            return [], False
        cls_str = " ".join(node.get("class") or [])
        if "flex-col" in cls_str and "gap-1" in cls_str:
            direct_ps = node.find_all("p", recursive=False)
            company_is_direct = company_p in direct_ps
            return direct_ps, company_is_direct
    return [], False


def _parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    seen_urls: set[str] = set()

    for card in soup.select(SELECTOR_CARD):
        # --- URL: first <a href> on the card (absolute or relative) ---
        link_el = card.find("a", href=True)
        if not link_el:
            continue
        href = link_el.get("href") or ""
        # Strip tracking query-string, keep path + job-id
        href_clean = re.sub(r"\?.*", "", href)
        url = urljoin(BASE, href_clean)
        if not url.startswith("http"):
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)

        # --- Title: h2 inside the card ---
        h2 = card.find("h2")
        title = h2.get_text(strip=True) if h2 else ""
        if not title:
            continue

        # --- Company / location / date via meta container ---
        company_p = card.find("p", class_=lambda c: c and "notranslate" in c)
        company = company_p.get_text(strip=True) if company_p else "—"
        if not company:
            company = "—"

        location = "—"
        date_str = None

        if company_p:
            ps, company_direct = _get_meta_ps(company_p)
            if company_direct:
                # Featured layout: ps = [company, location, date]
                if len(ps) >= 2:
                    location = ps[1].get_text(strip=True)
                if len(ps) >= 3:
                    candidate = ps[2].get_text(strip=True)
                    if _DATE_RE.match(candidate):
                        date_str = candidate
            else:
                # Regular layout: ps = [location, date]
                if len(ps) >= 1:
                    location = ps[0].get_text(strip=True)
                if len(ps) >= 2:
                    candidate = ps[1].get_text(strip=True)
                    if _DATE_RE.match(candidate):
                        date_str = candidate

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

        # --- Salary: span containing RSD or EUR ---
        salary = None
        for span in card.find_all("span"):
            txt = span.get_text(strip=True)
            if re.search(r"RSD|EUR", txt):
                salary = txt
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
    """Fetch jobs from Poslovi Infostud for each query in config, dedup by URL."""
    seen_urls: set[str] = set()
    all_jobs: list[dict] = []

    for query in config.get("queries", []):
        html = http_get(URL, params={SEARCH_PARAM: query})
        for job in _parse(html):
            if job["url"] not in seen_urls:
                seen_urls.add(job["url"])
                all_jobs.append(job)

    return all_jobs
