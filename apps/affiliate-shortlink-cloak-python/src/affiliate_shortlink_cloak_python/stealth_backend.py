"""Side-by-side Stealth/nodriver backend for the Python shortlink sidecar.

This backend is an OPT-IN alternative to the default CloakBrowser/Playwright
backend in ``browser.py``. It is selected only when an env var explicitly asks
for it (see ``resolve_backend``); otherwise the existing behavior is untouched.

Design notes:

- ``nodriver`` is imported **lazily inside the runtime only**, so importing this
  module (and running the unit-test suite) never requires ``nodriver`` to be
  installed. The pure helpers below (backend selection, profile mapping, gate
  detection) are fully testable without a browser.
- nodriver is async; the sidecar's HTTP server is synchronous and serial. A
  single dedicated asyncio loop thread owns every Browser instance and requests
  are dispatched onto it, so a persistent per-account profile is reused across
  ``/login`` and ``/shorten`` calls.
- The shortlink call runs Shopee's ``batchCustomLink`` GraphQL through an
  in-page ``fetch`` (page context, natural browser headers) — no raw requests
  and no static anti-fraud headers. Cookies / CSRF / tokens are never returned.
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Dict, List, Mapping, Optional

# Reuse the shared, already-sanitized exception + Shopee helpers so the stealth
# backend classifies and redacts failures identically to the CloakBrowser path.
from .browser import BrowserLaunchError  # noqa: F401 (re-exported for dispatch)
from .shopee import (
    SHOPEE_GQL_ENDPOINT,
    ShopeeShortenError,
    build_shortlink_body,
    parse_shortlink_response,
    sanitize_error_message,
)

SHOPEE_CUSTOM_LINK_URL = "https://affiliate.shopee.co.th/offer/custom_link"

# nodriver is not installed in this app's own venv; it lives in the Stealth
# Browser repo venv. When set, this optional site-packages path is injected onto
# sys.path lazily so the backend can import nodriver even when the sidecar runs
# under the repo python. Running under the Stealth venv python makes this a
# no-op. Never contains secrets.
_STEALTH_SITE_PACKAGES_ENV = "AFFILIATE_STEALTH_SITE_PACKAGES"

# Env names (documented in README).
_BACKEND_ENV_PRIMARY = "AFFILIATE_SHORTLINK_BROWSER_BACKEND"
_BACKEND_ENV_LEGACY = "BACKEND"
_PROFILE_MAP_ENV = "AFFILIATE_STEALTH_ACCOUNT_PROFILE_MAP"

_STEALTH_BACKEND_ALIASES = {
    "stealth",
    "nodriver",
    "python-stealth",
    "python-stealth-nodriver",
    "stealth-nodriver",
}

_SHOPEE_GATE_RE = re.compile(
    r"/buyer/login|/login|captcha|verify|sign[- ]?in|/otp",
    re.IGNORECASE,
)
_AFFILIATE_ORIGIN_RE = re.compile(r"affiliate\.shopee\.co\.th", re.IGNORECASE)
_BLANK_URL_RE = re.compile(r"^(about:|chrome://|data:,?$)", re.IGNORECASE)
_SAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9._-]+")

SHORTEN_TIMEOUT_SECONDS = 30.0


# ---------------------------------------------------------------------------
# Pure helpers (no nodriver, fully unit-testable)
# ---------------------------------------------------------------------------


def normalize_backend(value: object) -> str:
    """Map a raw backend string onto a canonical backend id.

    Anything in the stealth alias set → the stealth backend; everything else
    (including empty / unknown) → the default CloakBrowser backend."""
    from . import BACKEND_CLOAKBROWSER, BACKEND_STEALTH

    text = str(value or "").strip().lower()
    if text in _STEALTH_BACKEND_ALIASES:
        return BACKEND_STEALTH
    return BACKEND_CLOAKBROWSER


def resolve_backend(environ: Optional[Mapping[str, str]] = None) -> str:
    """Resolve the active backend from env, preserving the default when unset.

    ``AFFILIATE_SHORTLINK_BROWSER_BACKEND`` wins; ``BACKEND`` is a legacy
    fallback. If neither selects the stealth backend, the default CloakBrowser
    backend is returned so existing behavior is preserved."""
    from . import BACKEND_CLOAKBROWSER

    env = os.environ if environ is None else environ
    raw = env.get(_BACKEND_ENV_PRIMARY)
    if raw is None or not str(raw).strip():
        raw = env.get(_BACKEND_ENV_LEGACY)
    if raw is None or not str(raw).strip():
        return BACKEND_CLOAKBROWSER
    return normalize_backend(raw)


def parse_profile_map(raw: object) -> Dict[str, str]:
    """Parse ``key=profile,key2=profile2`` into a mapping.

    Keys may be a Shopee id (``15130770000``), an ``an_<id>`` alias, or an
    account/display/utm alias. Values are profile *directory names* directly
    under the stealth profile root. Malformed entries are skipped."""
    result: Dict[str, str] = {}
    text = str(raw or "").strip()
    if not text:
        return result
    for chunk in re.split(r"[,\n;]+", text):
        entry = chunk.strip()
        if not entry or "=" not in entry:
            continue
        key, _, value = entry.partition("=")
        key = key.strip()
        value = _safe_profile_name(value.strip())
        if key and value:
            result[key] = value
    return result


def _safe_profile_name(value: object) -> str:
    """Sanitize a profile directory NAME (single path segment, no traversal)."""
    cleaned = str(value or "").strip().replace("\\", "/")
    cleaned = cleaned.split("/")[-1]
    cleaned = _SAFE_SEGMENT_RE.sub("-", cleaned)
    cleaned = cleaned.strip(".-")
    return cleaned


def _profile_map_keys_for_record(record: Mapping[str, object]) -> List[str]:
    keys: List[str] = []
    for field in ("id", "account", "display", "utm_source"):
        value = str(record.get(field) or "").strip()
        if value:
            keys.append(value)
            if field == "id":
                keys.append("an_" + value)
    return keys


def stealth_profile_dir(
    profile_root: str,
    record: Mapping[str, object],
    profile_map: Optional[Mapping[str, str]] = None,
) -> str:
    """Resolve the flat per-account Stealth profile directory.

    Unlike the CloakBrowser layout (``<root>/<platform>/<account>``), the Stealth
    Browser stores each profile as a single directory directly under the profile
    root (e.g. ``.../profiles/shopee-login-test``). An explicit env mapping wins;
    otherwise a sanitized account name is used as the profile name."""
    profile_map = profile_map or {}
    for key in _profile_map_keys_for_record(record):
        mapped = profile_map.get(key)
        if mapped:
            return os.path.join(profile_root, _safe_profile_name(mapped))
    fallback = _safe_profile_name(record.get("account") or record.get("id") or "default")
    return os.path.join(profile_root, fallback or "default")


def _is_blank_url(url: object) -> bool:
    text = str(url or "").strip()
    if not text:
        return True
    return bool(_BLANK_URL_RE.match(text))


def url_is_shopee_gate(url: object) -> bool:
    """True when the URL is a Shopee login/captcha/verify interstitial."""
    text = str(url or "")
    return bool(_SHOPEE_GATE_RE.search(text))


def _should_navigate_custom_link(current_url: object) -> bool:
    """Navigate only when strictly necessary (blank tab or off-affiliate origin
    that is NOT a login/captcha gate — a gate is left untouched, never
    re-hammered)."""
    text = str(current_url or "")
    if _is_blank_url(text):
        return True
    if _AFFILIATE_ORIGIN_RE.search(text):
        return False
    if url_is_shopee_gate(text):
        return False
    return True


def build_in_page_shorten_expression(body: Mapping[str, object]) -> str:
    """Build the IIFE JS expression that runs Shopee ``batchCustomLink`` from the
    page context. Endpoint + body are JSON-embedded (no interpolation of raw
    user input). CSRF is read from the browser's own cookie/meta; natural
    browser headers are used (no static anti-fraud headers)."""
    endpoint_json = json.dumps(SHOPEE_GQL_ENDPOINT)
    body_json = json.dumps(body)
    return (
        "(async () => {\n"
        "  const endpoint = " + endpoint_json + ";\n"
        "  const body = " + body_json + ";\n"
        "  let token = '';\n"
        "  const m = document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/);\n"
        "  if (m) token = decodeURIComponent(m[1]);\n"
        "  if (!token) {\n"
        "    const meta = document.querySelector('meta[name=\"csrf-token\"]')\n"
        "      || document.querySelector('meta[name=\"csrftoken\"]');\n"
        "    if (meta) token = meta.getAttribute('content') || '';\n"
        "  }\n"
        "  const headers = { 'Content-Type': 'application/json',"
        " 'affiliate-program-type': '1' };\n"
        "  if (token) headers['csrf-token'] = token;\n"
        "  const response = await fetch(endpoint, { method: 'POST',"
        " credentials: 'include', headers, body: JSON.stringify(body) });\n"
        "  const text = await response.text();\n"
        # Return a JSON *string* (a primitive) rather than an object. Primitives
        # round-trip reliably through nodriver's evaluate regardless of whether
        # Chrome answers via returnByValue or deep serialization, so the result
        # is not lost as an unwrapped RemoteObject.
        "  return JSON.stringify({ status: response.status, text: text,"
        " currentUrl: location.href });\n"
        "})()"
    )


def build_in_page_report_expression(api_url: object) -> str:
    """Build the IIFE JS expression that GETs a Shopee report API from the page
    context with ``credentials: 'include'`` (natural browser/session cookies).

    Mirrors the CloakBrowser in-page report script so the report classifiers see
    the SAME ``{status, parsed, body, snippet}`` envelope. The api_url is
    JSON-embedded (no raw interpolation). Returns a JSON *string* so the result
    round-trips reliably through nodriver's evaluate (see the shorten expression
    note above). Never returns cookies/tokens."""
    api_url_json = json.dumps(str(api_url or ""))
    return (
        "(async () => {\n"
        "  const apiUrl = " + api_url_json + ";\n"
        "  const resp = await fetch(apiUrl, { method: 'GET',"
        " credentials: 'include', headers: { 'accept': 'application/json' } });\n"
        "  const status = resp.status;\n"
        "  const text = await resp.text();\n"
        "  let parsed = false;\n"
        "  let body = null;\n"
        "  try { body = JSON.parse(text); parsed = true; } catch (e) { parsed = false; }\n"
        "  return JSON.stringify({ status: status, parsed: parsed, body: body,"
        " snippet: parsed ? '' : String(text || '').slice(0, 200),"
        " currentUrl: location.href });\n"
        "})()"
    )


def report_url_is_login_gate(url: object) -> bool:
    """Decide whether a report page URL should fail closed with ``login_gate``.

    Unlike ``url_is_shopee_gate`` (used by the shortlink path, which navigates a
    non-affiliate origin once to reach the affiliate origin), the report path
    treats ANY off-affiliate origin as a gate after the single allowed
    navigation — a report fetch MUST run from the authenticated affiliate
    origin. Mirrors the CloakBrowser ``_report_url_is_login_gate``."""
    text = str(url or "")
    if url_is_shopee_gate(text):
        return True
    return not _AFFILIATE_ORIGIN_RE.search(text)


def coerce_report_result_payload(value: object) -> Optional[Dict[str, object]]:
    """Coerce a normalized report evaluate result into the
    ``{status, parsed, body, snippet}`` dict. Accepts an already-decoded dict or
    a JSON string; returns ``None`` when it cannot be turned into a dict (so the
    caller fails closed). Reuses the shorten coercion (same JSON-string / dict
    handling)."""
    return coerce_shorten_result_payload(value)


# ---------------------------------------------------------------------------
# tab.evaluate result normalization (pure, fully unit-testable)
# ---------------------------------------------------------------------------
#
# nodriver's ``Tab.evaluate`` is inconsistent about what it hands back. It sends
# CDP ``Runtime.evaluate`` with BOTH ``returnByValue=True`` and
# ``serializationOptions={serialization: "deep"}``. When Chrome honours the deep
# serialization it populates ``deepSerializedValue`` (WebDriver-BiDi shape) and
# leaves ``value`` empty, so nodriver falls through and returns the raw
# ``RemoteObject`` instead of a plain Python value. Depending on Chrome version
# the same call can also yield: a plain decoded value (returnByValue), a
# ``DeepSerializedValue``, a BiDi node dict, or — on a JS throw — an
# ``ExceptionDetails``. The helpers below collapse every one of those shapes into
# a plain Python value (or raise for a JS exception) without importing nodriver.


class _StealthEvalError(Exception):
    """Internal marker: the tab reported a JS exception while evaluating."""


# WebDriver-BiDi deep-serialization node types (Runtime.DeepSerializedValue.type).
_BIDI_NODE_TYPES = frozenset(
    {
        "undefined",
        "null",
        "string",
        "number",
        "boolean",
        "bigint",
        "regexp",
        "date",
        "symbol",
        "array",
        "object",
        "function",
        "map",
        "set",
        "weakmap",
        "weakset",
        "error",
        "proxy",
        "promise",
        "typedarray",
        "arraybuffer",
        "node",
        "window",
        "generator",
    }
)


def _looks_like_bidi_node(value: object) -> bool:
    """True when a dict has the WebDriver-BiDi deep-serialized node shape.

    A plain result payload (``{"status": ..., "text": ...}``) has no ``type``
    key, so it is never mistaken for a BiDi node."""
    if not isinstance(value, dict):
        return False
    node_type = value.get("type")
    if not isinstance(node_type, str) or node_type not in _BIDI_NODE_TYPES:
        return False
    return "value" in value or node_type in ("null", "undefined")


def _decode_bidi_key(key: object) -> str:
    if isinstance(key, str):
        return key
    if isinstance(key, dict) and "value" in key:
        return str(key.get("value"))
    return str(key)


def _decode_bidi_node(node: object) -> object:
    """Decode a WebDriver-BiDi deep-serialized node into a plain Python value.

    Non-node values (already-plain dicts/lists/primitives) pass through
    untouched so this is safe to call on any evaluate result."""
    if not _looks_like_bidi_node(node):
        return node
    node_type = node.get("type")  # type: ignore[union-attr]
    node_value = node.get("value")  # type: ignore[union-attr]
    if node_type in ("null", "undefined"):
        return None
    if node_type == "object":
        decoded: Dict[str, object] = {}
        if isinstance(node_value, list):
            for pair in node_value:
                if isinstance(pair, (list, tuple)) and len(pair) == 2:
                    decoded[_decode_bidi_key(pair[0])] = _decode_bidi_node(pair[1])
        elif isinstance(node_value, dict):
            for raw_key, raw_val in node_value.items():
                decoded[_decode_bidi_key(raw_key)] = _decode_bidi_node(raw_val)
        return decoded
    if node_type in ("array", "set"):
        if isinstance(node_value, list):
            return [_decode_bidi_node(item) for item in node_value]
        return []
    if node_type == "map":
        decoded_map: Dict[str, object] = {}
        if isinstance(node_value, list):
            for pair in node_value:
                if isinstance(pair, (list, tuple)) and len(pair) == 2:
                    decoded_map[_decode_bidi_key(pair[0])] = _decode_bidi_node(pair[1])
        return decoded_map
    # string / number / boolean / bigint / etc: value is the primitive itself.
    return node_value


def _is_exception_details(result: object) -> bool:
    """Duck-type nodriver/CDP ``ExceptionDetails`` (JS threw during evaluate)."""
    if isinstance(result, dict):
        return False
    return hasattr(result, "exception_id") or type(result).__name__ == "ExceptionDetails"


def _exception_details_text(result: object) -> str:
    text = getattr(result, "text", None)
    return str(text) if text else "stealth_evaluate_exception"


def _is_remote_object(result: object) -> bool:
    if isinstance(result, dict):
        return False
    return hasattr(result, "deep_serialized_value")


def _is_deep_serialized_value(result: object) -> bool:
    if isinstance(result, dict):
        return False
    return (
        hasattr(result, "type_")
        and hasattr(result, "value")
        and not hasattr(result, "deep_serialized_value")
    )


def _normalize_deep_serialized(dsv: object) -> object:
    if dsv is None:
        return None
    if isinstance(dsv, dict):
        node = {"type": dsv.get("type") or dsv.get("type_"), "value": dsv.get("value")}
    else:
        node = {"type": getattr(dsv, "type_", None), "value": getattr(dsv, "value", None)}
    return _decode_bidi_node(node)


def normalize_evaluate_result(result: object) -> object:
    """Collapse any nodriver ``tab.evaluate`` return shape into a plain value.

    Handles the plain ``returnByValue`` value, a JSON string, a nodriver
    ``RemoteObject`` (via ``.value`` or ``.deep_serialized_value``), a bare
    ``DeepSerializedValue``, and a raw BiDi node dict. Raises
    ``_StealthEvalError`` when the tab reported a JS exception. Never logs or
    exposes the (potentially secret-bearing) payload."""
    if result is None:
        return None
    if _is_exception_details(result):
        raise _StealthEvalError(_exception_details_text(result))
    if _is_remote_object(result):
        value = getattr(result, "value", None)
        if value is not None:
            return normalize_evaluate_result(value)
        dsv = getattr(result, "deep_serialized_value", None)
        if dsv is not None:
            return _normalize_deep_serialized(dsv)
        return None
    if _is_deep_serialized_value(result):
        return _normalize_deep_serialized(result)
    if _looks_like_bidi_node(result):
        return _decode_bidi_node(result)
    return result


def coerce_shorten_result_payload(value: object) -> Optional[Dict[str, object]]:
    """Coerce a normalized evaluate result into the ``{status,text,currentUrl}``
    dict. Accepts an already-decoded dict or a JSON string; returns ``None`` when
    it cannot be turned into a dict (so the caller fails closed)."""
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            return None
    if isinstance(value, dict):
        return value
    return None


# ---------------------------------------------------------------------------
# nodriver runtime (lazy import; owns one asyncio loop + Browser per profile)
# ---------------------------------------------------------------------------


class _StealthRuntime:
    """Owns a background asyncio loop and the live nodriver Browser instances.

    All coroutines are submitted onto the single loop thread so every Browser is
    created and driven from the same loop, which lets ``/shorten`` reuse the
    persistent profile that ``/login`` opened."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loop = None
        self._thread = None
        self._browsers: Dict[str, object] = {}
        self._profile_locks: Dict[str, threading.Lock] = {}

    def _ensure_loop(self):
        import asyncio

        with self._lock:
            if self._loop is not None and self._thread is not None and self._thread.is_alive():
                return self._loop
            loop = asyncio.new_event_loop()

            def _run() -> None:
                asyncio.set_event_loop(loop)
                loop.run_forever()

            thread = threading.Thread(
                target=_run,
                name="stealth-nodriver-loop",
                daemon=True,
            )
            thread.start()
            self._loop = loop
            self._thread = thread
            return loop

    def _run(self, coro, timeout: float = 90.0):
        import asyncio

        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=timeout)

    def profile_lock(self, profile_dir: str) -> threading.Lock:
        with self._lock:
            lock = self._profile_locks.get(profile_dir)
            if lock is None:
                lock = threading.Lock()
                self._profile_locks[profile_dir] = lock
            return lock

    def _import_nodriver(self):
        site_packages = os.environ.get(_STEALTH_SITE_PACKAGES_ENV, "").strip()
        if site_packages:
            import sys

            expanded = os.path.expanduser(site_packages)
            if os.path.isdir(expanded) and expanded not in sys.path:
                sys.path.insert(0, expanded)
        try:
            import nodriver  # noqa: WPS433 (intentional lazy import)
        except Exception as exc:  # pragma: no cover - depends on live env
            raise BrowserLaunchError(
                "stealth_nodriver_import_failed: %s" % type(exc).__name__
            )
        return nodriver

    async def _get_browser(self, profile_dir: str):
        browser = self._browsers.get(profile_dir)
        if browser is not None and not _browser_is_stopped(browser):
            return browser
        if browser is not None:
            self._browsers.pop(profile_dir, None)

        nodriver = self._import_nodriver()
        os.makedirs(profile_dir, exist_ok=True)
        headless = _env_bool("AFFILIATE_STEALTH_HEADLESS", False)
        try:
            browser = await nodriver.start(
                user_data_dir=profile_dir,
                headless=headless,
            )
        except Exception as exc:  # pragma: no cover - depends on live env
            raise BrowserLaunchError(
                "stealth_nodriver_launch_failed: %s" % type(exc).__name__
            )
        self._browsers[profile_dir] = browser
        return browser

    async def _prepare_shopee_tab(self, profile_dir: str, navigate: bool = True):
        """Acquire (or reuse) a usable Shopee tab, resilient to a dead browser.

        nodriver's ``browser.get()`` can raise ``RuntimeError: coroutine raised
        StopIteration`` (or a closed-target/websocket error) when Chrome exists
        but has no usable page/tab. Instead of letting that escape the loop
        thread and drop the HTTP connection, we drop the stale browser, relaunch
        once for a dead-browser error, and otherwise fail closed with a
        sanitized ``BrowserLaunchError`` (both the shorten and report callers map
        that to a JSON error). Navigation happens at most once (never on an
        affiliate tab / gate) so reCAPTCHA is not hammered.

        Returns ``(browser, tab, current_url)``."""
        last_exc: Optional[BaseException] = None
        for attempt in (1, 2):
            browser = await self._get_browser(profile_dir)
            try:
                tab = await _open_shopee_tab(browser)
                current_url = _tab_url(tab)
                if navigate and _should_navigate_custom_link(current_url):
                    tab = await browser.get(SHOPEE_CUSTOM_LINK_URL)
                    current_url = _tab_url(tab)
                return browser, tab, current_url
            except Exception as exc:  # noqa: BLE001 - classified + sanitized below
                last_exc = exc
                self._drop_browser(profile_dir, browser)
                if attempt == 1 and _is_dead_browser_error(exc):
                    # Chrome is alive but has no usable tab: relaunch once.
                    continue
                raise BrowserLaunchError(
                    "stealth_tab_unavailable: %s" % type(exc).__name__
                )
        raise BrowserLaunchError(
            "stealth_tab_unavailable: %s" % type(last_exc).__name__
        )

    def _drop_browser(self, profile_dir: str, browser: object) -> None:
        """Forget + best-effort stop a browser so the next call relaunches fresh."""
        self._browsers.pop(profile_dir, None)
        try:
            stop = getattr(browser, "stop", None)
            if callable(stop):
                stop()
        except Exception:  # pragma: no cover - best-effort cleanup
            pass

    async def _open_custom_link(self, profile_dir: str) -> Dict[str, Optional[str]]:
        _browser, _tab, current_url = await self._prepare_shopee_tab(profile_dir)
        return {
            "profileDir": profile_dir,
            "targetUrl": SHOPEE_CUSTOM_LINK_URL,
            "currentUrl": current_url,
        }

    async def _shorten(
        self,
        profile_dir: str,
        original_link: str,
        body: Mapping[str, object],
    ) -> Dict[str, object]:
        _browser, tab, current_url = await self._prepare_shopee_tab(profile_dir)

        # A page parked on a Shopee login/captcha/verify gate is failed closed
        # WITHOUT re-navigating it (re-navigating hammers reCAPTCHA).
        if url_is_shopee_gate(current_url):
            raise ShopeeShortenError(
                "shopee_session_gate",
                "Session on Shopee login/captcha gate",
                current_url=current_url,
                manual_login_required=True,
            )

        expression = build_in_page_shorten_expression(body)
        try:
            raw_result = await tab.evaluate(
                expression,
                await_promise=True,
                return_by_value=True,
            )
        except Exception as exc:
            raise ShopeeShortenError(
                "shopee_stealth_fetch_failed",
                sanitize_error_message(exc),
                current_url=current_url,
                manual_login_required=True,
            )

        # nodriver may hand back a plain dict, a JSON string, a RemoteObject, or
        # a deep-serialized BiDi node depending on Chrome/serialization; collapse
        # them all into the {status,text,currentUrl} payload here.
        try:
            normalized = normalize_evaluate_result(raw_result)
        except _StealthEvalError as exc:
            raise ShopeeShortenError(
                "shopee_stealth_fetch_failed",
                sanitize_error_message(exc),
                current_url=current_url,
                manual_login_required=True,
            )

        result = coerce_shorten_result_payload(normalized)
        if result is None:
            raise ShopeeShortenError(
                "shopee_stealth_invalid_fetch_result",
                "Invalid fetch result from stealth browser",
                current_url=current_url,
                manual_login_required=True,
            )

        result_url = str(result.get("currentUrl") or current_url or "")
        try:
            parsed = parse_shortlink_response(
                _as_int(result.get("status")),
                result.get("text") or "",
                original_link,
            )
        except ShopeeShortenError as exc:
            if not exc.current_url:
                exc.current_url = result_url
            raise
        return {
            "profileDir": profile_dir,
            "targetUrl": SHOPEE_CUSTOM_LINK_URL,
            "currentUrl": result_url,
            "shortLink": parsed["shortLink"],
            "longLink": parsed["longLink"],
            "originalLink": parsed["originalLink"],
        }

    async def _fetch_report(self, profile_dir: str, api_url: str) -> Dict[str, object]:
        """Run a credentialed in-page GET against a Shopee report API.

        Reuses the same persistent per-account Stealth profile / affiliate tab as
        the shortlink flow WITHOUT forcing a fresh navigation on every call
        (navigation happens at most once, only to establish the affiliate origin
        on a blank/off-affiliate tab). If the session is on a login/captcha gate
        or otherwise off the affiliate origin it fails closed with
        ``{login_gate: True}`` instead of re-navigating (which would hammer
        reCAPTCHA) or leaking the redirect URL. Returns the CloakBrowser-parity
        envelope ``{status, parsed, body, snippet}``. Never returns
        cookies/tokens."""
        _browser, tab, current_url = await self._prepare_shopee_tab(profile_dir)

        # After the single allowed navigation, the report fetch MUST run from the
        # authenticated affiliate origin. A login/captcha/verify gate or any
        # off-affiliate origin fails closed WITHOUT re-navigating.
        if report_url_is_login_gate(current_url):
            return {"login_gate": True}

        expression = build_in_page_report_expression(api_url)
        try:
            raw_result = await tab.evaluate(
                expression,
                await_promise=True,
                return_by_value=True,
            )
        except Exception as exc:  # noqa: BLE001 - sanitized upstream
            raise RuntimeError(sanitize_error_message(exc)) from None

        try:
            normalized = normalize_evaluate_result(raw_result)
        except _StealthEvalError as exc:
            raise RuntimeError(sanitize_error_message(exc)) from None

        result = coerce_report_result_payload(normalized)
        if result is None:
            raise RuntimeError("shopee_report_invalid_fetch_result")
        return result

    def open_shopee_custom_link(self, profile_dir: str) -> Dict[str, Optional[str]]:
        profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
        with self.profile_lock(profile_dir):
            return self._run(self._open_custom_link(profile_dir))

    def fetch_shopee_report_json(self, profile_dir: str, api_url: str) -> Dict[str, object]:
        profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
        with self.profile_lock(profile_dir):
            return self._run(self._fetch_report(profile_dir, str(api_url)))

    def shorten_shopee_link(
        self,
        profile_dir: str,
        original_link: str,
        sub_ids: object,
    ) -> Dict[str, object]:
        profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
        body = build_shortlink_body(original_link, sub_ids)
        with self.profile_lock(profile_dir):
            return self._run(self._shorten(profile_dir, original_link, body))

    def close_all(self) -> int:
        with self._lock:
            browsers = list(self._browsers.items())
            self._browsers.clear()
            loop = self._loop
        closed = 0
        for _profile, browser in browsers:
            try:
                stop = getattr(browser, "stop", None)
                if callable(stop):
                    stop()
                    closed += 1
            except Exception:  # pragma: no cover - best-effort cleanup
                pass
        if loop is not None:
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:  # pragma: no cover - best-effort cleanup
                pass
        return closed


_RUNTIME = _StealthRuntime()


# ---------------------------------------------------------------------------
# Module-level dispatch surface (mirrors browser.py so server.py can swap it in)
# ---------------------------------------------------------------------------


def open_shopee_custom_link(profile_dir: str) -> Dict[str, Optional[str]]:
    return _RUNTIME.open_shopee_custom_link(profile_dir)


def shorten_shopee_link(
    profile_dir: str,
    original_link: str,
    sub_ids: object,
) -> Dict[str, object]:
    return _RUNTIME.shorten_shopee_link(profile_dir, original_link, sub_ids)


def fetch_shopee_report_json(profile_dir: str, api_url: str) -> Dict[str, object]:
    """Stealth-backend report fetcher (mirrors ``browser.fetch_shopee_report_json``).

    Returns the CloakBrowser-parity envelope ``{status, parsed, body, snippet}``
    or ``{login_gate: True}`` when the session is on a login/captcha gate. Raises
    ``BrowserLaunchError`` when the Stealth browser cannot be launched / has no
    usable tab, or ``RuntimeError`` on an in-page fetch failure — both are mapped
    by the report handlers to a sanitized ``*_fetch_failed`` payload."""
    return _RUNTIME.fetch_shopee_report_json(profile_dir, api_url)


def close_all() -> int:
    return _RUNTIME.close_all()


# ---------------------------------------------------------------------------
# Small runtime helpers
# ---------------------------------------------------------------------------


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


_DEAD_BROWSER_MARKERS = (
    "stopiteration",
    "coroutine raised stopiteration",
    "target closed",
    "connection closed",
    "connection is closed",
    "websocket",
    "remotedisconnected",
    "no such target",
    "no usable tab",
    "cannot connect",
)


def _is_dead_browser_error(exc: object) -> bool:
    """True when an error means Chrome is up but has no usable page/tab / lost its
    connection (e.g. nodriver ``browser.get()`` raising
    ``RuntimeError: coroutine raised StopIteration``). Such errors are recovered
    by relaunching the browser once rather than dropping the HTTP connection."""
    text = (str(exc or "") + " " + type(exc).__name__).lower()
    return any(marker in text for marker in _DEAD_BROWSER_MARKERS)


def _browser_is_stopped(browser) -> bool:
    try:
        stopped = getattr(browser, "stopped", None)
        if callable(stopped):
            return bool(stopped())
        if stopped is not None:
            return bool(stopped)
    except Exception:  # pragma: no cover - defensive
        return True
    return False


def _tab_url(tab) -> str:
    try:
        url = getattr(tab, "url", None)
        if callable(url):
            url = url()
        return str(url) if url else ""
    except Exception:  # pragma: no cover - defensive
        return ""


async def _open_shopee_tab(browser):
    """Reuse the browser's existing tab when possible (persistent session)."""
    try:
        main_tab = getattr(browser, "main_tab", None)
        if main_tab is not None:
            return main_tab
    except Exception:  # pragma: no cover - defensive
        pass
    return await browser.get(SHOPEE_CUSTOM_LINK_URL)
