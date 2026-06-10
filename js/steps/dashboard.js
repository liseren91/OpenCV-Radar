// dashboard.js — fetches data/jobs.json, runs the matcher against the profile,
// renders ranked job cards with filters, NEW badges and "why it fits".

import { el, toast, escapeHtml } from '../app.js';
import { matchJobs, prefilter } from '../matcher.js';
import { getProfile, getSettings, ls, KEYS } from '../storage.js';

export async function renderDashboard(root) {
  root.append(
    el('h1', {}, 'Job radar'),
    el('p', { class: 'subtitle' }, 'Fresh jobs, ranked against your master profile. Updated daily.'),
  );

  const profile = getProfile();
  if (!profile) {
    root.append(el('div', { class: 'empty-state' },
      el('div', { class: 'big' }, '📡'),
      el('p', {}, 'The radar needs your profile first. ', el('a', { href: '#/onboarding' }, 'Upload your CV'), '.')));
    return;
  }

  // --- Load jobs.json ---
  let payload;
  try {
    const res = await fetch(`data/jobs.json?t=${Date.now() >> 16}`); // mild cache-bust, stable for ~18h
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    root.append(el('div', { class: 'notice warn' },
      'Could not load jobs.json (', String(err.message || err), '). ',
      'On a fresh fork the daily GitHub Action may not have run yet.'));
    return;
  }

  const jobs = Array.isArray(payload) ? payload : payload.jobs || [];
  const updatedAt = payload.updated_at || null;

  // --- NEW detection: anything we haven't seen in a previous visit ---
  const seen = ls.get(KEYS.SEEN_JOBS, { ids: [] });
  const seenSet = new Set(seen.ids);
  const newIds = new Set(jobs.filter((j) => !seenSet.has(j.id)).map((j) => j.id));
  // Persist current set for next visit (cap memory).
  ls.set(KEYS.SEEN_JOBS, { ids: jobs.map((j) => j.id).slice(0, 5000), lastVisit: new Date().toISOString() });

  // --- Status bar ---
  const statusBar = el('div', { class: 'dash-status' },
    el('span', {}, `${jobs.length} jobs in the pool`),
    updatedAt ? el('span', {}, `· updated ${new Date(updatedAt).toLocaleString()}`) : null,
    newIds.size ? el('span', { class: 'badge badge-new' }, `${newIds.size} new`) : null,
  );
  root.append(statusBar);

  // --- Filters ---
  const state = { remote: '', source: '', tag: '', query: '', onlyNew: false };

  const sources = [...new Set(jobs.map((j) => j.source))].sort();
  const tags = [...new Set(jobs.flatMap((j) => j.tags || []))].sort();

  const remoteSel = sel([['', 'Any location'], ['remote', 'Remote only'], ['onsite', 'On-site / hybrid']], (v) => { state.remote = v; renderList(); });
  const sourceSel = sel([['', 'All sources'], ...sources.map((s) => [s, s])], (v) => { state.source = v; renderList(); });
  const tagSel = sel([['', 'All tags'], ...tags.map((t) => [t, t])], (v) => { state.tag = v; renderList(); });
  const queryInput = el('input', { type: 'text', placeholder: 'Search title / company…' });
  queryInput.addEventListener('input', () => { state.query = queryInput.value.toLowerCase(); renderList(); });
  const newCb = el('input', { type: 'checkbox', id: 'only-new' });
  newCb.addEventListener('change', () => { state.onlyNew = newCb.checked; renderList(); });

  root.append(el('div', { class: 'filters' },
    remoteSel, sourceSel, tagSel, queryInput,
    el('label', { for: 'only-new', style: 'display:flex; align-items:center; gap:6px; margin:0; cursor:pointer;' }, newCb, 'NEW only'),
  ));

  function sel(options, onChange) {
    const s = el('select', {}, ...options.map(([v, label]) => el('option', { value: v }, label)));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  // --- Matching ---
  const listEl = el('div', {});
  const matchStatus = el('div', { class: 'dash-status' });
  root.append(matchStatus, listEl);

  let matches = prefilter(jobs, profile).map(({ job, localScore }) => ({ job, score: null, why: '', llm: false, localScore }));
  renderList();

  const settings = getSettings();
  const hasKey = settings.provider && settings.apiKeys?.[settings.provider];

  if (!hasKey) {
    matchStatus.append(el('span', {}, '⚠ No LLM key — showing keyword-based ordering. ',
      el('a', { href: '#/settings' }, 'Add your key'), ' for real matching.'));
  } else {
    const rankBtn = el('button', { class: 'btn btn-sm' }, '✨ Rank with AI');
    matchStatus.append(rankBtn);
    rankBtn.addEventListener('click', async () => {
      rankBtn.disabled = true;
      const prog = el('span', { class: 'muted' }, '');
      matchStatus.append(prog);
      try {
        matches = await matchJobs(jobs, profile, (done, total) => {
          prog.innerHTML = ` <span class="spinner"></span> Scoring ${done}/${total} (cached results are free)`;
        });
        prog.textContent = ' Done. Cached — re-ranking is free until your profile changes.';
        renderList();
      } catch (err) {
        toast('Matching failed: ' + (err.message || err), 'error', 8000);
        prog.textContent = '';
      } finally {
        rankBtn.disabled = false;
      }
    });
  }

  // --- List rendering ---
  function renderList() {
    listEl.innerHTML = '';
    let shown = 0;

    for (const m of matches) {
      const j = m.job;
      if (state.remote === 'remote' && !j.remote) continue;
      if (state.remote === 'onsite' && j.remote) continue;
      if (state.source && j.source !== state.source) continue;
      if (state.tag && !(j.tags || []).includes(state.tag)) continue;
      if (state.onlyNew && !newIds.has(j.id)) continue;
      if (state.query && !`${j.title} ${j.company}`.toLowerCase().includes(state.query)) continue;

      listEl.append(jobCard(m, newIds.has(j.id)));
      shown++;
      if (shown >= 100) break; // keep DOM light
    }

    if (!shown) {
      listEl.append(el('div', { class: 'empty-state' },
        el('div', { class: 'big' }, '🔍'),
        el('p', {}, 'Nothing matches the current filters.')));
    }
  }

  function jobCard(match, isNew) {
    const j = match.job;
    const salary = j.salary && (j.salary.min || j.salary.max)
      ? `${fmtMoney(j.salary.min)}–${fmtMoney(j.salary.max)} ${j.salary.currency || ''}`
      : null;

    return el('div', { class: 'job-card' },
      el('div', { class: 'job-head' },
        match.score !== null ? scorePill(match.score) : null,
        el('a', { class: 'job-title', href: j.url, target: '_blank', rel: 'noopener' }, j.title),
        isNew ? el('span', { class: 'badge badge-new' }, 'NEW') : null,
      ),
      el('div', { class: 'job-meta' },
        el('span', {}, `🏢 ${j.company || '—'}`),
        el('span', {}, `📍 ${j.location || (j.remote ? 'Remote' : '—')}`),
        salary ? el('span', {}, `💰 ${salary}`) : null,
        j.posted_at ? el('span', {}, `🗓 ${j.posted_at}`) : null,
        el('span', { class: 'badge badge-source' }, j.source),
      ),
      (j.tags || []).length
        ? el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap; margin:6px 0;' },
            ...(j.tags || []).slice(0, 8).map((t) => el('span', { class: 'badge badge-tag' }, t)))
        : null,
      match.why ? el('div', { class: 'job-why' }, `💡 ${match.why}`) : null,
      el('div', { class: 'job-actions' },
        el('a', { class: 'btn btn-sm', href: `#/tailor?job=${encodeURIComponent(j.id)}` }, '✂ Tailor CV'),
        el('a', { class: 'btn btn-secondary btn-sm', href: j.url, target: '_blank', rel: 'noopener' }, 'Open posting ↗'),
      ),
    );
  }

  function scorePill(score) {
    const cls = score >= 75 ? 'score-high' : score >= 50 ? 'score-mid' : 'score-low';
    return el('span', { class: `score-pill ${cls}` }, String(score));
  }

  function fmtMoney(n) {
    if (!n) return '?';
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }
}
