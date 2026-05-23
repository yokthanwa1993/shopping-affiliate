'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const keychain = require('../src/keychain');

// Every test in this file stubs the security(1) runner via __setRunnerForTest.
// No test must ever shell out to /usr/bin/security or read the real macOS Keychain.

const isDarwin = process.platform === 'darwin';
const macSkip = isDarwin ? false : 'macOS-only Keychain integration';

function installRunner(impl) {
  const calls = [];
  keychain.__setRunnerForTest(async (args, opts) => {
    calls.push({ args: args.slice(), opts: opts ? { ...opts } : undefined });
    return await impl({ args, opts, calls });
  });
  return calls;
}

test.afterEach(() => {
  keychain.__resetRunnerForTest();
});

test('serviceName builds a deterministic, sanitized identifier', () => {
  assert.equal(
    keychain.serviceName('shopee', 'CHEARB'),
    'com.affiliate.shortlink-cloak.shopee.CHEARB',
  );
  // Account is sanitized: special chars become "_"
  assert.equal(
    keychain.serviceName('shopee', 'name with spaces!@#'),
    'com.affiliate.shortlink-cloak.shopee.name_with_spaces___',
  );
  // Empty account falls back to DEFAULT_ACCOUNT
  assert.equal(
    keychain.serviceName('lazada', ''),
    'com.affiliate.shortlink-cloak.lazada.default',
  );
  // Platform is case-insensitive and whitespace-trimmed
  assert.equal(
    keychain.serviceName('  SHOPEE  ', 'A1'),
    'com.affiliate.shortlink-cloak.shopee.A1',
  );
});

test('serviceName rejects unknown platforms', () => {
  assert.throws(() => keychain.serviceName('amazon', 'X'), /Invalid platform/);
  assert.throws(() => keychain.serviceName('', 'X'), /Invalid platform/);
  assert.throws(() => keychain.serviceName(null, 'X'), /Invalid platform/);
});

test('isSupported reflects process.platform === darwin', () => {
  assert.equal(keychain.isSupported(), isDarwin);
});

test('saveCredential shells out with add-generic-password -U and required flags', { skip: macSkip }, async () => {
  const calls = installRunner(async () => ({ code: 0, stdout: '', stderr: '' }));

  const result = await keychain.saveCredential('shopee', 'CHEARB', 'someuser', 'TopSecret!');
  assert.deepEqual(result, {
    service: 'com.affiliate.shortlink-cloak.shopee.CHEARB',
    username: 'someuser',
  });

  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args[0], 'add-generic-password', 'must use add-generic-password (the -U upsert form)');
  // -U is the upsert/update flag (add-or-update). Make sure it's present so existing
  // entries get overwritten instead of failing with "already exists" (errSecDuplicateItem).
  assert.ok(args.includes('-U'), 'must pass -U so existing items are updated');

  function flag(name) {
    const idx = args.indexOf(name);
    assert.notEqual(idx, -1, `expected flag ${name} in security args`);
    return args[idx + 1];
  }
  assert.equal(flag('-s'), 'com.affiliate.shortlink-cloak.shopee.CHEARB');
  assert.equal(flag('-a'), 'someuser');
  assert.equal(flag('-D'), 'affiliate-shortlink-cloak credential');
  assert.match(flag('-l'), /Affiliate Shortlink Cloak/);
  assert.equal(flag('-w'), 'TopSecret!');
});

test('saveCredential rejects empty username/password', { skip: macSkip }, async () => {
  installRunner(async () => ({ code: 0, stdout: '', stderr: '' }));
  await assert.rejects(
    () => keychain.saveCredential('shopee', 'CHEARB', '', 'pw'),
    /username must not be empty/,
  );
  await assert.rejects(
    () => keychain.saveCredential('shopee', 'CHEARB', 'u', ''),
    /password must not be empty/,
  );
});

test('saveCredential rejects control characters in username/password', { skip: macSkip }, async () => {
  installRunner(async () => ({ code: 0, stdout: '', stderr: '' }));
  await assert.rejects(
    () => keychain.saveCredential('shopee', 'CHEARB', 'bad\nuser', 'pw'),
    /unsupported control character/,
  );
  await assert.rejects(
    () => keychain.saveCredential('shopee', 'CHEARB', 'user', 'bad\0pw'),
    /unsupported control character/,
  );
});

test('saveCredential surfaces a redacted error when security fails and never leaks the password', { skip: macSkip }, async () => {
  const PW = 'SUPERSECRET_!@#$';
  installRunner(async () => ({
    code: 51,
    stdout: '',
    stderr: `SecKeychainItemCreateFromContent (-25299) duplicate password=${PW} oops`,
  }));

  let caught = null;
  try {
    await keychain.saveCredential('shopee', 'CHEARB', 'user', PW);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'saveCredential must reject when security exits non-zero');
  assert.match(caught.message, /Failed to save credential/);
  assert.equal(
    caught.message.includes(PW),
    false,
    'password must be redacted from the bubbled-up error message',
  );
  assert.match(caught.message, /\[REDACTED\]/);
});

test('findCredential parses a quoted password line from security stdout/stderr', { skip: macSkip }, async () => {
  installRunner(async () => ({
    code: 0,
    stdout: [
      'keychain: "/Users/u/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="someuser"',
      '    "svce"<blob>="com.affiliate.shortlink-cloak.shopee.CHEARB"',
    ].join('\n'),
    // The actual password line appears on stderr when -g is passed.
    stderr: 'password: "MyP@ss\\042word"',
  }));

  const cred = await keychain.findCredential('shopee', 'CHEARB');
  assert.ok(cred, 'expected credential to be returned');
  assert.equal(cred.service, 'com.affiliate.shortlink-cloak.shopee.CHEARB');
  assert.equal(cred.username, 'someuser');
  // \042 is octal for the double-quote character.
  assert.equal(cred.password, 'MyP@ss"word');
});

test('findCredential parses a hex-encoded password (used by security for non-printable bytes)', { skip: macSkip }, async () => {
  // 0x73656372657420 == "secret " (with trailing space)
  installRunner(async () => ({
    code: 0,
    stdout: '    "acct"<blob>="hexuser"\n',
    stderr: 'password: 0x73656372657420  "secret "\n',
  }));

  const cred = await keychain.findCredential('shopee', 'CHEARB');
  assert.ok(cred);
  assert.equal(cred.username, 'hexuser');
  assert.equal(cred.password, 'secret ');
});

test('findCredential returns null when security exits non-zero (item not found)', { skip: macSkip }, async () => {
  installRunner(async () => ({
    code: 44,
    stdout: '',
    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
  }));

  const cred = await keychain.findCredential('shopee', 'CHEARB');
  assert.equal(cred, null);
});

test('findCredential returns null when no password line is present', { skip: macSkip }, async () => {
  installRunner(async () => ({
    code: 0,
    stdout: '    "acct"<blob>="someuser"\n',
    stderr: '',
  }));
  const cred = await keychain.findCredential('shopee', 'CHEARB');
  assert.equal(cred, null, 'without a password line the credential should be considered absent');
});

test('hasCredential reports configured status with username and no password', { skip: macSkip }, async () => {
  const calls = installRunner(async () => ({
    code: 0,
    stdout: '    "acct"<blob>="someuser"\n    "svce"<blob>="com.affiliate.shortlink-cloak.shopee.CHEARB"\n',
    stderr: '',
  }));

  const status = await keychain.hasCredential('shopee', 'CHEARB');
  assert.deepEqual(status, {
    service: 'com.affiliate.shortlink-cloak.shopee.CHEARB',
    username: 'someuser',
  });
  // hasCredential MUST NOT pass -g (which would surface the password on stderr).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('-g'), false, 'hasCredential must never request the password');
  assert.equal(calls[0].args[0], 'find-generic-password');
  // The returned object MUST NOT contain a password field.
  assert.equal('password' in status, false);
});

test('hasCredential returns null when security exits non-zero', { skip: macSkip }, async () => {
  installRunner(async () => ({ code: 44, stdout: '', stderr: 'not found' }));
  const status = await keychain.hasCredential('shopee', 'CHEARB');
  assert.equal(status, null);
});

test('deleteCredential reports {deleted:true} when security exits 0', { skip: macSkip }, async () => {
  const calls = installRunner(async () => ({ code: 0, stdout: '', stderr: '' }));
  const result = await keychain.deleteCredential('shopee', 'CHEARB');
  assert.deepEqual(result, {
    service: 'com.affiliate.shortlink-cloak.shopee.CHEARB',
    deleted: true,
  });
  assert.equal(calls[0].args[0], 'delete-generic-password');
});

test('deleteCredential reports {deleted:false} when item not found (still success-shaped)', { skip: macSkip }, async () => {
  installRunner(async () => ({
    code: 44,
    stdout: '',
    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
  }));
  const result = await keychain.deleteCredential('shopee', 'CHEARB');
  assert.deepEqual(result, {
    service: 'com.affiliate.shortlink-cloak.shopee.CHEARB',
    deleted: false,
  });
});

test('deleteCredential throws on unexpected security failures', { skip: macSkip }, async () => {
  installRunner(async () => ({ code: 99, stdout: '', stderr: 'unexpected acl failure' }));
  await assert.rejects(
    () => keychain.deleteCredential('shopee', 'CHEARB'),
    /Failed to delete credential/,
  );
});
