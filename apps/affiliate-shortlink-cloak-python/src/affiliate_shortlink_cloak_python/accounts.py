"""Shopee account alias mapping and validation."""

from __future__ import annotations

import os
import re
from typing import Dict, List, Optional

KNOWN_ACCOUNTS: Dict[str, Dict[str, str]] = {
    "15130770000": {
        "id": "15130770000",
        "account": "affiliate_chearb.com",
        "utm_source": "an_15130770000",
        "display": "affiliate@chearb.com",
    },
    "15142270000": {
        "id": "15142270000",
        "account": "affiliate_neezs.com",
        "utm_source": "an_15142270000",
        "display": "affiliate@neezs.com",
    },
}

_ACCOUNT_INDEX: Dict[str, Dict[str, str]] = {}
for _record in KNOWN_ACCOUNTS.values():
    _ACCOUNT_INDEX[_record["account"]] = _record
    _ACCOUNT_INDEX[_record["display"]] = _record
    _ACCOUNT_INDEX[_record["utm_source"]] = _record


def list_accounts() -> List[Dict[str, str]]:
    """Return safe copies of all known account records."""
    return [dict(rec) for rec in KNOWN_ACCOUNTS.values()]


def normalize_shopee_id(value: Optional[str]) -> str:
    """Normalize `151...` or `an_151...` to the numeric Shopee id."""
    if value is None:
        return ""
    text = str(value).strip()
    if text.lower().startswith("an_"):
        text = text[3:]
    return text if re.fullmatch(r"\d+", text) else ""


def resolve_by_shopee_id(shopee_id: str) -> Optional[Dict[str, str]]:
    """Resolve a record by numeric Shopee id or `an_<id>` alias."""
    rec = KNOWN_ACCOUNTS.get(normalize_shopee_id(shopee_id))
    return dict(rec) if rec else None


def resolve_by_account(account: str) -> Optional[Dict[str, str]]:
    """Resolve a record by internal account, display account, or utm alias."""
    if account is None:
        return None
    rec = _ACCOUNT_INDEX.get(str(account).strip())
    return dict(rec) if rec else None


def resolve_account(shopee_id: Optional[str] = None,
                    account: Optional[str] = None) -> Dict[str, object]:
    """Resolve and validate a request against known aliases."""
    by_id = resolve_by_shopee_id(shopee_id) if shopee_id else None
    by_acct = resolve_by_account(account) if account else None

    if shopee_id and not by_id:
        return {"ok": False, "record": None, "conflict": False,
                "error": "unknown_shopee_id"}
    if account and not by_acct:
        return {"ok": False, "record": None, "conflict": False,
                "error": "unknown_account"}

    if by_id and by_acct:
        if by_id["account"] != by_acct["account"]:
            return {"ok": False, "record": None, "conflict": True,
                    "error": "id_account_conflict"}
        return {"ok": True, "record": by_id, "conflict": False, "error": None}

    if by_id:
        return {"ok": True, "record": by_id, "conflict": False, "error": None}
    if by_acct:
        return {"ok": True, "record": by_acct, "conflict": False, "error": None}

    return {"ok": False, "record": None, "conflict": False,
            "error": "missing_identifier"}


def profile_dir_for(profile_root: str, platform: str, account: str) -> str:
    """Compute the per-account persistent-context profile directory."""
    safe_platform = _safe_segment(platform) or "unknown"
    safe_account = _safe_segment(account) or "unknown"
    return os.path.join(profile_root, safe_platform, safe_account)


def _safe_segment(value: Optional[str]) -> str:
    """Sanitize a single path segment."""
    if not value:
        return ""
    cleaned = str(value).strip().replace("\\", "_").replace("/", "_")
    cleaned = cleaned.replace("..", "_")
    return re.sub(r"_+", "_", cleaned)
