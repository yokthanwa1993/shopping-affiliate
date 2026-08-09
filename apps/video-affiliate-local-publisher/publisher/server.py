from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict
from urllib.parse import urlsplit

from .publisher import PublisherEngine
from .security import redact_error


class PublisherHTTPServer:
    def __init__(self, engine: PublisherEngine):
        self.engine = engine
        self.config = engine.config
        self.stop_event = threading.Event()
        self.run_lock = threading.Lock()
        self.scheduler_thread: threading.Thread | None = None
        self.httpd: ThreadingHTTPServer | None = None

    def _scheduler_loop(self) -> None:
        while not self.stop_event.wait(60):
            if not self.config.scheduler_enabled:
                continue
            if not self.run_lock.acquire(blocking=False):
                continue
            try:
                self.engine.run_due_once()
            except Exception:
                # Errors are persisted on attempts. Never print exception objects that may
                # contain network request context.
                pass
            finally:
                self.run_lock.release()

    def serve_forever(self) -> None:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def _json(self, status: int, payload: Dict[str, Any]) -> None:
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                path = urlsplit(self.path).path
                if path == "/health":
                    self._json(200, {
                        "ok": True,
                        "service": "video-affiliate-local-publisher",
                        "mode": "write" if parent.config.writes_enabled else "shadow",
                        "scheduler_enabled": parent.config.scheduler_enabled,
                    })
                    return
                if path == "/status":
                    try:
                        self._json(200, parent.engine.status())
                    except Exception as exc:
                        self._json(500, {"ok": False, "error": redact_error(exc)})
                    return
                self._json(404, {"ok": False, "error": "not_found"})

            def do_POST(self):
                path = urlsplit(self.path).path
                length = int(self.headers.get("content-length") or 0)
                if length > 16_384:
                    self._json(413, {"ok": False, "error": "body_too_large"})
                    return
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except Exception:
                    self._json(400, {"ok": False, "error": "invalid_json"})
                    return
                page_id = str(body.get("page_id") or "")
                if path == "/dry-run":
                    if not parent.run_lock.acquire(blocking=False):
                        self._json(409, {"ok": False, "error": "publisher_busy"})
                        return
                    try:
                        self._json(200, parent.engine.run_page(page_id, shadow=True, trigger="manual"))
                    except Exception as exc:
                        self._json(500, {"ok": False, "error": redact_error(exc)})
                    finally:
                        parent.run_lock.release()
                    return
                if path == "/run-once":
                    if not (parent.config.writes_enabled and parent.config.manual_api_enabled):
                        self._json(403, {"ok": False, "error": "manual_writes_disabled"})
                        return
                    if not parent.run_lock.acquire(blocking=False):
                        self._json(409, {"ok": False, "error": "publisher_busy"})
                        return
                    try:
                        self._json(200, parent.engine.run_page(page_id, shadow=False, trigger="manual"))
                    except Exception as exc:
                        self._json(500, {"ok": False, "error": redact_error(exc)})
                    finally:
                        parent.run_lock.release()
                    return
                self._json(404, {"ok": False, "error": "not_found"})

            def log_message(self, format, *args):
                return

        self.config.log_root.mkdir(parents=True, exist_ok=True)
        self.httpd = ThreadingHTTPServer((self.config.host, self.config.port), Handler)
        if self.config.scheduler_enabled:
            self.scheduler_thread = threading.Thread(
                target=self._scheduler_loop, name="publisher-scheduler", daemon=True,
            )
            self.scheduler_thread.start()
        self.httpd.serve_forever()

    def shutdown(self) -> None:
        self.stop_event.set()
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        if self.scheduler_thread:
            self.scheduler_thread.join(timeout=5)
