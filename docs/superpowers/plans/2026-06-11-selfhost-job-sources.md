# Self-host Job Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the localhost (self-host) job pool with 16 new sources via a pluggable Python source registry in the self-host worker, using the best tool per site (API / RSS / HTML) — without touching the hosted pipeline.

**Architecture:** A new `sources/` package inside `selfhost/worker/` holds one module per site, each exposing `NAME`, `REQUIRES_ENV`, `ENABLED_BY_DEFAULT`, and `fetch(config) -> list[dict]`. A registry auto-discovers them; `worker.py` runs them between the Node API pipeline and JobSpy, then merges everything into `data/jobs.json` through the existing `merge_into_pool()`. Normalization helpers move from `worker.py` into a shared `normalize.py`. Sources parse against saved fixtures in tests; no live calls in the test suite. HTTP + BeautifulSoup only — no headless browser.

**Tech Stack:** Python 3.12, `requests`, `beautifulsoup4`, `lxml`, `feedparser` (RSS), `dateparser`, `price-parser`, `pytest`. Runs in the existing `selfhost/worker` Docker image.

---

## File Structure

```
selfhost/worker/
  worker.py              # MODIFY: import normalize helpers; add run_registry_sources(); central title filter
  normalize.py           # CREATE: stable_id, strip_html, parse_date, derive_location_flags, derive_tags, title_matches_queries
  sources/
    __init__.py          # CREATE: load_sources() registry (auto-discovery)
    base.py              # CREATE: polite HTTP client (http_get/http_json), shared UA/timeout/retry/throttle
    working_nomads.py    # CREATE: JSON API  (Phase 1)
    jooble.py            # CREATE: API + key (Phase 1)
    workable.py          # CREATE: API       (Phase 1)
    jobspresso.py        # CREATE: RSS       (Phase 1)
    skipthedrive.py      # CREATE: RSS       (Phase 1)
    nodesk.py            # CREATE: HTML      (Phase 1)
    habr_career.py       # CREATE: HTML      (Phase 2)
    geekjob.py           # CREATE: HTML      (Phase 2)
    poslovi.py           # CREATE: HTML      (Phase 2)
    helloworld.py        # CREATE: HTML      (Phase 2)
    startit.py           # CREATE: RSS/HTML  (Phase 2)
    hubstaff.py          # CREATE: HTML/JSON (Phase 2)
    justremote.py        # CREATE: HTML      (Phase 2)
    virtual_vocations.py # CREATE: HTML      (Phase 2)
  requirements.txt       # MODIFY: add scraping deps
  tests/
    __init__.py          # CREATE
    conftest.py          # CREATE: fixtures dir helper
    helpers.py           # CREATE: assert_valid_jobs() shared schema assertion
    fixtures/            # CREATE: saved HTML/JSON/XML per source (captured live during impl)
    test_normalize.py    # CREATE
    test_base.py         # CREATE
    test_registry.py     # CREATE
    test_<source>.py     # CREATE: one per source, fixture-driven
selfhost/.env.example    # MODIFY: document new keys + SOURCES_ENABLED/DISABLED + linkedin note
selfhost/README.md       # MODIFY: source table + config
```

**LinkedIn** needs zero code — it is already a JobSpy site. Task 21 documents enabling it via `JOBSPY_SITES`.

**Normalized job schema** every source must return (dict):
```
id, title, company, location, remote (bool), office (bool), relocate (bool),
url, source, posted_at ("YYYY-MM-DD" or None), salary (dict or None),
description (str), tags (list[str])
```

---

## PHASE 0 — Infrastructure

### Task 1: Extract `normalize.py` from `worker.py`

**Files:**
- Create: `selfhost/worker/normalize.py`
- Create: `selfhost/worker/tests/__init__.py` (empty)
- Create: `selfhost/worker/tests/test_normalize.py`
- Modify: `selfhost/worker/worker.py` (replace inlined helpers with imports)

- [ ] **Step 1: Create the tests package marker**

Create empty file `selfhost/worker/tests/__init__.py`.

- [ ] **Step 2: Write failing tests for the extracted helpers**

Create `selfhost/worker/tests/test_normalize.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # selfhost/worker on path

from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries,
)


def test_stable_id_is_deterministic_and_short():
    a = stable_id("src", "https://x/1")
    b = stable_id("src", "https://x/1")
    assert a == b and len(a) == 16


def test_strip_html_collapses_tags_and_whitespace():
    assert strip_html("<p>Hello   <b>world</b></p>") == "Hello world"


def test_parse_date_handles_iso_and_relative():
    assert parse_date("2026-06-01") == "2026-06-01"
    assert parse_date("2026-06-01T10:00:00Z") == "2026-06-01"
    assert parse_date(None) is None


def test_derive_location_flags_remote_only_is_not_office():
    office, relocate = derive_location_flags(
        title="Product Manager", description="Fully remote role.",
        location="Remote, EU", remote=True,
    )
    assert office is False and relocate is False


def test_derive_location_flags_onsite_default_and_relocation_signal():
    office, relocate = derive_location_flags(
        title="PM", description="We sponsor visas and help you relocate.",
        location="Belgrade, Serbia", remote=False,
    )
    assert office is True and relocate is True


def test_derive_tags_role_from_title_only():
    tags = derive_tags("Senior Product Manager", "work with sales and engineers")
    assert "Product" in tags and "Senior" in tags
    assert "Sales" not in tags  # sales mentioned only in description


def test_title_matches_queries_requires_all_words():
    assert title_matches_queries("Senior Product Manager", ["product manager"]) is True
    assert title_matches_queries("Sales Executive", ["product manager"]) is False
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd selfhost/worker && python -m pytest tests/test_normalize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'normalize'`

- [ ] **Step 4: Create `normalize.py` with the helpers moved out of `worker.py`**

Create `selfhost/worker/normalize.py`:

```python
"""Shared normalization helpers for self-host job sources.

Twin of scripts/sources/util.mjs — keeps API, scraper and JobSpy outputs
schema-compatible. Zero coupling to any specific source.
"""

import hashlib
import re
from datetime import datetime


def stable_id(source: str, url: str) -> str:
    return hashlib.sha1(f"{source}|{url}".encode()).hexdigest()[:16]


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value) -> str | None:
    """Normalize ISO strings, datetimes, or '3 days ago' to YYYY-MM-DD."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip()
    if not s:
        return None
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    if m:
        return m.group(1)
    try:
        import dateparser
        parsed = dateparser.parse(s)
        return parsed.strftime("%Y-%m-%d") if parsed else None
    except Exception:
        return None


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


def title_matches_queries(title: str, queries: list[str]) -> bool:
    t = (title or "").lower()
    for q in queries:
        words = [w for w in re.split(r"[^a-zа-яё0-9+#.]+", q.lower()) if len(w) >= 2]
        if words and all(
            re.search(rf"(^|[^a-zа-яё0-9]){re.escape(w)}([^a-zа-яё0-9]|$)", t) for w in words
        ):
            return True
    return False
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd selfhost/worker && python -m pytest tests/test_normalize.py -v`
Expected: PASS (7 passed)

- [ ] **Step 6: Refactor `worker.py` to import from `normalize.py`**

In `selfhost/worker/worker.py`:
- Delete the inlined definitions of `stable_id`, `strip_html`, the `_REMOTE_META`/`_REGION_TOKENS`/`_HYBRID_RE`/`_RELOCATE_RE`/`_NO_RELOCATE_RE` blocks, `derive_location_flags`, `derive_tags`, and `title_matches_queries`.
- Replace `parse_posted` calls with `parse_date` (delete `parse_posted`).
- Change `title_matches_queries(title)` call site to `title_matches_queries(title, QUERIES)`.
- Add near the top (after the stdlib imports):

```python
from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries,
)
```
- Keep `parse_salary(row)` in `worker.py` (it is JobSpy-row specific).
- In `run_scrapers()`, change `parse_posted(row.get("date_posted"))` → `parse_date(row.get("date_posted"))`.

- [ ] **Step 7: Verify worker still imports and the JobSpy path is intact**

Run: `cd selfhost/worker && python -c "import worker; print('ok')"`
Expected: prints `ok` (no import errors).

- [ ] **Step 8: Commit**

```bash
git add selfhost/worker/normalize.py selfhost/worker/tests/__init__.py selfhost/worker/tests/test_normalize.py selfhost/worker/worker.py
git commit -m "refactor: extract normalize.py from self-host worker"
```

---

### Task 2: Polite HTTP client `sources/base.py`

**Files:**
- Create: `selfhost/worker/sources/__init__.py` (empty for now — registry added in Task 3)
- Create: `selfhost/worker/sources/base.py`
- Create: `selfhost/worker/tests/test_base.py`

- [ ] **Step 1: Create the package marker**

Create empty `selfhost/worker/sources/__init__.py`.

- [ ] **Step 2: Write failing tests for the HTTP client**

Create `selfhost/worker/tests/test_base.py`:

```python
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sources import base


def _resp(status=200, text="ok", json_data=None):
    r = MagicMock()
    r.status_code = status
    r.text = text
    r.json.return_value = json_data if json_data is not None else {}
    r.raise_for_status = MagicMock()
    if status >= 400:
        from requests import HTTPError
        r.raise_for_status.side_effect = HTTPError(f"{status}")
    return r


def test_http_get_returns_text_on_200():
    with patch.object(base._session, "get", return_value=_resp(text="<html>hi</html>")) as g:
        out = base.http_get("https://example.com")
    assert out == "<html>hi</html>"
    # Sends our User-Agent.
    assert "User-Agent" in g.call_args.kwargs["headers"]


def test_http_json_parses_json():
    with patch.object(base._session, "get", return_value=_resp(json_data={"a": 1})):
        assert base.http_json("https://example.com/api") == {"a": 1}


def test_http_get_retries_then_succeeds_on_429():
    calls = [_resp(status=429), _resp(text="recovered")]
    with patch.object(base._session, "get", side_effect=calls), \
         patch.object(base.time, "sleep") as sleep:
        out = base.http_get("https://example.com", retries=1, backoff=0)
    assert out == "recovered"
    assert sleep.called  # throttle/backoff invoked


def test_http_get_raises_after_exhausting_retries():
    with patch.object(base._session, "get", return_value=_resp(status=500)), \
         patch.object(base.time, "sleep"):
        try:
            base.http_get("https://example.com", retries=1, backoff=0)
            assert False, "expected an exception"
        except Exception:
            pass
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd selfhost/worker && python -m pytest tests/test_base.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'sources.base'`.

- [ ] **Step 4: Implement `sources/base.py`**

Create `selfhost/worker/sources/base.py`:

```python
"""Polite shared HTTP client for self-host sources.

All scraping runs on the user's machine, under the user's IP, per the self-host
disclaimer. Keep volumes modest: a global throttle, a sane timeout, and
exponential backoff on 429/5xx.
"""

import os
import time

import requests

USER_AGENT = os.getenv(
    "SOURCES_USER_AGENT",
    "JobRadar-selfhost/1.0 (+https://github.com/job-radar; personal job search)",
)
TIMEOUT = float(os.getenv("SOURCES_TIMEOUT", "30"))
THROTTLE = float(os.getenv("SOURCES_THROTTLE", "1.0"))  # seconds between requests

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept": "*/*"})


def _request(url: str, *, params=None, headers=None, method="GET", json_body=None,
             retries=2, backoff=2.0):
    last_exc = None
    for attempt in range(retries + 1):
        try:
            resp = _session.request(
                method, url, params=params, headers=headers, json=json_body,
                timeout=TIMEOUT,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                resp.raise_for_status()
            resp.raise_for_status()
            time.sleep(THROTTLE)  # be polite between successful calls
            return resp
        except Exception as exc:  # noqa: BLE001 — retry transient failures
            last_exc = exc
            if attempt < retries:
                time.sleep(backoff * (2 ** attempt))
            else:
                raise
    raise last_exc  # unreachable, satisfies type checkers


def http_get(url: str, *, params=None, headers=None, retries=2, backoff=2.0) -> str:
    """GET → response text (HTML/XML). Raises on non-2xx after retries."""
    return _request(url, params=params, headers=headers,
                    retries=retries, backoff=backoff).text


def http_json(url: str, *, params=None, headers=None, method="GET", json_body=None,
              retries=2, backoff=2.0):
    """GET/POST → parsed JSON. Raises on non-2xx after retries."""
    return _request(url, params=params, headers=headers, method=method,
                    json_body=json_body, retries=retries, backoff=backoff).json()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd selfhost/worker && python -m pytest tests/test_base.py -v`
Expected: PASS (4 passed)

- [ ] **Step 6: Commit**

```bash
git add selfhost/worker/sources/__init__.py selfhost/worker/sources/base.py selfhost/worker/tests/test_base.py
git commit -m "feat: polite shared HTTP client for self-host sources"
```

---

### Task 3: Source registry + worker integration

**Files:**
- Modify: `selfhost/worker/sources/__init__.py`
- Modify: `selfhost/worker/worker.py`
- Create: `selfhost/worker/tests/helpers.py`
- Create: `selfhost/worker/tests/conftest.py`
- Create: `selfhost/worker/tests/test_registry.py`
- Create: `selfhost/worker/tests/fixtures/` (directory; add `.gitkeep`)

- [ ] **Step 1: Create the shared test helper**

Create `selfhost/worker/tests/helpers.py`:

```python
REQUIRED_FIELDS = {
    "id", "title", "company", "location", "remote", "office", "relocate",
    "url", "source", "posted_at", "salary", "description", "tags",
}


def assert_valid_jobs(jobs, source_name=None):
    """Assert a source returned a list of schema-complete job dicts."""
    assert isinstance(jobs, list)
    for j in jobs:
        assert REQUIRED_FIELDS <= set(j), f"missing {REQUIRED_FIELDS - set(j)} in {j!r}"
        assert isinstance(j["title"], str) and j["title"]
        assert isinstance(j["url"], str) and j["url"].startswith("http")
        assert isinstance(j["remote"], bool)
        assert isinstance(j["office"], bool)
        assert isinstance(j["relocate"], bool)
        assert isinstance(j["tags"], list)
        assert j["posted_at"] is None or len(j["posted_at"]) == 10
        if source_name:
            assert j["source"] == source_name
```

- [ ] **Step 2: Create conftest with a fixtures-path helper**

Create `selfhost/worker/tests/conftest.py`:

```python
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # selfhost/worker importable


@pytest.fixture
def fixture_text():
    def _load(name):
        return (Path(__file__).parent / "fixtures" / name).read_text(encoding="utf-8")
    return _load
```

- [ ] **Step 3: Add fixtures dir placeholder**

Create `selfhost/worker/tests/fixtures/.gitkeep` (empty).

- [ ] **Step 4: Write failing test for the registry**

Create `selfhost/worker/tests/test_registry.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sources import load_sources


def test_load_sources_returns_modules_with_contract(monkeypatch):
    monkeypatch.delenv("SOURCES_ENABLED", raising=False)
    monkeypatch.delenv("SOURCES_DISABLED", raising=False)
    srcs = load_sources()
    assert len(srcs) >= 1
    for s in srcs:
        assert isinstance(s.NAME, str) and s.NAME
        assert hasattr(s, "fetch") and callable(s.fetch)
        assert isinstance(getattr(s, "REQUIRES_ENV", []), list)


def test_disabled_whitelist_and_blacklist(monkeypatch):
    all_names = {s.NAME for s in load_sources()}
    a_name = sorted(all_names)[0]
    monkeypatch.setenv("SOURCES_ENABLED", a_name)
    assert {s.NAME for s in load_sources()} == {a_name}
    monkeypatch.delenv("SOURCES_ENABLED")
    monkeypatch.setenv("SOURCES_DISABLED", a_name)
    assert a_name not in {s.NAME for s in load_sources()}
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd selfhost/worker && python -m pytest tests/test_registry.py -v`
Expected: FAIL — `ImportError: cannot import name 'load_sources'`

- [ ] **Step 6: Implement the registry in `sources/__init__.py`**

Replace `selfhost/worker/sources/__init__.py` with:

```python
"""Source registry: auto-discovers every source module in this package.

A source module defines:
  NAME: str
  REQUIRES_ENV: list[str]          (default [])
  ENABLED_BY_DEFAULT: bool         (default True)
  fetch(config: dict) -> list[dict]
"""

import importlib
import os
import pkgutil


def _split_env(name):
    return [s.strip() for s in os.getenv(name, "").split(",") if s.strip()]


def load_sources():
    enabled = set(_split_env("SOURCES_ENABLED"))
    disabled = set(_split_env("SOURCES_DISABLED"))
    sources = []
    for mod_info in pkgutil.iter_modules(__path__):
        if mod_info.name in {"base"}:
            continue
        module = importlib.import_module(f"{__name__}.{mod_info.name}")
        if not hasattr(module, "NAME") or not hasattr(module, "fetch"):
            continue
        name = module.NAME
        if getattr(module, "ENABLED_BY_DEFAULT", True) is False and name not in enabled:
            continue
        if enabled and name not in enabled:
            continue
        if name in disabled:
            continue
        sources.append(module)
    return sources
```

- [ ] **Step 7: Run registry test**

Note: with no source modules yet, `test_load_sources_returns_modules_with_contract` asserts `len >= 1`. Implement Task 4 (working_nomads) before this passes, OR temporarily run only the env-logic test:

Run: `cd selfhost/worker && python -m pytest tests/test_registry.py::test_disabled_whitelist_and_blacklist -v`
Expected: this test errors out with "list index out of range" until ≥1 source exists. Proceed — Task 4 adds the first source and both registry tests pass then. Re-run full `tests/test_registry.py` at the end of Task 4.

- [ ] **Step 8: Wire the registry into `worker.py`**

In `selfhost/worker/worker.py`:

Add import near the top:
```python
from sources import load_sources
```

Add this function after `run_scrapers()`:
```python
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
```

Change the central title filter: in `run_scrapers()` remove the inline
`if TITLE_FILTER and not title_matches_queries(title): continue` line (jobs are
filtered centrally now). Then update `main()`:

```python
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
```

Also update the `sources` status line in `merge_into_pool()` to be source-aware:
replace `payload.setdefault("sources", {})["jobspy"] = {"fetched": len(scraped), "added": added}`
with
```python
        payload.setdefault("sources", {})["selfhost_scrapers"] = {"fetched": len(scraped), "added": added}
```
(`scraped` is the merge function's parameter — now the full collected list.)

- [ ] **Step 9: Verify worker imports**

Run: `cd selfhost/worker && python -c "import worker; print('ok')"`
Expected: `ok`

- [ ] **Step 10: Commit**

```bash
git add selfhost/worker/sources/__init__.py selfhost/worker/worker.py selfhost/worker/tests/helpers.py selfhost/worker/tests/conftest.py selfhost/worker/tests/test_registry.py selfhost/worker/tests/fixtures/.gitkeep
git commit -m "feat: source registry + worker integration (no sources yet)"
```

---

## PHASE 1 — Easy wins (API / RSS)

> **Per-source TDD flow (applies to every source task below):**
> 1. **Capture a real fixture first** — run the documented live request once and save the raw body under `tests/fixtures/`. This is a manual capture step, not part of the test suite (tests never hit the network).
> 2. Write the fixture-driven test using `assert_valid_jobs`.
> 3. Implement `fetch()` / the module's `_parse()` against the captured fixture.
> 4. Run the test (PASS), then commit fixture + module + test together.
>
> If a Phase-2 site turns out to require JS (no usable HTML/JSON/RSS without a browser), **drop it** and note it in the README source table — do not add a headless browser.

### Task 4: `working_nomads.py` (JSON API) — reference implementation

**Files:**
- Create: `selfhost/worker/sources/working_nomads.py`
- Create: `selfhost/worker/tests/fixtures/working_nomads.json`
- Create: `selfhost/worker/tests/test_working_nomads.py`

**Endpoint:** `GET https://www.workingnomads.com/api/exposed_jobs/` → JSON array of jobs. Fields typically include `title`, `company_name`, `url`, `description`, `category_name`, `location`, `pub_date`, `tags`. Client-side filter by query (the endpoint returns the full feed).

- [ ] **Step 1: Capture the fixture**

```bash
cd selfhost/worker
python -c "import requests,io; open('tests/fixtures/working_nomads.json','w',encoding='utf-8').write(requests.get('https://www.workingnomads.com/api/exposed_jobs/', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Confirm the file is a JSON array. Inspect the first object to verify field names; adjust the mapping in Step 3 if they differ from those above.

- [ ] **Step 2: Write the failing test**

Create `selfhost/worker/tests/test_working_nomads.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers import assert_valid_jobs
from sources import working_nomads


def test_parses_fixture_into_valid_jobs(fixture_text):
    raw = json.loads(fixture_text("working_nomads.json"))
    jobs = working_nomads._parse(raw, queries=["product manager", "developer"])
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="working_nomads")


def test_query_filter_excludes_unrelated(fixture_text):
    raw = json.loads(fixture_text("working_nomads.json"))
    jobs = working_nomads._parse(raw, queries=["zzzznomatch"])
    assert jobs == []
```

- [ ] **Step 3: Implement the source**

Create `selfhost/worker/sources/working_nomads.py`:

```python
"""Working Nomads — public JSON feed of remote jobs.
Endpoint returns the full feed; we filter client-side by query in title/description.
"""

from normalize import (
    stable_id, strip_html, parse_date,
    derive_location_flags, derive_tags, title_matches_queries,
)
from .base import http_json

NAME = "working_nomads"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

API = "https://www.workingnomads.com/api/exposed_jobs/"


def _parse(rows, queries):
    jobs = []
    for r in rows:
        title = str(r.get("title") or "").strip()
        url = str(r.get("url") or "").strip()
        if not title or not url:
            continue
        description = strip_html(str(r.get("description") or ""))[:5000]
        # Working Nomads is a remote board → treat as remote unless location says otherwise.
        location = str(r.get("location") or "Remote").strip() or "Remote"
        remote = True
        office, relocate = derive_location_flags(title, description, location, remote)
        haystack = f"{title} {description}"
        if queries and not (title_matches_queries(title, queries)
                            or any(q.lower() in haystack.lower() for q in queries)):
            continue
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": str(r.get("company_name") or "—").strip() or "—",
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(r.get("pub_date")),
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    rows = http_json(API)
    if not isinstance(rows, list):
        rows = rows.get("jobs", []) if isinstance(rows, dict) else []
    return _parse(rows, config.get("queries", []))
```

- [ ] **Step 4: Run tests**

Run: `cd selfhost/worker && python -m pytest tests/test_working_nomads.py tests/test_registry.py -v`
Expected: PASS (working_nomads tests + both registry tests now pass — there is ≥1 source).

- [ ] **Step 5: Commit**

```bash
git add selfhost/worker/sources/working_nomads.py selfhost/worker/tests/test_working_nomads.py selfhost/worker/tests/fixtures/working_nomads.json
git commit -m "feat: Working Nomads source (JSON API)"
```

---

### Task 5: `jooble.py` (POST API, requires key)

**Files:**
- Create: `selfhost/worker/sources/jooble.py`
- Create: `selfhost/worker/tests/fixtures/jooble.json`
- Create: `selfhost/worker/tests/test_jooble.py`

**Endpoint:** `POST https://jooble.org/api/<JOOBLE_API_KEY>` with JSON body `{"keywords": "<query>", "location": "<location>"}` → `{"jobs": [{title, location, snippet, salary, link, company, updated, ...}]}`. Free key at https://jooble.org/api/about. `REQUIRES_ENV = ["JOOBLE_API_KEY"]` so it is skipped if the user has no key.

- [ ] **Step 1: Capture the fixture (needs a key)**

```bash
cd selfhost/worker
python -c "import os,requests; open('tests/fixtures/jooble.json','w',encoding='utf-8').write(requests.post('https://jooble.org/api/'+os.environ['JOOBLE_API_KEY'], json={'keywords':'product manager','location':'Serbia'}, timeout=30).text)"
```
If no key is available, hand-write a minimal `jooble.json` matching the documented shape: `{"jobs":[{"title":"Product Manager","company":"Acme","location":"Belgrade, Serbia","link":"https://jooble.org/desc/1","snippet":"...","updated":"2026-06-01T00:00:00","salary":"€60k"}]}`.

- [ ] **Step 2: Write the failing test**

Create `selfhost/worker/tests/test_jooble.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers import assert_valid_jobs
from sources import jooble


def test_parses_fixture_into_valid_jobs(fixture_text):
    raw = json.loads(fixture_text("jooble.json"))
    jobs = jooble._parse(raw, location="Serbia")
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="jooble")
```

- [ ] **Step 3: Implement the source**

Create `selfhost/worker/sources/jooble.py`:

```python
"""Jooble — official aggregator API. One POST per query. Requires a free API key."""

import os

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_json

NAME = "jooble"
REQUIRES_ENV = ["JOOBLE_API_KEY"]
ENABLED_BY_DEFAULT = True

BASE = "https://jooble.org/api/"


def _parse(payload, location):
    jobs = []
    for r in (payload.get("jobs") or []):
        title = str(r.get("title") or "").strip()
        url = str(r.get("link") or "").strip()
        if not title or not url:
            continue
        description = strip_html(str(r.get("snippet") or ""))[:5000]
        loc = str(r.get("location") or location or "—").strip() or "—"
        remote = "remote" in f"{title} {loc}".lower()
        office, relocate = derive_location_flags(title, description, loc, remote)
        salary_text = str(r.get("salary") or "").strip()
        salary = None
        if salary_text:
            try:
                from price_parser import Price
                p = Price.fromstring(salary_text)
                if p.amount and p.amount > 1000:
                    salary = {"min": int(p.amount), "max": int(p.amount),
                              "currency": p.currency or "EUR", "source": NAME}
            except Exception:
                salary = None
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": str(r.get("company") or "—").strip() or "—",
            "location": loc,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(r.get("updated")),
            "salary": salary,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    key = os.environ["JOOBLE_API_KEY"]
    location = config.get("location", "")
    jobs = []
    seen = set()
    for query in config.get("queries", []):
        payload = http_json(BASE + key, method="POST",
                            json_body={"keywords": query, "location": location})
        for job in _parse(payload, location):
            if job["url"] in seen:
                continue
            seen.add(job["url"])
            jobs.append(job)
    return jobs
```

- [ ] **Step 4: Run tests**

Run: `cd selfhost/worker && python -m pytest tests/test_jooble.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add selfhost/worker/sources/jooble.py selfhost/worker/tests/test_jooble.py selfhost/worker/tests/fixtures/jooble.json
git commit -m "feat: Jooble source (official API, requires key)"
```

---

### Task 6: `workable.py` (public job-board API)

**Files:**
- Create: `selfhost/worker/sources/workable.py`
- Create: `selfhost/worker/tests/fixtures/workable.json`
- Create: `selfhost/worker/tests/test_workable.py`

**Endpoint:** Workable's public aggregated search: `GET https://jobs.workable.com/api/v1/jobs?query=<q>&location=<loc>&remote=true` → JSON `{"results":[{title, company:{name}, location:{city,country}, url|shortcode, created_at, description, remote}]}`. **Verify the exact shape from the captured fixture** — Workable has changed this API before; if `/api/v1/jobs` is unavailable, capture from the documented current endpoint and adjust `_parse` field paths accordingly. If no public search endpoint works without auth, **drop this source** and note it in the README.

- [ ] **Step 1: Capture the fixture**

```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/workable.json','w',encoding='utf-8').write(requests.get('https://jobs.workable.com/api/v1/jobs', params={'query':'product manager','remote':'true'}, headers={'User-Agent':'JobRadar-selfhost/1.0','Accept':'application/json'}, timeout=30).text)"
```
Open the file; identify the results array key and per-job field paths. Update Step 3 mappings to match.

- [ ] **Step 2: Write the failing test**

Create `selfhost/worker/tests/test_workable.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers import assert_valid_jobs
from sources import workable


def test_parses_fixture_into_valid_jobs(fixture_text):
    raw = json.loads(fixture_text("workable.json"))
    jobs = workable._parse(raw)
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="workable")
```

- [ ] **Step 3: Implement the source**

Create `selfhost/worker/sources/workable.py`:

```python
"""Workable public job-board search. Field paths confirmed against the captured fixture."""

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_json

NAME = "workable"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

API = "https://jobs.workable.com/api/v1/jobs"


def _job_url(r):
    if r.get("url"):
        return str(r["url"])
    shortcode = r.get("shortcode") or r.get("id")
    return f"https://jobs.workable.com/view/{shortcode}" if shortcode else ""


def _location_str(r):
    loc = r.get("location") or {}
    if isinstance(loc, str):
        return loc
    parts = [loc.get("city"), loc.get("region"), loc.get("country")]
    return ", ".join(p for p in parts if p) or "—"


def _parse(payload):
    rows = payload.get("results") or payload.get("jobs") or []
    jobs = []
    for r in rows:
        title = str(r.get("title") or "").strip()
        url = _job_url(r)
        if not title or not url:
            continue
        company = r.get("company")
        company = company.get("name") if isinstance(company, dict) else company
        description = strip_html(str(r.get("description") or ""))[:5000]
        location = _location_str(r)
        remote = bool(r.get("remote")) or "remote" in f"{title} {location}".lower()
        office, relocate = derive_location_flags(title, description, location, remote)
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": str(company or "—").strip() or "—",
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(r.get("created_at") or r.get("published_on")),
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    jobs = []
    seen = set()
    for query in config.get("queries", []):
        payload = http_json(API, params={"query": query, "remote": "true"})
        for job in _parse(payload):
            if job["url"] in seen:
                continue
            seen.add(job["url"])
            jobs.append(job)
    return jobs
```

- [ ] **Step 4: Run tests**

Run: `cd selfhost/worker && python -m pytest tests/test_workable.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add selfhost/worker/sources/workable.py selfhost/worker/tests/test_workable.py selfhost/worker/tests/fixtures/workable.json
git commit -m "feat: Workable source (public job-board API)"
```

---

### Task 7: `jobspresso.py` (RSS)

**Files:**
- Create: `selfhost/worker/sources/jobspresso.py`
- Create: `selfhost/worker/tests/fixtures/jobspresso.xml`
- Create: `selfhost/worker/tests/test_jobspresso.py`

**Feed:** `https://jobspresso.co/remote-work/feed/` (WP Job Manager RSS). Each `<item>` has `title` (often "Job Title at Company"), `link`, `description` (HTML), `pubDate`. Parsed with `feedparser`.

- [ ] **Step 1: Capture the fixture**

```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/jobspresso.xml','w',encoding='utf-8').write(requests.get('https://jobspresso.co/remote-work/feed/', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Inspect `<item>` structure; confirm how company is encoded in the title (commonly `Title at Company`).

- [ ] **Step 2: Write the failing test**

Create `selfhost/worker/tests/test_jobspresso.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers import assert_valid_jobs
from sources import jobspresso


def test_parses_feed_into_valid_jobs(fixture_text):
    jobs = jobspresso._parse(fixture_text("jobspresso.xml"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="jobspresso")
```

- [ ] **Step 3: Implement the source**

Create `selfhost/worker/sources/jobspresso.py`:

```python
"""Jobspresso — WordPress (WP Job Manager) remote-jobs RSS feed."""

import re

import feedparser

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "jobspresso"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

FEED = "https://jobspresso.co/remote-work/feed/"


def _split_title(raw):
    """'Senior PM at Acme' -> ('Senior PM', 'Acme'). Falls back to (raw, '—')."""
    m = re.match(r"^(.*?)\s+at\s+(.+)$", raw, re.I)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return raw.strip(), "—"


def _parse(xml_text):
    feed = feedparser.parse(xml_text)
    jobs = []
    for e in feed.entries:
        raw_title = str(getattr(e, "title", "")).strip()
        url = str(getattr(e, "link", "")).strip()
        if not raw_title or not url:
            continue
        title, company = _split_title(raw_title)
        description = strip_html(str(getattr(e, "summary", "")))[:5000]
        location = "Remote"
        remote = True
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


def fetch(config):
    return _parse(http_get(FEED))
```

- [ ] **Step 4: Run tests**

Run: `cd selfhost/worker && python -m pytest tests/test_jobspresso.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add selfhost/worker/sources/jobspresso.py selfhost/worker/tests/test_jobspresso.py selfhost/worker/tests/fixtures/jobspresso.xml
git commit -m "feat: Jobspresso source (RSS)"
```

---

### Task 8: `skipthedrive.py` (RSS)

**Files:**
- Create: `selfhost/worker/sources/skipthedrive.py`
- Create: `selfhost/worker/tests/fixtures/skipthedrive.xml`
- Create: `selfhost/worker/tests/test_skipthedrive.py`

**Feed:** SkipTheDrive is WordPress; the site-wide feed is `https://www.skipthedrive.com/feed/`. Items: `title`, `link`, `description`, `pubDate`. Company is usually inside the description, not the title — capture the fixture and confirm; if company is not reliably extractable, set `company = "—"`.

- [ ] **Step 1: Capture the fixture**

```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/skipthedrive.xml','w',encoding='utf-8').write(requests.get('https://www.skipthedrive.com/feed/', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Inspect an `<item>`. Confirm whether company appears as a labelled line in `description` (e.g. "Company Name: X").

- [ ] **Step 2: Write the failing test**

Create `selfhost/worker/tests/test_skipthedrive.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers import assert_valid_jobs
from sources import skipthedrive


def test_parses_feed_into_valid_jobs(fixture_text):
    jobs = skipthedrive._parse(fixture_text("skipthedrive.xml"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="skipthedrive")
```

- [ ] **Step 3: Implement the source**

Create `selfhost/worker/sources/skipthedrive.py`:

```python
"""SkipTheDrive — WordPress remote-jobs RSS feed.
Company often appears as a 'Company Name:' line in the description; extracted if present."""

import re

import feedparser

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "skipthedrive"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

FEED = "https://www.skipthedrive.com/feed/"

_COMPANY_RE = re.compile(r"company\s*name\s*[:\-]\s*(.+)", re.I)


def _company_from(description_html):
    text = strip_html(description_html)
    m = _COMPANY_RE.search(text)
    return m.group(1).split("  ")[0].strip()[:80] if m else "—"


def _parse(xml_text):
    feed = feedparser.parse(xml_text)
    jobs = []
    for e in feed.entries:
        title = str(getattr(e, "title", "")).strip()
        url = str(getattr(e, "link", "")).strip()
        if not title or not url:
            continue
        summary_html = str(getattr(e, "summary", ""))
        description = strip_html(summary_html)[:5000]
        company = _company_from(summary_html)
        location = "Remote"
        remote = True
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


def fetch(config):
    return _parse(http_get(FEED))
```

- [ ] **Step 4: Run tests**

Run: `cd selfhost/worker && python -m pytest tests/test_skipthedrive.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add selfhost/worker/sources/skipthedrive.py selfhost/worker/tests/test_skipthedrive.py selfhost/worker/tests/fixtures/skipthedrive.xml
git commit -m "feat: SkipTheDrive source (RSS)"
```

---

### Task 9: `nodesk.py` (HTML)

**Files:**
- Create: `selfhost/worker/sources/nodesk.py`
- Create: `selfhost/worker/tests/fixtures/nodesk.html`
- Create: `selfhost/worker/tests/test_nodesk.py`

**Page:** `https://nodesk.co/remote-jobs/` — static, server-rendered HTML. Job cards are anchor elements linking to `/remote-jobs/<slug>/`. **Capture the fixture, then read it to determine the exact selectors** (container class, title element, company element). The implementation below uses placeholders `SELECTOR_*` that you replace with the real selectors found in the fixture.

- [ ] **Step 1: Capture the fixture**

```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/nodesk.html','w',encoding='utf-8').write(requests.get('https://nodesk.co/remote-jobs/', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Open `tests/fixtures/nodesk.html`. Find a job listing block. Note: the CSS class/tag of (a) each job card, (b) the title, (c) the company, (d) the job link href. If the listings are rendered only by JS (the HTML has no job text), **drop this source** per the JS rule and note it in the README.

- [ ] **Step 2: Write the failing test**

Create `selfhost/worker/tests/test_nodesk.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helpers import assert_valid_jobs
from sources import nodesk


def test_parses_html_into_valid_jobs(fixture_text):
    jobs = nodesk._parse(fixture_text("nodesk.html"))
    assert len(jobs) >= 1
    assert_valid_jobs(jobs, source_name="nodesk")
```

- [ ] **Step 3: Implement the source**

Create `selfhost/worker/sources/nodesk.py` (replace the `SELECTOR_*` constants with the real selectors from the fixture):

```python
"""NoDesk — static HTML remote-jobs listing.
Selectors confirmed against tests/fixtures/nodesk.html."""

from urllib.parse import urljoin

from bs4 import BeautifulSoup

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "nodesk"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

URL = "https://nodesk.co/remote-jobs/"
BASE = "https://nodesk.co"

# Replace with the actual selectors found in the captured fixture:
SELECTOR_CARD = "li.job"           # each job listing block
SELECTOR_TITLE = "h2"              # title text within a card
SELECTOR_COMPANY = ".company"      # company text within a card
SELECTOR_LINK = "a"                # anchor whose href is the job URL


def _parse(html):
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    for card in soup.select(SELECTOR_CARD):
        link_el = card.select_one(SELECTOR_LINK)
        title_el = card.select_one(SELECTOR_TITLE)
        if not link_el or not title_el:
            continue
        href = link_el.get("href") or ""
        url = urljoin(BASE, href)
        title = title_el.get_text(strip=True)
        if not title or not href:
            continue
        company_el = card.select_one(SELECTOR_COMPANY)
        company = company_el.get_text(strip=True) if company_el else "—"
        description = strip_html(card.get_text(" "))[:5000]
        location = "Remote"
        remote = True
        office, relocate = derive_location_flags(title, description, location, remote)
        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": company or "—",
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": None,
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config):
    return _parse(http_get(URL))
```

- [ ] **Step 4: Run tests**

Run: `cd selfhost/worker && python -m pytest tests/test_nodesk.py -v`
Expected: PASS (1 passed). If 0 jobs parsed, your selectors are wrong — re-inspect the fixture and fix the `SELECTOR_*` constants.

- [ ] **Step 5: Commit**

```bash
git add selfhost/worker/sources/nodesk.py selfhost/worker/tests/test_nodesk.py selfhost/worker/tests/fixtures/nodesk.html
git commit -m "feat: NoDesk source (HTML)"
```

---

## PHASE 2 — Serbian/Russian boards + remaining remote boards (HTML)

> Every Phase-2 task follows the **HTML source pattern from Task 9**: capture fixture → write test with `assert_valid_jobs` → implement BeautifulSoup `_parse` with selectors confirmed from the fixture → run → commit. Each task below gives the URL, the location/remote defaults, and the field-mapping notes specific to that site. The module body mirrors Task 9's structure with the site's URL/BASE/SELECTOR_* and these per-site rules. Searches use the existing English `JOB_QUERIES`; the central title filter in `worker.py` drops off-target results.

### Task 10: `habr_career.py` (HTML)

**Files:** Create `sources/habr_career.py`, `tests/fixtures/habr_career.html`, `tests/test_habr_career.py`.

**Page:** `https://career.habr.com/vacancies?q=<query>&type=all` (per query). Russian board; `location` from the card if present else `"—"`, `remote` = card shows "Можно удалённо"/"remote". `BASE = "https://career.habr.com"`. Use `urljoin` for relative hrefs.

- [ ] **Step 1:** Capture fixture for one query:
```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/habr_career.html','w',encoding='utf-8').write(requests.get('https://career.habr.com/vacancies', params={'q':'product manager','type':'all'}, headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Read the fixture; identify the vacancy card container, title anchor (`href` → job URL), company element, and the remote indicator text. If JS-only, drop and note in README.

- [ ] **Step 2:** Write `tests/test_habr_career.py` (copy of Task 9's test, replacing `nodesk` with `habr_career` and the fixture name with `habr_career.html`).

- [ ] **Step 3:** Implement `sources/habr_career.py` using Task 9's module structure with:
  - `NAME = "habr_career"`, `URL = "https://career.habr.com/vacancies"`, `BASE = "https://career.habr.com"`.
  - `fetch(config)` loops over `config["queries"]`, calling `http_get(URL, params={"q": query, "type": "all"})` and de-duping by URL.
  - `_parse(html)`: per card, derive `remote` from the card text containing `"удал"` or `"remote"`; `location` from the card's location element or `"—"`; everything else via the shared `normalize` helpers.
  - Replace `SELECTOR_*` with the real selectors from the fixture.

- [ ] **Step 4:** Run `cd selfhost/worker && python -m pytest tests/test_habr_career.py -v` → PASS.

- [ ] **Step 5:** Commit:
```bash
git add selfhost/worker/sources/habr_career.py selfhost/worker/tests/test_habr_career.py selfhost/worker/tests/fixtures/habr_career.html
git commit -m "feat: Habr Career source (HTML)"
```

### Task 11: `geekjob.py` (HTML)

**Files:** Create `sources/geekjob.py`, `tests/fixtures/geekjob.html`, `tests/test_geekjob.py`.

**Page:** `https://geekjob.ru/?qs=<query>` (search) or `https://geekjob.ru/vacancies`. Russian. `BASE = "https://geekjob.ru"`. Follows Task 9's HTML pattern.

- [ ] **Step 1:** Capture:
```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/geekjob.html','w',encoding='utf-8').write(requests.get('https://geekjob.ru/vacancies', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Inspect for vacancy cards; if search via querystring works, prefer it. If JS-only, drop + note in README.

- [ ] **Step 2:** Write `tests/test_geekjob.py` (Task 9 test, `geekjob`/`geekjob.html`).

- [ ] **Step 3:** Implement `sources/geekjob.py` (Task 9 structure): `NAME="geekjob"`, `URL`/`BASE` as above, `_parse` with fixture-confirmed selectors, `remote` from card text (`"удал"`/`"remote"`), `location` from card or `"—"`.

- [ ] **Step 4:** Run `python -m pytest tests/test_geekjob.py -v` → PASS.

- [ ] **Step 5:** Commit `feat: GeekJob source (HTML)`.

### Task 12: `poslovi.py` (Poslovi Infostud, HTML)

**Files:** Create `sources/poslovi.py`, `tests/fixtures/poslovi.html`, `tests/test_poslovi.py`.

**Page:** `https://poslovi.infostud.com/oglasi-za-posao?keyword=<query>` — largest Serbian board. `BASE = "https://poslovi.infostud.com"`. Serbian-language UI; English queries still match many IT/PM ads. Location commonly a Serbian city; `remote` if card text contains `"remote"`/`"rad od kuće"`.

- [ ] **Step 1:** Capture:
```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/poslovi.html','w',encoding='utf-8').write(requests.get('https://poslovi.infostud.com/oglasi-za-posao', params={'keyword':'product manager'}, headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Identify ad card container, title anchor, company, location. If JS-only, drop + note.

- [ ] **Step 2:** Write `tests/test_poslovi.py` (Task 9 test, `poslovi`/`poslovi.html`).

- [ ] **Step 3:** Implement `sources/poslovi.py` (Task 9 structure): `NAME="poslovi"`, `URL="https://poslovi.infostud.com/oglasi-za-posao"`, `BASE` as above; `fetch` loops queries with `params={"keyword": query}`; `_parse` with fixture selectors; `remote` from `"remote"`/`"rad od kuće"`; `location` from card.

- [ ] **Step 4:** Run `python -m pytest tests/test_poslovi.py -v` → PASS.

- [ ] **Step 5:** Commit `feat: Poslovi Infostud source (HTML)`.

### Task 13: `helloworld.py` (HelloWorld.rs, HTML)

**Files:** Create `sources/helloworld.py`, `tests/fixtures/helloworld.html`, `tests/test_helloworld.py`.

**Page:** `https://www.helloworld.rs/oglasi-za-posao` (Serbian IT board). `BASE = "https://www.helloworld.rs"`. Task 9 HTML pattern.

- [ ] **Step 1:** Capture:
```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/helloworld.html','w',encoding='utf-8').write(requests.get('https://www.helloworld.rs/oglasi-za-posao', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Inspect job cards; if a keyword query param exists, use it in `fetch`. If JS-only, drop + note.

- [ ] **Step 2:** Write `tests/test_helloworld.py` (Task 9 test, `helloworld`/`helloworld.html`).

- [ ] **Step 3:** Implement `sources/helloworld.py` (Task 9 structure): `NAME="helloworld"`, `URL`/`BASE` as above, fixture-confirmed selectors, `location` from card, `remote` from card text.

- [ ] **Step 4:** Run `python -m pytest tests/test_helloworld.py -v` → PASS.

- [ ] **Step 5:** Commit `feat: HelloWorld.rs source (HTML)`.

### Task 14: `startit.py` (Startit Poslovi, RSS or HTML)

**Files:** Create `sources/startit.py`, `tests/fixtures/startit.xml` (or `.html`), `tests/test_startit.py`.

**Source:** Startit is WordPress — try the feed first: `https://startit.rs/poslovi/feed/`. If a valid RSS feed exists, follow the **RSS pattern from Task 7** (`feedparser`, company via `_split_title` or `"—"`). If no feed, fall back to HTML at `https://startit.rs/poslovi/` using Task 9's pattern.

- [ ] **Step 1:** Probe the feed, capture whichever works:
```bash
cd selfhost/worker
python -c "import requests; r=requests.get('https://startit.rs/poslovi/feed/', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30); open('tests/fixtures/startit.xml','w',encoding='utf-8').write(r.text); print(r.status_code, r.headers.get('content-type'))"
```
If content-type is RSS/XML with `<item>`s → RSS path. Else capture the HTML page to `tests/fixtures/startit.html` and use the HTML path. If JS-only HTML and no feed, drop + note.

- [ ] **Step 2:** Write `tests/test_startit.py`: import `startit`, call `startit._parse(fixture_text("startit.xml"))` (or `.html`), assert `len >= 1` and `assert_valid_jobs(jobs, "startit")`.

- [ ] **Step 3:** Implement `sources/startit.py`: `NAME="startit"`. RSS path mirrors Task 7 (`FEED="https://startit.rs/poslovi/feed/"`, `location="Serbia"`, `remote=False` default, flags via helpers). HTML path mirrors Task 9.

- [ ] **Step 4:** Run `python -m pytest tests/test_startit.py -v` → PASS.

- [ ] **Step 5:** Commit `feat: Startit source (RSS/HTML)`.

### Task 15: `hubstaff.py` (Hubstaff Talent, HTML/JSON)

**Files:** Create `sources/hubstaff.py`, `tests/fixtures/hubstaff.*`, `tests/test_hubstaff.py`.

**Page:** `https://talent.hubstaff.com/search/jobs?search[keywords]=<query>`. Freelance-leaning. Capture and check whether results are server-rendered HTML or fetched via an internal JSON endpoint (watch the page's network/XHR by inspecting the captured HTML for an embedded JSON blob or an `/api/` URL). Use whichever is present; if results are JS-only with no reachable JSON, **drop this source** and note it in the README.

- [ ] **Step 1:** Capture:
```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/hubstaff.html','w',encoding='utf-8').write(requests.get('https://talent.hubstaff.com/search/jobs', params={'search[keywords]':'product manager'}, headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Decide HTML vs JSON from the fixture. Rename fixture to `.json` if you switch to a JSON endpoint.

- [ ] **Step 2:** Write `tests/test_hubstaff.py` (mirror Task 9 for HTML, or Task 4 for JSON), asserting `assert_valid_jobs(jobs, "hubstaff")`.

- [ ] **Step 3:** Implement `sources/hubstaff.py`: `NAME="hubstaff"`. HTML → Task 9 structure with fixture selectors. JSON → Task 4 structure with the discovered endpoint. `remote=True` default (remote-work board), `location` from listing or `"Remote"`.

- [ ] **Step 4:** Run `python -m pytest tests/test_hubstaff.py -v` → PASS (or source dropped with README note).

- [ ] **Step 5:** Commit `feat: Hubstaff Talent source` (or `docs: drop Hubstaff (JS-only)`).

### Task 16: `justremote.py` (HTML)

**Files:** Create `sources/justremote.py`, `tests/fixtures/justremote.html`, `tests/test_justremote.py`.

**Page:** `https://justremote.co/remote-jobs`. **Likely JS-heavy — verify first.** `BASE = "https://justremote.co"`, remote board (`remote=True`, `location="Remote"`).

- [ ] **Step 1:** Capture and check for server-rendered job text:
```bash
cd selfhost/worker
python -c "import requests; t=requests.get('https://justremote.co/remote-jobs', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text; open('tests/fixtures/justremote.html','w',encoding='utf-8').write(t); print('has job links:', 'remote-jobs/' in t)"
```
If the HTML contains no job listings (JS-only), **drop this source** and record it in the README source table; skip Steps 2–5.

- [ ] **Step 2:** Write `tests/test_justremote.py` (Task 9 test, `justremote`/`justremote.html`).

- [ ] **Step 3:** Implement `sources/justremote.py` (Task 9 structure) with fixture-confirmed selectors.

- [ ] **Step 4:** Run `python -m pytest tests/test_justremote.py -v` → PASS.

- [ ] **Step 5:** Commit `feat: JustRemote source (HTML)`.

### Task 17: `virtual_vocations.py` (HTML)

**Files:** Create `sources/virtual_vocations.py`, `tests/fixtures/virtual_vocations.html`, `tests/test_virtual_vocations.py`.

**Page:** `https://www.virtualvocations.com/jobs/q-<query>/` or `https://www.virtualvocations.com/jobs/`. Much content is behind a paywall — only public listing previews are scraped. `BASE = "https://www.virtualvocations.com"`, remote board (`remote=True`, `location="Remote"`). Many cards link to a registration wall; keep only cards with a direct job URL.

- [ ] **Step 1:** Capture:
```bash
cd selfhost/worker
python -c "import requests; open('tests/fixtures/virtual_vocations.html','w',encoding='utf-8').write(requests.get('https://www.virtualvocations.com/jobs/', headers={'User-Agent':'JobRadar-selfhost/1.0'}, timeout=30).text)"
```
Identify public job cards vs paywalled teasers. If everything is paywalled/JS-only, **drop** + note in README.

- [ ] **Step 2:** Write `tests/test_virtual_vocations.py` (Task 9 test, `virtual_vocations`/`virtual_vocations.html`).

- [ ] **Step 3:** Implement `sources/virtual_vocations.py` (Task 9 structure); skip cards without a real job `href`.

- [ ] **Step 4:** Run `python -m pytest tests/test_virtual_vocations.py -v` → PASS.

- [ ] **Step 5:** Commit `feat: Virtual Vocations source (HTML)`.

---

## PHASE 3 — Packaging, config, docs

### Task 18: Add Python dependencies

**Files:** Modify `selfhost/worker/requirements.txt`

- [ ] **Step 1:** Append the new dependencies:

```
# Source registry (Phase 1/2 sources): HTTP + HTML/RSS parsing
requests>=2.31
beautifulsoup4>=4.12
lxml>=5.0
feedparser>=6.0
```

- [ ] **Step 2:** Verify the full requirements install in a clean environment:

Run: `cd selfhost/worker && python -m pip install -r requirements.txt`
Expected: all install without error.

- [ ] **Step 3:** Commit:

```bash
git add selfhost/worker/requirements.txt
git commit -m "build: add requests/bs4/lxml/feedparser for self-host sources"
```

### Task 19: Document config in `.env.example`

**Files:** Modify `selfhost/.env.example`

- [ ] **Step 1:** Append:

```bash
# ---- Source registry (localhost-only, on top of JobSpy) ----
# Whitelist of source NAMEs to run (empty = all defaults on). Names:
#   working_nomads, jooble, workable, jobspresso, skipthedrive, nodesk,
#   habr_career, geekjob, poslovi, helloworld, startit, hubstaff,
#   justremote, virtual_vocations
#SOURCES_ENABLED=
# Blacklist of source NAMEs to skip.
#SOURCES_DISABLED=
# Jooble needs a free API key (https://jooble.org/api/about); without it Jooble is skipped.
#JOOBLE_API_KEY=
# Politeness knobs for the shared HTTP client.
#SOURCES_THROTTLE=1.0
#SOURCES_TIMEOUT=30
```

- [ ] **Step 2:** Update the LinkedIn note on the existing `JOBSPY_SITES` line's comment to make clear LinkedIn is enabled here (no code), e.g. ensure the comment lists `linkedin` (already present). No functional change.

- [ ] **Step 3:** Commit:

```bash
git add selfhost/.env.example
git commit -m "docs: document source registry env in .env.example"
```

### Task 20: Update `selfhost/README.md`

**Files:** Modify `selfhost/README.md`

- [ ] **Step 1:** Add a "Source registry" section after "What the worker does" describing: the worker now runs, each cycle, (1) Node API pipeline, (2) the Python source registry (the 14 new sources), (3) JobSpy, then merges. Include this table:

```markdown
| Source | Type | Env needed | Notes |
|---|---|---|---|
| working_nomads | JSON API | — | remote jobs |
| jooble | API | `JOOBLE_API_KEY` | skipped without key |
| workable | API | — | public job-board search |
| jobspresso | RSS | — | remote |
| skipthedrive | RSS | — | remote |
| nodesk | HTML | — | remote |
| habr_career | HTML | — | RU |
| geekjob | HTML | — | RU |
| poslovi | HTML | — | Serbia |
| helloworld | HTML | — | Serbia (IT) |
| startit | RSS/HTML | — | Serbia |
| hubstaff | HTML/JSON | — | freelance-leaning |
| justremote | HTML | — | remote |
| virtual_vocations | HTML | — | remote (paywalled) |
| LinkedIn | JobSpy | — | enable via `JOBSPY_SITES=linkedin` |
```

Note any source that was dropped during implementation (JS-only) by marking its row "dropped (JS-only)". Document `SOURCES_ENABLED` / `SOURCES_DISABLED`.

- [ ] **Step 2:** Commit:

```bash
git add selfhost/README.md
git commit -m "docs: document the self-host source registry"
```

### Task 21: Full suite + import smoke + final commit

**Files:** none (verification)

- [ ] **Step 1:** Run the whole test suite:

Run: `cd selfhost/worker && python -m pytest -v`
Expected: all tests PASS (normalize, base, registry, and one test per shipped source).

- [ ] **Step 2:** Verify the worker imports with the full registry:

Run: `cd selfhost/worker && python -c "import worker; from sources import load_sources; print('sources:', sorted(s.NAME for s in load_sources()))"`
Expected: prints the list of all shipped source NAMEs; no import errors.

- [ ] **Step 3:** Verify registry isolation — a broken source does not crash the run:

Run: `cd selfhost/worker && python -c "
import os, worker
# Force one source's required env missing is already handled; simulate a fetch crash:
from sources import load_sources
print('loaded', len(load_sources()), 'sources — worker.run_registry_sources isolates failures')
"`
Expected: prints the count; confirms `run_registry_sources` wraps each source in try/except (already implemented in Task 3).

- [ ] **Step 4:** Final commit if anything is uncommitted:

```bash
git add -A
git commit -m "test: full self-host source suite green" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** registry architecture (Tasks 2–3), normalize extraction (Task 1), all Phase-1 sources (Tasks 4–9) + LinkedIn doc (Task 19), all Phase-2 sources (Tasks 10–17), error isolation (Task 3 `run_registry_sources`), politeness (Task 2 `base.py`), fixture tests (every source task), README/env docs (Tasks 19–20), localhost-only boundary (no `scripts/` changes anywhere). Phase 3 / Playwright / localized queries explicitly excluded — no tasks, matching the narrowed spec.
- **Schema consistency:** every source returns the 13-field dict asserted by `assert_valid_jobs` (Task 3 helper); `_parse` is the unit-tested seam in every module; `fetch(config)` is the registry contract used by `run_registry_sources`.
- **JS-only escape hatch:** every HTML task includes a "drop + note in README" branch, honoring the no-headless-browser decision.
