#!/usr/bin/env python3
import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.environ.get("MOCK_ROOT", "/Users/yok/Developer/video-affiliate/merge-rust/output/local_mock_worker")
VIDEO_PATH = os.environ.get("INPUT_VIDEO", "/Users/yok/Developer/video-affiliate/01e82d55e778f4b94f03700196f121b02d_258.mp4")

os.makedirs(ROOT, exist_ok=True)

class Handler(BaseHTTPRequestHandler):
    server_version = "MockWorker/1.0"

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code: int, body: bytes, content_type: str = "text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[mock-worker]", fmt % args)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True})
            return

        if path == "/input.mp4":
            if not os.path.exists(VIDEO_PATH):
                self._json(404, {"error": "input video not found"})
                return
            with open(VIDEO_PATH, "rb") as f:
                data = f.read()
            self._text(200, data, "video/mp4")
            return

        if path.startswith("/api/r2-proxy/_processing/"):
            local = os.path.join(ROOT, path.lstrip("/"))
            if os.path.exists(local):
                with open(local, "rb") as f:
                    data = f.read()
                self._text(200, data, "application/json")
            else:
                self._json(404, {"error": "not found"})
            return

        self._json(404, {"error": "not found"})

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/r2-upload/"):
            self._json(404, {"error": "not found"})
            return

        key = urllib.parse.unquote(path[len("/api/r2-upload/"):])
        key = key.lstrip("/")
        local = os.path.join(ROOT, key)
        os.makedirs(os.path.dirname(local), exist_ok=True)

        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length) if length > 0 else b""
        with open(local, "wb") as f:
            f.write(data)

        self._json(200, {"ok": True, "key": key, "bytes": len(data)})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/r2-proxy/_processing/"):
            local = os.path.join(ROOT, path.lstrip("/"))
            if os.path.exists(local):
                os.remove(local)
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/gallery/refresh/") or path == "/api/queue/next":
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})


def main():
    port = int(os.environ.get("MOCK_PORT", "8788"))
    print(f"[mock-worker] root={ROOT}")
    print(f"[mock-worker] input={VIDEO_PATH}")
    print(f"[mock-worker] listening on 127.0.0.1:{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
