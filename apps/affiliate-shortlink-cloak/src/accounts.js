'use strict';

const path = require('path');
const fs = require('fs');
const { PROFILE_ROOT, DEFAULT_ACCOUNT } = require('./config');

const VALID_PLATFORMS = new Set(['shopee', 'lazada']);
const ACCOUNT_MAX_LEN = 64;

function sanitizeAccount(raw) {
  const str = String(raw == null ? '' : raw).trim();
  if (!str) return DEFAULT_ACCOUNT;
  const cleaned = str.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, ACCOUNT_MAX_LEN);
  return cleaned || DEFAULT_ACCOUNT;
}

function sanitizePlatform(raw) {
  const str = String(raw == null ? '' : raw).trim().toLowerCase();
  return VALID_PLATFORMS.has(str) ? str : '';
}

function profileDirFor(platform, account, root = PROFILE_ROOT) {
  const p = sanitizePlatform(platform);
  if (!p) throw new Error(`Invalid platform: ${platform}`);
  const a = sanitizeAccount(account);
  return path.join(root, p, a);
}

function ensureProfileDir(platform, account, root = PROFILE_ROOT) {
  const dir = profileDirFor(platform, account, root);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listAccounts(root = PROFILE_ROOT) {
  const out = { shopee: [], lazada: [] };
  for (const platform of VALID_PLATFORMS) {
    const dir = path.join(root, platform);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      out[platform].push(entry.name);
    }
    out[platform].sort();
  }
  return out;
}

module.exports = {
  VALID_PLATFORMS: Array.from(VALID_PLATFORMS),
  DEFAULT_ACCOUNT,
  sanitizeAccount,
  sanitizePlatform,
  profileDirFor,
  ensureProfileDir,
  listAccounts,
};
