// RemoteOK adapter — official public API, no key required.
// https://remoteok.com/api returns the latest remote jobs as a JSON array
// (first element is a legal notice object, not a job). No search parameter —
// relevance is enforced by the central title filter in fetch-jobs.mjs.

import { stableId, stripHtml, toDateOnly, fetchJSON, deriveTags, deriveLocationFlags } from './util.mjs';

export const name = 'remoteok';
export const requiresEnv = [];

const API = 'https://remoteok.com/api';

/**
 * @param {{queries: string[], freshDays: number}} config
 * @returns {Promise<Array>} normalized jobs
 */
export async function fetchJobs() {
  const data = await fetchJSON(API);
  const jobs = [];

  for (const j of Array.isArray(data) ? data : []) {
    if (!j || !j.id || !(j.position || j.title) || !j.url) continue; // skips the legal notice

    const title = j.position || j.title;
    const description = stripHtml(j.description).slice(0, 5000);
    const location = j.location || 'Remote';
    const remote = true; // RemoteOK is remote-only
    const { office, relocate } = deriveLocationFlags({ title, description, location, remote });
    jobs.push({
      id: stableId(name, j.url),
      title,
      company: j.company || '—',
      location,
      remote,
      office,
      relocate,
      url: j.url,
      source: name,
      posted_at: toDateOnly(j.date),
      salary: j.salary_min || j.salary_max
        ? {
            min: Math.round(j.salary_min || j.salary_max),
            max: Math.round(j.salary_max || j.salary_min),
            currency: 'USD',
            source: name,
          }
        : null,
      description,
      tags: deriveTags(title, description),
    });
  }
  return jobs;
}
