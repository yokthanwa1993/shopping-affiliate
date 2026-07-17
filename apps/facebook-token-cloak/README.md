# facebook-token-cloak

Side-by-side local Facebook token bridge for CloakBrowser + macOS Keychain.

> **Facebook Lite token generation was removed from this service (2026-07-17 cutover).**
> Facebook Lite (EAAD6V) token minting now lives ONLY in the IDLogin/IDBridge stack: the IDLogin
> app stores credentials in the iOS Keychain and the receiver (port 8799) mints in-memory and
> profile-syncs page tokens to the video-affiliate Worker. This service no longer mints, enumerates,
> or auto-syncs Facebook Lite tokens. The Facebook Lite mint routes (`/token/auto-sync`,
> `/token/import-pages`) and the Facebook Lite branches of `/token/export`, `GET /token`, `GET /pages`,
> `POST /post`, `POST /page-comment` now **fail closed with `410 facebook_lite_removed`**. Everything
> below is preserved for **Power Editor / Meta Ads / Accounts Bridge / CloakBrowser browser sessions**
> only. The `page_posting_facebook_lite` role name is retained (it labels Accounts-Bridge config and
> the profile archive path); it no longer implies this service mints a Facebook Lite token.

- Binds only to `127.0.0.1`.
- Default port: `8820`.
- Profile root: `~/.facebook-token-cloak/profiles`.
- Keychain service prefix: `com.affiliate.facebook-token-cloak`.
- No raw tokens/passwords/TOTP/cookies/datr are logged or returned by default.
- `/token/export` is dry-run by default (no writes). A `dryRun:false` export is **local-only**: it resolves the page-scoped token from the logged-in session in memory and pushes it to the Worker `/api/pages/profile-sync` route (secret-authed); it never returns or logs the raw token.

## Run

```sh
npm --prefix apps/facebook-token-cloak start
```

## Browser backend selection (CloakBrowser vs Stealth) — opt-in

By default the bridge uses the **CloakBrowser** backend (`browser.js`), and `GET /health`
reports `"backend":"cloakbrowser"`. There is an **opt-in** alternative **Stealth Browser**
backend (nodriver / Stealth Browser MCP, like the Shopee 8811 sidecar) that ATTACHES to an
already-running, already-authenticated Chromium over its Chrome DevTools (CDP) endpoint using
`playwright-core`'s `chromium.connectOverCDP`. Both backends feed the same
`resolveSessionToken → graphFetch → /update-cta` code path, so token extraction and CTA edits
behave identically and stay fail-closed (`token_not_found` / `no_session`).

The Stealth path is selected **only** when an env var explicitly asks for it — otherwise the
default is unchanged and the production `8820` LaunchAgent is untouched. It never launches a
profile, autofills, submits a login, or drives a checkpoint/CAPTCHA; manual/visible login stays
the operator's job inside the Stealth browser.

Env vars (module `src/stealthBrowser.js`):

| Env | Meaning |
|-----|---------|
| `FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND` | `stealth` (aliases: `nodriver`, `stealth-browser-mcp`, …) selects Stealth. Anything else / unset → `cloakbrowser`. |
| `ACCOUNTS_BRIDGE_BROWSER_BACKEND` | Fallback selector, only used when the primary is empty. |
| `FACEBOOK_TOKEN_CLOAK_STEALTH_CDP_URL` | Default CDP endpoint (e.g. `http://127.0.0.1:9222`) to attach to when no per-account mapping matches. |
| `FACEBOOK_TOKEN_CLOAK_STEALTH_ACCOUNT_CDP_MAP` | Per-account `key=endpoint` map, comma-separated, e.g. `100090320823561=http://127.0.0.1:9222`. |

Fail-closed codes when misconfigured/unreachable (never a fake success): `stealth_cdp_endpoint_missing`,
`stealth_cdp_connect_failed`, `stealth_cdp_context_missing`, `stealth_playwright_missing`.

### Side-by-side Stealth instance (does NOT disturb the 8820 LaunchAgent)

Run a second local instance on a different port with the Stealth backend, pointed at the
running Stealth browser's CDP endpoint. First start the Stealth Browser / nodriver Chromium
with remote debugging (e.g. `--remote-debugging-port=9222`) and log in manually to the
`ads_power_editor` account (`100090320823561`). Then:

```sh
PORT=8821 \
FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND=stealth \
FACEBOOK_TOKEN_CLOAK_STEALTH_ACCOUNT_CDP_MAP='100090320823561=http://127.0.0.1:9222' \
npm --prefix apps/facebook-token-cloak start
```

Smoke it (8821 stays isolated from 8820):

```sh
curl http://127.0.0.1:8821/health                          # expect "backend":"stealth"
curl 'http://127.0.0.1:8821/pages?account=100090320823561' # expect page 1008898512617594 in data[]
curl -X POST http://127.0.0.1:8821/update-cta \
  -H 'Content-Type: application/json' \
  -d '{"account":"100090320823561","page_id":"1008898512617594","story_id":"1008898512617594_1220849613553068","final_cta_link":"https://s.shopee.co.th/7prNYwcQ4p"}'
```

If the Stealth session is not logged in / has no user token, `/update-cta` fails closed with
`{"ok":false,"step":"session","error":"no_session"}` (no token is ever leaked).

## Web console (UI)

Once running, open the local console in a browser:

```
http://127.0.0.1:8820/
```

The console is the **Accounts Bridge** — a single static page (no build step, no
external CDNs) and an **API-first, thin status/config view**. It shows which
Facebook accounts/users exist in the local system and lets you add, edit, and
delete them plus configure account roles. **Opening the page never logs in,
refreshes a token, opens Chrome/Ads Manager, or submits credentials** — `init()`
runs only token-free status reads (`GET /accounts`, `GET /accounts/bridge/facebook`).
All side-effecting actions run through the explicit APIs below so ops/Hermes can
drive inspect/fix/do steps on demand. The browser UI saves through the app's own
macOS Generic Keychain provider (`generic-keychain`); it does not offer
macOS Passwords.app selection.

Sections:

1. **Accounts in this system** — alias/namespace, username/email hint, and
   present/missing pills for credential, 2FA, and token/session status.
2. **Add / edit account** — alias/namespace, username/email/phone, and the
   write-only secret fields (password and 2FA seed/code).
3. **Account roles (status / config)** — map which saved account plays each
   Facebook role. Role names are retained (`page_posting_facebook_lite`,
   `ads_power_editor`) but this service only serves the Power Editor / Ads /
   browser-session side; Facebook Lite token minting moved to IDLogin/IDBridge.
   Saving a role is config only; "Check roles (dry run)" is token-free and opens
   no browser.
4. **Status** — Save shows only redacted status. There is no Facebook Lite token
   reveal/export here anymore (a Facebook Lite request fails closed with
   `410 facebook_lite_removed`) and no datr tools.

### Safety model

- **Secrets are write-only.** Password and 2FA seed/code can be entered or
  replaced but are never returned by the API or shown in the UI — only a present
  / not-set status. They are stored exclusively in the macOS Keychain (Generic
  Passwords) under `com.affiliate.facebook-token-cloak.*`.
- **Username/email/phone hints and the alias/domain are non-secret** and may be
  shown so you can tell which user is in the local system.
- The **non-secret account registry** lives outside git at
  `~/.facebook-token-cloak/registry.json` (mode `0600`, override with
  `FACEBOOK_TOKEN_CLOAK_REGISTRY_CONFIG`). It contains only alias, display name,
  provider, username/email/phone hint, domain/server, and the convert-token-mode
  label — never a password, token, cookie, secret, or datr value (such fields are
  rejected). The UI sends `provider: "generic-keychain"` for account saves.
- All management endpoints (`/`, `/accounts*`, `/accounts/bridge/*`,
  `/keychain/*`, `/accounts/selector`) are localhost-only.
- **Browser login is disabled by default.** `GET /login` returns `410
  browser_login_disabled` unless `FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED=1`.
  Token recovery for posting/comments is automatic and machine-to-machine; the
  console never drives it.
- The served HTML is fully static (no account data is server-rendered), and the
  client renders all values with `textContent`, so account values cannot inject
  markup. A strict `Content-Security-Policy` is sent with the page.

### Account endpoints

List accounts (redacted status, no secrets):

```sh
curl http://127.0.0.1:8820/accounts
```

Create/update an account. Non-secret metadata is saved to the registry; any
secret provided is routed straight to the Keychain. The browser UI uses the
simple Generic Keychain path:

```sh
curl -X POST http://127.0.0.1:8820/accounts \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","displayName":"Chearb Page","provider":"generic-keychain","username":"[REDACTED_USERNAME]","domain":"facebook.com","convertTokenMode":"postcron-oauth","password":"[REDACTED]","totp":"[REDACTED]","datr":"[REDACTED]"}'
```

Delete an account (also purges its Keychain secrets and selector by default; pass
`purgeSecrets=false` to keep them):

```sh
curl -X DELETE 'http://127.0.0.1:8820/accounts?account=CHEARB'
```

Store / check / delete the datr (machine_id) cookie in the Keychain:

```sh
curl -X POST http://127.0.0.1:8820/keychain/datr \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","datr":"[REDACTED]"}'
curl 'http://127.0.0.1:8820/keychain/datr?account=CHEARB'   # {"datrPresent":true|false}
curl -X DELETE 'http://127.0.0.1:8820/keychain/datr?account=CHEARB'
```

### Accounts Bridge endpoints (account-role config / status)

API-first surface for configuring and inspecting account roles. All responses are
**token-free** (no raw token, `accessToken`, or secret is ever returned) and none
of these calls open a browser or mint/refresh a token.

Page posting (Facebook Lite / Token Bridge) and ad creation (Power Editor) are
kept conceptually separate by role name: `page_posting_facebook_lite` and
`ads_power_editor`.

Overall status — Shopee + Facebook sections plus configured roles:

```sh
curl http://127.0.0.1:8820/accounts/bridge/status
```

Facebook role mapping + readiness summary (from cached/local metadata only):

```sh
curl http://127.0.0.1:8820/accounts/bridge/facebook
```

Set the role mapping (account must already exist; pass `""` to clear a role):

```sh
curl -X POST http://127.0.0.1:8820/accounts/bridge/facebook \
  -H 'Content-Type: application/json' \
  -d '{"page_posting_facebook_lite":"CHEARB","ads_power_editor":"ADSPAGE"}'
```

Explicit operator check (defaults to `dry_run:true` — status-only, no browser). A
browser opens only with `dry_run:false` **and** `open_browser:true` while
`FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED=1`; even then it never autofills or
submits credentials:

```sh
curl -X POST http://127.0.0.1:8820/accounts/bridge/facebook/check \
  -H 'Content-Type: application/json' \
  -d '{"role":"page_posting_facebook_lite","account":"CHEARB"}'
```

The role mapping persists in a non-secret file outside git at
`~/.facebook-token-cloak/bridge-config.json` (mode `0600`, override with
`FACEBOOK_TOKEN_CLOAK_BRIDGE_CONFIG`). It stores account aliases only — never a
password, token, cookie, secret, or datr value (such fields are rejected).

## macOS LaunchAgent

The LaunchAgent runs the same local service command from this app path and keeps the server bound to `127.0.0.1:8820`. The plist template is `launchd/com.affiliate.facebook-token-cloak.plist`; logs go to:

- `/Users/yok-macmini/Library/Logs/facebook-token-cloak.log`
- `/Users/yok-macmini/Library/Logs/facebook-token-cloak.err.log`

Install copies the plist to `~/Library/LaunchAgents/`, creates the log directory, and validates the plist. It does not start the service by default.

```sh
npm --prefix apps/facebook-token-cloak run launchd:install
```

Starting is explicit:

```sh
npm --prefix apps/facebook-token-cloak run launchd:start
```

Check launchd state, port `8820`, and relevant pids:

```sh
npm --prefix apps/facebook-token-cloak run launchd:status
```

Stop only this LaunchAgent label:

```sh
npm --prefix apps/facebook-token-cloak run launchd:stop
```

Stop and remove the installed plist:

```sh
npm --prefix apps/facebook-token-cloak run launchd:uninstall
```

Do not paste Facebook passwords, tokens, cookies, or 2FA values into commands, logs, docs, or chat. Use `[REDACTED]` when documenting examples.

## Store credentials in Keychain

```sh
curl -X POST http://127.0.0.1:8820/keychain/credential \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","username":"[REDACTED_USERNAME]","password":"[REDACTED]"}'
```

Optional TOTP seed:

```sh
curl -X POST http://127.0.0.1:8820/keychain/totp \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","secret":"[REDACTED]"}'
```

Open login browser profile (**disabled by default** — returns `410
browser_login_disabled` unless `FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED=1`; the
console never calls this on load):

```sh
FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED=1 \
curl 'http://127.0.0.1:8820/login?account=CHEARB&visible=1&autofill=0&submit=0'
```

## Legacy Apple Passwords backend support

The backend still has Apple Passwords endpoints for legacy/manual diagnostics,
but the browser UI no longer offers or uses this provider. The reliable path is
to store the credential through this app's Generic Keychain account flow.

The service auto-detects common Facebook Passwords domains when no domain/server is provided: `facebook.com`, `www.facebook.com`, `m.facebook.com`, and `login.facebook.com`. It selects a credential only when exactly one usable item is found.

Check only redacted provider status:

```sh
curl 'http://127.0.0.1:8820/passwords/status?account=CHEARB'
```

Open the login browser profile and autofill from Passwords app:

```sh
curl 'http://127.0.0.1:8820/login?account=CHEARB&provider=apple-passwords&visible=1&autofill=1'
```

If multiple usable Passwords items are found, pass a domain/server or username lookup hint. Responses still do not include the raw username or password:

```sh
curl 'http://127.0.0.1:8820/login?account=CHEARB&credentialProvider=apple-passwords&domain=facebook.com&username=%5BREDACTED_USERNAME%5D&visible=1&autofill=1'
```

ถ้ามี Facebook หลาย account ใน macOS Passwords ให้ save selector ต่อ local alias ได้. App จะเก็บแค่ username hint/domain เป็นตัวเลือกที่ `~/.facebook-token-cloak/accounts.json` หรือ path จาก `FACEBOOK_TOKEN_CLOAK_ACCOUNTS_CONFIG`; password ยังอยู่ใน macOS Passwords และไม่ถูกเก็บในไฟล์นี้.

Save selector:

```sh
curl -X POST http://127.0.0.1:8820/accounts/selector \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","credentialProvider":"apple-passwords","domain":"facebook.com","username":"[REDACTED_USERNAME]"}'
```

Check redacted selector status:

```sh
curl 'http://127.0.0.1:8820/accounts/selector?account=CHEARB'
```

Remove selector:

```sh
curl -X DELETE 'http://127.0.0.1:8820/accounts/selector?account=CHEARB'
```

After selector is saved, `/passwords/status?account=CHEARB` and `/login?account=CHEARB&provider=apple-passwords` use only that selected Passwords item. Explicit `domain`, `server`, `protocol`, or `username` query params still override the selector.

When the browser is visible, screenshots may show Facebook pages, notifications, or a current 2FA challenge. A visible 6-digit 2FA code is a temporary login code, not a TOTP seed; do not paste it into chat or store it in repo/wiki notes.

Refresh token from existing browser session:

```sh
curl -X POST http://127.0.0.1:8820/token/refresh \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","visible":false}'
```

Default response returns only `tokenPresent`, redacted `tokenPrefix`, `pagesCount`, and sanitized `id/name/category/hasToken`. `includeToken=true` is localhost-only manual debug.

Dry-run export (default — previews what would be pushed, no writes):

```sh
curl -X POST http://127.0.0.1:8820/token/export \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","target":"video-affiliate","dryRun":true}'
```

Live export (local-only — resolves the page token and pushes it into the Worker namespace token
pool). Requires `namespaceId` + `pageId`, and a sync secret in the env:
`BRIDGE_TOKEN_SYNC_SECRET` (preferred) or `TAG_SYNC_PUSH_SECRET` / `BROWSERSAVING_TAG_SYNC_SECRET`.
The Worker URL defaults to `https://api.pubilo.com` and can be overridden with `workerUrl` or
`VIDEO_AFFILIATE_WORKER_URL` / `WORKER_URL`. The response is token-free
(`ok/synced/status/page_id/namespace_id/worker_status/profile_sync_success/page_found/hasToken/account`):

```sh
curl -X POST http://127.0.0.1:8820/token/export \
  -H 'Content-Type: application/json' \
  -d '{"account":"100090320823561","namespaceId":"<ns>","pageId":"<page_id>","dryRun":false}'
```

The live exporter resolves the requested page through the **same cookie-bound `session.graphFetch`
semantics as `GET /pages`** (the logged-in CloakBrowser / Ads Manager client), not a bare server
fetch — a plain fetch with only the user token misses Ads-Manager-derived sessions, which is why
`/pages` could see the page while the exporter returned `page_not_found`. If the requested
`account` cannot resolve the page (no session, page not administered, or no page token), the
exporter retries **once** with the default posting account (`FACEBOOK_TOKEN_CLOAK_POST_ACCOUNT`,
default `content_paiya`), whose session lists every administered page. The fallback is adopted only
when it gets strictly further, and the token-free `account` field reports the **effective** account
that produced the token. Unresolvable requests still return `no_session` / `page_not_found` /
`page_token_unavailable` and never push.

When no sync secret is configured a live export returns `{ ok:false, status:"sync_secret_missing" }`
(it never prompts and never writes). The matching Worker route accepts either
`BRIDGE_TOKEN_SYNC_SECRET` or `TAG_SYNC_PUSH_SECRET` as the `x-tag-sync-secret` header.

## Worker posting bridge endpoints (CloakBrowser)

This app also serves the Worker-compatible Facebook posting bridge contract that
`apps/video-affiliate/worker` calls via `CLOAK_FB_BRIDGE_URL`. These drive the persistent
logged-in CloakBrowser profile (`FACEBOOK_TOKEN_CLOAK_POST_ACCOUNT`, default `content_paiya`)
to resolve a user access token internally and call `graph.facebook.com`. They **never return
or log raw tokens/cookies/fb_dtsg** — only booleans / ids / redacted evidence. They replace
the retired Electron `apps/video-onecard` app (port 3847 / `video-onecard.wwoom.com`) — do
not resurrect it.

| Route | Method | Returns |
|-------|--------|---------|
| `/token` | GET | `{ ok, accessToken:<bool>, fbDtsg:<bool>, account }` — booleans only |
| `/pages` | GET | `{ data: [{ id, name, category, hasToken }] }` — no page tokens |
| `/post` | POST | organic One Card page video: `{ ok, story_id, video_id, post_url }` or step error |
| `/page-comment` | POST | comments **as the Page** (`{ ok, id, author_expected:'page' }`); fail-closed `page_token_not_found` |
| `/create-ad` | POST | OneCard/Ads: `{ ok, story_id, ad_id, adset_id, ... }` or step error. With `skip_ad` returns Phase A (`{ ok, phase:'post', story_id, video_id, thumbnail_url }`) — publishes a linkless page post and stops |
| `/promote` | POST | Phase B paid ad from `video_data.video_id` + the final direct Shopee CTA: `{ ok, phase:'promote', ad_id, adset_id, campaign_id, campaign_name, daily_budget, start_time, end_time, promoted_ad_cta_link, ... }`. Does NOT touch the organic post CTA |
| `/update-cta` | POST | update the **visible** Reel/page-post CTA to the final direct Shopee shortlink after `story_id` exists: POSTs `call_to_action` on `attachments.target.id`, reads back, returns `{ ok, cta_update_target_id, final_cta_link, visible_page_cta_link, visible_page_cta_final, permalink_url }`. Page-token only (fail-closed `page_token_not_found`); rejects Worker-redirect / non-`s.shopee.co.th` links |

### Campaign selection + ad schedule/budget (`/create-ad`, `/promote`)

Both ad-building routes share the same campaign resolution (precedence top→bottom):

| Body field | Behavior |
|------------|----------|
| `campaign_id` | Use this exact campaign as-is. |
| `new_campaign_name` | **Always force-create** a brand-new campaign with this exact name (CBO campaign budget; never reuses). Dashboard "new campaign" behavior — unchanged. |
| `daily_campaign_name` (alias `reuse_campaign_name`) | **Reuse-or-create**: search the ad account for a non-deleted campaign with the *exact same name* **and** the template objective; reuse it if found, else create it once (no campaign-level/CBO budget, so the adset keeps its own budget). The Worker post-first flow sends the Bangkok-date daily name `DD/Mon/YYYY` (e.g. `15/Jun/2026`) here when no `campaign_id`/`new_campaign_name` override is given. |
| _(none of the above)_ | Legacy `ADS_PUBLISH_<n>` prefix bin-packing (≤10 adsets/campaign, ≤10 campaigns per objective). |

When the `daily_campaign_name` path is taken, the copied template adset gets a per-ad budget +
24h run, applied in **separate, error-checked steps** (a combined budget+schedule+status POST
returned Graph `code=100 subcode=1487057` live, and was silently ignored):

1. POST `{ daily_budget }` **only** — default `10000` minor units = 100 THB (override
   `adset_daily_budget`). `daily_budget` and `end_time` must NOT be sent in the same POST: Meta
   rejects the pair (`code=100 subcode=1487793`), so budget is its own step. `daily_budget` (no
   `lifetime_budget`) is the conflict-free budget for a copied template adset; the daily campaign
   carries no CBO budget, so this is valid.
2. POST `{ name, status: ACTIVE, end_time }` to rename + activate + schedule (the live-proven
   single-POST shape). `end_time` is computed as the **copied adset's own `start_time` (read back
   from Graph via `fields=start_time`) + `adset_run_hours` (24h)** — Meta requires
   `end_time >= copied_start_time + run window`, and the copy assigns a `start_time` a few seconds
   after the bridge's local clock, so an `end_time` based on local "now" lands just short and is
   rejected `1487793`. It is sent as a **Bangkok offset ISO string** (e.g.
   `2026-06-16T21:39:39+0700`; a bare unix value is also rejected `1487793`). If the readback
   `start_time` is unavailable, it falls back to now + 24h + a 60s buffer. `start_time` is **never
   sent** so the ad starts immediately — a now/past `start_time` is a known cause of `1487057`.
   The **adset name is the post tail / sub2** (e.g.
   `984538171215406`, the `story_id` tail) — never the hash, never `page_id_post_id`. The **ad
   name is left as the system video code/hash** (set at ad creation from `source_video_id`) — the
   ad is never renamed to sub2.
3. Read the adset back (`fields=name,status,effective_status,daily_budget,start_time,end_time`)
   and require `status === ACTIVE` **and** a present `end_time` (never claim the 24h schedule
   applied if it is missing).

Every step's response is checked: any Graph error, or a readback that is not `ACTIVE`, returns
`ok:false` (step `adset_schedule` / `adset_activate`) and **deletes the orphan adset** — the
route never reports success on a paused/half-built adset. On success, `campaign_name`,
`daily_budget`, `start_time` (effective = now), and `end_time` are echoed back in the
(token-free) response. The legacy `new_campaign_name`/prefix paths keep the activate-only adset
behavior (campaign carries the budget) and do **not** set a per-adset budget or read back.

Each route accepts an optional `account` (query for GET, body for POST) to override the
default profile. Config (non-secret Facebook object ids, env-overridable):
`FACEBOOK_TOKEN_CLOAK_POST_AD_ACCOUNT`, `FACEBOOK_TOKEN_CLOAK_AD_ACCOUNT`,
`FACEBOOK_TOKEN_CLOAK_TEMPLATE_ADSET`, `FACEBOOK_TOKEN_CLOAK_POLL_MS`.

Default `FACEBOOK_TOKEN_CLOAK_TEMPLATE_ADSET` is the current Ads Manager
`TEMPLATE_SALES` adset `120248134990230263` (campaign
`120248134990220263`). The retired pre-SALES template adset
`120244361318490263` must not be used as a silent fallback.

Run for the live `content_paiya` profile:

```sh
FACEBOOK_TOKEN_CLOAK_POST_ACCOUNT=content_paiya \
  npm --prefix apps/facebook-token-cloak start
# listens on 127.0.0.1:8820 — expose via your cloudflared tunnel, then set the Worker's
# CLOAK_FB_BRIDGE_URL to that public https URL (NOT video-onecard.wwoom.com, NOT :3847).
```

## Verify

```sh
npm --prefix apps/facebook-token-cloak test
npm --prefix apps/facebook-token-cloak run check
```
