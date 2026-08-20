import unittest

from publisher.discord_source import DiscordSourceError, parse_editor_message


class DiscordSourceTests(unittest.TestCase):
    def payload(self):
        return {
            "id": "123",
            "attachments": [{"id": "a1", "filename": "final.mp4", "content_type": "video/mp4", "size": 200000, "proxy_url": "https://cdn.discordapp.com/final.mp4"}],
            "components": [{"components": [
                {"type": 2, "url": "https://s.shopee.co.th/abc"},
                {"type": 2, "url": "https://s.lazada.co.th/xyz"},
            ]}],
        }

    def test_requires_exact_video_and_buttons(self):
        video = parse_editor_message(self.payload(), "123", "https://s.shopee.co.th/abc", "https://s.lazada.co.th/xyz")
        self.assertEqual(video.attachment_id, "a1")

    def test_custom_id_buttons_are_bound_by_labels_and_video_path(self):
        payload = self.payload()
        payload["components"] = [{"components": [
            {"type": 2, "style": 4, "custom_id": "editshopee_v1", "label": "SHOPEE"},
            {"type": 2, "style": 1, "custom_id": "editlazada_v1", "label": "LAZADA"},
        ]}]
        video = parse_editor_message(
            payload, "123", "https://s.shopee.co.th/abc", "https://s.lazada.co.th/xyz",
            "https://cdn.discordapp.com/final.mp4?expired=1",
        )
        self.assertEqual(video.attachment_id, "a1")
        with self.assertRaises(DiscordSourceError):
            parse_editor_message(
                payload, "123", "https://s.shopee.co.th/abc", "https://s.lazada.co.th/xyz",
                "https://cdn.discordapp.com/other.mp4",
            )

    def test_missing_shopee_button_fails_closed(self):
        with self.assertRaises(DiscordSourceError):
            parse_editor_message(self.payload(), "123", "https://s.shopee.co.th/other", "https://s.lazada.co.th/xyz")
