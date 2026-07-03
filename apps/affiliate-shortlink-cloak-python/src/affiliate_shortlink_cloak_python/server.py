"""Stdlib HTTP server for the Python CloakBrowser prototype."""

from __future__ import annotations

import json
import os
import socket
import sys
from dataclasses import dataclass
from html import escape as html_escape
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Dict, Mapping, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from . import (
    APP_NAME,
    BACKEND,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_PROFILE_ROOT,
    SHOPEE_CUSTOM_LINK_URL,
    __version__,
)
from .accounts import list_accounts, profile_dir_for, resolve_account
from .click_report import handle_click_report, is_click_report_host
from .conversion_report import (
    handle_conversion_report,
    handle_daily_income_report,
    is_conversion_report_host,
)
from .report_common import ReportRequestError
from .report_common import sanitize_account as sanitize_derived_account
from .shopee import (
    ShopeeShortenError,
    sanitize_error_message,
    sub_ids_from_query,
)


@dataclass(frozen=True)
class ServerConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    profile_root: str = DEFAULT_PROFILE_ROOT


def load_config(environ: Optional[Mapping[str, str]] = None) -> ServerConfig:
    env = os.environ if environ is None else environ
    return ServerConfig(
        host=env.get("HOST", DEFAULT_HOST),
        port=int(env.get("PORT", str(DEFAULT_PORT))),
        profile_root=os.path.expanduser(
            env.get("PROFILE_ROOT", DEFAULT_PROFILE_ROOT)
        ),
    )


def json_bytes(payload: Mapping[str, object]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def health_payload(config: ServerConfig) -> Dict[str, object]:
    return {
        "status": "ok",
        "app": APP_NAME,
        "version": __version__,
        "backend": BACKEND,
        "host": config.host,
        "port": config.port,
        "profileRoot": config.profile_root,
        "shopeeCustomLinkUrl": SHOPEE_CUSTOM_LINK_URL,
    }


def accounts_payload(config: ServerConfig) -> Dict[str, object]:
    accounts = list_accounts()
    return {
        "status": "ok",
        "accounts": accounts,
        "count": len(accounts),
        "profileRoot": config.profile_root,
    }


def error_payload(error: str, **fields: object) -> Dict[str, object]:
    payload: Dict[str, object] = {"status": "error", "error": error}
    payload.update(fields)
    return payload


def first_query_value(query: Mapping[str, object],
                      key: str,
                      default: str = "") -> str:
    value = query.get(key)
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        value = value[0] if value else default
    text = str(value).strip()
    return text if text else default


def validate_login_query(
    query: Mapping[str, object],
    config: ServerConfig,
) -> Tuple[int, Dict[str, object]]:
    platform = first_query_value(query, "platform", "shopee").lower()
    if platform != "shopee":
        return 400, error_payload(
            "unsupported_platform",
            platform=platform,
            supported=["shopee"],
        )

    resolution = resolve_account(
        shopee_id=first_query_value(query, "id"),
        account=first_query_value(query, "account"),
    )
    if not resolution["ok"]:
        return 400, error_payload(
            str(resolution["error"]),
            conflict=bool(resolution["conflict"]),
        )

    record = resolution["record"]
    assert isinstance(record, dict)
    profile_dir = profile_dir_for(config.profile_root, platform, record["account"])
    return 200, {
        "platform": platform,
        "record": record,
        "profileDir": profile_dir,
    }


def validate_shorten_query(
    query: Mapping[str, object],
    config: ServerConfig,
) -> Tuple[int, Dict[str, object]]:
    raw_url = first_query_value(query, "url")
    if not _is_valid_http_url(raw_url):
        return 400, error_payload("invalid_url")

    status, payload = validate_login_query(query, config)
    if status != 200:
        return status, payload

    payload = dict(payload)
    payload["url"] = raw_url
    payload["subIds"] = sub_ids_from_query(query)
    return 200, payload


def _is_valid_http_url(raw_url: str) -> bool:
    parsed = urlparse(raw_url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _compat_body_value(body: Mapping[str, object], key: str, default: str = "") -> str:
    value = body.get(key) if isinstance(body, Mapping) else None
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        value = value[0] if value else default
    return str(value).strip()


def _compat_platform(value: object, default: str = "shopee") -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        raw = default
    return raw if raw in {"shopee", "lazada"} else ""


def _derive_account_from_body(body: Mapping[str, object]) -> str:
    raw_account = _compat_body_value(body, "account")
    if raw_account:
        return sanitize_derived_account(raw_account)
    username = _compat_body_value(body, "username")
    if username:
        return sanitize_derived_account(username)
    return ""


def _redact_body_secrets(value: object, body: Mapping[str, object]) -> str:
    text = sanitize_error_message(value)
    for key in ("username", "password"):
        secret = _compat_body_value(body, key)
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text


def login_ui_html(query: Mapping[str, object]) -> str:
    raw_url = first_query_value(query, "url")
    raw_platform = first_query_value(query, "platform").lower()
    if not raw_platform:
        raw_platform = "lazada" if "lazada." in raw_url.lower() else "shopee"
    platform = _compat_platform(raw_platform) or "shopee"
    account = first_query_value(query, "account")
    shopee_id = first_query_value(query, "id")
    hidden = {
        "platform": platform,
        "account": account,
        "id": shopee_id,
        "url": raw_url,
        "sub1": first_query_value(query, "sub1"),
        "sub2": first_query_value(query, "sub2"),
        "sub3": first_query_value(query, "sub3"),
        "sub4": first_query_value(query, "sub4"),
        "sub5": first_query_value(query, "sub5"),
    }
    hidden_inputs = "\n".join(
        '<input type="hidden" name="%s" value="%s">'
        % (html_escape(key, quote=True), html_escape(value, quote=True))
        for key, value in hidden.items()
        if value
    )
    context = account or shopee_id or "default"
    return "\n".join([
        "<!doctype html>",
        '<html lang="en"><head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        "<title>Login &amp; Shorten</title>",
        "<style>",
        "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:24px;max-width:560px}",
        "label{display:block;margin:12px 0 4px;font-weight:600}",
        "input{box-sizing:border-box;width:100%;padding:9px 10px}",
        "button{margin-top:14px;padding:10px 14px}",
        ".ctx{background:#f6f8fa;padding:10px;border-radius:6px}",
        "</style>",
        "</head><body>",
        "<h1>Login &amp; Shorten</h1>",
        '<p class="ctx">platform <code>%s</code> · account <code>%s</code></p>'
        % (html_escape(platform), html_escape(context)),
        '<form method="post" action="/api/login-and-shorten" autocomplete="off">',
        hidden_inputs,
        '<label for="username">Username</label>',
        '<input id="username" name="username" autocomplete="off">',
        '<label for="password">Password</label>',
        '<input id="password" name="password" type="password" autocomplete="new-password">',
        '<label><input name="remember" type="checkbox" value="1"> Remember credential if supported</label>',
        '<button type="submit">Shorten</button>',
        "</form>",
        '<script>',
        'document.querySelector("form").addEventListener("submit",function(ev){',
        'ev.preventDefault();var fd=new FormData(ev.target);var body={};',
        'fd.forEach(function(v,k){body[k]=String(v);});',
        'fetch("/api/login-and-shorten",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})',
        '.then(function(r){return r.json().then(function(j){document.body.appendChild(document.createElement("pre")).textContent=JSON.stringify(j,null,2);});});',
        '});',
        '</script>',
        "</body></html>",
    ])


def handle_login_compatibility(body: Mapping[str, object]) -> Tuple[int, Dict[str, object]]:
    platform = _compat_platform(_compat_body_value(body, "platform"))
    if not platform:
        return 400, error_payload(
            "unsupported_platform",
            supported=["shopee", "lazada"],
        )
    remember = _compat_body_value(body, "remember", "1").lower() not in {
        "0",
        "false",
        "no",
        "off",
    }
    account = _derive_account_from_body(body)
    payload = error_payload(
        "credential_storage_not_implemented",
        reason="credential_storage_not_implemented",
        message=(
            "Python sidecar does not store credentials. Open /login for manual "
            "session recovery, then retry the shortlink/report route."
        ),
        platform=platform,
        credential={
            "saved": False,
            "requested": remember,
            "status": "credential_storage_not_implemented",
        },
        loginUi="/login?platform=%s" % platform,
    )
    if account:
        payload["account"] = account
    return 501, payload


def _shorten_query_from_login_body(body: Mapping[str, object]) -> Dict[str, object]:
    query: Dict[str, object] = {}
    for key in ("id", "url", "sub1", "sub2", "sub3", "sub4", "sub5"):
        value = _compat_body_value(body, key)
        if value:
            query[key] = [value]
    account = _derive_account_from_body(body)
    if account:
        query["account"] = [account]
    return query


def handle_login_and_shorten_compatibility(
    body: Mapping[str, object],
    config: ServerConfig,
) -> Tuple[int, Dict[str, object]]:
    platform = _compat_platform(_compat_body_value(body, "platform"))
    if platform != "shopee":
        return 400, error_payload(
            "unsupported_platform",
            platform=platform or _compat_body_value(body, "platform") or "",
            supported=["shopee"],
        )

    query = _shorten_query_from_login_body(body)
    status, payload = handle_shorten(query, config)
    if status == 200:
        return 200, {
            "status": "ok",
            "platform": "shopee",
            "account": payload.get("account"),
            "shorten": payload,
        }
    out = dict(payload)
    out.setdefault("status", "error")
    out.setdefault("error", out.get("reason") or "shorten_failed")
    out["platform"] = "shopee"
    return status, out


def handle_login(query: Mapping[str, object],
                 config: ServerConfig) -> Tuple[int, Dict[str, object]]:
    status, payload = validate_login_query(query, config)
    if status != 200:
        return status, payload

    from .browser import BrowserLaunchError, open_shopee_custom_link

    try:
        browser_info = open_shopee_custom_link(str(payload["profileDir"]))
    except BrowserLaunchError as exc:
        return 503, error_payload("browser_launch_failed", reason=str(exc))

    record = payload["record"]
    assert isinstance(record, dict)
    return 200, {
        "status": "ok",
        "platform": payload["platform"],
        "id": record["id"],
        "account": record["account"],
        "display": record["display"],
        "utm_source": record["utm_source"],
        "profileDir": payload["profileDir"],
        "browser": browser_info,
    }



def _utm_content_from_long_link(long_link: object) -> str:
    try:
        parsed = urlparse(str(long_link or ""))
        return parse_qs(parsed.query).get("utm_content", [""])[0] or ""
    except Exception:
        return ""


def build_legacy_success_payload(
    record: Mapping[str, object],
    original_url: str,
    shorten_info: Mapping[str, object],
) -> Dict[str, object]:
    short_link = str(shorten_info.get("shortLink") or "")
    long_link = str(shorten_info.get("longLink") or "") or short_link
    utm_content = _utm_content_from_long_link(long_link)
    sub_parts = utm_content.split("-")
    return {
        "link": short_link,
        "longLink": long_link,
        "originalLink": str(shorten_info.get("originalLink") or original_url),
        "shortLink": short_link,
        "id": record["id"],
        "utm_source": record["utm_source"],
        "utm_content": utm_content,
        "account": record["account"],
        "sub1": (sub_parts[0] if len(sub_parts) > 0 else "") or "",
        "sub2": (sub_parts[1] if len(sub_parts) > 1 else "") or "",
        "sub3": (sub_parts[2] if len(sub_parts) > 2 else "") or "",
        "sub4": (sub_parts[3] if len(sub_parts) > 3 else "") or "",
        "sub5": (sub_parts[4] if len(sub_parts) > 4 else "") or "",
    }

def handle_shorten(query: Mapping[str, object],
                   config: ServerConfig) -> Tuple[int, Dict[str, object]]:
    status, payload = validate_shorten_query(query, config)
    if status != 200:
        return status, payload

    from .browser import BrowserLaunchError, shorten_shopee_link

    record = payload["record"]
    assert isinstance(record, dict)
    url = str(payload["url"])
    profile_dir = str(payload["profileDir"])
    try:
        shorten_info = shorten_shopee_link(
            profile_dir,
            url,
            payload.get("subIds") or [],
        )
    except BrowserLaunchError as exc:
        return 503, shorten_fail_closed_payload(
            record,
            profile_dir,
            reason=sanitize_error_message(exc),
            manual_login_required=False,
        )
    except ShopeeShortenError as exc:
        return (503 if exc.manual_login_required else 502), (
            shorten_fail_closed_payload(
                record,
                profile_dir,
                reason=exc.reason,
                current_url=exc.current_url,
                manual_login_required=exc.manual_login_required,
                diagnostic=sanitize_error_message(exc),
            )
        )

    return 200, build_legacy_success_payload(record, url, shorten_info)


def shorten_fail_closed_payload(
    record: Mapping[str, object],
    profile_dir: str,
    reason: object,
    current_url: Optional[str] = None,
    manual_login_required: bool = True,
    diagnostic: object = None,
) -> Dict[str, object]:
    safe_reason = sanitize_error_message(reason) or "shorten_failed"
    payload = {
        "status": (
            "manual_login_required" if manual_login_required else "error"
        ),
        "error": safe_reason,
        "manualLoginRequired": bool(manual_login_required),
        "needsManual": bool(manual_login_required),
        "reason": safe_reason,
        "currentUrl": current_url,
        "id": record["id"],
        "account": record["account"],
        "display": record["display"],
        "utm_source": record["utm_source"],
        "profileDir": profile_dir,
        "browser": {
            "profileDir": profile_dir,
            "targetUrl": SHOPEE_CUSTOM_LINK_URL,
            "currentUrl": current_url,
        },
    }
    if diagnostic:
        payload["diagnostic"] = sanitize_error_message(diagnostic)
    return payload


def make_report_fetcher(config: ServerConfig):
    """Build a ``fetch(account, api_url)`` bound to the per-account Shopee
    CloakBrowser profile. Imported lazily so the report modules stay
    browser-free and unit-testable without CloakBrowser installed."""

    def fetch(account: str, api_url: str) -> Mapping[str, object]:
        from .browser import fetch_shopee_report_json

        profile_dir = profile_dir_for(config.profile_root, "shopee", account)
        return fetch_shopee_report_json(profile_dir, api_url)

    return fetch


def _report_route(handler) -> Tuple[int, Dict[str, object]]:
    """Run a report handler, mapping validation failures to safe HTTP payloads."""
    try:
        return 200, handler()
    except ReportRequestError as exc:
        return exc.status_code, dict(exc.public_payload)


def handle_conversion_report_route(
    query: Mapping[str, object], config: ServerConfig
) -> Tuple[int, Dict[str, object]]:
    fetch = make_report_fetcher(config)
    return _report_route(lambda: handle_conversion_report(query, fetch=fetch))


def handle_daily_income_report_route(
    query: Mapping[str, object], config: ServerConfig
) -> Tuple[int, Dict[str, object]]:
    fetch = make_report_fetcher(config)
    return _report_route(lambda: handle_daily_income_report(query, fetch=fetch))


def handle_click_report_route(
    query: Mapping[str, object], config: ServerConfig
) -> Tuple[int, Dict[str, object]]:
    fetch = make_report_fetcher(config)
    return _report_route(lambda: handle_click_report(query, fetch=fetch))


class PrototypeHTTPServer(HTTPServer):

    def __init__(self, server_address, handler_class, config: ServerConfig):
        super().__init__(server_address, handler_class)
        self.config = config


class IPv6PrototypeHTTPServer(PrototypeHTTPServer):
    address_family = socket.AF_INET6


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "affiliate-shortlink-cloak-python/0.0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        config = self.server.config
        headers = getattr(self, "headers", None)
        host_header = headers.get("Host", "") if headers else ""
        path = parsed.path
        is_root = path in {"", "/"}

        if path == "/conversion-report" or (is_root and is_conversion_report_host(host_header)):
            status, payload = handle_conversion_report_route(query, config)
        elif path in {"/daily-income-report", "/income-report"}:
            status, payload = handle_daily_income_report_route(query, config)
        elif path == "/click-report" or (is_root and is_click_report_host(host_header)):
            status, payload = handle_click_report_route(query, config)
        elif is_root and ("url" in query or "id" in query):
            status, payload = handle_shorten(query, config)
        elif is_root:
            status, payload = 200, health_payload(config)
        elif path == "/health":
            status, payload = 200, health_payload(config)
        elif path == "/accounts":
            status, payload = 200, accounts_payload(config)
        elif path == "/login-ui":
            self._write_html(200, login_ui_html(query))
            return
        elif path == "/login/shopee":
            self._redirect("/login?platform=shopee")
            return
        elif path == "/login/lazada":
            self._redirect("/login?platform=lazada")
            return
        elif path == "/login":
            status, payload = handle_login(query, config)
        elif path == "/shorten":
            status, payload = handle_shorten(query, config)
        else:
            status, payload = 404, error_payload("not_found", path=parsed.path)

        self._write_json(status, payload)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        config = self.server.config

        if path not in {"/api/login", "/api/login-and-shorten"}:
            self._write_json(404, error_payload("not_found", path=parsed.path))
            return

        try:
            body = self._read_json_body()
        except ValueError as exc:
            self._write_json(
                400,
                error_payload(
                    "invalid_json",
                    reason="invalid_json",
                    message=sanitize_error_message(exc),
                ),
            )
            return

        try:
            if path == "/api/login":
                status, payload = handle_login_compatibility(body)
            else:
                status, payload = handle_login_and_shorten_compatibility(body, config)
        except Exception as exc:  # noqa: BLE001 - fail closed and redact submitted secrets
            status, payload = 400, error_payload(
                "compatibility_route_failed",
                reason=_redact_body_secrets(exc, body),
            )
        self._write_json(status, payload)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(
            "[affiliate-shortlink-cloak-python] %s\n" % (fmt % args)
        )

    def _write_json(self, status: int, payload: Mapping[str, object]) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_html(self, status: int, html: str) -> None:
        body = str(html).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_json_body(self) -> Dict[str, object]:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length or "0")
        except (TypeError, ValueError):
            length = 0
        if length < 0 or length > 1024 * 1024:
            raise ValueError("json_body_too_large")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid_json_body") from exc
        if not isinstance(body, dict):
            raise ValueError("json_body_must_be_object")
        return body


def make_server(config: ServerConfig) -> PrototypeHTTPServer:
    server_class = IPv6PrototypeHTTPServer if ":" in config.host else PrototypeHTTPServer
    return server_class((config.host, config.port), RequestHandler, config)


def main() -> None:
    config = load_config()
    httpd = make_server(config)
    print(
        "%s listening on http://%s:%s"
        % (APP_NAME, config.host, config.port),
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        from .browser import close_all

        close_all()
        httpd.server_close()


if __name__ == "__main__":
    main()
