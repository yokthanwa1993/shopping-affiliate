import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildExistingCommentDedupCandidates,
    buildVisibleCommentTargetCandidates,
    extractIdFromCommentTargetInput,
    isAffiliateCommentMatch,
} from '../src/comment-targeting.js'

test('story-first: bare fb_post_id + pageId composes the visible page-story target first', () => {
    // Mirrors the live bug: bot 1774858894802785816 / page 1008898512617594 / fb_post_id 1284990567138972
    // / fb_reel_url /reel/998726829758584/. The page-story target must be tried first.
    const candidates = buildVisibleCommentTargetCandidates({
        pageId: '1008898512617594',
        fbPostId: '1284990567138972',
        fbReelUrlOrId: '/reel/998726829758584/',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
        '998726829758584',
    ])
})

test('full pageid_storyid fb_post_id is used as-is and reel id is last', () => {
    const candidates = buildVisibleCommentTargetCandidates({
        pageId: '1008898512617594',
        fbPostId: '1008898512617594_1284990567138972',
        fbReelUrlOrId: '998726829758584',
    })

    assert.deepEqual(candidates, [
        '1008898512617594_1284990567138972',
        '1284990567138972',
        '998726829758584',
    ])
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

test('missing pageId still emits the bare fb_post_id', () => {
    const candidates = buildVisibleCommentTargetCandidates({
        fbPostId: '1284990567138972',
        fbReelUrlOrId: 'https://www.facebook.com/reel/998726829758584/',
    })

    assert.deepEqual(candidates, ['1284990567138972', '998726829758584'])
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
