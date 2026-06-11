"""Polite shared HTTP client for self-host sources.

All scraping runs on the user's machine, under the user's IP, per the self-host
disclaimer. Keep volumes modest: a global throttle, a sane timeout, and
exponential backoff on 429/5xx.
"""

import os
import time

import requests

USER_AGENT = os.getenv(
    "SOURCES_USER_AGENT",
    "JobRadar-selfhost/1.0 (+https://github.com/job-radar; personal job search)",
)
TIMEOUT = float(os.getenv("SOURCES_TIMEOUT", "30"))
THROTTLE = float(os.getenv("SOURCES_THROTTLE", "1.0"))  # seconds between requests

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept": "*/*"})


def _request(url, *, params=None, headers=None, method="GET", json_body=None,
             retries=2, backoff=2.0):
    merged_headers = {"User-Agent": USER_AGENT}
    if headers:
        merged_headers.update(headers)
    last_exc = None
    for attempt in range(retries + 1):
        try:
            if method == "GET":
                resp = _session.get(url, params=params, headers=merged_headers, timeout=TIMEOUT)
            else:
                resp = _session.request(method, url, params=params, headers=merged_headers,
                                        json=json_body, timeout=TIMEOUT)
            resp.raise_for_status()
            time.sleep(THROTTLE)  # be polite between successful calls
            return resp
        except Exception as exc:  # noqa: BLE001 — retry transient failures
            last_exc = exc
            if attempt < retries:
                time.sleep(backoff * (2 ** attempt))
            else:
                raise
    raise last_exc  # unreachable, satisfies type checkers


def http_get(url, *, params=None, headers=None, retries=2, backoff=2.0) -> str:
    """GET -> response text (HTML/XML). Raises on non-2xx after retries."""
    return _request(url, params=params, headers=headers,
                    retries=retries, backoff=backoff).text


def http_json(url, *, params=None, headers=None, method="GET", json_body=None,
              retries=2, backoff=2.0):
    """GET/POST -> parsed JSON. Raises on non-2xx after retries."""
    return _request(url, params=params, headers=headers, method=method,
                    json_body=json_body, retries=retries, backoff=backoff).json()
