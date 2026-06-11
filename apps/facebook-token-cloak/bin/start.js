#!/usr/bin/env node
'use strict';
const { start, DEFAULT_PORT } = require('../src/server');
const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
start(port);
