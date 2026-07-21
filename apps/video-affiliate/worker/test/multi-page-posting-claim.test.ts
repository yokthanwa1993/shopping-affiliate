import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Regression coverage for the namespace 1779705687536764750 posting selector.
// Contract after the 2026-06-21 incident:
//   1) normal cron/force-post must pick namespace-unposted videos first, so it
//      does not keep reusing clips another page already posted;
//   2) page-aware reuse is allowed only as an explicit fallback when there are
//      truly no namespace-unposted candidates, preserving the prior starvation
//      fix without making reused clips the default;
//   3) same-page duplicate prevention remains strict.
//
// These are source-level assertions (the worker's D1 helpers are not exported
// and there is no D1 mock in this suite), matching the established pattern in
// stale-posting-recovery.test.ts / recover-failed-history.test.ts. The one
// exception is buildFastGalleryPostingPageIndexes: it is a pure function, so
// its sliced source is additionally rewritten to plain JS and EXECUTED under a
// stubbed Math.random to prove the random page window covers the full
// candidate range (CHEARB 2026-07 starvation regression).

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

function getListCandidatesSource(): string {
    return sliceBetween(
        getSource(),
        'async function listFastGalleryPostingCandidatePage',
        '\nasync function claimFastGalleryVideoForPosting',
        'listFastGalleryPostingCandidatePage'
    )
}

function getPageIndexesSource(): string {
    return sliceBetween(
        getSource(),
        'function buildFastGalleryPostingPageIndexes',
        '\nasync function hydrateFastPostingCandidateSourceFingerprint',
        'buildFastGalleryPostingPageIndexes'
    )
}

function getHistoryCheckSource(): string {
    return sliceBetween(
        getSource(),
        'async function hasSuccessfulNamespacePostHistoryForVideo',
        '\nasync function listFastGalleryPostingCandidatePage',
        'hasSuccessfulNamespacePostHistoryForVideo'
    )
}

function getSourceFingerprintHistoryCheckSource(): string {
    return sliceBetween(
        getSource(),
        'async function getLatestSuccessfulNamespacePostHistoryForSourceFingerprint',
        '\nfunction isSuccessfulNamespaceSourceHistoryStaleForManualUnpost',
        'getLatestSuccessfulNamespacePostHistoryForSourceFingerprint'
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

// --- Executable harness for the pure page-index builder -----------------------
//
// The builder's body is deliberately plain JS; only the single-line signature
// carries TypeScript annotations. Rewriting that one known line lets the tests
// run the real production sampling logic instead of only asserting on source
// text. If the signature changes, the assert below fails loudly so the
// replacement is updated alongside it.

type FastGalleryPageIndexBuilder = (
    maxPages: number,
    postingOrder: string,
    availablePageCount?: number | null,
) => number[]

const PAGE_INDEX_BUILDER_TS_SIGNATURE =
    'function buildFastGalleryPostingPageIndexes(maxPages: number, postingOrder: NamespacePostingOrder, availablePageCount?: number | null): number[] {'
const PAGE_INDEX_BUILDER_JS_SIGNATURE =
    'function buildFastGalleryPostingPageIndexes(maxPages, postingOrder, availablePageCount) {'

function compilePageIndexBuilder(): FastGalleryPageIndexBuilder {
    const tsSource = getPageIndexesSource()
    assert.ok(
        tsSource.includes(PAGE_INDEX_BUILDER_TS_SIGNATURE),
        'page index builder must keep the single-line typed signature the executable harness rewrites'
    )
    const jsSource = tsSource.replace(PAGE_INDEX_BUILDER_TS_SIGNATURE, PAGE_INDEX_BUILDER_JS_SIGNATURE)
    const factory = new Function(`${jsSource}\nreturn buildFastGalleryPostingPageIndexes`)
    return factory() as FastGalleryPageIndexBuilder
}

function withStubbedRandom<T>(seed: number, run: () => T): T {
    const originalRandom = Math.random
    let state = seed >>> 0
    // Deterministic LCG (Numerical Recipes constants) so every run of the
    // suite samples identical "random" page windows.
    Math.random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 4294967296
    }
    try {
        return run()
    } finally {
        Math.random = originalRandom
    }
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

// --- Two-pass posting candidate pool -----------------------------------------
//
// Normal cron/force-post must choose namespace-fresh videos first. Page-aware
// reuse remains only as an explicit fallback so sibling pages are not starved
// when there are no fresh candidates left.

test('posting candidate pool has a namespace-unposted primary mode before posted fallback', () => {
    const listBody = getListCandidatesSource()
    assert.ok(
        listBody.includes("mode === 'namespace_unposted'"),
        'candidate query must branch on namespace_unposted mode'
    )
    assert.ok(
        listBody.includes('AND NOT (${DASHBOARD_GALLERY_POSTED_SQL})'),
        'primary candidate query must require namespace-unposted rows'
    )
    assert.ok(
        listBody.includes('AND (${DASHBOARD_GALLERY_POSTED_SQL})'),
        'fallback candidate query must be restricted to namespace-posted rows'
    )
})

test('posting selector avoids page-aware SQL subqueries in the hot path', () => {
    const source = getSource()
    const listBody = getListCandidatesSource()
    assert.ok(!source.includes('countFastGalleryPostingCandidates'), 'runtime selector must not keep the dead COUNT helper')
    assert.ok(!source.includes('PAGE_SCOPED_ALREADY_POSTED_SQL'), 'runtime selector must not use expensive page-aware subquery predicate')
    assert.ok(!source.includes('pageScopedAlreadyPostedBinds'), 'runtime selector must not bind page-aware subqueries')
    assert.match(listBody, /mode: FastGalleryPostingCandidateMode/, 'list params must include selection mode')
    assert.match(
        listBody,
        /\.bind\(params\.namespaceId,\s*params\.limit,\s*params\.offset\)/,
        'list query bind order must only be namespaceId, limit, offset'
    )
})

test('claimFastGalleryVideoForPosting keeps strict same-page guard outside the selector', () => {
    const body = getClaimFastSource()
    assert.ok(
        !body.includes('countFastGalleryPostingCandidates('),
        'claimFast must NOT run COUNT(*) before selecting; production D1 can exceed CPU'
    )
    const listCall = sliceBetween(body, 'listFastGalleryPostingCandidatePage({', '})', 'list call')
    assert.match(listCall, /\bmode\b/, 'claimFast must pass mode to the candidate lister')
    assert.ok(
        body.includes('ensurePagePostedVideoGuardsTable('),
        'claimFast must ensure the page_posted_video_guards table exists before claim-level duplicate checks'
    )
    assert.match(
        body,
        /claimGalleryVideoForPosting\(\{[\s\S]*pageId,[\s\S]*videos: \[candidate\]/,
        'claimFast must pass pageId into the strict same-page claim guard'
    )
})

test('claimFastGalleryVideoForPosting scans namespace-fresh before reuse fallback and only falls back after exhaustion', () => {
    const body = getClaimFastSource()
    const primaryIdx = body.indexOf("scanCandidateMode('namespace_unposted')")
    const fallbackIdx = body.indexOf("scanCandidateMode('page_reuse_fallback')")
    assert.notEqual(primaryIdx, -1, 'claimFast must run namespace_unposted primary pass')
    assert.notEqual(fallbackIdx, -1, 'claimFast must keep a page_reuse_fallback pass')
    assert.ok(primaryIdx < fallbackIdx, 'namespace_unposted pass must run before page_reuse_fallback')
    assert.match(
        body,
        /if \(!namespaceFreshScan\.exhausted \|\| namespaceFreshScan\.candidateRows > 0\) return finish\(null\)/,
        'claimFast must not fall back to reused clips unless the namespace-fresh pass was exhausted and empty'
    )
    assert.match(body, /gallery_index_namespace_unposted/, 'stats/log source must expose namespace-unposted mode')
    assert.match(body, /gallery_index_page_reuse_fallback/, 'stats/log source must expose fallback reuse mode')
})

test('claimFastGalleryVideoForPosting uses visible ready inventory for the primary pass', () => {
    const body = getClaimFastSource()
    const loadIdx = body.indexOf('const loadVisibleReadyPostingCandidates')
    const inventoryIdx = body.indexOf('getNamespaceGalleryInventory(params.env, namespaceId)', loadIdx)
    const readyFilterIdx = body.indexOf('isNamespaceGalleryVideoDisplayReady', inventoryIdx)
    const unpostedFilterIdx = body.indexOf('!isNamespaceGalleryVideoPosted', readyFilterIdx)
    const orderIdx = body.indexOf('orderGalleryVideosForPosting(readyVideos, params.postingOrder)', unpostedFilterIdx)
    const scanIdx = body.indexOf("scanCandidateMode('namespace_unposted')")

    assert.notEqual(loadIdx, -1, 'claimFast must define the visible-ready inventory loader')
    assert.ok(inventoryIdx > loadIdx, 'primary pool must load the same namespace inventory as Gallery')
    assert.ok(readyFilterIdx > inventoryIdx, 'primary pool must use Gallery display-ready semantics')
    assert.ok(unpostedFilterIdx > readyFilterIdx, 'primary pool must exclude Gallery posted items')
    assert.ok(orderIdx > unpostedFilterIdx, 'primary pool must apply the configured posting order to visible-ready items')
    assert.ok(scanIdx > orderIdx, 'visible-ready candidates must be prepared before the primary scan')
    assert.match(body, /gallery_ready_namespace_unposted/, 'stats/log source must distinguish visible-ready primary mode')
})

test('namespace-unposted scan slices visible ready candidates instead of raw gallery_index SQL', () => {
    const body = getClaimFastSource()
    const primarySliceIdx = body.indexOf("mode === 'namespace_unposted'\n                ? visibleReadyPostingCandidates.slice(offset, offset + pageSize)")
    const rawSqlIdx = body.indexOf('await listFastGalleryPostingCandidatePage({', primarySliceIdx)
    const fallbackIdx = body.indexOf("scanCandidateMode('page_reuse_fallback')")

    assert.notEqual(primarySliceIdx, -1, 'namespace_unposted scan must page through visibleReadyPostingCandidates')
    assert.ok(rawSqlIdx > primarySliceIdx, 'raw SQL candidate lister must be only the fallback branch')
    assert.ok(fallbackIdx > primarySliceIdx, 'reuse fallback must remain after visible-ready primary scan')
})

test('claimFastGalleryVideoForPosting treats seen fresh rows as no-fallback even when none claim', () => {
    const source = getSource()
    const body = getClaimFastSource()
    const guardIdx = body.indexOf('namespaceFreshScan.candidateRows > 0')
    const fallbackIdx = body.indexOf("scanCandidateMode('page_reuse_fallback')")

    assert.match(
        source,
        /type FastGalleryPostingScanResult = \{[\s\S]*candidateRows: number[\s\S]*\}/,
        'scan result must carry how many rows the active pass fetched'
    )
    assert.match(body, /let candidateRows = 0/, 'scan pass must initialize candidateRows')
    assert.match(body, /candidateRows \+= page\.length/, 'scan pass must count fetched fresh rows')
    assert.match(
        body,
        /return \{ picked: null, exhausted: exhaustedAfterPageIndex !== null, candidateRows \}/,
        'scan pass must report exhaustion separately from whether rows existed'
    )
    assert.ok(guardIdx !== -1 && guardIdx < fallbackIdx, 'fresh-row no-fallback guard must run before fallback scan')
})

test('namespace-unposted primary pass hydrates source_fingerprint before claim eligibility', () => {
    const body = getClaimFastSource()
    const hydrateIdx = body.indexOf('await hydrateFastPostingCandidateSourceFingerprint({')
    const sourceFingerprintIdx = body.indexOf('const sourceFingerprint = normalizeNamespaceVideoSourceFingerprint', hydrateIdx)
    const sourceHistoryIdx = body.indexOf('getLatestSuccessfulNamespacePostHistoryForSourceFingerprint', sourceFingerprintIdx)
    const claimIdx = body.indexOf('const picked = await claimGalleryVideoForPosting({', sourceHistoryIdx)

    assert.notEqual(hydrateIdx, -1, 'primary scan must hydrate candidate source_fingerprint')
    assert.ok(sourceFingerprintIdx > hydrateIdx, 'candidate source_fingerprint must be read after hydration')
    assert.ok(sourceHistoryIdx > sourceFingerprintIdx, 'source history eligibility must use the hydrated fingerprint')
    assert.ok(claimIdx > sourceHistoryIdx, 'source history eligibility must run before claimGalleryVideoForPosting')
    assert.match(
        body,
        /if \(mode === 'namespace_unposted' && sourceFingerprint\)/,
        'source-fingerprint history guard must apply to the namespace_unposted primary pass'
    )
})

test('namespace-unposted primary pass blocks successful duplicate sources before selecting raw rows', () => {
    const historyBody = getSourceFingerprintHistoryCheckSource()
    const claimBody = getClaimFastSource()
    const sourceHistoryIdx = claimBody.indexOf('getLatestSuccessfulNamespacePostHistoryForSourceFingerprint')
    const skipIdx = claimBody.indexOf('!isSuccessfulNamespaceSourceHistoryStaleForManualUnpost', sourceHistoryIdx)
    const claimIdx = claimBody.indexOf('const picked = await claimGalleryVideoForPosting({', sourceHistoryIdx)

    assert.match(historyBody, /FROM post_history ph/, 'source guard must read post_history')
    assert.match(historyBody, /ph\.bot_id = \?/, 'source guard must be namespace-scoped')
    assert.match(historyBody, /ph\.status = 'success'/, 'source guard must require successful history')
    assert.match(historyBody, /ph\.source_fingerprint/, 'source guard must use post_history source_fingerprint')
    assert.match(historyBody, /nvs\.source_fingerprint/, 'source guard must hydrate older history rows through namespace_video_state')
    assert.doesNotMatch(
        historyBody,
        /AND\s+ph\.video_id\s*=\s*\?/,
        'source guard must not only check exact video_id'
    )
    assert.doesNotMatch(historyBody, /ph\.page_id = \?/, 'source guard must not be page-scoped')
    assert.ok(skipIdx > sourceHistoryIdx && skipIdx < claimIdx, 'duplicate source skip must happen before claim selection')
})

test('page reuse fallback remains exact-video namespace success after the primary pass', () => {
    const claimBody = getClaimFastSource()
    const primaryIdx = claimBody.indexOf("scanCandidateMode('namespace_unposted')")
    const fallbackIdx = claimBody.indexOf("scanCandidateMode('page_reuse_fallback')")
    const fallbackBlock = sliceBetween(
        claimBody,
        "if (mode === 'page_reuse_fallback') {",
        '\n                await hydrateFastPostingCandidateSourceFingerprint',
        'page_reuse_fallback block'
    )

    assert.ok(primaryIdx !== -1 && fallbackIdx !== -1 && primaryIdx < fallbackIdx, 'fallback scan must stay after the primary scan')
    assert.match(
        fallbackBlock,
        /hasSuccessfulNamespacePostHistoryForVideo/,
        'fallback must still require real namespace success for the exact video_id'
    )
    assert.doesNotMatch(
        fallbackBlock,
        /getLatestSuccessfulNamespacePostHistoryForSourceFingerprint/,
        'source-fingerprint duplicate guard must not replace the fallback exact-video success check'
    )
})

test('source-fingerprint duplicate guard stays bounded and avoids page-aware hot SQL', () => {
    const listBody = getListCandidatesSource()
    const claimBody = getClaimFastSource()
    const historyBody = getSourceFingerprintHistoryCheckSource()

    assert.doesNotMatch(listBody, /SELECT\s+COUNT\(\*\)/i, 'candidate lister must not run COUNT(*)')
    assert.doesNotMatch(claimBody, /SELECT\s+COUNT\(\*\)/i, 'claimFast must not reintroduce COUNT(*)')
    assert.doesNotMatch(historyBody, /COUNT\(\*\)/i, 'source guard must not count history rows')
    assert.match(historyBody, /LIMIT 1/, 'source guard must use a bounded existence lookup')
    assert.doesNotMatch(historyBody, /page_id\s*=\s*\?/, 'source guard must not add a page-aware subquery')
})

test('random posting order uses bounded random page windows without COUNT', () => {
    const pageIndexBody = getPageIndexesSource()
    const claimBody = getClaimFastSource()
    assert.match(pageIndexBody, /postingOrder !== 'random'/, 'non-random order must keep sequential pages')
    assert.match(pageIndexBody, /Math\.random\(\)/, 'random order must shuffle bounded page windows')
    assert.match(
        claimBody,
        /const pageIndexes = buildFastGalleryPostingPageIndexes\(maxPages, params\.postingOrder, availablePageCount\)/,
        'claimFast must use bounded page indexes instead of COUNT-derived random offsets'
    )
    assert.match(
        claimBody,
        /if \(!namespaceFreshScan\.exhausted \|\| namespaceFreshScan\.candidateRows > 0\) return finish\(null\)/,
        'bounded random scans must return no pick when they lack proof of an empty fresh pool'
    )
})

// --- Full-range random page window (CHEARB 2026-07 starvation regression) -----
//
// With 8,786 fresh candidates (pageSize 24 → 367 pages) the legacy builder only
// ever emitted indexes 0..14, so the tick considered offsets 0..359 forever and
// starved once that fixed head window was fully blocked by duplicate guards.
// Random mode must now sample bounded distinct indexes across the WHOLE known
// page range, while the SQL fallback (unknown total, COUNT(*) forbidden) keeps
// the legacy window.

test('in-memory fresh pass feeds the full available page count into random sampling', () => {
    const claimBody = getClaimFastSource()
    assert.match(
        claimBody,
        /const availablePageCount = mode === 'namespace_unposted'\s*\?\s*Math\.ceil\(visibleReadyPostingCandidates\.length \/ pageSize\)\s*:\s*null/,
        'namespace_unposted must derive availablePageCount from the loaded in-memory pool; the SQL fallback must pass null'
    )
    assert.doesNotMatch(
        getListCandidatesSource(),
        /COUNT\s*\(/i,
        'deriving the page range must not reintroduce COUNT into the candidate lister'
    )
})

test('random page window samples the full in-memory range (8786 candidates, pageSize 24, maxPages 15)', () => {
    const buildPageIndexes = compilePageIndexBuilder()
    const availablePageCount = Math.ceil(8786 / 24) // 367 pages, matching the live CHEARB pool
    let sawBeyondLegacyWindow = false
    for (let seed = 1; seed <= 25; seed += 1) {
        const pages = withStubbedRandom(seed * 2654435761, () => buildPageIndexes(15, 'random', availablePageCount))
        assert.equal(pages.length, 15, 'random mode must return exactly maxPages indexes')
        assert.equal(new Set(pages).size, pages.length, 'random page indexes must be unique')
        for (const pageIndex of pages) {
            assert.ok(Number.isInteger(pageIndex), 'page indexes must be integers')
            assert.ok(
                pageIndex >= 0 && pageIndex < availablePageCount,
                `page index ${pageIndex} must stay inside 0..${availablePageCount - 1}`
            )
        }
        if (pages.some((pageIndex) => pageIndex > 14)) sawBeyondLegacyWindow = true
    }
    assert.ok(sawBeyondLegacyWindow, 'full-range sampling must reach page indexes beyond the legacy 0..14 window')
})

test('random page window caps at maxPages and covers every page of a small pool', () => {
    const buildPageIndexes = compilePageIndexBuilder()
    const smallPool = withStubbedRandom(1337, () => buildPageIndexes(15, 'random', 3))
    assert.deepEqual(
        [...smallPool].sort((a, b) => a - b),
        [0, 1, 2],
        'a 3-page pool must shuffle exactly pages 0..2 without inventing indexes'
    )
    assert.deepEqual(
        withStubbedRandom(7, () => buildPageIndexes(15, 'random', 0)),
        [0],
        'a known-empty pool must still probe page 0 so the scan can observe exhaustion for the reuse fallback'
    )
})

test('random page window without a known pool size keeps the legacy shuffled 0..14 window', () => {
    const buildPageIndexes = compilePageIndexBuilder()
    const legacyWindow = withStubbedRandom(42, () => buildPageIndexes(15, 'random'))
    assert.deepEqual(
        [...legacyWindow].sort((a, b) => a - b),
        Array.from({ length: 15 }, (_, index) => index),
        'unknown pool size (SQL fallback) must keep exactly the pages 0..14'
    )
    assert.ok(
        legacyWindow.some((pageIndex, position) => pageIndex !== position),
        'legacy window must still be shuffled, not sequential'
    )
})

test('sequential posting orders ignore availablePageCount and stay 0..maxPages-1', () => {
    const buildPageIndexes = compilePageIndexBuilder()
    for (const order of ['oldest_first', 'newest_first']) {
        const pages = withStubbedRandom(99, () => buildPageIndexes(15, order, 367))
        assert.deepEqual(
            pages,
            Array.from({ length: 15 }, (_, index) => index),
            `${order} must keep sequential page indexes 0..14 even when the pool is larger`
        )
    }
})

test('reuse fallback requires a real namespace success history row', () => {
    const historyBody = getHistoryCheckSource()
    const claimBody = getClaimFastSource()
    assert.match(historyBody, /FROM post_history/, 'fallback history check must read post_history')
    assert.match(historyBody, /status = 'success'/, 'fallback history check must require success')
    assert.match(
        historyBody,
        /video_id = \?/,
        'fallback history check must key on exact video_id'
    )
    assert.match(
        claimBody,
        /mode === 'page_reuse_fallback'[\s\S]*hasSuccessfulNamespacePostHistoryForVideo/,
        'fallback must skip namespace-posted rows that have no real success history'
    )
})

test('claimFastGalleryVideoForPosting reports candidateTotal as fetched bounded-window rows', () => {
    const body = getClaimFastSource()
    assert.match(body, /stats\.candidateTotal = 0/, 'each pass must reset candidateTotal')
    assert.match(body, /stats\.candidateTotal \+= page\.length/, 'candidateTotal must count fetched bounded-window rows')
    assert.match(body, /stats\.scanned = 0/, 'each pass must reset scanned count')
    assert.match(body, /stats\.pages = 0/, 'each pass must reset page count')
})
