'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');

const APP_ROOT = path.resolve(__dirname, '..');
const PLIST_PATH = path.join(APP_ROOT, 'launchd', 'com.affiliate.facebook-token-cloak.plist');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function stringForKey(plist, key) {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return match ? match[1] : undefined;
}

test('LaunchAgent plist pins label, command, paths, and opt-in startup', () => {
  const plist = read(PLIST_PATH);

  assert.equal(stringForKey(plist, 'Label'), 'com.affiliate.facebook-token-cloak');
  assert.equal(
    stringForKey(plist, 'WorkingDirectory'),
    '/Users/yok-macmini/Developer/shopping-affiliate/apps/facebook-token-cloak'
  );
  assert.equal(stringForKey(plist, 'StandardOutPath'), '/Users/yok-macmini/Library/Logs/facebook-token-cloak.log');
  assert.equal(stringForKey(plist, 'StandardErrorPath'), '/Users/yok-macmini/Library/Logs/facebook-token-cloak.err.log');
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>[\s\S]*<string>\/usr\/bin\/env<\/string>/);
  assert.match(plist, /<string>HOME=\/Users\/yok-macmini<\/string>/);
  assert.match(plist, /<string>NODE_ENV=production<\/string>/);
  assert.match(plist, /<string>PORT=8820<\/string>/);
  assert.match(plist, /<string>node<\/string>[\s\S]*<string>\/Users\/yok-macmini\/Developer\/shopping-affiliate\/apps\/facebook-token-cloak\/bin\/start\.js<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<string>\/bin\/(?:ba)?sh<\/string>/);
});

test('package exposes LaunchAgent lifecycle scripts', () => {
  assert.equal(packageJson.scripts['launchd:install'], 'bash scripts/install-launchagent.sh');
  assert.equal(packageJson.scripts['launchd:start'], 'bash scripts/start-launchagent.sh');
  assert.equal(packageJson.scripts['launchd:stop'], 'bash scripts/stop-launchagent.sh');
  assert.equal(packageJson.scripts['launchd:status'], 'bash scripts/status-launchagent.sh');
  assert.equal(packageJson.scripts['launchd:uninstall'], 'bash scripts/uninstall-launchagent.sh');

  for (const scriptName of [
    'install-launchagent.sh',
    'start-launchagent.sh',
    'stop-launchagent.sh',
    'status-launchagent.sh',
    'uninstall-launchagent.sh'
  ]) {
    const script = read(path.join(APP_ROOT, 'scripts', scriptName));
    assert.match(script, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
  }
});
