#!/usr/bin/env node
// fetch-jobs.mjs — collects fresh jobs from all source adapters,
// normalizes, dedupes, filters by freshness and writes data/jobs.json.
// Zero npm dependencies; runs on Node 18+ (global fetch).
//
// Usage:
//   node scripts/fetch-jobs.mjs                # all sources
//   node scripts/fetch-jobs.mjs remotive hh    # only listed sources
//
// Adzuna needs ADZUNA_APP_ID / ADZUNA_APP_KEY env vars (GitHub Secrets in CI);
// sources with missing env are skipped with a notice, never a failure.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as remotive from './sources/remotive.mjs';
import * as adzuna from './sources/adzuna.mjs';
import * as hh from './sources/hh.mjs';

const SOURCES = [remotive, adzuna, hh];

// ---------- Config (tune via env or edit here) ----------

const CONFIG = {
  // Search queries — aimed at the initial audience (PM / MarTech / AI, Remote/Belgrade/EU).
  // Contributors: extend freely; each query hits each source once.
  queries: (process.env.JOB_QUERIES || 'product manager,project manager,marketing technology,AI,data analyst,software engineer')
    .split(',').map((q) => q.trim()).filter(Boolean),
  freshDays: Number(process.env.JOB_FRESH_DAYS || 14), // drop jobs older than this
  maxJobs: Number(process.env.JOB_MAX || 1500),        // hard cap on output size
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'data', 'jobs.json');

// ---------- Main ----------

async function main() {
  const only = process.argv.slice(2); // optional source filter
  const active = SOURCES.filter((s) => !only.length || only.includes(s.name));

  console.log(`Job Radar fetch — sources: ${active.map((s) => s.name).join(', ')}`);
  console.log(`Queries: ${CONFIG.queries.join(' | ')}`);

  const all = [];
  const stats = {};

  for (const source of active) {
    // Skip sources whose required env vars are missing (e.g. Adzuna keys not set up yet).
    const missing = (source.requiresEnv || []).filter((v) => !process.env[v]);
    if (missing.length) {
      console.log(`- ${source.name}: SKIPPED (missing env: ${missing.join(', ')})`);
      stats[source.name] = { fetched: 0, skipped: true };
      continue;
    }

    try {
      const t0 = Date.now();
      const jobs = await source.fetchJobs(CONFIG);
      all.push(...jobs);
      stats[source.name] = { fetched: jobs.length, ms: Date.now() - t0 };
      console.log(`- ${source.name}: ${jobs.length} jobs (${Date.now() - t0}ms)`);
    } catch (err) {
      // One broken source must never break the daily update.
      stats[source.name] = { fetched: 0, error: String(err.message || err) };
      console.error(`- ${source.name}: FAILED — ${err.message}`);
    }
  }

  // ---------- Normalize / filter / dedupe ----------

  const fresh = all.filter((j) => withinDays(j.posted_at, CONFIG.freshDays));

  // Dedupe across sources: same company + similar title → keep the one with salary/earlier source order.
  const deduped = dedupe(fresh);

  // Newest first, cap size.
  deduped.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
  const final = deduped.slice(0, CONFIG.maxJobs);

  // ---------- Merge with previous file to keep ids stable across days ----------
  // (Jobs that disappeared from sources but are still fresh stay one more cycle.)
  let previous = [];
  try {
    const prev = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    previous = Array.isArray(prev) ? prev : prev.jobs || [];
  } catch { /* first run */ }

  const finalIds = new Set(final.map((j) => j.id));
  const carryOver = previous.filter((j) => !finalIds.has(j.id) && withinDays(j.posted_at, CONFIG.freshDays));
  const merged = [...final, ...carryOver].slice(0, CONFIG.maxJobs);

  // ---------- Write ----------

  const payload = {
    updated_at: new Date().toISOString(),
    count: merged.length,
    sources: stats,
    jobs: merged,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 1), 'utf8');
  console.log(`\nWrote ${merged.length} jobs (${final.length} fresh + ${carryOver.length} carried over) → ${OUT_FILE}`);
}

function withinDays(dateOnly, days) {
  if (!dateOnly) return true;
  const age = (Date.now() - new Date(dateOnly).getTime()) / 86400000;
  return age <= days;
}

function dedupe(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = `${normalize(job.company)}|${normalize(job.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, job);
    } else if (!existing.salary && job.salary) {
      // Prefer the duplicate that carries salary data.
      byKey.set(key, { ...job, tags: mergeTags(existing.tags, job.tags) });
    } else {
      existing.tags = mergeTags(existing.tags, job.tags);
    }
  }
  return [...byKey.values()];
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

function mergeTags(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
