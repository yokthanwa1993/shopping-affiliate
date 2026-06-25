import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
    validateAdOnlyInput,
    resolveAdOnlySchedule,
    buildAdOnlyUnsupportedResult,
    buildAdHistoryRecord,
    buildAdOnlyShortlinkRequestUrl,
    buildPaidAdCtaRepairBody,
    summarizePaidAdCtaRepair,
    truncateResultJson,
    AD_ONLY_BRIDGE_SUPPORTS_PAUSED,
    AD_ONLY_MISSING_BRIDGE_FIELDS,
    DEFAULT_DAILY_BUDGET_THB,
    DEFAULT_RUN_HOURS,
    MAX_RUN_HOURS,
    resolveAdOnlyLane,
    resolveFollowLaneTemplateAdset,
    resolveFollowLaneCampaignSub1,
    buildFollowLaneShortlinkRequestUrl,
    buildFollowLaneCreativeMessage,
    FOLLOW_LANE_PIN_PREFIX,
    buildFollowLaneCommentShortlinkRequestUrl,
    buildFollowLaneCommentMessage,
    buildFollowAutoPickBody,
    FOLLOW_LANE_TEMPLATE_ADSET,
    FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT,
    FOLLOW_LANE_CTA_TYPE,
    FOLLOW_LANE_COMMENT_BODY_LINES,
    AUTO_ADS_ALLOWED_PAGE_IDS,
    filterAutoAdsAllowedPageIds,
    AUTO_ADS_DEFAULT_ENABLED_PAGE_ID,
    isAdFlowEnabledForPage,
    filterCreateAdsEnabledPageIds,
    computeSchedulerJitterMs,
    computeJitteredNextRunAtMs,
    decideJitteredScheduleRun,
    DEFAULT_FOLLOW_AD_JITTER_MIN_MINUTES,
    DEFAULT_FOLLOW_AD_JITTER_MAX_MINUTES,
    DEFAULT_FOLLOW_AD_JITTER_MIN_MS,
    DEFAULT_FOLLOW_AD_JITTER_MAX_MS,
    DEFAULT_AD_ONLY_INTERVAL_MINUTES,
    makeSeededRng,
} from '../src/ad-only-contract.js'
import { buildPostingCommentShortlinkSubIds } from '../src/shortlink-template.js'
import {
    renderCommentTemplatesForPosting,
    DEFAULT_COMMENT_TEMPLATE_TEXT,
    COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER,
} from '../src/comment-template.js'

function getIndexSource(): string {
    return readFileSync('src/index.ts', 'utf8')
}

function sliceIndexSource(startMarker: string, endMarker: string, label: string): string {
    const source = getIndexSource()
    const start = source.indexOf(startMarker)
    assert.notEqual(start, -1, `${label} start marker must exist`)
    const end = source.indexOf(endMarker, start + startMarker.length)
    assert.notEqual(end, -1, `${label} end marker must exist`)
    return source.slice(start, end)
}

function getCreateAdOnlyRouteSource(): string {
    return sliceIndexSource(
        "app.post('/api/dashboard/create-ad-only'",
        "\napp.get('/api/dashboard/ad-history'",
        'POST /api/dashboard/create-ad-only'
    )
}

function getAdHistoryRouteSource(): string {
    return sliceIndexSource(
        "app.get('/api/dashboard/ad-history'",
        '\n// =====================================================================\n// CREATE ADS QUEUE',
        'GET /api/dashboard/ad-history'
    )
}

function getAdHistoryNormalizerSource(): string {
    return sliceIndexSource(
        'function normalizeDashboardAdHistoryRow',
        "\napp.post('/api/dashboard/create-ad-only'",
        'normalizeDashboardAdHistoryRow'
    )
}



test('validate fails closed when page_id is missing', () => {
    const v = validateAdOnlyInput({ story_id: '123_456' })
    assert.equal(v.ok, false)
    assert.equal(v.error, 'page_id_required')
})

test('validate accepts an already-resolved video_url publish source', () => {
    const v = validateAdOnlyInput({ page_id: 'P', video_url: 'https://cdn/x.mp4' })
    assert.equal(v.ok, true)
    assert.equal(v.videoUrl, 'https://cdn/x.mp4')
    assert.equal(v.hasSystemVideoSource, true)
})

test('validate accepts system_video_id alone as publishable system content', () => {
    const v = validateAdOnlyInput({ page_id: 'P', system_video_id: 'sys-1' })
    assert.equal(v.ok, true)
    assert.equal(v.systemVideoId, 'sys-1')
    assert.equal(v.hasAdSource, false)
    assert.equal(v.hasSystemVideoSource, true)
})

test('validate rejects old source-signal ids without system video content', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '123_456', fb_video_id: 'fb-1' })
    assert.equal(v.ok, false)
    assert.equal(v.error, 'system_video_source_required')
    assert.equal(v.sourceStoryId, '123_456')
    assert.equal(v.fbVideoId, 'fb-1')
    assert.equal(v.hasAdSource, true)
    assert.equal(v.hasSystemVideoSource, false)
})

test('validate accepts an old story_id signal with a system video publish source', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '123_456', system_video_id: 'sys-1' })
    assert.equal(v.ok, true)
    assert.equal(v.sourceStoryId, '123_456')
    assert.equal(v.systemVideoId, 'sys-1')
    assert.equal(v.hasAdSource, true)
})

test('validate accepts fb_video_id and the generic video_id alias', () => {
    assert.equal(validateAdOnlyInput({ page_id: 'P', fb_video_id: 'v1', system_video_id: 'sys-1' }).ok, true)
    const v = validateAdOnlyInput({ page_id: 'P', video_id: 'v2', system_video_id: 'sys-2' })
    assert.equal(v.ok, true)
    assert.equal(v.fbVideoId, 'v2')
})

test('validate accepts post_id as an ad source', () => {
    const v = validateAdOnlyInput({ page_id: 'P', post_id: 'P_789', system_video_id: 'sys-1' })
    assert.equal(v.ok, true)
    assert.equal(v.sourcePostId, 'P_789')
})

test('schedule defaults to PAUSED review mode (non-spending) with safe budget/run-hours defaults', () => {
    const s = resolveAdOnlySchedule({})
    assert.equal(s.ok, true)
    assert.equal(s.mode, 'paused')
    assert.equal(s.paused, true)
    assert.equal(s.dailyBudgetThb, DEFAULT_DAILY_BUDGET_THB)
    assert.equal(s.dailyBudgetMinor, DEFAULT_DAILY_BUDGET_THB * 100)
    assert.equal(s.runHours, DEFAULT_RUN_HOURS)
})

test('schedule active mode requires a daily_campaign_name (fails closed without it)', () => {
    const s = resolveAdOnlySchedule({ mode: 'active' })
    assert.equal(s.ok, false)
    assert.equal(s.error, 'ad_only_campaign_name_required')
    assert.equal(s.paused, false)
})

test('schedule active mode converts whole-THB budget to Meta minor units and carries the campaign + run-hours', () => {
    const s = resolveAdOnlySchedule({ mode: 'active', daily_campaign_name: '18/Jun/2026', daily_budget_thb: 250, run_hours: 48 })
    assert.equal(s.ok, true)
    assert.equal(s.mode, 'active')
    assert.equal(s.paused, false)
    assert.equal(s.dailyCampaignName, '18/Jun/2026')
    assert.equal(s.dailyBudgetThb, 250)
    assert.equal(s.dailyBudgetMinor, 25000)
    assert.equal(s.runHours, 48)
})

test('schedule clamps an out-of-range run window and a non-positive budget to safe defaults', () => {
    const s = resolveAdOnlySchedule({ mode: 'active', daily_campaign_name: 'C', daily_budget_thb: 0, run_hours: 99999 })
    assert.equal(s.ok, true)
    assert.equal(s.dailyBudgetThb, DEFAULT_DAILY_BUDGET_THB)
    assert.equal(s.runHours, MAX_RUN_HOURS)
})

test('schedule accepts the minor-units daily_budget alias (converted back to whole THB)', () => {
    const s = resolveAdOnlySchedule({ mode: 'active', daily_campaign_name: 'C', daily_budget: 30000 })
    assert.equal(s.dailyBudgetThb, 300)
    assert.equal(s.dailyBudgetMinor, 30000)
})

test('create-ad-only initial creative shortlink never uses empty settings sub2/sub3', () => {
    const route = getCreateAdOnlyRouteSource()
    assert.match(route, /const initialSub2 = String\(/)
    assert.match(route, /validation\.sourceStoryId/)
    assert.match(route, /validation\.sourcePostId/)
    assert.match(route, /validation\.fbVideoId/)
    assert.match(route, /validation\.systemVideoId/)
    assert.match(route, /const initialSub3 = String\(validation\.pageId/)
    assert.match(route, /sub2: initialSub2/)
    assert.match(route, /sub3: initialSub3/)
    assert.doesNotMatch(route, /\.replace\('\{sub_id2\}', encodeURIComponent\(String\(sub2Row\?\.value \|\| ''\)/)
})

test('ad-history record carries mode + run_hours intent and echoes bridge budget/schedule', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '1_2', system_video_id: 'sys-1' })
    const rec = buildAdHistoryRecord({
        status: 'created',
        validation: v,
        result: { ad_id: 'AD1', daily_budget: '10000', start_time: '2026-06-18T10:00:00+0700', end_time: '2026-06-19T10:00:00+0700' },
        schedule: { mode: 'active', runHours: 24 },
    })
    assert.equal(rec.mode, 'active')
    assert.equal(rec.run_hours, '24')
    assert.equal(rec.daily_budget, '10000')
    assert.equal(rec.start_time, '2026-06-18T10:00:00+0700')
    assert.equal(rec.end_time, '2026-06-19T10:00:00+0700')
})

test('ad-history record leaves schedule fields empty for the paused/review path', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '1_2', system_video_id: 'sys-1' })
    const rec = buildAdHistoryRecord({ status: 'created', validation: v, result: { ad_id: 'AD1', adset_status: 'PAUSED' }, schedule: { mode: 'paused', runHours: 24 } })
    assert.equal(rec.mode, 'paused')
    assert.equal(rec.daily_budget, '')
    assert.equal(rec.start_time, '')
    assert.equal(rec.end_time, '')
})

test('bridge paused gate is ON — ad-only creates non-spending PAUSED ads via the bridge', () => {
    assert.equal(AD_ONLY_BRIDGE_SUPPORTS_PAUSED, true)
    // The documented paused-path requirements stay available for the fail-closed branch.
    assert.ok(AD_ONLY_MISSING_BRIDGE_FIELDS.length >= 1)
})

test('unsupported result is structured, stable, and echoes the validated source', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '123_456', fb_video_id: 'v9', system_video_id: 'sys-1' })
    const r = buildAdOnlyUnsupportedResult(v)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'ad_only_bridge_paused_unsupported')
    assert.equal(r.page_id, 'P')
    assert.equal(r.source_story_id, '123_456')
    assert.equal(r.fb_video_id, 'v9')
    assert.ok(Array.isArray(r.missing_bridge_fields) && r.missing_bridge_fields.length >= 1)
})

test('ad-history record maps validation + bridge result fields', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '123_456', system_video_id: 'sys-1' })
    const rec = buildAdHistoryRecord({
        status: 'created',
        validation: v,
        result: { campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1', creative_id: 'cr1', ad_story_id: '999_111', cta_link: 'https://s.shopee.co.th/x' },
    })
    assert.equal(rec.status, 'created')
    assert.equal(rec.page_id, 'P')
    assert.equal(rec.source_story_id, '123_456')
    assert.equal(rec.system_video_id, 'sys-1')
    assert.equal(rec.campaign_id, 'c1')
    assert.equal(rec.adset_id, 'as1')
    assert.equal(rec.ad_id, 'ad1')
    assert.equal(rec.creative_id, 'cr1')
    assert.equal(rec.effective_object_story_id, '999_111')
    assert.equal(rec.click_link, 'https://s.shopee.co.th/x')
    assert.ok(rec.truncated_result_json.includes('c1'))
})

test('ad-history record for the unsupported path carries status + error, no result json', () => {
    const v = validateAdOnlyInput({ page_id: 'P', post_id: 'P_1', system_video_id: 'sys-1' })
    const rec = buildAdHistoryRecord({ status: 'unsupported', validation: v, errorMessage: 'ad_only_bridge_paused_unsupported' })
    assert.equal(rec.status, 'unsupported')
    assert.equal(rec.error_message, 'ad_only_bridge_paused_unsupported')
    assert.equal(rec.truncated_result_json, '')
    assert.equal(rec.ad_id, '')
})

// Active ad-only finalization: after the bridge returns the dark-post story_id, the worker re-mints
// the CTA/comment shortlink so it carries sub2 = post id tail and sub3 = page id. These two helpers
// are the single source of truth for that derivation + request-url build, so assert them together.
test('active ad-only re-mint derives sub2 = bridge story-id tail and sub3 = page id', () => {
    const bridgeStoryId = '111_222' // bridge effective_object_story_id = PAGEID_POSTID
    const pageId = '111'
    const subs = buildPostingCommentShortlinkSubIds({ canonicalPostId: bridgeStoryId, pageId, logPrefix: 'AD-ONLY ACTIVE' })
    assert.equal(subs.postSubId2, '222') // post id tail, NEVER the page id
    assert.equal(subs.postSubId3, '111') // page id

    const url = buildAdOnlyShortlinkRequestUrl({
        template: 'https://short.wwoom.com/?id=X&url={url}&sub1={sub_id}&sub2={sub_id2}&sub3={sub_id3}',
        shopeeLink: 'https://shopee.co.th/product',
        sub1: 'yok',
        sub2: subs.postSubId2,
        sub3: subs.postSubId3,
    })
    assert.ok(url.includes('sub2=222'), url)
    assert.ok(url.includes('sub3=111'), url)
    assert.ok(url.includes('sub1=yok'), url)
    assert.ok(url.includes(`url=${encodeURIComponent('https://shopee.co.th/product')}`), url)
})

test('buildAdOnlyShortlinkRequestUrl url-encodes subs, blanks sub4/sub5, tolerates missing placeholders', () => {
    const url = buildAdOnlyShortlinkRequestUrl({
        template: '{url}|{sub_id}|{sub_id2}|{sub_id3}|{sub_id4}|{sub_id5}',
        shopeeLink: 'https://shopee.co.th/x',
        sub1: 'a b',
        sub2: 'b',
        sub3: 'c',
    })
    // sub4/sub5 emptied; sub1 url-encoded; sub2/sub3 carried verbatim.
    assert.equal(url, `${encodeURIComponent('https://shopee.co.th/x')}|a%20b|b|c||`)
    // A template without the sub2/sub3 placeholders simply carries no sub2/sub3 (no throw).
    const noPlaceholders = buildAdOnlyShortlinkRequestUrl({
        template: 'https://short.wwoom.com/?id=X&url={url}&sub1={sub_id}',
        shopeeLink: 'https://shopee.co.th/x',
        sub1: 'yok',
        sub2: '222',
        sub3: '111',
    })
    assert.ok(!noPlaceholders.includes('222'))
    assert.ok(noPlaceholders.includes('sub1=yok'))
})

// Active ad-only finalization posts the Page comment through the SAME template renderer normal page
// posts use (buildAffiliateCommentMessage → renderCommentTemplatesForPosting), substituting the SAME
// finalLink the CTA carries into {{shopee_link}}. The comment must be the template style — NOT a bare
// link — and must contain the final shortlink. These assert the exact rendering that path relies on.
test('active ad-only comment renders the namespace template with the final shortlink, not a bare link', () => {
    const finalLink = 'https://s.shopee.co.th/8KnFV0t8sa'
    const customSlot = `🛍️ ช้อปเลย Shopee : ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`
    const rendered = renderCommentTemplatesForPosting({
        slots: [customSlot, '', ''],
        shopeeLink: finalLink,
        lazadaLink: '',
        fallbackTemplate: DEFAULT_COMMENT_TEMPLATE_TEXT,
    })
    const message = rendered[0] || ''
    assert.ok(message.includes(finalLink), 'comment substitutes the final shortlink into {{shopee_link}}')
    assert.notEqual(message.trim(), finalLink, 'comment is the template style, not a bare link')
    assert.ok(message.includes('Shopee :'), 'comment carries the page-post template label, not just a URL')
})

test('active ad-only comment falls back to the DEFAULT template when the namespace has no custom slots', () => {
    const finalLink = 'https://s.shopee.co.th/8KnFV0t8sa'
    const rendered = renderCommentTemplatesForPosting({
        slots: ['', '', ''],
        shopeeLink: finalLink,
        lazadaLink: '', // ad-only has no Lazada link → the Lazada line is dropped from the default
        fallbackTemplate: DEFAULT_COMMENT_TEMPLATE_TEXT,
    })
    const message = rendered[0] || ''
    assert.ok(message.length > 0, 'a normal fallback render always yields a non-empty message')
    assert.ok(message.includes(finalLink), 'default template still substitutes the final shortlink')
    assert.notEqual(message.trim(), finalLink, 'default fallback is not a bare link')
    assert.ok(!/lazada/i.test(message) || /https?:\/\//i.test(message), 'empty Lazada line is dropped')
})

test('create-ad-only records ad-story comment evidence or a skipped/failed reason', () => {
    const routeSource = getCreateAdOnlyRouteSource()
    const finalizationIdx = routeSource.indexOf('// 5. Finalize the ads-only story')
    const pageCommentIdx = routeSource.indexOf("`${baseUrl}/page-comment`")
    const successIdx = routeSource.indexOf('// 6. Success')

    assert.ok(finalizationIdx >= 0, 'create-ad-only must have an ads-only finalization block')
    assert.ok(pageCommentIdx > finalizationIdx && pageCommentIdx < successIdx, 'Page comment write must target the ad story finalization block')
    assert.match(routeSource, /skip_comment: true/, 'bridge /create-ad must not also comment')
    assert.match(routeSource, /shopee_link_missing/)
    assert.match(routeSource, /story_cta_update_failed/, 'must update the single ad story CTA instead of repairing paid creative into a duplicate story')
    assert.doesNotMatch(routeSource, /visible_cta_update_failed/)
    assert.match(routeSource, /bridgeResult\.comment_status = 'failed'[\s\S]*bridgeResult\.comment_error = 'final_shortlink_unresolved'/)
    assert.match(routeSource, /let commentStoryIdForProof = adStoryIdForProof/)
    assert.match(routeSource, /let commentPostIdForProof = adPostIdForProof/)
    assert.match(routeSource, /body: JSON\.stringify\(\{ page_id: validation\.pageId, story_id: commentStoryIdForProof, message: commentMessage, comment_message: commentMessage \}\)/)
})

test('create-ad-only bridge body creates an ads-only dark story and never publishes a visible Page post', () => {
    const routeSource = getCreateAdOnlyRouteSource()

    assert.match(routeSource, /video_url: publishVideoUrl/)
    assert.match(routeSource, /source_video_id: validation\.systemVideoId/)
    assert.match(routeSource, /skip_publish_to_page: true/)
    assert.match(routeSource, /skip_comment: true/)
    assert.doesNotMatch(routeSource, /fetch\(`\$\{baseUrl\}\/repair-ad-cta`/, 'create-ad-only must not call repair-ad-cta because Meta mints duplicate ad posts')
    assert.doesNotMatch(routeSource, /skip_ad: true/)
    assert.doesNotMatch(routeSource, /publish_as_page_video: true/)
    assert.doesNotMatch(routeSource, /`\$\{baseUrl\}\/promote`/)
    assert.match(routeSource, /`\$\{baseUrl\}\/update-cta`/, 'when Meta repairs to a new dark story, update that story CTA before commenting')
    assert.match(routeSource, /resolveGalleryVideoForRepost/)
    assert.match(routeSource, /system_video_unresolved/)
})

test('create-ad-only records ad-story proof separately from old source signal ids', () => {
    const routeSource = getCreateAdOnlyRouteSource()

    assert.match(routeSource, /source_signal_story_id: validation\.sourceStoryId/)
    assert.match(routeSource, /source_signal_post_id: validation\.sourcePostId/)
    assert.match(routeSource, /source_signal_fb_video_id: validation\.fbVideoId/)
    assert.match(routeSource, /source_signal_system_video_id: validation\.systemVideoId/)
    assert.match(routeSource, /story_id: adStoryIdForProof/)
    assert.match(routeSource, /ad_story_id: adStoryIdForProof/)
    assert.match(routeSource, /effective_object_story_id: adStoryIdForProof/)
    assert.match(routeSource, /ad_post_id: adPostIdForProof/)
    assert.match(routeSource, /published_to_page: false/)
    assert.match(routeSource, /bridgeResult\.final_shortlink = finalLink/)
    assert.match(routeSource, /bridgeResult\.sub1 = finalSub1/)
    assert.match(routeSource, /bridgeResult\.cta_sub1 = finalSub1/)
    assert.match(routeSource, /bridgeResult\.cta_sub2 = commentSubIds\.postSubId2/)
    assert.match(routeSource, /bridgeResult\.cta_sub3 = commentSubIds\.postSubId3/)
    assert.doesNotMatch(routeSource, /sourceCommentTargetRaw/)
    assert.doesNotMatch(routeSource, /source_comment_target_story_id = sourceCommentTargetStoryId/)
})

test('ad-only queue preflights old source signals to a system video before creating history', () => {
    const source = getIndexSource()
    const queueSource = sliceIndexSource(
        'async function processNextAdOnlyQueueItem',
        '\nasync function recoverStuckAdOnlyQueueProcessing',
        'processNextAdOnlyQueueItem'
    )
    const autoPickSource = sliceIndexSource(
        'async function autoPickAdOnlyCandidates',
        '\n// Issue ONE create-ad-only call',
        'autoPickAdOnlyCandidates'
    )

    assert.match(source, /async function resolveAdOnlySystemVideoIdFromSignal/)
    assert.match(queueSource, /resolveAdOnlySystemVideoIdFromSignal\(env/)
    assert.match(queueSource, /system_video_unmapped_preflight/)
    assert.match(queueSource, /system_video_source_required_preflight/)
    assert.ok(
        queueSource.indexOf('system_video_unmapped_preflight') < queueSource.indexOf("fetch(`${workerUrl}/api/dashboard/create-ad-only`"),
        'unmapped queued rows must fail before the internal create-ad-only fetch'
    )
    assert.match(autoPickSource, /resolveAdOnlySystemVideoIdFromSignal\(env/)
    assert.match(autoPickSource, /reason=system_video_unmapped_preflight/)
    assert.match(autoPickSource, /continue/)
})

test('ad-history expands safe comment and CTA proof fields from truncated_result_json', () => {
    const source = getIndexSource()
    const routeSource = getAdHistoryRouteSource()
    const normalizerSource = getAdHistoryNormalizerSource()

    for (const key of [
        'source_signal_story_id',
        'source_signal_post_id',
        'source_signal_fb_video_id',
        'source_signal_system_video_id',
        'new_story_id',
        'new_post_id',
        'new_fb_video_id',
        'comment_status',
        'comment_fb_id',
        'comment_message',
        'comment_shortlink',
        'comment_target_story_id',
        'comment_target_post_id',
        'source_comment_status',
        'source_comment_fb_id',
        'source_comment_message',
        'source_comment_shortlink',
        'source_comment_target_story_id',
        'source_comment_error',
        'published_to_page',
        'publish_error',
        'visible_page_cta_final',
        'visible_page_cta_link',
        'sub1',
        'cta_sub1',
        'cta_sub2',
        'cta_sub3',
        'final_shortlink',
        'paid_ad_cta_final',
        'paid_ad_cta_link',
        'promote_mode',
        'promote_uses_object_story_id',
    ]) {
        assert.match(source, new RegExp(`'${key}'`), `safe field list must include ${key}`)
    }
    assert.match(routeSource, /\.map\(normalizeDashboardAdHistoryRow\)/)
    assert.match(normalizerSource, /parseDashboardAdHistoryResultJson\(row\.truncated_result_json\)/)
    assert.match(normalizerSource, /for \(const key of AD_HISTORY_RESULT_SAFE_FIELDS\)/)
    assert.match(normalizerSource, /buildPageStoryId\(pageId, storyId\)/)
    assert.match(normalizerSource, /item\.comment_target_story_id = fullStoryId/)
    assert.match(normalizerSource, /item\.comment_target_post_id = adHistoryStoryTail\(fullStoryId\)/)
})

test('created ad-history audit json prioritizes comment proof fields before long bridge payloads', () => {
    const routeSource = getCreateAdOnlyRouteSource()
    const successResultIdx = routeSource.indexOf('const successResult = prioritizeDashboardAdHistoryResultFields(bridgeResult)')
    const buildRecordIdx = routeSource.indexOf("buildAdHistoryRecord({ status: 'created'")

    assert.ok(successResultIdx >= 0 && successResultIdx < buildRecordIdx, 'success audit result must be reordered before storage')
    assert.match(routeSource, /result: successResult/)
    assert.match(routeSource, /\.\.\.successResult/)
})

// PAID AD CTA REPAIR — the active ad-only finalization fixes the PAID ad creative's CTA in Ads
// Manager (the live bug: ads showed the placeholder utm_content=…AD---- link). The repair must carry
// the SAME finalLink the visible CTA + Page comment use, and must NEVER record success unless the
// bridge read-back confirmed it.
test('paid CTA repair body carries the SAME final link the visible CTA + comment use, plus the ad/creative/video ids', () => {
    const finalLink = 'https://s.shopee.co.th/8KnFV0t8sa'
    // The comment renders the SAME finalLink — assert both reference one identical link.
    const rendered = renderCommentTemplatesForPosting({
        slots: [`🛍️ Shopee : ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`, '', ''],
        shopeeLink: finalLink,
        lazadaLink: '',
        fallbackTemplate: DEFAULT_COMMENT_TEMPLATE_TEXT,
    })
    const body = buildPaidAdCtaRepairBody({
        pageId: '111',
        adId: 'AD9',
        finalLink,
        creativeId: 'OLDCR',
        videoId: 'VID9',
        caption: 'cap',
        adAccount: 'act_test',
        templateAdset: 'tpl_test',
        sourceStoryId: '111_222',
        adName: 'ad-9',
    })
    assert.equal(body.final_cta_link, finalLink, 'paid CTA repair carries the post-specific final link')
    assert.ok((rendered[0] || '').includes(finalLink), 'the Page comment renders the SAME final link')
    assert.ok((rendered[0] || '').includes(String(body.final_cta_link)), 'paid CTA and the comment share ONE final link')
    assert.equal(body.ad_id, 'AD9')
    assert.equal(body.creative_id, 'OLDCR')
    assert.equal(body.video_id, 'VID9')
    assert.equal(body.page_id, '111')
    assert.equal(body.ad_account, 'act_test')
    assert.equal(body.template_adset, 'tpl_test')
    assert.equal(body.source_story_id, '111_222')
})

test('paid CTA repair body omits empty optional fields so the bridge applies its own backfill', () => {
    const body = buildPaidAdCtaRepairBody({ pageId: '111', adId: 'AD9', finalLink: 'https://s.shopee.co.th/x' })
    assert.equal(body.page_id, '111')
    assert.equal(body.ad_id, 'AD9')
    assert.equal(body.final_cta_link, 'https://s.shopee.co.th/x')
    assert.ok(!('creative_id' in body), 'no empty creative_id is sent')
    assert.ok(!('video_id' in body), 'no empty video_id is sent')
    assert.ok(!('caption' in body), 'no empty caption is sent')
})

test('summarize paid CTA repair records paid_ad_cta_final=true ONLY when the bridge confirmed it', () => {
    const ok = summarizePaidAdCtaRepair({
        ok: true,
        paid_ad_cta_final: true,
        paid_ad_cta_link: 'https://s.shopee.co.th/FINAL',
        new_creative_id: 'CR2',
        old_creative_id: 'CR1',
    }, true)
    assert.equal(ok.paid_cta_update_status, 'success')
    assert.equal(ok.paid_ad_cta_final, true)
    assert.equal(ok.paid_ad_cta_link, 'https://s.shopee.co.th/FINAL')
    assert.equal(ok.paid_new_creative_id, 'CR2')
    assert.equal(ok.paid_old_creative_id, 'CR1')
})

test('summarize paid CTA repair NEVER claims success on an unconfirmed read-back or an http/error response', () => {
    // ok:true but read-back did NOT confirm → failed, not success.
    const unconfirmed = summarizePaidAdCtaRepair({ ok: true, paid_ad_cta_final: false, new_creative_id: 'CR2' }, true)
    assert.equal(unconfirmed.paid_cta_update_status, 'failed')
    assert.notEqual(unconfirmed.paid_ad_cta_final, true)
    // A bridge step error is surfaced as the recorded reason.
    const errored = summarizePaidAdCtaRepair({ ok: false, step: 'update_ad', error: 'ad_creative_update_failed' }, true)
    assert.equal(errored.paid_cta_update_status, 'failed')
    assert.equal(errored.paid_cta_update_error, 'update_ad:ad_creative_update_failed')
    // A non-2xx HTTP response is also a failure even if the body looks ok.
    const http = summarizePaidAdCtaRepair({ ok: true, paid_ad_cta_final: true }, false)
    assert.equal(http.paid_cta_update_status, 'failed')
})

test('ad-history record reflects the repaired paid creative + carries paid_ad_cta_final in the audit json', () => {
    const v = validateAdOnlyInput({ page_id: '111', story_id: '111_222', system_video_id: 'sys-1' })
    // After a confirmed repair the worker syncs creative_id to the NEW creative and merges the summary.
    const bridgeResult = {
        ad_id: 'AD9',
        creative_id: 'CR2', // synced to the new creative after repair
        story_id: '111_222',
        paid_ad_cta_final: true,
        paid_ad_cta_link: 'https://s.shopee.co.th/FINAL',
        paid_new_creative_id: 'CR2',
        paid_old_creative_id: 'CR1',
        visible_page_cta_final: true,
    }
    const rec = buildAdHistoryRecord({ status: 'created', validation: v, result: bridgeResult, clickLink: 'https://s.shopee.co.th/FINAL', schedule: { mode: 'active', runHours: 24 } })
    assert.equal(rec.creative_id, 'CR2', 'audit row reflects the repaired (new) creative id')
    assert.ok(rec.truncated_result_json.includes('"paid_ad_cta_final":true'), 'audit json records the confirmed paid CTA')
    assert.equal(rec.click_link, 'https://s.shopee.co.th/FINAL')
})

test('Create Ads UI wording says old post is a signal and no longer claims no new post/comment', () => {
    const ui = readFileSync('../../dashboard/react-dashboard/src/routes/create-ads.tsx', 'utf8')
    assert.match(ui, /โพสต์เก่าคือต้นแบบ\/สัญญาณ/)
    assert.match(ui, /สร้างโพสต์เพจใหม่/)
    assert.doesNotMatch(ui, /ไม่เผยแพร่โพสต์ใหม่/)
    assert.doesNotMatch(ui, /ไม่คอมเมนต์/)
})

test('truncateResultJson bounds long payloads and never throws on cycles', () => {
    const big = { s: 'x'.repeat(9000) }
    const out = truncateResultJson(big, 100)
    assert.ok(out.length <= 100)
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    assert.doesNotThrow(() => truncateResultJson(cyc))
})

// =====================================================================
// AUTO-ADS ALLOWLIST — the EMPTY-QUEUE auto-pick scheduler may only ever auto-create ads for the
// allowlisted page(s). Current production is exactly one page (เฉียบ / 1008898512617594), so the
// unattended cadence never silently spends on the other account pages. Manual Create Ads and
// explicitly-queued rows are NOT restricted by this list.
// =====================================================================

test('AUTO_ADS_ALLOWED_PAGE_IDS is exactly the one production page (เฉียบ)', () => {
    assert.deepEqual([...AUTO_ADS_ALLOWED_PAGE_IDS], ['1008898512617594'])
})

test('filterAutoAdsAllowedPageIds keeps only the allowed page, trims, and de-dupes', () => {
    const out = filterAutoAdsAllowedPageIds([
        ' 1008898512617594 ', // surrounding whitespace is trimmed → allowed
        '1008898512617594', // duplicate of the trimmed value → dropped
        '999', // not allowed → dropped
        '', // empty → dropped
        '123456789', // not allowed → dropped
    ])
    assert.deepEqual(out, ['1008898512617594'])
})

test('filterAutoAdsAllowedPageIds drops every non-allowed page id (and is null/empty safe)', () => {
    assert.deepEqual(filterAutoAdsAllowedPageIds(['1', '2', '3']), [])
    assert.deepEqual(filterAutoAdsAllowedPageIds([]), [])
    assert.deepEqual(filterAutoAdsAllowedPageIds(null), [])
    assert.deepEqual(filterAutoAdsAllowedPageIds(undefined), [])
})

test('filterAutoAdsAllowedPageIds fails closed when the allowlist is empty', () => {
    // An empty allowlist must yield [] — the unattended scheduler never auto-spends on an unlisted page.
    assert.deepEqual(filterAutoAdsAllowedPageIds(['1008898512617594'], []), [])
})

test('filterAutoAdsAllowedPageIds honors a custom allowlist, preserving input order and de-duping', () => {
    const out = filterAutoAdsAllowedPageIds(['c', 'a', 'b', 'a', 'z'], ['a', 'b', 'c'])
    assert.deepEqual(out, ['c', 'a', 'b'])
})

// =====================================================================
// CREATE ADS ENABLED STATE (operator-toggleable per-page ad_flow_enabled)
// =====================================================================

const CHEARB = '1008898512617594'

test('AUTO_ADS_DEFAULT_ENABLED_PAGE_ID is เฉียบ and matches the allowlist single page', () => {
    assert.equal(AUTO_ADS_DEFAULT_ENABLED_PAGE_ID, CHEARB)
    assert.deepEqual([...AUTO_ADS_ALLOWED_PAGE_IDS], [AUTO_ADS_DEFAULT_ENABLED_PAGE_ID])
})

test('isAdFlowEnabledForPage default (unset) enables ONLY เฉียบ, disables every other page', () => {
    // No explicit setting → default rule: Chearb on, others off (preserves current production).
    assert.equal(isAdFlowEnabledForPage(CHEARB, ''), true)
    assert.equal(isAdFlowEnabledForPage(CHEARB, null), true)
    assert.equal(isAdFlowEnabledForPage(CHEARB, undefined), true)
    assert.equal(isAdFlowEnabledForPage('999', ''), false)
    assert.equal(isAdFlowEnabledForPage('123456789', undefined), false)
})

test('isAdFlowEnabledForPage explicit off disables เฉียบ; explicit on enables another page', () => {
    // Persisted OFF turns even the default page off.
    for (const off of ['0', 'false', 'off', 'no', 'disabled']) {
        assert.equal(isAdFlowEnabledForPage(CHEARB, off), false, `off value ${off}`)
    }
    // Persisted ON turns a non-default page on.
    for (const on of ['1', 'true', 'on', 'yes', 'enabled']) {
        assert.equal(isAdFlowEnabledForPage('999', on), true, `on value ${on}`)
    }
})

test('filterCreateAdsEnabledPageIds default state is exactly เฉียบ among the held pages', () => {
    // All 8 held pages, none with an explicit setting → only Chearb is in scope.
    const held = [CHEARB, '111', '222', '333', '444', '555', '666', '777']
    const out = filterCreateAdsEnabledPageIds(held.map((pageId) => ({ pageId, adFlowEnabled: '' })))
    assert.deepEqual(out, [CHEARB])
})

test('filterCreateAdsEnabledPageIds excludes disabled pages and includes explicitly-enabled ones', () => {
    const out = filterCreateAdsEnabledPageIds([
        { pageId: CHEARB, adFlowEnabled: '0' }, // เฉียบ turned OFF → excluded
        { pageId: '111', adFlowEnabled: '1' },  // another page turned ON → included
        { pageId: '222', adFlowEnabled: '' },   // unset, not the default page → excluded
        { pageId: '333', adFlowEnabled: 'on' }, // included
    ])
    assert.deepEqual(out, ['111', '333'])
})

test('filterCreateAdsEnabledPageIds fails closed (empty) when no page is enabled, and is null/empty safe', () => {
    assert.deepEqual(filterCreateAdsEnabledPageIds([{ pageId: CHEARB, adFlowEnabled: '0' }]), [])
    assert.deepEqual(filterCreateAdsEnabledPageIds([]), [])
    assert.deepEqual(filterCreateAdsEnabledPageIds(null), [])
    assert.deepEqual(filterCreateAdsEnabledPageIds(undefined), [])
})

test('filterCreateAdsEnabledPageIds preserves input order and de-dupes by page id', () => {
    const out = filterCreateAdsEnabledPageIds([
        { pageId: '333', adFlowEnabled: '1' },
        { pageId: CHEARB, adFlowEnabled: '' }, // default-on
        { pageId: '333', adFlowEnabled: '1' }, // duplicate → dropped
    ])
    assert.deepEqual(out, ['333', CHEARB])
})

// =====================================================================
// FOLLOW / PAGE-LIKE LANE
// =====================================================================

const DEFAULT_TEMPLATE = 'https://short.wwoom.com/?id=15130770000&url={url}&sub1={sub_id}'
const FOLLOW_PAGE_ID = '1008898512617594'
const FOLLOW_SHOPEE = 'https://s.shopee.co.th/abc123'

function getFollowLaneHandlerSource(): string {
    return sliceIndexSource(
        'async function runFollowLaneCreateAdOnly',
        "\napp.post('/api/dashboard/create-ad-only'",
        'runFollowLaneCreateAdOnly',
    )
}

test('resolveAdOnlyLane defaults to sales and never breaks the click-link lane', () => {
    assert.equal(resolveAdOnlyLane(undefined), 'sales')
    assert.equal(resolveAdOnlyLane({}), 'sales')
    assert.equal(resolveAdOnlyLane({ page_id: 'P', system_video_id: 'sys' }), 'sales')
    assert.equal(resolveAdOnlyLane({ lane: 'sales' }), 'sales')
})

test('resolveAdOnlyLane selects follow for explicit lane/objective/flag hints', () => {
    assert.equal(resolveAdOnlyLane({ lane: 'follow' }), 'follow')
    assert.equal(resolveAdOnlyLane({ lane: 'page_like' }), 'follow')
    assert.equal(resolveAdOnlyLane({ lane: 'PAGE_LIKES' }), 'follow')
    assert.equal(resolveAdOnlyLane({ ad_objective: 'OUTCOME_ENGAGEMENT' }), 'follow')
    assert.equal(resolveAdOnlyLane({ follow: true }), 'follow')
    assert.equal(resolveAdOnlyLane({ follow: 'true' }), 'follow')
    assert.equal(resolveAdOnlyLane({ follow: 1 }), 'follow')
})

test('resolveFollowLaneTemplateAdset prefers body, then setting, then the corrected default', () => {
    assert.equal(FOLLOW_LANE_TEMPLATE_ADSET, '120248767074180263')
    assert.equal(resolveFollowLaneTemplateAdset({ bodyValue: '999', settingValue: '888' }), '999')
    assert.equal(resolveFollowLaneTemplateAdset({ settingValue: '888' }), '888')
    assert.equal(resolveFollowLaneTemplateAdset({}), FOLLOW_LANE_TEMPLATE_ADSET)
})

test('resolveFollowLaneCampaignSub1 falls back to the operator-confirmed campaign code', () => {
    assert.equal(FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT, '16JUN26FBSPCAD')
    assert.equal(resolveFollowLaneCampaignSub1('CUSTOM'), 'CUSTOM')
    assert.equal(resolveFollowLaneCampaignSub1(''), FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT)
    assert.equal(resolveFollowLaneCampaignSub1(undefined), FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT)
})

test('Follow shortlink carries EXACTLY two subs: sub1=campaign, sub2=page id, NO sub3 (default template)', () => {
    const url = buildFollowLaneShortlinkRequestUrl({
        template: DEFAULT_TEMPLATE,
        shopeeLink: FOLLOW_SHOPEE,
        campaignSub1: FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT,
        pageId: FOLLOW_PAGE_ID,
    })
    const u = new URL(url)
    // sub1 = campaign code, sub2 = page id — even though the default template has NO {sub_id2} slot.
    assert.equal(u.searchParams.get('sub1'), '16JUN26FBSPCAD')
    assert.equal(u.searchParams.get('sub2'), FOLLOW_PAGE_ID)
    // NO sub3/sub4/sub5 — the page id is NEVER repeated into a third sub (the page-page-page bug).
    assert.equal(u.searchParams.has('sub3'), false)
    assert.equal(u.searchParams.has('sub4'), false)
    assert.equal(u.searchParams.has('sub5'), false)
    // The product url survives single-encoded.
    assert.equal(u.searchParams.get('url'), FOLLOW_SHOPEE)
    // The page id appears in exactly ONE sub slot (sub2), proving utm_content can't be page-page-page.
    const subVals = ['sub1', 'sub2', 'sub3', 'sub4', 'sub5'].map((k) => u.searchParams.get(k)).filter(Boolean)
    assert.deepEqual(subVals, ['16JUN26FBSPCAD', FOLLOW_PAGE_ID])
    assert.equal(subVals.filter((v) => v === FOLLOW_PAGE_ID).length, 1)
})

test('Follow shortlink empties {sub_id3..5} placeholders when a sales-style template carries them', () => {
    const tmpl = 'https://short.wwoom.com/?id=15130770000&url={url}&sub1={sub_id}&sub2={sub_id2}&sub3={sub_id3}'
    const url = buildFollowLaneShortlinkRequestUrl({
        template: tmpl,
        shopeeLink: FOLLOW_SHOPEE,
        campaignSub1: 'CAMP',
        pageId: FOLLOW_PAGE_ID,
    })
    const u = new URL(url)
    assert.equal(u.searchParams.get('sub1'), 'CAMP')
    assert.equal(u.searchParams.get('sub2'), FOLLOW_PAGE_ID)
    assert.equal(u.searchParams.has('sub3'), false)
})

test('Follow shortlink uses the default campaign sub1 when none supplied', () => {
    const url = buildFollowLaneShortlinkRequestUrl({
        template: DEFAULT_TEMPLATE, shopeeLink: FOLLOW_SHOPEE, campaignSub1: '', pageId: FOLLOW_PAGE_ID,
    })
    assert.equal(new URL(url).searchParams.get('sub1'), '16JUN26FBSPCAD')
})

test('Follow creative message leads with the pin line `📌 พิกัด : <shortlink>` then the caption', () => {
    const msg = buildFollowLaneCreativeMessage({ caption: 'กดติดตามเพจ #ของดี', shortlink: 'https://s.shopee.co.th/x' })
    // Operator correction: shortlink at the TOP as the exact pin line, product caption/hashtags below.
    assert.equal(msg, '📌 พิกัด : https://s.shopee.co.th/x\nกดติดตามเพจ #ของดี')
    assert.equal(msg.split('\n')[0], '📌 พิกัด : https://s.shopee.co.th/x')
    assert.ok(msg.startsWith(FOLLOW_LANE_PIN_PREFIX))
    assert.ok(msg.includes('https://s.shopee.co.th/x'))
})

test('Follow creative message moves a legacy bottom shortlink line to the top pin line (no duplicate)', () => {
    // The legacy form baked the bare link at the BOTTOM; re-composing must flip it to the top pin line.
    const legacy = 'กดติดตามเพจ #ของดี\nhttps://s.shopee.co.th/x'
    const msg = buildFollowLaneCreativeMessage({ caption: legacy, shortlink: 'https://s.shopee.co.th/x' })
    assert.equal(msg, '📌 พิกัด : https://s.shopee.co.th/x\nกดติดตามเพจ #ของดี')
    assert.equal((msg.match(/https:\/\/s\.shopee\.co\.th\/x/g) || []).length, 1)
})

test('Follow creative message normalizes a legacy bare-shortlink first line into the pin line', () => {
    const legacy = 'https://s.shopee.co.th/x\nกดติดตามเพจ'
    const msg = buildFollowLaneCreativeMessage({ caption: legacy, shortlink: 'https://s.shopee.co.th/x' })
    assert.equal(msg, '📌 พิกัด : https://s.shopee.co.th/x\nกดติดตามเพจ')
    assert.equal((msg.match(/https:\/\/s\.shopee\.co\.th\/x/g) || []).length, 1)
})

test('Follow creative message is idempotent when the caption already leads with the pin line', () => {
    const composed = buildFollowLaneCreativeMessage({ caption: 'กดติดตามเพจ', shortlink: 'https://s.shopee.co.th/x' })
    const again = buildFollowLaneCreativeMessage({ caption: composed, shortlink: 'https://s.shopee.co.th/x' })
    assert.equal(again, composed)
    assert.equal((again.match(/https:\/\/s\.shopee\.co\.th\/x/g) || []).length, 1)
    assert.equal((again.match(/📌 พิกัด :/g) || []).length, 1)
})

test('Follow creative message removes an inline duplicate shortlink and still leads with the pin line', () => {
    const caption = 'ดูเลย https://s.shopee.co.th/x ของดี'
    const msg = buildFollowLaneCreativeMessage({ caption, shortlink: 'https://s.shopee.co.th/x' })
    assert.equal(msg, '📌 พิกัด : https://s.shopee.co.th/x\nดูเลย ของดี')
    assert.equal((msg.match(/https:\/\/s\.shopee\.co\.th\/x/g) || []).length, 1)
})

test('Follow creative message handles empty caption / empty shortlink', () => {
    // Empty caption → just the pin line. Empty shortlink → caption untouched (no pin line, nothing to track).
    assert.equal(buildFollowLaneCreativeMessage({ caption: '', shortlink: 'https://x' }), '📌 พิกัด : https://x')
    assert.equal(buildFollowLaneCreativeMessage({ caption: 'hi', shortlink: '' }), 'hi')
    assert.ok(!buildFollowLaneCreativeMessage({ caption: 'hi', shortlink: '' }).includes(FOLLOW_LANE_PIN_PREFIX))
})

test('Follow COMMENT shortlink carries THREE subs: sub1=campaign, sub2=page id, sub3=post tail (default template)', () => {
    const url = buildFollowLaneCommentShortlinkRequestUrl({
        template: DEFAULT_TEMPLATE,
        shopeeLink: FOLLOW_SHOPEE,
        campaignSub1: FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT,
        pageId: FOLLOW_PAGE_ID,
        postTail: '987654321',
    })
    const u = new URL(url)
    // The comment-tracking link is THREE-sub even though the default template only carries `sub1=`.
    assert.equal(u.searchParams.get('sub1'), '16JUN26FBSPCAD')
    assert.equal(u.searchParams.get('sub2'), FOLLOW_PAGE_ID)
    assert.equal(u.searchParams.get('sub3'), '987654321')
    // Never a fourth/fifth sub.
    assert.equal(u.searchParams.has('sub4'), false)
    assert.equal(u.searchParams.has('sub5'), false)
    assert.equal(u.searchParams.get('url'), FOLLOW_SHOPEE)
})

test('Follow COMMENT shortlink drops sub3 (never repeats sub2) when the post tail is empty', () => {
    const url = buildFollowLaneCommentShortlinkRequestUrl({
        template: DEFAULT_TEMPLATE,
        shopeeLink: FOLLOW_SHOPEE,
        campaignSub1: 'CAMP',
        pageId: FOLLOW_PAGE_ID,
        postTail: '',
    })
    const u = new URL(url)
    assert.equal(u.searchParams.get('sub1'), 'CAMP')
    assert.equal(u.searchParams.get('sub2'), FOLLOW_PAGE_ID)
    assert.equal(u.searchParams.has('sub3'), false)
    // The page id appears in exactly ONE sub slot — never the page-page-page bug.
    const subVals = ['sub1', 'sub2', 'sub3'].map((k) => u.searchParams.get(k)).filter(Boolean)
    assert.equal(subVals.filter((v) => v === FOLLOW_PAGE_ID).length, 1)
})

test('Follow COMMENT shortlink defaults sub1 to the operator campaign code when none supplied', () => {
    const url = buildFollowLaneCommentShortlinkRequestUrl({
        template: DEFAULT_TEMPLATE, shopeeLink: FOLLOW_SHOPEE, campaignSub1: '', pageId: FOLLOW_PAGE_ID, postTail: '55',
    })
    assert.equal(new URL(url).searchParams.get('sub1'), '16JUN26FBSPCAD')
})

test('Follow COMMENT message is the final shortlink then the exact two-line Page comment template', () => {
    const msg = buildFollowLaneCommentMessage('https://s.shopee.co.th/final')
    assert.equal(
        msg,
        'https://s.shopee.co.th/final\n📌 พิกัดอยู่ตรงนี้เลย กดเข้าไปดูเองได้\n🟠 สั่งผ่านลิงก์เพจเป็นพาร์ทเนอร์กับ Shopee ปลอดภัย 💯',
    )
    // The final shortlink is the FIRST line.
    assert.equal(msg.split('\n')[0], 'https://s.shopee.co.th/final')
    // The two standing CTA lines are exactly the exported constant.
    assert.deepEqual(msg.split('\n').slice(1), [...FOLLOW_LANE_COMMENT_BODY_LINES])
})

test('Follow COMMENT message is empty when there is no shortlink (caller skips the comment)', () => {
    assert.equal(buildFollowLaneCommentMessage(''), '')
})

test('Follow lane handler remints a three-sub COMMENT shortlink off the story tail and posts the Page comment', () => {
    const src = getFollowLaneHandlerSource()
    // Re-mints the FINAL three-sub comment shortlink (not the two-sub creative-message link) using the
    // bridge-returned story tail as sub3.
    assert.match(src, /buildFollowLaneCommentShortlinkRequestUrl\(/)
    assert.match(src, /postTail: commentPostTail/)
    assert.match(src, /commentPostTail = adHistoryStoryTail\(adStoryIdForProof\)/)
    // Posts the exact-template Page comment on the actual ad story via the Page-comment bridge.
    assert.match(src, /buildFollowLaneCommentMessage\(commentShortlink\)/)
    assert.match(src, /\/page-comment/)
    assert.match(src, /story_id: adStoryIdForProof/)
    // Surfaces sanitized comment proof fields (no tokens).
    assert.match(src, /follow_comment_status/)
    assert.match(src, /follow_comment_id/)
    assert.match(src, /follow_comment_error/)
    assert.match(src, /follow_comment_shortlink/)
    assert.match(src, /follow_comment_sub2 = validation\.pageId/)
    assert.match(src, /follow_comment_sub3 = commentPostTail/)
    assert.match(src, /comment_target_story_id = adStoryIdForProof/)
    // Comment is comment-tracking ONLY: the Follow lane never calls the SHOP_NOW story CTA repair path.
    assert.doesNotMatch(src, /\/update-cta/)
    assert.doesNotMatch(src, /cta_type: 'SHOP_NOW'/)
})

test('buildFollowAutoPickBody defaults to non-spending paused with lane=follow but still uses the daily campaign', () => {
    const body = buildFollowAutoPickBody({
        candidate: { pageId: FOLLOW_PAGE_ID, videoId: 'fb-1', postId: `${FOLLOW_PAGE_ID}_77`, systemVideoId: 'sys-1', shopeeLink: FOLLOW_SHOPEE },
        templateAdset: FOLLOW_LANE_TEMPLATE_ADSET,
        campaignSub1: FOLLOW_LANE_SHORTLINK_SUB1_DEFAULT,
        dailyCampaignName: '25/Jun/2026',
    })
    assert.equal(body.lane, 'follow')
    assert.equal(body.mode, 'paused')
    assert.equal(body.page_id, FOLLOW_PAGE_ID)
    assert.equal(body.system_video_id, 'sys-1')
    assert.equal(body.template_adset, '120248767074180263')
    assert.equal(body.follow_campaign_sub1, '16JUN26FBSPCAD')
    assert.equal(body.daily_campaign_name, '25/Jun/2026')
    // paused never spends → no budget/run-hours fields.
    assert.equal(body.daily_budget_thb, undefined)
    assert.equal(body.run_hours, undefined)
})

test('buildFollowAutoPickBody active mode carries the Bangkok daily campaign + CBO budget + run hours', () => {
    const body = buildFollowAutoPickBody({
        candidate: { pageId: FOLLOW_PAGE_ID, videoId: 'fb-1', systemVideoId: 'sys-1', shopeeLink: FOLLOW_SHOPEE },
        mode: 'active',
        dailyCampaignName: '24/Jun/2026',
        templateAdset: FOLLOW_LANE_TEMPLATE_ADSET,
    })
    assert.equal(body.lane, 'follow')
    assert.equal(body.mode, 'active')
    assert.equal(body.daily_campaign_name, '24/Jun/2026')
    assert.equal(body.daily_budget_thb, DEFAULT_DAILY_BUDGET_THB)
    assert.equal(body.run_hours, DEFAULT_RUN_HOURS)
})

test('create-ad-only route branches into the Follow lane via resolveAdOnlyLane', () => {
    const route = getCreateAdOnlyRouteSource()
    assert.match(route, /resolveAdOnlyLane\(body\)\s*===\s*'follow'/)
    assert.match(route, /return await runFollowLaneCreateAdOnly\(c, body, validation, schedule\)/)
})

test('Follow lane handler uses the two-sub shortlink, caption-embedded link, Follow template and LIKE_PAGE CTA', () => {
    const src = getFollowLaneHandlerSource()
    // Two-sub shortlink builder (not the sales 3-sub buildAdOnlyShortlinkRequestUrl).
    assert.match(src, /buildFollowLaneShortlinkRequestUrl\(/)
    assert.match(src, /pageId: validation\.pageId/)
    // Caption + shortlink composed into the creative message and sent as the bridge caption.
    assert.match(src, /buildFollowLaneCreativeMessage\(/)
    assert.match(src, /caption: creativeMessage/)
    // Follow template adset (per-page override key) + LIKE_PAGE CTA hint.
    assert.match(src, /FOLLOW_LANE_TEMPLATE_ADSET_SETTING_KEY/)
    assert.match(src, /resolveFollowLaneTemplateAdset\(/)
    assert.match(src, /call_to_action_type: FOLLOW_LANE_CTA_TYPE/)
    assert.equal(FOLLOW_LANE_CTA_TYPE, 'LIKE_PAGE')
    // Hard separation: dark/ad story only, never a visible Page post.
    assert.match(src, /skip_publish_to_page: true/)
    // Records the lane on the audit row.
    assert.match(src, /lane: 'follow'/)
})

test('Follow lane scheduler exposes scheduler_enabled + interval + run-next and is OPT-IN/paused-default', () => {
    const source = getIndexSource()
    assert.match(source, /app\.put\('\/api\/dashboard\/follow-ad\/enabled'/)
    assert.match(source, /app\.get\('\/api\/dashboard\/follow-ad\/status'/)
    assert.match(source, /app\.put\('\/api\/dashboard\/follow-ad\/interval'/)
    assert.match(source, /app\.post\('\/api\/dashboard\/follow-ad\/run-next'/)
    // Cron-wired alongside the click-link ad-only scheduler.
    assert.match(source, /maybeProcessFollowAdOnSchedule\(env\)/)
    // OPT-IN default off (settings default '0').
    assert.match(source, /row\?\.value \?\? '0'/)
    // Follow scheduler create body routes through the SAME create-ad-only endpoint with a follow body.
    assert.match(source, /buildFollowAutoPickBody\(\{/)
})

// =====================================================================
// SCHEDULER JITTER — anti-automation-pattern pacing for the Follow lane.
// =====================================================================

test('computeSchedulerJitterMs stays within the bounds and is deterministic for a fixed rng', () => {
    // r in [0,1] maps linearly into [lo, hi].
    assert.equal(computeSchedulerJitterMs(1000, 5000, () => 0), 1000)
    assert.equal(computeSchedulerJitterMs(1000, 5000, () => 1), 5000)
    assert.equal(computeSchedulerJitterMs(1000, 5000, () => 0.5), 3000)
    // Out-of-[0,1] / NaN rng output is clamped, never escaping the bounds.
    assert.equal(computeSchedulerJitterMs(1000, 5000, () => 2), 5000)
    assert.equal(computeSchedulerJitterMs(1000, 5000, () => -1), 1000)
    assert.equal(computeSchedulerJitterMs(1000, 5000, () => NaN), 1000)
    // Swapped / negative bounds are normalized; degenerate range returns lo.
    assert.equal(computeSchedulerJitterMs(5000, 1000, () => 0), 1000)
    assert.equal(computeSchedulerJitterMs(-50, -10, () => 0.5), 0)
    assert.equal(computeSchedulerJitterMs(2000, 2000, () => 0.5), 2000)
})

test('computeSchedulerJitterMs default Follow bounds give sub-interval, second-level spread', () => {
    // The default jitter window is meaningfully smaller than the 20-min default interval (so the base
    // cadence still dominates) but large enough to break the exact ~30-min lockstep.
    assert.ok(DEFAULT_FOLLOW_AD_JITTER_MIN_MS > 0)
    assert.ok(DEFAULT_FOLLOW_AD_JITTER_MAX_MS > DEFAULT_FOLLOW_AD_JITTER_MIN_MS)
    assert.equal(DEFAULT_FOLLOW_AD_JITTER_MIN_MS, DEFAULT_FOLLOW_AD_JITTER_MIN_MINUTES * 60_000)
    assert.equal(DEFAULT_FOLLOW_AD_JITTER_MAX_MS, DEFAULT_FOLLOW_AD_JITTER_MAX_MINUTES * 60_000)
    assert.ok(DEFAULT_FOLLOW_AD_JITTER_MAX_MINUTES < DEFAULT_AD_ONLY_INTERVAL_MINUTES)
})

test('computeJitteredNextRunAtMs is always within [base+interval+minJitter, base+interval+maxJitter]', () => {
    const base = 1_700_000_000_000
    const interval = 30 // minutes
    const intervalMs = interval * 60_000
    const lo = base + intervalMs + DEFAULT_FOLLOW_AD_JITTER_MIN_MS
    const hi = base + intervalMs + DEFAULT_FOLLOW_AD_JITTER_MAX_MS
    // Exhaustively probe a spread of rng outputs; every result lands inside the inclusive bound, and is
    // STRICTLY greater than the plain base+interval (so the run never fires on the exact boundary).
    for (let i = 0; i <= 20; i++) {
        const r = i / 20
        const next = computeJitteredNextRunAtMs({ baseMs: base, intervalMinutes: interval, rng: () => r })
        assert.ok(next >= lo, `next ${next} >= lo ${lo} at r=${r}`)
        assert.ok(next <= hi, `next ${next} <= hi ${hi} at r=${r}`)
        assert.ok(next > base + intervalMs, `jittered next ${next} must exceed exact base+interval at r=${r}`)
    }
    // The interval is clamped/defaulted by the shared helper (0 → default), so a bad interval never
    // collapses the offset to the exact boundary.
    const defaulted = computeJitteredNextRunAtMs({ baseMs: base, intervalMinutes: 0, rng: () => 0 })
    assert.equal(defaulted, base + DEFAULT_AD_ONLY_INTERVAL_MINUTES * 60_000 + DEFAULT_FOLLOW_AD_JITTER_MIN_MS)
    // Explicit jitter bounds override the defaults.
    const custom = computeJitteredNextRunAtMs({ baseMs: base, intervalMinutes: interval, minJitterMs: 0, maxJitterMs: 0, rng: () => 0.5 })
    assert.equal(custom, base + intervalMs)
})

test('decideJitteredScheduleRun: a stored future slot is jitter_pending and never re-rolled', () => {
    const now = 1_700_000_000_000
    const d = decideJitteredScheduleRun({
        nowMs: now,
        lastRunMs: now - 60_000,
        storedNextRunMs: now + 5 * 60_000, // 5 min in the future
        intervalMinutes: 30,
        rng: () => 0.42,
    })
    assert.equal(d.due, false)
    assert.equal(d.reason, 'jitter_pending')
    assert.equal(d.persistNextRun, false) // a valid stored slot is honored as-is, not rewritten
    assert.equal(d.nextRunAtMs, now + 5 * 60_000)
})

test('decideJitteredScheduleRun: a stored past slot is due, and leaves re-scheduling to the caller', () => {
    const now = 1_700_000_000_000
    const d = decideJitteredScheduleRun({
        nowMs: now,
        lastRunMs: now - 60 * 60_000,
        storedNextRunMs: now - 1000, // already reached
        intervalMinutes: 30,
        rng: () => 0.42,
    })
    assert.equal(d.due, true)
    assert.equal(d.reason, 'due')
    assert.equal(d.persistNextRun, false)
})

test('decideJitteredScheduleRun: no stored slot derives + persists a future jittered slot when not yet due', () => {
    const now = 1_700_000_000_000
    const lastRun = now - 60_000 // 1 min ago, interval 30 min ⇒ not due for ~29+ min
    const d = decideJitteredScheduleRun({
        nowMs: now,
        lastRunMs: lastRun,
        storedNextRunMs: NaN, // unset
        intervalMinutes: 30,
        rng: () => 0.5,
    })
    assert.equal(d.due, false)
    assert.equal(d.reason, 'jitter_pending')
    assert.equal(d.persistNextRun, true) // first derivation is persisted so later ticks don't re-roll
    // The derived slot equals the pure next-run helper for the same inputs and is in the future.
    const expected = computeJitteredNextRunAtMs({ baseMs: lastRun, intervalMinutes: 30, rng: () => 0.5 })
    assert.equal(d.nextRunAtMs, expected)
    assert.ok(d.nextRunAtMs > now)
})

test('decideJitteredScheduleRun: no stored slot and last_run long ago is due now (run, then re-schedule)', () => {
    const now = 1_700_000_000_000
    const d = decideJitteredScheduleRun({
        nowMs: now,
        lastRunMs: now - 5 * 60 * 60_000, // 5h ago ≫ interval + max jitter
        storedNextRunMs: NaN,
        intervalMinutes: 30,
        rng: () => 0.9,
    })
    assert.equal(d.due, true)
    assert.equal(d.reason, 'due')
    assert.equal(d.persistNextRun, false)
})

test('decideJitteredScheduleRun: never-ran (no last_run, no stored slot) anchors jitter from now, not the epoch', () => {
    const now = 1_700_000_000_000
    const d = decideJitteredScheduleRun({
        nowMs: now,
        lastRunMs: NaN, // never ran
        storedNextRunMs: NaN,
        intervalMinutes: 30,
        rng: () => 0,
    })
    // Anchored at now ⇒ first slot is now + interval + jitter (not due immediately), and persisted.
    assert.equal(d.due, false)
    assert.equal(d.persistNextRun, true)
    assert.equal(d.nextRunAtMs, computeJitteredNextRunAtMs({ baseMs: now, intervalMinutes: 30, rng: () => 0 }))
})

test('Follow scheduler is jittered: gate + persistence wiring (source guard)', () => {
    const source = getIndexSource()
    const start = source.indexOf('async function maybeProcessFollowAdOnSchedule')
    assert.notEqual(start, -1, 'maybeProcessFollowAdOnSchedule must exist')
    const fn = source.slice(start, start + 2500)
    // Uses the pure jittered decision, NOT the bare exact-interval gate.
    assert.match(fn, /decideJitteredScheduleRun\(\{/)
    assert.doesNotMatch(fn, /isAdOnlyQueueDue\(/) // the exact-boundary gate is no longer the Follow gate
    // Persists a derived future slot when not yet due, so jitter isn't re-rolled every tick.
    assert.match(fn, /decision\.persistNextRun/)
    // Pre-arms the NEXT jittered slot from now after claiming, via the pure helper.
    assert.match(fn, /computeJitteredNextRunAtMs\(\{ baseMs: nowMs/)
    assert.match(fn, /FOLLOW_AD_SCHED_NEXT_RUN_KEY/)
    // Still seeds the rng from the wall clock (deterministic tests inject a seed; runtime varies it).
    assert.match(fn, /makeSeededRng\(/)
})

// Slice a single Hono route handler: from its `app.<verb>('<path>'` opener to the start of the NEXT
// top-level declaration (another route, a function, or a section banner), so an assertion can't bleed
// into an adjacent handler/function.
function sliceRoute(source: string, opener: string): string {
    const start = source.indexOf(opener)
    assert.notEqual(start, -1, `${opener} must exist`)
    const after = start + opener.length
    const ends = ['\napp.', '\nasync function ', '\nfunction ', '\n// ====']
        .map((m) => source.indexOf(m, after))
        .filter((i) => i !== -1)
    const end = ends.length ? Math.min(...ends) : Math.min(source.length, start + 4000)
    return source.slice(start, end)
}

test('Follow status endpoint reports the stored jittered slot and does NOT mutate on GET', () => {
    const route = sliceRoute(getIndexSource(), "app.get('/api/dashboard/follow-ad/status'")
    // Reads the stored jittered next-due and prefers it over the plain interval estimate.
    assert.match(route, /FOLLOW_AD_SCHED_NEXT_RUN_KEY/)
    assert.match(route, /Number\.isFinite\(storedNextMs\)/)
    // GET must not write the next-run setting (no mutation on read).
    assert.doesNotMatch(route, /setDashboardSetting/)
})

test('Follow interval change clears the stale jittered slot so the new cadence applies', () => {
    const route = sliceRoute(getIndexSource(), "app.put('/api/dashboard/follow-ad/interval'")
    assert.match(route, /setDashboardSetting\(c\.env\.DB, FOLLOW_AD_SCHED_NEXT_RUN_KEY, ''\)/)
})

test('Manual Follow run-next stays immediate (no jitter gate)', () => {
    const route = sliceRoute(getIndexSource(), "app.post('/api/dashboard/follow-ad/run-next'")
    // Calls processOneFollowAd directly, bypassing any jitter/interval gate.
    assert.match(route, /processOneFollowAd\(c\.env\)/)
    assert.doesNotMatch(route, /decideJitteredScheduleRun/)
    assert.doesNotMatch(route, /computeJitteredNextRunAtMs/)
})
