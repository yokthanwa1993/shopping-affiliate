from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import mcp_server


def _capture():
    """Return (calls, http_get) that records URLs and echoes a canned reply."""
    calls = []

    def http_get(url):
        calls.append(url)
        return {"status": "ok", "echo": url}

    return calls, http_get


def _parse(url):
    parsed = urlparse(url)
    query = {k: v[0] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
    return parsed.scheme, parsed.netloc, parsed.path, query


class BridgeUrlTests(unittest.TestCase):
    def test_default_bridge_base_url(self) -> None:
        self.assertEqual(
            "http://127.0.0.1:8810", mcp_server.bridge_base_url({})
        )

    def test_env_overrides_bridge_base_url_and_strips_slash(self) -> None:
        env = {"AFFILIATE_SHORTLINK_BRIDGE_URL": "http://127.0.0.1:9999/"}
        self.assertEqual(
            "http://127.0.0.1:9999", mcp_server.bridge_base_url(env)
        )

    def test_build_bridge_url_drops_empty_and_none_but_keeps_zero(self) -> None:
        url = mcp_server.build_bridge_url(
            "http://127.0.0.1:8810",
            "/click-report",
            {"id": "15130770000", "sub_id": "", "missing": None, "page": 0},
        )
        _scheme, netloc, path, query = _parse(url)
        self.assertEqual("127.0.0.1:8810", netloc)
        self.assertEqual("/click-report", path)
        self.assertEqual({"id": "15130770000", "page": "0"}, query)

    def test_build_bridge_url_without_params_has_no_query(self) -> None:
        url = mcp_server.build_bridge_url("http://127.0.0.1:8810", "/health", {})
        self.assertEqual("http://127.0.0.1:8810/health", url)


class ToolUrlConstructionTests(unittest.TestCase):
    def test_health_and_accounts_paths(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_health(env={}, http_get=getter)
        mcp_server.tool_accounts(env={}, http_get=getter)
        self.assertEqual("http://127.0.0.1:8810/health", calls[0])
        self.assertEqual("http://127.0.0.1:8810/accounts", calls[1])

    def test_create_shortlink_drops_blank_subs(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_create_shopee_shortlink(
            "https://shopee.co.th/product/1/2",
            id="15142270000",
            sub1="camp",
            sub3="page",
            env={},
            http_get=getter,
        )
        _s, _n, path, query = _parse(calls[0])
        self.assertEqual("/shorten", path)
        self.assertEqual("15142270000", query["id"])
        self.assertEqual("https://shopee.co.th/product/1/2", query["url"])
        self.assertEqual("camp", query["sub1"])
        self.assertEqual("page", query["sub3"])
        self.assertNotIn("sub2", query)
        self.assertNotIn("sub4", query)

    def test_conversion_report_raw_flag_and_filters(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_get_conversion_report(
            id="15130770000",
            time="yesterday",
            raw=True,
            page=2,
            page_size=50,
            sub_id="abc",
            order_id="OID",
            env={},
            http_get=getter,
        )
        _s, _n, path, query = _parse(calls[0])
        self.assertEqual("/conversion-report", path)
        self.assertEqual("1", query["raw"])
        self.assertEqual("yesterday", query["time"])
        self.assertEqual("2", query["page"])
        self.assertEqual("50", query["page_size"])
        self.assertEqual("abc", query["sub_id"])
        self.assertEqual("OID", query["order_id"])
        self.assertNotIn("checkout_id", query)

    def test_conversion_report_summary_has_no_raw(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_get_conversion_report(env={}, http_get=getter)
        _s, _n, _p, query = _parse(calls[0])
        self.assertNotIn("raw", query)

    def test_daily_income_prefers_ids_over_id(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_get_daily_income_report(
            ids="15130770000,15142270000", env={}, http_get=getter
        )
        _s, _n, path, query = _parse(calls[0])
        self.assertEqual("/daily-income-report", path)
        self.assertEqual("15130770000,15142270000", query["ids"])
        self.assertNotIn("id", query)

    def test_daily_income_defaults_to_chearb_id(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_get_daily_income_report(env={}, http_get=getter)
        _s, _n, _p, query = _parse(calls[0])
        self.assertEqual("15130770000", query["id"])
        self.assertNotIn("ids", query)

    def test_click_report_preserves_sub_id(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_get_click_report(
            sub_id="16JUN26FBSPCAD", env={}, http_get=getter
        )
        _s, _n, path, query = _parse(calls[0])
        self.assertEqual("/click-report", path)
        self.assertEqual("16JUN26FBSPCAD", query["sub_id"])


class LoginMappingTests(unittest.TestCase):
    def test_map_login_account_known_ids(self) -> None:
        self.assertEqual(
            "affiliate_chearb.com", mcp_server.map_login_account("15130770000")
        )
        self.assertEqual(
            "affiliate_neezs.com", mcp_server.map_login_account("an_15142270000")
        )

    def test_map_login_account_unknown_is_none(self) -> None:
        self.assertIsNone(mcp_server.map_login_account("99999999999"))

    def test_open_manual_login_builds_expected_query(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_open_manual_login(id="15142270000", env={}, http_get=getter)
        _s, _n, path, query = _parse(calls[0])
        self.assertEqual("/login", path)
        self.assertEqual("1", query["json"])
        self.assertEqual("shopee", query["platform"])
        self.assertEqual("affiliate_neezs.com", query["account"])
        self.assertEqual("1", query["noAutofill"])
        self.assertEqual("0", query["autofill"])

    def test_open_manual_login_autofill_toggle(self) -> None:
        calls, getter = _capture()
        mcp_server.tool_open_manual_login(
            id="15130770000", no_autofill=False, env={}, http_get=getter
        )
        _s, _n, _p, query = _parse(calls[0])
        self.assertEqual("0", query["noAutofill"])
        self.assertEqual("1", query["autofill"])

    def test_open_manual_login_unknown_id_fails_without_bridge_call(self) -> None:
        calls, getter = _capture()
        result = mcp_server.tool_open_manual_login(
            id="00000000000", env={}, http_get=getter
        )
        self.assertEqual([], calls)
        self.assertEqual("unknown_shopee_id", result["error"])
        self.assertEqual("00000000000", result["id"])


class RedactionTests(unittest.TestCase):
    def test_redact_secret_keys_recursively(self) -> None:
        payload = {
            "status": "ok",
            "access_token": "EAAB-secret",
            "id": "15130770000",
            "nested": {
                "cookie": "SPC_EC=abc; csrftoken=xyz",
                "csrf_token": "deadbeef",
                "safe": "keep-me",
            },
            "rows": [
                {"session_id": "s1", "sub_id": "camp"},
                {"password": "hunter2", "count": 3},
            ],
        }
        cleaned = mcp_server.redact(payload)
        self.assertEqual("[REDACTED]", cleaned["access_token"])
        self.assertEqual("15130770000", cleaned["id"])
        self.assertEqual("[REDACTED]", cleaned["nested"]["cookie"])
        self.assertEqual("[REDACTED]", cleaned["nested"]["csrf_token"])
        self.assertEqual("keep-me", cleaned["nested"]["safe"])
        self.assertEqual("[REDACTED]", cleaned["rows"][0]["session_id"])
        self.assertEqual("camp", cleaned["rows"][0]["sub_id"])
        self.assertEqual("[REDACTED]", cleaned["rows"][1]["password"])
        self.assertEqual(3, cleaned["rows"][1]["count"])

    def test_redact_scrubs_cookie_fragments_in_string_values(self) -> None:
        payload = {
            "reason": "boom cookie: SPC_EC=leaked; csrftoken=leaked2",
        }
        cleaned = mcp_server.redact(payload)
        self.assertIn("[REDACTED]", cleaned["reason"])
        self.assertNotIn("leaked", cleaned["reason"])

    def test_call_bridge_redacts_response(self) -> None:
        def getter(url):
            return {"status": "ok", "access_token": "top-secret", "id": "1"}

        result = mcp_server.call_bridge("/health", {}, env={}, http_get=getter)
        self.assertEqual("[REDACTED]", result["access_token"])
        self.assertEqual("1", result["id"])


class _CannedHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - stdlib signature
        parsed = urlparse(self.path)
        self.server.hits.append(parsed.path)  # type: ignore[attr-defined]
        routes = {
            "/health": (200, {"status": "ok", "app": "bridge"}),
            "/accounts": (200, {"status": "ok", "count": 2}),
            "/shorten": (200, {
                "status": "ok",
                "shortLink": "https://s.shopee.co.th/abc",
                "access_token": "should-be-hidden",
            }),
            "/conversion-report": (200, {"status": "ok", "total_count": 5}),
            "/daily-income-report": (200, {"status": "ok", "totals": {}}),
            "/click-report": (200, {"status": "ok", "total_count": 9}),
            "/login": (503, {
                "status": "manual_login_required",
                "manualLoginRequired": True,
                "reason": "shopee_login_required",
                "loginUi": "/login?platform=shopee",
                "cookie": "SPC_EC=secret",
            }),
        }
        status, body = routes.get(parsed.path, (404, {"status": "error"}))
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):  # noqa: D401 - silence test server logs
        return


class FakeBridgeServerTests(unittest.TestCase):
    def setUp(self) -> None:
        try:
            self.httpd = HTTPServer(("127.0.0.1", 0), _CannedHandler)
        except PermissionError as exc:
            self.skipTest("loopback bind unavailable in this sandbox: %s" % exc)
        self.httpd.hits = []  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.httpd.server_address
        self.env = {"AFFILIATE_SHORTLINK_BRIDGE_URL": "http://%s:%d" % (host, port)}

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def test_health_over_real_http(self) -> None:
        result = mcp_server.tool_health(env=self.env)
        self.assertEqual("ok", result["status"])
        self.assertEqual("bridge", result["app"])

    def test_accounts_over_real_http(self) -> None:
        result = mcp_server.tool_accounts(env=self.env)
        self.assertEqual(2, result["count"])

    def test_shortlink_over_real_http_redacts_token(self) -> None:
        result = mcp_server.tool_create_shopee_shortlink(
            "https://shopee.co.th/product/1/2", env=self.env
        )
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])
        self.assertEqual("[REDACTED]", result["access_token"])

    def test_conversion_and_click_and_income_over_real_http(self) -> None:
        conv = mcp_server.tool_get_conversion_report(env=self.env)
        self.assertEqual(5, conv["total_count"])
        click = mcp_server.tool_get_click_report(env=self.env)
        self.assertEqual(9, click["total_count"])
        income = mcp_server.tool_get_daily_income_report(env=self.env)
        self.assertEqual("ok", income["status"])

    def test_manual_login_passthrough_without_retry(self) -> None:
        result = mcp_server.tool_open_manual_login(id="15130770000", env=self.env)
        self.assertEqual("manual_login_required", result["status"])
        self.assertTrue(result["manualLoginRequired"])
        self.assertEqual("/login?platform=shopee", result["loginUi"])
        self.assertEqual(503, result["httpStatus"])
        self.assertEqual("[REDACTED]", result["cookie"])
        # Exactly one request to /login: the MCP server must not hammer Shopee.
        self.assertEqual(["/login"], self.httpd.hits)  # type: ignore[attr-defined]

    def test_bridge_unreachable_fails_closed(self) -> None:
        env = {"AFFILIATE_SHORTLINK_BRIDGE_URL": "http://127.0.0.1:1"}
        result = mcp_server.tool_health(env=env)
        self.assertEqual("error", result["status"])
        self.assertEqual("bridge_unreachable", result["error"])


if __name__ == "__main__":
    unittest.main()
