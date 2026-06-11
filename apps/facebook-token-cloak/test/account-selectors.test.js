'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const selectors = require('../src/account-selectors');

function assertNoLeak(value, secrets) {
  const payload = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

async function tempConfigPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-token-cloak-selectors-'));
  return path.join(dir, 'accounts.json');
}

test('selector save/status/delete redacts username and writes mode 0600 best effort', async () => {
  const configPath = await tempConfigPath();

  const saved = await selectors.saveSelector('CHEARB', {
    credentialProvider: 'apple-passwords',
    domain: 'Facebook.com',
    username: 'fb-one@example.com'
  }, { configPath });

  assert.equal(saved.account, 'CHEARB');
  assert.equal(saved.selectorPresent, true);
  assert.equal(saved.credentialProvider, 'apple-passwords');
  assert.equal(saved.usernameHintPresent, true);
  assert.equal(saved.selectedDomain, 'facebook.com');
  assert.equal(saved.selectedServer, 'facebook.com');
  assert.equal(saved.selectedProtocol, 'https');
  assertNoLeak(saved, ['fb-one@example.com']);

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(Object.keys(raw.accounts), ['chearb']);
  assert.equal(raw.accounts.chearb.username, 'fb-one@example.com');
  assert.equal(raw.accounts.chearb.password, undefined);
  const mode = (await fs.stat(configPath)).mode & 0o777;
  assert.equal(mode, 0o600);

  const status = await selectors.getSelectorStatus('chearb', { configPath });
  assert.deepEqual(status, saved);
  assertNoLeak(status, ['fb-one@example.com']);

  const deleted = await selectors.deleteSelector('CHEARB', { configPath });
  assert.equal(deleted.selectorPresent, false);
  assert.equal(deleted.usernameHintPresent, false);
  assert.equal(deleted.selectedDomain, null);
});

test('selector validation rejects secret fields and unsafe input', async () => {
  const configPath = await tempConfigPath();

  await assert.rejects(
    () => selectors.saveSelector('CHEARB', {
      credentialProvider: 'apple-passwords',
      domain: 'facebook.com',
      username: 'fb-one@example.com',
      password: 'pw-secret'
    }, { configPath }),
    /Forbidden selector field: password/
  );

  await assert.rejects(
    () => selectors.saveSelector('CHEARB', {
      credentialProvider: 'generic-keychain',
      domain: 'facebook.com',
      username: 'fb-one@example.com'
    }, { configPath }),
    /Unsupported credential provider/
  );

  await assert.rejects(
    () => selectors.saveSelector('CHEARB', {
      credentialProvider: 'apple-passwords',
      domain: 'https:\/\/facebook.com',
      username: 'fb-one@example.com'
    }, { configPath }),
    /Invalid selector server/
  );

  await assert.rejects(
    () => selectors.saveSelector('bad/account', {
      credentialProvider: 'apple-passwords',
      domain: 'facebook.com',
      username: 'fb-one@example.com'
    }, { configPath }),
    /Invalid account/
  );

  assert.throws(
    () => selectors.validateConfigPath('relative/accounts.json'),
    /must be absolute/
  );

  assert.throws(
    () => selectors.validateConfigPath(`${configPath}\n`),
    /Invalid accounts config path/
  );
});

test('selector config rejects forbidden fields already present on disk', async () => {
  const configPath = await tempConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    accounts: {
      chearb: {
        credentialProvider: 'apple-passwords',
        domain: 'facebook.com',
        username: 'fb-one@example.com',
        token: 'token-secret'
      }
    }
  }));

  await assert.rejects(
    () => selectors.getSelectorStatus('CHEARB', { configPath }),
    /Forbidden selector field: accounts.chearb.token/
  );
});
