import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  LEGACY_SUBTITLE_STYLE,
  SubtitleGate,
  SubtitleGateError,
  buildBurnArgs,
  buildOverlayFilterGraph,
  buildOverlayPayload,
  computeTargetVideoKbps,
  createSubtitleGate,
  frameCheckPassed,
  sampleCues,
} from '../src/subtitle-gate.js';
import { ProcessingService } from '../src/processing-service.js';
import { openDb } from '../src/db.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amd-gate-'));
}

// --- overlay payload / style parity -----------------------------------------

test('buildOverlayPayload reproduces the legacy FC Iconic look at 720x1280', () => {
  const payload = buildOverlayPayload({
    text: 'ทดสอบซับ',
    width: 720,
    height: 1280,
    fontPath: '/fonts/font.ttf',
    outputPath: '/tmp/cue-1.png',
  });
  assert.equal(payload.font_size, 82, 'legacy ASS Fontsize 82');
  assert.equal(payload.outline_width, 20, 'total stroke 20 = legacy 10px per side');
  assert.equal(payload.fill_color, '#FFFFFF');
  assert.equal(payload.outline_color, '#000000');
  assert.equal(payload.bg_opacity, 0, 'no background box');
  assert.equal(payload.center_y, Math.round(1280 * LEGACY_SUBTITLE_STYLE.centerYRatio));
  assert.ok(payload.center_y > 640, 'lower/lower-middle placement, not centered');
  assert.equal(payload.auto_fit, true);
  assert.equal(payload.text, 'ทดสอบซับ', 'text passes through unmodified');
});

test('buildOverlayPayload scales style proportionally for other resolutions', () => {
  const payload = buildOverlayPayload({
    text: 'x',
    width: 1080,
    height: 1920,
    fontPath: '/fonts/font.ttf',
    outputPath: '/tmp/cue-1.png',
  });
  assert.equal(payload.font_size, Math.round(82 * 1.5));
  assert.equal(payload.outline_width, 30);
  assert.equal(payload.center_y, Math.round(1920 * LEGACY_SUBTITLE_STYLE.centerYRatio));
});

// --- ffmpeg command construction / input safety ------------------------------

test('buildOverlayFilterGraph gates each overlay to its exact SRT interval', () => {
  const graph = buildOverlayFilterGraph([
    { index: 1, startMs: 0, endMs: 1500, text: 'ข้อความซับหนึ่ง' },
    { index: 2, startMs: 1500, endMs: 3210, text: 'ข้อความซับสอง' },
  ]);
  assert.match(graph, /\[0:v\]\[1:v\]overlay=0:0:enable='between\(t,0\.000,1\.500\)'\[v1\]/);
  assert.match(graph, /\[v1\]\[2:v\]overlay=0:0:enable='between\(t,1\.500,3\.210\)'\[vout\]/);
  // Cue text must never reach the filtergraph (it goes into PNGs via JSON stdin).
  assert.equal(graph.includes('ข้อความ'), false, 'no cue text in filtergraph');
  assert.equal(graph.includes('drawtext'), false, 'no drawtext filter used');
});

test('buildBurnArgs bounds duration, copies TTS audio, and uses argv (no shell)', () => {
  const args = buildBurnArgs({
    videoPath: '/tmp/in with space.mp4',
    overlayPaths: ['/tmp/o1.png', '/tmp/o2.png'],
    filterScriptPath: '/tmp/graph.txt',
    outputPath: '/tmp/out.mp4',
    encoder: 'h264_videotoolbox',
    videoKbps: 2000,
    durationMs: 10_000,
  });
  assert.equal(args[args.indexOf('-t') + 1], '10.300', 'explicit output duration bound');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy', 'TTS audio preserved untouched');
  assert.equal(args[args.indexOf('-filter_complex_script') + 1], '/tmp/graph.txt');
  assert.equal(args.filter((a) => a === '-i').length, 3, 'video + one input per overlay');
  assert.ok(args.includes('-allow_sw'));
  assert.equal(args[args.indexOf('-map') + 1], '[vout]');
  // Paths stay single argv entries — spaces intact, nothing shell-quoted.
  assert.ok(args.includes('/tmp/in with space.mp4'));
});

test('computeTargetVideoKbps respects the Discord upload cap', () => {
  // 60s video under a 10MiB cap must not get the full 3500k ceiling.
  const kbps = computeTargetVideoKbps({ durationSec: 60, maxBytes: 10 * 1024 * 1024 });
  assert.ok(kbps < 1300 && kbps >= 300, `computed ${kbps}`);
  // Short clip hits the ceiling.
  assert.equal(computeTargetVideoKbps({ durationSec: 5, maxBytes: 10 * 1024 * 1024 }), 3500);
  // Unknown duration falls back to a sane default.
  assert.equal(computeTargetVideoKbps({}), 2500);
});

test('sampleCues keeps first/last and bounds the sample size', () => {
  const cues = Array.from({ length: 100 }, (_, i) => ({ index: i + 1 }));
  const sampled = sampleCues(cues, 12);
  assert.equal(sampled.length, 12);
  assert.equal(sampled[0].index, 1);
  assert.equal(sampled.at(-1).index, 100);
  assert.deepEqual(sampleCues(cues.slice(0, 3), 12).length, 3);
});

test('frameCheckPassed needs changed mass plus a white or dark tone signature', () => {
  const opaque = 10_000;
  assert.equal(frameCheckPassed({ changedPixels: 5000, whiteChangedPixels: 900, darkChangedPixels: 2000 }, opaque), true);
  // white-on-white background: only the outline shows -> still passes
  assert.equal(frameCheckPassed({ changedPixels: 4000, whiteChangedPixels: 0, darkChangedPixels: 2500 }, opaque), true);
  // nothing changed at all -> the overlay is not visible
  assert.equal(frameCheckPassed({ changedPixels: 10, whiteChangedPixels: 5, darkChangedPixels: 5 }, opaque), false);
  // changed but neither white nor dark -> not our subtitle style
  assert.equal(frameCheckPassed({ changedPixels: 5000, whiteChangedPixels: 10, darkChangedPixels: 12 }, opaque), false);
});

// --- fail-closed dependency preflight ----------------------------------------

function fakeExecFile({ pythonMissing = false, pillowMissing = false } = {}) {
  return (bin, args, _opts, callback) => {
    setImmediate(() => {
      if (pythonMissing) {
        const err = new Error('spawn ENOENT');
        err.code = 'ENOENT';
        callback(err, '', '');
        return;
      }
      if (pillowMissing) {
        const err = new Error('exit 1');
        err.code = 1;
        callback(err, '', "AMD_PROOF_ERROR:pillow_missing No module named 'PIL'\n");
        return;
      }
      callback(null, '11.0.0\n', '');
    });
    return { stdin: { write() {}, end() {}, on() {} } };
  };
}

function gateWithHelpers({ execFileImpl, helpersExist = true } = {}) {
  const dir = tempDir();
  const helper = path.join(dir, 'helper.py');
  const proof = path.join(dir, 'proof.py');
  const font = path.join(dir, 'font.ttf');
  if (helpersExist) {
    fs.writeFileSync(helper, '# helper');
    fs.writeFileSync(proof, '# proof');
    fs.writeFileSync(font, 'font-bytes');
  }
  return new SubtitleGate({
    gateCfg: {
      pythonBin: '/nonexistent-venv/bin/python3',
      overlayHelperPath: helper,
      proofHelperPath: proof,
      fontPath: font,
      verificationRoot: path.join(dir, 'verification'),
    },
    execFileImpl,
  });
}

test('preflight fails closed when the managed python is missing', async () => {
  const gate = gateWithHelpers({ execFileImpl: fakeExecFile({ pythonMissing: true }) });
  const pre = await gate.preflight();
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.categories, ['subtitle_python_missing']);
});

test('preflight fails closed when Pillow is not importable', async () => {
  const gate = gateWithHelpers({ execFileImpl: fakeExecFile({ pillowMissing: true }) });
  const pre = await gate.preflight();
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.categories, ['subtitle_pillow_missing']);
});

test('preflight fails closed when helper scripts or font are missing', async () => {
  const gate = gateWithHelpers({ execFileImpl: fakeExecFile(), helpersExist: false });
  const pre = await gate.preflight();
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.categories.sort(), [
    'subtitle_font_missing',
    'subtitle_overlay_helper_missing',
    'subtitle_proof_helper_missing',
  ]);
});

test('preflight passes when python+Pillow+helpers+font are all present', async () => {
  const gate = gateWithHelpers({ execFileImpl: fakeExecFile() });
  const pre = await gate.preflight();
  assert.equal(pre.ok, true);
  assert.equal(pre.pillowVersion, '11.0.0');
});

// --- enforce orchestration ----------------------------------------------------

test('enforce is a no-op for processors without a subtitle contract', async () => {
  const gate = createSubtitleGate({});
  const result = await gate.enforce({
    processResult: { outputPath: '/tmp/x.mp4', pipeline: 'merge_rust' },
    outputPath: '/tmp/x.mp4',
    tempDir: tempDir(),
    sourceUrl: 'https://cdn.example/src',
  });
  assert.equal(result.record.gate, 'not_applicable');
  assert.equal(result.required, false);
});

test('enforce records a disabled gate without verifying', async () => {
  const gate = new SubtitleGate({ gateCfg: { enabled: false } });
  const result = await gate.enforce({
    processResult: { subtitles: { skipped: false, srtPath: '/nope.srt' } },
    outputPath: '/tmp/x.mp4',
    tempDir: tempDir(),
  });
  assert.equal(result.record.gate, 'disabled');
  assert.equal(result.required, true);
  assert.equal(result.verified, false);
});

test('enforce fails closed with subtitle_srt_missing when subtitles are required but the SRT is gone', async () => {
  const dir = tempDir();
  const gate = gateWithHelpers({ execFileImpl: fakeExecFile() });
  gate.probe = async () => ({ durationMs: 3000, width: 720, height: 1280, hasAudio: true });
  await assert.rejects(
    gate.enforce({
      processResult: { subtitles: { skipped: false, srtPath: path.join(dir, 'missing.srt'), srtKey: 'debug/x/final_subtitles.srt' } },
      outputPath: path.join(dir, 'out.mp4'),
      tempDir: dir,
      sourceUrl: 'https://cdn.example/src',
      jobId: 7,
    }),
    (e) => e instanceof SubtitleGateError && e.category === 'subtitle_srt_missing' && e.record?.error === 'subtitle_srt_missing',
  );
  // failure evidence persisted for the job
  const artifact = path.join(path.dirname(gate.cfg.overlayHelperPath), 'verification', 'job-7', 'verification.json');
  assert.equal(fs.existsSync(artifact), true, 'failure verification.json persisted');
});

test('enforce fails closed when a generated overlay has no text pixels', async () => {
  const dir = tempDir();
  const srtPath = path.join(dir, 'final_subtitles.srt');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nสวัสดี\n');
  const outPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(outPath, 'video');

  const gate = gateWithHelpers({ execFileImpl: fakeExecFile() });
  gate.probe = async () => ({ durationMs: 2000, width: 720, height: 1280, hasAudio: true });
  gate.listFilters = async () => ({ ass: false, subtitles: false, drawtext: false, overlay: true });
  gate.generateOverlayPng = async (payload) => fs.writeFileSync(payload.output_path, 'png');
  gate.runProofHelper = async (payload) => {
    assert.equal(payload.mode, 'inspect_overlays');
    return { ok: true, overlays: payload.overlays.map(() => ({ opaquePixels: 0, bbox: null })) };
  };

  await assert.rejects(
    gate.enforce({
      processResult: { subtitles: { skipped: false, srtPath } },
      outputPath: outPath,
      tempDir: dir,
      sourceUrl: 'https://cdn.example/src',
    }),
    (e) => e.category === 'subtitle_overlay_empty',
  );
});

test('enforce fails closed when the output duration drifts out of bounds', async () => {
  const dir = tempDir();
  const srtPath = path.join(dir, 'final_subtitles.srt');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nสวัสดี\n');
  const outPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(outPath, 'video');

  const gate = gateWithHelpers({ execFileImpl: fakeExecFile() });
  const durations = [2000, 9000]; // input probe, then gated-output probe
  gate.probe = async () => ({
    durationMs: durations.shift(), width: 720, height: 1280, hasAudio: true,
  });
  gate.listFilters = async () => ({ ass: false, subtitles: false, drawtext: false, overlay: true });
  gate.applyOverlays = async ({ workDir }) => {
    const gatedPath = path.join(workDir, 'gated-output.mp4');
    fs.writeFileSync(gatedPath, 'gated');
    return {
      gatedPath,
      overlays: [{ cue: { index: 1, startMs: 0, endMs: 1000 }, path: 'o.png', opaquePixels: 9000, bbox: [10, 900, 700, 1000] }],
      encoder: 'libx264',
      videoKbps: 2500,
      attempts: 1,
      outBytes: 5,
    };
  };
  gate.verifyFrames = async () => ({
    perCue: [{ index: 1, timeMs: 500, pass: true, bbox: [10, 900, 700, 1000], overlayOpaquePixels: 9000, changedPixels: 5000, whiteChangedPixels: 500, darkChangedPixels: 800 }],
    allPassed: true,
    proofSheetPath: null,
    proofSheetTiles: 1,
  });
  gate.assertDecodes = async () => {};

  await assert.rejects(
    gate.enforce({
      processResult: { subtitles: { skipped: false, srtPath } },
      outputPath: outPath,
      tempDir: dir,
      sourceUrl: 'https://cdn.example/src',
    }),
    (e) => e.category === 'subtitle_output_duration_out_of_bounds',
  );
});

test('enforce passes only after frame proof + audio change, and swaps in the gated output', async () => {
  const dir = tempDir();
  const srtPath = path.join(dir, 'final_subtitles.srt');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nสวัสดี\n\n2\n00:00:01,000 --> 00:00:02,000\nชอบมาก\n');
  const outPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(outPath, 'provisional-no-subtitle-video');

  const gate = gateWithHelpers({ execFileImpl: fakeExecFile() });
  gate.probe = async () => ({ durationMs: 2000, width: 720, height: 1280, hasAudio: true });
  gate.listFilters = async () => ({ ass: false, subtitles: false, drawtext: false, overlay: true });
  gate.assertDecodes = async () => {};
  gate.applyOverlays = async ({ cues, workDir }) => {
    const gatedPath = path.join(workDir, 'gated-output.mp4');
    fs.writeFileSync(gatedPath, 'gated-with-subtitles');
    return {
      gatedPath,
      overlays: cues.map((cue) => ({ cue, path: `o${cue.index}.png`, opaquePixels: 9000, bbox: [10, 900, 700, 1000] })),
      encoder: 'h264_videotoolbox',
      videoKbps: 2100,
      attempts: 1,
      outBytes: 21,
    };
  };
  gate.verifyFrames = async ({ overlays }) => ({
    perCue: overlays.map((o) => ({
      index: o.cue.index, timeMs: 500, bbox: o.bbox, overlayOpaquePixels: o.opaquePixels, changedPixels: 4000, whiteChangedPixels: 700, darkChangedPixels: 900, pass: true,
    })),
    allPassed: true,
    proofSheetPath: null,
    proofSheetTiles: overlays.length,
  });
  gate.verifyAudioChanged = async () => ({ changed: true, sourceHasAudio: true, sourceAudioSha256: 'a', outputAudioSha256: 'b' });

  const result = await gate.enforce({
    processResult: { subtitles: { skipped: false, srtPath, srtKey: 'debug/v/final_subtitles.srt' } },
    outputPath: outPath,
    tempDir: dir,
    sourceUrl: 'https://cdn.example/src',
    jobId: 3,
  });

  assert.equal(result.verified, true);
  assert.equal(result.audioChanged, true);
  assert.equal(result.record.pass, true);
  assert.equal(result.record.mode, 'png_overlay');
  assert.equal(result.record.srt.cueCount, 2);
  assert.equal(
    fs.readFileSync(outPath, 'utf8'),
    'gated-with-subtitles',
    'provisional no-subtitle output replaced by the verified one before upload',
  );
});

test('enforce fails closed when the audio fingerprint did not change', async () => {
  const dir = tempDir();
  const srtPath = path.join(dir, 'final_subtitles.srt');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nสวัสดี\n');
  const outPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(outPath, 'video');

  const gate = gateWithHelpers({ execFileImpl: fakeExecFile() });
  gate.probe = async () => ({ durationMs: 2000, width: 720, height: 1280, hasAudio: true });
  gate.listFilters = async () => ({ ass: false, subtitles: false, drawtext: false, overlay: true });
  gate.assertDecodes = async () => {};
  gate.downloadFile = async (_url, target) => {
    fs.writeFileSync(target, 'source-bytes');
    return { path: target, bytes: 12, skipped: false };
  };
  gate.decodeAudioSha256 = async () => 'same-fingerprint';
  gate.applyOverlays = async ({ cues, workDir }) => {
    const gatedPath = path.join(workDir, 'gated-output.mp4');
    fs.writeFileSync(gatedPath, 'gated');
    return { gatedPath, overlays: cues.map((cue) => ({ cue, path: 'o.png', opaquePixels: 9000, bbox: [0, 0, 10, 10] })), encoder: 'libx264', videoKbps: 2500, attempts: 1, outBytes: 5 };
  };
  gate.verifyFrames = async ({ overlays }) => ({
    perCue: overlays.map((o) => ({ index: o.cue.index, timeMs: 1, bbox: o.bbox, overlayOpaquePixels: 9000, changedPixels: 4000, whiteChangedPixels: 700, darkChangedPixels: 900, pass: true })),
    allPassed: true,
    proofSheetPath: null,
    proofSheetTiles: 1,
  });

  await assert.rejects(
    gate.enforce({
      processResult: { subtitles: { skipped: false, srtPath } },
      outputPath: outPath,
      tempDir: dir,
      sourceUrl: 'https://cdn.example/src',
    }),
    (e) => e.category === 'output_audio_unchanged',
  );
});

// --- the gate actually blocks the Discord upload -----------------------------

function buildService({ gate }) {
  const dir = tempDir();
  const db = openDb(path.join(dir, 'index.sqlite'));
  const cfg = {
    namespaceId: 'admin',
    mediaRoot: dir,
    discord: { processedChannelId: 'processed', sourceChannelId: 'source', defaultChannelId: '' },
    processor: { keepTmp: false },
  };
  const uploads = [];
  const discord = {
    async resolveFreshUrl() { return 'https://cdn.example/fresh/src'; },
    async uploadFile(args) {
      uploads.push(args);
      return {
        id: 'up1', messageId: 'm1', channelId: args.channelId, guildId: 'g', filename: args.filename, size: 3, contentType: 'video/mp4', url: 'https://cdn.example/up1', proxyUrl: '/x', jumpUrl: 'https://discord.com/channels/g/c/m1', createdAt: new Date().toISOString(),
      };
    },
  };
  const processor = {
    inputMode: 'url',
    async health() { return { mode: 'merge_rust' }; },
    async processVideo({ outputPath }) {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, 'merged-no-subtitles');
      return {
        outputPath,
        pipeline: 'merge_rust',
        subtitles: { skipped: false, srtPath: path.join(dir, 'nope.srt'), srtKey: 'debug/v/final_subtitles.srt' },
      };
    },
  };
  const service = new ProcessingService({ cfg, db, discord, processor, subtitleGate: gate });
  const source = db.upsert({
    namespace_id: 'admin', channel_id: 'c1', message_id: 'm1', attachment_id: 'att-src', filename: 'clip.mp4', content_type: 'video/mp4', discord_url: 'https://cdn.example/src', status: 'discord_indexed',
  });
  return { service, db, uploads, source };
}

test('a failing subtitle gate blocks the Discord upload and marks the job failed with a category', async () => {
  const gate = {
    async enforce() {
      const error = new SubtitleGateError('subtitle_pixels_not_detected', 'proof failed');
      error.record = { pass: false, subtitlesRequired: true, audioChanged: null };
      throw error;
    },
  };
  const { service, db, uploads, source } = buildService({ gate });
  const job = service.enqueue({ mediaItemId: source.id });

  await assert.rejects(service.runJob(job.id), (e) => e.message === 'subtitle_pixels_not_detected');
  assert.equal(uploads.length, 0, 'NO Discord upload happened');
  const failed = db.getProcessingJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_category, 'subtitle_pixels_not_detected');
  assert.equal(failed.subtitles_verified, 0);
  assert.ok(failed.subtitle_verification_json.includes('"pass":false'));
});

test('a passing subtitle gate lets the upload proceed and persists verification flags', async () => {
  const gate = {
    async enforce() {
      return {
        required: true,
        verified: true,
        audioChanged: true,
        record: { pass: true, mode: 'png_overlay', subtitlesRequired: true },
      };
    },
  };
  const { service, uploads, source, db } = buildService({ gate });
  const job = service.enqueue({ mediaItemId: source.id });
  const done = await service.runJob(job.id);

  assert.equal(done.status, 'processed');
  assert.equal(uploads.length, 1, 'upload happened after verification');
  const row = db.getProcessingJob(job.id);
  assert.equal(row.subtitles_required, 1);
  assert.equal(row.subtitles_verified, 1);
  assert.equal(row.audio_changed, 1);
  assert.ok(row.subtitle_verification_json.includes('png_overlay'));
});

test('claimed jobs cannot be started twice (API run vs worker poll race)', async () => {
  const gate = { async enforce() { return { required: false, verified: false, audioChanged: null, record: { pass: true } }; } };
  const { service, db, source } = buildService({ gate });
  const job = service.enqueue({ mediaItemId: source.id });
  // Simulate the other process having claimed the row a moment earlier.
  const claimed = db.markProcessingJobStarted(job.id, { step: 'processing' });
  assert.ok(claimed, 'first claim succeeds');
  const second = db.markProcessingJobStarted(job.id, { step: 'processing' });
  assert.equal(second, undefined, 'second claim is refused');

  await assert.rejects(service.runJob(job.id), (e) => e.message === 'processing_job_already_running');
});

test('stale processing jobs are re-queued once they exceed the recovery window', () => {
  const gate = { async enforce() { return {}; } };
  const { db, service, source } = buildService({ gate });
  const job = service.enqueue({ mediaItemId: source.id });
  db.markProcessingJobStarted(job.id, { step: 'processing' });

  assert.equal(db.recoverStaleProcessingJobs('admin', { olderThanMs: 60_000 }), 0, 'fresh job not touched');
  assert.equal(db.recoverStaleProcessingJobs('admin', { olderThanMs: -1000 }), 1, 'old processing job recovered');
  assert.equal(db.getProcessingJob(job.id).status, 'queued');
});
