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
    | 'ready_inbox' // started the next ready inbox / gallery_index candidate
    | 'admin_original' // imported + started the next admin original-library item
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
    // Scans ready inbox / gallery_index / recent originals and starts exactly
    // one ready candidate. Resolves true when a job was started (or is already
    // running for the picked candidate).
    startReadyInbox: () => Promise<boolean>
    // Optional: import + start from the admin original library when nothing else
    // is ready. Should resolve false (no-op) for non-admin namespaces.
    startAdminOriginal?: () => Promise<boolean>
}

// Drives the steps in priority order and returns structured evidence of what
// happened. Stops at the first step that starts (or finds) work, so it never
// starts more than one job per call.
export async function dispatchNextProcessingJob(
    namespaceId: string,
    steps: ProcessingDispatchSteps,
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

    if (await steps.startReadyInbox()) {
        return { namespaceId: botId, started: true, source: 'ready_inbox' }
    }

    if (steps.startAdminOriginal && (await steps.startAdminOriginal())) {
        return { namespaceId: botId, started: true, source: 'admin_original' }
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
