#!/usr/bin/env node
'use strict';
const { start, DEFAULT_PORT } = require('../src/server');
const { maybeStartPoller } = require('../src/accountsBridgePoller');
const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
start(port);
// Optionally turn this bridge into a cloud Accounts Bridge AGENT. No-op unless
// ACCOUNTS_BRIDGE_WORKER_URL + ACCOUNTS_BRIDGE_API_KEY are set (and polling isn't disabled). This
// only ADDS an outbound poller for the "Open profile on Mac via Agent" path; it never opens a local
// web UI and never autofills/submits credentials or mints a token.
maybeStartPoller();
