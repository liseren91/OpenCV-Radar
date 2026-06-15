// storage.js — thin wrappers around localStorage (small data: profile, settings, key)
// and IndexedDB (large data: CV files, match cache, application history).
// Everything stays in the user's browser. Nothing is ever sent to any server of ours.

const LS_PREFIX = 'jobradar:';

// ---------- localStorage ----------

export const ls = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(LS_PREFIX + key);
  },
};

// Well-known keys
export const KEYS = {
  SETTINGS: 'settings',          // { provider, model, apiKeys: {openai, anthropic} }
  PROFILE: 'profile',            // master profile JSON
  PROFILE_META: 'profileMeta',   // { completeness, interviewDone, updatedAt }
  SEEN_JOBS: 'seenJobs',         // { ids: [...], lastVisit: iso }
  INTERVIEW_STATE: 'interviewState', // resumable interview state
  PERSONAL_JOBS: 'personalJobs', // { fetchedAt, queries, jobs } — browser-side personal fetch cache
};

// ---------- Settings helpers ----------

export function getSettings() {
  return ls.get(KEYS.SETTINGS, {
    provider: null, // 'openai' | 'anthropic' — user picks in Settings
    model: null,    // dynamic: fetched from the provider with the user's key
    apiKeys: {},
  });
}

export function saveSettings(settings) {
  ls.set(KEYS.SETTINGS, settings);
}

export function getActiveKey() {
  const s = getSettings();
  return s.provider ? (s.apiKeys?.[s.provider] || null) : null;
}

// Returns the user-chosen model id, or null if none has been picked yet.
// The provider layer falls back to its DEFAULT_MODEL if this is null.
export function getActiveModel() {
  return getSettings().model || null;
}

export function deleteAllKeys() {
  const s = getSettings();
  s.apiKeys = {};
  saveSettings(s);
}

// ---------- Profile helpers ----------

export function getProfile() {
  return ls.get(KEYS.PROFILE, null);
}

export function saveProfile(profile) {
  ls.set(KEYS.PROFILE, profile);
  const meta = ls.get(KEYS.PROFILE_META, {});
  meta.updatedAt = new Date().toISOString();
  ls.set(KEYS.PROFILE_META, meta);
}

// ---------- IndexedDB ----------

const DB_NAME = 'jobradar';
// v2: repair empty v1 databases (stores missing → CV upload failed with NotFoundError).
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');        // raw CV files
      if (!db.objectStoreNames.contains('matchCache')) db.createObjectStore('matchCache'); // LLM match results
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history');    // tailored CVs / applications
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbOp(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    const req = fn(os);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const idb = {
  get: (store, key) => idbOp(store, 'readonly', (os) => os.get(key)),
  set: (store, key, value) => idbOp(store, 'readwrite', (os) => os.put(value, key)),
  remove: (store, key) => idbOp(store, 'readwrite', (os) => os.delete(key)),
  clear: (store) => idbOp(store, 'readwrite', (os) => os.clear()),
  keys: (store) => idbOp(store, 'readonly', (os) => os.getAllKeys()),
};

// ---------- Match cache ----------

export async function getCachedMatch(hash) {
  try { return await idb.get('matchCache', hash); } catch { return null; }
}

export async function setCachedMatch(hash, result) {
  try { await idb.set('matchCache', hash, result); } catch { /* cache is best-effort */ }
}

// Stable tiny hash for cache keys (not cryptographic).
export function tinyHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- Danger zone ----------

export async function wipeEverything() {
  Object.values(KEYS).forEach((k) => ls.remove(k));
  try {
    await Promise.all(['files', 'matchCache', 'history'].map((s) => idb.clear(s)));
  } catch { /* best effort */ }
}
