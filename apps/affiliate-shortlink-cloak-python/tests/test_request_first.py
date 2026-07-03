"""Offline unit tests for the request-first hot path.

These prove the legacy Node baseline parity: the primary shortlink and report
transports use the persistent context's ``request`` APIRequestContext
(``context.request.post`` / ``context.request.get``) and therefore create NO
visible tab and perform NO ``page.goto`` / ``page.evaluate`` on the hot path.
Manual ``/login`` / ``open_shopee_custom_link`` still navigates, and a closed /
stale persistent context is cleared and relaunched cleanly.

Everything is driven with fake context/request/page objects; no live Shopee or
CloakBrowser is touched.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import browser  # noqa: E402
from affiliate_shortlink_cloak_python.shopee import ShopeeShortenError  # noqa: E402

AFFILIATE_URL = "https://affiliate.shopee.co.th/offer/custom_link"

_SHORTEN_OK_TEXT = (
    '{"data":{"batchCustomLink":[{"shortLink":"https://s.shopee.co.th/abc",'
    '"longLink":"https://x","failCode":0}]}}'
)


class FakeResponse:
    """Mimics a Playwright ``APIResponse`` (``.status`` int property, ``.text()``)."""

    def __init__(self, status: int, text: str) -> None:
        self._status = status
        self._text = text

    @property
    def status(self) -> int:
        return self._status

    def text(self) -> str:
        return self._text


class FakeRequestApi:
    """Mimics ``BrowserContext.request`` (an APIRequestContext).

    Records every call so tests can assert the request-first transport was used
    and can inject a scripted response / exception per verb.
    """

    def __init__(self, post_response=None, get_response=None) -> None:
        self.post_calls = []
        self.get_calls = []
        self._post_response = post_response
        self._get_response = get_response

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        return self._resolve(self._post_response, url, kwargs)

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return self._resolve(self._get_response, url, kwargs)

    @staticmethod
    def _resolve(spec, url, kwargs):
        if callable(spec):
            return spec(url, kwargs)
        if isinstance(spec, Exception):
            raise spec
        return spec


class FakePage:
    """A page that explodes if the hot path ever touches it."""

    def __init__(self, url: str) -> None:
        self._url = url
        self.goto_calls = []
        self.evaluate_calls = []

    @property
    def url(self) -> str:
        return self._url

    def goto(self, url: str) -> None:  # pragma: no cover - must never run here
        self.goto_calls.append(url)
        self._url = url

    def wait_for_load_state(self, *a, **k) -> None:  # pragma: no cover
        return None

    def evaluate(self, *a, **k):  # pragma: no cover - must never run here
        self.evaluate_calls.append((a, k))
        raise AssertionError("request-first path must not call page.evaluate")


class FakeRequestContext:
    """A persistent context that exposes ``.request`` (request-first capable)."""

    def __init__(self, request_api, pages=None) -> None:
        self.request = request_api
        self._pages = list(pages or [])
        self.new_page_count = 0

    @property
    def pages(self):
        return self._pages

    def new_page(self):  # pragma: no cover - must never run on the hot path
        self.new_page_count += 1
        page = FakePage("about:blank")
        self._pages.append(page)
        return page

    def cookies(self, origin=None):
        return [{"name": "csrftoken", "value": "REDACTED-CSRF"}]


class _PatchLaunch:
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


class ShortlinkRequestFirstTests(unittest.TestCase):
    def test_primary_uses_context_request_post_no_page(self) -> None:
        req = FakeRequestApi(post_response=FakeResponse(200, _SHORTEN_OK_TEXT))
        page = FakePage(AFFILIATE_URL)  # a parked tab that must be left untouched
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link(
                "/tmp/p", "https://shopee.co.th/x", ["a", "b"]
            )
        # Request-first was used...
        self.assertEqual(1, len(req.post_calls))
        url, kwargs = req.post_calls[0]
        self.assertEqual(browser.SHOPEE_GQL_ENDPOINT, url)
        self.assertIn("data", kwargs)
        # ...and the visible tab was never touched.
        self.assertEqual([], page.goto_calls)
        self.assertEqual([], page.evaluate_calls)
        self.assertEqual(0, ctx.new_page_count)
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_post_sends_csrf_and_affiliate_headers(self) -> None:
        req = FakeRequestApi(post_response=FakeResponse(200, _SHORTEN_OK_TEXT))
        ctx = FakeRequestContext(req)
        with _PatchLaunch(ctx):
            browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        _, kwargs = req.post_calls[0]
        headers = kwargs["headers"]
        self.assertEqual("REDACTED-CSRF", headers["csrf-token"])
        self.assertEqual("1", headers["affiliate-program-type"])
        self.assertEqual(browser.SHOPEE_ORIGIN, headers["origin"])

    def test_status_callable_is_supported(self) -> None:
        # Some shims expose status as a method; the reader must handle both.
        class CallableStatusResponse:
            def status(self):
                return 200

            def text(self):
                return _SHORTEN_OK_TEXT

        req = FakeRequestApi(post_response=CallableStatusResponse())
        ctx = FakeRequestContext(req)
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_non_session_failure_fails_closed_without_page(self) -> None:
        # A bad-JSON (non-session) failure must NOT fall back to the page path.
        req = FakeRequestApi(post_response=FakeResponse(200, "<html>not json</html>"))
        page = FakePage(AFFILIATE_URL)
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            with self.assertRaises(ShopeeShortenError):
                browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        self.assertEqual(1, len(req.post_calls))  # no re-hammer
        self.assertEqual([], page.goto_calls)
        self.assertEqual([], page.evaluate_calls)

    def test_session_failure_falls_back_to_page_path_once(self) -> None:
        # A 401 (session) request-first failure falls back to the gate-aware page
        # path exactly once. Here the parked tab is on the affiliate origin, so
        # the page path reuses it (no navigation) and succeeds.
        req = FakeRequestApi(post_response=FakeResponse(401, "unauthorized"))

        class ReusablePage(FakePage):
            def evaluate(self, script, arg=None):
                # Page-path in-page shorten fetch succeeds on the fallback.
                return {
                    "status": 200,
                    "text": _SHORTEN_OK_TEXT,
                    "currentUrl": AFFILIATE_URL,
                }

        page = ReusablePage(AFFILIATE_URL)
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            result = browser.shorten_shopee_link("/tmp/p", "https://shopee.co.th/x", ["a"])
        self.assertEqual(1, len(req.post_calls))
        self.assertEqual([], page.goto_calls)  # already on affiliate origin
        self.assertEqual("https://s.shopee.co.th/abc", result["shortLink"])

    def test_transport_exception_is_sanitized(self) -> None:
        # Unit-test the request-first helper directly so the sanitized transport
        # error is observed before any fallback classification kicks in.
        boom = RuntimeError("cookie: SECRETVALUE csrftoken=SECRET")
        req = FakeRequestApi(post_response=boom)
        ctx = FakeRequestContext(req)
        with self.assertRaises(ShopeeShortenError) as exc:
            browser._shorten_via_context_request(
                ctx, req, {"operationName": "batchGetCustomLink"}, "https://shopee.co.th/x"
            )
        self.assertNotIn("SECRETVALUE", str(exc.exception))
        self.assertNotIn("SECRETVALUE", exc.exception.reason)
        self.assertTrue(exc.exception.manual_login_required)


class ReportRequestFirstTests(unittest.TestCase):
    def test_primary_uses_context_request_get_no_page(self) -> None:
        api_url = AFFILIATE_URL + "/api/v3/report"
        req = FakeRequestApi(
            get_response=FakeResponse(200, '{"code":0,"data":{"list":[]}}')
        )
        page = FakePage(AFFILIATE_URL)
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", api_url)
        self.assertEqual(1, len(req.get_calls))
        self.assertEqual(api_url, req.get_calls[0][0])
        self.assertEqual([], page.goto_calls)
        self.assertEqual([], page.evaluate_calls)
        self.assertEqual(0, ctx.new_page_count)
        self.assertEqual(200, result["status"])
        self.assertTrue(result["parsed"])
        self.assertEqual({"code": 0, "data": {"list": []}}, result["body"])

    def test_report_works_with_no_open_page(self) -> None:
        # User closed every tab: request API still works purely from cookies.
        req = FakeRequestApi(get_response=FakeResponse(200, '{"code":0}'))
        ctx = FakeRequestContext(req, pages=[])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual(1, len(req.get_calls))
        self.assertEqual(0, ctx.new_page_count)
        self.assertEqual(200, result["status"])

    def test_report_login_gate_from_parked_tab_without_request(self) -> None:
        # A parked login tab fails closed BEFORE any network call.
        req = FakeRequestApi(get_response=FakeResponse(200, "{}"))
        page = FakePage("https://affiliate.shopee.co.th/login")
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertEqual({"login_gate": True}, result)
        self.assertEqual([], req.get_calls)

    def test_report_invalid_json_snippet_is_sanitized(self) -> None:
        req = FakeRequestApi(
            get_response=FakeResponse(200, "cookie: SECRETVALUE csrftoken=SECRET not-json")
        )
        ctx = FakeRequestContext(req, pages=[])
        with _PatchLaunch(ctx):
            result = browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertFalse(result["parsed"])
        self.assertNotIn("SECRETVALUE", result["snippet"])

    def test_report_transport_exception_is_sanitized(self) -> None:
        # The report path has NO fallback; a transport error surfaces as a
        # sanitized RuntimeError without ever touching a page.
        boom = RuntimeError("cookie: SECRETVALUE csrftoken=SECRET failed")
        req = FakeRequestApi(get_response=boom)
        page = FakePage(AFFILIATE_URL)
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            with self.assertRaises(RuntimeError) as exc:
                browser.fetch_shopee_report_json("/tmp/p", AFFILIATE_URL + "/api")
        self.assertNotIn("SECRETVALUE", str(exc.exception))
        self.assertEqual([], page.goto_calls)
        self.assertEqual([], page.evaluate_calls)


class ManualLoginStillNavigatesTests(unittest.TestCase):
    def test_open_custom_link_navigates_blank_tab_even_with_request_api(self) -> None:
        # Manual login/open path is allowed to open a visible page even though a
        # request API is present; the request-first hot path never does.
        req = FakeRequestApi()
        page = FakePage("about:blank")
        ctx = FakeRequestContext(req, pages=[page])
        with _PatchLaunch(ctx):
            out = browser.open_shopee_custom_link("/tmp/p")
        self.assertEqual([browser.SHOPEE_CUSTOM_LINK_URL], page.goto_calls)
        self.assertEqual(browser.SHOPEE_CUSTOM_LINK_URL, out["currentUrl"])
        # Manual open must not have used the request transport at all.
        self.assertEqual([], req.post_calls)
        self.assertEqual([], req.get_calls)


class ClosedContextRelaunchTests(unittest.TestCase):
    """Prove a stale/closed persistent context is cleared and relaunched, so the
    next hot-path request gets a fresh context + request API (no
    ``cloakbrowser_launch_failed`` unless a real launch fails)."""

    class ClosedCtx:
        def is_closed(self):
            return True

    class LiveCtx:
        def __init__(self, request_api) -> None:
            self.request = request_api
            self._pages = []

        @property
        def pages(self):
            return self._pages

        def is_closed(self):
            return False

    def _reset_registry(self, profile_dir, seeded_ctx):
        import os

        abspath = os.path.abspath(os.path.expanduser(profile_dir))
        browser._OPEN_CONTEXTS.clear()
        browser._CONTEXT_BY_PROFILE.clear()
        browser._CONTEXT_BY_PROFILE[abspath] = seeded_ctx
        browser._OPEN_CONTEXTS.append(seeded_ctx)
        return abspath

    def test_stale_closed_context_is_relaunched(self) -> None:
        import os

        profile_dir = "/tmp/relaunch-profile"
        abspath = self._reset_registry(profile_dir, self.ClosedCtx())

        fresh = self.LiveCtx(FakeRequestApi())

        class FakeCloak:
            def __init__(self, ctx):
                self.ctx = ctx
                self.launch_calls = 0

            def launch_persistent_context(self, profile, headless=False):
                self.launch_calls += 1
                return self.ctx

        fake_cloak = FakeCloak(fresh)
        orig_import = browser._import_cloakbrowser
        orig_makedirs = os.makedirs
        browser._import_cloakbrowser = lambda: fake_cloak
        os.makedirs = lambda *a, **k: None
        try:
            got = browser.launch_persistent_context(profile_dir)
        finally:
            browser._import_cloakbrowser = orig_import
            os.makedirs = orig_makedirs
            browser._OPEN_CONTEXTS.clear()
            browser._CONTEXT_BY_PROFILE.clear()

        # The stale closed record was discarded and a fresh live context (with a
        # usable request API) was launched exactly once.
        self.assertIs(fresh, got)
        self.assertEqual(1, fake_cloak.launch_calls)
        self.assertIsNotNone(browser._context_request_api(got))
        self.assertFalse(browser._context_is_closed(got))

    def test_live_context_is_reused_not_relaunched(self) -> None:
        import os

        profile_dir = "/tmp/reuse-profile"
        live = self.LiveCtx(FakeRequestApi())
        self._reset_registry(profile_dir, live)

        def _should_not_launch():
            raise AssertionError("must not relaunch a live context")

        orig_import = browser._import_cloakbrowser
        browser._import_cloakbrowser = _should_not_launch
        try:
            got = browser.launch_persistent_context(profile_dir)
        finally:
            browser._import_cloakbrowser = orig_import
            browser._OPEN_CONTEXTS.clear()
            browser._CONTEXT_BY_PROFILE.clear()
        self.assertIs(live, got)


if __name__ == "__main__":
    unittest.main()
