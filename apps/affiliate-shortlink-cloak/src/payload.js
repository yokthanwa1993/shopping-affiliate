'use strict';

const {
  normalizeShopeeOriginalLink,
  normalizeLazadaOriginalLink,
  normalizeAffiliateId,
} = require('./normalize');

function buildShopeeShortlinkPayload(params) {
  const link = String(params.link || '').trim();
  const longLink = String(params.longLink || '').trim() || link;
  const originalLink = normalizeShopeeOriginalLink(longLink) || longLink || link;
  const id = normalizeAffiliateId(params.id || params.utmSource || '');

  let utmContent = '';
  try {
    const parsed = new URL(longLink.includes('://') ? longLink : `https://${longLink}`);
    utmContent = parsed.searchParams.get('utm_content') || '';
  } catch {}
  const subParts = utmContent.split('-');
  const sub1 = String(subParts[0] || '').trim() || '';
  const sub2 = String(subParts[1] || '').trim() || '';
  const sub3 = String(subParts[2] || '').trim() || '';
  const sub4 = String(subParts[3] || '').trim() || '';
  const sub5 = String(subParts[4] || '').trim() || '';

  return {
    link,
    longLink,
    originalLink,
    shortLink: String(params.shortLink || '').trim(),
    id,
    utm_source: String(params.utmSource || '').trim(),
    utm_content: utmContent,
    account: String(params.account || '').trim(),
    sub1,
    sub2,
    sub3,
    sub4,
    sub5,
  };
}

function buildLazadaShortlinkPayload(params) {
  const link = String(params.link || '').trim();
  const longLink = String(params.longLink || '').trim() || link;
  const originalLink = normalizeLazadaOriginalLink(longLink) || longLink || link;
  const id = normalizeAffiliateId(params.id || params.memberId || '');
  return {
    link,
    longLink,
    originalLink,
    shortLink: String(params.shortLink || '').trim(),
    id,
    member_id: params.memberId == null ? null : params.memberId,
    promotionCode: String(params.promotionCode || '').trim(),
    account: String(params.account || '').trim(),
    sub1: String(params.sub1 || '').trim(),
  };
}

module.exports = {
  buildShopeeShortlinkPayload,
  buildLazadaShortlinkPayload,
};
