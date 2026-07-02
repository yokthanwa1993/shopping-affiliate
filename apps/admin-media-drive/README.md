# admin-media-drive

Personal/admin **media drive** for Thanwa's Discord + Mac mini workflow. It is a
small, self-contained Express app (side-by-side with the other `apps/*`; it does
**not** touch `video-affiliate`, `facebook-token-cloak`, or any production app).

What it does:

- Uploads images/videos to a Discord channel as **native attachments** (so they
  appear in Discord's Media tab), ported from the original `media-drive`
  prototype.
- Keeps a **local filesystem mirror** of every uploaded/synced attachment.
- Maintains a **SQLite index** (`media_items`) so media is browsable and
  serveable locally even after Discord CDN URLs expire.

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

## Configuration (`.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3100` | HTTP port (bind host is always `127.0.0.1`). |
| `DISCORD_BOT_TOKEN` | — | Bot token. **Never commit this.** |
| `DISCORD_GUILD_ID` | — | Guild the bot reads/writes. |
| `DEFAULT_CHANNEL_ID` | — | Pre-selected upload channel. |
| `MAX_UPLOAD_BYTES` | `10485760` | Max single upload size (bytes). |
| `MEDIA_ROOT` | `/Users/yok-macmini/AffiliateMedia/admin-media-drive` | Local mirror root. |
| `DB_PATH` | `/Users/yok-macmini/Library/Application Support/AffiliateAdmin/admin-media-drive.sqlite` | SQLite index file (parent dir auto-created). |
| `NAMESPACE_ID` | `admin` | Logical namespace stamped on indexed rows. |

Large files are rejected (HTTP 413) rather than chunked, because chunked files
do not show as one clean video in Discord's Media tab.

---

## Local mirror layout

Every upload/synced attachment is written under `MEDIA_ROOT` as:

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
| `local_path` | mirror path (null if mirror failed / index-only) |
| `discord_url` | last-known CDN url (expires) |
| `jump_url` | permalink to the Discord message |
| `status` | `mirrored` \| `indexed` \| `index_only` |
| `created_at`, `updated_at` | ISO timestamps |

Upserts key on `(namespace_id, attachment_id)`; a re-index never clobbers an
existing `local_path` or the original `created_at`.

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
| `POST` | `/api/sync-channel` | Index recent media of a channel and download any **missing** local mirrors. Body: `{ channelId, limit }`. |
| `GET` | `/api/local-media/:id/file` | Serve a locally-mirrored file (supports HTTP `Range`). |
| `POST` | `/api/upload` | Upload to Discord **and** write local mirror + index row. Multipart: `file`, `channelId`, `caption`. |

---

## Safety notes

- Binds to `127.0.0.1` only (not configurable — local-first by design).
- Filenames are sanitised and every write/serve path is verified to stay under
  `MEDIA_ROOT` (no path traversal).
- The bot token is read from `.env`, never logged, and never returned by any
  endpoint. `.env` is git-ignored.
- Uploads are capped by `MAX_UPLOAD_BYTES`.

---

## Future: run under launchd (not enabled here)

To keep the drive running on the Mac mini, a user LaunchAgent can be added
**manually** later (this app does not install one). Sketch:

- Create `~/Library/LaunchAgents/com.affiliate.admin-media-drive.plist` running
  `node <repo>/apps/admin-media-drive/src/server.js`.
- Set `RunAtLoad` + `KeepAlive`, `WorkingDirectory` to the app dir, and load the
  `.env` via a wrapper or `EnvironmentVariables`.
- `launchctl load -w ~/Library/LaunchAgents/com.affiliate.admin-media-drive.plist`.

Keep secrets out of the plist — reference `.env` instead.
