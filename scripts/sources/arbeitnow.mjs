// Arbeitnow adapter — free open API, no key required, EU-friendly board.
// Docs: https://www.arbeitnow.com/api/job-board-api (paginated, no search param —
// relevance is enforced by the central title filter in fetch-jobs.mjs).

import { stableId, stripHtml, fetchJSON, deriveTags, deriveLocationFlags } from './util.mjs';

export const name = 'arbeitnow';
export const requiresEnv = [];

const API = 'https://www.arbeitnow.com/api/job-board-api';
const PAGES = 5; // ~100 newest jobs per page; PM-grade roles are sparse, so dig deeper

/**
 * @param {{queries: string[], freshDays: number}} config
 * @returns {Promise<Array>} normalized jobs
 */
export async function fetchJobs() {
  const jobs = [];
  const seen = new Set();

  for (let page = 1; page <= PAGES; page++) {
    const data = await fetchJSON(`${API}?page=${page}`);
    for (const j of data.data || []) {
      if (!j.url || seen.has(j.url)) continue;
      seen.add(j.url);

      const description = stripHtml(j.description).slice(0, 5000);
      const location = j.location || (j.remote ? 'Remote' : '—');
      const remote = !!j.remote;
      const { office, relocate } = deriveLocationFlags({ title: j.title, description, location, remote });
      jobs.push({
        id: stableId(name, j.url),
        title: j.title,
        company: j.company_name || '—',
        location,
        remote,
        office,
        relocate,
        url: j.url,
        source: name,
        posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : null,
        salary: null, // Arbeitnow does not expose salary data
        description,
        tags: deriveTags(j.title, description, (j.tags || []).slice(0, 3)),
      });
    }
    if (!data.links?.next) break;
  }
  return jobs;
}
