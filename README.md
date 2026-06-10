# 📡 Job Radar

**Deep candidate profile → daily job radar → CV tailoring. Free, open source, privacy-first.**

A one-page CV physically cannot hold 5+ years of expertise. Job Radar extracts your *full* master profile through an adaptive AI interview, then uses it to rank fresh jobs daily and rewrite your CV for any posting — all in your browser, with **your own** LLM key.

> **Your data never leaves your browser.** CV, profile, interview answers and your API key live in localStorage / IndexedDB. There is no backend. The only shared resource is an anonymous, public `data/jobs.json` refreshed daily by GitHub Actions.

## How it works

```
GitHub Actions (daily cron)
  └─ scripts/fetch-jobs.mjs → Remotive / Adzuna / hh.ru → data/jobs.json
                                        │
GitHub Pages (static site) ◀────────────┘
  │
  ▼
Your browser
  ├─ CV upload → parsed locally (pdf.js / mammoth.js)
  ├─ Adaptive interview (your LLM key) → master profile (localStorage)
  ├─ Matching jobs.json × profile (your LLM key) → ranked dashboard
  └─ Tailored CV + cover letter + salary read (your LLM key)
```

**One shared job pool for everyone. Personalization happens in each user's browser, paid by each user's own key.** That's why this can stay free.

## Quick start (hosted)

1. Open the site (GitHub Pages of this repo).
2. **Settings** → pick OpenAI or Anthropic, paste your API key
   ([get an OpenAI key](https://platform.openai.com/api-keys) · [get an Anthropic key](https://console.anthropic.com/settings/keys)).
   The key is stored only in your browser. There is a "Delete all keys" button.
3. **Profile** → upload your CV (PDF/DOCX). A draft master profile appears.
4. **Interview** → answer short batches of 2–3 questions until the profile is saturated.
5. **Dashboard** → fresh jobs ranked against your full profile, with "why it fits".
6. **Tailor** → pick a job (or paste any JD) → tailored CV + cover letter + salary read.

Token costs are yours, and they are small: matching uses cheap models by default (gpt-4o-mini / Claude Haiku), results are cached, and only top-ranked jobs are scored.

## Quick start (fork your own radar)

1. Fork this repo (public — Actions minutes are free).
2. Settings → Pages → Source: **GitHub Actions**.
3. (Optional) Settings → Secrets → add `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`
   (free at [developer.adzuna.com](https://developer.adzuna.com/)) — adds salary-annotated jobs. Without them the Adzuna source is skipped gracefully.
4. (Optional) Edit `JOB_QUERIES` in [.github/workflows/update-jobs.yml](.github/workflows/update-jobs.yml) to your roles.
5. Run the **Update jobs pool** workflow manually once (Actions tab) — or wait for the daily cron.

## Quick start (self-host, with scrapers)

The hosted version uses only official/open job APIs. If you want LinkedIn / Indeed / Glassdoor coverage via [JobSpy](https://github.com/speedyapply/JobSpy) scrapers — run your own copy:

```bash
cd selfhost
cp .env.example .env   # set your search queries and location
docker compose up
```

See [selfhost/README.md](selfhost/README.md). Scraping runs on your machine, under your responsibility.

## Job sources

| Source | Key needed | Notes |
|---|---|---|
| [Remotive](https://remotive.com) | no | remote-only jobs, clean API |
| [Adzuna](https://developer.adzuna.com/) | free key | salary data; EU country endpoints |
| [hh.ru](https://api.hh.ru) | no | official API; may 403 from some datacenter IPs |
| JobSpy (self-host only) | no | LinkedIn / Indeed / Glassdoor scrapers |

Adding a source is a single small file — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

- **Frontend:** vanilla HTML/CSS/JS (ES modules), zero build step, zero `node_modules`. pdf.js + mammoth.js from CDN.
- **LLM:** thin provider layer ([js/providers/](js/providers/)) — OpenAI and Anthropic adapters, direct browser calls (both serve CORS; Anthropic needs the documented `anthropic-dangerous-direct-browser-access` header — fine for your own key in your own browser).
- **Jobs pipeline:** [scripts/fetch-jobs.mjs](scripts/fetch-jobs.mjs), Node 18+, zero dependencies.
- **Prompts:** editable Markdown templates in [prompts/](prompts/) — improve them without touching code.
- **Hosting:** GitHub Pages + GitHub Actions. Costs the author ≈ $0.

## Privacy & legal

- No backend, no analytics, no persistence outside your browser.
- Your LLM key goes directly from your browser to the provider you chose. Nowhere else.
- The hosted job pool uses only official/open APIs within their terms.
- Scrapers exist only in `selfhost/`, never run on the hosted version, and are your responsibility to use within the target sites' terms.

## License

[MIT](LICENSE)
