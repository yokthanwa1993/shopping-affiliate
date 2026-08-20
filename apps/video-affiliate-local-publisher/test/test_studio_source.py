import sqlite3
import tempfile
import unittest
from pathlib import Path

from publisher.studio_source import StudioSource


SCHEMA = """CREATE TABLE content_items(
 id INTEGER PRIMARY KEY,status TEXT,edited_message_id TEXT,editor_video_url TEXT,
 ready_message_id TEXT,ready_video_url TEXT,
 shopee_link TEXT,lazada_link TEXT,ai_caption_text TEXT,ai_hashtags_json TEXT,
 ai_post_caption TEXT,ready_at TEXT)"""


class StudioSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "content.db"
        conn = sqlite3.connect(self.path)
        conn.execute(SCHEMA)
        conn.execute("INSERT INTO content_items VALUES(1,'ready','','','r1','https://cdn/ready.mp4','https://s.shopee.co.th/a','https://s.lazada.co.th/a','เครื่องทำน้ำแข็งพกพา','[\"#เครื่องทำน้ำแข็ง\",\"#ทำน้ำแข็ง\",\"#เครื่องครัว\",\"#ของใช้\"]','legacy caption','now')")
        conn.execute("INSERT INTO content_items VALUES(2,'ready','','','','','','','','','','now')")
        conn.commit(); conn.close()

    def test_strict_ready_only(self):
        source = StudioSource(self.path)
        self.assertEqual(source.strict_ready_count(), 1)
        item = source.candidates()[0]
        self.assertEqual(item.content_id, 1)
        self.assertEqual(item.ready_message_id, "r1")
        self.assertEqual(item.ready_video_url, "https://cdn/ready.mp4")

    def test_editor_only_legacy_row_is_not_publishable(self):
        conn = sqlite3.connect(self.path)
        conn.execute(
            "INSERT INTO content_items VALUES(3,'ready','legacy-editor','https://cdn/editor.mp4',"
            "'','','https://s.shopee.co.th/b','https://s.lazada.co.th/b',"
            "'ของใช้ในบ้าน','[\"#บ้าน\",\"#ของใช้\",\"#รีวิว\",\"#ช้อปปิ้ง\"]','','now')"
        )
        conn.commit(); conn.close()
        source = StudioSource(self.path)
        self.assertEqual(source.strict_ready_count(), 1)
        self.assertEqual([row.content_id for row in source.candidates(limit=10)], [1])

    def test_connection_is_query_only(self):
        source = StudioSource(self.path)
        conn = source.connect()
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("UPDATE content_items SET status='x'")
        conn.close()


    def test_caption_is_composed_at_publishing_boundary_from_separated_fields(self):
        item = StudioSource(self.path).current(1)
        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(
            item.caption,
            "เครื่องทำน้ำแข็งพกพา\n\n"
            "#เครื่องทำน้ำแข็ง #ทำน้ำแข็ง #เครื่องครัว #ของใช้",
        )
        self.assertNotEqual(item.caption, "legacy caption")

    def test_caption_boundary_rejects_invalid_separated_metadata(self):
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE content_items SET ai_caption_text=? WHERE id=1", ("ก" * 33,))
        conn.commit(); conn.close()
        with self.assertRaisesRegex(RuntimeError, "studio_metadata_invalid"):
            StudioSource(self.path).current(1)

    def test_candidates_can_be_restricted_to_primary_success_ids(self):
        source = StudioSource(self.path)
        self.assertEqual([row.content_id for row in source.candidates(allowed_ids={1})], [1])
        self.assertEqual(source.candidates(allowed_ids={2}), [])
        self.assertEqual(source.candidates(excluded_ids={1}, allowed_ids={1}), [])
