'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const registry = require('../src/accounts-registry');

function assertNoLeak(value, secrets) {
  const payload = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

async function tempConfigPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-token-cloak-registry-'));
  return path.join(dir, 'registry.json');
}

test('registry upsert/list/get/delete stores non-secret metadata at mode 0600', async () => {
  const configPath = await tempConfigPath();

  const saved = await registry.upsertAccount('CHEARB', {
    displayName: 'Chearb Page',
    provider: 'generic-keychain',
    username: 'fb-hint@example.com',
    email: 'fb-hint@example.com',
    phone: '+66000000000',
    domain: 'Facebook.com',
    convertTokenMode: 'postcron-oauth'
  }, { configPath });

  assert.equal(saved.account, 'CHEARB');
  assert.equal(saved.key, 'chearb');
  assert.equal(saved.provider, 'generic-keychain');
  assert.equal(saved.displayName, 'Chearb Page');
  assert.equal(saved.username, 'fb-hint@example.com');
  assert.equal(saved.domain, 'facebook.com');
  assert.equal(saved.server, 'facebook.com');
  assert.equal(saved.convertTokenMode, 'postcron-oauth');

  const mode = (await fs.stat(configPath)).mode & 0o777;
  assert.equal(mode, 0o600);

  const list = await registry.listAccounts({ configPath });
  assert.equal(list.length, 1);
  assert.equal(list[0].account, 'CHEARB');

  const got = await registry.getAccount('chearb', { configPath });
  assert.deepEqual(got, saved);

  const removed = await registry.deleteAccount('CHEARB', { configPath });
  assert.equal(removed.removed, true);
  assert.equal((await registry.listAccounts({ configPath })).length, 0);
  assert.equal(await registry.getAccount('CHEARB', { configPath }), null);
});

test('registry defaults provider/convert-mode and validates enums and hosts', async () => {
  const configPath = await tempConfigPath();

  const saved = await registry.upsertAccount('ACC', {}, { configPath });
  assert.equal(saved.provider, 'generic-keychain');
  assert.equal(saved.convertTokenMode, 'none');
  assert.equal(saved.username, null);

  await assert.rejects(() => registry.upsertAccount('ACC', { provider: 'sketchy' }, { configPath }), /Unsupported credential provider/);
  await assert.rejects(() => registry.upsertAccount('ACC', { convertTokenMode: 'evil-mode' }, { configPath }), /Unsupported convert token mode/);
  await assert.rejects(() => registry.upsertAccount('ACC', { domain: 'https://facebook.com' }, { configPath }), /Invalid registry (domain|server)/);
  await assert.rejects(() => registry.upsertAccount('bad/acct', {}, { configPath }), /Invalid account/);
});

test('registry rejects secret-looking fields and never writes them to disk', async () => {
  const configPath = await tempConfigPath();

  for (const field of ['password', 'token', 'cookie', 'secret', 'datr', 'machine_id', 'totp', 'authorization']) {
    const input = { username: 'u@example.com' };
    input[field] = `SECRET-${field}`;
    await assert.rejects(
      () => registry.upsertAccount('ACC', input, { configPath }),
      new RegExp(`Forbidden registry field: ${field}`)
    );
  }

  // None of the rejected upserts created the file.
  await assert.rejects(() => fs.stat(configPath), /ENOENT/);
});

test('registry read rejects forbidden fields already present on disk', async () => {
  const configPath = await tempConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    accounts: { acc: { provider: 'generic-keychain', token: 'tok-secret' } }
  }));

  await assert.rejects(
    () => registry.listAccounts({ configPath }),
    /Forbidden registry field: accounts.acc.token/
  );
  await assert.rejects(
    () => registry.getAccount('ACC', { configPath }),
    error => {
      assertNoLeak(error.message, ['tok-secret']);
      return /Forbidden registry field/.test(error.message);
    }
  );
});

test('registry validates config path safety', () => {
  assert.throws(() => registry.validateConfigPath('relative/registry.json'), /must be absolute/);
  assert.throws(() => registry.validateConfigPath('/tmp/registry.json\n'), /Invalid registry config path/);
});
