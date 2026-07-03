"""Offline unit tests for the Shopee report ports.

No live Shopee / CloakBrowser: every handler is driven with an injected
``fetch(account, api_url)`` fake that returns canned Shopee-shaped envelopes.
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from affiliate_shortlink_cloak_python import (  # noqa: E402
    click_report,
    conversion_report,
    server,
)
from affiliate_shortlink_cloak_python.report_common import (  # noqa: E402
    ReportRequestError,
)

# 2026-05-26 03:00 UTC -> Bangkok 2026-05-26 10:00 (deterministic date defaults).
FROZEN_NOW = datetime(2026, 5, 26, 3, 0, 0, tzinfo=timezone.utc)


def _url_params(api_url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(api_url).query).items()}


def _order_row(idx: int, sub_id: str, purchase_value=100, commission=5) -> dict:
    return {
        "checkout_id": "CKO-" + str(idx),
        "conversion_status": "PAID",
        "sub_id": sub_id,
        "purchase_value": purchase_value,
        "actual_commission": commission,
    }


# ---------------------------------------------------------------------------
# Date parsing (Bangkok day windows)
# ---------------------------------------------------------------------------

class ConversionDateTests(unittest.TestCase):
    def test_ddmmyyyy_maps_to_bangkok_day(self) -> None:
        out = conversion_report.parse_conversion_report_date("25/05/2026")
        self.assertEqual("25/05/2026", out["display"])
        self.assertEqual("2026-05-25", out["isoDate"])
        self.assertEqual("Asia/Bangkok", out["timezone"])
        # Bangkok 00:00 on 2026-05-25 == 2026-05-24T17:00:00Z
        self.assertEqual(
            int(datetime(2026, 5, 24, 17, 0, 0, tzinfo=timezone.utc).timestamp()),
            out["purchase_time_s"],
        )
        self.assertEqual(86399, out["purchase_time_e"] - out["purchase_time_s"])

    def test_iso_format(self) -> None:
        out = conversion_report.parse_conversion_report_date("2026-05-25")
        self.assertEqual("25/05/2026", out["display"])

    def test_today_uses_bangkok_local_day(self) -> None:
        late = datetime(2026, 5, 25, 18, 0, 0, tzinfo=timezone.utc)
        out = conversion_report.parse_conversion_report_date("today", late)
        self.assertEqual("26/05/2026", out["display"])

    def test_yesterday_subtracts_a_day(self) -> None:
        out = conversion_report.parse_conversion_report_date("yesterday", FROZEN_NOW)
        self.assertEqual("25/05/2026", out["display"])

    def test_invalid_time_raises(self) -> None:
        with self.assertRaises(ReportRequestError) as ctx:
            conversion_report.parse_conversion_report_date("not-a-date")
        self.assertEqual("conversion_report_time_invalid", ctx.exception.reason)
        self.assertEqual(400, ctx.exception.status_code)
        self.assertEqual("not-a-date", ctx.exception.public_payload["requestedTime"])

    def test_out_of_range_day_raises(self) -> None:
        with self.assertRaises(ReportRequestError):
            conversion_report.parse_conversion_report_date("32/05/2026")

    def test_click_date_uses_click_time_fields(self) -> None:
        out = click_report.parse_click_report_date("25/05/2026")
        self.assertIn("click_time_s", out)
        self.assertEqual(86399, out["click_time_e"] - out["click_time_s"])


# ---------------------------------------------------------------------------
# Request resolution + id alias mapping + clamping
# ---------------------------------------------------------------------------

class ResolveRequestTests(unittest.TestCase):
    def test_defaults_id_to_chearb(self) -> None:
        spec = conversion_report.resolve_conversion_report_request(
            {"time": ["25/05/2026"]}, FROZEN_NOW
        )
        self.assertEqual("15130770000", spec["id"])
        self.assertEqual("affiliate_chearb.com", spec["account"])
        self.assertEqual("affiliate_chearb.com", spec["accountInternal"])
        self.assertEqual("affiliate@chearb.com", spec["displayAccount"])
        self.assertEqual(1, spec["page_num"])
        self.assertEqual(20, spec["page_size"])
        self.assertEqual("Asia/Bangkok", spec["range"]["timezone"])

    def test_maps_neezs_and_an_prefix(self) -> None:
        spec = conversion_report.resolve_conversion_report_request(
            {"id": ["an_15142270000"]}, FROZEN_NOW
        )
        self.assertEqual("15142270000", spec["id"])
        self.assertEqual("affiliate_neezs.com", spec["account"])
        self.assertEqual("affiliate@neezs.com", spec["displayAccount"])

    def test_unknown_id_raises_unknown(self) -> None:
        with self.assertRaises(ReportRequestError) as ctx:
            conversion_report.resolve_conversion_report_request(
                {"id": ["999999999999"]}, FROZEN_NOW
            )
        self.assertEqual("shopee_affiliate_id_unknown", ctx.exception.reason)
        self.assertEqual("999999999999", ctx.exception.public_payload["requestedId"])
        self.assertNotRegex(
            json.dumps(ctx.exception.public_payload), r"(?i)cookie|token|password|secret"
        )

    def test_unparseable_id_raises_invalid(self) -> None:
        with self.assertRaises(ReportRequestError) as ctx:
            conversion_report.resolve_conversion_report_request({"id": ["not-an-id"]})
        self.assertEqual("shopee_affiliate_id_invalid", ctx.exception.reason)

    def test_page_num_falls_back_to_page(self) -> None:
        spec = conversion_report.resolve_conversion_report_request(
            {"id": ["15130770000"], "page_num": [""], "page": ["4"], "page_size": ["5"]},
            FROZEN_NOW,
        )
        self.assertEqual(4, spec["page_num"])
        self.assertEqual(5, spec["page_size"])

    def test_page_size_clamps(self) -> None:
        self.assertEqual(20, conversion_report.clamp_page_size(""))
        self.assertEqual(50, conversion_report.clamp_page_size("50"))
        self.assertEqual(100, conversion_report.clamp_page_size(500))
        self.assertEqual(20, conversion_report.clamp_page_size(-1))
        self.assertEqual(1, conversion_report.clamp_page_num("0"))

    def test_extras_passthrough(self) -> None:
        spec = conversion_report.resolve_conversion_report_request(
            {
                "id": ["15130770000"],
                "sub_id": ["yok"],
                "order_id": ["OID-1"],
                "checkout_id": ["CKO-1"],
                "conversion_id": ["CON-1"],
                "order_status": [""],
                "conversion_status": ["PAID"],
            },
            FROZEN_NOW,
        )
        self.assertEqual(
            {
                "sub_id": "yok",
                "order_id": "OID-1",
                "checkout_id": "CKO-1",
                "conversion_id": "CON-1",
                "conversion_status": "PAID",
            },
            spec["extras"],
        )

    def test_conversion_fetch_url_targets_v3(self) -> None:
        spec = conversion_report.resolve_conversion_report_request(
            {"id": ["15142270000"], "page_size": ["5"], "sub_id": ["yok"]}, FROZEN_NOW
        )
        url = conversion_report.build_conversion_report_fetch_url(spec)
        self.assertRegex(url, r"^https://affiliate\.shopee\.co\.th/api/v3/report/list\?")
        self.assertNotIn("/api/v1/report/list", url)
        self.assertIn("version=1", url)
        self.assertIn("sub_id=yok", url)


# ---------------------------------------------------------------------------
# Host mapping
# ---------------------------------------------------------------------------

class HostMappingTests(unittest.TestCase):
    def test_conversion_host(self) -> None:
        self.assertTrue(conversion_report.is_conversion_report_host("conversionreport.wwoom.com"))
        self.assertTrue(conversion_report.is_conversion_report_host("conversionreport.wwoom.com:8810"))
        self.assertTrue(conversion_report.is_conversion_report_host("ConversionReport.WWoom.com"))
        self.assertFalse(conversion_report.is_conversion_report_host(""))
        self.assertFalse(conversion_report.is_conversion_report_host("127.0.0.1:8810"))
        self.assertFalse(conversion_report.is_conversion_report_host("clickreport.wwoom.com"))
        self.assertFalse(conversion_report.is_conversion_report_host("conversionreport.evil.com"))

    def test_click_host(self) -> None:
        self.assertTrue(click_report.is_click_report_host("clickreport.wwoom.com"))
        self.assertTrue(click_report.is_click_report_host("ClickReport.WWoom.com:8810"))
        self.assertFalse(click_report.is_click_report_host("conversionreport.wwoom.com"))
        self.assertFalse(click_report.is_click_report_host("clickreport.evil.com"))


# ---------------------------------------------------------------------------
# Login classification
# ---------------------------------------------------------------------------

class ClassifyTests(unittest.TestCase):
    def test_conversion_login_codes(self) -> None:
        self.assertEqual("shopee_login_required", conversion_report.classify_conversion_report_failure({"code": 30001}))
        self.assertEqual("shopee_login_required", conversion_report.classify_conversion_report_failure({"code": "30002"}))
        self.assertEqual("shopee_login_required", conversion_report.classify_conversion_report_failure({"data": {"code": 30001}}))
        self.assertIsNone(conversion_report.classify_conversion_report_failure({"code": 0}))
        self.assertIsNone(conversion_report.classify_conversion_report_failure({"code": 99999}))

    def test_click_login_code(self) -> None:
        self.assertEqual("shopee_login_required", click_report.classify_click_report_failure({"code": 30001}))
        # click report only treats 30001 as login (mirrors Node).
        self.assertIsNone(click_report.classify_click_report_failure({"code": 30002}))


# ---------------------------------------------------------------------------
# Conversion report: raw + summary modes (mocked fetch)
# ---------------------------------------------------------------------------

class ConversionRawSummaryTests(unittest.TestCase):
    def test_raw_mode(self) -> None:
        calls = []

        def fetch(account, api_url):
            calls.append((account, api_url))
            return {
                "status": 200,
                "parsed": True,
                "body": {
                    "code": 0,
                    "data": {
                        "affiliate_id": 15142270000,
                        "total_count": 12,
                        "list": [_order_row(1, "yok", 100, 5), _order_row(2, "", 200, 10)],
                    },
                },
            }

        result = conversion_report.handle_conversion_report(
            {"id": ["15142270000"], "time": ["25/05/2026"], "page_size": ["50"], "raw": ["1"]},
            fetch=fetch,
            now=FROZEN_NOW,
        )
        self.assertEqual("ok", result["status"])
        self.assertEqual("raw", result["mode"])
        self.assertEqual("conversion_report", result["report_type"])
        self.assertEqual("affiliate@neezs.com", result["account"])
        self.assertEqual(50, result["page_size"])
        self.assertEqual(12, result["total_count"])
        self.assertEqual("15142270000", result["affiliate_id"])
        self.assertEqual(2, len(result["list"]))
        self.assertEqual("affiliate_neezs.com", calls[0][0])
        self.assertRegex(calls[0][1], r"/api/v3/report/list\?")
        self.assertNotRegex(json.dumps(result), r"(?i)cookie|token|password|secret")

    def test_summary_complete_mode(self) -> None:
        def fetch(account, api_url):
            return {
                "status": 200,
                "parsed": True,
                "body": {
                    "code": 0,
                    "data": {
                        "affiliate_id": 15130770000,
                        "total_count": 3,
                        "list": [
                            _order_row(1, "yok", 100, 5),
                            _order_row(2, "yok", 50, 2.5),
                            _order_row(3, "", 30, 1.5),
                        ],
                    },
                },
            }

        result = conversion_report.handle_conversion_report(
            {"id": ["15130770000"], "time": ["25/05/2026"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("ok", result["status"])
        self.assertEqual("summary", result["mode"])
        self.assertEqual("complete", result["breakdown_mode"])
        self.assertEqual(1, result["pages_fetched"])
        self.assertEqual(100, result["page_size"])
        self.assertEqual(3, result["total_count"])
        self.assertEqual(2, result["unique_sub_id_count"])
        yok = next(e for e in result["sub_ids"] if e["sub_id"] == "yok")
        self.assertEqual(2, yok["count"])
        self.assertEqual(150, yok["purchase_value"])
        self.assertEqual(7.5, yok["commission"])
        self.assertEqual(66.67, yok["percent"])
        self.assertEqual(180, result["sample_totals"]["purchase_value"])
        self.assertEqual(9, result["sample_totals"]["commission"])
        self.assertNotIn("list", result)

    def test_summary_discovered_filtered_mode(self) -> None:
        filtered = {"alpha": 80, "beta": 50}
        calls = []

        def fetch(account, api_url):
            params = _url_params(api_url)
            self.assertEqual("1", params["page_num"])
            self.assertEqual("100", params["page_size"])
            sub = params.get("sub_id")
            calls.append(sub)
            if sub is None:
                rows = [_order_row(i, "alpha", 100, 5) for i in range(50)]
                rows += [_order_row(i, "beta", 200, 10) for i in range(50, 100)]
                return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"affiliate_id": 15142270000, "total_count": 140, "list": rows}}}
            total = filtered.get(sub, 0)
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"total_count": total, "list": []}}}

        result = conversion_report.handle_conversion_report(
            {"id": ["15142270000"], "time": ["25/05/2026"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("ok", result["status"])
        self.assertEqual("discovered_filtered", result["breakdown_mode"])
        self.assertTrue(result["truncated"])
        self.assertEqual(140, result["total_count"])
        self.assertEqual(100, result["row_sample_count"])
        self.assertEqual(2, result["discovered_sub_id_count"])
        self.assertEqual(3, result["pages_fetched"])
        self.assertEqual([None, "alpha", "beta"], calls)
        self.assertEqual("alpha", result["sub_ids"][0]["sub_id"])
        self.assertEqual(80, result["sub_ids"][0]["count"])
        self.assertEqual(57.14, result["sub_ids"][0]["percent"])
        self.assertEqual(35.71, result["sub_ids"][1]["percent"])
        self.assertRegex(result["warning"], r"sub_id discovery is based on")

    def test_summary_placeholder_sub_ids_skipped(self) -> None:
        calls = []

        def fetch(account, api_url):
            sub = _url_params(api_url).get("sub_id")
            calls.append(sub)
            if sub is None:
                rows = [_order_row(i, "alpha", 100, 5) for i in range(60)]
                rows += [_order_row(i, "-", 50, 2.5) for i in range(60, 90)]
                rows += [_order_row(i, "----", 50, 2.5) for i in range(90, 100)]
                return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"total_count": 5486, "list": rows}}}
            self.assertEqual("alpha", sub)
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"total_count": 4000, "list": []}}}

        result = conversion_report.handle_conversion_report(
            {"id": ["15130770000"], "time": ["25/05/2026"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual(1, result["discovered_sub_id_count"])
        self.assertEqual([None, "alpha"], calls)
        self.assertEqual(1, len(result["sub_ids"]))
        self.assertEqual("alpha", result["sub_ids"][0]["sub_id"])

    def test_manual_login_on_401(self) -> None:
        def fetch(account, api_url):
            return {"status": 401, "parsed": False, "body": None}

        result = conversion_report.handle_conversion_report(
            {"id": ["15130770000"], "time": ["25/05/2026"], "raw": ["1"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("manual_login_required", result["status"])
        self.assertTrue(result["manualLoginRequired"])
        self.assertEqual("/login?platform=shopee", result["loginUi"])

    def test_login_gate_marker_fails_closed(self) -> None:
        def fetch(account, api_url):
            return {"login_gate": True}

        result = conversion_report.handle_conversion_report(
            {"id": ["15130770000"], "raw": ["1"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("manual_login_required", result["status"])
        self.assertEqual("shopee_login_required", result["reason"])


# ---------------------------------------------------------------------------
# Daily income (dashboard/detail) multi-id aggregation
# ---------------------------------------------------------------------------

class DailyIncomeTests(unittest.TestCase):
    def test_single_id_dashboard_detail(self) -> None:
        def fetch(account, api_url):
            params = _url_params(api_url)
            self.assertRegex(api_url, r"/api/v3/dashboard/detail\?")
            self.assertRegex(params["start_time"], r"^\d+$")
            return {
                "status": 200,
                "parsed": True,
                "body": {"code": 0, "data": {
                    "clicks_sum": 45473,
                    "cv_by_order_sum": 6100,
                    "item_sold_sum": 10800,
                    "order_amount_sum": 190000000000,
                    "est_commission_sum": 323000000,
                    "est_income_sum": 32300000,
                }},
            }

        result = conversion_report.handle_daily_income_report(
            {"id": ["15142270000"], "time": ["25/05/2026"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("ok", result["status"])
        self.assertEqual("daily_income_report", result["report_type"])
        self.assertEqual(1, result["account_count"])
        self.assertEqual("THB", result["amount_unit"])
        self.assertEqual(6100, result["totals"]["orders"])
        self.assertEqual(1900000, result["totals"]["purchase_value"])
        self.assertEqual(3230, result["totals"]["commission"])
        self.assertEqual("dashboard_detail", result["accounts"][0]["mode"])
        self.assertEqual(10800, result["accounts"][0]["item_sold"])
        self.assertEqual("/api/v3/dashboard/detail", result["accounts"][0]["source_endpoint"])

    def test_multi_id_aggregation(self) -> None:
        metrics = {
            "affiliate_chearb.com": {"cv_by_order_sum": 2, "order_amount_sum": 100000000, "est_commission_sum": 500000},
            "affiliate_neezs.com": {"cv_by_order_sum": 3, "order_amount_sum": 200000000, "est_commission_sum": 639000},
        }

        def fetch(account, api_url):
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": metrics[account]}}

        result = conversion_report.handle_daily_income_report(
            {"ids": ["15130770000,15142270000"], "time": ["25/05/2026"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("ok", result["status"])
        self.assertEqual(2, result["account_count"])
        self.assertEqual(2, result["ok_account_count"])
        self.assertEqual(5, result["totals"]["orders"])
        # (100000000 + 200000000)/100000 = 3000
        self.assertEqual(3000, result["totals"]["purchase_value"])
        # (500000 + 639000)/100000 = 11.39
        self.assertEqual(11.39, result["totals"]["commission"])
        self.assertEqual({"15130770000", "15142270000"}, {a["id"] for a in result["accounts"]})

    def test_defaults_to_both_ids(self) -> None:
        seen = []

        def fetch(account, api_url):
            seen.append(account)
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"cv_by_order_sum": 1}}}

        result = conversion_report.handle_daily_income_report({}, fetch=fetch, now=FROZEN_NOW)
        self.assertEqual(2, result["account_count"])
        self.assertEqual({"affiliate_chearb.com", "affiliate_neezs.com"}, set(seen))

    def test_failed_account_marks_error(self) -> None:
        def fetch(account, api_url):
            if account == "affiliate_neezs.com":
                return {"status": 401, "parsed": False, "body": None}
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"cv_by_order_sum": 4}}}

        result = conversion_report.handle_daily_income_report({}, fetch=fetch, now=FROZEN_NOW)
        self.assertEqual("error", result["status"])
        self.assertEqual(1, result["failed_account_count"])
        self.assertEqual(4, result["totals"]["orders"])  # only ok account counted

    def test_invalid_id_list_raises(self) -> None:
        with self.assertRaises(ReportRequestError):
            conversion_report.parse_daily_income_ids({"ids": ["not,an,id"]}, FROZEN_NOW)


# ---------------------------------------------------------------------------
# Click report: raw + summary (complete windowing) + filtered
# ---------------------------------------------------------------------------

class ClickReportTests(unittest.TestCase):
    def test_raw_mode(self) -> None:
        def fetch(account, api_url):
            self.assertRegex(api_url, r"/api/v1/click_report/list\?")
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"affiliate_id": 15142270000, "total_count": 26437, "list": [{"sub_id": "a-b-c"}]}}}

        result = click_report.handle_click_report(
            {"id": ["15142270000"], "time": ["25/05/2026"], "page_size": ["50"], "raw": ["1"]},
            fetch=fetch, now=FROZEN_NOW,
        )
        self.assertEqual("ok", result["status"])
        self.assertEqual("raw", result["mode"])
        self.assertEqual(50, result["page_size"])
        self.assertEqual(26437, result["total_count"])

    def test_summary_complete_paginates(self) -> None:
        all_rows = [{"sub_id": "d-p-%d" % (i % 3)} for i in range(140)]
        pages = []

        def fetch(account, api_url):
            params = _url_params(api_url)
            self.assertEqual("100", params["page_size"])
            page_num = int(params["page_num"])
            page_size = int(params["page_size"])
            pages.append(page_num)
            start = (page_num - 1) * page_size
            rows = all_rows[start:start + page_size]
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"total_count": len(all_rows), "list": rows}}}

        result = click_report.handle_click_report(
            {"id": ["15142270000"], "time": ["25/05/2026"], "page_size": ["50"]},
            fetch=fetch, now=FROZEN_NOW,
        )
        self.assertEqual("summary", result["mode"])
        self.assertEqual(140, result["total_count"])
        self.assertEqual(140, result["leaf_total_count"])
        self.assertEqual(100, result["page_size"])
        self.assertEqual(2, result["pages_fetched"])
        self.assertEqual(1, result["windows_fetched"])
        self.assertEqual("complete", result["breakdown_mode"])
        self.assertIn("sub1_breakdown", result)
        # sub_id counts sum to total.
        self.assertEqual(140, sum(e["count"] for e in result["sub_ids"]))

    def test_summary_stops_when_list_short(self) -> None:
        def fetch(account, api_url):
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"total_count": 3, "list": [{"sub_id": "a"}, {"sub_id": "a"}, {"sub_id": "b"}]}}}

        result = click_report.handle_click_report(
            {"id": ["15130770000"], "time": ["25/05/2026"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual(1, result["pages_fetched"])
        self.assertEqual(3, result["total_count"])
        self.assertEqual("complete", result["breakdown_mode"])

    def test_filtered_summary_uses_total_count(self) -> None:
        def fetch(account, api_url):
            self.assertEqual("yok", _url_params(api_url)["sub_id"])
            return {"status": 200, "parsed": True, "body": {"code": 0, "data": {"total_count": 32247, "list": [{"sub_id": "yok"}, {"sub_id": "yok"}]}}}

        result = click_report.handle_click_report(
            {"id": ["15130770000"], "time": ["25/05/2026"], "sub_id": ["yok"]},
            fetch=fetch, now=FROZEN_NOW,
        )
        self.assertEqual("filtered", result["breakdown_mode"])
        self.assertEqual(32247, result["total_count"])
        self.assertEqual(1, result["pages_fetched"])
        self.assertEqual("yok", result["sub_ids"][0]["sub_id"])
        self.assertEqual(100, result["sub_ids"][0]["percent"])

    def test_manual_login_code(self) -> None:
        def fetch(account, api_url):
            return {"status": 200, "parsed": True, "body": {"code": 30001, "message": "Not Login"}}

        result = click_report.handle_click_report(
            {"id": ["15130770000"], "raw": ["1"]}, fetch=fetch, now=FROZEN_NOW
        )
        self.assertEqual("manual_login_required", result["status"])


# ---------------------------------------------------------------------------
# Server route dispatch + host mapping
# ---------------------------------------------------------------------------

class ServerRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = server.ServerConfig(
            host="127.0.0.1", port=8811, profile_root="/tmp/asclp/profiles"
        )

    def _dispatch(self, path, host=""):
        captured = {}

        class FakeHandler:
            headers = {"Host": host}

            def __init__(self) -> None:
                self.path = path
                self.server = type("S", (), {"config": None})()

            def _write_json(self, status, payload):
                captured["status"] = status
                captured["payload"] = payload

        handler = FakeHandler()
        handler.server.config = self.config
        server.RequestHandler.do_GET(handler)
        return captured

    def test_conversion_route_dispatched(self) -> None:
        with mock.patch.object(server, "handle_conversion_report_route", return_value=(200, {"m": "conv"})) as m:
            out = self._dispatch("/conversion-report?id=15130770000")
        self.assertTrue(m.called)
        self.assertEqual({"m": "conv"}, out["payload"])

    def test_conversion_host_maps_root(self) -> None:
        with mock.patch.object(server, "handle_conversion_report_route", return_value=(200, {"m": "conv"})) as conv, \
             mock.patch.object(server, "handle_click_report_route", return_value=(200, {"m": "click"})) as click_m:
            out = self._dispatch("/?id=15130770000", host="conversionreport.wwoom.com")
        self.assertTrue(conv.called)
        self.assertFalse(click_m.called)
        self.assertEqual({"m": "conv"}, out["payload"])

    def test_click_host_maps_root(self) -> None:
        with mock.patch.object(server, "handle_click_report_route", return_value=(200, {"m": "click"})) as click_m, \
             mock.patch.object(server, "handle_conversion_report_route", return_value=(200, {"m": "conv"})) as conv:
            out = self._dispatch("/", host="clickreport.wwoom.com")
        self.assertTrue(click_m.called)
        self.assertFalse(conv.called)

    def test_daily_income_routes(self) -> None:
        for path in ("/daily-income-report", "/income-report"):
            with mock.patch.object(server, "handle_daily_income_report_route", return_value=(200, {"m": "income"})) as m:
                out = self._dispatch(path + "?id=15130770000")
            self.assertTrue(m.called, path)
            self.assertEqual({"m": "income"}, out["payload"])

    def test_default_host_root_still_health(self) -> None:
        out = self._dispatch("/")
        self.assertEqual(200, out["status"])
        self.assertEqual("ok", out["payload"]["status"])
        self.assertEqual("affiliate-shortlink-cloak-python", out["payload"]["app"])

    def test_invalid_id_returns_400_via_route(self) -> None:
        status, payload = server.handle_conversion_report_route(
            {"id": ["not-an-id"]}, self.config
        )
        self.assertEqual(400, status)
        self.assertEqual("shopee_affiliate_id_invalid", payload["error"])


if __name__ == "__main__":
    unittest.main()
