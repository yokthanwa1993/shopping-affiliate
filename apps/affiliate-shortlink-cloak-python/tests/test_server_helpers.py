"""Server helper tests: health/accounts shapes + shorten validation.

These exercise the pure helpers only — no HTTP socket, no browser launch.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from affiliate_shortlink_cloak_python import server  # noqa: E402


def _is_json_safe(body):
    """A body is JSON-safe if it round-trips and leaks no secret-ish keys."""
    text = json.dumps(body).lower()
    for banned in ("password", "cookie", "token", "secret", "datr", "totp"):
        if banned in text:
            return False
    return True


class TestHealth(unittest.TestCase):
    def test_health_shape(self):
        status, body = server.build_health("/tmp/profiles", 8811)
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["app"], "affiliate-shortlink-cloak-python")
        self.assertEqual(body["backend"], "python-cloakbrowser")
        self.assertEqual(body["port"], 8811)
        self.assertIn("loaded", body)
        self.assertEqual(body["profileRoot"], "/tmp/profiles")
        self.assertTrue(_is_json_safe(body))


class TestAccounts(unittest.TestCase):
    def test_accounts_shape(self):
        status, body = server.build_accounts("/tmp/profiles")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["known"]), 2)
        ids = {rec["shopee_id"] for rec in body["known"]}
        self.assertEqual(ids, {"15130770000", "15142270000"})
        self.assertIn("runtime", body)
        self.assertIn("loaded", body)
        self.assertTrue(_is_json_safe(body))


class TestShortenValidation(unittest.TestCase):
    def test_valid_shorten(self):
        ok, detail = server.validate_shorten(
            {"id": "15130770000", "url": "https://shopee.co.th/x"}
        )
        self.assertTrue(ok)
        self.assertEqual(detail["record"]["account"], "affiliate_chearb.com")
        self.assertEqual(detail["url"], "https://shopee.co.th/x")

    def test_missing_id(self):
        ok, detail = server.validate_shorten({"url": "https://shopee.co.th/x"})
        self.assertFalse(ok)
        self.assertEqual(detail["error"], "missing_id")

    def test_missing_url(self):
        ok, detail = server.validate_shorten({"id": "15130770000"})
        self.assertFalse(ok)
        self.assertEqual(detail["error"], "missing_url")

    def test_invalid_url_scheme(self):
        ok, detail = server.validate_shorten(
            {"id": "15130770000", "url": "ftp://nope"}
        )
        self.assertFalse(ok)
        self.assertEqual(detail["error"], "invalid_url")

    def test_unknown_id(self):
        ok, detail = server.validate_shorten(
            {"id": "42", "url": "https://shopee.co.th/x"}
        )
        self.assertFalse(ok)
        self.assertEqual(detail["error"], "unknown_shopee_id")

    def test_id_account_conflict(self):
        ok, detail = server.validate_shorten(
            {
                "id": "15130770000",
                "account": "affiliate_neezs.com",
                "url": "https://shopee.co.th/x",
            }
        )
        self.assertFalse(ok)
        self.assertEqual(detail["error"], "id_account_conflict")
        self.assertTrue(detail["conflict"])


class TestLoginInvalidAccountIsSafe(unittest.TestCase):
    """An unknown account must be rejected BEFORE any browser import/launch."""

    def test_invalid_account_no_browser(self):
        status, body = server.handle_login("/tmp/profiles", {"account": "ghost.com"})
        self.assertEqual(status, 400)
        self.assertEqual(body["status"], "invalid_account")
        self.assertTrue(_is_json_safe(body))


class TestConfigResolvers(unittest.TestCase):
    def test_port_default_and_override(self):
        old = os.environ.pop("PORT", None)
        try:
            self.assertEqual(server.resolve_port(), 8811)
            os.environ["PORT"] = "9999"
            self.assertEqual(server.resolve_port(), 9999)
            os.environ["PORT"] = "not-a-number"
            self.assertEqual(server.resolve_port(), 8811)
        finally:
            os.environ.pop("PORT", None)
            if old is not None:
                os.environ["PORT"] = old

    def test_profile_root_expands_user(self):
        root = server.default_profile_root()
        self.assertNotIn("~", root)
        self.assertIn("affiliate-shortlink-cloak-python", root)


if __name__ == "__main__":
    unittest.main()
