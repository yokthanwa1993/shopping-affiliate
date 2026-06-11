'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const { sanitizeAccount } = require('./accounts');

const execFileAsync = promisify(execFile);
const SECURITY_BIN = '/usr/bin/security';
const SERVICE_PREFIX = 'com.affiliate.facebook-token-cloak';
const DEFAULT_INTERNET_SERVER = 'facebook.com';
const DEFAULT_INTERNET_PROTOCOL = 'https';
const FACEBOOK_INTERNET_SERVERS = Object.freeze([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'login.facebook.com'
]);
const INTERNET_PROTOCOL_CODES = {
  https: 'htps',
  http: 'http'
};
const INTERNET_PROTOCOL_NAMES = {
  htps: 'https'
};

let _runner = null;
function setRunner(fn) { _runner = fn; }
function clearRunner() { _runner = null; }
async function runSecurity(args) { return _runner ? _runner(args) : execFileAsync(SECURITY_BIN, args); }

function usernameService(k) { return `${SERVICE_PREFIX}.credential.${k}.username`; }
function passwordService(k) { return `${SERVICE_PREFIX}.credential.${k}.password`; }
function credentialService(k) { return passwordService(k); }
function totpService(k) { return `${SERVICE_PREFIX}.totp.${k}`; }
function datrService(k) { return `${SERVICE_PREFIX}.datr.${k}`; }

function stripTrailingNewline(value) {
  return String(value || '').replace(/[\r\n]+$/, '');
}

function protocolCode(protocol) {
  const normalized = normalizeInternetProtocol(protocol);
  return INTERNET_PROTOCOL_CODES[normalized] || normalized || INTERNET_PROTOCOL_CODES[DEFAULT_INTERNET_PROTOCOL];
}

function normalizeInternetProtocol(protocol) {
  const normalized = String(protocol || DEFAULT_INTERNET_PROTOCOL).trim().toLowerCase();
  return INTERNET_PROTOCOL_NAMES[normalized] || normalized || DEFAULT_INTERNET_PROTOCOL;
}

function optionString(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeInternetOptions(opts = {}) {
  const server = optionString(opts.server) || optionString(opts.domain);
  const protocol = normalizeInternetProtocol(opts.protocol);
  const username = optionString(opts.username);
  return {
    server,
    domain: server,
    protocol,
    securityProtocol: protocolCode(protocol),
    username
  };
}

function findInternetPasswordArgs(options, username, includePassword) {
  const args = ['find-internet-password', '-s', options.server, '-r', options.securityProtocol];
  if (username) args.push('-a', username);
  if (includePassword) args.push('-w');
  return args;
}

function parseInternetPasswordUsername(output) {
  const text = String(output || '');
  const match = text.match(/"acct"\s*<[^>]+>\s*=\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') || null;
}

function combineSecurityOutput(result) {
  return `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`;
}

function internetProviderInfo(options, usernameSource) {
  return {
    provider: 'apple-passwords',
    domain: options ? options.domain : null,
    server: options ? options.server : null,
    protocol: options ? options.protocol : DEFAULT_INTERNET_PROTOCOL,
    selectedDomain: options ? options.domain : null,
    selectedServer: options ? options.server : null,
    selectedProtocol: options ? options.protocol : null,
    usernameSource
  };
}

function internetCandidateOptions(options) {
  const servers = options.server ? [options.server] : FACEBOOK_INTERNET_SERVERS;
  return uniqueStrings(servers).map(server => ({
    ...options,
    server,
    domain: server,
    securityProtocol: protocolCode(options.protocol)
  }));
}

function discoveryStatus(display, discovery) {
  const selected = discovery.selected || (discovery.found.length === 1 ? discovery.found[0] : null);
  const selectedOptions = selected ? selected.options : null;
  return {
    account: display,
    credentialPresent: discovery.usable.length === 1,
    usernamePresent: discovery.usable.length > 0,
    passwordPresent: discovery.found.length > 0,
    ...internetProviderInfo(selectedOptions, discovery.usernameSource),
    ambiguous: discovery.usable.length > 1,
    candidatesChecked: {
      count: discovery.candidateDomains.length,
      domains: discovery.candidateDomains
    }
  };
}

async function discoverInternetPassword(rawAccount, opts = {}) {
  const { display } = sanitizeAccount(rawAccount);
  const options = normalizeInternetOptions(opts);
  const candidates = internetCandidateOptions(options);
  const candidateDomains = uniqueStrings(candidates.map(candidate => candidate.domain));
  const found = [];

  for (const candidate of candidates) {
    try {
      const result = await runSecurity(findInternetPasswordArgs(candidate, options.username, false));
      const username = options.username || parseInternetPasswordUsername(combineSecurityOutput(result));
      found.push({
        options: candidate,
        username,
        usernamePresent: !!username,
        passwordPresent: true,
        usernameSource: username ? (options.username ? 'override' : 'metadata') : 'missing'
      });
    } catch {}
  }

  const usable = found.filter(candidate => candidate.usernamePresent && candidate.passwordPresent);
  const selected = usable.length === 1 ? usable[0] : null;
  const usernameSource = options.username
    ? 'override'
    : (usable.length > 0 ? 'metadata' : 'missing');

  return {
    display,
    options,
    candidates,
    candidateDomains,
    found,
    usable,
    selected,
    usernameSource
  };
}

function internetCredentialError(message, status, display, discovery) {
  const err = Object.assign(new Error(message), { status });
  err.safeDetails = discoveryStatus(display, discovery);
  return err;
}

async function retrieveSelectedInternetCredential(display, selected) {
  const { stdout } = await runSecurity(findInternetPasswordArgs(selected.options, selected.username, true));
  const password = stripTrailingNewline(stdout);
  if (!password) throw Object.assign(new Error('Apple Passwords credential not found'), { status: 404 });
  return {
    account: display,
    username: selected.username,
    password,
    provider: 'apple-passwords',
    domain: selected.options.domain,
    server: selected.options.server,
    protocol: selected.options.protocol
  };
}

function directDiscovery(display, options, found) {
  const selected = found
    ? {
        options,
        username: options.username,
        usernamePresent: true,
        passwordPresent: true,
        usernameSource: 'override'
      }
    : null;
  return {
    display,
    options,
    candidates: [options],
    candidateDomains: [options.domain],
    found: selected ? [selected] : [],
    usable: selected ? [selected] : [],
    selected,
    usernameSource: options.username ? 'override' : 'missing'
  };
}

async function storeSecret(service, account, secret) { await runSecurity(['add-generic-password','-a',account,'-s',service,'-w',secret,'-U']); }
async function retrieveSecret(service, account) { const { stdout } = await runSecurity(['find-generic-password','-a',account,'-s',service,'-w']); return String(stdout||'').trim(); }
async function present(service, account) { try { await runSecurity(['find-generic-password','-a',account,'-s',service]); return true; } catch { return false; } }
async function del(service, account) { try { await runSecurity(['delete-generic-password','-a',account,'-s',service]); } catch {} }

async function storeCredential(raw, username, password) { const {key,display}=sanitizeAccount(raw); if(!username||!password) throw Object.assign(new Error('Missing username or password'),{status:400}); await storeSecret(usernameService(key), display, String(username)); await storeSecret(passwordService(key), display, String(password)); return {account:display, services:{username:usernameService(key), password:passwordService(key)}}; }
async function deleteCredential(raw) { const {key,display}=sanitizeAccount(raw); await del(usernameService(key),display); await del(passwordService(key),display); return {account:display, services:{username:usernameService(key), password:passwordService(key)}}; }
async function retrieveCredential(raw) { const {key,display}=sanitizeAccount(raw); return {account:display, username:await retrieveSecret(usernameService(key),display), password:await retrieveSecret(passwordService(key),display)}; }
async function storeTotp(raw, secret) { const {key,display}=sanitizeAccount(raw); if(!secret) throw Object.assign(new Error('Missing TOTP secret'),{status:400}); await storeSecret(totpService(key), display, String(secret)); return {account:display, service:totpService(key)}; }
async function deleteTotp(raw) { const {key,display}=sanitizeAccount(raw); await del(totpService(key),display); return {account:display, service:totpService(key)}; }
async function retrieveTotp(raw) { const {key,display}=sanitizeAccount(raw); return retrieveSecret(totpService(key),display); }
async function storeDatr(raw, datr) { const {key,display}=sanitizeAccount(raw); if(!datr) throw Object.assign(new Error('Missing datr cookie value'),{status:400}); await storeSecret(datrService(key), display, String(datr)); return {account:display, service:datrService(key)}; }
async function deleteDatr(raw) { const {key,display}=sanitizeAccount(raw); await del(datrService(key),display); return {account:display, service:datrService(key)}; }
async function retrieveDatr(raw) { const {key,display}=sanitizeAccount(raw); return retrieveSecret(datrService(key),display); }
async function getDatrStatus(raw) { const {key,display}=sanitizeAccount(raw); const datrPresent=await present(datrService(key),display); return {account:display, datrPresent, service:datrService(key)}; }
async function getStatus(raw) { const {key,display}=sanitizeAccount(raw); const usernamePresent=await present(usernameService(key),display); const passwordPresent=await present(passwordService(key),display); const totpPresent=await present(totpService(key),display); const datrPresent=await present(datrService(key),display); return {account:display, credentialPresent:usernamePresent&&passwordPresent, usernamePresent, passwordPresent, totpPresent, datrPresent, services:{username:usernameService(key), password:passwordService(key), totp:totpService(key), datr:datrService(key)}}; }

async function getInternetPasswordStatus(rawAccount, opts = {}) {
  const discovery = await discoverInternetPassword(rawAccount, opts);
  return discoveryStatus(discovery.display, discovery);
}

async function retrieveInternetCredential(rawAccount, opts = {}) {
  const { display } = sanitizeAccount(rawAccount);
  const options = normalizeInternetOptions(opts);

  if (options.server && options.username) {
    try {
      return await retrieveSelectedInternetCredential(display, {
        options,
        username: options.username,
        usernameSource: 'override'
      });
    } catch {
      throw internetCredentialError(
        'Apple Passwords credential not found',
        404,
        display,
        directDiscovery(display, options, false)
      );
    }
  }

  const discovery = await discoverInternetPassword(rawAccount, opts);
  if (discovery.usable.length === 0) {
    throw internetCredentialError('Apple Passwords credential not found', 404, display, discovery);
  }
  if (discovery.usable.length > 1) {
    throw internetCredentialError(
      'Multiple Apple Passwords credentials found; pass domain/server or username',
      409,
      display,
      discovery
    );
  }
  try {
    return await retrieveSelectedInternetCredential(display, discovery.usable[0]);
  } catch {
    throw internetCredentialError('Apple Passwords credential not found', 404, display, discovery);
  }
}

module.exports={
  SERVICE_PREFIX,
  DEFAULT_INTERNET_SERVER,
  DEFAULT_INTERNET_PROTOCOL,
  FACEBOOK_INTERNET_SERVERS,
  usernameService,
  passwordService,
  credentialService,
  totpService,
  datrService,
  setRunner,
  clearRunner,
  storeCredential,
  deleteCredential,
  retrieveCredential,
  retrieveInternetCredential,
  storeTotp,
  deleteTotp,
  retrieveTotp,
  storeDatr,
  deleteDatr,
  retrieveDatr,
  getDatrStatus,
  getStatus,
  getInternetPasswordStatus,
  parseInternetPasswordUsername
};
