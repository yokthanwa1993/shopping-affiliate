#!/usr/bin/env node
/**
 * Offline end-to-end smoke of the subtitle fail-closed gate. No Discord, no
 * Vertex, no network: builds two tiny lavfi videos (a "source" and a
 * merge-rust-style no-subtitle "output" with different audio), a 3-cue Thai
 * SRT, then runs the REAL SubtitleGate (managed venv Pillow + generate_overlay
 * + plain-ffmpeg overlay burn + pixel verification + proof sheet).
 *
 * Usage: node scripts/smoke-subtitle-gate.mjs [--keep]
 * Exit 0 = gate passed with proof artifacts; non-zero = gate failed (prints
 * the sanitized category).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { createSubtitleGate } from '../src/subtitle-gate.js';

const keep = process.argv.includes('--keep');
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-gate-smoke-'));

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

const sourcePath = path.join(work, 'source.mp4');
const mergedPath = path.join(work, 'merged-no-subtitles.mp4');
const srtPath = path.join(work, 'final_subtitles.srt');

// "Original" video: blue, 440Hz tone.
ffmpeg(['-y',
  '-f', 'lavfi', '-i', 'color=c=0x1e3a5f:s=720x1280:d=4:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', sourcePath].filter(Boolean));
// merge-rust-style output: different scene + DIFFERENT audio (the "TTS dub").
ffmpeg(['-y',
  '-f', 'lavfi', '-i', 'color=c=0x2d4a22:s=720x1280:d=4:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
  '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', mergedPath]);

fs.writeFileSync(srtPath, `1
00:00:00,200 --> 00:00:01,400
ตายแล้วแม่! ของมันดีมาก

2
00:00:01,400 --> 00:00:02,600
ใครยังไม่มี รีบดูเลย

3
00:00:02,600 --> 00:00:03,800
สั่งง่าย ส่งไวด้วยนะ
`);

const gate = createSubtitleGate(config, {
  // Offline "download": copy the local source file instead of fetching.
  downloadFile: async (_url, target) => {
    fs.copyFileSync(sourcePath, target);
    return { path: target, bytes: fs.statSync(target).size, skipped: false };
  },
});
// Persist smoke artifacts under the work dir, never the real MEDIA_ROOT.
gate.cfg.verificationRoot = path.join(work, 'verification');

try {
  const result = await gate.enforce({
    processResult: {
      pipeline: 'merge_rust',
      subtitles: { skipped: false, srtPath, srtKey: 'debug/smoke/final_subtitles.srt' },
    },
    outputPath: mergedPath,
    tempDir: path.join(work, 'job-tmp'),
    sourceUrl: 'local://smoke-source',
    jobId: 'smoke',
  });
  const r = result.record;
  console.log(JSON.stringify({
    pass: r.pass,
    mode: r.mode,
    cueCount: r.srt.cueCount,
    encoder: r.video.encoder,
    videoKbps: r.video.videoKbps,
    inDurationMs: r.video.inDurationMs,
    outDurationMs: r.video.outDurationMs,
    overlays: r.overlays,
    framesAllPassed: r.frames.allPassed,
    perCue: r.frames.sampledCues.map((c) => ({
      index: c.index, changed: c.changedPixels, white: c.whiteChangedPixels, dark: c.darkChangedPixels, pass: c.pass,
    })),
    audioChanged: r.audioChanged,
    proofSheet: r.proofSheet,
    artifactPath: r.artifactPath,
    ffmpegFilters: r.ffmpegFilters,
  }, null, 2));
  console.log(`\nsmoke OK. gated output: ${mergedPath}`);
  console.log(keep ? `artifacts kept at ${work}` : `artifacts at ${work} (pass --keep to retain)`);
} catch (error) {
  console.error(`smoke FAILED: ${error?.category || error?.message}`);
  if (error?.detail) console.error(`detail: ${error.detail}`);
  process.exitCode = 1;
} finally {
  if (!keep && process.exitCode) {
    // keep artifacts on failure for debugging
    console.error(`artifacts kept for debugging at ${work}`);
  }
}
