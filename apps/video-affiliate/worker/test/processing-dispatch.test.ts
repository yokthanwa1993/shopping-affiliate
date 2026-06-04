import assert from 'node:assert/strict'
import test from 'node:test'
import {
    dispatchNextProcessingJob,
    runScheduledProcessingTick,
    type ProcessingDispatchSteps,
    type ScheduledProcessingTickSteps,
} from '../src/processing-dispatch.js'

// Builds a steps object whose individual steps default to "nothing to do" and
// records how many times each one ran, so tests can assert both the result and
// that later steps are short-circuited once an earlier one starts work.
function makeSteps(overrides: Partial<Record<keyof ProcessingDispatchSteps, boolean>> = {}) {
    const calls = { hasActiveJob: 0, retryFailedJob: 0, drainQueue: 0, startReadyInbox: 0, startAdminOriginal: 0 }
    const steps: ProcessingDispatchSteps = {
        hasActiveJob: async () => { calls.hasActiveJob++; return overrides.hasActiveJob ?? false },
        retryFailedJob: async () => { calls.retryFailedJob++; return overrides.retryFailedJob ?? false },
        drainQueue: async () => { calls.drainQueue++; return overrides.drainQueue ?? false },
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
