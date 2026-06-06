import assert from 'node:assert/strict'
import test from 'node:test'
import {
    CUSTOMLINK_DEFAULT_ID,
    CUSTOMLINK_HOST,
    JOB_DEFAULT_BATCH_SIZE,
    JOB_MAX_BATCH_SIZE,
    REGISTRY_DEFAULT_LIMIT,
    REGISTRY_MAX_LIMIT,
    buildCustomlinkRequestUrl,
    buildExpectedUtmContent,
    buildTargetSubIds,
    canonicalizeProductUrl,
    clampBatchSize,
    computeRegistryItemStatus,
    computeWriteAction,
    detectGraphStopSignal,
    extractUrlsFromText,
    isCustomlinkLink,
    isShopeeLink,
    isShortlinkCandidate,
    normalizeJobBool,
    normalizeRegistryLimit,
    normalizeRegistryOffset,
    parseTrackingSubIds,
    pickPrimaryAffiliateUrl,
    replaceShortlinkInMessage,
    resolvePageCommentLinkJobStatus,
    verifyRewrittenShortlink,
} from '../src/comment-link-registry.js'

test('extractUrlsFromText pulls unique URLs and strips trailing punctuation', () => {
    const text = 'พิกัด: https://s.shopee.co.th/abc123) และ https://s.shopee.co.th/abc123 #ของดี\nลิงก์ https://customlink.wwoom.com/?id=1&url=x.'
    const urls = extractUrlsFromText(text)
    assert.deepEqual(urls, [
        'https://s.shopee.co.th/abc123',
        'https://customlink.wwoom.com/?id=1&url=x',
    ])
})

test('extractUrlsFromText returns [] for empty / link-free text', () => {
    assert.deepEqual(extractUrlsFromText(''), [])
    assert.deepEqual(extractUrlsFromText('สนใจสั่งซื้อทักแชท'), [])
})

test('link classifiers recognise shopee, customlink and short hosts', () => {
    assert.ok(isShopeeLink('https://shopee.co.th/product/123/456'))
    assert.ok(isShopeeLink('https://s.shopee.co.th/abc'))
    assert.ok(!isShopeeLink('https://example.com'))
    assert.ok(isCustomlinkLink('https://customlink.wwoom.com/?id=1'))
    assert.ok(!isCustomlinkLink('https://shopee.co.th/x'))
    assert.ok(isShortlinkCandidate('https://s.shopee.co.th/abc'))
    assert.ok(isShortlinkCandidate('https://customlink.wwoom.com/?id=1'))
    assert.ok(!isShortlinkCandidate('https://random.example/x'))
})

test('pickPrimaryAffiliateUrl prefers customlink, then shopee short link', () => {
    assert.equal(
        pickPrimaryAffiliateUrl([
            'https://shopee.co.th/product/1/2',
            'https://customlink.wwoom.com/?id=15130770000',
            'https://s.shopee.co.th/abc',
        ]),
        'https://customlink.wwoom.com/?id=15130770000',
    )
    assert.equal(
        pickPrimaryAffiliateUrl(['https://shopee.co.th/product/1/2', 'https://s.shopee.co.th/abc']),
        'https://s.shopee.co.th/abc',
    )
    assert.equal(pickPrimaryAffiliateUrl(['https://example.com', '']), '')
})

test('parseTrackingSubIds reads explicit sub1..sub3 customlink params', () => {
    const parsed = parseTrackingSubIds(
        'https://customlink.wwoom.com/?id=15130770000&sub1=spring&sub2=1277758961195466&sub3=1008898512617594',
    )
    assert.equal(parsed.sub1, 'spring')
    assert.equal(parsed.sub2, '1277758961195466')
    assert.equal(parsed.sub3, '1008898512617594')
    assert.equal(parsed.sub4, '')
    assert.equal(parsed.sub5, '')
})

test('parseTrackingSubIds splits shopee utm_content with trailing --', () => {
    const parsed = parseTrackingSubIds('https://shopee.co.th/product/1/2?utm_content=spring-post-page--')
    assert.equal(parsed.utm_content, 'spring-post-page--')
    assert.equal(parsed.sub1, 'spring')
    assert.equal(parsed.sub2, 'post')
    assert.equal(parsed.sub3, 'page')
    assert.equal(parsed.sub4, '')
    assert.equal(parsed.sub5, '')
})

test('parseTrackingSubIds returns empty struct for non-URL', () => {
    const parsed = parseTrackingSubIds('not a url')
    assert.deepEqual(parsed, { utm_content: '', sub1: '', sub2: '', sub3: '', sub4: '', sub5: '' })
})

test('canonicalizeProductUrl strips utm/sub/click tracking params', () => {
    const canonical = canonicalizeProductUrl(
        'https://shopee.co.th/product/123/456?utm_source=x&utm_content=a-b-c&sub1=y&fbclid=z&xptdk=q',
    )
    assert.equal(canonical, 'https://shopee.co.th/product/123/456')
})

test('canonicalizeProductUrl keeps non-tracking params and falls back on bad input', () => {
    assert.equal(
        canonicalizeProductUrl('https://shopee.co.th/search?keyword=shoes&utm_source=x'),
        'https://shopee.co.th/search?keyword=shoes',
    )
    assert.equal(canonicalizeProductUrl('not-a-url'), 'not-a-url')
})

test('canonicalizeProductUrl drops the whole query for the Shopee -i.<shop>.<item> form', () => {
    assert.equal(
        canonicalizeProductUrl(
            'https://shopee.co.th/Nice-Product-Name-i.1234567.890123456?__mobile__=1&gads_t_sig=AAA&mmp_pid=xyz&utm_content=a-b-c&xptdk=q',
        ),
        'https://shopee.co.th/Nice-Product-Name-i.1234567.890123456',
    )
})

test('canonicalizeProductUrl keeps the username/product path and strips stale tracking', () => {
    // ".../<shopname>/<shop>/<item>" — last two numeric path segments are the ids.
    assert.equal(
        canonicalizeProductUrl('https://shopee.co.th/opaanlp/1234567/890123456?__mobile__=1&af_siteid=z&mmp_pid=q'),
        'https://shopee.co.th/opaanlp/1234567/890123456',
    )
    // ".../product/<shop>/<item>" with affiliate + redirect junk.
    assert.equal(
        canonicalizeProductUrl('https://shopee.co.th/product/1234567/890123456?gads_t_sig=AAA&deep_link_value=foo&ref=bar'),
        'https://shopee.co.th/product/1234567/890123456',
    )
})

test('canonicalizeProductUrl rebuilds /product/<shop>/<item> from shopid/itemid query params', () => {
    assert.equal(
        canonicalizeProductUrl('https://shopee.co.th/-/redirect?shopid=1234567&itemid=890123456&__mobile__=1&mmp_pid=q'),
        'https://shopee.co.th/product/1234567/890123456',
    )
})

test('canonicalizeProductUrl strips named Shopee junk via generic fallback when ids are unparseable', () => {
    // No parseable shop/item ids → generic param stripping must still drop the
    // named stale tracking keys while keeping a real param.
    assert.equal(
        canonicalizeProductUrl('https://shopee.co.th/m/flash-sale?promo=cny&__mobile__=1&gads_t_sig=AAA&mmp_pid=xyz'),
        'https://shopee.co.th/m/flash-sale?promo=cny',
    )
})

test('computeRegistryItemStatus prioritises token then fetch blockers', () => {
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'missing_token', pageCommentCount: 0, otherCommentCount: 0, hasLink: true, expandState: 'ok',
    }), 'missing_token')
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'failed', pageCommentCount: 0, otherCommentCount: 0, hasLink: true, expandState: 'ok',
    }), 'comment_fetch_failed')
})

test('computeRegistryItemStatus distinguishes missing vs non-page comments', () => {
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'ok', pageCommentCount: 0, otherCommentCount: 0, hasLink: true, expandState: 'ok',
    }), 'missing_comment')
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'ok', pageCommentCount: 0, otherCommentCount: 3, hasLink: true, expandState: 'ok',
    }), 'non_page_comment')
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'ok', pageCommentCount: 2, otherCommentCount: 0, hasLink: true, expandState: 'ok',
    }), 'multiple_comments')
})

test('computeRegistryItemStatus reports link/expand outcomes once a single page comment exists', () => {
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'ok', pageCommentCount: 1, otherCommentCount: 0, hasLink: false, expandState: 'not_attempted',
    }), 'missing_link')
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'ok', pageCommentCount: 1, otherCommentCount: 0, hasLink: true, expandState: 'failed',
    }), 'expand_failed')
    assert.equal(computeRegistryItemStatus({
        commentFetch: 'ok', pageCommentCount: 1, otherCommentCount: 0, hasLink: true, expandState: 'ok',
    }), 'ok')
})

test('normalizeRegistryLimit clamps into [1, MAX] with default fallback', () => {
    assert.equal(normalizeRegistryLimit(undefined), REGISTRY_DEFAULT_LIMIT)
    assert.equal(normalizeRegistryLimit('abc'), REGISTRY_DEFAULT_LIMIT)
    assert.equal(normalizeRegistryLimit(0), 1)
    assert.equal(normalizeRegistryLimit(5000), REGISTRY_MAX_LIMIT)
    assert.equal(normalizeRegistryLimit(40), 40)
})

test('normalizeRegistryOffset floors to >= 0', () => {
    assert.equal(normalizeRegistryOffset(undefined), 0)
    assert.equal(normalizeRegistryOffset(-5), 0)
    assert.equal(normalizeRegistryOffset('12'), 12)
    assert.equal(normalizeRegistryOffset(3.9), 3)
})

// --- Safe rewrite workflow helpers -----------------------------------------

test('clampBatchSize defaults to 5 and clamps into [1, 50]', () => {
    assert.equal(clampBatchSize(undefined), JOB_DEFAULT_BATCH_SIZE)
    assert.equal(clampBatchSize('abc'), JOB_DEFAULT_BATCH_SIZE)
    assert.equal(clampBatchSize(0), 1)
    assert.equal(clampBatchSize(9999), JOB_MAX_BATCH_SIZE)
    assert.equal(clampBatchSize(12), 12)
})

test('normalizeJobBool keeps SAFE default when unset, parses truthy/falsy', () => {
    assert.equal(normalizeJobBool(undefined, true), true)
    assert.equal(normalizeJobBool('', true), true)
    assert.equal(normalizeJobBool('false', true), false)
    assert.equal(normalizeJobBool('0', true), false)
    assert.equal(normalizeJobBool(false, true), false)
    assert.equal(normalizeJobBool('yes', false), true)
    assert.equal(normalizeJobBool('garbage', true), true)
})

test('buildTargetSubIds uses canonical post_id for sub2 when present', () => {
    const subs = buildTargetSubIds({
        requestedSub1: 'spring',
        pageId: '1008898512617594',
        canonicalPostId: '1008898512617594_1284990567138972',
        fbVideoId: '998726829758584',
    })
    assert.equal(subs.sub1, 'spring')
    assert.equal(subs.sub2, '1284990567138972') // story tail of canonical post id
    assert.equal(subs.sub3, '1008898512617594')
    assert.equal(subs.sub2_source, 'canonical_post_id')
    assert.equal(subs.reason, '')
})

test('buildTargetSubIds falls back to fb_video_id and flags the reason', () => {
    const subs = buildTargetSubIds({
        requestedSub1: 'spring',
        pageId: '1008898512617594',
        canonicalPostId: '',
        fbVideoId: '998726829758584',
    })
    assert.equal(subs.sub2, '998726829758584')
    assert.equal(subs.sub2_source, 'fb_video_id')
    assert.ok(subs.reason.includes('sub2_fallback_fb_video_id'))
})

test('buildTargetSubIds reports missing sub2 when nothing resolves', () => {
    const subs = buildTargetSubIds({ requestedSub1: '', pageId: '', canonicalPostId: '', fbVideoId: '' })
    assert.equal(subs.sub2_source, 'none')
    assert.ok(subs.reason.includes('missing_sub1'))
    assert.ok(subs.reason.includes('missing_page_id'))
    assert.ok(subs.reason.includes('missing_sub2'))
})

test('buildCustomlinkRequestUrl targets customlink host with default id and subs', () => {
    const url = buildCustomlinkRequestUrl({
        productUrl: 'https://shopee.co.th/product/1/2',
        sub1: 'spring',
        sub2: '1284990567138972',
        sub3: '1008898512617594',
    })
    const parsed = new URL(url)
    assert.equal(parsed.hostname, CUSTOMLINK_HOST)
    assert.equal(parsed.searchParams.get('id'), CUSTOMLINK_DEFAULT_ID)
    assert.equal(parsed.searchParams.get('url'), 'https://shopee.co.th/product/1/2')
    assert.equal(parsed.searchParams.get('sub1'), 'spring')
    assert.equal(parsed.searchParams.get('sub2'), '1284990567138972')
    assert.equal(parsed.searchParams.get('sub3'), '1008898512617594')
})

test('buildCustomlinkRequestUrl canonicalizes the product url so url= carries no stale tracking', () => {
    const url = buildCustomlinkRequestUrl({
        productUrl: 'https://shopee.co.th/Nice-i.1234567.890123456?__mobile__=1&gads_t_sig=AAA&mmp_pid=xyz&utm_content=a-b-c',
        sub1: 'spring',
        sub2: '1284990567138972',
        sub3: '1008898512617594',
    })
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('url'), 'https://shopee.co.th/Nice-i.1234567.890123456')
    assert.equal(parsed.searchParams.get('sub1'), 'spring')
})

test('buildExpectedUtmContent renders <sub1>-<sub2>-<sub3>-- with trailing --', () => {
    assert.equal(buildExpectedUtmContent({ sub1: 'a', sub2: 'b', sub3: 'c' }), 'a-b-c--')
})

test('verifyRewrittenShortlink confirms matching utm_content sub ids', () => {
    const expected = { sub1: 'spring', sub2: 'post123', sub3: 'page456' }
    const ok = verifyRewrittenShortlink(
        'https://shopee.co.th/product/1/2?utm_content=spring-post123-page456--',
        expected,
    )
    assert.equal(ok.ok, true)
    assert.equal(ok.utm_content, 'spring-post123-page456--')
    assert.equal(ok.expected_utm_content, 'spring-post123-page456--')
    assert.equal(ok.reason, '')

    const mismatch = verifyRewrittenShortlink(
        'https://shopee.co.th/product/1/2?utm_content=spring-WRONG-page456--',
        expected,
    )
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.reason, 'mismatch_sub2')

    const empty = verifyRewrittenShortlink('https://shopee.co.th/product/1/2', expected)
    assert.equal(empty.ok, false)
    assert.equal(empty.reason, 'no_tracking_params')
})

test('replaceShortlinkInMessage swaps the old link in place, keeps caption', () => {
    const result = replaceShortlinkInMessage(
        '🔥 พิกัด https://s.shopee.co.th/OLD จัดเลย #ของดี',
        'https://s.shopee.co.th/OLD',
        'https://customlink.wwoom.com/?id=15130770000&x=1',
    )
    assert.equal(result.replaced, 'exact')
    assert.equal(result.message, '🔥 พิกัด https://customlink.wwoom.com/?id=15130770000&x=1 จัดเลย #ของดี')
})

test('replaceShortlinkInMessage detects an affiliate link when old url unknown', () => {
    const result = replaceShortlinkInMessage(
        'สนใจกดที่นี่ https://s.shopee.co.th/DETECT นะ',
        '',
        'https://customlink.wwoom.com/?id=1',
    )
    assert.equal(result.replaced, 'detected')
    assert.ok(result.message.includes('https://customlink.wwoom.com/?id=1'))
    assert.ok(!result.message.includes('DETECT'))
})

test('replaceShortlinkInMessage appends when there is no link, noops on empty newUrl', () => {
    const appended = replaceShortlinkInMessage('สนใจทักแชท', '', 'https://customlink.wwoom.com/?id=1')
    assert.equal(appended.replaced, 'appended')
    assert.equal(appended.message, 'สนใจทักแชท\nhttps://customlink.wwoom.com/?id=1')

    const noop = replaceShortlinkInMessage('keep me', 'https://s.shopee.co.th/x', '')
    assert.equal(noop.replaced, 'noop')
    assert.equal(noop.message, 'keep me')
})

test('computeWriteAction edits only page-owned comments, else creates new', () => {
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: 'P', oldCommentId: 'P_123', hasRewriteableLink: true,
    }), 'edit')
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: 'OTHER', oldCommentId: 'OTHER_123', hasRewriteableLink: true,
    }), 'create_new')
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: '', oldCommentId: '', hasRewriteableLink: true,
    }), 'create_new')
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: 'P', oldCommentId: 'P_123', hasRewriteableLink: false,
    }), 'skip')
})

test('detectGraphStopSignal halts on 368, rate-limit codes and spam wording', () => {
    assert.deepEqual(detectGraphStopSignal({ code: 368 }), { stop: true, reason: 'policy_block_368' })
    assert.equal(detectGraphStopSignal({ code: 32 }).stop, true)
    assert.equal(detectGraphStopSignal({ code: 4 }).stop, true)
    assert.equal(detectGraphStopSignal({ error_subcode: 1390008 }).stop, true)
    assert.equal(detectGraphStopSignal({ message: 'This looks like spam' }).stop, true)
    assert.equal(detectGraphStopSignal({ message: 'You are temporarily blocked' }).stop, true)
    assert.deepEqual(detectGraphStopSignal({ code: 100, message: 'invalid param' }), { stop: false, reason: '' })
    assert.deepEqual(detectGraphStopSignal(null), { stop: false, reason: '' })
})

test('resolvePageCommentLinkJobStatus keeps a dry-run from looking running/stuck', () => {
    // Effective dry-run: items stay 'planned', nothing written → preserve prior status.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: false, previousStatus: 'planned', remainingPlanned: 3,
        doneCount: 0, failedCount: 0, stoppedReason: '',
    }), 'planned')
    // Prior status from an earlier real partial run is preserved, not reset to 'running'.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: false, previousStatus: 'partial', remainingPlanned: 2,
        doneCount: 1, failedCount: 1, stoppedReason: '',
    }), 'partial')
    // A dry-run must NEVER return 'running': a leftover 'running' prior is demoted to 'planned'.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: false, previousStatus: 'running', remainingPlanned: 3,
        doneCount: 0, failedCount: 0, stoppedReason: '',
    }), 'planned')
    // Even with prior partial work counts, a dry-run over a 'running' prior stays non-running.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: false, previousStatus: 'running', remainingPlanned: 2,
        doneCount: 1, failedCount: 1, stoppedReason: '',
    }), 'planned')
    // A failed prior is preserved through a dry-run (terminal, not running).
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: false, previousStatus: 'failed', remainingPlanned: 1,
        doneCount: 0, failedCount: 1, stoppedReason: '',
    }), 'failed')
    // Unknown/empty prior status falls back to 'planned'.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: false, previousStatus: '', remainingPlanned: 1,
        doneCount: 0, failedCount: 0, stoppedReason: '',
    }), 'planned')
})

test('resolvePageCommentLinkJobStatus advances a real write run as before', () => {
    // Write mode with remaining work → in-progress.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: true, previousStatus: 'planned', remainingPlanned: 2,
        doneCount: 1, failedCount: 0, stoppedReason: '',
    }), 'running')
    // Early stop with work remaining → partial.
    assert.equal(resolvePageCommentLinkJobStatus({
        effectiveWriteMode: true, previousStatus: 'running', remainingPlanned: 2,
        doneCount: 1, failedCount: 1, stoppedReason: 'policy_block_368',
    }), 'partial')
})

test('resolvePageCommentLinkJobStatus reaches terminal state when nothing remains', () => {
    // Terminal rollups are independent of write mode (dry-run can finish a fully-skipped job).
    for (const effectiveWriteMode of [true, false]) {
        assert.equal(resolvePageCommentLinkJobStatus({
            effectiveWriteMode, previousStatus: 'planned', remainingPlanned: 0,
            doneCount: 5, failedCount: 0, stoppedReason: '',
        }), 'done')
        assert.equal(resolvePageCommentLinkJobStatus({
            effectiveWriteMode, previousStatus: 'running', remainingPlanned: 0,
            doneCount: 3, failedCount: 2, stoppedReason: '',
        }), 'partial')
        assert.equal(resolvePageCommentLinkJobStatus({
            effectiveWriteMode, previousStatus: 'running', remainingPlanned: 0,
            doneCount: 0, failedCount: 4, stoppedReason: '',
        }), 'failed')
    }
})
