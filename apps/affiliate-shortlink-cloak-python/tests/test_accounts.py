from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import accounts


class AccountTests(unittest.TestCase):
    def test_known_accounts_mapping(self) -> None:
        records = accounts.list_accounts()
        self.assertEqual(2, len(records))

        chearb = accounts.resolve_by_shopee_id("15130770000")
        self.assertIsNotNone(chearb)
        self.assertEqual("affiliate_chearb.com", chearb["account"])
        self.assertEqual("an_15130770000", chearb["utm_source"])
        self.assertEqual("affiliate@chearb.com", chearb["display"])

        neezs = accounts.resolve_by_shopee_id("an_15142270000")
        self.assertIsNotNone(neezs)
        self.assertEqual("affiliate_neezs.com", neezs["account"])

    def test_account_resolution_accepts_aliases(self) -> None:
        by_display = accounts.resolve_account(account="affiliate@chearb.com")
        self.assertTrue(by_display["ok"])
        self.assertEqual("15130770000", by_display["record"]["id"])

        by_utm = accounts.resolve_account(account="an_15142270000")
        self.assertTrue(by_utm["ok"])
        self.assertEqual("affiliate_neezs.com", by_utm["record"]["account"])

    def test_conflicting_id_and_account_is_rejected(self) -> None:
        result = accounts.resolve_account(
            shopee_id="15130770000",
            account="affiliate_neezs.com",
        )
        self.assertFalse(result["ok"])
        self.assertTrue(result["conflict"])
        self.assertEqual("id_account_conflict", result["error"])

    def test_unknown_and_missing_identifiers(self) -> None:
        self.assertEqual(
            "unknown_shopee_id",
            accounts.resolve_account(shopee_id="99999999999")["error"],
        )
        self.assertEqual(
            "missing_identifier",
            accounts.resolve_account()["error"],
        )

    def test_profile_dir_sanitizes_path_segments(self) -> None:
        path = accounts.profile_dir_for(
            "/tmp/profiles",
            "../shopee",
            "affiliate/chearb.com",
        )
        self.assertEqual(
            os.path.join("/tmp/profiles", "_shopee", "affiliate_chearb.com"),
            path,
        )


if __name__ == "__main__":
    unittest.main()
