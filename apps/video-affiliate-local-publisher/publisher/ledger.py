from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set


class LedgerError(RuntimeError):
    pass


POSTED_STATES = (
    "existing_story_bound", "post_confirmed", "final_shortlink_ok", "comment_pending", "verifying",
    "post_success_comment_failed", "post_success_verification_failed", "success",
)
COMMENT_RETRY_BASE_SECONDS = 5 * 60
COMMENT_RETRY_MAX_SECONDS = 6 * 60 * 60
TERMINAL_STATES = (
    "failed_pre_post", "post_outcome_unknown", "post_success_comment_failed",
    "post_success_verification_failed", "blocked_human_gate", "success", "shadow_ready",
)
PAGE_BLOCKING_STATES = (
    "posting", "stale_posting_review", "existing_story_bound", "post_confirmed",
    "final_shortlink_ok", "comment_pending", "verifying",
    "post_outcome_unknown", "post_success_verification_failed",
)
ALLOWED_TRANSITIONS = {
    "claimed": {"source_resolved", "failed_pre_post"},
    "source_resolved": {"downloaded", "failed_pre_post"},
    "downloaded": {"avatar_composing", "failed_pre_post"},
    "avatar_composing": {"avatar_ready", "failed_pre_post"},
    "avatar_ready": {"shortlink_preflight_ok", "shadow_ready", "failed_pre_post"},
    "shortlink_preflight_ok": {"posting", "failed_pre_post", "blocked_human_gate"},
    "posting": {"post_confirmed", "stale_posting_review", "post_outcome_unknown"},
    "stale_posting_review": {"existing_story_bound", "post_outcome_unknown"},
    "existing_story_bound": {"final_shortlink_ok", "post_success_comment_failed"},
    "post_confirmed": {"final_shortlink_ok", "post_success_comment_failed"},
    "final_shortlink_ok": {"comment_pending", "post_success_comment_failed"},
    "comment_pending": {"verifying", "post_success_comment_failed"},
    "verifying": {"success", "post_success_verification_failed"},
    "post_success_comment_failed": {"final_shortlink_ok", "comment_pending", "verifying"},
    "post_success_verification_failed": {"success"},
    "post_outcome_unknown": {"failed_pre_post"},
}

NO_POST_EVIDENCE_CODES = {
    "idbridge_rejected_before_upload",
    "idbridge_rejected_before_upload_and_graph_no_post",
    "facebook_upload_rejected_and_graph_no_post",
}

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS pages(
  page_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL,
  daily_success_limit INTEGER NOT NULL DEFAULT 0,
  reuse_success_from_page_id TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL,
  next_due_at INTEGER,
  campaign_sub1 TEXT NOT NULL DEFAULT '',
  shopee_account TEXT NOT NULL DEFAULT '',
  affiliate_id TEXT NOT NULL DEFAULT '',
  facebook_account TEXT NOT NULL DEFAULT '',
  avatar_path TEXT NOT NULL DEFAULT '',
  avatar_version TEXT NOT NULL DEFAULT '',
  caption_template TEXT NOT NULL DEFAULT '{caption}',
  last_success_at INTEGER,
  updated_at INTEGER NOT NULL
);
-- editor_message_id is a legacy SQLite column name retained for compatibility;
-- new writes store the canonical Ready message identity in it.
CREATE TABLE IF NOT EXISTS source_items(
  studio_content_id INTEGER PRIMARY KEY,
  editor_message_id TEXT NOT NULL UNIQUE,
  source_attachment_id TEXT NOT NULL DEFAULT '',
  source_sha256 TEXT NOT NULL DEFAULT '',
  shopee_url TEXT NOT NULL,
  lazada_url TEXT NOT NULL,
  caption TEXT NOT NULL,
  ready_at TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL,
  source_status TEXT NOT NULL DEFAULT 'ready'
);
CREATE TABLE IF NOT EXISTS source_archives(
  studio_content_id INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  archive_bytes INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY(studio_content_id,source_sha256),
  UNIQUE(archive_path),
  FOREIGN KEY(studio_content_id) REFERENCES source_items(studio_content_id)
);
CREATE TABLE IF NOT EXISTS post_attempts(
  attempt_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  studio_content_id INTEGER NOT NULL,
  slot_key TEXT NOT NULL,
  state TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  source_sha256 TEXT NOT NULL DEFAULT '',
  avatar_version TEXT NOT NULL DEFAULT '',
  fb_video_id TEXT NOT NULL DEFAULT '',
  fb_story_id TEXT NOT NULL DEFAULT '',
  fb_post_tail TEXT NOT NULL DEFAULT '',
  permalink TEXT NOT NULL DEFAULT '',
  comment_id TEXT NOT NULL DEFAULT '',
  preflight_shortlink TEXT NOT NULL DEFAULT '',
  final_shortlink TEXT NOT NULL DEFAULT '',
  posting_source TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_detail_redacted TEXT NOT NULL DEFAULT '',
  comment_retry_count INTEGER NOT NULL DEFAULT 0,
  comment_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  posted_at INTEGER,
  completed_at INTEGER,
  UNIQUE(page_id,slot_key)
);
DROP INDEX IF EXISTS ux_posted_page_content;
CREATE UNIQUE INDEX ux_posted_page_content
  ON post_attempts(page_id,studio_content_id)
  WHERE state IN ('existing_story_bound','post_confirmed','final_shortlink_ok','comment_pending','verifying','post_success_comment_failed','post_success_verification_failed','success');
DROP INDEX IF EXISTS ux_posted_page_sha;
CREATE UNIQUE INDEX ux_posted_page_sha
  ON post_attempts(page_id,source_sha256)
  WHERE source_sha256!='' AND state IN ('existing_story_bound','post_confirmed','final_shortlink_ok','comment_pending','verifying','post_success_comment_failed','post_success_verification_failed','success');
CREATE TABLE IF NOT EXISTS leases(
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  old_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
"""


class Ledger:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def migrate(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(pages)")}
            if "daily_success_limit" not in columns:
                conn.execute(
                    "ALTER TABLE pages ADD COLUMN daily_success_limit INTEGER NOT NULL DEFAULT 0"
                )
            if "reuse_success_from_page_id" not in columns:
                conn.execute(
                    "ALTER TABLE pages ADD COLUMN reuse_success_from_page_id TEXT NOT NULL DEFAULT ''"
                )
            attempt_columns = {
                str(row[1]) for row in conn.execute("PRAGMA table_info(post_attempts)")
            }
            if "comment_retry_count" not in attempt_columns:
                conn.execute(
                    "ALTER TABLE post_attempts ADD COLUMN comment_retry_count INTEGER NOT NULL DEFAULT 0"
                )
            if "comment_retry_at" not in attempt_columns:
                conn.execute("ALTER TABLE post_attempts ADD COLUMN comment_retry_at INTEGER")
            conn.execute("""
                UPDATE post_attempts
                SET comment_retry_count=CASE
                      WHEN comment_retry_count<1 THEN 1 ELSE comment_retry_count END,
                    comment_retry_at=COALESCE(comment_retry_at,updated_at)
                WHERE state='post_success_comment_failed'
            """)
            conn.execute("""
                UPDATE post_attempts
                SET comment_retry_count=CASE
                      WHEN comment_retry_count<1 THEN 1 ELSE comment_retry_count END,
                    comment_retry_at=COALESCE(comment_retry_at,updated_at)
                WHERE state='post_success_verification_failed'
            """)
        self.path.chmod(0o600)

    def sync_page(self, page: Any) -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO pages(page_id,name,enabled,interval_minutes,daily_success_limit,
                  reuse_success_from_page_id,timezone,campaign_sub1,
                  shopee_account,affiliate_id,facebook_account,avatar_path,avatar_version,
                  caption_template,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(page_id) DO UPDATE SET
                  name=excluded.name, enabled=excluded.enabled,
                  interval_minutes=excluded.interval_minutes,
                  daily_success_limit=excluded.daily_success_limit,
                  reuse_success_from_page_id=excluded.reuse_success_from_page_id,
                  timezone=excluded.timezone,
                  campaign_sub1=excluded.campaign_sub1, shopee_account=excluded.shopee_account,
                  affiliate_id=excluded.affiliate_id, facebook_account=excluded.facebook_account,
                  avatar_path=excluded.avatar_path, avatar_version=excluded.avatar_version,
                  caption_template=excluded.caption_template, updated_at=excluded.updated_at
            """, (page.page_id, page.name, int(page.enabled), page.interval_minutes,
                  page.daily_success_limit, page.reuse_success_from_page_id, page.timezone,
                  page.campaign_sub1, page.shopee_account, page.affiliate_id,
                  page.facebook_account, str(page.avatar_path), page.avatar_version,
                  page.caption_template, now))

    def due_pages(self, now: Optional[int] = None) -> List[sqlite3.Row]:
        current = int(now or time.time())
        with self.connect() as conn:
            return list(conn.execute("""
                SELECT * FROM pages WHERE enabled=1 AND (next_due_at IS NULL OR next_due_at<=?)
                ORDER BY COALESCE(next_due_at,0), page_id
            """, (current,)))

    def acquire_lease(self, key: str, owner: str, ttl: int, now: Optional[int] = None) -> bool:
        current = int(now or time.time())
        expires = current + max(1, int(ttl))
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT owner_id,expires_at FROM leases WHERE lease_key=?", (key,)).fetchone()
            if row and row["owner_id"] != owner and int(row["expires_at"]) > current:
                conn.rollback()
                return False
            conn.execute("""
                INSERT INTO leases(lease_key,owner_id,expires_at,heartbeat_at) VALUES(?,?,?,?)
                ON CONFLICT(lease_key) DO UPDATE SET owner_id=excluded.owner_id,
                  expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at
            """, (key, owner, expires, current))
            conn.commit()
            return True

    def heartbeat(self, key: str, owner: str, ttl: int, now: Optional[int] = None) -> bool:
        current = int(now or time.time())
        with self.connect() as conn:
            cur = conn.execute("""
                UPDATE leases SET expires_at=?,heartbeat_at=?
                WHERE lease_key=? AND owner_id=? AND expires_at>?
            """, (current + max(1, int(ttl)), current, key, owner, current))
            return cur.rowcount == 1

    def release_lease(self, key: str, owner: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM leases WHERE lease_key=? AND owner_id=?", (key, owner))

    def used_content_ids(self, page_id: str, *, include_shadow: bool = False) -> Set[int]:
        states = POSTED_STATES + (("shadow_ready",) if include_shadow else ())
        placeholders = ",".join("?" for _ in states)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT studio_content_id FROM post_attempts WHERE page_id=? AND state IN ({placeholders})",
                (page_id, *states),
            )
            return {int(row[0]) for row in rows}

    def successful_content_ids(self, page_id: str) -> Set[int]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT studio_content_id FROM post_attempts WHERE page_id=? AND state='success'",
                (str(page_id),),
            )
            return {int(row[0]) for row in rows}

    def success_count_between(self, page_id: str, start_at: int, end_at: int) -> int:
        with self.connect() as conn:
            return int(conn.execute(
                """
                SELECT COUNT(*) FROM post_attempts
                WHERE page_id=? AND state='success'
                  AND completed_at>=? AND completed_at<?
                """,
                (str(page_id), int(start_at), int(end_at)),
            ).fetchone()[0])

    def posted_count_between(self, page_id: str, start_at: int, end_at: int) -> int:
        placeholders = ",".join("?" for _ in POSTED_STATES)
        with self.connect() as conn:
            return int(conn.execute(
                f"""
                SELECT COUNT(*) FROM post_attempts
                WHERE page_id=? AND state IN ({placeholders})
                  AND COALESCE(posted_at,created_at)>=?
                  AND COALESCE(posted_at,created_at)<?
                """,
                (str(page_id), *POSTED_STATES, int(start_at), int(end_at)),
            ).fetchone()[0])

    def set_next_due_at(self, page_id: str, next_due_at: int, now: Optional[int] = None) -> None:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute(
                "UPDATE pages SET next_due_at=?,updated_at=? WHERE page_id=?",
                (int(next_due_at), current, str(page_id)),
            )

    def page_has_sha(self, page_id: str, sha256: str) -> bool:
        if not sha256:
            return False
        placeholders = ",".join("?" for _ in POSTED_STATES)
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT 1 FROM post_attempts WHERE page_id=? AND source_sha256=? AND state IN ({placeholders}) LIMIT 1",
                (page_id, sha256, *POSTED_STATES),
            ).fetchone()
            return bool(row)

    def claim_attempt(self, page_id: str, content_id: int, slot_key: str, trigger: str) -> str:
        attempt_id = uuid.uuid4().hex
        now = int(time.time())
        try:
            with self.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("""
                    INSERT INTO post_attempts(attempt_id,page_id,studio_content_id,slot_key,state,
                      trigger_source,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?)
                """, (attempt_id, page_id, int(content_id), slot_key, "claimed", trigger, now, now))
                conn.execute("INSERT INTO events(attempt_id,old_state,new_state,created_at) VALUES(?,?,?,?)",
                             (attempt_id, "", "claimed", now))
                conn.commit()
        except sqlite3.IntegrityError as exc:
            raise LedgerError("attempt_claim_conflict") from exc
        return attempt_id

    def upsert_source(self, item: Any, attachment_id: str = "", sha256: str = "") -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO source_items(studio_content_id,editor_message_id,source_attachment_id,
                  source_sha256,shopee_url,lazada_url,caption,ready_at,last_seen_at,source_status)
                VALUES(?,?,?,?,?,?,?,?,?,'ready')
                ON CONFLICT(studio_content_id) DO UPDATE SET
                  editor_message_id=excluded.editor_message_id,
                  source_attachment_id=CASE WHEN excluded.source_attachment_id!='' THEN excluded.source_attachment_id ELSE source_items.source_attachment_id END,
                  source_sha256=CASE WHEN excluded.source_sha256!='' THEN excluded.source_sha256 ELSE source_items.source_sha256 END,
                  shopee_url=excluded.shopee_url,lazada_url=excluded.lazada_url,caption=excluded.caption,
                  ready_at=excluded.ready_at,last_seen_at=excluded.last_seen_at,source_status='ready'
            """, (item.content_id, item.ready_message_id, attachment_id, sha256,
                  item.shopee_url, item.lazada_url, item.caption, item.ready_at, now))

    def source_item(self, content_id: int) -> Dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM source_items WHERE studio_content_id=?",
                (int(content_id),),
            ).fetchone()
            if not row:
                raise LedgerError("source_item_not_found")
            return dict(row)

    def record_source_archive(self, content_id: int, sha256: str, archive_path: Path,
                              archive_bytes: int, now: Optional[int] = None) -> None:
        path = Path(archive_path).expanduser()
        sha = str(sha256 or "").strip().lower()
        size = int(archive_bytes)
        if int(content_id) <= 0 or len(sha) != 64 or not path.is_absolute() or size <= 0:
            raise LedgerError("source_archive_invalid")
        archived_at = int(now or time.time())
        with self.connect() as conn:
            try:
                conn.execute("""
                    INSERT INTO source_archives(studio_content_id,source_sha256,archive_path,
                      archive_bytes,archived_at)
                    VALUES(?,?,?,?,?)
                    ON CONFLICT(studio_content_id,source_sha256) DO UPDATE SET
                      archive_path=excluded.archive_path,
                      archive_bytes=excluded.archive_bytes,
                      archived_at=MIN(source_archives.archived_at,excluded.archived_at)
                """, (int(content_id), sha, str(path), size, archived_at))
            except sqlite3.IntegrityError as exc:
                raise LedgerError("source_archive_conflict") from exc

    def source_archive(self, content_id: int, sha256: str) -> Optional[Dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute("""
                SELECT * FROM source_archives
                WHERE studio_content_id=? AND source_sha256=?
            """, (int(content_id), str(sha256 or "").strip().lower())).fetchone()
            return dict(row) if row else None

    def classify_stale_posting(self, stale_after_seconds: int,
                               now: Optional[int] = None) -> List[Dict[str, Any]]:
        """Move abandoned Facebook writes to a fail-closed review state."""
        current = int(now or time.time())
        threshold = current - max(300, int(stale_after_seconds))
        classified: List[Dict[str, Any]] = []
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = list(conn.execute("""
                SELECT attempt_id,page_id,studio_content_id,source_sha256,updated_at
                FROM post_attempts
                WHERE state='posting'
                  AND TRIM(COALESCE(fb_story_id,''))=''
                  AND TRIM(COALESCE(fb_video_id,''))=''
                  AND updated_at<=?
                ORDER BY updated_at,attempt_id
            """, (threshold,)))
            for row in rows:
                fields = {
                    "error_code": "stale_posting_requires_existing_story_recovery",
                    "error_detail_redacted": "process_ended_after_post_invocation; repost_forbidden",
                }
                cur = conn.execute("""
                    UPDATE post_attempts
                    SET state='stale_posting_review',error_code=?,error_detail_redacted=?,
                        updated_at=?,completed_at=NULL
                    WHERE attempt_id=? AND state='posting'
                      AND TRIM(COALESCE(fb_story_id,''))=''
                      AND TRIM(COALESCE(fb_video_id,''))=''
                      AND updated_at<=?
                """, (
                    fields["error_code"], fields["error_detail_redacted"], current,
                    str(row["attempt_id"]), threshold,
                ))
                if cur.rowcount != 1:
                    continue
                conn.execute("""
                    INSERT INTO events(attempt_id,old_state,new_state,detail_json,created_at)
                    VALUES(?,?,?,?,?)
                """, (
                    str(row["attempt_id"]), "posting", "stale_posting_review",
                    json.dumps(fields, ensure_ascii=False), current,
                ))
                classified.append(dict(row))
            conn.commit()
        return classified

    def bind_existing_story(self, attempt_id: str, *, fb_story_id: str,
                            fb_post_tail: str, fb_video_id: str, permalink: str,
                            posting_source: str, posted_at: int) -> None:
        """Audit-bind one verified Facebook story to its original stale attempt."""
        story_id = str(fb_story_id or "").strip()
        post_tail = str(fb_post_tail or "").strip()
        video_id = str(fb_video_id or "").strip()
        if not story_id or not post_tail.isdigit() or not video_id.isdigit():
            raise LedgerError("existing_story_identity_invalid")
        self.transition(attempt_id, "existing_story_bound", {
            "fb_story_id": story_id,
            "fb_post_tail": post_tail,
            "fb_video_id": video_id,
            "permalink": str(permalink or "").strip(),
            "posting_source": str(posting_source or "").strip(),
            "posted_at": int(posted_at),
            "error_code": "",
            "error_detail_redacted": "",
        })

    def attempt(self, attempt_id: str) -> sqlite3.Row:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM post_attempts WHERE attempt_id=?", (attempt_id,)).fetchone()
            if not row:
                raise LedgerError("attempt_not_found")
            return row

    def transition(self, attempt_id: str, new_state: str, fields: Optional[Dict[str, Any]] = None) -> None:
        fields = dict(fields or {})
        if new_state == "success":
            fields.setdefault("error_code", "")
            fields.setdefault("error_detail_redacted", "")
        allowed_fields = {
            "source_sha256", "avatar_version", "fb_video_id", "fb_story_id", "fb_post_tail",
            "permalink", "comment_id", "preflight_shortlink", "final_shortlink", "posting_source",
            "error_code", "error_detail_redacted", "comment_retry_count", "comment_retry_at",
            "posted_at", "completed_at",
        }
        if any(key not in allowed_fields for key in fields):
            raise LedgerError("attempt_field_invalid")
        now = int(time.time())
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT state FROM post_attempts WHERE attempt_id=?", (attempt_id,)).fetchone()
            if not row:
                conn.rollback()
                raise LedgerError("attempt_not_found")
            old_state = str(row["state"])
            if new_state not in ALLOWED_TRANSITIONS.get(old_state, set()):
                conn.rollback()
                raise LedgerError(f"state_transition_invalid:{old_state}:{new_state}")
            assignments = ["state=?", "updated_at=?"]
            values: List[Any] = [new_state, now]
            for key, value in fields.items():
                assignments.append(f"{key}=?")
                values.append(value)
            if new_state in TERMINAL_STATES and "completed_at" not in fields:
                assignments.append("completed_at=?")
                values.append(now)
            values.append(attempt_id)
            try:
                conn.execute(f"UPDATE post_attempts SET {','.join(assignments)} WHERE attempt_id=?", values)
            except sqlite3.IntegrityError as exc:
                conn.rollback()
                raise LedgerError("post_duplicate_guard") from exc
            conn.execute("INSERT INTO events(attempt_id,old_state,new_state,detail_json,created_at) VALUES(?,?,?,?,?)",
                         (attempt_id, old_state, new_state, json.dumps(fields, ensure_ascii=False), now))
            conn.commit()

    def align_success_shortlink(self, attempt_id: str, shortlink: str,
                                reason: str, now: Optional[int] = None) -> None:
        """Audit one verified historical comment repair without changing post state."""
        link = str(shortlink or "").strip()
        if not link.startswith("https://s.shopee.co.th/"):
            raise LedgerError("success_shortlink_invalid")
        detail = str(reason or "").strip()
        if not detail:
            raise LedgerError("success_shortlink_reason_missing")
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT state,preflight_shortlink FROM post_attempts WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
            if not row:
                conn.rollback()
                raise LedgerError("attempt_not_found")
            if str(row["state"]) != "success":
                conn.rollback()
                raise LedgerError("success_shortlink_state_invalid")
            if str(row["preflight_shortlink"] or "").strip() != link:
                conn.rollback()
                raise LedgerError("success_shortlink_preflight_mismatch")
            conn.execute(
                "UPDATE post_attempts SET final_shortlink=?,updated_at=? WHERE attempt_id=?",
                (link, current, attempt_id),
            )
            conn.execute("""
                INSERT INTO events(attempt_id,old_state,new_state,detail_json,created_at)
                VALUES(?,?,?,?,?)
            """, (
                attempt_id, "success", "success",
                json.dumps({"final_shortlink": link, "repair": detail}, ensure_ascii=False),
                current,
            ))
            conn.commit()

    @staticmethod
    def comment_retry_delay(retry_count: int) -> int:
        exponent = max(0, int(retry_count) - 1)
        return min(COMMENT_RETRY_MAX_SECONDS, COMMENT_RETRY_BASE_SECONDS * (2 ** exponent))

    def record_comment_failure(self, attempt_id: str, code: str, detail: str,
                               now: Optional[int] = None) -> int:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("""
                SELECT state,comment_retry_count FROM post_attempts WHERE attempt_id=?
            """, (attempt_id,)).fetchone()
            if not row:
                conn.rollback()
                raise LedgerError("attempt_not_found")
            old_state = str(row["state"])
            if old_state == "post_success_comment_failed":
                new_state = old_state
            elif "post_success_comment_failed" in ALLOWED_TRANSITIONS.get(old_state, set()):
                new_state = "post_success_comment_failed"
            else:
                conn.rollback()
                raise LedgerError(f"state_transition_invalid:{old_state}:post_success_comment_failed")
            retry_count = int(row["comment_retry_count"] or 0) + 1
            retry_at = current + self.comment_retry_delay(retry_count)
            fields = {
                "error_code": str(code)[:100],
                "error_detail_redacted": str(detail)[:240],
                "comment_retry_count": retry_count,
                "comment_retry_at": retry_at,
            }
            conn.execute("""
                UPDATE post_attempts
                SET state=?,error_code=?,error_detail_redacted=?,comment_retry_count=?,
                    comment_retry_at=?,updated_at=?,completed_at=?
                WHERE attempt_id=?
            """, (
                new_state, fields["error_code"], fields["error_detail_redacted"],
                retry_count, retry_at, current, current, attempt_id,
            ))
            conn.execute("""
                INSERT INTO events(attempt_id,old_state,new_state,detail_json,created_at)
                VALUES(?,?,?,?,?)
            """, (
                attempt_id, old_state, new_state,
                json.dumps(fields, ensure_ascii=False), current,
            ))
            conn.commit()
        return retry_at

    def record_verification_failure(self, attempt_id: str, code: str, detail: str,
                                    now: Optional[int] = None) -> int:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("""
                SELECT state,comment_retry_count FROM post_attempts WHERE attempt_id=?
            """, (attempt_id,)).fetchone()
            if not row:
                conn.rollback()
                raise LedgerError("attempt_not_found")
            old_state = str(row["state"])
            if old_state == "post_success_verification_failed":
                new_state = old_state
            elif "post_success_verification_failed" in ALLOWED_TRANSITIONS.get(old_state, set()):
                new_state = "post_success_verification_failed"
            else:
                conn.rollback()
                raise LedgerError(
                    f"state_transition_invalid:{old_state}:post_success_verification_failed"
                )
            retry_count = int(row["comment_retry_count"] or 0) + 1
            retry_at = current + self.comment_retry_delay(retry_count)
            fields = {
                "error_code": str(code)[:100],
                "error_detail_redacted": str(detail)[:240],
                "comment_retry_count": retry_count,
                "comment_retry_at": retry_at,
            }
            conn.execute("""
                UPDATE post_attempts
                SET state=?,error_code=?,error_detail_redacted=?,comment_retry_count=?,
                    comment_retry_at=?,updated_at=?,completed_at=?
                WHERE attempt_id=?
            """, (
                new_state, fields["error_code"], fields["error_detail_redacted"],
                retry_count, retry_at, current, current, attempt_id,
            ))
            conn.execute("""
                INSERT INTO events(attempt_id,old_state,new_state,detail_json,created_at)
                VALUES(?,?,?,?,?)
            """, (
                attempt_id, old_state, new_state,
                json.dumps(fields, ensure_ascii=False), current,
            ))
            conn.commit()
        return retry_at

    def due_comment_retries(self, now: Optional[int] = None, limit: int = 1) -> List[Dict[str, Any]]:
        current = int(now or time.time())
        with self.connect() as conn:
            rows = conn.execute("""
                SELECT * FROM post_attempts
                WHERE state IN ('post_success_comment_failed','post_success_verification_failed')
                  AND (comment_retry_at IS NULL OR comment_retry_at<=?)
                ORDER BY COALESCE(comment_retry_at,updated_at),updated_at,attempt_id
                LIMIT ?
            """, (current, max(1, int(limit))))
            return [dict(row) for row in rows]

    def fail_pre_post(self, attempt_id: str, code: str, detail: str) -> None:
        row = self.attempt(attempt_id)
        if row["state"] in TERMINAL_STATES:
            return
        self.transition(attempt_id, "failed_pre_post", {
            "error_code": code[:100], "error_detail_redacted": detail[:240],
        })

    def resolve_unknown_no_post(self, attempt_id: str, evidence_code: str) -> None:
        """Close an unknown outcome only after operator-confirmed live readback.

        This preserves the original attempt and writes an auditable state transition.
        It must never be used when a Facebook object may have been created.
        """
        if evidence_code not in NO_POST_EVIDENCE_CODES:
            raise LedgerError("no_post_evidence_invalid")
        row = self.attempt(attempt_id)
        if str(row["state"]) != "post_outcome_unknown":
            raise LedgerError("unknown_resolution_state_invalid")
        self.transition(attempt_id, "failed_pre_post", {
            "error_code": "operator_confirmed_no_post",
            "error_detail_redacted": f"evidence={evidence_code}",
        })

    def advance_page_after_success(self, page_id: str, interval_minutes: int, now: Optional[int] = None) -> None:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("""
                UPDATE pages
                SET last_success_at=?,
                    next_due_at=CASE
                      WHEN next_due_at IS NULL OR next_due_at<=? THEN ?
                      ELSE next_due_at END,
                    updated_at=?
                WHERE page_id=?
            """, (current, current, current + interval_minutes * 60, current, page_id))

    def advance_page_after_post(self, page_id: str, interval_minutes: int,
                                now: Optional[int] = None) -> None:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("""
                UPDATE pages
                SET next_due_at=CASE
                      WHEN next_due_at IS NULL OR next_due_at<=? THEN ?
                      ELSE next_due_at END,
                    updated_at=?
                WHERE page_id=?
            """, (current, current + interval_minutes * 60, current, page_id))

    def advance_page_after_shadow(self, page_id: str, interval_minutes: int, now: Optional[int] = None) -> None:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("UPDATE pages SET next_due_at=?,updated_at=? WHERE page_id=?",
                         (current + interval_minutes * 60, current, page_id))

    def attempts_in_states(self, states: Sequence[str], page_id: Optional[str] = None) -> List[Dict[str, Any]]:
        if not states:
            return []
        placeholders = ",".join("?" for _ in states)
        params: List[Any] = list(states)
        page_filter = ""
        if page_id is not None:
            page_filter = " AND page_id=?"
            params.append(str(page_id))
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM post_attempts WHERE state IN ({placeholders}){page_filter} ORDER BY updated_at",
                tuple(params),
            )
            return [dict(row) for row in rows]

    def summary(self) -> Dict[str, Any]:
        with self.connect() as conn:
            states = {str(row[0]): int(row[1]) for row in conn.execute(
                "SELECT state,COUNT(*) FROM post_attempts GROUP BY state"
            )}
            active_leases = int(conn.execute("SELECT COUNT(*) FROM leases WHERE expires_at>?", (int(time.time()),)).fetchone()[0])
            archive = conn.execute(
                "SELECT COUNT(*),COALESCE(SUM(archive_bytes),0) FROM source_archives"
            ).fetchone()
            due_comment_retries = int(conn.execute("""
                SELECT COUNT(*) FROM post_attempts
                WHERE state IN ('post_success_comment_failed','post_success_verification_failed')
                  AND (comment_retry_at IS NULL OR comment_retry_at<=?)
            """, (int(time.time()),)).fetchone()[0])
            last = conn.execute("SELECT attempt_id,page_id,studio_content_id,state,updated_at,error_code FROM post_attempts ORDER BY updated_at DESC LIMIT 1").fetchone()
            return {
                "attempts": sum(states.values()),
                "states": states,
                "active_leases": active_leases,
                "source_archives": int(archive[0]),
                "source_archive_bytes": int(archive[1]),
                "due_comment_retries": due_comment_retries,
                "last_attempt": dict(last) if last else None,
            }
