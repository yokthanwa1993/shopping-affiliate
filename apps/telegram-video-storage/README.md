# telegram-video-storage

Headless Rust HTTP service that archives local video files into Telegram
channels as **cold storage**. This is a Hermes-led safe pilot — it lives in
its own directory and does **not** touch the production R2/Worker flow used by
`apps/video-affiliate/`.

> Inspired by the upload path in
> [`caamer20/Telegram-Drive`](https://github.com/caamer20/Telegram-Drive)
> (`app/src-tauri/src/commands/auth.rs` + `fs.rs`):
> grammers-client → `upload_stream` → `InputMessage::default().file(...)` →
> `send_message(chat, msg)`.

---

## Pilot scope

| In scope | Out of scope (this pass) |
|---|---|
| New Rust binary at `apps/telegram-video-storage/` | Touching `video-affiliate` worker / webapp / merge-rust |
| `POST /api/archive/local-file` → upload one file to a Telegram channel | Deleting from R2 |
| Two channels: `original` (raw archive) and `processed` (post-FFmpeg) | Migrating existing R2 objects |
| Mock backend for plumbing tests (`TELEGRAM_VIDEO_STORAGE_MOCK=1`) | Interactive Telegram login flow |
| LaunchAgent template for macOS | Linux systemd unit |

### What still has to be done before this pilot can archive a real file

1. **Interactive auth helper.** This service refuses to start the Telegram
   backend if `TELEGRAM_SESSION_PATH` does not point at an authorized
   `grammers` session file. The login dance (phone → code → optional 2FA →
   save session) is *not* implemented here. Options:
   - Re-use the helper in `caamer20/Telegram-Drive`, run it once locally,
     copy the resulting `.session` file into `TELEGRAM_SESSION_PATH`.
   - Or write a one-shot `telegram-video-storage-login` binary in a follow-up
     PR using `grammers_client::SignInError` flow.
2. **Resumable / chunked uploads for >2 GB.** Current code uses
   `client.upload_stream(&mut file, size, name)` which works for files within
   the MTProto large-file limits (~2 GB). For larger files we should slice in
   userland or fall back to multi-message manifests.
3. **Caller integration.** Nothing in this repo calls `POST /api/archive/...`
   yet. The pilot expects an operator (or a follow-up worker job) to POST
   manifests for processed/originals before R2 deletion is considered.
4. **Idempotency / dedupe.** Repeated POSTs with the same `videoId` will
   currently re-upload. A future PR can add a small SQLite/JSON manifest of
   `videoId → messageId` to short-circuit.

---

## Build & run

This crate is **not** part of the npm root scripts on purpose — it has its own
release cadence. Run from the app directory:

```bash
cd apps/telegram-video-storage

# Fast feedback loop — pure routing/config layer, no Telegram client deps.
cargo fmt
cargo test
cargo check

# Production build — includes the grammers backend.
cargo build --release --features real_telegram
```

The built binary lands at
`apps/telegram-video-storage/target/release/telegram-video-storage`.

### Run with the mock backend (no Telegram traffic)

```bash
TELEGRAM_VIDEO_STORAGE_MOCK=1 \
  cargo run

# In another shell:
curl -s http://127.0.0.1:8820/health | jq
curl -s http://127.0.0.1:8820/api/config/status | jq
curl -s -X POST http://127.0.0.1:8820/api/archive/local-file \
  -H 'content-type: application/json' \
  -d '{"path":"/tmp/clip.mp4","kind":"original","videoId":"demo-1"}' | jq
```

### Run with the real Telegram backend

You must already have a logged-in `grammers` session file. See "What still has
to be done" above.

```bash
export TELEGRAM_API_ID=...                   # int from my.telegram.org
export TELEGRAM_API_HASH=...                 # hex string from my.telegram.org
export TELEGRAM_SESSION_PATH=~/.config/telegram-video-storage/session
export TELEGRAM_ORIGINAL_CHANNEL_ID=@my_archive_originals     # or numeric -100...
export TELEGRAM_PROCESSED_CHANNEL_ID=@my_archive_processed
export TELEGRAM_VIDEO_STORAGE_API_KEY=<generate-with-openssl-rand-hex-32>  # optional but recommended

cargo run --release --features real_telegram
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_VIDEO_STORAGE_HOST` | `127.0.0.1` | Bind address. Keep on loopback unless you front it with a reverse proxy. |
| `TELEGRAM_VIDEO_STORAGE_PORT` | `8820` | TCP port. |
| `TELEGRAM_VIDEO_STORAGE_API_KEY` | _(unset)_ | If set, every `POST /api/archive/...` must include the configured key as either an `X-Api-Key` header or an `Authorization: Bearer` header. Strongly recommended. Do not commit the actual key. |
| `TELEGRAM_VIDEO_STORAGE_MOCK` | `0` | `1` to use the in-process mock backend (no Telegram traffic). |
| `TELEGRAM_API_ID` | _(unset)_ | App API id from [my.telegram.org](https://my.telegram.org). |
| `TELEGRAM_API_HASH` | _(unset)_ | App API hash. **Never** commit. |
| `TELEGRAM_SESSION_PATH` | _(unset)_ | Path to a `grammers` session file (logged-in account). |
| `TELEGRAM_ORIGINAL_CHANNEL_ID` | _(unset)_ | Channel for raw originals — `@username` or numeric `-100...`. |
| `TELEGRAM_PROCESSED_CHANNEL_ID` | _(unset)_ | Channel for post-FFmpeg outputs. |
| `RUST_LOG` | `info,tower_http=warn` | Standard `tracing` filter. |

---

## HTTP API

### `GET /health`

```json
{ "ok": true, "ready": true, "mode": "telegram", "missing": [] }
```

`ready=false` if any required field is missing; `missing` lists the env var
names. `mode` is `mock` when `TELEGRAM_VIDEO_STORAGE_MOCK=1`.

### `GET /api/config/status`

Redacted, never returns raw secrets:

```json
{
  "ready": true,
  "mode": "telegram",
  "host": "127.0.0.1",
  "port": 8820,
  "api_id_present": true,
  "api_hash_fingerprint": "de…ef (16)",
  "session_path_present": true,
  "original_channel_present": true,
  "processed_channel_present": true,
  "api_key_required": true,
  "mock_mode": false,
  "missing": []
}
```

### `POST /api/archive/local-file`

Headers: `Content-Type: application/json`, plus `X-Api-Key: <value>` when an
API key is configured.

Body:

```json
{
  "path": "/absolute/path/to/output.mp4",
  "kind": "original",
  "videoId": "vid-abc123",
  "namespaceId": "tenant-A",
  "fileName": "vid-abc123-original.mp4"
}
```

- `path` **must be absolute** and readable by the service process.
- `kind` is `"original"` or `"processed"`.
- `videoId` is required (operator-defined string).
- `namespaceId` and `fileName` are optional.

Success (`200`):

```json
{
  "storage": "telegram",
  "kind": "original",
  "videoId": "vid-abc123",
  "namespaceId": "tenant-A",
  "channelId": "-1001234567890",
  "messageId": 42,
  "fileName": "vid-abc123-original.mp4",
  "size": 50331648,
  "createdAt": "2026-05-23T10:00:00Z"
}
```

Errors:

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_request` | Validation failed (relative path, blank `videoId`, unknown `kind`, etc.). |
| `401` | `unauthorized` | API key required but missing/wrong. |
| `404` | `file_not_found` | `path` does not exist or is not a file. |
| `502` | `upload_failed` | Telegram rejected the upload / send. Message body has detail. |
| `503` | `telegram_not_ready` | Service is up but credentials/session are missing. `missing` lists offending env vars. |

---

## Pilot workflow — two channels

1. **Operator creates two private Telegram channels**, e.g.
   `@shopping_affiliate_originals` and `@shopping_affiliate_processed`. Add
   the session account as admin (or at least as a member with post rights).
2. **Operator runs the auth helper once** (out of scope, see above), saves
   the session file at `TELEGRAM_SESSION_PATH`. The file should be
   `chmod 600` and live outside the repo.
3. **Service is started** via the LaunchAgent below. `/health` should report
   `ready: true, mode: "telegram"`.
4. **For every newly-processed video** the operator (or a follow-up job)
   POSTs two manifests:
   - `kind: "original"` → archives the raw upload.
   - `kind: "processed"` → archives the FFmpeg/merge-rust output.
5. **Both responses are persisted** alongside the existing R2 manifest so
   future jobs know where the cold copy lives. Only after both succeed should
   any R2 cleanup be considered — and R2 cleanup is **explicitly out of
   scope** for this pilot.

---

## LaunchAgent template (macOS)

Copy to `~/Library/LaunchAgents/com.shopping-affiliate.telegram-video-storage.plist`
and fill in the bracketed values. **Do not check this file in** — it will end
up containing the real `TELEGRAM_API_HASH`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.shopping-affiliate.telegram-video-storage</string>

    <key>ProgramArguments</key>
    <array>
      <string>/Users/&lt;you&gt;/Developer/shopping-affiliate/apps/telegram-video-storage/target/release/telegram-video-storage</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>TELEGRAM_VIDEO_STORAGE_HOST</key><string>127.0.0.1</string>
      <key>TELEGRAM_VIDEO_STORAGE_PORT</key><string>8820</string>
      <key>TELEGRAM_VIDEO_STORAGE_API_KEY</key><string>[REDACTED-API-KEY]</string>
      <key>TELEGRAM_API_ID</key><string>[REDACTED-API-ID]</string>
      <key>TELEGRAM_API_HASH</key><string>[REDACTED-API-HASH]</string>
      <key>TELEGRAM_SESSION_PATH</key><string>/Users/&lt;you&gt;/.config/telegram-video-storage/session</string>
      <key>TELEGRAM_ORIGINAL_CHANNEL_ID</key><string>@your_originals_channel</string>
      <key>TELEGRAM_PROCESSED_CHANNEL_ID</key><string>@your_processed_channel</string>
      <key>RUST_LOG</key><string>info,tower_http=warn</string>
    </dict>

    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>

    <key>StandardOutPath</key>
    <string>/Users/&lt;you&gt;/Library/Logs/telegram-video-storage.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/&lt;you&gt;/Library/Logs/telegram-video-storage.err.log</string>
  </dict>
</plist>
```

Load / unload:

```bash
launchctl load   ~/Library/LaunchAgents/com.shopping-affiliate.telegram-video-storage.plist
launchctl unload ~/Library/LaunchAgents/com.shopping-affiliate.telegram-video-storage.plist
```

---

## Security notes

- **Bind to loopback** by default. If you need remote access, front the
  service with a reverse proxy that terminates TLS and enforces auth — do
  not expose `127.0.0.1:8820` directly to the network.
- **API key is mandatory in production.** The mock backend accepts files
  from any caller, but the loopback bind protects you. As soon as you flip
  to the real backend, set `TELEGRAM_VIDEO_STORAGE_API_KEY` to a 32-byte
  random hex string.
- **Session file is sensitive.** A leaked session file is equivalent to a
  hijacked Telegram account. `chmod 600`, keep it outside the repo, exclude
  it from backups that leave the machine in plaintext.
- **Never put `TELEGRAM_API_HASH`, `TELEGRAM_VIDEO_STORAGE_API_KEY`, or
  channel ids of real production channels into git, the Obsidian wiki, or
  any committed config file.** Use `[REDACTED]` placeholders when
  referencing them in docs.
- The redacted `/api/config/status` endpoint is deliberately information-
  thin: it exposes presence booleans and a 2-char fingerprint of the API
  hash, never raw values.

---

## Layout

```
apps/telegram-video-storage/
├── Cargo.toml
├── README.md                 # this file
├── src/
│   ├── lib.rs                # re-exports modules for the bin + tests
│   ├── main.rs               # tokio + axum + signal handling
│   ├── config.rs             # env loading, readiness, redacted status
│   ├── routes.rs             # axum router + handlers + unit tests
│   └── storage/
│       ├── mod.rs            # Storage trait, ArchiveRequest/Result, Kind
│       ├── mock.rs           # mock backend (TELEGRAM_VIDEO_STORAGE_MOCK=1)
│       └── telegram.rs       # grammers backend (feature = "real_telegram")
└── tests/
    └── archive_e2e.rs        # mock-backend HTTP integration test
```

## Testing strategy

- **TDD-first for pure logic.** Config parsing, redaction, API-key check,
  kind→channel routing, and request validation are unit-tested in their
  source modules. These run against the default feature set, so
  `cargo test` is fast and offline-safe.
- **Mock-backend HTTP integration.** `tests/archive_e2e.rs` drives the full
  axum router with `tower::ServiceExt::oneshot` and a real temp file.
- **Real Telegram backend is excluded from `cargo test`.** Its functional
  correctness depends on a real session and live channels and is verified
  manually during the pilot. The code path is still type-checked via
  `cargo check --features real_telegram`.
