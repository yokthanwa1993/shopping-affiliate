from __future__ import annotations

import json
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

    def test_build_in_page_expression_returns_json_string(self) -> None:
        # The IIFE must serialize the result so it round-trips as a primitive.
        expr = stealth_backend.build_in_page_shorten_expression({"x": 1})
        self.assertIn("JSON.stringify({ status: response.status", expr)


# ---------------------------------------------------------------------------
# Minimal fakes mimicking nodriver / CDP return shapes (no browser required).
# ---------------------------------------------------------------------------


class _FakeDeepSerializedValue:
    """Mirrors nodriver ``cdp.runtime.DeepSerializedValue`` (type_ + value)."""

    def __init__(self, type_: str, value: object) -> None:
        self.type_ = type_
        self.value = value


class _FakeRemoteObject:
    """Mirrors nodriver ``cdp.runtime.RemoteObject`` (has deep_serialized_value)."""

    def __init__(
        self,
        type_: str = "object",
        value: object = None,
        deep_serialized_value: object = None,
    ) -> None:
        self.type_ = type_
        self.value = value
        self.deep_serialized_value = deep_serialized_value


class _FakeExceptionDetails:
    """Mirrors nodriver ``cdp.runtime.ExceptionDetails`` (has exception_id)."""

    def __init__(self, text: str) -> None:
        self.exception_id = 1
        self.text = text


_LIVE_PAYLOAD = {
    "status": 200,
    "text": '{"data":{"batchCustomLink":[{"shortLink":"https://s.shopee.co.th/x"}]}}',
    "currentUrl": "https://affiliate.shopee.co.th/offer/custom_link",
}


class StealthEvaluateNormalizationTests(unittest.TestCase):
    def _assert_live_payload(self, value: object) -> None:
        payload = stealth_backend.coerce_shorten_result_payload(value)
        self.assertIsInstance(payload, dict)
        self.assertEqual(200, payload["status"])
        self.assertEqual(_LIVE_PAYLOAD["text"], payload["text"])
        self.assertEqual(_LIVE_PAYLOAD["currentUrl"], payload["currentUrl"])

    def test_plain_dict_passes_through(self) -> None:
        normalized = stealth_backend.normalize_evaluate_result(dict(_LIVE_PAYLOAD))
        self.assertEqual(_LIVE_PAYLOAD, normalized)
        self._assert_live_payload(normalized)

    def test_json_string_return_by_value(self) -> None:
        # returnByValue path where the JSON-string primitive is decoded directly.
        normalized = stealth_backend.normalize_evaluate_result(
            json.dumps(_LIVE_PAYLOAD)
        )
        self.assertIsInstance(normalized, str)
        self._assert_live_payload(normalized)

    def test_remote_object_with_plain_value(self) -> None:
        ro = _FakeRemoteObject(value=dict(_LIVE_PAYLOAD))
        normalized = stealth_backend.normalize_evaluate_result(ro)
        self._assert_live_payload(normalized)

    def test_remote_object_deep_serialized_string(self) -> None:
        # The real live shape: JSON string returned via deep serialization only.
        ro = _FakeRemoteObject(
            value=None,
            deep_serialized_value=_FakeDeepSerializedValue(
                "string", json.dumps(_LIVE_PAYLOAD)
            ),
        )
        normalized = stealth_backend.normalize_evaluate_result(ro)
        self.assertIsInstance(normalized, str)
        self._assert_live_payload(normalized)

    def test_remote_object_deep_serialized_bidi_object(self) -> None:
        # BiDi object node: value is a list of [key, valueNode] pairs.
        node_value = [
            ["status", {"type": "number", "value": 200}],
            ["text", {"type": "string", "value": _LIVE_PAYLOAD["text"]}],
            ["currentUrl", {"type": "string", "value": _LIVE_PAYLOAD["currentUrl"]}],
        ]
        ro = _FakeRemoteObject(
            value=None,
            deep_serialized_value=_FakeDeepSerializedValue("object", node_value),
        )
        normalized = stealth_backend.normalize_evaluate_result(ro)
        self.assertEqual(_LIVE_PAYLOAD, normalized)
        self._assert_live_payload(normalized)

    def test_bare_deep_serialized_value(self) -> None:
        dsv = _FakeDeepSerializedValue("string", json.dumps(_LIVE_PAYLOAD))
        normalized = stealth_backend.normalize_evaluate_result(dsv)
        self._assert_live_payload(normalized)

    def test_raw_bidi_node_dict(self) -> None:
        node = {
            "type": "object",
            "value": [
                ["status", {"type": "number", "value": 200}],
                ["text", {"type": "string", "value": _LIVE_PAYLOAD["text"]}],
                [
                    "currentUrl",
                    {"type": "string", "value": _LIVE_PAYLOAD["currentUrl"]},
                ],
            ],
        }
        normalized = stealth_backend.normalize_evaluate_result(node)
        self.assertEqual(_LIVE_PAYLOAD, normalized)

    def test_nested_bidi_object_and_array(self) -> None:
        node = {
            "type": "object",
            "value": [
                [
                    "data",
                    {
                        "type": "object",
                        "value": [
                            [
                                "items",
                                {
                                    "type": "array",
                                    "value": [
                                        {"type": "number", "value": 1},
                                        {"type": "string", "value": "a"},
                                    ],
                                },
                            ]
                        ],
                    },
                ],
                ["ok", {"type": "boolean", "value": True}],
                ["missing", {"type": "null"}],
            ],
        }
        normalized = stealth_backend.normalize_evaluate_result(node)
        self.assertEqual(
            {"data": {"items": [1, "a"]}, "ok": True, "missing": None},
            normalized,
        )

    def test_exception_details_raises_internal_marker(self) -> None:
        exc = _FakeExceptionDetails("Uncaught TypeError: boom")
        with self.assertRaises(stealth_backend._StealthEvalError):
            stealth_backend.normalize_evaluate_result(exc)

    def test_none_normalizes_and_coerces_to_none(self) -> None:
        self.assertIsNone(stealth_backend.normalize_evaluate_result(None))
        self.assertIsNone(stealth_backend.coerce_shorten_result_payload(None))

    def test_coerce_rejects_non_json_and_non_dict(self) -> None:
        # Fail closed on garbage so the caller raises invalid_fetch_result.
        self.assertIsNone(stealth_backend.coerce_shorten_result_payload("not json"))
        self.assertIsNone(stealth_backend.coerce_shorten_result_payload(""))
        self.assertIsNone(stealth_backend.coerce_shorten_result_payload(123))
        self.assertIsNone(stealth_backend.coerce_shorten_result_payload([1, 2]))

    def test_plain_payload_not_mistaken_for_bidi_node(self) -> None:
        # A real payload has no BiDi "type" key and must pass through verbatim.
        payload = {"status": 200, "text": "{}", "currentUrl": "https://x"}
        self.assertFalse(stealth_backend._looks_like_bidi_node(payload))
        self.assertEqual(
            payload, stealth_backend.normalize_evaluate_result(payload)
        )


if __name__ == "__main__":
    unittest.main()
