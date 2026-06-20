import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function getSource(): string {
    return readFileSync('src/index.ts', 'utf8')
}

function sliceBetween(source: string, startMarker: string, endMarker: string, label: string): string {
    const start = source.indexOf(startMarker)
    assert.notEqual(start, -1, `${label} start marker must exist`)
    const end = source.indexOf(endMarker, start + startMarker.length)
    assert.notEqual(end, -1, `${label} end marker must exist`)
    return source.slice(start, end)
}

function getCoreSource(): string {
    return sliceBetween(
        getSource(),
        'async function attemptFailedRowFeedRecovery',
        '\nasync function finishReelPublishWithRetry',
        'attemptFailedRowFeedRecovery'
    )
}

function getListSource(): string {
    return sliceBetween(
        getSource(),
        'async function listRecentPagePostsForRecovery',
        '\n// Canonical-owner-tolerant, multi-token candidate harvest',
        'listRecentPagePostsForRecovery'
    )
}

function getCollectSource(): string {
    return sliceBetween(
        getSource(),
        'async function collectRecoveryStoryCandidates',
        '\n// Shared core that recovers ONE failed post_history row',
        'collectRecoveryStoryCandidates'
    )
}

function getCronBatchSource(): string {
    return sliceBetween(
        getSource(),
        'async function recoverFailedHistoryRowsFromFeed',
        '\nfunction isVideoProcessingErrorMessage',
        'recoverFailedHistoryRowsFromFeed'
    )
}

function getAdminRouteSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/admin/api/post-history/:id/recover-from-feed'",
        "\napp.get('/admin/api/data'",
        'admin recover-from-feed route'
    )
}

function getNamespaceRouteSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/api/post-history/:id/recover-from-feed'",
        "\napp.post('/api/post-history/:id/retry-post'",
        'namespace recover-from-feed route'
    )
}

test('the failed-row recovery core uses the namespace token pool plus the sync token', () => {
    const body = getCoreSource()
    assert.match(body, /ensurePageTokenCandidates\(/, 'must resolve namespace token candidates')
    assert.match(body, /tokenCandidates\.postTokens/, 'must include post tokens')
    assert.match(body, /tokenCandidates\.commentTokens/, 'must include comment tokens (cloak-bridge posts have no stored post token)')
    assert.match(body, /resolveFacebookSyncToken\(/, 'must also try the gallery sync token')
})

test('recovery lists Reels via the reliable /posts edge, time-bounded with since/until', () => {
    const body = getListSource()
    // /feed silently omits Reels; /posts is the edge the gallery sync trusts.
    assert.match(body, /\['posts', 'feed'\]/, 'must query the /posts edge (and /feed as a secondary source)')
    assert.match(body, /since: String\(since\)/, 'must server-bound the scan with since')
    assert.match(body, /until: String\(until\)/, 'must server-bound the scan with until')
    // Comments must target the page-story tail, never the bare reel object id.
    assert.match(body, /fullStoryId\.split\('_'\)\.pop/, 'must derive the bare page-story tail from the full id')
    assert.match(body, /postHasVideoAttachment\(item\)/, 'must restrict candidates to video/reel posts')
})

test('candidate harvest is canonical-owner tolerant and never logs raw tokens', () => {
    const body = getCollectSource()
    assert.match(body, /resolveFacebookTokenActorId/, 'must resolve the token actor id')
    assert.match(body, /\[storedPageId, actorId\]/, 'must scan both the stored page id and the actor id')
    assert.doesNotMatch(body, /logPrefix:[^\n]*\$\{token\}/, 'must never log the raw token')
})

test('the core picks safely: caption is a soft preference, claims are skipped, comment is deferred', () => {
    const body = getCoreSource()
    // Caption match is a RANKING preference, not a veto (posted message may be AI-generated).
    assert.match(body, /captionMatches\(c\.message\)\) \|\| unclaimed\[0\]/, 'caption match must only rank, never veto')
    // Never steals a story id already claimed by a sibling row.
    assert.match(body, /isClaimed/, 'must skip already-claimed story ids')
    assert.match(body, /hasShopee \? 'pending' : 'not_configured'/, 'must queue the comment as pending for the backlog')
    assert.match(body, /status = 'success'/, 'must flip the row to success')
    // dry_run must never write.
    assert.match(body, /if \(params\.dryRun\)/, 'must support a non-writing dry run')
})

test('the cron backstop scans all namespaces and delegates to the shared core with a freshness gate', () => {
    const body = getCronBatchSource()
    assert.match(body, /attemptFailedRowFeedRecovery\(/, 'cron batch must delegate to the shared core')
    assert.match(body, /freshnessGuardMs: 60 \* 1000/, 'cron batch must keep a freshness gate')
    assert.match(body, /dryRun: false/, 'cron batch must write')
    assert.match(body, /ph\.status = 'failed'/, 'must only target failed rows')
    assert.match(body, /ph\.comment_status = 'not_attempted'/, 'must only touch rows whose comment never ran')
})

test('the targeted maintenance endpoint is admin-scoped, dry-run-by-default, and gated', () => {
    const body = getAdminRouteSource()
    assert.match(body, /c\.get\('botId'\)/, 'must be namespace-scoped via botId')
    assert.match(body, /const dryRun = !isExplicitFalse/, 'dry_run must default TRUE (write requires explicit false)')
    assert.match(body, /freshnessGuardMs: 0/, 'manual path must drop the freshness gate to repair historical rows')
    assert.match(body, /row_not_failed/, 'must refuse rows that are not failed')
    assert.match(body, /row_already_has_fb_post_id/, 'must refuse rows that already have an fb_post_id')
    assert.match(body, /attemptFailedRowFeedRecovery\(/, 'must reuse the shared recovery core')
})

test('the namespace-scoped route is botId-scoped and never reposts (delegates to the shared core)', () => {
    const body = getNamespaceRouteSource()
    assert.match(body, /c\.get\('botId'\)/, 'must be namespace-scoped via botId, like retry-post')
    assert.match(body, /attemptFailedRowFeedRecovery\(/, 'must reuse the shared recovery core, not repost')
    assert.match(body, /freshnessGuardMs: 0/, 'manual path must drop the freshness gate to repair historical rows')
    // It must not call the posting/publish path (that would create a duplicate).
    assert.doesNotMatch(body, /publishReel|createAd|finishReelPublishWithRetry|force-post/, 'must never repost')
})

test('the namespace route is dry-run-by-default and requires an exact id echo to write', () => {
    const body = getNamespaceRouteSource()
    assert.match(body, /const dryRun = !isExplicitFalse/, 'dry_run must default TRUE')
    // A write must require expected_fb_post_id up front...
    assert.match(body, /if \(!dryRun && !expectedFbPostId\)/, 'write must require expected_fb_post_id')
    assert.match(body, /expected_fb_post_id_required/, 'must reject a write with no expected id')
    // ...and the value is threaded into the core for the exact-match guard.
    assert.match(body, /expectedFbPostId,/, 'must pass expectedFbPostId to the core')
    assert.match(body, /error: 'expected_fb_post_id_mismatch'/, 'must surface a mismatch without writing')
    assert.match(body, /matched_fb_post_id: result\.fb_post_id/, 'mismatch response must reveal the matched id, not write it')
})

test('the namespace route refuses rows that are not safely recoverable', () => {
    const body = getNamespaceRouteSource()
    assert.match(body, /row_not_failed/, 'must refuse rows that are not failed')
    assert.match(body, /row_already_has_fb_post_id/, 'must refuse rows that already have an fb_post_id')
    assert.match(body, /comment_already_attempted/, 'must refuse rows whose comment was already attempted')
})

test('the shared core enforces the expected-fb_post_id write guard', () => {
    const body = getCoreSource()
    assert.match(body, /const expectedFbPostId = String\(params\.expectedFbPostId \|\| ''\)\.trim\(\)/, 'core must read the guard')
    assert.match(body, /if \(expectedFbPostId && expectedFbPostId !== recoveredPostId\)/, 'core must compare before writing')
    // The guard must sit AFTER the dry-run return and BEFORE the UPDATE.
    const dryIdx = body.indexOf('if (params.dryRun)')
    const guardIdx = body.indexOf("reason: 'expected_fb_post_id_mismatch'")
    const updateIdx = body.indexOf('UPDATE post_history')
    assert.ok(dryIdx !== -1 && guardIdx !== -1 && updateIdx !== -1, 'all markers present')
    assert.ok(dryIdx < guardIdx && guardIdx < updateIdx, 'guard must gate the write')
})

test('the cron scheduled handler wires in the failed-row recovery backstop', () => {
    const source = getSource()
    const wiredIdx = source.indexOf('recoverFailedHistoryRowsFromFeed({ env, logPrefix: ')
    assert.notEqual(wiredIdx, -1, 'scheduled() must invoke recoverFailedHistoryRowsFromFeed')
    const tag = source.indexOf('[CRON-RECOVER-FAILED]')
    assert.notEqual(tag, -1, 'recovery must run inside its own error-swallowing waitUntil')
})
