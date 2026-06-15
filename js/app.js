// app.js — hash router + shared UI helpers + Welcome/Settings screens.
// Feature screens live in js/steps/*.js and register themselves via routes.

import { getSettings, saveSettings, getProfile, deleteAllKeys, wipeEverything } from './storage.js';
import { PROVIDERS, listModels, defaultModelFor } from './providers/index.js';
import { renderOnboarding } from './steps/onboarding.js';
import { renderInterview } from './steps/interview.js';
import { renderDashboard } from './steps/dashboard.js';
import { renderTailor } from './steps/tailor.js';

// ---------- Tiny DOM helpers ----------

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function toast(message, type = 'info', ms = 4000) {
  const box = document.getElementById('toast-container');
  const t = el('div', { class: `toast ${type}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Router ----------

const app = document.getElementById('app');

const routes = {
  '': renderWelcome,
  'settings': renderSettings,
  'onboarding': renderOnboarding,
  'interview': renderInterview,
  'dashboard': renderDashboard,
  'tailor': renderTailor,
};

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  return hash.split('?')[0];
}

export function routeParams() {
  const hash = location.hash.replace(/^#\/?/, '');
  const q = hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

async function render() {
  const route = currentRoute();
  const handler = routes[route] || renderWelcome;

  // nav highlight
  document.querySelectorAll('#main-nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });

  app.innerHTML = '';
  try {
    await handler(app);
  } catch (err) {
    console.error(err);
    app.innerHTML = '';
    app.append(
      el('div', { class: 'card' },
        el('h2', {}, 'Something went wrong'),
        el('p', { class: 'muted' }, String(err.message || err)),
      ),
    );
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

// ---------- Welcome screen ----------

function renderWelcome(root) {
  const settings = getSettings();
  const hasKey = settings.provider && settings.apiKeys?.[settings.provider];
  const hasProfile = !!getProfile();

  const cta = !hasKey
    ? el('a', { href: '#/settings', class: 'btn' }, 'Get started — add your API key')
    : !hasProfile
      ? el('a', { href: '#/onboarding', class: 'btn' }, 'Continue — upload your CV')
      : el('a', { href: '#/dashboard', class: 'btn' }, 'Open your dashboard');

  root.append(
    el('div', { class: 'hero' },
      el('h1', {}, '📡 Job Radar'),
      el('p', { class: 'subtitle' },
        'Deep candidate profile → daily job radar → CV tailoring. ',
        'Free, open source, privacy-first. Your data and your LLM key never leave this browser.'),
      cta,
    ),
    el('div', { class: 'hero-steps' },
      heroStep(1, 'Bring your own key', 'Paste your OpenAI or Anthropic API key. It is stored only in your browser — we have no server to send it to.'),
      heroStep(2, 'Build a master profile', 'Upload your CV. An adaptive interview digs out the expertise that never fits on one page.'),
      heroStep(3, 'Watch the radar', 'Fresh jobs land daily. Your browser ranks them against your full profile and explains why each one fits.'),
      heroStep(4, 'Tailor and apply', 'One click rewrites your CV for the chosen job and drafts a cover letter.'),
    ),
    el('div', { class: 'notice' },
      el('strong', {}, 'Privacy: '),
      'this is a static site. CV, profile, answers and API keys live in your browser (localStorage / IndexedDB). ',
      'LLM calls go directly from your browser to the provider with your key. The only shared resource is a public, anonymous jobs.json updated daily.'),
  );

  function heroStep(num, title, text) {
    return el('div', { class: 'card hero-step' },
      el('div', { class: 'num' }, String(num)),
      el('strong', {}, title),
      el('p', { class: 'muted' }, text),
    );
  }
}

// ---------- Settings screen ----------
//
// Flow:
//   1. Pick provider.
//   2. Paste API key.
//   3. Click "Load available models" — we hit the provider's /v1/models endpoint
//      with that key (same call validates the key for free).
//   4. Pick a model from the dynamic list.
//   5. Save.
// If a key is already saved on mount, models auto-load so the user lands on
// their previously chosen model without an extra click.

function renderSettings(root) {
  const settings = getSettings();

  root.append(el('h1', {}, 'Settings'), el('p', { class: 'subtitle' }, 'LLM provider, model and your API key.'));

  const providerSel = el('select', {},
    el('option', { value: '' }, '— choose provider —'),
    ...PROVIDERS.map((p) => el('option', { value: p.id, ...(settings.provider === p.id ? { selected: '' } : {}) }, p.label)),
  );

  const keyInput = el('input', { type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
  const keyHelp = el('p', { class: 'muted' });

  const modelSel = el('select', { disabled: '' },
    el('option', { value: '' }, '— load models first —'),
  );
  const modelHint = el('p', { class: 'muted' }, 'Models appear after we check your key with the provider.');

  const loadBtn = el('button', { class: 'btn btn-secondary btn-sm' }, 'Load available models');
  const saveBtn = el('button', { class: 'btn', disabled: '' }, 'Save settings');
  const statusEl = el('span', { class: 'key-status' });

  function updateStatus() {
    const pid = providerSel.value;
    const saved = pid && getSettings().apiKeys?.[pid];
    statusEl.innerHTML = '';
    statusEl.append(
      el('span', { class: `dot ${saved ? 'ok' : 'off'}` }),
      saved ? 'Key saved in this browser' : 'No key saved',
    );
  }

  function setModelOptions(models, selectedId) {
    modelSel.innerHTML = '';
    if (!models.length) {
      modelSel.append(el('option', { value: '' }, 'No chat-capable models available'));
      modelSel.disabled = true;
      saveBtn.disabled = true;
      return;
    }
    const target = selectedId && models.some((m) => m.id === selectedId)
      ? selectedId
      : (defaultModelFor(providerSel.value) && models.some((m) => m.id === defaultModelFor(providerSel.value))
        ? defaultModelFor(providerSel.value)
        : models[0].id);
    for (const m of models) {
      modelSel.append(el('option', { value: m.id, ...(m.id === target ? { selected: '' } : {}) }, m.label));
    }
    modelSel.disabled = false;
    saveBtn.disabled = false;
  }

  function resetModelOptions(reason) {
    modelSel.innerHTML = '';
    modelSel.append(el('option', { value: '' }, reason || '— load models first —'));
    modelSel.disabled = true;
    saveBtn.disabled = true;
  }

  async function loadModels({ silent = false } = {}) {
    const pid = providerSel.value;
    const key = keyInput.value.trim();
    if (!pid) {
      if (!silent) toast('Choose a provider first.', 'error');
      return;
    }
    if (!key) {
      if (!silent) toast('Paste your API key first.', 'error');
      return;
    }
    loadBtn.disabled = true;
    loadBtn.innerHTML = '<span class="spinner"></span> Checking key & loading models…';
    modelHint.textContent = 'Talking to ' + pid + '…';
    try {
      const models = await listModels(pid, key);
      const currentSettings = getSettings();
      const preselect = currentSettings.provider === pid ? currentSettings.model : null;
      setModelOptions(models, preselect);
      modelHint.textContent = `${models.length} model${models.length === 1 ? '' : 's'} available for this key.`;
      if (!silent) toast('Key works — pick a model and save.', 'success');
    } catch (err) {
      resetModelOptions('— could not load —');
      modelHint.textContent = '';
      toast(String(err.message || err), 'error', 8000);
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load available models';
    }
  }

  function onProviderChange() {
    const pid = providerSel.value;
    resetModelOptions();
    if (!pid) {
      keyInput.value = '';
      keyHelp.textContent = '';
      modelHint.textContent = 'Choose a provider to begin.';
      updateStatus();
      return;
    }
    const meta = PROVIDERS.find((p) => p.id === pid);
    keyHelp.innerHTML = `Get a key: <a href="${meta.keyUrl}" target="_blank" rel="noopener">${meta.keyUrl}</a>`;
    keyInput.value = settings.apiKeys?.[pid] || '';
    modelHint.textContent = keyInput.value
      ? 'Loading models for your saved key…'
      : 'Paste your key, then click "Load available models".';
    updateStatus();
    if (keyInput.value) loadModels({ silent: true });
  }

  // Typing/pasting a fresh key invalidates the previous model list — force the
  // user to re-check so we never save a stale (key, model) pair.
  keyInput.addEventListener('input', () => {
    const pid = providerSel.value;
    const savedKey = pid ? (settings.apiKeys?.[pid] || '') : '';
    if (keyInput.value.trim() !== savedKey) {
      resetModelOptions('— re-load models for this key —');
      modelHint.textContent = 'Click "Load available models" to refresh the list.';
    }
  });

  providerSel.addEventListener('change', onProviderChange);
  loadBtn.addEventListener('click', () => loadModels());

  saveBtn.addEventListener('click', () => {
    const pid = providerSel.value;
    if (!pid) return toast('Choose a provider.', 'error');
    const model = modelSel.value;
    if (!model) return toast('Load and pick a model first.', 'error');
    const key = keyInput.value.trim();
    if (!key) return toast('Paste your API key.', 'error');
    const s = getSettings();
    s.provider = pid;
    s.model = model;
    s.apiKeys = { ...s.apiKeys, [pid]: key };
    saveSettings(s);
    updateStatus();
    toast('Settings saved (in your browser only).', 'success');
  });

  const deleteKeyBtn = el('button', { class: 'btn btn-danger btn-sm' }, 'Delete all keys');
  deleteKeyBtn.addEventListener('click', () => {
    deleteAllKeys();
    keyInput.value = '';
    resetModelOptions();
    modelHint.textContent = 'Paste your key, then click "Load available models".';
    updateStatus();
    toast('All API keys removed from this browser.', 'success');
  });

  root.append(
    el('div', { class: 'card' },
      el('h2', {}, 'LLM provider'),
      el('div', { class: 'notice' },
        el('strong', {}, 'Your key stays here. '),
        'It is saved in localStorage of this browser and is sent only to the provider\'s API, directly. ',
        'It never touches any server of ours — there is none.'),
      el('label', {}, 'Provider'), providerSel,
      el('label', {}, 'API key'), keyInput, keyHelp,
      el('div', { style: 'display:flex; gap:10px; margin-top:8px; align-items:center;' },
        loadBtn, el('span', { class: 'spacer' }), statusEl,
      ),
      el('label', {}, 'Model'), modelSel, modelHint,
      el('div', { style: 'display:flex; gap:10px; margin-top:16px;' }, saveBtn),
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Danger zone'),
      el('p', { class: 'muted' }, 'Remove keys, or wipe everything this app stored in your browser (profile, CV, cache, keys).'),
      el('div', { style: 'display:flex; gap:10px;' },
        deleteKeyBtn,
        el('button', {
          class: 'btn btn-danger btn-sm',
          onclick: async () => {
            if (!confirm('Wipe ALL Job Radar data from this browser?')) return;
            await wipeEverything();
            toast('All local data wiped.', 'success');
            location.hash = '#/';
          },
        }, 'Wipe all local data'),
      ),
    ),
  );

  onProviderChange();
}
