// AES-GCM credential vault for Accounts Bridge v2.
//
// The sensitive profile fields (password, datr_cookie, totp_secret, proxy_url) are JSON-encoded and
// sealed into ONE opaque ciphertext blob per account. This module is the ONLY place that holds the
// key or sees plaintext; callers above it receive presence booleans and a credential-free proxy hint.
//
// KEY: a dedicated `ACCOUNTS_BRIDGE_SECRETS_KEY` env is PREFERRED. When it is absent we derive a key
// from the existing `ACCOUNTS_BRIDGE_API_KEY` so a deployment can work without extra setup — both are
// run through SHA-256 to a fixed 32-byte AES-GCM key. key_version records which source sealed a blob.
//
// FORMAT: base64( iv[12] ‖ AES-GCM-ciphertext ). A fresh random IV is generated per write.
//
// Runs identically on Workers and `node --test` — depends only on Web globals (crypto.subtle, atob,
// btoa, TextEncoder/TextDecoder), no Node-only or Worker-only API.

const CREDENTIAL_FIELDS = Object.freeze(['password', 'datr_cookie', 'totp_secret', 'proxy_url']);
const IV_BYTES = 12;

export { CREDENTIAL_FIELDS };

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

// Resolve the AES-GCM key + its provenance label from env. PREFERS ACCOUNTS_BRIDGE_SECRETS_KEY; falls
// back to deriving from ACCOUNTS_BRIDGE_API_KEY. Throws when neither is configured (fail closed — we
// never store credentials under a guessable/empty key).
export async function getCredentialKey(env) {
  const dedicated = typeof env.ACCOUNTS_BRIDGE_SECRETS_KEY === 'string' ? env.ACCOUNTS_BRIDGE_SECRETS_KEY.trim() : '';
  const apiKey = typeof env.ACCOUNTS_BRIDGE_API_KEY === 'string' ? env.ACCOUNTS_BRIDGE_API_KEY.trim() : '';
  const material = dedicated || apiKey;
  if (!material) {
    const err = new Error('No credential key material configured');
    err.code = 'credential_key_unconfigured';
    throw err;
  }
  const keyVersion = dedicated ? 'secrets-v1' : 'apikey-v1';
  const raw = await sha256Bytes(`accounts-bridge:credentials:${keyVersion}:${material}`);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, keyVersion };
}

// Seal a plain object ({field: value}) into base64(iv ‖ ciphertext). Returns null for an empty object
// so an all-cleared credential row stores no blob at all.
export async function sealCredentials(key, plainObject) {
  const keys = Object.keys(plainObject || {});
  if (keys.length === 0) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(plainObject));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const cipher = new Uint8Array(cipherBuf);
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

// Open a base64(iv ‖ ciphertext) blob back to its plain object. Returns {} on any failure (missing
// blob, wrong key after a key rotation, corruption) so a partial-update merge degrades to "start
// fresh" rather than throwing — the operator simply re-enters the fields. NEVER surfaced to a client.
export async function openCredentials(key, blobB64) {
  if (typeof blobB64 !== 'string' || blobB64.trim() === '') return {};
  try {
    const packed = base64ToBytes(blobB64);
    if (packed.length <= IV_BYTES) return {};
    const iv = packed.slice(0, IV_BYTES);
    const cipher = packed.slice(IV_BYTES);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Reduce a proxy URL to a credential-free host:port hint that is SAFE to display/return. Strips any
// scheme credentials (user:pass@) and anything past host:port so a proxy password can never leak.
// Examples:
//   socks5://user:pass@1.2.3.4:1080  -> socks5://1.2.3.4:1080
//   1.2.3.4:8000:user:pass           -> 1.2.3.4:8000
//   host.example.com:3128            -> host.example.com:3128
export function proxyHostHint(proxyUrl) {
  if (typeof proxyUrl !== 'string') return null;
  let s = proxyUrl.trim();
  if (!s) return null;
  let scheme = '';
  const schemeMatch = s.match(/^([a-z0-9]+):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    s = s.slice(schemeMatch[0].length);
  }
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const parts = s.split(':');
  const host = (parts[0] || '').replace(/[^A-Za-z0-9.\-]/g, '').slice(0, 100);
  if (!host) return null;
  const port = parts[1] && /^[0-9]{1,5}$/.test(parts[1]) ? parts[1] : null;
  const hostport = port ? `${host}:${port}` : host;
  return scheme ? `${scheme}://${hostport}` : hostport;
}

// Validate raw image bytes by signature (authoritative — we never trust a client-claimed MIME). Returns
// the canonical MIME for png/jpeg/webp, or null when the bytes are not one of the allowed image types.
export function detectImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}
