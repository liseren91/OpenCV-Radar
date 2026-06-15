// OpenAI adapter. Direct browser calls — OpenAI serves CORS headers.
// The user's key is read from settings at call time and never leaves the browser
// except to api.openai.com itself.

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MODELS_URL = 'https://api.openai.com/v1/models';

// Safe fallback when no model has been picked yet (e.g. on first run, or imported
// settings from another machine). The settings screen lets the user pick anything
// their key gives access to.
export const DEFAULT_MODEL = 'gpt-4o-mini';

// Small dictionary of human hints for known model ids. Anything not listed here
// just shows up under its raw id — that keeps us forward-compatible with new
// OpenAI releases without code changes.
const HINTS = {
  'gpt-4o-mini': 'cheap, recommended',
  'gpt-4.1-mini': 'cheap',
  'gpt-4.1-nano': 'cheap',
  'gpt-4o': 'stronger, pricier',
  'gpt-4.1': 'stronger, pricier',
};

// /v1/models returns the full catalog the key has access to — including
// embeddings, audio, image, moderation etc. Filter to chat-completion families.
const INCLUDE_RE = /^(gpt-|o1|o3|o4|chatgpt-)/i;
const EXCLUDE_RE = /(embedding|audio|tts|whisper|realtime|search|transcribe|moderation|image|dall-e|davinci|babbage|instruct)/i;

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {{apiKey: string, model: string, temperature?: number, maxTokens?: number, json?: boolean}} opts
 * @returns {Promise<string>} assistant text
 */
export async function chat(messages, opts) {
  const body = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await safeError(res);
    throw new Error(`OpenAI error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Ask the provider what this key can actually use.
 * Doubles as a key-validity check: a successful list = the key works.
 * @returns {Promise<Array<{id: string, label: string}>>}
 */
export async function listModels(apiKey) {
  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    const detail = await safeError(res);
    throw new Error(`OpenAI key check failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return (data.data || [])
    .filter((m) => INCLUDE_RE.test(m.id) && !EXCLUDE_RE.test(m.id))
    .map((m) => ({
      id: m.id,
      label: HINTS[m.id] ? `${m.id} (${HINTS[m.id]})` : m.id,
    }))
    .sort((a, b) => {
      // Known/recommended models float to the top; otherwise newest id first.
      const ra = HINTS[a.id] ? 0 : 1;
      const rb = HINTS[b.id] ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.id.localeCompare(a.id);
    });
}

export async function testKey(apiKey) {
  await listModels(apiKey);
  return true;
}

async function safeError(res) {
  try {
    const j = await res.json();
    return j.error?.message || JSON.stringify(j).slice(0, 200);
  } catch {
    return res.statusText;
  }
}
