"""Stdlib HTTP server for the Python CloakBrowser prototype."""

from __future__ import annotations

import json
import os
import socket
import sys
from dataclasses import dataclass
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
        elif path == "/login":
            status, payload = handle_login(query, config)
        elif path == "/shorten":
            status, payload = handle_shorten(query, config)
        else:
            status, payload = 404, error_payload("not_found", path=parsed.path)

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
