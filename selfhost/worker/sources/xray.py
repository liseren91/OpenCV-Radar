"""X-Ray discovery — find company slugs on ATS platforms via a Search API.

Uses Boolean site: operators (the technique from Potok's X-Ray guide) against
Greenhouse / Lever / Ashby / SmartRecruiters / Recruitee / Workable / Personio
boards. Results are NOT parsed into jobs — slugs are accumulated into
selfhost/data/ats-companies.json for the `ats` source to fetch via official
board APIs.

Requires XRAY_SEARCH_API_KEY. Provider: XRAY_SEARCH_PROVIDER=brave|serper|serpapi
(default: brave). Skipped automatically when the key is missing.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .base import http_json

NAME = "xray"
REQUIRES_ENV = ["XRAY_SEARCH_API_KEY"]
ENABLED_BY_DEFAULT = True

CACHE_PATH = Path(__file__).resolve().parents[2] / "data" / "ats-companies.json"

# (platform, site_operator_host) — hosts that appear in Google-indexed job URLs.
ATS_SITES = [
    ("greenhouse", "boards.greenhouse.io"),
    ("greenhouse", "job-boards.greenhouse.io"),
    ("lever", "jobs.lever.co"),
    ("ashby", "jobs.ashbyhq.com"),
    ("smartrecruiters", "jobs.smartrecruiters.com"),
    ("recruitee", "recruitee.com"),
    ("workable", "apply.workable.com"),
    ("personio", "jobs.personio.de"),
    ("personio", "jobs.personio.com"),
]

RESULTS_PER_QUERY = int(os.getenv("XRAY_RESULTS_PER_QUERY", "10"))


def _load_cache() -> dict:
    if CACHE_PATH.exists():
        try:
            data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {k: list(v) if isinstance(v, list) else [] for k, v in data.items()}
        except Exception:  # noqa: BLE001
            pass
    return {
        "greenhouse": [], "lever": [], "ashby": [], "smartrecruiters": [],
        "recruitee": [], "workable": [], "personio": [],
    }


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Stable sort for readable diffs
    out = {k: sorted(set(v), key=str.lower) for k, v in sorted(cache.items())}
    CACHE_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_slug(url: str) -> tuple[str, str] | None:
    """Return (platform, slug) from an ATS job-board URL, or None."""
    try:
        p = urlparse(url)
    except Exception:  # noqa: BLE001
        return None
    host = (p.hostname or "").lower()
    path = (p.path or "").strip("/")
    parts = [x for x in path.split("/") if x]

    if "greenhouse.io" in host:
        # boards.greenhouse.io/{slug}/jobs/...  or ?for={slug}
        qs = parse_qs(p.query)
        if "for" in qs and qs["for"]:
            return "greenhouse", qs["for"][0].lower()
        if parts:
            return "greenhouse", parts[0].lower()
        return None

    if host == "jobs.lever.co" and parts:
        return "lever", parts[0].lower()

    if host == "jobs.ashbyhq.com" and parts:
        return "ashby", parts[0].lower()

    if "smartrecruiters.com" in host and parts:
        # jobs.smartrecruiters.com/{company}/...
        return "smartrecruiters", parts[0].lower()

    if host.endswith(".recruitee.com"):
        slug = host.split(".")[0]
        if slug and slug != "www":
            return "recruitee", slug.lower()
        return None

    if host == "apply.workable.com" and parts:
        return "workable", parts[0].lower()

    if host.endswith(".jobs.personio.de") or host.endswith(".jobs.personio.com"):
        slug = host.split(".")[0]
        if slug:
            return "personio", slug.lower()
        return None

    return None


def build_xray_query(site_host: str, term: str) -> str:
    """Compose a Google-style X-Ray query for one ATS host + search term."""
    # Prefer quoted multi-word terms; keep single tokens bare.
    term = term.strip()
    if not term:
        term = "remote"
    qterm = f'"{term}"' if " " in term else term
    return f"site:{site_host} {qterm}"


def _search_brave(query: str, api_key: str, count: int) -> list[str]:
    data = http_json(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": query, "count": count},
        headers={"Accept": "application/json", "X-Subscription-Token": api_key},
    )
    return [r["url"] for r in (data.get("web") or {}).get("results") or [] if r.get("url")]


def _search_serper(query: str, api_key: str, count: int) -> list[str]:
    data = http_json(
        "https://google.serper.dev/search",
        method="POST",
        json_body={"q": query, "num": count},
        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
    )
    return [r["link"] for r in data.get("organic") or [] if r.get("link")]


def _search_serpapi(query: str, api_key: str, count: int) -> list[str]:
    data = http_json(
        "https://serpapi.com/search.json",
        params={"q": query, "api_key": api_key, "num": count, "engine": "google"},
    )
    return [r["link"] for r in data.get("organic_results") or [] if r.get("link")]


_PROVIDERS = {
    "brave": _search_brave,
    "serper": _search_serper,
    "serpapi": _search_serpapi,
}


def search_urls(query: str, *, provider: str, api_key: str, count: int = RESULTS_PER_QUERY) -> list[str]:
    fn = _PROVIDERS.get(provider)
    if not fn:
        raise ValueError(f"Unknown XRAY_SEARCH_PROVIDER={provider!r}; use brave|serper|serpapi")
    return fn(query, api_key, count)


def discover(queries: list[str], *, provider: str, api_key: str) -> dict:
    """Run X-Ray searches and return updated cache dict (platform → [slugs])."""
    cache = _load_cache()
    terms = queries or ["remote"]
    # Cap discovery volume: first N terms × each ATS site.
    max_terms = int(os.getenv("XRAY_MAX_TERMS", "3"))
    for term in terms[:max_terms]:
        for platform, host in ATS_SITES:
            q = build_xray_query(host, term)
            try:
                urls = search_urls(q, provider=provider, api_key=api_key)
            except Exception:  # noqa: BLE001 — one site failure must not kill discovery
                continue
            for url in urls:
                hit = extract_slug(url)
                if not hit:
                    continue
                plat, slug = hit
                # Recruitee host matching may fire for any *.recruitee.com; accept.
                if slug and re.match(r"^[a-z0-9][a-z0-9_-]{1,60}$", slug):
                    cache.setdefault(plat, [])
                    if slug not in cache[plat]:
                        cache[plat].append(slug)
    _save_cache(cache)
    return cache


def fetch(config: dict) -> list[dict]:
    """Discovery-only: updates ats-companies.json, returns no jobs.

    The `ats` source reads the cache and fetches structured openings.
    """
    api_key = os.environ["XRAY_SEARCH_API_KEY"]
    provider = (os.getenv("XRAY_SEARCH_PROVIDER") or "brave").strip().lower()
    queries = config.get("queries") or []
    discover(queries, provider=provider, api_key=api_key)
    return []
