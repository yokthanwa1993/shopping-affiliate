import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildExistingCommentDedupCandidates,
    buildPostingCommentTargetCandidates,
    buildVisibleCommentTargetCandidates,
    extractIdFromCommentTargetInput,
    isAffiliateCommentMatch,
    resolveCanonicalCommentTarget,
} from '../src/comment-targeting.js'

test('story-first: bare fb_post_id + pageId composes the visible page-story target, EXCLUDING the reel id', () => {
    // Mirrors the live bug: bot 1774858894802785816 / page 1008898512617594 / fb_post_id 1284990567138972
    // / fb_reel_url /reel/998726829758584/. When a page-story exists the reel object
    // id is never a candidate — no read/write/verify may touch it (Thanwa's rule).
    const candidates = buildVisibleCommentTargetCandidates({
        pageId: '1008898512617594',
        fbPostId: '1284990567138972',
        fbReelUrlOrId: '/reel/998726829758584/',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
    ])
    assert.ok(!candidates.includes('998726829758584'), 'reel id must be excluded when a page-story exists')
})

test('full pageid_storyid fb_post_id is used as-is and the reel id is excluded', () => {
    const candidates = buildVisibleCommentTargetCandidates({
        pageId: '1008898512617594',
        fbPostId: '1008898512617594_1284990567138972',
        fbReelUrlOrId: '998726829758584',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
    ])
    assert.ok(!candidates.includes('998726829758584'), 'reel id must be excluded when a page-story exists')
})

test('full pageid_storyid with mismatched pageId still emits page-prefixed normalized form', () => {
    const candidates = buildVisibleCommentTargetCandidates({
        pageId: '999000111222333',
        fbPostId: '1008898512617594_1284990567138972',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '999000111222333_1284990567138972',
        '1284990567138972',
    ])
})

test('missing pageId still emits the bare fb_post_id and still excludes the reel id', () => {
    const candidates = buildVisibleCommentTargetCandidates({
        fbPostId: '1284990567138972',
        fbReelUrlOrId: 'https://www.facebook.com/reel/998726829758584/',
    })

    assert.deepEqual(candidates, ['1284990567138972'])
    assert.ok(!candidates.includes('998726829758584'), 'reel id must be excluded when a page-story exists')
})

test('only reel url with no post id falls back to bare reel id', () => {
    const candidates = buildVisibleCommentTargetCandidates({
        pageId: '1008898512617594',
        fbReelUrlOrId: 'https://www.facebook.com/reel/998726829758584/',
    })

    assert.deepEqual(candidates, ['998726829758584'])
})

test('empty input produces empty list', () => {
    assert.deepEqual(buildVisibleCommentTargetCandidates({}), [])
})

test('posting candidates: fbPostId keeps write path story-only even when initial target is a bare reel id', () => {
    const candidates = buildPostingCommentTargetCandidates({
        pageId: '1008898512617594',
        fbPostId: '1284990567138972',
        fbReelUrlOrId: 'https://www.facebook.com/reel/998726829758584/',
        initialTargetId: '998726829758584',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
    ])
    assert.ok(!candidates.includes('998726829758584'), 'bare reel fallback must not be in write candidates when page-story exists')
    assert.ok(!candidates.includes('1008898512617594_998726829758584'), 'legacy page-prefixed reel candidate must not be appended')
})

test('posting candidates: no post_id/page-story preserves bare reel fallback candidates', () => {
    const candidates = buildPostingCommentTargetCandidates({
        pageId: '1008898512617594',
        fbReelUrlOrId: 'https://www.facebook.com/reel/998726829758584/',
        initialTargetId: '998726829758584',
    })

    assert.deepEqual(candidates, [
        '998726829758584',
        '1008898512617594_998726829758584',
    ])
})

test('extractIdFromCommentTargetInput parses common Graph permalink shapes', () => {
    assert.equal(extractIdFromCommentTargetInput('/reel/998726829758584/'), '998726829758584')
    assert.equal(extractIdFromCommentTargetInput('https://www.facebook.com/reel/998726829758584'), '998726829758584')
    assert.equal(extractIdFromCommentTargetInput('https://www.facebook.com/watch/?v=12345'), '12345')
    assert.equal(extractIdFromCommentTargetInput('998726829758584'), '998726829758584')
    assert.equal(extractIdFromCommentTargetInput('1008898512617594_1284990567138972'), '1008898512617594_1284990567138972')
    assert.equal(extractIdFromCommentTargetInput(''), '')
})

test('isAffiliateCommentMatch returns true when the just-posted comment id appears verbatim', () => {
    const result = isAffiliateCommentMatch(
        [{ id: '1284990567138972_555000', message: 'irrelevant text' }],
        { commentId: '1284990567138972_555000' },
    )
    assert.equal(result.matched, true)
    assert.equal(result.matchedBy, 'comment_id')
})

test('isAffiliateCommentMatch matches when the listing returns suffix-style id (parent_commentid)', () => {
    const result = isAffiliateCommentMatch(
        [{ id: '1008898512617594_1284990567138972_555000', message: 'random' }],
        { commentId: '1284990567138972_555000' },
    )
    assert.equal(result.matched, true)
    assert.equal(result.matchedBy, 'comment_id_suffix')
})

test('isAffiliateCommentMatch matches by shopee host in message even without comment_id', () => {
    const result = isAffiliateCommentMatch(
        [{ id: 'other_999', message: 'ลิงก์ที่ฝากกันค่ะ https://s.shopee.co.th/abc' }],
        {},
    )
    assert.equal(result.matched, true)
    assert.equal(result.matchedBy, 'message')
})

test('isAffiliateCommentMatch returns no match when target shows unrelated comments only', () => {
    const result = isAffiliateCommentMatch(
        [{ id: '1', message: 'hi' }, { id: '2', message: 'first!' }],
        { commentId: '1284990567138972_555000' },
    )
    assert.equal(result.matched, false)
})

test('isAffiliateCommentMatch handles null/empty listings without throwing', () => {
    assert.equal(isAffiliateCommentMatch(null, { commentId: 'x' }).matched, false)
    assert.equal(isAffiliateCommentMatch([], { commentId: 'x' }).matched, false)
})

test('dedup: when fb_post_id exists, reel/video target is EXCLUDED so a stray reel comment cannot skip posting to the story', () => {
    // Live regression: row already has affiliate comment on reel 998726829758584
    // but the visible page-story 1008898512617594_1284990567138972 has nothing.
    // Admin retry must NOT see the reel comment as proof.
    const candidates = buildExistingCommentDedupCandidates({
        pageId: '1008898512617594',
        fbPostId: '1284990567138972',
        fbReelUrlOrId: '/reel/998726829758584/',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
    ])
    assert.ok(!candidates.includes('998726829758584'), 'reel id must not be a dedup candidate when story exists')
})

test('dedup: full pageid_storyid fb_post_id still excludes reel id', () => {
    const candidates = buildExistingCommentDedupCandidates({
        pageId: '1008898512617594',
        fbPostId: '1008898512617594_1284990567138972',
        fbReelUrlOrId: '998726829758584',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
    ])
})

test('dedup: no fb_post_id falls back to reel/video candidate (legacy behavior)', () => {
    const candidates = buildExistingCommentDedupCandidates({
        pageId: '1008898512617594',
        fbReelUrlOrId: 'https://www.facebook.com/reel/998726829758584/',
    })

    assert.deepEqual(candidates, ['998726829758584'])
})

test('dedup: empty input returns empty list', () => {
    assert.deepEqual(buildExistingCommentDedupCandidates({}), [])
})

// --- Canonical page-story comment target -----------------------------------

test('canonical target: reel_id + post_id resolves to <page_id>_<post_id>, NOT the reel id', () => {
    // The core invariant. Live shape: page 1008898512617594 / post_id (numeric tail)
    // 1284990567138972 / reel object 998726829758584. The page-story object wins.
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        postId: '1284990567138972',
        reelId: '998726829758584',
    })
    assert.equal(result.target, '1008898512617594_1284990567138972')
    assert.equal(result.pageStoryObjectId, '1008898512617594_1284990567138972')
    assert.equal(result.postTail, '1284990567138972')
    assert.equal(result.source, 'page_story_object')
    assert.equal(result.fallback, false)
    assert.equal(result.reason, '')
    assert.notEqual(result.target, '998726829758584')
})

test('canonical target: a bare reel reel_url is still upgraded to the page-story when post_id exists', () => {
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        postId: '1284990567138972',
        reelId: 'https://www.facebook.com/reel/998726829758584/',
        existingTarget: '998726829758584', // a stale bare reel target must NOT be kept
    })
    assert.equal(result.target, '1008898512617594_1284990567138972')
    assert.equal(result.fallback, false)
})

test('canonical target: a WRITTEN/legacy row (new_comment_id) with a stored bare reel + post_id still resolves to the page-story, not the reel', () => {
    // Regression for loadPageCommentLinkJobItems: a row that already has a
    // new_comment_id used to keep its stored comment_target_id verbatim, so a
    // legacy bare reel target survived even when post_id/page-story existed and the
    // verify endpoint then re-read the wrong (reel) object. The load function now
    // makes this exact resolution call unconditionally — `new_comment_id` no longer
    // short-circuits it — so the response target must be `<page_id>_<post_id>`.
    const storedBareReelTarget = '998726829758584' // legacy comment_target_id on a written row
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        postId: '1284990567138972',
        reelId: '998726829758584',
        existingTarget: storedBareReelTarget,
    })
    // canonical.fallback is false, so loadPageCommentLinkJobItems uses canonical.target.
    assert.equal(result.fallback, false)
    assert.equal(result.target, '1008898512617594_1284990567138972')
    assert.equal(result.pageStoryObjectId, '1008898512617594_1284990567138972')
    assert.equal(result.source, 'page_story_object')
    assert.notEqual(result.target, storedBareReelTarget)
})

test('canonical target: full canonical_post_id is used as-is', () => {
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        canonicalPostId: '1008898512617594_1284990567138972',
        postId: '1284990567138972',
        reelId: '998726829758584',
    })
    assert.equal(result.target, '1008898512617594_1284990567138972')
    assert.equal(result.source, 'canonical_post_id')
    assert.equal(result.fallback, false)
})

test('canonical target: bare canonical_post_id composes <page_id>_<post_id>', () => {
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        canonicalPostId: '1284990567138972',
        reelId: '998726829758584',
    })
    assert.equal(result.target, '1008898512617594_1284990567138972')
    assert.equal(result.source, 'canonical_post_id')
})

test('canonical target: missing post_id falls back to the reel id with a visible reason', () => {
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        reelId: 'https://www.facebook.com/reel/998726829758584/',
    })
    assert.equal(result.target, '998726829758584')
    assert.equal(result.pageStoryObjectId, '')
    assert.equal(result.postTail, '')
    assert.equal(result.source, 'reel_id')
    assert.equal(result.fallback, true)
    assert.match(result.reason, /comment_target_fallback_reel_id/)
    assert.match(result.reason, /page_story_object_missing/)
})

test('canonical target: existing full page-story id is honoured when no post_id is given', () => {
    const result = resolveCanonicalCommentTarget({
        pageId: '1008898512617594',
        existingTarget: '1008898512617594_1284990567138972',
        reelId: '998726829758584',
    })
    assert.equal(result.target, '1008898512617594_1284990567138972')
    assert.equal(result.source, 'existing_full_story')
    assert.equal(result.fallback, false)
})

test('canonical target: missing pageId still prefers the bare post id over the reel', () => {
    const result = resolveCanonicalCommentTarget({
        postId: '1284990567138972',
        reelId: '998726829758584',
    })
    assert.equal(result.target, '1284990567138972')
    assert.equal(result.fallback, false)
    assert.equal(result.source, 'page_story_object')
})

test('canonical target: nothing resolvable reports source none and a missing reason', () => {
    const result = resolveCanonicalCommentTarget({})
    assert.equal(result.target, '')
    assert.equal(result.source, 'none')
    assert.equal(result.fallback, true)
    assert.match(result.reason, /page_story_object_missing/)
})
