'use strict';

// Optional cloud command poller for the Accounts Bridge "Open profile on Mac via Agent" path.
//
// This module turns the local bridge into a cloud-reachable Mac AGENT. When the operator clicks
// "Open on Mac" / "Close on Mac" in the cloud dashboard (https://www.pubilo.com/dashboard/accounts),
// the dashboard enqueues a NON-SECRET command in the Accounts Bridge Worker. This poller:
//   * syncs the local account registry (token-free: uid + display label only) to the cloud,
//   * heartbeats agent status,
//   * polls its command queue, runs each command against THIS machine, and reports a sanitized result.
//
// SAFETY INVARIANTS:
//   * It NEVER autofills a credential, submits a login, or mints a token. open_profile reuses the same
//     safe path as GET /login?visible=1&autofill=0&submit=0 — a VISIBLE window only.
//   * No secret (token/cookie/datr/password/totp) is ever sent to the cloud. Results are stripped of
//     secret-shaped keys before upload (defence in depth on top of the Worker's own rejection).
//   * It does NOT run on require and NOT in tests — it only runs when start() is called explicitly,
//     which bin/start.js does ONLY when ACCOUNTS_BRIDGE_WORKER_URL + ACCOUNTS_BRIDGE_API_KEY are set.
//   * It adds NO local web UI and never touches the root '/' native-only invariant.

const DEFAULT_WORKER_URL = 'https://accounts-bridge-worker.yokthanwa1993-bc9.workers.dev';
const DEFAULT_AGENT_ID = 'mac-mini';
const DEFAULT_POLL_MS = 5000;

// Secret-shaped key names — any result key matching this is dropped before upload. Mirrors the
// dashboard/worker redaction so a result can never carry a raw secret even by mistake.
const SECRET_KEY_RE = /password|token|cookie|secret|datr|fb_dtsg|dtsg|totp|otp|2fa|authorization|access_token|c_user/i;

// Stable, sanitized agent id: lowercased, [a-z0-9._-] only, never empty, bounded length.
function sanitizeAgentId(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || DEFAULT_AGENT_ID;
}

// Recursively drop secret-shaped keys from a result object (keeps boolean presence flags).
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key) && typeof raw !== 'boolean') continue;
      out[key] = stripSecrets(raw);
    }
    return out;
  }
  return value;
}

function readConfig(env = process.env) {
  const baseUrl = String(env.ACCOUNTS_BRIDGE_WORKER_URL || env.ACCOUNTS_BRIDGE_URL || DEFAULT_WORKER_URL).trim().replace(/\/+$/, '');
  const apiKey = String(env.ACCOUNTS_BRIDGE_API_KEY || env.FACEBOOK_TOKEN_CLOAK_API_KEY || '').trim();
  const agentId = sanitizeAgentId(env.ACCOUNTS_BRIDGE_AGENT_ID || DEFAULT_AGENT_ID);
  const pollMsRaw = Number(env.ACCOUNTS_BRIDGE_AGENT_POLL_MS);
  const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 1000 ? pollMsRaw : DEFAULT_POLL_MS;
  // Enabled only when explicitly NOT turned off AND both URL + key are present.
  const enabledFlag = env.ACCOUNTS_BRIDGE_AGENT_POLL !== '0';
  const configured = !!baseUrl && !!apiKey;
  return { baseUrl, apiKey, agentId, pollMs, enabled: enabledFlag && configured, configured };
}

// Factory: build a poller with injectable deps so tests never touch the network or a real browser.
function createPoller(deps = {}) {
  const env = deps.env || process.env;
  const cfg = readConfig(env);
  const agentId = deps.agentId ? sanitizeAgentId(deps.agentId) : cfg.agentId;
  const fetchImpl = deps.fetch || global.fetch;
  const br = deps.browser || require('./browser');
  const registry = deps.accountsRegistry || require('./accounts-registry');
  const logger = deps.logger || console;
  const timeoutMs = deps.timeoutMs || 20000;

  let timer = null;
  let ticking = false;

  function headers(extra = {}) {
    return { 'x-accounts-bridge-key': cfg.apiKey, ...extra };
  }

  async function fetchWithTimeout(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // Push the local account registry to the cloud as token-free rows (uid + display label only).
  async function syncAccounts() {
    let accounts = [];
    try {
      accounts = await registry.listAccounts();
    } catch {
      accounts = [];
    }
    let synced = 0;
    for (const rec of accounts) {
      const accountUid = String(rec.key || rec.account || '').trim();
      if (!accountUid) continue;
      const displayLabel = String(rec.displayName || rec.account || accountUid).slice(0, 120);
      try {
        const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/accounts`, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          // ONLY non-secret identity fields — never username/email/phone/credential material.
          body: JSON.stringify({ platform: 'facebook', account_uid: accountUid, display_label: displayLabel })
        });
        if (res.ok || res.status === 409) synced += 1;
      } catch {
        // Network hiccup syncing one account is non-fatal; keep going.
      }
    }
    return { synced, total: accounts.length };
  }

  // Heartbeat agent status with non-secret detail.
  async function heartbeat(detail = {}) {
    try {
      const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/status`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ status: 'online', label: agentId, detail: stripSecrets({ app: 'facebook-token-cloak', ...detail }) })
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // open_profile: VISIBLE window, autofill + submit OFF. Reuses the same safe open path as /login.
  async function openProfile(accountUid) {
    const opened = await br.openPage(accountUid, 'https://www.facebook.com/', { visible: true, reuse: true });
    return stripSecrets({ opened: true, profileDir: opened && opened.profileDir ? opened.profileDir : null, reused: !!(opened && opened.reused) });
  }

  // close_profile: close the operator-visible context this process owns for the account.
  async function closeProfile(accountUid) {
    const result = await br.closeAccountContext(accountUid);
    return stripSecrets({ closed: !!result.closed, state: result.state || (result.closed ? 'closed' : 'not_open') });
  }

  // Run a single claimed command and return { status, result?, error_code?, error_message? }.
  async function runCommand(cmd) {
    try {
      if (cmd.action === 'open_profile') {
        if (!cmd.account_uid) return { status: 'failed', error_code: 'account_uid_required', error_message: 'open_profile needs an account_uid' };
        return { status: 'succeeded', result: await openProfile(cmd.account_uid) };
      }
      if (cmd.action === 'close_profile') {
        if (!cmd.account_uid) return { status: 'failed', error_code: 'account_uid_required', error_message: 'close_profile needs an account_uid' };
        return { status: 'succeeded', result: await closeProfile(cmd.account_uid) };
      }
      if (cmd.action === 'sync_accounts') {
        return { status: 'succeeded', result: await syncAccounts() };
      }
      if (cmd.action === 'status') {
        const sync = await syncAccounts();
        await heartbeat({ accountsCount: sync.total });
        return { status: 'succeeded', result: { ok: true, accountsCount: sync.total } };
      }
      return { status: 'failed', error_code: 'unknown_action', error_message: `unsupported action ${cmd.action}` };
    } catch (e) {
      const code = String((e && (e.code || e.name)) || 'command_failed');
      const message = String((e && e.message) || 'command_failed');
      return { status: 'failed', error_code: code.slice(0, 80), error_message: message };
    }
  }

  async function complete(commandId, outcome) {
    try {
      await fetchWithTimeout(`${cfg.baseUrl}/v1/commands/${encodeURIComponent(commandId)}/complete`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          status: outcome.status,
          result: outcome.result == null ? null : stripSecrets(outcome.result),
          error_code: outcome.error_code || null,
          error_message: outcome.error_message || null
        })
      });
    } catch {
      // Reporting failure is non-fatal; the command stays 'running' and can be re-reported.
    }
  }

  // Claim queued commands for this agent and run them. Returns the list of completed command ids.
  async function poll() {
    let commands = [];
    try {
      const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/poll`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ limit: 5 })
      });
      if (!res.ok) return [];
      const body = await res.json().catch(() => ({}));
      commands = Array.isArray(body && body.commands) ? body.commands : [];
    } catch {
      return [];
    }
    const done = [];
    for (const cmd of commands) {
      if (!cmd || !cmd.id) continue;
      const outcome = await runCommand(cmd);
      await complete(cmd.id, outcome);
      done.push(cmd.id);
    }
    return done;
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const ok = await heartbeat();
      const done = await poll();
      if (done.length && logger.log) logger.log(`[accounts-bridge-poller] completed commands: ${done.join(',')}`);
      return { heartbeat: ok, done };
    } catch (e) {
      const code = String((e && (e.code || e.name || e.message)) || 'tick_failed');
      try { logger.warn && logger.warn(`[accounts-bridge-poller] tick failed: ${code}`); } catch {}
      return { heartbeat: false, done: [], error: code };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (!cfg.enabled) {
      logger.log && logger.log(`[accounts-bridge-poller] disabled (configured=${cfg.configured}) — not starting`);
      return null;
    }
    logger.log && logger.log(`[accounts-bridge-poller] starting · agent=${agentId} · worker=${cfg.baseUrl} · interval=${cfg.pollMs}ms`);
    // Prime the cloud once with the current account list, then tick immediately and on an interval.
    syncAccounts().then((r) => logger.log && logger.log(`[accounts-bridge-poller] initial account sync: ${r.synced}/${r.total}`)).catch(() => {});
    tick().then((r) => logger.log && logger.log(`[accounts-bridge-poller] first tick: heartbeat=${!!(r && r.heartbeat)} done=${((r && r.done) || []).length}`)).catch((e) => logger.warn && logger.warn(`[accounts-bridge-poller] first tick failed: ${String(e && e.message)}`));
    timer = setInterval(() => { tick().catch((e) => { try { logger.warn && logger.warn(`[accounts-bridge-poller] interval tick failed: ${String(e && e.message)}`); } catch {} }); }, cfg.pollMs);
    return handle;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  const handle = { start, stop, tick, poll, heartbeat, syncAccounts, runCommand, openProfile, closeProfile, config: cfg, agentId };
  return handle;
}

// Called by bin/start.js. A no-op (returns null) unless the cloud worker URL + key are present and
// polling is not explicitly disabled. Never throws — a misconfigured poller must not break the bridge.
function maybeStartPoller(deps = {}) {
  try {
    const cfg = readConfig(deps.env || process.env);
    if (!cfg.enabled) return null;
    return createPoller(deps).start();
  } catch (e) {
    try { (deps.logger || console).warn && (deps.logger || console).warn(`[accounts-bridge-poller] failed to start: ${String(e && e.message)}`); } catch {}
    return null;
  }
}

module.exports = { createPoller, maybeStartPoller, readConfig, sanitizeAgentId, stripSecrets };
