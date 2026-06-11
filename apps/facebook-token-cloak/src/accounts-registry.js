'use strict';

// Non-secret local account registry for the facebook-token-cloak UI.
//
// This file stores ONLY non-secret metadata used to show "which accounts are in
// the local system" (alias/namespace, display name, provider, username/email/phone
// hint, domain/server, convert-token-mode label). Passwords, TOTP seeds, datr
// cookies, tokens and any other secret live ONLY in the macOS Keychain and are
// never written here. Forbidden secret-looking fields are rejected defensively.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { sanitizeAccount } = require('./accounts');

const CONFIG_ENV = 'FACEBOOK_TOKEN_CLOAK_REGISTRY_CONFIG';
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.facebook-token-cloak', 'registry.json');
const DEFAULT_PROVIDER = 'generic-keychain';
const ALLOWED_PROVIDERS = new Set(['generic-keychain', 'apple-passwords']);
const ALLOWED_PROTOCOLS = new Set(['https', 'http']);
const DEFAULT_CONVERT_TOKEN_MODE = 'none';
const ALLOWED_CONVERT_TOKEN_MODES = new Set(['none', 'postcron-oauth', 'graph-explorer', 'manual']);
// Defence in depth: never let a secret-looking field reach the on-disk registry.
const FORBIDDEN_FIELD_RE = /password|token|cookie|secret|datr|machine[_-]?id|totp|otp|2fa|authorization/i;
// Known non-secret keys are exempt from the substring scan (e.g. `convertTokenMode`
// legitimately contains "token"). Everything else is still scanned.
const SAFE_FIELD_NAMES = new Set([
  'accounts', 'displayName', 'provider', 'credentialProvider',
  'username', 'email', 'phone', 'domain', 'server', 'protocol', 'convertTokenMode'
]);
const TEXT_FIELDS = ['displayName', 'username', 'email', 'phone'];
const MAX_TEXT_LEN = 320;

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
    if (!SAFE_FIELD_NAMES.has(key) && FORBIDDEN_FIELD_RE.test(key)) throw statusError(`Forbidden registry field: ${field}`);
    rejectForbiddenFields(nested, field);
  }
}

function configPathFromEnv(env = process.env) {
  return env[CONFIG_ENV] || DEFAULT_CONFIG_PATH;
}

function validateConfigPath(rawPath = configPathFromEnv()) {
  if (typeof rawPath !== 'string') throw statusError('Invalid registry config path');
  rejectControlChars('registry config path', rawPath);
  const trimmed = rawPath.trim();
  if (!trimmed) throw statusError('Invalid registry config path');
  if (!path.isAbsolute(trimmed)) throw statusError('Registry config path must be absolute');
  return path.normalize(trimmed);
}

function normalizeProvider(raw) {
  if (raw == null || raw === '') return DEFAULT_PROVIDER;
  const value = String(raw);
  rejectControlChars('credential provider', value);
  const provider = value.trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) throw statusError('Unsupported credential provider');
  return provider;
}

function normalizeProtocol(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  rejectControlChars('protocol', value);
  const protocol = value.trim().toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) throw statusError('Unsupported registry protocol');
  return protocol;
}

function normalizeHost(name, raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw statusError(`Invalid registry ${name}`);
  rejectControlChars(name, raw);
  const host = raw.trim().toLowerCase();
  if (!host) return null;
  if (host.length > 253) throw statusError(`Invalid registry ${name}`);
  if (host.includes('/') || host.includes(':') || host.includes('..')) throw statusError(`Invalid registry ${name}`);
  if (!/^[a-z0-9.-]+$/.test(host)) throw statusError(`Invalid registry ${name}`);
  if (host.startsWith('.') || host.endsWith('.')) throw statusError(`Invalid registry ${name}`);
  return host;
}

function normalizeText(name, raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw statusError(`Invalid ${name}`);
  rejectControlChars(name, raw);
  const value = raw.trim();
  if (!value) return null;
  if (value.length > MAX_TEXT_LEN) throw statusError(`Invalid ${name}`);
  return value;
}

function normalizeConvertTokenMode(raw) {
  if (raw == null || raw === '') return DEFAULT_CONVERT_TOKEN_MODE;
  const value = String(raw);
  rejectControlChars('convert token mode', value);
  const mode = value.trim().toLowerCase();
  if (!ALLOWED_CONVERT_TOKEN_MODES.has(mode)) throw statusError('Unsupported convert token mode');
  return mode;
}

function normalizeEntry(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('Invalid account entry');
  rejectForbiddenFields(input);
  const server = normalizeHost('server', input.server == null ? input.domain : input.server);
  const domain = normalizeHost('domain', input.domain == null ? input.server : input.domain);
  return {
    displayName: normalizeText('displayName', input.displayName),
    provider: normalizeProvider(input.provider || input.credentialProvider),
    username: normalizeText('username', input.username),
    email: normalizeText('email', input.email),
    phone: normalizeText('phone', input.phone),
    domain,
    server,
    protocol: normalizeProtocol(input.protocol),
    convertTokenMode: normalizeConvertTokenMode(input.convertTokenMode)
  };
}

function entryRecord(rawAccount, entry) {
  const { key, display } = sanitizeAccount(rawAccount);
  const e = entry || {};
  return {
    account: display,
    key,
    displayName: e.displayName || null,
    provider: e.provider || DEFAULT_PROVIDER,
    username: e.username || null,
    email: e.email || null,
    phone: e.phone || null,
    domain: e.domain || null,
    server: e.server || null,
    protocol: e.protocol || null,
    convertTokenMode: e.convertTokenMode || DEFAULT_CONVERT_TOKEN_MODE
  };
}

// Strip null/default values so the on-disk file stays compact.
function compactEntry(entry) {
  const out = { provider: entry.provider };
  for (const field of TEXT_FIELDS) if (entry[field]) out[field] = entry[field];
  if (entry.domain) out.domain = entry.domain;
  if (entry.server && entry.server !== entry.domain) out.server = entry.server;
  if (entry.protocol) out.protocol = entry.protocol;
  if (entry.convertTokenMode && entry.convertTokenMode !== DEFAULT_CONVERT_TOKEN_MODE) {
    out.convertTokenMode = entry.convertTokenMode;
  }
  return out;
}

async function readConfig(configPath = validateConfigPath()) {
  const filePath = validateConfigPath(configPath);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { accounts: {} };
    if (error instanceof SyntaxError) throw statusError('Invalid registry config JSON');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw statusError('Invalid registry config');
  rejectForbiddenFields(parsed);
  const accounts = parsed.accounts == null ? parsed : parsed.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw statusError('Invalid registry config');

  const normalized = {};
  for (const [rawAccount, entry] of Object.entries(accounts)) {
    const { key } = sanitizeAccount(rawAccount);
    normalized[key] = normalizeEntry(entry);
  }
  return { accounts: normalized };
}

async function writeConfig(config, configPath = validateConfigPath()) {
  const filePath = validateConfigPath(configPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const accounts = {};
  for (const [key, entry] of Object.entries(config.accounts || {})) accounts[key] = compactEntry(entry);
  const body = `${JSON.stringify({ accounts }, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {}
}

async function getAccount(rawAccount, options = {}) {
  const { key } = sanitizeAccount(rawAccount);
  const config = await readConfig(options.configPath);
  return config.accounts[key] ? entryRecord(rawAccount, config.accounts[key]) : null;
}

async function listAccounts(options = {}) {
  const config = await readConfig(options.configPath);
  return Object.entries(config.accounts).map(([key, entry]) => entryRecord(key, entry));
}

async function upsertAccount(rawAccount, input, options = {}) {
  const { key } = sanitizeAccount(rawAccount);
  const entry = normalizeEntry(input);
  const config = await readConfig(options.configPath);
  config.accounts[key] = entry;
  await writeConfig(config, options.configPath);
  return entryRecord(rawAccount, entry);
}

async function deleteAccount(rawAccount, options = {}) {
  const { key, display } = sanitizeAccount(rawAccount);
  const config = await readConfig(options.configPath);
  const removed = Object.prototype.hasOwnProperty.call(config.accounts, key);
  delete config.accounts[key];
  await writeConfig(config, options.configPath);
  return { account: display, key, removed };
}

module.exports = {
  CONFIG_ENV,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PROVIDER,
  ALLOWED_PROVIDERS,
  ALLOWED_CONVERT_TOKEN_MODES,
  configPathFromEnv,
  validateConfigPath,
  normalizeEntry,
  entryRecord,
  readConfig,
  writeConfig,
  getAccount,
  listAccounts,
  upsertAccount,
  deleteAccount
};
