# facebook-token-cloak

Side-by-side local Facebook token bridge for CloakBrowser + macOS Keychain.

- Binds only to `127.0.0.1`.
- Default port: `8820`.
- Profile root: `~/.facebook-token-cloak/profiles`.
- Keychain service prefix: `com.affiliate.facebook-token-cloak`.
- No raw tokens/passwords/TOTP/cookies/datr are logged or returned by default.
- `/token/export` is dry-run only; it does not write Cloudflare/D1.

## Run

```sh
npm --prefix apps/facebook-token-cloak start
```

## Web console (UI)

Once running, open the local console in a browser:

```
http://127.0.0.1:8820/
```

The console is a single static page (no build step, no external CDNs) that shows
which Facebook accounts/users exist in the local system and lets you add, edit,
log in, check, and delete them. The browser UI always saves and logs in through
the app's own macOS Generic Keychain provider (`generic-keychain`); it does not
offer macOS Passwords.app selection.

Sections:

1. **Accounts in this system** — alias/namespace, username/email hint, and
   present/missing pills for credential, 2FA, and token/session status.
2. **Add / edit account** — alias/namespace, username/email/phone, and the
   write-only secret fields (password and 2FA seed/code).
3. **Status** — Save and Login/Get Token show only redacted status. The UI never
   requests raw token output (`includeToken` is never sent) and has no token
   export or datr tools.

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
- All management endpoints (`/`, `/accounts*`, `/keychain/*`, `/accounts/selector`)
  are localhost-only.
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

Open login browser profile:

```sh
curl 'http://127.0.0.1:8820/login?account=CHEARB&visible=1&autofill=1&submit=0'
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

Dry-run export:

```sh
curl -X POST http://127.0.0.1:8820/token/export \
  -H 'Content-Type: application/json' \
  -d '{"account":"CHEARB","target":"video-affiliate","dryRun":true}'
```

## Verify

```sh
npm --prefix apps/facebook-token-cloak test
npm --prefix apps/facebook-token-cloak run check
```
