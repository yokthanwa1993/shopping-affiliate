from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import server


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
            },
            self.config,
        )
        self.assertEqual(200, status)
        self.assertEqual("affiliate_chearb.com", payload["record"]["account"])
        self.assertEqual(
            "/tmp/affiliate-shortlink-cloak-python/profiles/shopee/affiliate_chearb.com",
            payload["profileDir"],
        )

    def test_validate_shorten_rejects_invalid_url(self) -> None:
        status, payload = server.validate_shorten_query(
            {"id": ["15130770000"], "url": ["not-a-url"]},
            self.config,
        )
        self.assertEqual(400, status)
        self.assertEqual("invalid_url", payload["error"])


if __name__ == "__main__":
    unittest.main()
