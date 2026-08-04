// Boolean query language for Job Radar (browser twin of selfhost/worker/query.py
// and scripts/sources/query.mjs). Keep the three implementations in sync.
//
// Grammar: expr := orExpr; orExpr := andExpr (OR andExpr)*;
// andExpr := unary (AND? unary)*; unary := NOT? primary;
// primary := "(" expr ")" | term; term := [field ":"] (phrase | word)
// Fields: title (default), company, desc, tag, loc, any.

const FIELDS = new Set(['title', 'company', 'desc', 'tag', 'loc', 'any']);
const OPS = new Set(['AND', 'OR', 'NOT']);

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

/** @returns {[string, string][]} tokens as [kind, value] */
export function tokenize(s) {
  s = String(s || '').trim();
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push(['LPAREN', '(']); i++; continue; }
    if (c === ')') { tokens.push(['RPAREN', ')']); i++; continue; }
    if ((c === '-' || c === '!') && i + 1 < n && !/\s/.test(s[i + 1])) {
      tokens.push(['OP', 'NOT']); i++; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j++;
      tokens.push(['PHRASE', s.slice(i + 1, j)]);
      i = j < n ? j + 1 : n;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(s[j]) && s[j] !== '(' && s[j] !== ')') {
      if (s[j] === '"' && s.slice(i, j).includes(':')) break;
      j++;
    }
    const raw = s.slice(i, j);
    if (raw.includes(':')) {
      const colon = raw.indexOf(':');
      const field = raw.slice(0, colon).toLowerCase();
      const rest = raw.slice(colon + 1);
      if (FIELDS.has(field)) {
        tokens.push(['FIELD', field]);
        while (j < n && /\s/.test(s[j])) j++;
        if (rest.startsWith('"')) {
          let k = 1;
          while (k < rest.length && rest[k] !== '"') k++;
          tokens.push(['PHRASE', rest.slice(1, k)]);
          i = j;
          continue;
        }
        if (j < n && s[j] === '"') {
          let k = j + 1;
          while (k < n && s[k] !== '"') k++;
          tokens.push(['PHRASE', s.slice(j + 1, k)]);
          i = k < n ? k + 1 : n;
          continue;
        }
        if (rest) {
          tokens.push(['WORD', rest]);
          i = j;
          continue;
        }
        i = j;
        continue;
      }
    }
    const upper = raw.toUpperCase();
    if (OPS.has(upper)) tokens.push(['OP', upper]);
    else tokens.push(['WORD', raw]);
    i = j;
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.pos < this.tokens.length ? this.tokens[this.pos] : null; }
  take() { const t = this.peek(); if (t) this.pos++; return t; }

  parse() {
    if (!this.tokens.length) return { type: 'AND', children: [] };
    const node = this._or();
    if (this.peek()) throw new ParseError(`Unexpected token: ${JSON.stringify(this.peek())}`);
    return node;
  }

  _or() {
    const kids = [this._and()];
    while (this.peek() && this.peek()[0] === 'OP' && this.peek()[1] === 'OR') {
      this.take();
      kids.push(this._and());
    }
    return kids.length === 1 ? kids[0] : { type: 'OR', children: kids };
  }

  _and() {
    const kids = [this._unary()];
    while (true) {
      const p = this.peek();
      if (!p || (p[0] === 'OP' && p[1] === 'OR') || p[0] === 'RPAREN') break;
      if (p[0] === 'OP' && p[1] === 'AND') this.take();
      kids.push(this._unary());
    }
    return kids.length === 1 ? kids[0] : { type: 'AND', children: kids };
  }

  _unary() {
    if (this.peek() && this.peek()[0] === 'OP' && this.peek()[1] === 'NOT') {
      this.take();
      return { type: 'NOT', child: this._primary() };
    }
    return this._primary();
  }

  _primary() {
    const p = this.peek();
    if (!p) throw new ParseError('Unexpected end of query');
    if (p[0] === 'LPAREN') {
      this.take();
      const node = this._or();
      if (!this.peek() || this.peek()[0] !== 'RPAREN') throw new ParseError('Missing closing parenthesis');
      this.take();
      return node;
    }
    return this._term();
  }

  _term() {
    let field = 'title';
    let p = this.peek();
    if (!p) throw new ParseError('Expected term');
    if (p[0] === 'FIELD') {
      field = this.take()[1];
      p = this.peek();
      if (!p || (p[0] !== 'WORD' && p[0] !== 'PHRASE')) {
        throw new ParseError(`Expected value after ${field}:`);
      }
    }
    if (p[0] === 'PHRASE') {
      this.take();
      return { type: 'TERM', field, value: p[1], phrase: true };
    }
    if (p[0] === 'WORD') {
      this.take();
      return { type: 'TERM', field, value: p[1], phrase: false };
    }
    throw new ParseError(`Expected term, got ${JSON.stringify(p)}`);
  }
}

export function parseQuery(s) {
  return new Parser(tokenize(s)).parse();
}

export function tryParseQuery(s) {
  try {
    return { ast: parseQuery(s), error: null };
  } catch (err) {
    return { ast: null, error: String(err.message || err) };
  }
}

function fieldText(job, field) {
  if (field === 'title') return String(job?.title || '');
  if (field === 'company') return String(job?.company || '');
  if (field === 'desc') return String(job?.description || '');
  if (field === 'tag') return (job?.tags || []).map(String).join(' ');
  if (field === 'loc') return String(job?.location || '');
  return [
    job?.title, job?.company, job?.location,
    ...(job?.tags || []), job?.description,
  ].map((x) => String(x || '')).join(' ');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeWord(haystack, word) {
  if (!word) return true;
  return new RegExp(`(^|[^a-zа-яё0-9])${escapeRe(word)}([^a-zа-яё0-9]|$)`, 'i').test(haystack);
}

function termMatches(node, job) {
  const text = fieldText(job, node.field || 'title');
  const value = node.value || '';
  if (node.phrase) return text.toLowerCase().includes(value.toLowerCase());
  return wholeWord(text, value);
}

export function matchesQuery(ast, job) {
  if (!ast) return true;
  const t = ast.type;
  if (t === 'AND') {
    const kids = ast.children || [];
    return kids.length ? kids.every((c) => matchesQuery(c, job)) : true;
  }
  if (t === 'OR') {
    const kids = ast.children || [];
    return kids.length ? kids.some((c) => matchesQuery(c, job)) : true;
  }
  if (t === 'NOT') return !matchesQuery(ast.child || {}, job);
  if (t === 'TERM') return termMatches(ast, job);
  return true;
}

/** Legacy whole-word AND-within-query / OR-across-queries (title only). */
export function titleMatchesQueries(title, queries) {
  const t = String(title || '').toLowerCase();
  return (queries || []).some((q) => {
    const words = String(q).toLowerCase().split(/[^a-zа-яё0-9+#.]+/).filter((w) => w.length >= 2);
    return words.length > 0 &&
      words.every((w) => new RegExp(`(^|[^a-zа-яё0-9])${escapeRe(w)}([^a-zа-яё0-9]|$)`, 'i').test(t));
  });
}

function isPlainLegacy(q) {
  if (/["()]/.test(q)) return false;
  for (const [kind, val] of tokenize(q)) {
    if (kind === 'OP' || kind === 'LPAREN' || kind === 'RPAREN' || kind === 'FIELD' || kind === 'PHRASE') return false;
    if (kind === 'WORD' && OPS.has(val.toUpperCase())) return false;
  }
  return true;
}

export function matchesAnyQuery(job, queryStrings) {
  if (!queryStrings?.length) return true;
  for (const q of queryStrings) {
    const { ast, error } = tryParseQuery(q);
    if (error || !ast) {
      if (titleMatchesQueries(job?.title || '', [q])) return true;
      continue;
    }
    if (matchesQuery(ast, job)) return true;
  }
  return false;
}

export function jobMatchesQueries(job, queryStrings, { titleOnlyCompat = false } = {}) {
  if (!queryStrings?.length) return true;
  if (titleOnlyCompat && queryStrings.every(isPlainLegacy)) {
    return titleMatchesQueries(job?.title || '', queryStrings);
  }
  return matchesAnyQuery(job, queryStrings);
}

function collectPositiveTitlePhrases(ast) {
  const t = ast?.type;
  if (t === 'OR') {
    const out = [];
    for (const c of ast.children || []) out.push(...collectPositiveTitlePhrases(c));
    return out.length ? out : [[]];
  }
  if (t === 'AND') {
    let groups = [[]];
    for (const c of ast.children || []) {
      if (c.type === 'NOT') continue;
      const childGroups = collectPositiveTitlePhrases(c);
      if (!childGroups.length || (childGroups.length === 1 && !childGroups[0].length)) continue;
      const next = [];
      for (const g of groups) for (const cg of childGroups) next.push([...g, ...cg]);
      groups = next;
    }
    return groups;
  }
  if (t === 'NOT') return [[]];
  if (t === 'TERM') {
    const field = ast.field || 'title';
    const val = String(ast.value || '').trim();
    return val ? [[val]] : [[]];
  }
  return [[]];
}

export function expandToApiTerms(ast) {
  const groups = collectPositiveTitlePhrases(ast);
  const terms = [];
  const seen = new Set();
  for (const g of groups) {
    const words = g.filter(Boolean);
    if (!words.length) continue;
    const term = words.join(' ');
    const key = term.toLowerCase();
    if (!seen.has(key)) { seen.add(key); terms.push(term); }
  }
  return terms;
}

export function queriesToApiTerms(queryStrings) {
  const terms = [];
  const seen = new Set();
  for (const q of queryStrings || []) {
    const { ast, error } = tryParseQuery(q);
    if (error || !ast) {
      const key = q.toLowerCase().trim();
      if (key && !seen.has(key)) { seen.add(key); terms.push(q.trim()); }
      continue;
    }
    for (const t of expandToApiTerms(ast)) {
      const key = t.toLowerCase();
      if (!seen.has(key)) { seen.add(key); terms.push(t); }
    }
  }
  return terms;
}
