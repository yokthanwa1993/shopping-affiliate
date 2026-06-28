// Accounts Bridge v2 — local profile-archive helper (download-before-open / upload-after-close).
//
// This is the LOCAL side of the sealed profile-archive sync. It mirrors BrowserSaving's
// compress-on-close / restore-on-open behaviour (apps/browsersaving/launcher/index.js), with one
// critical difference: the archive bytes are SEALED LOCALLY before they ever leave the device, and
// the Worker stores only opaque ciphertext. The Worker never parses cookies/tokens/datr/passwords
// from the archive — it has no key and never decrypts.
//
// SECURITY CONTRACT
//   * Key material is INJECTED (`seal`/`open` callbacks), never hard-coded or read from the repo.
//     The operator app supplies an AES-GCM seal/open backed by the macOS Keychain.
//   * `buildArchiveManifest` is an ALLOWLIST: only `ESSENTIAL_PROFILE_PATHS` are ever collected, and
//     absolute paths / `..` traversal are refused — a malicious or corrupt profile dir cannot widen
//     the capture surface.
//   * The sealed upload begins with the ABENC1 magic so the Worker can prove it is ciphertext, not a
//     raw tar.gz. Must stay byte-identical to the Worker's `ARCHIVE_MAGIC` and Swift `archiveMagic`.

import { Buffer } from 'node:buffer';

// Essential Chrome/Chromium profile paths (relative to the profile dir) — the same surface
// BrowserSaving captures. The Worker never sees these names, only the sealed bytes.
export const ESSENTIAL_PROFILE_PATHS = Object.freeze([
  'Cookies',
  'Cookies-journal',
  'Login Data',
  'Login Data-journal',
  'Web Data',
  'Web Data-journal',
  'History',
  'Preferences',
  'Secure Preferences',
  'Network/Cookies',
  'Network/Network Persistent State',
  'Network/Trust Tokens',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Service Worker',
  'Local Extension Settings',
  'Sync Data'
]);

// `Local State` lives at the user-data-dir ROOT (one level above the profile dir).
export const USER_DATA_ROOT_PATHS = Object.freeze(['Local State']);

// ASCII envelope magic "ABENC1" — identical to the Worker's ARCHIVE_MAGIC and Swift archiveMagic.
export const ARCHIVE_MAGIC = Buffer.from('ABENC1', 'ascii');

// A relative path is safe iff it is non-empty, not absolute, has no Windows drive prefix, and never
// escapes the profile dir via `..`. Used to keep the capture surface to the allowlist only.
export function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split(/[/\\]+/);
  return !parts.includes('..') && !parts.includes('');
}

// Build the list of essential paths to archive. `exists(rel)` is injected (real fs or a test stub) so
// this stays pure/testable. Returns { included, missing, rejected } — `rejected` flags any allowlist
// entry that somehow fails the safety check (defence in depth; should always be empty).
export function buildArchiveManifest({ exists, paths = ESSENTIAL_PROFILE_PATHS } = {}) {
  if (typeof exists !== 'function') throw new Error('buildArchiveManifest requires an exists(rel) callback');
  const included = [];
  const missing = [];
  const rejected = [];
  for (const rel of paths) {
    if (!isSafeRelativePath(rel)) {
      rejected.push(rel);
      continue;
    }
    if (exists(rel)) included.push(rel);
    else missing.push(rel);
  }
  return { included, missing, rejected };
}

// Wrap already-sealed AES-GCM ciphertext in the ABENC1 envelope. `seal(plaintext) -> Buffer` is
// injected (Keychain-backed AES-GCM in production). Plaintext (the tar.gz bytes) never leaves here.
export function sealArchiveEnvelope(tarGzBytes, seal) {
  if (typeof seal !== 'function') throw new Error('sealArchiveEnvelope requires a seal(bytes) callback');
  const ciphertext = seal(Buffer.from(tarGzBytes));
  return Buffer.concat([ARCHIVE_MAGIC, Buffer.from(ciphertext)]);
}

// Inverse of sealArchiveEnvelope: strip the magic and unseal. `open(ciphertext) -> Buffer` injected.
export function unsealArchiveEnvelope(envelope, open) {
  if (typeof open !== 'function') throw new Error('unsealArchiveEnvelope requires an open(bytes) callback');
  const buf = Buffer.from(envelope);
  if (buf.length <= ARCHIVE_MAGIC.length || !buf.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    throw new Error('not an ABENC1 sealed archive');
  }
  return Buffer.from(open(buf.subarray(ARCHIVE_MAGIC.length)));
}

// Token-free HTTP client for the three profile-archive routes. `fetchImpl` defaults to global fetch.
export class ProfileArchiveClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    if (!baseUrl || !apiKey) throw new Error('ProfileArchiveClient requires baseUrl + apiKey');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  _url({ platform, role, accountUid, action, query }) {
    const base = `${this.baseUrl}/v1/profile-archives/${platform}/${role}/${encodeURIComponent(accountUid)}/${action}`;
    return query ? `${base}?${query}` : base;
  }

  async status({ platform = 'facebook', role, accountUid }) {
    const res = await this.fetchImpl(this._url({ platform, role, accountUid, action: 'status' }), {
      headers: { 'x-accounts-bridge-key': this.apiKey }
    });
    if (!res.ok) throw new Error(`status failed: ${res.status}`);
    return res.json();
  }

  // Restore-before-open: returns the sealed envelope bytes (Buffer) or null when none exists yet.
  async download({ platform = 'facebook', role, accountUid }) {
    const res = await this.fetchImpl(this._url({ platform, role, accountUid, action: 'download' }), {
      headers: { 'x-accounts-bridge-key': this.apiKey }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Save-on-close: upload the sealed envelope bytes. Returns the metadata-only response.
  async upload({ platform = 'facebook', role, accountUid, version, source, cipher = 'aesgcm', sealedEnvelope }) {
    const query = new URLSearchParams({ version, source, cipher }).toString();
    const res = await this.fetchImpl(this._url({ platform, role, accountUid, action: 'upload', query }), {
      method: 'POST',
      headers: { 'x-accounts-bridge-key': this.apiKey, 'content-type': 'application/octet-stream' },
      body: sealedEnvelope
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return res.json();
  }
}
