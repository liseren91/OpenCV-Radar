// xray.js — Boolean / X-Ray query builder from the master profile.
// Generates ready-to-paste Google/Bing/DuckDuckGo links. No scraping, no keys.

import { el, toast } from '../app.js';
import { getProfile, getSettings } from '../storage.js';
import { chatJSON } from '../providers/index.js';

const PLATFORMS = [
  {
    id: 'ats',
    label: 'ATS career pages',
    hint: 'Greenhouse, Lever, Ashby, Workable, …',
    build: (terms) => terms.flatMap((t) => [
      `site:boards.greenhouse.io ${q(t)}`,
      `site:jobs.lever.co ${q(t)}`,
      `site:jobs.ashbyhq.com ${q(t)}`,
      `site:apply.workable.com ${q(t)}`,
    ]),
  },
  {
    id: 'linkedin',
    label: 'LinkedIn jobs',
    hint: 'Public job listings indexed by Google',
    build: (terms) => terms.map((t) =>
      `site:linkedin.com/jobs ${q(t)} -inurl:dir`),
  },
  {
    id: 'habr',
    label: 'Habr Career',
    hint: 'RU / CIS tech roles',
    build: (terms) => terms.map((t) =>
      `site:career.habr.com ${q(t)} -inurl:companies -inurl:courses -inurl:vacancies`),
  },
  {
    id: 'github',
    label: 'GitHub',
    hint: 'Repos / jobs.md / “we are hiring”',
    build: (terms) => terms.map((t) =>
      `site:github.com ${q(t)} (intitle:hiring OR intitle:jobs OR "we are hiring" OR filename:jobs.md)`),
  },
];

function q(term) {
  const t = String(term || '').trim();
  return t.includes(' ') ? `"${t}"` : t;
}

/** Build search terms from the master profile (roles + focus). */
export function termsFromProfile(profile) {
  const terms = [];
  const push = (t) => {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 3) return;
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
  };
  for (const role of profile?.headline_roles || []) {
    push(String(role).replace(/\bpm\b/gi, 'product manager').replace(/\bpo\b/gi, 'product owner'));
  }
  for (const f of profile?.preferences?.focus || []) push(f);
  const locs = (profile?.basics?.locations || []).filter((l) => l && !/remote/i.test(l));
  return { terms: terms.slice(0, 5), locations: locs.slice(0, 3) };
}

function searchLinks(query) {
  const enc = encodeURIComponent(query);
  return {
    google: `https://www.google.com/search?q=${enc}`,
    bing: `https://www.bing.com/search?q=${enc}`,
    ddg: `https://duckduckgo.com/?q=${enc}`,
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok', 1500);
  } catch {
    toast('Could not copy — select the text manually', 'warn', 3000);
  }
}

export async function renderXray(root) {
  root.append(
    el('h1', {}, 'X-Ray search'),
    el('p', { class: 'subtitle' },
      'Boolean queries scoped to a site (', el('code', {}, 'site:'),
      '). Copy into Google / Bing / DuckDuckGo — no API key needed.'),
  );

  const profile = getProfile();
  if (!profile) {
    root.append(el('div', { class: 'empty-state' },
      el('div', { class: 'big' }, '🔎'),
      el('p', {}, 'Upload a CV first so we can derive roles. ',
        el('a', { href: '#/onboarding' }, 'Go to Profile'), '.')));
    return;
  }

  const { terms, locations } = termsFromProfile(profile);
  if (!terms.length) {
    root.append(el('div', { class: 'notice warn' },
      'No headline roles in your profile yet — add some under Profile / Interview.'));
  }

  root.append(el('div', { class: 'notice' },
    el('strong', {}, 'From your profile: '),
    terms.length ? terms.map((t) => el('code', { style: 'margin-right:6px;' }, t)) : '(none)',
    locations.length
      ? el('span', {}, ' · locations: ', ...locations.map((l) => el('code', { style: 'margin-right:6px;' }, l)))
      : null,
  ));

  // Platform tabs
  let active = PLATFORMS[0].id;
  const tabBar = el('div', { class: 'filters', style: 'flex-wrap:wrap;' });
  const listEl = el('div', { class: 'xray-list' });
  root.append(tabBar, listEl);

  function renderQueries() {
    listEl.innerHTML = '';
    const platform = PLATFORMS.find((p) => p.id === active) || PLATFORMS[0];
    const baseTerms = terms.length ? terms : ['product manager'];
    let queries = platform.build(baseTerms);
    // Optionally append a location OR-group
    if (locations.length && platform.id !== 'github') {
      const locClause = locations.map((l) => q(l)).join(' OR ');
      queries = queries.map((qq) => `${qq} (${locClause})`);
    }

    listEl.append(el('p', { class: 'muted' }, platform.hint));

    for (const query of queries) {
      const links = searchLinks(query);
      const card = el('div', { class: 'card', style: 'margin-bottom:12px; padding:14px;' },
        el('pre', {
          class: 'xray-query',
          style: 'white-space:pre-wrap; word-break:break-word; margin:0 0 10px; font-size:13px;',
        }, query),
        el('div', { style: 'display:flex; flex-wrap:wrap; gap:8px; align-items:center;' },
          el('button', { class: 'btn btn-sm btn-secondary', type: 'button' }, 'Copy'),
          el('a', { class: 'btn btn-sm', href: links.google, target: '_blank', rel: 'noopener' }, 'Google'),
          el('a', { class: 'btn btn-sm btn-secondary', href: links.bing, target: '_blank', rel: 'noopener' }, 'Bing'),
          el('a', { class: 'btn btn-sm btn-secondary', href: links.ddg, target: '_blank', rel: 'noopener' }, 'DuckDuckGo'),
        ),
      );
      card.querySelector('button').addEventListener('click', () => copyText(query));
      listEl.append(card);
    }
  }

  for (const p of PLATFORMS) {
    const btn = el('button', {
      class: `btn btn-sm ${p.id === active ? '' : 'btn-secondary'}`,
      type: 'button',
      'data-id': p.id,
    }, p.label);
    btn.addEventListener('click', () => {
      active = p.id;
      tabBar.querySelectorAll('button').forEach((b) => {
        b.className = `btn btn-sm ${b.dataset.id === active ? '' : 'btn-secondary'}`;
      });
      renderQueries();
    });
    tabBar.append(btn);
  }

  // Optional LLM refine
  const settings = getSettings();
  const hasKey = settings.provider && settings.apiKeys?.[settings.provider];
  if (hasKey) {
    const llmBtn = el('button', { class: 'btn btn-sm', type: 'button', style: 'margin-left:auto;' },
      '✨ Craft with AI');
    tabBar.append(llmBtn);
    llmBtn.addEventListener('click', async () => {
      llmBtn.disabled = true;
      llmBtn.innerHTML = '<span class="spinner"></span> Crafting…';
      try {
        const platform = PLATFORMS.find((p) => p.id === active);
        const prompt =
          `You are a Boolean/X-Ray sourcing expert. Given this candidate profile JSON:\n` +
          `${JSON.stringify(profile, null, 2)}\n\n` +
          `Write 3 Google X-Ray queries for finding JOB OPENINGS (not candidates) ` +
          `relevant to this person on platform "${platform.label}". ` +
          `Use site: operators, OR/AND/-/"phrases". Return JSON: {"queries":["...","...","..."]}.`;
        const parsed = await chatJSON([{ role: 'user', content: prompt }], { temperature: 0.3 });
        const qs = parsed?.queries || [];
        if (!qs.length) throw new Error('Model returned no queries');
        listEl.innerHTML = '';
        listEl.append(el('p', { class: 'muted' }, 'AI-crafted queries — review before using.'));
        for (const query of qs) {
          const links = searchLinks(query);
          const card = el('div', { class: 'card', style: 'margin-bottom:12px; padding:14px;' },
            el('pre', { style: 'white-space:pre-wrap; word-break:break-word; margin:0 0 10px; font-size:13px;' }, query),
            el('div', { style: 'display:flex; flex-wrap:wrap; gap:8px;' },
              el('button', { class: 'btn btn-sm btn-secondary', type: 'button' }, 'Copy'),
              el('a', { class: 'btn btn-sm', href: links.google, target: '_blank', rel: 'noopener' }, 'Google'),
              el('a', { class: 'btn btn-sm btn-secondary', href: links.bing, target: '_blank', rel: 'noopener' }, 'Bing'),
              el('a', { class: 'btn btn-sm btn-secondary', href: links.ddg, target: '_blank', rel: 'noopener' }, 'DuckDuckGo'),
            ),
          );
          card.querySelector('button').addEventListener('click', () => copyText(query));
          listEl.append(card);
        }
      } catch (err) {
        toast('AI craft failed: ' + (err.message || err), 'error', 6000);
        renderQueries();
      } finally {
        llmBtn.disabled = false;
        llmBtn.textContent = '✨ Craft with AI';
      }
    });
  }

  renderQueries();

  root.append(el('div', { class: 'notice', style: 'margin-top:24px;' },
    el('strong', {}, 'Tip: '),
    'Operators — ', el('code', {}, 'AND'), ' ', el('code', {}, 'OR'), ' ',
    el('code', {}, 'NOT/-'), ' ', el('code', {}, '"exact phrase"'), ' ',
    el('code', {}, '(group)'), ' · Fields in the dashboard search: ',
    el('code', {}, 'title:'), ' ', el('code', {}, 'company:'), ' ',
    el('code', {}, 'desc:'), ' ', el('code', {}, 'loc:'), ' ', el('code', {}, 'tag:'),
    '. Self-host users can also set ', el('code', {}, 'XRAY_SEARCH_API_KEY'),
    ' so the worker discovers ATS companies automatically.'));
}
