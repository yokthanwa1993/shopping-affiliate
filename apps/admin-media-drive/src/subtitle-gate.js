/**
 * Durable fail-closed subtitle gate for the merge-rust processing path.
 *
 * Incident this exists for: the local macOS FFmpeg lacks the libass
 * `ass`/`subtitles`/`drawtext` filters, so merge-rust's burn step fails OPEN
 * and the "processed" MP4 keeps its TTS audio but has NO burned subtitles —
 * which then used to be uploaded to Discord and marked processed.
 *
 * This gate runs between the merge-rust pipeline result and the Discord
 * upload. When subtitles are required (skip_subtitles=false) and
 * `final_subtitles.srt` exists it:
 *
 *   1. renders one transparent PNG per SRT cue with the existing
 *      merge-rust `scripts/generate_overlay.py` JSON-stdin contract, using the
 *      bundled FC Iconic Bold font and the legacy 720x1280 style (white fill,
 *      ~10px/side black outline, no box, lower/lower-middle placement);
 *   2. proves every overlay PNG has non-transparent text pixels;
 *   3. composites the overlays with plain FFmpeg `overlay` (available even in
 *      libass-less builds), preserving TTS audio (`-c:a copy`) and explicitly
 *      bounding the output duration;
 *   4. verifies the result: full decode, bounded duration, per-cue midpoint
 *      frame diffs against the pre-overlay video, and a labelled proof sheet;
 *   5. confirms the decoded audio fingerprint differs from the source
 *      (new voiceover expected).
 *
 * Any missing dependency (managed Python venv, Pillow, helper scripts, font)
 * or failed check throws `SubtitleGateError` with a sanitized category — the
 * job is marked failed and NOTHING is uploaded to Discord. Subtitle text and
 * timings come only from final_subtitles.srt; nothing is ever invented.
 */

import crypto from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadTo, ensureDir, fsp } from './storage.js';
import { selectVideoEncoder } from './processor.js';
import {
  SrtError,
  canonicalCueText,
  parseSrt,
  validateCuesForBurn,
} from './srt.js';

const PROBE_TIMEOUT_MS = 30_000;
const OVERLAY_PYTHON_TIMEOUT_MS = 30_000;
const PROOF_HELPER_TIMEOUT_MS = 180_000;
const BURN_TIMEOUT_MS = 20 * 60_000;
const DECODE_TIMEOUT_MS = 10 * 60_000;
const FRAME_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

const MIN_OVERLAY_OPAQUE_PIXELS = 200;
const PREBURN_BAND_MIN_PIXELS = 400;
const REVERIFY_MIN_PIXELS = 60;

export const GATE_ENGINE = 'amd-subtitle-gate/1';

/** Legacy merge-rust subtitle look (see merge-rust/debug_subtitles.ass). */
export const LEGACY_SUBTITLE_STYLE = Object.freeze({
  refWidth: 720,
  refHeight: 1280,
  fontSize: 82,
  // ASS Outline=10 is per-side; generate_overlay.py halves its outline_width,
  // so 20 total reproduces the legacy ~10px/side black stroke.
  outlineWidthTotal: 20,
  fillColor: '#FFFFFF',
  outlineColor: '#000000',
  bgColor: '',
  bgOpacity: 0,
  // Legacy ASS is bottom-center with MarginV=250 at 1280 → the text box
  // center sits around 0.74×H (lower / lower-middle).
  centerYRatio: 0.74,
  padX: 40,
  padY: 24,
  lineSpacingPx: 12,
  maxBoxWidthRatio: 0.96,
  maxBoxHeightRatio: 0.30,
  minFontSize: 30,
});

export class SubtitleGateError extends Error {
  constructor(category, detail = '', { record = null } = {}) {
    super(category);
    this.name = 'SubtitleGateError';
    this.category = category;
    this.detail = String(detail || '').slice(0, 400);
    this.status = 422;
    this.record = record;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function secondsArg(ms, extraMs = 0) {
  return ((Math.max(0, ms) + extraMs) / 1000).toFixed(3);
}

/** Run a binary with text on stdin, capturing stdout/stderr. */
export function runWithStdin(bin, args, stdinText, {
  execFileImpl = nodeExecFile,
  timeoutMs = 30_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileImpl(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = String(stdout || '');
          error.stderr = String(stderr || '');
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
    if (stdinText !== null && stdinText !== undefined && child?.stdin) {
      child.stdin.on?.('error', () => {});
      child.stdin.write(stdinText);
      child.stdin.end();
    }
  });
}

/** generate_overlay.py JSON-stdin payload for one cue, legacy-style scaled. */
export function buildOverlayPayload({
  text,
  width,
  height,
  fontPath,
  outputPath,
  style = LEGACY_SUBTITLE_STYLE,
}) {
  const scale = height / style.refHeight;
  const outline = Math.max(2, 2 * Math.round((style.outlineWidthTotal * scale) / 2));
  return {
    text: String(text),
    width: Math.round(width),
    height: Math.round(height),
    font_path: fontPath,
    font_size: Math.max(style.minFontSize, Math.round(style.fontSize * scale)),
    fill_color: style.fillColor,
    secondary_fill_color: '',
    bg_color: style.bgColor,
    bg_opacity: style.bgOpacity,
    outline_color: style.outlineColor,
    outline_width: outline,
    pad_x: Math.max(8, Math.round(style.padX * scale)),
    pad_y: Math.max(8, Math.round(style.padY * scale)),
    line_spacing_px: Math.max(4, Math.round(style.lineSpacingPx * scale)),
    center_y: Math.round(height * style.centerYRatio),
    output_path: outputPath,
    auto_fit: true,
    max_box_width: Math.round(width * style.maxBoxWidthRatio),
    max_box_height: Math.round(height * style.maxBoxHeightRatio),
    min_font_size: style.minFontSize,
  };
}

/**
 * FFmpeg filtergraph chaining one enable-gated overlay per cue.
 * Input 0 is the video; inputs 1..N are the per-cue PNGs (same size as the
 * video, so they composite at 0:0).
 */
export function buildOverlayFilterGraph(cues) {
  if (!cues.length) throw new SubtitleGateError('subtitle_srt_empty');
  const steps = [];
  let prev = '[0:v]';
  cues.forEach((cue, i) => {
    const out = i === cues.length - 1 ? '[vout]' : `[v${i + 1}]`;
    const start = secondsArg(cue.startMs);
    const end = secondsArg(cue.endMs);
    steps.push(`${prev}[${i + 1}:v]overlay=0:0:enable='between(t,${start},${end})'${out}`);
    prev = out;
  });
  return steps.join(';\n');
}

/** Video bitrate that keeps duration×bitrate under the Discord upload cap. */
export function computeTargetVideoKbps({
  durationSec,
  maxBytes,
  audioKbpsAllowance = 192,
  ceilingKbps = 3500,
  floorKbps = 300,
  headroom = 0.85,
} = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return 2500;
  }
  const usableKbits = (maxBytes * 8 * headroom) / 1000;
  const kbps = Math.floor(usableKbits / durationSec - audioKbpsAllowance);
  return Math.max(floorKbps, Math.min(ceilingKbps, kbps));
}

/** Full ffmpeg argv for the bounded overlay burn. TTS audio is stream-copied. */
export function buildBurnArgs({
  videoPath,
  overlayPaths,
  filterScriptPath,
  outputPath,
  encoder = 'libx264',
  videoKbps = 2500,
  durationMs,
}) {
  const encoderArgs = encoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', 'fast'];
  return [
    '-hide_banner',
    '-y',
    '-i', videoPath,
    ...overlayPaths.flatMap((p) => ['-i', p]),
    '-filter_complex_script', filterScriptPath,
    '-map', '[vout]',
    '-map', '0:a:0?',
    ...encoderArgs,
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${Math.round(videoKbps * 1.45)}k`,
    '-bufsize', `${videoKbps * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    // Explicit duration bound: never emit more than source + 300ms.
    '-t', secondsArg(durationMs, 300),
    '-f', 'mp4',
    outputPath,
  ];
}

/** Evenly sample up to `max` cues, always including the first and last. */
export function sampleCues(cues, max) {
  if (cues.length <= max) return [...cues];
  const picked = [];
  const seen = new Set();
  for (let k = 0; k < max; k += 1) {
    const idx = Math.round((k * (cues.length - 1)) / (max - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      picked.push(cues[idx]);
    }
  }
  return picked;
}

export function cueMidpointMs(cue, videoDurationMs) {
  let mid = cue.startMs + (cue.endMs - cue.startMs) / 2;
  if (cue.endMs - cue.startMs >= 240) {
    mid = Math.min(Math.max(mid, cue.startMs + 120), cue.endMs - 120);
  }
  if (Number.isFinite(videoDurationMs)) {
    mid = Math.min(mid, Math.max(0, videoDurationMs - 100));
  }
  return Math.max(0, Math.round(mid));
}

/** Per-cue frame-diff pass policy (measurements come from subtitle_proof.py). */
export function frameCheckPassed(check, overlayOpaquePixels) {
  const opaque = Math.max(1, Number(overlayOpaquePixels) || 0);
  const changedOk = check.changedPixels >= Math.max(150, Math.round(opaque * 0.15));
  const whiteOk = check.whiteChangedPixels >= Math.max(60, Math.round(opaque * 0.03));
  const darkOk = check.darkChangedPixels >= Math.max(60, Math.round(opaque * 0.03));
  // White-on-white or outline-on-black backgrounds hide one of the two tones,
  // so require the changed mass plus at least one tone signature.
  return changedOk && (whiteOk || darkOk);
}

function mapHelperError(error, { helperKind }) {
  const stderr = String(error?.stderr || '');
  if (error?.code === 'ENOENT') return 'subtitle_python_missing';
  if (stderr.includes('AMD_PROOF_ERROR:pillow_missing') || stderr.includes('No module named')) {
    return 'subtitle_pillow_missing';
  }
  if (error?.killed || error?.signal === 'SIGTERM') return `subtitle_${helperKind}_timeout`;
  return `subtitle_${helperKind}_failed`;
}

export class SubtitleGate {
  constructor({
    gateCfg = {},
    ffmpegBin = 'ffmpeg',
    ffprobeBin = 'ffprobe',
    videoEncoder = 'auto',
    finalUploadMaxBytes = 10 * 1024 * 1024,
    execFileImpl = nodeExecFile,
    downloadFile = downloadTo,
    platform = process.platform,
  } = {}) {
    this.cfg = {
      enabled: gateCfg.enabled !== false,
      pythonBin: gateCfg.pythonBin || '',
      overlayHelperPath: gateCfg.overlayHelperPath || '',
      proofHelperPath: gateCfg.proofHelperPath || '',
      fontPath: gateCfg.fontPath || '',
      maxCues: gateCfg.maxCues || 240,
      maxSampledFrames: gateCfg.maxSampledFrames || 12,
      durationToleranceMs: gateCfg.durationToleranceMs || 1500,
      centerYRatio: gateCfg.centerYRatio || LEGACY_SUBTITLE_STYLE.centerYRatio,
      verificationRoot: gateCfg.verificationRoot || '',
    };
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
    this.videoEncoder = videoEncoder;
    this.finalUploadMaxBytes = finalUploadMaxBytes;
    this.execFileImpl = execFileImpl;
    this.downloadFile = downloadFile;
    this.platform = platform;
    this.style = { ...LEGACY_SUBTITLE_STYLE, centerYRatio: this.cfg.centerYRatio };
    this._preflightCache = null;
  }

  get enabled() {
    return this.cfg.enabled;
  }

  fail(category, detail, record) {
    throw new SubtitleGateError(category, detail, { record });
  }

  /**
   * Sanitized dependency check for the overlay fallback path. Cached briefly
   * so /api/processor/health can include it without spawning Python each call.
   */
  async preflight({ fresh = false } = {}) {
    if (!fresh && this._preflightCache && Date.now() - this._preflightCache.at < 60_000) {
      return this._preflightCache.value;
    }
    const categories = [];
    const value = {
      ok: false,
      enabled: this.cfg.enabled,
      python: false,
      pillow: false,
      pillowVersion: '',
      overlayHelper: fs.existsSync(this.cfg.overlayHelperPath || ''),
      proofHelper: fs.existsSync(this.cfg.proofHelperPath || ''),
      font: fs.existsSync(this.cfg.fontPath || ''),
      categories,
    };
    if (!value.overlayHelper) categories.push('subtitle_overlay_helper_missing');
    if (!value.proofHelper) categories.push('subtitle_proof_helper_missing');
    if (!value.font) categories.push('subtitle_font_missing');
    try {
      const { stdout } = await runWithStdin(
        this.cfg.pythonBin,
        ['-c', 'import PIL, PIL.Image, PIL.ImageDraw; print(PIL.__version__)'],
        null,
        { execFileImpl: this.execFileImpl, timeoutMs: 15_000 },
      );
      value.python = true;
      value.pillow = true;
      value.pillowVersion = stdout.trim().split(/\s+/)[0] || '';
    } catch (error) {
      if (error?.code === 'ENOENT' || !this.cfg.pythonBin) {
        categories.push('subtitle_python_missing');
      } else {
        value.python = true;
        categories.push('subtitle_pillow_missing');
      }
    }
    value.ok = categories.length === 0;
    this._preflightCache = { at: Date.now(), value };
    return value;
  }

  async preflightOrThrow(record) {
    const pre = await this.preflight({ fresh: true });
    if (!pre.ok) this.fail(pre.categories[0], pre.categories.join(','), record);
    return pre;
  }

  async runFfprobe(args, timeoutMs = PROBE_TIMEOUT_MS) {
    return runWithStdin(this.ffprobeBin, args, null, {
      execFileImpl: this.execFileImpl,
      timeoutMs,
    });
  }

  async runFfmpeg(args, timeoutMs) {
    return runWithStdin(this.ffmpegBin, args, null, {
      execFileImpl: this.execFileImpl,
      timeoutMs,
    });
  }

  async probe(videoPath, record) {
    let parsed;
    try {
      const { stdout } = await this.runFfprobe([
        '-v', 'error',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        videoPath,
      ]);
      parsed = JSON.parse(stdout || '{}');
    } catch (error) {
      this.fail('output_probe_failed', error?.message, record);
    }
    const video = (parsed.streams || []).find((s) => s.codec_type === 'video');
    const audio = (parsed.streams || []).find((s) => s.codec_type === 'audio');
    const durationSec = Number(parsed.format?.duration || video?.duration || 0);
    if (!video || !Number.isFinite(durationSec) || durationSec <= 0) {
      this.fail('output_probe_failed', 'missing video stream or duration', record);
    }
    return {
      durationMs: Math.round(durationSec * 1000),
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      hasAudio: Boolean(audio),
    };
  }

  async listFilters() {
    try {
      const { stdout, stderr } = await this.runFfmpeg(['-hide_banner', '-filters'], PROBE_TIMEOUT_MS);
      const text = `${stdout}\n${stderr}`;
      const has = (name) => new RegExp(`\\s${name}\\s`).test(text);
      return {
        ass: has('ass'),
        subtitles: has('subtitles'),
        drawtext: has('drawtext'),
        overlay: has('overlay'),
      };
    } catch {
      return { ass: false, subtitles: false, drawtext: false, overlay: false };
    }
  }

  async assertDecodes(videoPath, record) {
    try {
      const { stderr } = await this.runFfmpeg([
        '-hide_banner',
        '-v', 'error',
        '-i', videoPath,
        '-f', 'null', '-',
      ], DECODE_TIMEOUT_MS);
      const firstError = String(stderr || '').split(/\r?\n/).find((l) => l.trim());
      if (firstError) this.fail('output_decode_failed', firstError, record);
    } catch (error) {
      if (error instanceof SubtitleGateError) throw error;
      this.fail('output_decode_failed', error?.message, record);
    }
  }

  async extractFrame(videoPath, ms, outPng, record) {
    try {
      await this.runFfmpeg([
        '-hide_banner', '-y',
        '-ss', secondsArg(ms),
        '-i', videoPath,
        '-frames:v', '1',
        outPng,
      ], FRAME_TIMEOUT_MS);
      if (!fs.existsSync(outPng)) throw new Error('frame_not_written');
    } catch (error) {
      if (error instanceof SubtitleGateError) throw error;
      this.fail('subtitle_frame_extract_failed', error?.message, record);
    }
  }

  async runProofHelper(payload, record) {
    try {
      const { stdout } = await runWithStdin(
        this.cfg.pythonBin,
        [this.cfg.proofHelperPath],
        JSON.stringify(payload),
        { execFileImpl: this.execFileImpl, timeoutMs: PROOF_HELPER_TIMEOUT_MS },
      );
      const parsed = JSON.parse(stdout || '{}');
      if (!parsed.ok) throw new Error('proof_helper_not_ok');
      return parsed;
    } catch (error) {
      if (error instanceof SubtitleGateError) throw error;
      this.fail(mapHelperError(error, { helperKind: 'proof_helper' }), error?.message, record);
    }
  }

  async generateOverlayPng(payload, record) {
    try {
      await runWithStdin(
        this.cfg.pythonBin,
        [this.cfg.overlayHelperPath],
        JSON.stringify(payload),
        { execFileImpl: this.execFileImpl, timeoutMs: OVERLAY_PYTHON_TIMEOUT_MS },
      );
      if (!fs.existsSync(payload.output_path)) throw new Error('overlay_not_written');
    } catch (error) {
      if (error instanceof SubtitleGateError) throw error;
      this.fail(mapHelperError(error, { helperKind: 'overlay_generation' }), error?.message, record);
    }
  }

  async decodeAudioSha256(mediaPath, workDir, tag) {
    const pcmPath = path.join(workDir, `audio-${tag}.pcm`);
    try {
      await this.runFfmpeg([
        '-hide_banner', '-y',
        '-v', 'error',
        '-i', mediaPath,
        '-map', '0:a:0',
        '-ac', '1',
        '-ar', '16000',
        '-f', 's16le',
        pcmPath,
      ], DECODE_TIMEOUT_MS);
      const stat = await fsp.stat(pcmPath);
      if (!stat.size) return null;
      return await sha256File(pcmPath);
    } catch {
      return null; // no decodable audio stream
    } finally {
      await fsp.rm(pcmPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Confirm the output audio is a real, new voiceover: an audio stream must
   * exist and its decoded PCM fingerprint must differ from the source's.
   */
  async verifyAudioChanged({ sourceUrl, outputPath, workDir, record }) {
    const outSha = await this.decodeAudioSha256(outputPath, workDir, 'out');
    if (!outSha) this.fail('output_audio_missing', '', record);
    let srcSha = null;
    if (sourceUrl) {
      const srcTarget = path.join(workDir, 'source-for-verify.bin');
      try {
        await this.downloadFile(sourceUrl, srcTarget);
      } catch (error) {
        this.fail('source_download_failed_for_verification', error?.message, record);
      }
      srcSha = await this.decodeAudioSha256(srcTarget, workDir, 'src');
      await fsp.rm(srcTarget, { force: true }).catch(() => {});
    }
    const changed = srcSha === null ? true : srcSha !== outSha;
    if (!changed) this.fail('output_audio_unchanged', '', record);
    return {
      changed,
      sourceHasAudio: srcSha !== null,
      sourceAudioSha256: srcSha,
      outputAudioSha256: outSha,
    };
  }

  /** Heuristic text-presence check for outputs burned by libass upstream. */
  async detectBurnedText({ videoPath, cues, probe, workDir, record }) {
    const sampled = sampleCues(cues, Math.min(6, this.cfg.maxSampledFrames));
    const framesDir = path.join(workDir, 'preburn-frames');
    await ensureDir(framesDir);
    const regions = [];
    for (const cue of sampled) {
      const framePath = path.join(framesDir, `frame-${cue.index}.png`);
      await this.extractFrame(videoPath, cueMidpointMs(cue, probe.durationMs), framePath, record);
      const bands = [
        [0, Math.round(probe.height * 0.35), probe.width, Math.round(probe.height * 0.65)],
        [0, Math.round(probe.height * 0.60), probe.width, Math.round(probe.height * 0.95)],
      ];
      for (const bbox of bands) regions.push({ path: framePath, bbox, cueIndex: cue.index });
    }
    const result = await this.runProofHelper({ mode: 'detect_text', regions }, record);
    const perCue = new Map();
    result.regions.forEach((r, i) => {
      const cueIndex = regions[i].cueIndex;
      const hit = r.whitePixels >= PREBURN_BAND_MIN_PIXELS && r.darkPixels >= PREBURN_BAND_MIN_PIXELS;
      perCue.set(cueIndex, (perCue.get(cueIndex) || false) || hit);
    });
    const hits = [...perCue.values()].filter(Boolean).length;
    return {
      sampled: sampled.length,
      hits,
      pass: sampled.length > 0 && hits >= Math.ceil(sampled.length * 0.8),
    };
  }

  async applyOverlays({ videoPath, cues, probe, workDir, record }) {
    const overlaysDir = path.join(workDir, 'overlays');
    await ensureDir(overlaysDir);
    const overlays = [];
    for (const cue of cues) {
      const outputPath = path.join(overlaysDir, `cue-${String(cue.index).padStart(4, '0')}.png`);
      const payload = buildOverlayPayload({
        text: cue.text,
        width: probe.width,
        height: probe.height,
        fontPath: this.cfg.fontPath,
        outputPath,
        style: this.style,
      });
      await this.generateOverlayPng(payload, record);
      overlays.push({ cue, path: outputPath });
    }

    // Every cue must have produced real, non-transparent text pixels.
    const inspect = await this.runProofHelper({
      mode: 'inspect_overlays',
      overlays: overlays.map((o) => ({ path: o.path })),
    }, record);
    inspect.overlays.forEach((stat, i) => {
      overlays[i].opaquePixels = stat.opaquePixels;
      overlays[i].bbox = stat.bbox;
      if (!stat.bbox || stat.opaquePixels < MIN_OVERLAY_OPAQUE_PIXELS) {
        this.fail('subtitle_overlay_empty', `cue#${overlays[i].cue.index}`, record);
      }
    });

    const filterScriptPath = path.join(workDir, 'overlay-filtergraph.txt');
    await fsp.writeFile(filterScriptPath, buildOverlayFilterGraph(cues), 'utf8');

    const encoder = await selectVideoEncoder({
      ffmpegBin: this.ffmpegBin,
      preference: this.videoEncoder,
      platform: this.platform,
      execFileImpl: this.execFileImpl,
    });

    const gatedPath = path.join(workDir, 'gated-output.mp4');
    let videoKbps = computeTargetVideoKbps({
      durationSec: probe.durationMs / 1000,
      maxBytes: this.finalUploadMaxBytes,
    });
    let outBytes = 0;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const args = buildBurnArgs({
        videoPath,
        overlayPaths: overlays.map((o) => o.path),
        filterScriptPath,
        outputPath: gatedPath,
        encoder: encoder.selected,
        videoKbps,
        durationMs: probe.durationMs,
      });
      try {
        await this.runFfmpeg(args, BURN_TIMEOUT_MS);
      } catch (error) {
        const tail = String(error?.stderr || error?.message || '').split(/\r?\n/)
          .filter(Boolean).slice(-3).join(' | ');
        this.fail('subtitle_burn_failed', tail, record);
      }
      outBytes = (await fsp.stat(gatedPath).catch(() => ({ size: 0 }))).size;
      if (!outBytes) this.fail('subtitle_burn_failed', 'empty output', record);
      if (outBytes <= this.finalUploadMaxBytes) break;
      if (attempts >= 2) {
        this.fail('subtitle_output_exceeds_upload_cap', `${outBytes}b>${this.finalUploadMaxBytes}b`, record);
      }
      videoKbps = Math.max(300, Math.floor((videoKbps * this.finalUploadMaxBytes * 0.85) / outBytes));
    }

    return {
      gatedPath,
      overlays,
      encoder: encoder.selected,
      videoKbps,
      attempts,
      outBytes,
    };
  }

  async verifyFrames({ beforePath, afterPath, overlays, probe, workDir, record }) {
    const withPixels = overlays.filter((o) => o.bbox);
    const sampledIdx = sampleCues(withPixels.map((_, i) => i), this.cfg.maxSampledFrames);
    const sampled = sampledIdx.map((i) => withPixels[i]);
    const framesDir = path.join(workDir, 'frames');
    await ensureDir(framesDir);
    const checks = [];
    for (const overlay of sampled) {
      const mid = cueMidpointMs(overlay.cue, probe.durationMs);
      const beforeFrame = path.join(framesDir, `before-${overlay.cue.index}.png`);
      const afterFrame = path.join(framesDir, `after-${overlay.cue.index}.png`);
      await this.extractFrame(beforePath, mid, beforeFrame, record);
      await this.extractFrame(afterPath, mid, afterFrame, record);
      checks.push({
        overlay,
        timeMs: mid,
        request: {
          before: beforeFrame,
          after: afterFrame,
          bbox: overlay.bbox,
          pad: 12,
          label: `#${overlay.cue.index} @ ${(mid / 1000).toFixed(2)}s`,
        },
      });
    }
    const proofSheetPath = path.join(workDir, 'proof-sheet.png');
    const result = await this.runProofHelper({
      mode: 'verify_frames',
      checks: checks.map((c) => c.request),
      proofSheet: { path: proofSheetPath, tileWidth: 360, columns: 3 },
    }, record);

    const perCue = result.checks.map((measured, i) => {
      const { overlay, timeMs } = checks[i];
      const pass = frameCheckPassed(measured, overlay.opaquePixels);
      return {
        index: overlay.cue.index,
        timeMs,
        bbox: overlay.bbox,
        overlayOpaquePixels: overlay.opaquePixels,
        changedPixels: measured.changedPixels,
        whiteChangedPixels: measured.whiteChangedPixels,
        darkChangedPixels: measured.darkChangedPixels,
        pass,
      };
    });
    const allPassed = perCue.length > 0 && perCue.every((c) => c.pass);
    return {
      perCue,
      allPassed,
      proofSheetPath: result.proofSheet?.path || proofSheetPath,
      proofSheetTiles: result.proofSheet?.tiles || perCue.length,
    };
  }

  async persistArtifacts({ jobId, record, proofSheetPath }) {
    if (!this.cfg.verificationRoot || !jobId) return record;
    const dir = path.join(this.cfg.verificationRoot, `job-${jobId}`);
    await ensureDir(dir);
    if (proofSheetPath && fs.existsSync(proofSheetPath)) {
      const persistedSheet = path.join(dir, 'proof-sheet.png');
      await fsp.copyFile(proofSheetPath, persistedSheet);
      record.proofSheet = {
        ...(record.proofSheet || {}),
        path: persistedSheet,
        sha256: await sha256File(persistedSheet),
      };
    }
    const artifactPath = path.join(dir, 'verification.json');
    record.artifactPath = artifactPath;
    await fsp.writeFile(artifactPath, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  /**
   * Main gate. Returns `{ record, required, verified, audioChanged }` on pass;
   * throws SubtitleGateError (with `.record` evidence attached) on any failure.
   * NOTHING may be uploaded to Discord when this throws.
   */
  async enforce({ processResult, outputPath, tempDir, sourceUrl, jobId }) {
    const subtitles = processResult?.subtitles || null;
    const record = {
      version: 1,
      engine: GATE_ENGINE,
      gate: 'enforced',
      mode: null,
      startedAt: nowIso(),
      subtitlesRequired: subtitles ? !subtitles.skipped : null,
      subtitlesVerified: false,
      audioChanged: null,
      pass: false,
    };

    if (!subtitles) {
      // Processor did not run the dubbing/subtitle pipeline (e.g. legacy
      // PROCESSOR_MODE=ffmpeg transcode) — the gate has nothing to verify.
      record.gate = 'not_applicable';
      record.subtitlesRequired = false;
      record.pass = true;
      record.finishedAt = nowIso();
      return { record, required: false, verified: false, audioChanged: null };
    }

    if (!this.cfg.enabled) {
      record.gate = 'disabled';
      record.pass = true;
      record.finishedAt = nowIso();
      return {
        record,
        required: !subtitles.skipped,
        verified: false,
        audioChanged: null,
      };
    }

    const workDir = path.join(tempDir, 'subtitle-gate');
    await ensureDir(workDir);
    try {
      return await this.enforceChecked({
        record, workDir, outputPath, sourceUrl, jobId, subtitles,
      });
    } catch (error) {
      if (error instanceof SubtitleGateError) {
        // Persist the failure evidence (artifact JSON + any proof sheet)
        // before the job temp dir is cleaned, so failures stay auditable.
        record.error = error.category;
        record.finishedAt = nowIso();
        const failedSheet = record.proofSheet?.path && fs.existsSync(record.proofSheet.path)
          ? record.proofSheet.path
          : null;
        await this.persistArtifacts({ jobId, record, proofSheetPath: failedSheet })
          .catch(() => {});
        error.record = record;
      }
      throw error;
    }
  }

  async enforceChecked({ record, workDir, outputPath, sourceUrl, jobId, subtitles }) {
    const probe = await this.probe(outputPath, record);
    record.video = {
      width: probe.width,
      height: probe.height,
      inDurationMs: probe.durationMs,
    };

    const required = !subtitles.skipped;
    if (!required) {
      record.mode = 'audio_only';
      await this.assertDecodes(outputPath, record);
      const audio = await this.verifyAudioChanged({ sourceUrl, outputPath, workDir, record });
      record.audioChanged = audio.changed;
      record.audio = audio;
      record.decode = { ok: true };
      record.pass = true;
      record.finishedAt = nowIso();
      await this.persistArtifacts({ jobId, record, proofSheetPath: null });
      return { record, required: false, verified: false, audioChanged: audio.changed };
    }

    if (!subtitles.srtPath || !fs.existsSync(subtitles.srtPath)) {
      this.fail('subtitle_srt_missing', subtitles.srtKey || '', record);
    }
    const srtText = await fsp.readFile(subtitles.srtPath, 'utf8');
    let cues;
    try {
      cues = validateCuesForBurn(parseSrt(srtText), {
        maxCues: this.cfg.maxCues,
        videoDurationMs: probe.durationMs,
      });
    } catch (error) {
      if (error instanceof SrtError) this.fail(error.category, error.detail, record);
      throw error;
    }
    record.srt = {
      cueCount: cues.length,
      firstStartMs: cues[0].startMs,
      lastEndMs: cues[cues.length - 1].endMs,
      sha256: sha256Text(canonicalCueText(cues)),
      srtKey: subtitles.srtKey || null,
    };

    await this.preflightOrThrow(record);
    const filters = await this.listFilters();
    record.ffmpegFilters = filters;
    if (!filters.overlay) this.fail('ffmpeg_overlay_filter_missing', '', record);

    let mode = 'png_overlay';
    if (filters.ass) {
      // libass exists locally, so merge-rust's own burn likely succeeded.
      // Trust only after a pixel-level presence check; otherwise overlay.
      const detected = await this.detectBurnedText({
        videoPath: outputPath, cues, probe, workDir, record,
      });
      record.preburnDetection = detected;
      if (detected.pass) mode = 'preburned_libass';
    }
    record.mode = mode;

    let finalPath = outputPath;
    let proofSheetPath = null;

    if (mode === 'png_overlay') {
      const burn = await this.applyOverlays({
        videoPath: outputPath, cues, probe, workDir, record,
      });
      record.video.encoder = burn.encoder;
      record.video.videoKbps = burn.videoKbps;
      record.video.attempts = burn.attempts;
      record.video.outBytes = burn.outBytes;
      record.overlays = {
        generated: burn.overlays.length,
        minOpaquePixels: Math.min(...burn.overlays.map((o) => o.opaquePixels)),
      };

      const frames = await this.verifyFrames({
        beforePath: outputPath,
        afterPath: burn.gatedPath,
        overlays: burn.overlays,
        probe,
        workDir,
        record,
      });
      record.frames = { sampledCues: frames.perCue, allPassed: frames.allPassed };
      proofSheetPath = frames.proofSheetPath;
      record.proofSheet = { path: proofSheetPath, tiles: frames.proofSheetTiles };
      if (!frames.allPassed) this.fail('subtitle_pixels_not_detected', '', record);

      await this.assertDecodes(burn.gatedPath, record);
      record.decode = { ok: true };
      const outProbe = await this.probe(burn.gatedPath, record);
      record.video.outDurationMs = outProbe.durationMs;
      if (Math.abs(outProbe.durationMs - probe.durationMs) > this.cfg.durationToleranceMs) {
        this.fail(
          'subtitle_output_duration_out_of_bounds',
          `${outProbe.durationMs}ms vs ${probe.durationMs}ms`,
          record,
        );
      }
      finalPath = burn.gatedPath;
    } else {
      await this.assertDecodes(outputPath, record);
      record.decode = { ok: true };
      record.video.outDurationMs = probe.durationMs;
    }

    const audio = await this.verifyAudioChanged({
      sourceUrl, outputPath: finalPath, workDir, record,
    });
    record.audioChanged = audio.changed;
    record.audio = audio;

    if (finalPath !== outputPath) {
      // Replace the provisional no-subtitle output with the verified one so
      // the upload step can never pick up the unsubtitled MP4.
      await fsp.rename(finalPath, outputPath);
    }

    record.subtitlesVerified = true;
    record.pass = true;
    record.finishedAt = nowIso();
    await this.persistArtifacts({ jobId, record, proofSheetPath });
    return {
      record,
      required: true,
      verified: true,
      audioChanged: audio.changed,
    };
  }

  /**
   * Deterministic re-verification for an already-processed job. Downloads the
   * processed attachment (fresh URL), re-runs decode + duration checks and,
   * when the original verification stored per-cue bboxes, a reference-free
   * text-presence check at each stored cue midpoint.
   */
  async reverify({ videoUrl, prior = null, jobId }) {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `amd-reverify-${jobId || 'x'}-`));
    const record = {
      version: 1,
      engine: GATE_ENGINE,
      gate: 'reverify',
      mode: prior?.frames?.sampledCues?.length ? 'full' : 'limited',
      startedAt: nowIso(),
      pass: false,
    };
    try {
      const videoPath = path.join(workDir, 'processed.mp4');
      try {
        await this.downloadFile(videoUrl, videoPath);
      } catch (error) {
        this.fail('processed_download_failed', error?.message, record);
      }
      const probe = await this.probe(videoPath, record);
      record.video = { width: probe.width, height: probe.height, durationMs: probe.durationMs };
      await this.assertDecodes(videoPath, record);
      record.decode = { ok: true };

      const priorDuration = prior?.video?.outDurationMs ?? prior?.video?.inDurationMs;
      record.durationOk = priorDuration
        ? Math.abs(probe.durationMs - priorDuration) <= this.cfg.durationToleranceMs
        : true;
      if (!record.durationOk) {
        this.fail('subtitle_output_duration_out_of_bounds', `${probe.durationMs}ms vs ${priorDuration}ms`, record);
      }

      if (record.mode === 'full') {
        const pre = await this.preflight({ fresh: true });
        if (!pre.ok) this.fail(pre.categories[0], pre.categories.join(','), record);
        const framesDir = path.join(workDir, 'frames');
        await ensureDir(framesDir);
        const stored = prior.frames.sampledCues.slice(0, this.cfg.maxSampledFrames);
        const regions = [];
        for (const cue of stored) {
          const framePath = path.join(framesDir, `frame-${cue.index}.png`);
          await this.extractFrame(videoPath, Math.min(cue.timeMs, probe.durationMs - 100), framePath, record);
          regions.push({ path: framePath, bbox: cue.bbox, pad: 12, index: cue.index, timeMs: cue.timeMs });
        }
        const result = await this.runProofHelper({
          mode: 'detect_text',
          regions: regions.map((r) => ({ path: r.path, bbox: r.bbox, pad: r.pad })),
        }, record);
        record.frames = result.regions.map((r, i) => ({
          index: regions[i].index,
          timeMs: regions[i].timeMs,
          whitePixels: r.whitePixels,
          darkPixels: r.darkPixels,
          textDetected: r.whitePixels >= REVERIFY_MIN_PIXELS && r.darkPixels >= REVERIFY_MIN_PIXELS,
        }));
        const allDetected = record.frames.every((f) => f.textDetected);
        if (!allDetected) this.fail('subtitle_pixels_not_detected', 'reverify', record);
      }

      record.pass = true;
      record.finishedAt = nowIso();
      return { record, pass: true };
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Build the gate from the app config (used by server.js and worker.js). */
export function createSubtitleGate(cfg, deps = {}) {
  return new SubtitleGate({
    gateCfg: cfg?.subtitleGate || {},
    ffmpegBin: cfg?.processor?.ffmpegBin || 'ffmpeg',
    ffprobeBin: cfg?.processor?.ffprobeBin || 'ffprobe',
    videoEncoder: cfg?.processor?.videoEncoder || 'auto',
    finalUploadMaxBytes: cfg?.processor?.finalUploadMaxBytes
      || cfg?.maxUploadBytes
      || 10 * 1024 * 1024,
    ...deps,
  });
}

export default SubtitleGate;
