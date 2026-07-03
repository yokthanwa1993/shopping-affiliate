"""Shopee account alias mapping and validation.

Pure data + helpers — never touches the browser, network, secrets, or cookies.
"""

from __future__ import annotations

from typing import Dict, List, Optional

# Known Shopee affiliate aliases. Keyed by the numeric Shopee `id` seen in the
# legacy shortlink query string. No secrets/cookies live here.
KNOWN_ACCOUNTS: Dict[str, Dict[str, str]] = {
    "15130770000": {
        "shopee_id": "15130770000",
        "account": "affiliate_chearb.com",
        "utm_source": "an_15130770000",
        "display": "affiliate@chearb.com",
    },
    "15142270000": {
        "shopee_id": "15142270000",
        "account": "affiliate_neezs.com",
        "utm_source": "an_15142270000",
        "display": "affiliate@neezs.com",
    },
}

# Reverse index: account name -> record.
_ACCOUNT_INDEX: Dict[str, Dict[str, str]] = {
    rec["account"]: rec for rec in KNOWN_ACCOUNTS.values()
}


def list_accounts() -> List[Dict[str, str]]:
    """Return a copy of all known account records (safe, no secrets)."""
    return [dict(rec) for rec in KNOWN_ACCOUNTS.values()]


def resolve_by_shopee_id(shopee_id: str) -> Optional[Dict[str, str]]:
    """Resolve a record by the numeric Shopee id, or None."""
    if shopee_id is None:
        return None
    rec = KNOWN_ACCOUNTS.get(str(shopee_id).strip())
    return dict(rec) if rec else None


def resolve_by_account(account: str) -> Optional[Dict[str, str]]:
    """Resolve a record by account name (e.g. affiliate_chearb.com), or None."""
    if account is None:
        return None
    rec = _ACCOUNT_INDEX.get(str(account).strip())
    return dict(rec) if rec else None


def resolve_account(shopee_id: Optional[str] = None,
                    account: Optional[str] = None) -> Dict[str, object]:
    """Resolve/validate a request against known aliases.

    Returns a dict with:
      - ok: bool
      - record: the resolved record (or None)
      - error: a safe machine-readable reason (or None)
      - conflict: True when id and account each resolve but disagree

    Accepts either identifier; if both are given they must agree.
    """
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
    """Compute the per-account persistent-context profile directory.

    Layout: <profile_root>/<platform>/<account>. Import kept local so this
    module has no top-level os dependency surprises for callers.
    """
    import os

    safe_platform = _safe_segment(platform) or "unknown"
    safe_account = _safe_segment(account) or "unknown"
    return os.path.join(profile_root, safe_platform, safe_account)


def _safe_segment(value: Optional[str]) -> str:
    """Sanitize a single path segment (no separators / traversal)."""
    if not value:
        return ""
    cleaned = str(value).strip().replace("\\", "_").replace("/", "_")
    cleaned = cleaned.replace("..", "_")
    return cleaned
