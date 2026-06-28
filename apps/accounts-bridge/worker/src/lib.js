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

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}
