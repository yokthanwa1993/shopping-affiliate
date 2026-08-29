from __future__ import annotations

import hashlib
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from .asset_server import AssetServer
from .avatar_client import AvatarClient
from .config import AppConfig, PageConfig
from .discord_source import DiscordSource
from .idbridge_client import IDBridgeClient, IDBridgeError, IDBridgeHTTPError
from .ledger import Ledger, LedgerError, PAGE_BLOCKING_STATES
from .notifier import Notifier
from .scheduler import local_day_window, manual_slot_key, slot_key
from .security import discord_bot_token, idbridge_service_auth, redact_error
from .spool import Spool
from .studio_source import StudioItem, StudioSource


class PublisherError(RuntimeError):
    pass


URL_PATTERN = re.compile(r"https?://", re.IGNORECASE)
CHEARB_PAGE_ID = "1008898512617594"
CAPTION_LINK_PIN_PREFIX = "📌 พิกัด : "
CHEARB_CAPTION_HASHTAG_LIMIT = 3
CHEARB_CAPTION_MAX_CHARS = 130
CHEARB_GENERIC_PRODUCT_TAGS = {
    "ของใช้", "ของใช้ในบ้าน", "เครื่องมือช่าง", "อุปกรณ์ช่าง", "งานช่าง",
    "เฟอร์นิเจอร์", "ยานยนต์", "กีฬา", "อุปกรณ์กีฬา",
    "สินค้า", "รีวิว", "ช้อปปิ้ง",
}
CHEARB_GENERIC_DETAIL_LABELS = {
    "ของใช้": "ใช้ทั่วไป", "ของใช้ในบ้าน": "ใช้ในบ้าน",
    "เครื่องมือช่าง": "งานช่าง", "อุปกรณ์ช่าง": "งานช่าง",
    "งานช่าง": "งานช่าง", "เฟอร์นิเจอร์": "แต่งบ้าน",
    "ยานยนต์": "ใช้กับรถ", "กีฬา": "ใช้เล่นกีฬา",
    "อุปกรณ์กีฬา": "ใช้เล่นกีฬา",
}
CHEARB_DETAIL_PREFIXES = (
    "อุปกรณ์", "เครื่องมือ", "ของใช้", "ของแต่ง", "สำหรับ", "แบบ",
)
CHEARB_NAME_FEATURES = (
    "ปรับระดับ", "ปรับได้", "พับเก็บ", "พับได้", "กางได้", "พกพา",
    "ไร้สาย", "มือหมุน", "อัตโนมัติ", "มีล้อ", "บานเลื่อน", "ติดผนัง",
    "ติดเพดาน", "พร้อมไฟ", "พร้อมแผงโซลาร์", "พร้อมถ้วยซอส", "สองทาง",
    "หลายชั้น", "มีลิ้นชัก", "หมุนได้", "เคลื่อนที่", "แม่เหล็ก",
    "ไฟฟ้า", "ดิจิตอล", "สแตนเลส",
)
CHEARB_NAME_FEATURE_LABELS = {
    "ไฟฟ้า": "ระบบไฟฟ้า", "ดิจิตอล": "ระบบดิจิตอล",
}
CHEARB_HASHTAG_REDUCTIONS = (
    "จัดระเบียบ", "มีลิ้นชัก", "สำหรับ", "อัตโนมัติ", "แบบ",
    "เพื่อ", "เสริม", "นั่ง", "ติด", "เก็บ", "พกพา",
)
CHEARB_HASHTAG_SUFFIXES = (
    "มอเตอร์ไซค์", "เครื่องสำอาง", "เครื่องแป้ง", "สกู๊ตเตอร์",
)


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
        if not config.ready_channel_id:
            raise PublisherError("ready_channel_not_configured")
        self.discord = DiscordSource(
            config.ready_channel_id,
            discord_bot_token(config.discord_env_file),
        )
        self._idbridge: Optional[IDBridgeClient] = None
        self.notifier = Notifier()
        for page in config.pages:
            self.ledger.sync_page(page)
        self.ledger.classify_stale_posting(config.stale_posting_seconds)

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
    def resolve_avatar_asset(page: PageConfig, spool: Spool) -> str:
        """Use the durable Mac mini avatar only; publishing has no Cloudflare runtime dependency."""
        if not page.avatar_enabled:
            return "none"
        if not page.avatar_path.is_file():
            raise PublisherError("avatar_asset_missing")
        spool.inspect(page.avatar_path)
        return page.avatar_version

    @staticmethod
    def caption(page: PageConfig, item: StudioItem) -> str:
        caption = page.caption_template.format(caption=item.caption).strip()
        if not caption:
            raise PublisherError("caption_empty")
        if page.page_id == CHEARB_PAGE_ID:
            shopee_link = str(item.shopee_url or "").strip()
            if not shopee_link or not URL_PATTERN.match(shopee_link):
                raise PublisherError("caption_shopee_link_missing")
            lines = [line.strip() for line in caption.splitlines() if line.strip()]
            hashtags = []
            if lines and lines[-1].startswith("#"):
                hashtags = [token for token in lines.pop().split() if token.startswith("#")]
            if len(hashtags) < CHEARB_CAPTION_HASHTAG_LIMIT:
                raise PublisherError("caption_hashtags_incomplete")
            product_name = str(getattr(item, "product_name", "") or "").strip()
            if not product_name:
                product_name = " ".join(lines).strip()
            if not product_name:
                raise PublisherError("caption_product_text_missing")
            if URL_PATTERN.search(product_name):
                raise PublisherError("caption_product_text_link_forbidden")
            separated_hashtags = getattr(item, "hashtags", ())
            if separated_hashtags:
                hashtags = [str(tag).strip() for tag in separated_hashtags]
            link_line = f"{CAPTION_LINK_PIN_PREFIX}{shopee_link}"
            product_text = ""
            hashtag_line = ""
            product_copy_name, detail_pairs = PublisherEngine._chearb_product_details(
                product_name, hashtags,
            )
            for details in detail_pairs:
                proposal = " ".join((product_copy_name, *details))
                try:
                    proposal_hashtags = PublisherEngine._chearb_hashtag_line(
                        link_line, proposal, hashtags,
                    )
                except PublisherError:
                    continue
                product_text = proposal
                hashtag_line = proposal_hashtags
                break
            if not product_text:
                raise PublisherError("caption_too_long")
            value = "\n".join((link_line, product_text, hashtag_line))
            if len(value) > CHEARB_CAPTION_MAX_CHARS:
                raise PublisherError("caption_too_long")
            return value
        if URL_PATTERN.search(caption):
            raise PublisherError("caption_visible_link_forbidden")
        return caption

    @staticmethod
    def _chearb_product_details(product_name: str,
                                hashtags: list[str]) -> tuple[str, list[tuple[str, str]]]:
        name = re.sub(r"\s+", " ", str(product_name or "")).strip()
        if not name or "\n" in name or "\r" in name or URL_PATTERN.search(name):
            raise PublisherError("caption_product_text_invalid")
        tag_pools: list[tuple[int, list[str]]] = []
        for raw in hashtags:
            detail = re.sub(r"\s+", " ", str(raw or "").lstrip("#")).strip()
            if not detail:
                continue
            if detail in CHEARB_GENERIC_PRODUCT_TAGS:
                label = CHEARB_GENERIC_DETAIL_LABELS.get(detail, "")
                if label:
                    tag_pools.append((2, [label]))
                continue
            variants = PublisherEngine._chearb_detail_variants(name, detail)
            if variants:
                tag_pools.append((1, variants))
        name_features = []
        name_pools: list[tuple[int, list[str]]] = []
        for feature in CHEARB_NAME_FEATURES:
            if feature in name:
                name_features.append(feature)
                label = CHEARB_NAME_FEATURE_LABELS.get(feature, feature)
                name_pools.append((0, [label]))
        copy_name = name
        for feature in sorted(name_features, key=len, reverse=True):
            copy_name = copy_name.replace(feature, " ")
        copy_name = re.sub(r"แบบ\s*$", "", copy_name)
        copy_name = re.sub(r"\s+", " ", copy_name).strip(" -") or name
        pools = name_pools + tag_pools
        results: list[tuple[int, int, int, tuple[str, str]]] = []
        for left_index, (left_priority, left_pool) in enumerate(pools):
            for right_priority, right_pool in pools[left_index + 1:]:
                for left in left_pool:
                    for right in right_pool:
                        if (
                            PublisherEngine._chearb_text_overlaps(left, right)
                            or PublisherEngine._chearb_detail_key(left)
                            == PublisherEngine._chearb_detail_key(right)
                        ):
                            continue
                        results.append((
                            left_priority + right_priority,
                            len(left) + len(right), left_index, (left, right),
                        ))
        if not results:
            raise PublisherError("caption_product_details_incomplete")
        deduped: list[tuple[str, str]] = []
        seen = set()
        for _priority, _length, _index, pair in sorted(
            results, key=lambda value: (value[0], value[1], value[2]),
        ):
            key = tuple(value.casefold() for value in pair)
            if key not in seen:
                deduped.append(pair)
                seen.add(key)
        return copy_name, deduped

    @staticmethod
    def _chearb_detail_key(value: str) -> str:
        compact = re.sub(r"[^0-9A-Za-zก-๙]", "", str(value or "")).casefold()
        concepts = (
            ("พับ", "fold"), ("ไฟฟ้า", "electric"), ("พกพา", "portable"),
            ("ปรับ", "adjustable"), ("ลิ้นชัก", "drawer"),
            ("แม่เหล็ก", "magnetic"), ("ดิจิตอล", "digital"),
            ("สแตนเลส", "stainless"),
        )
        for needle, concept in concepts:
            if needle in compact:
                return concept
        return compact

    @staticmethod
    def _chearb_detail_variants(product_name: str, detail: str) -> list[str]:
        variants = [detail]
        for prefix in CHEARB_DETAIL_PREFIXES:
            if detail.startswith(prefix) and len(detail) - len(prefix) >= 3:
                variants.append(detail[len(prefix):].strip())
        for reduction in CHEARB_HASHTAG_REDUCTIONS:
            if reduction in detail:
                reduced = detail.replace(reduction, "", 1).strip()
                if len(reduced) >= 3:
                    variants.append(reduced)
        deduped: list[str] = []
        seen = set()
        for variant in sorted(variants, key=len):
            value = variant.strip()
            key = value.casefold()
            if (
                not value or value in CHEARB_GENERIC_PRODUCT_TAGS or key in seen
                or PublisherEngine._chearb_text_overlaps(product_name, value)
            ):
                continue
            deduped.append(value)
            seen.add(key)
        return deduped

    @staticmethod
    def _chearb_text_overlaps(left: str, right: str) -> bool:
        compact = lambda value: re.sub(
            r"[^0-9A-Za-zก-๙]", "", str(value or ""),
        ).casefold()
        left_value = compact(left)
        right_value = compact(right)
        return bool(
            left_value and right_value
            and (left_value in right_value or right_value in left_value)
        )

    @staticmethod
    def _chearb_hashtag_line(link_line: str, product_text: str,
                             hashtags: list[str]) -> str:
        limit = CHEARB_CAPTION_MAX_CHARS - len(link_line) - len(product_text) - 2
        selected = [str(tag).strip() for tag in hashtags[:CHEARB_CAPTION_HASHTAG_LIMIT]]
        if len(" ".join(selected)) <= limit:
            return " ".join(selected)

        candidates: list[tuple[int, int, str]] = []
        for index, raw in enumerate(hashtags):
            for priority, candidate in enumerate(PublisherEngine._hashtag_variants(raw)):
                candidates.append((priority, index, candidate))
        candidates.sort(key=lambda value: (value[0], value[1], len(value[2])))

        fits: list[tuple[int, int, int, list[str]]] = []
        for first in range(len(candidates)):
            for second in range(first + 1, len(candidates)):
                for third in range(second + 1, len(candidates)):
                    picks = [candidates[first], candidates[second], candidates[third]]
                    proposal = [value[2] for value in picks]
                    if len({value[1] for value in picks}) != CHEARB_CAPTION_HASHTAG_LIMIT:
                        continue
                    if len({token.casefold() for token in proposal}) != CHEARB_CAPTION_HASHTAG_LIMIT:
                        continue
                    total = len(" ".join(proposal))
                    if total <= limit:
                        fits.append((sum(value[0] for value in picks), total,
                                     sum(value[1] for value in picks), proposal))
        if fits:
            proposal = min(fits, key=lambda value: (value[0], value[1], value[2]))[3]
            return " ".join(proposal)

        raise PublisherError("caption_too_long")

    @staticmethod
    def _hashtag_variants(raw: str) -> list[str]:
        tag = str(raw or "").strip()
        if not tag.startswith("#") or any(ch.isspace() for ch in tag):
            return []
        body = tag[1:]
        variants = [tag]
        for reduction in CHEARB_HASHTAG_REDUCTIONS:
            if reduction in body:
                reduced = body.replace(reduction, "", 1).strip()
                if len(reduced) >= 4:
                    variants.append(f"#{reduced}")
        compact = body
        for reduction in CHEARB_HASHTAG_REDUCTIONS:
            compact = compact.replace(reduction, "")
        compact = compact.strip()
        if len(compact) >= 4:
            variants.append(f"#{compact}")
        for suffix in CHEARB_HASHTAG_SUFFIXES:
            pos = body.find(suffix)
            if pos > 3:
                prefix = body[:pos].strip()
                if len(prefix) >= 4:
                    variants.append(f"#{prefix}")
                variants.append(f"#{suffix}")
        deduped = []
        seen = set()
        for candidate in variants:
            key = candidate.casefold()
            if key not in seen and len(candidate) >= 3:
                deduped.append(candidate)
                seen.add(key)
        return deduped

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

    @staticmethod
    def _caption_digest(value: str) -> str:
        return hashlib.sha256(str(value or "").strip().encode("utf-8")).hexdigest()

    def recover_existing_story(self, attempt_id: str, *, story_id: str,
                               video_id: str, expected_caption_sha256: str) -> Dict[str, Any]:
        """Bind and finish one already-published Reel without calling `/post`."""
        if not self.config.writes_enabled:
            raise PublisherError("external_writes_disabled")
        initial = self.ledger.attempt(attempt_id)
        if str(initial["state"]) not in {"posting", "stale_posting_review"}:
            raise PublisherError("existing_story_recovery_state_invalid")
        page = self.page(str(initial["page_id"]))
        canonical, post_tail = self.canonical_story(page.page_id, story_id)
        video_id = str(video_id or "").strip()
        if not video_id.isdigit():
            raise PublisherError("existing_story_video_id_invalid")
        expected_digest = str(expected_caption_sha256 or "").strip().lower()
        if len(expected_digest) != 64 or any(ch not in "0123456789abcdef" for ch in expected_digest):
            raise PublisherError("existing_story_caption_digest_invalid")

        source = self.ledger.source_item(int(initial["studio_content_id"]))
        source_sha256 = str(initial["source_sha256"] or "").strip().lower()
        if len(source_sha256) != 64 or str(source.get("source_sha256") or "").strip().lower() != source_sha256:
            raise PublisherError("existing_story_source_identity_mismatch")
        archive = self.ledger.source_archive(int(initial["studio_content_id"]), source_sha256)
        if not archive:
            raise PublisherError("existing_story_source_archive_missing")
        archived = self.spool.inspect(Path(str(archive["archive_path"])))
        if archived.sha256 != source_sha256 or archived.bytes != int(archive["archive_bytes"]):
            raise PublisherError("existing_story_source_archive_mismatch")
        try:
            preflight_link = str(initial["preflight_shortlink"] or "").strip()
        except (KeyError, IndexError):
            preflight_link = ""
        if page.page_id == CHEARB_PAGE_ID and not preflight_link:
            raise PublisherError("existing_story_preflight_shortlink_missing")
        try:
            expected_caption = self.caption(
                page,
                StudioItem(
                    content_id=int(initial["studio_content_id"]),
                    ready_message_id=str(source.get("editor_message_id") or ""),
                    ready_video_url="",
                    shopee_url=(
                        preflight_link
                        if page.page_id == CHEARB_PAGE_ID
                        else str(source.get("shopee_url") or "")
                    ),
                    lazada_url=str(source.get("lazada_url") or ""),
                    caption=str(source["caption"]),
                    ready_at="",
                    product_name="",
                    hashtags=(),
                ),
            )
        except PublisherError as exc:
            raise PublisherError("existing_story_source_caption_invalid") from exc
        if self._caption_digest(expected_caption) != expected_digest:
            raise PublisherError("existing_story_expected_caption_changed")

        story = self.idbridge.graph_get(
            page.power_editor_account, canonical,
            {"fields": "id,message,created_time,permalink_url,from,is_published,attachments{target{id}}"},
        )
        if str(story.get("id") or "") != canonical or story.get("is_published") is not True:
            raise PublisherError("existing_story_readback_failed")
        author = story.get("from") if isinstance(story.get("from"), dict) else {}
        if str(author.get("id") or "") != page.page_id:
            raise PublisherError("existing_story_author_mismatch")
        if self._caption_digest(str(story.get("message") or "")) != expected_digest:
            raise PublisherError("existing_story_caption_mismatch")
        attachments_raw = story.get("attachments")
        attachments: Dict[str, Any] = attachments_raw if isinstance(attachments_raw, dict) else {}
        attachment_rows_raw = attachments.get("data")
        attachment_rows = attachment_rows_raw if isinstance(attachment_rows_raw, list) else []
        target_ids = {
            str((row.get("target") or {}).get("id") or "")
            for row in attachment_rows
            if isinstance(row, dict) and isinstance(row.get("target"), dict)
        }
        if video_id not in target_ids:
            raise PublisherError("existing_story_video_mismatch")

        video = self.idbridge.graph_get(
            page.power_editor_account, video_id,
            {"fields": "id,description,created_time,permalink_url,from,published"},
        )
        video_author_raw = video.get("from")
        video_author: Dict[str, Any] = video_author_raw if isinstance(video_author_raw, dict) else {}
        if str(video.get("id") or "") != video_id or video.get("published") is not True:
            raise PublisherError("existing_video_readback_failed")
        if str(video_author.get("id") or "") != page.page_id:
            raise PublisherError("existing_video_author_mismatch")
        if self._caption_digest(str(video.get("description") or "")) != expected_digest:
            raise PublisherError("existing_video_caption_mismatch")
        story_created = str(story.get("created_time") or "")
        if not story_created or story_created != str(video.get("created_time") or ""):
            raise PublisherError("existing_story_time_mismatch")
        try:
            from datetime import datetime
            posted_at = int(datetime.fromisoformat(story_created.replace("Z", "+00:00")).timestamp())
        except (TypeError, ValueError) as exc:
            raise PublisherError("existing_story_time_invalid") from exc
        created_at = int(initial["created_at"] or 0)
        if created_at <= 0 or abs(posted_at - created_at) > 15 * 60:
            raise PublisherError("existing_story_time_outside_attempt_window")

        owner = "recover-existing-" + uuid.uuid4().hex
        page_key = "page:" + page.page_id
        if not self.ledger.acquire_lease(page_key, owner, 900):
            return {
                "ok": False, "state": "skipped", "reason": "page_lease_busy",
                "attempt_id": attempt_id, "page_id": page.page_id,
            }
        try:
            current = self.ledger.attempt(attempt_id)
            current_state = str(current["state"])
            if current_state == "posting":
                self.ledger.transition(attempt_id, "stale_posting_review", {
                    "error_code": "operator_verified_existing_story",
                    "error_detail_redacted": "exact_story_readback_passed; repost_forbidden",
                })
            elif current_state != "stale_posting_review":
                raise PublisherError("existing_story_recovery_state_changed")
            self.ledger.bind_existing_story(
                attempt_id, fb_story_id=canonical, fb_post_tail=post_tail,
                fb_video_id=video_id, permalink=str(story.get("permalink_url") or ""),
                posting_source=page.posting_source, posted_at=posted_at,
            )
            self.ledger.advance_page_after_post(
                page.page_id, page.interval_minutes, now=posted_at,
            )
            return self._reconcile_attempt_locked(attempt_id)
        finally:
            self.ledger.release_lease(page_key, owner)

    def _preflight_identity(self, page: PageConfig) -> None:
        self.idbridge.ensure_page(
            page.facebook_account, page.page_id, page.posting_source,
        )
        graph_page = self.idbridge.graph_get(
            page.power_editor_account, page.page_id, {"fields": "id"},
        )
        if str(graph_page.get("id") or "") != page.page_id:
            raise PublisherError("power_editor_page_readback_failed")
        accounts = self.idbridge.shopee_accounts()
        if not any(str(row.get("account") or row.get("spc_u") or "") == page.shopee_account for row in accounts):
            raise PublisherError("shopee_account_unavailable")

    def _final_shortlink(self, page: PageConfig, source_url: str,
                         preflight_link: str, post_tail: str) -> str:
        if page.page_id == CHEARB_PAGE_ID:
            if not preflight_link:
                raise PublisherError("chearb_shared_shortlink_missing")
            return preflight_link
        return self.idbridge.shorten(
            source_url, page.shopee_account, page.affiliate_id,
            page.campaign_sub1, page.page_id, post_tail,
        )

    def _publish_real(self, page: PageConfig, item: StudioItem, attempt_id: str,
                      composed_path: Path) -> Dict[str, Any]:
        if not self.config.writes_enabled:
            raise PublisherError("external_writes_disabled")
        self._preflight_identity(page)
        preflight_raw = self.idbridge.shorten(
            item.shopee_url, page.shopee_account, page.affiliate_id,
            page.campaign_sub1, page.page_id, "",
        )
        preflight = (
            preflight_raw.removesuffix("?lp=aff")
            .removesuffix("&lp=aff")
        )
        self.ledger.transition(attempt_id, "shortlink_preflight_ok", {"preflight_shortlink": preflight})
        caption_item = item
        if page.page_id == CHEARB_PAGE_ID:
            caption_item = StudioItem(
                content_id=item.content_id,
                ready_message_id=item.ready_message_id,
                ready_video_url=item.ready_video_url,
                shopee_url=preflight,
                lazada_url=item.lazada_url,
                caption=item.caption,
                ready_at=item.ready_at,
                product_name=str(getattr(item, "product_name", "") or ""),
                hashtags=tuple(getattr(item, "hashtags", ()) or ()),
            )
        caption = self.caption(page, caption_item)
        with AssetServer() as server:
            video_url = server.register(composed_path)
            self.ledger.transition(attempt_id, "posting")
            try:
                posted = self.idbridge.post(
                    page.page_id, video_url, caption, page.facebook_account,
                    page.posting_source,
                )
            except IDBridgeHTTPError as exc:
                if exc.status == 403 and exc.code == "page_token_not_found":
                    self.ledger.transition(attempt_id, "post_outcome_unknown", {
                        "error_code": "post_outcome_unknown",
                        "error_detail_redacted": "idbridge_http_403:page_token_not_found",
                    })
                    self.ledger.resolve_unknown_no_post(
                        attempt_id,
                        "idbridge_rejected_before_upload",
                    )
                    self._notify_failure(
                        page.page_id,
                        attempt_id,
                        "operator_confirmed_no_post",
                        exc,
                    )
                    raise
                # Once /post may have reached Facebook, every other HTTP error remains
                # outcome-unknown until reconciled. Never classify it as safe to retry.
                self.ledger.transition(attempt_id, "post_outcome_unknown", {
                    "error_code": "post_outcome_unknown",
                    "error_detail_redacted": redact_error(exc),
                })
                self._notify_failure(page.page_id, attempt_id, "post_outcome_unknown", exc)
                raise
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
        self.ledger.advance_page_after_post(page.page_id, page.interval_minutes)
        try:
            final_link = self._final_shortlink(
                page, item.shopee_url, preflight, post_tail,
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
                self.ledger.record_comment_failure(
                    attempt_id, _error_code(exc), redact_error(exc),
                )
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
            self.ledger.record_verification_failure(
                attempt_id, _error_code(exc), redact_error(exc),
            )
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
        if page.daily_success_limit:
            day_start, next_day = local_day_window(page.timezone, at=at)
            daily_posts = self.ledger.posted_count_between(
                page.page_id, day_start, next_day,
            )
            if daily_posts >= page.daily_success_limit:
                if trigger == "scheduler":
                    self.ledger.set_next_due_at(page.page_id, next_day, now=at)
                return {
                    "ok": True,
                    "state": "idle",
                    "reason": "daily_success_limit_reached",
                    "page_id": page.page_id,
                    "daily_posts": daily_posts,
                    "daily_post_limit": page.daily_success_limit,
                    "next_due_at": next_day,
                }
        used = self.ledger.used_content_ids(page.page_id, include_shadow=shadow)
        allowed: Optional[set[int]] = None
        if page.reuse_success_from_page_id:
            allowed = self.ledger.successful_content_ids(page.reuse_success_from_page_id)
            if not allowed:
                return {
                    "ok": False,
                    "state": "blocked",
                    "reason": "reuse_source_success_empty",
                    "page_id": page.page_id,
                    "reuse_success_from_page_id": page.reuse_success_from_page_id,
                }
            if not (allowed - used):
                return {
                    "ok": False,
                    "state": "blocked",
                    "reason": "reuse_source_success_exhausted",
                    "page_id": page.page_id,
                    "reuse_success_from_page_id": page.reuse_success_from_page_id,
                }
        candidates = self.studio.candidates(
            limit=20, excluded_ids=used, allowed_ids=allowed,
        )
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
                    item.ready_message_id, item.shopee_url, item.lazada_url,
                    item.ready_video_url,
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
                source = self.spool.inspect(source_path, expected_sha=source.sha256)
                self.ledger.upsert_source(item, resolved.attachment_id, source.sha256)
                archived = self.spool.archive_source(item.content_id, source)
                self.ledger.record_source_archive(
                    item.content_id, archived.sha256, archived.path, archived.bytes,
                )
                self.ledger.transition(attempt_id, "source_resolved")
                self.ledger.transition(attempt_id, "downloaded", {"source_sha256": source.sha256})
                avatar_version = self.resolve_avatar_asset(page, self.spool)
                self.ledger.transition(attempt_id, "avatar_composing")
                if page.avatar_enabled:
                    output_path = attempt_dir / "avatar-composed.mp4"
                    with AssetServer() as server:
                        source_url = server.register(source_path)
                        avatar_url = server.register(page.avatar_path)
                        AvatarClient(self.config.merge_url, self.spool).compose(
                            source_url, avatar_url, output_path,
                            similarity=page.chromakey_similarity,
                            blend=page.chromakey_blend,
                        )
                else:
                    output_path = source_path
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
            "existing_story_bound", "post_confirmed", "final_shortlink_ok", "comment_pending", "verifying",
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
        if state in {"existing_story_bound", "post_confirmed"} or not final_link:
            preflight_link = str(row["preflight_shortlink"] or "").strip()
            source_url = ""
            if page.page_id != CHEARB_PAGE_ID:
                source = self.ledger.source_item(int(row["studio_content_id"]))
                source_url = str(source["shopee_url"])
            final_link = self._final_shortlink(
                page, source_url, preflight_link, str(row["fb_post_tail"] or ""),
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
            if state == "post_success_comment_failed":
                self.ledger.transition(attempt_id, "comment_pending")
                state = "comment_pending"
            if comment_id:
                self.ledger.transition(attempt_id, "verifying", {"comment_id": comment_id})
                state = "verifying"
            else:
                try:
                    comment_id = self.idbridge.page_comment(
                        page.page_id, story_id, comment, page.facebook_account,
                    )
                    self.ledger.transition(attempt_id, "verifying", {"comment_id": comment_id})
                    state = "verifying"
                except Exception as exc:
                    self.ledger.record_comment_failure(
                        attempt_id, _error_code(exc), redact_error(exc),
                    )
                    self._notify_failure(page.page_id, attempt_id, "post_success_comment_failed", exc)
                    raise
        if not comment_id:
            raise PublisherError("reconcile_comment_missing")
        try:
            readback = self._verify_live_readback(page, story_id, comment_id, comment)
        except Exception as exc:
            if state == "verifying":
                self.ledger.record_verification_failure(
                    attempt_id, _error_code(exc), redact_error(exc),
                )
            elif state == "post_success_verification_failed":
                self.ledger.record_verification_failure(
                    attempt_id, _error_code(exc), redact_error(exc),
                )
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
        self.ledger.classify_stale_posting(self.config.stale_posting_seconds, now=at)
        due = self.ledger.due_pages(now=at)
        if not due:
            return {"ok": True, "state": "idle", "due_pages": 0}
        # Scan all due pages fairly, but permit at most one source/post attempt per tick.
        # A page-local reconciliation blocker or lease must not starve later pages.
        deferred_reasons = {
            "page_reconciliation_required", "page_lease_busy", "reuse_source_success_empty",
            "reuse_source_success_exhausted", "strict_ready_exhausted",
            "candidate_budget_exhausted", "slot_already_claimed",
        }
        deferred = []
        for index, due_page in enumerate(due):
            page_id = str(due_page["page_id"])
            result = self.run_page(
                page_id,
                shadow=not self.config.writes_enabled,
                trigger="scheduler",
                at=at,
            )
            result["due_pages"] = len(due)
            result["pages_considered"] = index + 1
            result["pages_deferred"] = len(deferred)
            reason = str(result.get("reason") or "")
            if result.get("attempt_id") or result.get("ok") or reason not in deferred_reasons:
                return result
            deferred.append({"page_id": page_id, "reason": reason})
        return {
            "ok": False,
            "state": "blocked",
            "reason": "all_due_pages_deferred",
            "due_pages": len(due),
            "pages_considered": len(due),
            "pages_deferred": len(deferred),
            "deferred": deferred,
        }

    def run_due_comment_retry_once(self, at: Optional[int] = None) -> Dict[str, Any]:
        due = self.ledger.due_comment_retries(now=at, limit=1000)
        if not due:
            return {"ok": True, "state": "idle", "due_comment_retries": 0}
        deferred = []
        for index, due_attempt in enumerate(due):
            attempt_id = str(due_attempt["attempt_id"])
            try:
                result = self.reconcile_attempt(attempt_id)
            except Exception as exc:
                current = self.ledger.attempt(attempt_id)
                if str(current["state"]) in {
                    "post_confirmed", "final_shortlink_ok", "comment_pending",
                    "post_success_comment_failed",
                }:
                    self.ledger.record_comment_failure(
                        attempt_id, _error_code(exc), redact_error(exc), now=at,
                    )
                elif str(current["state"]) == "post_success_verification_failed":
                    self.ledger.record_verification_failure(
                        attempt_id, _error_code(exc), redact_error(exc), now=at,
                    )
                raise
            if str(result.get("reason") or "") == "page_lease_busy":
                deferred.append({"attempt_id": attempt_id, "reason": "page_lease_busy"})
                continue
            result["due_comment_retries"] = len(due)
            result["comment_retries_considered"] = index + 1
            result["comment_retries_deferred"] = len(deferred)
            return result
        return {
            "ok": False,
            "state": "skipped",
            "reason": "all_comment_retry_pages_busy",
            "due_comment_retries": len(due),
            "comment_retries_considered": len(due),
            "comment_retries_deferred": len(deferred),
            "deferred": deferred,
        }

    def status(self) -> Dict[str, Any]:
        return {
            "writes_enabled": self.config.writes_enabled,
            "scheduler_enabled": self.config.scheduler_enabled,
            "strict_ready": self.studio.strict_ready_count(),
            "ledger": self.ledger.summary(),
            "unknown_outcomes": len(self.ledger.attempts_in_states(["post_outcome_unknown"])),
            "comment_backlog": len(self.ledger.attempts_in_states(["post_success_comment_failed"])),
            "due_comment_retries": len(self.ledger.due_comment_retries(limit=1000)),
            "verification_backlog": len(self.ledger.attempts_in_states(["post_success_verification_failed"])),
            "page_blockers": len(self.ledger.attempts_in_states(PAGE_BLOCKING_STATES)),
        }
