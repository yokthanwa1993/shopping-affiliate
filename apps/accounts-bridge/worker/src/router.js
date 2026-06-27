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
  HttpError,
  badRequest,
  assertPlatform,
  assertRole,
  assertIdentifier,
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
  return new AccountsStore(env.DB, opts);
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

    return json({ ok: false, error: 'not_found', path }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ ok: false, error: error.code || 'error', message: error.message }, error.status);
    }
    // Never leak internals; surface a stable shape.
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
