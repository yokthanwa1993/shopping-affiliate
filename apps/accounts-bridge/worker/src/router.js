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
import { getCredentialKey, detectImageMime } from './crypto.js';
import {
  SERVICE,
  API_VERSION,
  ROLES,
  ROLE_LABELS,
  SURFACE_ROLE,
  COMMAND_ACTIONS,
  COMMAND_TERMINAL_STATUSES,
  AGENT_STATUSES,
  ACCOUNT_TAGS,
  AVATAR_MAX_BYTES,
  CREDENTIAL_FIELD_NAMES,
  HttpError,
  badRequest,
  assertPlatform,
  assertRole,
  assertIdentifier,
  assertAccountUid,
  assertNoSecretAccountFields,
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

// Parse an avatar upload from multipart/form-data (file field), application/json (data_url/base64), or
// a raw image body. Validates the image TYPE by signature (never trusting a client-claimed MIME) and
// the size cap. Returns { bytes, mime } where mime is the canonical png/jpeg/webp.
async function readAvatarUpload(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  let bytes = null;
  if (ct.includes('multipart/form-data')) {
    let form;
    try { form = await request.formData(); } catch { throw badRequest('invalid multipart form', 'bad_avatar'); }
    const file = form.get('file') || form.get('avatar') || form.get('image');
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      throw badRequest('avatar file field required', 'bad_avatar');
    }
    bytes = new Uint8Array(await file.arrayBuffer());
  } else if (ct.includes('application/json')) {
    const body = await readJson(request);
    let b64 = null;
    if (typeof body.data_url === 'string') {
      const m = body.data_url.match(/^data:[^;,]*;base64,(.+)$/);
      if (!m) throw badRequest('data_url must be a base64 image data URL', 'bad_avatar');
      b64 = m[1];
    } else if (typeof body.base64 === 'string') {
      b64 = body.base64.replace(/^data:[^,]*,/, '');
    }
    if (!b64) throw badRequest('avatar image (data_url or base64) required', 'bad_avatar');
    try {
      bytes = Uint8Array.from(atob(b64.trim()), (ch) => ch.charCodeAt(0));
    } catch {
      throw badRequest('avatar base64 is invalid', 'bad_avatar');
    }
  } else {
    bytes = new Uint8Array(await request.arrayBuffer());
  }
  if (!bytes || bytes.byteLength === 0) throw badRequest('avatar image is empty', 'bad_avatar');
  if (bytes.byteLength > AVATAR_MAX_BYTES) throw badRequest('avatar image is too large (max 2MB)', 'avatar_too_large');
  const mime = detectImageMime(bytes);
  if (!mime) throw badRequest('avatar must be a PNG, JPEG, or WEBP image', 'bad_avatar_type');
  return { bytes, mime };
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

// --- account metadata validation (non-secret operator fields only) ---------------------------------
const ACCOUNT_ROLE_MAX = 40;
// Statuses the API accepts on input. 'disabled' is a UI synonym for the stored 'inactive' (the DB
// CHECK only knows active/inactive/archived — we map rather than widen the enum / rebuild the table).
const ACCOUNT_STATUSES_IN = ['active', 'inactive', 'disabled', 'archived'];

// Optional free-text metadata field: null/'' -> null, else trimmed, length-capped, control-char-free.
function optAccountText(name, value, { maxLen, allowNewlines = false } = {}) {
  if (value == null) return null;
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`, 'bad_field');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLen) throw badRequest(`${name} is too long (max ${maxLen})`, 'bad_field');
  const ctrl = allowNewlines ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
  if (ctrl.test(trimmed)) throw badRequest(`${name} has invalid characters`, 'bad_field');
  return trimmed;
}

// Normalize an input status to a stored status. Returns undefined when not provided (so PATCH can tell
// "leave unchanged" from an explicit value); maps the UI's 'disabled' onto the stored 'inactive'.
function normalizeAccountStatus(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('status must be a string', 'bad_status');
  const v = value.trim().toLowerCase();
  if (!ACCOUNT_STATUSES_IN.includes(v)) {
    throw badRequest(`status must be one of ${ACCOUNT_STATUSES_IN.join(', ')}`, 'bad_status');
  }
  return v === 'disabled' ? 'inactive' : v;
}

// Validate the tags input shape (string[] or comma/newline-separated string). The store does the
// trim/dedupe/cap; here we only reject a wrong TYPE. Returns undefined when the key is absent.
function validateTagsInput(value) {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const t of value) if (typeof t !== 'string') throw badRequest('tags must be strings', 'bad_tags');
    return value;
  }
  if (typeof value === 'string') return value;
  throw badRequest('tags must be a string or string array', 'bad_tags');
}

function readAccountRole(value) {
  if (value == null || value === '') return null;
  return assertIdentifier('account_role', value, { maxLen: ACCOUNT_ROLE_MAX });
}

// BrowserSaving-style single tag: exactly one of post/comment/mobile, or null when blank/absent.
function readAccountTag(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('tag must be a string', 'bad_tag');
  const v = value.trim().toLowerCase();
  if (!ACCOUNT_TAGS.includes(v)) throw badRequest(`tag must be one of ${ACCOUNT_TAGS.join(', ')}`, 'bad_tag');
  return v;
}

// Non-secret login email LABEL (never a password). Loose sanity check only; null when blank/absent.
function readAccountEmail(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('email must be a string', 'bad_email');
  const v = value.trim();
  if (v === '') return null;
  if (v.length > 200 || /[\x00-\x1f\x7f]/.test(v) || !/^[^@\s]+@[^@\s]+$/.test(v)) {
    throw badRequest('email is invalid', 'bad_email');
  }
  return v;
}
function readPreferredAgentId(value) {
  if (value == null || value === '') return null;
  return assertIdentifier('preferred_agent_id', value, { maxLen: 120 });
}

// Build the metadata set for a create. All fields optional; identity (uid/platform) handled by caller.
function readAccountMetadataForCreate(body) {
  return {
    display_label: optAccountText('display_label', body.display_label, { maxLen: 120 }),
    notes: optAccountText('notes', body.notes, { maxLen: 500, allowNewlines: true }),
    tags: validateTagsInput(body.tags) ?? null,
    tag: readAccountTag(body.tag),
    page_label: optAccountText('page_label', body.page_label, { maxLen: 120 }),
    account_role: readAccountRole(body.account_role),
    homepage_url: optAccountText('homepage_url', body.homepage_url, { maxLen: 300 }),
    email: readAccountEmail(body.email),
    preferred_agent_id: readPreferredAgentId(body.preferred_agent_id)
  };
}

// Build a sparse patch for an update: only keys actually present in the body are included, so a PATCH
// never clobbers an unmentioned field. Identity columns (account_uid/platform) are immutable here.
function readAccountMetadataForPatch(body) {
  const patch = {};
  if ('display_label' in body) patch.display_label = optAccountText('display_label', body.display_label, { maxLen: 120 });
  if ('notes' in body) patch.notes = optAccountText('notes', body.notes, { maxLen: 500, allowNewlines: true });
  if ('tags' in body) patch.tags = validateTagsInput(body.tags) ?? null;
  if ('tag' in body) patch.tag = readAccountTag(body.tag);
  if ('page_label' in body) patch.page_label = optAccountText('page_label', body.page_label, { maxLen: 120 });
  if ('account_role' in body) patch.account_role = readAccountRole(body.account_role);
  if ('homepage_url' in body) patch.homepage_url = optAccountText('homepage_url', body.homepage_url, { maxLen: 300 });
  if ('email' in body) patch.email = readAccountEmail(body.email);
  if ('preferred_agent_id' in body) patch.preferred_agent_id = readPreferredAgentId(body.preferred_agent_id);
  const status = normalizeAccountStatus(body.status);
  if (status !== undefined) patch.status = status;
  return patch;
}

// Pull platform from query (?platform=) defaulting to facebook for the role/binding endpoints.
function platformFromQuery(url, fallback = 'facebook') {
  const raw = url.searchParams.get('platform');
  return assertPlatform(raw || fallback);
}

export function createStore(env, opts = {}) {
  if (!env || !env.DB) throw new HttpError('DB binding missing', 500, 'no_db');
  // PROFILE_ARCHIVES = sealed profile archives; ACCOUNT_AVATARS = avatar images. The credential-key
  // provider seals/opens the AES-GCM credential vault (dedicated ACCOUNTS_BRIDGE_SECRETS_KEY preferred,
  // else derived from ACCOUNTS_BRIDGE_API_KEY). All optional — only the matching routes require them.
  return new AccountsStore(env.DB, {
    bucket: env.PROFILE_ARCHIVES,
    avatarBucket: env.ACCOUNT_AVATARS,
    getCredentialKey: () => getCredentialKey(env),
    ...opts
  });
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

    // --- accounts (real Cloud Account Manager CRUD; non-secret metadata only) ---
    if (path === '/v1/accounts' && method === 'GET') {
      const platform = url.searchParams.get('platform');
      if (platform) assertPlatform(platform);
      const includeArchived = ['1', 'true', 'yes'].includes(String(url.searchParams.get('include_archived') || '').toLowerCase());
      return json({ accounts: await store.listAccounts(platform || undefined, { includeArchived }) });
    }
    if (path === '/v1/accounts' && method === 'POST') {
      const body = await readJson(request);
      // Refuse a secret-shaped field BEFORE creating anything, and audit the rejection.
      try {
        assertNoSecretAccountFields(body);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'secret_field_rejected') {
          await store.insertAudit({ event_type: 'account.rejected_secret_field', source: 'api' });
        }
        throw err;
      }
      const platform = assertPlatform(body.platform);
      const accountUid = assertAccountUid(body.account_uid);
      const status = normalizeAccountStatus(body.status) ?? 'active';
      const meta = readAccountMetadataForCreate(body);
      const { account, created } = await store.createAccount({ account_uid: accountUid, platform, status, ...meta });
      await store.insertAudit({ event_type: created ? 'account.created' : 'account.exists', account_uid: accountUid, platform, source: 'api' });
      return json({ account, created }, created ? 201 : 200);
    }

    // Single account: read / update mutable metadata / soft-archive.
    const accountMatch = path.match(/^\/v1\/accounts\/([a-z]+)\/([^/]+)$/);
    if (accountMatch) {
      const platform = assertPlatform(accountMatch[1]);
      const accountUid = assertAccountUid(decodeURIComponent(accountMatch[2]));
      if (method === 'GET') {
        const account = await store.publicAccount(platform, accountUid);
        if (!account) return json({ ok: false, error: 'account_not_found' }, 404);
        return json({ account });
      }
      if (method === 'PATCH') {
        const body = await readJson(request);
        try {
          assertNoSecretAccountFields(body);
        } catch (err) {
          if (err instanceof HttpError && err.code === 'secret_field_rejected') {
            await store.insertAudit({ event_type: 'account.rejected_secret_field', account_uid: accountUid, platform, source: 'api' });
          }
          throw err;
        }
        const patch = readAccountMetadataForPatch(body);
        const account = await store.updateAccount(platform, accountUid, patch);
        if (!account) return json({ ok: false, error: 'account_not_found' }, 404);
        await store.insertAudit({
          event_type: account.status === 'archived' ? 'account.archived' : 'account.updated',
          account_uid: accountUid,
          platform,
          source: 'api'
        });
        return json({ account });
      }
      if (method === 'DELETE') {
        // Soft archive by default — never deletes the account row or any profile/session/cookie bytes.
        const account = await store.archiveAccount(platform, accountUid);
        if (!account) return json({ ok: false, error: 'account_not_found' }, 404);
        await store.insertAudit({ event_type: 'account.archived', account_uid: accountUid, platform, source: 'api' });
        return json({ account, archived: true });
      }
    }

    // --- account credential vault (WRITE-ONLY; AES-GCM at rest; presence flags ONLY ever returned) ---
    // The sensitive profile fields (password / datr_cookie / totp_secret / proxy_url) are sealed into a
    // separate encrypted table. A blank/absent field is left untouched ("leave blank to keep existing");
    // a `clear_<field>: true` flag removes it. The response is presence booleans + a host-only proxy
    // hint — a raw secret value is NEVER returned by any method here.
    const credMatch = path.match(/^\/v1\/accounts\/([a-z]+)\/([^/]+)\/credentials$/);
    if (credMatch && method === 'PUT') {
      const platform = assertPlatform(credMatch[1]);
      const accountUid = assertAccountUid(decodeURIComponent(credMatch[2]));
      if (!(await store.getAccount(platform, accountUid))) {
        return json({ ok: false, error: 'account_not_found' }, 404);
      }
      const body = await readJson(request);
      const updates = {};
      const clears = new Set();
      for (const f of CREDENTIAL_FIELD_NAMES) {
        if (body[`clear_${f}`] === true) clears.add(f);
        if (f in body) {
          const raw = body[f];
          if (raw == null || (typeof raw === 'string' && raw.trim() === '')) continue; // blank → keep existing
          if (typeof raw !== 'string') throw badRequest(`${f} must be a string`, 'bad_credential');
          const v = raw.trim();
          if (v.length > 8192) throw badRequest(`${f} is too long`, 'bad_credential');
          updates[f] = v;
        }
      }
      let presence;
      try {
        presence = await store.putCredentials(platform, accountUid, { updates, clears });
      } catch (err) {
        if (err && err.code === 'credential_key_unconfigured') {
          throw new HttpError('Credential vault key is not configured', 503, 'credential_vault_unconfigured');
        }
        throw err;
      }
      await store.insertAudit({
        event_type: 'account.credentials_updated',
        account_uid: accountUid,
        platform,
        source: 'api',
        detail: { set: Object.keys(updates), cleared: [...clears] }
      });
      return json({ platform, account_uid: accountUid, ...presence });
    }

    // --- account avatar (image bytes in R2; non-secret) ---
    const avatarMatch = path.match(/^\/v1\/accounts\/([a-z]+)\/([^/]+)\/avatar$/);
    if (avatarMatch) {
      const platform = assertPlatform(avatarMatch[1]);
      const accountUid = assertAccountUid(decodeURIComponent(avatarMatch[2]));
      if (method === 'GET') {
        const { mime, object } = await store.getAvatarBytes(platform, accountUid);
        if (!object) return json({ ok: false, error: 'avatar_not_found' }, 404);
        return new Response(object.body, {
          status: 200,
          headers: { 'content-type': mime, 'cache-control': 'private, max-age=300' }
        });
      }
      if (method === 'POST' || method === 'PUT') {
        if (!(await store.getAccount(platform, accountUid))) {
          throw new HttpError(`Account not found: ${redact(accountUid)}`, 422, 'account_not_found');
        }
        const { bytes, mime } = await readAvatarUpload(request);
        const account = await store.putAvatar(platform, accountUid, bytes, mime);
        await store.insertAudit({ event_type: 'account.avatar_updated', account_uid: accountUid, platform, source: 'api', detail: { mime, byte_size: bytes.byteLength } });
        return json({ account });
      }
      if (method === 'DELETE') {
        const account = await store.deleteAvatar(platform, accountUid);
        if (!account) return json({ ok: false, error: 'account_not_found' }, 404);
        await store.insertAudit({ event_type: 'account.avatar_removed', account_uid: accountUid, platform, source: 'api' });
        return json({ account });
      }
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
