"""Jobspresso — WordPress (WP Job Manager) remote-jobs RSS feed.

The working feed URL is the generic post_type=job_listing variant; the
dedicated /remote-work/feed/ path returns an empty channel.

Each <item> encodes:
  * <title>  — job title only (no company suffix)
  * <dc:creator> / author — "Company<br>⚲&nbsp;location"
  * <link>   — absolute permalink
  * <pubDate>
  * <description> / <content:encoded> — HTML job description
"""

import re

import feedparser

from normalize import (
    stable_id, strip_html, parse_date, derive_location_flags, derive_tags,
)
from .base import http_get

NAME = "jobspresso"
REQUIRES_ENV: list[str] = []
ENABLED_BY_DEFAULT = True

FEED = "https://jobspresso.co/?feed=rss2&post_type=job_listing"

# dc:creator is "Company<br>⚲&nbsp;some location" — split on the <br> tag.
_BR_RE = re.compile(r"<br\s*/?>", re.I)


def _extract_company(author_raw: str) -> str:
    """Return the company name from the raw dc:creator string.

    Feed format: 'Acme Corp<br>⚲&nbsp;United States'
    We take the part before the first <br>.
    """
    if not author_raw:
        return "—"
    parts = _BR_RE.split(author_raw, maxsplit=1)
    company = parts[0].strip()
    return company or "—"


def _parse(xml_text: str) -> list[dict]:
    feed = feedparser.parse(xml_text)
    jobs = []
    for e in feed.entries:
        title = str(getattr(e, "title", "")).strip()
        url = str(getattr(e, "link", "")).strip()
        if not title or not url:
            continue
        # Guard: links should be absolute; WordPress always gives them absolute.
        if not url.startswith("http"):
            continue

        author_raw = str(getattr(e, "author", "") or "")
        company = _extract_company(author_raw)

        # Prefer content:encoded (full HTML) over summary (truncated).
        content_list = getattr(e, "content", [])
        if content_list:
            raw_html = content_list[0].get("value", "")
        else:
            raw_html = str(getattr(e, "summary", "") or "")
        description = strip_html(raw_html)[:5000]

        location = "Remote"
        remote = True
        office, relocate = derive_location_flags(title, description, location, remote)

        jobs.append({
            "id": stable_id(NAME, url),
            "title": title,
            "company": company,
            "location": location,
            "remote": remote,
            "office": office,
            "relocate": relocate,
            "url": url,
            "source": NAME,
            "posted_at": parse_date(getattr(e, "published", None)),
            "salary": None,
            "description": description,
            "tags": derive_tags(title, description),
        })
    return jobs


def fetch(config: dict) -> list[dict]:
    return _parse(http_get(FEED))
