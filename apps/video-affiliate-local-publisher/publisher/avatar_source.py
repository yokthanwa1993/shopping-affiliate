from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from .spool import Spool, VideoFile


class AvatarSourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class CloudflareAvatar:
    video: VideoFile
    version: str
    cache_hit: bool


def _probe_url(url: str, now: int) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["_publisher_probe"] = str(now // 300)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _headers(response: object) -> Dict[str, str]:
    headers = getattr(response, "headers", {})
    return {str(key).lower(): str(value).strip() for key, value in headers.items()}


def _metadata_path(target: Path) -> Path:
    return target.with_suffix(target.suffix + ".cloudflare.json")


def _read_metadata(path: Path) -> Dict[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def sync_cloudflare_avatar(url: str, target: Path, spool: Spool, *,
                           max_bytes: int = 512 * 1024 * 1024,
                           timeout: int = 120,
                           now: int | None = None) -> CloudflareAvatar:
    if not url.startswith("https://"):
        raise AvatarSourceError("avatar_cloudflare_url_invalid")
    checked_at = int(now or time.time())
    fetch_url = _probe_url(url, checked_at)
    try:
        with urlopen(Request(fetch_url, method="HEAD", headers={
            "User-Agent": "VideoAffiliateLocalPublisher/0.1",
            "Cache-Control": "no-cache",
        }), timeout=30) as response:
            status = int(getattr(response, "status", 0))
            head = _headers(response)
    except HTTPError as exc:
        raise AvatarSourceError(f"avatar_cloudflare_head_http_{exc.code}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise AvatarSourceError("avatar_cloudflare_head_failed") from exc
    if status != 200 or "video/mp4" not in head.get("content-type", "").lower():
        raise AvatarSourceError("avatar_cloudflare_head_invalid")
    try:
        declared_size = int(head.get("content-length") or 0)
    except ValueError as exc:
        raise AvatarSourceError("avatar_cloudflare_size_invalid") from exc
    if declared_size < 100_000 or declared_size > max_bytes:
        raise AvatarSourceError("avatar_cloudflare_size_invalid")
    version = head.get("x-avatar-version") or head.get("etag", "").strip('"')
    etag = head.get("etag", "").strip('"')
    cache_key = f"{version}:{etag}:{declared_size}"
    meta_path = _metadata_path(target)
    cached = _read_metadata(meta_path)
    if target.is_file() and cached.get("cache_key") == cache_key:
        video = spool.inspect(target)
        return CloudflareAvatar(video=video, version=version or "cloudflare", cache_hit=True)

    target.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(target.parent, 0o700)
    partial = target.with_suffix(target.suffix + ".part")
    total = 0
    try:
        with urlopen(Request(fetch_url, headers={
            "User-Agent": "VideoAffiliateLocalPublisher/0.1",
            "Cache-Control": "no-cache",
        }), timeout=timeout) as response, partial.open("wb") as handle:
            response_headers = _headers(response)
            if int(getattr(response, "status", 0)) != 200:
                raise AvatarSourceError("avatar_cloudflare_get_invalid")
            if "video/mp4" not in response_headers.get("content-type", "").lower():
                raise AvatarSourceError("avatar_cloudflare_get_invalid")
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise AvatarSourceError("avatar_cloudflare_too_large")
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
    except HTTPError as exc:
        partial.unlink(missing_ok=True)
        raise AvatarSourceError(f"avatar_cloudflare_get_http_{exc.code}") from exc
    except (URLError, TimeoutError, OSError):
        partial.unlink(missing_ok=True)
        raise AvatarSourceError("avatar_cloudflare_get_failed")
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    if total != declared_size:
        partial.unlink(missing_ok=True)
        raise AvatarSourceError("avatar_cloudflare_size_mismatch")
    os.chmod(partial, 0o600)
    partial.replace(target)
    os.chmod(target, 0o600)
    video = spool.inspect(target)
    metadata = {
        "cache_key": cache_key,
        "version": version or "cloudflare",
        "etag": etag,
        "bytes": str(total),
        "checked_at": str(checked_at),
    }
    meta_partial = meta_path.with_suffix(meta_path.suffix + ".part")
    meta_partial.write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")
    os.chmod(meta_partial, 0o600)
    meta_partial.replace(meta_path)
    os.chmod(meta_path, 0o600)
    return CloudflareAvatar(video=video, version=version or "cloudflare", cache_hit=False)
