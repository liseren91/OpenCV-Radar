// providers/index.js — unified LLM interface.
// chat(messages, opts?) routes to the provider chosen in settings.
// Adding a provider = add an adapter file with {chat, testKey, MODELS} and register it here.

import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import { getSettings, getActiveModel } from '../storage.js';

const ADAPTERS = { openai, anthropic };

export const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys' },
];

export function modelsFor(providerId) {
  return ADAPTERS[providerId]?.MODELS ?? [];
}

/**
 * Unified chat call using current settings.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{temperature?: number, maxTokens?: number, json?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export async function chat(messages, opts = {}) {
  const s = getSettings();
  if (!s.provider) throw new Error('No LLM provider configured. Open Settings and add your API key.');
  const apiKey = s.apiKeys?.[s.provider];
  if (!apiKey) throw new Error(`No API key saved for ${s.provider}. Open Settings.`);
  const adapter = ADAPTERS[s.provider];
  if (!adapter) throw new Error(`Unknown provider: ${s.provider}`);

  return adapter.chat(messages, {
    apiKey,
    model: opts.model || getActiveModel(),
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    json: opts.json,
  });
}

/**
 * Chat that must return JSON. Parses the reply, tolerating ```json fences.
 * @returns {Promise<any>}
 */
export async function chatJSON(messages, opts = {}) {
  const text = await chat(messages, { ...opts, json: true });
  return parseLooseJSON(text);
}

export function parseLooseJSON(text) {
  let t = text.trim();
  // Strip markdown fences if the model added them.
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  // Last resort: grab the outermost {...} or [...]
  try {
    return JSON.parse(t);
  } catch {
    const start = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (start !== Infinity && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error('LLM did not return valid JSON:\n' + text.slice(0, 300));
  }
}

export async function testKey(providerId, apiKey) {
  const adapter = ADAPTERS[providerId];
  if (!adapter) throw new Error(`Unknown provider: ${providerId}`);
  return adapter.testKey(apiKey);
}
