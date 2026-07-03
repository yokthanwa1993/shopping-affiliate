"""Pure-Python MCP stdio server for the affiliate shortlink / report bridge.

This exposes the local CloakBrowser bridge (``/shorten``, ``/conversion-report``,
``/daily-income-report``, ``/click-report``, ``/accounts``, ``/health``,
``/login``) as MCP tools so a Hermes profile can call tools instead of raw URL
endpoints.

Design goals:

* 100% Python; the bridge is called over stdlib ``urllib`` (no third-party HTTP
  client). The only optional dependency is ``mcp`` (``FastMCP``), imported
  lazily so the pure logic below stays unit-testable without it installed.
* Never returns cookies / access tokens / CSRF values. Every bridge response is
  passed through :func:`redact` before it leaves this process.
* Fails closed and never retries: if the bridge is unreachable or Shopee returns
  a ``manual_login_required`` / captcha payload, that sanitized JSON is returned
  verbatim (with ``httpStatus`` metadata) — the MCP server never re-hammers
  Shopee.

Entry points:

* console script ``affiliate-shortlink-cloak-mcp`` (see ``pyproject.toml``)
* ``python -m affiliate_shortlink_cloak_python.mcp_server``
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Mapping, Optional
from urllib.parse import urlencode

from . import APP_NAME
from .accounts import resolve_by_shopee_id

DEFAULT_BRIDGE_URL = "http://127.0.0.1:8810"
BRIDGE_URL_ENV = "AFFILIATE_SHORTLINK_BRIDGE_URL"
BRIDGE_TIMEOUT_ENV = "AFFILIATE_SHORTLINK_BRIDGE_TIMEOUT"
DEFAULT_BRIDGE_TIMEOUT_SECONDS = 30.0

# ``http_get`` receives a fully built URL and returns a parsed JSON mapping.
HttpGet = Callable[[str], Mapping[str, object]]


# --- Config ------------------------------------------------------------------

def bridge_base_url(env: Optional[Mapping[str, str]] = None) -> str:
    """Resolve the configurable bridge base URL (no trailing slash)."""
    environ = os.environ if env is None else env
    raw = str(environ.get(BRIDGE_URL_ENV, "") or "").strip()
    return raw.rstrip("/") if raw else DEFAULT_BRIDGE_URL


def bridge_timeout_seconds(env: Optional[Mapping[str, str]] = None) -> float:
    """Resolve the per-request timeout, defaulting to 30s."""
    environ = os.environ if env is None else env
    raw = str(environ.get(BRIDGE_TIMEOUT_ENV, "") or "").strip()
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_BRIDGE_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_BRIDGE_TIMEOUT_SECONDS


# --- Secret redaction --------------------------------------------------------

# Key substrings that must never leave this process with a real value.
_SECRET_KEY_SUBSTRINGS = (
    "token",
    "cookie",
    "csrf",
    "secret",
    "password",
    "passwd",
    "datr",
    "totp",
    "bearer",
    "authorization",
    "apikey",
    "api_key",
    "sessionid",
    "session_id",
    "set-cookie",
)


def _is_secret_key(key: object) -> bool:
    text = str(key).strip().lower()
    return any(token in text for token in _SECRET_KEY_SUBSTRINGS)


def _scrub_secret_string(text: str) -> str:
    """Redact cookie / CSRF header fragments inside a string without truncating."""
    text = re.sub(
        r"(?im)^(\s*-?\s*(?:set-)?cookie\s*[:=]\s*)[^\r\n]*",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)(csrf-?token\s*[:=]\s*)[^\s;,'\"]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)(csrftoken=)[^;\s,'\"]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)((?:SPC|REC)[^=;\s]*=)[^;\s,'\"]+",
        r"\1[REDACTED]",
        text,
    )
    return text


def redact(value: object) -> object:
    """Recursively redact cookie/token-like fields from a bridge response."""
    if isinstance(value, Mapping):
        cleaned: Dict[str, object] = {}
        for key, inner in value.items():
            if _is_secret_key(key):
                cleaned[str(key)] = "[REDACTED]"
            else:
                cleaned[str(key)] = redact(inner)
        return cleaned
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return _scrub_secret_string(value)
    return value


# --- Account id mapping ------------------------------------------------------

def map_login_account(shopee_id: object) -> Optional[str]:
    """Map a numeric Shopee id (or ``an_<id>``) to its internal account name."""
    record = resolve_by_shopee_id(str(shopee_id or ""))
    return record["account"] if record else None


# --- URL construction + transport --------------------------------------------

def build_bridge_url(base: str, path: str, params: Mapping[str, object]) -> str:
    """Join ``base`` + ``path`` and append non-empty params as a query string.

    ``None`` and empty-string values are dropped so optional filters do not send
    blank query params to the bridge. Numeric ``0`` / ``False`` are preserved.
    """
    pairs: List[tuple] = []
    for key, value in params.items():
        if value is None:
            continue
        text = str(value)
        if text == "":
            continue
        pairs.append((key, text))
    url = base.rstrip("/") + path
    if pairs:
        url += "?" + urlencode(pairs)
    return url


def _decode_bridge_body(status: int, raw: object) -> Dict[str, object]:
    if isinstance(raw, (bytes, bytearray)):
        text = bytes(raw).decode("utf-8", "replace")
    else:
        text = str(raw or "")
    try:
        data = json.loads(text) if text.strip() else {}
    except (TypeError, ValueError):
        return {
            "status": "error",
            "error": "bridge_invalid_json",
            "httpStatus": status,
            "snippet": _scrub_secret_string(text[:200]),
        }
    if isinstance(data, dict):
        if status >= 400:
            data.setdefault("httpStatus", status)
        return data
    return {"status": "ok", "httpStatus": status, "data": data}


def http_get_json(url: str, timeout: float = DEFAULT_BRIDGE_TIMEOUT_SECONDS) -> Dict[str, object]:
    """Perform one GET against the bridge and parse JSON. Never retries."""
    request = urllib.request.Request(
        url, headers={"Accept": "application/json"}, method="GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return _decode_bridge_body(response.getcode(), response.read())
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001 - fail closed with the status only
            body = b""
        return _decode_bridge_body(exc.code, body)
    except urllib.error.URLError as exc:
        return {
            "status": "error",
            "error": "bridge_unreachable",
            "reason": _scrub_secret_string(str(getattr(exc, "reason", exc))),
        }
    except Exception as exc:  # noqa: BLE001 - never leak a raw traceback
        return {
            "status": "error",
            "error": "bridge_request_failed",
            "reason": _scrub_secret_string(str(exc)),
        }


def call_bridge(
    path: str,
    params: Mapping[str, object],
    *,
    env: Optional[Mapping[str, str]] = None,
    http_get: Optional[HttpGet] = None,
) -> Dict[str, object]:
    """Build the bridge URL, fetch once, and return the redacted JSON."""
    base = bridge_base_url(env)
    url = build_bridge_url(base, path, params)
    if http_get is not None:
        raw = http_get(url)
    else:
        raw = http_get_json(url, timeout=bridge_timeout_seconds(env))
    result = redact(raw)
    return result if isinstance(result, dict) else {"status": "ok", "data": result}


# --- Tool implementations (FastMCP-free, unit-testable) ----------------------

def tool_health(
    *, env: Optional[Mapping[str, str]] = None, http_get: Optional[HttpGet] = None
) -> Dict[str, object]:
    return call_bridge("/health", {}, env=env, http_get=http_get)


def tool_accounts(
    *, env: Optional[Mapping[str, str]] = None, http_get: Optional[HttpGet] = None
) -> Dict[str, object]:
    return call_bridge("/accounts", {}, env=env, http_get=http_get)


def tool_create_shopee_shortlink(
    url: str,
    id: str = "15130770000",
    sub1: str = "",
    sub2: str = "",
    sub3: str = "",
    sub4: str = "",
    sub5: str = "",
    *,
    env: Optional[Mapping[str, str]] = None,
    http_get: Optional[HttpGet] = None,
) -> Dict[str, object]:
    params = {
        "id": id,
        "url": url,
        "sub1": sub1,
        "sub2": sub2,
        "sub3": sub3,
        "sub4": sub4,
        "sub5": sub5,
    }
    return call_bridge("/shorten", params, env=env, http_get=http_get)


def tool_get_conversion_report(
    id: str = "15130770000",
    time: str = "today",
    raw: bool = False,
    page: int = 1,
    page_size: int = 100,
    sub_id: str = "",
    order_id: str = "",
    checkout_id: str = "",
    conversion_id: str = "",
    order_status: str = "",
    conversion_status: str = "",
    *,
    env: Optional[Mapping[str, str]] = None,
    http_get: Optional[HttpGet] = None,
) -> Dict[str, object]:
    params: Dict[str, object] = {
        "id": id,
        "time": time,
        "page": page,
        "page_size": page_size,
        "sub_id": sub_id,
        "order_id": order_id,
        "checkout_id": checkout_id,
        "conversion_id": conversion_id,
        "order_status": order_status,
        "conversion_status": conversion_status,
    }
    if raw:
        params["raw"] = "1"
    return call_bridge("/conversion-report", params, env=env, http_get=http_get)


def tool_get_daily_income_report(
    id: str = "",
    ids: str = "",
    time: str = "today",
    *,
    env: Optional[Mapping[str, str]] = None,
    http_get: Optional[HttpGet] = None,
) -> Dict[str, object]:
    params: Dict[str, object] = {"time": time}
    if str(ids).strip():
        params["ids"] = ids
    else:
        params["id"] = str(id).strip() or "15130770000"
    return call_bridge("/daily-income-report", params, env=env, http_get=http_get)


def tool_get_click_report(
    id: str = "15130770000",
    time: str = "today",
    raw: bool = False,
    page: int = 1,
    page_size: int = 100,
    sub_id: str = "",
    *,
    env: Optional[Mapping[str, str]] = None,
    http_get: Optional[HttpGet] = None,
) -> Dict[str, object]:
    params: Dict[str, object] = {
        "id": id,
        "time": time,
        "page": page,
        "page_size": page_size,
        "sub_id": sub_id,
    }
    if raw:
        params["raw"] = "1"
    return call_bridge("/click-report", params, env=env, http_get=http_get)


def tool_open_manual_login(
    id: str = "15130770000",
    no_autofill: bool = True,
    *,
    env: Optional[Mapping[str, str]] = None,
    http_get: Optional[HttpGet] = None,
) -> Dict[str, object]:
    account = map_login_account(id)
    if not account:
        return {
            "status": "error",
            "error": "unknown_shopee_id",
            "id": str(id),
        }
    params = {
        "json": "1",
        "platform": "shopee",
        "account": account,
        "noAutofill": "1" if no_autofill else "0",
        "autofill": "0" if no_autofill else "1",
    }
    return call_bridge("/login", params, env=env, http_get=http_get)


# --- FastMCP wiring ----------------------------------------------------------

def build_server(env: Optional[Mapping[str, str]] = None):
    """Build the FastMCP server. ``mcp`` is imported lazily so importing this
    module (and running its unit tests) never requires ``mcp`` installed."""
    from mcp.server.fastmcp import FastMCP

    server = FastMCP(APP_NAME)

    @server.tool()
    def health() -> dict:
        """Check the local affiliate shortlink bridge health and config."""
        return tool_health(env=env)

    @server.tool()
    def accounts() -> dict:
        """List the known Shopee affiliate account aliases from the bridge."""
        return tool_accounts(env=env)

    @server.tool()
    def create_shopee_shortlink(
        url: str,
        id: str = "15130770000",
        sub1: str = "",
        sub2: str = "",
        sub3: str = "",
        sub4: str = "",
        sub5: str = "",
    ) -> dict:
        """Create a Shopee affiliate shortlink for ``url``.

        ``id`` selects the account (``15130770000`` = chearb, ``15142270000`` =
        neezs). ``sub1``..``sub5`` are optional Shopee sub ids.
        """
        return tool_create_shopee_shortlink(
            url,
            id=id,
            sub1=sub1,
            sub2=sub2,
            sub3=sub3,
            sub4=sub4,
            sub5=sub5,
            env=env,
        )

    @server.tool()
    def get_conversion_report(
        id: str = "15130770000",
        time: str = "today",
        raw: bool = False,
        page: int = 1,
        page_size: int = 100,
        sub_id: str = "",
        order_id: str = "",
        checkout_id: str = "",
        conversion_id: str = "",
        order_status: str = "",
        conversion_status: str = "",
    ) -> dict:
        """Fetch the Shopee conversion report (summary by default, ``raw=True``
        for one page of raw rows). ``time`` accepts ``today``/``yesterday``/
        ``DD/MM/YYYY``/``YYYY-MM-DD``."""
        return tool_get_conversion_report(
            id=id,
            time=time,
            raw=raw,
            page=page,
            page_size=page_size,
            sub_id=sub_id,
            order_id=order_id,
            checkout_id=checkout_id,
            conversion_id=conversion_id,
            order_status=order_status,
            conversion_status=conversion_status,
            env=env,
        )

    @server.tool()
    def get_daily_income_report(
        id: str = "",
        ids: str = "",
        time: str = "today",
    ) -> dict:
        """Fetch the Shopee daily-income report. Pass ``ids`` (comma-separated)
        for multiple accounts, else ``id`` (default ``15130770000``)."""
        return tool_get_daily_income_report(id=id, ids=ids, time=time, env=env)

    @server.tool()
    def get_click_report(
        id: str = "15130770000",
        time: str = "today",
        raw: bool = False,
        page: int = 1,
        page_size: int = 100,
        sub_id: str = "",
    ) -> dict:
        """Fetch the Shopee click report (summary breakdown by default,
        ``raw=True`` for one page of raw rows)."""
        return tool_get_click_report(
            id=id,
            time=time,
            raw=raw,
            page=page,
            page_size=page_size,
            sub_id=sub_id,
            env=env,
        )

    @server.tool()
    def open_manual_login(id: str = "15130770000", no_autofill: bool = True) -> dict:
        """Open the manual Shopee login page for the mapped account (no autofill
        by default). Returns sanitized JSON; never returns cookies or tokens."""
        return tool_open_manual_login(id=id, no_autofill=no_autofill, env=env)

    return server


def main(argv: Optional[List[str]] = None) -> None:
    """Console entry point: run the MCP server over stdio."""
    server = build_server()
    server.run()


if __name__ == "__main__":
    main()
