"""Thin CloakBrowser wrapper for the Python prototype.

`cloakbrowser` is imported **lazily inside launch functions only**, so importing
this module (and running the test suite) never requires a live browser or the
`cloakbrowser` package to be installed.
"""

from __future__ import annotations

import os
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
                headless=False,
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
    """Create a real Shopee shortlink using the opened browser session.

    This intentionally performs one in-page fetch from Shopee's affiliate
    origin. It does not auto-login, retry, or surface cookies/tokens. Shopee
    uses one headed persistent page per profile, so calls for the same profile
    are serialized to avoid concurrent navigation/evaluate collisions.
    """
    profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
    with _profile_lock(profile_dir):
        context, page = _open_shopee_custom_link_page(profile_dir)
        body = build_shortlink_body(original_link, sub_ids)
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
            if _is_recoverable_shopee_error(exc):
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
    context = launch_persistent_context(profile_dir)
    page = _first_page(context)
    if page is None:
        raise BrowserLaunchError("browser_page_unavailable")
    _navigate_to_custom_link(page)
    return context, page


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
    try:
        import subprocess
        out = subprocess.check_output(["/bin/ps", "-axo", "command"], text=True)
    except Exception:
        return True
    return profile_dir in out and "Chromium" in out

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
