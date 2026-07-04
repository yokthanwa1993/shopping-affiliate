"""Offline unit tests for the Stealth/nodriver report fetcher + backend routing.

No live Shopee / nodriver: the runtime is driven with fake browser/tab objects
(``_get_browser`` is patched to bypass the nodriver import) and the report
handlers keep using their injected ``fetch`` fake. These cover:

- ``make_report_fetcher`` routes to the Stealth fetcher under the stealth backend
  and to the CloakBrowser fetcher under the default backend.
- The Stealth report in-page expression + gate/coerce helpers (pure).
- ``_StealthRuntime._fetch_report`` normalization, login-gate fail-closed,
  sanitized fetch-failure, and the dead-browser relaunch/fail-closed lifecycle.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import (  # noqa: E402
    BACKEND_CLOAKBROWSER,
    BACKEND_STEALTH,
    server,
    stealth_backend,
)

AFFILIATE_URL = "https://affiliate.shopee.co.th/offer/custom_link"
REPORT_API = "https://affiliate.shopee.co.th/api/v3/report/list?page_num=1"

_REPORT_PAYLOAD = {
    "status": 200,
    "parsed": True,
    "body": {"code": 0, "data": {"list": [], "total_count": 0}},
    "snippet": "",
    "currentUrl": AFFILIATE_URL,
}


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class StealthReportExpressionTests(unittest.TestCase):
    def test_report_expression_is_credentialed_iife(self) -> None:
        expr = stealth_backend.build_in_page_report_expression(REPORT_API)
        self.assertTrue(expr.startswith("(async () => {"))
        self.assertTrue(expr.rstrip().endswith("})()"))
        # Runs from the affiliate origin with the session cookies.
        self.assertIn("credentials: 'include'", expr)
        # The api_url is JSON-embedded, never raw-interpolated.
        self.assertIn(json.dumps(REPORT_API), expr)
        # Returns the CloakBrowser-parity envelope, serialized as a JSON string.
        self.assertIn("JSON.stringify({ status: status, parsed: parsed", expr)
        # No static anti-fraud headers / secrets.
        self.assertNotIn("user-agent", expr.lower())

    def test_report_expression_embeds_safely(self) -> None:
        # A hostile api_url is embedded as a JSON string literal, not code.
        expr = stealth_backend.build_in_page_report_expression(
            "https://x/api\"});fetch('evil')//"
        )
        self.assertIn(json.dumps("https://x/api\"});fetch('evil')//"), expr)


class ReportGateHelperTests(unittest.TestCase):
    def test_affiliate_origin_is_not_a_gate(self) -> None:
        self.assertFalse(stealth_backend.report_url_is_login_gate(AFFILIATE_URL))
        self.assertFalse(
            stealth_backend.report_url_is_login_gate(AFFILIATE_URL + "?foo=1")
        )

    def test_login_and_captcha_are_gates(self) -> None:
        for url in (
            "https://affiliate.shopee.co.th/login",
            "https://shopee.co.th/buyer/login?next=x",
            "https://affiliate.shopee.co.th/captcha",
        ):
            self.assertTrue(stealth_backend.report_url_is_login_gate(url), url)

    def test_off_affiliate_origin_is_a_gate(self) -> None:
        # Unlike the shortlink path, ANY off-affiliate origin fails a report closed.
        self.assertTrue(stealth_backend.report_url_is_login_gate("https://www.google.com/"))
        self.assertTrue(stealth_backend.report_url_is_login_gate(""))


class ReportCoerceTests(unittest.TestCase):
    def test_coerce_accepts_dict_and_json_string(self) -> None:
        self.assertEqual(
            _REPORT_PAYLOAD,
            stealth_backend.coerce_report_result_payload(dict(_REPORT_PAYLOAD)),
        )
        self.assertEqual(
            _REPORT_PAYLOAD,
            stealth_backend.coerce_report_result_payload(json.dumps(_REPORT_PAYLOAD)),
        )

    def test_coerce_rejects_garbage(self) -> None:
        self.assertIsNone(stealth_backend.coerce_report_result_payload("not json"))
        self.assertIsNone(stealth_backend.coerce_report_result_payload(""))
        self.assertIsNone(stealth_backend.coerce_report_result_payload(123))


class DeadBrowserErrorTests(unittest.TestCase):
    def test_stopiteration_and_connection_errors_are_dead(self) -> None:
        for exc in (
            RuntimeError("coroutine raised StopIteration"),
            RuntimeError("Target closed"),
            RuntimeError("connection is closed"),
            Exception("WebSocket connection lost"),
        ):
            self.assertTrue(stealth_backend._is_dead_browser_error(exc), exc)

    def test_ordinary_errors_are_not_dead(self) -> None:
        for exc in (ValueError("bad url"), RuntimeError("shopee said no")):
            self.assertFalse(stealth_backend._is_dead_browser_error(exc), exc)


# ---------------------------------------------------------------------------
# Backend routing for make_report_fetcher
# ---------------------------------------------------------------------------


class ReportFetcherRoutingTests(unittest.TestCase):
    def _stealth_config(self) -> server.ServerConfig:
        return server.ServerConfig(
            host="127.0.0.1",
            port=8811,
            profile_root="/stealth/profiles",
            backend=BACKEND_STEALTH,
            stealth_profile_map={"15130770000": "shopee-login-test"},
        )

    def test_stealth_backend_routes_to_stealth_fetcher(self) -> None:
        config = self._stealth_config()
        fetch = server.make_report_fetcher(config)
        with mock.patch.object(
            stealth_backend,
            "fetch_shopee_report_json",
            return_value=dict(_REPORT_PAYLOAD),
        ) as stealth_mock:
            result = fetch("affiliate_chearb.com", REPORT_API)
        self.assertEqual(_REPORT_PAYLOAD, result)
        args, _kwargs = stealth_mock.call_args
        # The id-keyed profile map still applies to the report account.
        self.assertEqual("/stealth/profiles/shopee-login-test", args[0])
        self.assertEqual(REPORT_API, args[1])

    def test_stealth_unknown_account_falls_back_to_account_name(self) -> None:
        config = self._stealth_config()
        fetch = server.make_report_fetcher(config)
        with mock.patch.object(
            stealth_backend,
            "fetch_shopee_report_json",
            return_value={"login_gate": True},
        ) as stealth_mock:
            fetch("mystery_account", REPORT_API)
        args, _kwargs = stealth_mock.call_args
        self.assertEqual("/stealth/profiles/mystery_account", args[0])

    def test_default_backend_routes_to_cloakbrowser_fetcher(self) -> None:
        config = server.ServerConfig(
            host="127.0.0.1",
            port=8811,
            profile_root="/cloak/profiles",
            backend=BACKEND_CLOAKBROWSER,
        )
        fetch = server.make_report_fetcher(config)
        from affiliate_shortlink_cloak_python import browser

        with mock.patch.object(
            browser, "fetch_shopee_report_json", return_value=dict(_REPORT_PAYLOAD)
        ) as cloak_mock:
            result = fetch("affiliate_chearb.com", REPORT_API)
        self.assertEqual(_REPORT_PAYLOAD, result)
        args, _kwargs = cloak_mock.call_args
        self.assertEqual("/cloak/profiles/shopee/affiliate_chearb.com", args[0])


# ---------------------------------------------------------------------------
# Runtime _fetch_report (fake browser/tab, no nodriver)
# ---------------------------------------------------------------------------


class FakeTab:
    def __init__(self, url: str, eval_result=None, eval_exc=None) -> None:
        self._url = url
        self.evaluate_calls = []
        self.eval_result = eval_result
        self.eval_exc = eval_exc

    @property
    def url(self) -> str:
        return self._url

    async def evaluate(self, expression, await_promise=False, return_by_value=False):
        self.evaluate_calls.append(expression)
        if self.eval_exc is not None:
            raise self.eval_exc
        return self.eval_result


class FakeBrowser:
    def __init__(self, tab, get_lands_on=None, get_exc=None) -> None:
        self.main_tab = tab
        self.get_calls = []
        self._get_lands_on = get_lands_on
        self._get_exc = get_exc
        self.stopped = False

    async def get(self, url):
        self.get_calls.append(url)
        if self._get_exc is not None:
            raise self._get_exc
        if self._get_lands_on is not None and self.main_tab is not None:
            self.main_tab._url = self._get_lands_on
        return self.main_tab

    def stop(self) -> None:
        self.stopped = True


def _run_fetch_with_browsers(browsers):
    """Drive ``_fetch_report`` on a fresh runtime whose ``_get_browser`` yields the
    given fake browsers in order. Returns (result_or_exc, runtime)."""
    runtime = stealth_backend._StealthRuntime()
    calls = {"n": 0}

    async def fake_get_browser(profile_dir):
        idx = calls["n"]
        calls["n"] += 1
        browser = browsers[min(idx, len(browsers) - 1)]
        if isinstance(browser, Exception):
            raise browser
        return browser

    runtime._get_browser = fake_get_browser
    try:
        return runtime.fetch_shopee_report_json("/tmp/p", REPORT_API), runtime
    finally:
        runtime.close_all()


class StealthReportRuntimeTests(unittest.TestCase):
    def test_success_on_affiliate_tab_without_navigation(self) -> None:
        tab = FakeTab(AFFILIATE_URL, eval_result=json.dumps(_REPORT_PAYLOAD))
        browser = FakeBrowser(tab)
        result, _runtime = _run_fetch_with_browsers([browser])
        self.assertEqual(200, result["status"])
        self.assertTrue(result["parsed"])
        self.assertEqual({"list": [], "total_count": 0}, result["body"]["data"])
        # Hot path: no navigation on an already-affiliate tab.
        self.assertEqual([], browser.get_calls)
        self.assertEqual(1, len(tab.evaluate_calls))

    def test_blank_tab_navigates_once_then_fetches(self) -> None:
        tab = FakeTab("about:blank", eval_result=json.dumps(_REPORT_PAYLOAD))
        browser = FakeBrowser(tab, get_lands_on=AFFILIATE_URL)
        result, _runtime = _run_fetch_with_browsers([browser])
        self.assertEqual(200, result["status"])
        self.assertEqual([stealth_backend.SHOPEE_CUSTOM_LINK_URL], browser.get_calls)

    def test_login_gate_fails_closed_without_navigating_or_evaluating(self) -> None:
        tab = FakeTab("https://affiliate.shopee.co.th/login")
        browser = FakeBrowser(tab)
        result, _runtime = _run_fetch_with_browsers([browser])
        self.assertEqual({"login_gate": True}, result)
        self.assertEqual([], browser.get_calls)
        self.assertEqual([], tab.evaluate_calls)

    def test_off_affiliate_origin_after_nav_fails_closed(self) -> None:
        # A non-affiliate, non-gate origin navigates once; if it stays off the
        # affiliate origin the report fails closed instead of fetching.
        tab = FakeTab("https://www.google.com/")
        browser = FakeBrowser(tab, get_lands_on="https://www.google.com/")
        result, _runtime = _run_fetch_with_browsers([browser])
        self.assertEqual({"login_gate": True}, result)
        self.assertEqual([stealth_backend.SHOPEE_CUSTOM_LINK_URL], browser.get_calls)
        self.assertEqual([], tab.evaluate_calls)

    def test_invalid_fetch_result_raises(self) -> None:
        tab = FakeTab(AFFILIATE_URL, eval_result="not-json")
        browser = FakeBrowser(tab)
        with self.assertRaises(RuntimeError):
            _run_fetch_with_browsers([browser])

    def test_evaluate_failure_is_sanitized(self) -> None:
        tab = FakeTab(
            AFFILIATE_URL,
            eval_exc=RuntimeError("cookie: SECRET csrf-token: SUPERSECRET"),
        )
        browser = FakeBrowser(tab)
        with self.assertRaises(RuntimeError) as ctx:
            _run_fetch_with_browsers([browser])
        rendered = str(ctx.exception)
        self.assertNotIn("SUPERSECRET", rendered)

    def test_dead_browser_relaunches_once_then_succeeds(self) -> None:
        # First browser has no tab and get() raises the StopIteration lifecycle
        # error; the runtime relaunches once and the second browser succeeds.
        dead_tab = None
        dead_browser = FakeBrowser(
            dead_tab, get_exc=RuntimeError("coroutine raised StopIteration")
        )
        good_tab = FakeTab(AFFILIATE_URL, eval_result=json.dumps(_REPORT_PAYLOAD))
        good_browser = FakeBrowser(good_tab)
        result, _runtime = _run_fetch_with_browsers([dead_browser, good_browser])
        self.assertEqual(200, result["status"])
        self.assertTrue(dead_browser.stopped)

    def test_non_dead_tab_error_fails_closed_as_browser_launch_error(self) -> None:
        # A non-lifecycle failure while acquiring the tab is wrapped (fail closed)
        # rather than dropping the connection, and is NOT retried.
        bad_browser = FakeBrowser(None, get_exc=ValueError("boom"))
        with self.assertRaises(stealth_backend.BrowserLaunchError):
            _run_fetch_with_browsers([bad_browser, bad_browser])


if __name__ == "__main__":
    unittest.main()
