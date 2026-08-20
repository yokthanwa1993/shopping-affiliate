from __future__ import annotations

import json
import random
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
    ready_message_id: str
    ready_video_url: str
    shopee_url: str
    lazada_url: str
    caption: str
    ready_at: str


REQUIRED_COLUMNS = {
    "id", "status", "ready_message_id", "ready_video_url",
    "shopee_link", "lazada_link", "ai_caption_text", "ai_hashtags_json", "ready_at",
}

CAPTION_MAX_CHARS = 32


def compose_caption(caption_text: object, hashtags_json: object) -> str:
    caption = str(caption_text or "").strip()
    try:
        hashtags = json.loads(str(hashtags_json or "[]"))
    except json.JSONDecodeError as exc:
        raise StudioSourceError("studio_hashtags_invalid") from exc
    tags = [str(tag or "").strip() for tag in hashtags] if isinstance(hashtags, list) else []
    if not caption or len(tags) != 4 or len({tag.casefold() for tag in tags}) != 4:
        raise StudioSourceError("studio_metadata_incomplete")
    if (
        "\n" in caption or "\r" in caption or len(caption) > CAPTION_MAX_CHARS
        or "#" in caption
        or any(not tag.startswith("#") or any(ch.isspace() for ch in tag) for tag in tags)
    ):
        raise StudioSourceError("studio_metadata_invalid")
    return f"{caption}\n\n{' '.join(tags)}"


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
            ready_message_id=str(row["ready_message_id"] or "").strip(),
            ready_video_url=str(row["ready_video_url"] or "").strip(),
            shopee_url=str(row["shopee_link"] or "").strip(),
            lazada_url=str(row["lazada_link"] or "").strip(),
            caption=compose_caption(row["ai_caption_text"], row["ai_hashtags_json"]),
            ready_at=str(row["ready_at"] or "").strip(),
        )

    def strict_ready_count(self) -> int:
        with self.connect() as conn:
            return int(conn.execute("""
                SELECT COUNT(*) FROM content_items
                WHERE status='ready'
                  AND COALESCE(ready_message_id,'')!=''
                  AND COALESCE(ready_video_url,'')!=''
                  AND COALESCE(shopee_link,'')!=''
                  AND COALESCE(lazada_link,'')!=''
                  AND COALESCE(ai_caption_text,'')!=''
                  AND COALESCE(ai_hashtags_json,'')!=''
            """).fetchone()[0])

    def candidates(self, limit: int = 20, excluded_ids: Optional[Set[int]] = None,
                   allowed_ids: Optional[Set[int]] = None) -> List[StudioItem]:
        excluded_set = {int(value) for value in (excluded_ids or set())}
        limit_value = max(1, min(int(limit), 100))
        base_sql = """
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
        """
        if allowed_ids is not None:
            eligible = list({int(value) for value in allowed_ids} - excluded_set)
            if not eligible:
                return []
            random.shuffle(eligible)
            results: List[StudioItem] = []
            with self.connect() as conn:
                for start in range(0, len(eligible), 500):
                    remaining = limit_value - len(results)
                    if remaining <= 0:
                        break
                    chunk = eligible[start:start + 500]
                    placeholders = ",".join("?" for _ in chunk)
                    sql = base_sql + f" AND id IN ({placeholders}) ORDER BY RANDOM() LIMIT ?"
                    results.extend(
                        self._to_item(row)
                        for row in conn.execute(sql, [*chunk, remaining])
                    )
            return results

        excluded = sorted(excluded_set)
        where_excluded = ""
        params: List[object] = []
        if excluded:
            where_excluded = " AND id NOT IN (" + ",".join("?" for _ in excluded) + ")"
            params.extend(excluded)
        params.append(limit_value)
        sql = base_sql + where_excluded + " ORDER BY RANDOM() LIMIT ?"
        with self.connect() as conn:
            return [self._to_item(row) for row in conn.execute(sql, params)]

    def current(self, content_id: int) -> Optional[StudioItem]:
        with self.connect() as conn:
            row = conn.execute("""
                SELECT id,ready_message_id,ready_video_url,
                       shopee_link,lazada_link,
                       ai_caption_text,ai_hashtags_json,ready_at
                FROM content_items WHERE id=? AND status='ready'
            """, (int(content_id),)).fetchone()
            return self._to_item(row) if row else None
