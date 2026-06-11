// hh.ru adapter — official open API (api.hh.ru), no key required for search.
// Docs: https://api.hh.ru/openapi/redoc
// Useful for Serbia/EU/remote-friendly listings on HeadHunter.

import { stableId, stripHtml, toDateOnly, fetchJSON, deriveTags, deriveLocationFlags } from './util.mjs';

export const name = 'hh';
export const requiresEnv = [];

const API = 'https://api.hh.ru/vacancies';

// hh.ru area ids: 113 = Russia, 1001 = Other regions; text search covers Serbia/remote.
// We search without area restriction plus schedule=remote pass for remote roles.
const SEARCH_PASSES = [
  { params: 'schedule=remote', label: 'remote' },
  { params: 'area=2179', label: 'serbia' }, // 2179 = Serbia in hh.ru areas tree
];

/**
 * @param {{queries: string[], freshDays: number}} config
 */
export async function fetchJobs(config) {
  const jobs = [];
  const seen = new Set();
  const periodDays = Math.min(config.freshDays, 30); // hh API caps `period` at 30

  for (const pass of SEARCH_PASSES) {
    for (const query of config.queries) {
      const url =
        `${API}?text=${encodeURIComponent(query)}` +
        `&search_field=name` + // match the vacancy TITLE only, not full descriptions
        `&${pass.params}` +
        `&period=${periodDays}` +
        `&per_page=50&page=0` +
        `&order_by=publication_time`;

      let data;
      try {
        // hh.ru requires a UA in "AppName/version (contact)" form and may still
        // return 403 for some datacenter/foreign IPs — we degrade gracefully.
        data = await fetchJSON(url, {
          headers: {
            'User-Agent': 'JobRadar/1.0 (https://github.com/job-radar)',
            'HH-User-Agent': 'JobRadar/1.0 (https://github.com/job-radar)',
          },
        });
      } catch (err) {
        console.warn(`  hh ${pass.label}/"${query}" failed: ${err.message}`);
        continue;
      }

      for (const j of data.items || []) {
        const jobUrl = j.alternate_url;
        if (!jobUrl || seen.has(jobUrl)) continue;
        seen.add(jobUrl);

        // The search endpoint returns a snippet, not the full description — good enough for matching.
        const description = stripHtml(
          [j.snippet?.responsibility, j.snippet?.requirement].filter(Boolean).join('\n'),
        ).slice(0, 5000);

        const remote = j.schedule?.id === 'remote' || pass.label === 'remote';
        const location = j.area?.name || (remote ? 'Remote' : '—');
        const { office, relocate } = deriveLocationFlags({ title: j.name, description, location, remote });

        jobs.push({
          id: stableId(name, jobUrl),
          title: j.name,
          company: j.employer?.name || '—',
          location,
          remote,
          office,
          relocate,
          url: jobUrl,
          source: name,
          posted_at: toDateOnly(j.published_at),
          salary: j.salary
            ? {
                min: j.salary.from || j.salary.to || 0,
                max: j.salary.to || j.salary.from || 0,
                currency: (j.salary.currency || 'RUR').replace('RUR', 'RUB'),
                source: name,
              }
            : null,
          description,
          tags: deriveTags(j.name, description, j.professional_roles?.map((r) => r.name) || []),
        });
      }
    }
  }
  return jobs;
}
