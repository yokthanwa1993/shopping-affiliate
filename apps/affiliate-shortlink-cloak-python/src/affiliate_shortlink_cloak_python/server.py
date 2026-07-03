"""Stdlib HTTP server for the Python CloakBrowser shortlink prototype.

No FastAPI / third-party web framework — `http.server` only. Run with:

    PYTHONPATH=src python3 -m affiliate_shortlink_cloak_python.server

Binds 127.0.0.1:8811 by default. Does not touch the production Node service
on 8810. `cloakbrowser` is only imported when a browser is actually launched.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from . import (
    APP_NAME,
    BACKEND,
    DEFAULT_HOST,
    DEFAULT_PORT,
    __version__,
)
from . import accounts as accounts_mod

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def default_profile_root() -> str:
    return os.path.expanduser(
        os.environ.get(
            "PROFILE_ROOT",
            os.path.join("~", ".affiliate-shortlink-cloak-python", "profiles"),
        )
    )


def resolve_host() -> str:
    return os.environ.get("HOST", DEFAULT_HOST)


def resolve_port() -> int:
    raw = os.environ.get("PORT", str(DEFAULT_PORT))
    try:
        return int(raw)
    except (TypeError, ValueError):
        return DEFAULT_PORT


# In-memory runtime state — which accounts have had a login window opened this
# process. No secrets/cookies, just booleans + last-seen url.
_RUNTIME_STATE: Dict[str, Dict[str, object]] = {}


def _record_runtime(account: str, current_url: Optional[str]) -> None:
    entry = _RUNTIME_STATE.setdefault(account, {"loginOpened": False, "opens": 0})
    entry["loginOpened"] = True
    entry["opens"] = int(entry.get("opens", 0)) + 1
    entry["lastUrl"] = current_url


def loaded_runtime_state() -> Dict[str, Dict[str, object]]:
    """Safe snapshot of runtime state for /accounts and /health."""
    return {acct: dict(info) for acct, info in _RUNTIME_STATE.items()}


def loaded_count() -> int:
    return len(_RUNTIME_STATE)


# ---------------------------------------------------------------------------
# Pure handler helpers — return (status_code, body_dict). No browser needed.
# ---------------------------------------------------------------------------

def build_health(profile_root: str, port: int) -> Tuple[int, Dict[str, object]]:
    return 200, {
        "status": "ok",
        "app": APP_NAME,
        "backend": BACKEND,
        "version": __version__,
        "port": port,
        "loaded": loaded_count(),
        "profileRoot": profile_root,
    }


def build_accounts(profile_root: str) -> Tuple[int, Dict[str, object]]:
    return 200, {
        "app": APP_NAME,
        "backend": BACKEND,
        "profileRoot": profile_root,
        "known": accounts_mod.list_accounts(),
        "loaded": loaded_count(),
        "runtime": loaded_runtime_state(),
    }


def validate_shorten(params: Dict[str, str]) -> Tuple[bool, Dict[str, object]]:
    """Validate /shorten inputs against known aliases. Pure — no browser.

    Returns (ok, detail). `detail` carries either an `error` reason or the
    resolved `record` plus echoed id/url.
    """
    link_id = (params.get("id") or "").strip()
    url = (params.get("url") or "").strip()
    account = (params.get("account") or "").strip() or None

    if not link_id:
        return False, {"error": "missing_id"}
    if not url:
        return False, {"error": "missing_url"}
    if not (url.startswith("http://") or url.startswith("https://")):
        return False, {"error": "invalid_url"}

    resolution = accounts_mod.resolve_account(shopee_id=link_id, account=account)
    if not resolution["ok"]:
        return False, {
            "error": resolution["error"],
            "conflict": resolution["conflict"],
        }

    return True, {
        "record": resolution["record"],
        "id": link_id,
        "url": url,
    }


# ---------------------------------------------------------------------------
# Browser-backed handlers (import cloakbrowser lazily via browser module).
# ---------------------------------------------------------------------------

def handle_login(profile_root: str, params: Dict[str, str]) -> Tuple[int, Dict[str, object]]:
    platform = (params.get("platform") or "shopee").strip() or "shopee"
    account = (params.get("account") or "").strip()

    resolution = accounts_mod.resolve_account(account=account)
    if not resolution["ok"]:
        return 400, {
            "status": "invalid_account",
            "app": APP_NAME,
            "platform": platform,
            "account": account or None,
            "error": resolution["error"],
        }

    record = resolution["record"]
    resolved_account = record["account"]
    profile_dir = accounts_mod.profile_dir_for(profile_root, platform, resolved_account)

    # Lazy import so a missing/broken browser can't crash the process.
    from . import browser as browser_mod

    try:
        result = browser_mod.open_shopee_custom_link(profile_dir)
    except browser_mod.BrowserLaunchError as exc:
        return 503, {
            "status": "browser_unavailable",
            "app": APP_NAME,
            "platform": platform,
            "account": resolved_account,
            "profileDir": profile_dir,
            "error": str(exc),
        }

    _record_runtime(resolved_account, result.get("currentUrl"))

    return 200, {
        "status": "login_window_opened",
        "app": APP_NAME,
        "platform": platform,
        "account": resolved_account,
        "display": record["display"],
        "profileDir": profile_dir,
        "targetUrl": result.get("targetUrl"),
        "currentUrl": result.get("currentUrl"),
    }


def handle_shorten(profile_root: str, params: Dict[str, str]) -> Tuple[int, Dict[str, object]]:
    ok, detail = validate_shorten(params)
    if not ok:
        return 400, {
            "status": "invalid_request",
            "app": APP_NAME,
            **detail,
        }

    record = detail["record"]
    account = record["account"]
    platform = (params.get("platform") or "shopee").strip() or "shopee"
    profile_dir = accounts_mod.profile_dir_for(profile_root, platform, account)

    # Best-effort open of the context; real Shopee shorten is NOT implemented.
    current_url: Optional[str] = None
    browser_error: Optional[str] = None
    from . import browser as browser_mod

    try:
        result = browser_mod.open_shopee_custom_link(profile_dir)
        current_url = result.get("currentUrl")
        _record_runtime(account, current_url)
    except browser_mod.BrowserLaunchError as exc:
        browser_error = str(exc)

    return 200, {
        "status": "not_implemented_after_login",
        "app": APP_NAME,
        "platform": platform,
        "account": account,
        "utm_source": record["utm_source"],
        "id": detail["id"],
        "url": detail["url"],
        "profileDir": profile_dir,
        "currentUrl": current_url,
        "session": {
            "profileDir": profile_dir,
            "opened": browser_error is None,
        },
        "note": "Shopee GraphQL shorten not implemented in this prototype.",
        "browserError": browser_error,
    }


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

def _flatten(qs: Dict[str, List[str]]) -> Dict[str, str]:
    return {k: (v[0] if v else "") for k, v in qs.items()}


class CloakRequestHandler(BaseHTTPRequestHandler):
    server_version = "AffiliateShortlinkCloakPy/" + __version__

    # Silence default noisy logging; keep it minimal and safe.
    def log_message(self, fmt, *args):  # noqa: A003
        return

    def _send_json(self, status: int, body: Dict[str, object]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        params = _flatten(parse_qs(parsed.query))
        profile_root = self.server.profile_root  # type: ignore[attr-defined]
        port = self.server.server_address[1]

        if path == "/health":
            self._send_json(*build_health(profile_root, port))
        elif path == "/accounts":
            self._send_json(*build_accounts(profile_root))
        elif path == "/login":
            self._send_json(*handle_login(profile_root, params))
        elif path == "/shorten":
            self._send_json(*handle_shorten(profile_root, params))
        else:
            self._send_json(404, {"status": "not_found", "app": APP_NAME, "path": path})


class CloakServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int, profile_root: str):
        super().__init__((host, port), CloakRequestHandler)
        self.profile_root = profile_root


def make_server(host: Optional[str] = None,
                port: Optional[int] = None,
                profile_root: Optional[str] = None) -> CloakServer:
    host = host or resolve_host()
    port = port if port is not None else resolve_port()
    profile_root = profile_root or default_profile_root()
    os.makedirs(profile_root, exist_ok=True)
    return CloakServer(host, port, profile_root)


def main() -> None:
    server = make_server()
    host, port = server.server_address
    print(
        "[%s] listening on http://%s:%s  profileRoot=%s"
        % (APP_NAME, host, port, server.profile_root)
    )
    print("  prototype only — not production, does not touch port 8810")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down...")
    finally:
        try:
            from . import browser as browser_mod

            closed = browser_mod.close_all()
            if closed:
                print("closed %d browser context(s)" % closed)
        except Exception:
            pass
        server.server_close()


if __name__ == "__main__":
    main()
