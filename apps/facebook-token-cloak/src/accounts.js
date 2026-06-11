'use strict';

function sanitizeAccount(raw) {
  if (typeof raw !== 'string') throw Object.assign(new Error('Invalid account'), { status: 400 });
  if (/[\x00-\x1f\x7f]/.test(raw)) throw Object.assign(new Error('Invalid account'), { status: 400 });
  const trimmed = raw.trim();
  if (!trimmed) throw Object.assign(new Error('Invalid account'), { status: 400 });
  if (/[\\/]/.test(trimmed) || trimmed.includes('..')) throw Object.assign(new Error('Invalid account'), { status: 400 });
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) throw Object.assign(new Error('Invalid account'), { status: 400 });
  return { key: trimmed.toLowerCase(), display: trimmed.toUpperCase() };
}
module.exports = { sanitizeAccount };
