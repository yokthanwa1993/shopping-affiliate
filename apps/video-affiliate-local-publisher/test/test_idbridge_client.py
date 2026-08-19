import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from publisher.idbridge_client import IDBridgeClient, IDBridgeError


class IDBridgeClientTests(unittest.TestCase):
    def setUp(self):
        parent = self
        class Handler(BaseHTTPRequestHandler):
            def reply(self, payload, status=200):
                body = json.dumps(payload).encode()
                self.send_response(status); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            def do_GET(self):
                if self.headers.get("X-Bridge-Token") != "secret": return self.reply({"error":"unauthorized"},401)
                if self.path.startswith("/token"): return self.reply({"ok":True,"accessToken":True,"source":"facebook_lite_eaad6"})
                if self.path.startswith("/pages"): return self.reply({"data":[{"id":"p1"}]})
                if self.path.startswith("/accounts"): return self.reply([{"account":"15130770000"}])
                return self.reply({"error":"not_found"},404)
            def do_POST(self):
                if self.headers.get("X-Bridge-Token") != "secret": return self.reply({"error":"unauthorized"},401)
                body=json.loads(self.rfile.read(int(self.headers.get("Content-Length","0"))) or b"{}")
                if self.path == "/post": return self.reply({"ok":True,"source":"facebook_lite_eaad6","story_id":"p1_post","video_id":"video","post_url":"https://facebook.test/p1_post"})
                if self.path == "/page-comment": return self.reply({"ok":True,"id":"comment","author_expected":"page"})
                if self.path == "/shorten": return self.reply({
                    "ok": True,
                    "shortLink": "https://s.shopee.co.th/final",
                    "canonicalUrl": "https://shopee.co.th/product/1/2",
                    "affiliateVerified": True,
                    "utmContent": "c-p1-post--",
                })
                return self.reply({"error":"not_found"},404)
            def log_message(self,*args): pass
        self.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.client=IDBridgeClient(f"http://127.0.0.1:{self.server.server_port}","secret")
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)
    def test_contract(self):
        self.client.ensure_page("uid","p1")
        self.assertEqual(self.client.shorten("https://shopee.co.th/product/1/2","15130770000","15130770000","c","p1","post"),"https://s.shopee.co.th/final")
        post=self.client.post("p1","http://127.0.0.1/video","caption","uid")
        self.assertEqual(post["source"],"facebook_lite_eaad6")
        self.assertEqual(self.client.page_comment("p1","p1_post","link","uid"),"comment")

    def test_shorten_fails_closed_when_verified_tracking_is_missing(self):
        class BadClient(IDBridgeClient):
            def _request(self, *args, **kwargs):
                return {
                    "ok": True,
                    "shortLink": "https://s.shopee.co.th/final",
                    "canonicalUrl": "https://shopee.co.th/product/1/2",
                    "affiliateVerified": True,
                    "utmContent": "wrong",
                }

        with self.assertRaisesRegex(IDBridgeError, "shorten_tracking_mismatch"):
            BadClient("http://127.0.0.1:1", "secret").shorten(
                "https://shopee.co.th/product/1/2",
                "15130770000", "15130770000", "c", "p1", "post",
            )

    def test_shorten_reseeds_exact_account_once_after_not_found(self):
        class RestartRecoveryClient(IDBridgeClient):
            def __init__(self):
                super().__init__("http://127.0.0.1:1", "secret")
                self.shorten_calls = 0
                self.reseed_accounts = []

            def _shorten_request(self, *args, **kwargs):
                self.shorten_calls += 1
                if self.shorten_calls == 1:
                    return {"ok": False, "code": "error_not_found"}
                return {
                    "ok": True,
                    "shortLink": "https://s.shopee.co.th/final",
                    "canonicalUrl": "https://shopee.co.th/product/1/2",
                    "affiliateVerified": True,
                    "utmContent": "c-p1-post--",
                }

            def reseed_shopee_account(self, account):
                self.reseed_accounts.append(account)

        client = RestartRecoveryClient()
        result = client.shorten_verified(
            "https://shopee.co.th/product/1/2",
            "1508173077", "15130770000", "c", "p1", "post",
        )
        self.assertEqual(result["shortlink"], "https://s.shopee.co.th/final")
        self.assertEqual(client.reseed_accounts, ["1508173077"])
        self.assertEqual(client.shorten_calls, 2)

    def test_shorten_does_not_reseed_or_retry_other_failures(self):
        class PermanentFailureClient(IDBridgeClient):
            def __init__(self):
                super().__init__("http://127.0.0.1:1", "secret")
                self.shorten_calls = 0
                self.reseed_calls = 0

            def _shorten_request(self, *args, **kwargs):
                self.shorten_calls += 1
                return {"ok": False, "code": "fail_code_2"}

            def reseed_shopee_account(self, account):
                self.reseed_calls += 1

        client = PermanentFailureClient()
        with self.assertRaisesRegex(IDBridgeError, "shorten_failed"):
            client.shorten_verified(
                "https://shopee.co.th/product/1/2",
                "1508173077", "15130770000", "c", "p1", "post",
            )
        self.assertEqual(client.shorten_calls, 1)
        self.assertEqual(client.reseed_calls, 0)
