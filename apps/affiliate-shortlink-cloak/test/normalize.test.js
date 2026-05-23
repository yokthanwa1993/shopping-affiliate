'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeShopeeOriginalLink,
  normalizeLazadaOriginalLink,
  normalizeAffiliateId,
  extractUtmSource,
  extractMemberIdFromUrl,
  extractMemberIdFromData,
  decodeHtmlEntities,
  extractOriginalLinkFromHtml,
} = require('../src/normalize');

test('normalizeShopeeOriginalLink canonicalizes product paths', () => {
  assert.equal(
    normalizeShopeeOriginalLink('https://shopee.co.th/product/123/456?x=1'),
    'https://shopee.co.th/product/123/456',
  );
  assert.equal(
    normalizeShopeeOriginalLink('https://shopee.co.th/universal-link/product/123/456'),
    'https://shopee.co.th/product/123/456',
  );
  assert.equal(
    normalizeShopeeOriginalLink('https://shopee.co.th/Foo-i.123.456'),
    'https://shopee.co.th/product/123/456',
  );
});

test('normalizeLazadaOriginalLink strips query string', () => {
  assert.equal(
    normalizeLazadaOriginalLink('https://www.lazada.co.th/products/i12345.html?spm=foo&bar=1'),
    'https://www.lazada.co.th/products/i12345.html',
  );
});

test('normalizeAffiliateId extracts numeric id, stripping an_ prefix', () => {
  assert.equal(normalizeAffiliateId('an_987654321'), '987654321');
  assert.equal(normalizeAffiliateId('123456789'), '123456789');
  assert.equal(normalizeAffiliateId('nope'), '');
});

test('extractUtmSource returns utm_source from urls', () => {
  assert.equal(extractUtmSource('https://x?utm_source=an_1'), 'an_1');
  assert.equal(extractUtmSource('not-a-url'), '');
});

test('extractMemberIdFromUrl finds mm_<id>_', () => {
  assert.equal(extractMemberIdFromUrl('https://s.lazada.co.th/y?af=mm_987654_xxx'), '987654');
  assert.equal(extractMemberIdFromUrl('no member'), null);
});

test('extractMemberIdFromData handles utLogMap (object & string) and link fallback', () => {
  assert.equal(extractMemberIdFromData({ utLogMap: { member_id: '42' } }), '42');
  assert.equal(extractMemberIdFromData({ utLogMap: JSON.stringify({ member_id: '99' }) }), '99');
  assert.equal(extractMemberIdFromData({ utLogMap: { member_id: '-1' }, promotionLink: 'x mm_777_y' }), '777');
  assert.equal(extractMemberIdFromData({}), null);
  assert.equal(extractMemberIdFromData(null), null);
});

test('decodeHtmlEntities decodes common HTML entities', () => {
  assert.equal(decodeHtmlEntities('a &amp; b &quot;c&quot;'), 'a & b "c"');
});

test('extractOriginalLinkFromHtml prefers rel="origin"', () => {
  const html = `<html><head>
    <link rel="canonical" href="https://example.com/canon">
    <link rel="origin" href="https://example.com/origin">
    <meta property="og:url" content="https://example.com/og">
  </head></html>`;
  assert.equal(extractOriginalLinkFromHtml(html), 'https://example.com/origin');
});
