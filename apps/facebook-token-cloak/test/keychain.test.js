'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const keychain = require('../src/keychain');
const {
  store,
  internetStore,
  securityCalls,
  fakeRunner,
  setInternetCredential
} = require('./_helpers');

function assertNoLeak(value, secrets) {
  const payload = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

beforeEach(() => {
  store.clear();
  internetStore.clear();
  securityCalls.length = 0;
  keychain.setRunner(fakeRunner);
});

afterEach(() => keychain.clearRunner());

test('credential and totp status never expose secret values', async () => {
  await keychain.storeCredential('CHEARB', 'u@example.com', 'pw-secret');
  await keychain.storeTotp('CHEARB', 'TOTPSECRET');
  const s = await keychain.getStatus('CHEARB');
  assert.equal(s.credentialPresent, true);
  assert.equal(s.totpPresent, true);
  assertNoLeak(s, ['pw-secret', 'u@example.com', 'TOTPSECRET']);
  assert.ok(s.services.username.endsWith('.credential.chearb.username'));
  assert.deepEqual(await keychain.retrieveCredential('CHEARB'), {
    account: 'CHEARB',
    username: 'u@example.com',
    password: 'pw-secret'
  });
  await keychain.deleteCredential('CHEARB');
  assert.equal((await keychain.getStatus('CHEARB')).credentialPresent, false);
});

test('parseInternetPasswordUsername extracts acct metadata only', () => {
  const output = 'attributes:\n    "acct"<blob>="fb@example.com"\n    "srvr"<blob>="facebook.com"';
  assert.equal(keychain.parseInternetPasswordUsername(output), 'fb@example.com');
  assert.equal(keychain.parseInternetPasswordUsername('attributes:\n    "srvr"<blob>="facebook.com"'), null);
});

test('internet password status autodiscovers a single facebook domain', async () => {
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb@example.com',
    password: 'internet-secret'
  });

  const s = await keychain.getInternetPasswordStatus('CHEARB');
  assert.equal(s.account, 'CHEARB');
  assert.equal(s.provider, 'apple-passwords');
  assert.equal(s.credentialPresent, true);
  assert.equal(s.usernamePresent, true);
  assert.equal(s.passwordPresent, true);
  assert.equal(s.usernameSource, 'metadata');
  assert.equal(s.domain, 'www.facebook.com');
  assert.equal(s.server, 'www.facebook.com');
  assert.equal(s.protocol, 'https');
  assert.equal(s.selectedDomain, 'www.facebook.com');
  assert.equal(s.selectedProtocol, 'https');
  assert.equal(s.ambiguous, false);
  assert.deepEqual(s.candidatesChecked, {
    count: 4,
    domains: keychain.FACEBOOK_INTERNET_SERVERS
  });
  assertNoLeak(s, ['fb@example.com', 'internet-secret']);
  assert.deepEqual(securityCalls.map(args => args[2]), keychain.FACEBOOK_INTERNET_SERVERS);
  assert.ok(securityCalls.every(args => !args.includes('-w') && !args.includes('fb@example.com')));
});

test('retrieveInternetCredential autodiscovers exactly one usable password item', async () => {
  setInternetCredential({
    server: 'm.facebook.com',
    username: 'fb@example.com',
    password: 'internet-secret'
  });

  const c = await keychain.retrieveInternetCredential('CHEARB');
  assert.deepEqual(c, {
    account: 'CHEARB',
    username: 'fb@example.com',
    password: 'internet-secret',
    provider: 'apple-passwords',
    domain: 'm.facebook.com',
    server: 'm.facebook.com',
    protocol: 'https'
  });
  assert.deepEqual(securityCalls.slice(0, 4).map(args => args[2]), keychain.FACEBOOK_INTERNET_SERVERS);
  assert.deepEqual(securityCalls[4], [
    'find-internet-password',
    '-s',
    'm.facebook.com',
    '-r',
    'htps',
    '-a',
    'fb@example.com',
    '-w'
  ]);
});

test('internet password status reports no candidate without leaking secrets', async () => {
  const s = await keychain.getInternetPasswordStatus('CHEARB');
  assert.equal(s.credentialPresent, false);
  assert.equal(s.usernamePresent, false);
  assert.equal(s.passwordPresent, false);
  assert.equal(s.usernameSource, 'missing');
  assert.equal(s.domain, null);
  assert.equal(s.selectedDomain, null);
  assert.equal(s.selectedProtocol, null);
  assert.deepEqual(s.candidatesChecked, {
    count: 4,
    domains: keychain.FACEBOOK_INTERNET_SERVERS
  });

  await assert.rejects(
    () => keychain.retrieveInternetCredential('CHEARB'),
    error => {
      assert.equal(error.status, 404);
      assert.equal(error.safeDetails.credentialPresent, false);
      assertNoLeak(error.safeDetails, ['fb@example.com', 'internet-secret']);
      return true;
    }
  );
});

test('multiple autodiscovered usable candidates are ambiguous and redacted', async () => {
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'login.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });

  const s = await keychain.getInternetPasswordStatus('CHEARB');
  assert.equal(s.credentialPresent, false);
  assert.equal(s.usernamePresent, true);
  assert.equal(s.passwordPresent, true);
  assert.equal(s.ambiguous, true);
  assert.equal(s.usernameSource, 'metadata');
  assert.equal(s.selectedDomain, null);
  assert.deepEqual(s.candidatesChecked, {
    count: 4,
    domains: keychain.FACEBOOK_INTERNET_SERVERS
  });
  assertNoLeak(s, [
    'fb-one@example.com',
    'fb-two@example.com',
    'internet-secret-one',
    'internet-secret-two'
  ]);

  await assert.rejects(
    () => keychain.retrieveInternetCredential('CHEARB'),
    error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /pass domain\/server or username/);
      assert.equal(error.safeDetails.ambiguous, true);
      assertNoLeak(error.safeDetails, [
        'fb-one@example.com',
        'fb-two@example.com',
        'internet-secret-one',
        'internet-secret-two'
      ]);
      return true;
    }
  );
});

test('explicit domain and username overrides select only that Passwords item', async () => {
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });

  const s = await keychain.getInternetPasswordStatus('CHEARB', { domain: 'www.facebook.com' });
  assert.equal(s.credentialPresent, true);
  assert.equal(s.ambiguous, false);
  assert.equal(s.selectedDomain, 'www.facebook.com');
  assert.deepEqual(s.candidatesChecked, { count: 1, domains: ['www.facebook.com'] });
  assertNoLeak(s, ['fb-two@example.com', 'internet-secret-two']);

  securityCalls.length = 0;
  const c = await keychain.retrieveInternetCredential('CHEARB', {
    server: 'www.facebook.com',
    username: 'fb-two@example.com'
  });
  assert.equal(c.username, 'fb-two@example.com');
  assert.equal(c.password, 'internet-secret-two');
  assert.deepEqual(securityCalls, [[
    'find-internet-password',
    '-s',
    'www.facebook.com',
    '-r',
    'htps',
    '-a',
    'fb-two@example.com',
    '-w'
  ]]);
});

test('internet password status reports missing username when metadata has no acct', async () => {
  keychain.setRunner(async args => {
    securityCalls.push([...args]);
    return {
      stdout: 'attributes:\n    "srvr"<blob>="facebook.com"\n',
      stderr: ''
    };
  });
  const s = await keychain.getInternetPasswordStatus('CHEARB', { domain: 'facebook.com' });
  assert.equal(s.credentialPresent, false);
  assert.equal(s.usernamePresent, false);
  assert.equal(s.passwordPresent, true);
  assert.equal(s.usernameSource, 'missing');
  assert.equal(s.selectedDomain, 'facebook.com');
  assert.ok(!JSON.stringify(s).includes('@'));
});
