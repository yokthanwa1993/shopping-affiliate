import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCALE_FILTER,
  buildFfmpegArgs,
  selectVideoEncoder,
} from '../src/processor.js';

const ENCODERS = `
 V....D h264_videotoolbox VideoToolbox H.264 Encoder
 V....D libx264 libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
`;

function fakeExec(encodersText) {
  return (_bin, args, _options, callback) => {
    if (args.includes('-encoders')) {
      callback(null, encodersText, '');
      return;
    }
    callback(null, 'ffmpeg version fake', '');
  };
}

test('selectVideoEncoder prefers h264_videotoolbox on macOS when available', async () => {
  const selected = await selectVideoEncoder({
    platform: 'darwin',
    preference: 'auto',
    execFileImpl: fakeExec(ENCODERS),
  });
  assert.equal(selected.selected, 'h264_videotoolbox');
  assert.equal(selected.availability.h264Videotoolbox, true);
});

test('selectVideoEncoder uses libx264 when forced or hardware is unavailable', async () => {
  assert.equal((await selectVideoEncoder({
    platform: 'darwin',
    preference: 'libx264',
    execFileImpl: fakeExec(ENCODERS),
  })).selected, 'libx264');

  const unavailable = await selectVideoEncoder({
    platform: 'darwin',
    preference: 'h264_videotoolbox',
    execFileImpl: fakeExec(' V....D libx264 libx264 H.264'),
  });
  assert.equal(unavailable.selected, 'libx264');
  assert.equal(unavailable.reason, 'videotoolbox_unavailable');
});

test('legacy ffmpeg fallback normalizes to MP4 H.264/AAC faststart without crop', () => {
  const args = buildFfmpegArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    encoder: 'libx264',
  });

  assert.deepEqual(args.slice(0, 4), ['-hide_banner', '-y', '-i', '/tmp/in.mov']);
  assert.ok(args.includes('-map'));
  assert.ok(args.includes('0:a:0?'), 'optional audio map keeps silent videos valid');
  assert.ok(args.includes('-sn'), 'legacy ffmpeg fallback drops existing subtitle streams');
  assert.ok(args.includes('-dn'), 'legacy ffmpeg fallback drops data streams');
  assert.equal(args[args.indexOf('-vf') + 1], SCALE_FILTER);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  assert.equal(args.at(-3), '-f');
  assert.equal(args.at(-2), 'mp4');
  assert.equal(args.at(-1), '/tmp/out.mp4');
});

test('legacy ffmpeg fallback uses VideoToolbox-safe bitrate flags for hardware encode', () => {
  const args = buildFfmpegArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    encoder: 'h264_videotoolbox',
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_videotoolbox');
  assert.ok(args.includes('-allow_sw'));
  assert.ok(!args.includes('-crf'), 'VideoToolbox does not use libx264 CRF');
});
