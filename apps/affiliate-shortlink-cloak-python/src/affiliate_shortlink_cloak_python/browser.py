"""Thin CloakBrowser wrapper for the Python prototype.

`cloakbrowser` is imported **lazily inside launch functions only**, so importing
this module (and running the test suite) never requires a live browser or the
`cloakbrowser` package to be installed.
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Dict, List, Optional

from .shopee import (
    SHOPEE_GQL_ENDPOINT,
    SHOPEE_ORIGIN,
    ShopeeShortenError,
    build_shortlink_body,
    parse_shortlink_response,
    sanitize_error_message,
)

SHOPEE_CUSTOM_LINK_URL = "https://affiliate.shopee.co.th/offer/custom_link"

# Request-first hot path (mirrors the legacy stable Node baseline c63c3306). The
# primary shortlink / report transport is Playwright's ``BrowserContext.request``
# APIRequestContext, which shares the persistent profile's logged-in cookies. It
# needs NO visible tab and NO per-call navigation, so thousands of shortlink /
# report calls never reload the affiliate tab (which was tripping reCAPTCHA).
# Values match the Node config: same UA, same 25s timeout, same affiliate origin.
_CHROME_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)
SHORTEN_TIMEOUT_MS = 25000
_SHOPEE_REFERER = SHOPEE_ORIGIN + "/"

_IN_PAGE_SHORTEN_SCRIPT = """async ([endpoint, body, csrfToken]) => {
  let token = csrfToken || '';
  if (!token) {
    const match = document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }
  if (!token) {
    const meta = document.querySelector('meta[name="csrf-token"]')
      || document.querySelector('meta[name="csrftoken"]');
    if (meta) token = meta.getAttribute('content') || '';
  }
  const headers = {
    'Content-Type': 'application/json',
    'affiliate-program-type': '1',
  };
  if (token) headers['csrf-token'] = token;
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, currentUrl: location.href };
}"""

_IN_PAGE_REPORT_FETCH_SCRIPT = """async ([apiUrl]) => {
  const resp = await fetch(apiUrl, {
    method: 'GET',
    credentials: 'include',
    headers: { 'accept': 'application/json' },
  });
  const status = resp.status;
  const text = await resp.text();
  let parsed = false;
  let body = null;
  try { body = JSON.parse(text); parsed = true; } catch (e) { parsed = false; }
  return { status, parsed, body, snippet: parsed ? '' : String(text || '').slice(0, 200) };
}"""

_IN_PAGE_CSRF_SCRIPT = """() => {
  const match = document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  const meta = document.querySelector('meta[name="csrf-token"]')
    || document.querySelector('meta[name="csrftoken"]');
  return meta ? meta.getAttribute('content') || '' : '';
}"""

# Track live persistent contexts so close_all() can clean up on shutdown.
_LOCK = threading.Lock()
_OPEN_CONTEXTS: List[object] = []
_CONTEXT_BY_PROFILE: Dict[str, object] = {}
_PROFILE_LOCKS: Dict[str, threading.Lock] = {}


class BrowserLaunchError(RuntimeError):
    """Raised when the browser cannot be imported or launched. Message is safe
    (no secrets) and suitable for returning to a client."""


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _headless_mode() -> bool:
    return _env_bool("AFFILIATE_CLOAK_HEADLESS", False)

def _import_cloakbrowser():
    """Import cloakbrowser lazily. Raises BrowserLaunchError on failure."""
    try:
        import cloakbrowser  # noqa: WPS433 (intentional local import)
    except Exception as exc:  # pragma: no cover - depends on live env
        raise BrowserLaunchError("cloakbrowser_import_failed: %s" % type(exc).__name__)
    return cloakbrowser


def launch_persistent_context(profile_dir: str):
    """Launch or reuse a headed CloakBrowser persistent context.

    CloakBrowser persistent profiles are exclusive. The `/login` endpoint leaves
    the browser open for manual login, so `/shorten` must reuse that same live
    context instead of launching the same profile again.
    """
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    with _LOCK:
        existing = _CONTEXT_BY_PROFILE.get(profile_dir)
        if existing is not None and not _context_is_closed(existing):
            return existing
        if existing is not None:
            _CONTEXT_BY_PROFILE.pop(profile_dir, None)

    cloakbrowser = _import_cloakbrowser()
    os.makedirs(profile_dir, exist_ok=True)

    last_exc = None
    for attempt in (1, 2):
        try:
            context = cloakbrowser.launch_persistent_context(
                profile_dir,
                headless=_headless_mode(),
            )
            break
        except Exception as exc:  # pragma: no cover - depends on live env
            last_exc = exc
            if attempt == 1:
                _forget_profile_context(profile_dir)
                _remove_stale_singleton_files(profile_dir)
                continue
            raise BrowserLaunchError("cloakbrowser_launch_failed: %s" % type(exc).__name__)
    else:  # pragma: no cover
        raise BrowserLaunchError("cloakbrowser_launch_failed: %s" % type(last_exc).__name__)

    with _LOCK:
        _OPEN_CONTEXTS.append(context)
        _CONTEXT_BY_PROFILE[profile_dir] = context
    return context


def open_shopee_custom_link(profile_dir: str) -> Dict[str, Optional[str]]:
    """Open (or reuse) a persistent context and navigate to the Shopee
    custom-link page. Returns a safe dict with `currentUrl` when resolvable.

    No autofill, no keychain, no secrets.
    """
    context, page = _open_shopee_custom_link_page(profile_dir)

    return {
        "profileDir": profile_dir,
        "targetUrl": SHOPEE_CUSTOM_LINK_URL,
        "currentUrl": _safe_current_url(page),
    }


def shorten_shopee_link(
    profile_dir: str,
    original_link: str,
    sub_ids: object,
) -> Dict[str, Optional[str]]:
    """Create a real Shopee shortlink using the logged-in browser session.

    Request-first hot path (legacy Node baseline parity): the primary transport
    is the persistent context's ``request`` APIRequestContext, which reuses the
    profile cookies WITHOUT creating or navigating a visible tab. Only when the
    request-first call reports a login/session/403-style failure do we fall back
    once to the gate-aware in-page path (which never re-navigates a login/captcha
    gate, so Shopee is never hammered). It does not auto-login or surface
    cookies/tokens. Calls for the same profile are serialized.
    """
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    with _profile_lock(profile_dir):
        context = launch_persistent_context(profile_dir)
        body = build_shortlink_body(original_link, sub_ids)

        request_api = _context_request_api(context)
        if request_api is not None and callable(getattr(request_api, "post", None)):
            try:
                parsed = _shorten_via_context_request(
                    context, request_api, body, original_link
                )
                return {
                    "profileDir": profile_dir,
                    "targetUrl": SHOPEE_CUSTOM_LINK_URL,
                    "currentUrl": _existing_page_url(context),
                    "shortLink": parsed["shortLink"],
                    "longLink": parsed["longLink"],
                    "originalLink": parsed["originalLink"],
                }
            except ShopeeShortenError as exc:
                # Non-session classifications (bad JSON, failCode, etc.) fail
                # closed immediately. Only a login/session/403-style failure is
                # worth one fallback to the gate-aware page path below.
                if not exc.manual_login_required:
                    raise

        return _shorten_via_page(profile_dir, original_link, body)


def _shorten_via_page(
    profile_dir: str,
    original_link: str,
    body: Dict[str, object],
) -> Dict[str, Optional[str]]:
    """Legacy in-page fallback for the shortlink flow.

    Performs one in-page fetch from Shopee's affiliate origin using the already
    open (or minimally navigated) custom_link tab. Kept intact from the original
    implementation so it stays gate-aware and never hammers reCAPTCHA.

    The caller (``shorten_shopee_link``) already holds the per-profile lock, so
    this helper must NOT re-acquire it (``threading.Lock`` is non-reentrant).
    """
    context, page = _open_shopee_custom_link_page(profile_dir)
    csrf_token = _csrf_token_from_context(context, page)
    fetch_result = _fetch_shortlink_from_page(page, body, csrf_token)
    current_url = str(fetch_result.get("currentUrl") or _safe_current_url(page) or "")

    try:
        parsed = parse_shortlink_response(
            int(fetch_result.get("status") or 0),
            fetch_result.get("text") or "",
            original_link,
        )
    except ShopeeShortenError as exc:
        if not exc.current_url:
            exc.current_url = current_url
        # Recover by re-navigating + retrying once for transient failures,
        # but NEVER when the session is sitting on a Shopee login/captcha/
        # verify gate: re-navigating there just reloads the gate and trips
        # more reCAPTCHA. Fail closed and let the caller classify instead.
        if _is_recoverable_shopee_error(exc) and not _url_is_shopee_gate(current_url):
            _navigate_to_custom_link(page)
            csrf_token = _csrf_token_from_context(context, page)
            fetch_result = _fetch_shortlink_from_page(page, body, csrf_token)
            current_url = str(
                fetch_result.get("currentUrl") or _safe_current_url(page) or ""
            )
            try:
                parsed = parse_shortlink_response(
                    int(fetch_result.get("status") or 0),
                    fetch_result.get("text") or "",
                    original_link,
                )
            except ShopeeShortenError as retry_exc:
                if not retry_exc.current_url:
                    retry_exc.current_url = current_url
                raise
        else:
            raise

    return {
        "profileDir": profile_dir,
        "targetUrl": SHOPEE_CUSTOM_LINK_URL,
        "currentUrl": current_url,
        "shortLink": parsed["shortLink"],
        "longLink": parsed["longLink"],
        "originalLink": parsed["originalLink"],
    }


def _context_request_api(context):
    """Return the persistent context's ``request`` APIRequestContext, or None.

    Returning None means "no request-first transport available" and keeps the
    legacy in-page path fully in control (this is also why the existing
    fake-context tests, which have no ``.request``, behave exactly as before)."""
    try:
        request = getattr(context, "request", None)
    except Exception:  # pragma: no cover - defensive
        return None
    return request


def _response_status(response) -> int:
    """Read a Playwright ``APIResponse.status`` (int property) defensively.

    Also tolerates a callable ``status()`` for fakes / older shims."""
    status = getattr(response, "status", 0)
    if callable(status):
        try:
            status = status()
        except Exception:  # pragma: no cover - defensive
            status = 0
    try:
        return int(status or 0)
    except (TypeError, ValueError):
        return 0


def _response_text(response) -> str:
    """Read a Playwright ``APIResponse.text()`` body defensively."""
    text_fn = getattr(response, "text", None)
    if callable(text_fn):
        try:
            return str(text_fn() or "")
        except Exception as exc:  # pragma: no cover - surfaced upstream
            raise RuntimeError(sanitize_error_message(exc)) from None
    return str(text_fn or "")


def _existing_page_url(context) -> str:
    """Peek an already-open tab's URL WITHOUT creating a page.

    The request-first path never needs a visible tab, but if the profile still
    has a tab parked on a login/captcha gate we can fail closed from it."""
    try:
        pages = getattr(context, "pages", None)
        if callable(pages):
            pages = pages()
        if pages:
            return str(_safe_current_url(pages[0]) or "")
    except Exception:  # pragma: no cover - defensive
        pass
    return ""


def _csrf_token_from_cookies(context) -> str:
    """Cookie-only csrf lookup for the request-first path (no page.evaluate)."""
    try:
        cookies_fn = getattr(context, "cookies", None)
        if callable(cookies_fn):
            for cookie in cookies_fn(SHOPEE_ORIGIN) or []:
                if _cookie_value(cookie, "name") == "csrftoken":
                    return _cookie_value(cookie, "value")
    except Exception:  # pragma: no cover - best-effort
        pass
    return ""


def _shorten_via_context_request(
    context,
    request_api,
    body: Dict[str, object],
    original_link: str,
) -> Dict[str, str]:
    """Primary request-first shortlink transport.

    POSTs ``batchCustomLink`` through the persistent context's APIRequestContext
    (shares profile cookies, no visible tab, no navigation). Response parsing and
    classification reuse the same pure helpers as the in-page path, so response
    shapes and sanitization are identical. Raises ``ShopeeShortenError`` on any
    failure; a login/session/403-style failure sets ``manual_login_required`` so
    the caller can fall back once to the gate-aware page path."""
    headers = {
        "Content-Type": "application/json",
        "affiliate-program-type": "1",
        "origin": SHOPEE_ORIGIN,
        "referer": _SHOPEE_REFERER,
        "user-agent": _CHROME_UA,
    }
    csrf_token = _csrf_token_from_cookies(context)
    if csrf_token:
        headers["csrf-token"] = csrf_token

    try:
        response = request_api.post(
            SHOPEE_GQL_ENDPOINT,
            headers=headers,
            data=body,
            timeout=SHORTEN_TIMEOUT_MS,
        )
    except Exception as exc:
        raise ShopeeShortenError(
            _classify_fetch_error(exc),
            sanitize_error_message(exc),
            current_url=_existing_page_url(context),
            manual_login_required=True,
        )

    status = _response_status(response)
    text = _response_text(response)
    try:
        return parse_shortlink_response(status, text, original_link)
    except ShopeeShortenError as exc:
        if not exc.current_url:
            exc.current_url = _existing_page_url(context)
        raise



_AFFILIATE_ORIGIN_RE = re.compile(r"affiliate\.shopee\.co\.th", re.IGNORECASE)
_LOGIN_REDIRECT_RE = re.compile(
    r"shopee\.co\.th/buyer/login|affiliate\.shopee\.co\.th/login",
    re.IGNORECASE,
)
_DASHBOARD_DETAIL_RE = re.compile(
    r"/api/v3/dashboard/detail(?:\?|$)",
    re.IGNORECASE,
)
# A Shopee captcha / login / verify / sign-in interstitial. When the report
# session lands here we fail closed instead of re-navigating (which would
# refresh the visible custom_link tab and trip more reCAPTCHA).
_SHOPEE_GATE_RE = re.compile(
    r"/buyer/login|/login|captcha|verify|sign[- ]?in|/otp",
    re.IGNORECASE,
)
# "No established origin yet" URLs for a freshly created / reused blank tab.
_BLANK_URL_RE = re.compile(r"^(about:|chrome://newtab|data:,?$)", re.IGNORECASE)


def _is_blank_url(url: str) -> bool:
    """True when the page has no real origin yet (new tab / about:blank)."""
    text = str(url or "").strip()
    if not text:
        return True
    return bool(_BLANK_URL_RE.match(text))


def _url_is_shopee_gate(url: str) -> bool:
    """True when the URL is a Shopee login/captcha/verify interstitial.

    Unlike ``_report_url_is_login_gate`` this does NOT treat an arbitrary
    non-affiliate origin as a gate — the shortlink path navigates such origins
    once to reach the affiliate origin, and only refuses to re-navigate a real
    login/captcha gate (to avoid hammering reCAPTCHA)."""
    text = str(url or "")
    return bool(_SHOPEE_GATE_RE.search(text) or _LOGIN_REDIRECT_RE.search(text))


def _report_url_is_login_gate(url: str) -> bool:
    """Decide whether a report page URL should fail closed.

    A URL is a gate when it is a Shopee login/captcha/verify interstitial, or
    when it is simply not on the affiliate origin (blank tabs are handled
    separately by navigating once, so by the time this runs a non-affiliate URL
    means the session really is off-origin)."""
    text = str(url or "")
    if _SHOPEE_GATE_RE.search(text) or _LOGIN_REDIRECT_RE.search(text):
        return True
    return not _AFFILIATE_ORIGIN_RE.search(text)


def fetch_shopee_report_json(profile_dir: str, api_url: str) -> Dict[str, object]:
    """Run a credentialed in-page GET against a Shopee report API.

    Reuses the per-account persistent CloakBrowser session (same profile the
    shortlink flow uses) and, crucially, reuses whatever page/tab is already
    open **without forcing a fresh navigation on every call**. Thousands of
    report fetches therefore no longer reload the visible custom_link tab
    (which was tripping reCAPTCHA). Navigation happens at most once, only to
    establish the affiliate origin on a brand-new / blank tab.

    Returns a dict shaped like the legacy in-page fetch:
    ``{status, parsed, body, snippet}``. If the session is on a login/captcha
    page (or is off the affiliate origin) it fails closed with
    ``{login_gate: True}`` instead of leaking the redirect URL or re-navigating.
    Never returns cookies/tokens.

    Raises ``BrowserLaunchError`` when the browser cannot be launched (callers
    map that to ``browser_unavailable``); a failed in-page fetch raises a plain
    ``RuntimeError`` (callers map that to a sanitized ``*_fetch_failed``).
    """
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    with _profile_lock(profile_dir):
        context = launch_persistent_context(profile_dir)

        # Request-first hot path: GET the report through the persistent context's
        # APIRequestContext (shares profile cookies, no visible tab, no reload).
        request_api = _context_request_api(context)
        if request_api is not None and callable(getattr(request_api, "get", None)):
            gate_url = _existing_page_url(context)
            # If a real tab is parked on a login/captcha/verify gate, fail closed
            # from it (a blank/new tab is fine — the request API uses cookies).
            if (
                gate_url
                and not _is_blank_url(gate_url)
                and _report_url_is_login_gate(gate_url)
            ):
                return {"login_gate": True}
            result = _report_fetch_via_context_request(request_api, api_url)
            if _should_page_fallback_for_report(api_url, result):
                return _report_fetch_via_page_once(context, api_url)
            return result

        # Legacy in-page fallback (no request API available on this context).
        context, page, current_url = _open_shopee_report_page(profile_dir)
        if _report_url_is_login_gate(current_url):
            return {"login_gate": True}

        evaluate = getattr(page, "evaluate", None)
        if not callable(evaluate):
            raise RuntimeError("browser_evaluate_unavailable")
        try:
            result = evaluate(_IN_PAGE_REPORT_FETCH_SCRIPT, [str(api_url)])
        except Exception as exc:  # noqa: BLE001 - sanitized upstream
            raise RuntimeError(sanitize_error_message(exc)) from None
        if not isinstance(result, dict):
            raise RuntimeError("shopee_report_invalid_fetch_result")
        return result


def _is_dashboard_detail_url(api_url: object) -> bool:
    return bool(_DASHBOARD_DETAIL_RE.search(str(api_url or "")))


def _report_headers_for_api(api_url: object) -> Dict[str, str]:
    headers = {
        "accept": "application/json",
        "origin": SHOPEE_ORIGIN,
        "referer": _SHOPEE_REFERER,
        "user-agent": _CHROME_UA,
    }
    if _is_dashboard_detail_url(api_url):
        headers["referer"] = SHOPEE_ORIGIN + "/dashboard"
        headers["x-requested-with"] = "XMLHttpRequest"
    return headers


def _should_page_fallback_for_report(api_url: object, result: object) -> bool:
    if not _is_dashboard_detail_url(api_url):
        return False
    if not isinstance(result, dict):
        return False
    return _response_status_like(result.get("status")) in {401, 403}


def _response_status_like(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _report_fetch_via_context_request(request_api, api_url: str) -> Dict[str, object]:
    """Primary request-first report transport.

    GETs a Shopee report API through the persistent context's APIRequestContext
    and returns the SAME shape as the legacy in-page fetch
    (``{status, parsed, body, snippet}``) so the report classifiers are
    unchanged. Never creates/reloads a visible page. Sanitizes the failure /
    snippet so cookies/tokens are never surfaced."""
    headers = _report_headers_for_api(api_url)
    try:
        response = request_api.get(
            str(api_url),
            headers=headers,
            timeout=SHORTEN_TIMEOUT_MS,
        )
    except Exception as exc:  # noqa: BLE001 - sanitized upstream
        raise RuntimeError(sanitize_error_message(exc)) from None

    status = _response_status(response)
    text = _response_text(response)
    parsed = False
    body: object = None
    try:
        body = json.loads(text)
        parsed = True
    except (TypeError, ValueError):
        parsed = False
    return {
        "status": status,
        "parsed": parsed,
        "body": body,
        "snippet": "" if parsed else sanitize_error_message(text, limit=200),
    }


def _report_fetch_via_page_once(context, api_url: str) -> Dict[str, object]:
    """Dashboard-detail fallback after request-context 401/403.

    This reuses the existing Shopee tab and only navigates when the tab is new
    or blank, matching the legacy report fallback without repeated refreshes.
    """
    page, created = _report_page(context)
    if page is None:
        raise BrowserLaunchError("browser_page_unavailable")
    current_url = str(_safe_current_url(page) or "")
    if created or _is_blank_url(current_url):
        _navigate_to_custom_link(page)
        current_url = str(_safe_current_url(page) or "")
    if _report_url_is_login_gate(current_url):
        return {"login_gate": True}

    evaluate = getattr(page, "evaluate", None)
    if not callable(evaluate):
        raise RuntimeError("browser_evaluate_unavailable")
    try:
        result = evaluate(_IN_PAGE_REPORT_FETCH_SCRIPT, [str(api_url)])
    except Exception as exc:  # noqa: BLE001 - sanitized upstream
        raise RuntimeError(sanitize_error_message(exc)) from None
    if not isinstance(result, dict):
        raise RuntimeError("shopee_report_invalid_fetch_result")
    return result


def _profile_lock(profile_dir: str) -> threading.Lock:
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    with _LOCK:
        lock = _PROFILE_LOCKS.get(profile_dir)
        if lock is None:
            lock = threading.Lock()
            _PROFILE_LOCKS[profile_dir] = lock
        return lock


def _is_recoverable_shopee_error(exc: ShopeeShortenError) -> bool:
    reason = str(getattr(exc, "reason", "") or "").lower()
    message = str(exc or "").lower()
    return any(marker in reason or marker in message for marker in (
        "http_401",
        "http_403",
        "session_fetch_failed",
        "browser_fetch_failed",
        "invalid_json",
        "no_results",
    ))

def _open_shopee_custom_link_page(profile_dir: str):
    """Open (or reuse) the persistent custom-link page for the shortlink hot
    path WITHOUT reloading the affiliate custom_link tab on every request.

    Legacy/browser-like behavior (mirrors the report path so shortlink creation
    no longer trips reCAPTCHA on the visible tab):

    - Reuse the already-open tab. If it is already on the affiliate origin
      (especially ``/offer/custom_link``) we do NOT navigate — the in-page
      shortlink fetch runs against the live affiliate origin, so a reload only
      adds reCAPTCHA risk.
    - Only when the tab has no real origin yet (freshly created / ``about:blank``)
      do we navigate once to establish the affiliate origin.
    - A page sitting on a Shopee login/captcha/verify gate is left untouched; we
      never re-navigate/hammer it. The shorten flow classifies the gate from the
      current URL / fetch result and fails closed (``manual_login_required``).
    - Any other non-affiliate origin is navigated once (never in a loop), because
      the affiliate shortlink API fetch requires the affiliate origin.
    """
    context = launch_persistent_context(profile_dir)
    page, created = _report_page(context)
    if page is None:
        raise BrowserLaunchError("browser_page_unavailable")
    if _should_navigate_custom_link(created, str(_safe_current_url(page) or "")):
        _navigate_to_custom_link(page)
    return context, page


def _should_navigate_custom_link(created: bool, current_url: str) -> bool:
    """Decide whether the shortlink path must ``page.goto`` custom_link.

    Navigate only when strictly necessary so an already-open affiliate
    custom_link tab is never reloaded (reload == reCAPTCHA risk)."""
    if created or _is_blank_url(current_url):
        # Brand-new / blank tab: navigate once to establish the affiliate origin.
        return True
    if _AFFILIATE_ORIGIN_RE.search(current_url):
        # Already on the affiliate origin (incl. /offer/custom_link): reuse it.
        return False
    if _SHOPEE_GATE_RE.search(current_url) or _LOGIN_REDIRECT_RE.search(current_url):
        # Login/captcha/verify gate: do not re-navigate/hammer. The shorten flow
        # fails closed based on the current URL / fetch result instead.
        return False
    # Some other non-affiliate origin: navigate once (the API fetch needs the
    # affiliate origin), never loop.
    return True


def _open_shopee_report_page(profile_dir: str):
    """Reuse the persistent context + an existing page for a report fetch
    WITHOUT forcing ``page.goto`` on every call.

    - Reuses the already-open tab. If it is already on the affiliate origin we
      do NOT navigate (this is the hot path for thousands of report fetches).
    - Only when the tab has no real origin yet (freshly created / ``about:blank``)
      do we navigate once to establish the affiliate origin.
    - A page sitting on a login/captcha/verify or otherwise non-affiliate origin
      is left untouched here; the caller fails closed with ``login_gate`` rather
      than re-navigating and hammering Shopee.

    Returns ``(context, page, current_url)``.
    """
    context = launch_persistent_context(profile_dir)
    page, created = _report_page(context)
    if page is None:
        raise BrowserLaunchError("browser_page_unavailable")
    current_url = str(_safe_current_url(page) or "")
    if created or _is_blank_url(current_url):
        # At most one navigation, purely to establish the affiliate origin on a
        # blank/new tab. Existing affiliate pages skip this entirely.
        _navigate_to_custom_link(page)
        current_url = str(_safe_current_url(page) or "")
    return context, page, current_url


def _report_page(context):
    """Like ``_first_page`` but reports whether the page was newly created, so
    the report path knows when a one-time navigation is warranted."""
    try:
        pages = getattr(context, "pages", None)
        if callable(pages):
            pages = pages()
        if pages:
            return pages[0], False
    except Exception:  # pragma: no cover - defensive
        pass
    try:
        return context.new_page(), True
    except Exception:  # pragma: no cover
        return None, True


def _navigate_to_custom_link(page) -> None:
    try:
        page.goto(SHOPEE_CUSTOM_LINK_URL)
    except Exception:  # pragma: no cover - navigation best-effort
        pass
    wait_for_load_state = getattr(page, "wait_for_load_state", None)
    if callable(wait_for_load_state):
        try:
            wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:  # pragma: no cover
            pass


def _csrf_token_from_context(context, page) -> str:
    try:
        cookies_fn = getattr(context, "cookies", None)
        if callable(cookies_fn):
            cookies = cookies_fn(SHOPEE_ORIGIN)
            for cookie in cookies or []:
                name = _cookie_value(cookie, "name")
                if name == "csrftoken":
                    return _cookie_value(cookie, "value")
    except Exception:  # pragma: no cover - token lookup is best-effort
        pass

    try:
        evaluate = getattr(page, "evaluate", None)
        if callable(evaluate):
            token = evaluate(_IN_PAGE_CSRF_SCRIPT)
            return str(token or "")
    except Exception:  # pragma: no cover
        pass
    return ""


def _cookie_value(cookie, key: str) -> str:
    if isinstance(cookie, dict):
        return str(cookie.get(key) or "")
    return str(getattr(cookie, key, "") or "")


def _fetch_shortlink_from_page(
    page,
    body: Dict[str, object],
    csrf_token: str,
) -> Dict[str, object]:
    evaluate = getattr(page, "evaluate", None)
    if not callable(evaluate):
        raise ShopeeShortenError(
            "browser_evaluate_unavailable",
            manual_login_required=True,
            current_url=_safe_current_url(page),
        )

    try:
        result = evaluate(
            _IN_PAGE_SHORTEN_SCRIPT,
            [SHOPEE_GQL_ENDPOINT, body, csrf_token or ""],
        )
    except Exception as exc:
        current_url = _safe_current_url(page)
        raise ShopeeShortenError(
            _classify_fetch_error(exc),
            sanitize_error_message(exc),
            current_url=current_url,
            manual_login_required=True,
        )

    if not isinstance(result, dict):
        raise ShopeeShortenError(
            "shopee_api_invalid_fetch_result",
            "Invalid fetch result from browser",
            current_url=_safe_current_url(page),
        )
    return result


def _classify_fetch_error(exc: object) -> str:
    msg = str(exc or "").lower()
    if any(marker in msg for marker in (
        "login",
        "signin",
        "sign-in",
        "csrf",
        "captcha",
        "otp",
        "401",
        "403",
        "unauthorized",
    )):
        return "shopee_session_blocked"
    if "failed to fetch" in msg or "network" in msg:
        return "shopee_session_fetch_failed"
    return "shopee_browser_fetch_failed"



def _forget_profile_context(profile_dir: str) -> None:
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    with _LOCK:
        context = _CONTEXT_BY_PROFILE.pop(profile_dir, None)
        if context in _OPEN_CONTEXTS:
            try:
                _OPEN_CONTEXTS.remove(context)
            except ValueError:
                pass
    if context is not None:
        try:
            close = getattr(context, "close", None)
            if callable(close):
                close()
        except Exception:
            pass


def _remove_stale_singleton_files(profile_dir: str) -> None:
    # Only called after a launch failure. If a Chromium process still owns the
    # profile, removing these files would be unsafe; otherwise they are stale.
    if _profile_has_live_chromium_process(profile_dir):
        return
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        path = os.path.join(profile_dir, name)
        try:
            if os.path.lexists(path):
                os.unlink(path)
        except Exception:
            pass


def _profile_has_live_chromium_process(profile_dir: str) -> bool:
    """Return True only when a real Chromium process owns ``profile_dir``.

    This must inspect per-process lines. A previous substring check over the
    whole ``ps`` output could see ``profile_dir`` in the current shell command
    and ``Chromium`` on an unrelated line, incorrectly treating stale
    Singleton* files as live after the user closed the browser window.
    """
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    try:
        import subprocess
        out = subprocess.check_output(["/bin/ps", "-axo", "pid=,comm=,command="], text=True)
    except Exception:
        return True
    for raw_line in out.splitlines():
        line = raw_line.strip()
        if not line or profile_dir not in line:
            continue
        # Match the actual Chromium app/helper command, not grep/shell/python
        # commands that merely mention the profile path.
        if "Chromium" not in line:
            continue
        if ".app/Contents/MacOS/Chromium" in line or "Chromium Helper" in line:
            return True
    return False

def _context_is_closed(context: object) -> bool:
    try:
        closed_attr = getattr(context, "is_closed", None)
        if callable(closed_attr):
            return bool(closed_attr())
        if closed_attr is not None:
            return bool(closed_attr)
    except Exception:
        return True
    try:
        pages = getattr(context, "pages", None)
        if callable(pages):
            pages = pages()
        # Playwright persistent contexts usually keep this accessible while live.
        if pages is not None:
            return False
    except Exception:
        return True
    return False


def _first_page(context):
    """Best-effort: get an existing page or create a new one on the context."""
    try:
        pages = getattr(context, "pages", None)
        if pages:
            return pages[0]
    except Exception:  # pragma: no cover
        pass
    try:
        return context.new_page()
    except Exception:  # pragma: no cover
        return None


def _safe_current_url(page) -> Optional[str]:
    """Read page.url defensively; return None on any failure."""
    try:
        url = getattr(page, "url", None)
        if callable(url):
            url = url()
        return str(url) if url else None
    except Exception:  # pragma: no cover
        return None


def close_all() -> int:
    """Close every tracked context. Returns how many were closed. Safe to call
    when none are open (e.g. during tests)."""
    closed = 0
    with _LOCK:
        contexts = list(_OPEN_CONTEXTS)
        _OPEN_CONTEXTS.clear()
    for ctx in contexts:
        try:
            ctx.close()
            closed += 1
        except Exception:  # pragma: no cover - best-effort cleanup
            pass
    return closed
