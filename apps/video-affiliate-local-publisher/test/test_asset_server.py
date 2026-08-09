import tempfile
import unittest
from pathlib import Path
from urllib.request import urlopen

from publisher.asset_server import AssetServer


class AssetServerTests(unittest.TestCase):
    def test_opaque_loopback_asset(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "video.mp4"
            path.write_bytes(b"x" * 1024)
            with AssetServer() as server:
                url = server.register(path)
                self.assertTrue(url.startswith("http://127.0.0.1:"))
                with urlopen(url, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), b"x" * 1024)
