# Design: Enrich the localhost (self-host) job pool with 18 new sources

Date: 2026-06-11
Status: Approved (design) — pending implementation plan

## Problem

The hosted ("Door A") version of Job Radar runs a zero-dependency Node pipeline
(`scripts/fetch-jobs.mjs`: Remotive, Adzuna, hh.ru, RemoteOK, Arbeitnow) and, by
design, **never scrapes**. The self-host ("Door B") worker
(`selfhost/worker/worker.py`) adds JobSpy scrapers on top, running on the user's
own machine and IP.

The current self-host pool is too thin. The user wants to enrich **localhost
only** with 18 additional sources, using "the same scheme as JobSpy" — i.e.
running on her machine under her responsibility — but applying the *best tool per
site* rather than forcing every site through JobSpy.

## Decisions (locked during brainstorming)

1. **Best tool per site** — API → adapter, RSS/JSON → light parser, HTML →
   scraper, LinkedIn → JobSpy config. Not strictly JobSpy.
2. **Phased rollout** — Phase 1 (easy wins: API/RSS) → Phase 2 (Serbian/Russian
   HTML + remaining remote boards). Phase 3 (fragile anti-bot: Wellfound,
   workatastartup) is **dropped from scope** for now.
3. **Lightweight stack, no headless browser** — `requests` + `BeautifulSoup`
   only. With Phase 3 dropped there is no Playwright and no headless browser
   anywhere; any site that requires JS rendering is out of scope.
4. **English queries only** — search uses the existing English `JOB_QUERIES`.
   No localized-query / synonym mechanism for the Serbian/Russian boards (out of
   scope for now); those boards are still scraped, just with English terms.
5. **Localhost-only boundary** — every new source (including the clean API ones)
   lives in the self-host worker. The hosted Node pipeline
   (`scripts/fetch-jobs.mjs` and its `SOURCES` list) is **not touched**, so the
   "two variants with different conditions" stay separated and the hosted
   no-scraping posture is preserved.

## Architecture

Convert the worker's monolithic "sources" step into a **pluggable Python source
registry** — a Python mirror of the existing Node adapter pattern (`name` +
`fetchJobs`), localhost-only.

```
selfhost/worker/
  worker.py            # loop: Node API pipeline -> registry sources -> JobSpy -> merge
  normalize.py         # helpers EXTRACTED from worker.py:
                       #   stable_id, strip_html, parse_posted, parse_salary,
                       #   derive_location_flags, derive_tags, title_matches_queries
  sources/
    __init__.py        # registry: auto-discovers all source modules
    base.py            # contract + polite HTTP client (UA, timeout, retry, throttle, robots)
    jooble.py          # API
    workable.py        # API
    working_nomads.py  # API (JSON)
    jobspresso.py      # RSS
    skipthedrive.py    # RSS
    nodesk.py          # HTML
    habr_career.py     # HTML
    geekjob.py         # HTML
    poslovi.py         # HTML
    helloworld.py      # HTML
    startit.py         # RSS/HTML
    hubstaff.py        # HTML/JSON (verify)
    justremote.py      # HTML (verify not JS-only)
    virtual_vocations.py # HTML
  tests/
    fixtures/          # saved HTML/JSON snippets per source
    test_<source>.py   # parse tests against fixtures + schema smoke test
```

The normalization helpers currently inlined in `worker.py` are extracted into
`normalize.py` so every source reuses them (today they are hard-wired into the
JobSpy path; leaving them there would bloat `worker.py`).

`merge_into_pool()` is unchanged: dedupe, freshness window, title filter, and the
write to `data/jobs.json` already handle the normalized job dict.

## Source contract

Each module in `sources/` exports:

```python
NAME = "working_nomads"
REQUIRES_ENV = []          # e.g. ["JOOBLE_API_KEY"]; missing env -> source skipped silently
ENABLED_BY_DEFAULT = True  # fragile sources (wellfound) -> False, opt-in via env

def fetch(config) -> list[dict]:
    # config = {queries, location, fresh_days, results_wanted}
    # returns normalized job dicts via normalize.py helpers
```

`base.py` provides a polite HTTP client shared by all sources: common
User-Agent, 30s timeout, exponential backoff retry on 429/5xx, throttle between
requests, and robots.txt respect by default.

Config via `.env`:
- `SOURCES_ENABLED` — whitelist (comma-separated NAMEs); empty = all defaults.
- `SOURCES_DISABLED` — blacklist.
- API keys per source (e.g. `JOOBLE_API_KEY`).

`ENABLED_BY_DEFAULT` remains in the contract for future opt-in sources, but in
the current scope every shipped source is enabled by default.

## Normalized job schema (unchanged, required for every source)

```
id, title, company, location, remote, office, relocate,
url, source, posted_at, salary, description, tags
```

`office`/`relocate`/`tags` come from the extracted `derive_*` helpers, identical
to the JobSpy path and schema-compatible with the Node adapters.

## Phases and per-site technique

| # | Site | Technique | Phase | Note |
|---|------|-----------|-------|------|
| 1 | LinkedIn | JobSpy (env) | 1 | zero code — `JOBSPY_SITES=linkedin` |
| 2 | hh.ru | already exists | — | Node adapter; optional hardening |
| 3 | Jooble RS (rs.jooble.org) | API (key) | 1 | official API, `JOOBLE_API_KEY` |
| 4 | Workable (jobs.workable.com) | API | 1 | public job-board API |
| 5 | Working Nomads | API (JSON) | 1 | `/api/exposed_jobs/` |
| 6 | Jobspresso | RSS | 1 | WP feed |
| 7 | SkipTheDrive | RSS | 1 | WP category feeds |
| 8 | NoDesk | HTML | 1 | static HTML |
| 9 | Habr Career (career.habr.com) | HTML | 2 | `/vacancies` |
| 10 | GeekJob (geekjob.ru) | HTML | 2 | |
| 11 | Poslovi Infostud | HTML | 2 | largest Serbian board |
| 12 | HelloWorld.rs | HTML | 2 | Serbian IT board |
| 13 | Startit (startit.rs) | RSS/HTML | 2 | WP |
| 14 | Hubstaff Talent | HTML/JSON | 2 | freelance-leaning, verify |
| 15 | JustRemote (justremote.co) | HTML | 2 | verify not JS-only; if JS-only → drop |
| 16 | Virtual Vocations | HTML | 2 | much behind paywall |

**Dropped from scope (Phase 3):** Wellfound and workatastartup (YC) — both
require a headless browser / login and are too fragile. Can be revisited later
as a separate spec.

Exact endpoints/markup are verified during implementation (one plan step per
source); some sites may have changed since this design. A Phase-2 site that
turns out to be JS-only (no usable HTML/RSS/JSON without a browser) is dropped
rather than escalated to a headless browser.

## Error handling (no silent failures)

Each source runs in try/except. A failure is logged with the source name and
reason; the cycle continues — one broken site never kills the run (same posture
as the current JobSpy step). `data/jobs.json` `sources` records per-source status:
`{fetched, added}` on success or `{error: "..."}` on failure, so the dashboard /
logs show what is live and what broke.

## Politeness

Shared User-Agent, 30s timeout, inter-request throttle, exponential backoff on
429/5xx, robots.txt respect. Modest volumes per the self-host scraping
disclaimer. All requests run on the user's machine under her IP.

## Testing

- Per-source parse test against a **saved fixture** (real HTML/JSON snippet in
  `tests/fixtures/`) — fast, deterministic, flags markup drift without live
  requests.
- Schema smoke test: every source yields dicts with all required schema fields.

## Documentation

Update `selfhost/README.md`: source table, required env keys per source, and how
to enable/disable sources (`SOURCES_ENABLED` / `SOURCES_DISABLED`).

## Out of scope (explicitly untouched / deferred)

- `scripts/`, `index.html`, the frontend, GitHub Actions, and the hosted
  pipeline. Changes are confined to `selfhost/`.
- **Phase 3** sources (Wellfound, workatastartup) and any headless browser /
  Playwright dependency.
- **Localized search queries / synonyms** for Serbian/Russian boards — those
  boards are searched with the existing English `JOB_QUERIES` only.
