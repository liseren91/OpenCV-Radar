// personal-jobs.js — fetches jobs for *your* profile, straight from the browser.
//
// The shared data/jobs.json pool is one-for-everyone (built from generic queries
// by the Action / selfhost worker). This module adds the personal layer the
// architecture promises ("персонализация — у каждого в браузере"): it derives
// search queries from your master profile and queries CORS-friendly job APIs
// (Remotive, hh.ru) directly. No author-side server involved; results are
// cached in localStorage and merged into the dashboard pool.

import { ls, KEYS, tinyHash } from './storage.js';

const CACHE_TTL_HOURS = 6;
const FRESH_DAYS = 14;
const MAX_QUERIES = 6;
const MAX_JOBS = 150;
const DESCRIPTION_CAP = 1500; // keep localStorage small; matcher sends ≤1200 chars anyway

// ---------- Queries from profile ----------

// Seniority words that are meaningless as a standalone query ("Lead" matches everything).
const GENERIC_WORDS = /^(lead|head|senior|sr|principal|staff|junior|jr|group|chief|director|vp|manager)$/i;

/** Derive search queries from the master profile: headline roles, expanded and split. */
export function buildQueriesFromProfile(profile) {
  const out = [];
  const push = (q) => {
    q = String(q || '').replace(/\s+/g, ' ').trim();
    // Seniority qualifiers narrow the title match too much ("Lead product manager"
    // would skip a plain "Product Manager" posting) — search for the role core.
    q = q.replace(/^((lead|senior|sr|principal|staff|junior|jr|group|chief)\s+)+/i, '');
    if (!q) return;
    // Single generic words would flood the radar with unrelated jobs.
    if (!q.includes(' ') && (GENERIC_WORDS.test(q) || q.length < 3)) return;
    if (!out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q);
  };

  for (const role of profile?.headline_roles || []) {
    // "Lead/Group PM" → "Lead PM" + "Group PM": single seniority words inherit
    // the role noun from the last slash part.
    const parts = String(role).split('/').map((p) => p.trim()).filter(Boolean);
    const lastWords = parts.length ? parts[parts.length - 1].split(/\s+/) : [];
    const roleNoun = lastWords[lastWords.length - 1] || '';
    for (const part of parts) {
      const full = (!part.includes(' ') && GENERIC_WORDS.test(part) && roleNoun && part !== roleNoun)
        ? `${part} ${roleNoun}`
        : part;
      push(full
        .replace(/\bpm\b/gi, 'product manager')
        .replace(/\bpo\b/gi, 'product owner'));
    }
  }
  // Focus areas make good qualified queries when the person is product-side.
  const productish = out.some((q) => /product/i.test(q));
  for (const f of profile?.preferences?.focus || []) {
    if (productish) push(`${f} product manager`);
  }

  return out.slice(0, MAX_QUERIES);
}

// Same guard as the fetch pipeline: every significant word of at least one query
// must appear in the title as a whole word (sources search full text otherwise).
function titleMatchesQueries(title, queries) {
  const t = String(title || '').toLowerCase();
  return queries.some((q) => {
    const words = String(q).toLowerCase().split(/[^a-zа-яё0-9+#.]+/).filter((w) => w.length >= 2);
    return words.length > 0 &&
      words.every((w) => new RegExp(`(^|[^a-zа-яё0-9])${escapeRe(w)}([^a-zа-яё0-9]|$)`, 'i').test(t));
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Fetching ----------

/**
 * Returns { fetchedAt, queries, jobs, errors }. Serves a cached result when the
 * queries are unchanged and the cache is younger than CACHE_TTL_HOURS.
 */
export async function getPersonalJobs(profile, { force = false } = {}) {
  const queries = buildQueriesFromProfile(profile);
  if (!queries.length) return { fetchedAt: null, queries, jobs: [], errors: [] };

  const cached = ls.get(KEYS.PERSONAL_JOBS, null);
  const fresh = cached && (Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000 < CACHE_TTL_HOURS;
  const sameQueries = cached && JSON.stringify(cached.queries) === JSON.stringify(queries);
  if (!force && fresh && sameQueries) return cached;

  const errors = [];
  const settled = await Promise.allSettled([
    fetchRemotive(queries),
    fetchHH(queries),
    fetchRemoteOK(),
    fetchArbeitnow(),
  ]);

  const jobs = [];
  const seen = new Set();
  for (const r of settled) {
    if (r.status === 'rejected') { errors.push(String(r.reason?.message || r.reason)); continue; }
    for (const job of r.value) {
      const key = `${norm(job.company)}|${norm(job.title)}`;
      if (seen.has(key) || seen.has(job.url)) continue;
      seen.add(key); seen.add(job.url);
      if (!titleMatchesQueries(job.title, queries)) continue;
      if (!withinDays(job.posted_at, FRESH_DAYS)) continue;
      jobs.push(job);
    }
  }

  jobs.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
  const payload = {
    fetchedAt: new Date().toISOString(),
    queries,
    jobs: jobs.slice(0, MAX_JOBS),
    errors,
  };
  try { ls.set(KEYS.PERSONAL_JOBS, payload); } catch { /* quota — cache is best-effort */ }
  return payload;
}

/** Merge personal jobs into the shared pool, deduping by url and company|title. */
export function mergeWithPool(poolJobs, personalJobs) {
  const seen = new Set();
  for (const j of poolJobs) {
    seen.add(j.url);
    seen.add(`${norm(j.company)}|${norm(j.title)}`);
  }
  const extra = (personalJobs || []).filter((j) =>
    !seen.has(j.url) && !seen.has(`${norm(j.company)}|${norm(j.title)}`));
  return [...poolJobs, ...extra];
}

// ---------- Source adapters (browser-side, CORS-friendly APIs only) ----------

async function fetchRemotive(queries) {
  const jobs = [];
  for (const query of queries) {
    const res = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=50`,
      { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Remotive HTTP ${res.status}`);
    const data = await res.json();
    for (const j of data.jobs || []) {
      const location = j.candidate_required_location || 'Remote';
      const description = stripHtml(j.description).slice(0, DESCRIPTION_CAP);
      const { office, relocate } = deriveLocationFlags({ title: j.title, description, location, remote: true });
      jobs.push({
        id: `p-remotive-${tinyHash(j.url)}`,
        title: j.title,
        company: j.company_name,
        location,
        remote: true,
        office,
        relocate,
        url: j.url,
        source: 'remotive',
        personal: true,
        posted_at: toDateOnly(j.publication_date),
        salary: null,
        description,
        tags: [j.category].filter(Boolean),
      });
    }
  }
  return jobs;
}

async function fetchHH(queries) {
  const jobs = [];
  for (const query of queries) {
    const url = `https://api.hh.ru/vacancies?text=${encodeURIComponent(query)}` +
      `&search_field=name&schedule=remote&period=${FRESH_DAYS}&per_page=50&order_by=publication_time`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`hh.ru HTTP ${res.status}`);
    const data = await res.json();
    for (const j of data.items || []) {
      if (!j.alternate_url) continue;
      const description = stripHtml([j.snippet?.responsibility, j.snippet?.requirement].filter(Boolean).join('\n')).slice(0, DESCRIPTION_CAP);
      const location = j.area?.name || 'Remote';
      const { office, relocate } = deriveLocationFlags({ title: j.name, description, location, remote: true });
      jobs.push({
        id: `p-hh-${tinyHash(j.alternate_url)}`,
        title: j.name,
        company: j.employer?.name || '—',
        location,
        remote: true,
        office,
        relocate,
        url: j.alternate_url,
        source: 'hh',
        personal: true,
        posted_at: toDateOnly(j.published_at),
        salary: j.salary ? {
          min: j.salary.from || j.salary.to || 0,
          max: j.salary.to || j.salary.from || 0,
          currency: (j.salary.currency || 'RUR').replace('RUR', 'RUB'),
          source: 'hh',
        } : null,
        description,
        tags: (j.professional_roles || []).map((r) => r.name),
      });
    }
  }
  return jobs;
}

// RemoteOK / Arbeitnow have no search parameter — we pull the newest jobs and
// rely on the title filter in getPersonalJobs to keep only relevant ones.

async function fetchRemoteOK() {
  const res = await fetch('https://remoteok.com/api', { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`RemoteOK HTTP ${res.status}`);
  const data = await res.json();
  const jobs = [];
  for (const j of Array.isArray(data) ? data : []) {
    if (!j || !j.id || !(j.position || j.title) || !j.url) continue; // first element is a legal notice
    const title = j.position || j.title;
    const description = stripHtml(j.description).slice(0, DESCRIPTION_CAP);
    const location = j.location || 'Remote';
    const { office, relocate } = deriveLocationFlags({ title, description, location, remote: true });
    jobs.push({
      id: `p-remoteok-${tinyHash(j.url)}`,
      title,
      company: j.company || '—',
      location,
      remote: true,
      office,
      relocate,
      url: j.url,
      source: 'remoteok',
      personal: true,
      posted_at: toDateOnly(j.date),
      salary: j.salary_min || j.salary_max ? {
        min: Math.round(j.salary_min || j.salary_max),
        max: Math.round(j.salary_max || j.salary_min),
        currency: 'USD',
        source: 'remoteok',
      } : null,
      description,
      tags: (j.tags || []).slice(0, 5),
    });
  }
  return jobs;
}

async function fetchArbeitnow() {
  const jobs = [];
  for (let page = 1; page <= 4; page++) {
    const res = await fetch(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Arbeitnow HTTP ${res.status}`);
    const data = await res.json();
    for (const j of data.data || []) {
      if (!j.url) continue;
      const description = stripHtml(j.description).slice(0, DESCRIPTION_CAP);
      const location = j.location || (j.remote ? 'Remote' : '—');
      const remote = !!j.remote;
      const { office, relocate } = deriveLocationFlags({ title: j.title, description, location, remote });
      jobs.push({
        id: `p-arbeitnow-${tinyHash(j.url)}`,
        title: j.title,
        company: j.company_name || '—',
        location,
        remote,
        office,
        relocate,
        url: j.url,
        source: 'arbeitnow',
        personal: true,
        posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : null,
        salary: null,
        description,
        tags: (j.tags || []).slice(0, 5),
      });
    }
    if (!data.links?.next) break;
  }
  return jobs;
}

// ---------- Small helpers (browser twins of scripts/sources/util.mjs) ----------

// Three independent location flags — see scripts/sources/util.mjs for the canonical
// version and prose. Kept in sync by hand; the browser side cannot import Node code.
const REMOTE_META = new Set([
  'remote', 'anywhere', 'worldwide', 'global', 'distributed',
  'home', 'wfh', 'fully', 'only', 'first', 'friendly',
  'position', 'location', 'based', 'across', 'within',
]);
const REGION_TOKENS = new Set([
  'eu', 'europe', 'european', 'union', 'us', 'usa', 'united', 'states',
  'america', 'americas', 'emea', 'apac', 'latam', 'asia', 'africa',
  'oceania', 'pacific', 'cet', 'cest', 'gmt', 'utc', 'est', 'pst',
  'timezone', 'tz', 'time', 'zone',
  'north', 'south', 'east', 'west', 'central', 'latin',
]);
const HYBRID_RE = /\b(hybrid|on[-\s]?site|onsite|in[-\s]?office|in[-\s]?person)\b/i;
const RELOCATE_RE = /relocat\w+|relo[-\s]?package|visa\s+sponsorship|sponsor\s+(?:your|the|a)?\s*visas?|we\s+(?:will\s+)?sponsor\s+visas?|work[-\s]?permit\s+(?:assistance|sponsorship|support)|релок\w+|переезд\w*|визов\w+\s+поддержк\w+|оплат\w+\s+релок\w+|помощь\s+с\s+переездом/i;
const NO_RELOCATE_RE = /no\s+relocation|no\s+visa\s+sponsorship|cannot\s+sponsor|unable\s+to\s+sponsor|does\s+not\s+(?:offer\s+)?(?:relocation|sponsor)|we\s+do\s+not\s+sponsor|без\s+релокации|релокация\s+не\s+предоставляется/i;

/** Twin of util.mjs::deriveLocationFlags. Returns {office, relocate}; `remote` is passed in. */
export function deriveLocationFlags({ title = '', description = '', location = '', remote = false } = {}) {
  const fullText = `${title}\n${description}`;
  const loc = String(location || '').trim();
  let office;
  if (!loc || loc === '—' || loc === '-') {
    office = !remote;
  } else {
    const remainder = loc.toLowerCase()
      .split(/[^a-zа-яё0-9]+/)
      .filter((w) => w.length >= 2 && !REMOTE_META.has(w) && !REGION_TOKENS.has(w))
      .join('');
    office = remainder.length > 0;
  }
  if (!office && HYBRID_RE.test(fullText)) office = true;
  const relocate = RELOCATE_RE.test(fullText) && !NO_RELOCATE_RE.test(fullText);
  return { office, relocate };
}

/** Back-fill office/relocate for jobs from a pre-flag pool (legacy jobs.json on
 *  forks that haven't re-fetched yet). Mutates and returns the job for chaining. */
export function ensureLocationFlags(job) {
  if (typeof job.office !== 'boolean' || typeof job.relocate !== 'boolean') {
    const flags = deriveLocationFlags({
      title: job.title,
      description: job.description,
      location: job.location,
      remote: !!job.remote,
    });
    if (typeof job.office !== 'boolean') job.office = flags.office;
    if (typeof job.relocate !== 'boolean') job.relocate = flags.relocate;
  }
  return job;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function withinDays(dateOnly, days) {
  if (!dateOnly) return true;
  return (Date.now() - new Date(dateOnly).getTime()) / 86400000 <= days;
}
