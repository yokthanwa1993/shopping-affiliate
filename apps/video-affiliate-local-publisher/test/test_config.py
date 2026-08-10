import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from publisher.config import ConfigError, load_config


class ConfigTests(unittest.TestCase):
    def make(self, raw):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        path = Path(root.name) / "config.json"
        path.write_text(json.dumps(raw), encoding="utf-8")
        return load_config(path)

    def test_safe_defaults_are_closed(self):
        config = self.make({"pages": [{"page_id": "1008898512617594"}]})
        self.assertFalse(config.writes_enabled)
        self.assertFalse(config.scheduler_enabled)
        self.assertFalse(config.pages[0].enabled)
        self.assertEqual(config.host, "127.0.0.1")

    def test_non_loopback_rejected(self):
        with self.assertRaises(ConfigError):
            self.make({"host": "0.0.0.0", "pages": []})


    def test_write_config_requires_all_identity_fields(self):
        with patch.dict("os.environ", {"PUBLISHER_ALLOW_WRITES": "I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS"}):
            with self.assertRaises(ConfigError):
                self.make({"writes_enabled": True, "pages": [{"page_id": "100", "enabled": True}]})
