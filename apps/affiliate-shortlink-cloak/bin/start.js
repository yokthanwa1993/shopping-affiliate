#!/usr/bin/env node
'use strict';

const { start } = require('../src/server');
const browser = require('../src/browser');

const server = start();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[affiliate-shortlink-cloak] received ${signal}, closing server`);
  // Release any resident (keep-warm/headless or headed/manual) CloakBrowser
  // contexts on explicit shutdown — keep-warm intentionally never idle-closes
  // them, so this is where they get torn down cleanly.
  Promise.resolve()
    .then(() => browser.closeAll())
    .catch(() => {})
    .finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
