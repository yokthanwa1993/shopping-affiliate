#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
function loadAccountsBridgeEnvFile() {
  const explicit = process.env.ACCOUNTS_BRIDGE_ENV_FILE || '/Users/yok-macmini/.config/shopping-affiliate/facebook-token-cloak.env';
  if (!explicit) return;
  let text = '';
  try { text = fs.readFileSync(explicit, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    // Runtime env-file wins for Accounts Bridge wiring so a stale LaunchAgent env cannot keep
    // the Mac agent disconnected from the cloud command queue. Do not override unrelated app env.
    if (process.env[key] == null || key.startsWith('ACCOUNTS_BRIDGE_')) process.env[key] = value;
  }
}
loadAccountsBridgeEnvFile();
const { start, DEFAULT_PORT } = require('../src/server');
const { maybeStartPoller } = require('../src/accountsBridgePoller');
const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
start(port);
// Optionally turn this bridge into a cloud Accounts Bridge AGENT. No-op unless
// ACCOUNTS_BRIDGE_WORKER_URL + ACCOUNTS_BRIDGE_API_KEY are set (and polling isn't disabled). This
// only ADDS an outbound poller for the "Open profile on Mac via Agent" path; it never opens a local
// web UI and never autofills/submits credentials or mints a token.
const accountsBridgePoller = maybeStartPoller();
// Keep the poller handle strongly referenced for the lifetime of the daemon; otherwise the interval
// can be garbage-collected after the initial sync and commands stay queued.
global.__accountsBridgePoller = accountsBridgePoller;
