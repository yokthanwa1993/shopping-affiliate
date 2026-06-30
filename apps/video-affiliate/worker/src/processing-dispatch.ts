// Shared, deterministic "start the next processing job" decision logic.
//
// The video pipeline has many entry points that each need to answer the same
// question after a job finishes (or on a scheduled tick): "what should run
// next for this namespace?". Historically that ordering was duplicated and
// inconsistent across the completion callback, the cron guardian, and the
// manual drainers, which is how the Processing flow could stop after a few
// videos — some paths only drained the durable `_queue/` and never fell back to
// the ready inbox / original library.
//
// This module centralises the ordering and makes it unit-testable by injecting
// the side-effecting steps. It intentionally has no imports so it can be
// compiled and tested in isolation (no secrets, no env, no worker entrypoint).
//
// Invariant: at most one active processing job per namespace. `hasActiveJob`
// short-circuits the whole dispatch, and each start step is itself expected to
// re-check before writing a new `_processing/` record.

export type ProcessingDispatchSource =
    | 'active' // a job is already running for this namespace; nothing new started
    | 'retry' // requeued a retryable failed processing record
    | 'queue' // started the next durable `_queue/` entry
    | 'ai_clip_source' // materialized + started the next unprocessed AI clip (new source library)
    | 'ready_inbox' // started the next ready inbox / gallery_index candidate (legacy)
    | 'admin_original' // imported + started the next admin original-library item (legacy)
    | 'idle' // nothing ready to start

export interface ProcessingDispatchResult {
    namespaceId: string
    started: boolean
    source: ProcessingDispatchSource
    detail?: string
}

export interface ProcessingDispatchSteps {
    // True when the namespace already has a non-failed `_processing/` job in
    // flight. Enforces the one-active-job-per-namespace invariant.
    hasActiveJob: () => Promise<boolean>
    // Optional: requeue one retryable failed `_processing/` record whose
    // backoff is due before pulling fresh backlog. This lets transient failures
    // heal automatically without blocking the one-active-job invariant.
    retryFailedJob?: () => Promise<boolean>
    // Drains the durable `_queue/` first. Resolves true when a queued job was
    // promoted to processing.
    drainQueue: () => Promise<boolean>
    // Optional: materialize + start exactly ONE unprocessed AI clip from the new
    // source library (`_ai_clips/<namespace>/`) when the durable queue is empty.
    // This is the ONLY automatic backlog source for the Dashboard processing flow,
    // and is tried BEFORE the legacy sources below. Resolves true when a job was
    // started, false when there is no unprocessed AI clip to start.
    startAiClipSource?: () => Promise<boolean>
    // Scans ready inbox / gallery_index / recent originals and starts exactly
    // one ready candidate. Resolves true when a job was started (or is already
    // running for the picked candidate). LEGACY: gated by `disableLegacySources`.
    startReadyInbox: () => Promise<boolean>
    // Optional: import + start from the admin original library when nothing else
    // is ready. Should resolve false (no-op) for non-admin namespaces. LEGACY:
    // gated by `disableLegacySources`.
    startAdminOriginal?: () => Promise<boolean>
}

// Tuning for one dispatch call. Kept separate from the side-effecting steps so a
// caller can opt the new Dashboard/AI-clip flow out of the legacy auto-pick without
// changing the step wiring.
export interface ProcessingDispatchOptions {
    // When true, the legacy `startReadyInbox` / `startAdminOriginal` fallbacks are
    // NEVER invoked — only the durable queue and the new AI clip source can start a
    // job. This is how the Dashboard namespace flow stops auto-picking old
    // Chinese/legacy gallery_index inbox items and admin-original clips. The legacy
    // steps may still be supplied (kept available for explicit/legacy callers); they
    // are simply skipped while this flag is set.
    disableLegacySources?: boolean
}

// Which automatic-dispatch contract a namespace gets. The two production shapes:
//
//  - AI-only (the Dashboard /Media flow): the namespace owns AI clip source records, so the
//    AI clip source library is the ONLY automatic backlog. Legacy ready-inbox / admin-original
//    auto-pick is disabled and non-AI durable-queue handoffs are deleted rather than promoted,
//    keeping the strict one-clip-at-a-time behavior and never auto-picking old Chinese backlog.
//  - Legacy (app.oomnn etc.): the namespace has NO AI clip source records, so it keeps the
//    original durable-queue + ready-inbox autostart. Failed/reprocessed legacy jobs requeued
//    into the durable queue MUST be drained (never deleted), and the ready inbox / admin
//    original library remain valid automatic backlogs.
export interface ProcessingDispatchModePlan {
    aiOnly: boolean
    // Maps directly to ProcessingDispatchOptions.disableLegacySources.
    disableLegacySources: boolean
    // True only in AI-only mode: the durable-queue drain may DELETE a non-AI handoff. In legacy
    // mode this is false — every durable-queue handoff is preserved and promoted in order.
    deleteNonAiQueueHandoffs: boolean
    // True only in AI-only mode: the AI clip source library is an automatic backlog.
    allowAiClipSource: boolean
}

// Pure decision: given whether the namespace is backed by the AI clip source library, resolve
// the dispatch contract. Kept import-free + unit-tested so the legacy-vs-AI split can never
// silently regress (e.g. accidentally deleting a legacy namespace's requeued failed job).
export function resolveProcessingDispatchMode(aiOnly: boolean): ProcessingDispatchModePlan {
    return {
        aiOnly,
        disableLegacySources: aiOnly,
        deleteNonAiQueueHandoffs: aiOnly,
        allowAiClipSource: aiOnly,
    }
}

// Drives the steps in priority order and returns structured evidence of what
// happened. Stops at the first step that starts (or finds) work, so it never
// starts more than one job per call.
export async function dispatchNextProcessingJob(
    namespaceId: string,
    steps: ProcessingDispatchSteps,
    options: ProcessingDispatchOptions = {},
): Promise<ProcessingDispatchResult> {
    const botId = String(namespaceId || '').trim()
    if (!botId) {
        return { namespaceId: '', started: false, source: 'idle', detail: 'missing_namespace' }
    }

    if (await steps.hasActiveJob()) {
        return { namespaceId: botId, started: false, source: 'active' }
    }

    if (steps.retryFailedJob && (await steps.retryFailedJob())) {
        return { namespaceId: botId, started: true, source: 'retry' }
    }

    if (await steps.drainQueue()) {
        return { namespaceId: botId, started: true, source: 'queue' }
    }

    // New source library: pick exactly one unprocessed AI clip before any legacy
    // source. Runs regardless of `disableLegacySources` — it IS the intended source.
    if (steps.startAiClipSource && (await steps.startAiClipSource())) {
        return { namespaceId: botId, started: true, source: 'ai_clip_source' }
    }

    // Legacy fallbacks. Skipped entirely for the Dashboard/AI-clip flow so old
    // Chinese/legacy gallery_index inbox + admin-original clips are never auto-picked.
    if (!options.disableLegacySources) {
        if (await steps.startReadyInbox()) {
            return { namespaceId: botId, started: true, source: 'ready_inbox' }
        }

        if (steps.startAdminOriginal && (await steps.startAdminOriginal())) {
            return { namespaceId: botId, started: true, source: 'admin_original' }
        }
    }

    return { namespaceId: botId, started: false, source: 'idle' }
}

// The side-effecting steps a single scheduled (cron) tick runs to keep the
// Processing flow self-perpetuating. Modelled as plain callbacks so the
// ordering + isolation contract is unit-testable without the worker entrypoint.
export interface ScheduledProcessingTickSteps {
    // Awaited first so the posting loop runs to completion before the heavier
    // inbox/comment work yields (preserves cron isolation). MAY reject — and a
    // rejection MUST NOT prevent the continuation steps below from running.
    runPosting: () => Promise<void>
    // Always invoked after posting settles. Registers the inbox-processing
    // guardian — the deterministic every-minute backstop that drains the ready
    // backlog and recovers a missed completion callback (one active job per
    // namespace is still enforced inside the dispatcher).
    runGuardian: () => void
    // Optional. Always invoked after posting settles when provided (e.g. the
    // pending-comment backlog). Kept separate so callers that don't want it
    // (the admin manual trigger) can simply omit it.
    runComments?: () => void
    // Optional. Invoked with the posting error when runPosting rejects, so the
    // caller can log it / surface a non-200 without aborting the guardian.
    onPostingError?: (error: unknown) => void
}

// Runs one scheduled tick's continuation steps with the invariant that a thrown
// posting error can NEVER skip the inbox-processing guardian (or comment
// backlog). Historically the cron entrypoint `await`ed posting *before*
// registering the guardian's waitUntil, so a fatal posting error (handleScheduled
// rethrows) silently disabled the only automatic path that keeps processing the
// backlog one-at-a-time and recovers stuck jobs — i.e. the system "silently
// stopped" while a backlog still existed. Posting still runs first; only its
// failure mode changes (logged via onPostingError instead of propagating).
export async function runScheduledProcessingTick(
    steps: ScheduledProcessingTickSteps,
): Promise<void> {
    try {
        await steps.runPosting()
    } catch (error) {
        if (steps.onPostingError) steps.onPostingError(error)
    }
    steps.runGuardian()
    if (steps.runComments) steps.runComments()
}
