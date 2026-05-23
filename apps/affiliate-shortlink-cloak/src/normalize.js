'use strict';

const { CHROME_UA } = require('./config');

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractOriginalLinkFromHtml(html) {
  const source = String(html || '');
  if (!source) return '';
  const patterns = [
    /<link[^>]+rel=["']origin["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const value = decodeHtmlEntities(match && match[1] ? match[1] : '').trim();
    if (value) return value;
  }
  return '';
}

async function resolveOriginalLink(inputUrl, fetchImpl = fetch) {
  const raw = String(inputUrl || '').trim();
  if (!raw) return '';
  try {
    const resp = await fetchImpl(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const finalUrl = String(resp.url || '').trim();
    const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const html = await resp.text();
      const extracted = extractOriginalLinkFromHtml(html);
      if (extracted) return extracted;
    }
    return finalUrl || raw;
  } catch {
    return raw;
  }
}

async function resolveRedirectUrl(inputUrl, fetchImpl = fetch) {
  const raw = String(inputUrl || '').trim();
  if (!raw) return '';
  try {
    const resp = await fetchImpl(raw, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    return String(resp.url || '').trim() || raw;
  } catch {
    return raw;
  }
}

async function resolveTrackingLink(inputUrl, fetchImpl = fetch) {
  const current = String(inputUrl || '').trim();
  if (!current) return '';
  const extracted = await resolveOriginalLink(current, fetchImpl);
  const candidate = extracted || current;
  const redirected = await resolveRedirectUrl(candidate, fetchImpl);
  return redirected || candidate || current;
}

function normalizeShopeeOriginalLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\/(?:universal-link\/)?product\/(\d+)\/(\d+)/i)
      || parsed.pathname.match(/\/opaanlp\/(\d+)\/(\d+)/i)
      || parsed.pathname.match(/-i[./](\d+)[./](\d+)/i);
    if (match) {
      return `https://shopee.co.th/product/${match[1]}/${match[2]}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

function normalizeLazadaOriginalLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

function normalizeAffiliateId(value) {
  const raw = String(value || '').trim().replace(/^an_/i, '');
  const match = raw.match(/(\d{6,})/);
  return match ? match[1] : '';
}

function extractUtmSource(value) {
  try {
    const u = new URL(value);
    return u.searchParams.get('utm_source') || '';
  } catch {
    return '';
  }
}

function extractMemberIdFromUrl(value) {
  const raw = decodeURIComponent(String(value || '').trim());
  if (!raw) return null;
  const match = raw.match(/mm_(\d+)_/);
  return match ? match[1] : null;
}

function extractMemberIdFromData(data) {
  if (!data || typeof data !== 'object') return null;
  try {
    const utLogMap = typeof data.utLogMap === 'string' ? JSON.parse(data.utLogMap) : data.utLogMap;
    if (utLogMap && utLogMap.member_id && utLogMap.member_id !== '-1') return String(utLogMap.member_id);
  } catch {}
  const links = [data.promotionLink, data.clickUrl, data.eurl].filter(Boolean);
  for (const link of links) {
    const m = String(link).match(/mm_(\d+)_/);
    if (m) return m[1];
  }
  return null;
}

module.exports = {
  decodeHtmlEntities,
  extractOriginalLinkFromHtml,
  resolveOriginalLink,
  resolveRedirectUrl,
  resolveTrackingLink,
  normalizeShopeeOriginalLink,
  normalizeLazadaOriginalLink,
  normalizeAffiliateId,
  extractUtmSource,
  extractMemberIdFromUrl,
  extractMemberIdFromData,
};
