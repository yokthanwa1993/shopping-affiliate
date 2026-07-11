import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLISTS = [
  'launchd/com.affiliate.admin-media-drive.api.plist',
  'launchd/com.affiliate.admin-media-drive.worker.plist',
  'launchd/com.affiliate.admin-media-drive.merge-rust.plist',
];
const SCRIPTS = [
  'scripts/launchd-run.sh',
  'scripts/install-launchagents.sh',
  'scripts/status-launchagents.sh',
  'scripts/uninstall-launchagents.sh',
  'scripts/setup-python-venv.sh',
];

const hasPlutil = process.platform === 'darwin'
  && spawnSync('plutil', ['-help']).status !== null;

test('LaunchAgent plists are valid plist XML', { skip: !hasPlutil && 'plutil unavailable' }, () => {
  for (const rel of PLISTS) {
    const result = spawnSync('plutil', ['-lint', path.join(appDir, rel)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${rel}: ${result.stdout}${result.stderr}`);
  }
});

test('LaunchAgent plists use /Users/yok-macmini paths, KeepAlive/RunAtLoad, and contain no secrets', () => {
  for (const rel of PLISTS) {
    const file = path.join(appDir, rel);
    const text = fs.readFileSync(file, 'utf8');
    const label = path.basename(rel, '.plist');
    assert.ok(text.includes(`<string>${label}</string>`), `${rel} Label matches filename`);
    assert.ok(text.includes('<key>RunAtLoad</key>'), `${rel} RunAtLoad`);
    assert.ok(text.includes('<key>KeepAlive</key>'), `${rel} KeepAlive`);
    assert.ok(text.includes('/Users/yok-macmini/Developer/shopping-affiliate/apps/admin-media-drive'), `${rel} absolute app path`);
    assert.ok(text.includes('/Users/yok-macmini/Library/Logs/admin-media-drive/'), `${rel} bounded log path`);
    for (const needle of ['DISCORD_BOT_TOKEN', 'BEGIN PRIVATE KEY', 'client_secret', 'Bearer ']) {
      assert.equal(text.includes(needle), false, `${rel} must not embed ${needle}`);
    }
    assert.equal(/"private_key"/.test(text), false, `${rel} must not embed credential JSON`);
  }
});

test('operational scripts exist, are executable, and never echo secrets', () => {
  for (const rel of SCRIPTS) {
    const file = path.join(appDir, rel);
    const stat = fs.statSync(file);
    assert.ok(stat.isFile(), `${rel} exists`);
    assert.ok(stat.mode & 0o100, `${rel} is executable`);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /set -[eu]+o pipefail|set -uo pipefail/, `${rel} uses strict mode`);
    assert.equal(text.includes('cat .env'), false, `${rel} never dumps .env`);
    // Mentioning the variable NAME in a hint is fine; expanding its VALUE is not.
    assert.equal(/echo.*\$\{?DISCORD_BOT_TOKEN/.test(text), false, `${rel} never echoes the token value`);
    assert.equal(/echo.*\$\{?GOOGLE_APPLICATION_CREDENTIALS/.test(text), false, `${rel} never echoes the credential path var`);
  }
});

test('merge-rust supervisor plist runs the merge-rust role and restarts on failure only', () => {
  const text = fs.readFileSync(
    path.join(appDir, 'launchd/com.affiliate.admin-media-drive.merge-rust.plist'),
    'utf8',
  );
  assert.match(text, /launchd-run\.sh merge-rust/, 'dispatches the merge-rust role');
  // SuccessfulExit=false: exit 0 (external MERGE_RUST_URL — nothing to
  // supervise) leaves the agent stopped instead of respawn-looping.
  assert.match(text, /<key>SuccessfulExit<\/key>\s*<false\/>/, 'KeepAlive on failure only');
});

test('launchd-run.sh dispatches api, worker, and merge-rust roles', () => {
  const text = fs.readFileSync(path.join(appDir, 'scripts/launchd-run.sh'), 'utf8');
  for (const role of ['api)', 'worker)', 'merge-rust)']) {
    assert.ok(text.includes(role), `launchd-run.sh handles ${role}`);
  }
  assert.match(text, /start-merge-rust\.js/, 'merge-rust role runs the supervisor entry');
});

test('install/status/uninstall scripts manage the merge-rust agent too', () => {
  for (const rel of [
    'scripts/install-launchagents.sh',
    'scripts/status-launchagents.sh',
    'scripts/uninstall-launchagents.sh',
  ]) {
    const text = fs.readFileSync(path.join(appDir, rel), 'utf8');
    assert.ok(
      text.includes('com.affiliate.admin-media-drive.merge-rust'),
      `${rel} includes the merge-rust label`,
    );
  }
});

test('installer retries the launchd bootstrap (bootout/bootstrap EIO race)', () => {
  const text = fs.readFileSync(path.join(appDir, 'scripts/install-launchagents.sh'), 'utf8');
  assert.match(text, /bootstrapped=0/, 'has a bootstrap retry loop');
  assert.match(text, /sleep 2/, 'waits between bootstrap attempts');
});

test('venv setup script installs Pillow into the app-local venv only (no global pip)', () => {
  const text = fs.readFileSync(path.join(appDir, 'scripts/setup-python-venv.sh'), 'utf8');
  assert.match(text, /-m venv/, 'creates a venv');
  assert.match(text, /\$VENV_DIR\/bin\/pip/, 'pip always the venv pip');
  assert.equal(/pip install --user/.test(text), false, 'no --user installs');
  assert.equal(/sudo/.test(text), false, 'no sudo');
  assert.match(text, /pillow>=10/, 'pins a Pillow range');
});
