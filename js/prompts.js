// prompts.js — loads editable prompt templates from /prompts/*.md
// and fills {{PLACEHOLDERS}}. Contributors can improve prompts without touching code.

const cache = new Map();

export async function loadPrompt(name) {
  if (cache.has(name)) return cache.get(name);
  const res = await fetch(`prompts/${name}.md`);
  if (!res.ok) throw new Error(`Failed to load prompt "${name}" (${res.status})`);
  const text = await res.text();
  cache.set(name, text);
  return text;
}

export async function fillPrompt(name, vars = {}) {
  let text = await loadPrompt(name);
  for (const [key, value] of Object.entries(vars)) {
    text = text.split(`{{${key}}}`).join(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  return text;
}
