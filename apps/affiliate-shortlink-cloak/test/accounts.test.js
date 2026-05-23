'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  sanitizeAccount,
  sanitizePlatform,
  profileDirFor,
  ensureProfileDir,
  listAccounts,
  DEFAULT_ACCOUNT,
} = require('../src/accounts');

test('sanitizeAccount falls back to default when empty/whitespace', () => {
  assert.equal(sanitizeAccount(''), DEFAULT_ACCOUNT);
  assert.equal(sanitizeAccount('   '), DEFAULT_ACCOUNT);
  assert.equal(sanitizeAccount(null), DEFAULT_ACCOUNT);
  assert.equal(sanitizeAccount(undefined), DEFAULT_ACCOUNT);
});

test('sanitizeAccount keeps allowed chars and replaces others with _', () => {
  assert.equal(sanitizeAccount('CHEARB'), 'CHEARB');
  assert.equal(sanitizeAccount('user-1.alt_2'), 'user-1.alt_2');
  assert.equal(sanitizeAccount('bad/name with spaces'), 'bad_name_with_spaces');
  assert.equal(sanitizeAccount('weird@!*'), 'weird___');
});

test('sanitizeAccount truncates to 64 chars', () => {
  const long = 'A'.repeat(200);
  assert.equal(sanitizeAccount(long).length, 64);
});

test('sanitizePlatform only accepts shopee/lazada (case-insensitive)', () => {
  assert.equal(sanitizePlatform('shopee'), 'shopee');
  assert.equal(sanitizePlatform('SHOPEE'), 'shopee');
  assert.equal(sanitizePlatform('Lazada'), 'lazada');
  assert.equal(sanitizePlatform('amazon'), '');
  assert.equal(sanitizePlatform(''), '');
  assert.equal(sanitizePlatform(null), '');
});

test('profileDirFor maps to <root>/<platform>/<account>', () => {
  const root = '/tmp/x';
  assert.equal(profileDirFor('shopee', 'CHEARB', root), path.join(root, 'shopee', 'CHEARB'));
  assert.equal(profileDirFor('lazada', '', root), path.join(root, 'lazada', DEFAULT_ACCOUNT));
});

test('profileDirFor throws on invalid platform', () => {
  assert.throws(() => profileDirFor('amazon', 'x', '/tmp'));
});

test('ensureProfileDir creates directory and listAccounts reflects it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloak-profiles-'));
  try {
    const dir = ensureProfileDir('shopee', 'TESTUSER', root);
    assert.ok(fs.existsSync(dir));
    ensureProfileDir('lazada', 'L1', root);
    ensureProfileDir('lazada', 'L2', root);
    const listed = listAccounts(root);
    assert.deepEqual(listed.shopee.sort(), ['TESTUSER']);
    assert.deepEqual(listed.lazada.sort(), ['L1', 'L2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
