// Adzuna adapter — official API, free tier, requires app_id/app_key.
// Register: https://developer.adzuna.com/ → put keys in GitHub Secrets
// as ADZUNA_APP_ID / ADZUNA_APP_KEY. Adapter is skipped gracefully without them.
// Bonus: Adzuna provides salary data (salary_min/salary_max).

import { stableId, stripHtml, toDateOnly, fetchJSON, deriveTags } from './util.mjs';

export const name = 'adzuna';
export const requiresEnv = ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'];

// Country endpoints relevant for the Remote/Belgrade/EU focus.
// Adzuna has no Serbia endpoint; we use major EU markets (many list remote-EU roles).
const COUNTRIES = ['gb', 'de', 'nl', 'at', 'pl'];
const RESULTS_PER_PAGE = 50;

/**
 * @param {{queries: string[], freshDays: number}} config
 */
export async function fetchJobs(config) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const jobs = [];
  const seen = new Set();

  for (const country of COUNTRIES) {
    for (const query of config.queries) {
      const url =
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1` +
        `?app_id=${appId}&app_key=${appKey}` +
        `&results_per_page=${RESULTS_PER_PAGE}` +
        `&title_only=${encodeURIComponent(query)}` + // match the job TITLE, not full descriptions
        `&max_days_old=${config.freshDays}` +
        `&content-type=application/json`;

      let data;
      try {
        data = await fetchJSON(url);
      } catch (err) {
        // One country/query failing must not kill the rest (rate limits etc.)
        console.warn(`  adzuna ${country}/"${query}" failed: ${err.message}`);
        continue;
      }

      for (const j of data.results || []) {
        const jobUrl = j.redirect_url;
        if (!jobUrl || seen.has(jobUrl)) continue;
        seen.add(jobUrl);

        const description = stripHtml(j.description).slice(0, 5000);
        const location = j.location?.display_name || country.toUpperCase();
        const remote = /remote/i.test(`${j.title} ${description} ${location}`);

        jobs.push({
          id: stableId(name, jobUrl),
          title: j.title?.replace(/<[^>]+>/g, '') || 'Untitled',
          company: j.company?.display_name || '—',
          location,
          remote,
          url: jobUrl,
          source: name,
          posted_at: toDateOnly(j.created),
          salary: j.salary_min || j.salary_max
            ? {
                min: Math.round(j.salary_min || j.salary_max),
                max: Math.round(j.salary_max || j.salary_min),
                currency: country === 'gb' ? 'GBP' : country === 'pl' ? 'PLN' : 'EUR',
                source: name,
              }
            : null,
          description,
          tags: deriveTags(j.title, description, [j.category?.label]),
        });
      }
    }
  }
  return jobs;
}
