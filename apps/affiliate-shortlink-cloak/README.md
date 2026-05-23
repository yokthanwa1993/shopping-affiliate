# affiliate-shortlink-cloak

Parallel CloakBrowser + Playwright bridge for Shopee / Lazada affiliate shortlinks. Runs alongside the existing Electron bridge at `apps/affiliate-shortlink/` — it does **not** modify or replace it.

| Bridge | Port | Browser | Multi-account |
|---|---|---|---|
| Electron (legacy) | `8800` | Electron `BrowserWindow` (one partition per platform) | No |
| Cloak (new) | `8810` | CloakBrowser / Playwright persistent context (one dir per account) | Yes |

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
```

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

Pure-JS helpers were ported (copied) into this app — the legacy `apps/affiliate-shortlink/main.js` is **not** modified:

- URL normalization (`normalizeShopeeOriginalLink`, `normalizeLazadaOriginalLink`, `normalizeAffiliateId`)
- Tracking-link resolution (`resolveOriginalLink`, `resolveTrackingLink`, etc.)
- Payload builders (`buildShopeeShortlinkPayload`, `buildLazadaShortlinkPayload`)
- Member-id / utm extraction

The Lazada in-page MTOP script is loaded directly from `../affiliate-shortlink/lazada-shorten.js` (read-only) to keep both bridges using the same signing logic.
