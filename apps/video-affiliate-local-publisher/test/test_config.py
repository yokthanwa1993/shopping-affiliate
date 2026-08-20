import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from publisher.config import ConfigError, DEFAULT_LEDGER, load_config


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
        self.assertEqual(config.pages[0].posting_source, "facebook_lite_eaad6")
        self.assertTrue(config.pages[0].avatar_enabled)
        self.assertEqual(config.pages[0].daily_success_limit, 0)
        self.assertEqual(config.pages[0].reuse_success_from_page_id, "")
        self.assertEqual(config.stale_posting_seconds, 15 * 60)
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.ready_channel_id, "")

    def test_ready_channel_is_explicit(self):
        config = self.make({
            "ready_channel_id": "1234567890",
            "pages": [{"page_id": "1008898512617594"}],
        })
        self.assertEqual(config.ready_channel_id, "1234567890")
        self.assertFalse(hasattr(config, "editor_channel_id"))

    def test_stale_posting_threshold_has_conservative_minimum(self):
        config = self.make({
            "stale_posting_seconds": 1,
            "pages": [{"page_id": "1008898512617594"}],
        })
        self.assertEqual(config.stale_posting_seconds, 300)

    def test_example_config_never_points_at_production_ledger(self):
        example = Path(__file__).resolve().parents[1] / "config.example.json"
        config = load_config(example)
        self.assertNotEqual(config.ledger_db, DEFAULT_LEDGER)

    def test_page_can_disable_avatar_overlay(self):
        config = self.make({"pages": [{
            "page_id": "114142457961643",
            "posting_source": "idbridge_power_editor",
            "avatar_enabled": False,
        }]})
        self.assertEqual(config.pages[0].posting_source, "idbridge_power_editor")
        self.assertFalse(config.pages[0].avatar_enabled)

    def test_unknown_posting_source_rejected(self):
        with self.assertRaisesRegex(ConfigError, "posting_source_invalid"):
            self.make({"pages": [{"page_id": "100", "posting_source": "unknown"}]})

    def test_non_loopback_rejected(self):
        with self.assertRaises(ConfigError):
            self.make({"host": "0.0.0.0", "pages": []})

    def test_secondary_page_reuse_and_daily_limit(self):
        config = self.make({"pages": [
            {"page_id": "100", "enabled": True},
            {
                "page_id": "200", "enabled": True,
                "interval_minutes": 120,
                "daily_success_limit": 12,
                "reuse_success_from_page_id": "100",
            },
        ]})
        secondary = config.pages[1]
        self.assertEqual(secondary.interval_minutes, 120)
        self.assertEqual(secondary.daily_success_limit, 12)
        self.assertEqual(secondary.reuse_success_from_page_id, "100")

    def test_reuse_source_must_be_another_configured_page(self):
        with self.assertRaisesRegex(ConfigError, "reuse_success_from_page_id_not_configured"):
            self.make({"pages": [
                {"page_id": "200", "reuse_success_from_page_id": "100"},
            ]})
        with self.assertRaisesRegex(ConfigError, "reuse_success_from_page_id_self"):
            self.make({"pages": [
                {"page_id": "200", "reuse_success_from_page_id": "200"},
            ]})


    def test_write_config_requires_all_identity_fields(self):
        with patch.dict("os.environ", {"PUBLISHER_ALLOW_WRITES": "I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS"}):
            with self.assertRaises(ConfigError):
                self.make({"writes_enabled": True, "pages": [{"page_id": "100", "enabled": True}]})
