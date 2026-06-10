// tailor.js — rewrite the CV for a chosen job (or any pasted JD),
// draft a cover letter, and estimate the salary range from legal data.

import { el, toast, routeParams } from '../app.js';
import { chatJSON } from '../providers/index.js';
import { fillPrompt } from '../prompts.js';
import { getProfile, getSettings, idb } from '../storage.js';

export async function renderTailor(root) {
  root.append(
    el('h1', {}, 'Tailor'),
    el('p', { class: 'subtitle' }, 'Pick a job from the dashboard or paste any job description. Get a tailored CV, cover letter and a salary read.'),
  );

  const profile = getProfile();
  if (!profile) {
    root.append(el('div', { class: 'empty-state' },
      el('div', { class: 'big' }, '📄'),
      el('p', {}, 'No profile yet. ', el('a', { href: '#/onboarding' }, 'Upload your CV first'), '.')));
    return;
  }

  const settings = getSettings();
  if (!settings.provider || !settings.apiKeys?.[settings.provider]) {
    root.append(el('div', { class: 'notice warn' },
      'Tailoring needs your LLM key. ', el('a', { href: '#/settings' }, 'Add it in Settings'), '.'));
    return;
  }

  // --- Input: job from dashboard (?job=id) or pasted JD ---
  const params = routeParams();
  let prefillJob = null;
  if (params.job) {
    try {
      const res = await fetch('data/jobs.json');
      const payload = await res.json();
      const jobs = Array.isArray(payload) ? payload : payload.jobs || [];
      prefillJob = jobs.find((j) => String(j.id) === params.job) || null;
    } catch { /* fall through to manual paste */ }
  }

  const jdInput = el('textarea', {
    placeholder: 'Paste the job description here (title, company, requirements)…',
    style: 'min-height:220px;',
  });
  if (prefillJob) {
    jdInput.value = `${prefillJob.title} — ${prefillJob.company}\n${prefillJob.location || ''}\n\n${prefillJob.description || ''}`;
  }

  const goBtn = el('button', { class: 'btn' }, '✂ Tailor my CV for this job');
  const outputWrap = el('div', {});

  root.append(
    el('div', { class: 'card' },
      prefillJob
        ? el('p', {}, el('strong', {}, prefillJob.title), ` at ${prefillJob.company} `, el('a', { href: prefillJob.url, target: '_blank', rel: 'noopener' }, '↗'))
        : null,
      el('label', {}, 'Job description'),
      jdInput,
      el('div', { style: 'margin-top:12px;' }, goBtn),
    ),
    outputWrap,
  );

  goBtn.addEventListener('click', async () => {
    const jd = jdInput.value.trim();
    if (jd.length < 80) return toast('Paste a fuller job description (at least a paragraph).', 'error');

    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spinner"></span> Writing… (20–60s)';
    outputWrap.innerHTML = '';

    try {
      // 1. Tailored CV + cover letter
      const tailorPrompt = await fillPrompt('tailor', { PROFILE: profile, JOB: jd.slice(0, 12000) });
      const result = await chatJSON([{ role: 'user', content: tailorPrompt }], { temperature: 0.4, maxTokens: 4096 });

      // 2. Salary estimate (best-effort; market data comes from the job pool's own salary fields)
      let salary = null;
      try {
        const market = prefillJob?.salary ? [prefillJob.salary] : [];
        const salaryPrompt = await fillPrompt('salary', {
          JOB: jd.slice(0, 6000),
          MARKET: market,
          EXPECTATION: profile.salary_expectation || {},
        });
        salary = await chatJSON([{ role: 'user', content: salaryPrompt }], { temperature: 0.2, maxTokens: 800 });
      } catch (err) {
        console.error('Salary estimate failed:', err);
      }

      renderResult(outputWrap, result, salary, prefillJob, jd);

      // Save to history (best effort)
      try {
        await idb.set('history', `tailor-${Date.now()}`, {
          at: new Date().toISOString(),
          job: prefillJob ? { id: prefillJob.id, title: prefillJob.title, company: prefillJob.company, url: prefillJob.url } : { pasted: jd.slice(0, 300) },
          result,
        });
      } catch { /* non-critical */ }
    } catch (err) {
      toast('Tailoring failed: ' + (err.message || err), 'error', 9000);
    } finally {
      goBtn.disabled = false;
      goBtn.textContent = '✂ Tailor my CV for this job';
    }
  });
}

// ---------- Output ----------

function renderResult(wrap, result, salary, job, jd) {
  wrap.innerHTML = '';

  const tabs = [
    { id: 'cv', label: '📄 Tailored CV', content: result.cv_markdown || '(empty)' },
    { id: 'cover', label: '✉ Cover letter', content: result.cover_letter || '(empty)' },
  ];

  const tabBar = el('div', { class: 'tabs' });
  const body = el('div', { class: 'tailor-output' });

  let active = 'cv';
  function show(id) {
    active = id;
    body.textContent = tabs.find((t) => t.id === id).content;
    tabBar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  }
  for (const t of tabs) {
    const btn = el('button', { class: 'tab', 'data-id': t.id, onclick: () => show(t.id) }, t.label);
    tabBar.append(btn);
  }

  const copyBtn = el('button', {
    class: 'btn btn-secondary btn-sm',
    onclick: async () => {
      await navigator.clipboard.writeText(tabs.find((t) => t.id === active).content);
      toast('Copied to clipboard.', 'success');
    },
  }, '📋 Copy');

  const downloadBtn = el('button', {
    class: 'btn btn-secondary btn-sm',
    onclick: () => {
      const t = tabs.find((x) => x.id === active);
      const blob = new Blob([t.content], { type: 'text/markdown' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `${t.id === 'cv' ? 'cv' : 'cover-letter'}-tailored.md` });
      a.click();
      URL.revokeObjectURL(a.href);
    },
  }, '⬇ Download .md');

  const printBtn = el('button', {
    class: 'btn btn-secondary btn-sm',
    onclick: () => {
      const t = tabs.find((x) => x.id === active);
      const w = window.open('', '_blank');
      w.document.write(`<pre style="font-family: Georgia, serif; white-space: pre-wrap; max-width: 720px; margin: 40px auto; font-size: 14px;">${t.content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`);
      w.document.close();
      w.print();
    },
  }, '🖨 Print / PDF');

  wrap.append(
    el('div', { class: 'card' },
      tabBar,
      body,
      el('div', { style: 'display:flex; gap:10px; margin-top:12px;' }, copyBtn, downloadBtn, printBtn),
      result.fit_notes ? el('div', { class: 'notice', style: 'margin-top:14px;' }, el('strong', {}, 'Coach notes: '), result.fit_notes) : null,
    ),
  );

  if (salary?.estimate) {
    wrap.append(
      el('div', { class: 'card' },
        el('h3', { style: 'margin-top:0;' }, '💰 Salary read'),
        el('p', {},
          el('strong', {}, `${fmt(salary.estimate.min)}–${fmt(salary.estimate.max)} ${salary.estimate.currency || ''}`),
          el('span', { class: 'muted' }, `  · confidence: ${salary.confidence || '?'}`)),
        salary.basis ? el('p', { class: 'muted' }, salary.basis) : null,
        salary.vs_expectation ? el('p', {}, salary.vs_expectation) : null,
      ),
    );
  }

  show('cv');

  function fmt(n) {
    if (!n) return '?';
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }
}
