import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const defaultMergeRustRoot = path.resolve(__dirname, '..', '..', 'video-affiliate', 'merge-rust');

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numAllowZero(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
export const PROCESSOR_MODES = Object.freeze(['merge_rust', 'ffmpeg']);

/** Normalise an arbitrary STORAGE_MODE value; unknown/empty falls back to discord. */
export function normalizeStorageMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return STORAGE_MODES.includes(v) ? v : 'discord';
}

/** Normalise PROCESSOR_MODE; the real legacy merge-rust pipeline is the default. */
export function normalizeProcessorMode(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return PROCESSOR_MODES.includes(v) ? v : 'merge_rust';
}

/** Default media_items.status for a given storage mode. */
export function defaultIndexStatus(mode) {
  return normalizeStorageMode(mode) === 'mirror' ? 'indexed' : 'discord_indexed';
}

const mediaRoot = path.resolve(str(
  process.env.MEDIA_ROOT,
  path.join(home, 'AffiliateMedia', 'admin-media-drive'),
));
const mergeRustRoot = path.resolve(str(process.env.MERGE_RUST_ROOT, defaultMergeRustRoot));

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
  // processing (nothing is persisted here by default; the small persisted
  // exception is subtitleGate.verificationRoot below). In mirror mode it is
  // the permanent local mirror root.
  mediaRoot,
  dbPath: path.resolve(str(
    process.env.DB_PATH,
    path.join(home, 'Library', 'Application Support', 'AffiliateAdmin', 'admin-media-drive.sqlite'),
  )),
  processor: {
    mode: normalizeProcessorMode(process.env.PROCESSOR_MODE),
    ffmpegBin: str(process.env.FFMPEG_BIN, 'ffmpeg'),
    ffprobeBin: str(process.env.FFPROBE_BIN, 'ffprobe'),
    videoEncoder: str(process.env.FFMPEG_VIDEO_ENCODER, 'auto').toLowerCase(),
    keepTmp: boolFlag(process.env.KEEP_PROCESSING_TMP),
    pollMs: num(process.env.PROCESS_POLL_MS, 30_000),
    mergeRustUrl: str(process.env.MERGE_RUST_URL, ''),
    mergeRustRoot,
    mergeRustBin: str(process.env.MERGE_RUST_BIN, ''),
    cargoBin: str(process.env.CARGO_BIN, 'cargo'),
    mergeRustPort: num(process.env.MERGE_RUST_PORT, 18080),
    mergeRustStartTimeoutMs: num(process.env.MERGE_RUST_START_TIMEOUT_MS, 180_000),
    mergeRustJobTimeoutMs: num(process.env.MERGE_RUST_JOB_TIMEOUT_MS, 60 * 60_000),
    callbackHost: '127.0.0.1',
    callbackPort: numAllowZero(process.env.MERGE_RUST_CALLBACK_PORT, 0),
    callbackPublicUrl: str(process.env.MERGE_RUST_CALLBACK_URL, ''),
    finalUploadMaxBytes: num(process.env.PROCESSOR_FINAL_UPLOAD_MAX_BYTES, num(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024)),
    geminiModel: str(process.env.PROCESSOR_GEMINI_MODEL || process.env.GEMINI_MODEL, 'gemini-3-flash-preview'),
    vertexTtsEndpoint: str(process.env.VERTEX_TTS_ENDPOINT, 'https://aiplatform.googleapis.com'),
    vertexTtsProjectId: str(process.env.VERTEX_TTS_PROJECT_ID, ''),
    vertexTtsLocation: str(process.env.VERTEX_TTS_LOCATION, 'global'),
    vertexTtsModel: str(process.env.VERTEX_TTS_MODEL, 'gemini-3.1-flash-tts-preview'),
    voiceName: str(process.env.PROCESSOR_VOICE_NAME, 'Puck'),
  },
  // Fail-closed subtitle verification gate (see src/subtitle-gate.js). The
  // local FFmpeg lacks libass, so subtitle burns are recovered with Pillow
  // PNG overlays from a managed venv and verified pixel-by-pixel before any
  // Discord upload. Disabling this reverts to the false-success incident
  // behavior — keep it enabled.
  subtitleGate: {
    enabled: process.env.SUBTITLE_GATE_ENABLED === undefined
      ? true
      : boolFlag(process.env.SUBTITLE_GATE_ENABLED),
    // Managed Python (venv with Pillow). Never uses global site-packages.
    pythonBin: str(process.env.SUBTITLE_PYTHON_BIN, path.join(appRoot, '.venv', 'bin', 'python3')),
    // Existing merge-rust overlay renderer (JSON on stdin -> RGBA PNG).
    overlayHelperPath: str(
      process.env.SUBTITLE_OVERLAY_HELPER,
      path.join(mergeRustRoot, 'scripts', 'generate_overlay.py'),
    ),
    proofHelperPath: str(
      process.env.SUBTITLE_PROOF_HELPER,
      path.join(appRoot, 'scripts', 'subtitle_proof.py'),
    ),
    // Bundled FC Iconic Bold (byte-identical to assets/fonts/FC Iconic Bold.ttf).
    fontPath: str(process.env.SUBTITLE_FONT_PATH, path.join(mergeRustRoot, 'font.ttf')),
    maxCues: num(process.env.SUBTITLE_MAX_CUES, 240),
    maxSampledFrames: num(process.env.SUBTITLE_MAX_SAMPLED_FRAMES, 12),
    durationToleranceMs: num(process.env.SUBTITLE_DURATION_TOLERANCE_MS, 1500),
    centerYRatio: num(process.env.SUBTITLE_CENTER_Y_RATIO, 0.74),
    // Small persisted evidence dir: verification.json + proof-sheet.png per job.
    verificationRoot: path.join(mediaRoot, 'verification'),
  },
};

export default config;
