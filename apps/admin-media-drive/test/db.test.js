import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-db-'));
  return path.join(dir, 'index.sqlite');
}

test('upsert inserts then updates by (namespace, attachment)', () => {
  const db = openDb(tempDb());
  const first = db.upsert({
    namespace_id: 'admin',
    channel_id: 'c1',
    message_id: 'm1',
    attachment_id: 'a1',
    filename: 'one.png',
    content_type: 'image/png',
    size: 10,
    local_path: '/tmp/x/one.png',
    discord_url: 'https://cdn/one',
    jump_url: 'https://discord/one',
    status: 'mirrored',
  });
  assert.equal(first.attachment_id, 'a1');
  assert.equal(first.status, 'mirrored');

  const second = db.upsert({
    namespace_id: 'admin',
    channel_id: 'c1',
    message_id: 'm1',
    attachment_id: 'a1',
    filename: 'one-renamed.png',
    content_type: 'image/png',
    size: 20,
    local_path: null, // must NOT clobber existing local_path
    discord_url: 'https://cdn/one2',
    jump_url: 'https://discord/one',
    status: 'indexed',
  });
  assert.equal(second.id, first.id, 'same row reused');
  assert.equal(second.filename, 'one-renamed.png');
  assert.equal(second.local_path, '/tmp/x/one.png', 'existing local_path preserved');
  assert.equal(second.created_at, first.created_at, 'created_at preserved');

  db.close();
});

test('count is 0 on empty db and tallies rows per namespace', () => {
  const db = openDb(tempDb());
  assert.equal(db.count(), 0, 'empty db counts zero');
  assert.equal(db.count('admin'), 0, 'empty namespace counts zero');

  db.upsert({
    namespace_id: 'admin', channel_id: 'c1', message_id: 'm1', attachment_id: 'a1',
    filename: 'one.png', status: 'indexed',
  });
  db.upsert({
    namespace_id: 'admin', channel_id: 'c1', message_id: 'm2', attachment_id: 'a2',
    filename: 'two.png', status: 'indexed',
  });
  db.upsert({
    namespace_id: 'other', channel_id: 'c1', message_id: 'm3', attachment_id: 'a3',
    filename: 'three.png', status: 'indexed',
  });

  assert.equal(db.count(), 3, 'counts all rows');
  assert.equal(db.count('admin'), 2, 'scopes to namespace');
  assert.equal(db.count('other'), 1);

  db.close();
});

test('list filters by namespace and channel, newest first', () => {
  const db = openDb(tempDb());
  db.upsert({
    namespace_id: 'admin', channel_id: 'c1', message_id: 'm1', attachment_id: 'a1',
    filename: 'old.png', created_at: '2026-01-01T00:00:00Z', status: 'indexed',
  });
  db.upsert({
    namespace_id: 'admin', channel_id: 'c1', message_id: 'm2', attachment_id: 'a2',
    filename: 'new.png', created_at: '2026-06-01T00:00:00Z', status: 'indexed',
  });
  db.upsert({
    namespace_id: 'other', channel_id: 'c1', message_id: 'm3', attachment_id: 'a3',
    filename: 'nope.png', created_at: '2026-07-01T00:00:00Z', status: 'indexed',
  });

  const admin = db.list({ namespaceId: 'admin' });
  assert.equal(admin.length, 2);
  assert.equal(admin[0].filename, 'new.png', 'newest first');

  const c2 = db.list({ namespaceId: 'admin', channelId: 'c-none' });
  assert.equal(c2.length, 0);

  db.close();
});
