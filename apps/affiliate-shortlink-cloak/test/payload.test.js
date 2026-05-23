'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildShopeeShortlinkPayload,
  buildLazadaShortlinkPayload,
} = require('../src/payload');

const SHOPEE_EXPECTED_KEYS = [
  'link', 'longLink', 'originalLink', 'shortLink', 'id',
  'utm_source', 'utm_content', 'account',
  'sub1', 'sub2', 'sub3', 'sub4', 'sub5',
];

const LAZADA_EXPECTED_KEYS = [
  'link', 'longLink', 'originalLink', 'shortLink', 'id',
  'member_id', 'promotionCode', 'account', 'sub1',
];

test('buildShopeeShortlinkPayload produces exact expected key set', () => {
  const out = buildShopeeShortlinkPayload({
    link: 'https://shopee.co.th/x',
    longLink: 'https://shopee.co.th/product/1234567/9876543?utm_source=an_987654321&utm_content=YOK-aa-bb-cc-dd',
    shortLink: 'https://s.shopee.co.th/zzz',
    utmSource: 'an_987654321',
    account: 'CHEARB',
  });
  assert.deepEqual(Object.keys(out).sort(), [...SHOPEE_EXPECTED_KEYS].sort());
  assert.equal(out.account, 'CHEARB');
  assert.equal(out.utm_source, 'an_987654321');
  assert.equal(out.id, '987654321');
  assert.equal(out.utm_content, 'YOK-aa-bb-cc-dd');
  assert.equal(out.sub1, 'YOK');
  assert.equal(out.sub2, 'aa');
  assert.equal(out.sub3, 'bb');
  assert.equal(out.sub4, 'cc');
  assert.equal(out.sub5, 'dd');
  assert.equal(out.originalLink, 'https://shopee.co.th/product/1234567/9876543');
});

test('buildShopeeShortlinkPayload tolerates missing fields', () => {
  const out = buildShopeeShortlinkPayload({ link: 'https://shopee.co.th/foo' });
  assert.deepEqual(Object.keys(out).sort(), [...SHOPEE_EXPECTED_KEYS].sort());
  assert.equal(out.sub1, '');
  assert.equal(out.utm_content, '');
});

test('buildLazadaShortlinkPayload produces exact expected key set', () => {
  const out = buildLazadaShortlinkPayload({
    link: 'https://www.lazada.co.th/products/i12345.html',
    longLink: 'https://www.lazada.co.th/products/i12345.html?spm=foo',
    shortLink: 'https://s.lazada.co.th/s.aBcDe?cv=1&af=mm_123456789_test_yok',
    memberId: '123456789',
    promotionCode: 'PROMO123',
    account: 'YOK',
    sub1: 'fbpost',
  });
  assert.deepEqual(Object.keys(out).sort(), [...LAZADA_EXPECTED_KEYS].sort());
  assert.equal(out.account, 'YOK');
  assert.equal(out.member_id, '123456789');
  assert.equal(out.id, '123456789');
  assert.equal(out.promotionCode, 'PROMO123');
  assert.equal(out.sub1, 'fbpost');
  assert.equal(out.originalLink, 'https://www.lazada.co.th/products/i12345.html');
});

test('buildLazadaShortlinkPayload returns null member_id when absent', () => {
  const out = buildLazadaShortlinkPayload({
    link: 'https://www.lazada.co.th/x',
    shortLink: 'https://s.lazada.co.th/y',
  });
  assert.equal(out.member_id, null);
  assert.equal(out.id, '');
});
