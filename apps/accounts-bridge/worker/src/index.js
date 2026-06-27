// Accounts Bridge v2 — Cloudflare Worker entry.
//
// A pure database + config API (D1-backed). It deliberately contains NO browser-driving, token
// minting, sign-in, or credential-filling code: the local Swift/native operator app performs those
// steps and calls these APIs to persist durable, ownership-explicit state. See README.md / docs.

import { handleRequest } from './router.js';

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
