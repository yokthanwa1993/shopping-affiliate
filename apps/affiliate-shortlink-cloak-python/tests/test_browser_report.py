"""Offline unit tests for browser report vs shortlink navigation behavior.

These prove the reCAPTCHA fix: ``fetch_shopee_report_json`` reuses the already
open affiliate tab and must NOT call ``page.goto`` on every call, while the
shortlink path still navigates as before. Everything is driven with fake
context/page objects; no live Shopee / CloakBrowser is touched.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import browser  # noqa: E402
from affiliate_shortlink_cloak_python.shopee import (  # noqa: E402
    SHOPEE_ORIGIN,
)

AFFILIATE_URL = "https://affiliate.shopee.co.th/offer/custom_link"


class FakePage:
    def __init__(self, url: str, eval_return=None) -> None:
        self._url = url
        self.goto_calls = []
        self.evaluate_calls = []
        self.eval_return = eval_return if eval_return is not None else {
            "status": 200,
            "parsed": True,
            "body": {"code": 0, "data": {}},
            "snippet": "",
        }

    @property
    def url(self) -> str:
        return self._url

    def goto(self, url: str) -> None:
        self.goto_calls.append(url)
        self._url = url

    def wait_for_load_state(self, *args, **kwargs) -> None:  # noqa: D401
        return None

    def evaluate(self, script, arg=None):
        self.evaluate_calls.append((script, arg))
        if callable(self.eval_return):
            return self.eval_return(script, arg)
        return self.eval_return


class FakeContext:
    def __init__(self, pages) -> None:
        self._pages = list(pages)
        self.new_page_count = 0

    @property
    def pages(self):
        return self._pages

    def new_page(self):
        self.new_page_count += 1
        page = FakePage("about:blank")
        self._pages.append(page)
        return page

    def cookies(self, origin=None):
        return [{"name": "csrftoken", "value": "REDACTED"}]


class _PatchLaunch:
    """Context manager: make ``launch_persistent_context`` return a fake."""

    def __init__(self, context) -> None:
        self.context = context
        self._orig = None

    def __enter__(self):
        self._orig = browser.launch_persistent_context
        browser.launch_persistent_context = lambda profile_dir: self.context
        return self.context

    def __exit__(self, *exc):
        browser.launch_persistent_context = self._orig
        return False


class ReportNavigationTests(unittest.TestCase):
    def test_no_goto_when_already_on_affiliate_origin(self) -> None:
        page = FakePage(AFFILIATE_URL)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        # The whole point of the fix: no navigation on the hot report path.
        self.assertEqual([], page.goto_calls)
        self.assertEqual(0, ctx.new_page_count)
        self.assertEqual(1, len(page.evaluate_calls))
        self.assertEqual(200, result["status"])
        self.assertNotIn("login_gate", result)

    def test_no_goto_on_deep_affiliate_url(self) -> None:
        page = FakePage("https://affiliate.shopee.co.th/offer/custom_link?foo=1")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            browser.fetch_shopee_report_json("/tmp/p", "https://affiliate.shopee.co.th/api/v3/report/list")
        self.assertEqual([], page.goto_calls)

    def test_blank_tab_navigates_once(self) -> None:
        page = FakePage("about:blank")
        # goto() flips the fake page onto the affiliate origin.
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], page.goto_calls)
        self.assertEqual(200, result["status"])

    def test_new_page_created_navigates_once(self) -> None:
        ctx = FakeContext([])  # no existing page -> new_page() (blank)
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual(1, ctx.new_page_count)
        created = ctx.pages[0]
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], created.goto_calls)
        self.assertEqual(200, result["status"])

    def test_login_gate_fails_closed_without_navigating(self) -> None:
        page = FakePage("https://affiliate.shopee.co.th/login")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual({"login_gate": True}, result)
        self.assertEqual([], page.goto_calls)
        self.assertEqual([], page.evaluate_calls)

    def test_captcha_gate_fails_closed(self) -> None:
        page = FakePage("https://affiliate.shopee.co.th/captcha?next=/offer")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual({"login_gate": True}, result)
        self.assertEqual([], page.goto_calls)

    def test_non_affiliate_origin_fails_closed(self) -> None:
        page = FakePage("https://shopee.co.th/buyer/login")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual({"login_gate": True}, result)
        self.assertEqual([], page.goto_calls)

    def test_fetch_result_must_be_dict(self) -> None:
        page = FakePage(AFFILIATE_URL, eval_return="not-a-dict")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            with self.assertRaises(RuntimeError):
                browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")

    def test_evaluate_failure_is_sanitized(self) -> None:
        def boom(script, arg):
            raise RuntimeError("cookie: SECRETVALUE csrftoken=SECRET")

        page = FakePage(AFFILIATE_URL, eval_return=boom)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            with self.assertRaises(RuntimeError) as exc:
                browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertNotIn("SECRETVALUE", str(exc.exception))


class ShortlinkNavigationTests(unittest.TestCase):
    def _shorten_ok_eval(self, script, arg):
        return {
            "status": 200,
            "text": (
                '{"data":{"batchCustomLink":[{"shortLink":'
                '"https://s.shopee.co.th/abc","longLink":"https://x","failCode":0}]}}'
            ),
            "currentUrl": AFFILIATE_URL,
        }

    def test_shorten_reuses_affiliate_tab_without_reloading(self) -> None:
        page = FakePage(AFFILIATE_URL, eval_return=self._shorten_ok_eval)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        # The fix: an already-open affiliate custom_link tab is NOT reloaded on
        # shortlink creation (reload == reCAPTCHA risk), yet the link is created.
        self.assertEqual([], page.goto_calls)
        self.assertEqual(0, ctx.new_page_count)
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_shorten_on_deep_custom_link_url_does_not_reload(self) -> None:
        page = FakePage(AFFILIATE_URL + "?foo=1", eval_return=self._shorten_ok_eval)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        self.assertEqual([], page.goto_calls)
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_shorten_blank_tab_navigates_once(self) -> None:
        page = FakePage("about:blank", eval_return=self._shorten_ok_eval)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        # A blank/new tab still gets one navigation to establish the origin.
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], page.goto_calls)
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_shorten_new_page_navigates_once(self) -> None:
        ctx = FakeContext([])  # no existing page -> new_page() (blank)
        # The freshly created page needs its eval wired for the shorten fetch.
        with _PatchLaunch(ctx):
            created_holder = {}
            orig_new_page = ctx.new_page

            def new_page():
                page = orig_new_page()
                page.eval_return = self._shorten_ok_eval
                created_holder["page"] = page
                return page

            ctx.new_page = new_page
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        self.assertEqual(1, ctx.new_page_count)
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], created_holder["page"].goto_calls)
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_shorten_non_affiliate_origin_navigates_once(self) -> None:
        page = FakePage("https://www.google.com/", eval_return=self._shorten_ok_eval)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        # Off-origin: navigate exactly once (the API fetch needs affiliate origin).
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], page.goto_calls)
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_shorten_on_login_gate_does_not_navigate(self) -> None:
        # Sitting on a Shopee login/captcha gate: do NOT re-navigate/hammer.
        page = FakePage("https://affiliate.shopee.co.th/login")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            with self.assertRaises(browser.ShopeeShortenError):
                browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        self.assertEqual([], page.goto_calls)

    def test_open_custom_link_reuses_affiliate_tab(self) -> None:
        page = FakePage(AFFILIATE_URL)
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            out = browser.open_shopee_custom_link("/tmp/p")
        # Already on the affiliate origin: no reload.
        self.assertEqual([], page.goto_calls)
        self.assertEqual(AFFILIATE_URL, out["currentUrl"])

    def test_open_custom_link_blank_navigates_once(self) -> None:
        page = FakePage("about:blank")
        ctx = FakeContext([page])
        with _PatchLaunch(ctx):
            browser.open_shopee_custom_link("/tmp/p")
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], page.goto_calls)


class BlankUrlHelperTests(unittest.TestCase):
    def test_blank_variants(self) -> None:
        for url in ("", "  ", "about:blank", "about:", "chrome://newtab", "data:,", None):
            self.assertTrue(browser._is_blank_url(url), url)

    def test_real_urls_not_blank(self) -> None:
        for url in (AFFILIATE_URL, "https://shopee.co.th/x", SHOPEE_ORIGIN):
            self.assertFalse(browser._is_blank_url(url), url)


if __name__ == "__main__":
    unittest.main()
