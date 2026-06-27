import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    AUTO_ADS_SOURCE_PAGE_ID_SETTING_KEY,
    resolveAutoAdsSourcePageId,
    isUnderDailyAdCap,
} from '../src/ad-only-contract.js'

const CHEARB_SOURCE_PAGE_ID = '1008898512617594'
const TARGET_PAGES = ['1024425144090122', '1043230485549800', '1047668188424521']

// ---------------------------------------------------------------------------
// Pure helper: source page resolution
// ---------------------------------------------------------------------------

test('auto_ads_source_page_id setting key is stable', () => {
    assert.equal(AUTO_ADS_SOURCE_PAGE_ID_SETTING_KEY, 'auto_ads_source_page_id')
})

test('default source page remains the target page when no setting is configured', () => {
    for (const target of TARGET_PAGES) {
        assert.equal(resolveAutoAdsSourcePageId('', target), target)
        assert.equal(resolveAutoAdsSourcePageId(undefined, target), target)
        assert.equal(resolveAutoAdsSourcePageId(null, target), target)
        assert.equal(resolveAutoAdsSourcePageId('   ', target), target)
    }
})

test('a configured source page id wins over the target page (Chearb seeds the 3 target pages)', () => {
    for (const target of TARGET_PAGES) {
        assert.equal(resolveAutoAdsSourcePageId(CHEARB_SOURCE_PAGE_ID, target), CHEARB_SOURCE_PAGE_ID)
        // Trimmed, so whitespace around the operator-entered id never leaks into the query.
        assert.equal(resolveAutoAdsSourcePageId(`  ${CHEARB_SOURCE_PAGE_ID}  `, target), CHEARB_SOURCE_PAGE_ID)
    }
})

// ---------------------------------------------------------------------------
// Daily cap: at most 1 Follow ad per Bangkok day per target page
// ---------------------------------------------------------------------------

test('max_per_day=1 blocks the second same-day run per target page', () => {
    // First run of the day: nothing created yet → allowed.
    assert.equal(isUnderDailyAdCap(0, 1), true)
    // After one Follow ad today → the cap blocks any further create for that page that day.
    assert.equal(isUnderDailyAdCap(1, 1), false)
    assert.equal(isUnderDailyAdCap(2, 1), false)
    // 0 = unlimited (existing behavior preserved for non-capped pages).
    assert.equal(isUnderDailyAdCap(5, 0), true)
})

// ---------------------------------------------------------------------------
// Source wiring in index.ts — pickBestAutoAdsCandidateForPage must read videos
// from the SOURCE page while still creating the ad for the TARGET page.
// ---------------------------------------------------------------------------

const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')

test('pickBestAutoAdsCandidateForPage resolves the source page from the per-page setting', () => {
    assert.match(indexSrc, /AUTO_ADS_SOURCE_PAGE_ID_SETTING_KEY/)
    assert.match(indexSrc, /const sourcePageId = resolveAutoAdsSourcePageId\(sourcePageRow\?\.value, pageId\)/)
})

test('the candidate video pool is read from the source page id', () => {
    // listFacebookPageVideoCache must use sourcePageId (not the bare target pageId) for the pool.
    assert.match(indexSrc, /listFacebookPageVideoCache\(env\.DB, \{\s*\n\s*pageId: sourcePageId,/)
})

test('system-video resolution uses the source page id', () => {
    assert.match(indexSrc, /resolveAdOnlySystemVideoIdFromSignal\(env, \{ pageId: sourcePageId, postId, fbVideoId, shopeeLink \}\)/)
})

test('the candidate is still created for the TARGET page (candidate.pageId stays pageId)', () => {
    // The used-id dedup query stays keyed on the target page (per-target-page same-day reuse).
    assert.match(indexSrc, /dashboard_ad_history WHERE page_id = \? ORDER BY id DESC LIMIT 5000`\s*\n\s*\)\.bind\(pageId\)/)
    // And the candidate object is built with the target pageId, never sourcePageId.
    assert.match(indexSrc, /const candidate: AdOnlyAutoCandidate = \{\s*\n\s*pageId,/)
})

test('daily cap is consulted per target page before each create', () => {
    assert.match(indexSrc, /const todayCount = await countAutoAdsCreatedTodayForPage\(env, pageId, nowMs\)/)
    assert.match(indexSrc, /if \(!isUnderDailyAdCap\(todayCount, maxPerDay\)\)/)
})

// ---------------------------------------------------------------------------
// Settings round-trip: auto_ads_source_page_id is whitelisted + aliased.
// ---------------------------------------------------------------------------

test('settings GET/PUT whitelist includes auto_ads_source_page_id with camelCase alias', () => {
    assert.match(indexSrc, /'auto_ads_source_page_id'/)
    assert.match(indexSrc, /autoAdsSourcePageId: 'auto_ads_source_page_id'/)
})

test('auto-ads status endpoint reports the resolved source page id', () => {
    assert.match(indexSrc, /source_page_id: sourcePageId,/)
})
