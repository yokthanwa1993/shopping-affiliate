import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    CUSTOMLINK_DEFAULT_ID,
    CUSTOMLINK_HOST,
    JOB_DEFAULT_BATCH_SIZE,
    JOB_MAX_BATCH_SIZE,
    GRAPH_COMMENT_BLOCK_SECONDS,
    GRAPH_COMMENT_DEFAULT_MIN_SPACING_SECONDS,
    GRAPH_COMMENT_GUARD_TABLE_SQL,
    PAGE_COMMENT_LINK_JOB_ITEMS_TABLE_SQL,
    PAGE_COMMENT_LINK_REGISTRY_TABLE_SQL,
    PAGE_POST_LINK_LEDGER_TABLE_SQL,
    REGISTRY_DEFAULT_LIMIT,
    REGISTRY_MAX_LIMIT,
    buildCustomlinkRequestUrl,
    buildExpectedUtmContent,
    buildTargetSubIds,
    canonicalizeProductUrl,
    clampBatchSize,
    computeGraphCommentBlockUntil,
    computeGraphCommentGuardDecision,
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
    parseAffiliateId,
    parseTrackingSubIds,
    pickPrimaryAffiliateUrl,
    resolveTargetAffiliateId,
    replaceShortlinkInMessage,
    resolveCreateNewBlockedReason,
    resolveEffectiveTargetSub4,
    resolveGraphCommentMinSpacingSeconds,
    resolveRealRewriteRefusal,
    resolveRewriteLogId,
    ensureRewriteLogId,
    resolveRunCommentBatchLimit,
    resolvePageCommentLinkJobStatus,
    verifyAffiliateId,
    verifyRewrittenShortlink,
    resolvePageStoryRewriteBlockReason,
} from '../src/comment-link-registry.js'
import { resolveCanonicalCommentTarget } from '../src/comment-targeting.js'

function indexFunctionSource(startMarker: string, endMarker: string): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf(startMarker)
    assert.ok(start > -1, `${startMarker} must exist`)
    const end = source.indexOf(endMarker, start)
    assert.ok(end > start, `${endMarker} must exist after ${startMarker}`)
    return source.slice(start, end)
}

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


test('Graph comment guard cooldown prevents immediate repeated comment calls', () => {
    const now = Date.parse('2026-06-07T00:01:00.000Z')
    const decision = computeGraphCommentGuardDecision(
        { lastCommentOperationAt: '2026-06-07T00:00:30.000Z', blockUntil: '', blockReason: '' },
        now,
        GRAPH_COMMENT_DEFAULT_MIN_SPACING_SECONDS,
    )

    assert.equal(decision.allowed, false)
    assert.equal(decision.status, 'cooldown')
    assert.equal(decision.reason, 'min_spacing')
    assert.equal(decision.block_until, '2026-06-07T00:01:30.000Z')
})

test('Graph 368/rate/spam stop signals map to at least a two-hour block', () => {
    const now = Date.parse('2026-06-07T00:00:00.000Z')
    assert.deepEqual(detectGraphStopSignal({ code: 368, message: 'temporarily blocked' }), {
        stop: true,
        reason: 'policy_block_368',
    })
    assert.equal(detectGraphStopSignal({ code: 4, message: 'rate limit' }).stop, true)
    assert.equal(detectGraphStopSignal({ message: 'Too many spam comments, temporarily restricted' }).stop, true)

    const blockUntil = computeGraphCommentBlockUntil({ nowMs: now, minBlockSeconds: GRAPH_COMMENT_BLOCK_SECONDS })
    assert.ok(Date.parse(blockUntil) - now >= 2 * 60 * 60 * 1000)
})

test('Graph comment guard SQL stores page feature pacing and block state', () => {
    assert.match(GRAPH_COMMENT_GUARD_TABLE_SQL, /page_id TEXT NOT NULL/)
    assert.match(GRAPH_COMMENT_GUARD_TABLE_SQL, /feature TEXT NOT NULL/)
    assert.match(GRAPH_COMMENT_GUARD_TABLE_SQL, /last_comment_operation_at TEXT NOT NULL DEFAULT ''/)
    assert.match(GRAPH_COMMENT_GUARD_TABLE_SQL, /block_until TEXT NOT NULL DEFAULT ''/)
    assert.match(GRAPH_COMMENT_GUARD_TABLE_SQL, /block_reason TEXT NOT NULL DEFAULT ''/)
    assert.match(GRAPH_COMMENT_GUARD_TABLE_SQL, /PRIMARY KEY \(page_id, feature\)/)
})

test('Graph comment min spacing defaults to 60s and accepts bounded env override', () => {
    assert.equal(resolveGraphCommentMinSpacingSeconds(undefined), 60)
    assert.equal(resolveGraphCommentMinSpacingSeconds('90'), 90)
    assert.equal(resolveGraphCommentMinSpacingSeconds('0'), 0)
    assert.equal(resolveGraphCommentMinSpacingSeconds('99999'), 3600)
    assert.equal(resolveGraphCommentMinSpacingSeconds('bad'), 60)
})

test('real page-comment run clamps writes to one item while dry-run can keep requested batch', () => {
    assert.equal(resolveRunCommentBatchLimit({ writeMode: true, batchSize: 50, requestedLimit: 50 }), 1)
    assert.equal(resolveRunCommentBatchLimit({ writeMode: true, batchSize: 5, requestedLimit: undefined }), 1)
    assert.equal(resolveRunCommentBatchLimit({ writeMode: false, batchSize: 5, requestedLimit: 4 }), 4)
})

test('create_new remains blocked by default without explicit allow_create_new', () => {
    assert.equal(computeWriteAction({
        pageId: '1008898512617594',
        commentFromId: '',
        oldCommentId: '',
        hasRewriteableLink: true,
        allowCreateNew: false,
    }), 'skip')
    assert.equal(resolveCreateNewBlockedReason({
        pageId: '1008898512617594',
        commentFromId: '',
        oldCommentId: '',
        allowCreateNew: false,
    }), 'missing_existing_comment_id')
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

test('parseTrackingSubIds reads explicit sub1..sub4 customlink params', () => {
    const parsed = parseTrackingSubIds(
        'https://customlink.wwoom.com/?id=15130770000&sub1=spring&sub2=1277758961195466&sub3=1008898512617594&sub4=98765',
    )
    assert.equal(parsed.sub1, 'spring')
    assert.equal(parsed.sub2, '1277758961195466')
    assert.equal(parsed.sub3, '1008898512617594')
    assert.equal(parsed.sub4, '98765')
    assert.equal(parsed.sub5, '')
})

test('parseTrackingSubIds splits legacy shopee utm_content with trailing --', () => {
    const parsed = parseTrackingSubIds('https://shopee.co.th/product/1/2?utm_content=spring-post-page--')
    assert.equal(parsed.utm_content, 'spring-post-page--')
    assert.equal(parsed.sub1, 'spring')
    assert.equal(parsed.sub2, 'post')
    assert.equal(parsed.sub3, 'page')
    assert.equal(parsed.sub4, '')
    assert.equal(parsed.sub5, '')
})

test('parseTrackingSubIds reports sub4 from new shopee utm_content without sub5', () => {
    const parsed = parseTrackingSubIds('https://shopee.co.th/product/1/2?utm_content=spring-post-page-log987-')
    assert.equal(parsed.utm_content, 'spring-post-page-log987-')
    assert.equal(parsed.sub1, 'spring')
    assert.equal(parsed.sub2, 'post')
    assert.equal(parsed.sub3, 'page')
    assert.equal(parsed.sub4, 'log987')
    assert.equal(parsed.sub5, '')

    const compact = parseTrackingSubIds('https://shopee.co.th/product/1/2?utm_content=spring-post-page-log987')
    assert.equal(compact.sub4, 'log987')
    assert.equal(compact.sub5, '')
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

// The page-comment-link job item persists comment_target_id (aliased as
// page_story_object_id in responses) via resolveCanonicalCommentTarget. The
// canonical comment/post target MUST be the page-story object <page_id>_<post_id>.
// Bare Reel/video ids are metadata only and must never become registry/job/run/
// verify targets.
test('job item canonical target: reel_id + post_id => page_id_post_id (not the bare reel id)', () => {
    const target = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        postId: '1284990567138972',
        reelId: '998726829758584',
    })
    assert.equal(target.target, '1008898512617594_1284990567138972')
    assert.equal(target.pageStoryObjectId, '1008898512617594_1284990567138972')
    assert.equal(target.fallback, false)
    assert.notEqual(target.target, '998726829758584')
})

test('job item canonical target: missing post_id blocks instead of falling back to reel id', () => {
    const target = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        reelId: '998726829758584',
    })
    assert.equal(target.target, '')
    assert.equal(target.pageStoryObjectId, '')
    assert.equal(target.source, 'none')
    assert.equal(target.fallback, true)
    assert.match(target.reason, /missing_page_story_object_id/)
    assert.doesNotMatch(target.reason, /reel_id/)
})

test('buildTargetSubIds uses canonical post_id for sub2 when present', () => {
    const subs = buildTargetSubIds({
        requestedSub1: 'spring',
        pageId: '1008898512617594',
        canonicalPostId: '1008898512617594_1284990567138972',
        fbVideoId: '998726829758584',
        logId: 98765,
    })
    assert.equal(subs.sub1, 'spring')
    assert.equal(subs.sub2, '1284990567138972') // story tail of canonical post id
    assert.equal(subs.sub3, '1008898512617594')
    assert.equal(subs.sub4, '98765')
    assert.equal(subs.sub2_source, 'canonical_post_id')
    assert.equal(subs.reason, '')
})

test('buildTargetSubIds does not fall back to fb_video_id when post_id is missing', () => {
    const subs = buildTargetSubIds({
        requestedSub1: 'spring',
        pageId: '1008898512617594',
        canonicalPostId: '',
        fbVideoId: '998726829758584',
    })
    assert.equal(subs.sub2, '')
    assert.equal(subs.sub2_source, 'none')
    assert.ok(subs.reason.includes('missing_page_story_object_id'))
    assert.ok(!subs.reason.includes('sub2_fallback_fb_video_id'))
    assert.ok(!subs.reason.includes('sub2_fallback_reel_id'))
})

test('buildTargetSubIds reports missing sub2 when nothing resolves', () => {
    const subs = buildTargetSubIds({ requestedSub1: '', pageId: '', canonicalPostId: '', fbVideoId: '' })
    assert.equal(subs.sub2_source, 'none')
    assert.ok(subs.reason.includes('missing_sub1'))
    assert.ok(subs.reason.includes('missing_page_id'))
    assert.ok(subs.reason.includes('missing_sub2'))
    assert.ok(subs.reason.includes('missing_page_story_object_id'))
})

test('run/verify target gate requires a full page-story object and post_id tail', () => {
    assert.equal(resolvePageStoryRewriteBlockReason({
        commentTargetId: '1008898512617594_1284990567138972',
        targetSub2: '1284990567138972',
        targetSub3: '1008898512617594',
    }), '')
    assert.equal(resolvePageStoryRewriteBlockReason({
        commentTargetId: '1008898512617594_1284990567138972',
        postId: '1284990567138972',
        targetSub2: '1284990567138972',
        targetSub3: '1008898512617594',
    }), '')
    assert.equal(resolvePageStoryRewriteBlockReason({
        commentTargetId: '',
        postId: '',
        targetSub2: '',
        targetSub3: '1008898512617594',
    }), 'missing_page_story_object_id')
    assert.equal(resolvePageStoryRewriteBlockReason({
        commentTargetId: '998726829758584',
        postId: '',
        targetSub2: '998726829758584',
        targetSub3: '1008898512617594',
    }), 'missing_page_story_object_id')
    assert.equal(resolvePageStoryRewriteBlockReason({
        commentTargetId: '1008898512617594_998726829758584',
        postId: '',
        reelId: '998726829758584',
        targetSub2: '998726829758584',
        targetSub3: '1008898512617594',
    }), 'missing_page_story_object_id')
})

test('page comment planner does not fall back to raw or bare reel targets', () => {
    const withLedgerSource = indexFunctionSource(
        'async function planPageCommentLinkItemWithLedger',
        '// Normalise a registry-shaped input item',
    )
    assert.match(withLedgerSource, /const commentTargetId = canonical\.target/)
    assert.doesNotMatch(withLedgerSource, /canonical\.target\s*\|\|/)

    const plannerSource = indexFunctionSource(
        'function planPageCommentLinkItem',
        'type PageCommentLinkPlanItem',
    )
    assert.match(plannerSource, /const commentTargetId = canonicalTarget\.target/)
    assert.doesNotMatch(plannerSource, /canonicalTarget\.target\s*\|\|\s*str\(raw\.comment_target_id\)/)
    assert.doesNotMatch(plannerSource, /fallback to reel|reel fallback/i)
})

test('run and verify paths block missing page-story targets before live reads', () => {
    const runSource = indexFunctionSource(
        "app.post('/api/dashboard/page-comment-link-jobs/:job_id/run'",
        "app.post('/api/dashboard/page-comment-link-jobs/:job_id/verify'",
    )
    assert.match(runSource, /const verifyTarget = usedTarget \|\| canonicalVerify\.target/)
    assert.match(runSource, /const verifyBlockReason = resolvePageStoryRewriteBlockReason/)
    assert.ok(runSource.indexOf('const verifyBlockReason = resolvePageStoryRewriteBlockReason') < runSource.indexOf('fetchPageCommentsLive(verifyTarget, token)'))
    assert.doesNotMatch(runSource, /str\(row\.comment_target_id\)\s*\|\|\s*str\(row\.reel_id\)/)

    const verifySource = indexFunctionSource(
        "app.post('/api/dashboard/page-comment-link-jobs/:job_id/verify'",
        "app.get('/api/dashboard/page-comment-link-jobs/:job_id/history'",
    )
    assert.match(verifySource, /const canonicalVerifyTarget = resolveCanonicalCommentTarget/)
    assert.match(verifySource, /const pageStoryBlockReason = resolvePageStoryRewriteBlockReason/)
    assert.ok(verifySource.indexOf('const pageStoryBlockReason = resolvePageStoryRewriteBlockReason') < verifySource.indexOf('fetchPageCommentsLive(target, token)'))
    assert.doesNotMatch(verifySource, /str\(row\.comment_target_id\)\s*\|\|\s*str\(row\.reel_id\)/)
})

test('Shopee comment posting dedup and target selection are story-only', () => {
    const dedupSource = indexFunctionSource(
        'async function findExistingAffiliateComment',
        '// Confirm the comment we just POSTed',
    )
    assert.match(dedupSource, /else\s*\{\s*return null\s*\}/)
    assert.doesNotMatch(dedupSource, /resolveCommentTargetIdViaGraph\(\{/)
    assert.doesNotMatch(dedupSource, /buildCommentTargetCandidates\(/)

    const strictSource = indexFunctionSource(
        'async function postShopeeCommentStrict',
        'async function postShopeeCommentWithFallback',
    )
    assert.match(strictSource, /candidateList\.length === 0[\s\S]*missing_page_story_object_id/)
    assert.doesNotMatch(strictSource, /comment_target_missing/)
    assert.doesNotMatch(strictSource, /reel fallback|fallback to reel/i)

    const subSource = indexFunctionSource(
        'function buildPostingCommentShortlinkSubIds',
        'function isManagedShortlinkTransientFailure',
    )
    assert.match(subSource, /Shopee comment shortlink sub2 missing: missing_page_story_object_id/)
    assert.doesNotMatch(subSource, /fb_video_id[\s\S]*reel_id[\s\S]*unavailable/)
    assert.doesNotMatch(subSource, /fallback/i)
})

test('post history comment targets do not fall back to bare post ids', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    assert.doesNotMatch(source, /visibleCandidates\[0\]\s*\|\|\s*fbPostId(?:Raw)?/)
})

test('resolveEffectiveTargetSub4 preserves persisted sub4 and falls back to log/history ids', () => {
    assert.equal(resolveEffectiveTargetSub4({ target_sub4: '25831', log_id: 'fallback' }), '25831')
    assert.equal(resolveEffectiveTargetSub4({ target_sub4: '', log_id: 25831 }), '25831')
    assert.equal(resolveEffectiveTargetSub4({ targetSub4: null, history_id: 'hist42' }), 'hist42')
    assert.equal(resolveEffectiveTargetSub4({ post_history_id: 'ph99' }), 'ph99')
    assert.equal(resolveEffectiveTargetSub4({}), '')
})

test('page comment job item schema persists log_id and target_sub4 for preview to run', () => {
    assert.match(PAGE_COMMENT_LINK_JOB_ITEMS_TABLE_SQL, /log_id TEXT NOT NULL DEFAULT ''/)
    assert.match(PAGE_COMMENT_LINK_JOB_ITEMS_TABLE_SQL, /target_sub4 TEXT NOT NULL DEFAULT ''/)
})

test('dry-run customlink path includes fallback sub4 from log_id', () => {
    const targetSub4 = resolveEffectiveTargetSub4({ target_sub4: '', log_id: 25831 })
    const requestUrl = buildCustomlinkRequestUrl({
        productUrl: 'https://shopee.co.th/product/1/2',
        sub1: '1JUN26FBSPCAD',
        sub2: '1294666126171416',
        sub3: '1008898512617594',
        sub4: targetSub4,
    })
    const parsed = new URL(requestUrl)
    assert.equal(parsed.searchParams.get('sub4'), '25831')
    assert.equal(buildExpectedUtmContent({
        sub1: '1JUN26FBSPCAD',
        sub2: '1294666126171416',
        sub3: '1008898512617594',
        sub4: targetSub4,
    }), '1JUN26FBSPCAD-1294666126171416-1008898512617594-25831-')
})

// ---------------------------------------------------------------------------
// Durable per-page-story ledger id — guarantees a non-empty target_sub4/log_id
// for EVERY rewrite item, including cache/manual/imported posts that have no
// post_history.id. Regression guard for the 2026-05-16 batch that minted
// utm_content with an empty slot 4 (`...-<post_id>-<page_id>--`).
// ---------------------------------------------------------------------------

test('page_post_link_ledger schema has an autoincrement id and durable metadata columns', () => {
    assert.match(PAGE_POST_LINK_LEDGER_TABLE_SQL, /id INTEGER PRIMARY KEY AUTOINCREMENT/)
    assert.match(PAGE_POST_LINK_LEDGER_TABLE_SQL, /comment_target_id TEXT NOT NULL DEFAULT ''/)
    assert.match(PAGE_POST_LINK_LEDGER_TABLE_SQL, /page_story_object_id TEXT NOT NULL DEFAULT ''/)
    for (const col of [
        'page_id', 'fb_video_id', 'reel_id', 'post_id', 'comment_id', 'posted_at', 'source',
        'old_shortlink', 'new_shortlink', 'old_utm_content', 'new_utm_content',
        'old_affiliate_id', 'new_affiliate_id',
        'target_sub1', 'target_sub2', 'target_sub3', 'target_sub4',
        'status', 'last_audited_at', 'last_rewrite_at', 'last_verified_at',
    ]) {
        assert.ok(PAGE_POST_LINK_LEDGER_TABLE_SQL.includes(col), `ledger schema missing column ${col}`)
    }
})

test('resolveRewriteLogId prefers an existing durable id, else the ledger id, else empty', () => {
    assert.equal(resolveRewriteLogId({ existing: '25831', ledgerId: 7 }), '25831')
    assert.equal(resolveRewriteLogId({ existing: '', ledgerId: 7 }), '7')
    assert.equal(resolveRewriteLogId({ existing: '  ', ledgerId: '42' }), '42')
    assert.equal(resolveRewriteLogId({ existing: '', ledgerId: '' }), '')
    assert.equal(resolveRewriteLogId({ existing: '', ledgerId: null }), '')
})

test('cache item without post_history id gets a ledger id and a populated target_sub4', async () => {
    // In-memory ledger: a stable autoincrement id per (page_id, comment_target_id),
    // standing in for the D1 page_post_link_ledger autoincrement. No Facebook, no DB.
    const seen = new Map()
    let next = 0
    const store = {
        resolveId: async (key) => {
            const k = `${key.pageId}::${key.commentTargetId}`
            if (!seen.has(k)) seen.set(k, ++next)
            return seen.get(k)
        },
    }
    // A 2026-05-16 cache/manual row: full page-story target, but NO log_id /
    // history_id / post_history_id — exactly the shape that minted the empty slot 4.
    const raw: Record<string, unknown> = {
        page_id: '1008898512617594',
        fb_video_id: '1294666126171416',
        reel_id: '1294666126171416',
        post_id: '1234567890',
        comment_target_id: '1008898512617594_1234567890',
        comment_id: '1008898512617594_1234567890_999',
    }
    assert.equal(resolveEffectiveTargetSub4(raw), '', 'precondition: no durable id on the raw cache row')

    const logId = await ensureRewriteLogId(raw, {
        pageId: '1008898512617594',
        commentTargetId: '1008898512617594_1234567890',
        store,
    })
    assert.equal(logId, '1', 'cache item must receive a durable ledger id, never empty')

    const subs = buildTargetSubIds({
        requestedSub1: '1JUN26FBSPCAD',
        pageId: '1008898512617594',
        canonicalPostId: '1008898512617594_1234567890',
        fbVideoId: '1294666126171416',
        reelId: '1294666126171416',
        logId,
    })
    assert.equal(subs.sub4, '1')
    const utm = buildExpectedUtmContent(subs)
    assert.equal(utm, '1JUN26FBSPCAD-1234567890-1008898512617594-1-')
    assert.ok(!utm.endsWith('--'), 'utm_content must never carry an empty slot 4')

    // Idempotent: the same page-story target keeps the same ledger id (no churn).
    const again = await ensureRewriteLogId(raw, {
        pageId: '1008898512617594',
        commentTargetId: '1008898512617594_1234567890',
        store,
    })
    assert.equal(again, '1')
})

test('ensureRewriteLogId prefers an existing post_history id over allocating a ledger id', async () => {
    let called = 0
    const store = { resolveId: async () => { called++; return 999 } }
    const logId = await ensureRewriteLogId(
        { log_id: 25831 },
        { pageId: '1008898512617594', commentTargetId: '1008898512617594_123', store },
    )
    assert.equal(logId, '25831')
    assert.equal(called, 0, 'store must not be touched when a durable post_history id already exists')
})

test('ensureRewriteLogId returns empty when no durable id and no stable target to key on', async () => {
    const store = { resolveId: async () => 5 }
    assert.equal(await ensureRewriteLogId({}, { pageId: '1008898512617594', commentTargetId: '', store }), '')
    assert.equal(await ensureRewriteLogId({}, { pageId: '1008898512617594', commentTargetId: 'P_1', store: null }), '')
})

test('real run refuses to mint when target_sub4 is empty and a comment target/id is known', () => {
    assert.equal(resolveRealRewriteRefusal({
        targetSub4: '', commentTargetId: '1008898512617594_1234567890', oldCommentId: '', commentId: '',
    }), 'missing_target_sub4')
    assert.equal(resolveRealRewriteRefusal({
        targetSub4: '', commentTargetId: '', oldCommentId: '', commentId: '1008898512617594_1234567890_9',
    }), 'missing_target_sub4')
    assert.equal(resolveRealRewriteRefusal({
        targetSub4: '', commentTargetId: '', oldCommentId: '1008898512617594_1234567890_9', commentId: '',
    }), 'missing_target_sub4')
    // A populated target_sub4 (post_history id OR ledger id) clears the refusal.
    assert.equal(resolveRealRewriteRefusal({
        targetSub4: '25831', commentTargetId: '1008898512617594_1234567890', oldCommentId: '', commentId: '',
    }), '')
    // No target/comment to key on at all → not refused on this basis.
    assert.equal(resolveRealRewriteRefusal({
        targetSub4: '', commentTargetId: '', oldCommentId: '', commentId: '',
    }), '')
})

test('page_story_object_id stays the full <page_id>_<post_id> used to key the ledger', () => {
    const canonical = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        postId: '1234567890',
        canonicalPostId: '',
        reelId: '1294666126171416',
        existingTarget: '',
    })
    assert.equal(canonical.target, '1008898512617594_1234567890')
    assert.equal(canonical.fallback, false)
})

test('target affiliate id stays the numeric 15130770000 for the rewrite', () => {
    assert.equal(resolveTargetAffiliateId(), '15130770000')
    assert.equal(resolveTargetAffiliateId('an_15130770000'), '15130770000')
    assert.equal(resolveTargetAffiliateId('garbage-token'), '15130770000')
    assert.equal(parseAffiliateId('https://customlink.wwoom.com/?id=15130770000&url=x'), '15130770000')
})

test('buildCustomlinkRequestUrl targets customlink host with default id and subs', () => {
    const url = buildCustomlinkRequestUrl({
        productUrl: 'https://shopee.co.th/product/1/2',
        sub1: 'spring',
        sub2: '1284990567138972',
        sub3: '1008898512617594',
        sub4: '98765',
    })
    const parsed = new URL(url)
    assert.equal(parsed.hostname, CUSTOMLINK_HOST)
    assert.equal(parsed.searchParams.get('id'), CUSTOMLINK_DEFAULT_ID)
    assert.equal(parsed.searchParams.get('url'), 'https://shopee.co.th/product/1/2')
    assert.equal(parsed.searchParams.get('sub1'), 'spring')
    assert.equal(parsed.searchParams.get('sub2'), '1284990567138972')
    assert.equal(parsed.searchParams.get('sub3'), '1008898512617594')
    assert.equal(parsed.searchParams.get('sub4'), '98765')
    assert.equal(parsed.searchParams.has('sub5'), false)
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

test('buildExpectedUtmContent preserves legacy trailing -- without sub4', () => {
    assert.equal(buildExpectedUtmContent({ sub1: 'a', sub2: 'b', sub3: 'c' }), 'a-b-c--')
})

test('buildExpectedUtmContent renders sub4/log_id and leaves sub5 empty', () => {
    assert.equal(buildExpectedUtmContent({ sub1: 'a', sub2: 'b', sub3: 'c', sub4: 'log987' }), 'a-b-c-log987-')
})

test('verifyRewrittenShortlink confirms matching utm_content sub ids', () => {
    const expected = { sub1: 'spring', sub2: 'post123', sub3: 'page456', sub4: 'log987' }
    const ok = verifyRewrittenShortlink(
        'https://shopee.co.th/product/1/2?utm_content=spring-post123-page456-log987-',
        expected,
    )
    assert.equal(ok.ok, true)
    assert.equal(ok.utm_content, 'spring-post123-page456-log987-')
    assert.equal(ok.sub4, 'log987')
    assert.equal(ok.expected_utm_content, 'spring-post123-page456-log987-')
    assert.equal(ok.reason, '')

    const mismatch = verifyRewrittenShortlink(
        'https://shopee.co.th/product/1/2?utm_content=spring-WRONG-page456-log987-',
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

test('computeWriteAction defaults to edit-only and blocks create without explicit override', () => {
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: 'P', oldCommentId: 'P_123', hasRewriteableLink: true,
    }), 'edit')
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: 'OTHER', oldCommentId: 'OTHER_123', hasRewriteableLink: true,
    }), 'skip')
    assert.equal(resolveCreateNewBlockedReason({
        pageId: 'P', commentFromId: 'OTHER', oldCommentId: 'OTHER_123', allowCreateNew: false,
    }), 'non_page_comment')
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: '', oldCommentId: '', hasRewriteableLink: true,
    }), 'skip')
    assert.equal(resolveCreateNewBlockedReason({
        pageId: 'P', commentFromId: '', oldCommentId: '', allowCreateNew: false,
    }), 'missing_existing_comment_id')
    assert.equal(computeWriteAction({
        pageId: 'P', commentFromId: '', oldCommentId: '', hasRewriteableLink: true, allowCreateNew: true,
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

// --- Affiliate id tracking --------------------------------------------------

test('parseAffiliateId reads the customlink id= param (digits only, fail-closed)', () => {
    assert.equal(parseAffiliateId('https://customlink.wwoom.com/?id=15130770000&url=x'), '15130770000')
    assert.equal(parseAffiliateId('https://customlink.wwoom.com/?id=an_15130770000'), '15130770000')
    assert.equal(parseAffiliateId('https://customlink.wwoom.com/?id=https%3A%2F%2Fexample.com'), '')
    // The minted short code form has no id= param → nothing to read here.
    assert.equal(parseAffiliateId('https://customlink.wwoom.com/abcDEF'), '')
})

test('parseAffiliateId reads Shopee an_<id> from utm_source / mmp_pid', () => {
    assert.equal(
        parseAffiliateId('https://shopee.co.th/product/1/2?mmp_pid=an_15130770000&utm_source=an_15130770000'),
        '15130770000',
    )
    assert.equal(parseAffiliateId('https://shopee.co.th/product/1/2?utm_source=an_99999'), '99999')
    assert.equal(parseAffiliateId('https://shopee.co.th/product/1/2?mmp_pid=an_77777'), '77777')
})

test('parseAffiliateId fails closed for missing / non-affiliate / non-numeric markers', () => {
    assert.equal(parseAffiliateId('https://shopee.co.th/product/1/2'), '')
    assert.equal(parseAffiliateId('https://shopee.co.th/product/1/2?utm_source=organic'), '')
    assert.equal(parseAffiliateId('https://shopee.co.th/product/1/2?mmp_pid=an_77777x'), '')
    // utm_campaign is intentionally NOT parsed: the shared extractor only treats
    // utm_source / mmp_pid as affiliate id sources, so this stays empty (safe).
    assert.equal(parseAffiliateId('https://shopee.co.th/product/1/2?utm_campaign=an_55555'), '')
    assert.equal(parseAffiliateId('not a url'), '')
})

test('resolveTargetAffiliateId defaults to the CHEARB customlink id, honours overrides', () => {
    assert.equal(resolveTargetAffiliateId(''), CUSTOMLINK_DEFAULT_ID)
    assert.equal(resolveTargetAffiliateId(undefined), CUSTOMLINK_DEFAULT_ID)
    assert.equal(resolveTargetAffiliateId(null), CUSTOMLINK_DEFAULT_ID)
    assert.equal(resolveTargetAffiliateId('25551212'), '25551212')
    assert.equal(resolveTargetAffiliateId('an_25551212'), '25551212')
    assert.equal(resolveTargetAffiliateId('mmp_pid=an_25551212'), CUSTOMLINK_DEFAULT_ID)
})

test('verifyAffiliateId flags match, mismatch and missing affiliate ids', () => {
    const match = verifyAffiliateId('https://shopee.co.th/product/1/2?mmp_pid=an_15130770000', '15130770000')
    assert.deepEqual(match, {
        new_affiliate_id: '15130770000', affiliate_id_match: true, affiliate_verify_status: 'verified',
    })

    const mismatch = verifyAffiliateId('https://shopee.co.th/product/1/2?utm_source=an_99999', '15130770000')
    assert.equal(mismatch.new_affiliate_id, '99999')
    assert.equal(mismatch.affiliate_id_match, false)
    assert.equal(mismatch.affiliate_verify_status, 'mismatch')

    const missing = verifyAffiliateId('https://shopee.co.th/product/1/2', '15130770000')
    assert.deepEqual(missing, {
        new_affiliate_id: '', affiliate_id_match: false, affiliate_verify_status: 'missing',
    })

    // No target id to compare against → never a false "verified".
    const noTarget = verifyAffiliateId('https://shopee.co.th/product/1/2?mmp_pid=an_15130770000', '')
    assert.equal(noTarget.affiliate_id_match, false)
    assert.equal(noTarget.affiliate_verify_status, 'mismatch')
})

test('page comment tables carry affiliate id tracking columns on registry and job items', () => {
    for (const sql of [PAGE_COMMENT_LINK_REGISTRY_TABLE_SQL, PAGE_COMMENT_LINK_JOB_ITEMS_TABLE_SQL]) {
        assert.match(sql, /old_affiliate_id TEXT NOT NULL DEFAULT ''/)
        assert.match(sql, /target_affiliate_id TEXT NOT NULL DEFAULT ''/)
        assert.match(sql, /new_affiliate_id TEXT NOT NULL DEFAULT ''/)
        assert.match(sql, /affiliate_verify_status TEXT NOT NULL DEFAULT ''/)
        assert.match(sql, /affiliate_id_match INTEGER NOT NULL DEFAULT 0/)
    }
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
