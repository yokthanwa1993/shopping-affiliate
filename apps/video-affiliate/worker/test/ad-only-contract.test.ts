import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    validateAdOnlyInput,
    resolveAdOnlySchedule,
    buildAdOnlyUnsupportedResult,
    buildAdHistoryRecord,
    truncateResultJson,
    AD_ONLY_BRIDGE_SUPPORTS_PAUSED,
    AD_ONLY_MISSING_BRIDGE_FIELDS,
    DEFAULT_DAILY_BUDGET_THB,
    DEFAULT_RUN_HOURS,
    MAX_RUN_HOURS,
} from '../src/ad-only-contract.js'

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

test('truncateResultJson bounds long payloads and never throws on cycles', () => {
    const big = { s: 'x'.repeat(9000) }
    const out = truncateResultJson(big, 100)
    assert.ok(out.length <= 100)
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    assert.doesNotThrow(() => truncateResultJson(cyc))
})
