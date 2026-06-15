# 📡 Job Radar 
**Deep candidate profile → daily job radar → CV tailoring. Free, open source, privacy-first.**

A one-page CV physically cannot hold 5+ years of expertise. Job Radar extracts your *full* master profile through an adaptive AI interview, then uses it to rank fresh jobs daily and rewrite your CV for any posting — all in your browser, with **your own** LLM key.

> **Your data never leaves your browser.** CV, profile, interview answers and your API key live in localStorage / IndexedDB. There is no backend. The only shared resource is an anonymous, public `data/jobs.json` refreshed daily by GitHub Actions.

**Live demo:** [liseren91.github.io/OpenCV-Radar](https://liseren91.github.io/OpenCV-Radar) · **Repo:** [github.com/liseren91/OpenCV-Radar](https://github.com/liseren91/OpenCV-Radar)

Product spec (RU): [PRD-job-radar-opensource.md](PRD-job-radar-opensource.md)

## Features

| Area | What you get |
|---|---|
| **Profile** | Upload CV (PDF/DOCX) → parsed locally → editable master profile → export/import JSON |
| **Interview** | Adaptive AI follow-up in batches of 2–3 questions; resumable; completeness meter |
| **Dashboard** | Shared pool + personal browser fetch; two-stage matching (local prefilter → LLM score); filters; NEW badge |
| **Tailor** | CV rewrite + cover letter + salary read for any job or pasted JD |
| **Settings** | OpenAI or Anthropic BYO key; model list fetched live from your provider; delete keys / wipe all data |
| **Jobs pipeline** | Hosted: daily GitHub Action. Self-host: Docker worker + scrapers — see [Self-host](#self-host-door-b) |

## How it works

```
GitHub Actions (daily cron, 05:17 UTC)
  └─ scripts/fetch-jobs.mjs → Remotive / RemoteOK / Arbeitnow / Adzuna* / hh.ru*
        └─ writes data/jobs.json → commit → triggers Pages deploy
                                        │
GitHub Pages (static site) ◀────────────┘
  │
  ▼
Your browser
  ├─ CV upload → parsed locally (pdf.js / mammoth.js)
  ├─ Adaptive interview (your LLM key) → master profile (localStorage)
  ├─ Personal layer: CORS-friendly APIs queried from your profile (badge "👤 personal")
  ├─ Matching pool × profile (your LLM key) → ranked dashboard + "why it fits"
  └─ Tailored CV + cover letter + salary read (your LLM key)
```

\* Adzuna and hh.ru are skipped gracefully when keys are missing or the API blocks the runner IP.

**Self-host** uses the same browser flow, but `data/jobs.json` is written by the local Docker worker (APIs + registry + JobSpy) instead of GitHub Actions — see [Self-host (Door B)](#self-host-door-b).

**One shared job pool for everyone. Personalization happens in each user's browser, paid by each user's own key.** That's why this can stay free.

## Quick start (hosted)

1. Open [the live site](https://liseren91.github.io/OpenCV-Radar) or your fork's GitHub Pages URL.
2. **Settings** → pick OpenAI or Anthropic, paste your API key
   ([OpenAI](https://platform.openai.com/api-keys) · [Anthropic](https://console.anthropic.com/settings/keys)).
   The key stays in your browser only. Use **Delete all keys** or **Wipe everything** anytime.
3. **Profile** → upload your CV (PDF/DOCX). A draft master profile appears; edit and export JSON if you like.
4. **Interview** → answer short batches of 2–3 questions until the profile is saturated.
5. **Dashboard** → fresh jobs ranked against your full profile, with "why it fits" and a personal fetch layer.
6. **Tailor** → pick a job (or paste any JD) → tailored CV + cover letter + salary read.

Token costs are yours and stay small: matching uses cheap models by default (gpt-4o-mini / Claude Haiku), results are cached in IndexedDB, and only top prefiltered jobs are LLM-scored (cap 40 per run).

## Quick start (fork your own radar)

1. Fork [this repo](https://github.com/liseren91/OpenCV-Radar) (public — Actions minutes are free).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. (Optional) **Settings → Secrets** → add `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`
   (free at [developer.adzuna.com](https://developer.adzuna.com/)) — adds salary-annotated jobs.
4. (Optional) Edit `JOB_QUERIES` in [.github/workflows/update-jobs.yml](.github/workflows/update-jobs.yml) to your roles.
5. Run the **Update jobs pool** workflow once (Actions tab) — or wait for the daily cron.

## Quick start (local dev)

```bash
git clone https://github.com/liseren91/OpenCV-Radar.git
cd OpenCV-Radar
python -m http.server 8000
# open http://localhost:8000
```

Refresh the job pool locally (writes a gitignored file — never commit test output):

```bash
# Unix
JOB_OUT_FILE=data/jobs.local.json node scripts/fetch-jobs.mjs

# Windows PowerShell
$env:JOB_OUT_FILE='data/jobs.local.json'; node scripts/fetch-jobs.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for adapter rules, prompt editing, and provider registration.

## Self-host (Door B)

One repo, two deployment modes. The **frontend is identical** — vanilla static files, BYO LLM key, all personalization in the browser. The difference is only **who builds `data/jobs.json`** and **which job sources are allowed**.

| | Hosted (Door A) | Self-host (Door B) |
|---|---|---|
| Where | GitHub Pages | `docker compose up` on your machine |
| Job pool | GitHub Actions cron → commits `data/jobs.json` | Local Python worker on your schedule |
| Sources | Official/open APIs only (legal posture for public hosting) | Same APIs **+** 13 regional boards **+** JobSpy scrapers |
| Scraping | Never | On your machine, your IP, your responsibility |
| LLM | BYO key in browser | Same — still BYO in browser |
| Best for | Friends, zero install | Developers who want LinkedIn/Indeed and RU/Serbia boards |

### When to self-host

- You need **LinkedIn / Indeed / Glassdoor** — not available on the hosted version.
- You want **regional boards**: Habr Career, Geekjob (RU), Poslovi, HelloWorld (Serbia), etc.
- You want your **own refresh schedule** and optional DIY notifications (Telegram/SMTP hook in the worker).
- You are fine running scrapers under **your** IP and within each site's terms.

> ⚠️ **Scraping disclaimer.** JobSpy and HTML adapters run on your machine against sites that may prohibit automated access. The hosted site never scrapes — `selfhost/` is isolated from that legal posture by design. Keep request volumes modest.

### Run

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

```bash
cd selfhost
cp .env.example .env   # edit JOB_QUERIES, JOB_LOCATION, JOBSPY_SITES, keys
docker compose up
```

- **Frontend:** http://localhost:8080 (nginx serves the same `index.html` + `js/` as GitHub Pages)
- **Worker:** runs a full fetch cycle immediately, then every `FETCH_INTERVAL_HOURS` (default 12h)
- **Stop:** `Ctrl+C` or `docker compose down`

Minimal `.env` to enable LinkedIn scraping for Belgrade/EU PM roles:

```env
JOB_QUERIES=product manager,head of product,AI product
JOB_LOCATION=Belgrade, Serbia
JOBSPY_SITES=linkedin,indeed
JOBSPY_RESULTS=25
FETCH_INTERVAL_HOURS=12
```

Optional: add free [Adzuna](https://developer.adzuna.com/) and [Jooble](https://jooble.org/api/about) keys for salary data and extra coverage.

### What the worker does

```
selfhost/worker (Python loop)
  ├─ 1. Node pipeline — scripts/fetch-jobs.mjs (Remotive, RemoteOK, Arbeitnow, Adzuna*, hh.ru*)
  ├─ 2. Source registry — worker/sources/*.py (13 extra API/RSS/HTML boards)
  ├─ 3. JobSpy scrapers — linkedin, indeed, glassdoor, google (if JOBSPY_SITES set)
  └─ 4. Merge → data/jobs.json (title filter, dedup, freshness cap)
        │
nginx :8080 ◀── serves repo root; browser reload picks up fresh pool
```

Each source is isolated — a broken adapter is logged and skipped, never killing the cycle. The dashboard treats self-host jobs like any other source (filter by `source` in the UI).

### Self-host job sources

**JobSpy** (enable via `JOBSPY_SITES`): `linkedin`, `indeed`, `glassdoor`, `google`, `zip_recruiter`.

**Python registry** (`worker/sources/`, localhost only — all on by default):

| Source | Type | Key | Notes |
|---|---|---|---|
| `working_nomads` | JSON API | — | remote, full feed |
| `jooble` | API | `JOOBLE_API_KEY` | skipped without free key |
| `workable` | API | — | public job-board search |
| `jobspresso` | RSS | — | remote |
| `nodesk` | HTML | — | remote |
| `habr_career` | HTML | — | RU — career.habr.com |
| `geekjob` | HTML | — | RU — geekjob.ru |
| `poslovi` | HTML | — | Serbia — poslovi.infostud.com |
| `helloworld` | HTML | — | Serbia IT — helloworld.rs |
| `hubstaff` | HTML | — | freelance-leaning remote |
| `justremote` | embedded JSON | — | remote |
| `virtual_vocations` | embedded JSON | — | remote; company may show as "—" |
| `startit` | RSS | — | Serbia — legacy feed often stale |

Control sources with `SOURCES_ENABLED` (whitelist) or `SOURCES_DISABLED` (blacklist) in `.env`.

### Configuration (`.env`)

| Variable | Meaning | Default |
|---|---|---|
| `JOB_QUERIES` | Comma-separated roles — drives APIs, registry, and JobSpy | `product manager` |
| `JOB_LOCATION` | JobSpy location (`"City, Country"` or `Remote`) | `Remote` |
| `JOBSPY_SITES` | Scraper list; empty = API/registry only | *(empty)* |
| `JOBSPY_RESULTS` | Results per site per query | `25` |
| `JOB_FRESH_DAYS` | Drop jobs older than N days | `14` |
| `JOB_TITLE_FILTER` | `strict` = title must match a query; `off` = keep all | `strict` |
| `FETCH_INTERVAL_HOURS` | Worker refresh period | `12` |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Optional salary-enriched Adzuna jobs | — |
| `JOOBLE_API_KEY` | Optional Jooble registry source | — |
| `SOURCES_ENABLED` / `SOURCES_DISABLED` | Whitelist / blacklist registry sources | all on |

> 💡 Set `JOB_QUERIES` to your real target roles. The browser still fetches a personal layer from your master profile, but the richest pool comes from configuring queries here.

### Extending self-host

- **New registry source:** drop a module in `selfhost/worker/sources/` with `NAME`, `REQUIRES_ENV`, `fetch(config) -> list[dict]` — auto-discovered. See existing adapters and `pytest` under `selfhost/worker/tests/`.
- **Custom scrapers:** [Scrapy](https://scrapy.org/) recommended; merge into `data/jobs.json` via the same schema as `worker/normalize.py`.
- **Notifications:** hook at the end of `merge_into_pool()` in `worker/worker.py` (Telegram bot, SMTP) when `added > 0` — not shipped by default (no author-side servers).

Full details: [selfhost/README.md](selfhost/README.md).

## Job sources

### Hosted (GitHub Actions)

| Source | Key needed | Notes |
|---|---|---|
| [Remotive](https://remotive.com) | no | remote-only jobs |
| [RemoteOK](https://remoteok.com/api) | no | remote-only, some salary data |
| [Arbeitnow](https://www.arbeitnow.com/api/job-board-api) | no | EU-friendly board |
| [Adzuna](https://developer.adzuna.com/) | free key (`ADZUNA_APP_ID` / `ADZUNA_APP_KEY`) | salary data; skipped without secrets |
| [hh.ru](https://api.hh.ru) | no | official API; may 403 from some datacenter IPs |

### Personal layer (browser only)

The dashboard derives search queries from **your** master profile and fetches CORS-friendly APIs (Remotive, hh.ru) straight from the browser. Results merge into the pool with a **👤 personal** badge. Cached 6 hours in localStorage — no author-side server.

### Self-host only

Everything in the [Self-host (Door B)](#self-host-door-b) section above: JobSpy + 13 Python registry adapters. Not used on GitHub Pages.

### Relevance filters

1. **Title filter** (`JOB_TITLE_FILTER=strict` by default) — sources search full descriptions, so the pipeline also requires the job *title* to match a query. Set `off` to keep everything.
2. **Freshness** — jobs older than `JOB_FRESH_DAYS` (default 14) are dropped.
3. **Dedup** — stable `id` hash per URL across sources.

Adding a hosted source = one small file in `scripts/sources/` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Data model

`data/jobs.json` is a metadata wrapper plus a normalized job array:

```json
{
  "updated_at": "2026-06-15T08:53:00Z",
  "count": 187,
  "sources": { "remotive": { "fetched": 32, "ms": 222 } },
  "jobs": [
    {
      "id": "stable-hash",
      "title": "Senior Product Manager",
      "company": "Example Co",
      "location": "Remote (Europe)",
      "remote": true,
      "url": "https://…",
      "source": "remotive",
      "posted_at": "2026-06-09",
      "salary": { "min": 43200, "max": 75900, "currency": "EUR", "source": "adzuna" },
      "description": "…",
      "tags": ["AI", "Remote", "Senior"]
    }
  ]
}
```

The master profile (localStorage, exportable JSON) holds `basics`, `headline_roles`, `experience`, `hidden_expertise`, `preferences`, and `salary_expectation` — see PRD §7 for the full schema.

## Project structure

```
index.html              # app shell (hash router)
css/styles.css
js/
  app.js                # router, settings, welcome
  storage.js            # localStorage + IndexedDB
  matcher.js            # prefilter + LLM ranking
  personal-jobs.js      # browser-side personal fetch
  prompts.js            # loads prompts/*.md
  providers/            # openai.js, anthropic.js, index.js
  steps/                # onboarding, interview, dashboard, tailor
data/jobs.json          # daily pool (bot-owned in CI)
prompts/                # interview, match, tailor, salary, parse-cv, …
scripts/
  fetch-jobs.mjs        # hosted job pipeline
  sources/              # one adapter per API source
selfhost/               # Docker + Python worker + scrapers
.github/workflows/      # update-jobs.yml, deploy-pages.yml
```

## Stack

- **Frontend:** vanilla HTML/CSS/JS (ES modules), zero build step, zero `node_modules`. pdf.js + mammoth.js from CDN.
- **LLM:** thin provider layer ([js/providers/](js/providers/)) — OpenAI and Anthropic; direct browser calls (CORS; Anthropic needs `anthropic-dangerous-direct-browser-access` for your own key).
- **Jobs pipeline:** [scripts/fetch-jobs.mjs](scripts/fetch-jobs.mjs), Node 18+, zero dependencies.
- **Prompts:** editable Markdown in [prompts/](prompts/) — improve interview, matching, tailoring without code changes.
- **Self-host worker:** Python 3, JobSpy, pytest suite under `selfhost/worker/tests/`.
- **Hosting:** GitHub Pages + GitHub Actions. Author cost ≈ $0.

## Privacy & legal

- No backend, no analytics, no persistence outside your browser.
- Your LLM key goes directly from your browser to the provider you chose. Nowhere else.
- The hosted job pool uses only official/open APIs within their terms.
- Scrapers live only in `selfhost/`, never on the hosted site — your machine, your IP, your responsibility.

## Contributing

PRs welcome — especially new job sources, prompt improvements, and UI polish. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
