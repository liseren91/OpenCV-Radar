// Shared helpers for job source adapters. Zero dependencies.

import { createHash } from 'node:crypto';

/** Stable job id from source + url (survives re-fetches). */
export function stableId(source, url) {
  return createHash('sha1').update(`${source}|${url}`).digest('hex').slice(0, 16);
}

/** Strip HTML tags and collapse whitespace. Good enough for job descriptions. */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ISO date (YYYY-MM-DD) or null. */
export function toDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** True if the date is within `days` of now. Unknown dates pass (kept). */
export function isFresh(dateOnly, days) {
  if (!dateOnly) return true;
  const age = (Date.now() - new Date(dateOnly).getTime()) / 86400000;
  return age <= days;
}

/** fetch with timeout + JSON + helpful errors. */
export async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'job-radar (+https://github.com)', Accept: 'application/json', ...(opts.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Derive simple tags for the dashboard filter.
 * Role tags come from the TITLE only — descriptions mention every role under
 * the sun ("report to the Product Manager", "work with engineers") and used to
 * mislabel e.g. sales jobs as Product/Engineering. Context tags (AI / MarTech /
 * Remote) may legitimately come from the description too. */
export function deriveTags(title, description, extra = []) {
  const t = String(title || '').toLowerCase();
  const full = `${t} ${String(description || '').toLowerCase()}`;
  const tags = new Set(extra.filter(Boolean));

  const titleRules = [
    ['Product', /\b(product (manager|owner|lead|management|director)|cpo|pm)\b/],
    ['Data', /\b(data (engineer|scientist|analyst)|analytics)\b/],
    ['Engineering', /\b(software|backend|frontend|fullstack|developer|engineer)\b/],
    ['Design', /\b(designer|ux|ui)\b/],
    ['Sales', /\b(sales|account executive|business development)\b/],
    ['Marketing', /\b(marketing|growth|seo)\b/],
    ['Senior', /\b(senior|sr\.?|staff|principal)\b/],
    ['Lead', /\b(lead|head of|director|vp)\b/],
    ['Junior', /\b(junior|jr\.?|intern(ship)?)\b/],
  ];
  const textRules = [
    ['AI', /\b(ai|ml|machine learning|llm|genai|generative)\b/],
    ['MarTech', /\b(martech|marketing tech(nology)?|crm|attribution)\b/],
    ['Remote', /\bremote\b/],
  ];

  for (const [tag, re] of titleRules) if (re.test(t)) tags.add(tag);
  for (const [tag, re] of textRules) if (re.test(full)) tags.add(tag);
  return [...tags];
}

/** Derive {office, relocate} flags for a posting.
 *
 * `remote` is already determined by each adapter (sources tell us directly).
 * `office`   — is physical presence at a workplace expected? Pure remote-from-anywhere
 *              postings → false; hybrid / on-site → true. Independent from `remote`:
 *              a hybrid role is `remote: true` AND `office: true`.
 * `relocate` — does the posting offer visa sponsorship or relocation help?
 *              Positive signals must be present AND not negated ("no sponsorship").
 *
 * All three flags are independent. They drive the geo filter in the dashboard:
 * Belgrade-based user wants Remote (works from where she is) OR Office in her city
 * OR Office elsewhere WITH Relocate (they help her move).
 */
export function deriveLocationFlags({ title = '', description = '', location = '', remote = false } = {}) {
  const fullText = `${title}\n${description}`;
  return {
    office: detectOffice(location, fullText, remote),
    relocate: detectRelocate(fullText),
  };
}

// Tokens that, alone, mean "remote/anywhere" — not a specific workplace.
const REMOTE_META = new Set([
  'remote', 'anywhere', 'worldwide', 'global', 'distributed',
  'home', 'wfh', 'fully', 'only', 'first', 'friendly',
  'position', 'location', 'based', 'across', 'within',
]);
// Region-only tokens — stripping these does NOT make a location "an office".
// "Remote, EU" / "Remote — Europe" are still remote-only.
const REGION_TOKENS = new Set([
  'eu', 'europe', 'european', 'union', 'us', 'usa', 'united', 'states',
  'america', 'americas', 'emea', 'apac', 'latam', 'asia', 'africa',
  'oceania', 'pacific', 'cet', 'cest', 'gmt', 'utc', 'est', 'pst',
  'timezone', 'tz', 'time', 'zone',
  'north', 'south', 'east', 'west', 'central', 'latin',
]);
// Hybrid / explicit-onsite phrasing in the posting body forces office:true.
const HYBRID_RE = /\b(hybrid|on[-\s]?site|onsite|in[-\s]?office|in[-\s]?person)\b/i;

function detectOffice(location, fullText, remote) {
  const loc = String(location || '').trim();
  let office;
  if (!loc || loc === '—' || loc === '-') {
    office = !remote; // no location info → on-site is the default for non-remote
  } else {
    const remainder = loc.toLowerCase()
      .split(/[^a-zа-яё0-9]+/)
      .filter((w) => w.length >= 2 && !REMOTE_META.has(w) && !REGION_TOKENS.has(w))
      .join('');
    office = remainder.length > 0;
  }
  if (!office && HYBRID_RE.test(fullText)) office = true;
  return office;
}

// Positive sponsorship / relocation signals (EN + RU).
const RELOCATE_RE = new RegExp([
  'relocat\\w+',                          // relocation / relocate / relocating
  'relo[-\\s]?package',
  'visa\\s+sponsorship',
  'sponsor\\s+(?:your|the|a)?\\s*visas?',
  'we\\s+(?:will\\s+)?sponsor\\s+visas?',
  'work[-\\s]?permit\\s+(?:assistance|sponsorship|support)',
  'релок\\w+',                            // релокация / релокейт
  'переезд\\w*',
  'визов\\w+\\s+поддержк\\w+',           // визовая поддержка
  'оплат\\w+\\s+релок\\w+',
  'помощь\\s+с\\s+переездом',
].join('|'), 'i');

// Negations that veto a positive match nearby.
const NO_RELOCATE_RE = new RegExp([
  'no\\s+relocation',
  'no\\s+visa\\s+sponsorship',
  'cannot\\s+sponsor',
  'unable\\s+to\\s+sponsor',
  'does\\s+not\\s+(?:offer\\s+)?(?:relocation|sponsor)',
  'we\\s+do\\s+not\\s+sponsor',
  'без\\s+релокации',
  'релокация\\s+не\\s+предоставляется',
].join('|'), 'i');

function detectRelocate(fullText) {
  return RELOCATE_RE.test(fullText) && !NO_RELOCATE_RE.test(fullText);
}

/** True if the title matches at least one query: every significant word of the
 * query appears in the title as a whole word (case-insensitive). Protects the
 * pool from full-text search noise — e.g. Remotive returns sales jobs for
 * "product manager" because the phrase is merely mentioned in the description. */
export function titleMatchesQueries(title, queries) {
  const t = String(title || '').toLowerCase();
  return (queries || []).some((q) => {
    const words = String(q).toLowerCase().split(/[^a-zа-яё0-9+#.]+/).filter((w) => w.length >= 2);
    return words.length > 0 &&
      words.every((w) => new RegExp(`(^|[^a-zа-яё0-9])${escapeRe(w)}([^a-zа-яё0-9]|$)`, 'i').test(t));
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
