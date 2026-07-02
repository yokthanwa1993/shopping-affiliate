import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_FILENAME_LENGTH = 160;

/**
 * Reduce an arbitrary (possibly hostile) filename to a single safe path segment.
 * Strips directory separators, control chars, leading dots, and traversal tokens.
 */
export function sanitizeFilename(input) {
  const base = path.basename(String(input ?? '')); // drop any directory portion
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  let stem = base.slice(0, base.length - path.extname(base).length);

  stem = stem
    .normalize('NFKC')
    .replace(/[\x00-\x1f\x7f]/g, '') // control chars
    .replace(/[/\\]/g, '_') // separators
    .replace(/\.{2,}/g, '') // kill any run of dots (traversal tokens)
    .replace(/[^\w.\-]+/g, '_') // anything not word/dot/dash -> _
    .replace(/^\.+/, '') // no leading dots (hidden files)
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (!stem) stem = 'file';
  const safe = `${stem}${ext}`.slice(0, MAX_FILENAME_LENGTH);
  return safe || 'file';
}

/** Same sanitizer applied to the attachment id so it is always a safe segment. */
function sanitizeId(id) {
  const clean = String(id ?? '').replace(/[^\w-]/g, '');
  return clean || 'unknown';
}

/**
 * Deterministic local path for an attachment: <root>/<yyyy>/<mm>/<id>_<safeFilename>.
 * `when` is the message/attachment timestamp (Date or ISO string); defaults to epoch-safe.
 */
export function localPathFor(mediaRoot, attachmentId, filename, when) {
  const date = when ? new Date(when) : new Date(0);
  const safeDate = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const yyyy = String(safeDate.getUTCFullYear()).padStart(4, '0');
  const mm = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
  const name = `${sanitizeId(attachmentId)}_${sanitizeFilename(filename)}`;

  const root = path.resolve(mediaRoot);
  const full = path.resolve(root, yyyy, mm, name);

  // Defense in depth: the computed path must stay under mediaRoot.
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Refusing to write outside MEDIA_ROOT');
  }
  return full;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Write a buffer to an absolute path, creating parent dirs. */
export async function writeBuffer(fullPath, buffer) {
  await ensureDir(path.dirname(fullPath));
  await fsp.writeFile(fullPath, buffer);
  return fullPath;
}

/**
 * Download a URL to a local path. Skips the fetch if the file already exists
 * with a non-zero size (idempotent sync). Returns { path, bytes, skipped }.
 */
export async function downloadTo(url, fullPath) {
  try {
    const stat = await fsp.stat(fullPath);
    if (stat.isFile() && stat.size > 0) {
      return { path: fullPath, bytes: stat.size, skipped: true };
    }
  } catch {
    // not present yet — fall through and download
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeBuffer(fullPath, buffer);
  return { path: fullPath, bytes: buffer.length, skipped: false };
}

export function fileExists(fullPath) {
  try {
    return fs.statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

export { fs, fsp };
