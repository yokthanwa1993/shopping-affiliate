'use strict';

// Non-secret Accounts Bridge configuration store.
//
// This file persists ONLY non-secret operational config for the Accounts Bridge — specifically the
// Facebook role mapping that says WHICH local account plays each conceptually-separate role:
//   - page_posting_facebook_lite : Facebook Lite (EAAD6V) Token Bridge used for Page posting
//   - ads_power_editor           : Power Editor browser session used for ad creation
// It stores account aliases/namespaces only. Passwords, TOTP seeds, datr cookies, tokens and any
// other secret live ONLY in the macOS Keychain and are never written here. Forbidden secret-looking
// fields are rejected defensively, mirroring accounts-registry.js.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { sanitizeAccount } = require('./accounts');

const CONFIG_ENV = 'FACEBOOK_TOKEN_CLOAK_BRIDGE_CONFIG';
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.facebook-token-cloak', 'bridge-config.json');

// The two Facebook roles this bridge mediates. Page posting and ad creation are kept separate on
// purpose (different surfaces, different accounts allowed) — see API response names.
const FACEBOOK_ROLES = ['page_posting_facebook_lite', 'ads_power_editor'];
const FACEBOOK_ROLE_LABELS = Object.freeze({
  page_posting_facebook_lite: 'Facebook Lite — Page posting / Token Bridge',
  ads_power_editor: 'Power Editor — Ad creation'
});

// Defence in depth: never let a secret-looking field reach the on-disk bridge config.
const FORBIDDEN_FIELD_RE = /password|token|cookie|secret|datr|machine[_-]?id|totp|otp|2fa|authorization/i;
// Known non-secret keys are exempt from the substring scan. The Facebook Lite role key legitimately
// contains no secret term, but list the structural keys here so the scan only ever catches stray
// secret-looking fields a caller might attach.
const SAFE_FIELD_NAMES = new Set(['facebook', ...FACEBOOK_ROLES]);

function statusError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function rejectControlChars(name, value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw statusError(`Invalid ${name}`);
}

function rejectForbiddenFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (!SAFE_FIELD_NAMES.has(key) && FORBIDDEN_FIELD_RE.test(key)) throw statusError(`Forbidden bridge-config field: ${field}`);
    rejectForbiddenFields(nested, field);
  }
}

function configPathFromEnv(env = process.env) {
  return env[CONFIG_ENV] || DEFAULT_CONFIG_PATH;
}

function validateConfigPath(rawPath = configPathFromEnv()) {
  if (typeof rawPath !== 'string') throw statusError('Invalid bridge-config path');
  rejectControlChars('bridge-config path', rawPath);
  const trimmed = rawPath.trim();
  if (!trimmed) throw statusError('Invalid bridge-config path');
  if (!path.isAbsolute(trimmed)) throw statusError('Bridge-config path must be absolute');
  return path.normalize(trimmed);
}

// Returns a sanitized account display string, or null when the role is being cleared. Throws a 400
// for anything that is not a valid account alias.
function normalizeRoleAccount(role, raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw statusError(`Invalid account for ${role}`);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const { display } = sanitizeAccount(trimmed);
  return display;
}

function emptyFacebookRoles() {
  const out = {};
  for (const role of FACEBOOK_ROLES) out[role] = null;
  return out;
}

function normalizeFacebookRoles(input = {}) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw statusError('Invalid facebook role mapping');
  rejectForbiddenFields(input);
  const out = emptyFacebookRoles();
  for (const role of FACEBOOK_ROLES) {
    if (Object.prototype.hasOwnProperty.call(input, role)) out[role] = normalizeRoleAccount(role, input[role]);
  }
  return out;
}

async function readConfig(configPath = validateConfigPath()) {
  const filePath = validateConfigPath(configPath);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { facebook: emptyFacebookRoles() };
    if (error instanceof SyntaxError) throw statusError('Invalid bridge-config JSON');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw statusError('Invalid bridge-config');
  rejectForbiddenFields(parsed);
  return { facebook: normalizeFacebookRoles(parsed.facebook || {}) };
}

async function writeConfig(config, configPath = validateConfigPath()) {
  const filePath = validateConfigPath(configPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const facebook = normalizeFacebookRoles((config && config.facebook) || {});
  const body = `${JSON.stringify({ facebook }, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {}
}

async function getFacebookRoles(options = {}) {
  const config = await readConfig(options.configPath);
  return config.facebook;
}

// Merge: only the roles present in `input` are changed; pass null/'' to clear a role. Returns the
// full normalized mapping after the write.
async function setFacebookRoles(input, options = {}) {
  const patch = normalizeFacebookRoles(input || {});
  const config = await readConfig(options.configPath);
  const merged = { ...config.facebook };
  for (const role of FACEBOOK_ROLES) {
    if (input && Object.prototype.hasOwnProperty.call(input, role)) merged[role] = patch[role];
  }
  await writeConfig({ facebook: merged }, options.configPath);
  return merged;
}

module.exports = {
  CONFIG_ENV,
  DEFAULT_CONFIG_PATH,
  FACEBOOK_ROLES,
  FACEBOOK_ROLE_LABELS,
  configPathFromEnv,
  validateConfigPath,
  normalizeFacebookRoles,
  emptyFacebookRoles,
  readConfig,
  writeConfig,
  getFacebookRoles,
  setFacebookRoles
};
