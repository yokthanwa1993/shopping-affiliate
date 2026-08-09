from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Set
from urllib.parse import quote


class StudioSourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class StudioItem:
    content_id: int
    editor_message_id: str
    editor_video_url: str
    shopee_url: str
    lazada_url: str
    caption: str
    ready_at: str


REQUIRED_COLUMNS = {
    "id", "status", "edited_message_id", "editor_video_url",
    "shopee_link", "lazada_link", "ai_post_caption", "ready_at",
}


class StudioSource:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    def connect(self) -> sqlite3.Connection:
        if not self.db_path.is_file():
            raise StudioSourceError("studio_db_missing")
        uri = self.db_path.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(content_items)")}
        missing = REQUIRED_COLUMNS - columns
        if missing:
            conn.close()
            raise StudioSourceError("studio_columns_missing:" + ",".join(sorted(missing)))
        return conn

    @staticmethod
    def _to_item(row: sqlite3.Row) -> StudioItem:
        return StudioItem(
            content_id=int(row["id"]),
            editor_message_id=str(row["edited_message_id"] or "").strip(),
            editor_video_url=str(row["editor_video_url"] or "").strip(),
            shopee_url=str(row["shopee_link"] or "").strip(),
            lazada_url=str(row["lazada_link"] or "").strip(),
            caption=str(row["ai_post_caption"] or "").strip(),
            ready_at=str(row["ready_at"] or "").strip(),
        )

    def strict_ready_count(self) -> int:
        with self.connect() as conn:
            return int(conn.execute("""
                SELECT COUNT(*) FROM content_items
                WHERE status='ready'
                  AND COALESCE(edited_message_id,'')!=''
                  AND COALESCE(editor_video_url,'')!=''
                  AND COALESCE(shopee_link,'')!=''
                  AND COALESCE(lazada_link,'')!=''
                  AND COALESCE(ai_post_caption,'')!=''
            """).fetchone()[0])

    def candidates(self, limit: int = 20, excluded_ids: Optional[Set[int]] = None) -> List[StudioItem]:
        excluded = sorted(excluded_ids or set())
        where_excluded = ""
        params: List[object] = []
        if excluded:
            where_excluded = " AND id NOT IN (" + ",".join("?" for _ in excluded) + ")"
            params.extend(excluded)
        params.append(max(1, min(int(limit), 100)))
        sql = """
            SELECT id,edited_message_id,editor_video_url,shopee_link,lazada_link,ai_post_caption,ready_at
            FROM content_items
            WHERE status='ready'
              AND COALESCE(edited_message_id,'')!=''
              AND COALESCE(editor_video_url,'')!=''
              AND COALESCE(shopee_link,'')!=''
              AND COALESCE(lazada_link,'')!=''
              AND COALESCE(ai_post_caption,'')!=''
        """ + where_excluded + " ORDER BY RANDOM() LIMIT ?"
        with self.connect() as conn:
            return [self._to_item(row) for row in conn.execute(sql, params)]

    def current(self, content_id: int) -> Optional[StudioItem]:
        with self.connect() as conn:
            row = conn.execute("""
                SELECT id,edited_message_id,editor_video_url,shopee_link,lazada_link,ai_post_caption,ready_at
                FROM content_items WHERE id=? AND status='ready'
            """, (int(content_id),)).fetchone()
            return self._to_item(row) if row else None
