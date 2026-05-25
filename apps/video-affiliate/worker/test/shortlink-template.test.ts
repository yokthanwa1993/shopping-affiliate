import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MAX_SHORTLINK_SUB_ID_CHARS,
    buildShortlinkRequestUrlFromTemplate,
    normalizeShortlinkSubId,
} from '../src/shortlink-template.js'

const SHOPEE_URL_TEMPLATE = 'https://customlink.wwoom.com/?id=15130770000&url={url}&sub1={sub_id}&sub2={sub_id2}&sub3={sub_id3}&sub4={sub_id4}&sub5={sub_id5}'
const PRODUCT_URL = 'https://shopee.co.th/product/123/456'

test('normalizeShortlinkSubId preserves underscore in pageId_postId format', () => {
    const fbPostId = '1008898512617594_1277758961195466'
    assert.equal(normalizeShortlinkSubId(fbPostId), fbPostId)
})

test('normalizeShortlinkSubId trims whitespace and strips CR/LF/TAB', () => {
    assert.equal(normalizeShortlinkSubId('  abc\r\n_def\t  '), 'abc_def')
    assert.equal(normalizeShortlinkSubId(null as unknown as string), '')
    assert.equal(normalizeShortlinkSubId(undefined as unknown as string), '')
})

test('normalizeShortlinkSubId slices to MAX_SHORTLINK_SUB_ID_CHARS', () => {
    const long = 'x'.repeat(MAX_SHORTLINK_SUB_ID_CHARS + 10)
    assert.equal(normalizeShortlinkSubId(long).length, MAX_SHORTLINK_SUB_ID_CHARS)
})

test('buildShortlinkRequestUrlFromTemplate fills sub_id2 with provided value', () => {
    const fbPostId = '1008898512617594_1277758961195466'
    const url = buildShortlinkRequestUrlFromTemplate(SHOPEE_URL_TEMPLATE, PRODUCT_URL, {
        sub1: 'configuredSub1',
        sub2: fbPostId,
        sub3: '',
        sub4: '',
        sub5: '',
    })
    assert.match(url, /sub1=configuredSub1/)
    assert.match(url, /sub2=1008898512617594_1277758961195466/)
    // underscore must survive encodeURIComponent (it is an unreserved char)
    assert.ok(!url.includes('sub2=1008898512617594%5F'), 'underscore should not be percent-encoded')
})

test('buildShortlinkRequestUrlFromTemplate leaves sub_id2 empty when not provided', () => {
    const url = buildShortlinkRequestUrlFromTemplate(SHOPEE_URL_TEMPLATE, PRODUCT_URL, {
        sub1: 'configuredSub1',
        sub2: '',
        sub3: '',
        sub4: '',
        sub5: '',
    })
    assert.match(url, /sub2=&/)
})

test('buildShortlinkRequestUrlFromTemplate URL-encodes the product url', () => {
    const url = buildShortlinkRequestUrlFromTemplate(SHOPEE_URL_TEMPLATE, PRODUCT_URL, {
        sub1: 's1',
        sub2: 's2',
        sub3: '',
        sub4: '',
        sub5: '',
    })
    assert.match(url, /url=https%3A%2F%2Fshopee\.co\.th%2Fproduct%2F123%2F456/)
})

test('postSubId2 override semantics: empty override falls back to settings sub2', () => {
    // Mirrors the override resolution used in shortenShopeeLinkForNamespace:
    //   effectiveSub2 = normalizeShortlinkSubId(postSubId2 || '') || settingsSub2
    const settingsSub2 = 'configuredSub2'
    const resolve = (override?: string) => normalizeShortlinkSubId(override || '') || settingsSub2

    assert.equal(resolve(undefined), settingsSub2)
    assert.equal(resolve(''), settingsSub2)
    assert.equal(resolve('   '), settingsSub2)
    assert.equal(resolve('1008898512617594_1277758961195466'), '1008898512617594_1277758961195466')
})

test('postSubId2 override is sanitized of unsafe characters before use', () => {
    const sanitized = normalizeShortlinkSubId('1008898512617594_1277758961195466\r\n<script>')
    // newlines stripped, but other chars (including <>) are preserved by current normalize.
    // The important guarantee is no CR/LF that could break a header/URL line.
    assert.ok(!/[\r\n\t]/.test(sanitized))
    assert.ok(sanitized.startsWith('1008898512617594_1277758961195466'))
})
