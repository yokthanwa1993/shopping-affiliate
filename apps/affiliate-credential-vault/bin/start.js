#!/usr/bin/env node
'use strict';
const { start } = require('../src/server');
const port = Number(process.env.AFFILIATE_CREDENTIAL_VAULT_PORT || 8840);
const host = process.env.AFFILIATE_CREDENTIAL_VAULT_HOST || '127.0.0.1';
start({ port, host });
