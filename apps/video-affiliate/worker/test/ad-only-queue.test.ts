import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    buildAdOnlyCreateBody,
    clampAdOnlyIntervalMinutes,
    isAdOnlyQueueDue,
    nextAdOnlyRunAtMs,
    AD_ONLY_QUEUE_ENDPOINT,
    DEFAULT_AD_ONLY_INTERVAL_MINUTES,
    MIN_AD_ONLY_INTERVAL_MINUTES,
    MAX_AD_ONLY_INTERVAL_MINUTES,
    AD_ONLY_AUTO_MIN_VIEWS,
    DEFAULT_DAILY_BUDGET_THB,
    DEFAULT_RUN_HOURS,
    buildAdOnlyUsedIdSet,
    buildAdOnlyUsedIdSetForBangkokDate,
    bangkokDateKey,
    filterAdOnlyHistoryRowsForBangkokDate,
    isAdOnlyCandidateEligible,
    isAdOnlyCandidateUsed,
    selectAdOnlyAutoCandidate,
    rankAdOnlyAutoCandidates,
    rankAdOnlyAutoCandidatesRandom,
    makeSeededRng,
    shuffleWithRng,
    buildAdOnlyAutoPickBody,
    adOnlyIdTail,
    isAdOnlyFatalError,
    buildAdOnlySkippedPageSet,
    AD_ONLY_FATAL_ERROR_SUBSTRINGS,
    AD_ONLY_PAGE_COOLDOWN_MS,
    AD_ONLY_AUTO_MAX_ATTEMPTS,
    type AdOnlyAutoCandidate,
} from '../src/ad-only-contract.js'

// The processor must replay queued rows through the AD-ONLY endpoint, never the legacy hybrid one.
test('queue processor targets the ad-only endpoint, never the legacy create-ad', () => {
    assert.equal(AD_ONLY_QUEUE_ENDPOINT, '/api/dashboard/create-ad-only')
    assert.notEqual(AD_ONLY_QUEUE_ENDPOINT, '/api/dashboard/create-ad')
})

test('buildAdOnlyCreateBody maps a queued row to the create-ad-only body and preserves the campaign date', () => {
    const body = buildAdOnlyCreateBody({
        page_id: 'P1',
        mode: 'active',
        daily_campaign_name: '18/Jun/2026',
        daily_budget_thb: '150',
        run_hours: '24',
        story_id: '111_222',
        fb_video_id: 'v9',
        system_video_id: 'sys-1',
        shopee_url: 'https://s.shopee.co.th/x',
        caption: 'hi',
        ad_name: 'sys-1',
    })
    assert.equal(body.page_id, 'P1')
    assert.equal(body.mode, 'active')
    // The operator-set campaign date is preserved verbatim through the queue → run replay.
    assert.equal(body.daily_campaign_name, '18/Jun/2026')
    assert.equal(body.daily_budget_thb, 150)
    assert.equal(body.run_hours, 24)
    assert.equal(body.story_id, '111_222')
    assert.equal(body.fb_video_id, 'v9')
    assert.equal(body.system_video_id, 'sys-1')
    assert.equal(body.shopee_url, 'https://s.shopee.co.th/x')
})

test('buildAdOnlyCreateBody never emits a page-publish field (no video_url)', () => {
    const body = buildAdOnlyCreateBody({ page_id: 'P', story_id: '1_2', mode: 'paused' })
    assert.equal('video_url' in body, false)
    assert.equal(body.mode, 'paused')
})

test('buildAdOnlyCreateBody defaults to paused and omits empty budget/run-hours so the endpoint defaults apply', () => {
    const body = buildAdOnlyCreateBody({ page_id: 'P', post_id: 'P_1' })
    assert.equal(body.mode, 'paused')
    assert.equal('daily_budget_thb' in body, false)
    assert.equal('run_hours' in body, false)
})

test('buildAdOnlyCreateBody tolerates a null/empty row without throwing', () => {
    const body = buildAdOnlyCreateBody(null)
    assert.equal(body.page_id, '')
    assert.equal(body.mode, 'paused')
})

test('interval gate: a queue that has never run is due immediately', () => {
    assert.equal(isAdOnlyQueueDue('', 20, 1_000_000), true)
    assert.equal(isAdOnlyQueueDue('not-a-date', 20, 1_000_000), true)
})

test('interval gate: not due before the interval elapses, due after', () => {
    const last = '2026-06-18T10:00:00.000Z'
    const lastMs = Date.parse(last)
    // 5 minutes later, interval 20 → not due.
    assert.equal(isAdOnlyQueueDue(last, 20, lastMs + 5 * 60_000), false)
    // exactly 20 minutes later → due.
    assert.equal(isAdOnlyQueueDue(last, 20, lastMs + 20 * 60_000), true)
    // 21 minutes later → due.
    assert.equal(isAdOnlyQueueDue(last, 20, lastMs + 21 * 60_000), true)
})

test('nextAdOnlyRunAtMs adds the interval to the last run', () => {
    const last = '2026-06-18T10:00:00.000Z'
    const lastMs = Date.parse(last)
    assert.equal(nextAdOnlyRunAtMs(last, 30, lastMs), lastMs + 30 * 60_000)
})

test('clampAdOnlyIntervalMinutes defaults garbage / non-positive and clamps out-of-range', () => {
    assert.equal(clampAdOnlyIntervalMinutes(''), DEFAULT_AD_ONLY_INTERVAL_MINUTES)
    assert.equal(clampAdOnlyIntervalMinutes('abc'), DEFAULT_AD_ONLY_INTERVAL_MINUTES)
    assert.equal(clampAdOnlyIntervalMinutes(0), DEFAULT_AD_ONLY_INTERVAL_MINUTES)
    assert.equal(clampAdOnlyIntervalMinutes(-5), DEFAULT_AD_ONLY_INTERVAL_MINUTES)
    assert.equal(clampAdOnlyIntervalMinutes(5), 5)
    assert.equal(clampAdOnlyIntervalMinutes(99999), MAX_AD_ONLY_INTERVAL_MINUTES)
    assert.equal(clampAdOnlyIntervalMinutes(0.4), MIN_AD_ONLY_INTERVAL_MINUTES)
})

test('create-ad-only keeps one dark story: update story CTA then comment same story without paid repair remint', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const start = src.indexOf("app.post('/api/dashboard/create-ad-only'")
    assert.ok(start > 0, 'create-ad-only route exists')
    const end = src.indexOf("app.get('/api/dashboard/ad-history'", start)
    const route = src.slice(start, end)
    assert.doesNotMatch(route, /fetch\(`\$\{baseUrl\}\/repair-ad-cta`/, 'create-ad-only must not call repair-ad-cta because Meta mints duplicate ad posts')
    const ctaIdx = route.indexOf('/update-cta')
    const commentIdx = route.indexOf('/page-comment')
    assert.ok(ctaIdx > 0 && commentIdx > ctaIdx, 'route updates the story CTA before commenting')
    assert.match(route, /story_id: commentStoryIdForProof/, 'page-comment targets the same create-ad story')
})

// =====================================================================
// AD-ONLY AUTO-PICK — when the manual queue is empty, the scheduler auto-selects ONE eligible cached
// page video and replays it through the SAME create-ad-only contract (never legacy/page-publish).
// =====================================================================

const candidate = (over: Partial<AdOnlyAutoCandidate> = {}): AdOnlyAutoCandidate => ({
    pageId: '1008898512617594',
    videoId: 'v-368352',
    postId: '1008898512617594_1306136458357716',
    shopeeLink: 'https://s.shopee.co.th/abc',
    views: 368_352,
    createdTime: '2026-06-18T10:00:00.000Z',
    adName: 'clip',
    ...over,
})

test('auto-pick builds the create-ad-only body — active mode, Bangkok daily campaign, 10000 THB, 24h', () => {
    const body = buildAdOnlyAutoPickBody({ candidate: candidate(), dailyCampaignName: '19/Jun/2026' })
    assert.equal(body.page_id, '1008898512617594')
    assert.equal(body.fb_video_id, 'v-368352')
    assert.equal(body.post_id, '1008898512617594_1306136458357716')
    assert.equal(body.shopee_url, 'https://s.shopee.co.th/abc')
    assert.equal(body.mode, 'active')
    assert.equal(body.daily_campaign_name, '19/Jun/2026')
    assert.equal(body.daily_budget_thb, DEFAULT_DAILY_BUDGET_THB)
    assert.equal(body.daily_budget_thb, 10000)
    assert.equal(body.run_hours, DEFAULT_RUN_HOURS)
    assert.equal(body.run_hours, 24)
})

test('auto-pick body NEVER emits a page-publish field (no video_url, no caption-publish)', () => {
    const body = buildAdOnlyAutoPickBody({ candidate: candidate(), dailyCampaignName: '19/Jun/2026' })
    assert.equal('video_url' in body, false)
    assert.equal('publish_to_page' in body, false)
    assert.equal('video_file' in body, false)
})

test('auto-pick replays through the create-ad-only endpoint, never the legacy create-ad', () => {
    // The auto path uses the exact same endpoint constant the queue replays through.
    assert.equal(AD_ONLY_QUEUE_ENDPOINT, '/api/dashboard/create-ad-only')
    assert.notEqual(AD_ONLY_QUEUE_ENDPOINT, '/api/dashboard/create-ad')
})

test('eligibility: a candidate without a shopee link or below 100k views is skipped', () => {
    assert.equal(AD_ONLY_AUTO_MIN_VIEWS, 100_000)
    assert.equal(isAdOnlyCandidateEligible(candidate()), true)
    // No shopee link → skipped.
    assert.equal(isAdOnlyCandidateEligible(candidate({ shopeeLink: '' })), false)
    // Below the views bar → skipped.
    assert.equal(isAdOnlyCandidateEligible(candidate({ views: 99_999 })), false)
    // Exactly at the bar → eligible.
    assert.equal(isAdOnlyCandidateEligible(candidate({ views: 100_000 })), true)
    // No ad source at all → skipped.
    assert.equal(isAdOnlyCandidateEligible(candidate({ videoId: '', postId: '' })), false)
})

test('dedup: a candidate already in dashboard_ad_history is excluded by fb/post/story/system ids', () => {
    // Match by fb_video_id.
    let used = buildAdOnlyUsedIdSet([{ fb_video_id: 'v-368352' }])
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
    // Match by source_post_id.
    used = buildAdOnlyUsedIdSet([{ source_post_id: '1008898512617594_1306136458357716' }])
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
    // Match by source_story_id.
    used = buildAdOnlyUsedIdSet([{ source_story_id: '1008898512617594_1306136458357716' }])
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
    // Match by system_video_id (candidate video id recorded there).
    used = buildAdOnlyUsedIdSet([{ system_video_id: 'v-368352' }])
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
    // Match by the TAIL of effective_object_story_id (PAGEID_POSTID → POSTID).
    used = buildAdOnlyUsedIdSet([{ effective_object_story_id: '1008898512617594_1306136458357716' }])
    assert.equal(adOnlyIdTail('1008898512617594_1306136458357716'), '1306136458357716')
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
    // A fresh, unrelated history row never matches.
    used = buildAdOnlyUsedIdSet([{ fb_video_id: 'other', effective_object_story_id: '999_888' }])
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), false)
})

test('selection: picks the highest-views eligible+fresh candidate, skips used and ineligible ones', () => {
    const used = buildAdOnlyUsedIdSet([{ fb_video_id: 'v-top' }])
    const best = selectAdOnlyAutoCandidate(
        [
            candidate({ videoId: 'v-top', views: 900_000 }), // highest but already used → skip
            candidate({ videoId: 'v-nolink', views: 800_000, shopeeLink: '', postId: 'p_2' }), // no link → skip
            candidate({ videoId: 'v-low', views: 50_000, postId: 'p_3' }), // below bar → skip
            candidate({ videoId: 'v-win', views: 400_000, postId: 'p_4' }), // eligible + fresh → winner
            candidate({ videoId: 'v-mid', views: 300_000, postId: 'p_5' }),
        ],
        used,
    )
    assert.ok(best)
    assert.equal(best?.videoId, 'v-win')
})

test('selection: returns null when nothing is eligible (queue stays idle that interval)', () => {
    const best = selectAdOnlyAutoCandidate(
        [candidate({ shopeeLink: '' }), candidate({ views: 10 })],
        new Set<string>(),
    )
    assert.equal(best, null)
})

// =====================================================================
// AUTO-PICK RESILIENCE — a ranked list (not one pick) + fatal-failure cooldown so one bad page/
// candidate can't waste every cadence slot.
// =====================================================================

test('ranking: returns ALL eligible+fresh candidates highest-views first (so the scheduler can fall through)', () => {
    const ranked = rankAdOnlyAutoCandidates(
        [
            candidate({ videoId: 'v-low', views: 120_000, postId: 'p_low' }),
            candidate({ videoId: 'v-nolink', views: 900_000, shopeeLink: '', postId: 'p_nolink' }), // skip
            candidate({ videoId: 'v-high', views: 500_000, postId: 'p_high' }),
            candidate({ videoId: 'v-mid', views: 300_000, postId: 'p_mid' }),
        ],
        new Set<string>(),
    )
    assert.deepEqual(ranked.map((c) => c.videoId), ['v-high', 'v-mid', 'v-low'])
})

test('ranking: ranked list can fall through from a high-view (failing) page to a known-good page', () => {
    // Simulate one per-page best from a high-view page that will fail, plus a known-good lower-view page.
    const highViewFailingPage = candidate({ pageId: '103881139378321', videoId: 'v-bad', views: 800_000, postId: 'pbad_1' })
    const knownGoodPage = candidate({ pageId: '1008898512617594', videoId: 'v-good', views: 368_352, postId: 'pgood_1' })
    const ranked = rankAdOnlyAutoCandidates([knownGoodPage, highViewFailingPage], new Set<string>())
    // Highest views is first (the page we'd try first); the good page is the next fall-through target.
    assert.equal(ranked[0].pageId, '103881139378321')
    assert.equal(ranked[1].pageId, '1008898512617594')
    // After dropping the failing page (as the loop would), the good page is selectable next.
    assert.equal(ranked.slice(1)[0].videoId, 'v-good')
})

test('rankAdOnlyAutoCandidates returns [] (not throw) for empty/null input', () => {
    assert.deepEqual(rankAdOnlyAutoCandidates([], new Set<string>()), [])
    assert.deepEqual(rankAdOnlyAutoCandidates(null, new Set<string>()), [])
})

test('fatal error classifier: matches the live permission/config failures and the worker fail-closed codes', () => {
    assert.equal(isAdOnlyFatalError('[creative] Application does not have permission for this action'), true)
    assert.equal(isAdOnlyFatalError("Unsupported post request. Object with ID 'act_1459223368888364' does not exist"), true)
    assert.equal(isAdOnlyFatalError('... missing permissions ...'), true)
    assert.equal(isAdOnlyFatalError('config_missing_template_or_ad_account'), true)
    assert.equal(isAdOnlyFatalError('bridge_not_configured'), true)
    assert.equal(isAdOnlyFatalError('fb_video_id_unresolved'), true)
    // Case-insensitive.
    assert.equal(isAdOnlyFatalError('APPLICATION DOES NOT HAVE PERMISSION'), true)
    // A transient/unknown error is NOT fatal — the page stays retryable.
    assert.equal(isAdOnlyFatalError('temporary network error'), false)
    assert.equal(isAdOnlyFatalError(''), false)
    assert.equal(isAdOnlyFatalError(null), false)
    // The substring list is non-empty and covers the documented codes.
    assert.ok(AD_ONLY_FATAL_ERROR_SUBSTRINGS.includes('Application does not have permission'))
})

test('cooldown set: recently-failed-fatal pages are skipped; good/old/non-fatal pages are not', () => {
    const now = Date.parse('2026-06-19T12:00:00.000Z')
    const recent = '2026-06-19T11:30:00.000Z' // 30 min ago → within cooldown
    const old = '2026-06-18T12:00:00.000Z' // 24h ago → outside the 6h cooldown
    const skipped = buildAdOnlySkippedPageSet(
        [
            { page_id: '103881139378321', status: 'failed', error_message: '[creative] Application does not have permission for this action', created_at: recent },
            { page_id: '114142457961643', status: 'failed', truncated_result_json: '{"error":"Object with ID \'act_1\' does not exist"}', created_at: recent },
            { page_id: 'P-transient', status: 'failed', error_message: 'temporary network error', created_at: recent }, // non-fatal → not skipped
            { page_id: 'P-old', status: 'failed', error_message: 'missing permissions', created_at: old }, // fatal but expired → not skipped
            { page_id: 'P-created', status: 'created', error_message: '', created_at: recent }, // success → not skipped
        ],
        now,
    )
    assert.equal(skipped.has('103881139378321'), true)
    assert.equal(skipped.has('114142457961643'), true)
    assert.equal(skipped.has('P-transient'), false)
    assert.equal(skipped.has('P-old'), false)
    assert.equal(skipped.has('P-created'), false)
})

test('cooldown set: a fatal failure with no parseable timestamp is treated as recent (fail safe)', () => {
    const now = Date.parse('2026-06-19T12:00:00.000Z')
    const skipped = buildAdOnlySkippedPageSet(
        [{ page_id: 'P-no-ts', status: 'failed', error_message: 'bridge_not_configured', created_at: '' }],
        now,
    )
    assert.equal(skipped.has('P-no-ts'), true)
})

test('cooldown set: the window is bounded (temporary), never a permanent ban', () => {
    // A fatal failure exactly at the cooldown edge is no longer skipped, so a fixed page recovers.
    const now = 10 * AD_ONLY_PAGE_COOLDOWN_MS
    const justExpired = new Date(now - AD_ONLY_PAGE_COOLDOWN_MS - 1).toISOString()
    const skipped = buildAdOnlySkippedPageSet(
        [{ page_id: 'P', status: 'failed', error_message: 'missing permissions', created_at: justExpired }],
        now,
    )
    assert.equal(skipped.has('P'), false)
    assert.ok(AD_ONLY_PAGE_COOLDOWN_MS > 0)
})

test('cooldown set: legacy visible-publish failures do not block the restored ads-only flow', () => {
    const now = Date.parse('2026-06-22T09:05:00.000Z')
    const recent = new Date(now - 10 * 60 * 1000).toISOString()
    const skipped = buildAdOnlySkippedPageSet(
        [
            { page_id: 'P-old', status: 'failed', error_message: 'missing permissions', created_at: recent, published_to_page: true },
            { page_id: 'P-new', status: 'failed', error_message: 'missing permissions', created_at: recent, published_to_page: false },
        ],
        now,
    )
    assert.equal(skipped.has('P-old'), false)
    assert.equal(skipped.has('P-new'), true)
})

test('bounded attempts constant is a small positive number (loops a few candidates, not unbounded)', () => {
    assert.ok(AD_ONLY_AUTO_MAX_ATTEMPTS >= 3 && AD_ONLY_AUTO_MAX_ATTEMPTS <= 10)
})

// Source-invariant guard: processAutoPickedAdOnlyCreate must loop a BOUNDED set of ranked candidates
// and return on the FIRST success (so the second candidate is tried when the first fails), rather than
// the old single-candidate behaviour. We assert on the source so a regression to one-shot is caught
// without standing up D1/the bridge.
test('processAutoPickedAdOnlyCreate loops bounded ranked candidates and returns on first success', () => {
    const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    // It resolves a LIST of candidates, not a single one.
    assert.match(indexSrc, /const candidates = await autoPickAdOnlyCandidates\(env\)/)
    // It bounds attempts by AD_ONLY_AUTO_MAX_ATTEMPTS and the candidate count.
    assert.match(indexSrc, /Math\.min\(AD_ONLY_AUTO_MAX_ATTEMPTS, candidates\.length\)/)
    // It loops and returns on the first ok result (try-next-on-failure).
    assert.match(indexSrc, /for \(let i = 0; i < maxAttempts; i\+\+\)/)
    assert.match(indexSrc, /if \(res\.ok\) \{\s*\n\s*return \{ ok: true/)
    // The failing-page cooldown set is consulted so a known-bad page is skipped before attempts begin.
    assert.match(indexSrc, /buildAdOnlySkippedPageSet\(/)
    assert.match(indexSrc, /if \(skippedPages\.has\(pageId\)\) continue/)
    // The ad-only invariant holds: the auto path still targets create-ad-only, never legacy create-ad.
    assert.match(indexSrc, /\/api\/dashboard\/create-ad-only/)
})

// Source-invariant guard for the daily-random no-repeat behavior: the auto-pick reader must scope its
// dedup to the CURRENT Bangkok day (not all-time) and draw RANDOMLY across the eligible pool.
test('autoPickAdOnlyCandidates scopes dedup to the Bangkok day and picks randomly', () => {
    const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    // Used set is the Bangkok-day-scoped variant, not the all-time one.
    assert.match(indexSrc, /buildAdOnlyUsedIdSetForBangkokDate\(historyRows\.results \|\| \[\], nowMs\)/)
    // The history read pulls created_at (needed to scope by day) and newest-first.
    assert.match(indexSrc, /effective_object_story_id, created_at, status\s*\n\s*FROM dashboard_ad_history WHERE page_id = \? ORDER BY id DESC LIMIT 5000/)
    // Selection is randomized (per-page and cross-page), driven by one seeded rng per tick.
    assert.match(indexSrc, /const rng = makeSeededRng\(nowMs\)/)
    // Mapped system-video candidates are ranked first; source_url fallbacks only when no mapped clip.
    assert.match(indexSrc, /rankAdOnlyAutoCandidatesRandom\(mappedCandidates, used, rng\)/)
    assert.match(indexSrc, /rankAdOnlyAutoCandidatesRandom\(sourceUrlCandidates, used, rng\)/)
    assert.match(indexSrc, /rankAdOnlyAutoCandidatesRandom\(perPageBest, new Set<string>\(\), rng\)/)
})

// =====================================================================
// AUTO-PAUSE FINISHED AD-ONLY CAMPAIGNS — turn OFF, never delete. Source-invariant guards so the
// close/off-never-destroy contract is provable without standing up D1/the bridge.
// =====================================================================
test('autoPauseCompletedAdOnlyCampaigns selects only finished, not-yet-paused rows with a pausable id', () => {
    const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const fnStart = indexSrc.indexOf('async function autoPauseCompletedAdOnlyCampaigns')
    assert.ok(fnStart >= 0, 'autoPauseCompletedAdOnlyCampaigns exists')
    const fn = indexSrc.slice(fnStart, fnStart + 6000)
    // Only rows whose run window has ENDED are eligible. Prefer explicit bridge end_time;
    // fixed-adset bridge rows may omit end_time, so fall back to created_at + run_hours.
    assert.match(fn, /end_time != ''/)
    assert.match(fn, /datetime\(end_time\) <= datetime\('now'\)/)
    assert.match(fn, /end_time = '' AND run_hours != '' AND created_at != ''/)
    assert.match(fn, /datetime\(created_at, '\+' \|\| CAST\(run_hours AS INTEGER\) \|\| ' hours'\) <= datetime\('now'\)/)
    // One-shot: only rows not already auto-paused.
    assert.match(fn, /auto_paused_at = ''/)
    // Only created/success rows (rejected/unsupported/failed never made live objects).
    assert.match(fn, /status IN \('created', 'success'\)/)
    // Must carry a pausable id.
    assert.match(fn, /campaign_id != '' OR adset_id != ''/)
    // Bounded batch — never an unbounded sweep.
    assert.match(fn, /LIMIT \?/)
})

test('autoPauseCompletedAdOnlyCampaigns turns OFF via /pause-ad-only and NEVER deletes', () => {
    const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const fnStart = indexSrc.indexOf('async function autoPauseCompletedAdOnlyCampaigns')
    const fn = indexSrc.slice(fnStart, fnStart + 6000)
    // It calls the bridge pause route (status=PAUSED only lives in the bridge), never legacy create.
    assert.match(fn, /\/pause-ad-only/)
    assert.ok(!fn.includes('create-ad-only'), 'auto-pause never re-creates ads')
    // HARD GUARANTEE: no DELETE method and never status=DELETED anywhere in the function body.
    assert.ok(!/method:\s*'DELETE'/.test(fn), 'auto-pause never issues a DELETE')
    assert.ok(!/DELETED/.test(fn), 'auto-pause never references DELETED')
    // auto_paused_at is stamped ONLY on a confirmed pause (success branch), so failures retry.
    assert.match(fn, /auto_paused_at = datetime\('now'\),\s*\n\s*auto_pause_status = 'success'/)
    assert.match(fn, /auto_pause_status = 'failed'/)
})

test('scheduled handler invokes autoPauseCompletedAdOnlyCampaigns in its own waitUntil', () => {
    const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    assert.match(indexSrc, /_ctx\.waitUntil\(autoPauseCompletedAdOnlyCampaigns\(env\)\.catch\(/)
})

test('ensureAdHistoryTable adds the auto-pause audit columns (additive ALTER)', () => {
    const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    for (const col of ['auto_paused_at', 'auto_pause_status', 'auto_pause_error', 'campaign_status_after', 'adset_status_after', 'ad_status_after']) {
        assert.match(indexSrc, new RegExp(`ALTER TABLE dashboard_ad_history ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`))
    }
})

// =====================================================================
// DAILY RANDOM NO-REPEAT (Bangkok day) — dedup resets at the Bangkok midnight boundary, and selection
// is random across the eligible cached pool rather than always the highest-view clip.
// =====================================================================

test('bangkokDateKey: returns the Asia/Bangkok (UTC+7) calendar date, not the UTC date', () => {
    // 20:00 UTC on Jun 18 is already 03:00 on Jun 19 in Bangkok (UTC+7).
    assert.equal(bangkokDateKey('2026-06-18T20:00:00.000Z'), '2026-06-19')
    // 05:00 UTC on Jun 19 is 12:00 Jun 19 in Bangkok.
    assert.equal(bangkokDateKey('2026-06-19T05:00:00.000Z'), '2026-06-19')
    // Accepts epoch ms too.
    assert.equal(bangkokDateKey(Date.parse('2026-06-19T05:00:00.000Z')), '2026-06-19')
    // Empty / unparseable → ''.
    assert.equal(bangkokDateKey(''), '')
    assert.equal(bangkokDateKey('not-a-date'), '')
})

test('same Bangkok day: a history row from TODAY excludes its candidate (no same-day repeat)', () => {
    const nowMs = Date.parse('2026-06-19T05:00:00.000Z') // 12:00 Jun 19 Bangkok
    // Promoted earlier today (Bangkok) → still in the day's used set.
    const used = buildAdOnlyUsedIdSetForBangkokDate(
        [{ fb_video_id: 'v-368352', created_at: '2026-06-19T02:00:00.000Z' }],
        nowMs,
    )
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
})

test('same Bangkok day: failed rows do NOT exclude a candidate because no ad was created', () => {
    const nowMs = Date.parse('2026-06-19T05:00:00.000Z')
    const used = buildAdOnlyUsedIdSetForBangkokDate(
        [{ fb_video_id: 'v-368352', created_at: '2026-06-19T02:00:00.000Z', status: 'failed' }],
        nowMs,
    )
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), false)
})

test('Bangkok day boundary: a row whose UTC date is yesterday but Bangkok date is TODAY still excludes', () => {
    const nowMs = Date.parse('2026-06-19T05:00:00.000Z') // 12:00 Jun 19 Bangkok
    // 20:00 UTC Jun 18 == 03:00 Jun 19 Bangkok → counts as TODAY, so it must still dedup.
    const used = buildAdOnlyUsedIdSetForBangkokDate(
        [{ fb_video_id: 'v-368352', created_at: '2026-06-18T20:00:00.000Z' }],
        nowMs,
    )
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
})

test('previous Bangkok day: yesterday\'s history row does NOT exclude the candidate today (window resets)', () => {
    const nowMs = Date.parse('2026-06-19T05:00:00.000Z') // 12:00 Jun 19 Bangkok
    // Promoted at 12:00 Jun 18 Bangkok → a previous Bangkok day → must NOT block today.
    const used = buildAdOnlyUsedIdSetForBangkokDate(
        [{ fb_video_id: 'v-368352', created_at: '2026-06-18T05:00:00.000Z' }],
        nowMs,
    )
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), false)
    assert.equal(used.size, 0)
})

test('filterAdOnlyHistoryRowsForBangkokDate keeps only today, drops previous days, keeps undated (fail safe)', () => {
    const nowMs = Date.parse('2026-06-19T05:00:00.000Z')
    const rows = [
        { fb_video_id: 'today-a', created_at: '2026-06-19T02:00:00.000Z' },
        { fb_video_id: 'today-b', created_at: '2026-06-18T20:00:00.000Z' }, // Bangkok Jun 19
        { fb_video_id: 'yesterday', created_at: '2026-06-18T05:00:00.000Z' }, // Bangkok Jun 18 → drop
        { fb_video_id: 'undated', created_at: '' }, // no timestamp → kept (fail safe)
    ]
    const kept = filterAdOnlyHistoryRowsForBangkokDate(rows, nowMs).map((r) => r.fb_video_id)
    assert.deepEqual(kept.sort(), ['today-a', 'today-b', 'undated'])
})

test('manual flow unchanged: all-time buildAdOnlyUsedIdSet still ignores the day and excludes any row', () => {
    // The non-dated, all-time set used by the manual create-ad-only path must keep its prior behavior.
    const used = buildAdOnlyUsedIdSet([{ fb_video_id: 'v-368352', created_at: '2020-01-01T00:00:00.000Z' }])
    assert.equal(isAdOnlyCandidateUsed(candidate(), used), true)
})

test('seeded rng is deterministic for a fixed seed and differs across seeds', () => {
    const a = makeSeededRng(42)
    const b = makeSeededRng(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    assert.deepEqual(seqA, seqB)
    // All in [0, 1).
    for (const n of seqA) assert.ok(n >= 0 && n < 1)
    // A different seed yields a different stream.
    const c = makeSeededRng(43)
    assert.notDeepEqual([c(), c(), c()], seqA)
})

test('shuffleWithRng returns a permutation (same multiset) and never mutates the input', () => {
    const input = [1, 2, 3, 4, 5]
    const out = shuffleWithRng(input, makeSeededRng(7))
    assert.deepEqual([...out].sort((x, y) => x - y), [1, 2, 3, 4, 5])
    assert.deepEqual(input, [1, 2, 3, 4, 5]) // untouched
})

test('randomized ranking: does NOT return a fixed highest-views-first order, but keeps the eligible pool', () => {
    const pool = [
        candidate({ videoId: 'v-900k', views: 900_000, postId: 'p1' }),
        candidate({ videoId: 'v-800k', views: 800_000, postId: 'p2' }),
        candidate({ videoId: 'v-700k', views: 700_000, postId: 'p3' }),
        candidate({ videoId: 'v-600k', views: 600_000, postId: 'p4' }),
        candidate({ videoId: 'v-500k', views: 500_000, postId: 'p5' }),
    ]
    const eligibleIds = ['v-500k', 'v-600k', 'v-700k', 'v-800k', 'v-900k']
    // The deterministic ranker always leads with the highest views — the behavior we are moving away from.
    assert.equal(rankAdOnlyAutoCandidates(pool, new Set<string>())[0].videoId, 'v-900k')

    // The randomized ranker, across seeds, must NOT always lead with v-900k and must vary its first pick.
    const firstPicks = new Set<string>()
    for (let seed = 1; seed <= 25; seed++) {
        const ranked = rankAdOnlyAutoCandidatesRandom(pool, new Set<string>(), makeSeededRng(seed))
        // Same eligible multiset regardless of seed (nothing dropped/added by shuffling).
        assert.deepEqual(ranked.map((c) => c.videoId).sort(), eligibleIds)
        firstPicks.add(ranked[0].videoId)
    }
    assert.ok(firstPicks.size > 1, 'expected randomized first pick to vary across seeds')
    assert.ok(firstPicks.size > 1 && ![...firstPicks].every((v) => v === 'v-900k'))
})

test('randomized ranking still honors eligibility + same-day dedup gates', () => {
    const used = buildAdOnlyUsedIdSet([{ fb_video_id: 'v-used' }])
    const pool = [
        candidate({ videoId: 'v-used', views: 900_000, postId: 'pu' }), // already promoted → excluded
        candidate({ videoId: 'v-nolink', views: 800_000, shopeeLink: '', postId: 'pn' }), // no link → excluded
        candidate({ videoId: 'v-low', views: 50_000, postId: 'pl' }), // below bar → excluded
        candidate({ videoId: 'v-ok-1', views: 400_000, postId: 'po1' }),
        candidate({ videoId: 'v-ok-2', views: 300_000, postId: 'po2' }),
    ]
    const ranked = rankAdOnlyAutoCandidatesRandom(pool, used, makeSeededRng(3))
    assert.deepEqual(ranked.map((c) => c.videoId).sort(), ['v-ok-1', 'v-ok-2'])
})
