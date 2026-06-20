import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Regression coverage for the namespace 1779705687536764750 multi-page posting
// starvation: pages in one namespace share ONE gallery. The claim path used to
// dedup against post_history (and namespace_video_state) namespace-wide, so once
// the primary page posted a video, every sibling page saw it (or any freshly
// uploaded duplicate sharing its source_fingerprint) as "already posted" and
// got "No unposted gallery video left" even though their per-page history was
// empty. Per-page dedup must come from ensurePageVideoNeverPosted (page-scoped
// post_history + page guards), never from a namespace-wide block.
//
// These are source-level assertions (the worker's D1 helpers are not exported
// and there is no D1 mock in this suite), matching the established pattern in
// stale-posting-recovery.test.ts / recover-failed-history.test.ts.

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

function getClaimGalleryVideoSource(): string {
    return sliceBetween(
        getSource(),
        'async function claimGalleryVideoForPosting',
        '\nasync function ensurePageVideoNeverPosted',
        'claimGalleryVideoForPosting'
    )
}

function getEnsurePageVideoNeverPostedSource(): string {
    return sliceBetween(
        getSource(),
        'async function ensurePageVideoNeverPosted',
        '\nfunction hasGalleryVideoThumbnail',
        'ensurePageVideoNeverPosted'
    )
}

function getPageScopedHistoryRowSource(): string {
    return sliceBetween(
        getSource(),
        'async function getLatestSuccessfulPostHistoryRow',
        '\nasync function',
        'getLatestSuccessfulPostHistoryRow'
    )
}

function getPageScopedAlreadyPostedSql(): string {
    return sliceBetween(
        getSource(),
        'const PAGE_SCOPED_ALREADY_POSTED_SQL = `',
        '\n`',
        'PAGE_SCOPED_ALREADY_POSTED_SQL'
    )
}

function getCountCandidatesSource(): string {
    return sliceBetween(
        getSource(),
        'async function countFastGalleryPostingCandidates',
        '\nasync function listFastGalleryPostingCandidatePage',
        'countFastGalleryPostingCandidates'
    )
}

function getListCandidatesSource(): string {
    return sliceBetween(
        getSource(),
        'async function listFastGalleryPostingCandidatePage',
        '\nasync function claimFastGalleryVideoForPosting',
        'listFastGalleryPostingCandidatePage'
    )
}

function getClaimFastSource(): string {
    return sliceBetween(
        getSource(),
        'async function claimFastGalleryVideoForPosting',
        '\nasync function getSystemGalleryPageFast',
        'claimFastGalleryVideoForPosting'
    )
}

test('claim path no longer blocks siblings via namespace-wide post_history dedup', () => {
    const body = getClaimGalleryVideoSource()

    // The cross-page post_history query (status IN ('success','posting') keyed on
    // bot_id without page_id) is the starvation source. It must be gone.
    assert.doesNotMatch(
        body,
        /status IN \('success', 'posting'\)/,
        'claim must NOT run a namespace-wide post_history dedup query'
    )
    assert.ok(
        !body.includes('existingNamespacePost'),
        'claim must NOT reference existingNamespacePost'
    )
    assert.ok(
        !body.includes('ensureNamespaceVideoNeverPosted('),
        'claim must NOT call ensureNamespaceVideoNeverPosted'
    )
})

test('claim path enforces per-page duplicate prevention', () => {
    const body = getClaimGalleryVideoSource()
    assert.ok(
        body.includes('ensurePageVideoNeverPosted('),
        'claim must still enforce per-page dedup via ensurePageVideoNeverPosted'
    )
})

test('claim path never seeds a page guard from a sibling page row', () => {
    const body = getClaimGalleryVideoSource()
    // Seeding recordPagePostedVideoGuard for the CURRENT page off another page's
    // post_history row is exactly what permanently (and falsely) starved siblings.
    assert.ok(
        !body.includes('recordPagePostedVideoGuard('),
        'claim must NOT write page guards off a sibling page post_history row'
    )
})

test('claim path no longer re-applies namespace-wide posted_at guards', () => {
    const body = getClaimGalleryVideoSource()
    // namespace_video_state.posted_at is set the moment ANY page posts a video.
    // Re-checking it in the claim path (isNamespaceGalleryVideoPosted /
    // getFreshNamespacePostedState) re-starved sibling pages even after the
    // page-aware pool let the video through. Those guards must be gone from claim;
    // eligibility is owned by the page-aware pool + ensurePageVideoNeverPosted.
    assert.ok(
        !body.includes('getFreshNamespacePostedState('),
        'claim must NOT re-read namespace-wide posted_at via getFreshNamespacePostedState'
    )
    assert.ok(
        !body.includes('isNamespaceGalleryVideoPosted('),
        'claim must NOT gate on the namespace-wide isNamespaceGalleryVideoPosted flag'
    )
})

test('claim path still serialises same-video races with the video-scoped lock', () => {
    const body = getClaimGalleryVideoSource()
    assert.ok(
        body.includes('tryAcquirePostingLock('),
        'claim must still acquire a posting lock'
    )
    assert.match(
        body,
        /scope:\s*'video'/,
        'claim must acquire the video-scoped posting lock'
    )
})

test('per-page dedup remains page-scoped (page A history does not block page B)', () => {
    // ensurePageVideoNeverPosted reads the latest successful row via
    // getLatestSuccessfulPostHistoryRow, which MUST filter on page_id. This is
    // what keeps a video posted to page A claimable for page B while still
    // blocking page A from re-posting it.
    const rowBody = getPageScopedHistoryRowSource()
    assert.match(rowBody, /ph\.page_id = \?/, 'per-page history lookup must filter on page_id')
    assert.match(rowBody, /ph\.bot_id = \?/, 'per-page history lookup must still scope to the namespace')
    // It must still also catch a freshly-uploaded duplicate on the SAME page by
    // source_fingerprint, so page A cannot re-post the same content twice.
    assert.match(
        rowBody,
        /source_fingerprint/,
        'per-page history lookup must still dedup by source_fingerprint within the page'
    )
})

test('manual unpost still allows an intended repost', () => {
    const body = getEnsurePageVideoNeverPostedSource()
    assert.match(body, /manual_unposted_at/, 'per-page dedup must read manual_unposted_at')
    assert.match(body, /historyIsStale/, 'a post older than manual_unposted_at must be treated as stale (repost allowed)')
    assert.match(body, /guardIsStale/, 'a guard older than manual_unposted_at must be treated as stale (repost allowed)')
})

test('dead namespace-wide dedup helpers are fully removed', () => {
    const source = getSource()
    assert.ok(
        !source.includes('async function ensureNamespaceVideoNeverPosted'),
        'ensureNamespaceVideoNeverPosted must be removed (no longer called anywhere)'
    )
    assert.ok(
        !source.includes('getLatestSuccessfulNamespacePostHistoryRow'),
        'getLatestSuccessfulNamespacePostHistoryRow must be removed (was only used by the deleted helper)'
    )
})

// --- Page-aware candidate pool (the second half of the starvation fix) ---------
//
// Before: force-post/cron candidate pool used `AND NOT (DASHBOARD_GALLERY_POSTED_SQL)`,
// which keys on the namespace-wide nvs.posted_at. The instant page A posted a
// video, markNamespaceVideoPosted set nvs.posted_at and the exact video_id
// vanished from EVERY sibling page's pool BEFORE the page-scoped claim checks ran
// — so empty sibling pages got "No unposted gallery video left" even with ready
// videos. The pool is now page-aware: it excludes a candidate only if the TARGET
// page already posted it, never just because a sibling did.

test('posting candidate pool no longer filters on the namespace-wide posted_at flag', () => {
    const countBody = getCountCandidatesSource()
    const listBody = getListCandidatesSource()
    for (const [label, body] of [['count', countBody], ['list', listBody]] as const) {
        assert.ok(
            !body.includes('DASHBOARD_GALLERY_POSTED_SQL'),
            `${label} candidate query must NOT use the namespace-wide DASHBOARD_GALLERY_POSTED_SQL`
        )
        assert.ok(
            body.includes('PAGE_SCOPED_ALREADY_POSTED_SQL'),
            `${label} candidate query must use the page-aware PAGE_SCOPED_ALREADY_POSTED_SQL`
        )
    }
})

test('posting candidate pool functions are page-aware (accept and bind pageId)', () => {
    const countBody = getCountCandidatesSource()
    const listBody = getListCandidatesSource()
    assert.match(countBody, /countFastGalleryPostingCandidates\(db: D1Database, namespaceId: string, pageId: string\)/, 'count must accept pageId')
    assert.match(listBody, /pageId: string/, 'list params must include pageId')
    assert.ok(countBody.includes('pageScopedAlreadyPostedBinds(namespaceId, pageId)'), 'count must bind the page-scoped predicate')
    assert.ok(listBody.includes('pageScopedAlreadyPostedBinds(params.namespaceId, params.pageId)'), 'list must bind the page-scoped predicate')
})

test('claimFastGalleryVideoForPosting threads pageId into the candidate pool', () => {
    const body = getClaimFastSource()
    assert.ok(
        body.includes('countFastGalleryPostingCandidates(params.env.DB, namespaceId, pageId)'),
        'claimFast must pass pageId to the candidate counter'
    )
    // The list call inside the scan loop must pass pageId too.
    const listCall = sliceBetween(body, 'listFastGalleryPostingCandidatePage({', '})', 'list call')
    assert.match(listCall, /\bpageId\b/, 'claimFast must pass pageId to the candidate lister')
    // The page_posted_video_guards table referenced by the predicate must be ensured.
    assert.ok(
        body.includes('ensurePagePostedVideoGuardsTable('),
        'claimFast must ensure the page_posted_video_guards table exists before querying it'
    )
})

test('page-aware predicate excludes only by THIS page (post_history + guards), keyed by page_id', () => {
    const sql = getPageScopedAlreadyPostedSql()
    // Page-scoped successful post_history.
    assert.match(sql, /FROM post_history ph\b/, 'predicate must check post_history')
    assert.match(sql, /ph\.page_id = \?/, 'post_history branch must be page-scoped')
    assert.match(sql, /ph\.status = 'success'/, 'post_history branch must only count successful posts')
    // Page-scoped guards.
    assert.match(sql, /FROM page_posted_video_guards g\b/, 'predicate must check page guards')
    assert.match(sql, /g\.page_id = \?/, 'guard branch must be page-scoped')
    // Both page-posted branches match by exact video_id OR source_fingerprint.
    assert.match(sql, /ph\.video_id = gi\.video_id/, 'post_history branch must match exact video_id')
    assert.match(sql, /g\.video_id = gi\.video_id/, 'guard branch must match exact video_id')
    assert.match(sql, /source_fingerprint/, 'predicate must also dedup by source_fingerprint within the page')
})

test('page-aware predicate honors manual_unposted_at (repost intent re-opens the video)', () => {
    const sql = getPageScopedAlreadyPostedSql()
    assert.match(sql, /nvs\.manual_unposted_at/, 'predicate must consult manual_unposted_at')
    // A post/guard older than the manual unpost must NOT exclude (allow repost).
    assert.match(
        sql,
        /CAST\(strftime\('%s', ph\.posted_at\) AS INTEGER\) <= CAST\(strftime\('%s', nvs\.manual_unposted_at\) AS INTEGER\)/,
        'post_history exclusion must be skipped when posted_at <= manual_unposted_at'
    )
    assert.match(
        sql,
        /CAST\(strftime\('%s', g\.created_at\) AS INTEGER\) <= CAST\(strftime\('%s', nvs\.manual_unposted_at\) AS INTEGER\)/,
        'guard exclusion must be skipped when guard created_at <= manual_unposted_at'
    )
})

test('page-aware predicate preserves the admin "mark all as posted" override', () => {
    const sql = getPageScopedAlreadyPostedSql()
    // The admin override branch keeps a video out for EVERY page only when
    // posted_at is set AND there is NO real post_history success row for it. A
    // genuine page-A post always has a post_history row, so that branch never
    // fires for "page A posted it" — keeping it claimable for siblings.
    assert.match(sql, /TRIM\(COALESCE\(nvs\.posted_at, ''\)\) <> ''/, 'admin-override branch must check posted_at')
    assert.match(
        sql,
        /NOT EXISTS \(\s*SELECT 1\s*FROM post_history ph2\s*WHERE ph2\.bot_id = \?\s*AND ph2\.status = 'success'\s*AND ph2\.video_id = gi\.video_id\s*\)/,
        'admin-override branch must only fire when NO real post_history success row exists'
    )
})
