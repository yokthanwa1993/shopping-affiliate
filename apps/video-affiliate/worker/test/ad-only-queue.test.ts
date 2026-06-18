import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildAdOnlyCreateBody,
    clampAdOnlyIntervalMinutes,
    isAdOnlyQueueDue,
    nextAdOnlyRunAtMs,
    AD_ONLY_QUEUE_ENDPOINT,
    DEFAULT_AD_ONLY_INTERVAL_MINUTES,
    MIN_AD_ONLY_INTERVAL_MINUTES,
    MAX_AD_ONLY_INTERVAL_MINUTES,
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
