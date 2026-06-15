#!/usr/bin/env python3
"""Job Radar self-host worker.

Loops forever:
  1. Runs the same Node API adapters as the hosted version (scripts/fetch-jobs.mjs)
     -> writes data/jobs.json with Remotive / Adzuna / hh.ru jobs.
  2. Runs the localhost-only source registry (sources/*.py): extra API / RSS / HTML
     sources (Working Nomads, Jooble, Workable, Habr Career, Poslovi, …).
  3. Runs JobSpy scrapers (LinkedIn / Indeed / Glassdoor / ...) for your queries.
  4. Merges everything into data/jobs.json (central title filter + dedupe).
  5. Sleeps FETCH_INTERVAL_HOURS and repeats.

Scraping happens on YOUR machine with YOUR IP, under your responsibility.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries,
)
from sources import load_sources

ROOT = Path(__file__).resolve().parents[2]  # repo root (mounted at /app)
JOBS_FILE = ROOT / "data" / "jobs.json"

QUERIES = [q.strip() for q in os.getenv("JOB_QUERIES", "product manager").split(",") if q.strip()]
LOCATION = os.getenv("JOB_LOCATION", "Remote")
SITES = [s.strip() for s in os.getenv("JOBSPY_SITES", "").split(",") if s.strip()]
RESULTS_WANTED = int(os.getenv("JOBSPY_RESULTS", "25"))
FRESH_DAYS = int(os.getenv("JOB_FRESH_DAYS", "14"))
INTERVAL_HOURS = float(os.getenv("FETCH_INTERVAL_HOURS", "12"))
# Drop results whose TITLE doesn't match any query (set JOB_TITLE_FILTER=off to disable).
TITLE_FILTER = os.getenv("JOB_TITLE_FILTER", "strict") != "off"


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}", flush=True)


# ---------- Step 1: API sources via the shared Node pipeline ----------

def run_api_sources() -> None:
    script = ROOT / "scripts" / "fetch-jobs.mjs"
    try:
        result = subprocess.run(
            ["node", str(script)],
            cwd=ROOT, capture_output=True, text=True, timeout=600,
            env={**os.environ},
        )
        for line in (result.stdout + result.stderr).splitlines():
            log(f"  node: {line}")
        if result.returncode != 0:
            log(f"  node pipeline exited with {result.returncode} (continuing with scrapers)")
    except Exception as exc:  # noqa: BLE001 — one stage must not kill the loop
        log(f"  node pipeline failed: {exc}")


# ---------- Step 2: JobSpy scrapers ----------

def parse_salary(row) -> dict | None:
    """Prefer JobSpy's structured columns; fall back to price-parser on free text."""
    min_a, max_a = row.get("min_amount"), row.get("max_amount")
    currency = row.get("currency") or "USD"
    if min_a or max_a:
        return {
            "min": int(min_a or max_a),
            "max": int(max_a or min_a),
            "currency": str(currency).upper(),
            "source": "jobspy",
        }
    # price-parser fallback for salary buried in description text.
    try:
        from price_parser import Price  # Zyte open source
        text = str(row.get("description") or "")
        m = re.search(r"(?:salary|compensation|pay)[^.\n]{0,120}", text, re.I)
        if m:
            price = Price.fromstring(m.group(0))
            if price.amount and price.amount > 1000:
                return {
                    "min": int(price.amount),
                    "max": int(price.amount),
                    "currency": price.currency or "USD",
                    "source": "jobspy/price-parser",
                }
    except Exception:  # noqa: BLE001
        pass
    return None


def run_scrapers() -> list[dict]:
    if not SITES:
        log("  scrapers disabled (JOBSPY_SITES is empty)")
        return []

    try:
        from jobspy import scrape_jobs
    except ImportError:
        log("  python-jobspy not installed — skipping scrapers")
        return []

    jobs: list[dict] = []
    for query in QUERIES:
        try:
            log(f"  jobspy: '{query}' @ {LOCATION} on {SITES}")
            df = scrape_jobs(
                site_name=SITES,
                search_term=query,
                location=LOCATION,
                results_wanted=RESULTS_WANTED,
                hours_old=FRESH_DAYS * 24,
                linkedin_fetch_description=False,
            )
        except Exception as exc:  # noqa: BLE001 — sites block sometimes; carry on
            log(f"  jobspy '{query}' failed: {exc}")
            continue

        for _, row in df.iterrows():
            url = str(row.get("job_url") or "")
            if not url:
                continue
            source = f"jobspy-{row.get('site', 'scrape')}"
            title = str(row.get("title") or "Untitled")
            description = strip_html(str(row.get("description") or ""))[:5000]
            is_remote = bool(row.get("is_remote")) or "remote" in f"{title} {row.get('location', '')}".lower()
            location = str(row.get("location") or LOCATION)
            office, relocate = derive_location_flags(title, description, location, is_remote)
            jobs.append({
                "id": stable_id(source, url),
                "title": title,
                "company": str(row.get("company") or "—"),
                "location": location,
                "remote": is_remote,
                "office": office,
                "relocate": relocate,
                "url": url,
                "source": source,
                "posted_at": parse_date(row.get("date_posted")),
                "salary": parse_salary(row),
                "description": description,
                "tags": derive_tags(title, description),
            })
    return jobs


def run_registry_sources() -> list[dict]:
    """Run every enabled source module and collect normalized jobs.
    One broken source must never kill the cycle."""
    config = {
        "queries": QUERIES,
        "location": LOCATION,
        "fresh_days": FRESH_DAYS,
        "results_wanted": RESULTS_WANTED,
    }
    jobs: list[dict] = []
    for module in load_sources():
        missing = [v for v in getattr(module, "REQUIRES_ENV", []) if not os.getenv(v)]
        if missing:
            log(f"  source {module.NAME}: SKIPPED (missing env: {', '.join(missing)})")
            continue
        try:
            t0 = time.time()
            found = module.fetch(config)
            jobs.extend(found)
            log(f"  source {module.NAME}: {len(found)} jobs ({time.time() - t0:.1f}s)")
        except Exception as exc:  # noqa: BLE001 — isolate per-source failures
            log(f"  source {module.NAME} FAILED: {exc}")
    return jobs


# ---------- Step 3: merge into data/jobs.json ----------

def merge_into_pool(scraped: list[dict]) -> None:
    payload = {"updated_at": None, "count": 0, "sources": {}, "jobs": []}
    if JOBS_FILE.exists():
        try:
            payload = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass

    existing = payload.get("jobs", [])
    cutoff = (datetime.now(timezone.utc) - timedelta(days=FRESH_DAYS)).strftime("%Y-%m-%d")

    by_id = {j["id"]: j for j in existing if (j.get("posted_at") or "9999") >= cutoff or not j.get("posted_at")}
    # Cross-source dedupe: company|title key, prefer entries with salary.
    def key(j):
        return re.sub(r"\W+", " ", f"{j.get('company', '')}|{j.get('title', '')}".lower()).strip()

    seen_keys = {key(j) for j in by_id.values()}
    added = 0
    for job in scraped:
        if job["id"] in by_id or key(job) in seen_keys:
            continue
        by_id[job["id"]] = job
        seen_keys.add(key(job))
        added += 1

    merged = sorted(by_id.values(), key=lambda j: j.get("posted_at") or "", reverse=True)
    payload["jobs"] = merged
    payload["count"] = len(merged)
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    payload.setdefault("sources", {})["selfhost_scrapers"] = {"fetched": len(scraped), "added": added}

    JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
    JOBS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"  merged: +{added} scraped, total {len(merged)} → {JOBS_FILE}")


# ---------- Main loop ----------

def main() -> None:
    log(f"Job Radar worker: queries={QUERIES}, location='{LOCATION}', sites={SITES or 'none'}, every {INTERVAL_HOURS}h")
    while True:
        log("Cycle start: API sources (shared Node pipeline)")
        run_api_sources()
        log("Cycle: registry sources (API/RSS/HTML)")
        registry_jobs = run_registry_sources()
        log("Cycle: scrapers (JobSpy)")
        scraped = run_scrapers()
        collected = registry_jobs + scraped
        if TITLE_FILTER:
            before = len(collected)
            collected = [j for j in collected if title_matches_queries(j["title"], QUERIES)]
            log(f"  title filter: kept {len(collected)}/{before}")
        merge_into_pool(collected)
        log(f"Cycle done. Sleeping {INTERVAL_HOURS}h…")
        try:
            time.sleep(INTERVAL_HOURS * 3600)
        except KeyboardInterrupt:
            sys.exit(0)


if __name__ == "__main__":
    main()
