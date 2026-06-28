# Accounts Bridge v2

A **side-by-side** rebuild of the local Accounts Bridge with a real **Cloudflare Worker + D1**
backend, while keeping the local operator app on the **native Swift/SwiftUI** direction.

It does **not** replace the existing `apps/facebook-token-cloak` bridge, Tauri/BrowserSaving code, or
any deployed Worker. It is deploy-independent.

## Why

The file/Keychain-only Accounts Bridge had no durable, queryable source of truth for *which account
owns which page/token*. That caused account/session/token drift — e.g. the UI showed Chanalai
(`100090320823561`) while a page post actually used an old token Facebook attributed to **Yanin**.

v2 makes ownership **explicit and durable**: every session/cookie/token record binds to
`account_uid + role + platform + page_id(optional) + version/source + timestamps`, with an
append-only audit trail. There is **no hidden fallback account**.

## Layout

```
apps/accounts-bridge/
  worker/                 Cloudflare Worker + D1 backend (this is the new server)
    src/                  index.js (entry), router.js, store.js, lib.js
    migrations/0001_init.sql
    test/                 node --test suite, runs real SQL via node:sqlite
    wrangler.jsonc, package.json
  swift/                  Native macOS operator app scaffold (API-first, status/config only)
    Sources/AccountsBridgeKit/   token-free API client + local blob sealer + models
    Sources/AccountsBridgeApp/   status-only SwiftUI shell
    Tests/                       contract tests
```

See [`docs/accounts-bridge-v2.md`](../../docs/accounts-bridge-v2.md) for the full architecture,
sync flow, and Swift contract.

## Roles & platforms

| Role key | Surface | Allowed mechanism |
|---|---|---|
| `page_posting_facebook_lite` | Page posting | **Facebook Lite / Token Bridge only** |
| `ads_power_editor` | Ad creation | **Power Editor only** |

Platforms: `facebook`, `shopee` (initially).

Each role is a **singleton per (platform, role)** — exactly one account owns it (DB `UNIQUE`).

## Secret policy

- Secret material (session/cookie/token blobs) is **encrypted locally** by the native app before it
  is sent, and stored in D1 **only as opaque ciphertext** (`*_blob` columns). Key material lives in
  the macOS Keychain / a Worker secret — never in D1, the repo, or the wiki.
- The API **never returns** a `*_blob`. Responses expose only `blob_digest`, `version`, `source`,
  and boolean flags (`has_blob`). A plaintext-secret tripwire rejects raw tokens/cookies on write.
- Tests use **fake ciphertext** strings; no real secret appears anywhere.

## API (v1)

Auth: all `/v1/*` routes require header `x-accounts-bridge-key` (shared local-bridge key, timing-safe
compared). `/health` is public. Fails **closed** (503) if the key is unconfigured.

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness + advertised roles (public) |
| `GET /v1/accounts` | List accounts (token-free; includes `credential_presence`, `avatar_present`, `proxy_host_hint`) |
| `POST /v1/accounts` | Create/ensure an account (non-secret metadata: `display_label`, `tag` ∈ {post,comment,mobile}, `homepage_url`, `email`, `notes`, `page_label`, `status`) |
| `GET` \| `PATCH` \| `DELETE /v1/accounts/:platform/:account_uid` | Read / update metadata / soft-archive a single account |
| `PUT /v1/accounts/:platform/:account_uid/credentials` | **Write-only** credential vault — `password` / `datr_cookie` / `totp_secret` / `proxy_url` are AES-GCM-sealed; blank field keeps existing, `clear_<field>:true` removes; returns **presence flags + host-only `proxy_host_hint` only** |
| `GET` \| `POST` \| `PUT` \| `DELETE /v1/accounts/:platform/:account_uid/avatar` | Avatar image bytes in R2 (png/jpeg/webp ≤2MB, validated by signature); GET streams the image |
| `GET /v1/roles/facebook` | Read the role→account mapping |
| `PUT /v1/roles/facebook` | Assign/clear role owners |
| `GET /v1/pages/:page_id/binding` | Read a page's role bindings |
| `PUT /v1/pages/:page_id/binding` | Bind a page to an account+role (rejects role/account drift) |
| `POST /v1/sessions` | Store an encrypted session blob (metadata only returned) |
| `GET /v1/sessions/status` | `?account_uid=&role=&platform=` — presence/digest, never the blob |
| `POST /v1/cookies` | Store an encrypted cookie blob |
| `POST /v1/profile-archives/:platform/:role/:account_uid/upload` | Store the **sealed** profile archive on close (raw ciphertext body) |
| `GET /v1/profile-archives/:platform/:role/:account_uid/download` | Fetch the sealed archive bytes on open (ciphertext only) |
| `GET /v1/profile-archives/:platform/:role/:account_uid/status` | Presence/digest/version/size metadata, never the bytes |
| `POST /v1/audit/events` | Append a non-secret audit event |
| `POST /v1/commands` | Enqueue a non-secret agent command |
| `GET /v1/commands` | List recent commands (`?agent_id=&status=&limit=`) |
| `POST /v1/agents/:agent_id/poll` | Agent claims queued commands → `running` (also a heartbeat) |
| `POST /v1/commands/:id/complete` | Agent reports a terminal result (`succeeded`/`failed`/`cancelled`) |
| `POST` \| `PUT /v1/agents/:agent_id/status` | Agent heartbeat / status upsert |
| `GET /v1/agents/:agent_id/status` | Read one agent's heartbeat |
| `GET /v1/agents` | List known agents (dashboard heartbeat view) |

### Agent command queue — cloud-backed "Open profile on Mac via Agent"

So `https://www.pubilo.com/dashboard/accounts` works from **any** machine (not only the Mac on
loopback), the Worker carries a small command queue + agent heartbeat. This is **not** browser
streaming/noVNC — the dashboard enqueues a command and a local Mac agent
(`apps/facebook-token-cloak`, optional poller) runs it on its own machine.

- **Actions (MVP):** `open_profile`, `close_profile`, `sync_accounts`, `status`. `open_profile` /
  `close_profile` require an `account_uid`.
- **Lifecycle:** `queued` → (poll claims it) `running` → `succeeded` \| `failed` \| `cancelled`.
  The claim is a deterministic compare-and-set per command, so two concurrent polls never
  double-claim the same row (no D1 multi-row transaction needed).
- **Secret policy:** `payload_json` / `result_json` are **non-secret JSON only**. The API rejects any
  secret-shaped **key** (`token`/`cookie`/`password`/`datr`/`fb_dtsg`/…) *and* any value that looks
  like a raw token/cookie before a row is written; `error_message` is sanitized + truncated.
- **The Worker still opens no browser and mints no token.** The agent does the local work and the
  command is the message between them. `open_profile` opens a **VISIBLE** window with autofill +
  submit OFF (same safe path as `GET /login?visible=1&autofill=0&submit=0`).

Agent identity defaults to `mac-mini` (override with `ACCOUNTS_BRIDGE_AGENT_ID`, sanitized). The
dashboard reaches all of this **same-origin** via the worker proxy at `/accounts-bridge/*`, which
injects `x-accounts-bridge-key` server-side — the browser never sees the key.

### Profile archive sync — BrowserSaving semantics, but sealed

BrowserSaving compresses a Chrome profile on close, uploads the **raw** `tar.gz` to its Worker (which
then parses cookies/`datr` out of it and stores them in D1), and restores it on open. Accounts Bridge
deliberately does **not** do that. It keeps the *behaviour* — restore-on-open, save-on-close, so
session data never disappears — but:

- The local app collects the essential profile paths (`Cookies`, `Login Data`, `Web Data`,
  `Preferences`, `Secure Preferences`, `History`, `Local Storage`, `Session Storage`, `IndexedDB`,
  `Service Worker`, `Local State`, …), `tar.gz`-es them, then **seals the bytes locally** (AES-GCM,
  key in the Keychain) into an **`ABENC1` envelope** before upload.
- The Worker stores the envelope as **opaque ciphertext** in R2 at
  `profile-archives/{platform}/{role}/{account_uid}.tar.gz.enc` (account/role-scoped — no bare
  profile-id ambiguity) and keeps only **non-secret metadata** in D1 (`blob_digest`, `byte_size`,
  `version`, `source`, `cipher`, timestamps). It **never** parses cookies/tokens/`datr`/passwords from
  the archive — it has no key and never decrypts.
- `upload` refuses anything that is not a sealed `ABENC1` envelope (a raw gzip/zip archive is rejected
  with `archive_not_encrypted`), so a plaintext profile can never land in storage even by mistake.
- `download` returns the ciphertext bytes only to the authenticated local client (which unseals
  locally); `status` returns booleans/digest/version/size only.

Local flow helper: `local/profile-archive.js` (`buildArchiveManifest` allowlist + path-safety,
`sealArchiveEnvelope`/`unsealArchiveEnvelope`, `ProfileArchiveClient`). Swift:
`AccountsBridgeClient.{downloadProfileArchive,uploadProfileArchive,profileArchiveStatus}` +
`LocalBlobSealer.sealArchive`.

## Setup & commands

```bash
cd apps/accounts-bridge/worker
npm install                       # wrangler (dev dep) — not needed just to run tests
npm test                          # node --test, real SQL via node:sqlite (no network, no secrets)
npm run check                     # syntax check

# One-time backend provisioning (requires a Cloudflare account; not run here):
wrangler d1 create accounts-bridge-db                       # paste database_id into wrangler.jsonc
wrangler r2 bucket create accounts-bridge-profile-archives  # sealed profile archives (opaque ciphertext)
npm run db:migrate:local                                    # apply migrations/ locally (0001 + 0002 + 0003)
wrangler secret put ACCOUNTS_BRIDGE_API_KEY                 # set the shared local-bridge key (value not stored here)
npm run dev                                                  # local Worker on http://127.0.0.1:8787
```

Local profile-archive helper tests (no network, no secrets — seal/open key is generated in-test):

```bash
cd apps/accounts-bridge/local
npm test                          # manifest path-safety + ABENC1 envelope round-trip + HTTP flow
```

### Required secret (documented, value not stored)

| Name | Where | What |
|---|---|---|
| `ACCOUNTS_BRIDGE_API_KEY` | Worker secret + macOS Keychain (local app) | Shared local-bridge API key for `/v1/*` |
| `ACCOUNTS_BRIDGE_SECRETS_KEY` | Worker secret (**preferred**, optional) | Dedicated AES-GCM key for the credential vault. If unset, the key is **derived from `ACCOUNTS_BRIDGE_API_KEY`** so deployment still works — but a dedicated key is preferred (rotating the API key would otherwise re-key the vault). Set with `wrangler secret put ACCOUNTS_BRIDGE_SECRETS_KEY`. |

R2 bucket for avatars (one-time): `wrangler r2 bucket create accounts-bridge-account-avatars` (binding `ACCOUNT_AVATARS`).

## Migration / audit path

Because every record carries `account_uid + role + platform + page_id + version/source + timestamps`
and writes emit `audit_events`, you can always answer *"which account/session produced this page
token/post?"* — query `page_bindings` and `session_records` for the `page_id`, then `audit_events`
for the provenance trail. The Yanin-vs-Chanalai drift becomes a single lookup, not a guess.

## What this app deliberately does NOT do

No token mint/refresh, no login, no autofill/submit, no browser/Chrome/CloakBrowser automation. The
Worker is a pure DB + config API; the native app performs those local steps and pushes only durable,
already-encrypted state here. (Enforced by `test/security.test.js`.)
