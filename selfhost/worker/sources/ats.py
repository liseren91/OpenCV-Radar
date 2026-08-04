"""ATS board APIs — fetch jobs from company career pages via official public APIs.

Reads company slugs from selfhost/data/ats-companies.json (seeded + filled by the
`xray` discovery source). No Search API key needed once the cache has entries.

Platforms: Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable, Personio.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries,
)
from .base import http_get, http_json

NAME = "ats"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

CACHE_PATH = Path(__file__).resolve().parents[2] / "data" / "ats-companies.json"

# Sensible seed so the source is useful before the first X-Ray discovery run.
SEED = {
    "greenhouse": ["stripe", "airbnb", "discord", "figma", "notion"],
    "lever": ["shopify", "netflix"],
    "ashby": ["linear", "ramp"],
    "smartrecruiters": [],
    "recruitee": [],
    "workable": [],
    "personio": [],
}


def _load_companies() -> dict[str, list[str]]:
    cache = {k: list(v) for k, v in SEED.items()}
    if CACHE_PATH.exists():
        try:
            data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for plat, slugs in data.items():
                    if not isinstance(slugs, list):
                        continue
                    merged = list(cache.get(plat, []))
                    for s in slugs:
                        s = str(s).strip().lower()
                        if s and s not in merged:
                            merged.append(s)
                    cache[plat] = merged
        except Exception:  # noqa: BLE001
            pass
    return cache


def _job(
    *, platform: str, slug: str, title: str, url: str, company: str,
    location: str, remote: bool, description: str, posted_at, salary=None,
    extra_tags=None,
) -> dict:
    description = strip_html(description or "")[:5000]
    office, relocate = derive_location_flags(title, description, location, remote)
    tags = derive_tags(title, description)
    if extra_tags:
        for t in extra_tags:
            if t and t not in tags:
                tags.append(t)
    tags.append(f"ats:{platform}")
    return {
        "id": stable_id(NAME, url),
        "title": title,
        "company": company or slug.replace("-", " ").title() or "—",
        "location": location or ("Remote" if remote else "—"),
        "remote": remote,
        "office": office,
        "relocate": relocate,
        "url": url,
        "source": NAME,
        "posted_at": parse_date(posted_at),
        "salary": salary,
        "description": description,
        "tags": tags,
    }


def _is_remote(location: str, text: str = "") -> bool:
    blob = f"{location} {text}".lower()
    return bool(re.search(r"\bremote\b|\bwfh\b|work from home|anywhere", blob))


# ---------- Platform fetchers ----------

def fetch_greenhouse(slug: str) -> list[dict]:
    data = http_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                     params={"content": "true"})
    company = (data.get("name") or slug).strip() if isinstance(data, dict) else slug
    # Some boards return {jobs: [...]} only
    jobs_raw = data.get("jobs") if isinstance(data, dict) else []
    out = []
    for j in jobs_raw or []:
        title = str(j.get("title") or "").strip()
        url = str(j.get("absolute_url") or "").strip()
        if not title or not url:
            continue
        loc_parts = [loc.get("name") for loc in (j.get("offices") or j.get("location") and [{"name": j.get("location", {}).get("name")}] or []) if loc]
        # Greenhouse uses location.name and/or offices[].name
        if j.get("location") and isinstance(j["location"], dict):
            loc_parts = [j["location"].get("name")] + loc_parts
        location = ", ".join(p for p in loc_parts if p) or "—"
        desc = j.get("content") or ""
        remote = _is_remote(location, desc)
        out.append(_job(
            platform="greenhouse", slug=slug, title=title, url=url,
            company=company, location=location, remote=remote,
            description=desc, posted_at=j.get("updated_at") or j.get("created_at"),
        ))
    return out


def fetch_lever(slug: str) -> list[dict]:
    rows = http_json(f"https://api.lever.co/v0/postings/{slug}", params={"mode": "json"})
    if not isinstance(rows, list):
        rows = []
    out = []
    for j in rows:
        title = str(j.get("text") or "").strip()
        url = str(j.get("hostedUrl") or j.get("applyUrl") or "").strip()
        if not title or not url:
            continue
        cats = j.get("categories") or {}
        location = str(cats.get("location") or j.get("country") or "—")
        company = slug.replace("-", " ").title()
        desc = " ".join(filter(None, [
            j.get("descriptionPlain") or j.get("description"),
            j.get("additionalPlain") or j.get("additional"),
        ]))
        workplace = str(cats.get("commitment") or "")
        remote = _is_remote(location, f"{desc} {workplace}") or "remote" in workplace.lower()
        out.append(_job(
            platform="lever", slug=slug, title=title, url=url,
            company=company, location=location, remote=remote,
            description=desc, posted_at=j.get("createdAt"),
        ))
    return out


def fetch_ashby(slug: str) -> list[dict]:
    data = http_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    jobs_raw = (data or {}).get("jobs") if isinstance(data, dict) else []
    out = []
    for j in jobs_raw or []:
        title = str(j.get("title") or "").strip()
        url = str(j.get("jobUrl") or "").strip()
        if not title or not url:
            continue
        location = str(j.get("location") or "—")
        desc = j.get("descriptionPlain") or j.get("descriptionHtml") or ""
        remote = bool(j.get("isRemote")) or _is_remote(location, desc)
        company = str(j.get("department") and slug.replace("-", " ").title() or slug.replace("-", " ").title())
        out.append(_job(
            platform="ashby", slug=slug, title=title, url=url,
            company=company, location=location, remote=remote,
            description=desc, posted_at=j.get("publishedAt") or j.get("updatedAt"),
        ))
    return out


def fetch_smartrecruiters(slug: str) -> list[dict]:
    data = http_json(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings")
    content = (data or {}).get("content") if isinstance(data, dict) else []
    out = []
    for j in content or []:
        title = str(j.get("name") or "").strip()
        post_id = j.get("id") or ""
        url = str(j.get("ref") or f"https://jobs.smartrecruiters.com/{slug}/{post_id}").strip()
        if not title or not url:
            continue
        loc = j.get("location") or {}
        location = ", ".join(filter(None, [loc.get("city"), loc.get("region"), loc.get("country")])) or "—"
        remote = bool(loc.get("remote")) or _is_remote(location)
        company = str((j.get("company") or {}).get("name") or slug.replace("-", " ").title())
        out.append(_job(
            platform="smartrecruiters", slug=slug, title=title, url=url,
            company=company, location=location, remote=remote,
            description="", posted_at=j.get("releasedDate"),
        ))
    return out


def fetch_recruitee(slug: str) -> list[dict]:
    data = http_json(f"https://{slug}.recruitee.com/api/offers/")
    offers = (data or {}).get("offers") if isinstance(data, dict) else []
    out = []
    for j in offers or []:
        title = str(j.get("title") or "").strip()
        url = str(j.get("careers_url") or j.get("url") or "").strip()
        if url and url.startswith("/"):
            url = f"https://{slug}.recruitee.com{url}"
        if not title or not url:
            continue
        location = str(j.get("location") or j.get("city") or "—")
        desc = j.get("description") or ""
        remote = bool(j.get("remote")) or _is_remote(location, desc)
        company = str(j.get("company_name") or slug.replace("-", " ").title())
        out.append(_job(
            platform="recruitee", slug=slug, title=title, url=url,
            company=company, location=location, remote=remote,
            description=desc, posted_at=j.get("published_at") or j.get("created_at"),
        ))
    return out


def fetch_workable(slug: str) -> list[dict]:
    data = http_json(
        f"https://apply.workable.com/api/v1/widget/accounts/{slug}",
        params={"details": "true"},
    )
    jobs_raw = (data or {}).get("jobs") if isinstance(data, dict) else []
    company = str((data or {}).get("name") or slug.replace("-", " ").title())
    out = []
    for j in jobs_raw or []:
        title = str(j.get("title") or "").strip()
        shortcode = j.get("shortcode") or ""
        url = str(j.get("url") or f"https://apply.workable.com/{slug}/j/{shortcode}/").strip()
        if not title or not url.startswith("http"):
            if shortcode:
                url = f"https://apply.workable.com/{slug}/j/{shortcode}/"
            else:
                continue
        location = str(j.get("city") or j.get("location") or "—")
        if isinstance(j.get("locations"), list) and j["locations"]:
            location = ", ".join(str(x) for x in j["locations"][:3])
        desc = j.get("description") or ""
        remote = bool(j.get("remote")) or _is_remote(str(location), desc)
        out.append(_job(
            platform="workable", slug=slug, title=title, url=url,
            company=company, location=str(location), remote=remote,
            description=desc, posted_at=j.get("created_at") or j.get("published_on"),
        ))
    return out


def fetch_personio(slug: str) -> list[dict]:
    # XML feed
    xml_text = http_get(f"https://{slug}.jobs.personio.de/xml")
    root = ET.fromstring(xml_text)
    out = []
    for pos in root.findall(".//position") or root.findall("position"):
        title = (pos.findtext("name") or pos.findtext("title") or "").strip()
        job_id = (pos.findtext("id") or "").strip()
        url = f"https://{slug}.jobs.personio.de/job/{job_id}" if job_id else ""
        if not title or not url:
            continue
        office = pos.findtext("office") or pos.findtext("city") or ""
        schedule = pos.findtext("schedule") or ""
        desc_parts = []
        for tag in ("jobDescription", "responsibilities", "profile"):
            el = pos.find(tag)
            if el is not None and (el.text or list(el)):
                desc_parts.append(ET.tostring(el, encoding="unicode", method="text"))
        desc = " ".join(desc_parts)
        location = office or "—"
        remote = _is_remote(f"{location} {schedule}", desc)
        out.append(_job(
            platform="personio", slug=slug, title=title, url=url,
            company=slug.replace("-", " ").title(), location=location, remote=remote,
            description=desc, posted_at=pos.findtext("createdAt"),
        ))
    return out


_FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "smartrecruiters": fetch_smartrecruiters,
    "recruitee": fetch_recruitee,
    "workable": fetch_workable,
    "personio": fetch_personio,
}


def _parse_platform_jobs(platform: str, rows: list[dict], queries: list[str]) -> list[dict]:
    """Filter by title queries (volume control for large boards)."""
    if not queries:
        return rows
    return [j for j in rows if title_matches_queries(j["title"], queries)]


def fetch(config: dict) -> list[dict]:
    queries = config.get("queries") or []
    companies = _load_companies()
    seen_urls: set[str] = set()
    out: list[dict] = []

    for platform, slugs in companies.items():
        fetcher = _FETCHERS.get(platform)
        if not fetcher or not slugs:
            continue
        for slug in slugs:
            try:
                rows = fetcher(slug)
            except Exception:  # noqa: BLE001 — one board failure must not kill the cycle
                continue
            for job in _parse_platform_jobs(platform, rows, queries):
                if job["url"] in seen_urls:
                    continue
                seen_urls.add(job["url"])
                out.append(job)
    return out
