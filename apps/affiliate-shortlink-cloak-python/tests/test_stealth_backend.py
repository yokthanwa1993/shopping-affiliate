from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import (
    BACKEND_CLOAKBROWSER,
    BACKEND_STEALTH,
    DEFAULT_PROFILE_ROOT,
    DEFAULT_STEALTH_PROFILE_ROOT,
    server,
    stealth_backend,
)
from affiliate_shortlink_cloak_python.shopee import ShopeeShortenError


class BackendSelectionTests(unittest.TestCase):
    def test_normalize_backend_aliases_map_to_stealth(self) -> None:
        for alias in ("stealth", "nodriver", "python-stealth-nodriver", "STEALTH"):
            self.assertEqual(BACKEND_STEALTH, stealth_backend.normalize_backend(alias))

    def test_normalize_backend_unknown_defaults_to_cloakbrowser(self) -> None:
        for value in ("", None, "python-cloakbrowser", "playwright", "whatever"):
            self.assertEqual(
                BACKEND_CLOAKBROWSER, stealth_backend.normalize_backend(value)
            )

    def test_resolve_backend_prefers_primary_env(self) -> None:
        env = {"AFFILIATE_SHORTLINK_BROWSER_BACKEND": "stealth", "BACKEND": "junk"}
        self.assertEqual(BACKEND_STEALTH, stealth_backend.resolve_backend(env))

    def test_resolve_backend_legacy_env_fallback(self) -> None:
        env = {"BACKEND": "python-stealth-nodriver"}
        self.assertEqual(BACKEND_STEALTH, stealth_backend.resolve_backend(env))

    def test_resolve_backend_unset_preserves_default(self) -> None:
        self.assertEqual(BACKEND_CLOAKBROWSER, stealth_backend.resolve_backend({}))

    def test_load_config_stealth_switches_default_profile_root(self) -> None:
        config = server.load_config({"AFFILIATE_SHORTLINK_BROWSER_BACKEND": "stealth"})
        self.assertEqual(BACKEND_STEALTH, config.backend)
        self.assertEqual(DEFAULT_STEALTH_PROFILE_ROOT, config.profile_root)

    def test_load_config_default_backend_keeps_cloakbrowser_root(self) -> None:
        config = server.load_config({})
        self.assertEqual(BACKEND_CLOAKBROWSER, config.backend)
        self.assertEqual(DEFAULT_PROFILE_ROOT, config.profile_root)

    def test_load_config_explicit_profile_root_wins(self) -> None:
        config = server.load_config(
            {
                "AFFILIATE_SHORTLINK_BROWSER_BACKEND": "stealth",
                "PROFILE_ROOT": "/tmp/custom-stealth",
            }
        )
        self.assertEqual("/tmp/custom-stealth", config.profile_root)

    def test_health_payload_reports_selected_backend(self) -> None:
        config = server.load_config({"AFFILIATE_SHORTLINK_BROWSER_BACKEND": "stealth"})
        self.assertEqual(BACKEND_STEALTH, server.health_payload(config)["backend"])


class StealthProfileMapTests(unittest.TestCase):
    def test_parse_profile_map_basic(self) -> None:
        parsed = stealth_backend.parse_profile_map(
            "15130770000=shopee-login-test,affiliate_neezs.com=neezs-login"
        )
        self.assertEqual(
            {
                "15130770000": "shopee-login-test",
                "affiliate_neezs.com": "neezs-login",
            },
            parsed,
        )

    def test_parse_profile_map_skips_malformed_and_sanitizes_traversal(self) -> None:
        parsed = stealth_backend.parse_profile_map(
            "  ,noequals, 15130770000 = ../../etc/passwd ,x="
        )
        self.assertEqual({"15130770000": "passwd"}, parsed)

    def test_parse_profile_map_empty(self) -> None:
        self.assertEqual({}, stealth_backend.parse_profile_map(""))
        self.assertEqual({}, stealth_backend.parse_profile_map(None))

    def test_stealth_profile_dir_maps_by_shopee_id(self) -> None:
        record = {
            "id": "15130770000",
            "account": "affiliate_chearb.com",
            "utm_source": "an_15130770000",
            "display": "affiliate@chearb.com",
        }
        result = stealth_backend.stealth_profile_dir(
            "/root/profiles", record, {"15130770000": "shopee-login-test"}
        )
        self.assertEqual("/root/profiles/shopee-login-test", result)

    def test_stealth_profile_dir_maps_by_an_alias_and_account(self) -> None:
        record = {
            "id": "15142270000",
            "account": "affiliate_neezs.com",
            "utm_source": "an_15142270000",
            "display": "affiliate@neezs.com",
        }
        by_an = stealth_backend.stealth_profile_dir(
            "/root", record, {"an_15142270000": "neezs"}
        )
        self.assertEqual("/root/neezs", by_an)
        by_account = stealth_backend.stealth_profile_dir(
            "/root", record, {"affiliate_neezs.com": "neezs2"}
        )
        self.assertEqual("/root/neezs2", by_account)

    def test_stealth_profile_dir_falls_back_to_account_name(self) -> None:
        record = {"id": "15130770000", "account": "affiliate_chearb.com"}
        result = stealth_backend.stealth_profile_dir("/root", record, {})
        self.assertEqual("/root/affiliate_chearb.com", result)

    def test_validate_login_query_uses_stealth_mapping(self) -> None:
        config = server.ServerConfig(
            host="127.0.0.1",
            port=8811,
            profile_root="/stealth/profiles",
            backend=BACKEND_STEALTH,
            stealth_profile_map={"15130770000": "shopee-login-test"},
        )
        status, payload = server.validate_login_query(
            {"id": ["15130770000"]}, config
        )
        self.assertEqual(200, status)
        self.assertEqual(
            "/stealth/profiles/shopee-login-test", payload["profileDir"]
        )


class StealthShortenDispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = server.ServerConfig(
            host="127.0.0.1",
            port=8811,
            profile_root="/stealth/profiles",
            backend=BACKEND_STEALTH,
            stealth_profile_map={"15130770000": "shopee-login-test"},
        )

    def test_handle_shorten_success_payload_shape_and_order(self) -> None:
        shorten_return = {
            "profileDir": "/stealth/profiles/shopee-login-test",
            "targetUrl": "https://affiliate.shopee.co.th/offer/custom_link",
            "currentUrl": "https://affiliate.shopee.co.th/offer/custom_link",
            "shortLink": "https://s.shopee.co.th/xyz",
            "longLink": (
                "https://shopee.co.th/product/1/2?"
                "utm_content=A1-post2---&utm_source=an_15130770000"
            ),
            "originalLink": "https://shopee.co.th/product/1/2",
        }
        with mock.patch.object(
            stealth_backend, "shorten_shopee_link", return_value=shorten_return
        ) as shorten_mock:
            status, payload = server.handle_shorten(
                {
                    "id": ["15130770000"],
                    "url": ["https://shopee.co.th/product/1/2"],
                    "sub1": ["A-1"],
                    "sub2": ["post_2"],
                },
                self.config,
            )

        self.assertEqual(200, status)
        # Legacy success payload key order is preserved.
        self.assertEqual(
            [
                "link",
                "longLink",
                "originalLink",
                "shortLink",
                "id",
                "utm_source",
                "utm_content",
                "account",
                "sub1",
                "sub2",
                "sub3",
                "sub4",
                "sub5",
            ],
            list(payload.keys()),
        )
        self.assertEqual("https://s.shopee.co.th/xyz", payload["link"])
        self.assertEqual("https://s.shopee.co.th/xyz", payload["shortLink"])
        self.assertEqual("15130770000", payload["id"])
        self.assertEqual("affiliate_chearb.com", payload["account"])
        self.assertEqual("an_15130770000", payload["utm_source"])
        self.assertEqual("A1", payload["sub1"])
        self.assertEqual("post2", payload["sub2"])
        # Dispatch used the stealth-mapped profile dir.
        args, _kwargs = shorten_mock.call_args
        self.assertEqual("/stealth/profiles/shopee-login-test", args[0])
        self.assertEqual("https://shopee.co.th/product/1/2", args[1])

    def test_handle_shorten_fail_closed_manual_login_required(self) -> None:
        error = ShopeeShortenError(
            "shopee_session_gate",
            "cookie: csrftoken=secret; csrf-token: verysecret",
            current_url="https://affiliate.shopee.co.th/buyer/login",
            manual_login_required=True,
        )
        with mock.patch.object(
            stealth_backend, "shorten_shopee_link", side_effect=error
        ):
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
        self.assertEqual("shopee_session_gate", payload["reason"])
        self.assertEqual(
            "https://affiliate.shopee.co.th/buyer/login", payload["currentUrl"]
        )
        # Secrets from the diagnostic message are never surfaced.
        rendered = server.json_bytes(payload).decode("utf-8")
        self.assertNotIn("verysecret", rendered)
        self.assertNotIn("csrftoken=secret", rendered)

    def test_handle_shorten_fail_closed_browser_launch_error(self) -> None:
        with mock.patch.object(
            stealth_backend,
            "shorten_shopee_link",
            side_effect=stealth_backend.BrowserLaunchError(
                "stealth_nodriver_launch_failed cookie: csrftoken=secret"
            ),
        ):
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
        self.assertNotIn("csrftoken=secret", server.json_bytes(payload).decode("utf-8"))


class StealthInPageScriptTests(unittest.TestCase):
    def test_build_in_page_shorten_expression_is_iife_without_secrets(self) -> None:
        body = {"operationName": "batchGetCustomLink", "variables": {"x": 1}}
        expr = stealth_backend.build_in_page_shorten_expression(body)
        self.assertTrue(expr.startswith("(async () => {"))
        self.assertTrue(expr.rstrip().endswith("})()"))
        self.assertIn("batchGetCustomLink", expr)
        self.assertIn("affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink", expr)
        # Reads csrf from the browser's own cookie/meta; no static UA / origin.
        self.assertIn("csrftoken=", expr)
        self.assertNotIn("user-agent", expr.lower())

    def test_url_is_shopee_gate(self) -> None:
        self.assertTrue(
            stealth_backend.url_is_shopee_gate(
                "https://shopee.co.th/buyer/login?next=x"
            )
        )
        self.assertFalse(
            stealth_backend.url_is_shopee_gate(
                "https://affiliate.shopee.co.th/offer/custom_link"
            )
        )


if __name__ == "__main__":
    unittest.main()
