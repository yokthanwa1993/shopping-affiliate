# admin-media-drive

Personal/admin **media drive** for Thanwa's Discord + Mac mini workflow. It is a
small, self-contained Express app (side-by-side with the other `apps/*`; it does
**not** touch `video-affiliate`, `facebook-token-cloak`, or any production app).

## Storage model — Discord is the source of truth

**Discord stores 100% of the media** — both **original** (`#คลังต้นฉบับ`) and
**processed** (`#ประมวลผลแล้ว`) videos live in Discord as native attachments.
The Mac mini is **only an indexer/worker**:

- It keeps a **SQLite index** (`media_items`) of **metadata only**
  (`channelId` / `messageId` / `attachmentId` / `filename` / `size` /
  `contentType` / `status` / `jumpUrl` / last-known CDN url).
- It does **not** download or permanently keep media files. `MEDIA_ROOT` is only
  a **temp/cache** dir used transiently while processing a file; nothing is
  persisted there by default.
- Fresh, non-expiring access is served on demand by resolving the Discord
  message and redirecting to the current attachment `url`.

This is controlled by `STORAGE_MODE` (default **`discord`**). A legacy
`mirror` mode still exists that additionally keeps a permanent local copy under
`MEDIA_ROOT`, but it is optional and off by default.

What it does:

- Uploads images/videos to a Discord channel as **native attachments** (so they
  appear in Discord's Media tab), ported from the original `media-drive`
  prototype.
- **discord mode (default):** indexes attachment **metadata** only — no file
  bodies are downloaded on sync, and uploads are not copied to local disk.
- **mirror mode (legacy):** additionally keeps a **local filesystem mirror** of
  every uploaded/synced attachment.
- Maintains a **SQLite index** (`media_items`) so media is browsable, and
  serveable via a **fresh Discord URL** even after old CDN links expire.

It is loopback-only (`127.0.0.1`) and never logs the bot token.

---

## Quick start (Mac mini)

```bash
cd apps/admin-media-drive
cp .env.example .env          # then fill DISCORD_BOT_TOKEN / DISCORD_GUILD_ID
npm install
npm run dev                   # or: npm start
```

Open `http://127.0.0.1:3100`.

Run tests (no Discord token needed):

```bash
npm test
```

Health check (works even with no Discord config):

```bash
curl -s http://127.0.0.1:3100/api/health
```

---

## Local Mac video processing

Processing is intentionally **100% local on this Mac mini**:

- No Docker.
- No CapRover Ubuntu.
- No Cloudflare Worker / Container / D1 / R2 processing path.
- The existing `apps/video-affiliate/merge-rust` pipeline still calls Vertex
  Gemini cloud APIs for analysis, Thai TTS, and audio subtitle sync.
- Discord remains the source of truth for original and processed media.
- The Mac mini resolves a fresh Discord source URL and sends that URL to the
  real legacy merge-rust `/pipeline` flow:
  download video -> flip/prepare -> Vertex Gemini analyze -> Thai
  script/subtitle_lines/title/category -> Vertex Gemini TTS -> adjust audio
  duration -> Vertex Gemini audio SRT sync or deterministic fallback -> SRT to
  ASS -> burn centered subtitles -> thumbnail -> callback upload.
- A per-job local callback server implements the Worker-compatible endpoints
  merge-rust expects (`/api/r2-upload/*`, `/api/r2-proxy/*`,
  `/api/gallery/refresh/:id`, `/api/queue/next`). Artifacts are staged under
  `MEDIA_ROOT/tmp/...`; the final MP4 is then uploaded to `PROCESSED_CHANNEL_ID`
  and indexed in SQLite.
- Temp files are deleted after success/failure unless `KEEP_PROCESSING_TMP=1`.

`PROCESSOR_MODE=merge_rust` is the default. The old simple FFmpeg transcode path
is still available only as `PROCESSOR_MODE=ffmpeg` for explicit legacy fallback
testing.

---

## Subtitle fail-closed verification gate

**Incident this guards against:** the local macOS FFmpeg build lacks the libass
`ass`/`subtitles`/`drawtext` filters. merge-rust's burn step then fails **open**
("subtitle burn failed-open: using no-subtitle mp4"), so a job could reach
`processed` + Discord upload with new TTS audio but **no visible subtitles**.

The gate (`src/subtitle-gate.js`) runs between the merge-rust result and the
Discord upload, whenever the pipeline reports subtitle context:

1. **Recover** — when subtitles are required (`skip_subtitles=false`) and the
   pipeline's `final_subtitles.srt` exists, render one transparent PNG per SRT
   cue with the existing `merge-rust/scripts/generate_overlay.py` JSON-stdin
   contract (Pillow in a **managed venv**, never global site-packages) and
   composite them with plain-ffmpeg `overlay` (present even in libass-less
   builds). TTS audio is stream-copied (`-c:a copy`); output duration is
   explicitly bounded (`-t`). Subtitle text/timings come ONLY from
   `final_subtitles.srt` — nothing is ever invented.
2. **Style** — legacy 720x1280 parity, scaled to the actual resolution:
   FC Iconic Bold (`merge-rust/font.ttf`), white fill, thick black outline
   (~10px per side at 1280), no background box, lower/lower-middle placement
   (text-box center ≈ 0.74×H, from the legacy ASS bottom-center MarginV=250).
3. **Verify** — machine-readable artifact (`verification.json`): every cue's
   overlay PNG must contain non-transparent text pixels; full decode must
   pass; output duration must stay within tolerance of the input; sampled
   per-cue midpoint frames are diffed against the pre-overlay video inside the
   overlay's inked bbox (changed + white/dark tone pixels); a labelled proof
   contact sheet PNG is rendered; the decoded output audio fingerprint must
   differ from the source (new voiceover). Only then does the job upload to
   Discord and become `processed`.
4. **Fail closed** — any missing dependency (venv python, Pillow, helper
   scripts, font) or failed check marks the job `failed` with a sanitized
   `error_category` (e.g. `subtitle_python_missing`, `subtitle_srt_missing`,
   `subtitle_overlay_empty`, `subtitle_pixels_not_detected`,
   `subtitle_output_duration_out_of_bounds`, `output_audio_unchanged`) and
   **nothing is uploaded** — no provisional no-subtitle Discord message can
   become canonical. Failure evidence is persisted too.

Persistent, sanitized evidence lives under
`<MEDIA_ROOT>/verification/job-<id>/` (`verification.json` +
`proof-sheet.png`) and in `processing_jobs.subtitle_verification_json`
(+ `subtitles_required` / `subtitles_verified` / `audio_changed` flags). Job
temp dirs stay temp-only as before.

Setup (one-time, no global pip mutation):

```bash
cd apps/admin-media-drive
npm run setup:venv     # creates .venv with Pillow for the gate
```

Offline end-to-end proof (no Discord/Vertex/network):

```bash
node scripts/smoke-subtitle-gate.mjs        # builds lavfi videos + Thai SRT,
                                            # runs the real gate, prints the
                                            # verification record
```

`SUBTITLE_GATE_ENABLED=0` disables the gate (reverts to the incident
behavior) — keep it enabled.

Prerequisites for the real path:

- `ffmpeg`, `ffprobe`, Rust/Cargo, and network access to Vertex APIs.
- `GOOGLE_APPLICATION_CREDENTIALS` or `VERTEX_TTS_SERVICE_ACCOUNT_JSON` in the
  local environment. Do not log or paste the credential contents.
- If merge-rust runs as an already-started service, it must run on the same Mac
  or otherwise be able to call the local callback URL.

merge-rust ownership: an empty `MERGE_RUST_URL` **and** any loopback
`MERGE_RUST_URL` (e.g. `http://127.0.0.1:18080`) mean the service is *locally
owned* — this app may start it (Cargo, or `MERGE_RUST_BIN` if set) on that
port. Only a non-loopback URL is treated as an external service that is never
started from here. Two things start the locally owned service:

- the `com.affiliate.admin-media-drive.merge-rust` LaunchAgent (primary owner:
  starts it at boot and supervises it — see the launchd section below), and
- the worker, as a per-job fallback whenever the local service is down.

To run the supervisor manually in one terminal instead:

```bash
cd apps/admin-media-drive
npm run start:merge-rust
```

That command loads `apps/admin-media-drive/.env` before starting Cargo, so
`GOOGLE_APPLICATION_CREDENTIALS` and Vertex settings are inherited by
merge-rust. It stays in the foreground while the service runs and exits
non-zero when the service dies (launchd uses that to restart the agent).

Then run one queued job from another terminal:

Run one queued job:

```bash
npm run process:once
```

Poll for queued jobs:

```bash
npm run process
```

Sample local API flow:

```bash
curl -s http://127.0.0.1:3100/api/processor/health

curl -s -X POST http://127.0.0.1:3100/api/sync-channel \
  -H 'content-type: application/json' \
  -d '{"channelId":"'"$SOURCE_CHANNEL_ID"'","limit":50}'

curl -s 'http://127.0.0.1:3100/api/media-items?channelId='"$SOURCE_CHANNEL_ID"'&limit=50'

curl -s -X POST http://127.0.0.1:3100/api/processor/jobs \
  -H 'content-type: application/json' \
  -d '{"mediaItemId":1}'

curl -s -X POST http://127.0.0.1:3100/api/processor/run-next
```

Verification:

```bash
npm test --prefix apps/admin-media-drive
node --check apps/admin-media-drive/src/worker.js
cargo test --manifest-path apps/video-affiliate/merge-rust/Cargo.toml
```

---

## Configuration (`.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3100` | HTTP port (bind host is always `127.0.0.1`). |
| `STORAGE_MODE` | `discord` | `discord` = Discord-backed metadata-only index (default). `mirror` = legacy local copy under `MEDIA_ROOT`. |
| `DISCORD_BOT_TOKEN` | — | Bot token. **Never commit this.** |
| `DISCORD_GUILD_ID` | — | Guild the bot reads/writes. |
| `DEFAULT_CHANNEL_ID` | — | Pre-selected upload channel. |
| `SOURCE_CHANNEL_ID` | — (empty) | Discord channel for **original** files (`#คลังต้นฉบับ`). Channel id, not a secret. |
| `PROCESSED_CHANNEL_ID` | — (empty) | Discord channel for **processed** files (`#ประมวลผลแล้ว`). Channel id, not a secret. |
| `MAX_UPLOAD_BYTES` | `10485760` | Max single upload size (bytes). |
| `MEDIA_ROOT` | `/Users/yok-macmini/AffiliateMedia/admin-media-drive` | Temp/cache dir (discord mode); permanent mirror root (mirror mode). |
| `DB_PATH` | `/Users/yok-macmini/Library/Application Support/AffiliateAdmin/admin-media-drive.sqlite` | SQLite index file (parent dir auto-created). |
| `NAMESPACE_ID` | `admin` | Logical namespace stamped on indexed rows. |
| `PROCESSOR_MODE` | `merge_rust` | Default real processor. Set `ffmpeg` only for explicit legacy simple-transcode fallback. |
| `MERGE_RUST_URL` | — (empty) | Empty **and loopback** URLs = locally owned service on that port: started/supervised by the merge-rust LaunchAgent, with a per-job worker spawn fallback. Non-loopback = external service, never started from here. |
| `MERGE_RUST_ROOT` | repo `apps/video-affiliate/merge-rust` | Local merge-rust source dir for Cargo auto-start and font path. |
| `MERGE_RUST_BIN` | — (empty) | Optional built merge-rust binary. If empty, auto-start uses `cargo run --quiet`. |
| `MERGE_RUST_PORT` | `18080` | Local merge-rust service port when auto-starting/reusing. |
| `MERGE_RUST_CALLBACK_PORT` | `0` | Local callback port. `0` = random free loopback port per job. |
| `MERGE_RUST_CALLBACK_URL` | — (empty) | Override callback public URL. Usually blank for same-Mac processing. |
| `MERGE_RUST_JOB_TIMEOUT_MS` | `3600000` | Max wait for one real pipeline job. |
| `PROCESSOR_FINAL_UPLOAD_MAX_BYTES` | `10485760` | Final MP4 ceiling passed to auto-started merge-rust as `R2_UPLOAD_MAX_BYTES` so Discord upload stays under cap. |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Local Vertex service-account JSON path. Never commit or print the file contents. |
| `PROCESSOR_GEMINI_MODEL` | `gemini-3-flash-preview` | Vertex Gemini analysis/script model sent to merge-rust. |
| `VERTEX_TTS_ENDPOINT` | `https://aiplatform.googleapis.com` | Vertex endpoint used by merge-rust. |
| `VERTEX_TTS_PROJECT_ID` | service account project | Optional override; merge-rust can read project id from the service account. |
| `VERTEX_TTS_LOCATION` | `global` | Required by current Gemini TTS path. |
| `VERTEX_TTS_MODEL` | `gemini-3.1-flash-tts-preview` | Vertex Gemini TTS model; matches the current video-affiliate flow. |
| `PROCESSOR_VOICE_NAME` | `Puck` | Default Gemini TTS voice name; matches Worker defaults. |
| `FFMPEG_BIN` | `ffmpeg` | Legacy `PROCESSOR_MODE=ffmpeg` binary and merge-rust dependency from `PATH`. |
| `FFPROBE_BIN` | `ffprobe` | Legacy `PROCESSOR_MODE=ffmpeg` binary and merge-rust dependency from `PATH`. |
| `FFMPEG_VIDEO_ENCODER` | `auto` | Used only by `PROCESSOR_MODE=ffmpeg`. |
| `KEEP_PROCESSING_TMP` | `0` | `1` keeps job temp dirs for debugging; default cleans after success/failure. |
| `PROCESS_POLL_MS` | `30000` | Poll interval for `npm run process`. |
| `SUBTITLE_GATE_ENABLED` | `1` | Fail-closed subtitle/audio verification gate. `0` reverts to the false-success incident behavior — keep enabled. |
| `SUBTITLE_PYTHON_BIN` | `<app>/.venv/bin/python3` | Managed Pillow venv python (create with `npm run setup:venv`). Missing ⇒ gate fails closed `subtitle_python_missing`. |
| `SUBTITLE_OVERLAY_HELPER` | merge-rust `scripts/generate_overlay.py` | Existing JSON-stdin PNG overlay renderer. |
| `SUBTITLE_PROOF_HELPER` | `<app>/scripts/subtitle_proof.py` | Pillow measurement helper (overlay pixels, frame diffs, proof sheet, text detection). |
| `SUBTITLE_FONT_PATH` | merge-rust `font.ttf` | Bundled FC Iconic Bold. |
| `SUBTITLE_MAX_CUES` | `240` | Overlay fallback bound; more cues ⇒ `subtitle_cue_count_exceeded`. |
| `SUBTITLE_MAX_SAMPLED_FRAMES` | `12` | Per-cue midpoint frames verified per job (evenly sampled incl. first/last). |
| `SUBTITLE_DURATION_TOLERANCE_MS` | `1500` | Max abs(output−input) duration drift. |
| `SUBTITLE_CENTER_Y_RATIO` | `0.74` | Text-box center (legacy lower/lower-middle). |
| `ADMIN_MEDIA_DRIVE_API_URL` | `http://127.0.0.1:3100` | MCP server → API base. Loopback only; anything else refused. |
| `MEDIA_SUBMIT_ALLOWED_ROOTS` | `~/Desktop:~/Downloads:~/Movies:~/AffiliateMedia/inbox` | Allowlisted roots for `media_submit_video` paths (colon-separated). |

Discovered channel ids (safe to keep in `.env` / examples — they are ids, not
secrets):

- `#คลังต้นฉบับ` (originals): `1522202812560310283`
- `#ประมวลผลแล้ว` (processed): `1518808518176800769`

Large files are rejected (HTTP 413) rather than chunked, because chunked files
do not show as one clean video in Discord's Media tab.

---

## Local mirror layout (mirror mode only)

In discord mode **nothing is written here** — this section applies only to the
legacy `mirror` mode. There, every upload/synced attachment is written under
`MEDIA_ROOT` as:

```
<MEDIA_ROOT>/<yyyy>/<mm>/<attachmentId>_<safeFilename>
```

- `yyyy`/`mm` come from the Discord message timestamp (UTC).
- `attachmentId` is Discord's globally-unique attachment id, so paths are
  deterministic and collision-free.
- `safeFilename` is sanitised: directory separators, control characters,
  leading dots, and `..` traversal tokens are stripped. The resolved path is
  re-checked to guarantee it stays under `MEDIA_ROOT`.

## SQLite index

Table `media_items`:

| column | notes |
|--------|-------|
| `id` | autoincrement PK |
| `namespace_id` | default `admin` |
| `channel_id`, `message_id`, `attachment_id` | Discord identity (`UNIQUE(namespace_id, attachment_id)`) |
| `filename`, `content_type`, `size` | attachment metadata |
| `local_path` | **null in discord mode**; mirror path in mirror mode (null if mirror failed) |
| `discord_url` | last-known CDN url (expires — use the fresh-url route instead) |
| `jump_url` | permalink to the Discord message |
| `status` | discord mode originals: `discord_indexed`; processed outputs: `processed_discord_indexed`. mirror mode: `mirrored` \| `indexed` \| `index_only` |
| `created_at`, `updated_at` | ISO timestamps |

Upserts key on `(namespace_id, attachment_id)`; a re-index never clobbers an
existing `local_path` or the original `created_at`.

Table `processing_jobs` records local processor lifecycle:

| column | notes |
|--------|-------|
| `id` | autoincrement PK |
| `namespace_id` | default `admin` |
| `source_media_item_id` | original `media_items.id` |
| `source_attachment_id`, `source_channel_id`, `source_message_id` | Discord identity for the original |
| `status` | `queued` \| `processing` \| `processed` \| `failed` |
| `step` | current short step such as `downloading`, `processing`, `uploading` |
| `options_json` | currently `{}` only; free-form caller options are not persisted |
| `temp_dir`, `input_path`, `output_path` | transient local paths; cleaned unless `KEEP_PROCESSING_TMP=1` |
| `output_media_item_id`, `output_attachment_id`, `output_channel_id`, `output_message_id` | processed Discord output |
| `error`, `attempts`, timestamps | retry/debug state; no secrets |
| `error_category` | sanitized machine-readable failure category (e.g. `subtitle_pixels_not_detected`) |
| `subtitles_required`, `subtitles_verified`, `audio_changed` | verification flags from the subtitle gate |
| `subtitle_verification_json` | sanitized verification artifact (cue metrics, proof-sheet path/sha256, reverify history) |

`media_items` also carries a nullable `source_sha256` (content hash for
idempotent submissions). Table `media_submissions` records idempotent
submissions: `(namespace_id, idempotency_key)` and
`(namespace_id, source_sha256)` are unique; rows point at the media item and
job produced by the first submission of that file.

---

## API

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/health` | Liveness + resolved config (no Discord required). |
| `GET` | `/api/status` | Discord connection + channels (UI). |
| `GET` | `/api/channels` | List uploadable text channels. |
| `GET` | `/api/channels/:channelId/media` | Recent media in a channel (live Discord). |
| `GET` | `/api/media/:channelId/:messageId/:attachmentId` | 302 redirect to a **fresh** CDN url. |
| `GET` | `/api/media-items` | List rows from the local SQLite index (`?channelId`, `?status`, `?limit`, `?offset`). |
| `POST` | `/api/sync-channel` | **discord mode:** index recent-message metadata only — no downloads; reports `{ mode, total, indexed, skipped, failed, downloaded: 0 }`. **mirror mode:** also downloads missing local mirrors. Body: `{ channelId, limit }`. |
| `GET` | `/api/local-media/:id/file` | **discord mode:** 302-redirects to a **fresh Discord URL** resolved from the DB row (no local file). **mirror mode:** serves the local mirror with HTTP `Range`. |
| `POST` | `/api/upload` | Upload to Discord. **discord mode:** insert index row (metadata only, no local file). **mirror mode:** also write local mirror. Multipart: `file`, `channelId`, `caption`. |
| `GET` | `/api/processor/health` | Processor mode, merge-rust health/model/voice info, queue counts, output-channel config, and sanitized `subtitleGate` readiness. No secrets. |
| `POST` | `/api/processor/jobs` | Enqueue a local processing job. Body: `{ "mediaItemId": 1 }` or `{ "attachmentId": "..." }`. |
| `GET` | `/api/processor/jobs` | List recent processor jobs (`?status`, `?limit`, `?offset`). |
| `GET` | `/api/processor/jobs/:id` | One job + its output media item + parsed subtitle verification artifact. |
| `POST` | `/api/processor/jobs/:id/run` | Process one queued/failed job immediately. |
| `POST` | `/api/processor/run-next` | Process the next queued job immediately. |
| `POST` | `/api/processor/jobs/:id/retry` | Move a failed job back to queued. |
| `POST` | `/api/processor/jobs/:id/verify` | Re-run deterministic decode/duration/subtitle-presence checks on a processed job's Discord output (fresh URL download). |
| `POST` | `/api/processor/submissions` | Idempotent submit: multipart `file` (+ optional `idempotencyKey`) → upload to `SOURCE_CHANNEL_ID`, index with sha256, enqueue exactly one job per distinct file. Dedupes by idempotency key and content hash; `409 idempotency_key_conflict` when a key is reused with different bytes. |

All routes are additive — existing response shapes used by `public/app.js` are
unchanged.

Sample local curls:

```bash
curl -s http://127.0.0.1:3100/api/processor/health

curl -s -X POST http://127.0.0.1:3100/api/processor/jobs \
  -H 'content-type: application/json' \
  -d '{"mediaItemId":123}'

curl -s -X POST http://127.0.0.1:3100/api/processor/run-next
```

---

## Safety notes

- Binds to `127.0.0.1` only (not configurable — local-first by design).
- Filenames are sanitised and every write/serve path is verified to stay under
  `MEDIA_ROOT` (no path traversal).
- The bot token is read from `.env`, never logged, and never returned by any
  endpoint. `.env` is git-ignored.
- Uploads are capped by `MAX_UPLOAD_BYTES`.

---

## MCP server (typed stdio)

`src/mcp-server.js` exposes the pipeline as **typed, constrained MCP tools**
over stdio using the official `@modelcontextprotocol/sdk` + zod. It is thin
orchestration only — all business logic stays in this app/merge-rust behind
the loopback REST API.

```bash
cd apps/admin-media-drive
npm run mcp        # stdio MCP server (command: node src/mcp-server.js)
```

Example client registration (any MCP host):

```json
{
  "command": "node",
  "args": ["/Users/yok-macmini/Developer/shopping-affiliate/apps/admin-media-drive/src/mcp-server.js"]
}
```

Tools (strict zod input/output schemas):

| Tool | Purpose |
|------|---------|
| `media_health` | Sanitized API + processor + subtitle-gate health. |
| `media_submit_video` | Absolute local path (validated: allowlisted roots, `.mp4/.mov/.m4v/.webm`, size cap) → upload to the configured SOURCE channel + enqueue once (sha256 + optional `idempotencyKey`). Returns job/media identity. |
| `media_job_status` | Job id → status/phase/attempts + sanitized `errorCategory` + verification flags. |
| `media_result` | Processed job → final Discord identity, local fresh-URL proxy status, `audioChanged`/`subtitlesRequired`/`subtitlesVerified`, proof-sheet identity. |
| `media_verify` | Re-run the deterministic ffprobe/decode/subtitle-presence proof for a processed job. |

Safety properties:

- API base URL **must be loopback** (`ADMIN_MEDIA_DRIVE_API_URL`, default
  `http://127.0.0.1:3100`) — anything else is refused at startup.
- No shell execution, no SQL, no raw HTTP/URL passthrough, no arbitrary
  channel ids, no arbitrary destination paths, no credentials in input or
  output. The MCP process itself needs **no Discord/Vertex secrets** — the
  LaunchAgent-owned API/worker processes own `.env`.
- `media_submit_video` resolves symlinks before the allowlist check
  (`MEDIA_SUBMIT_ALLOWED_ROOTS`, default `~/Desktop:~/Downloads:~/Movies:~/AffiliateMedia/inbox`).

---

## Run under launchd (permanent local service)

Templates live in `launchd/` and install as **user LaunchAgents** (no sudo):

- `com.affiliate.admin-media-drive.api` — API on `127.0.0.1:3100`.
- `com.affiliate.admin-media-drive.worker` — polls queued jobs (one active job
  at a time; no per-job GUI/process), enforces the subtitle gate, re-queues
  stale `processing` rows from crashed runs. Spawns merge-rust itself only as
  a per-job fallback when the local service is down.
- `com.affiliate.admin-media-drive.merge-rust` — supervises the locally owned
  merge-rust service (`node src/start-merge-rust.js`): starts it at boot on
  the loopback `MERGE_RUST_URL`/`MERGE_RUST_PORT` target so
  `/api/processor/health` reports `mergeRust.ok=true` even while idle and
  jobs never pay a cargo start. Its `KeepAlive` is `SuccessfulExit=false`:
  with an external (non-loopback) `MERGE_RUST_URL` the supervisor logs that
  and exits 0, so the agent stays stopped instead of respawn-looping; a crash
  exits 1 and launchd restarts it.

All plists: `RunAtLoad` + `KeepAlive`, `ThrottleInterval`, absolute
`/Users/yok-macmini/...` paths, logs under
`~/Library/Logs/admin-media-drive/{api,worker,merge-rust}.log` (rotated at
10 MB on restart by `scripts/launchd-run.sh`). Secrets stay in `.env` only —
`GOOGLE_APPLICATION_CREDENTIALS` there must be a file **path**; credential
JSON is never embedded in a plist.

```bash
cd apps/admin-media-drive
cp .env.example .env                        # fill locally; never commit
npm install
npm run setup:venv                          # managed Pillow venv for the gate
bash scripts/install-launchagents.sh        # lint + install + start all three agents
bash scripts/status-launchagents.sh         # agent state + health + venv check
bash scripts/uninstall-launchagents.sh      # stop + remove (keeps .env/DB/logs)
```

Verification commands:

```bash
npm test --prefix apps/admin-media-drive            # full suite
node --check apps/admin-media-drive/src/server.js   # syntax spot-check
node apps/admin-media-drive/scripts/smoke-subtitle-gate.mjs  # offline gate proof
curl -s http://127.0.0.1:3100/api/processor/health  # includes subtitleGate block
```
