import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideProcessingRetry, PROCESSING_AUTO_RETRY_MAX_ATTEMPTS } from '../src/processing-retry-policy.js'

const now = Date.parse('2026-06-04T12:00:00.000Z')

test('retries transient Gemini request failures when due', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'gemini_pipeline_failed',
        error: 'error sending request for url https://aiplatform.googleapis.com/...',
        failedAt: '2026-06-04T11:58:00.000Z',
        retryCount: 0,
        now,
    })
    assert.equal(decision.action, 'retry_now')
    assert.equal(decision.retryable, true)
    assert.equal(decision.attempts, 0)
})

test('does not retry FFmpeg preprocessing timeout because it blocks the queue', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'ffmpeg_timeout',
        error: 'FFmpeg flip timed out (>180s)',
        failedAt: '2026-06-04T11:59:30.000Z',
        retryCount: 0,
        now,
    })
    assert.equal(decision.action, 'terminal')
    assert.equal(decision.retryable, false)
    assert.equal(decision.reason, 'non_retryable:ffmpeg_timeout')
})

test('backs off Gemini 429/resource exhausted for a long cooldown', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'gemini_pipeline_failed',
        error: 'Vertex Gemini gemini-safe http_429: Resource exhausted. Please try again later',
        failedAt: '2026-06-04T11:50:00.000Z',
        retryCount: 1,
        now,
    })
    assert.equal(decision.action, 'wait')
    assert.equal(decision.reason, 'backoff')
    assert.equal(decision.nextRetryAt, '2026-06-04T12:20:00.000Z')
})

test('uses retry history length when retryCount is missing', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'pipeline_handoff_stale_timeout',
        failedAt: '2026-06-04T11:00:00.000Z',
        retryHistory: [{}, {}, {}],
        now,
    })
    assert.equal(decision.action, 'retry_now')
    assert.equal(decision.attempts, 3)
})

test('stops retrying after max attempts', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'gemini_pipeline_failed',
        error: 'timeout',
        failedAt: '2026-06-04T10:00:00.000Z',
        retryCount: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS,
        now,
    })
    assert.equal(decision.action, 'terminal')
    assert.equal(decision.retryable, true)
    assert.equal(decision.reason, 'max_attempts_exceeded')
})

test('retries container version mismatch after a corrective deploy window', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'container_version_mismatch',
        error: 'Container version mismatch: expected old, got new',
        failedAt: '2026-06-04T11:00:00.000Z',
        retryCount: 1,
        now,
    })
    assert.equal(decision.action, 'retry_now')
    assert.equal(decision.retryable, true)
    assert.equal(decision.attempts, 1)
})

test('does not retry missing original assets even when the broad category is dispatch failed', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'pipeline_dispatch_failed',
        error: 'missing_original_video_asset_unrecoverable',
        failedAt: '2026-06-04T10:00:00.000Z',
        retryCount: 0,
        now,
    })
    assert.equal(decision.action, 'terminal')
    assert.equal(decision.retryable, false)
    assert.equal(decision.reason, 'non_retryable:missing_original_video_asset_unrecoverable')
})

test('does not retry hard invalid source failures', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'source_video_invalid',
        error: 'source_video_invalid',
        failedAt: '2026-06-04T10:00:00.000Z',
        now,
    })
    assert.equal(decision.action, 'terminal')
    assert.equal(decision.retryable, false)
})

test('does not retry unclassified business-rule failures', () => {
    const decision = decideProcessingRetry({
        status: 'failed',
        errorCategory: 'managed_shortlink_conversion_failed',
        error: 'managed shortlink failed',
        failedAt: '2026-06-04T10:00:00.000Z',
        now,
    })
    assert.equal(decision.action, 'terminal')
    assert.equal(decision.retryable, false)
})
