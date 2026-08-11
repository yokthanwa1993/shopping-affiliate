import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.lookup_facebook_source import (
    FacebookLookupError,
    extract_facebook_ids,
    lookup_source,
    resolve_input,
)


class FacebookSourceLookupTests(unittest.TestCase):
    def make_databases(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        ledger = Path(root.name) / "publisher.db"
        studio = Path(root.name) / "content.db"

        with sqlite3.connect(ledger) as conn:
            conn.executescript(
                """
                CREATE TABLE post_attempts(
                  attempt_id TEXT PRIMARY KEY,
                  page_id TEXT NOT NULL,
                  studio_content_id INTEGER NOT NULL,
                  state TEXT NOT NULL,
                  fb_video_id TEXT NOT NULL DEFAULT '',
                  fb_story_id TEXT NOT NULL DEFAULT '',
                  fb_post_tail TEXT NOT NULL DEFAULT '',
                  permalink TEXT NOT NULL DEFAULT '',
                  completed_at INTEGER
                );
                CREATE TABLE source_items(
                  studio_content_id INTEGER PRIMARY KEY,
                  editor_message_id TEXT NOT NULL,
                  source_attachment_id TEXT NOT NULL DEFAULT '',
                  source_sha256 TEXT NOT NULL DEFAULT '',
                  caption TEXT NOT NULL DEFAULT ''
                );
                INSERT INTO post_attempts VALUES(
                  'attempt-1','1008898512617594',9011,'success','1069164855567107',
                  '1008898512617594_1352962457008449','1352962457008449',
                  'https://www.facebook.com/reel/1069164855567107/',1786412508
                );
                INSERT INTO source_items VALUES(
                  9011,'1535481665772716112','1535481664317423707','sha-source','caption'
                );
                """
            )

        with sqlite3.connect(studio) as conn:
            conn.executescript(
                """
                CREATE TABLE content_items(
                  id INTEGER PRIMARY KEY,
                  status TEXT,
                  edited_message_id TEXT,
                  source_post_id TEXT,
                  source_link TEXT,
                  reel_url TEXT,
                  ai_post_caption TEXT
                );
                INSERT INTO content_items VALUES(
                  9011,'ready','1535481665772716112','legacy-r2:8107b39c',
                  'https://s.shopee.co.th/example','https://example.invalid/original','caption'
                );
                """
            )
        return ledger, studio

    def test_extracts_story_and_reel_ids(self):
        self.assertEqual(
            extract_facebook_ids(
                "https://www.facebook.com/story.php?story_fbid=1352962457008449&id=100068841215950"
            ),
            ["1352962457008449", "100068841215950"],
        )
        self.assertEqual(
            extract_facebook_ids("https://www.facebook.com/reel/1069164855567107/"),
            ["1069164855567107"],
        )

    def test_share_redirect_is_resolved_without_browser(self):
        def fetch(_url):
            return (
                "https://www.facebook.com/story.php?"
                "story_fbid=1352962457008449&id=100068841215950"
            )

        resolved = resolve_input(
            "https://www.facebook.com/share/r/1GMyKjSp7j/", fetch_redirect=fetch
        )
        self.assertIn("1352962457008449", resolved["candidate_ids"])
        self.assertEqual(len(resolved["urls"]), 2)

    def test_rejects_non_facebook_url(self):
        with self.assertRaisesRegex(FacebookLookupError, "facebook_url_required"):
            resolve_input("https://example.com/share/r/test")

    def test_lookup_returns_exact_editor_jumper(self):
        ledger, studio = self.make_databases()
        result = lookup_source(
            ledger,
            studio,
            ["1352962457008449", "100068841215950"],
            guild_id="1500909618275156070",
            editor_channel_id="1518808518176800769",
        )
        self.assertTrue(result["found"])
        self.assertEqual(result["studio_content_id"], 9011)
        self.assertEqual(result["editor_message_id"], "1535481665772716112")
        self.assertEqual(
            result["editor_jump_url"],
            "https://discord.com/channels/1500909618275156070/1518808518176800769/1535481665772716112",
        )
        self.assertFalse(result["editor_pointer_changed"])

    def test_lookup_reports_not_found(self):
        ledger, studio = self.make_databases()
        result = lookup_source(
            ledger,
            studio,
            ["999"],
            guild_id="1500909618275156070",
            editor_channel_id="1518808518176800769",
        )
        self.assertEqual(result, {"found": False, "candidate_ids": ["999"]})


if __name__ == "__main__":
    unittest.main()
