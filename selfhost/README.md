# Job Radar — self-host (Door B)

Run your own Job Radar with **scrapers** on top of the official API sources. You get the exact same frontend as the hosted version, plus LinkedIn / Indeed / Glassdoor coverage via [JobSpy](https://github.com/speedyapply/JobSpy).

> ⚠️ **Scraping disclaimer.** Scrapers run on your machine, with your IP, against sites whose terms of service may prohibit automated access. The hosted version of Job Radar never scrapes — this directory is excluded from that legal posture by design. Use at your own discretion and risk; keep request volumes modest.

## Run

```bash
cd selfhost
cp .env.example .env   # edit queries / location / sites
docker compose up
```

- Frontend: http://localhost:8080
- The worker immediately does a full fetch cycle, then repeats every `FETCH_INTERVAL_HOURS`.

## What the worker does

1. **API sources** — runs the same zero-dependency Node pipeline as the hosted version
   (`scripts/fetch-jobs.mjs`: Remotive, Adzuna*, hh.ru) → writes `data/jobs.json`.
2. **Source registry** — runs the localhost-only Python sources in
   [`worker/sources/`](worker/sources/): extra API / RSS / HTML boards (see the table
   below). Each is isolated — one broken source is logged and skipped, never killing the cycle.
3. **Scrapers** — runs JobSpy for each of your `JOB_QUERIES` against `JOBSPY_SITES`,
   normalizes results (dates via [dateparser](https://github.com/scrapinghub/dateparser),
   salary text via [price-parser](https://github.com/scrapinghub/price-parser)) and merges
   the registry + scraper results into the same `data/jobs.json` (central title filter +
   cross-source dedupe against the API results).
4. Nginx serves the repo as static files — the frontend picks up the fresh pool on reload.

\* Adzuna needs free keys in `.env` (`ADZUNA_APP_ID`/`ADZUNA_APP_KEY`); skipped without them.

## Source registry (localhost only)

These sources scrape on **your** machine, under **your** IP — they are deliberately
excluded from the hosted version's no-scraping posture. All are enabled by default; control
them with `SOURCES_ENABLED` (whitelist) / `SOURCES_DISABLED` (blacklist) in `.env`.

| Source | Type | Env needed | Notes |
|---|---|---|---|
| `working_nomads` | JSON API | — | remote jobs (full feed, title-filtered) |
| `jooble` | API | `JOOBLE_API_KEY` | skipped without a free key |
| `workable` | API | — | public job-board search |
| `jobspresso` | RSS | — | remote |
| `nodesk` | HTML | — | remote |
| `habr_career` | HTML | — | RU (career.habr.com) |
| `geekjob` | HTML | — | RU (geekjob.ru) |
| `poslovi` | HTML | — | Serbia (poslovi.infostud.com) |
| `helloworld` | HTML | — | Serbia, IT (helloworld.rs) |
| `startit` | RSS | — | Serbia — ⚠️ legacy feed is stale; live board is AJAX-only, so it usually yields no *fresh* jobs |
| `hubstaff` | HTML (Rails UJS) | — | freelance-leaning remote |
| `justremote` | embedded JSON | — | remote (parses inlined Redux state) |
| `virtual_vocations` | embedded JSON | — | remote; company hidden behind paywall (shown as “—”) |
| LinkedIn | JobSpy | — | enable via `JOBSPY_SITES=linkedin` (no registry source) |

**Dropped during build:** `skipthedrive` — RSS is disabled site-wide and the content is blog
articles, not parseable listings. Wellfound and workatastartup (YC) were out of scope (anti-bot,
require a headless browser).

Search uses your English `JOB_QUERIES`. Each source returns the shared job schema
(`worker/normalize.py`), so the dashboard treats registry jobs like any other source.
Writing a new source: drop a module in `worker/sources/` exposing `NAME`, `REQUIRES_ENV`,
`fetch(config) -> list[dict]` — the registry auto-discovers it.

## Configuration (`.env`)

| Var | Meaning | Default |
|---|---|---|
| `JOB_QUERIES` | comma-separated search queries | `product manager` |
| `JOB_LOCATION` | JobSpy location ("City, Country" or "Remote") | `Remote` |
| `JOBSPY_SITES` | `linkedin,indeed,glassdoor,google` — empty disables scraping | empty |
| `JOBSPY_RESULTS` | results per site per query | `25` |
| `JOB_FRESH_DAYS` | drop jobs older than N days | `14` |
| `JOB_TITLE_FILTER` | `strict` = job title must match a query (kills full-text noise); `off` = keep everything | `strict` |
| `FETCH_INTERVAL_HOURS` | refresh period | `12` |

> 💡 **Set `JOB_QUERIES` to your actual target roles** — it drives both the API
> sources and the scrapers. The dashboard also fetches a personal layer in your
> browser (queries derived from your master profile), but the richest pool comes
> from putting your roles here.

## Notifications (optional, DIY)

The worker is a plain Python loop — the simplest hook is to add a few lines at the end of
`merge_into_pool()` in [worker/worker.py](worker/worker.py) that POST to a Telegram bot or
SMTP when `added > 0`. We deliberately don't ship a notification service: no author-side
servers is a core principle.

## Writing custom scrapers

JobSpy covers the big boards. For anything else, [Scrapy](https://scrapy.org/) is the
recommended foundation — battle-tested, polite by default (robots.txt, throttling), and
its output is easy to map onto our job schema (see `merge_into_pool()` for the shape).
Drop your spider in this directory, write into `data/jobs.json` via the same merge logic,
and it will appear in the dashboard like any other source.
