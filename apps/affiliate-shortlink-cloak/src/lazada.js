'use strict';

const fs = require('fs');
const path = require('path');
const { getPage, ensureOnPlatformPage } = require('./browser');
const {
  MAX_SHORTEN_ATTEMPTS,
  BETWEEN_ATTEMPT_DELAY_MS,
  SHORTEN_TIMEOUT_MS,
  LAZADA_URL,
} = require('./config');

const LAZADA_JS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'affiliate-shortlink', 'lazada-shorten.js'),
  'utf8',
);

function isSessionLikelyExpired(err) {
  const msg = String((err && err.message) || err || '').toUpperCase();
  if (/SESSION|TOKEN_EMPTY|TOKEN_EXPIRED|ILLEGAL_ACCESS|UNAUTHORIZED|LOGIN|CSRF|FAIL_SYS|401|403/.test(msg)) return true;
  if (/FAILED TO FETCH|NETWORKERROR|NETWORK ERROR|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|LOAD FAILED|ABORTED/.test(msg)) return true;
  return false;
}

async function shortenLazadaOnce(account, productUrl) {
  const { page } = await getPage('lazada', account, { headless: true });
  await ensureOnPlatformPage(page, 'lazada');

  const result = await page.evaluate(
    new Function('args', `const fn = (${LAZADA_JS}); return fn(args[0]);`),
    [productUrl],
  );

  if (!result) throw new Error('No result from Lazada');
  const retText = Array.isArray(result.ret) ? result.ret.join(', ') : '';
  if (retText && /SESSION|TOKEN_EMPTY|TOKEN_EXPIRED|ILLEGAL_ACCESS|FAIL_SYS/i.test(retText)) {
    throw new Error(retText);
  }
  let d = result;
  if (result.data && typeof result.data === 'object') {
    d = result.data.data || result.data;
  }
  if (!d || !d.promotionLink) {
    throw new Error(retText || 'No promotionLink: ' + JSON.stringify(result).substring(0, 200));
  }
  return d;
}

async function shortenLazada(account, productUrl, opts = {}) {
  const onSessionExpired = typeof opts.onSessionExpired === 'function' ? opts.onSessionExpired : null;
  let lastErr = null;
  let reauthAttempted = false;
  for (let attempt = 1; attempt <= MAX_SHORTEN_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(shortenLazadaOnce(account, productUrl), SHORTEN_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      const recoverable = isSessionLikelyExpired(err);
      console.warn(`[lazada:${account}] attempt ${attempt}/${MAX_SHORTEN_ATTEMPTS} failed (${recoverable ? 'recoverable' : 'fatal'}): ${err.message}`);
      if (!recoverable || attempt === MAX_SHORTEN_ATTEMPTS) break;
      await sleep(BETWEEN_ATTEMPT_DELAY_MS[attempt] || 3500);
      if (!reauthAttempted && onSessionExpired) {
        reauthAttempted = true;
        try {
          const reauth = await onSessionExpired({ platform: 'lazada', account, attempt, error: err });
          if (reauth && reauth.manualLoginRequired) {
            const blockErr = new Error('MANUAL_LOGIN_REQUIRED');
            blockErr.manualLoginRequired = true;
            blockErr.reason = reauth.reason || 'manual_login_required';
            throw blockErr;
          }
        } catch (reauthErr) {
          if (reauthErr && reauthErr.manualLoginRequired) throw reauthErr;
        }
      }
      try {
        const { page } = await getPage('lazada', account, { headless: true });
        await page.goto(LAZADA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {}
    }
  }
  throw lastErr;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  shortenLazada,
  isSessionLikelyExpired,
};
