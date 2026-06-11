"""Shared normalization helpers for self-host job sources.

Twin of scripts/sources/util.mjs — keeps API, scraper and JobSpy outputs
schema-compatible. Zero coupling to any specific source.
"""

import hashlib
import re
from datetime import datetime


def stable_id(source: str, url: str) -> str:
    return hashlib.sha1(f"{source}|{url}".encode()).hexdigest()[:16]


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value) -> str | None:
    """Normalize ISO strings, datetimes, or '3 days ago' to YYYY-MM-DD."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip()
    if not s:
        return None
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    if m:
        return m.group(1)
    try:
        import dateparser
        parsed = dateparser.parse(s)
        return parsed.strftime("%Y-%m-%d") if parsed else None
    except Exception:  # noqa: BLE001 — unparseable date or missing dateparser → unknown
        return None


_REMOTE_META = {
    "remote", "anywhere", "worldwide", "global", "distributed",
    "home", "wfh", "fully", "only", "first", "friendly",
    "position", "location", "based", "across", "within",
}
_REGION_TOKENS = {
    "eu", "europe", "european", "union", "us", "usa", "united", "states",
    "america", "americas", "emea", "apac", "latam", "asia", "africa",
    "oceania", "pacific", "cet", "cest", "gmt", "utc", "est", "pst",
    "timezone", "tz", "time", "zone",
    "north", "south", "east", "west", "central", "latin",
}
_HYBRID_RE = re.compile(r"\b(hybrid|on[-\s]?site|onsite|in[-\s]?office|in[-\s]?person)\b", re.I)
_RELOCATE_RE = re.compile(
    r"relocat\w+|relo[-\s]?package|visa\s+sponsorship|sponsor\s+(?:your|the|a)?\s*visas?|"
    r"we\s+(?:will\s+)?sponsor\s+visas?|work[-\s]?permit\s+(?:assistance|sponsorship|support)|"
    r"релок\w+|переезд\w*|визов\w+\s+поддержк\w+|оплат\w+\s+релок\w+|помощь\s+с\s+переездом",
    re.I,
)
_NO_RELOCATE_RE = re.compile(
    r"no\s+relocation|no\s+visa\s+sponsorship|cannot\s+sponsor|unable\s+to\s+sponsor|"
    r"does\s+not\s+(?:offer\s+)?(?:relocation|sponsor)|we\s+do\s+not\s+sponsor|"
    r"без\s+релокации|релокация\s+не\s+предоставляется",
    re.I,
)


def derive_location_flags(title: str, description: str, location: str, remote: bool) -> tuple[bool, bool]:
    full_text = f"{title}\n{description}"
    loc = (location or "").strip()
    if not loc or loc in {"—", "-"}:
        office = not remote
    else:
        remainder = "".join(
            w for w in re.split(r"[^a-zа-яё0-9]+", loc.lower())
            if len(w) >= 2 and w not in _REMOTE_META and w not in _REGION_TOKENS
        )
        office = bool(remainder)
    if not office and _HYBRID_RE.search(full_text):
        office = True
    relocate = bool(_RELOCATE_RE.search(full_text)) and not _NO_RELOCATE_RE.search(full_text)
    return office, relocate


def derive_tags(title: str, description: str) -> list[str]:
    t = (title or "").lower()
    full = f"{t} {(description or '').lower()}"
    title_rules = {
        "Product": r"\b(product (manager|owner|lead|management|director)|cpo|pm)\b",
        "Sales": r"\b(sales|account executive|business development)\b",
        "Senior": r"\b(senior|staff|principal)\b",
        "Lead": r"\b(lead|head of|director)\b",
    }
    text_rules = {
        "AI": r"\b(ai|ml|machine learning|llm)\b",
        "MarTech": r"\b(martech|marketing tech(nology)?|crm)\b",
        "Remote": r"\bremote\b",
    }
    tags = [tag for tag, pattern in title_rules.items() if re.search(pattern, t)]
    tags += [tag for tag, pattern in text_rules.items() if re.search(pattern, full)]
    return tags


def title_matches_queries(title: str, queries: list[str]) -> bool:
    """True if at least one query matches: every significant word (len>=2) of the
    query appears in the title as a whole word. Same guard as the Node pipeline —
    keeps full-text search noise (jobs that merely mention a query) out of the pool."""
    t = (title or "").lower()
    for q in queries:
        words = [w for w in re.split(r"[^a-zа-яё0-9+#.]+", q.lower()) if len(w) >= 2]
        if words and all(
            re.search(rf"(^|[^a-zа-яё0-9]){re.escape(w)}([^a-zа-яё0-9]|$)", t) for w in words
        ):
            return True
    return False
