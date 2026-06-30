import assert from 'node:assert/strict'
import test from 'node:test'
import {
    dispatchNextProcessingJob,
    resolveProcessingDispatchMode,
    runScheduledProcessingTick,
    type ProcessingDispatchSteps,
    type ScheduledProcessingTickSteps,
} from '../src/processing-dispatch.js'

// Builds a steps object whose individual steps default to "nothing to do" and
// records how many times each one ran, so tests can assert both the result and
// that later steps are short-circuited once an earlier one starts work.
function makeSteps(overrides: Partial<Record<keyof ProcessingDispatchSteps, boolean>> = {}) {
    const calls = { hasActiveJob: 0, retryFailedJob: 0, drainQueue: 0, startAiClipSource: 0, startReadyInbox: 0, startAdminOriginal: 0 }
    const steps: ProcessingDispatchSteps = {
        hasActiveJob: async () => { calls.hasActiveJob++; return overrides.hasActiveJob ?? false },
        retryFailedJob: async () => { calls.retryFailedJob++; return overrides.retryFailedJob ?? false },
        drainQueue: async () => { calls.drainQueue++; return overrides.drainQueue ?? false },
        startAiClipSource: async () => { calls.startAiClipSource++; return overrides.startAiClipSource ?? false },
        startReadyInbox: async () => { calls.startReadyInbox++; return overrides.startReadyInbox ?? false },
        startAdminOriginal: async () => { calls.startAdminOriginal++; return overrides.startAdminOriginal ?? false },
    }
    return { steps, calls }
}

test('an active job short-circuits everything (one active job per namespace)', async () => {
    const { steps, calls } = makeSteps({ hasActiveJob: true, drainQueue: true, startReadyInbox: true })
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: false, source: 'active' })
    assert.equal(calls.hasActiveJob, 1)
    assert.equal(calls.retryFailedJob, 0)
    assert.equal(calls.drainQueue, 0)
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('retryable failed jobs are requeued before fresh durable queue work', async () => {
    const { steps, calls } = makeSteps({ retryFailedJob: true, drainQueue: true, startReadyInbox: true })
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'retry' })
    assert.equal(calls.retryFailedJob, 1)
    assert.equal(calls.drainQueue, 0)
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('the durable queue is drained before the ready inbox', async () => {
    const { steps, calls } = makeSteps({ drainQueue: true, startReadyInbox: true, startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'queue' })
    assert.equal(calls.drainQueue, 1)
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('falls back to the ready inbox when the queue is empty', async () => {
    const { steps, calls } = makeSteps({ startReadyInbox: true, startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'ready_inbox' })
    assert.equal(calls.drainQueue, 1)
    assert.equal(calls.startReadyInbox, 1)
    assert.equal(calls.startAdminOriginal, 0)
})

test('falls back to the admin original library when queue and ready inbox are empty', async () => {
    const { steps, calls } = makeSteps({ startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'admin_original' })
    assert.equal(calls.drainQueue, 1)
    assert.equal(calls.startReadyInbox, 1)
    assert.equal(calls.startAdminOriginal, 1)
})

// --- New Dashboard / AI-clip source flow: the AI clip source is the only automatic
// backlog; legacy ready-inbox + admin-original auto-pick is disabled. ---

test('the AI clip source is tried before legacy ready inbox / admin original', async () => {
    const { steps, calls } = makeSteps({ startAiClipSource: true, startReadyInbox: true, startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'ai_clip_source' })
    assert.equal(calls.drainQueue, 1)
    assert.equal(calls.startAiClipSource, 1)
    // Legacy sources never run once the AI source starts a job (at most one job per call).
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('disableLegacySources never auto-picks the legacy ready inbox / admin original', async () => {
    // Legacy steps WOULD start work, but the new-flow flag must skip them entirely.
    const { steps, calls } = makeSteps({ startReadyInbox: true, startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps, { disableLegacySources: true })
    assert.deepEqual(result, { namespaceId: 'ns-1', started: false, source: 'idle' })
    assert.equal(calls.drainQueue, 1)
    assert.equal(calls.startAiClipSource, 1)
    // The legacy Chinese/admin-original sources are NEVER consulted in the new flow.
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('disableLegacySources still starts the AI clip source when one is available', async () => {
    const { steps, calls } = makeSteps({ startAiClipSource: true, startReadyInbox: true, startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps, { disableLegacySources: true })
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'ai_clip_source' })
    assert.equal(calls.startAiClipSource, 1)
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('disableLegacySources with an empty AI source idles (legacy never picked even as fallback)', async () => {
    const { steps, calls } = makeSteps({ startAiClipSource: false, startReadyInbox: true, startAdminOriginal: true })
    const result = await dispatchNextProcessingJob('ns-1', steps, { disableLegacySources: true })
    assert.equal(result.started, false)
    assert.equal(result.source, 'idle')
    assert.equal(calls.startAiClipSource, 1)
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('a still-draining durable queue wins over the AI clip source (one job per call)', async () => {
    const { steps, calls } = makeSteps({ drainQueue: true, startAiClipSource: true })
    const result = await dispatchNextProcessingJob('ns-1', steps, { disableLegacySources: true })
    assert.deepEqual(result, { namespaceId: 'ns-1', started: true, source: 'queue' })
    // The AI source is NOT consulted while a durable queue job is still being drained.
    assert.equal(calls.startAiClipSource, 0)
})

test('an active job short-circuits the AI clip source too', async () => {
    const { steps, calls } = makeSteps({ hasActiveJob: true, startAiClipSource: true })
    const result = await dispatchNextProcessingJob('ns-1', steps, { disableLegacySources: true })
    assert.deepEqual(result, { namespaceId: 'ns-1', started: false, source: 'active' })
    assert.equal(calls.startAiClipSource, 0)
})

test('reports idle when nothing is ready to start', async () => {
    const { steps, calls } = makeSteps()
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: false, source: 'idle' })
    assert.equal(calls.hasActiveJob, 1)
    assert.equal(calls.drainQueue, 1)
    assert.equal(calls.startReadyInbox, 1)
    assert.equal(calls.startAdminOriginal, 1)
})

test('a non-admin namespace (no startAdminOriginal step) reports idle without throwing', async () => {
    const calls = { hasActiveJob: 0, drainQueue: 0, startReadyInbox: 0 }
    const steps: ProcessingDispatchSteps = {
        hasActiveJob: async () => { calls.hasActiveJob++; return false },
        drainQueue: async () => { calls.drainQueue++; return false },
        startReadyInbox: async () => { calls.startReadyInbox++; return false },
    }
    const result = await dispatchNextProcessingJob('ns-1', steps)
    assert.deepEqual(result, { namespaceId: 'ns-1', started: false, source: 'idle' })
    assert.equal(calls.startReadyInbox, 1)
})

test('a blank namespace id is idle and never touches any step', async () => {
    const { steps, calls } = makeSteps({ drainQueue: true, startReadyInbox: true })
    const result = await dispatchNextProcessingJob('   ', steps)
    assert.deepEqual(result, { namespaceId: '', started: false, source: 'idle', detail: 'missing_namespace' })
    assert.equal(calls.hasActiveJob, 0)
    assert.equal(calls.drainQueue, 0)
    assert.equal(calls.startReadyInbox, 0)
    assert.equal(calls.startAdminOriginal, 0)
})

test('namespace id is trimmed in the result', async () => {
    const { steps } = makeSteps({ drainQueue: true })
    const result = await dispatchNextProcessingJob('  ns-2  ', steps)
    assert.equal(result.namespaceId, 'ns-2')
    assert.equal(result.started, true)
    assert.equal(result.source, 'queue')
})

// --- resolveProcessingDispatchMode: the legacy-vs-AI split that fixes the app.oomnn
// Processing retry/autostart regression. A namespace with NO AI clip source records stays
// in LEGACY mode (durable queue + ready inbox, no handoff deletion); a namespace backed by
// the AI clip source library stays in AI-only mode (one clip at a time, legacy auto-pick
// disabled, non-AI handoffs deleted). ---

test('a legacy (non-AI) namespace keeps the legacy queue + ready-inbox flow', () => {
    const mode = resolveProcessingDispatchMode(false)
    assert.equal(mode.aiOnly, false)
    // Legacy ready-inbox / admin-original auto-pick stays ENABLED so app.oomnn autostarts.
    assert.equal(mode.disableLegacySources, false)
    // A requeued failed/legacy durable-queue handoff must NEVER be deleted — it must drain.
    assert.equal(mode.deleteNonAiQueueHandoffs, false)
    // No AI clip source library backs a legacy namespace.
    assert.equal(mode.allowAiClipSource, false)
})

test('an AI-clip namespace stays one-at-a-time with legacy auto-pick disabled', () => {
    const mode = resolveProcessingDispatchMode(true)
    assert.equal(mode.aiOnly, true)
    // The Dashboard/Media flow never auto-picks the old Chinese/legacy backlog.
    assert.equal(mode.disableLegacySources, true)
    // Non-AI durable-queue handoffs are deleted rather than promoted.
    assert.equal(mode.deleteNonAiQueueHandoffs, true)
    // The AI clip source library is the only automatic backlog.
    assert.equal(mode.allowAiClipSource, true)
})

test('legacy-mode dispatch drains a requeued durable-queue job (reprocess autostart)', async () => {
    // The exact reprocess path: a failed legacy job is moved into the durable `_queue/`, then
    // dispatch runs with the legacy plan. drainQueue (processNextInQueue) promotes it — the AI
    // clip source step is absent (legacy namespaces never have one), legacy sources stay live.
    const mode = resolveProcessingDispatchMode(false)
    const calls = { hasActiveJob: 0, drainQueue: 0, startReadyInbox: 0, startAdminOriginal: 0 }
    const steps: ProcessingDispatchSteps = {
        hasActiveJob: async () => { calls.hasActiveJob++; return false },
        drainQueue: async () => { calls.drainQueue++; return true }, // the requeued job drains
        startReadyInbox: async () => { calls.startReadyInbox++; return false },
        startAdminOriginal: async () => { calls.startAdminOriginal++; return false },
    }
    const result = await dispatchNextProcessingJob('1774985587565583183', steps, { disableLegacySources: mode.disableLegacySources })
    assert.deepEqual(result, { namespaceId: '1774985587565583183', started: true, source: 'queue' })
    assert.equal(calls.drainQueue, 1)
    // Legacy fallbacks never need to run because the queued job already started.
    assert.equal(calls.startReadyInbox, 0)
})

test('legacy-mode dispatch falls back to the ready inbox when the queue is empty', async () => {
    // app.oomnn autostart: with an empty durable queue, the legacy ready-inbox picks the next
    // item. This is the path that disableLegacySources would have wrongly suppressed.
    const mode = resolveProcessingDispatchMode(false)
    const { steps, calls } = makeSteps({ startReadyInbox: true })
    const result = await dispatchNextProcessingJob('1774985587565583183', steps, { disableLegacySources: mode.disableLegacySources })
    assert.equal(result.started, true)
    assert.equal(result.source, 'ready_inbox')
    assert.equal(calls.startReadyInbox, 1)
})

// --- runScheduledProcessingTick: a posting failure must never skip the
// inbox-processing guardian (the every-minute backstop). This is the exact
// regression that let Processing "silently stop" while a backlog existed. ---

function makeTickSteps(overrides: Partial<{ postingThrows: unknown; withComments: boolean }> = {}) {
    const order: string[] = []
    const calls = { runPosting: 0, runGuardian: 0, runComments: 0, onPostingError: 0 }
    let postingError: unknown = null
    const steps: ScheduledProcessingTickSteps = {
        runPosting: async () => {
            calls.runPosting++
            order.push('posting')
            if ('postingThrows' in overrides) throw overrides.postingThrows
        },
        runGuardian: () => { calls.runGuardian++; order.push('guardian') },
        onPostingError: (error) => { calls.onPostingError++; postingError = error },
    }
    if (overrides.withComments) {
        steps.runComments = () => { calls.runComments++; order.push('comments') }
    }
    return { steps, calls, order, getPostingError: () => postingError }
}

test('the guardian still runs after the posting loop succeeds', async () => {
    const { steps, calls, order } = makeTickSteps({ withComments: true })
    await runScheduledProcessingTick(steps)
    assert.equal(calls.runPosting, 1)
    assert.equal(calls.runGuardian, 1)
    assert.equal(calls.runComments, 1)
    assert.equal(calls.onPostingError, 0)
    // Posting always runs first to preserve cron isolation.
    assert.deepEqual(order, ['posting', 'guardian', 'comments'])
})

test('a thrown posting loop does NOT skip the guardian or comment backlog', async () => {
    const boom = new Error('posting blew up')
    const { steps, calls, order, getPostingError } = makeTickSteps({ postingThrows: boom, withComments: true })
    await runScheduledProcessingTick(steps)
    assert.equal(calls.runGuardian, 1, 'guardian must run even when posting throws')
    assert.equal(calls.runComments, 1, 'comments must run even when posting throws')
    assert.equal(calls.onPostingError, 1)
    assert.equal(getPostingError(), boom)
    assert.deepEqual(order, ['posting', 'guardian', 'comments'])
})

test('runScheduledProcessingTick never rejects when posting rejects', async () => {
    const { steps } = makeTickSteps({ postingThrows: new Error('fatal') })
    // Must resolve, not reject — otherwise the cron entrypoint would surface an
    // unhandled rejection and the guardian registration would be moot.
    await assert.doesNotReject(() => runScheduledProcessingTick(steps))
})

test('comments are optional: guardian still runs when no comment step is provided', async () => {
    const { steps, calls } = makeTickSteps({ postingThrows: new Error('fatal') })
    assert.equal(steps.runComments, undefined)
    await runScheduledProcessingTick(steps)
    assert.equal(calls.runGuardian, 1)
    assert.equal(calls.runComments, 0)
})

test('a posting error without an onPostingError handler is swallowed, guardian runs', async () => {
    const order: string[] = []
    const steps: ScheduledProcessingTickSteps = {
        runPosting: async () => { order.push('posting'); throw new Error('no handler') },
        runGuardian: () => { order.push('guardian') },
    }
    await assert.doesNotReject(() => runScheduledProcessingTick(steps))
    assert.deepEqual(order, ['posting', 'guardian'])
})
