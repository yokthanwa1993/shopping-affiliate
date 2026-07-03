from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import server
from affiliate_shortlink_cloak_python.browser import BrowserLaunchError
from affiliate_shortlink_cloak_python.shopee import ShopeeShortenError


class ServerHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = server.ServerConfig(
            host="127.0.0.1",
            port=8811,
            profile_root="/tmp/affiliate-shortlink-cloak-python/profiles",
        )

    def test_json_bytes_shape(self) -> None:
        raw = server.json_bytes({"status": "ok", "value": "chearb"})
        parsed = json.loads(raw.decode("utf-8"))
        self.assertEqual({"status": "ok", "value": "chearb"}, parsed)

    def test_health_payload_shape(self) -> None:
        payload = server.health_payload(self.config)
        self.assertEqual("ok", payload["status"])
        self.assertEqual("127.0.0.1", payload["host"])
        self.assertEqual(8811, payload["port"])
        self.assertEqual(
            "/tmp/affiliate-shortlink-cloak-python/profiles",
            payload["profileRoot"],
        )
        self.assertEqual(
            "https://affiliate.shopee.co.th/offer/custom_link",
            payload["shopeeCustomLinkUrl"],
        )

    def test_accounts_payload_shape(self) -> None:
        payload = server.accounts_payload(self.config)
        self.assertEqual("ok", payload["status"])
        self.assertEqual(2, payload["count"])
        first = payload["accounts"][0]
        self.assertIn("id", first)
        self.assertIn("account", first)
        self.assertIn("utm_source", first)
        self.assertIn("display", first)

    def test_validate_shorten_rejects_conflicting_aliases(self) -> None:
        status, payload = server.validate_shorten_query(
            {
                "id": ["15130770000"],
                "account": ["affiliate_neezs.com"],
                "url": ["https://shopee.co.th/product/1/2"],
            },
            self.config,
        )
        self.assertEqual(400, status)
        self.assertEqual("id_account_conflict", payload["error"])
        self.assertTrue(payload["conflict"])

    def test_validate_shorten_accepts_valid_request_without_browser(self) -> None:
        status, payload = server.validate_shorten_query(
            {
                "id": ["an_15130770000"],
                "url": ["https://shopee.co.th/product/1/2"],
                "sub1": ["A-1"],
                "sub2": ["post_2"],
            },
            self.config,
        )
        self.assertEqual(200, status)
        self.assertEqual("affiliate_chearb.com", payload["record"]["account"])
        self.assertEqual(
            "/tmp/affiliate-shortlink-cloak-python/profiles/shopee/affiliate_chearb.com",
            payload["profileDir"],
        )
        self.assertEqual(["A1", "post2", "", "", ""], payload["subIds"])

    def test_validate_shorten_rejects_invalid_url(self) -> None:
        status, payload = server.validate_shorten_query(
            {"id": ["15130770000"], "url": ["not-a-url"]},
            self.config,
        )
        self.assertEqual(400, status)
        self.assertEqual("invalid_url", payload["error"])

    def test_root_route_is_legacy_shorten_alias(self) -> None:
        class FakeHandler:
            path = "/?id=15130770000&url=https://shopee.co.th/product/1/2&sub1"
            server = type("FakeServer", (), {"config": self.config})()

            def __init__(self) -> None:
                self.status = None
                self.payload = None

            def _write_json(self, status, payload):
                self.status = status
                self.payload = payload

        handler = FakeHandler()
        with mock.patch.object(server, "handle_shorten", return_value=(200, {"status": "ok"})) as mocked:
            server.RequestHandler.do_GET(handler)
        self.assertEqual(200, handler.status)
        self.assertEqual({"status": "ok"}, handler.payload)
        args, _kwargs = mocked.call_args
        self.assertIn("id", args[0])
        self.assertIn("url", args[0])
        self.assertIn("sub1", args[0])

    @mock.patch("affiliate_shortlink_cloak_python.browser.shorten_shopee_link")
    def test_handle_shorten_returns_real_shortlink(
        self,
        shorten_mock: mock.Mock,
    ) -> None:
        shorten_mock.return_value = {
            "profileDir": (
                "/tmp/affiliate-shortlink-cloak-python/profiles/"
                "shopee/affiliate_chearb.com"
            ),
            "targetUrl": "https://affiliate.shopee.co.th/offer/custom_link",
            "currentUrl": "https://affiliate.shopee.co.th/offer/custom_link",
            "shortLink": "https://s.shopee.co.th/abc",
            "longLink": "https://shopee.co.th/product/1/2?utm_content=A1-post2---&utm_source=an_15130770000",
            "originalLink": "https://shopee.co.th/product/1/2",
        }

        status, payload = server.handle_shorten(
            {
                "id": ["15130770000"],
                "url": ["https://shopee.co.th/product/1/2"],
                "sub1": ["A-1"],
            },
            self.config,
        )

        self.assertEqual(200, status)
        self.assertEqual("https://s.shopee.co.th/abc", payload["shortLink"])
        self.assertEqual("https://s.shopee.co.th/abc", payload["link"])
        self.assertEqual("affiliate_chearb.com", payload["account"])
        self.assertEqual("15130770000", payload["id"])
        self.assertEqual("an_15130770000", payload["utm_source"])
        self.assertEqual("A1-post2---", payload["utm_content"])
        self.assertEqual("A1", payload["sub1"])
        self.assertEqual("post2", payload["sub2"])
        self.assertNotIn("status", payload)
        self.assertNotIn("browser", payload)
        self.assertNotIn("profileDir", payload)
        self.assertNotIn("display", payload)
        shorten_mock.assert_called_once_with(
            (
                "/tmp/affiliate-shortlink-cloak-python/profiles/"
                "shopee/affiliate_chearb.com"
            ),
            "https://shopee.co.th/product/1/2",
            ["A1", "", "", "", ""],
        )

    @mock.patch("affiliate_shortlink_cloak_python.browser.shorten_shopee_link")
    def test_handle_shorten_fail_closes_browser_error_safely(
        self,
        shorten_mock: mock.Mock,
    ) -> None:
        shorten_mock.side_effect = BrowserLaunchError(
            "cloakbrowser_launch_failed cookie: csrftoken=secret; "
            "csrf-token: verysecret"
        )

        status, payload = server.handle_shorten(
            {
                "id": ["15130770000"],
                "url": ["https://shopee.co.th/product/1/2"],
            },
            self.config,
        )

        self.assertEqual(503, status)
        self.assertEqual("error", payload["status"])
        self.assertFalse(payload["manualLoginRequired"])
        self.assertFalse(payload["needsManual"])
        self.assertEqual("affiliate_chearb.com", payload["account"])
        self.assertIn("[REDACTED]", payload["reason"])
        self.assertNotIn("secret", payload["reason"])
        self.assertNotIn("verysecret", payload["reason"])

    @mock.patch("affiliate_shortlink_cloak_python.browser.shorten_shopee_link")
    def test_handle_shorten_fail_closes_session_error(
        self,
        shorten_mock: mock.Mock,
    ) -> None:
        shorten_mock.side_effect = ShopeeShortenError(
            "shopee_session_html",
            "cookie: csrftoken=secret; csrf-token: verysecret",
            current_url="https://affiliate.shopee.co.th/buyer/login",
            manual_login_required=True,
        )

        status, payload = server.handle_shorten(
            {
                "id": ["15130770000"],
                "url": ["https://shopee.co.th/product/1/2"],
            },
            self.config,
        )

        self.assertEqual(503, status)
        self.assertEqual("manual_login_required", payload["status"])
        self.assertTrue(payload["manualLoginRequired"])
        self.assertTrue(payload["needsManual"])
        self.assertEqual("shopee_session_html", payload["reason"])
        self.assertEqual(
            "https://affiliate.shopee.co.th/buyer/login",
            payload["currentUrl"],
        )


if __name__ == "__main__":
    unittest.main()
