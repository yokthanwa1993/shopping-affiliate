#!/usr/bin/env node
'use strict';

const { start } = require('../src/server');

const server = start();

function shutdown(signal) {
  console.log(`[affiliate-shortlink-cloak] received ${signal}, closing server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
