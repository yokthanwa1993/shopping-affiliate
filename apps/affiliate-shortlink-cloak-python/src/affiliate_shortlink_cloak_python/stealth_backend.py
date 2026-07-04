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
        "  return { status: response.status, text: text, currentUrl: location.href };\n"
        "})()"
    )


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

    async def _open_custom_link(self, profile_dir: str) -> Dict[str, Optional[str]]:
        browser = await self._get_browser(profile_dir)
        tab = await _open_shopee_tab(browser)
        current_url = _tab_url(tab)
        if _should_navigate_custom_link(current_url):
            tab = await browser.get(SHOPEE_CUSTOM_LINK_URL)
            current_url = _tab_url(tab)
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
        browser = await self._get_browser(profile_dir)
        tab = await _open_shopee_tab(browser)
        current_url = _tab_url(tab)
        if _should_navigate_custom_link(current_url):
            tab = await browser.get(SHOPEE_CUSTOM_LINK_URL)
            current_url = _tab_url(tab)

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
            result = await tab.evaluate(
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

        if not isinstance(result, dict):
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

    def open_shopee_custom_link(self, profile_dir: str) -> Dict[str, Optional[str]]:
        profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
        with self.profile_lock(profile_dir):
            return self._run(self._open_custom_link(profile_dir))

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
