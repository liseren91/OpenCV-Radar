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

/** Derive simple tags from title + description for the dashboard filter. */
export function deriveTags(title, description, extra = []) {
  const text = `${title} ${description}`.toLowerCase();
  const tags = new Set(extra.filter(Boolean));
  const rules = [
    ['AI', /\b(ai|ml|machine learning|llm|genai|generative)\b/],
    ['Product', /\bproduct (manager|owner|lead)|pm\b/],
    ['MarTech', /\bmartech|marketing tech|crm|attribution\b/],
    ['Data', /\bdata (engineer|scientist|analyst)|analytics\b/],
    ['Engineering', /\b(software|backend|frontend|fullstack|developer|engineer)\b/],
    ['Design', /\b(designer|ux|ui)\b/],
    ['Senior', /\b(senior|sr\.|staff|principal)\b/],
    ['Lead', /\b(lead|head of|director|vp)\b/],
    ['Junior', /\b(junior|jr\.|intern(ship)?)\b/],
    ['Remote', /\bremote\b/],
  ];
  for (const [tag, re] of rules) if (re.test(text)) tags.add(tag);
  return [...tags];
}
