import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import patch

from publisher.avatar_source import sync_cloudflare_avatar
from publisher.spool import Spool


class FakeResponse:
    def __init__(self, body=b"", headers=None, status=200):
        self.body = body
        self.headers = headers or {}
        self.status = status
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, size=-1):
        if self.offset >= len(self.body):
            return b""
        if size < 0:
            size = len(self.body) - self.offset
        chunk = self.body[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk


class FakeSpool:
    def inspect(self, path):
        return SimpleNamespace(path=path, bytes=path.stat().st_size,
                               sha256="sha", duration=10.0, width=1080, height=1920)


class AvatarSourceTests(unittest.TestCase):
    def test_download_then_cache_hit_by_cloudflare_version(self):
        body = b"x" * 120_000
        headers = {
            "Content-Type": "video/mp4",
            "Content-Length": str(len(body)),
            "ETag": '"etag-1"',
            "X-Avatar-Version": "v1",
        }
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "avatar.mp4"
            responses = [
                FakeResponse(headers=headers),
                FakeResponse(body=body, headers=headers),
                FakeResponse(headers=headers),
            ]
            with patch("publisher.avatar_source.urlopen", side_effect=responses) as mocked:
                first = sync_cloudflare_avatar(
                    "https://cloudflare.test/avatar.mp4", target, cast(Spool, FakeSpool()), now=300,
                )
                second = sync_cloudflare_avatar(
                    "https://cloudflare.test/avatar.mp4", target, cast(Spool, FakeSpool()), now=301,
                )
            self.assertFalse(first.cache_hit)
            self.assertTrue(second.cache_hit)
            self.assertEqual(second.version, "v1")
            self.assertEqual(target.stat().st_size, len(body))
            self.assertEqual(mocked.call_count, 3)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_rejects_non_https(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(Exception, "avatar_cloudflare_url_invalid"):
                sync_cloudflare_avatar(
                    "http://cloudflare.test/avatar.mp4",
                    Path(root) / "avatar.mp4", cast(Spool, FakeSpool()),
                )


if __name__ == "__main__":
    unittest.main()
