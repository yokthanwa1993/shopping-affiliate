import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MAX_SHORTLINK_SUB_ID_CHARS,
    DEFAULT_SHOPEE_CUSTOMLINK_ID,
    DEFAULT_SHOPEE_SHORTLINK_URL_TEMPLATE,
    buildShopeeShortlinkBaseUrl,
    buildShortlinkRequestUrlFromTemplate,
    normalizeShortlinkSubId,
    normalizeFacebookPostSubIdForShortlink,
    buildPostingCommentShortlinkSubIds,
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

test('Shopee default shortlink template uses id=15130770000 and never account=CHEARB', () => {
    assert.equal(DEFAULT_SHOPEE_CUSTOMLINK_ID, '15130770000')
    assert.match(DEFAULT_SHOPEE_SHORTLINK_URL_TEMPLATE, /[?&]id=15130770000(&|$)/)
    assert.doesNotMatch(DEFAULT_SHOPEE_SHORTLINK_URL_TEMPLATE, /account=/i)
    assert.doesNotMatch(DEFAULT_SHOPEE_SHORTLINK_URL_TEMPLATE, /CHEARB/i)
    // The Cloak bridge mints from a built request, so the default template must
    // produce an id-based request URL with the product url filled in.
    const built = buildShortlinkRequestUrlFromTemplate(DEFAULT_SHOPEE_SHORTLINK_URL_TEMPLATE, PRODUCT_URL, {
        sub1: 's1', sub2: '', sub3: '', sub4: '', sub5: '',
    })
    assert.match(built, /[?&]id=15130770000(&|$)/)
    assert.doesNotMatch(built, /account=/i)
})

test('buildShopeeShortlinkBaseUrl maps the admin CHEARB account to id=15130770000', () => {
    const url = buildShopeeShortlinkBaseUrl('https://short.wwoom.com/', 'CHEARB')
    assert.match(url, /[?&]id=15130770000(&|$)/)
    assert.doesNotMatch(url, /account=/i)
    // case-insensitive on the account name
    assert.match(buildShopeeShortlinkBaseUrl('https://short.wwoom.com/', 'chearb'), /[?&]id=15130770000(&|$)/)
})

test('buildShopeeShortlinkBaseUrl keeps account= form for accounts without a known id', () => {
    const url = buildShopeeShortlinkBaseUrl('https://short.wwoom.com/', 'SIAMNEWS')
    assert.match(url, /[?&]account=SIAMNEWS(&|$)/)
    assert.doesNotMatch(url, /[?&]id=/)
    assert.equal(buildShopeeShortlinkBaseUrl('https://short.wwoom.com/', ''), '')
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

test('postSubId3 override semantics: empty override falls back to settings sub3', () => {
    // Mirrors the override resolution used in shortenShopeeLinkForNamespace:
    //   effectiveSub3 = normalizeShortlinkSubId(postSubId3 || '') || settingsSub3
    const settingsSub3 = 'configuredSub3'
    const resolve = (override?: string) => normalizeShortlinkSubId(override || '') || settingsSub3

    assert.equal(resolve(undefined), settingsSub3)
    assert.equal(resolve(''), settingsSub3)
    assert.equal(resolve('   '), settingsSub3)
    assert.equal(resolve('1008898512617594'), '1008898512617594')
})

test('buildShortlinkRequestUrlFromTemplate fills sub_id3 with provided page id', () => {
    const pageId = '1008898512617594'
    const url = buildShortlinkRequestUrlFromTemplate(SHOPEE_URL_TEMPLATE, PRODUCT_URL, {
        sub1: 'configuredSub1',
        sub2: '1008898512617594_1277758961195466',
        sub3: pageId,
        sub4: '',
        sub5: '',
    })
    assert.match(url, new RegExp(`sub3=${pageId}`))
})

test('normalizeFacebookPostSubIdForShortlink takes the POST id tail from pageId_postId', () => {
    // story_id is `pageId_postId` — sub2 must be the POST id, never the page id.
    assert.equal(
        normalizeFacebookPostSubIdForShortlink('1008898512617594_1277758961195466'),
        '1277758961195466',
    )
})

test('normalizeFacebookPostSubIdForShortlink returns a bare post id unchanged', () => {
    assert.equal(normalizeFacebookPostSubIdForShortlink('1277758961195466'), '1277758961195466')
})

test('normalizeFacebookPostSubIdForShortlink returns empty for blank/missing input', () => {
    assert.equal(normalizeFacebookPostSubIdForShortlink(''), '')
    assert.equal(normalizeFacebookPostSubIdForShortlink(null), '')
    assert.equal(normalizeFacebookPostSubIdForShortlink(undefined), '')
    assert.equal(normalizeFacebookPostSubIdForShortlink('   '), '')
})

test('buildPostingCommentShortlinkSubIds sets sub2=post id tail and sub3=page id (the live-link bug)', () => {
    // Reproduces the reported bug: live URL showed utm_content=<campaign>---- with
    // sub2/sub3 blank. The fix derives sub2 from the post id tail and sub3 from the
    // page id so the comment link carries both.
    const pageId = '1008898512617594'
    const storyId = `${pageId}_1277758961195466`
    const subs = buildPostingCommentShortlinkSubIds({
        canonicalPostId: storyId,
        pageId,
        logPrefix: 'TEST',
    })
    assert.equal(subs.postSubId2, '1277758961195466', 'sub2 must be the post id tail, not the page id')
    assert.notEqual(subs.postSubId2, pageId, 'sub2 must never equal the page id')
    assert.equal(subs.postSubId3, pageId, 'sub3 must be the page id')
    assert.equal(subs.postSubId4, '', 'sub4 stays internal (empty)')
})

test('buildPostingCommentShortlinkSubIds accepts a bare post id for sub2', () => {
    const subs = buildPostingCommentShortlinkSubIds({
        canonicalPostId: '1277758961195466',
        pageId: '1008898512617594',
        logPrefix: 'TEST',
    })
    assert.equal(subs.postSubId2, '1277758961195466')
    assert.equal(subs.postSubId3, '1008898512617594')
})

test('cron CloakBridge re-mint produces the expected utm_content tail shape (CHEARB live bug)', () => {
    // Regression for the cron stored-token→CloakBridge comment path: it used to comment
    // the pre-publish shortlink, whose request carried blank sub2/sub3, resolving to
    // utm_content=16JUN26FBSPCAD---- (no post/page tail). After the fix the branch first
    // re-mints with buildPostingCommentShortlinkSubIds(confirmedCanonicalPostId, pageId),
    // so the minted request carries sub2=post id / sub3=page id and the resolved
    // utm_content becomes <prefix>-<postId>-<pageId>--.
    const pageId = '1008898512617594'
    const fbPostId = '1305950258376336'
    const storyId = `${pageId}_${fbPostId}`
    const campaignPrefix = '16JUN26FBSPCAD'

    const subs = buildPostingCommentShortlinkSubIds({
        canonicalPostId: storyId,
        pageId,
        logPrefix: 'CRON STORED→CLOAK COMMENT-SHORTLINK',
    })
    // The re-mint request the cron branch now sends (mirrors shortenShopeeLinkForNamespace
    // override resolution: sub2/sub3 come from the post-time overrides).
    const mintRequest = buildShortlinkRequestUrlFromTemplate(SHOPEE_URL_TEMPLATE, PRODUCT_URL, {
        sub1: campaignPrefix,
        sub2: subs.postSubId2,
        sub3: subs.postSubId3,
        sub4: subs.postSubId4,
        sub5: '',
    })
    assert.match(mintRequest, new RegExp(`sub2=${fbPostId}(&|$)`), 'minted request must carry the post id as sub2')
    assert.match(mintRequest, new RegExp(`sub3=${pageId}(&|$)`), 'minted request must carry the page id as sub3')
    assert.doesNotMatch(mintRequest, /sub2=&/, 'sub2 must not be blank after re-mint')
    assert.doesNotMatch(mintRequest, /sub3=&/, 'sub3 must not be blank after re-mint')

    // The customlink resolver concatenates the populated subs into the expected
    // utm_content tail: <prefix>-<postId>-<pageId>-- (sub4 empty → trailing --).
    const expectedUtmContent = `${campaignPrefix}-${subs.postSubId2}-${subs.postSubId3}--`
    assert.equal(expectedUtmContent, `${campaignPrefix}-${fbPostId}-${pageId}--`)
    // And it must NOT collapse to the blank-tail shape seen on the broken live links.
    assert.notEqual(expectedUtmContent, `${campaignPrefix}----`)
})

test('buildPostingCommentShortlinkSubIds leaves sub2 empty when no post id is known', () => {
    // When story_id is missing the caller must fall back (no fake sub2). The OneCard
    // re-mint helper treats an empty sub2 as "do not re-mint" and keeps the original link.
    const subs = buildPostingCommentShortlinkSubIds({
        canonicalPostId: '',
        pageId: '1008898512617594',
        logPrefix: 'TEST',
    })
    assert.equal(subs.postSubId2, '')
    assert.equal(subs.postSubId3, '1008898512617594')
})
