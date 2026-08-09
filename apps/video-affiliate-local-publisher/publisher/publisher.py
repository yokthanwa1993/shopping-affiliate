from __future__ import annotations

import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from .asset_server import AssetServer
from .avatar_client import AvatarClient
from .avatar_source import sync_cloudflare_avatar
from .config import AppConfig, PageConfig
from .discord_source import DiscordSource
from .idbridge_client import IDBridgeClient, IDBridgeError
from .ledger import Ledger, LedgerError, PAGE_BLOCKING_STATES
from .notifier import Notifier
from .scheduler import manual_slot_key, slot_key
from .security import discord_bot_token, idbridge_service_auth, redact_error
from .spool import Spool
from .studio_source import StudioItem, StudioSource


class PublisherError(RuntimeError):
    pass


URL_PATTERN = re.compile(r"https?://", re.IGNORECASE)


def _error_code(error: Exception) -> str:
    raw = str(error or "publisher_failed")
    code = raw.split(":", 1)[0].strip()
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", code)[:100] or "publisher_failed"


class PublisherEngine:
    def __init__(self, config: AppConfig):
        self.config = config
        self.ledger = Ledger(config.ledger_db)
        self.studio = StudioSource(config.studio_db)
        self.spool = Spool(config.spool_root)
        self.discord = DiscordSource(
            config.editor_channel_id,
            discord_bot_token(config.discord_env_file),
        )
        self._idbridge: Optional[IDBridgeClient] = None
        self.notifier = Notifier()
        for page in config.pages:
            self.ledger.sync_page(page)

    @property
    def idbridge(self) -> IDBridgeClient:
        if self._idbridge is None:
            self._idbridge = IDBridgeClient(
                self.config.idbridge_url,
                idbridge_service_auth(self.config.idbridge_auth_file),
            )
        return self._idbridge

    def page(self, page_id: str) -> PageConfig:
        for page in self.config.pages:
            if page.page_id == str(page_id):
                return page
        raise PublisherError("page_not_configured")

    @staticmethod
    def caption(page: PageConfig, item: StudioItem) -> str:
        caption = page.caption_template.format(caption=item.caption).strip()
        if not caption:
            raise PublisherError("caption_empty")
        if URL_PATTERN.search(caption):
            raise PublisherError("caption_visible_link_forbidden")
        return caption

    @staticmethod
    def canonical_story(page_id: str, story_id: str) -> tuple[str, str]:
        raw = str(story_id or "").strip()
        if not raw:
            raise PublisherError("story_id_missing")
        canonical = raw if raw.startswith(page_id + "_") else f"{page_id}_{raw.split('_')[-1]}"
        tail = canonical.split("_", 1)[1]
        if not tail.isdigit():
            raise PublisherError("story_id_invalid")
        return canonical, tail

    def _notify_failure(self, page_id: str, attempt_id: str, state: str, error: Exception) -> None:
        try:
            self.notifier.send(
                "⚠️ Local publisher ต้องตรวจสอบ",
                "error",
                [
                    ("Page", page_id, True),
                    ("State", state, True),
                    ("Attempt", attempt_id, False),
                    ("Error", _error_code(error), False),
                ],
            )
        except Exception:
            pass

    def _notify_success(self, page_id: str, attempt_id: str, content_id: int) -> None:
        try:
            self.notifier.send(
                "✅ Local publisher โพสต์สำเร็จ",
                "ok",
                [
                    ("Page", page_id, True),
                    ("Content", str(content_id), True),
                    ("State", "success + live readback", False),
                    ("Attempt", attempt_id, False),
                ],
            )
        except Exception:
            pass

    def _verify_live_readback(self, page: PageConfig, story_id: str,
                              comment_id: str, expected_comment: str) -> Dict[str, str]:
        post = self.idbridge.graph_get(
            page.power_editor_account, story_id,
            {"fields": "id,permalink_url,created_time,is_published"},
        )
        if str(post.get("id") or "") != story_id:
            raise PublisherError("post_readback_identity_mismatch")
        if post.get("is_published") is not True:
            raise PublisherError("post_readback_not_published")
        comment = self.idbridge.graph_get(
            page.power_editor_account, comment_id,
            {"fields": "id,parent,from,message"},
        )
        if str(comment.get("id") or "") != comment_id:
            raise PublisherError("comment_readback_identity_mismatch")
        author_raw = comment.get("from")
        author: Dict[str, Any] = author_raw if isinstance(author_raw, dict) else {}
        if str(author.get("id") or "") != page.page_id:
            raise PublisherError("comment_readback_author_mismatch")
        parent_raw = comment.get("parent")
        parent: Dict[str, Any] = parent_raw if isinstance(parent_raw, dict) else {}
        parent_id = str(parent.get("id") or "")
        if parent_id and parent_id != story_id:
            raise PublisherError("comment_readback_parent_mismatch")
        comments = self.idbridge.graph_get(
            page.power_editor_account, f"{story_id}/comments",
            {"fields": "id", "limit": "100"},
        )
        comment_rows = comments.get("data")
        if not isinstance(comment_rows, list) or not any(
            isinstance(row, dict) and str(row.get("id") or "") == comment_id
            for row in comment_rows
        ):
            raise PublisherError("comment_readback_not_attached")
        if str(comment.get("message") or "").strip() != expected_comment.strip():
            raise PublisherError("comment_readback_message_mismatch")
        return {"permalink": str(post.get("permalink_url") or "").strip()}

    def _find_existing_comment(self, page: PageConfig, story_id: str,
                               message: str) -> str:
        payload = self.idbridge.graph_get(
            page.power_editor_account, f"{story_id}/comments",
            {"fields": "id,message,from", "limit": "100"},
        )
        rows = payload.get("data")
        if not isinstance(rows, list):
            return ""
        for row in rows:
            if not isinstance(row, dict) or str(row.get("message") or "").strip() != message:
                continue
            author = row.get("from") if isinstance(row.get("from"), dict) else {}
            if str(author.get("id") or "") == page.page_id:
                return str(row.get("id") or "").strip()
        return ""

    def _preflight_identity(self, page: PageConfig) -> None:
        self.idbridge.ensure_page(page.facebook_account, page.page_id)
        graph_page = self.idbridge.graph_get(
            page.power_editor_account, page.page_id, {"fields": "id"},
        )
        if str(graph_page.get("id") or "") != page.page_id:
            raise PublisherError("power_editor_page_readback_failed")
        accounts = self.idbridge.shopee_accounts()
        if not any(str(row.get("account") or row.get("spc_u") or "") == page.shopee_account for row in accounts):
            raise PublisherError("shopee_account_unavailable")

    def _publish_real(self, page: PageConfig, item: StudioItem, attempt_id: str,
                      composed_path: Path) -> Dict[str, Any]:
        if not self.config.writes_enabled:
            raise PublisherError("external_writes_disabled")
        self._preflight_identity(page)
        preflight = self.idbridge.shorten(
            item.shopee_url, page.shopee_account, page.affiliate_id,
            page.campaign_sub1, page.page_id, "",
        )
        self.ledger.transition(attempt_id, "shortlink_preflight_ok", {"preflight_shortlink": preflight})
        caption = self.caption(page, item)
        with AssetServer() as server:
            video_url = server.register(composed_path)
            self.ledger.transition(attempt_id, "posting")
            try:
                posted = self.idbridge.post(page.page_id, video_url, caption, page.facebook_account)
            except IDBridgeError as exc:
                # Once /post has been invoked, every transport or application error is
                # outcome-unknown until reconciled. Never classify it as safe to retry.
                self.ledger.transition(attempt_id, "post_outcome_unknown", {
                    "error_code": "post_outcome_unknown",
                    "error_detail_redacted": redact_error(exc),
                })
                self._notify_failure(page.page_id, attempt_id, "post_outcome_unknown", exc)
                raise
        story_id, post_tail = self.canonical_story(page.page_id, posted["story_id"])
        self.ledger.transition(attempt_id, "post_confirmed", {
            "fb_video_id": posted["video_id"],
            "fb_story_id": story_id,
            "fb_post_tail": post_tail,
            "permalink": posted.get("post_url", ""),
            "posting_source": posted["source"],
            "posted_at": int(time.time()),
        })
        try:
            final_link = self.idbridge.shorten(
                item.shopee_url, page.shopee_account, page.affiliate_id,
                page.campaign_sub1, page.page_id, post_tail,
            )
            self.ledger.transition(attempt_id, "final_shortlink_ok", {"final_shortlink": final_link})
            comment = page.comment_template.format(shortlink=final_link).strip()
            if final_link not in comment:
                raise PublisherError("comment_template_missing_shortlink")
            self.ledger.transition(attempt_id, "comment_pending")
            if self.config.comment_delay_seconds:
                time.sleep(self.config.comment_delay_seconds)
            comment_id = self.idbridge.page_comment(
                page.page_id, story_id, comment, page.facebook_account,
            )
        except Exception as exc:
            row = self.ledger.attempt(attempt_id)
            if str(row["state"]) == "success":
                return {
                    "ok": True, "mode": "write", "attempt_id": attempt_id,
                    "page_id": page.page_id, "studio_content_id": item.content_id,
                    "state": "success", "fb_story_id": story_id,
                    "fb_video_id": str(row["fb_video_id"] or posted["video_id"]),
                    "comment_id": str(row["comment_id"] or ""),
                    "permalink": str(row["permalink"] or posted.get("post_url", "")),
                }
            if row["state"] != "post_success_comment_failed":
                self.ledger.transition(attempt_id, "post_success_comment_failed", {
                    "error_code": _error_code(exc),
                    "error_detail_redacted": redact_error(exc),
                })
            self._notify_failure(page.page_id, attempt_id, "post_success_comment_failed", exc)
            raise

        current = self.ledger.attempt(attempt_id)
        if str(current["state"]) == "success":
            return {
                "ok": True, "mode": "write", "attempt_id": attempt_id,
                "page_id": page.page_id, "studio_content_id": item.content_id,
                "state": "success", "fb_story_id": story_id,
                "fb_video_id": str(current["fb_video_id"] or posted["video_id"]),
                "comment_id": str(current["comment_id"] or comment_id),
                "permalink": str(current["permalink"] or posted.get("post_url", "")),
            }
        self.ledger.transition(attempt_id, "verifying", {"comment_id": comment_id})
        try:
            readback = self._verify_live_readback(page, story_id, comment_id, comment)
        except Exception as exc:
            current = self.ledger.attempt(attempt_id)
            if str(current["state"]) == "success":
                return {
                    "ok": True, "mode": "write", "attempt_id": attempt_id,
                    "page_id": page.page_id, "studio_content_id": item.content_id,
                    "state": "success", "fb_story_id": story_id,
                    "fb_video_id": str(current["fb_video_id"] or posted["video_id"]),
                    "comment_id": str(current["comment_id"] or comment_id),
                    "permalink": str(current["permalink"] or posted.get("post_url", "")),
                }
            self.ledger.transition(attempt_id, "post_success_verification_failed", {
                "error_code": _error_code(exc),
                "error_detail_redacted": redact_error(exc),
            })
            self._notify_failure(page.page_id, attempt_id, "post_success_verification_failed", exc)
            raise
        self.ledger.transition(attempt_id, "success", {
            "permalink": readback.get("permalink") or posted.get("post_url", ""),
            "error_code": "",
            "error_detail_redacted": "",
        })
        self.ledger.advance_page_after_success(page.page_id, page.interval_minutes)
        self.spool.cleanup(attempt_id)
        self._notify_success(page.page_id, attempt_id, item.content_id)
        return {
            "ok": True, "mode": "write", "attempt_id": attempt_id,
            "page_id": page.page_id, "studio_content_id": item.content_id,
            "state": "success", "fb_story_id": story_id, "comment_id": comment_id,
            "live_readback": True,
        }

    def run_page(self, page_id: str, *, shadow: bool = True, trigger: str = "manual",
                 at: Optional[int] = None) -> Dict[str, Any]:
        page = self.page(page_id)
        if not page.enabled:
            raise PublisherError("page_disabled")
        if not shadow and not self.config.writes_enabled:
            raise PublisherError("external_writes_disabled")
        blockers = self.ledger.attempts_in_states(PAGE_BLOCKING_STATES, page.page_id)
        if blockers:
            return {
                "ok": False,
                "state": "blocked",
                "reason": "page_reconciliation_required",
                "blocking_attempt_id": str(blockers[0]["attempt_id"]),
                "blocking_state": str(blockers[0]["state"]),
            }
        owner = uuid.uuid4().hex
        global_key = "scheduler:global"
        page_key = "page:" + page.page_id
        if not self.ledger.acquire_lease(global_key, owner, 900):
            return {"ok": False, "state": "skipped", "reason": "global_lease_busy"}
        try:
            if not self.ledger.acquire_lease(page_key, owner, 900):
                return {"ok": False, "state": "skipped", "reason": "page_lease_busy"}
            try:
                return self._run_locked(page, shadow=shadow, trigger=trigger, at=at)
            finally:
                self.ledger.release_lease(page_key, owner)
        finally:
            self.ledger.release_lease(global_key, owner)

    def _run_locked(self, page: PageConfig, *, shadow: bool, trigger: str,
                    at: Optional[int]) -> Dict[str, Any]:
        used = self.ledger.used_content_ids(page.page_id, include_shadow=shadow)
        candidates = self.studio.candidates(limit=20, excluded_ids=used)
        if not candidates:
            return {"ok": False, "state": "blocked", "reason": "strict_ready_exhausted"}
        candidate_errors = []
        for index, candidate in enumerate(candidates):
            probe_id = "probe-" + uuid.uuid4().hex
            attempt_id = ""
            try:
                item = self.studio.current(candidate.content_id)
                if item is None:
                    candidate_errors.append("source_no_longer_ready")
                    continue
                resolved = self.discord.fetch(
                    item.editor_message_id, item.shopee_url, item.lazada_url,
                    item.editor_video_url,
                )
                source = self.spool.download(
                    probe_id, resolved.url, "source.mp4",
                    max_bytes=self.config.source_max_bytes,
                )
                if self.ledger.page_has_sha(page.page_id, source.sha256):
                    candidate_errors.append("source_sha_duplicate")
                    self.spool.cleanup(probe_id)
                    continue
                key = (
                    manual_slot_key(page.page_id, index=index, at=at)
                    if trigger == "manual" else slot_key(page.page_id, page.interval_minutes, at=at)
                )
                attempt_id = self.ledger.claim_attempt(
                    page.page_id, item.content_id, key, trigger,
                )
                attempt_dir = self.spool.adopt(probe_id, attempt_id)
                source_path = attempt_dir / "source.mp4"
                self.ledger.upsert_source(item, resolved.attachment_id, source.sha256)
                self.ledger.transition(attempt_id, "source_resolved")
                self.ledger.transition(attempt_id, "downloaded", {"source_sha256": source.sha256})
                avatar_version = page.avatar_version
                if page.avatar_url:
                    cloudflare_avatar = sync_cloudflare_avatar(
                        page.avatar_url, page.avatar_path, self.spool,
                    )
                    avatar_version = cloudflare_avatar.version
                elif not page.avatar_path.is_file():
                    raise PublisherError("avatar_asset_missing")
                else:
                    self.spool.inspect(page.avatar_path)
                self.ledger.transition(attempt_id, "avatar_composing")
                output_path = attempt_dir / "avatar-composed.mp4"
                with AssetServer() as server:
                    source_url = server.register(source_path)
                    avatar_url = server.register(page.avatar_path)
                    AvatarClient(self.config.merge_url, self.spool).compose(
                        source_url, avatar_url, output_path,
                        similarity=page.chromakey_similarity,
                        blend=page.chromakey_blend,
                    )
                self.ledger.transition(attempt_id, "avatar_ready", {"avatar_version": avatar_version})
                if shadow:
                    self.ledger.transition(attempt_id, "shadow_ready")
                    self.ledger.advance_page_after_shadow(page.page_id, page.interval_minutes)
                    if not self.config.keep_shadow_spool:
                        self.spool.cleanup(attempt_id)
                    return {
                        "ok": True, "mode": "shadow", "attempt_id": attempt_id,
                        "page_id": page.page_id, "studio_content_id": item.content_id,
                        "state": "shadow_ready", "source_bytes": source.bytes,
                        "source_sha256": source.sha256,
                        "output_path": str(output_path),
                    }
                return self._publish_real(page, item, attempt_id, output_path)
            except LedgerError as exc:
                self.spool.cleanup(probe_id)
                if str(exc) == "attempt_claim_conflict":
                    return {"ok": False, "state": "skipped", "reason": "slot_already_claimed"}
                if attempt_id:
                    self.ledger.fail_pre_post(attempt_id, _error_code(exc), redact_error(exc))
                raise
            except Exception as exc:
                self.spool.cleanup(probe_id)
                if attempt_id:
                    row = self.ledger.attempt(attempt_id)
                    if row["state"] not in {
                        "failed_pre_post", "post_outcome_unknown",
                        "post_success_comment_failed", "post_success_verification_failed",
                        "success",
                    }:
                        self.ledger.fail_pre_post(attempt_id, _error_code(exc), redact_error(exc))
                    if not shadow and self.ledger.attempt(attempt_id)["state"] == "failed_pre_post":
                        self._notify_failure(page.page_id, attempt_id, "failed_pre_post", exc)
                candidate_errors.append(_error_code(exc))
                # Once a durable attempt exists, do not consume the same slot with another source.
                if attempt_id:
                    return {
                        "ok": False, "state": "failed", "attempt_id": attempt_id,
                        "reason": _error_code(exc),
                    }
        return {
            "ok": False, "state": "blocked", "reason": "candidate_budget_exhausted",
            "candidate_errors": candidate_errors[:20],
        }

    def reconcile_attempt(self, attempt_id: str) -> Dict[str, Any]:
        if not self.config.writes_enabled:
            raise PublisherError("external_writes_disabled")
        initial = self.ledger.attempt(attempt_id)
        page_id = str(initial["page_id"])
        owner = "reconcile-" + uuid.uuid4().hex
        page_key = "page:" + page_id
        if not self.ledger.acquire_lease(page_key, owner, 900):
            return {
                "ok": False, "state": "skipped", "reason": "page_lease_busy",
                "attempt_id": attempt_id, "page_id": page_id,
            }
        try:
            return self._reconcile_attempt_locked(attempt_id)
        finally:
            self.ledger.release_lease(page_key, owner)

    def _reconcile_attempt_locked(self, attempt_id: str) -> Dict[str, Any]:
        row = self.ledger.attempt(attempt_id)
        state = str(row["state"])
        recoverable = {
            "post_confirmed", "final_shortlink_ok", "comment_pending", "verifying",
            "post_success_comment_failed", "post_success_verification_failed",
        }
        if state not in recoverable:
            raise PublisherError("reconcile_state_invalid")
        page = self.page(str(row["page_id"]))
        self._preflight_identity(page)
        story_id = str(row["fb_story_id"] or "")
        if not story_id:
            raise PublisherError("reconcile_story_missing")
        final_link = str(row["final_shortlink"] or "")
        if state == "post_confirmed" or not final_link:
            source = self.ledger.source_item(int(row["studio_content_id"]))
            final_link = self.idbridge.shorten(
                str(source["shopee_url"]), page.shopee_account, page.affiliate_id,
                page.campaign_sub1, page.page_id, str(row["fb_post_tail"] or ""),
            )
            self.ledger.transition(attempt_id, "final_shortlink_ok", {"final_shortlink": final_link})
            state = "final_shortlink_ok"
        comment = page.comment_template.format(shortlink=final_link).strip()
        if final_link not in comment:
            raise PublisherError("comment_template_missing_shortlink")
        comment_id = str(row["comment_id"] or "")
        if state not in {"verifying", "post_success_verification_failed"}:
            comment_id = comment_id or self._find_existing_comment(page, story_id, comment)
            if state == "final_shortlink_ok":
                self.ledger.transition(attempt_id, "comment_pending")
                state = "comment_pending"
            if comment_id:
                self.ledger.transition(attempt_id, "verifying", {"comment_id": comment_id})
                state = "verifying"
            else:
                if state == "post_success_comment_failed":
                    self.ledger.transition(attempt_id, "comment_pending")
                    state = "comment_pending"
                try:
                    comment_id = self.idbridge.page_comment(
                        page.page_id, story_id, comment, page.facebook_account,
                    )
                    self.ledger.transition(attempt_id, "verifying", {"comment_id": comment_id})
                    state = "verifying"
                except Exception as exc:
                    self.ledger.transition(attempt_id, "post_success_comment_failed", {
                        "error_code": _error_code(exc),
                        "error_detail_redacted": redact_error(exc),
                    })
                    self._notify_failure(page.page_id, attempt_id, "post_success_comment_failed", exc)
                    raise
        if not comment_id:
            raise PublisherError("reconcile_comment_missing")
        try:
            readback = self._verify_live_readback(page, story_id, comment_id, comment)
        except Exception as exc:
            if state == "verifying":
                self.ledger.transition(attempt_id, "post_success_verification_failed", {
                    "error_code": _error_code(exc),
                    "error_detail_redacted": redact_error(exc),
                })
            self._notify_failure(page.page_id, attempt_id, "post_success_verification_failed", exc)
            raise
        self.ledger.transition(attempt_id, "success", {
            "comment_id": comment_id,
            "permalink": readback.get("permalink") or str(row["permalink"] or ""),
            "error_code": "",
            "error_detail_redacted": "",
        })
        self.ledger.advance_page_after_success(page.page_id, page.interval_minutes)
        self.spool.cleanup(attempt_id)
        self._notify_success(page.page_id, attempt_id, int(row["studio_content_id"]))
        return {
            "ok": True, "state": "success", "attempt_id": attempt_id,
            "page_id": page.page_id, "fb_story_id": story_id,
            "comment_id": comment_id, "live_readback": True,
        }

    def retry_comment(self, attempt_id: str) -> Dict[str, Any]:
        return self.reconcile_attempt(attempt_id)

    def run_due_once(self, at: Optional[int] = None) -> Dict[str, Any]:
        due = self.ledger.due_pages(now=at)
        if not due:
            return {"ok": True, "state": "idle", "due_pages": 0}
        # Startup catch-up is deliberately capped at one slot; never burst.
        page_id = str(due[0]["page_id"])
        return self.run_page(
            page_id,
            shadow=not self.config.writes_enabled,
            trigger="scheduler",
            at=at,
        )

    def status(self) -> Dict[str, Any]:
        return {
            "writes_enabled": self.config.writes_enabled,
            "scheduler_enabled": self.config.scheduler_enabled,
            "strict_ready": self.studio.strict_ready_count(),
            "ledger": self.ledger.summary(),
            "unknown_outcomes": len(self.ledger.attempts_in_states(["post_outcome_unknown"])),
            "comment_backlog": len(self.ledger.attempts_in_states(["post_success_comment_failed"])),
            "verification_backlog": len(self.ledger.attempts_in_states(["post_success_verification_failed"])),
            "page_blockers": len(self.ledger.attempts_in_states(PAGE_BLOCKING_STATES)),
        }
