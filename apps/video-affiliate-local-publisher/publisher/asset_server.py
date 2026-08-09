from __future__ import annotations

import mimetypes
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional, Tuple


class AssetServerError(RuntimeError):
    pass


class AssetServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 0):
        if host != "127.0.0.1":
            raise AssetServerError("asset_server_loopback_only")
        self.host = host
        self.port = int(port)
        self._assets: Dict[str, Tuple[Path, str]] = {}
        self._lock = threading.Lock()
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    def register(self, path: Path, content_type: str = "video/mp4") -> str:
        resolved = path.resolve()
        if not resolved.is_file():
            raise AssetServerError("asset_missing")
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._assets[token] = (resolved, content_type)
        if not self._server:
            raise AssetServerError("asset_server_not_started")
        return f"http://{self.host}:{self._server.server_port}/asset/{token}"

    def start(self) -> "AssetServer":
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    payload = b'{"ok":true}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                prefix = "/asset/"
                if not self.path.startswith(prefix):
                    self.send_error(404)
                    return
                token = self.path[len(prefix):].split("?", 1)[0]
                with parent._lock:
                    asset = parent._assets.get(token)
                if not asset:
                    self.send_error(404)
                    return
                path, content_type = asset
                try:
                    size = path.stat().st_size
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(size))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    with path.open("rb") as handle:
                        while True:
                            chunk = handle.read(1024 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return

            def log_message(self, format, *args):
                return

        self._server = ThreadingHTTPServer((self.host, self.port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, name="asset-server", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        if self._thread:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None
        with self._lock:
            self._assets.clear()

    def __enter__(self) -> "AssetServer":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()
