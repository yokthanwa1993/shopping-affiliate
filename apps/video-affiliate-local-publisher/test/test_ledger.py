import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from publisher.ledger import Ledger, LedgerError


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "publisher.db")

    def test_slot_guard_and_state_machine(self):
        attempt = self.ledger.claim_attempt("p1", 1, "slot1", "test")
        with self.assertRaises(LedgerError):
            self.ledger.claim_attempt("p1", 2, "slot1", "test")
        self.ledger.transition(attempt, "source_resolved")
        self.ledger.transition(attempt, "downloaded", {"source_sha256": "a" * 64})
        with self.assertRaises(LedgerError):
            self.ledger.transition(attempt, "success")

    def test_posted_content_and_sha_are_page_local(self):
        attempt = self.ledger.claim_attempt("p1", 1, "slot1", "test")
        for state in ["source_resolved", "downloaded", "avatar_composing", "avatar_ready", "shortlink_preflight_ok", "posting"]:
            fields = {"source_sha256": "b" * 64} if state == "downloaded" else None
            self.ledger.transition(attempt, state, fields)
        self.ledger.transition(attempt, "post_confirmed", {"fb_story_id": "p1_post"})
        self.assertEqual(self.ledger.used_content_ids("p1"), {1})
        self.assertTrue(self.ledger.page_has_sha("p1", "b" * 64))
        self.assertFalse(self.ledger.page_has_sha("p2", "b" * 64))

    def test_shadow_is_excluded_only_from_future_shadow_selection(self):
        attempt = self.ledger.claim_attempt("p1", 7, "shadow-slot", "manual")
        for state in ["source_resolved", "downloaded", "avatar_composing", "avatar_ready", "shadow_ready"]:
            self.ledger.transition(attempt, state)
        self.assertEqual(self.ledger.used_content_ids("p1"), set())
        self.assertEqual(self.ledger.used_content_ids("p1", include_shadow=True), {7})

    def test_lease_exclusion_and_expiry(self):
        self.assertTrue(self.ledger.acquire_lease("page:p1", "a", 10, now=100))
        self.assertFalse(self.ledger.acquire_lease("page:p1", "b", 10, now=105))
        self.assertTrue(self.ledger.acquire_lease("page:p1", "b", 10, now=111))

    def test_success_clears_stale_error_fields(self):
        attempt = self.ledger.claim_attempt("p1", 9, "slot-success", "test")
        for state in [
            "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
            "shortlink_preflight_ok", "posting", "post_confirmed",
            "final_shortlink_ok", "comment_pending", "verifying",
        ]:
            self.ledger.transition(attempt, state)
        self.ledger.transition(attempt, "post_success_verification_failed", {
            "error_code": "old_error",
            "error_detail_redacted": "old detail",
        })
        self.ledger.transition(attempt, "success")
        row = self.ledger.attempt(attempt)
        self.assertEqual(row["error_code"], "")
        self.assertEqual(row["error_detail_redacted"], "")
