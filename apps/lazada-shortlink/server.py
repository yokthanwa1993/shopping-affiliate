#!/usr/bin/env python3
"""
Lazada Shortlink API — FastAPI + browser-use
browser-use คุม Chrome profile จริง (login Lazada ไว้แล้ว)
ใช้ page.evaluate() สั่งยิง API จาก context ของหน้า Lazada โดยตรง

Start:  python3 server.py
API:    GET http://localhost:8800/shorten?url=LAZADA_URL
Docs:   http://localhost:8800/docs
"""

import asyncio
import json
import os
import re
import subprocess
import uuid
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import HTMLResponse
import uvicorn

PORT = 8800
SHORTEN_JS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shorten.js")
PREWARM_BROWSER = os.getenv("PREWARM_BROWSER", "1").lower() not in {"0", "false", "no"}
BROWSER_PROFILE = os.getenv("BROWSER_PROFILE", "Default")
BROWSER_SESSION = os.getenv("BROWSER_SESSION", "shortlink")
BROWSER_HEADED = os.getenv("BROWSER_HEADED", "1").lower() not in {"0", "false", "no"}
CDP_URL = os.getenv("CDP_URL", "").strip()

# Load JS
with open(SHORTEN_JS_PATH) as f:
    SHORTEN_JS = f.read()

# Track browser state
browser_ready = False
browser_use_prefix = None


def get_browser_use_prefix():
    """Pick browser-use flags that match the installed CLI version."""
    global browser_use_prefix
    if browser_use_prefix is not None:
        return browser_use_prefix

    if CDP_URL:
        browser_use_prefix = ["browser-use", "--session", BROWSER_SESSION, "--cdp-url", CDP_URL]
        return browser_use_prefix

    prefix = ["browser-use", "--session", BROWSER_SESSION]
    if BROWSER_HEADED:
        prefix.append("--headed")
    prefix.extend(["--profile", BROWSER_PROFILE])
    try:
        help_result = subprocess.run(
            ["browser-use", "-h"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        help_text = f"{help_result.stdout}\n{help_result.stderr}"
        if "--headed" not in help_text and BROWSER_HEADED:
            prefix = ["browser-use", "--session", BROWSER_SESSION, "--profile", BROWSER_PROFILE]
    except Exception:
        pass

    browser_use_prefix = prefix
    return browser_use_prefix


def bu(command, *args, timeout=30):
    """Run browser-use CLI command."""
    # Global flags must come BEFORE the command
    cmd = get_browser_use_prefix() + [command] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip(), r.stderr.strip(), r.returncode


async def ensure_browser():
    """Make sure browser is open on a Lazada page."""
    global browser_ready
    if browser_ready:
        # Quick check
        try:
            out, _, rc = bu("get", "title", timeout=5)
            if rc == 0:
                return True
        except Exception:
            pass

    # Open Lazada
    out, err, rc = bu("open", "https://www.lazada.co.th")
    if rc != 0:
        raise HTTPException(503, detail=f"Browser launch failed: {err}")

    await asyncio.sleep(3)
    browser_ready = True
    return True


async def shorten_link_via_browser_use(product_url: str) -> dict:
    """Shorten a Lazada URL via browser-use eval (2-step async pattern)."""
    await ensure_browser()

    # Escape URL for JS
    safe_url = product_url.replace("'", "\\'")
    request_id = uuid.uuid4().hex
    result_key = f"__lzd_result_{request_id}"
    done_key = f"__lzd_done_{request_id}"

    # Step 1: Start async call, store result in window.__lzd_result
    js_start = (
        f"window.{done_key}=false;window.{result_key}=null;"
        f"({SHORTEN_JS})('{safe_url}')"
        f".then(function(r){{window.{result_key}=JSON.stringify(r);window.{done_key}=true;}})"
        f".catch(function(e){{window.{result_key}=JSON.stringify({{error:e.message||String(e)}});window.{done_key}=true;}});"
        f"'started'"
    )

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: bu("eval", js_start, timeout=15))

    # Step 2: Poll for result
    for _ in range(20):  # max 20 seconds
        await asyncio.sleep(1)
        out, _, rc = await loop.run_in_executor(
            None, lambda: bu("eval", f"window.{result_key}", timeout=5)
        )
        text = out.replace("result: ", "", 1).strip() if out.startswith("result:") else out.strip()
        if text and text != "null" and text != "None":
            break
    else:
        raise HTTPException(504, detail="Timeout waiting for API response")

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(500, detail=f"Failed to parse: {text[:300]}")

    # Extract data
    d = None
    detail = None
    if isinstance(raw, dict):
        if "data" in raw and isinstance(raw["data"], dict):
            data_block = raw["data"]
            d = data_block.get("data", data_block)
            detail = data_block.get("msg") or data_block.get("subMsg")
            if not detail and isinstance(d, dict):
                detail = d.get("msg") or d.get("subMsg")
        else:
            d = raw

    if not d or not isinstance(d, dict) or not d.get("promotionLink"):
        ret = raw.get("ret", []) if isinstance(raw, dict) else []
        ret_text = ", ".join(ret) if ret else ""
        if detail and ret_text:
            raise HTTPException(500, detail=f"{detail} ({ret_text})")
        if detail:
            raise HTTPException(500, detail=detail)
        if ret_text == "SUCCESS::调用成功":
            raise HTTPException(500, detail="Lazada API accepted the request but returned no shortlink")
        raise HTTPException(500, detail=ret_text if ret_text else f"No shortlink: {str(raw)[:200]}")

    return d


async def shorten_link(product_url: str) -> dict:
    return await shorten_link_via_browser_use(product_url)


def parse_jsonish(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return None


def find_first_query_param(urls: list[str], name: str) -> str | None:
    for url in urls:
        if not url:
            continue
        parsed = urlparse(url)
        value = parse_qs(parsed.query).get(name)
        if value and value[0]:
            return value[0]
    return None


def extract_member_id(data: dict) -> str | None:
    pid = None

    ut_log_map = parse_jsonish(data.get("utLogMap"))
    if isinstance(ut_log_map, dict):
        pid = ut_log_map.get("pid")
        member_id = ut_log_map.get("member_id")
        if member_id not in (None, "", "-1", -1):
            return str(member_id)

    if not pid:
        track_info = parse_jsonish(data.get("trackInfo"))
        if isinstance(track_info, dict):
            for value in track_info.values():
                if isinstance(value, str):
                    match = re.search(r"pid[:=](mm_\d+_\d+_\d+)", value)
                    if match:
                        pid = match.group(1)
                        break

    if not pid:
        for key in ("clickUrl", "eurl", "pdpJumpUrl", "promotionLink"):
            value = data.get(key)
            if isinstance(value, str):
                match = re.search(r"(mm_\d+_\d+_\d+)", value)
                if match:
                    pid = match.group(1)
                    break

    if not pid:
        return None

    match = re.match(r"mm_(\d+)_", pid)
    return match.group(1) if match else None


def extract_utm_source(data: dict) -> str | None:
    urls = [
        data.get("clickUrl"),
        data.get("eurl"),
        data.get("pdpJumpUrl"),
        data.get("promotionLink"),
    ]
    return find_first_query_param(urls, "utm_source")


def build_legacy_response(data: dict, url: str, account: str, sub1: str) -> dict:
    short_link = data["promotionLink"]
    return {
        "originalLink": url,
        "redirectLink": short_link,
        "longLink": url,
        "shortLink": short_link,
        "member_id": extract_member_id(data),
        "promotionCode": data.get("promotionCode"),
        "account": account,
        "sub1": sub1,
    }


# --- FastAPI ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    if PREWARM_BROWSER:
        try:
            await ensure_browser()
            print("[OK] Browser ready")
        except Exception as e:
            print(f"[WARN] Browser deferred: {e}")
    else:
        print("[INFO] Browser prewarm disabled")
    yield
    # Cleanup — don't close browser, user might want to keep it


app = FastAPI(title="Lazada Shortlink API", lifespan=lifespan)


INDEX_HTML = """<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lazada Shortlink</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);padding:32px;width:460px;max-width:95vw}
h1{color:#f5365c;font-size:22px;margin-bottom:4px}.sub{color:#999;font-size:13px;margin-bottom:24px}
label{display:block;font-size:12px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 6px}
input{width:100%;padding:10px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;outline:none}input:focus{border-color:#f5365c}
.row{display:flex;gap:10px}.row>*{flex:1}
button{width:100%;padding:12px;background:#f5365c;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:20px}
button:hover{background:#e0294e}button:disabled{background:#ccc}
.res{display:none;margin-top:20px;padding:16px;border-radius:10px;border:1.5px solid #28a745;background:#f0fff4}
.rl{font-size:15px;color:#f5365c;font-weight:600;word-break:break-all;margin:6px 0 10px;cursor:pointer}
.cb{padding:8px 20px;background:#28a745;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;width:auto;margin:0}
.err{display:none;margin-top:16px;padding:12px;background:#fff3f3;border:1px solid #ffcdd2;border-radius:8px;color:#d32f2f;font-size:13px}
.jt{margin-top:10px;font-size:12px;color:#888;cursor:pointer}.jb{display:none;margin-top:8px;padding:10px;background:#f8f8f8;border-radius:6px;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto}
.ai{margin-top:20px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#aaa}.ai code{background:#f0f0f0;padding:2px 6px;border-radius:4px}
</style></head><body><div class="c">
<h1>Lazada Shortlink</h1><p class="sub">FastAPI + browser-use</p>
<label>Lazada Product URL</label><input id="u" placeholder="https://www.lazada.co.th/products/...">
<div class="row"><div><label>Account</label><input id="a" value="CHEARB"></div><div><label>Sub1</label><input id="s1" value="yok"></div></div>
<button id="b" onclick="go()">Short Link</button>
<div class="err" id="e"></div>
<div class="res" id="rs"><div style="font-size:11px;color:#888">SHORTLINK</div>
<div class="rl" id="l" onclick="cp()"></div>
<button class="cb" id="cb" onclick="cp()">Copy Link</button>
<div class="jt" onclick="document.getElementById('j').style.display=document.getElementById('j').style.display==='none'?'block':'none'">JSON</div>
<div class="jb" id="j"></div></div>
<div class="ai">API: <code>GET /shorten?url=URL&account=X&sub1=Y</code> | <a href="/docs">Swagger</a></div>
</div><script>
async function go(){const u=document.getElementById('u').value.trim();if(!u)return;const b=document.getElementById('b');b.disabled=true;b.textContent='Loading...';document.getElementById('rs').style.display='none';document.getElementById('e').style.display='none';try{const r=await(await fetch('/shorten?'+new URLSearchParams({url:u,account:document.getElementById('a').value,sub1:document.getElementById('s1').value}))).json();if(r.error||r.detail)throw new Error(r.error||r.detail);document.getElementById('l').textContent=r.shortLink;document.getElementById('j').textContent=JSON.stringify(r,null,2);document.getElementById('rs').style.display='block'}catch(e){document.getElementById('e').textContent=e.message;document.getElementById('e').style.display='block'}finally{b.disabled=false;b.textContent='Short Link'}}
function cp(){navigator.clipboard.writeText(document.getElementById('l').textContent);const b=document.getElementById('cb');b.textContent='Copied!';setTimeout(()=>b.textContent='Copy Link',2000)}
document.getElementById('u').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
</script></body></html>"""


@app.get("/")
async def index(
    url: str | None = Query(None, description="Lazada product URL"),
    account: str = Query("", description="Account name"),
    sub1: str = Query("", description="Sub tracking ID"),
):
    if url:
        data = await shorten_link(url)
        return build_legacy_response(data, url, account, sub1)
    return HTMLResponse(INDEX_HTML)


@app.get("/shorten")
async def shorten(
    url: str = Query(..., description="Lazada product URL"),
    account: str = Query("", description="Account name"),
    sub1: str = Query("", description="Sub tracking ID"),
):
    d = await shorten_link(url)
    return build_legacy_response(d, url, account, sub1)


@app.get("/health")
async def health():
    try:
        out, _, rc = bu("get", "title", timeout=5)
        return {"status": "ok", "title": out}
    except Exception as e:
        return {"status": "error", "error": str(e)}


if __name__ == "__main__":
    print(f"Lazada Shortlink API: http://localhost:{PORT}")
    print(f"Swagger docs: http://localhost:{PORT}/docs")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
