'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { sanitizeAccount } = require('./accounts');

const CONFIG_ENV = 'FACEBOOK_TOKEN_CLOAK_ACCOUNTS_CONFIG';
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.facebook-token-cloak', 'accounts.json');
const PROVIDER = 'apple-passwords';
const DEFAULT_PROTOCOL = 'https';
const ALLOWED_PROTOCOLS = new Set(['https', 'http']);
const FORBIDDEN_FIELD_RE = /password|token|cookie|secret/i;

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
    if (FORBIDDEN_FIELD_RE.test(key)) throw statusError(`Forbidden selector field: ${field}`);
    rejectForbiddenFields(nested, field);
  }
}

function configPathFromEnv(env = process.env) {
  return env[CONFIG_ENV] || DEFAULT_CONFIG_PATH;
}

function validateConfigPath(rawPath = configPathFromEnv()) {
  if (typeof rawPath !== 'string') throw statusError('Invalid accounts config path');
  rejectControlChars('accounts config path', rawPath);
  const trimmed = rawPath.trim();
  if (!trimmed) throw statusError('Invalid accounts config path');
  if (!path.isAbsolute(trimmed)) throw statusError('Accounts config path must be absolute');
  return path.normalize(trimmed);
}

function normalizeProvider(raw) {
  const value = String(raw || '');
  rejectControlChars('credential provider', value);
  const provider = value.trim().toLowerCase();
  if (provider !== PROVIDER) throw statusError('Unsupported credential provider');
  return PROVIDER;
}

function normalizeProtocol(raw = DEFAULT_PROTOCOL) {
  const value = String(raw || DEFAULT_PROTOCOL);
  rejectControlChars('protocol', value);
  const protocol = value.trim().toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) throw statusError('Unsupported selector protocol');
  return protocol;
}

function normalizeServer(raw) {
  if (typeof raw !== 'string') throw statusError('Missing selector server or domain');
  rejectControlChars('server', raw);
  const server = raw.trim().toLowerCase();
  if (!server || server.length > 253) throw statusError('Invalid selector server');
  if (server.includes('/') || server.includes(':') || server.includes('..')) throw statusError('Invalid selector server');
  if (!/^[a-z0-9.-]+$/.test(server)) throw statusError('Invalid selector server');
  if (server.startsWith('.') || server.endsWith('.')) throw statusError('Invalid selector server');
  return server;
}

function normalizeUsername(raw) {
  if (typeof raw !== 'string') throw statusError('Missing selector username');
  rejectControlChars('username', raw);
  const username = raw.trim();
  if (!username) throw statusError('Missing selector username');
  return username;
}

function normalizeSelector(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('Invalid selector');
  rejectForbiddenFields(input);
  const allowed = new Set(['credentialProvider', 'provider', 'server', 'domain', 'protocol', 'username']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw statusError(`Unsupported selector field: ${key}`);
  }

  const credentialProvider = normalizeProvider(input.credentialProvider || input.provider);
  const rawServer = input.server == null ? input.domain : input.server;
  const server = normalizeServer(rawServer);
  if (input.domain != null && input.server != null && normalizeServer(input.domain) !== server) {
    throw statusError('Selector domain and server must match');
  }

  return {
    credentialProvider,
    server,
    domain: server,
    protocol: normalizeProtocol(input.protocol),
    username: normalizeUsername(input.username)
  };
}

function selectorStatus(rawAccount, selector) {
  const { display } = sanitizeAccount(rawAccount);
  if (!selector) {
    return {
      account: display,
      selectorPresent: false,
      credentialProvider: null,
      usernameHintPresent: false,
      domain: null,
      server: null,
      protocol: null,
      selectedDomain: null,
      selectedServer: null,
      selectedProtocol: null
    };
  }
  return {
    account: display,
    selectorPresent: true,
    credentialProvider: selector.credentialProvider,
    usernameHintPresent: !!selector.username,
    domain: selector.domain,
    server: selector.server,
    protocol: selector.protocol,
    selectedDomain: selector.domain,
    selectedServer: selector.server,
    selectedProtocol: selector.protocol
  };
}

async function readConfig(configPath = validateConfigPath()) {
  const filePath = validateConfigPath(configPath);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { accounts: {} };
    if (error instanceof SyntaxError) throw statusError('Invalid accounts config JSON');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw statusError('Invalid accounts config');
  rejectForbiddenFields(parsed);
  const accounts = parsed.accounts == null ? parsed : parsed.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw statusError('Invalid accounts config');

  const normalized = {};
  for (const [rawAccount, selector] of Object.entries(accounts)) {
    const { key } = sanitizeAccount(rawAccount);
    normalized[key] = normalizeSelector(selector);
  }
  return { accounts: normalized };
}

async function writeConfig(config, configPath = validateConfigPath()) {
  const filePath = validateConfigPath(configPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ accounts: config.accounts || {} }, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {}
}

async function getSelector(rawAccount, options = {}) {
  const { key } = sanitizeAccount(rawAccount);
  const config = await readConfig(options.configPath);
  return config.accounts[key] || null;
}

async function getSelectorStatus(rawAccount, options = {}) {
  return selectorStatus(rawAccount, await getSelector(rawAccount, options));
}

async function listStatuses(options = {}) {
  const config = await readConfig(options.configPath);
  return Object.entries(config.accounts).map(([key, selector]) => selectorStatus(key, selector));
}

async function saveSelector(rawAccount, input, options = {}) {
  const { key } = sanitizeAccount(rawAccount);
  const selector = normalizeSelector(input);
  const config = await readConfig(options.configPath);
  config.accounts[key] = selector;
  await writeConfig(config, options.configPath);
  return selectorStatus(rawAccount, selector);
}

async function deleteSelector(rawAccount, options = {}) {
  const { key } = sanitizeAccount(rawAccount);
  const config = await readConfig(options.configPath);
  delete config.accounts[key];
  await writeConfig(config, options.configPath);
  return selectorStatus(rawAccount, null);
}

module.exports = {
  CONFIG_ENV,
  DEFAULT_CONFIG_PATH,
  PROVIDER,
  configPathFromEnv,
  validateConfigPath,
  normalizeSelector,
  selectorStatus,
  readConfig,
  writeConfig,
  getSelector,
  getSelectorStatus,
  listStatuses,
  saveSelector,
  deleteSelector
};
