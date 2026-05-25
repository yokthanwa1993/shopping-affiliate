'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseEnvMap,
  resolveShopeeAccountMetadataFromId,
  resolveShopeeAccountFromId,
} = require('../src/shopee-accounts');

test('built-in Shopee id aliases return internal and display account metadata', () => {
  assert.deepEqual(resolveShopeeAccountMetadataFromId('15130770000', { envValue: '' }), {
    id: '15130770000',
    account: 'affiliate_chearb.com',
    displayAccount: 'affiliate@chearb.com',
  });
  assert.equal(resolveShopeeAccountFromId('an_15130770000', { envValue: '' }), 'affiliate_chearb.com');

  assert.deepEqual(resolveShopeeAccountMetadataFromId('15142270000', { envValue: '' }), {
    id: '15142270000',
    account: 'affiliate_neezs.com',
    displayAccount: 'affiliate@neezs.com',
  });
  assert.equal(resolveShopeeAccountFromId('an_15142270000', { envValue: '' }), 'affiliate_neezs.com');
});

test('env Shopee id aliases support string values with sanitized internal account', () => {
  const envValue = JSON.stringify({
    an_222222000000: 'env-user@example.com',
  });

  assert.deepEqual(resolveShopeeAccountMetadataFromId('222222000000', { envValue }), {
    id: '222222000000',
    account: 'env-user_example.com',
    displayAccount: 'env-user@example.com',
  });
});

test('env Shopee id aliases cannot override built-in account mapping', () => {
  const envValue = JSON.stringify({
    15130770000: 'wrong@example.com',
    15142270000: 'also-wrong@example.com',
  });

  assert.deepEqual(resolveShopeeAccountMetadataFromId('15130770000', { envValue }), {
    id: '15130770000',
    account: 'affiliate_chearb.com',
    displayAccount: 'affiliate@chearb.com',
  });
  assert.deepEqual(resolveShopeeAccountMetadataFromId('15142270000', { envValue }), {
    id: '15142270000',
    account: 'affiliate_neezs.com',
    displayAccount: 'affiliate@neezs.com',
  });
});

test('env Shopee id aliases support object values with displayAccount', () => {
  const envValue = JSON.stringify({
    333333000000: {
      account: 'internal_profile',
      displayAccount: 'human@example.com',
    },
  });

  assert.deepEqual(parseEnvMap(envValue), {
    333333000000: {
      id: '333333000000',
      account: 'internal_profile',
      displayAccount: 'human@example.com',
    },
  });
});
