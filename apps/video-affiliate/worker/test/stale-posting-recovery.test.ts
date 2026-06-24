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

function getRecoverHelperSource(): string {
    return sliceBetween(
        getSource(),
        'async function recoverStalePostingAttemptsForPage',
        '\nasync function ensureLinkSubmissionsTable',
        'recoverStalePostingAttemptsForPage'
    )
}

function getForcePostRouteSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/api/pages/:id/force-post'",
        '\n// ==================== MANUAL REEL POST',
        'force-post route'
    )
}

function getRetryPostRouteSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/api/post-history/:id/retry-post'",
        "\napp.get('/api/pages/:id/history'",
        'retry-post route'
    )
}

test('recoverStalePostingAttemptsForPage helper exists with safe invariants', () => {
    const body = getRecoverHelperSource()

    // Only fails rows that are actually stuck posting.
    assert.match(body, /status = 'posting'/, 'must only target posting rows')
    // Never clobbers a row that already published.
    assert.match(body, /TRIM\(COALESCE\(fb_post_id, ''\)\) = ''/, 'must require empty fb_post_id')
    // Bounded by a posted_at threshold.
    assert.match(body, /datetime\(posted_at\) < datetime\('now', \?\)/, 'must bound by posted_at age')
    // Scoped to a single namespace + page.
    assert.match(body, /bot_id = \?/, 'must scope to namespace')
    assert.match(body, /page_id = \?/, 'must scope to page')
    // Marks the row failed with a clear non-secret reason.
    assert.match(body, /status = 'failed'/, 'must mark the row failed')
    assert.match(body, /stale_posting_timeout_no_fb_post_id/, 'must use the documented default reason')
    assert.match(body, /comment_status = 'not_attempted'/, 'must reset comment status')
    // Lock cleanup is scoped to the page scope and stale locks only.
    assert.match(body, /DELETE FROM posting_locks/, 'must clean stale page lock')
    assert.match(body, /scope = 'page'/, 'lock cleanup must be page-scoped')
    assert.match(body, /datetime\(created_at\) < datetime\('now', \?\)/, 'lock cleanup must be age-bounded')
})

test('default recovery threshold gives Facebook Lite /video_reels enough processing headroom', () => {
    const source = getSource()
    assert.match(
        source,
        /const STALE_POSTING_RECOVERY_THRESHOLD_MINUTES = 15\b/,
        'STALE_POSTING_RECOVERY_THRESHOLD_MINUTES must be 15'
    )
})

test('Facebook Lite /video_reels upload is timeout-bounded, not a raw fetch that can leave posting rows stuck', () => {
    const source = getSource()
    const body = sliceBetween(
        source,
        'async function publishReelDirectWithTokenFallback',
        '\nasync function publishReelWithCommentTokenPrimaryFallback',
        'publishReelDirectWithTokenFallback'
    )

    assert.match(body, /fetchWithTimeout\(uploadUrl,/, 'video_reels upload must use fetchWithTimeout')
    assert.match(body, /facebook_reel_upload/, 'timeout label must identify the Facebook reel upload step')
    assert.doesNotMatch(body, /await fetch\(uploadUrl,/, 'video_reels upload must not use raw fetch')
})

test('force-post recovers stale posting rows before acquiring the page lock', () => {
    const body = getForcePostRouteSource()
    const recoverIdx = body.indexOf('recoverStalePostingAttemptsForPage')
    const lockIdx = body.indexOf('tryAcquirePostingLock')
    assert.notEqual(recoverIdx, -1, 'force-post must call recoverStalePostingAttemptsForPage')
    assert.notEqual(lockIdx, -1, 'force-post must still acquire the page lock')
    assert.ok(recoverIdx < lockIdx, 'recovery must run before acquiring the page lock')
})

test('retry-post recovers stale posting rows before its active-posting query', () => {
    const body = getRetryPostRouteSource()
    const recoverIdx = body.indexOf('recoverStalePostingAttemptsForPage')
    const activeIdx = body.indexOf('const activePosting')
    assert.notEqual(recoverIdx, -1, 'retry-post must call recoverStalePostingAttemptsForPage')
    assert.notEqual(activeIdx, -1, 'retry-post must still guard on active posting')
    assert.ok(recoverIdx < activeIdx, 'recovery must run before the active-posting guard')
})

test('scheduled cron recovers stale posting rows before the min-gap guard', () => {
    const source = getSource()
    const cronRecoverIdx = source.indexOf("reason: 'stale_posting_timeout_no_fb_post_id_cron'")
    assert.notEqual(cronRecoverIdx, -1, 'cron must call recoverStalePostingAttemptsForPage')
    const minGapIdx = source.indexOf('Universal min-gap guard', cronRecoverIdx)
    assert.notEqual(minGapIdx, -1, 'cron min-gap guard must follow the recovery call')
    assert.ok(cronRecoverIdx < minGapIdx, 'recovery must run before the min-gap guard')
})
