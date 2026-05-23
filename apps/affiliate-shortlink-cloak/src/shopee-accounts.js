'use strict';

const { sanitizeAccount } = require('./accounts');

const DEFAULT_SHOPEE_ID_TO_ACCOUNT = Object.freeze({
  '15142270000': Object.freeze({
    id: '15142270000',
    account: 'affiliate_neezs.com',
    displayAccount: 'affiliate@neezs.com',
  }),
  '15130770000': Object.freeze({
    id: '15130770000',
    account: 'affiliate_neezs.com',
    displayAccount: 'affiliate@neezs.com',
  }),
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
    const meta = normalizeShopeeAccountMapping(id, v);
    if (meta) out[id] = meta;
  }
  return out;
}

function normalizeShopeeAccountMapping(id, value) {
  if (!id) return null;
  if (typeof value === 'string') {
    const rawAccount = value.trim();
    if (!rawAccount) return null;
    return {
      id,
      account: sanitizeAccount(rawAccount),
      displayAccount: rawAccount,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawAccount = String(value.account == null ? '' : value.account).trim();
  const rawDisplayAccount = String(value.displayAccount == null ? '' : value.displayAccount).trim();
  const accountSource = rawAccount || rawDisplayAccount;
  if (!accountSource) return null;
  return {
    id,
    account: sanitizeAccount(accountSource),
    displayAccount: rawDisplayAccount || rawAccount || sanitizeAccount(accountSource),
  };
}

function resolveShopeeAccountMetadataFromId(rawId, { envValue = process.env.SHOPEE_ID_ACCOUNT_MAP } = {}) {
  const id = normalizeShopeeAffiliateId(rawId);
  if (!id) return null;
  const envMap = parseEnvMap(envValue);
  if (Object.prototype.hasOwnProperty.call(envMap, id)) return envMap[id];
  if (Object.prototype.hasOwnProperty.call(DEFAULT_SHOPEE_ID_TO_ACCOUNT, id)) {
    return DEFAULT_SHOPEE_ID_TO_ACCOUNT[id];
  }
  return null;
}

function resolveShopeeAccountFromId(rawId, opts = {}) {
  const meta = resolveShopeeAccountMetadataFromId(rawId, opts);
  if (meta) {
    return meta.account;
  }
  return '';
}

module.exports = {
  DEFAULT_SHOPEE_ID_TO_ACCOUNT,
  normalizeShopeeAffiliateId,
  parseEnvMap,
  resolveShopeeAccountMetadataFromId,
  resolveShopeeAccountFromId,
};
