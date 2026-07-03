"""Python port of the legacy Shopee conversion / daily-income report route.

Fetching is abstracted behind a ``fetch(account, api_url) -> result`` callable so
the summary/raw/daily-income logic is unit-testable with a mock and the live
runtime injects a CloakBrowser-backed fetcher. ``result`` is a dict shaped like
the legacy in-page fetch: ``{status, parsed, body, snippet}`` (and optionally
``login_gate: True`` when the session bounced to Shopee's login page).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Callable, Dict, List, Mapping, Optional
from urllib.parse import urlencode

from .report_common import (
    BANGKOK_TIMEZONE,
    ReportRequestError,
    clamp_page_num,
    first_value,
    is_shopee_login_code,
    make_page_size_clamp,
    manual_login_shape,
    normalize_shopee_affiliate_id,
    parse_report_date,
    pick_affiliate_id,
    pick_list,
    pick_number,
    pick_total_count,
    resolve_report_account,
    round_to_2,
    safe_passthrough_extras,
    sanitize_account,
    sanitize_detail,
    sanitize_extra_value,
    is_truthy_flag,
)

SHOPEE_CONVERSION_REPORT_API_BASE = (
    "https://affiliate.shopee.co.th/api/v3/report/list"
)
SHOPEE_DASHBOARD_DETAIL_API_BASE = (
    "https://affiliate.shopee.co.th/api/v3/dashboard/detail"
)
SHOPEE_CONVERSION_REPORT_HOST_PATTERN = re.compile(r"^conversionreport\.wwoom\.com$", re.IGNORECASE)
SHOPEE_CONVERSION_REPORT_PAGE_SIZE_DEFAULT = 20
SHOPEE_CONVERSION_REPORT_PAGE_SIZE_MAX = 100
SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE = 100
SHOPEE_CONVERSION_REPORT_API_VERSION = "1"
CONVERSION_REPORT_EXTRA_KEYS = [
    "sub_id",
    "order_id",
    "checkout_id",
    "conversion_id",
    "order_status",
    "conversion_status",
]
SHOPEE_DISCOVERED_SUMMARY_WARNING = (
    "sub_id discovery is based on the first sample of rows from Shopee; "
    "additional sub_ids may exist beyond the sample."
)

_clamp_page_size = make_page_size_clamp(
    SHOPEE_CONVERSION_REPORT_PAGE_SIZE_DEFAULT,
    SHOPEE_CONVERSION_REPORT_PAGE_SIZE_MAX,
)

# Public alias kept for parity with the Node module / tests.
clamp_page_num = clamp_page_num  # noqa: PLW0127


def clamp_page_size(value: object) -> int:
    return _clamp_page_size(value)


def parse_conversion_report_date(value: object, now: Optional[datetime] = None) -> Dict[str, object]:
    parsed = parse_report_date(value, now, "conversion_report_time_invalid")
    return {
        "display": parsed["display"],
        "isoDate": parsed["isoDate"],
        "timezone": parsed["timezone"],
        "purchase_time_s": parsed["start"],
        "purchase_time_e": parsed["end"],
    }


def is_raw_conversion_report_mode(query: Mapping[str, object]) -> bool:
    if not isinstance(query, Mapping):
        return False
    if is_truthy_flag(first_value(query, "raw")):
        return True
    return first_value(query, "mode").strip().lower() == "raw"


def safe_conversion_extras(query: Mapping[str, object]) -> Dict[str, str]:
    return safe_passthrough_extras(query, CONVERSION_REPORT_EXTRA_KEYS)


def resolve_conversion_report_request(
    query: Mapping[str, object], now: Optional[datetime] = None
) -> Dict[str, object]:
    meta = resolve_report_account(
        first_value(query, "id"), "shopee_affiliate_id_invalid"
    )
    account_internal = str(meta["account"])
    parsed = parse_conversion_report_date(first_value(query, "time"), now)
    page_num_source = (
        first_value(query, "page_num")
        if first_value(query, "page_num").strip()
        else first_value(query, "page")
    )
    return {
        "id": meta["id"],
        "account": sanitize_account(account_internal),
        "accountInternal": account_internal,
        "displayAccount": str(meta.get("displayAccount") or account_internal),
        "time": parsed["display"],
        "isoDate": parsed["isoDate"],
        "range": {
            "timezone": parsed["timezone"],
            "purchase_time_s": parsed["purchase_time_s"],
            "purchase_time_e": parsed["purchase_time_e"],
        },
        "page_num": clamp_page_num(page_num_source),
        "page_size": clamp_page_size(first_value(query, "page_size")),
        "extras": safe_conversion_extras(query),
    }


def build_conversion_report_fetch_url(spec: Mapping[str, object]) -> str:
    rng = spec["range"]
    params = [
        ("purchase_time_s", str(rng["purchase_time_s"])),
        ("purchase_time_e", str(rng["purchase_time_e"])),
        ("page_num", str(spec["page_num"])),
        ("page_size", str(spec["page_size"])),
        ("version", SHOPEE_CONVERSION_REPORT_API_VERSION),
    ]
    extras = spec.get("extras") if isinstance(spec.get("extras"), Mapping) else {}
    for key in CONVERSION_REPORT_EXTRA_KEYS:
        value = extras.get(key)
        if value:
            params.append((key, str(value)))
    return SHOPEE_CONVERSION_REPORT_API_BASE + "?" + urlencode(params)


def build_dashboard_detail_fetch_url(spec: Mapping[str, object]) -> str:
    rng = spec["range"]
    params = [
        ("start_time", str(rng["purchase_time_s"])),
        ("end_time", str(rng["purchase_time_e"])),
    ]
    return SHOPEE_DASHBOARD_DETAIL_API_BASE + "?" + urlencode(params)


def classify_conversion_report_failure(body: object) -> Optional[str]:
    if not isinstance(body, Mapping):
        return None
    code = body.get("code")
    if code is None and isinstance(body.get("data"), Mapping):
        code = body["data"].get("code")
    if is_shopee_login_code(code, extra_codes=(30002,)):
        return "shopee_login_required"
    return None


def classify_conversion_report_fetch_result(result: object) -> Optional[Dict[str, object]]:
    if not isinstance(result, Mapping):
        return {
            "status": "error",
            "error": "conversion_report_empty_response",
            "reason": "conversion_report_empty_response",
        }
    if result.get("login_gate"):
        return manual_login_shape()
    if result.get("status") in (401, 403):
        return {
            "status": "manual_login_required",
            "error": "manual_login_required",
            "manualLoginRequired": True,
            "needsManual": True,
            "reason": "shopee_unauthorized",
            "httpStatus": result.get("status"),
            "loginUi": "/login?platform=shopee",
        }
    if not result.get("parsed"):
        return {
            "status": "error",
            "error": "conversion_report_invalid_json",
            "reason": "conversion_report_invalid_json",
            "httpStatus": result.get("status"),
        }
    login_reason = classify_conversion_report_failure(result.get("body"))
    if login_reason:
        return {
            "status": "manual_login_required",
            "error": "manual_login_required",
            "manualLoginRequired": True,
            "needsManual": True,
            "reason": login_reason,
            "loginUi": "/login?platform=shopee",
        }
    return None


def base_response_shape(spec: Mapping[str, object]) -> Dict[str, object]:
    return {
        "report_type": "conversion_report",
        "id": spec["id"],
        "account": spec["displayAccount"],
        "accountInternal": spec["accountInternal"],
        "time": spec["time"],
        "isoDate": spec["isoDate"],
        "range": spec["range"],
        "page_num": spec["page_num"],
        "page_size": spec["page_size"],
        "source": "shopee_conversion_report_api",
    }


def summary_response_shape(spec: Mapping[str, object]) -> Dict[str, object]:
    return {
        "status": "ok",
        "report_type": "conversion_report",
        "mode": "summary",
        "id": spec["id"],
        "account": spec["displayAccount"],
        "accountInternal": spec["accountInternal"],
        "time": spec["time"],
        "isoDate": spec["isoDate"],
        "range": spec["range"],
        "source": "shopee_conversion_report_api",
    }


# --- Row value pickers (utm_content is the live Sub ID field) ----------------

def pick_row_sub_id(row: object) -> str:
    if not isinstance(row, Mapping):
        return ""
    for key in ("utm_content", "utmContent", "sub_id", "subId", "sub_ids", "subIds"):
        candidate = row.get(key)
        if candidate is None:
            continue
        text = str(candidate).strip()
        if text:
            return text
    return ""


def is_placeholder_sub_id(sub_id: object) -> bool:
    if sub_id is None:
        return True
    text = str(sub_id).strip()
    if not text:
        return True
    return bool(re.fullmatch(r"-+", text))


def pick_row_purchase_value(row: object) -> float:
    if not isinstance(row, Mapping):
        return 0.0
    for key in (
        "purchase_value",
        "purchaseValue",
        "total_payable_amount",
        "totalPayableAmount",
        "order_amount",
        "gmv",
    ):
        candidate = row.get(key)
        if candidate is not None and candidate != "":
            return pick_number(candidate)
    return 0.0


def _pick_micro_baht_commission(row: Mapping[str, object]) -> Optional[float]:
    for key in (
        "affiliate_net_commission",
        "affiliateNetCommission",
        "estimated_total_commission_with_mcn",
        "estimatedTotalCommissionWithMcn",
        "estimated_total_commission",
        "estimatedTotalCommission",
    ):
        candidate = row.get(key)
        if candidate is None or candidate == "":
            continue
        value = pick_number(candidate)
        if abs(value) >= 1000:
            return value / 100000
    return None


def pick_row_commission(row: object) -> float:
    if not isinstance(row, Mapping):
        return 0.0
    micro = _pick_micro_baht_commission(row)
    if micro is not None:
        return micro
    for key in (
        "actual_commission",
        "actualCommission",
        "commission",
        "gross_commission",
        "grossCommission",
        "commission_amount",
    ):
        candidate = row.get(key)
        if candidate is not None and candidate != "":
            return pick_number(candidate)
    return 0.0


def _summarize_row_amounts(rows: List[object]) -> Dict[str, float]:
    purchase = 0.0
    commission = 0.0
    for row in rows:
        purchase += pick_row_purchase_value(row)
        commission += pick_row_commission(row)
    return {
        "purchase_value": round_to_2(purchase),
        "commission": round_to_2(commission),
    }


def dashboard_money(value: object) -> float:
    return round_to_2(pick_number(value) / 100000)


# --- Fetch orchestration -----------------------------------------------------

Fetcher = Callable[[str, str], Mapping[str, object]]


def _run_fetch(fetch: Fetcher, account: str, api_url: str) -> Mapping[str, object]:
    """Call the injected fetcher, translating a login-gated page into a marker."""
    return fetch(account, api_url)


def handle_conversion_report_raw_mode(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    api_url = build_conversion_report_fetch_url(spec)
    try:
        result = _run_fetch(fetch, str(spec["account"]), api_url)
    except Exception as err:  # noqa: BLE001 - fail closed, sanitized
        out = base_response_shape(spec)
        out.update({
            "mode": "raw",
            "status": "error",
            "error": "conversion_report_fetch_failed",
            "reason": "conversion_report_fetch_failed",
            "detail": sanitize_detail(err),
        })
        return out
    classification = classify_conversion_report_fetch_result(result)
    if classification:
        out = base_response_shape(spec)
        out["mode"] = "raw"
        out.update(classification)
        return out
    body = result.get("body")
    out = base_response_shape(spec)
    out.update({
        "mode": "raw",
        "status": "ok",
        "total_count": pick_total_count(body),
        "list": pick_list(body, ["conversion_report_list", "conversion_list", "order_list", "report_list"]),
        "affiliate_id": pick_affiliate_id(body),
    })
    return out


def _handle_filtered_summary(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    page_size = SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE
    extras = spec.get("extras") or {}
    requested_sub_id = str(extras.get("sub_id") or "")
    api_url = build_conversion_report_fetch_url({
        "range": spec["range"],
        "page_num": 1,
        "page_size": page_size,
        "extras": extras,
    })
    try:
        result = _run_fetch(fetch, str(spec["account"]), api_url)
    except Exception as err:  # noqa: BLE001
        out = summary_response_shape(spec)
        out.update({
            "status": "error",
            "error": "conversion_report_fetch_failed",
            "reason": "conversion_report_fetch_failed",
            "detail": sanitize_detail(err),
            "pages_fetched": 0,
            "page_size": page_size,
        })
        return out
    classification = classify_conversion_report_fetch_result(result)
    if classification:
        out = summary_response_shape(spec)
        out.update(classification)
        out.update({"pages_fetched": 0, "page_size": page_size})
        return out
    body = result.get("body")
    total_count = pick_total_count(body)
    rows = pick_list(body)
    affiliate_id = pick_affiliate_id(body)
    first_sub_id = pick_row_sub_id(rows[0]) if rows else ""
    display_sub_id = first_sub_id or requested_sub_id
    sample_amounts = _summarize_row_amounts(rows)
    out = summary_response_shape(spec)
    out.update({
        "total_count": total_count,
        "unique_sub_id_count": 1 if total_count > 0 else 0,
        "sub_ids": (
            [{
                "sub_id": display_sub_id,
                "requested_sub_id": requested_sub_id,
                "count": total_count,
                "percent": 100,
                "sample_purchase_value": sample_amounts["purchase_value"],
                "sample_commission": sample_amounts["commission"],
            }]
            if total_count > 0 else []
        ),
        "pages_fetched": 1,
        "page_size": page_size,
        "row_sample_count": len(rows),
        "truncated": False,
        "breakdown_mode": "filtered",
        "sample_totals": sample_amounts,
        "affiliate_id": affiliate_id,
    })
    return out


def _sub_id_sort_key(entry: Mapping[str, object]):
    return (-int(entry["count"]), str(entry["sub_id"]))


def handle_conversion_report_summary_mode(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    extras = spec.get("extras") or {}
    if extras.get("sub_id"):
        return _handle_filtered_summary(spec, fetch)

    page_size = SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE
    unfiltered_url = build_conversion_report_fetch_url({
        "range": spec["range"],
        "page_num": 1,
        "page_size": page_size,
        "extras": extras,
    })
    try:
        result = _run_fetch(fetch, str(spec["account"]), unfiltered_url)
    except Exception as err:  # noqa: BLE001
        out = summary_response_shape(spec)
        out.update({
            "status": "error",
            "error": "conversion_report_fetch_failed",
            "reason": "conversion_report_fetch_failed",
            "detail": sanitize_detail(err),
            "pages_fetched": 0,
            "page_size": page_size,
        })
        return out
    classification = classify_conversion_report_fetch_result(result)
    if classification:
        out = summary_response_shape(spec)
        out.update(classification)
        out.update({"pages_fetched": 0, "page_size": page_size})
        return out

    body = result.get("body")
    total_count = pick_total_count(body)
    rows = pick_list(body)
    affiliate_id = pick_affiliate_id(body)
    row_sample_count = len(rows)
    sample_amounts = _summarize_row_amounts(rows)

    sample_complete = total_count <= 0 or row_sample_count >= total_count
    if sample_complete:
        by_id: Dict[str, Dict[str, float]] = {}
        for row in rows:
            sub_id = pick_row_sub_id(row)
            agg = by_id.setdefault(sub_id, {"count": 0, "purchase": 0.0, "commission": 0.0})
            agg["count"] += 1
            agg["purchase"] += pick_row_purchase_value(row)
            agg["commission"] += pick_row_commission(row)
        entries: List[Dict[str, object]] = []
        total = 0
        for sub_id, agg in by_id.items():
            total += int(agg["count"])
            entries.append({
                "sub_id": sub_id,
                "count": int(agg["count"]),
                "purchase_value": round_to_2(agg["purchase"]),
                "commission": round_to_2(agg["commission"]),
            })
        entries.sort(key=_sub_id_sort_key)
        for entry in entries:
            entry["percent"] = (
                round_to_2(entry["count"] / total * 100) if total > 0 else 0
            )
        out = summary_response_shape(spec)
        out.update({
            "total_count": total_count,
            "unique_sub_id_count": len(entries),
            "sub_ids": entries,
            "pages_fetched": 1,
            "page_size": page_size,
            "row_sample_count": row_sample_count,
            "truncated": False,
            "breakdown_mode": "complete",
            "sample_totals": sample_amounts,
            "affiliate_id": affiliate_id,
        })
        return out

    # Sample shorter than total_count: discover non-placeholder sub_ids, then ask
    # Shopee for the exact filtered total_count per sub.
    discovered = sorted({
        pick_row_sub_id(row)
        for row in rows
        if not is_placeholder_sub_id(pick_row_sub_id(row))
    })
    entries = []
    filtered_fetch_count = 0
    for sub_id in discovered:
        filtered_url = build_conversion_report_fetch_url({
            "range": spec["range"],
            "page_num": 1,
            "page_size": page_size,
            "extras": dict(extras, sub_id=sub_id),
        })
        try:
            sub_result = _run_fetch(fetch, str(spec["account"]), filtered_url)
        except Exception as err:  # noqa: BLE001
            out = summary_response_shape(spec)
            out.update({
                "status": "error",
                "error": "conversion_report_sub_count_failed",
                "reason": "conversion_report_sub_count_failed",
                "failed_sub_id": sanitize_extra_value(sub_id),
                "detail": sanitize_detail(err),
                "pages_fetched": 1 + filtered_fetch_count,
                "page_size": page_size,
            })
            return out
        filtered_fetch_count += 1
        sub_classification = classify_conversion_report_fetch_result(sub_result)
        if sub_classification:
            out = summary_response_shape(spec)
            out.update({
                "status": "error",
                "error": "conversion_report_sub_count_failed",
                "reason": "conversion_report_sub_count_failed",
                "failed_sub_id": sanitize_extra_value(sub_id),
                "underlying": sub_classification.get("reason") or sub_classification.get("error"),
                "pages_fetched": 1 + filtered_fetch_count,
                "page_size": page_size,
            })
            return out
        sub_total = pick_total_count(sub_result.get("body"))
        sub_rows = pick_list(sub_result.get("body"))
        sub_amounts = _summarize_row_amounts(sub_rows)
        entries.append({
            "sub_id": sub_id,
            "count": sub_total,
            "sample_purchase_value": sub_amounts["purchase_value"],
            "sample_commission": sub_amounts["commission"],
        })

    entries.sort(key=_sub_id_sort_key)
    for entry in entries:
        entry["percent"] = (
            round_to_2(entry["count"] / total_count * 100) if total_count > 0 else 0
        )
    out = summary_response_shape(spec)
    out.update({
        "total_count": total_count,
        "unique_sub_id_count": len(entries),
        "discovered_sub_id_count": len(discovered),
        "sub_ids": entries,
        "pages_fetched": 1 + filtered_fetch_count,
        "page_size": page_size,
        "row_sample_count": row_sample_count,
        "truncated": True,
        "breakdown_mode": "discovered_filtered",
        "sample_totals": sample_amounts,
        "warning": SHOPEE_DISCOVERED_SUMMARY_WARNING,
        "affiliate_id": affiliate_id,
    })
    return out


def handle_conversion_report(
    query: Mapping[str, object],
    *,
    fetch: Fetcher,
    now: Optional[datetime] = None,
) -> Dict[str, object]:
    raw_mode = is_raw_conversion_report_mode(query)
    working = dict(query)
    if not raw_mode:
        working["page_size"] = str(SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE)
        working["page_num"] = "1"
    spec = resolve_conversion_report_request(working, now)
    if raw_mode:
        return handle_conversion_report_raw_mode(spec, fetch)
    return handle_conversion_report_summary_mode(spec, fetch)


# --- Daily income (dashboard/detail) -----------------------------------------

def parse_daily_income_ids(query: Mapping[str, object], now: Optional[datetime] = None) -> List[str]:
    ids_raw = first_value(query, "ids").strip()
    id_raw = first_value(query, "id").strip()
    raw = ids_raw or id_raw or "15130770000,15142270000"
    ids: List[str] = []
    seen = set()
    time_value = first_value(query, "time")
    for part in raw.split(","):
        candidate = normalize_shopee_affiliate_id(part)
        if not candidate or candidate in seen:
            continue
        # Reuse the resolver so unknown ids fail with the same public error.
        resolve_conversion_report_request({"id": candidate, "time": time_value}, now)
        seen.add(candidate)
        ids.append(candidate)
    if not ids:
        raise ReportRequestError(
            "shopee_affiliate_id_invalid",
            "Invalid Shopee affiliate id list",
            extra={"requestedId": str(raw)[:64]},
        )
    return ids


def handle_dashboard_income_for_spec(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    api_url = build_dashboard_detail_fetch_url(spec)
    try:
        result = _run_fetch(fetch, str(spec["account"]), api_url)
    except Exception as err:  # noqa: BLE001
        out = base_response_shape(spec)
        out.update({
            "status": "error",
            "error": "dashboard_detail_fetch_failed",
            "reason": "dashboard_detail_fetch_failed",
            "detail": sanitize_detail(err),
        })
        return out
    classification = classify_conversion_report_fetch_result(result)
    if classification:
        out = base_response_shape(spec)
        out.update(classification)
        return out
    body = result.get("body") or {}
    data = body.get("data") if isinstance(body.get("data"), Mapping) else {}
    out = base_response_shape(spec)
    out.update({
        "status": "ok",
        "report_type": "daily_income_account",
        "mode": "dashboard_detail",
        "amount_unit": "THB",
        "orders": int(pick_number(data.get("cv_by_order_sum"))),
        "row_count": None,
        "item_sold": int(pick_number(data.get("item_sold_sum"))),
        "clicks": int(pick_number(data.get("clicks_sum"))),
        "purchase_value": dashboard_money(data.get("order_amount_sum")),
        "commission": dashboard_money(data.get("est_commission_sum")),
        "est_income": dashboard_money(data.get("est_income_sum")),
        "source_endpoint": "/api/v3/dashboard/detail",
        "last_update_time": data.get("last_update_time") or body.get("last_update_time"),
    })
    return out


def handle_daily_income_report(
    query: Mapping[str, object],
    *,
    fetch: Fetcher,
    now: Optional[datetime] = None,
) -> Dict[str, object]:
    ids = parse_daily_income_ids(query, now)
    accounts: List[Dict[str, object]] = []
    first_spec: Optional[Dict[str, object]] = None
    for id_value in ids:
        spec = resolve_conversion_report_request(
            dict(query, id=id_value, page_size=str(SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE), page_num="1"),
            now,
        )
        if first_spec is None:
            first_spec = spec
        accounts.append(handle_dashboard_income_for_spec(spec, fetch))

    ok_accounts = [a for a in accounts if a.get("status") == "ok"]
    totals = {"orders": 0, "row_count": 0, "purchase_value": 0.0, "commission": 0.0}
    for account in ok_accounts:
        totals["orders"] += int(pick_number(account.get("orders") or account.get("total_count") or 0))
        totals["row_count"] += int(pick_number(account.get("row_count") or 0))
        totals["purchase_value"] += pick_number(account.get("purchase_value") or 0)
        totals["commission"] += pick_number(account.get("commission") or 0)
    totals["purchase_value"] = round_to_2(totals["purchase_value"])
    totals["commission"] = round_to_2(totals["commission"])
    failed = [a for a in accounts if a.get("status") != "ok"]
    return {
        "status": "error" if failed else "ok",
        "report_type": "daily_income_report",
        "mode": "daily_income",
        "time": first_spec["time"] if first_spec else "",
        "isoDate": first_spec["isoDate"] if first_spec else "",
        "range": first_spec["range"] if first_spec else None,
        "timezone": BANGKOK_TIMEZONE,
        "source": "shopee_conversion_report_api",
        "account_count": len(accounts),
        "ok_account_count": len(ok_accounts),
        "failed_account_count": len(failed),
        "totals": totals,
        "amount_unit": "THB",
        "accounts": accounts,
    }


def is_conversion_report_host(host_header: object) -> bool:
    if not host_header:
        return False
    host = str(host_header).split(",")[0].split(":")[0].strip().lower()
    return bool(host) and bool(SHOPEE_CONVERSION_REPORT_HOST_PATTERN.match(host))
