#!/usr/bin/env python3
"""Job Radar self-host worker.

Loops forever:
  1. Runs the same Node API adapters as the hosted version (scripts/fetch-jobs.mjs)
     -> writes data/jobs.json with Remotive / Adzuna / hh.ru jobs.
  2. Runs JobSpy scrapers (LinkedIn / Indeed / Glassdoor / ...) for your queries
     and merges the results into the same data/jobs.json.
  3. Sleeps FETCH_INTERVAL_HOURS and repeats.

Scraping happens on YOUR machine with YOUR IP, under your responsibility.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

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


def stable_id(source: str, url: str) -> str:
    return hashlib.sha1(f"{source}|{url}".encode()).hexdigest()[:16]


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


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

def parse_posted(value) -> str | None:
    """Normalize whatever JobSpy returns ('2026-06-01', '3 days ago', datetime) to YYYY-MM-DD."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    try:
        import dateparser  # Zyte open source — handles '3 days ago', 18 languages
        parsed = dateparser.parse(str(value))
        return parsed.strftime("%Y-%m-%d") if parsed else None
    except Exception:  # noqa: BLE001
        return None


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
            if TITLE_FILTER and not title_matches_queries(title):
                continue
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
                "posted_at": parse_posted(row.get("date_posted")),
                "salary": parse_salary(row),
                "description": description,
                "tags": derive_tags(title, description),
            })
    return jobs


# Twin of scripts/sources/util.mjs::deriveLocationFlags — keeps API and scraper
# outputs schema-compatible. Three independent flags (a hybrid job is remote AND
# office; an on-site role with visa support is office AND relocate).

_REMOTE_META = {
    "remote", "anywhere", "worldwide", "global", "distributed",
    "home", "wfh", "fully", "only", "first", "friendly",
    "position", "location", "based", "across", "within",
}
_REGION_TOKENS = {
    "eu", "europe", "european", "union", "us", "usa", "united", "states",
    "america", "americas", "emea", "apac", "latam", "asia", "africa",
    "oceania", "pacific", "cet", "cest", "gmt", "utc", "est", "pst",
    "timezone", "tz", "time", "zone",
    "north", "south", "east", "west", "central", "latin",
}
_HYBRID_RE = re.compile(r"\b(hybrid|on[-\s]?site|onsite|in[-\s]?office|in[-\s]?person)\b", re.I)
_RELOCATE_RE = re.compile(
    r"relocat\w+|relo[-\s]?package|visa\s+sponsorship|sponsor\s+(?:your|the|a)?\s*visas?|"
    r"we\s+(?:will\s+)?sponsor\s+visas?|work[-\s]?permit\s+(?:assistance|sponsorship|support)|"
    r"релок\w+|переезд\w*|визов\w+\s+поддержк\w+|оплат\w+\s+релок\w+|помощь\s+с\s+переездом",
    re.I,
)
_NO_RELOCATE_RE = re.compile(
    r"no\s+relocation|no\s+visa\s+sponsorship|cannot\s+sponsor|unable\s+to\s+sponsor|"
    r"does\s+not\s+(?:offer\s+)?(?:relocation|sponsor)|we\s+do\s+not\s+sponsor|"
    r"без\s+релокации|релокация\s+не\s+предоставляется",
    re.I,
)


def derive_location_flags(title: str, description: str, location: str, remote: bool) -> tuple[bool, bool]:
    full_text = f"{title}\n{description}"
    loc = (location or "").strip()
    if not loc or loc in {"—", "-"}:
        office = not remote
    else:
        remainder = "".join(
            w for w in re.split(r"[^a-zа-яё0-9]+", loc.lower())
            if len(w) >= 2 and w not in _REMOTE_META and w not in _REGION_TOKENS
        )
        office = bool(remainder)
    if not office and _HYBRID_RE.search(full_text):
        office = True
    relocate = bool(_RELOCATE_RE.search(full_text)) and not _NO_RELOCATE_RE.search(full_text)
    return office, relocate


def derive_tags(title: str, description: str) -> list[str]:
    # Role tags from the TITLE only (descriptions mention every role under the sun);
    # context tags (AI / MarTech / Remote) may come from the description too.
    t = (title or "").lower()
    full = f"{t} {(description or '').lower()}"
    title_rules = {
        "Product": r"\b(product (manager|owner|lead|management|director)|cpo|pm)\b",
        "Sales": r"\b(sales|account executive|business development)\b",
        "Senior": r"\b(senior|staff|principal)\b",
        "Lead": r"\b(lead|head of|director)\b",
    }
    text_rules = {
        "AI": r"\b(ai|ml|machine learning|llm)\b",
        "MarTech": r"\b(martech|marketing tech(nology)?|crm)\b",
        "Remote": r"\bremote\b",
    }
    tags = [tag for tag, pattern in title_rules.items() if re.search(pattern, t)]
    tags += [tag for tag, pattern in text_rules.items() if re.search(pattern, full)]
    return tags


def title_matches_queries(title: str) -> bool:
    """Same guard as the Node pipeline: every significant word of at least one
    query must appear in the title as a whole word. Keeps scraper full-text
    noise (sales jobs that merely *mention* 'product manager') out of the pool."""
    t = (title or "").lower()
    for q in QUERIES:
        words = [w for w in re.split(r"[^a-zа-яё0-9+#.]+", q.lower()) if len(w) >= 2]
        if words and all(
            re.search(rf"(^|[^a-zа-яё0-9]){re.escape(w)}([^a-zа-яё0-9]|$)", t) for w in words
        ):
            return True
    return False


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
    payload.setdefault("sources", {})["jobspy"] = {"fetched": len(scraped), "added": added}

    JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
    JOBS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"  merged: +{added} scraped, total {len(merged)} → {JOBS_FILE}")


# ---------- Main loop ----------

def main() -> None:
    log(f"Job Radar worker: queries={QUERIES}, location='{LOCATION}', sites={SITES or 'none'}, every {INTERVAL_HOURS}h")
    while True:
        log("Cycle start: API sources (shared Node pipeline)")
        run_api_sources()
        log("Cycle: scrapers (JobSpy)")
        scraped = run_scrapers()
        merge_into_pool(scraped)
        log(f"Cycle done. Sleeping {INTERVAL_HOURS}h…")
        try:
            time.sleep(INTERVAL_HOURS * 3600)
        except KeyboardInterrupt:
            sys.exit(0)


if __name__ == "__main__":
    main()
