"""Python port of the legacy Shopee click-report route.

Same injected ``fetch(account, api_url) -> result`` contract as
``conversion_report``. Supports single-page raw mode, complete-raw enumeration
(time-window bisection under Shopee's page cap), and summary mode (complete
breakdown by sub_id / sub1 / sub2 / sub3, or a filtered single-sub summary).
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Callable, Dict, List, Mapping, Optional
from urllib.parse import urlencode

from .report_common import (
    clamp_page_num,
    first_value,
    is_shopee_login_code,
    make_page_size_clamp,
    manual_login_shape,
    parse_report_date,
    pick_affiliate_id,
    pick_list,
    pick_total_count,
    resolve_report_account,
    round_to_2,
    safe_passthrough_extras,
    sanitize_account,
    sanitize_detail,
    is_truthy_flag,
)

SHOPEE_CLICK_REPORT_API_BASE = (
    "https://affiliate.shopee.co.th/api/v1/click_report/list"
)
SHOPEE_CLICK_REPORT_HOST_PATTERN = re.compile(r"^clickreport\.wwoom\.com$", re.IGNORECASE)
SHOPEE_CLICK_REPORT_PAGE_SIZE_DEFAULT = 20
SHOPEE_CLICK_REPORT_PAGE_SIZE_MAX = 100
SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE = 100
SHOPEE_CLICK_REPORT_PAGE_CAP_ROWS = 10000
SHOPEE_CLICK_REPORT_COMPLETE_PAGE_SIZE = 100
CLICK_REPORT_EXTRA_KEYS = ["sub_id", "click_id", "click_region"]

_clamp_page_size = make_page_size_clamp(
    SHOPEE_CLICK_REPORT_PAGE_SIZE_DEFAULT,
    SHOPEE_CLICK_REPORT_PAGE_SIZE_MAX,
)

clamp_page_num = clamp_page_num  # noqa: PLW0127


def clamp_page_size(value: object) -> int:
    return _clamp_page_size(value)


def parse_click_report_date(value: object, now: Optional[datetime] = None) -> Dict[str, object]:
    parsed = parse_report_date(value, now, "click_report_time_invalid")
    return {
        "display": parsed["display"],
        "isoDate": parsed["isoDate"],
        "timezone": parsed["timezone"],
        "click_time_s": parsed["start"],
        "click_time_e": parsed["end"],
    }


def is_raw_click_report_mode(query: Mapping[str, object]) -> bool:
    if not isinstance(query, Mapping):
        return False
    raw = first_value(query, "raw").strip().lower()
    if raw == "complete":
        return True
    if is_truthy_flag(raw):
        return True
    mode = first_value(query, "mode").strip().lower()
    return mode in {"raw", "raw_complete", "complete_raw"}


def is_complete_click_report_mode(query: Mapping[str, object]) -> bool:
    if not isinstance(query, Mapping):
        return False
    if is_truthy_flag(first_value(query, "complete")):
        return True
    return first_value(query, "mode").strip().lower() == "complete"


def is_complete_raw_click_report_mode(query: Mapping[str, object]) -> bool:
    if not isinstance(query, Mapping):
        return False
    raw = first_value(query, "raw").strip().lower()
    mode = first_value(query, "mode").strip().lower()
    return (
        raw == "complete"
        or mode in {"raw_complete", "complete_raw"}
        or (is_truthy_flag(raw) and is_truthy_flag(first_value(query, "complete")))
    )


def safe_click_extras(query: Mapping[str, object]) -> Dict[str, str]:
    return safe_passthrough_extras(query, CLICK_REPORT_EXTRA_KEYS)


def resolve_click_report_request(
    query: Mapping[str, object], now: Optional[datetime] = None
) -> Dict[str, object]:
    meta = resolve_report_account(first_value(query, "id"), "shopee_affiliate_id_invalid")
    account_internal = str(meta["account"])
    parsed = parse_click_report_date(first_value(query, "time"), now)
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
            "click_time_s": parsed["click_time_s"],
            "click_time_e": parsed["click_time_e"],
        },
        "page_num": clamp_page_num(page_num_source),
        "page_size": clamp_page_size(first_value(query, "page_size")),
        "extras": safe_click_extras(query),
    }


def build_click_report_fetch_url(spec: Mapping[str, object]) -> str:
    rng = spec["range"]
    params = [
        ("click_time_s", str(rng["click_time_s"])),
        ("click_time_e", str(rng["click_time_e"])),
        ("page_num", str(spec["page_num"])),
        ("page_size", str(spec["page_size"])),
    ]
    extras = spec.get("extras") if isinstance(spec.get("extras"), Mapping) else {}
    for key in CLICK_REPORT_EXTRA_KEYS:
        value = extras.get(key)
        if value:
            params.append((key, str(value)))
    return SHOPEE_CLICK_REPORT_API_BASE + "?" + urlencode(params)


def classify_click_report_failure(body: object) -> Optional[str]:
    if not isinstance(body, Mapping):
        return None
    code = body.get("code")
    if code is None and isinstance(body.get("data"), Mapping):
        code = body["data"].get("code")
    if is_shopee_login_code(code):
        return "shopee_login_required"
    return None


def classify_click_report_fetch_result(result: object) -> Optional[Dict[str, object]]:
    if not isinstance(result, Mapping):
        return {
            "status": "error",
            "error": "click_report_empty_response",
            "reason": "click_report_empty_response",
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
            "error": "click_report_invalid_json",
            "reason": "click_report_invalid_json",
            "httpStatus": result.get("status"),
        }
    login_reason = classify_click_report_failure(result.get("body"))
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
        "id": spec["id"],
        "account": spec["displayAccount"],
        "accountInternal": spec["accountInternal"],
        "time": spec["time"],
        "range": spec["range"],
        "page_num": spec["page_num"],
        "page_size": spec["page_size"],
        "source": "shopee_click_report_api",
    }


def summary_response_shape(spec: Mapping[str, object]) -> Dict[str, object]:
    return {
        "status": "ok",
        "mode": "summary",
        "id": spec["id"],
        "account": spec["displayAccount"],
        "accountInternal": spec["accountInternal"],
        "time": spec["time"],
        "range": spec["range"],
        "source": "shopee_click_report_api",
    }


# --- Breakdown helpers -------------------------------------------------------

def _parse_sub_parts(sub_id: object) -> Dict[str, str]:
    parts = str(sub_id if sub_id is not None else "").split("-")
    return {
        "sub1": parts[0] if len(parts) > 0 else "",
        "sub2": parts[1] if len(parts) > 1 else "",
        "sub3": parts[2] if len(parts) > 2 else "",
    }


def _summarize_named_counts(counts: Dict[str, int], value_field: str, percent_total: object) -> List[Dict[str, object]]:
    entries = []
    total = 0
    for value, count in counts.items():
        total += count
        entries.append({value_field: value, "count": count})
    entries.sort(key=lambda e: (-e["count"], str(e[value_field])))
    pt = _finite(percent_total)
    denom = pt if pt is not None else total
    for entry in entries:
        entry["percent"] = round_to_2(entry["count"] / denom * 100) if denom > 0 else 0
    return entries


def _summarize_sub_id_counts(counts: Dict[str, int], percent_total: object) -> List[Dict[str, object]]:
    entries = []
    total = 0
    for sub_id, count in counts.items():
        total += count
        entries.append({"sub_id": sub_id, "count": count})
    entries.sort(key=lambda e: (-e["count"], str(e["sub_id"])))
    pt = _finite(percent_total)
    denom = pt if pt is not None else total
    for entry in entries:
        entry["percent"] = round_to_2(entry["count"] / denom * 100) if denom > 0 else 0
    return entries


def _build_breakdowns(rows: List[object], total_for_percent: object) -> Dict[str, object]:
    sub_id_counts: Dict[str, int] = {}
    sub1_counts: Dict[str, int] = {}
    sub2_counts: Dict[str, int] = {}
    sub3_counts: Dict[str, int] = {}
    for row in rows:
        sub_id = str(row.get("sub_id")) if isinstance(row, Mapping) and row.get("sub_id") is not None else ""
        sub_id_counts[sub_id] = sub_id_counts.get(sub_id, 0) + 1
        parts = _parse_sub_parts(sub_id)
        sub1_counts[parts["sub1"]] = sub1_counts.get(parts["sub1"], 0) + 1
        sub2_counts[parts["sub2"]] = sub2_counts.get(parts["sub2"], 0) + 1
        sub3_counts[parts["sub3"]] = sub3_counts.get(parts["sub3"], 0) + 1
    return {
        "sub_ids": _summarize_sub_id_counts(sub_id_counts, total_for_percent),
        "sub1_breakdown": _summarize_named_counts(sub1_counts, "sub1", total_for_percent),
        "sub2_breakdown": _summarize_named_counts(sub2_counts, "sub2", total_for_percent),
        "sub3_breakdown": _summarize_named_counts(sub3_counts, "sub3", total_for_percent),
    }


def _finite(value: object) -> Optional[float]:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):
        return None
    return n


# --- Fetch orchestration -----------------------------------------------------

Fetcher = Callable[[str, str], Mapping[str, object]]


def _fetch_window_page(fetch: Fetcher, spec: Mapping[str, object], rng: Mapping[str, object], page_num: int, page_size: int) -> Dict[str, object]:
    api_url = build_click_report_fetch_url({
        "range": rng,
        "page_num": page_num,
        "page_size": page_size,
        "extras": spec.get("extras"),
    })
    try:
        result = _run_fetch(fetch, str(spec["account"]), api_url)
    except Exception as err:  # noqa: BLE001
        return {
            "ok": False,
            "failure": {
                "status": "error",
                "error": "click_report_fetch_failed",
                "reason": "click_report_fetch_failed",
                "detail": sanitize_detail(err),
            },
        }
    classification = classify_click_report_fetch_result(result)
    if classification:
        return {"ok": False, "failure": classification}
    body = result.get("body")
    return {
        "ok": True,
        "total_count": pick_total_count(body),
        "rows": pick_list(body, ["click_report_list", "report_list"]),
        "affiliate_id": pick_affiliate_id(body),
    }


def _run_fetch(fetch: Fetcher, account: str, api_url: str) -> Mapping[str, object]:
    return fetch(account, api_url)


def _complete_fetch_failure(state: Dict[str, object], failure: Mapping[str, object]) -> Dict[str, object]:
    out = dict(failure)
    out.update({
        "total_count": 0 if state["rootTotalCount"] is None else state["rootTotalCount"],
        "leaf_total_count": state["leafTotalCount"],
        "rows_fetched": state["rowsFetched"],
        "pages_fetched": state["pagesFetched"],
        "probes_fetched": state["probesFetched"],
        "windows_fetched": state["windowsFetched"],
        "split_window_count": state["splitWindowCount"],
        "max_window_depth": state["maxWindowDepth"],
        "page_size": state["pageSize"],
    })
    return out


def fetch_complete_click_report_rows(fetch: Fetcher, spec: Mapping[str, object], page_size: Optional[int] = None, cap_rows: Optional[int] = None) -> Dict[str, object]:
    page_size = page_size or SHOPEE_CLICK_REPORT_COMPLETE_PAGE_SIZE
    cap_rows = cap_rows or SHOPEE_CLICK_REPORT_PAGE_CAP_ROWS
    max_pages_per_window = max(1, cap_rows // page_size)
    state: Dict[str, object] = {
        "rootTotalCount": None,
        "leafTotalCount": 0,
        "rowsFetched": 0,
        "pagesFetched": 0,
        "probesFetched": 0,
        "windowsFetched": 0,
        "splitWindowCount": 0,
        "maxWindowDepth": 0,
        "pageSize": page_size,
    }
    rows: List[object] = []
    affiliate_id: Optional[str] = None
    pending = [{
        "start": spec["range"]["click_time_s"],
        "end": spec["range"]["click_time_e"],
        "depth": 0,
        "root": True,
    }]

    while pending:
        window = pending.pop(0)
        state["maxWindowDepth"] = max(state["maxWindowDepth"], window["depth"])
        rng = {
            "timezone": spec["range"]["timezone"],
            "click_time_s": window["start"],
            "click_time_e": window["end"],
        }
        first_page = _fetch_window_page(fetch, spec, rng, 1, page_size)
        state["pagesFetched"] += 1
        state["probesFetched"] += 1
        if not first_page["ok"]:
            return {"ok": False, "failure": _complete_fetch_failure(state, first_page["failure"])}

        window_total = first_page["total_count"]
        if window["root"]:
            state["rootTotalCount"] = window_total
        if affiliate_id is None and first_page["affiliate_id"] is not None:
            affiliate_id = first_page["affiliate_id"]

        if window_total > cap_rows:
            if window["start"] >= window["end"]:
                return {"ok": False, "failure": _complete_fetch_failure(state, {
                    "status": "error",
                    "error": "click_report_window_too_dense",
                    "reason": "click_report_window_too_dense",
                    "truncated": True,
                    "cap_rows": cap_rows,
                    "window_total_count": window_total,
                    "window": {"click_time_s": window["start"], "click_time_e": window["end"]},
                    "warning": "Shopee returned more rows than the page cap inside a one-second click_time window; complete row enumeration cannot finish safely.",
                })}
            mid = (window["start"] + window["end"]) // 2
            if mid < window["start"] or mid >= window["end"]:
                return {"ok": False, "failure": _complete_fetch_failure(state, {
                    "status": "error",
                    "error": "click_report_window_split_failed",
                    "reason": "click_report_window_split_failed",
                    "truncated": True,
                    "cap_rows": cap_rows,
                    "window_total_count": window_total,
                    "window": {"click_time_s": window["start"], "click_time_e": window["end"]},
                    "warning": "The click_time window could not be split further without repeating the same timestamp range.",
                })}
            state["splitWindowCount"] += 1
            pending.append({"start": window["start"], "end": mid, "depth": window["depth"] + 1, "root": False})
            pending.append({"start": mid + 1, "end": window["end"], "depth": window["depth"] + 1, "root": False})
            continue

        state["windowsFetched"] += 1
        state["leafTotalCount"] += window_total
        first_rows = first_page["rows"] if isinstance(first_page["rows"], list) else []
        window_rows_fetched = len(first_rows)
        rows.extend(first_rows)
        state["rowsFetched"] += len(first_rows)

        page_count = math.ceil(window_total / page_size) if window_total else 0
        pages_to_fetch = min(page_count, max_pages_per_window)
        for page_num in range(2, pages_to_fetch + 1):
            next_page = _fetch_window_page(fetch, spec, rng, page_num, page_size)
            state["pagesFetched"] += 1
            if not next_page["ok"]:
                return {"ok": False, "failure": _complete_fetch_failure(state, next_page["failure"])}
            if affiliate_id is None and next_page["affiliate_id"] is not None:
                affiliate_id = next_page["affiliate_id"]
            page_rows = next_page["rows"] if isinstance(next_page["rows"], list) else []
            rows.extend(page_rows)
            state["rowsFetched"] += len(page_rows)
            window_rows_fetched += len(page_rows)
            if not page_rows and window_rows_fetched < window_total:
                break

        if window_rows_fetched < window_total:
            return {"ok": False, "failure": _complete_fetch_failure(state, {
                "status": "error",
                "error": "click_report_window_incomplete",
                "reason": "click_report_window_incomplete",
                "truncated": True,
                "cap_rows": cap_rows,
                "window_total_count": window_total,
                "window_rows_fetched": window_rows_fetched,
                "window": {"click_time_s": window["start"], "click_time_e": window["end"]},
                "warning": "Shopee returned fewer rows than total_count for a window that should fit below the page cap.",
            })}

    total_count = state["leafTotalCount"] if state["rootTotalCount"] is None else state["rootTotalCount"]
    return {
        "ok": True,
        "total_count": total_count,
        "leaf_total_count": state["leafTotalCount"],
        "rows": rows,
        "rows_fetched": state["rowsFetched"],
        "pages_fetched": state["pagesFetched"],
        "probes_fetched": state["probesFetched"],
        "windows_fetched": state["windowsFetched"],
        "split_window_count": state["splitWindowCount"],
        "max_window_depth": state["maxWindowDepth"],
        "page_size": page_size,
        "affiliate_id": affiliate_id,
        "truncated": False,
    }


def handle_click_report_raw_mode(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    api_url = build_click_report_fetch_url(spec)
    try:
        result = _run_fetch(fetch, str(spec["account"]), api_url)
    except Exception as err:  # noqa: BLE001
        out = base_response_shape(spec)
        out.update({
            "mode": "raw",
            "status": "error",
            "error": "click_report_fetch_failed",
            "reason": "click_report_fetch_failed",
            "detail": sanitize_detail(err),
        })
        return out
    classification = classify_click_report_fetch_result(result)
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
        "list": pick_list(body, ["click_report_list", "report_list"]),
        "affiliate_id": pick_affiliate_id(body),
    })
    return out


def handle_click_report_complete_raw_mode(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    complete = fetch_complete_click_report_rows(fetch, spec, page_size=SHOPEE_CLICK_REPORT_COMPLETE_PAGE_SIZE)
    shape = base_response_shape(spec)
    shape.update({"mode": "raw_complete", "page_num": 1, "page_size": SHOPEE_CLICK_REPORT_COMPLETE_PAGE_SIZE})
    if not complete["ok"]:
        shape.update(complete["failure"])
        return shape
    breakdowns = _build_breakdowns(complete["rows"], complete["total_count"])
    shape.update({
        "status": "ok",
        "total_count": complete["total_count"],
        "leaf_total_count": complete["leaf_total_count"],
        "rows_fetched": complete["rows_fetched"],
        "list": complete["rows"],
        "sub_ids": breakdowns["sub_ids"],
        "sub1_breakdown": breakdowns["sub1_breakdown"],
        "sub2_breakdown": breakdowns["sub2_breakdown"],
        "sub3_breakdown": breakdowns["sub3_breakdown"],
        "unique_sub_id_count": len(breakdowns["sub_ids"]),
        "pages_fetched": complete["pages_fetched"],
        "probes_fetched": complete["probes_fetched"],
        "windows_fetched": complete["windows_fetched"],
        "split_window_count": complete["split_window_count"],
        "max_window_depth": complete["max_window_depth"],
        "truncated": complete["truncated"],
        "breakdown_mode": "complete",
        "affiliate_id": complete["affiliate_id"],
    })
    return shape


def handle_click_report_filtered_summary(spec: Mapping[str, object], fetch: Fetcher) -> Dict[str, object]:
    page_size = SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE
    extras = spec.get("extras") or {}
    requested_sub_id = str(extras.get("sub_id") or "")
    api_url = build_click_report_fetch_url({
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
            "error": "click_report_fetch_failed",
            "reason": "click_report_fetch_failed",
            "detail": sanitize_detail(err),
            "pages_fetched": 0,
            "page_size": page_size,
        })
        return out
    classification = classify_click_report_fetch_result(result)
    if classification:
        out = summary_response_shape(spec)
        out.update(classification)
        out.update({"pages_fetched": 0, "page_size": page_size})
        return out
    body = result.get("body")
    total_count = pick_total_count(body)
    rows = pick_list(body, ["click_report_list", "report_list"])
    affiliate_id = pick_affiliate_id(body)
    first_sub_id = (
        str(rows[0]["sub_id"])
        if rows and isinstance(rows[0], Mapping) and rows[0].get("sub_id") is not None
        else ""
    )
    display_sub_id = first_sub_id or requested_sub_id
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
            }]
            if total_count > 0 else []
        ),
        "pages_fetched": 1,
        "page_size": page_size,
        "row_sample_count": len(rows),
        "truncated": False,
        "breakdown_mode": "filtered",
        "affiliate_id": affiliate_id,
    })
    return out


def handle_click_report_summary_mode(spec: Mapping[str, object], fetch: Fetcher, force_complete: bool = False) -> Dict[str, object]:
    extras = spec.get("extras") or {}
    if extras.get("sub_id") and not force_complete:
        return handle_click_report_filtered_summary(spec, fetch)

    complete = fetch_complete_click_report_rows(fetch, spec, page_size=SHOPEE_CLICK_REPORT_COMPLETE_PAGE_SIZE)
    if not complete["ok"]:
        out = summary_response_shape(spec)
        out.update(complete["failure"])
        return out
    breakdowns = _build_breakdowns(complete["rows"], complete["total_count"])
    out = summary_response_shape(spec)
    out.update({
        "total_count": complete["total_count"],
        "leaf_total_count": complete["leaf_total_count"],
        "unique_sub_id_count": len(breakdowns["sub_ids"]),
        "sub_ids": breakdowns["sub_ids"],
        "sub1_breakdown": breakdowns["sub1_breakdown"],
        "sub2_breakdown": breakdowns["sub2_breakdown"],
        "sub3_breakdown": breakdowns["sub3_breakdown"],
        "pages_fetched": complete["pages_fetched"],
        "page_size": complete["page_size"],
        "row_sample_count": complete["rows_fetched"],
        "rows_fetched": complete["rows_fetched"],
        "aggregated_total": complete["rows_fetched"],
        "probes_fetched": complete["probes_fetched"],
        "windows_fetched": complete["windows_fetched"],
        "split_window_count": complete["split_window_count"],
        "max_window_depth": complete["max_window_depth"],
        "truncated": complete["truncated"],
        "breakdown_mode": "complete",
        "affiliate_id": complete["affiliate_id"],
    })
    return out


def handle_click_report(
    query: Mapping[str, object],
    *,
    fetch: Fetcher,
    now: Optional[datetime] = None,
) -> Dict[str, object]:
    raw_mode = is_raw_click_report_mode(query)
    complete_raw_mode = is_complete_raw_click_report_mode(query)
    complete_summary_mode = is_complete_click_report_mode(query)

    working = dict(query)
    if not (raw_mode and not complete_raw_mode):
        working["page_size"] = str(SHOPEE_CLICK_REPORT_COMPLETE_PAGE_SIZE)
        working["page_num"] = "1"
    spec = resolve_click_report_request(working, now)

    if complete_raw_mode:
        return handle_click_report_complete_raw_mode(spec, fetch)
    if raw_mode:
        return handle_click_report_raw_mode(spec, fetch)
    return handle_click_report_summary_mode(spec, fetch, force_complete=complete_summary_mode)


def is_click_report_host(host_header: object) -> bool:
    if not host_header:
        return False
    host = str(host_header).split(",")[0].split(":")[0].strip().lower()
    return bool(host) and bool(SHOPEE_CLICK_REPORT_HOST_PATTERN.match(host))
