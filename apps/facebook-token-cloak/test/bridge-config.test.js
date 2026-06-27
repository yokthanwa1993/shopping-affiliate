'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const bridgeConfig = require('../src/bridge-config');

let configPath;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-token-cloak-bridge-unit-'));
  configPath = path.join(dir, 'bridge-config.json');
});

test('getFacebookRoles returns empty roles when no file exists', async () => {
  const roles = await bridgeConfig.getFacebookRoles({ configPath });
  assert.deepEqual(roles, { page_posting_facebook_lite: null, ads_power_editor: null });
});

test('setFacebookRoles stores sanitized account display and merges per role', async () => {
  let roles = await bridgeConfig.setFacebookRoles({ page_posting_facebook_lite: 'chearb' }, { configPath });
  assert.equal(roles.page_posting_facebook_lite, 'CHEARB');
  assert.equal(roles.ads_power_editor, null);

  // Setting only the other role leaves the first intact (merge, not replace).
  roles = await bridgeConfig.setFacebookRoles({ ads_power_editor: 'AdsPage' }, { configPath });
  assert.equal(roles.page_posting_facebook_lite, 'CHEARB');
  assert.equal(roles.ads_power_editor, 'ADSPAGE');

  const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(onDisk, { facebook: { page_posting_facebook_lite: 'CHEARB', ads_power_editor: 'ADSPAGE' } });
});

test('setFacebookRoles clears a role with empty string', async () => {
  await bridgeConfig.setFacebookRoles({ page_posting_facebook_lite: 'CHEARB' }, { configPath });
  const roles = await bridgeConfig.setFacebookRoles({ page_posting_facebook_lite: '' }, { configPath });
  assert.equal(roles.page_posting_facebook_lite, null);
});

test('normalizeFacebookRoles rejects a malformed account alias', () => {
  assert.throws(() => bridgeConfig.normalizeFacebookRoles({ page_posting_facebook_lite: 'bad/slash' }), /Invalid account/);
});

test('readConfig rejects a forbidden secret-looking field', async () => {
  await fs.writeFile(configPath, JSON.stringify({ facebook: { page_posting_facebook_lite: 'CHEARB' }, password: 'x' }));
  await assert.rejects(() => bridgeConfig.readConfig(configPath), /Forbidden bridge-config field/);
});

test('config file is written with owner-only permissions', async () => {
  await bridgeConfig.setFacebookRoles({ page_posting_facebook_lite: 'CHEARB' }, { configPath });
  const stat = await fs.stat(configPath);
  assert.equal(stat.mode & 0o777, 0o600);
});
