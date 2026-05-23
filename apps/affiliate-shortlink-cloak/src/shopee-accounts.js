'use strict';

const DEFAULT_SHOPEE_ID_TO_ACCOUNT = Object.freeze({
  '15142270000': 'affiliate_neezs.com',
});

function normalizeShopeeAffiliateId(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^an_/i, '');
  if (!raw) return '';
  const match = raw.match(/^(\d{6,})$/);
  return match ? match[1] : '';
}

function parseEnvMap(rawEnv) {
  const raw = String(rawEnv == null ? '' : rawEnv).trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    const id = normalizeShopeeAffiliateId(k);
    const account = String(v == null ? '' : v).trim();
    if (id && account) out[id] = account;
  }
  return out;
}

function resolveShopeeAccountFromId(rawId, { envValue = process.env.SHOPEE_ID_ACCOUNT_MAP } = {}) {
  const id = normalizeShopeeAffiliateId(rawId);
  if (!id) return '';
  const envMap = parseEnvMap(envValue);
  if (Object.prototype.hasOwnProperty.call(envMap, id)) return envMap[id];
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SHOPEE_ID_TO_ACCOUNT, id)) {
    return DEFAULT_SHOPEE_ID_TO_ACCOUNT[id];
  }
  return '';
}

module.exports = {
  DEFAULT_SHOPEE_ID_TO_ACCOUNT,
  normalizeShopeeAffiliateId,
  parseEnvMap,
  resolveShopeeAccountFromId,
};
