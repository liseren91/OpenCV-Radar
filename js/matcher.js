// matcher.js — ranks jobs.json against the master profile.
// Two stages to keep the user's token bill low:
//   1. Free local prefilter: hard excludes + cheap keyword affinity → top candidates.
//   2. LLM scoring in batches: score 0–100 + "why it fits", cached per (job, profile) hash.

import { chatJSON } from './providers/index.js';
import { fillPrompt } from './prompts.js';
import { getCachedMatch, setCachedMatch, tinyHash } from './storage.js';

const LLM_BATCH_SIZE = 8;       // jobs per LLM call
const MAX_LLM_JOBS = 40;        // cap LLM-scored jobs per run (cost control)
const DESCRIPTION_SNIPPET = 1200; // chars of description sent to the LLM per job

// ---------- Stage 1: local prefilter ----------

/**
 * Cheap, free, local scoring. Returns jobs sorted by affinity with hard-excluded ones dropped.
 */
export function prefilter(jobs, profile) {
  const focus = (profile.preferences?.focus || []).map(norm);
  const exclude = (profile.preferences?.exclude || []).map(norm);
  const roles = (profile.headline_roles || []).map(norm);
  const skills = collectKeywords(profile);
  const locations = (profile.basics?.locations || []).map(norm);

  const scored = [];
  for (const job of jobs) {
    const haystack = norm(`${job.title} ${job.company} ${job.location} ${(job.tags || []).join(' ')} ${(job.description || '').slice(0, 2000)}`);

    // Hard excludes: any exclude term present → drop.
    if (exclude.some((x) => x && haystack.includes(x))) continue;

    let score = 0;
    for (const r of roles) if (r && haystack.includes(r)) score += 6;
    for (const f of focus) if (f && haystack.includes(f)) score += 4;
    for (const s of skills) if (s && haystack.includes(s)) score += 1;

    // Location affinity: remote always OK if user wants remote; otherwise match location terms.
    const wantsRemote = locations.some((l) => l.includes('remote'));
    if (job.remote && wantsRemote) score += 3;
    else if (locations.some((l) => l && norm(job.location || '').includes(l))) score += 3;

    // Freshness nudge.
    const ageDays = (Date.now() - new Date(job.posted_at || 0).getTime()) / 86400000;
    if (ageDays <= 2) score += 2;
    else if (ageDays <= 7) score += 1;

    scored.push({ job, localScore: score });
  }

  scored.sort((a, b) => b.localScore - a.localScore);
  return scored;
}

function norm(s) {
  return String(s || '').toLowerCase();
}

function collectKeywords(profile) {
  const set = new Set();
  for (const s of profile.skills || []) set.add(norm(s));
  for (const e of profile.experience || []) {
    for (const d of e.domains || []) set.add(norm(d));
    for (const t of e.tools || []) set.add(norm(t));
  }
  return [...set].filter((k) => k.length > 2);
}

// ---------- Stage 2: LLM scoring ----------

/**
 * Scores top prefiltered jobs with the LLM, using a per-(job, profile) cache.
 * @param {Array} jobs - raw jobs array
 * @param {Object} profile - master profile
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<Array<{job, score, why, llm: boolean}>>} sorted by score desc
 */
export async function matchJobs(jobs, profile, onProgress) {
  const pre = prefilter(jobs, profile);
  const candidates = pre.slice(0, MAX_LLM_JOBS);
  const rest = pre.slice(MAX_LLM_JOBS);

  const profileHash = tinyHash(JSON.stringify(profile));
  const results = [];
  const uncached = [];

  // Cache lookup first.
  for (const { job } of candidates) {
    const key = `${profileHash}:${job.id}`;
    const cached = await getCachedMatch(key);
    if (cached) results.push({ job, score: cached.score, why: cached.why, llm: true });
    else uncached.push(job);
  }

  // Batch the uncached ones.
  let done = candidates.length - uncached.length;
  const total = candidates.length;
  onProgress?.(done, total);

  for (let i = 0; i < uncached.length; i += LLM_BATCH_SIZE) {
    const batch = uncached.slice(i, i + LLM_BATCH_SIZE);
    const compact = batch.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      remote: j.remote,
      salary: j.salary || null,
      tags: j.tags || [],
      description: (j.description || '').slice(0, DESCRIPTION_SNIPPET),
    }));

    const prompt = await fillPrompt('match', { PROFILE: profile, JOBS: compact });
    let parsed;
    try {
      parsed = await chatJSON([{ role: 'user', content: prompt }], { temperature: 0.2 });
    } catch (err) {
      // If one batch dies (rate limit etc.), surface the rest unscored rather than failing the page.
      console.error('Match batch failed:', err);
      for (const job of batch) results.push({ job, score: null, why: 'Scoring failed — retry later.', llm: false });
      done += batch.length;
      onProgress?.(done, total);
      continue;
    }

    const byId = new Map((parsed.results || []).map((r) => [String(r.id), r]));
    for (const job of batch) {
      const r = byId.get(String(job.id));
      const score = r ? Math.max(0, Math.min(100, Math.round(r.score))) : null;
      const why = r?.why || '';
      results.push({ job, score, why, llm: !!r });
      if (r) await setCachedMatch(`${profileHash}:${job.id}`, { score, why });
    }
    done += batch.length;
    onProgress?.(done, total);
  }

  // Unscored long tail keeps its local ordering below LLM-scored ones.
  for (const { job, localScore } of rest) {
    results.push({ job, score: null, why: '', llm: false, localScore });
  }

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.localScore ?? 0) - (a.localScore ?? 0));
  return results;
}
