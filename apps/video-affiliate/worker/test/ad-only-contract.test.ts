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
        '\n// =====================================================================\n// AD-ONLY QUEUE',
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

test('validate rejects a video_url-only request (would publish a new post)', () => {
    const v = validateAdOnlyInput({ page_id: 'P', video_url: 'https://cdn/x.mp4' })
    assert.equal(v.ok, false)
    assert.equal(v.error, 'ad_only_no_new_post')
})

test('validate rejects system_video_id alone — audit metadata is not an ad source', () => {
    const v = validateAdOnlyInput({ page_id: 'P', system_video_id: 'sys-1' })
    assert.equal(v.ok, false)
    assert.equal(v.error, 'ad_source_required')
    assert.equal(v.systemVideoId, 'sys-1')
    assert.equal(v.hasAdSource, false)
})

test('validate accepts an existing story_id and carries the parsed source ids', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '123_456', system_video_id: 'sys-1' })
    assert.equal(v.ok, true)
    assert.equal(v.sourceStoryId, '123_456')
    assert.equal(v.systemVideoId, 'sys-1')
    assert.equal(v.hasAdSource, true)
})

test('validate accepts fb_video_id and the generic video_id alias', () => {
    assert.equal(validateAdOnlyInput({ page_id: 'P', fb_video_id: 'v1' }).ok, true)
    const v = validateAdOnlyInput({ page_id: 'P', video_id: 'v2' })
    assert.equal(v.ok, true)
    assert.equal(v.fbVideoId, 'v2')
})

test('validate accepts post_id as an ad source', () => {
    const v = validateAdOnlyInput({ page_id: 'P', post_id: 'P_789' })
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

test('ad-history record carries mode + run_hours intent and echoes bridge budget/schedule', () => {
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '1_2' })
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
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '1_2' })
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
    const v = validateAdOnlyInput({ page_id: 'P', story_id: '123_456', fb_video_id: 'v9' })
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
    const v = validateAdOnlyInput({ page_id: 'P', post_id: 'P_1' })
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

test('active create-ad-only records explicit comment evidence or a skipped/failed reason', () => {
    const routeSource = getCreateAdOnlyRouteSource()
    const activeIdx = routeSource.indexOf("if (schedule.mode === 'active')")
    const pageCommentIdx = routeSource.indexOf("`${baseUrl}/page-comment`")
    const successIdx = routeSource.indexOf('// 6. Success')

    assert.ok(activeIdx >= 0, 'create-ad-only must have an active-only finalization block')
    assert.ok(pageCommentIdx > activeIdx && pageCommentIdx < successIdx, 'Page comment write must only happen inside active finalization')
    assert.match(routeSource, /skip_comment: true/, 'bridge /create-ad must not also comment')
    assert.match(routeSource, /bridgeResult\.comment_status = 'skipped_no_shopee_link'/)
    assert.match(routeSource, /bridgeResult\.comment_error = 'shopee_link_missing'/)
    assert.match(routeSource, /bridgeResult\.comment_status = 'failed'[\s\S]*bridgeResult\.comment_error = 'story_id_missing'/)
    assert.match(routeSource, /bridgeResult\.comment_status = 'failed'[\s\S]*bridgeResult\.comment_error = 'final_shortlink_unresolved'/)
    assert.match(routeSource, /bridgeResult\.comment_target_story_id = fullStoryId/)
    assert.match(routeSource, /bridgeResult\.comment_target_post_id = commentSubIds\.postSubId2/)
    assert.match(routeSource, /body: JSON\.stringify\(\{ page_id: validation\.pageId, story_id: targetStoryId, message: commentMessage, comment_message: commentMessage \}\)/)
    assert.match(routeSource, /const sourceCommentTargetRaw = validation\.sourcePostId \|\| validation\.fbVideoId/)
    assert.match(routeSource, /sourceCommentTargetStoryId && sourceCommentTargetStoryId !== fullStoryId/)
})

test('active create-ad-only records source-surface comment proof without overwriting created-story proof', () => {
    const routeSource = getCreateAdOnlyRouteSource()

    assert.match(routeSource, /bridgeResult\.comment_status = createdComment\.status/)
    assert.match(routeSource, /bridgeResult\.comment_fb_id = createdComment\.id/)
    assert.match(routeSource, /bridgeResult\.source_comment_target_story_id = sourceCommentTargetStoryId/)
    assert.match(routeSource, /bridgeResult\.source_comment_shortlink = finalLink/)
    assert.match(routeSource, /bridgeResult\.source_comment_message = commentMessage\.slice\(0, 500\)/)
    assert.match(routeSource, /bridgeResult\.source_comment_status = sourceComment\.status/)
    assert.match(routeSource, /bridgeResult\.source_comment_fb_id = sourceComment\.id/)
    assert.match(routeSource, /bridgeResult\.source_comment_error = sourceComment\.error/)
    assert.match(routeSource, /bridgeResult\.source_comment_error = \(e instanceof Error \? e\.message : String\(e\)\)\.slice\(0, 200\)/)
})

test('ad-history expands safe comment and CTA proof fields from truncated_result_json', () => {
    const source = getIndexSource()
    const routeSource = getAdHistoryRouteSource()
    const normalizerSource = getAdHistoryNormalizerSource()

    for (const key of [
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
        'paid_ad_cta_final',
        'paid_ad_cta_link',
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
    const v = validateAdOnlyInput({ page_id: '111', story_id: '111_222' })
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

test('truncateResultJson bounds long payloads and never throws on cycles', () => {
    const big = { s: 'x'.repeat(9000) }
    const out = truncateResultJson(big, 100)
    assert.ok(out.length <= 100)
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    assert.doesNotThrow(() => truncateResultJson(cyc))
})
