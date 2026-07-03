"""Pure Shopee shortlink helpers for the Python sidecar."""

from __future__ import annotations

import json
import re
from typing import Dict, List, Mapping, Optional

SHOPEE_ORIGIN = "https://affiliate.shopee.co.th"
SHOPEE_GQL_ENDPOINT = (
    "https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink"
)
SHOPEE_BATCH_CUSTOM_LINK_QUERY = (
    "query batchGetCustomLink($linkParams: [CustomLinkParam!], "
    "$sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, "
    "sourceCaller: $sourceCaller){ shortLink longLink failCode } }"
)

_SESSION_HTML_RE = re.compile(
    r"login|sign[- ]?in|csrf|captcha|otp|verify", re.IGNORECASE
)
_SAFE_SUB_ID_RE = re.compile(r"[^A-Za-z0-9]")


class ShopeeShortenError(RuntimeError):
    """Safe, classified Shopee shortening failure."""

    def __init__(
        self,
        reason: str,
        message: Optional[str] = None,
        current_url: Optional[str] = None,
        manual_login_required: bool = False,
    ) -> None:
        self.reason = sanitize_error_message(reason)
        self.current_url = current_url
        self.manual_login_required = manual_login_required
        super().__init__(sanitize_error_message(message or self.reason))


def sanitize_shopee_sub_id(value: object) -> str:
    """Keep Shopee sub ids alphanumeric and at most 64 characters."""
    return _SAFE_SUB_ID_RE.sub("", str(value or ""))[:64]


def sanitize_shopee_sub_ids(values: object) -> List[str]:
    if not isinstance(values, (list, tuple)):
        values = []
    return [sanitize_shopee_sub_id(values[i] if i < len(values) else "")
            for i in range(5)]


def sub_ids_from_query(query: Mapping[str, object]) -> List[str]:
    raw = [_first_query_value(query, "sub%s" % i) for i in range(1, 6)]
    return sanitize_shopee_sub_ids(raw)


def build_shortlink_body(original_link: str, sub_ids: object) -> Dict[str, object]:
    sanitized = sanitize_shopee_sub_ids(sub_ids)
    link_param: Dict[str, object] = {"originalLink": original_link}
    if any(sanitized):
        link_param["advancedLinkParams"] = {
            "subId1": sanitized[0],
            "subId2": sanitized[1],
            "subId3": sanitized[2],
            "subId4": sanitized[3],
            "subId5": sanitized[4],
        }

    return {
        "operationName": "batchGetCustomLink",
        "variables": {
            "linkParams": [link_param],
            "sourceCaller": "CUSTOM_LINK_CALLER",
        },
        "query": SHOPEE_BATCH_CUSTOM_LINK_QUERY,
    }


def parse_shortlink_response(
    status: int,
    text: object,
    original_link: str,
) -> Dict[str, str]:
    if status in {401, 403}:
        raise ShopeeShortenError(
            "shopee_session_http_%s" % status,
            "HTTP %s UNAUTHORIZED (likely SESSION_EXPIRED)" % status,
            manual_login_required=True,
        )

    body_text = str(text or "")
    try:
        envelope = json.loads(body_text)
    except (TypeError, ValueError):
        snippet = _safe_snippet(body_text)
        if _SESSION_HTML_RE.search(snippet):
            raise ShopeeShortenError(
                "shopee_session_html",
                "SESSION_EXPIRED (login/session page returned)",
                manual_login_required=True,
            )
        raise ShopeeShortenError(
            "shopee_api_invalid_json",
            "Invalid JSON: %s" % snippet,
        )

    results = _batch_custom_link_results(envelope)
    if not results:
        raise ShopeeShortenError(
            "shopee_api_no_results",
            "No results: %s" % _safe_snippet(json.dumps(envelope)),
        )

    result = results[0] if isinstance(results[0], Mapping) else {}
    fail_code = result.get("failCode")
    if _has_nonzero_fail_code(fail_code):
        raise ShopeeShortenError(
            "shopee_api_fail_code_%s" % sanitize_error_message(fail_code),
            "failCode: %s envelope: %s" % (
                sanitize_error_message(fail_code),
                _safe_snippet(json.dumps({
                    "result": dict(result),
                    "errors": envelope.get("errors") if isinstance(
                        envelope, Mapping
                    ) else None,
                })),
            ),
        )

    short_link = str(result.get("shortLink") or "").strip()
    if not short_link:
        raise ShopeeShortenError(
            "shopee_api_missing_shortlink",
            "No shortLink from Shopee",
        )

    return {
        "shortLink": short_link,
        "longLink": str(result.get("longLink") or ""),
        "originalLink": original_link,
    }


def sanitize_error_message(value: object, limit: int = 600) -> str:
    text = str(value or "")
    if not text:
        return ""

    text = re.sub(
        r"(?im)^(\s*-?\s*cookie\s*[:=]\s*)[^\r\n]*",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)(csrf-token\s*[:=]\s*)[^\s;,'\"]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)(csrftoken=)[^;\s,'\"]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)((?:SPC|REC|_ga|_gcl|_fbp|language|ds)"
        r"[^=;\s]*=)[^;\s,'\"]+",
        r"\1[REDACTED]",
        text,
    )
    if len(text) > limit:
        return text[:limit - 1].rstrip() + "..."
    return text


def _first_query_value(
    query: Mapping[str, object],
    key: str,
    default: str = "",
) -> str:
    value = query.get(key)
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        value = value[0] if value else default
    text = str(value).strip()
    return text if text else default


def _batch_custom_link_results(envelope: object) -> object:
    if not isinstance(envelope, Mapping):
        return None
    data = envelope.get("data")
    if not isinstance(data, Mapping):
        return None
    return data.get("batchCustomLink")


def _has_nonzero_fail_code(value: object) -> bool:
    if value in (None, "", 0, "0"):
        return False
    try:
        return int(str(value)) != 0
    except (TypeError, ValueError):
        return True


def _safe_snippet(value: object, limit: int = 200) -> str:
    return sanitize_error_message(value, limit=limit)
