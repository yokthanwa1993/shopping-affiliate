// Pure retry policy for Processing failures.
//
// Keep this module import-free so it can be unit-tested without loading the
// Worker entrypoint or secrets. The Worker/container can write terminal-looking
// `_processing/*.json` failures directly; this policy decides whether those are
// truly terminal or should be retried automatically with bounded backoff.

export type ProcessingRetryAction = 'retry_now' | 'wait' | 'terminal'

export interface ProcessingRetryDecision {
    action: ProcessingRetryAction
    retryable: boolean
    attempts: number
    maxAttempts: number
    nextRetryAt?: string
    reason: string
}

export interface ProcessingRetryPolicyInput {
    status?: unknown
    errorCategory?: unknown
    error?: unknown
    failedAt?: unknown
    updatedAt?: unknown
    retryCount?: unknown
    retryHistory?: unknown
    now?: number | Date
}

export const PROCESSING_AUTO_RETRY_MAX_ATTEMPTS = 5

const RETRY_BACKOFF_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000]
const RATE_LIMIT_RETRY_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000]

const RETRYABLE_CATEGORIES = new Set([
    'pipeline_handoff_stale_timeout',
    'gemini_pipeline_failed',
    'container_health_timeout',
    'container_dispatch_timeout',
    'container_pipeline_error',
    'container_pipeline_failed',
    'container_version_mismatch',
    'pipeline_dispatch_failed',
    'gemini_file_wait_timeout',
    'gemini_safe_transcode_timeout',
    'gemini_strict_transcode_timeout',
    'gemini_preparation_stale_timeout',
    'stale_timeout',
])

const NON_RETRYABLE_CATEGORIES = new Set([
    'source_video_invalid',
    'managed_shortlink_conversion_failed',
    'gemini_configuration_error',
    'gemini_safe_output_invalid',
    'gemini_strict_output_invalid',
    'ffmpeg_timeout',
    'missing_original_video_asset_unrecoverable',
])

function normalize(value: unknown): string {
    return String(value || '').trim().toLowerCase()
}

function numericRetryCount(value: unknown): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function retryHistoryCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0
}

function epochMs(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : NaN
}

function isRetryableByText(category: string, error: string): boolean {
    const combined = `${category} ${error}`
    if (category && RETRYABLE_CATEGORIES.has(category)) return true
    return combined.includes('timeout')
        || combined.includes('timed out')
        || combined.includes('deadline')
        || combined.includes('temporarily')
        || combined.includes('econnreset')
        || combined.includes('etimedout')
        || combined.includes('network')
        || combined.includes('error sending request')
        || combined.includes('request for url')
        || combined.includes('429')
        || combined.includes('resource exhausted')
        || combined.includes('quota')
        || combined.includes('503')
        || combined.includes('502')
        || combined.includes('504')
}

function isRateLimitedByText(category: string, error: string): boolean {
    const combined = `${category} ${error}`
    return combined.includes('429')
        || combined.includes('resource exhausted')
        || combined.includes('quota')
        || combined.includes('rate limit')
}

export function decideProcessingRetry(input: ProcessingRetryPolicyInput): ProcessingRetryDecision {
    const status = normalize(input.status)
    if (status !== 'failed') {
        return {
            action: 'terminal',
            retryable: false,
            attempts: numericRetryCount(input.retryCount),
            maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS,
            reason: 'not_failed',
        }
    }

    const category = normalize(input.errorCategory)
    const error = normalize(input.error)
    const attempts = Math.max(numericRetryCount(input.retryCount), retryHistoryCount(input.retryHistory))

    if (category && NON_RETRYABLE_CATEGORIES.has(category)) {
        return { action: 'terminal', retryable: false, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, reason: `non_retryable:${category}` }
    }
    if (error && NON_RETRYABLE_CATEGORIES.has(error)) {
        return { action: 'terminal', retryable: false, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, reason: `non_retryable:${error}` }
    }

    const retryable = isRetryableByText(category, error)
    if (!retryable) {
        return { action: 'terminal', retryable: false, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, reason: 'non_retryable:unclassified' }
    }

    if (attempts >= PROCESSING_AUTO_RETRY_MAX_ATTEMPTS) {
        return { action: 'terminal', retryable: true, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, reason: 'max_attempts_exceeded' }
    }

    const nowMs = epochMs(input.now ?? Date.now())
    const failedMs = epochMs(input.failedAt || input.updatedAt)
    if (!Number.isFinite(failedMs) || failedMs <= 0 || !Number.isFinite(nowMs)) {
        return { action: 'retry_now', retryable: true, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, reason: 'missing_failed_at' }
    }

    const backoffTable = isRateLimitedByText(category, error) ? RATE_LIMIT_RETRY_BACKOFF_MS : RETRY_BACKOFF_MS
    const backoffMs = backoffTable[Math.min(attempts, backoffTable.length - 1)]
    const nextMs = failedMs + backoffMs
    const nextRetryAt = new Date(nextMs).toISOString()
    if (nowMs >= nextMs) {
        return { action: 'retry_now', retryable: true, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, nextRetryAt, reason: 'due' }
    }

    return { action: 'wait', retryable: true, attempts, maxAttempts: PROCESSING_AUTO_RETRY_MAX_ATTEMPTS, nextRetryAt, reason: 'backoff' }
}
