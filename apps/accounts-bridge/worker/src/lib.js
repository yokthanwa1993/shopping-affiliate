// Shared, runtime-agnostic helpers for Accounts Bridge v2.
//
// These run identically on the Cloudflare Workers runtime and under `node --test`. They depend only
// on the WHATWG/Web globals present in both: `crypto.subtle`, `crypto.randomUUID`, `TextEncoder`,
// `Response`. No Node-only or Worker-only API is used here.

export const SERVICE = 'accounts-bridge';
export const API_VERSION = 'v1';

export const PLATFORMS = Object.freeze(['facebook', 'shopee']);
export const ROLES = Object.freeze(['page_posting_facebook_lite', 'ads_power_editor']);
export const ROLE_LABELS = Object.freeze({
  page_posting_facebook_lite: 'Facebook Lite — Page posting / Token Bridge',
  ads_power_editor: 'Power Editor — Ad creation'
});

// The role each surface is allowed to use. Page posting is Facebook Lite / Token Bridge ONLY; ad
// creation is Power Editor ONLY. Encoded so the binding layer can reject role/surface drift.
export const SURFACE_ROLE = Object.freeze({
  page_posting: 'page_posting_facebook_lite',
  ads: 'ads_power_editor'
});

// BrowserSaving-style single profile tag. Exactly one of these (or null) per account.
export const ACCOUNT_TAGS = Object.freeze(['post', 'comment', 'mobile']);

// Avatar upload limits. Bytes are stored in R2; only png/jpeg/webp by SIGNATURE are accepted.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // ~2MB
export const AVATAR_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

// The write-only credential fields the vault accepts. NEVER returned by any GET.
export const CREDENTIAL_FIELD_NAMES = Object.freeze(['password', 'datr_cookie', 'totp_secret', 'proxy_url']);

// Agent command-queue vocabulary. Actions are the MVP set the local Mac agent understands; statuses
// walk a fixed lifecycle (queued -> running -> terminal). Agent heartbeat statuses are a small set.
export const COMMAND_ACTIONS = Object.freeze(['open_profile', 'close_profile', 'sync_accounts', 'status']);
export const COMMAND_TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);
export const AGENT_STATUSES = Object.freeze(['online', 'idle', 'busy', 'error', 'offline']);

// A request error carrying an HTTP status. Thrown by validators, caught by the router.
export class HttpError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}

export function badRequest(message, code) {
  return new HttpError(message, 400, code);
}

// Plaintext-secret tripwire. The *_blob fields must already be ciphertext: callers encrypt locally
// (or via a Worker secret key) before POSTing. We refuse anything that looks like a raw Facebook
// token, fb_dtsg, datr cookie, or a Set-Cookie/JSON session dump so a plaintext secret can never
// land in the DB even by mistake. Fake ciphertext used in tests passes (it matches none of these).
const PLAINTEXT_SECRET_RE = /\bEAA[A-Za-z0-9]{6,}|fb_dtsg|c_user=|xs=|datr=|"access_token"|sb=/i;

export function assertEncryptedBlob(value, field = 'encrypted_blob') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} must be a non-empty ciphertext string`, 'blob_required');
  }
  if (PLAINTEXT_SECRET_RE.test(value)) {
    // Never echo the offending value; report the field only.
    throw badRequest(`${field} looks like a plaintext secret — store ciphertext only`, 'blob_not_encrypted');
  }
  return value;
}

// Secret-shaped KEY names. A command payload/result is non-secret provenance only; any key whose
// name suggests a credential is refused so a token/cookie/password can never ride along even by
// mistake. Boolean readiness flags (…Present) are allowed by callers BEFORE reaching this check.
const SECRET_KEY_RE = /password|token|cookie|secret|datr|fb_dtsg|dtsg|totp|otp|2fa|authorization|encrypted_blob|access_token|c_user/i;

// Reject a payload/result object that names a secret-shaped key, OR whose serialized values look
// like a raw secret (reuses the plaintext-secret tripwire). Returns the object on success (or null).
export function assertNoSecretMaterial(value, field = 'payload') {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${field} must be a JSON object`, `bad_${field}`);
  }
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, nested] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (SECRET_KEY_RE.test(key)) throw badRequest(`Forbidden ${field} field: ${path}`, 'forbidden_field');
      walk(nested, path);
    }
  };
  walk(value, '');
  // Value-shape tripwire: even with safe key names, refuse a raw token/cookie/datr value.
  if (PLAINTEXT_SECRET_RE.test(JSON.stringify(value))) {
    throw badRequest(`${field} contains a value that looks like a plaintext secret`, 'forbidden_value');
  }
  return value;
}

// A safe, bounded error string for the command queue: control-chars stripped, secret-shaped content
// removed, and truncated. Never echoes a raw token/cookie even if an agent reports one by mistake.
export function sanitizeErrorMessage(value, maxLen = 240) {
  if (value == null) return null;
  let s = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (s === '') return null;
  if (PLAINTEXT_SECRET_RE.test(s)) s = '[redacted]';
  return s.slice(0, maxLen);
}

// Non-secret SHA-256 digest of a blob, so callers can compare versions without seeing plaintext.
export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Non-secret SHA-256 digest of raw bytes (encrypted profile archive). Same hex format as sha256Hex.
export async function sha256HexBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Sealed-archive envelope magic. The local app prepends these ASCII bytes ("ABENC1") to the AES-GCM
// ciphertext so the Worker can prove an upload is sealed ciphertext — not a raw tar.gz/zip from which
// cookies/tokens could be parsed. The Worker has no key and never decrypts; it only checks the shape.
export const ARCHIVE_MAGIC = new Uint8Array([0x41, 0x42, 0x45, 0x4e, 0x43, 0x31]); // "ABENC1"
export const ARCHIVE_MAGIC_TEXT = 'ABENC1';
// AES-GCM minimum overhead past the magic: 12-byte nonce + 16-byte tag.
const ARCHIVE_MIN_OVERHEAD = 12 + 16;

function startsWith(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

// Tripwire for the binary archive path: refuse anything that is NOT our local-sealed envelope, and
// explicitly refuse the common UNencrypted archive magics (gzip / zip) so a raw browser-data archive
// can never be stored even by mistake. Returns the byte view on success.
export function assertEncryptedArchive(value, field = 'archive') {
  const bytes = value instanceof Uint8Array ? value : value ? new Uint8Array(value) : null;
  if (!bytes || bytes.byteLength === 0) {
    throw badRequest(`${field} must be non-empty sealed-archive bytes`, 'archive_required');
  }
  // gzip (1f 8b) / zip (PK\x03\x04) — the shapes BrowserSaving uploads RAW. We refuse them: only a
  // locally-sealed ABENC1 envelope is acceptable here.
  if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw badRequest(`${field} looks like an unencrypted archive — seal it locally first`, 'archive_not_encrypted');
  }
  if (!startsWith(bytes, ARCHIVE_MAGIC)) {
    throw badRequest(`${field} is missing the ${ARCHIVE_MAGIC_TEXT} sealed-envelope header`, 'archive_not_encrypted');
  }
  if (bytes.byteLength < ARCHIVE_MAGIC.byteLength + ARCHIVE_MIN_OVERHEAD) {
    throw badRequest(`${field} is too small to be a sealed archive`, 'archive_too_small');
  }
  return bytes;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(clock) {
  // `clock` lets tests inject deterministic timestamps; defaults to wall-clock at runtime.
  return (typeof clock === 'function' ? new Date(clock()) : new Date()).toISOString();
}

// Constant-time string compare. Avoids leaking the API key length/contents via early-exit timing.
// Implemented locally so it works on the bare Workers runtime without `nodejs_compat`.
export function timingSafeEqualStr(a, b) {
  const sa = typeof a === 'string' ? a : '';
  const sb = typeof b === 'string' ? b : '';
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw badRequest(`Unsupported platform: ${redact(platform)}`, 'bad_platform');
  }
  return platform;
}

export function assertRole(role) {
  if (!ROLES.includes(role)) {
    throw badRequest(`Unknown role: ${redact(role)}`, 'bad_role');
  }
  return role;
}

// A short, safe rendering of arbitrary caller input for error messages — never a secret blob.
export function redact(value) {
  if (typeof value !== 'string') return '<non-string>';
  const trimmed = value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40);
  return trimmed === '' ? '<empty>' : trimmed;
}

// A UID/page_id/section_key must be a short, printable, control-char-free token.
export function assertIdentifier(name, value, { maxLen = 64 } = {}) {
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`, 'bad_identifier');
  const trimmed = value.trim();
  if (trimmed === '') throw badRequest(`${name} is required`, 'bad_identifier');
  if (trimmed.length > maxLen) throw badRequest(`${name} is too long`, 'bad_identifier');
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw badRequest(`${name} has invalid characters`, 'bad_identifier');
  return trimmed;
}

// account_uid is the primary identity of an account and MUST be a real numeric platform UID:
// digits only, 5–32 chars. This is stricter than assertIdentifier (which allows any printable token)
// because the account identity is what every role/binding/session/archive is scoped to.
export function assertAccountUid(value, name = 'account_uid') {
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`, 'bad_account_uid');
  const trimmed = value.trim();
  if (!/^[0-9]{5,32}$/.test(trimmed)) {
    throw badRequest(`${name} must be 5–32 digits (numeric UID only)`, 'bad_account_uid');
  }
  return trimmed;
}

// Secret-shaped KEY names that may NEVER appear in an account create/update body. Account metadata is
// operator-facing, non-secret labels ONLY (notes/tags/page_label/role/status/preferred agent). Raw
// cookies, tokens, passwords, datr, fb_dtsg, localStorage, profile archives, or any session secret
// belong on the dedicated sealed routes — not in CRUD. Reject the whole request (400) if one appears.
const ACCOUNT_SECRET_FIELD_RE =
  /password|token|cookie|secret|datr|fb_dtsg|dtsg|localstorage|local_storage|session|proxy_password|access_token|c_user|\botp\b|totp|2fa|encrypted_blob/i;

// Walk every (possibly nested) key of an account CRUD body and refuse any secret-shaped field name.
// Returns the body on success. Throws HttpError(400, 'secret_field_rejected') with the offending path
// (the value is never echoed) so the caller can audit the rejection.
export function assertNoSecretAccountFields(body, field = 'account') {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return body;
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, nested] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (ACCOUNT_SECRET_FIELD_RE.test(key)) {
        throw new HttpError(`Secret-shaped ${field} field rejected: ${path}`, 400, 'secret_field_rejected');
      }
      walk(nested, path);
    }
  };
  walk(body, '');
  return body;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
