// dashboard.js — fetches data/jobs.json, runs the matcher against the profile,
// renders ranked job cards with filters, NEW badges and "why it fits".

import { el, toast, escapeHtml } from '../app.js';
import { matchJobs, prefilter } from '../matcher.js';
import { getProfile, getSettings, ls, KEYS } from '../storage.js';
import { getPersonalJobs, mergeWithPool, ensureLocationFlags } from '../personal-jobs.js';
import { tryParseQuery, matchesQuery } from '../query.js';

const WEAK_SCORE = 40; // LLM-scored jobs below this are hidden behind a toggle
const HELP_TEXT = `Boolean search: AND (default) · OR · NOT/- · "phrase" · (group)
Fields: title: company: desc: tag: loc: any:
Examples: product manager · (PM OR "product owner") -sales · company:stripe · -loc:"United States"`;

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

  const poolJobs = (Array.isArray(payload) ? payload : payload.jobs || []).map(ensureLocationFlags);
  const updatedAt = payload.updated_at || null;

  // --- Personal layer: jobs fetched from the browser with queries built from
  // YOUR profile (the shared pool is generic — one for all users). ---
  let personal = { queries: [], jobs: [], errors: [] };
  try {
    personal = await getPersonalJobs(profile);
  } catch (err) {
    console.warn('Personal fetch failed:', err);
  }
  const jobs = mergeWithPool(poolJobs, personal.jobs);

  // --- NEW detection: anything we haven't seen in a previous visit ---
  const seen = ls.get(KEYS.SEEN_JOBS, { ids: [] });
  const seenSet = new Set(seen.ids);
  const newIds = new Set(jobs.filter((j) => !seenSet.has(j.id)).map((j) => j.id));
  // Persist current set for next visit (cap memory).
  ls.set(KEYS.SEEN_JOBS, { ids: jobs.map((j) => j.id).slice(0, 5000), lastVisit: new Date().toISOString() });

  // --- Status bar ---
  const refreshBtn = el('button', { class: 'btn btn-secondary btn-sm', title: personal.queries.join(' · ') }, '↻ Refresh personal');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="spinner"></span> Fetching…';
    try {
      await getPersonalJobs(profile, { force: true });
      location.reload();
    } catch (err) {
      toast('Personal fetch failed: ' + (err.message || err), 'error', 6000);
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Refresh personal';
    }
  });

  const statusBar = el('div', { class: 'dash-status' },
    el('span', {}, `${poolJobs.length} jobs in the shared pool`),
    personal.jobs.length
      ? el('span', { title: `Queries from your profile: ${personal.queries.join(' · ')}` },
          `· +${personal.jobs.length} personal (from your profile)`)
      : null,
    updatedAt ? el('span', {}, `· updated ${new Date(updatedAt).toLocaleString()}`) : null,
    newIds.size ? el('span', { class: 'badge badge-new' }, `${newIds.size} new`) : null,
    personal.queries.length ? refreshBtn : null,
  );
  root.append(statusBar);
  if (personal.errors?.length) {
    root.append(el('div', { class: 'notice warn' },
      'Some personal sources failed: ', personal.errors.join('; ')));
  }

  // --- Filters (persisted) ---
  // Geo flags are three independent OR-filters: a Belgrade-based user wants
  // Remote OR Office (Belgrade) OR Relocate (office elsewhere, with help moving).
  // None checked = show all, mirroring the previous "Any location" default.
  const saved = ls.get(KEYS.DASH_FILTERS, {}) || {};
  const state = {
    geo: new Set(Array.isArray(saved.geo) ? saved.geo : []),
    source: saved.source || '',
    tag: saved.tag || '',
    query: saved.query || '',
    onlyNew: !!saved.onlyNew,
    showWeak: false,
    sort: saved.sort || 'relevance',
    queryAst: null,
    queryError: null,
  };
  if (state.query) {
    const { ast, error } = tryParseQuery(state.query);
    state.queryAst = error ? null : ast;
    state.queryError = error;
  }

  function persistFilters() {
    ls.set(KEYS.DASH_FILTERS, {
      geo: [...state.geo],
      source: state.source,
      tag: state.tag,
      query: state.query,
      onlyNew: state.onlyNew,
      sort: state.sort,
    });
  }

  const sources = [...new Set(jobs.map((j) => j.source))].sort();
  const tags = [...new Set(jobs.flatMap((j) => j.tags || []))].sort();

  const geoFilter = geoFilterBox((flag, on) => {
    if (on) state.geo.add(flag); else state.geo.delete(flag);
    persistFilters();
    renderList();
  }, state.geo);
  const sourceSel = sel([['', 'All sources'], ...sources.map((s) => [s, s])], (v) => {
    state.source = v; persistFilters(); renderList();
  }, state.source);
  const tagSel = sel([['', 'All tags'], ...tags.map((t) => [t, t])], (v) => {
    state.tag = v; persistFilters(); renderList();
  }, state.tag);

  const queryInput = el('input', {
    type: 'text',
    placeholder: 'Boolean: (product manager OR "product owner") -sales',
    value: state.query,
    title: HELP_TEXT,
    style: 'min-width:280px; flex:1;',
  });
  const queryHint = el('span', {
    class: 'muted',
    style: 'font-size:12px; min-width:120px;',
  });
  function updateQueryHint() {
    if (!state.query.trim()) {
      queryHint.textContent = '';
      queryInput.style.borderColor = '';
      return;
    }
    if (state.queryError) {
      queryHint.textContent = `⚠ ${state.queryError}`;
      queryHint.style.color = 'var(--danger, #c0392b)';
      queryInput.style.borderColor = 'var(--danger, #c0392b)';
    } else {
      queryHint.textContent = '✓ Boolean OK';
      queryHint.style.color = 'var(--ok, #27ae60)';
      queryInput.style.borderColor = '';
    }
  }
  updateQueryHint();
  queryInput.addEventListener('input', () => {
    state.query = queryInput.value;
    if (!state.query.trim()) {
      state.queryAst = null;
      state.queryError = null;
    } else {
      const { ast, error } = tryParseQuery(state.query);
      state.queryAst = error ? null : ast;
      state.queryError = error;
    }
    updateQueryHint();
    persistFilters();
    renderList();
  });

  const helpBtn = el('button', {
    class: 'btn btn-secondary btn-sm', type: 'button', title: HELP_TEXT,
  }, '?');
  helpBtn.addEventListener('click', () => {
    toast(HELP_TEXT, 'info', 8000);
  });

  const sortSel = sel([
    ['relevance', 'Sort: relevance'],
    ['date', 'Sort: newest'],
    ['salary', 'Sort: salary'],
  ], (v) => { state.sort = v; persistFilters(); renderList(); }, state.sort);

  const newCb = el('input', { type: 'checkbox', id: 'only-new' });
  if (state.onlyNew) newCb.checked = true;
  newCb.addEventListener('change', () => { state.onlyNew = newCb.checked; persistFilters(); renderList(); });

  // Saved searches
  const savedSearches = () => ls.get(KEYS.SAVED_SEARCHES, []) || [];
  const saveBtn = el('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, '☆ Save');
  saveBtn.addEventListener('click', () => {
    const name = prompt('Name this search', state.query || 'My search');
    if (!name) return;
    const list = savedSearches();
    list.unshift({
      name: name.trim(),
      query: state.query,
      geo: [...state.geo],
      source: state.source,
      tag: state.tag,
      sort: state.sort,
    });
    ls.set(KEYS.SAVED_SEARCHES, list.slice(0, 20));
    toast('Search saved', 'ok', 2000);
    renderSavedDropdown();
  });
  const savedSel = el('select', {}, el('option', { value: '' }, 'Saved searches…'));
  function renderSavedDropdown() {
    savedSel.innerHTML = '';
    savedSel.append(el('option', { value: '' }, 'Saved searches…'));
    savedSearches().forEach((s, i) => {
      savedSel.append(el('option', { value: String(i) }, s.name));
    });
  }
  renderSavedDropdown();
  savedSel.addEventListener('change', () => {
    const idx = savedSel.value;
    if (idx === '') return;
    const s = savedSearches()[Number(idx)];
    if (!s) return;
    state.query = s.query || '';
    state.geo = new Set(s.geo || []);
    state.source = s.source || '';
    state.tag = s.tag || '';
    state.sort = s.sort || 'relevance';
    if (state.query) {
      const { ast, error } = tryParseQuery(state.query);
      state.queryAst = error ? null : ast;
      state.queryError = error;
    } else {
      state.queryAst = null; state.queryError = null;
    }
    queryInput.value = state.query;
    sourceSel.value = state.source;
    tagSel.value = state.tag;
    sortSel.value = state.sort;
    geoFilter.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      const flag = cb.id.replace(/^geo-/, '');
      cb.checked = state.geo.has(flag);
    });
    updateQueryHint();
    persistFilters();
    renderList();
    savedSel.value = '';
  });

  root.append(el('div', { class: 'filters' },
    geoFilter, sourceSel, tagSel, sortSel,
    queryInput, helpBtn, queryHint,
    el('label', { for: 'only-new', style: 'display:flex; align-items:center; gap:6px; margin:0; cursor:pointer;' }, newCb, 'NEW only'),
    saveBtn, savedSel,
  ));

  function sel(options, onChange, initial) {
    const s = el('select', {}, ...options.map(([v, label]) => el('option', { value: v }, label)));
    if (initial) s.value = initial;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function geoFilterBox(onToggle, initialSet) {
    const items = [
      ['remote', '🌍 Remote', 'Can work from anywhere / your region'],
      ['office', '🏢 Office', 'On-site or hybrid — physical workplace expected'],
      ['relocate', '✈ Relocate', 'Visa sponsorship or relocation help offered'],
    ];
    const box = el('div', {
      class: 'geo-filter',
      style: 'display:flex; align-items:center; gap:10px; padding:4px 8px; border:1px solid var(--border, #ccc); border-radius:6px;',
      title: 'Geo filters are additive — leave all unchecked to show every job',
    });
    for (const [flag, label, hint] of items) {
      const cb = el('input', { type: 'checkbox', id: `geo-${flag}` });
      if (initialSet?.has(flag)) cb.checked = true;
      cb.addEventListener('change', () => onToggle(flag, cb.checked));
      box.append(el('label', {
        for: `geo-${flag}`, title: hint,
        style: 'display:flex; align-items:center; gap:4px; margin:0; cursor:pointer; user-select:none;',
      }, cb, label));
    }
    return box;
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
    let weakHidden = 0;

    // Invalid Boolean syntax → show nothing (hint already visible) rather than silent full list.
    if (state.query.trim() && state.queryError) {
      listEl.append(el('div', { class: 'empty-state' },
        el('div', { class: 'big' }, '⚠'),
        el('p', {}, 'Fix the Boolean syntax to search. ',
          el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => toast(HELP_TEXT, 'info', 8000) }, 'Syntax help'))));
      return;
    }

    let filtered = [];
    for (const m of matches) {
      const j = m.job;
      if (state.geo.size && ![...state.geo].some((flag) => j[flag])) continue;
      if (state.source && j.source !== state.source) continue;
      if (state.tag && !(j.tags || []).includes(state.tag)) continue;
      if (state.onlyNew && !newIds.has(j.id)) continue;
      if (state.queryAst && !matchesQuery(state.queryAst, j)) continue;
      if (m.score !== null && m.score < WEAK_SCORE) {
        weakHidden++;
        if (!state.showWeak) continue;
      }
      filtered.push(m);
    }

    filtered = sortMatches(filtered, state.sort);

    for (const m of filtered) {
      listEl.append(jobCard(m, newIds.has(m.job.id)));
      shown++;
      if (shown >= 100) break;
    }

    if (weakHidden) {
      const toggle = el('a', { href: '#', style: 'cursor:pointer;' },
        state.showWeak ? 'hide them' : 'show them');
      toggle.addEventListener('click', (e) => { e.preventDefault(); state.showWeak = !state.showWeak; renderList(); });
      listEl.append(el('div', { class: 'dash-status muted' },
        `${weakHidden} weak matches (score < ${WEAK_SCORE}) ${state.showWeak ? 'shown' : 'hidden'} — `, toggle));
    }

    if (!shown && !weakHidden) {
      listEl.append(el('div', { class: 'empty-state' },
        el('div', { class: 'big' }, '🔍'),
        el('p', {}, 'Nothing matches the current filters.')));
    }
  }

  function sortMatches(list, sort) {
    const arr = [...list];
    if (sort === 'date') {
      arr.sort((a, b) => String(b.job.posted_at || '').localeCompare(String(a.job.posted_at || '')));
    } else if (sort === 'salary') {
      const sal = (j) => Math.max(j.salary?.max || 0, j.salary?.min || 0);
      arr.sort((a, b) => sal(b.job) - sal(a.job));
    } else {
      // relevance: LLM score then localScore
      arr.sort((a, b) => {
        const sa = a.score !== null ? a.score : (a.localScore || 0);
        const sb = b.score !== null ? b.score : (b.localScore || 0);
        return sb - sa;
      });
    }
    return arr;
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
        ...geoBadges(j),
        salary ? el('span', {}, `💰 ${salary}`) : null,
        j.posted_at ? el('span', {}, `🗓 ${j.posted_at}`) : null,
        el('span', { class: 'badge badge-source' }, j.source),
        j.personal ? el('span', { class: 'badge badge-tag', title: 'Fetched by your browser with queries from your profile' }, '👤 personal') : null,
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

  function geoBadges(j) {
    const out = [];
    if (j.remote) out.push(el('span', { class: 'badge badge-tag', title: 'Can be done remotely' }, '🌍 remote'));
    if (j.office) out.push(el('span', { class: 'badge badge-tag', title: 'On-site or hybrid — physical workplace expected' }, '🏢 office'));
    if (j.relocate) out.push(el('span', { class: 'badge badge-tag', title: 'Posting mentions visa sponsorship or relocation help' }, '✈ relocate'));
    return out;
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
