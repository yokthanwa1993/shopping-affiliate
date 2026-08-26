import hashlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from publisher.publisher import PublisherEngine
from publisher.studio_source import StudioSource


class ReadyCaptionContractTests(unittest.TestCase):
    def test_every_live_ready_row_fits_chearb_publish_contract_without_writes(self):
        db_path = Path.home() / "Library/Application Support/AffiliateAdmin/content.db"
        if not db_path.is_file():
            self.skipTest("live Studio database is unavailable")

        database_sha256 = hashlib.sha256(db_path.read_bytes()).hexdigest()
        source = StudioSource(db_path)
        page = cast(Any, SimpleNamespace(
            page_id="1008898512617594",
            caption_template="{caption}",
        ))
        with source.connect() as conn:
            rows = conn.execute("""
                SELECT id,ready_message_id,ready_video_url,
                       shopee_link,lazada_link,
                       ai_caption_text,ai_hashtags_json,ready_at
                FROM content_items
                WHERE status='ready'
                  AND COALESCE(ready_message_id,'')!=''
                  AND COALESCE(ready_video_url,'')!=''
                  AND COALESCE(shopee_link,'')!=''
                  AND COALESCE(lazada_link,'')!=''
                  AND COALESCE(ai_caption_text,'')!=''
                  AND COALESCE(ai_hashtags_json,'')!=''
                ORDER BY id
            """).fetchall()

        self.assertGreater(len(rows), 0)
        failures = []
        for row in rows:
            item = source._to_item(row)
            try:
                value = PublisherEngine.caption(page, item)
                lines = value.splitlines()
                tags = lines[2].split() if len(lines) == 3 else []
                if (
                    len(lines) != 3
                    or "\n\n" in value
                    or len(tags) != 3
                    or not all(tag.startswith("#") for tag in tags)
                    or len(value) > 130
                ):
                    failures.append({"id": item.content_id, "value": value})
            except Exception as exc:
                failures.append({"id": item.content_id, "error": str(exc)})

        self.assertEqual(failures, [], json.dumps(failures[:10], ensure_ascii=False))
        self.assertEqual(hashlib.sha256(db_path.read_bytes()).hexdigest(), database_sha256)


if __name__ == "__main__":
    unittest.main()