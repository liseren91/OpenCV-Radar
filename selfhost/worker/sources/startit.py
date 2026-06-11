"""Startit Poslovi — Serbian startup/tech job board (WordPress RSS).

Feed URL: https://startit.rs/startit-poslovi/feed/

Each <item> encodes:
  * <title>      — job title
  * <link>       — absolute permalink
  * <dc:creator> — name of the person who posted (NOT the company)
  * <pubDate>    — publish date
  * <category>   — multiple: mix of location, technology, seniority, domain,
                   and exactly ONE company name
  * <description> — truncated plain-text job description

Category taxonomy (from the site's autocomplete JS):
  lokacija   — e.g. "Beograd", "Novi Sad", "Daljinski rad"
  tehnologija — e.g. "Python", "React", "JavaScript"
  oblast     — domain: "Dizajn", "Marketing", "Proizvod", …
  senioritet — "Junior", "Medior", "Senior", "Pocetnik"

The company tag is any capitalized <category> that falls outside the
known taxonomy vocabularies listed above (plus a small blocklist of
meta-category names WordPress adds automatically).
"""

import re

import feedparser

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "startit"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

BASE = "https://startit.rs"
FEED = "https://startit.rs/startit-poslovi/feed/"

# ── known non-company category terms ──────────────────────────────────────────
# Serbian city names and remote-work synonyms (lowercased for comparison)
_KNOWN_LOCATIONS: frozenset[str] = frozenset({
    "beograd", "novi sad", "nis", "niš", "kragujevac", "subotica", "leskovac",
    "zrenjanin", "pancevo", "pančevo", "cacak", "čačak", "uzice", "užice",
    "bor", "cuprija", "ćuprija", "jagodina", "kikinda", "kraljevo", "krusevac",
    "kruševac", "loznica", "novi pazar", "pirot", "pozarevac", "požarevac",
    "sremska mitrovica", "sabac", "šabac", "smederevo", "valjevo", "vranje",
    "vrsac", "vršac", "zrenjanin", "indjija", "inđija",
    # explicit remote/flexible labels that appear as categories
    "daljinski rad", "rad (od kuce)", "rad (od kuće)", "globalno",
    "remote", "hybrid", "hibrid", "fleksibilno", "iz kancelarije",
    "srbija", "serbia", "eu", "europe",
})

# Domain areas (oblast), seniority (senioritet), and other meta tags
_KNOWN_NON_COMPANY: frozenset[str] = frozenset({
    # seniority
    "junior", "medior", "senior", "pocetnik", "početnik",
    # domains
    "dizajn", "ui", "ux", "poslovanje", "finansije", "kriptovalute", "igre",
    "investiranje", "drustvo", "marketing", "privatnost", "racunarstvo",
    "računarstvo", "metodologije", "pravo", "poducavanje", "podučavanje",
    "proizvod", "rukovanje", "rukovanje", "rukovođenje", "pr",
    # employment type / mode labels
    "usluzno", "uslužno", "puno radno vreme", "puno radno vrijeme",
    "skraceno radno vreme", "skraćeno radno vreme", "honorarno",
    "programiranje",
    # meta WP categories
    "tehnologija", "uncategorized",
})

# Remote-work detection — Serbian + English
_REMOTE_RE = re.compile(
    r"remote|daljinski|rad od ku[ćc]e|daljin[as]|hibrid|fleksibilno",
    re.IGNORECASE,
)

# Location category values that signal remote work (lowercased)
_REMOTE_LOCATION_TERMS: frozenset[str] = frozenset({
    "daljinski rad", "rad (od kuce)", "rad (od kuće)", "globalno",
    "remote", "hybrid", "hibrid", "fleksibilno",
})


def _extract_from_tags(
    tags: list[str],
) -> tuple[str, str, bool]:
    """Return (company, location, remote) extracted from the category list."""
    company = "—"
    location_parts: list[str] = []
    remote = False

    for tag in tags:
        tag_lower = tag.lower().strip()

        # Remote detection
        if tag_lower in _REMOTE_LOCATION_TERMS or _REMOTE_RE.search(tag):
            remote = True
            location_parts.append(tag)
            continue

        # Known location
        if tag_lower in _KNOWN_LOCATIONS:
            location_parts.append(tag)
            continue

        # Known non-company term (domain, seniority, meta, etc.)
        if tag_lower in _KNOWN_NON_COMPANY:
            continue

        # Heuristic: company is a capitalized proper noun not matched above.
        # All-lowercase tags are typically tech/skill slugs (e.g. "react", "css").
        if tag and tag[0].isupper() and company == "—":
            company = tag

    if location_parts:
        location = ", ".join(location_parts)
    elif remote:
        location = "Remote"
    else:
        location = "Serbia"  # Startit is a Serbian board; assume Serbia if unknown

    return company, location, remote


def _parse(xml_text: str) -> list[dict]:
    feed = feedparser.parse(xml_text)
    jobs = []
    for e in feed.entries:
        title = str(getattr(e, "title", "")).strip()
        url = str(getattr(e, "link", "")).strip()
        if not title or not url:
            continue
        if not url.startswith("http"):
            continue

        # Categories are the primary source of company / location / remote
        raw_tags: list[str] = [t["term"] for t in getattr(e, "tags", [])]
        company, location, remote = _extract_from_tags(raw_tags)

        # Description: prefer content:encoded, fall back to summary
        content_list = getattr(e, "content", [])
        if content_list:
            raw_html = content_list[0].get("value", "")
        else:
            raw_html = str(getattr(e, "summary", "") or "")
        description = strip_html(raw_html)[:5000]

        # Also check title + description for remote signals
        if not remote and _REMOTE_RE.search(title + " " + description):
            remote = True
            if "Serbia" in location or location == "—":
                location = "Remote"

        office, relocate = derive_location_flags(title, description, location, remote)

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
            "posted_at": parse_date(getattr(e, "published", None)),
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config: dict) -> list[dict]:
    return _parse(http_get(FEED))
