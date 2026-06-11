import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sources import base


def _resp(status=200, text="ok", json_data=None):
    r = MagicMock()
    r.status_code = status
    r.text = text
    r.json.return_value = json_data if json_data is not None else {}
    r.raise_for_status = MagicMock()
    if status >= 400:
        from requests import HTTPError
        r.raise_for_status.side_effect = HTTPError(f"{status}")
    return r


def test_http_get_returns_text_on_200():
    with patch.object(base._session, "get", return_value=_resp(text="<html>hi</html>")) as g:
        out = base.http_get("https://example.com")
    assert out == "<html>hi</html>"
    # Sends our User-Agent.
    assert "User-Agent" in g.call_args.kwargs["headers"]


def test_http_json_parses_json():
    with patch.object(base._session, "get", return_value=_resp(json_data={"a": 1})):
        assert base.http_json("https://example.com/api") == {"a": 1}


def test_http_get_retries_then_succeeds_on_429():
    calls = [_resp(status=429), _resp(text="recovered")]
    with patch.object(base._session, "get", side_effect=calls), \
         patch.object(base.time, "sleep") as sleep:
        out = base.http_get("https://example.com", retries=1, backoff=0)
    assert out == "recovered"
    assert sleep.called  # throttle/backoff invoked


def test_http_get_raises_after_exhausting_retries():
    with patch.object(base._session, "get", return_value=_resp(status=500)), \
         patch.object(base.time, "sleep"):
        try:
            base.http_get("https://example.com", retries=1, backoff=0)
            assert False, "expected an exception"
        except Exception:
            pass
