// onboarding.js — CV upload → in-browser parsing (pdf.js / mammoth) →
// LLM draft of the master profile → editable JSON + export/import.

import { el, toast } from '../app.js';
import { chatJSON } from '../providers/index.js';
import { fillPrompt } from '../prompts.js';
import {
  getProfile, saveProfile, getSettings, getProfilePhoto, saveProfilePhoto,
  idb, ls, KEYS,
} from '../storage.js';

// CDN libs, loaded lazily on first use so the app shell stays dependency-free.
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs';
const MAMMOTH_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js';

export async function renderOnboarding(root) {
  root.append(
    el('h1', {}, 'Your profile'),
    el('p', { class: 'subtitle' },
      'Upload your CV to build a draft master profile (photo optional), then refine it in the adaptive interview.'),
  );

  const settings = getSettings();
  if (!settings.provider || !settings.apiKeys?.[settings.provider]) {
    root.append(el('div', { class: 'notice warn' },
      'No API key configured yet. ', el('a', { href: '#/settings' }, 'Add your key in Settings'),
      ' — CV parsing uses your LLM.'));
  }

  root.append(await photoCard(root));

  const existing = getProfile();
  if (existing) {
    await renderEditor(root, existing);
    root.append(uploadCard(root, 'Replace profile from a new CV'));
  } else {
    root.append(uploadCard(root, 'Upload your CV (PDF or DOCX)'));
    renderImportExport(root, null);
  }
}

// ---------- Profile photo (optional) ----------

async function rerenderOnboarding() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  await renderOnboarding(app);
}

async function photoCard(root) {
  const stored = await getProfilePhoto();
  const previewUrl = stored?.blob ? URL.createObjectURL(stored.blob) : null;

  const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const statusEl = el('p', { class: 'muted' });
  const preview = el('div', { class: 'photo-preview' });

  function setPreview(url) {
    preview.innerHTML = '';
    if (url) {
      preview.append(el('img', { src: url, alt: 'Profile photo preview' }));
    }
  }
  setPreview(previewUrl);

  const zone = el('div', { class: 'dropzone photo-dropzone' },
    el('div', { style: 'font-size:34px;' }, '📷'),
    el('p', {}, stored ? 'Replace profile photo' : 'Upload profile photo'),
    el('p', { class: 'muted' }, 'JPEG, PNG or WebP · max 5 MB · optional'),
    fileInput,
  );

  async function handlePhoto(file) {
    try {
      await saveProfilePhoto(file);
      toast('Profile photo saved.', 'success');
      await rerenderOnboarding();
    } catch (err) {
      toast(String(err.message || err), 'error', 7000);
    }
  }

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handlePhoto(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handlePhoto(fileInput.files[0]);
  });

  const card = el('div', { class: 'card' },
    el('div', { style: 'display:flex; align-items:center; gap:12px;' },
      el('h2', { style: 'margin:0;' }, 'Profile photo'),
      el('span', { class: 'spacer' }),
      stored ? el('span', { class: 'badge ok' }, 'Uploaded') : null,
    ),
    el('p', { class: 'muted' },
      'Optional headshot for your profile. Stored only in your browser.'),
    el('div', { class: 'photo-upload-row' }, preview, zone),
    statusEl,
  );

  return card;
}

// ---------- Upload ----------

function uploadCard(root, title) {
  const fileInput = el('input', { type: 'file', accept: '.pdf,.docx,.txt,.md' });
  const statusEl = el('p', { class: 'muted' });

  const zone = el('div', { class: 'dropzone' },
    el('div', { style: 'font-size:34px;' }, '📄'),
    el('p', {}, title),
    el('p', { class: 'muted' }, 'PDF, DOCX or plain text. Parsed locally in your browser.'),
    fileInput,
  );

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    try {
      statusEl.innerHTML = '<span class="spinner"></span> Extracting text…';
      const text = await extractText(file);
      if (!text || text.trim().length < 100) {
        throw new Error('Could not extract meaningful text from this file. Is it a scanned image? Try a text-based PDF or DOCX.');
      }
      // Keep the raw file + text for later (tailoring, re-parsing).
      await idb.set('files', 'cv-original', { name: file.name, type: file.type, blob: file, text, savedAt: new Date().toISOString() });

      statusEl.innerHTML = '<span class="spinner"></span> Building draft profile with your LLM… (10–30s)';
      const prompt = await fillPrompt('parse-cv', { CV_TEXT: text.slice(0, 40000) });
      const profile = await chatJSON([{ role: 'user', content: prompt }], { temperature: 0.2 });
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error('LLM returned an invalid profile structure. Try again.');
      }

      saveProfile(profile);
      ls.set(KEYS.PROFILE_META, { completeness: 35, interviewDone: false, updatedAt: new Date().toISOString() });
      toast('Draft profile created. Review it, then run the interview.', 'success', 6000);
      const appEl = document.getElementById('app');
      appEl.innerHTML = '';
      await renderOnboarding(appEl);
    } catch (err) {
      console.error(err);
      statusEl.textContent = '';
      const msg = err?.name === 'NotFoundError'
        ? 'Browser storage is in a bad state. Open Settings → Danger zone → wipe data, reload, and try again.'
        : String(err.message || err);
      toast(msg, 'error', 8000);
    }
  }

  return el('div', { class: 'card' }, zone, statusEl);
}

// ---------- Text extraction ----------

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractPdf(file);
  if (name.endsWith('.docx')) return extractDocx(file);
  return file.text(); // txt / md fallback
}

async function extractPdf(file) {
  const pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(' '));
  }
  return pages.join('\n\n');
}

async function extractDocx(file) {
  if (!window.mammoth) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load mammoth.js from CDN'));
      document.head.append(s);
    });
  }
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

// ---------- Profile editor ----------

async function renderEditor(root, profile) {
  const meta = ls.get(KEYS.PROFILE_META, {});
  const completeness = meta.completeness ?? 35;
  const textarea = el('textarea', { spellcheck: 'false' });
  textarea.value = JSON.stringify(profile, null, 2);

  const saveBtn = el('button', { class: 'btn' }, 'Save profile');
  saveBtn.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(textarea.value);
      saveProfile(parsed);
      toast('Profile saved.', 'success');
    } catch (err) {
      toast('Invalid JSON: ' + err.message, 'error', 7000);
    }
  });

  const nextStep = meta.interviewDone
    ? el('p', { class: 'muted' }, '✅ Interview completed. You can re-run it anytime to dig deeper.')
    : el('p', { class: 'muted' }, '👉 Next step: ', el('a', { href: '#/interview' }, 'run the adaptive interview'), ' to unlock hidden expertise.');

  root.append(
    el('div', { class: 'card' },
      el('div', { style: 'display:flex; align-items:center; gap:12px;' },
        el('h2', { style: 'margin:0;' }, 'Master profile'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted' }, `Completeness ~${completeness}%`),
      ),
      el('div', { class: 'progress-wrap' }, el('div', { class: 'progress-bar', style: `width:${completeness}%` })),
      nextStep,
      el('div', { class: 'profile-editor' }, textarea),
      el('div', { style: 'display:flex; gap:10px; margin-top:12px;' }, saveBtn),
    ),
  );

  renderImportExport(root, profile);
}

function renderImportExport(root, profile) {
  const importInput = el('input', { type: 'file', accept: '.json', style: 'display:none' });
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      saveProfile(parsed);
      toast('Profile imported.', 'success');
      const appEl = document.getElementById('app');
      appEl.innerHTML = '';
      await renderOnboarding(appEl);
    } catch (err) {
      toast('Import failed: ' + err.message, 'error', 7000);
    }
  });

  root.append(
    el('div', { class: 'card' },
      el('h3', { style: 'margin-top:0;' }, 'Export / import'),
      el('p', { class: 'muted' }, 'Your profile is a single JSON file. Export it as a backup or to move to another device.'),
      el('div', { style: 'display:flex; gap:10px;' },
        el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => {
            const p = getProfile();
            if (!p) return toast('No profile to export yet.', 'error');
            const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
            const a = el('a', { href: URL.createObjectURL(blob), download: 'jobradar-profile.json' });
            a.click();
            URL.revokeObjectURL(a.href);
          },
        }, '⬇ Export JSON'),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => importInput.click() }, '⬆ Import JSON'),
        importInput,
      ),
    ),
  );
}
