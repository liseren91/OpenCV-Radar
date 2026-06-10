// OpenAI adapter. Direct browser calls — OpenAI serves CORS headers.
// The user's key is read from settings at call time and never leaves the browser
// except to api.openai.com itself.

const API_URL = 'https://api.openai.com/v1/chat/completions';

export const MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (cheap, recommended)' },
  { id: 'gpt-4o', label: 'GPT-4o (stronger, pricier)' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { id: 'gpt-4.1', label: 'GPT-4.1' },
];

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

  const res = await fetch(API_URL, {
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

export async function testKey(apiKey) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
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
