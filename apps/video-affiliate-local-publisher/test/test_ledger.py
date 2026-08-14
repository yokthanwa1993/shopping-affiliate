import tempfile
import sqlite3
import time
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

    def test_operator_can_close_unknown_only_with_allowlisted_no_post_evidence(self):
        attempt = self.ledger.claim_attempt("p1", 10, "slot-unknown", "scheduler")
        for state in [
            "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
            "shortlink_preflight_ok", "posting", "post_outcome_unknown",
        ]:
            self.ledger.transition(attempt, state)
        with self.assertRaises(LedgerError):
            self.ledger.resolve_unknown_no_post(attempt, "operator_says_ok")
        self.ledger.resolve_unknown_no_post(
            attempt, "idbridge_rejected_before_upload_and_graph_no_post",
        )
        row = self.ledger.attempt(attempt)
        self.assertEqual(row["state"], "failed_pre_post")
        self.assertEqual(row["error_code"], "operator_confirmed_no_post")
        event = self.ledger.connect().execute(
            "SELECT old_state,new_state,detail_json FROM events WHERE attempt_id=? ORDER BY id DESC LIMIT 1",
            (attempt,),
        ).fetchone()
        self.assertEqual(event["old_state"], "post_outcome_unknown")
        self.assertEqual(event["new_state"], "failed_pre_post")
        self.assertIn("idbridge_rejected_before_upload_and_graph_no_post", event["detail_json"])

    def test_operator_can_close_rejected_upload_after_graph_confirms_no_post(self):
        attempt = self.ledger.claim_attempt("p1", 11, "slot-upload-rejected", "manual")
        for state in [
            "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
            "shortlink_preflight_ok", "posting", "post_outcome_unknown",
        ]:
            self.ledger.transition(attempt, state)
        self.ledger.resolve_unknown_no_post(
            attempt, "facebook_upload_rejected_and_graph_no_post",
        )
        self.assertEqual(self.ledger.attempt(attempt)["state"], "failed_pre_post")

    def test_primary_success_ids_and_daily_count_are_sql_backed(self):
        success = self.ledger.claim_attempt("primary", 101, "slot-success-primary", "scheduler")
        for state in [
            "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
            "shortlink_preflight_ok", "posting", "post_confirmed",
            "final_shortlink_ok", "comment_pending", "verifying", "success",
        ]:
            self.ledger.transition(success, state)
        failed = self.ledger.claim_attempt("primary", 102, "slot-failed-primary", "scheduler")
        self.ledger.transition(failed, "failed_pre_post")
        posted = self.ledger.claim_attempt("primary", 103, "slot-posted-primary", "scheduler")
        for state in [
            "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
            "shortlink_preflight_ok", "posting", "post_confirmed",
        ]:
            self.ledger.transition(posted, state)
        self.assertEqual(self.ledger.successful_content_ids("primary"), {101})
        now = int(time.time())
        self.assertEqual(self.ledger.success_count_between("primary", now - 60, now + 60), 1)
        self.assertEqual(self.ledger.posted_count_between("primary", now - 60, now + 60), 2)

    def test_migrate_adds_secondary_policy_columns_to_existing_pages_table(self):
        old_path = Path(self.temp.name) / "old.db"
        conn = sqlite3.connect(old_path)
        conn.execute("""
            CREATE TABLE pages(
              page_id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,
              interval_minutes INTEGER NOT NULL,timezone TEXT NOT NULL,next_due_at INTEGER,
              campaign_sub1 TEXT NOT NULL DEFAULT '',shopee_account TEXT NOT NULL DEFAULT '',
              affiliate_id TEXT NOT NULL DEFAULT '',facebook_account TEXT NOT NULL DEFAULT '',
              avatar_path TEXT NOT NULL DEFAULT '',avatar_version TEXT NOT NULL DEFAULT '',
              caption_template TEXT NOT NULL DEFAULT '{caption}',last_success_at INTEGER,
              updated_at INTEGER NOT NULL)
        """)
        conn.commit(); conn.close()
        migrated = Ledger(old_path)
        columns = {row[1] for row in migrated.connect().execute("PRAGMA table_info(pages)")}
        self.assertIn("daily_success_limit", columns)
        self.assertIn("reuse_success_from_page_id", columns)

    def test_source_archive_is_sql_backed_and_summarized(self):
        item = SimpleNamespace(
            content_id=77,
            editor_message_id="message-77",
            shopee_url="https://shopee.co.th/product/1/77",
            lazada_url="https://www.lazada.co.th/products/example-i77.html",
            caption="caption",
            ready_at="2026-08-14T00:00:00Z",
        )
        sha = "c" * 64
        self.ledger.upsert_source(item, "attachment-77", sha)
        path = Path(self.temp.name) / "source-archive" / f"content_77_{sha}.mp4"
        self.ledger.record_source_archive(77, sha, path, 123456, now=100)
        self.ledger.record_source_archive(77, sha, path, 123456, now=200)
        row = self.ledger.source_archive(77, sha)
        if row is None:
            self.fail("source archive row missing")
        self.assertEqual(row["archive_path"], str(path))
        self.assertEqual(row["archive_bytes"], 123456)
        self.assertEqual(row["archived_at"], 100)
        summary = self.ledger.summary()
        self.assertEqual(summary["source_archives"], 1)
        self.assertEqual(summary["source_archive_bytes"], 123456)
