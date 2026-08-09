import sqlite3
import tempfile
import unittest
from pathlib import Path

from publisher.studio_source import StudioSource


SCHEMA = """CREATE TABLE content_items(
 id INTEGER PRIMARY KEY,status TEXT,edited_message_id TEXT,editor_video_url TEXT,
 shopee_link TEXT,lazada_link TEXT,ai_post_caption TEXT,ready_at TEXT)"""


class StudioSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "content.db"
        conn = sqlite3.connect(self.path)
        conn.execute(SCHEMA)
        conn.execute("INSERT INTO content_items VALUES(1,'ready','m1','https://cdn/a.mp4','https://s.shopee.co.th/a','https://s.lazada.co.th/a','caption','now')")
        conn.execute("INSERT INTO content_items VALUES(2,'ready','','','','','','now')")
        conn.commit(); conn.close()

    def test_strict_ready_only(self):
        source = StudioSource(self.path)
        self.assertEqual(source.strict_ready_count(), 1)
        self.assertEqual(source.candidates()[0].content_id, 1)

    def test_connection_is_query_only(self):
        source = StudioSource(self.path)
        conn = source.connect()
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("UPDATE content_items SET status='x'")
        conn.close()
