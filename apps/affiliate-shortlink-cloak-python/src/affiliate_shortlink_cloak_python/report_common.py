"""Shared, offline-safe helpers for the Shopee report ports.

Mirrors the pure logic in the legacy Node ``conversion-report.js`` and
``click-report.js`` (date parsing, id/account resolution, page clamping, extra
passthrough, Shopee login classification). No browser or network access here so
the whole module is unit-testable without a live Shopee session.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Mapping, Optional, Tuple

from .accounts import KNOWN_ACCOUNTS
from .shopee import sanitize_error_message

BANGKOK_TIMEZONE = "Asia/Bangkok"
BANGKOK_UTC_OFFSET_SECONDS = 7 * 3600
_BANGKOK_TZ = timezone(timedelta(seconds=BANGKOK_UTC_OFFSET_SECONDS))

DEFAULT_SHOPEE_ID = "15130770000"
_ACCOUNT_MAX_LEN = 64
_ACCOUNT_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")

# Shopee account metadata keyed by numeric affiliate id. ``account`` is the
# internal profile account; ``displayAccount`` is the human-facing login.
_ID_TO_META: Dict[str, Dict[str, str]] = {
    rec["id"]: {
        "id": rec["id"],
        "account": rec["account"],
        "displayAccount": rec["display"],
    }
    for rec in KNOWN_ACCOUNTS.values()
}


class ReportRequestError(Exception):
    """Validation failure that maps to a safe HTTP response.

    ``public_payload`` is already sanitized (no secrets) and suitable to return
    verbatim to a client; ``status_code`` is the HTTP status to use.
    """

    def __init__(
        self,
        reason: str,
        message: str,
        status_code: int = 400,
        extra: Optional[Mapping[str, object]] = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.status_code = status_code
        payload: Dict[str, object] = {
            "status": "error",
            "error": reason,
            "reason": reason,
            "message": message,
        }
        if extra:
            payload.update(extra)
        self.public_payload = payload


def sanitize_account(raw: object) -> str:
    text = str(raw or "").strip()
    if not text:
        return "default"
    cleaned = _ACCOUNT_SAFE_RE.sub("_", text)[:_ACCOUNT_MAX_LEN]
    return cleaned or "default"


def normalize_shopee_affiliate_id(value: object) -> str:
    """Return the numeric (>= 6 digit) affiliate id, or "" if unparseable.

    Mirrors Node ``normalizeShopeeAffiliateId``: strips an ``an_`` prefix and
    requires at least six digits so short garbage fails as *invalid* while a
    well-formed-but-unregistered id fails as *unknown*.
    """
    raw = re.sub(r"^an_", "", str(value or "").strip(), flags=re.IGNORECASE)
    if not raw:
        return ""
    return raw if re.fullmatch(r"\d{6,}", raw) else ""


def resolve_report_account(raw_id: object, reason_prefix: str) -> Dict[str, str]:
    """Resolve a request id to account metadata or raise ``ReportRequestError``."""
    raw = str(raw_id or "").strip()
    candidate = raw or DEFAULT_SHOPEE_ID
    normalized = normalize_shopee_affiliate_id(candidate)
    if not normalized:
        raise ReportRequestError(
            "shopee_affiliate_id_invalid",
            "Invalid Shopee affiliate id",
            extra={"requestedId": str(candidate)[:64]},
        )
    meta = _ID_TO_META.get(normalized)
    if not meta:
        raise ReportRequestError(
            "shopee_affiliate_id_unknown",
            "Unknown Shopee affiliate id: " + normalized,
            extra={"requestedId": normalized[:64]},
        )
    return meta


def _pad2(n: int) -> str:
    return str(n).zfill(2)


def _current_bangkok_date(now: datetime) -> Tuple[int, int, int]:
    shifted = _as_utc(now).astimezone(_BANGKOK_TZ)
    return shifted.year, shifted.month, shifted.day


def _as_utc(now: Optional[datetime]) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now


def date_to_unix_seconds_bangkok(
    year: int, month: int, day: int, hour: int, minute: int, second: int
) -> int:
    dt = datetime(year, month, day, hour, minute, second, tzinfo=_BANGKOK_TZ)
    return int(dt.timestamp())


def _is_valid_ymd(y: int, m: int, d: int) -> bool:
    if y < 1970 or y > 9999 or m < 1 or m > 12 or d < 1 or d > 31:
        return False
    try:
        datetime(y, m, d)
    except ValueError:
        return False
    return True


def parse_report_date(
    value: object,
    now: Optional[datetime],
    reason: str,
) -> Dict[str, object]:
    """Parse a report ``time`` param into a Bangkok day window.

    Accepts ``today``/``yesterday``/``DD/MM/YYYY``/``YYYY-MM-DD`` and returns a
    dict with the display/isoDate strings plus ``start``/``end`` unix seconds
    (Bangkok 00:00:00 .. 23:59:59). Raises ``ReportRequestError(reason)`` on
    anything else.
    """
    now = _as_utc(now)
    raw = str(value or "").strip()
    lowered = raw.lower()
    if not raw or lowered == "today":
        y, m, d = _current_bangkok_date(now)
    elif lowered == "yesterday":
        y, m, d = _current_bangkok_date(now - timedelta(days=1))
    else:
        ddmm = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
        iso = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw)
        if ddmm:
            d, m, y = int(ddmm.group(1)), int(ddmm.group(2)), int(ddmm.group(3))
        elif iso:
            y, m, d = int(iso.group(1)), int(iso.group(2)), int(iso.group(3))
        else:
            raise _date_error(reason, raw)
        if not _is_valid_ymd(y, m, d):
            raise _date_error(reason, raw)
    return {
        "year": y,
        "month": m,
        "day": d,
        "display": _pad2(d) + "/" + _pad2(m) + "/" + str(y),
        "isoDate": str(y) + "-" + _pad2(m) + "-" + _pad2(d),
        "timezone": BANGKOK_TIMEZONE,
        "start": date_to_unix_seconds_bangkok(y, m, d, 0, 0, 0),
        "end": date_to_unix_seconds_bangkok(y, m, d, 23, 59, 59),
    }


def _date_error(reason: str, raw: object) -> ReportRequestError:
    safe = str(raw or "")[:64]
    return ReportRequestError(
        reason,
        "Invalid time parameter. Accepted formats: DD/MM/YYYY, YYYY-MM-DD, "
        "today, yesterday.",
        extra={"requestedTime": safe},
    )


def parse_integer(value: object, fallback: int) -> int:
    text = str(value if value is not None else "").strip()
    if not text:
        return fallback
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return fallback


def clamp_page_num(value: object) -> int:
    n = parse_integer(value, 1)
    return 1 if n < 1 else n


def make_page_size_clamp(default: int, maximum: int) -> Callable[[object], int]:
    def clamp(value: object) -> int:
        n = parse_integer(value, default)
        if n < 1:
            return default
        if n > maximum:
            return maximum
        return n

    return clamp


def sanitize_extra_value(value: object) -> str:
    return str(value if value is not None else "").strip()[:200]


def safe_passthrough_extras(
    query: Mapping[str, object], keys: List[str]
) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not isinstance(query, Mapping):
        return out
    for key in keys:
        val = sanitize_extra_value(first_value(query, key))
        if val:
            out[key] = val
    return out


def is_truthy_flag(value: object) -> bool:
    if value is True:
        return True
    text = str(value if value is not None else "").strip().lower()
    return text in {"1", "true", "yes", "on"}


def first_value(query: Mapping[str, object], key: str, default: str = "") -> str:
    """Read one string from a stdlib ``parse_qs`` dict (values are lists)."""
    value = query.get(key) if isinstance(query, Mapping) else None
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        value = value[0] if value else default
    return str(value)


def sanitize_detail(text: object) -> str:
    collapsed = re.sub(r"[\r\n]+", " ", str(text if text is not None else ""))
    return sanitize_error_message(collapsed, limit=300)


def pick_number(value: object) -> float:
    if value is None or value == "":
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if n == n and n not in (float("inf"), float("-inf")) else 0.0


def round_to_2(value: float) -> float:
    if value != value or value in (float("inf"), float("-inf")):
        return 0
    rounded = round(float(value) + 0.0, 2)
    # Collapse -0.0 and integral floats to ints to mirror JSON.stringify output.
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def pick_total_count(body: object) -> int:
    if not isinstance(body, Mapping):
        return 0
    data = body.get("data") if isinstance(body.get("data"), Mapping) else None
    candidates = [
        data.get("total_count") if data else None,
        data.get("total") if data else None,
        body.get("total_count"),
    ]
    for candidate in candidates:
        n = _finite_number(candidate)
        if n is not None:
            return int(n)
    return 0


def pick_list(body: object, extra_keys: Optional[List[str]] = None) -> List[object]:
    if not isinstance(body, Mapping):
        return []
    data = body.get("data") if isinstance(body.get("data"), Mapping) else {}
    keys = ["list"] + list(extra_keys or [])
    for key in keys:
        val = data.get(key)
        if isinstance(val, list):
            return val
    if isinstance(body.get("list"), list):
        return body["list"]
    return []


def pick_affiliate_id(body: object) -> Optional[str]:
    if not isinstance(body, Mapping):
        return None
    data = body.get("data") if isinstance(body.get("data"), Mapping) else {}
    for candidate in (
        data.get("affiliate_id"),
        data.get("affiliateId"),
        body.get("affiliate_id"),
    ):
        if candidate is not None:
            return str(candidate)
    return None


def is_shopee_login_code(code: object, extra_codes: Tuple[int, ...] = ()) -> bool:
    if code is None:
        return False
    try:
        n = int(str(code))
    except (TypeError, ValueError):
        return False
    return n in (30001,) + tuple(extra_codes)


def is_login_redirect_url(current_url: object) -> bool:
    value = str(current_url or "")
    if not value:
        return False
    return bool(
        re.search(
            r"shopee\.co\.th/buyer/login|affiliate\.shopee\.co\.th/login",
            value,
            re.IGNORECASE,
        )
    )


def manual_login_shape() -> Dict[str, object]:
    return {
        "status": "manual_login_required",
        "error": "manual_login_required",
        "manualLoginRequired": True,
        "needsManual": True,
        "reason": "shopee_login_required",
        "loginUi": "/login?platform=shopee",
    }


def _finite_number(value: object) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):
        return None
    return n


def host_matches(host_header: object, pattern: "re.Pattern[str]") -> bool:
    if not host_header:
        return False
    host = str(host_header).split(",")[0].split(":")[0].strip().lower()
    if not host:
        return False
    return bool(pattern.match(host))
