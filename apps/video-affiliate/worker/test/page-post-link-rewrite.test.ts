import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseGraphCtaObject } from '../src/comment-link-registry.js'

function indexSlice(startMarker: string, endMarker: string): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf(startMarker)
    assert.ok(start > -1, `${startMarker} must exist`)
    const end = source.indexOf(endMarker, start)
    assert.ok(end > start, `${endMarker} must exist after ${startMarker}`)
    return source.slice(start, end)
}

const CHECK = "app.post('/api/dashboard/page-post-link-rewrite/check'"
const PREVIEW = "app.post('/api/dashboard/page-post-link-rewrite/preview'"
const RUN = "app.post('/api/dashboard/page-post-link-rewrite/run'"
const AFTER_RUN = "app.get('/api/dashboard/page-video-asset-winners'"

test('all three page-post-link-rewrite routes are registered', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    assert.ok(source.includes(CHECK), 'check route must exist')
    assert.ok(source.includes(PREVIEW), 'preview route must exist')
    assert.ok(source.includes(RUN), 'run route must exist')
})

test('run defaults dry_run true and only writes on explicit dry_run:false', () => {
    const runSource = indexSlice(RUN, AFTER_RUN)
    assert.match(runSource, /normalizeJobBool\(body\.dry_run,\s*true\)\s*===\s*false/)
    // The dry-run branch is the SAFE default path.
    assert.match(runSource, /if \(!writeMode \|\| !ctx\.has_token \|\| pageStoryBlockReason\)/)
    assert.match(runSource, /mode:\s*'run_dry'/)
})

test('run pins allow_create_new false default and a fixed one-post batch', () => {
    const runSource = indexSlice(RUN, AFTER_RUN)
    assert.match(runSource, /normalizeJobBool\(body\.allow_create_new,\s*false\)/)
    assert.match(runSource, /const batchSize = 1/)
})

test('preview defaults allow_create_new false and is read-only/dry_run', () => {
    const previewSource = indexSlice(PREVIEW, RUN)
    assert.match(previewSource, /normalizeJobBool\(body\.allow_create_new,\s*false\)/)
    assert.match(previewSource, /read_only:\s*true/)
    assert.match(previewSource, /dry_run:\s*true/)
    // Comment action is edit (never create); CTA action is update.
    assert.match(previewSource, /comment_action:\s*'edit'/)
    assert.match(previewSource, /cta_action:\s*'update'/)
})

test('comment read/write/verify keys off the full page-story object only', () => {
    // The shared read-only preflight reads comments from the canonical page-story
    // target (resolveCanonicalCommentTarget), never a bare reel/video id.
    const resolverSource = indexSlice(
        'async function resolvePagePostLinkRewriteContext',
        '// 1) READ-ONLY check',
    )
    assert.match(resolverSource, /const canonical = resolveCanonicalCommentTarget\(\{ pageId, postId \}\)/)
    assert.match(resolverSource, /fetchPageCommentsLive\(canonical\.target, base\.token\)/)
    assert.doesNotMatch(resolverSource, /buildVisibleCommentTargetCandidates/)

    const runSource = indexSlice(RUN, AFTER_RUN)
    // Verify re-reads the comment from the FULL page-story object.
    assert.match(runSource, /fetchPageCommentsLive\(ctx\.page_story_object_id, token\)/)
})

test('run edits the existing comment only — no create-comment fallback', () => {
    const runSource = indexSlice(RUN, AFTER_RUN)
    // Edit targets the existing comment id directly; fails closed otherwise.
    assert.match(runSource, /\$\{encodeURIComponent\(comment\.id\)\}/)
    assert.match(runSource, /return fail\('comment_missing'\)/)
    assert.match(runSource, /return fail\('non_page_comment'\)/)
    assert.match(runSource, /return fail\('old_comment_link_not_present'\)/)
    // No comment-create path: never POST to /comments, never reach for create helpers.
    assert.doesNotMatch(runSource, /graphCreateComment/)
    assert.doesNotMatch(runSource, /\/comments`/)
    assert.doesNotMatch(runSource, /buildVisibleCommentTargetCandidates/)
})

test('CTA update posts to the bare post tail; readback verifies the full page-story object', () => {
    const runSource = indexSlice(RUN, AFTER_RUN)
    // Update target is the bare post/video id tail.
    assert.match(runSource, /updatePagePostStoryCta\(ctx\.post_tail, ctaType, newShortlink, token\)/)
    // Readback reads the FULL page-story object.
    assert.match(runSource, /readPagePostStoryCta\(ctx\.page_story_object_id, token\)/)

    const updateHelper = indexSlice('async function updatePagePostStoryCta', 'type PagePostLinkParsedLink')
    // The CTA write is a POST to the bare id node (no /comments, no full-story PUT).
    assert.match(updateHelper, /method:\s*'POST'/)
    assert.match(updateHelper, /call_to_action/)
})

test('run mints + verifies the new shortlink before any Facebook write', () => {
    const runSource = indexSlice(RUN, AFTER_RUN)
    const mintIdx = runSource.indexOf('mintCustomlinkShortlink(requestUrl)')
    const verifyIdx = runSource.indexOf('verifyAffiliateId(expandedNewUrl, plan.customlinkId)')
    const commentWriteIdx = runSource.indexOf('encodeURIComponent(comment.id)')
    const ctaWriteIdx = runSource.indexOf('updatePagePostStoryCta(ctx.post_tail')
    assert.ok(mintIdx > -1 && verifyIdx > -1, 'mint + verify must exist')
    assert.ok(mintIdx < commentWriteIdx, 'mint must precede the comment write')
    assert.ok(verifyIdx < commentWriteIdx, 'shortlink verify must precede the comment write')
    assert.ok(verifyIdx < ctaWriteIdx, 'shortlink verify must precede the CTA write')
    // Stop on Graph block/rate/spam codes during writes.
    assert.match(runSource, /detectGraphStopSignal/)
    assert.match(runSource, /blockGraphCommentGuard/)
})

test('outbound sub4 stays blank while an internal log_id/effective_target_sub4 is exposed', () => {
    const previewSource = indexSlice(PREVIEW, RUN)
    assert.match(previewSource, /target_sub4:\s*'',/)
    assert.match(previewSource, /log_id:\s*plan\.logId/)
    assert.match(previewSource, /effective_target_sub4:\s*plan\.logId/)
    assert.match(previewSource, /sub4_policy:\s*PAGE_POST_LINK_SUB4_POLICY/)

    const runSource = indexSlice(RUN, AFTER_RUN)
    assert.match(runSource, /buildCustomlinkRequestUrl\(\{ productUrl: ctx\.product_url, sub1: targetSub1, sub2: targetSub2, sub3: targetSub3, sub4: '',/)
    assert.match(runSource, /verifyRewrittenShortlink\(expandedNewUrl, \{ sub1: targetSub1, sub2: targetSub2, sub3: targetSub3, sub4: '' \}\)/)
})

test('routes expose only redacted token metadata, never the raw token', () => {
    for (const [start, end] of [[CHECK, PREVIEW], [PREVIEW, RUN], [RUN, AFTER_RUN]] as Array<[string, string]>) {
        const slice = indexSlice(start, end)
        assert.match(slice, /facebookTokenDebugFields\(ctx\.tokenResolution\)/)
        assert.doesNotMatch(slice, /token:\s*token/)
        assert.doesNotMatch(slice, /token:\s*ctx\.token/)
        assert.doesNotMatch(slice, /access_token:\s*token/)
        assert.doesNotMatch(slice, /tokenResolution\.token\b(?!\.length)/)
    }
})

test('page_id resolves explicit first, then the old shortlink sub3, else blocks', () => {
    const resolverSource = indexSlice(
        'async function resolvePagePostLinkRewriteContext',
        '// 1) READ-ONLY check',
    )
    assert.match(resolverSource, /const pageId = explicitPage \|\| str\(oldParsed\.sub3\)/)
    assert.match(resolverSource, /return \{ \.\.\.base, error: 'page_id_required' \}/)
    assert.match(resolverSource, /return \{ \.\.\.base, error: 'post_id_required' \}/)
})

// --- Pure helper: parseGraphCtaObject ---------------------------------------

test('parseGraphCtaObject reads the {type,value:{link}} post-story CTA shape', () => {
    const cta = parseGraphCtaObject({ type: 'SHOP_NOW', value: { link: 'https://s.shopee.co.th/abc', title: 'Shop' } })
    assert.deepEqual(cta, { type: 'SHOP_NOW', title: 'Shop', url: 'https://s.shopee.co.th/abc' })
})

test('parseGraphCtaObject reads a flat title/link and url alias', () => {
    assert.deepEqual(parseGraphCtaObject({ type: 'LEARN_MORE', title: 'More', url: 'https://x.test/y' }), {
        type: 'LEARN_MORE', title: 'More', url: 'https://x.test/y',
    })
    assert.deepEqual(parseGraphCtaObject({ value: { url: 'https://x.test/z' } }), {
        type: '', title: '', url: 'https://x.test/z',
    })
})

test('parseGraphCtaObject returns null for empty / non-object input', () => {
    assert.equal(parseGraphCtaObject(null), null)
    assert.equal(parseGraphCtaObject(undefined), null)
    assert.equal(parseGraphCtaObject('SHOP_NOW'), null)
    assert.equal(parseGraphCtaObject({}), null)
    assert.equal(parseGraphCtaObject({ value: {} }), null)
})
