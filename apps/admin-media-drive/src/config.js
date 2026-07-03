import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function str(value, fallback) {
  const trimmed = String(value ?? '').trim();
  return trimmed || fallback;
}

function boolFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

// Storage modes:
//   discord — Discord is the 100% source of truth for original + processed
//             media. The Mac mini only indexes metadata (SQLite) and never
//             keeps a permanent local copy. This is the default.
//   mirror  — legacy: also keep a permanent local filesystem mirror under
//             MEDIA_ROOT. Optional; kept for backwards compatibility only.
export const STORAGE_MODES = Object.freeze(['discord', 'mirror']);

/** Normalise an arbitrary STORAGE_MODE value; unknown/empty falls back to discord. */
export function normalizeStorageMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return STORAGE_MODES.includes(v) ? v : 'discord';
}

/** Default media_items.status for a given storage mode. */
export function defaultIndexStatus(mode) {
  return normalizeStorageMode(mode) === 'mirror' ? 'indexed' : 'discord_indexed';
}

export const config = {
  port: num(process.env.PORT, 3100),
  // Always loopback-only. Not configurable on purpose (see README safety notes).
  host: '127.0.0.1',
  // discord (default) = Discord-backed storage; mirror = legacy local mirror.
  storageMode: normalizeStorageMode(process.env.STORAGE_MODE),
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
  discord: {
    botToken: str(process.env.DISCORD_BOT_TOKEN, ''),
    guildId: str(process.env.DISCORD_GUILD_ID, ''),
    defaultChannelId: str(process.env.DEFAULT_CHANNEL_ID, ''),
    // #คลังต้นฉบับ — original files live in Discord (default empty).
    sourceChannelId: str(process.env.SOURCE_CHANNEL_ID, ''),
    // #ประมวลผลแล้ว — processed files live in Discord (default empty).
    processedChannelId: str(process.env.PROCESSED_CHANNEL_ID, ''),
  },
  namespaceId: str(process.env.NAMESPACE_ID, 'admin'),
  // In discord mode this is only a temp/cache dir used transiently during
  // processing (nothing is persisted here by default). In mirror mode it is the
  // permanent local mirror root.
  mediaRoot: path.resolve(str(
    process.env.MEDIA_ROOT,
    path.join(home, 'AffiliateMedia', 'admin-media-drive'),
  )),
  dbPath: path.resolve(str(
    process.env.DB_PATH,
    path.join(home, 'Library', 'Application Support', 'AffiliateAdmin', 'admin-media-drive.sqlite'),
  )),
  processor: {
    ffmpegBin: str(process.env.FFMPEG_BIN, 'ffmpeg'),
    ffprobeBin: str(process.env.FFPROBE_BIN, 'ffprobe'),
    videoEncoder: str(process.env.FFMPEG_VIDEO_ENCODER, 'auto').toLowerCase(),
    keepTmp: boolFlag(process.env.KEEP_PROCESSING_TMP),
    pollMs: num(process.env.PROCESS_POLL_MS, 30_000),
  },
};

export default config;
