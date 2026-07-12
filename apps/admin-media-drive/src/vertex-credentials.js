import { fsp } from './storage.js';

// A real Google service-account key file is a few KB; the ceiling only needs
// to be generous enough for real keys while keeping the lazy per-job read
// bounded. Anything larger is not a credential file.
export const MAX_VERTEX_CREDENTIALS_BYTES = 64 * 1024;

const REQUIRED_STRING_FIELDS = ['client_email', 'private_key'];

// Fail-closed credential load error. The message is always exactly the
// machine-readable snake_case category (which db.markProcessingJobFailed
// adopts as error_category), so credential contents and paths can never leak
// through job rows, worker logs, or MCP output.
export class VertexCredentialsError extends Error {
  constructor(category) {
    super(category);
    this.name = 'VertexCredentialsError';
    this.category = category;
  }
}

function fail(category) {
  throw new VertexCredentialsError(category);
}

/**
 * Read + validate the Vertex service-account JSON at `credentialsPath`
 * (GOOGLE_APPLICATION_CREDENTIALS). Returns the serialized credential for the
 * merge-rust `vertex_tts_service_account_json` request field plus the
 * embedded project id. The return value must never be logged, stored, or
 * surfaced anywhere except the loopback merge-rust /pipeline request body.
 */
export async function loadVertexServiceAccount(credentialsPath, { maxBytes = MAX_VERTEX_CREDENTIALS_BYTES } = {}) {
  const filePath = String(credentialsPath || '').trim();
  if (!filePath) fail('vertex_credentials_not_configured');

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'vertex_credentials_missing' : 'vertex_credentials_unreadable');
  }
  if (!stat.isFile()) fail('vertex_credentials_not_a_file');
  if (stat.size > maxBytes) fail('vertex_credentials_too_large');

  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    fail('vertex_credentials_unreadable');
  }
  // The file could have grown between stat and read; the bound is a hard one.
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) fail('vertex_credentials_too_large');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('vertex_credentials_invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('vertex_credentials_invalid_json');
  }
  if (parsed.type !== 'service_account') fail('vertex_credentials_invalid_shape');
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      fail('vertex_credentials_invalid_shape');
    }
  }

  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  return {
    serviceAccountJson: JSON.stringify(parsed),
    projectId,
  };
}
