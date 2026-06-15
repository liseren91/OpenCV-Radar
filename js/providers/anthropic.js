// Anthropic adapter. Direct browser calls require the explicit opt-in header
// `anthropic-dangerous-direct-browser-access: true`. This is acceptable here
// because the key belongs to the user and lives only in their own browser —
// there is no server in between to protect it from.

const CHAT_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const API_VERSION = '2023-06-01';

export const DEFAULT_MODEL = 'claude-3-5-haiku-latest';

// Hints for known model families. Anything else shows up under its raw id /
// display_name so the catalog stays forward-compatible.
const HINTS = {
  'claude-3-5-haiku-latest': 'cheap, recommended',
  'claude-haiku-4-5': 'cheap',
  'claude-sonnet-4-5': 'stronger, pricier',
  'claude-opus-4-5': 'top-tier, expensive',
};

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {{apiKey: string, model: string, temperature?: number, maxTokens?: number, json?: boolean}} opts
 * @returns {Promise<string>} assistant text
 */
export async function chat(messages, opts) {
  // Anthropic takes the system prompt as a separate top-level field.
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.4,
    messages: rest,
  };
  if (system) body.system = system;
  // Anthropic has no response_format; JSON discipline is enforced via prompt.

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await safeError(res);
    throw new Error(`Anthropic error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * List models the key has access to. /v1/models returns a paginated list of
 * { id, display_name, created_at, type:'model' } entries; we ask for the max
 * page size and skip pagination — there are only a handful of Claude families.
 * @returns {Promise<Array<{id: string, label: string}>>}
 */
export async function listModels(apiKey) {
  const res = await fetch(`${MODELS_URL}?limit=1000`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  if (!res.ok) {
    const detail = await safeError(res);
    throw new Error(`Anthropic key check failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return (data.data || [])
    .filter((m) => m.type === 'model')
    .map((m) => {
      const base = m.display_name || m.id;
      const hint = HINTS[m.id];
      return { id: m.id, label: hint ? `${base} — ${hint}` : base };
    })
    .sort((a, b) => {
      const ra = HINTS[a.id] ? 0 : 1;
      const rb = HINTS[b.id] ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.id.localeCompare(a.id);
    });
}

// Cheap probe: hitting /v1/models is free and validates the key.
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
