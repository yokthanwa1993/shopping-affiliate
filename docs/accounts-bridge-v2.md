# Accounts Bridge v2 — architecture & sync flow

Status: side-by-side rebuild. Lives at `apps/accounts-bridge/`. Deploy-independent from
`video-affiliate`, `browsersaving`, and `facebook-token-cloak`. No existing endpoint or deployment is
changed by adding it.

## Problem it solves

The previous Accounts Bridge stored account/session/token state in files + macOS Keychain with no
durable, ownership-explicit record of *which account owns which page or token*. The result was
account/session/token **drift**: the UI showed one identity (Chanalai, `100090320823561`) while a
page post used a stale token Facebook attributed to a different identity (Yanin). There was an
implicit fallback account and no audit path to explain the discrepancy.

## Design principles

1. **Durable source of truth in D1.** Accounts, role ownership, page bindings, and session/cookie
   metadata live in a relational schema with constraints, not in scattered files.
2. **Ownership is explicit; no hidden fallback.** Every session/cookie/page record binds to
   `account_uid + role + platform + page_id(optional) + version/source + timestamps`.
3. **Role separation is structural.** Page posting = Facebook Lite / Token Bridge only;
   ad creation = Power Editor only. Enforced by `CHECK` + `UNIQUE(platform, role)` and by the binding
   layer (an account must actually *hold* a role to be bound to a page for it).
4. **API-first, status-only UI.** The native app calls the API to read/write durable state. Opening
   the status UI mints nothing, refreshes nothing, logs in to nothing, opens no browser.
5. **Secrets never transit the API in the clear, and never come back.** Blobs are sealed locally and
   stored as ciphertext; responses expose digests/versions/flags only.

## Components

```
            ┌─────────────────────────────┐         encrypted blobs + non-secret state
 macOS  ┌──▶│  AccountsBridgeApp (SwiftUI) │  status-only reads on launch
 native │   │  + AccountsBridgeKit client  │──────────────┐
 login/ │   └─────────────────────────────┘              │  HTTPS, x-accounts-bridge-key
 token  │            ▲  seals secret blobs                ▼
 mint ──┘            │  (AES-GCM, key in Keychain)   ┌─────────────────────────┐
 (facebook-token-    └───────────────────────────────│ accounts-bridge-worker  │
  cloak / native)        plaintext NEVER leaves device│   (Cloudflare Worker)   │
                                                       │   router → store → D1   │
                                                       └─────────────────────────┘
                                                                 │
                                                                 ▼
                                                        D1: accounts, account_roles,
                                                        sections, page_bindings,
                                                        session_records, cookie_records,
                                                        audit_events
```

The **local login / token-mint** step (today the `apps/facebook-token-cloak` CloakBrowser/Token
Bridge, tomorrow possibly a native module) is the only place a browser/login happens. Its *outputs* —
already encrypted — are pushed to the Worker. The Worker and the status UI contain no such code path.

## Data model (D1)

`migrations/0001_init.sql`:

- **accounts** — one row per login identity. `UNIQUE(platform, account_uid)`. Non-secret display only.
- **account_roles** — which account plays each role. `UNIQUE(platform, role)` ⇒ a role has exactly
  one owner. `role CHECK IN (page_posting_facebook_lite, ads_power_editor)`.
- **sections** — optional operator grouping of accounts.
- **page_bindings** — which `account_uid + role` owns a `page_id`. `UNIQUE(platform, page_id, role)`.
- **session_records** — encrypted session/token blob + `blob_digest`, bound to account/role/platform/
  page_id/version/source/timestamps. `encrypted_blob` + `blob_digest` are `NOT NULL`.
- **cookie_records** — encrypted cookie blob, same binding discipline.
- **audit_events** — append-only, non-secret provenance (`event_type`, who/what/when, `detail` JSON
  with a forbidden-key guard so no secret-looking field can be recorded).
- **profile_archives** (`migrations/0002_profile_archives.sql`) — metadata for the sealed profile
  archive: `r2_key + blob_digest + byte_size + cipher + version + source`, bound to
  `platform + role + account_uid` with `UNIQUE(platform, role, account_uid)` (one CURRENT archive per
  owner). The bytes themselves live in R2, **never** in D1.

## Sync flow (write path)

1. Native login/token-mint module obtains a fresh page token / session locally.
2. It **seals** the secret with `LocalBlobSealer` (AES-GCM; key from Keychain). Plaintext stays on
   device.
3. `POST /v1/accounts` (ensure the identity exists) → `PUT /v1/roles/facebook` (record role
   ownership) → optional `PUT /v1/pages/:page_id/binding` (bind the page to that account+role).
4. `POST /v1/sessions` (or `/v1/cookies`) with the sealed blob. The Worker computes a SHA-256
   `blob_digest`, stores ciphertext only, and returns metadata (never the blob).
5. The Worker writes an `audit_events` row for each step.

## Profile archive sync (sealed, BrowserSaving-style)

Thanwa's requirement: BrowserSaving does **not** keep profile data local-only — on close it compresses
the Chrome/session data and uploads it to its Worker, and on open it downloads/restores the archive
first, so session data never disappears. Accounts Bridge reproduces that *behaviour* but not its
*trust model*.

| | BrowserSaving | Accounts Bridge v2 |
|---|---|---|
| On close | `tar.gz` the profile, upload **raw** bytes | `tar.gz`, then **seal locally** (AES-GCM → `ABENC1` envelope), upload **ciphertext** |
| Worker storage | R2 `browser-data/{profileId}.tar.gz` | R2 `profile-archives/{platform}/{role}/{account_uid}.tar.gz.enc` (account/role-scoped) |
| Worker reads secrets? | Yes — parses cookies/`datr` out of the archive into D1 columns | **No** — has no key, never decrypts; D1 holds only digest/size/version metadata |
| Download returns | raw archive (and a `/cookies` JSON endpoint) | **ciphertext only**, to the authenticated local client, which unseals locally |
| Upload validation | rejects `< 1024` bytes | rejects anything that isn't a sealed `ABENC1` envelope (`archive_not_encrypted` on raw gzip/zip) |

Flow:

1. **Open** → `GET …/download`. If present, the local app receives the sealed `ABENC1` bytes, unseals
   with the Keychain key, extracts the `tar.gz` into the profile dir, then launches the browser. This
   is what stops session/cookie data from "disappearing".
2. **Close** → the local app collects only the allowlisted essential paths (`buildArchiveManifest`),
   `tar.gz`-es them, **seals locally** (`sealArchiveEnvelope` / `LocalBlobSealer.sealArchive`), and
   `POST …/upload`s the ciphertext. The Worker computes a SHA-256 of the ciphertext, writes the bytes
   to R2, upserts non-secret metadata to `profile_archives` (one CURRENT archive per
   `platform+role+account_uid`), and emits a `profile_archive.uploaded` audit event.
3. **Status** → `GET …/status` returns `present` + digest/version/size only (the "head" surface).

Why this is safe where BrowserSaving's pattern would not be: the Worker is a zero-knowledge byte store
for archives. Even with full DB + R2 access, an attacker sees only opaque ciphertext and metadata — no
cookies, no `datr`, no tokens, no passwords. The only place plaintext profile bytes exist is on the
operator's device, behind the Keychain-held seal key.

Storage: bytes live in R2 (`PROFILE_ARCHIVES` binding); D1's `profile_archives` row holds
`r2_key + blob_digest + byte_size + cipher + version + source + timestamps` and never the blob. The
account must exist **and hold the role** for an upload to be accepted (same no-fallback discipline as
sessions), so a restored profile is always traceable to its rightful owner.

Local helper: `apps/accounts-bridge/local/profile-archive.js` — `ESSENTIAL_PROFILE_PATHS`,
`isSafeRelativePath`/`buildArchiveManifest` (allowlist + traversal refusal), `sealArchiveEnvelope`/
`unsealArchiveEnvelope` (key injected, never in repo), and `ProfileArchiveClient`.

## Read / status flow

- `GET /health` — public liveness.
- `GET /v1/accounts`, `GET /v1/roles/facebook`, `GET /v1/pages/:id/binding`,
  `GET /v1/sessions/status?account_uid=&role=&platform=` — all token-free, blob-free. The SwiftUI
  shell calls these on `.task` (appear). No mutation, no browser, no token mint.

## Audit / drift explanation

To explain *"which account/session produced this page token/post?"* for `page_id` P:

```sql
SELECT * FROM page_bindings   WHERE page_id = 'P';                 -- owner account + role
SELECT * FROM session_records WHERE page_id = 'P' ORDER BY created_at DESC;  -- which session/version
SELECT * FROM audit_events    WHERE page_id = 'P' ORDER BY created_at;       -- provenance trail
```

Because ownership is a stored constraint (no fallback), the Chanalai-vs-Yanin class of drift surfaces
as a binding/role mismatch instead of a silent wrong-token post.

## Swift native contract (`AccountsBridgeKit`)

- `AccountsBridgeClient` — token-free HTTP client. Read methods (`health`, `listAccounts`,
  `facebookRoles`, `pageBindings`, `sessionStatus`) and write methods (`createAccount`,
  `assignFacebookRole`, `bindPage`, `storeSession`, `recordAudit`). Reads the shared API key from the
  Keychain; never hard-codes or logs it.
- `LocalBlobSealer` — AES-GCM seal of secret blobs; the only place plaintext is handled, on-device.
- `StatusView` — status/config-only SwiftUI shell; `.task` performs READ calls only.

## Integration with the existing bridge

`apps/facebook-token-cloak` continues to own local login/token-mint and its own endpoints/tests
unchanged. v2 is additive: the bridge (or a future native module) can call the v1 API to record
durable ownership. No facebook-token-cloak endpoint, test, or behavior is modified by v2. A token-free
client for that integration should be added only when the integration is actually wired, to avoid
touching that app's in-flight working tree.

## Secrets (documented; values never stored)

| Name | Location | Purpose |
|---|---|---|
| `ACCOUNTS_BRIDGE_API_KEY` | Worker secret (`wrangler secret put`) + macOS Keychain | Shared `/v1/*` auth key |
| Local seal key | macOS Keychain | AES-GCM key for `LocalBlobSealer`; never sent to the Worker |

## Tests

`apps/accounts-bridge/worker/test/` runs under `node --test` with `node:sqlite`, executing the real
migration and real store queries (no mocks, no network, no secrets):

- `schema.test.js` — tables exist; platform/role `CHECK`s; `UNIQUE(platform, role)` singleton;
  page-binding uniqueness; `NOT NULL` blob/digest.
- `api.test.js` — token-free responses; role assignment; **page binding rejects mismatched
  account/role**; session store returns digest/flags but never the blob; plaintext-secret blob
  rejected; status mirrors stored session; audit forbidden-key guard.
- `security.test.js` — every `/v1` route requires the key (401, incl. the profile-archive routes);
  fail-closed (503) when unconfigured; health stays public; **worker source contains no
  browser/login/token-mint code path**; no GET over a populated DB ever leaks ciphertext or names
  `encrypted_blob`.
- `archives.test.js` — profile-archive sync: upload seals bytes to R2 and returns metadata only;
  download returns the exact ciphertext with non-secret headers; re-upload replaces (singleton);
  raw gzip / missing-`ABENC1` uploads rejected; role/account drift refused; R2-unconfigured fails
  closed (503).

The local helper has its own suite at `apps/accounts-bridge/local/test/` (manifest path-safety,
`ABENC1` envelope round-trip with a real in-test AES-GCM key, and the HTTP flow). The Swift contract
smoke (`AccountsBridgeContractSmoke`) additionally checks `sealArchive`/`unsealArchive` round-trips,
the `ABENC1` magic, the essential-paths allowlist safety, and `ProfileArchiveMeta` decoding.
