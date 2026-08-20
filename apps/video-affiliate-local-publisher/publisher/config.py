from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

APP_SUPPORT = Path.home() / "Library/Application Support/VideoAffiliatePublisher"
DEFAULT_STUDIO_DB = Path.home() / "Library/Application Support/AffiliateAdmin/content.db"
DEFAULT_CONFIG = APP_SUPPORT / "config.json"
DEFAULT_LEDGER = APP_SUPPORT / "publisher.db"
DEFAULT_SPOOL = APP_SUPPORT / "spool"
DEFAULT_LOGS = Path.home() / "Library/Logs/VideoAffiliatePublisher"
DEFAULT_DISCORD_ENV = Path.home() / "Developer/shopping-affiliate/apps/admin-media-drive/.env"
DEFAULT_IDBRIDGE_AUTH = Path.home() / "Library/Application Support/IDBridge/service-auth"
DIGITS = re.compile(r"^[0-9]+$")
POSTING_SOURCES = {"facebook_lite_eaad6", "idbridge_power_editor"}


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class PageConfig:
    page_id: str
    name: str
    enabled: bool
    interval_minutes: int
    daily_success_limit: int
    reuse_success_from_page_id: str
    timezone: str
    campaign_sub1: str
    shopee_account: str
    affiliate_id: str
    facebook_account: str
    power_editor_account: str
    posting_source: str
    avatar_enabled: bool
    avatar_path: Path
    avatar_version: str
    caption_template: str
    comment_template: str
    chromakey_similarity: float
    chromakey_blend: float


@dataclass(frozen=True)
class AppConfig:
    config_path: Path
    studio_db: Path
    ledger_db: Path
    spool_root: Path
    log_root: Path
    ready_channel_id: str
    discord_env_file: Path
    idbridge_auth_file: Path
    idbridge_url: str
    merge_url: str
    host: str
    port: int
    writes_enabled: bool
    scheduler_enabled: bool
    manual_api_enabled: bool
    keep_shadow_spool: bool
    source_max_bytes: int
    comment_delay_seconds: int
    stale_posting_seconds: int
    pages: List[PageConfig]


def _path(value: Any, default: Path) -> Path:
    raw = os.path.expanduser(str(value or default))
    return Path(raw).resolve()


def _boolean(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _page(raw: Dict[str, Any]) -> PageConfig:
    page_id = _text(raw.get("page_id"))
    if not DIGITS.fullmatch(page_id):
        raise ConfigError("page_id_invalid")
    interval = int(raw.get("interval_minutes") or 20)
    if interval < 1 or interval > 1440:
        raise ConfigError("interval_minutes_invalid")
    daily_success_limit = int(raw.get("daily_success_limit") or 0)
    if daily_success_limit < 0 or daily_success_limit > 1440:
        raise ConfigError("daily_success_limit_invalid")
    reuse_success_from_page_id = _text(raw.get("reuse_success_from_page_id"))
    if reuse_success_from_page_id and not DIGITS.fullmatch(reuse_success_from_page_id):
        raise ConfigError("reuse_success_from_page_id_invalid")
    if reuse_success_from_page_id == page_id:
        raise ConfigError("reuse_success_from_page_id_self")
    avatar_path = _path(raw.get("avatar_path"), APP_SUPPORT / f"assets/pages/{page_id}/avatar.mp4")
    similarity = float(raw.get("chromakey_similarity", 0.30))
    blend = float(raw.get("chromakey_blend", 0.10))
    if not 0 <= similarity <= 1 or not 0 <= blend <= 1:
        raise ConfigError("chromakey_invalid")
    posting_source = _text(raw.get("posting_source")) or "facebook_lite_eaad6"
    if posting_source not in POSTING_SOURCES:
        raise ConfigError("posting_source_invalid")
    return PageConfig(
        page_id=page_id,
        name=_text(raw.get("name")) or page_id,
        enabled=_boolean(raw.get("enabled"), False),
        interval_minutes=interval,
        daily_success_limit=daily_success_limit,
        reuse_success_from_page_id=reuse_success_from_page_id,
        timezone=_text(raw.get("timezone")) or "Asia/Bangkok",
        campaign_sub1=_text(raw.get("campaign_sub1")),
        shopee_account=_text(raw.get("shopee_account")),
        affiliate_id=_text(raw.get("affiliate_id")),
        facebook_account=_text(raw.get("facebook_account")),
        power_editor_account=_text(raw.get("power_editor_account")),
        posting_source=posting_source,
        avatar_enabled=_boolean(raw.get("avatar_enabled"), True),
        avatar_path=avatar_path,
        avatar_version=_text(raw.get("avatar_version")) or "unversioned",
        caption_template=_text(raw.get("caption_template")) or "{caption}",
        comment_template=_text(raw.get("comment_template")) or "{shortlink}",
        chromakey_similarity=similarity,
        chromakey_blend=blend,
    )


def load_config(path: Optional[Path] = None) -> AppConfig:
    configured_path = path or (Path(os.environ["PUBLISHER_CONFIG"]) if os.environ.get("PUBLISHER_CONFIG") else DEFAULT_CONFIG)
    config_path = configured_path.expanduser().resolve()
    if not config_path.exists():
        raise ConfigError(f"config_missing:{config_path}")
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ConfigError("config_invalid_json") from exc
    if not isinstance(raw, dict):
        raise ConfigError("config_invalid")
    pages_raw = raw.get("pages") or []
    if not isinstance(pages_raw, list):
        raise ConfigError("pages_invalid")
    pages = [_page(item) for item in pages_raw if isinstance(item, dict)]
    if len({p.page_id for p in pages}) != len(pages):
        raise ConfigError("page_id_duplicate")
    page_ids = {p.page_id for p in pages}
    for page in pages:
        if page.reuse_success_from_page_id and page.reuse_success_from_page_id not in page_ids:
            raise ConfigError(f"reuse_success_from_page_id_not_configured:{page.page_id}")
    host = _text(raw.get("host")) or "127.0.0.1"
    if host != "127.0.0.1":
        raise ConfigError("host_must_be_loopback")
    port = int(raw.get("port") or 3110)
    if port < 1024 or port > 65535:
        raise ConfigError("port_invalid")
    # External writes require two independent gates. A config edit alone can never
    # publish to Facebook or mint a Shopee link.
    writes_enabled = (
        _boolean(raw.get("writes_enabled"), False)
        and os.environ.get("PUBLISHER_ALLOW_WRITES", "") == "I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS"
    )
    scheduler_enabled = _boolean(
        os.environ.get("PUBLISHER_SCHEDULER_ENABLED"),
        _boolean(raw.get("scheduler_enabled"), False),
    )
    if writes_enabled:
        for page in pages:
            if not page.enabled:
                continue
            required = [
                page.campaign_sub1, page.shopee_account, page.affiliate_id,
                page.facebook_account, page.power_editor_account,
            ]
            if any(not value for value in required):
                raise ConfigError(f"write_page_config_incomplete:{page.page_id}")
    return AppConfig(
        config_path=config_path,
        studio_db=_path(raw.get("studio_db"), DEFAULT_STUDIO_DB),
        ledger_db=_path(raw.get("ledger_db"), DEFAULT_LEDGER),
        spool_root=_path(raw.get("spool_root"), DEFAULT_SPOOL),
        log_root=_path(raw.get("log_root"), DEFAULT_LOGS),
        ready_channel_id=_text(raw.get("ready_channel_id")),
        discord_env_file=_path(raw.get("discord_env_file"), DEFAULT_DISCORD_ENV),
        idbridge_auth_file=_path(raw.get("idbridge_auth_file"), DEFAULT_IDBRIDGE_AUTH),
        idbridge_url=(_text(raw.get("idbridge_url")) or "http://127.0.0.1:8798").rstrip("/"),
        merge_url=(_text(raw.get("merge_url")) or "http://127.0.0.1:18080").rstrip("/"),
        host=host,
        port=port,
        writes_enabled=writes_enabled,
        scheduler_enabled=scheduler_enabled,
        manual_api_enabled=_boolean(raw.get("manual_api_enabled"), False),
        keep_shadow_spool=_boolean(raw.get("keep_shadow_spool"), True),
        source_max_bytes=max(1_000_000, int(raw.get("source_max_bytes") or 262_144_000)),
        comment_delay_seconds=max(0, int(raw.get("comment_delay_seconds") or 30)),
        stale_posting_seconds=max(300, int(raw.get("stale_posting_seconds") or 15 * 60)),
        pages=pages,
    )


def safe_config_summary(config: AppConfig) -> Dict[str, Any]:
    return {
        "host": config.host,
        "port": config.port,
        "writes_enabled": config.writes_enabled,
        "scheduler_enabled": config.scheduler_enabled,
        "studio_db_present": config.studio_db.exists(),
        "ready_channel_configured": bool(config.ready_channel_id),
        "page_count": len(config.pages),
        "enabled_page_count": sum(1 for page in config.pages if page.enabled),
        "pages": [
            {
                "page_id": page.page_id,
                "name": page.name,
                "enabled": page.enabled,
                "interval_minutes": page.interval_minutes,
                "daily_success_limit": page.daily_success_limit,
                "reuse_success_from_page_id": page.reuse_success_from_page_id,
                "posting_source": page.posting_source,
                "avatar_enabled": page.avatar_enabled,
                "avatar_present": page.avatar_path.is_file() if page.avatar_enabled else True,
                "campaign_present": bool(page.campaign_sub1),
                "facebook_account_present": bool(page.facebook_account),
                "power_editor_account_present": bool(page.power_editor_account),
            }
            for page in config.pages
        ],
    }
