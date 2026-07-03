"""Account alias mapping / conflict tests. No browser is ever launched."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from affiliate_shortlink_cloak_python import accounts  # noqa: E402


class TestAliasMapping(unittest.TestCase):
    def test_known_ids_map_to_expected_accounts(self):
        chearb = accounts.resolve_by_shopee_id("15130770000")
        self.assertIsNotNone(chearb)
        self.assertEqual(chearb["account"], "affiliate_chearb.com")
        self.assertEqual(chearb["utm_source"], "an_15130770000")
        self.assertEqual(chearb["display"], "affiliate@chearb.com")

        neezs = accounts.resolve_by_shopee_id("15142270000")
        self.assertEqual(neezs["account"], "affiliate_neezs.com")
        self.assertEqual(neezs["utm_source"], "an_15142270000")
        self.assertEqual(neezs["display"], "affiliate@neezs.com")

    def test_resolve_by_account_name(self):
        rec = accounts.resolve_by_account("affiliate_neezs.com")
        self.assertEqual(rec["shopee_id"], "15142270000")

    def test_unknown_id_returns_none(self):
        self.assertIsNone(accounts.resolve_by_shopee_id("999"))
        self.assertIsNone(accounts.resolve_by_account("nope.com"))

    def test_list_accounts_returns_copies_without_secrets(self):
        listed = accounts.list_accounts()
        self.assertEqual(len(listed), 2)
        blob = " ".join(str(v).lower() for rec in listed for v in rec.values())
        for banned in ("password", "cookie", "token", "secret", "datr", "totp"):
            self.assertNotIn(banned, blob)
        # mutating the copy must not affect source data
        listed[0]["account"] = "mutated"
        self.assertNotEqual(
            accounts.resolve_by_shopee_id("15130770000")["account"], "mutated"
        )


class TestConflictDetection(unittest.TestCase):
    def test_agreeing_id_and_account_ok(self):
        res = accounts.resolve_account(
            shopee_id="15130770000", account="affiliate_chearb.com"
        )
        self.assertTrue(res["ok"])
        self.assertFalse(res["conflict"])
        self.assertEqual(res["record"]["account"], "affiliate_chearb.com")

    def test_conflicting_id_and_account(self):
        res = accounts.resolve_account(
            shopee_id="15130770000", account="affiliate_neezs.com"
        )
        self.assertFalse(res["ok"])
        self.assertTrue(res["conflict"])
        self.assertEqual(res["error"], "id_account_conflict")

    def test_unknown_id(self):
        res = accounts.resolve_account(shopee_id="123")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "unknown_shopee_id")

    def test_unknown_account(self):
        res = accounts.resolve_account(account="ghost.com")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "unknown_account")

    def test_missing_identifier(self):
        res = accounts.resolve_account()
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "missing_identifier")


class TestProfileDir(unittest.TestCase):
    def test_profile_dir_layout(self):
        path = accounts.profile_dir_for("/root", "shopee", "affiliate_chearb.com")
        self.assertEqual(
            path, os.path.join("/root", "shopee", "affiliate_chearb.com")
        )

    def test_profile_dir_sanitizes_traversal(self):
        path = accounts.profile_dir_for("/root", "../etc", "a/b")
        self.assertNotIn("..", path)
        self.assertNotIn("/etc/", path + "/")
        self.assertTrue(path.startswith("/root"))


if __name__ == "__main__":
    unittest.main()
