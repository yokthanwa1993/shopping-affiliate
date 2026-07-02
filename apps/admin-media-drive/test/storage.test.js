import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { sanitizeFilename, localPathFor } from '../src/storage.js';

test('sanitizeFilename strips path separators and traversal', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('a/b/c.png'), 'c.png');
  assert.equal(sanitizeFilename('..\\..\\win.mp4'), 'win.mp4');
});

test('sanitizeFilename drops leading dots and keeps a safe extension', () => {
  assert.equal(sanitizeFilename('.hidden'), 'hidden');
  const out = sanitizeFilename('My Photo!!.JPEG');
  assert.match(out, /^My_Photo.*\.jpeg$/);
});

test('sanitizeFilename never returns empty', () => {
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('/////'), 'file');
  assert.equal(sanitizeFilename(null), 'file');
});

test('localPathFor produces yyyy/mm/<id>_<name> under the root', () => {
  const root = '/tmp/media-root';
  const full = localPathFor(root, '12345', 'clip.mp4', '2026-07-02T10:00:00.000Z');
  assert.equal(full, path.join(root, '2026', '07', '12345_clip.mp4'));
});

test('localPathFor sanitizes hostile filename and id', () => {
  const root = '/tmp/media-root';
  const full = localPathFor(root, '../evil', '../../secret.png', '2026-01-05T00:00:00Z');
  assert.equal(full, path.join(root, '2026', '01', 'evil_secret.png'));
  assert.ok(full.startsWith(path.resolve(root) + path.sep));
});

test('localPathFor cannot escape the media root', () => {
  const root = '/tmp/media-root';
  const full = localPathFor(root, 'a', 'b.png', 0);
  const rel = path.relative(path.resolve(root), full);
  assert.ok(!rel.startsWith('..'));
});
