// HTTP router for Accounts Bridge v2.
//
// IMPORTANT INVARIANTS (enforced + asserted by tests):
//   * Token-free: no endpoint mints/refreshes a token, signs in, fills credentials, submits, or
//     opens a browser. This Worker has no headless-browser code path — it is a pure DB + config API.
//   * No secret blob is ever returned by a GET. Sessions/cookies expose only digest + version + flags.
//   * Every /v1 write requires the shared local-bridge API key (timing-safe compared).
//   * Page posting role is Facebook Lite / Token Bridge ONLY; ad creation is Power Editor ONLY.
//   * Page bindings reject a mismatched account/role: the account must actually hold the role.

import { AccountsStore } from './store.js';
import {
  SERVICE,
  API_VERSION,
  ROLES,
  ROLE_LABELS,
  SURFACE_ROLE,
  COMMAND_ACTIONS,
  COMMAND_TERMINAL_STATUSES,
  AGENT_STATUSES,
  HttpError,
  badRequest,
  assertPlatform,
  assertRole,
  assertIdentifier,
  assertNoSecretMaterial,
  timingSafeEqualStr,
  json,
  redact
} from './lib.js';

const AUTH_HEADER = 'x-accounts-bridge-key';
// Audit detail is non-secret provenance only — reject secret-looking keys defensively.
const FORBIDDEN_DETAIL_RE = /password|token|cookie|secret|datr|fb_dtsg|totp|otp|2fa|authorization|encrypted_blob/i;

function requireApiKey(request, env) {
  const expected = env.ACCOUNTS_BRIDGE_API_KEY;
  if (typeof expected !== 'string' || expected === '') {
    // Fail closed: without a configured key the v1 surface is unusable, never open.
    throw new HttpError('Accounts Bridge API key is not configured', 503, 'api_key_unconfigured');
  }
  const provided = request.headers.get(AUTH_HEADER) || '';
  if (!timingSafeEqualStr(provided, expected)) {
    throw new HttpError('Unauthorized', 401, 'unauthorized');
  }
}

async function readJson(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw badRequest('Invalid JSON body', 'bad_json');
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('JSON object body required', 'bad_json');
  }
  return body;
}

function assertSafeDetail(detail) {
  if (detail == null) return null;
  if (typeof detail !== 'object' || Array.isArray(detail)) throw badRequest('audit detail must be an object', 'bad_detail');
  const walk = (value, prefix) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (FORBIDDEN_DETAIL_RE.test(key)) throw badRequest(`Forbidden audit-detail field: ${field}`, 'forbidden_detail');
      walk(nested, field);
    }
  };
  walk(detail, '');
  return detail;
}

// Pull platform from query (?platform=) defaulting to facebook for the role/binding endpoints.
function platformFromQuery(url, fallback = 'facebook') {
  const raw = url.searchParams.get('platform');
  return assertPlatform(raw || fallback);
}

export function createStore(env, opts = {}) {
  if (!env || !env.DB) throw new HttpError('DB binding missing', 500, 'no_db');
  // PROFILE_ARCHIVES is the optional R2 bucket binding for sealed profile archives.
  return new AccountsStore(env.DB, { bucket: env.PROFILE_ARCHIVES, ...opts });
}

// Core dispatch. `store` is injectable for tests; defaults to a D1-backed store.
export async function handleRequest(request, env, deps = {}) {
  const store = deps.store || createStore(env, { clock: deps.clock });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  try {
    // --- public health (no key) ---
    if (path === '/health' || path === '/') {
      return json({ ok: true, service: SERVICE, api: API_VERSION, roles: ROLES, role_labels: ROLE_LABELS });
    }

    // Everything under /v1 requires the shared local-bridge key.
    if (path.startsWith('/v1/')) requireApiKey(request, env);


    // --- fixed schema bootstrap (for environments where Wrangler D1 management is unavailable) ---
    if (path === '/v1/admin/bootstrap' && method === 'POST') {
      const result = await store.bootstrapSchema();
      await store.insertAudit({ event_type: 'schema.bootstrap', source: 'api' });
      return json({ ok: true, ...result });
    }

    // --- accounts ---
    if (path === '/v1/accounts' && method === 'GET') {
      const platform = url.searchParams.get('platform');
      if (platform) assertPlatform(platform);
      return json({ accounts: await store.listAccounts(platform || undefined) });
    }
    if (path === '/v1/accounts' && method === 'POST') {
      const body = await readJson(request);
      const platform = assertPlatform(body.platform);
      const accountUid = assertIdentifier('account_uid', body.account_uid);
      const displayLabel = body.display_label == null ? null : assertIdentifier('display_label', body.display_label, { maxLen: 120 });
      const { account, created } = await store.createAccount({
        account_uid: accountUid,
        platform,
        display_label: displayLabel
      });
      await store.insertAudit({ event_type: created ? 'account.created' : 'account.exists', account_uid: accountUid, platform, source: 'api' });
      return json({ account, created }, created ? 201 : 200);
    }

    // --- facebook role mapping ---
    const roleMatch = path.match(/^\/v1\/roles\/([a-z]+)$/);
    if (roleMatch) {
      const platform = assertPlatform(roleMatch[1]);
      if (method === 'GET') {
        return json({ platform, roles: await store.listRoles(platform, ROLES), role_labels: ROLE_LABELS });
      }
      if (method === 'PUT') {
        const body = await readJson(request);
        const patch = body.roles && typeof body.roles === 'object' ? body.roles : body;
        const source = body.source == null ? null : assertIdentifier('source', body.source, { maxLen: 120 });
        const version = body.version == null ? null : assertIdentifier('version', body.version, { maxLen: 120 });
        for (const role of Object.keys(patch)) {
          if (!ROLES.includes(role)) throw badRequest(`Unknown role: ${redact(role)}`, 'bad_role');
        }
        for (const role of ROLES) {
          if (!Object.prototype.hasOwnProperty.call(patch, role)) continue;
          const raw = patch[role];
          if (raw == null || raw === '') {
            await store.setRole(platform, role, null);
            await store.insertAudit({ event_type: 'role.cleared', platform, role, source: 'api' });
            continue;
          }
          const accountUid = assertIdentifier(`roles.${role}`, raw);
          if (!(await store.getAccount(platform, accountUid))) {
            throw new HttpError(`Account not found for role ${role}: ${redact(accountUid)}`, 422, 'account_not_found');
          }
          await store.setRole(platform, role, accountUid, { source, version });
          await store.insertAudit({ event_type: 'role.assigned', account_uid: accountUid, platform, role, source: 'api' });
        }
        return json({ platform, roles: await store.listRoles(platform, ROLES), role_labels: ROLE_LABELS });
      }
    }

    // --- page bindings ---
    const bindMatch = path.match(/^\/v1\/pages\/([^/]+)\/binding$/);
    if (bindMatch) {
      const pageId = assertIdentifier('page_id', decodeURIComponent(bindMatch[1]));
      const platform = platformFromQuery(url);
      if (method === 'GET') {
        return json({ platform, page_id: pageId, bindings: await store.getPageBindings(platform, pageId) });
      }
      if (method === 'PUT') {
        const body = await readJson(request);
        const role = assertRole(body.role);
        const accountUid = assertIdentifier('account_uid', body.account_uid);
        const bodyPlatform = body.platform == null ? platform : assertPlatform(body.platform);
        const displayLabel = body.display_label == null ? null : assertIdentifier('display_label', body.display_label, { maxLen: 120 });
        const source = body.source == null ? null : assertIdentifier('source', body.source, { maxLen: 120 });
        const version = body.version == null ? null : assertIdentifier('version', body.version, { maxLen: 120 });
        // The account must EXIST and actually HOLD the role on this platform — no fallback account,
        // no role/account drift.
        if (!(await store.getAccount(bodyPlatform, accountUid))) {
          throw new HttpError(`Account not found: ${redact(accountUid)}`, 422, 'account_not_found');
        }
        if (!(await store.accountHoldsRole(bodyPlatform, accountUid, role))) {
          throw new HttpError(`Account ${redact(accountUid)} does not hold role ${role}`, 409, 'role_mismatch');
        }
        const binding = await store.putPageBinding({
          platform: bodyPlatform,
          page_id: pageId,
          account_uid: accountUid,
          role,
          display_label: displayLabel,
          source,
          version
        });
        await store.insertAudit({ event_type: 'page_binding.set', account_uid: accountUid, platform: bodyPlatform, role, page_id: pageId, source: 'api' });
        return json({ platform: bodyPlatform, page_id: pageId, binding });
      }
    }

    // --- sessions ---
    if (path === '/v1/sessions' && method === 'POST') {
      const body = await readJson(request);
      const platform = assertPlatform(body.platform);
      const role = assertRole(body.role);
      const accountUid = assertIdentifier('account_uid', body.account_uid);
      const version = assertIdentifier('version', body.version, { maxLen: 120 });
      const source = assertIdentifier('source', body.source, { maxLen: 120 });
      const pageId = body.page_id == null ? null : assertIdentifier('page_id', body.page_id);
      if (!(await store.getAccount(platform, accountUid))) {
        throw new HttpError(`Account not found: ${redact(accountUid)}`, 422, 'account_not_found');
      }
      // The role must be held by the account, so a stored session can always be traced to the owner.
      if (!(await store.accountHoldsRole(platform, accountUid, role))) {
        throw new HttpError(`Account ${redact(accountUid)} does not hold role ${role}`, 409, 'role_mismatch');
      }
      // `encrypted_blob` is validated as ciphertext inside the store (rejects plaintext secrets).
      const session = await store.insertSession({
        account_uid: accountUid,
        platform,
        role,
        page_id: pageId,
        version,
        source,
        encrypted_blob: body.encrypted_blob
      });
      await store.insertAudit({ event_type: 'session.stored', account_uid: accountUid, platform, role, page_id: pageId, source: 'api', detail: { version, digest: session.blob_digest } });
      return json({ session }, 201);
    }

    if (path === '/v1/sessions/status' && method === 'GET') {
      const platform = platformFromQuery(url);
      const role = assertRole(url.searchParams.get('role'));
      const accountUid = assertIdentifier('account_uid', url.searchParams.get('account_uid') || '');
      return json({ platform, account_uid: accountUid, role, ...(await store.sessionStatus({ platform, account_uid: accountUid, role })) });
    }

    // --- cookies (write-only; status surfaced via digest, never blob) ---
    if (path === '/v1/cookies' && method === 'POST') {
      const body = await readJson(request);
      const platform = assertPlatform(body.platform);
      const accountUid = assertIdentifier('account_uid', body.account_uid);
      const version = assertIdentifier('version', body.version, { maxLen: 120 });
      const source = assertIdentifier('source', body.source, { maxLen: 120 });
      const role = body.role == null ? null : assertRole(body.role);
      const pageId = body.page_id == null ? null : assertIdentifier('page_id', body.page_id);
      const cookieScope = body.cookie_scope == null ? null : assertIdentifier('cookie_scope', body.cookie_scope, { maxLen: 120 });
      if (!(await store.getAccount(platform, accountUid))) {
        throw new HttpError(`Account not found: ${redact(accountUid)}`, 422, 'account_not_found');
      }
      const cookie = await store.insertCookie({
        account_uid: accountUid,
        platform,
        role,
        page_id: pageId,
        cookie_scope: cookieScope,
        version,
        source,
        encrypted_blob: body.encrypted_blob
      });
      await store.insertAudit({ event_type: 'cookie.stored', account_uid: accountUid, platform, role, page_id: pageId, source: 'api', detail: { version, digest: cookie.blob_digest } });
      return json({ cookie }, 201);
    }

    // --- profile archives (BrowserSaving-style restore-on-open / save-on-close, but SEALED) ---
    // The bytes are a locally-sealed ABENC1 envelope; the Worker stores opaque ciphertext in R2 and
    // never parses cookies/tokens/datr/passwords from them. Metadata responses are token-free.
    const archiveMatch = path.match(/^\/v1\/profile-archives\/([a-z]+)\/([a-z_]+)\/([^/]+)\/(upload|download|status)$/);
    if (archiveMatch) {
      const platform = assertPlatform(archiveMatch[1]);
      const role = assertRole(archiveMatch[2]);
      const accountUid = assertIdentifier('account_uid', decodeURIComponent(archiveMatch[3]));
      const action = archiveMatch[4];
      const owner = { platform, role, account_uid: accountUid };

      if (action === 'status' && method === 'GET') {
        return json({ ...owner, ...(await store.profileArchiveStatus(owner)) });
      }

      if (action === 'download' && method === 'GET') {
        const { meta, object } = await store.getProfileArchiveBytes(owner);
        if (!meta || !object) return json({ ok: false, error: 'archive_not_found', ...owner }, 404);
        // Stream opaque ciphertext to the authenticated local client. Non-secret metadata rides in
        // headers so the client can verify what it restored without a second round-trip.
        return new Response(object.body, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-archive-digest': meta.blob_digest,
            'x-archive-version': meta.version,
            'x-archive-cipher': meta.cipher,
            'x-archive-size': String(meta.byte_size)
          }
        });
      }

      if (action === 'upload' && method === 'POST') {
        const version = assertIdentifier('version', url.searchParams.get('version') || '', { maxLen: 120 });
        const source = assertIdentifier('source', url.searchParams.get('source') || '', { maxLen: 120 });
        const cipherRaw = url.searchParams.get('cipher');
        const cipher = cipherRaw == null || cipherRaw === '' ? 'aesgcm' : assertIdentifier('cipher', cipherRaw, { maxLen: 40 });
        // Ownership is explicit: the account must exist AND actually hold the role, so a restored
        // profile can always be traced to its rightful owner (no fallback account).
        if (!(await store.getAccount(platform, accountUid))) {
          throw new HttpError(`Account not found: ${redact(accountUid)}`, 422, 'account_not_found');
        }
        if (!(await store.accountHoldsRole(platform, accountUid, role))) {
          throw new HttpError(`Account ${redact(accountUid)} does not hold role ${role}`, 409, 'role_mismatch');
        }
        const archiveBytes = new Uint8Array(await request.arrayBuffer());
        const archive = await store.putProfileArchive({ platform, role, account_uid: accountUid, version, source, cipher, archive: archiveBytes });
        await store.insertAudit({ event_type: 'profile_archive.uploaded', account_uid: accountUid, platform, role, source: 'api', detail: { version, digest: archive.blob_digest, byte_size: archive.byte_size } });
        return json({ archive }, 201);
      }
    }

    // --- audit ---
    if (path === '/v1/audit/events' && method === 'POST') {
      const body = await readJson(request);
      const eventType = assertIdentifier('event_type', body.event_type, { maxLen: 120 });
      const platform = body.platform == null ? null : assertPlatform(body.platform);
      const role = body.role == null ? null : assertRole(body.role);
      const accountUid = body.account_uid == null ? null : assertIdentifier('account_uid', body.account_uid);
      const pageId = body.page_id == null ? null : assertIdentifier('page_id', body.page_id);
      const source = body.source == null ? null : assertIdentifier('source', body.source, { maxLen: 120 });
      const detail = assertSafeDetail(body.detail);
      const event = await store.insertAudit({ event_type: eventType, account_uid: accountUid, platform, role, page_id: pageId, source: source || 'api', detail });
      return json({ event }, 201);
    }

    // --- agent command queue (cloud-backed Mac Agent launcher) ----------------------------------
    // The Worker is still a pure DB API: it stores non-secret commands + agent heartbeats and never
    // opens a browser / mints a token. The local Mac agent polls its queue, runs each command on its
    // OWN machine, and reports a non-secret result. payload/result reject secret-shaped keys/values.

    // Enqueue a command for an agent.
    if (path === '/v1/commands' && method === 'POST') {
      const body = await readJson(request);
      const agentId = assertIdentifier('agent_id', body.agent_id, { maxLen: 120 });
      const action = assertIdentifier('action', body.action, { maxLen: 40 });
      if (!COMMAND_ACTIONS.includes(action)) {
        throw badRequest(`Unknown action: ${redact(action)}`, 'bad_action');
      }
      const platform = body.platform == null || body.platform === '' ? null : assertPlatform(body.platform);
      const role = body.role == null || body.role === '' ? null : assertRole(body.role);
      const accountUid = body.account_uid == null || body.account_uid === '' ? null : assertIdentifier('account_uid', body.account_uid);
      // open/close target a specific profile; the account_uid is mandatory for them.
      if ((action === 'open_profile' || action === 'close_profile') && !accountUid) {
        throw badRequest(`account_uid is required for action ${action}`, 'account_uid_required');
      }
      const payload = assertNoSecretMaterial(body.payload == null ? null : body.payload, 'payload');
      const command = await store.enqueueCommand({ agent_id: agentId, action, platform, role, account_uid: accountUid, payload });
      await store.insertAudit({ event_type: 'command.enqueued', account_uid: accountUid, platform, role, source: 'api', detail: { agent_id: agentId, action, command_id: command.id } });
      return json({ command }, 201);
    }

    // List recent commands (most-recent-first), optionally filtered by agent_id / status.
    if (path === '/v1/commands' && method === 'GET') {
      const agentId = url.searchParams.get('agent_id');
      if (agentId) assertIdentifier('agent_id', agentId, { maxLen: 120 });
      const status = url.searchParams.get('status');
      const limit = url.searchParams.get('limit');
      const commands = await store.listCommands({ agent_id: agentId || null, status: status || null, limit: limit || 20 });
      return json({ commands });
    }

    // Report a terminal result for a running command.
    const completeMatch = path.match(/^\/v1\/commands\/([^/]+)\/complete$/);
    if (completeMatch && method === 'POST') {
      const commandId = assertIdentifier('command_id', decodeURIComponent(completeMatch[1]), { maxLen: 120 });
      const body = await readJson(request);
      const status = assertIdentifier('status', body.status, { maxLen: 40 });
      if (!COMMAND_TERMINAL_STATUSES.includes(status)) {
        throw badRequest(`status must be one of ${COMMAND_TERMINAL_STATUSES.join(', ')}`, 'bad_status');
      }
      const result = assertNoSecretMaterial(body.result == null ? null : body.result, 'result');
      const errorCode = body.error_code == null ? null : assertIdentifier('error_code', String(body.error_code), { maxLen: 80 });
      const errorMessage = body.error_message == null ? null : String(body.error_message);
      const outcome = await store.completeCommand({ id: commandId, status, result, error_code: errorCode, error_message: errorMessage });
      if (!outcome.ok && outcome.reason === 'not_found') return json({ ok: false, error: 'command_not_found' }, 404);
      if (!outcome.ok && outcome.reason === 'not_running') return json({ ok: false, error: 'command_not_running', command: outcome.command }, 409);
      await store.insertAudit({ event_type: 'command.completed', source: 'api', detail: { command_id: commandId, status, error_code: outcome.command?.error_code ?? null } });
      return json({ command: outcome.command });
    }

    // Agent poll: atomically claim queued commands and mark them running. Also a heartbeat.
    const pollMatch = path.match(/^\/v1\/agents\/([^/]+)\/poll$/);
    if (pollMatch && method === 'POST') {
      const agentId = assertIdentifier('agent_id', decodeURIComponent(pollMatch[1]), { maxLen: 120 });
      let body = {};
      try { body = await readJson(request); } catch { body = {}; }
      const limit = body && body.limit != null ? body.limit : 5;
      const commands = await store.claimQueuedCommands({ agent_id: agentId, limit });
      return json({ agent_id: agentId, commands });
    }

    // Agent heartbeat / status upsert.
    const statusMatch = path.match(/^\/v1\/agents\/([^/]+)\/status$/);
    if (statusMatch) {
      const agentId = assertIdentifier('agent_id', decodeURIComponent(statusMatch[1]), { maxLen: 120 });
      if (method === 'GET') {
        const agent = await store.getAgent(agentId);
        return json({ agent_id: agentId, present: !!agent, agent });
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readJson(request);
        let status = null;
        if (body.status != null && body.status !== '') {
          status = assertIdentifier('status', body.status, { maxLen: 40 });
          if (!AGENT_STATUSES.includes(status)) throw badRequest(`status must be one of ${AGENT_STATUSES.join(', ')}`, 'bad_status');
        }
        const label = body.label == null ? null : assertIdentifier('label', body.label, { maxLen: 120 });
        const detail = assertNoSecretMaterial(body.detail == null ? null : body.detail, 'detail');
        const agent = await store.upsertAgentStatus({ agent_id: agentId, status, label, detail, seen: true });
        return json({ agent });
      }
    }

    // List known agents (dashboard heartbeat view).
    if (path === '/v1/agents' && method === 'GET') {
      return json({ agents: await store.listAgents() });
    }

    return json({ ok: false, error: 'not_found', path }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ ok: false, error: error.code || 'error', message: error.message }, error.status);
    }
    // Never leak internals; surface a stable shape.
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
