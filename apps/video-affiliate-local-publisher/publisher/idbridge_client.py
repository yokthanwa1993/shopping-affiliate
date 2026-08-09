from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .security import redact_error


class IDBridgeError(RuntimeError):
    pass


class IDBridgeClient:
    def __init__(self, base_url: str, service_auth: str):
        self.base_url = base_url.rstrip("/")
        self.service_auth = service_auth
        if not service_auth:
            raise IDBridgeError("idbridge_auth_missing")

    def _request(self, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None,
                 query: Optional[Dict[str, str]] = None, timeout: int = 120) -> Any:
        url = self.base_url + path
        if query:
            url += "?" + urlencode({k: v for k, v in query.items() if str(v).strip()})
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "X-Bridge-Token": self.service_auth,
            "Accept": "application/json",
            "User-Agent": "VideoAffiliateLocalPublisher/0.1",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, method=method, headers=headers)
        try:
            with urlopen(request, timeout=timeout) as response:
                status = int(response.status)
                raw = response.read(8 * 1024 * 1024)
        except HTTPError as exc:
            status = int(exc.code)
            raw = exc.read(1024 * 1024)
        except (URLError, TimeoutError) as exc:
            raise IDBridgeError("idbridge_network_failed") from exc
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            raise IDBridgeError(f"idbridge_http_{status}_invalid_json") from exc
        if status < 200 or status >= 300:
            code = payload.get("code") or payload.get("error") if isinstance(payload, dict) else ""
            raise IDBridgeError(f"idbridge_http_{status}:{redact_error(code or 'failed')}")
        return payload

    def token_ready(self, account: str) -> bool:
        data = self._request("/token", query={"account": account}, timeout=30)
        return isinstance(data, dict) and data.get("ok") is True and data.get("accessToken") is True

    def pages(self, account: str) -> List[Dict[str, Any]]:
        data = self._request("/pages", query={"account": account}, timeout=30)
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise IDBridgeError("idbridge_pages_invalid")
        return [row for row in rows if isinstance(row, dict)]

    def ensure_page(self, account: str, page_id: str) -> None:
        if not account:
            raise IDBridgeError("facebook_account_missing")
        if not self.token_ready(account):
            raise IDBridgeError("facebook_lite_token_unavailable")
        if not any(str(row.get("id") or "") == str(page_id) for row in self.pages(account)):
            raise IDBridgeError("facebook_page_not_authorized")

    def graph_get(self, account: str, path: str,
                  params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        if not account:
            raise IDBridgeError("power_editor_account_missing")
        query = {"account": account, "path": path}
        query.update(params or {})
        payload = self._request("/graph", query=query, timeout=45)
        if not isinstance(payload, dict) or payload.get("error"):
            raise IDBridgeError("graph_readback_failed")
        return payload

    def shopee_accounts(self) -> List[Dict[str, Any]]:
        data = self._request("/accounts", timeout=30)
        if not isinstance(data, list):
            raise IDBridgeError("shopee_accounts_invalid")
        return [row for row in data if isinstance(row, dict)]

    def shorten(self, product_url: str, account: str, affiliate_id: str,
                sub1: str, sub2: str, sub3: str) -> str:
        payload = self._request("/shorten", method="POST", timeout=180, body={
            "url": product_url, "account": account, "affiliate_id": affiliate_id,
            "sub1": sub1, "sub2": sub2, "sub3": sub3,
        })
        if not isinstance(payload, dict) or payload.get("ok") is False:
            raise IDBridgeError("shorten_failed")
        link = str(payload.get("shortLink") or payload.get("shortlink") or payload.get("short_link") or "").strip()
        if not link.startswith("https://s.shopee.co.th/"):
            raise IDBridgeError("shorten_result_invalid")
        return link

    def post(self, page_id: str, video_url: str, message: str, account: str) -> Dict[str, str]:
        payload = self._request("/post", method="POST", timeout=210, body={
            "page_id": page_id, "video_url": video_url, "message": message, "account": account,
        })
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            code = payload.get("error") if isinstance(payload, dict) else "post_failed"
            raise IDBridgeError("facebook_post_failed:" + redact_error(code))
        source = str(payload.get("source") or "").strip()
        story_id = str(payload.get("story_id") or "").strip()
        video_id = str(payload.get("video_id") or "").strip()
        if source != "facebook_lite_eaad6":
            raise IDBridgeError("facebook_post_source_not_lite")
        if not story_id or not video_id:
            raise IDBridgeError("facebook_post_identity_missing")
        return {
            "source": source, "story_id": story_id, "video_id": video_id,
            "post_url": str(payload.get("post_url") or "").strip(),
        }

    def page_comment(self, page_id: str, story_id: str, message: str, account: str) -> str:
        payload = self._request("/page-comment", method="POST", timeout=45, body={
            "page_id": page_id, "story_id": story_id, "message": message, "account": account,
        })
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            code = payload.get("error") if isinstance(payload, dict) else "comment_failed"
            raise IDBridgeError("page_comment_failed:" + redact_error(code))
        comment_id = str(payload.get("id") or "").strip()
        if not comment_id or payload.get("author_expected") != "page":
            raise IDBridgeError("page_comment_identity_invalid")
        return comment_id
