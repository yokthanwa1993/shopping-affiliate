# affiliate-shortlink-cloak-python

Minimal Python CloakBrowser prototype for the affiliate shortlink flow.

This is a parallel prototype, not production. It has no LaunchAgent, no
cloudflared tunnel, no auto-start, and no production wiring. It binds
`127.0.0.1:8811` by default, uses the separate profile root
`~/.affiliate-shortlink-cloak-python/profiles`, and does not touch the active
Node service on port `8810`.

`/shorten` validates the request, opens the headed persistent CloakBrowser
context, and attempts a real Shopee Affiliate `batchCustomLink` GraphQL call
from the logged-in browser session. This remains a test-only sidecar: no
LaunchAgent, no cloudflared tunnel, no auto-start, and no production wiring.

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
| `PROFILE_ROOT` | `~/.affiliate-shortlink-cloak-python/profiles` |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and non-secret config summary |
| `GET` | `/accounts` | Known Shopee account aliases |
| `GET` | `/login?platform=shopee&account=affiliate_chearb.com` | Open headed CloakBrowser at `https://affiliate.shopee.co.th/offer/custom_link` |
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
