"""Boolean query language for Job Radar.

Grammar (recursive descent):
  expr    := orExpr
  orExpr  := andExpr (OR andExpr)*
  andExpr := unary (AND? unary)*     # implicit AND between terms
  unary   := NOT? primary            # NOT | - | !
  primary := "(" expr ")" | term
  term    := [field ":"] (phrase | word)

Fields: title (default), company, desc, tag, loc, any.

Examples:
  product manager
  "head of product"
  (product manager OR product owner) -sales
  title:"product manager" desc:AI -loc:"United States"
  company:stripe OR company:figma

Twin of scripts/sources/query.mjs and js/query.js — keep in sync.
"""

from __future__ import annotations

import re
from typing import Any

FIELDS = frozenset({"title", "company", "desc", "tag", "loc", "any"})
OPS = frozenset({"AND", "OR", "NOT"})


# ---------- Tokenizer ----------

def tokenize(s: str) -> list[tuple[str, str]]:
    """Return list of (kind, value) tokens. Kinds: OP, LPAREN, RPAREN, PHRASE, WORD, FIELD."""
    s = (s or "").strip()
    tokens: list[tuple[str, str]] = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c.isspace():
            i += 1
            continue
        if c == "(":
            tokens.append(("LPAREN", "(")); i += 1; continue
        if c == ")":
            tokens.append(("RPAREN", ")")); i += 1; continue
        if c in "-!" and i + 1 < n and not s[i + 1].isspace():
            # Prefix NOT: -sales / !"foo" / -company:x
            tokens.append(("OP", "NOT")); i += 1; continue
        if c == '"':
            j = i + 1
            while j < n and s[j] != '"':
                j += 1
            tokens.append(("PHRASE", s[i + 1:j]))
            i = j + 1 if j < n else n
            continue
        # Word / field:word / field:"phrase" / OR / AND / NOT
        j = i
        while j < n and not s[j].isspace() and s[j] not in "()":
            if s[j] == '"' and ":" in s[i:j]:
                break
            j += 1
        raw = s[i:j]
        # field:"phrase"
        if ":" in raw:
            field, _, rest = raw.partition(":")
            if field.lower() in FIELDS:
                tokens.append(("FIELD", field.lower()))
                # Skip whitespace between field: and value
                while j < n and s[j].isspace():
                    j += 1
                if rest.startswith('"'):
                    # field:"phrase" glued — shouldn't normally happen
                    k = 1
                    while k < len(rest) and rest[k] != '"':
                        k += 1
                    tokens.append(("PHRASE", rest[1:k]))
                    i = j
                    continue
                if j < n and s[j] == '"':
                    k = j + 1
                    while k < n and s[k] != '"':
                        k += 1
                    tokens.append(("PHRASE", s[j + 1:k]))
                    i = k + 1 if k < n else n
                    continue
                if rest:
                    tokens.append(("WORD", rest))
                    i = j
                    continue
                # field: with value as next token — leave i at j for next loop
                i = j
                continue
        upper = raw.upper()
        if upper in OPS:
            tokens.append(("OP", upper))
        else:
            tokens.append(("WORD", raw))
        i = j
    return tokens


# ---------- Parser ----------

class ParseError(ValueError):
    pass


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> tuple[str, str] | None:
        tok = self.peek()
        if tok:
            self.pos += 1
        return tok

    def parse(self) -> dict:
        if not self.tokens:
            return {"type": "AND", "children": []}
        node = self._or()
        if self.peek():
            raise ParseError(f"Unexpected token: {self.peek()!r}")
        return node

    def _or(self) -> dict:
        kids = [self._and()]
        while self.peek() and self.peek() == ("OP", "OR"):
            self.take()
            kids.append(self._and())
        return kids[0] if len(kids) == 1 else {"type": "OR", "children": kids}

    def _and(self) -> dict:
        kids = [self._unary()]
        while True:
            p = self.peek()
            if not p or p == ("OP", "OR") or p[0] == "RPAREN":
                break
            if p == ("OP", "AND"):
                self.take()
            kids.append(self._unary())
        return kids[0] if len(kids) == 1 else {"type": "AND", "children": kids}

    def _unary(self) -> dict:
        if self.peek() == ("OP", "NOT"):
            self.take()
            return {"type": "NOT", "child": self._primary()}
        return self._primary()

    def _primary(self) -> dict:
        p = self.peek()
        if not p:
            raise ParseError("Unexpected end of query")
        if p[0] == "LPAREN":
            self.take()
            node = self._or()
            if not self.peek() or self.peek()[0] != "RPAREN":
                raise ParseError("Missing closing parenthesis")
            self.take()
            return node
        return self._term()

    def _term(self) -> dict:
        field = "title"
        p = self.peek()
        if not p:
            raise ParseError("Expected term")
        if p[0] == "FIELD":
            field = self.take()[1]
            p = self.peek()
            if not p or p[0] not in ("WORD", "PHRASE"):
                raise ParseError(f"Expected value after {field}:")
        if p[0] == "PHRASE":
            self.take()
            return {"type": "TERM", "field": field, "value": p[1], "phrase": True}
        if p[0] == "WORD":
            self.take()
            return {"type": "TERM", "field": field, "value": p[1], "phrase": False}
        if p == ("OP", "AND") or p == ("OP", "OR"):
            raise ParseError(f"Unexpected operator {p[1]}")
        raise ParseError(f"Expected term, got {p!r}")


def parse_query(s: str) -> dict:
    """Parse a Boolean query string into an AST. Raises ParseError on bad syntax."""
    return _Parser(tokenize(s)).parse()


def try_parse_query(s: str) -> tuple[dict | None, str | None]:
    """Return (ast, None) or (None, error_message)."""
    try:
        return parse_query(s), None
    except ParseError as exc:
        return None, str(exc)


# ---------- Evaluation ----------

def _field_text(job: dict, field: str) -> str:
    if field == "title":
        return str(job.get("title") or "")
    if field == "company":
        return str(job.get("company") or "")
    if field == "desc":
        return str(job.get("description") or "")
    if field == "tag":
        return " ".join(str(t) for t in (job.get("tags") or []))
    if field == "loc":
        return str(job.get("location") or "")
    # any
    return " ".join([
        str(job.get("title") or ""),
        str(job.get("company") or ""),
        str(job.get("location") or ""),
        " ".join(str(t) for t in (job.get("tags") or [])),
        str(job.get("description") or ""),
    ])


def _whole_word(haystack: str, word: str) -> bool:
    if not word:
        return True
    return bool(re.search(
        rf"(^|[^a-zа-яё0-9]){re.escape(word)}([^a-zа-яё0-9]|$)",
        haystack,
        re.I,
    ))


def _term_matches(node: dict, job: dict) -> bool:
    text = _field_text(job, node.get("field") or "title")
    value = node.get("value") or ""
    if node.get("phrase"):
        return value.lower() in text.lower()
    return _whole_word(text, value)


def matches_query(ast: dict, job: dict) -> bool:
    """True if the job satisfies the Boolean AST."""
    if not ast:
        return True
    t = ast.get("type")
    if t == "AND":
        kids = ast.get("children") or []
        return all(matches_query(c, job) for c in kids) if kids else True
    if t == "OR":
        kids = ast.get("children") or []
        return any(matches_query(c, job) for c in kids) if kids else True
    if t == "NOT":
        return not matches_query(ast.get("child") or {}, job)
    if t == "TERM":
        return _term_matches(ast, job)
    return True


def matches_any_query(job: dict, query_strings: list[str]) -> bool:
    """OR across comma-separated JOB_QUERIES entries. Empty list ⇒ True."""
    if not query_strings:
        return True
    for q in query_strings:
        ast, err = try_parse_query(q)
        if err or ast is None:
            # Fall back to legacy whole-word-AND on title for broken syntax.
            from normalize import title_matches_queries
            if title_matches_queries(job.get("title") or "", [q]):
                return True
            continue
        if matches_query(ast, job):
            return True
    return False


# ---------- Expand to flat API search terms ----------

def _collect_positive_title_phrases(ast: dict) -> list[list[str]]:
    """Return list of AND-groups of title/any words (ignoring NOT and non-title fields).

    Each inner list is words that should be joined into one API search string.
    OR at the top level produces multiple groups.
    """
    t = ast.get("type")
    if t == "OR":
        out: list[list[str]] = []
        for c in ast.get("children") or []:
            out.extend(_collect_positive_title_phrases(c))
        return out or [[]]
    if t == "AND":
        # Merge child groups: if all children are single groups, concatenate words.
        # If a child expands to multiple OR groups, distribute (limited).
        groups: list[list[str]] = [[]]
        for c in ast.get("children") or []:
            if c.get("type") == "NOT":
                continue
            child_groups = _collect_positive_title_phrases(c)
            if not child_groups or child_groups == [[]]:
                continue
            new_groups: list[list[str]] = []
            for g in groups:
                for cg in child_groups:
                    new_groups.append(g + cg)
            groups = new_groups
        return groups
    if t == "NOT":
        return [[]]
    if t == "TERM":
        field = ast.get("field") or "title"
        if field not in ("title", "any"):
            # Company/desc/tag/loc terms are not useful as primary API title searches;
            # still emit the value so full-text APIs can use it as a fallback term.
            val = (ast.get("value") or "").strip()
            return [[val]] if val else [[]]
        val = (ast.get("value") or "").strip()
        return [[val]] if val else [[]]
    return [[]]


def expand_to_api_terms(ast: dict) -> list[str]:
    """Flatten AST into plain search strings suitable for external APIs."""
    groups = _collect_positive_title_phrases(ast)
    terms: list[str] = []
    seen: set[str] = set()
    for g in groups:
        words = [w for w in g if w]
        if not words:
            continue
        term = " ".join(words)
        key = term.lower()
        if key not in seen:
            seen.add(key)
            terms.append(term)
    return terms


def queries_to_api_terms(query_strings: list[str]) -> list[str]:
    """Parse each JOB_QUERIES entry and expand; dedupe case-insensitively."""
    terms: list[str] = []
    seen: set[str] = set()
    for q in query_strings:
        ast, err = try_parse_query(q)
        if err or ast is None:
            # Legacy fallback: use the raw string as one term.
            key = q.lower().strip()
            if key and key not in seen:
                seen.add(key)
                terms.append(q.strip())
            continue
        for t in expand_to_api_terms(ast):
            key = t.lower()
            if key not in seen:
                seen.add(key)
                terms.append(t)
    return terms


def job_matches_queries(job: dict, query_strings: list[str], *, title_only_compat: bool = False) -> bool:
    """Central filter used by worker/pipeline.

    When title_only_compat=True and every query is a plain word-AND (no operators /
    fields / phrases), fall back to legacy title_matches_queries for exact parity.
    """
    if not query_strings:
        return True
    if title_only_compat and all(_is_plain_legacy(q) for q in query_strings):
        from normalize import title_matches_queries
        return title_matches_queries(job.get("title") or "", query_strings)
    return matches_any_query(job, query_strings)


def _is_plain_legacy(q: str) -> bool:
    """True if the query has no operators, quotes, parens, or field prefixes."""
    if any(ch in q for ch in '"()'):
        return False
    tokens = tokenize(q)
    for kind, val in tokens:
        if kind in ("OP", "LPAREN", "RPAREN", "FIELD", "PHRASE"):
            return False
        if kind == "WORD" and val.upper() in OPS:
            return False
    return True
