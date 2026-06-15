# Contributing to Job Radar

Thanks for stopping by! This project is intentionally low-tech so that **anyone** — including juniors and product folks — can contribute. No build step, no framework, no `node_modules` in the frontend.

## Run it locally

```bash
git clone <your-fork>
cd job-radar
# any static server works:
python -m http.server 8000
# or: npx serve .
```

Open `http://localhost:8000`. That's it — the whole app is static files.

To refresh the job pool locally:

```bash
# Write to a gitignored file — never commit a test pool.
JOB_OUT_FILE=data/jobs.local.json node scripts/fetch-jobs.mjs

# One specific source:
JOB_OUT_FILE=data/jobs.local.json node scripts/fetch-jobs.mjs remotive
```

On Windows PowerShell: `$env:JOB_OUT_FILE='data/jobs.local.json'; node scripts/fetch-jobs.mjs`.

> ⚠️ **Do not run `node scripts/fetch-jobs.mjs` without `JOB_OUT_FILE`.**
> The default output path `data/jobs.json` is owned by the daily GitHub Action
> bot. If you commit a local override, every subsequent `git pull` will hit a
> merge conflict on a ~20 000-line JSON file. `JOB_OUT_FILE=data/jobs.local.json`
> writes to a path that is in `.gitignore`, so your test runs stay out of git.
> If you want to preview the result in the dashboard, temporarily symlink or
> rename your file to `data/jobs.json` *without committing it*.

Node 18+ required (uses global `fetch`). No `npm install` needed.

## The easiest first PRs

1. **Improve a prompt.** Everything the LLM does is driven by editable Markdown templates in [prompts/](prompts/). Better interview questions, better matching rubric, better CV-writing rules — all without touching code.
2. **Add a job source.** One small file, see below.
3. **UI polish.** Plain CSS in [css/styles.css](css/styles.css).

## Adding a job source (adapter)

Each source is one file in `scripts/sources/` exporting three things:

```js
// scripts/sources/example.mjs
import { stableId, stripHtml, toDateOnly, fetchJSON, deriveTags } from './util.mjs';

export const name = 'example';            // unique id, shows up in the dashboard filter
export const requiresEnv = [];            // env vars needed (e.g. API keys); adapter is
                                          // skipped gracefully when they are missing

export async function fetchJobs(config) { // config = { queries: string[], freshDays: number }
  const jobs = [];
  for (const query of config.queries) {
    const data = await fetchJSON(`https://api.example.com/jobs?q=${encodeURIComponent(query)}`);
    for (const j of data.results) {
      jobs.push({
        id: stableId(name, j.url),        // stable across re-fetches
        title: j.title,
        company: j.company,
        location: j.location || 'Remote',
        remote: !!j.remote,
        url: j.url,
        source: name,
        posted_at: toDateOnly(j.published),     // 'YYYY-MM-DD' or null
        salary: null,                            // or { min, max, currency, source }
        description: stripHtml(j.body).slice(0, 5000),
        tags: deriveTags(j.title, j.body),
      });
    }
  }
  return jobs;
}
```

Then register it in [scripts/fetch-jobs.mjs](scripts/fetch-jobs.mjs):

```js
import * as example from './sources/example.mjs';
const SOURCES = [remotive, adzuna, hh, example];
```

Rules of the road:

- **Hosted sources must be official/open APIs** that permit aggregation. Scrapers belong in `selfhost/` only.
- One failing source must never break the run — wrap risky loops in try/catch and `console.warn`, like the existing adapters do.
- Respect rate limits; the daily Action calls each source once per query.
- Keys go to GitHub Secrets and `requiresEnv`, never in code.

## Adding an LLM provider

Create `js/providers/yourprovider.js` exporting:

- `chat(messages, opts)` — main inference call.
- `listModels(apiKey)` — fetch the list of chat-capable models the key has access to (used by the Settings screen to populate the model dropdown). Returns `Array<{ id, label }>`. A successful response also validates the key, so this doubles as a key check.
- `testKey(apiKey)` — typically `() => listModels(apiKey).then(() => true)`.
- `DEFAULT_MODEL` — a string used as a safe fallback when the user hasn't picked a model yet (e.g. for imported settings from another machine).

Then register it in [js/providers/index.js](js/providers/index.js). The provider must support CORS for direct browser calls — if it doesn't, document that it is self-host-only.

## Code style

- Vanilla ES modules, no transpilation, works straight from a static server.
- Keep dependencies at zero in the frontend; CDN libs only when genuinely needed (pdf.js, mammoth).
- Comments explain *why*, not *what*.

## Reporting issues

Use GitHub Issues. For matching/interview quality problems, include (redacted) examples — prompt improvements are the most valuable contributions of all.
