'use strict';
function tokenPrefix(token) { return token ? String(token).slice(0, 6) : ''; }
function redactToken(token) { return token ? `${tokenPrefix(token)}…[REDACTED]` : '[NO TOKEN]'; }
function sanitizeUrlSecrets(input) {
  if (!input || typeof input !== 'string') return input;
  return input
    .replace(/([?#&]access_token=)[^&#\s]+/ig, '$1[REDACTED]')
    .replace(/([?#&]token=)[^&#\s]+/ig, '$1[REDACTED]')
    .replace(/([?#&]code=)[^&#\s]+/ig, '$1[REDACTED]');
}
function redactObjectSecrets(value) {
  if (Array.isArray(value)) return value.map(redactObjectSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k,v] of Object.entries(value)) {
    out[k] = /(token|password|secret|cookie|authorization)/i.test(k) ? '[REDACTED]' : redactObjectSecrets(v);
  }
  return out;
}
module.exports = { tokenPrefix, redactToken, sanitizeUrlSecrets, redactObjectSecrets };
