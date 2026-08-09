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
    "post_confirmed", "final_shortlink_ok", "comment_pending", "verifying",
    "post_success_comment_failed", "post_success_verification_failed", "success",
)
TERMINAL_STATES = (
    "failed_pre_post", "post_outcome_unknown", "post_success_comment_failed",
    "post_success_verification_failed", "blocked_human_gate", "success", "shadow_ready",
)
PAGE_BLOCKING_STATES = (
    "posting", "post_confirmed", "final_shortlink_ok", "comment_pending", "verifying",
    "post_outcome_unknown", "post_success_verification_failed",
)
ALLOWED_TRANSITIONS = {
    "claimed": {"source_resolved", "failed_pre_post"},
    "source_resolved": {"downloaded", "failed_pre_post"},
    "downloaded": {"avatar_composing", "failed_pre_post"},
    "avatar_composing": {"avatar_ready", "failed_pre_post"},
    "avatar_ready": {"shortlink_preflight_ok", "shadow_ready", "failed_pre_post"},
    "shortlink_preflight_ok": {"posting", "failed_pre_post", "blocked_human_gate"},
    "posting": {"post_confirmed", "post_outcome_unknown"},
    "post_confirmed": {"final_shortlink_ok", "post_success_comment_failed"},
    "final_shortlink_ok": {"comment_pending", "post_success_comment_failed"},
    "comment_pending": {"verifying", "post_success_comment_failed"},
    "verifying": {"success", "post_success_verification_failed"},
    "post_success_comment_failed": {"final_shortlink_ok", "comment_pending", "verifying"},
    "post_success_verification_failed": {"success"},
}

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS pages(
  page_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  posted_at INTEGER,
  completed_at INTEGER,
  UNIQUE(page_id,slot_key)
);
DROP INDEX IF EXISTS ux_posted_page_content;
CREATE UNIQUE INDEX ux_posted_page_content
  ON post_attempts(page_id,studio_content_id)
  WHERE state IN ('post_confirmed','final_shortlink_ok','comment_pending','verifying','post_success_comment_failed','post_success_verification_failed','success');
DROP INDEX IF EXISTS ux_posted_page_sha;
CREATE UNIQUE INDEX ux_posted_page_sha
  ON post_attempts(page_id,source_sha256)
  WHERE source_sha256!='' AND state IN ('post_confirmed','final_shortlink_ok','comment_pending','verifying','post_success_comment_failed','post_success_verification_failed','success');
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
        self.path.chmod(0o600)

    def sync_page(self, page: Any) -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO pages(page_id,name,enabled,interval_minutes,timezone,campaign_sub1,
                  shopee_account,affiliate_id,facebook_account,avatar_path,avatar_version,
                  caption_template,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(page_id) DO UPDATE SET
                  name=excluded.name, enabled=excluded.enabled,
                  interval_minutes=excluded.interval_minutes, timezone=excluded.timezone,
                  campaign_sub1=excluded.campaign_sub1, shopee_account=excluded.shopee_account,
                  affiliate_id=excluded.affiliate_id, facebook_account=excluded.facebook_account,
                  avatar_path=excluded.avatar_path, avatar_version=excluded.avatar_version,
                  caption_template=excluded.caption_template, updated_at=excluded.updated_at
            """, (page.page_id, page.name, int(page.enabled), page.interval_minutes, page.timezone,
                  page.campaign_sub1, page.shopee_account, page.affiliate_id, page.facebook_account,
                  str(page.avatar_path), page.avatar_version, page.caption_template, now))

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
            """, (item.content_id, item.editor_message_id, attachment_id, sha256,
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
            "error_code", "error_detail_redacted", "posted_at", "completed_at",
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

    def fail_pre_post(self, attempt_id: str, code: str, detail: str) -> None:
        row = self.attempt(attempt_id)
        if row["state"] in TERMINAL_STATES:
            return
        self.transition(attempt_id, "failed_pre_post", {
            "error_code": code[:100], "error_detail_redacted": detail[:240],
        })

    def advance_page_after_success(self, page_id: str, interval_minutes: int, now: Optional[int] = None) -> None:
        current = int(now or time.time())
        with self.connect() as conn:
            conn.execute("UPDATE pages SET last_success_at=?,next_due_at=?,updated_at=? WHERE page_id=?",
                         (current, current + interval_minutes * 60, current, page_id))

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
            last = conn.execute("SELECT attempt_id,page_id,studio_content_id,state,updated_at,error_code FROM post_attempts ORDER BY updated_at DESC LIMIT 1").fetchone()
            return {
                "attempts": sum(states.values()),
                "states": states,
                "active_leases": active_leases,
                "last_attempt": dict(last) if last else None,
            }
