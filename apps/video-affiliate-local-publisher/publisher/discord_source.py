from __future__ import annotations

import json
import mimetypes
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


class DiscordSourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class DiscordVideo:
    message_id: str
    attachment_id: str
    filename: str
    url: str
    size: int
    content_type: str
    component_urls: List[str]


def _component_urls(components: Any) -> List[str]:
    urls: List[str] = []
    stack = list(components or []) if isinstance(components, list) else []
    while stack:
        item = stack.pop()
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if url:
            urls.append(url)
        children = item.get("components")
        if isinstance(children, list):
            stack.extend(children)
    return urls


def _component_labels(components: Any) -> List[str]:
    labels: List[str] = []
    stack = list(components or []) if isinstance(components, list) else []
    while stack:
        item = stack.pop()
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip().lower()
        if label:
            labels.append(label)
        children = item.get("components")
        if isinstance(children, list):
            stack.extend(children)
    return labels


def _normalized_url(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), parts.query, ""))


def parse_editor_message(payload: Dict[str, Any], expected_message_id: str,
                         shopee_url: str, lazada_url: str,
                         expected_video_url: str = "") -> DiscordVideo:
    message_id = str(payload.get("id") or "").strip()
    if message_id != str(expected_message_id):
        raise DiscordSourceError("discord_message_id_mismatch")
    attachments = payload.get("attachments")
    if not isinstance(attachments, list):
        raise DiscordSourceError("discord_attachments_missing")
    videos = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or "").strip()
        content_type = str(item.get("content_type") or "").lower()
        guessed = mimetypes.guess_type(filename)[0] or ""
        if content_type.startswith("video/") or guessed.startswith("video/"):
            videos.append(item)
    if len(videos) != 1:
        raise DiscordSourceError(f"discord_video_attachment_count:{len(videos)}")
    item = videos[0]
    url = str(item.get("proxy_url") or item.get("url") or "").strip()
    if not url.startswith("https://"):
        raise DiscordSourceError("discord_video_url_invalid")
    if expected_video_url:
        actual_path = urlsplit(url).path.rstrip("/")
        expected_path = urlsplit(expected_video_url).path.rstrip("/")
        if not actual_path or actual_path != expected_path:
            raise DiscordSourceError("discord_video_attachment_mismatch")

    urls = _component_urls(payload.get("components"))
    labels = _component_labels(payload.get("components"))
    normalized = {_normalized_url(value) for value in urls}
    shopee_component_urls = [value for value in urls if "shopee" in (urlsplit(value).hostname or "").lower()]
    lazada_component_urls = [value for value in urls if "lazada" in (urlsplit(value).hostname or "").lower()]
    if shopee_component_urls:
        if _normalized_url(shopee_url) not in normalized:
            raise DiscordSourceError("discord_shopee_button_mismatch")
    elif not any("shopee" in label for label in labels):
        raise DiscordSourceError("discord_shopee_button_missing")
    if lazada_component_urls:
        if _normalized_url(lazada_url) not in normalized:
            raise DiscordSourceError("discord_lazada_button_mismatch")
    elif not any("lazada" in label for label in labels):
        raise DiscordSourceError("discord_lazada_button_missing")
    return DiscordVideo(
        message_id=message_id,
        attachment_id=str(item.get("id") or "").strip(),
        filename=str(item.get("filename") or "video.mp4").strip(),
        url=url,
        size=int(item.get("size") or 0),
        content_type=str(item.get("content_type") or "video/mp4"),
        component_urls=urls,
    )


class DiscordSource:
    def __init__(self, channel_id: str, bot_token: str, api_base: str = "https://discord.com/api/v10"):
        self.channel_id = str(channel_id)
        self.bot_token = str(bot_token)
        self.api_base = api_base.rstrip("/")

    def fetch(self, message_id: str, shopee_url: str, lazada_url: str,
              expected_video_url: str = "", timeout: int = 30) -> DiscordVideo:
        url = f"{self.api_base}/channels/{self.channel_id}/messages/{message_id}"
        request = Request(url, headers={
            "Authorization": "Bot " + self.bot_token,
            "User-Agent": "VideoAffiliateLocalPublisher/0.1",
            "Accept": "application/json",
        })
        payload: Any = None
        for attempt in range(3):
            try:
                with urlopen(request, timeout=timeout) as response:
                    payload = json.loads(response.read(4 * 1024 * 1024))
                break
            except HTTPError as exc:
                if exc.code == 429 and attempt < 2:
                    raw = exc.read(64 * 1024)
                    retry_after = 1.0
                    try:
                        data = json.loads(raw or b"{}")
                        retry_after = float(data.get("retry_after") or retry_after)
                    except Exception:
                        pass
                    time.sleep(max(0.25, min(retry_after, 15.0)))
                    continue
                raise DiscordSourceError(f"discord_http_{exc.code}") from exc
            except (URLError, TimeoutError, json.JSONDecodeError) as exc:
                raise DiscordSourceError("discord_fetch_failed") from exc
        if not isinstance(payload, dict):
            raise DiscordSourceError("discord_response_invalid")
        return parse_editor_message(
            payload, message_id, shopee_url, lazada_url, expected_video_url,
        )
