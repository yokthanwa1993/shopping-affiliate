import assert from 'node:assert/strict'
import test from 'node:test'
import {
    extractShopeeAffiliateIdFromLink,
    extractShopeeUtmSourceFromLink,
    normalizeShortlinkExpectedUtmId,
} from '../src/shopee-affiliate-id.js'

test('normalizeShortlinkExpectedUtmId strips an_ prefix and validates digits', () => {
    assert.equal(normalizeShortlinkExpectedUtmId('an_15130770000'), '15130770000')
    assert.equal(normalizeShortlinkExpectedUtmId('AN_15142270000'), '15142270000')
    assert.equal(normalizeShortlinkExpectedUtmId('15130770000'), '15130770000')
    assert.equal(normalizeShortlinkExpectedUtmId(''), '')
    assert.equal(normalizeShortlinkExpectedUtmId(null), '')
    assert.equal(normalizeShortlinkExpectedUtmId('not_an_id'), '')
    assert.equal(normalizeShortlinkExpectedUtmId('an_abc'), '')
})

test('extractShopeeUtmSourceFromLink reads only utm_source', () => {
    assert.equal(
        extractShopeeUtmSourceFromLink('https://shopee.co.th/product/1/2?utm_source=an_15130770000'),
        'an_15130770000',
    )
    assert.equal(
        extractShopeeUtmSourceFromLink('https://shopee.co.th/product/1/2?mmp_pid=an_15130770000'),
        '',
    )
    assert.equal(extractShopeeUtmSourceFromLink(''), '')
    assert.equal(extractShopeeUtmSourceFromLink('not-a-url'), '')
})

test('extractShopeeAffiliateIdFromLink prefers utm_source', () => {
    const link = 'https://shopee.co.th/product/1/2?utm_source=an_15130770000&mmp_pid=an_99999'
    assert.equal(extractShopeeAffiliateIdFromLink(link), '15130770000')
})

test('extractShopeeAffiliateIdFromLink falls back to mmp_pid when utm_source absent', () => {
    const link = 'https://shopee.co.th/product/1/2?mmp_pid=an_15130770000&other=x'
    assert.equal(extractShopeeAffiliateIdFromLink(link), '15130770000')
})

test('extractShopeeAffiliateIdFromLink accepts mmp_pid without an_ prefix', () => {
    const link = 'https://shopee.co.th/product/1/2?mmp_pid=15142270000'
    assert.equal(extractShopeeAffiliateIdFromLink(link), '15142270000')
})

test('extractShopeeAffiliateIdFromLink returns empty when neither param has a valid id', () => {
    assert.equal(
        extractShopeeAffiliateIdFromLink('https://shopee.co.th/product/1/2?utm_source=some_string&mmp_pid=abc'),
        '',
    )
    assert.equal(extractShopeeAffiliateIdFromLink('https://shopee.co.th/product/1/2'), '')
    assert.equal(extractShopeeAffiliateIdFromLink(''), '')
    assert.equal(extractShopeeAffiliateIdFromLink('not-a-url'), '')
})

test('extractShopeeAffiliateIdFromLink fail-closed: a wrong mmp_pid does not match expected', () => {
    // Wrong affiliate id (different namespace) must NOT pass equality with
    // the expected id. This is the strict Shopee alias validation: we accept
    // the alternative parameter shape, but the id itself still has to match.
    const link = 'https://shopee.co.th/product/1/2?mmp_pid=an_99999999999'
    const actual = extractShopeeAffiliateIdFromLink(link)
    const expected = normalizeShortlinkExpectedUtmId('an_15130770000')
    assert.notEqual(actual, expected)
    assert.equal(actual, '99999999999')
})

test('extractShopeeAffiliateIdFromLink supports common Shopee bridge redirect shape', () => {
    // Realistic shape after a Shopee shortlink redirects to a product URL:
    // many tracking params, affiliate id only in mmp_pid.
    const link = 'https://shopee.co.th/Tide-Liquid-i.123.456?af_click_lookback=7d&mmp_pid=an_15130770000&af_pid=affiliates'
    assert.equal(extractShopeeAffiliateIdFromLink(link), '15130770000')
})
