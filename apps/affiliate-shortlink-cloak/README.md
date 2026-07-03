# affiliate-shortlink-cloak

Current local-only CloakBrowser + Playwright bridge for Shopee / Lazada affiliate shortlinks. It runs on the Mac mini at `http://127.0.0.1:8810` only; Cloudflare tunnel/domain operation has been removed from this machine.

| Bridge | Port | Browser | Multi-account |
|---|---|---|---|
| Cloak (active) | `8810` | CloakBrowser / Playwright persistent context (one dir per account) | Yes |

## Install

```bash
cd apps/affiliate-shortlink-cloak
npm install
# Playwright needs Chromium installed at least once
npx playwright install chromium
```

If `cloakbrowser` exposes a Playwright-compatible `chromium` (i.e. `chromium.launchPersistentContext`), the bridge uses it automatically. Otherwise it falls back to `playwright-core`'s `chromium`. The selected backend is reported by `/health` and `/debug` under `backend.source`.

## Run

```bash
npm start
# → [affiliate-shortlink-cloak] listening on http://127.0.0.1:8810
```

Overrides:

| Env var | Default |
|---|---|
| `AFFILIATE_CLOAK_PORT` | `8810` |
| `AFFILIATE_CLOAK_HOST` | `127.0.0.1` |
| `AFFILIATE_CLOAK_PROFILE_DIR` | `~/.affiliate-shortlink-cloak/profiles` |

The legacy Electron bridge on port `8800` is untouched.

## API

URL contract matches the existing bridge as closely as possible.

### `GET /` or `GET /shorten`

Auto-detects Shopee vs Lazada from the `url`. Pass `?platform=shopee|lazada` to force.

```
GET /?account=CHEARB&url=<shopee_or_lazada_url>&sub1=yok
GET /shorten?account=CHEARB&url=<shopee_or_lazada_url>&sub1=yok
GET /shorten?id=15142270000&url=<shopee_url>&sub1=yok
```

Shopee `id=` aliases select and validate the internal browser profile. Built-in aliases are:

- `id=15130770000` or `id=an_15130770000` -> profile/keychain `affiliate_chearb.com`, response `"account": "affiliate@chearb.com"`, expected `utm_source=an_15130770000`
- `id=15142270000` or `id=an_15142270000` -> profile/keychain `affiliate_neezs.com`, response `"account": "affiliate@neezs.com"`, expected `utm_source=an_15142270000`

When Shopee `id=` is present, it takes precedence over `account=`. If `account=` conflicts with the mapped id account, the bridge rejects the request before shortening. After Shopee returns a short link, the bridge resolves it and fails closed unless the resolved `utm_source` exactly matches the requested id.

Shopee shortening uses the Affiliate Portal home page (`https://affiliate.shopee.co.th/`) as the browser origin and calls Shopee's `batchCustomLink` API from that authenticated context. The old `/offer/custom_link` page can redirect to Affiliate Portal `/404`; when the bridge sees that route it navigates back to the portal home before calling the API. If Shopee still keeps the browser on `/404`, the response uses the readable reason `shopee_custom_link_route_not_found` instead of a misleading login-selector reason.

Incoming Shopee short URLs such as `https://s.shopee.co.th/...` are resolved first and the resolved canonical product URL is sent to Shopee `batchCustomLink`; the public response still preserves the original incoming `link` value.

When Shopee shortening detects a session/auth failure, `failCode: 3`, a redirect away from `affiliate.shopee.co.th` to the buyer/login site, or the route-not-found case above, the bridge uses the stored macOS Keychain credential for that `platform/account` to auto re-authenticate the same persistent profile and retries the shorten. If Shopee redirects the reauth browser to an already-authenticated Affiliate dashboard/root page, the retry keeps that authenticated context instead of discarding it with a fresh browser context. Shopee reauth opens Shopee buyer login with `next=https://affiliate.shopee.co.th/` rather than the obsolete Affiliate Portal login route. Passwords are never logged or returned. If no credential exists, CAPTCHA/OTP/manual verification blocks auto-login, or Shopee's API still rejects the authenticated retry, the JSON response keeps the existing manual-login contract and includes explicit flags:

```json
{
  "status": "manual_login_required",
  "error": "manual_login_required",
  "manualLoginRequired": true,
  "needsManual": true,
  "reason": "captcha_or_otp_detected",
  "platform": "shopee",
  "account": "CHEARB",
  "loginUi": "/login?platform=shopee"
}
```

Post-reauth Shopee API/session rejections use precise reasons such as `shopee_api_auth_rejected_after_authenticated_reauth`, `shopee_api_fail_code_3_after_reauth`, or `shopee_redirected_off_affiliate_after_reauth`, plus a sanitized `diagnostic` object and `debug: "/debug"`. If Playwright's `context.request` is rejected with HTTP 401/403, the bridge retries once through the authenticated page's in-origin browser transport using credentialed `XMLHttpRequest` so Shopee's in-page anti-bot hooks can attach their own request metadata before surfacing a manual-login response. Diagnostics include only safe classification fields such as `errorClass`, `reauthOk`, `reauthAlreadyAuthenticated`, and optional `apiTransport` classes; they must not include cookies, tokens, passwords, or raw credentials.

**Shopee response shape** (identical to the Electron bridge):
```json
{
  "link": "...", "longLink": "...", "originalLink": "...", "shortLink": "...",
  "id": "987654321",
  "utm_source": "an_987654321",
  "utm_content": "sub1-sub2-sub3-sub4-sub5",
  "account": "CHEARB",
  "sub1": "...", "sub2": "...", "sub3": "...", "sub4": "...", "sub5": "..."
}
```

**Lazada response shape** (identical to the Electron bridge):
```json
{
  "link": "...", "longLink": "...", "originalLink": "...", "shortLink": "...",
  "id": "123456789",
  "member_id": "123456789",
  "promotionCode": "...",
  "account": "CHEARB",
  "sub1": "..."
}
```

### `GET /click-report`

Returns the Shopee Affiliate **click_report** API as JSON for a given Shopee affiliate id and a single Asia/Bangkok local day. Reuses the same CloakBrowser persistent profile and session manager as `/shorten`, so it does not fight `/shorten` over the profile lock.

Two response modes:

- **Summary mode (default)** — aggregates click rows for the requested day into exact per-`sub_id`, Sub1, Sub2, and Sub3 breakdowns. For unfiltered requests the bridge probes `page_num=1&page_size=100`, recursively splits `click_time_s/e` windows whenever Shopee reports more than the 10,000-row page cap, then paginates each safe window without requesting beyond page 100. The response carries no raw `list`.
  - `breakdown_mode: "complete"` — set when row enumeration reached `total_count`. Entries use `count` and `percent`, and `percent` is the share of `total_count`.
  - `breakdown_mode: "filtered"` — set when the request includes `sub_id=<value>` without `complete=1`. Only page 1 is fetched and the response reports Shopee's server-side `total_count` for that sub.
  - If a one-second window still exceeds the cap, the response is a clear `status: "error"` / `reason: "click_report_window_too_dense"` with `truncated: true` instead of looping.
- **Raw mode** — `raw=1` or `mode=raw` preserves the existing one-page raw response honoring `page_num`/`page_size`. Use `raw=complete` (or `raw=1&complete=1`) to fetch complete raw rows using the same split-window strategy.

Query parameters:

| Param | Default | Notes |
|---|---|---|
| `id` | `15130770000` | Built-in alias (or `SHOPEE_ID_ACCOUNT_MAP` entry). Selects the persistent profile / Keychain account. `an_<digits>` is also accepted. |
| `time` | today (Asia/Bangkok) | Accepts `DD/MM/YYYY`, `YYYY-MM-DD`, `today`, or `yesterday`. The day is interpreted in Asia/Bangkok (UTC+7) and translated to `click_time_s` (00:00:00) / `click_time_e` (23:59:59) Unix seconds — no reliance on server local timezone. |
| `raw` / `mode` | _(unset)_ | `raw=1`, `raw=true`, or `mode=raw` switches to raw single-page mode. `raw=complete`, `mode=raw_complete`, or `mode=complete_raw` returns complete raw rows. `mode=complete` keeps summary mode and forces complete row enumeration even with filters. |
| `complete` | _(unset)_ | `complete=1` forces complete row enumeration. Combined with `raw=1`, it returns complete raw rows. |
| `page_num` (or `page`) | `1` | Raw mode only. Floored at `1`. Ignored in summary mode. |
| `page_size` | raw: `20` / summary: `100` | Raw mode honors caller-supplied value, clamped to `[1, 100]`. Summary mode always uses `100`. |
| `sub_id`, `click_id`, `click_region` | _(omitted)_ | Passed through to the Shopee API when non-empty. In summary mode, supplying `sub_id` triggers `breakdown_mode: "filtered"` unless `complete=1` is also supplied. |

The bridge resolves `id → account` using the same alias table as `/shorten` (so id `15130770000` → `affiliate_chearb.com`, id `15142270000` → `affiliate_neezs.com`). The persistent profile is opened headless and `fetch('/api/v1/click_report/list?...', { credentials: 'include' })` runs from the `affiliate.shopee.co.th` origin, just like the click report dashboard does.

Examples:

```
# Summary by default — daily total + sub_id breakdown for the chosen affiliate id
curl 'http://127.0.0.1:8810/click-report?id=15130770000&time=25/05/2026'
curl 'http://127.0.0.1:8810/click-report?time=26/05/2026'
curl 'http://127.0.0.1:8810/click-report?time=2026-06-09&complete=1'

# Summary filtered to a single sub_id (Shopee filters on the server side; summary aggregates the filtered rows)
curl 'http://127.0.0.1:8810/click-report?id=15130770000&time=25/05/2026&sub_id=16MAY26FBSPCAD'

# Raw mode — inspect Shopee rows verbatim, one page at a time
curl 'http://127.0.0.1:8810/click-report?id=15142270000&time=yesterday&raw=1&page_size=5'
curl 'http://127.0.0.1:8810/click-report?id=15142270000&time=2026-05-25&mode=raw&page_num=2'
curl 'http://127.0.0.1:8810/click-report?id=15130770000&time=2026-06-09&raw=complete'
```

**Summary response shape — `breakdown_mode: "complete"`** (small days where Shopee returns every row):

```json
{
  "status": "ok",
  "mode": "summary",
  "id": "15130770000",
  "account": "affiliate@chearb.com",
  "accountInternal": "affiliate_chearb.com",
  "time": "25/05/2026",
  "range": {
    "timezone": "Asia/Bangkok",
    "click_time_s": 1748102400,
    "click_time_e": 1748188799
  },
  "source": "shopee_click_report_api",
  "total_count": 3,
  "unique_sub_id_count": 2,
  "sub_ids": [
    { "sub_id": "yok", "count": 2, "percent": 66.67 },
    { "sub_id": "", "count": 1, "percent": 33.33 }
  ],
  "pages_fetched": 1,
  "page_size": 100,
  "row_sample_count": 3,
  "truncated": false,
  "breakdown_mode": "complete",
  "affiliate_id": "15130770000"
}
```

**Summary response shape — `breakdown_mode: "sample"`** (Shopee caps list pagination before `total_count`):

```json
{
  "status": "ok",
  "mode": "summary",
  "id": "15130770000",
  "account": "affiliate@chearb.com",
  "accountInternal": "affiliate_chearb.com",
  "time": "25/05/2026",
  "range": { "timezone": "Asia/Bangkok", "click_time_s": 1748102400, "click_time_e": 1748188799 },
  "source": "shopee_click_report_api",
  "total_count": 49774,
  "unique_sub_id_count": 3,
  "sub_ids": [
    { "sub_id": "16MAY26FBSPCAD----", "sample_count": 6500, "sample_percent": 65.00 },
    { "sub_id": "17MAY26FBSPCAD----", "sample_count": 2500, "sample_percent": 25.00 },
    { "sub_id": "",                    "sample_count": 1000, "sample_percent": 10.00 }
  ],
  "pages_fetched": 100,
  "page_size": 100,
  "row_sample_count": 10000,
  "truncated": true,
  "breakdown_mode": "sample",
  "warning": "Shopee list pagination caps before total_count is reached; per-sub_id breakdown reflects the fetched sample only. Use sub_id=<value> to get the exact count for one sub.",
  "affiliate_id": "15130770000"
}
```

**Summary response shape — `breakdown_mode: "filtered"`** (recommended for exact per-sub counts):

```json
{
  "status": "ok",
  "mode": "summary",
  "id": "15130770000",
  "account": "affiliate@chearb.com",
  "accountInternal": "affiliate_chearb.com",
  "time": "25/05/2026",
  "range": { "timezone": "Asia/Bangkok", "click_time_s": 1748102400, "click_time_e": 1748188799 },
  "source": "shopee_click_report_api",
  "total_count": 32247,
  "unique_sub_id_count": 1,
  "sub_ids": [
    { "sub_id": "16MAY26FBSPCAD----", "requested_sub_id": "16MAY26FBSPCAD", "count": 32247, "percent": 100 }
  ],
  "pages_fetched": 1,
  "page_size": 100,
  "row_sample_count": 100,
  "truncated": false,
  "breakdown_mode": "filtered",
  "affiliate_id": "15130770000"
}
```

`sub_ids` is sorted by count descending, with the `sub_id` string used as the ascending tiebreaker. The empty-string entry represents Shopee rows with no `sub_id`. Percentages are rounded to two decimals; with no rows they stay `0`. In `complete` mode entries use `count` + `percent` (share of `total_count`); in `sample` mode they use `sample_count` + `sample_percent` (share of the fetched row sample only) so the percentage cannot be mistaken for a share of `total_count`. `truncated` is `true` whenever Shopee's list pagination capped before `total_count` was reached or the 1000-page safety guard fired.

**Raw response shape** (`raw=1` / `mode=raw`):

```json
{
  "status": "ok",
  "mode": "raw",
  "id": "15142270000",
  "account": "affiliate@neezs.com",
  "accountInternal": "affiliate_neezs.com",
  "time": "25/05/2026",
  "range": {
    "timezone": "Asia/Bangkok",
    "click_time_s": 1748102400,
    "click_time_e": 1748188799
  },
  "page_num": 1,
  "page_size": 20,
  "total_count": 26437,
  "affiliate_id": "15142270000",
  "list": [
    { "click_id": "...", "click_time": 1748102500, "click_region": "TH", "sub_id": "yok", "referrer": "" }
  ],
  "source": "shopee_click_report_api"
}
```

Failure shapes (no cookies / tokens / passwords are ever included):

- Unknown / invalid `id` → HTTP `400` with `status: "error"`, `reason: "shopee_affiliate_id_unknown"` or `"shopee_affiliate_id_invalid"`.
- Invalid `time` → HTTP `400` with `status: "error"`, `reason: "click_report_time_invalid"`.
- Shopee responds with `code: 30001`, redirects to `shopee.co.th/buyer/login`, or returns HTTP `401`/`403` → `status: "manual_login_required"`, `reason: "shopee_login_required"` or `"shopee_unauthorized"`, plus `loginUi: "/login?platform=shopee"`.
- Browser/fetch transport failure → `status: "error"`, `reason: "click_report_fetch_failed"` (or `"click_report_invalid_json"`, `"click_report_empty_response"`).

Use the explicit local endpoint `GET http://127.0.0.1:8810/click-report`. Domain Host routing is disabled; reports are local-path only.

### `GET /login`

The single user-facing credential-saving page. Polished mobile-friendly card UI with a gradient background, platform dropdown (Shopee/Lazada), `username` + `password` inputs, a live "Account ที่จะใช้" preview, and a *remember in macOS Keychain* checkbox (checked by default).

The header shows **กำลัง login: Shopee/Lazada · account X** so it is always clear which credential will be saved; `account` is derived from `username` via `sanitizeAccount` (e.g. `affiliate@neezs.com` → `affiliate_neezs.com`). As the user types their username, the page calls `GET /api/credentials?platform=…&account=…` and shows a Keychain status card — either **มี credential ใน macOS Keychain แล้ว** (with a small "ลบ credential นี้" forget button that issues `DELETE /api/credentials?…`) or **ยังไม่มี credential**. The password is never displayed back, never written outside macOS Keychain, and never echoed into the DOM.

No `url` / `sub1` / advanced section, no `account` text field, no `/login/shopee` or `/login/lazada` links — the page is for saving credentials only. Success/error feedback uses a friendly Thai toast underneath the form.

Submit always goes to `POST /api/login` (credential-only). The legacy `POST /api/login-and-shorten` is not reachable from this page.

**Backward-compatible JSON behavior:** `GET /login?platform=shopee&account=CHEARB` still opens a headed browser window and returns the legacy JSON payload **when the client sends `Accept: application/json` or `?json=1`**. Add `&autofill=1` to make that JSON path read the macOS Keychain credential and attempt automatic username/password fill + submit without returning the secret. If the expected Keychain item is absent, the response status/reason is `keychain_credential_not_found` and includes safe metadata only: platform, account, service prefix, checked account aliases, and expected service names. Browser callers (those sending `Accept: text/html`) get the HTML form instead. For backward compatibility, the legacy `/login/shopee` and `/login/lazada` paths still 302-redirect to `/login?platform=…`.

### `POST /api/login`

Credential-save-only. JSON `{platform, username, password, remember?, account?}`. Validates `platform` / `username` / `password`; `account` is optional and is derived from `username` via `sanitizeAccount` when blank/missing. When `remember` is `true` (the default), the credential is saved to the macOS Keychain. Returns a JSON status payload and never echoes the password back in the response, error messages, or logs.

This endpoint does **not** open a browser window and does **not** call `attemptLogin(...)`. Actual login / re-auth automation happens later inside the shorten + auto-reauth flow, using the credentials saved here.

### `GET /accounts`

Lists known profile directories per platform plus any contexts currently loaded. It also includes `credentialPresence.accounts.<platform>.<account> = true|false` for known profile/loaded/Keychain accounts. This is presence-only and never returns usernames, passwords, cookies, or tokens.

### `GET /health`

Liveness + backend info.

### `GET /debug`

**Sanitized**: returns profile root, backend source, loaded contexts (platform/account/profileDir/page count/timestamps), pid, node version, and the recent redacted login diagnostics captured when auto re-auth needs manual help. Never returns cookies, tokens, passwords, or persisted auth.

When Shopee/Lazada auto-login cannot find or submit the live login form, the manual-login JSON may include a `diagnostic` object and `debug: "/debug"`. Diagnostics are safe evidence for debugging live pages: sanitized URL/domain, title, frame count, redacted text snippets, blocker markers, and input descriptors without field values.

## Multi-account profiles

Profiles are persisted at `<PROFILE_ROOT>/<platform>/<account>/`. Account names are sanitized (`[A-Za-z0-9._-]` only, capped at 64 chars). Empty/missing `account=` falls back to `default`. The profile dir is auto-created on first use.

Example:
```
~/.affiliate-shortlink-cloak/profiles/
├── shopee/
│   ├── CHEARB/      # cookies, local storage for CHEARB on Shopee
│   └── YOK/
└── lazada/
    └── CHEARB/
```

## Tests / smoke

```bash
npm run check        # node --check on every JS file in src + bin
npm test             # node --test on the offline suites
```

The tests are deliberately offline — they validate URL parsing, account sanitization, profile dir mapping, normalization, payload shape, and the sanitized `/debug` / `/health` / `/accounts` handlers without launching a real browser or calling Shopee/Lazada.

## Why a new app instead of patching the old one?

The Electron bridge is in production behind launchd/pm2 on port 8800. This new bridge is intentionally a side-by-side experiment so existing dashboards/video-onecard/video-affiliate callers keep working unchanged. Once it proves out, callers can move over by switching from `http://localhost:8800` to `http://localhost:8810`.

## What is reused from the legacy bridge

Pure-JS helpers now live inside this app (the legacy `apps/affiliate-shortlink/` app has been removed):

- URL normalization (`normalizeShopeeOriginalLink`, `normalizeLazadaOriginalLink`, `normalizeAffiliateId`)
- Tracking-link resolution (`resolveOriginalLink`, `resolveTrackingLink`, etc.)
- Payload builders (`buildShopeeShortlinkPayload`, `buildLazadaShortlinkPayload`)
- Member-id / utm extraction

The Lazada in-page MTOP script is loaded directly from `../affiliate-shortlink/lazada-shorten.js` (read-only) to keep both bridges using the same signing logic.

## Local-only operation

This Mac mini is the source of truth for shortlinks and reports. Use `http://127.0.0.1:8810` only. Do not run Cloudflare tunnel/domain LaunchAgents for this bridge. Removed runtime domain artifacts include `com.affiliate.customlink-wwoom.tunnel`, `com.affiliate.shortlink-cloak.tunnel`, `cloudflared/short-wwoom.yml`, and the tunnel LaunchAgent plist.

