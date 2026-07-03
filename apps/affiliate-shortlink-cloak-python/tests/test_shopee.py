from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import shopee


class ShopeeHelperTests(unittest.TestCase):
    def test_sub_id_sanitizer(self) -> None:
        self.assertEqual(
            "ABC123x",
            shopee.sanitize_shopee_sub_id("A-B_C 123@x"),
        )
        self.assertEqual(
            "a" * 64,
            shopee.sanitize_shopee_sub_id("a" * 70),
        )
        self.assertEqual("", shopee.sanitize_shopee_sub_id(None))

    def test_request_body_builder_includes_sanitized_sub_ids(self) -> None:
        body = shopee.build_shortlink_body(
            "https://shopee.co.th/product/1/2",
            ["CAMPAIGN-1", "post_2", "", "%%", "z" * 70],
        )

        self.assertEqual("batchGetCustomLink", body["operationName"])
        self.assertEqual(shopee.SHOPEE_BATCH_CUSTOM_LINK_QUERY, body["query"])
        variables = body["variables"]
        self.assertEqual("CUSTOM_LINK_CALLER", variables["sourceCaller"])
        link_param = variables["linkParams"][0]
        self.assertEqual(
            "https://shopee.co.th/product/1/2",
            link_param["originalLink"],
        )
        self.assertEqual(
            {
                "subId1": "CAMPAIGN1",
                "subId2": "post2",
                "subId3": "",
                "subId4": "",
                "subId5": "z" * 64,
            },
            link_param["advancedLinkParams"],
        )

    def test_request_body_builder_omits_advanced_when_empty(self) -> None:
        body = shopee.build_shortlink_body(
            "https://shopee.co.th/product/1/2",
            ["", None, "***"],
        )
        link_param = body["variables"]["linkParams"][0]
        self.assertNotIn("advancedLinkParams", link_param)

    def test_response_parser_success(self) -> None:
        raw = json.dumps({
            "data": {
                "batchCustomLink": [{
                    "shortLink": "https://s.shopee.co.th/abc",
                    "longLink": "https://shopee.co.th/product/1/2?utm=1",
                    "failCode": 0,
                }],
            },
        })

        parsed = shopee.parse_shortlink_response(
            200,
            raw,
            "https://shopee.co.th/product/1/2",
        )
        self.assertEqual("https://s.shopee.co.th/abc", parsed["shortLink"])
        self.assertEqual(
            "https://shopee.co.th/product/1/2?utm=1",
            parsed["longLink"],
        )
        self.assertEqual(
            "https://shopee.co.th/product/1/2",
            parsed["originalLink"],
        )

    def test_response_parser_fail_code(self) -> None:
        raw = json.dumps({
            "data": {
                "batchCustomLink": [{
                    "shortLink": "",
                    "longLink": "",
                    "failCode": 3,
                }],
            },
        })

        with self.assertRaises(shopee.ShopeeShortenError) as ctx:
            shopee.parse_shortlink_response(
                200,
                raw,
                "https://shopee.co.th/product/1/2",
            )
        self.assertEqual("shopee_api_fail_code_3", ctx.exception.reason)
        self.assertFalse(ctx.exception.manual_login_required)

    def test_response_parser_no_results(self) -> None:
        with self.assertRaises(shopee.ShopeeShortenError) as ctx:
            shopee.parse_shortlink_response(
                200,
                json.dumps({"data": {"batchCustomLink": []}}),
                "https://shopee.co.th/product/1/2",
            )
        self.assertEqual("shopee_api_no_results", ctx.exception.reason)

    def test_response_parser_invalid_json(self) -> None:
        with self.assertRaises(shopee.ShopeeShortenError) as ctx:
            shopee.parse_shortlink_response(
                200,
                "not json at all",
                "https://shopee.co.th/product/1/2",
            )
        self.assertEqual("shopee_api_invalid_json", ctx.exception.reason)

    def test_response_parser_session_html(self) -> None:
        with self.assertRaises(shopee.ShopeeShortenError) as ctx:
            shopee.parse_shortlink_response(
                200,
                "<html><title>Login</title><body>csrf required</body></html>",
                "https://shopee.co.th/product/1/2",
            )
        self.assertEqual("shopee_session_html", ctx.exception.reason)
        self.assertTrue(ctx.exception.manual_login_required)

    def test_response_parser_session_http_status(self) -> None:
        with self.assertRaises(shopee.ShopeeShortenError) as ctx:
            shopee.parse_shortlink_response(
                403,
                "{}",
                "https://shopee.co.th/product/1/2",
            )
        self.assertEqual("shopee_session_http_403", ctx.exception.reason)
        self.assertTrue(ctx.exception.manual_login_required)


if __name__ == "__main__":
    unittest.main()
