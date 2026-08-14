import hashlib
import stat
import tempfile
import unittest
from pathlib import Path

from publisher.spool import Spool, SpoolError, VideoFile


class SpoolArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spool = Spool(self.root / "spool")
        self.source_path = self.root / "downloaded.mp4"
        self.payload = b"source-before-avatar" * 10_000
        self.source_path.write_bytes(self.payload)
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.source = VideoFile(
            path=self.source_path,
            bytes=len(self.payload),
            sha256=self.sha,
            duration=15.0,
            width=720,
            height=1280,
        )

    def test_archive_is_atomic_reusable_and_private(self):
        first = self.spool.archive_source(7446, self.source)
        second = self.spool.archive_source(7446, self.source)
        self.assertEqual(first.path, second.path)
        self.assertEqual(first.path.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(first.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(first.path.parent.stat().st_mode), 0o700)
        self.assertFalse(any(first.path.parent.glob("*.part")))

    def test_existing_corrupt_archive_fails_closed(self):
        archived = self.spool.archive_source(7446, self.source)
        archived.path.write_bytes(b"x" * len(self.payload))
        with self.assertRaisesRegex(SpoolError, "source_archive_integrity_failed"):
            self.spool.archive_source(7446, self.source)


if __name__ == "__main__":
    unittest.main()