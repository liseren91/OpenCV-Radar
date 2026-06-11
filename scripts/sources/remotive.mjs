// Remotive adapter — official public API, no key required.
// Docs: https://github.com/remotive-com/remote-jobs-api

import { stableId, stripHtml, toDateOnly, fetchJSON, deriveTags, deriveLocationFlags } from './util.mjs';

export const name = 'remotive';
export const requiresEnv = []; // no keys needed

const API = 'https://remotive.com/api/remote-jobs';

/**
 * @param {{queries: string[], freshDays: number}} config
 * @returns {Promise<Array>} normalized jobs
 */
export async function fetchJobs(config) {
  const jobs = [];
  const seen = new Set();

  for (const query of config.queries) {
    const url = `${API}?search=${encodeURIComponent(query)}&limit=100`;
    const data = await fetchJSON(url);
    for (const j of data.jobs || []) {
      if (seen.has(j.url)) continue;
      seen.add(j.url);

      const description = stripHtml(j.description).slice(0, 5000);
      const location = j.candidate_required_location || 'Remote';
      const remote = true; // Remotive is remote-only
      const { office, relocate } = deriveLocationFlags({ title: j.title, description, location, remote });
      jobs.push({
        id: stableId(name, j.url),
        title: j.title,
        company: j.company_name,
        location,
        remote,
        office,
        relocate,
        url: j.url,
        source: name,
        posted_at: toDateOnly(j.publication_date),
        salary: parseSalary(j.salary),
        description,
        tags: deriveTags(j.title, description, [j.category]),
      });
    }
  }
  return jobs;
}

// Remotive's salary is a free-text string like "$70,000 - $90,000" or "70k-90k EUR".
function parseSalary(text) {
  if (!text) return null;
  const t = String(text);
  const nums = [...t.matchAll(/(\d[\d,.]*)\s*(k)?/gi)]
    .map((m) => {
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (m[2]) n *= 1000;
      return n;
    })
    .filter((n) => n > 1000 && n < 2000000);
  if (!nums.length) return null;
  const currency = /€|eur/i.test(t) ? 'EUR' : /£|gbp/i.test(t) ? 'GBP' : /\$|usd/i.test(t) ? 'USD' : 'USD';
  return { min: Math.min(...nums), max: Math.max(...nums), currency, source: name };
}
