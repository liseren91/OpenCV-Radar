// Anthropic adapter. Direct browser calls require the explicit opt-in header
// `anthropic-dangerous-direct-browser-access: true`. This is acceptable here
// because the key belongs to the user and lives only in their own browser —
// there is no server in between to protect it from.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODELS = [
  { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (cheap, recommended)' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (stronger, pricier)' },
];

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

  const res = await fetch(API_URL, {
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

export async function testKey(apiKey) {
  // Cheapest possible probe: 1-token request to the smallest model.
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (!res.ok) {
    const detail = await safeError(res);
    throw new Error(`Key check failed (${res.status}): ${detail}`);
  }
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
