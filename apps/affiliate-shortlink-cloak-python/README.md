# affiliate-shortlink-cloak-python

Minimal Python CloakBrowser prototype for the affiliate shortlink flow.

This is a parallel prototype, not production. It has no LaunchAgent, no
cloudflared tunnel, no auto-start, and no production wiring. It binds
`127.0.0.1:8811` by default, uses the separate profile root
`~/.affiliate-shortlink-cloak-python/profiles`, and does not touch the active
Node service on port `8810`.

`/shorten` validates the request and attempts a real Shopee Affiliate
`batchCustomLink` GraphQL call from the logged-in browser session. This remains a
test-only sidecar: no LaunchAgent, no cloudflared tunnel, no auto-start, and no
production wiring.

### Request-first hot path (legacy Node baseline parity)

The primary transport for both `/shorten` and the report routes is Playwright's
`BrowserContext.request` APIRequestContext, which reuses the persistent profile's
logged-in cookies. This mirrors the old stable Node baseline (`c63c3306`):

- `/shorten` POSTs `batchCustomLink` via `context.request.post(...)` — **no
  visible tab is created and no navigation happens** on the hot path. Only when
  that request reports a login/session/403-style failure does it fall back once
  to the gate-aware in-page path (which never re-navigates a login/captcha gate,
  so Shopee is never hammered).
- The report routes GET the Shopee report API via `context.request.get(...)`
  instead of an in-page `page.evaluate`, so thousands of report fetches never
  reload the visible custom_link tab (which was tripping reCAPTCHA).
- Manual `/login` (`open_shopee_custom_link`) may still open a visible page.
- If the browser was closed, the next hot-path request relaunches the persistent
  context cleanly (stale/closed context records are cleared) and uses the request
  API — no `cloakbrowser_launch_failed` unless a real launch fails.

Cookies, CSRF values, and tokens are never surfaced in any response.

### Local-only

This is a Mac-local sidecar. There is no tunnel config change; the server still
binds `127.0.0.1`/`::1` (default port `8811`, overridable via `PORT`). Agents and
the MCP tools reach the bridge at `http://127.0.0.1:8810`
(`AFFILIATE_SHORTLINK_BRIDGE_URL`, the active local service) — everything stays
on loopback and no public domain / tunnel testing is required.

The HTTP server uses only the Python standard library. The optional
`cloakbrowser` import is lazy and happens only when `/login` or `/shorten`
actually launches a browser. The prototype does not use autofill, Keychain,
stored tokens, cookies, or secrets.

## Run

```bash
cd apps/affiliate-shortlink-cloak-python
./scripts/run_dev.sh
```

Equivalent direct command:

```bash
PYTHONPATH=src python3 -m affiliate_shortlink_cloak_python.server
```

Environment overrides:

| Var | Default |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `8811` |
| `PROFILE_ROOT` | `~/.affiliate-shortlink-cloak-python/profiles` (CloakBrowser) / `~/.stealth-browser-mcp/profiles` (Stealth) |
| `AFFILIATE_SHORTLINK_BROWSER_BACKEND` | *(unset)* → default CloakBrowser backend |

## Stealth / nodriver backend (opt-in, test-only)

A side-by-side **Stealth Browser (nodriver)** backend can be selected instead of
the default CloakBrowser/Playwright backend. It is **fully opt-in**: if the
backend env is not set, behavior on port `8811` is unchanged. It exists only to
make the already-installed Stealth Browser profile usable for Shopee shortlink
creation; it does **not** touch the production Node service on port `8810`.

> **Test-only.** No LaunchAgent, no cloudflared tunnel, no auto-start, and no
> production replacement. It binds `127.0.0.1:8811` like the default backend and
> is intended for a single manual verification run, not a service.

### What it does

- `/login` opens a headed Stealth/nodriver Chrome at
  `https://affiliate.shopee.co.th/offer/custom_link` using a **persistent
  per-account profile directory** and leaves it open for **manual** login
  (no autofill, no secrets).
- `/shorten` reuses that same authenticated profile/tab and runs Shopee's
  `batchCustomLink` GraphQL via an **in-page `fetch`** from
  `affiliate.shopee.co.th` — no raw HTTP requests and no static anti-fraud
  headers (the browser's own headers + cookie-derived CSRF are used).
- The report routes (`/conversion-report`, `/daily-income-report` /
  `/income-report`, `/click-report`) work under this backend too: each report
  page GETs the Shopee report API via an **in-page `fetch` with
  `credentials: 'include'`** from the already-open affiliate tab (the same
  per-account Stealth profile the shortlink flow uses, resolved through the id/
  account profile map). The affiliate tab is **not** re-navigated for every
  report page — it navigates at most once, only to establish the affiliate
  origin on a blank/off-affiliate tab.
- Cookies, CSRF values, and tokens are never surfaced in any response. A session
  parked on a Shopee login/captcha gate (or any off-affiliate origin) fails
  closed — shortlink with `manualLoginRequired`, reports with the sanitized
  `manual_login_required` payload — instead of re-hammering Shopee. If the
  Stealth Chrome is alive but has lost its usable tab (nodriver
  `RuntimeError: coroutine raised StopIteration`), the sidecar relaunches the
  browser once and otherwise returns a JSON error rather than dropping the HTTP
  connection.

### Backend env vars

| Var | Purpose |
| --- | --- |
| `AFFILIATE_SHORTLINK_BROWSER_BACKEND` | Set to `stealth` (or `python-stealth-nodriver`) to select the Stealth backend. `BACKEND` is a legacy fallback for the same value. |
| `PROFILE_ROOT` | Stealth profile root. Defaults to `~/.stealth-browser-mcp/profiles` **only** when the Stealth backend is selected. |
| `AFFILIATE_STEALTH_ACCOUNT_PROFILE_MAP` | Maps a Shopee id / account alias to a flat profile directory **name** under the profile root, e.g. `15130770000=shopee-login-test`. Comma/semicolon/newline separated. |
| `AFFILIATE_STEALTH_SITE_PACKAGES` | Optional. Absolute path to a `site-packages` dir that contains `nodriver`, injected onto `sys.path` at launch. Only needed if you run under a Python that does not already have `nodriver`. |
| `AFFILIATE_STEALTH_HEADLESS` | Optional. `1`/`true` to run headless (default headed, so manual login works). |

### Run (Stealth sidecar on 8811)

`nodriver` lives in the Stealth Browser repo venv (Python 3.12), so the simplest
command runs this sidecar under that venv's Python:

```bash
cd apps/affiliate-shortlink-cloak-python
AFFILIATE_SHORTLINK_BROWSER_BACKEND=stealth \
AFFILIATE_STEALTH_ACCOUNT_PROFILE_MAP='15130770000=shopee-login-test' \
PYTHONPATH=src \
/Users/yok-macmini/SupportRepos/stealth-browser-mcp/.venv/bin/python \
  -m affiliate_shortlink_cloak_python.server
```

Then, for the id `15130770000` (chearb) test profile:

```bash
# Open the headed Stealth profile for manual login (leaves the browser open):
curl 'http://127.0.0.1:8811/login?platform=shopee&id=15130770000'

# Reuse the logged-in profile to create a real Shopee shortlink:
curl 'http://127.0.0.1:8811/shorten?id=15130770000&url=https://shopee.co.th/product/1/2&sub1=TEST'

# Reports run against the same logged-in Stealth profile:
curl 'http://127.0.0.1:8811/conversion-report?id=15130770000&time=today'
curl 'http://127.0.0.1:8811/click-report?id=15130770000&time=today'
curl 'http://127.0.0.1:8811/daily-income-report?id=15130770000&time=today'
```

Alternatively, run under this app's own Python and point it at the Stealth
`site-packages` so `nodriver` is importable:

```bash
cd apps/affiliate-shortlink-cloak-python
AFFILIATE_SHORTLINK_BROWSER_BACKEND=stealth \
AFFILIATE_STEALTH_ACCOUNT_PROFILE_MAP='15130770000=shopee-login-test' \
AFFILIATE_STEALTH_SITE_PACKAGES='/Users/yok-macmini/SupportRepos/stealth-browser-mcp/.venv/lib/python3.12/site-packages' \
PYTHONPATH=src python3 -m affiliate_shortlink_cloak_python.server
```

> ⚠️ **Warning:** This Stealth backend is a manual test path only. Do not add a
> LaunchAgent, tunnel, or auto-start for it, and do not treat it as a replacement
> for the production port `8810` service.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and non-secret config summary |
| `GET` | `/accounts` | Known Shopee account aliases |
| `GET` | `/login?platform=shopee&account=affiliate_chearb.com` | Open headed CloakBrowser at `https://affiliate.shopee.co.th/offer/custom_link` |
| `GET` | `/login-ui?account=...&url=...` | Local-only compatibility form that posts JSON to `/api/login-and-shorten` |
| `GET` | `/login/shopee`, `/login/lazada` | Legacy 302 compatibility redirects to `/login?platform=...` |
| `POST` | `/api/login` | Compatibility JSON route; credential storage is not implemented in Python and fails closed without echoing credentials |
| `POST` | `/api/login-and-shorten` | Compatibility JSON route that derives `id`/`account`/`url`/`sub1..sub5` and calls the existing Shopee shortlink flow |
| `GET` | `/shorten?id=15130770000&url=https://...&sub1=...` | Attempt real Shopee `batchCustomLink` shortening from the opened browser session |
| `GET` | `/conversion-report?id=15130770000&time=DD/MM/YYYY` | Shopee conversion report; summary (per-`sub_id` counts) by default, `raw=1`/`mode=raw` returns one page of raw rows |
| `GET` | `/daily-income-report?ids=15130770000,15142270000&time=today` | Multi-account daily income from Shopee `dashboard/detail`; also `/income-report` |
| `GET` | `/click-report?id=15130770000&time=DD/MM/YYYY` | Shopee click report; summary (`sub_id`/`sub1`/`sub2`/`sub3` breakdown), `raw=1` single page, `raw=complete` full enumeration |

### Report routes

Ported from the legacy Node `affiliate-shortlink-cloak` service. All report
fetches reuse the same per-account CloakBrowser profile as `/shorten` (no stored
tokens, cookies, or secrets in responses). If Shopee is gated by login/captcha,
the report fails closed with a sanitized `manual_login_required` payload plus
`loginUi: /login?platform=shopee`.

`/daily-income-report` / `/income-report` use `BrowserContext.request` first.
If Shopee returns HTTP 401/403 only for `/api/v3/dashboard/detail`, the Python
sidecar falls back once to the legacy page-context fetch: it reuses the existing
affiliate tab without reloading it, or navigates a blank/new tab once to
establish the affiliate origin. Other report endpoints do not page-fallback on
401/403.

- **Accounts / id:** `id` (or `an_<id>`) selects the account; default
  `15130770000`. Daily income accepts `ids=15130770000,15142270000`.
- **Dates:** `time` accepts `today`, `yesterday`, `DD/MM/YYYY`, or `YYYY-MM-DD`,
  resolved against the Asia/Bangkok day (00:00:00 – 23:59:59).
- **Host aliases:** `GET /` on Host `conversionreport.wwoom.com` maps to
  `/conversion-report`; Host `clickreport.wwoom.com` maps to `/click-report`.
- **Paging:** conversion `raw` mode honors `page`/`page_num` and `page_size`
  (1–100, default 20); summary/complete modes force `page_size=100` from page 1.

`/shorten` supports optional `sub1` through `sub5` query params. Each value is
sanitized to alphanumeric characters and capped at 64 characters before it is
sent as `advancedLinkParams.subId1` through `subId5`.

On success, `/shorten` returns `status: "ok"` with `shortLink`, `longLink`,
`originalLink`, `account`, `id`, `utm_source`, `profileDir`, and safe browser
URL metadata. If Shopee login/session/captcha blocks the call, it fails closed
with `manualLoginRequired`, `needsManual`, `reason`, `currentUrl`, `account`,
and `profileDir`. Cookies, CSRF values, and tokens are never returned.

## MCP server (Hermes tools)

A pure-Python MCP stdio server exposes the same bridge endpoints as tools so a
Hermes profile can call tools instead of raw URL endpoints. It lives in
`affiliate_shortlink_cloak_python.mcp_server` and calls the local bridge over
stdlib `urllib` (no third-party HTTP client). The only optional dependency is
`mcp` (`FastMCP`), imported lazily.

Install and run with Python 3.10+ (the `mcp` package does not support macOS system Python 3.9):

```bash
cd apps/affiliate-shortlink-cloak-python
python3.11 -m pip install --upgrade pip
python3.11 -m pip install -e '.[mcp]'
affiliate-shortlink-cloak-mcp          # console entry point
# or, equivalently:
PYTHONPATH=src python3.11 -m affiliate_shortlink_cloak_python.mcp_server
```

The server targets the local bridge base URL from `AFFILIATE_SHORTLINK_BRIDGE_URL`
(default `http://127.0.0.1:8810`, i.e. the active Node service). Optional
`AFFILIATE_SHORTLINK_BRIDGE_TIMEOUT` sets the per-request timeout (default `30`).

### Tools

| Tool | Bridge endpoint |
| --- | --- |
| `health()` | `/health` |
| `accounts()` | `/accounts` |
| `create_shopee_shortlink(url, id='15130770000', sub1..sub5='')` | `/shorten` |
| `get_conversion_report(id, time, raw, page, page_size, sub_id, order_id, checkout_id, conversion_id, order_status, conversion_status)` | `/conversion-report` |
| `get_daily_income_report(id, ids, time)` | `/daily-income-report` |
| `get_click_report(id, time, raw, page, page_size, sub_id)` | `/click-report` |
| `open_manual_login(id='15130770000', no_autofill=True)` | `/login?json=1&platform=shopee&account=<mapped>&noAutofill=1&autofill=0` |

`id` accepts `15130770000` (chearb) or `15142270000` (neezs). Every response is
passed through a redactor that strips cookie / access-token / CSRF fields before
it leaves the process, and the server never retries: a `manual_login_required` /
captcha payload from Shopee is returned verbatim (sanitized) so it never
re-hammers Shopee.

### Hermes profile `cgo` config

Add the server to the `cgo` profile's MCP config (adjust the absolute path):

```json
{
  "mcpServers": {
    "affiliate-shortlink-cloak": {
      "command": "affiliate-shortlink-cloak-mcp",
      "args": [],
      "env": {
        "AFFILIATE_SHORTLINK_BRIDGE_URL": "http://127.0.0.1:8810"
      }
    }
  }
}
```

If the console script is not on `PATH`, use the module form instead:

```json
{
  "mcpServers": {
    "affiliate-shortlink-cloak": {
      "command": "python3.11",
      "args": ["-m", "affiliate_shortlink_cloak_python.mcp_server"],
      "env": {
        "PYTHONPATH": "/Users/yok-macmini/Developer/shopping-affiliate/apps/affiliate-shortlink-cloak-python/src",
        "AFFILIATE_SHORTLINK_BRIDGE_URL": "http://127.0.0.1:8810"
      }
    }
  }
}
```

Restart Hermes (reload the `cgo` profile) after editing the config so the new
MCP server is picked up.

## Known Shopee Aliases

| Shopee id | account | utm_source | display |
| --- | --- | --- | --- |
| `15130770000` | `affiliate_chearb.com` | `an_15130770000` | `affiliate@chearb.com` |
| `15142270000` | `affiliate_neezs.com` | `an_15142270000` | `affiliate@neezs.com` |

## Tests

```bash
./scripts/smoke_local.sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Tests use `unittest` and never launch a browser.
