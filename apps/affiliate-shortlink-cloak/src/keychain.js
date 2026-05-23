'use strict';

const childProcess = require('child_process');
const { sanitizePlatform, sanitizeAccount, VALID_PLATFORMS } = require('./accounts');

const SERVICE_PREFIX = 'com.affiliate.shortlink-cloak';
const MAX_USERNAME_LEN = 256;
const MAX_PASSWORD_LEN = 1024;
const VALID_PLATFORM_SET = new Set(VALID_PLATFORMS);

let runner = defaultRunner;

function defaultRunner(args, opts) {
  return new Promise((resolve) => {
    const child = childProcess.spawn('/usr/bin/security', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts || {}),
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    child.on('error', (err) => {
      resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
    });
    child.on('close', (code) => {
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (opts && typeof opts.stdin === 'string') {
      try { child.stdin.end(opts.stdin); } catch {}
    } else {
      try { child.stdin.end(); } catch {}
    }
  });
}

function __setRunnerForTest(fn) {
  runner = typeof fn === 'function' ? fn : defaultRunner;
}

function __resetRunnerForTest() {
  runner = defaultRunner;
}

function serviceName(platform, account) {
  const p = sanitizePlatform(platform);
  if (!p) throw new Error(`Invalid platform: ${platform}`);
  const a = sanitizeAccount(account);
  return `${SERVICE_PREFIX}.${p}.${a}`;
}

function isSupported() {
  return process.platform === 'darwin';
}

function assertString(name, value, maxLen) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (!value) throw new Error(`${name} must not be empty`);
  if (value.length > maxLen) throw new Error(`${name} too long (max ${maxLen})`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${name} contains an unsupported control character`);
}

function redactStderr(stderr, password) {
  let out = String(stderr || '');
  if (password) {
    try { out = out.split(password).join('[REDACTED]'); } catch {}
  }
  return out.trim().slice(0, 200);
}

async function saveCredential(platform, account, username, password) {
  if (!isSupported()) {
    throw new Error('Keychain credential storage is only supported on macOS');
  }
  assertString('username', username, MAX_USERNAME_LEN);
  assertString('password', password, MAX_PASSWORD_LEN);
  const service = serviceName(platform, account);
  const args = [
    'add-generic-password',
    '-U',
    '-s', service,
    '-a', username,
    '-D', 'affiliate-shortlink-cloak credential',
    '-l', `Affiliate Shortlink Cloak — ${sanitizePlatform(platform)}/${sanitizeAccount(account)}`,
    '-w', password,
  ];
  const result = await runner(args);
  if (result.code !== 0) {
    const msg = redactStderr(result.stderr, password) || `security exit code ${result.code}`;
    throw new Error(`Failed to save credential: ${msg}`);
  }
  return { service, username };
}

async function findCredential(platform, account) {
  if (!isSupported()) return null;
  const service = serviceName(platform, account);
  const result = await runner(['find-generic-password', '-s', service, '-g']);
  if (result.code !== 0) {
    return null;
  }
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  let username = '';
  const userMatch = combined.match(/"acct"<blob>="((?:[^"\\]|\\.)*)"/);
  if (userMatch) {
    username = userMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  let password = '';
  const pwQuoted = combined.match(/^password:\s*"((?:[^"\\]|\\.)*)"\s*$/m);
  if (pwQuoted) {
    password = pwQuoted[1]
      .replace(/\\134/g, '\\')
      .replace(/\\042/g, '"')
      .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\"/g, '"');
  } else {
    const pwHex = combined.match(/^password:\s*0x([0-9A-Fa-f]+)\s/m);
    if (pwHex) {
      try { password = Buffer.from(pwHex[1], 'hex').toString('utf8'); }
      catch { password = ''; }
    }
  }
  if (!password) return null;
  return { service, username, password };
}

async function hasCredential(platform, account) {
  if (!isSupported()) return null;
  const service = serviceName(platform, account);
  const result = await runner(['find-generic-password', '-s', service]);
  if (result.code !== 0) return null;
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  const userMatch = combined.match(/"acct"<blob>="((?:[^"\\]|\\.)*)"/);
  const username = userMatch ? userMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
  return { service, username };
}

function decodeBlobLiteral(literal) {
  if (literal == null) return '';
  const trimmed = String(literal).trim();
  if (!trimmed) return '';
  // Quoted string form: "..."  (with security's octal escapes like \042 = ")
  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1);
    if (closing === -1) return '';
    const inner = trimmed.slice(1, closing);
    return inner
      .replace(/\\134/g, '\\')
      .replace(/\\042/g, '"')
      .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\"/g, '"');
  }
  // Hex form: 0xDEADBEEF (optionally followed by an annotated readable literal)
  if (/^0x/i.test(trimmed)) {
    const hex = trimmed.slice(2).match(/^[0-9A-Fa-f]+/);
    if (!hex) return '';
    try { return Buffer.from(hex[0], 'hex').toString('utf8'); }
    catch { return ''; }
  }
  return '';
}

function parseDumpForCredentials(text) {
  const raw = String(text || '');
  if (!raw) return [];
  // Each item starts with a line like `keychain: "..."`. Split on the boundary.
  const blocks = raw.split(/\r?\nkeychain:\s/);
  if (!blocks.length) return [];
  // Re-prefix every block except possibly the first so a regex anchored on the
  // header still works if needed; we only inspect the body so it's not required.
  const items = [];
  for (const block of blocks) {
    // Only generic-password items (class "genp") carry our credentials.
    if (!/class:\s*"genp"/.test(block)) continue;
    const svceMatch = block.match(/"svce"<blob>=([^\n]*)/);
    if (!svceMatch) continue;
    const svce = decodeBlobLiteral(svceMatch[1]);
    if (!svce || !svce.startsWith(SERVICE_PREFIX + '.')) continue;
    const rest = svce.slice(SERVICE_PREFIX.length + 1);
    const dotIdx = rest.indexOf('.');
    if (dotIdx <= 0) continue;
    const platform = rest.slice(0, dotIdx);
    const account = rest.slice(dotIdx + 1);
    if (!VALID_PLATFORM_SET.has(platform) || !account) continue;
    const acctMatch = block.match(/"acct"<blob>=([^\n]*)/);
    const username = acctMatch ? decodeBlobLiteral(acctMatch[1]) : '';
    items.push({ platform, account, username, configured: true });
  }
  // De-duplicate by (platform, account); prefer entries with a non-empty username.
  const map = new Map();
  for (const it of items) {
    const key = it.platform + '\u0000' + it.account;
    const prev = map.get(key);
    if (!prev || (!prev.username && it.username)) map.set(key, it);
  }
  const out = Array.from(map.values());
  out.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    if (a.account !== b.account) return a.account < b.account ? -1 : 1;
    return 0;
  });
  return out;
}

async function listCredentials() {
  if (!isSupported()) return [];
  let result;
  try {
    result = await runner(['dump-keychain']);
  } catch {
    return [];
  }
  if (!result || result.code !== 0) return [];
  try {
    return parseDumpForCredentials(result.stdout || '');
  } catch {
    return [];
  }
}

async function deleteCredential(platform, account) {
  if (!isSupported()) {
    throw new Error('Keychain credential storage is only supported on macOS');
  }
  const service = serviceName(platform, account);
  const result = await runner(['delete-generic-password', '-s', service]);
  if (result.code !== 0) {
    const stderr = String(result.stderr || '').toLowerCase();
    if (/could not be found|specified item could not be found/.test(stderr)) {
      return { service, deleted: false };
    }
    throw new Error(`Failed to delete credential: ${redactStderr(result.stderr, '')}`);
  }
  return { service, deleted: true };
}

module.exports = {
  SERVICE_PREFIX,
  serviceName,
  isSupported,
  saveCredential,
  findCredential,
  hasCredential,
  listCredentials,
  deleteCredential,
  parseDumpForCredentials,
  __setRunnerForTest,
  __resetRunnerForTest,
};
