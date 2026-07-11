import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SrtError,
  canonicalCueText,
  formatSrtTimestampMs,
  parseSrt,
  validateCuesForBurn,
} from '../src/srt.js';

const SIMPLE = `1
00:00:00,000 --> 00:00:01,500
ตายแล้วแม่!

2
00:00:01,500 --> 00:00:03,000
ใครยังไม่มี
`;

test('parseSrt reads cues with Thai text and millisecond timings', () => {
  const cues = parseSrt(SIMPLE);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], {
    index: 1, startMs: 0, endMs: 1500, text: 'ตายแล้วแม่!',
  });
  assert.equal(cues[1].startMs, 1500);
  assert.equal(cues[1].endMs, 3000);
});

test('parseSrt tolerates CRLF, BOM, missing index lines, and markup', () => {
  const messy = '﻿00:00:00.000 --> 00:00:01.000\r\n<i>สวัสดี</i>{\\an5}ค่ะ\r\n\r\nnot-a-block\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nสองบรรทัด\r\nต่อกัน\r\n';
  const cues = parseSrt(messy);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'สวัสดีค่ะ');
  assert.equal(cues[1].text, 'สองบรรทัด\nต่อกัน');
});

test('validateCuesForBurn fails closed on empty/oversized/invalid input', () => {
  assert.throws(() => validateCuesForBurn([]), (e) => e instanceof SrtError && e.category === 'subtitle_srt_empty');
  assert.throws(
    () => validateCuesForBurn(parseSrt(SIMPLE), { maxCues: 1 }),
    (e) => e.category === 'subtitle_cue_count_exceeded',
  );
  assert.throws(
    () => validateCuesForBurn([{ index: 1, startMs: 0, endMs: 1000, text: '   ' }]),
    (e) => e.category === 'subtitle_cue_text_empty',
  );
  assert.throws(
    () => validateCuesForBurn([{ index: 1, startMs: 1000, endMs: 1000, text: 'x' }]),
    (e) => e.category === 'subtitle_cue_invalid_timing',
  );
  assert.throws(
    () => validateCuesForBurn([{ index: 1, startMs: -5, endMs: 100, text: 'x' }]),
    (e) => e.category === 'subtitle_cue_invalid_timing',
  );
});

test('validateCuesForBurn clamps ends to the video duration but never extends or edits text', () => {
  const cues = validateCuesForBurn(
    [
      { index: 1, startMs: 0, endMs: 4000, text: 'ยาวเกินวิดีโอ' },
      { index: 2, startMs: 500, endMs: 900, text: 'ปกติ' },
    ],
    { videoDurationMs: 3000 },
  );
  // sorted + clamped
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[0].endMs, 3000, 'end clamped to duration');
  assert.equal(cues[0].text, 'ยาวเกินวิดีโอ');
  assert.equal(cues[1].endMs, 900, 'in-range cue untouched');
});

test('validateCuesForBurn rejects cues starting beyond the video', () => {
  assert.throws(
    () => validateCuesForBurn(
      [{ index: 1, startMs: 10_000, endMs: 11_000, text: 'x' }],
      { videoDurationMs: 3000 },
    ),
    (e) => e.category === 'subtitle_cue_beyond_duration',
  );
});

test('timestamp formatting and canonical text are stable', () => {
  assert.equal(formatSrtTimestampMs(3_723_456), '01:02:03,456');
  const canonical = canonicalCueText(parseSrt(SIMPLE));
  assert.match(canonical, /^1\|0\|1500\|ตายแล้วแม่!\n2\|1500\|3000\|ใครยังไม่มี$/);
});
