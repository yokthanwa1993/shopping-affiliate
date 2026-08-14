#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

APP_ROOT = Path(__file__).resolve().parents[1]
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from publisher.config import load_config

DEFAULT_GUILD_ID = "1500909618275156070"
FACEBOOK_ID_KEYS = ("story_fbid", "fbid", "v", "video_id", "id")
FACEBOOK_PATH_ID = re.compile(r"/(?:reel|reels|videos|posts)/(\d+)(?:/|$)")
DIGITS = re.compile(r"^\d+$")
STORY_OBJECT = re.compile(r"^(\d+)_(\d+)$")


class FacebookLookupError(RuntimeError):
    pass


def _dedupe(values: List[str]) -> List[str]:
    result: List[str] = []
    seen = set()
    for value in values:
        clean = str(value or "").strip()
        if clean and clean not in seen:
            result.append(clean)
            seen.add(clean)
    return result


def _facebook_url(value: str) -> bool:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    return parsed.scheme in {"http", "https"} and (
        host == "facebook.com" or host.endswith(".facebook.com")
    )


def extract_facebook_ids(value: str) -> List[str]:
    raw = str(value or "").strip()
    if DIGITS.fullmatch(raw):
        return [raw]
    story_match = STORY_OBJECT.fullmatch(raw)
    if story_match:
        return _dedupe([story_match.group(2), story_match.group(1)])
    if not _facebook_url(raw):
        return []

    parsed = urlparse(raw)
    values: List[str] = []
    query = parse_qs(parsed.query)
    for key in FACEBOOK_ID_KEYS:
        for candidate in query.get(key, []):
            if DIGITS.fullmatch(candidate):
                values.append(candidate)
    path_match = FACEBOOK_PATH_ID.search(parsed.path)
    if path_match:
        values.insert(0, path_match.group(1))
    return _dedupe(values)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_facebook_redirect(url: str) -> str:
    if not _facebook_url(url):
        raise FacebookLookupError("facebook_url_required")
    request = Request(
        url,
        headers={
            "User-Agent": "facebookexternalhit/1.1",
            "Accept": "text/html,application/xhtml+xml",
        },
        method="GET",
    )
    opener = build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=20) as response:
            target = response.geturl()
    except HTTPError as exc:
        if exc.code not in {301, 302, 303, 307, 308}:
            raise FacebookLookupError(f"facebook_http_{exc.code}") from exc
        target = str(exc.headers.get("Location") or "").strip()
    except (URLError, TimeoutError) as exc:
        raise FacebookLookupError("facebook_resolve_failed") from exc
    if not target or not _facebook_url(target):
        raise FacebookLookupError("facebook_redirect_invalid")
    return target


def resolve_input(
    value: str,
    fetch_redirect: Callable[[str], str] = fetch_facebook_redirect,
) -> Dict[str, List[str]]:
    raw = str(value or "").strip()
    direct = extract_facebook_ids(raw)
    if direct:
        return {"urls": [raw] if _facebook_url(raw) else [], "candidate_ids": direct}
    if not _facebook_url(raw):
        raise FacebookLookupError("facebook_url_required")
    target = fetch_redirect(raw)
    candidates = extract_facebook_ids(target)
    if not candidates:
        raise FacebookLookupError("facebook_id_not_found")
    return {"urls": _dedupe([raw, target]), "candidate_ids": candidates}


def _readonly(path: Path) -> sqlite3.Connection:
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_file():
        raise FacebookLookupError(f"database_missing:{resolved.name}")
    connection = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def lookup_source(
    ledger_db: Path,
    studio_db: Path,
    candidate_ids: List[str],
    guild_id: str,
    editor_channel_id: str,
) -> Dict[str, object]:
    ids = _dedupe([value for value in candidate_ids if DIGITS.fullmatch(str(value))])
    if not ids:
        raise FacebookLookupError("facebook_id_not_found")

    placeholders = ",".join("?" for _ in ids)
    suffixes = [f"%_{value}" for value in ids]
    permalinks = [f"%/{value}/%" for value in ids]
    query = f"""
        SELECT a.attempt_id,a.page_id,a.studio_content_id,a.state,
               a.fb_video_id,a.fb_story_id,a.fb_post_tail,a.permalink,a.completed_at,
               s.editor_message_id,s.source_attachment_id,s.source_sha256,s.caption,
               ar.archive_path,ar.archive_bytes,ar.archived_at
        FROM post_attempts a
        LEFT JOIN source_items s ON s.studio_content_id=a.studio_content_id
        LEFT JOIN source_archives ar ON ar.studio_content_id=a.studio_content_id
          AND ar.source_sha256=a.source_sha256
        WHERE a.fb_post_tail IN ({placeholders})
           OR a.fb_video_id IN ({placeholders})
           OR a.fb_story_id IN ({placeholders})
           OR a.fb_story_id LIKE ANY_PLACEHOLDER
           OR a.permalink LIKE ANY_PERMALINK
        ORDER BY (a.state='success') DESC, a.completed_at DESC
        LIMIT 1
    """
    suffix_clause = " OR a.fb_story_id LIKE ".join("?" for _ in suffixes)
    permalink_clause = " OR a.permalink LIKE ".join("?" for _ in permalinks)
    query = query.replace("a.fb_story_id LIKE ANY_PLACEHOLDER", f"(a.fb_story_id LIKE {suffix_clause})")
    query = query.replace("a.permalink LIKE ANY_PERMALINK", f"(a.permalink LIKE {permalink_clause})")
    params = ids + ids + ids + suffixes + permalinks

    with _readonly(ledger_db) as ledger:
        row = ledger.execute(query, params).fetchone()
    if row is None:
        return {"found": False, "candidate_ids": ids}

    item = dict(row)
    with _readonly(studio_db) as studio:
        studio_row = studio.execute(
            """
            SELECT id,status,edited_message_id,source_post_id,source_link,reel_url,ai_post_caption
            FROM content_items WHERE id=?
            """,
            (item["studio_content_id"],),
        ).fetchone()
    studio_item = dict(studio_row) if studio_row else {}

    message_at_post = str(item.get("editor_message_id") or "").strip()
    message_current = str(studio_item.get("edited_message_id") or "").strip()
    message_id = message_at_post or message_current
    pointer_changed = bool(message_at_post and message_current and message_at_post != message_current)

    result: Dict[str, object] = {
        "found": True,
        "candidate_ids": ids,
        "attempt_id": item["attempt_id"],
        "page_id": item["page_id"],
        "state": item["state"],
        "studio_content_id": item["studio_content_id"],
        "fb_story_id": item["fb_story_id"],
        "fb_video_id": item["fb_video_id"],
        "fb_post_tail": item["fb_post_tail"],
        "permalink": item["permalink"],
        "completed_at": item["completed_at"],
        "editor_message_id": message_id,
        "editor_message_id_at_post": message_at_post,
        "editor_message_id_current": message_current,
        "editor_pointer_changed": pointer_changed,
        "source_attachment_id": item.get("source_attachment_id") or "",
        "source_sha256": item.get("source_sha256") or "",
        "archive_path": item.get("archive_path") or "",
        "archive_bytes": int(item.get("archive_bytes") or 0),
        "archived_at": item.get("archived_at"),
        "studio_status": studio_item.get("status") or "",
        "source_post_id": studio_item.get("source_post_id") or "",
    }
    if message_id:
        result["editor_jump_url"] = (
            f"https://discord.com/channels/{guild_id}/{editor_channel_id}/{message_id}"
        )
    if pointer_changed:
        result["editor_current_jump_url"] = (
            f"https://discord.com/channels/{guild_id}/{editor_channel_id}/{message_current}"
        )
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Resolve a Facebook Reel/share URL back to its Studio Editor source"
    )
    result.add_argument("facebook_url_or_id")
    result.add_argument("--config", type=Path, default=None)
    result.add_argument("--guild-id", default=DEFAULT_GUILD_ID)
    return result


def main(argv: Optional[List[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        config = load_config(args.config)
        resolved = resolve_input(args.facebook_url_or_id)
        result = lookup_source(
            config.ledger_db,
            config.studio_db,
            resolved["candidate_ids"],
            guild_id=args.guild_id,
            editor_channel_id=config.editor_channel_id,
        )
        result["resolved_urls"] = resolved["urls"]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("found") else 2
    except FacebookLookupError as exc:
        print(json.dumps({"found": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
