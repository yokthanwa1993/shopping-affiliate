import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from publisher.idbridge_client import IDBridgeError
from publisher.ledger import Ledger
from publisher.publisher import PublisherEngine, PublisherError
from publisher.scheduler import slot_key
from publisher.security import redact_error


class PublisherHelpersTests(unittest.TestCase):
    def setUp(self):
        self.page = SimpleNamespace(page_id="1008898512617594", caption_template="{caption}")

    def test_caption_rejects_visible_link(self):
        item = SimpleNamespace(caption="ซื้อเลย https://example.com")
        with self.assertRaises(PublisherError):
            PublisherEngine.caption(cast(Any, self.page), cast(Any, item))

    def test_caption_preserves_link_free_text(self):
        item = SimpleNamespace(caption="สินค้าน่าใช้ #รีวิว")
        self.assertEqual(PublisherEngine.caption(cast(Any, self.page), cast(Any, item)), "สินค้าน่าใช้ #รีวิว")

    def test_canonical_story(self):
        story, tail = PublisherEngine.canonical_story("100", "200")
        self.assertEqual(story, "100_200")
        self.assertEqual(tail, "200")

    def test_redaction(self):
        text = redact_error(RuntimeError("Authorization: Bearer secret-token Cookie: session=abc X-Bridge-Token: bridge-secret"))
        self.assertNotIn("secret-token", text)
        self.assertNotIn("session=abc", text)
        self.assertNotIn("bridge-secret", text)

    def test_post_error_after_invocation_is_outcome_unknown(self):
        class FailingBridge:
            def ensure_page(self, account, page_id):
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

            def ensure_page(self, account, page_id):
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

    def test_reconcile_reuses_existing_comment_without_reposting(self):
        class FakeBridge:
            def __init__(self, message):
                self.message = message
                self.comment_posts = 0

            def ensure_page(self, account, page_id):
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

    def test_slot_key_stable(self):
        self.assertEqual(slot_key("100", 20, at=1234), slot_key("100", 20, at=2399))


if __name__ == "__main__":
    unittest.main()
