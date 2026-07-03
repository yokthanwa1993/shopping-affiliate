"""Thin CloakBrowser wrapper for the Python prototype.

`cloakbrowser` is imported **lazily inside launch functions only**, so importing
this module (and running the test suite) never requires a live browser or the
`cloakbrowser` package to be installed.
"""

from __future__ import annotations

import os
import threading
from typing import Dict, List, Optional

SHOPEE_CUSTOM_LINK_URL = "https://affiliate.shopee.co.th/offer/custom_link"

# Track live persistent contexts so close_all() can clean up on shutdown.
_LOCK = threading.Lock()
_OPEN_CONTEXTS: List[object] = []


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
    """Launch a headed CloakBrowser persistent context at `profile_dir`.

    Deliberately avoids injecting user_agent / locale / args / viewport so the
    browser presents naturally. Returns the raw context object. Registered for
    cleanup by close_all().
    """
    cloakbrowser = _import_cloakbrowser()

    os.makedirs(profile_dir, exist_ok=True)

    try:
        context = cloakbrowser.launch_persistent_context(
            profile_dir,
            headless=False,
            user_agent=None,
            locale=None,
            args=None,
        )
    except Exception as exc:  # pragma: no cover - depends on live env
        raise BrowserLaunchError("cloakbrowser_launch_failed: %s" % type(exc).__name__)

    with _LOCK:
        _OPEN_CONTEXTS.append(context)
    return context


def open_shopee_custom_link(profile_dir: str) -> Dict[str, Optional[str]]:
    """Open (or reuse) a persistent context and navigate to the Shopee
    custom-link page. Returns a safe dict with `currentUrl` when resolvable.

    No autofill, no keychain, no secrets.
    """
    context = launch_persistent_context(profile_dir)

    current_url: Optional[str] = None
    try:
        page = _first_page(context)
        if page is not None:
            try:
                page.goto(SHOPEE_CUSTOM_LINK_URL)
            except Exception:  # pragma: no cover - navigation best-effort
                pass
            current_url = _safe_current_url(page)
    except Exception:  # pragma: no cover - never leak internals
        current_url = None

    return {
        "profileDir": profile_dir,
        "targetUrl": SHOPEE_CUSTOM_LINK_URL,
        "currentUrl": current_url,
    }


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
