import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from publisher.idbridge_client import IDBridgeError
from publisher.ledger import Ledger
from publisher.publisher import PublisherEngine, PublisherError
from publisher.scheduler import slot_key
from publisher.scheduler import local_day_window
from publisher.security import redact_error


class PublisherHelpersTests(unittest.TestCase):
    def setUp(self):
        self.page = SimpleNamespace(page_id="1008898512617594", caption_template="{caption}")

    def test_chearb_caption_adds_product_link_first_and_limits_hashtags(self):
        item = SimpleNamespace(
            shopee_url="https://s.shopee.co.th/example",
            caption="ราวตากผ้าแบบพับได้\n\n#ราวตากผ้า #ราวตากผ้าพับได้ #ของใช้ในบ้าน #จัดระเบียบบ้าน",
        )
        value = PublisherEngine.caption(cast(Any, self.page), cast(Any, item))
        self.assertEqual(
            value,
            "📌 พิกัด : https://s.shopee.co.th/example\n"
            "ราวตากผ้าแบบพับได้\n"
            "#ราวตากผ้า #ราวตากผ้าพับได้ #ของใช้ในบ้าน",
        )
        self.assertEqual(len(value.splitlines()), 3)
        self.assertNotIn("\n\n", value)
        self.assertLessEqual(len(value), 130)

    def test_chearb_caption_requires_a_shopee_link(self):
        item = SimpleNamespace(shopee_url="", caption="สินค้าน่าใช้\n\n#รีวิว")
        with self.assertRaisesRegex(PublisherError, "caption_shopee_link_missing"):
            PublisherEngine.caption(cast(Any, self.page), cast(Any, item))

    def test_chearb_caption_requires_at_least_three_hashtags(self):
        item = SimpleNamespace(
            shopee_url="https://s.shopee.co.th/example",
            caption="สินค้าน่าใช้\n\n#หนึ่ง #สอง",
        )
        with self.assertRaisesRegex(PublisherError, "caption_hashtags_incomplete"):
            PublisherEngine.caption(cast(Any, self.page), cast(Any, item))

    def test_chearb_caption_compacts_ready_hashtags_to_hard_limit(self):
        item = SimpleNamespace(
            shopee_url="https://s.shopee.co.th/3ViCVKSEo9",
            caption=(
                "ชั้นวางเครื่องสำอางมีลิ้นชัก\n\n"
                "#ชั้นวางเครื่องสำอางมีลิ้นชัก #จัดระเบียบโต๊ะเครื่องแป้ง "
                "#กล่องเก็บเครื่องสำอาง #ของใช้ในบ้าน"
            ),
        )
        value = PublisherEngine.caption(cast(Any, self.page), cast(Any, item))
        self.assertEqual(
            value,
            "📌 พิกัด : https://s.shopee.co.th/3ViCVKSEo9\n"
            "ชั้นวางเครื่องสำอางมีลิ้นชัก\n"
            "#กล่องเก็บเครื่องสำอาง #ของใช้ในบ้าน #โต๊ะเครื่องแป้ง",
        )
        self.assertEqual(len(value.splitlines()), 3)
        self.assertEqual(len(value.splitlines()[2].split()), 3)
        self.assertLessEqual(len(value), 130)

    def test_chearb_caption_fails_closed_when_three_tags_cannot_fit(self):
        item = SimpleNamespace(
            shopee_url="https://s.shopee.co.th/example",
            caption=(
                f"{'สินค้า' * 10}\n\n"
                f"#{'รายละเอียด' * 8} #{'รูปแบบ' * 8} "
                f"#{'หมวดหมู่' * 8} #{'ลักษณะ' * 8}"
            ),
        )
        with self.assertRaisesRegex(PublisherError, "caption_too_long"):
            PublisherEngine.caption(cast(Any, self.page), cast(Any, item))

    def test_chearb_caption_rejects_visible_link_inside_product_text(self):
        item = SimpleNamespace(
            shopee_url="https://s.shopee.co.th/example",
            caption="ดูเพิ่ม https://example.com\n\n#รีวิว #สินค้า #ของใช้",
        )
        with self.assertRaisesRegex(PublisherError, "caption_product_text_link_forbidden"):
            PublisherEngine.caption(cast(Any, self.page), cast(Any, item))

    def test_caption_preserves_link_free_text(self):
        other_page = SimpleNamespace(page_id="200", caption_template="{caption}")
        item = SimpleNamespace(
            shopee_url="https://s.shopee.co.th/example",
            caption="สินค้าน่าใช้ #รีวิว",
        )
        self.assertEqual(
            PublisherEngine.caption(cast(Any, other_page), cast(Any, item)),
            "สินค้าน่าใช้ #รีวิว",
        )

    def test_canonical_story(self):
        story, tail = PublisherEngine.canonical_story("100", "200")
        self.assertEqual(story, "100_200")
        self.assertEqual(tail, "200")

    def test_avatar_uses_local_asset(self):
        class InspectingSpool:
            inspected = None

            def inspect(self, path):
                self.inspected = path

        with tempfile.TemporaryDirectory() as root:
            avatar = Path(root) / "avatar.mp4"
            avatar.write_bytes(b"local-avatar")
            page = cast(Any, SimpleNamespace(
                avatar_enabled=True,
                avatar_path=avatar,
                avatar_version="local-v1",
            ))
            spool = InspectingSpool()
            version = PublisherEngine.resolve_avatar_asset(page, cast(Any, spool))
            self.assertEqual(version, "local-v1")
            self.assertEqual(spool.inspected, avatar)

    def test_avatar_fails_closed_when_local_asset_is_missing(self):
        with tempfile.TemporaryDirectory() as root:
            page = cast(Any, SimpleNamespace(
                avatar_enabled=True,
                avatar_path=Path(root) / "missing.mp4",
                avatar_version="local-v1",
            ))
            with self.assertRaisesRegex(PublisherError, "avatar_asset_missing"):
                PublisherEngine.resolve_avatar_asset(page, cast(Any, SimpleNamespace()))

    def test_avatar_can_be_disabled_per_page_without_an_asset(self):
        page = cast(Any, SimpleNamespace(
            avatar_enabled=False,
            avatar_path=Path("/missing/avatar.mp4"),
            avatar_version="unused",
        ))
        self.assertEqual(
            PublisherEngine.resolve_avatar_asset(page, cast(Any, SimpleNamespace())),
            "none",
        )

    def test_redaction(self):
        text = redact_error(RuntimeError("Authorization: Bearer secret-token Cookie: session=abc X-Bridge-Token: bridge-secret"))
        self.assertNotIn("secret-token", text)
        self.assertNotIn("session=abc", text)
        self.assertNotIn("bridge-secret", text)

    def test_post_error_after_invocation_is_outcome_unknown(self):
        class FailingBridge:
            def ensure_page(self, *args):
                return None

            def graph_get(self, account, path, params):
                return {"id": path}

            def shopee_accounts(self):
                return [{"account": "15130770000"}]

            def shorten(self, *args):
                return "https://s.shopee.co.th/preflight"

            def post(self, *args):
                raise IDBridgeError("facebook_post_failed:graph_error")

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            ledger = Ledger(root_path / "publisher.db")
            attempt = ledger.claim_attempt("100", 1, "slot", "test")
            for state in ["source_resolved", "downloaded", "avatar_composing", "avatar_ready"]:
                ledger.transition(attempt, state)
            video = root_path / "video.mp4"
            video.write_bytes(b"video")
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.config = cast(Any, SimpleNamespace(writes_enabled=True))
            engine.ledger = ledger
            engine._idbridge = cast(Any, FailingBridge())
            page = cast(Any, SimpleNamespace(
                page_id="100", facebook_account="uid", power_editor_account="peuid",
                posting_source="facebook_lite_eaad6",
                shopee_account="15130770000",
                affiliate_id="15130770000", campaign_sub1="campaign",
                caption_template="{caption}", comment_template="{shortlink}",
            ))
            item = cast(Any, SimpleNamespace(shopee_url="https://shopee.co.th/product/1/2", caption="caption"))
            with self.assertRaises(IDBridgeError):
                engine._publish_real(page, item, attempt, video)
            self.assertEqual(ledger.attempt(attempt)["state"], "post_outcome_unknown")

    def test_success_requires_live_post_and_page_comment_readback(self):
        class FakeBridge:
            def __init__(self):
                self.comment_message = ""
                self.shorten_calls = []

            def ensure_page(self, *args):
                return None

            def shopee_accounts(self):
                return [{"account": "15130770000"}]

            def shorten(self, product_url, account, affiliate_id, sub1, sub2, sub3):
                self.shorten_calls.append((sub1, sub2, sub3))
                return "https://s.shopee.co.th/pre" if not sub3 else "https://s.shopee.co.th/final"

            def post(self, *args):
                return {"source": "facebook_lite_eaad6", "story_id": "200",
                        "video_id": "video-1", "post_url": "https://facebook.test/100_200"}

            def page_comment(self, page_id, story_id, message, account):
                self.comment_message = message
                return "comment-1"

            def graph_get(self, account, path, params):
                if path == "100":
                    return {"id": "100"}
                if path == "100_200":
                    return {"id": path, "is_published": True,
                            "permalink_url": "https://facebook.test/100_200"}
                if path == "comment-1":
                    return {"id": path, "from": {"id": "100"},
                            "message": self.comment_message}
                if path == "100_200/comments":
                    return {"data": [{"id": "comment-1"}]}
                raise AssertionError(path)

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            ledger = Ledger(root_path / "publisher.db")
            attempt = ledger.claim_attempt("100", 2, "slot-success", "test")
            for state in ["source_resolved", "downloaded", "avatar_composing", "avatar_ready"]:
                ledger.transition(attempt, state)
            video = root_path / "video.mp4"
            video.write_bytes(b"video")
            page = cast(Any, SimpleNamespace(
                page_id="100", name="page", enabled=True, interval_minutes=20,
                facebook_account="uid", power_editor_account="peuid",
                posting_source="facebook_lite_eaad6",
                shopee_account="15130770000", affiliate_id="15130770000",
                campaign_sub1="campaign", caption_template="{caption}",
                comment_template="{shortlink}\ncomment",
            ))
            bridge = FakeBridge()
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.config = cast(Any, SimpleNamespace(
                writes_enabled=True, comment_delay_seconds=0, pages=[page],
            ))
            engine.ledger = ledger
            engine._idbridge = cast(Any, bridge)
            engine.spool = cast(Any, SimpleNamespace(cleanup=lambda attempt_id: None))
            item = cast(Any, SimpleNamespace(
                content_id=2, shopee_url="https://shopee.co.th/product/1/2", caption="caption",
            ))
            result = engine._publish_real(page, item, attempt, video)
            self.assertTrue(result["live_readback"])
            self.assertEqual(ledger.attempt(attempt)["state"], "success")
            self.assertEqual(bridge.shorten_calls[-1], ("campaign", "100", "200"))
            self.assertIn("https://s.shopee.co.th/final", bridge.comment_message)

    def test_chearb_publish_uses_preflight_shortlink_in_caption(self):
        class FakeBridge:
            def __init__(self):
                self.post_caption = ""
                self.comment_message = ""

            def ensure_page(self, *args):
                return None

            def shopee_accounts(self):
                return [{"account": "15130770000"}]

            def shorten(self, product_url, account, affiliate_id, sub1, sub2, sub3):
                del product_url, account, affiliate_id, sub1, sub2
                return "https://s.shopee.co.th/final" if sub3 else "https://s.shopee.co.th/preflight?lp=aff"

            def post(self, page_id, video_url, caption, account, source):
                del page_id, video_url, account, source
                self.post_caption = caption
                return {
                    "source": "facebook_lite_eaad6", "story_id": "200",
                    "video_id": "video-1", "post_url": "https://facebook.test/1008898512617594_200",
                }

            def page_comment(self, page_id, story_id, message, account):
                del page_id, story_id, account
                self.comment_message = message
                return "comment-1"

            def graph_get(self, account, path, params):
                del account, params
                if path == "1008898512617594":
                    return {"id": path}
                if path == "1008898512617594_200":
                    return {"id": path, "is_published": True, "permalink_url": "https://facebook.test/reel/200"}
                if path == "comment-1":
                    return {"id": path, "from": {"id": "1008898512617594"}, "message": self.comment_message}
                if path == "1008898512617594_200/comments":
                    return {"data": [{"id": "comment-1"}]}
                raise AssertionError(path)

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            ledger = Ledger(root_path / "publisher.db")
            attempt = ledger.claim_attempt("1008898512617594", 4, "slot-chearb-caption", "test")
            for state in ["source_resolved", "downloaded", "avatar_composing", "avatar_ready"]:
                ledger.transition(attempt, state)
            video = root_path / "video.mp4"
            video.write_bytes(b"video")
            page = cast(Any, SimpleNamespace(
                page_id="1008898512617594", name="เฉียบ", enabled=True, interval_minutes=30,
                facebook_account="uid", power_editor_account="peuid",
                posting_source="facebook_lite_eaad6", shopee_account="15130770000",
                affiliate_id="15130770000", campaign_sub1="campaign",
                caption_template="{caption}", comment_template="{shortlink}\ncomment",
            ))
            bridge = FakeBridge()
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.config = cast(Any, SimpleNamespace(
                writes_enabled=True, comment_delay_seconds=0, pages=[page],
            ))
            engine.ledger = ledger
            engine._idbridge = cast(Any, bridge)
            engine.spool = cast(Any, SimpleNamespace(cleanup=lambda attempt_id: None))
            item = cast(Any, SimpleNamespace(
                content_id=4, ready_message_id="ready-4", ready_video_url="https://cdn/4.mp4",
                shopee_url="https://shopee.co.th/product/1/4", lazada_url="https://lazada.test/4",
                caption="ราวตากผ้าแบบพับได้\n\n#หนึ่ง #สอง #สาม #สี่", ready_at="now",
            ))
            engine._publish_real(page, item, attempt, video)
            self.assertEqual(
                bridge.post_caption,
                "📌 พิกัด : https://s.shopee.co.th/preflight\n"
                "ราวตากผ้าแบบพับได้\n#หนึ่ง #สอง #สาม",
            )

    def test_reconcile_reuses_existing_comment_without_reposting(self):
        class FakeBridge:
            def __init__(self, message):
                self.message = message
                self.comment_posts = 0

            def ensure_page(self, *args):
                return None

            def shopee_accounts(self):
                return [{"account": "15130770000"}]

            def graph_get(self, account, path, params):
                if path == "100":
                    return {"id": "100"}
                if path == "100_200/comments":
                    return {"data": [{"id": "comment-existing", "message": self.message,
                                      "from": {"id": "100"}}]}
                if path == "100_200":
                    return {"id": path, "is_published": True,
                            "permalink_url": "https://facebook.test/100_200"}
                if path == "comment-existing":
                    return {"id": path, "parent": {"id": "100_200"},
                            "from": {"id": "100"}, "message": self.message}
                raise AssertionError(path)

            def page_comment(self, *args):
                self.comment_posts += 1
                raise AssertionError("must_not_repost_comment")

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            ledger = Ledger(root_path / "publisher.db")
            attempt = ledger.claim_attempt("100", 3, "slot-reconcile", "test")
            for state in ["source_resolved", "downloaded", "avatar_composing", "avatar_ready",
                          "shortlink_preflight_ok", "posting"]:
                ledger.transition(attempt, state)
            ledger.transition(attempt, "post_confirmed", {
                "fb_story_id": "100_200", "fb_post_tail": "200", "fb_video_id": "video-1",
            })
            final_link = "https://s.shopee.co.th/final"
            ledger.transition(attempt, "final_shortlink_ok", {"final_shortlink": final_link})
            ledger.transition(attempt, "comment_pending")
            ledger.transition(attempt, "post_success_comment_failed", {"error_code": "timeout"})
            page = cast(Any, SimpleNamespace(
                page_id="100", name="page", enabled=True, interval_minutes=20,
                facebook_account="uid", power_editor_account="peuid",
                posting_source="facebook_lite_eaad6",
                shopee_account="15130770000", affiliate_id="15130770000",
                campaign_sub1="campaign", caption_template="{caption}",
                comment_template="{shortlink}\ncomment",
            ))
            message = page.comment_template.format(shortlink=final_link)
            bridge = FakeBridge(message)
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.config = cast(Any, SimpleNamespace(writes_enabled=True, pages=[page]))
            engine.ledger = ledger
            engine._idbridge = cast(Any, bridge)
            engine.spool = cast(Any, SimpleNamespace(cleanup=lambda attempt_id: None))
            self.assertTrue(ledger.acquire_lease("page:100", "active-publisher", 900))
            busy = engine.reconcile_attempt(attempt)
            self.assertEqual(busy["state"], "skipped")
            self.assertEqual(busy["reason"], "page_lease_busy")
            self.assertEqual(bridge.comment_posts, 0)
            ledger.release_lease("page:100", "active-publisher")
            result = engine.reconcile_attempt(attempt)
            self.assertEqual(result["state"], "success")
            self.assertEqual(bridge.comment_posts, 0)
            recovered = ledger.attempt(attempt)
            self.assertEqual(recovered["comment_id"], "comment-existing")
            self.assertEqual(recovered["error_code"], "")

    def test_reconcile_existing_comment_moves_failed_state_through_pending(self):
        class FakeLedger:
            def __init__(self):
                self.state = "post_success_comment_failed"
                self.transitions = []

            def attempt(self, _attempt_id):
                return {
                    "attempt_id": "attempt", "page_id": "100", "studio_content_id": 3,
                    "state": self.state, "fb_story_id": "100_200", "fb_post_tail": "200",
                    "final_shortlink": "https://s.shopee.co.th/final",
                    "comment_id": "", "permalink": "", "fb_video_id": "video-1",
                }

            def transition(self, _attempt_id, state, _fields=None):
                allowed = {
                    "post_success_comment_failed": {"comment_pending"},
                    "comment_pending": {"verifying"},
                    "verifying": {"success"},
                }
                if state not in allowed.get(self.state, set()):
                    raise AssertionError(f"invalid transition {self.state}->{state}")
                self.transitions.append((self.state, state))
                self.state = state

            def advance_page_after_success(self, *_args):
                return None

        final_link = "https://s.shopee.co.th/final"
        message = final_link + "\ncomment"

        class FakeBridge:
            def ensure_page(self, *args):
                return None

            def shopee_accounts(self):
                return [{"account": "15130770000"}]

            def graph_get(self, account, path, params):
                if path == "100":
                    return {"id": "100"}
                if path == "100_200/comments":
                    if params.get("fields") == "id,message,from":
                        return {"data": [{"id": "comment-existing", "message": message,
                                          "from": {"id": "100"}}]}
                    return {"data": [{"id": "comment-existing"}]}
                if path == "100_200":
                    return {"id": path, "is_published": True, "permalink_url": "https://fb.test"}
                if path == "comment-existing":
                    return {"id": path, "from": {"id": "100"}, "message": message}
                raise AssertionError(path)

            def page_comment(self, *args):
                raise AssertionError("must_not_create_comment")

        page = cast(Any, SimpleNamespace(
            page_id="100", interval_minutes=20, facebook_account="uid",
            power_editor_account="peuid", posting_source="facebook_lite_eaad6",
            shopee_account="15130770000", affiliate_id="15130770000",
            campaign_sub1="campaign", comment_template="{shortlink}\ncomment",
        ))
        engine = PublisherEngine.__new__(PublisherEngine)
        engine.config = cast(Any, SimpleNamespace(writes_enabled=True, pages=[page]))
        engine.ledger = cast(Any, FakeLedger())
        engine._idbridge = cast(Any, FakeBridge())
        engine.spool = cast(Any, SimpleNamespace(cleanup=lambda _attempt_id: None))
        engine.notifier = cast(Any, SimpleNamespace(send=lambda *args, **kwargs: None))
        result = engine._reconcile_attempt_locked("attempt")
        self.assertEqual(result["state"], "success")
        self.assertEqual(engine.ledger.transitions[:2], [
            ("post_success_comment_failed", "comment_pending"),
            ("comment_pending", "verifying"),
        ])

    def test_recover_existing_story_binds_exact_story_and_never_reposts(self):
        caption = "exact caption"

        class FakeBridge:
            def __init__(self):
                self.post_calls = 0
                self.comment_message = ""

            def graph_get(self, account, path, params):
                del account
                if path == "100_200":
                    return {
                        "id": path, "message": caption,
                        "created_time": "1970-01-01T00:16:40+00:00",
                        "permalink_url": "https://facebook.test/reel/300",
                        "from": {"id": "100"}, "is_published": True,
                        "attachments": {"data": [{"target": {"id": "300"}}]},
                    }
                if path == "300":
                    return {
                        "id": "300", "description": caption,
                        "created_time": "1970-01-01T00:16:40+00:00",
                        "permalink_url": "https://facebook.test/reel/300",
                        "from": {"id": "100"}, "published": True,
                    }
                if path == "100":
                    return {"id": "100"}
                if path == "100_200/comments":
                    if params.get("fields") == "id,message,from":
                        return {"data": []}
                    return {"data": [{"id": "comment-1"}]}
                if path == "comment-1":
                    return {
                        "id": "comment-1", "parent": {"id": "100_200"},
                        "from": {"id": "100"}, "message": self.comment_message,
                    }
                raise AssertionError(path)

            def post(self, *args):
                self.post_calls += 1
                raise AssertionError("must_not_repost")

            def ensure_page(self, *args):
                return None

            def shopee_accounts(self):
                return [{"account": "15130770000"}]

            def shorten(self, product_url, account, affiliate_id, sub1, sub2, sub3):
                del product_url, account, affiliate_id, sub1, sub2
                return "https://s.shopee.co.th/final" if sub3 else "https://s.shopee.co.th/pre"

            def shorten_verified(self, product_url, account, affiliate_id, sub1, sub2, sub3):
                return {
                    "shortlink": self.shorten(
                        product_url, account, affiliate_id, sub1, sub2, sub3,
                    ),
                    "canonical_url": "https://shopee.co.th/product/1/124",
                    "utm_content": f"{sub1}-{sub2}-{sub3}--",
                }

            def page_comment(self, page_id, story_id, message, account):
                del page_id, story_id, account
                self.comment_message = message
                return "comment-1"

        with tempfile.TemporaryDirectory() as root:
            ledger = Ledger(Path(root) / "publisher.db")
            item = SimpleNamespace(
                content_id=124, ready_message_id="message-124",
                shopee_url="https://shopee.co.th/product/1/124",
                lazada_url="https://www.lazada.co.th/products/example-i124.html",
                caption=caption, ready_at="1970-01-01T00:00:00Z",
            )
            ledger.upsert_source(item, "attachment-124", "f" * 64)
            archive_path = Path(root) / "archive-124.mp4"
            ledger.record_source_archive(124, "f" * 64, archive_path, 200_000, now=900)
            attempt = ledger.claim_attempt("100", 124, "recover-slot", "scheduler")
            for state in [
                "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
                "shortlink_preflight_ok", "posting", "stale_posting_review",
            ]:
                fields = {"source_sha256": "f" * 64} if state == "downloaded" else None
                ledger.transition(attempt, state, fields)
            with ledger.connect() as conn:
                conn.execute(
                    "UPDATE post_attempts SET created_at=?,updated_at=? WHERE attempt_id=?",
                    (995, 1_000, attempt),
                )
            page = cast(Any, SimpleNamespace(
                page_id="100", name="page", enabled=True, interval_minutes=20,
                facebook_account="uid", power_editor_account="peuid",
                posting_source="facebook_lite_eaad6",
                shopee_account="15130770000", affiliate_id="15130770000",
                campaign_sub1="campaign", caption_template="{caption}",
                comment_template="{shortlink}\ncomment",
            ))
            bridge = FakeBridge()
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.config = cast(Any, SimpleNamespace(
                writes_enabled=True, pages=[page], comment_delay_seconds=0,
            ))
            engine.ledger = ledger
            engine._idbridge = cast(Any, bridge)
            engine.spool = cast(Any, SimpleNamespace(
                inspect=lambda path: SimpleNamespace(
                    path=path, sha256="f" * 64, bytes=200_000,
                ),
                cleanup=lambda _attempt_id: None,
            ))
            engine.notifier = cast(Any, SimpleNamespace(send=lambda *args, **kwargs: None))
            result = engine.recover_existing_story(
                attempt,
                story_id="100_200",
                video_id="300",
                expected_caption_sha256=PublisherEngine._caption_digest(caption),
            )
            self.assertEqual(result["state"], "success")
            self.assertEqual(bridge.post_calls, 0)
            recovered = ledger.attempt(attempt)
            self.assertEqual(recovered["fb_story_id"], "100_200")
            self.assertEqual(recovered["fb_video_id"], "300")
            self.assertEqual(recovered["comment_id"], "comment-1")

    def test_recover_existing_story_fails_before_mutation_on_caption_mismatch(self):
        class FakeLedger:
            def attempt(self, _attempt_id):
                return {
                    "state": "stale_posting_review", "page_id": "100",
                    "studio_content_id": 1, "source_sha256": "a" * 64,
                }

            def source_item(self, _content_id):
                return {
                    "caption": "expected", "studio_content_id": 1,
                    "source_sha256": "a" * 64,
                    "editor_message_id": "message", "shopee_url": "https://shopee.co.th/product/1/1",
                    "lazada_url": "https://www.lazada.co.th/products/example.html", "ready_at": "",
                }

            def source_archive(self, _content_id, _sha256):
                return {"archive_path": "/archive.mp4", "archive_bytes": 200_000}

        page = cast(Any, SimpleNamespace(page_id="100", caption_template="{caption}"))
        engine = PublisherEngine.__new__(PublisherEngine)
        engine.config = cast(Any, SimpleNamespace(writes_enabled=True, pages=[page]))
        engine.ledger = cast(Any, FakeLedger())
        engine.spool = cast(Any, SimpleNamespace(
            inspect=lambda path: SimpleNamespace(
                path=path, sha256="a" * 64, bytes=200_000,
            ),
        ))
        with self.assertRaisesRegex(PublisherError, "existing_story_expected_caption_changed"):
            engine.recover_existing_story(
                "attempt", story_id="100_200", video_id="300",
                expected_caption_sha256=PublisherEngine._caption_digest("wrong"),
            )

    def test_scheduler_skips_blocked_oldest_page_and_runs_next_due_page(self):
        class FakeLedger:
            def classify_stale_posting(self, *args, **kwargs):
                return []

            def due_pages(self, now=None):
                return [
                    {"page_id": "review", "next_due_at": 100},
                    {"page_id": "chearb", "next_due_at": 200},
                ]

        engine = PublisherEngine.__new__(PublisherEngine)
        engine.config = cast(Any, SimpleNamespace(
            writes_enabled=True, stale_posting_seconds=900,
        ))
        engine.ledger = cast(Any, FakeLedger())
        calls = []

        def run_page(page_id, **kwargs):
            calls.append((page_id, kwargs))
            if page_id == "review":
                return {
                    "ok": False,
                    "state": "skipped",
                    "reason": "slot_already_claimed",
                }
            return {"ok": True, "state": "success", "page_id": page_id}

        engine.run_page = run_page
        result = engine.run_due_once(at=300)
        self.assertEqual(result["page_id"], "chearb")
        self.assertEqual([page_id for page_id, _kwargs in calls], ["review", "chearb"])
        self.assertEqual(result["pages_considered"], 2)
        self.assertEqual(result["pages_deferred"], 1)

    def test_scheduler_runs_at_most_one_post_attempt_per_tick(self):
        class FakeLedger:
            def classify_stale_posting(self, *args, **kwargs):
                return []

            def due_pages(self, now=None):
                return [
                    {"page_id": "oldest", "next_due_at": 100},
                    {"page_id": "next", "next_due_at": 200},
                ]

        engine = PublisherEngine.__new__(PublisherEngine)
        engine.config = cast(Any, SimpleNamespace(
            writes_enabled=True, stale_posting_seconds=900,
        ))
        engine.ledger = cast(Any, FakeLedger())
        calls = []

        def run_page(page_id, **kwargs):
            calls.append(page_id)
            return {"ok": False, "state": "failed", "attempt_id": "attempt-1"}

        engine.run_page = run_page
        result = engine.run_due_once(at=300)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(calls, ["oldest"])
        self.assertEqual(result["pages_considered"], 1)

    def test_scheduler_does_not_create_a_second_post_after_success(self):
        class FakeLedger:
            def classify_stale_posting(self, *args, **kwargs):
                return []

            def due_pages(self, now=None):
                return [
                    {"page_id": "oldest", "next_due_at": 100},
                    {"page_id": "next", "next_due_at": 200},
                ]

        engine = PublisherEngine.__new__(PublisherEngine)
        engine.config = cast(Any, SimpleNamespace(
            writes_enabled=True, stale_posting_seconds=900,
        ))
        engine.ledger = cast(Any, FakeLedger())
        calls = []

        def run_page(page_id, **kwargs):
            calls.append(page_id)
            return {"ok": True, "state": "success", "page_id": page_id}

        engine.run_page = run_page
        result = engine.run_due_once(at=300)
        self.assertEqual(result["state"], "success")
        self.assertEqual(calls, ["oldest"])
        self.assertEqual(result["pages_considered"], 1)

    def test_comment_retry_scheduler_repairs_only_one_existing_attempt(self):
        class FakeLedger:
            def due_comment_retries(self, now=None, limit=1):
                self.request = (now, limit)
                return [
                    {"attempt_id": "old-comment"},
                    {"attempt_id": "new-comment"},
                ][:limit]

        engine = PublisherEngine.__new__(PublisherEngine)
        engine.ledger = cast(Any, FakeLedger())
        reconciled = []

        def reconcile_attempt(attempt_id):
            reconciled.append(attempt_id)
            return {"ok": True, "state": "success", "attempt_id": attempt_id}

        engine.reconcile_attempt = reconcile_attempt
        result = engine.run_due_comment_retry_once(at=500)
        self.assertEqual(reconciled, ["old-comment"])
        self.assertEqual(result["attempt_id"], "old-comment")
        self.assertEqual(result["due_comment_retries"], 2)

    def test_comment_retry_scheduler_reschedules_failure_before_comment_pending(self):
        with tempfile.TemporaryDirectory() as root:
            ledger = Ledger(Path(root) / "publisher.db")
            attempt = ledger.claim_attempt("100", 91, "slot-comment-preflight", "scheduler")
            for state in [
                "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
                "shortlink_preflight_ok", "posting", "post_confirmed",
                "final_shortlink_ok", "comment_pending",
            ]:
                ledger.transition(attempt, state)
            ledger.record_comment_failure(attempt, "first", "redacted", now=100)
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.ledger = ledger

            def fail_before_pending(attempt_id):
                del attempt_id
                raise PublisherError("power_editor_page_readback_failed")

            engine.reconcile_attempt = fail_before_pending
            with self.assertRaisesRegex(PublisherError, "power_editor_page_readback_failed"):
                engine.run_due_comment_retry_once(at=400)
            row = ledger.attempt(attempt)
            self.assertEqual(row["state"], "post_success_comment_failed")
            self.assertEqual(row["comment_retry_count"], 2)
            self.assertEqual(row["comment_retry_at"], 400 + 10 * 60)

    def test_comment_retry_scheduler_reschedules_failure_after_final_link_transition(self):
        with tempfile.TemporaryDirectory() as root:
            ledger = Ledger(Path(root) / "publisher.db")
            attempt = ledger.claim_attempt("100", 92, "slot-comment-final-link", "scheduler")
            for state in [
                "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
                "shortlink_preflight_ok", "posting", "post_confirmed",
                "final_shortlink_ok", "comment_pending",
            ]:
                ledger.transition(attempt, state)
            ledger.record_comment_failure(attempt, "first", "redacted", now=100)
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.ledger = ledger

            def fail_after_final_link(attempt_id):
                ledger.transition(attempt_id, "final_shortlink_ok")
                raise PublisherError("comment_template_missing_shortlink")

            engine.reconcile_attempt = fail_after_final_link
            with self.assertRaisesRegex(PublisherError, "comment_template_missing_shortlink"):
                engine.run_due_comment_retry_once(at=400)
            row = ledger.attempt(attempt)
            self.assertEqual(row["state"], "post_success_comment_failed")
            self.assertEqual(row["comment_retry_count"], 2)
            self.assertEqual(row["comment_retry_at"], 400 + 10 * 60)

    def test_comment_retry_scheduler_skips_busy_page_and_repairs_next_attempt(self):
        class FakeLedger:
            def due_comment_retries(self, now=None, limit=1):
                self.request = (now, limit)
                return [
                    {"attempt_id": "busy-comment"},
                    {"attempt_id": "repairable-comment"},
                ]

        engine = PublisherEngine.__new__(PublisherEngine)
        engine.ledger = cast(Any, FakeLedger())
        reconciled = []

        def reconcile_attempt(attempt_id):
            reconciled.append(attempt_id)
            if attempt_id == "busy-comment":
                return {"ok": False, "state": "skipped", "reason": "page_lease_busy"}
            return {"ok": True, "state": "success", "attempt_id": attempt_id}

        engine.reconcile_attempt = reconcile_attempt
        result = engine.run_due_comment_retry_once(at=500)
        self.assertEqual(reconciled, ["busy-comment", "repairable-comment"])
        self.assertEqual(result["attempt_id"], "repairable-comment")
        self.assertEqual(result["comment_retries_considered"], 2)
        self.assertEqual(result["comment_retries_deferred"], 1)

    def test_slot_key_stable(self):
        self.assertEqual(slot_key("100", 20, at=1234), slot_key("100", 20, at=2399))

    def test_daily_limit_stops_before_source_selection(self):
        with tempfile.TemporaryDirectory() as root:
            ledger = Ledger(Path(root) / "publisher.db")
            attempt = ledger.claim_attempt("secondary", 3, "daily-success", "scheduler")
            for state in [
                "source_resolved", "downloaded", "avatar_composing", "avatar_ready",
                "shortlink_preflight_ok", "posting", "post_confirmed",
                "final_shortlink_ok", "comment_pending", "verifying", "success",
            ]:
                ledger.transition(attempt, state)
            now = int(__import__("time").time())
            start, end = local_day_window("Asia/Bangkok", now)
            self.assertLess(start, now)
            self.assertGreater(end, now)
            engine = PublisherEngine.__new__(PublisherEngine)
            engine.ledger = ledger
            engine.studio = cast(Any, SimpleNamespace(
                candidates=lambda *args, **kwargs: self.fail("must_not_select_source"),
            ))
            page = cast(Any, SimpleNamespace(
                page_id="secondary", timezone="Asia/Bangkok",
                daily_success_limit=1, reuse_success_from_page_id="",
            ))
            result = engine._run_locked(page, shadow=False, trigger="manual", at=now)
            self.assertEqual(result["reason"], "daily_success_limit_reached")
            self.assertEqual(result["daily_posts"], 1)
            self.assertEqual(result["daily_post_limit"], 1)

    def test_source_is_archived_from_adopted_path_before_state_progresses(self):
        events = []
        source_sha = "d" * 64
        item = SimpleNamespace(
            content_id=88,
            ready_message_id="message-88",
            shopee_url="https://shopee.co.th/product/1/88",
            lazada_url="https://www.lazada.co.th/products/example-i88.html",
            ready_video_url="https://cdn.example/source.mp4",
        )

        class FakeStudio:
            def candidates(self, **_kwargs):
                return [item]

            def current(self, _content_id):
                return item

        class FakeDiscord:
            def fetch(self, *_args):
                return SimpleNamespace(url="https://cdn.example/source.mp4", attachment_id="att-88")

        class FakeLedger:
            def used_content_ids(self, *_args, **_kwargs):
                return set()

            def page_has_sha(self, *_args):
                return False

            def claim_attempt(self, *_args):
                events.append("claim")
                return "attempt-88"

            def upsert_source(self, *_args):
                events.append("upsert_source")

            def record_source_archive(self, *_args):
                events.append("record_archive")

            def transition(self, _attempt_id, state, _fields=None):
                events.append("transition:" + state)

            def advance_page_after_shadow(self, *_args):
                events.append("advance_shadow")

        class FakeSpool:
            def download(self, probe_id, *_args, **_kwargs):
                return SimpleNamespace(
                    path=Path("/spool") / probe_id / "source.mp4",
                    bytes=200_000,
                    sha256=source_sha,
                    duration=15.0,
                    width=720,
                    height=1280,
                )

            def adopt(self, _probe_id, attempt_id):
                events.append("adopt")
                return Path("/spool") / attempt_id

            def inspect(self, path, expected_sha=""):
                events.append("inspect_adopted")
                self.assert_adopted_path = path
                return SimpleNamespace(
                    path=path, bytes=200_000, sha256=expected_sha,
                    duration=15.0, width=720, height=1280,
                )

            def archive_source(self, content_id, source):
                events.append("archive_source")
                if source.path != Path("/spool/attempt-88/source.mp4"):
                    raise AssertionError("archive did not receive adopted source path")
                return SimpleNamespace(
                    path=Path("/archive") / f"content_{content_id}_{source.sha256}.mp4",
                    bytes=source.bytes,
                    sha256=source.sha256,
                )

            def cleanup(self, _attempt_id):
                events.append("cleanup")

        engine = PublisherEngine.__new__(PublisherEngine)
        engine.config = cast(Any, SimpleNamespace(
            source_max_bytes=262_144_000,
            keep_shadow_spool=False,
        ))
        engine.ledger = cast(Any, FakeLedger())
        engine.studio = cast(Any, FakeStudio())
        engine.discord = cast(Any, FakeDiscord())
        engine.spool = cast(Any, FakeSpool())
        page = cast(Any, SimpleNamespace(
            page_id="page-88",
            timezone="Asia/Bangkok",
            daily_success_limit=0,
            reuse_success_from_page_id="",
            interval_minutes=120,
            avatar_enabled=False,
        ))
        result = engine._run_locked(page, shadow=True, trigger="manual", at=1_000)
        self.assertEqual(result["state"], "shadow_ready")
        self.assertLess(events.index("inspect_adopted"), events.index("archive_source"))
        self.assertLess(events.index("archive_source"), events.index("record_archive"))
        self.assertLess(events.index("record_archive"), events.index("transition:source_resolved"))


if __name__ == "__main__":
    unittest.main()
