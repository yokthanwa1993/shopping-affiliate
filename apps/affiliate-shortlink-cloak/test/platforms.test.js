'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPlatform } = require('../src/platforms');

test('detectPlatform identifies Shopee urls', () => {
  assert.equal(detectPlatform('https://shopee.co.th/product/12345/67890'), 'shopee');
  assert.equal(detectPlatform('https://s.shopee.co.th/abcDEF'), 'shopee');
  assert.equal(detectPlatform('SHOPEE.co.th/foo'), 'shopee');
});

test('detectPlatform identifies Lazada urls', () => {
  assert.equal(detectPlatform('https://www.lazada.co.th/products/i12345.html'), 'lazada');
  assert.equal(detectPlatform('https://s.lazada.co.th/abc'), 'lazada');
});

test('detectPlatform returns empty for unknown urls', () => {
  assert.equal(detectPlatform('https://example.com'), '');
  assert.equal(detectPlatform(''), '');
  assert.equal(detectPlatform(null), '');
});
