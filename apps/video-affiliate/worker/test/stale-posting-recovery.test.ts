import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const requireFromWorker = createRequire(`${process.cwd()}/package.json`)
const ts = requireFromWorker('typescript')

function getSource(): string {
    return readFileSync('src/index.ts', 'utf8')
}

function sliceBetween(source: string, startMarker: string, endMarker: string, label: string): string {
    const start = source.indexOf(startMarker)
    assert.notEqual(start, -1, `${label} start marker must exist`)
    const end = source.indexOf(endMarker, start + startMarker.length)
    assert.notEqual(end, -1, `${label} end marker must exist`)
    return source.slice(start, end)
}

function getRecoverHelperSource(): string {
    return sliceBetween(
        getSource(),
        'async function recoverStalePostingAttemptsForPage',
        '\nasync function ensureLinkSubmissionsTable',
        'recoverStalePostingAttemptsForPage'
    )
}

function getForcePostRouteSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/api/pages/:id/force-post'",
        '\n// ==================== MANUAL REEL POST',
        'force-post route'
    )
}

function getRetryPostRouteSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/api/post-history/:id/retry-post'",
        "\napp.get('/api/pages/:id/history'",
        'retry-post route'
    )
}

function getScheduledSource(): string {
    return sliceBetween(
        getSource(),
        'async function handleScheduled',
        '\n// Container class',
        'handleScheduled'
    )
}

function getScheduledRecoverySource(): string {
    return sliceBetween(
        getSource(),
        'async function recoverStaleScheduledRun',
        '\nasync function handleScheduled',
        'recoverStaleScheduledRun'
    )
}

function getRuntimeUpdateSource(): string {
    return sliceBetween(
        getSource(),
        'async function updateCronRuntimeState',
        '\nasync function releaseScheduledRunLock',
        'updateCronRuntimeState'
    )
}

type RuntimeStateInput = {
    status: string
    startedAt: string
    finishedAt: string | null
    heartbeatAt: string
    currentPageId: string | null
    currentPageName: string | null
    currentNamespaceId: string | null
    pagesTotal: number
    pagesVisited: number
    pagesPosted: number
    pagesFailed: number
    lastError: string | null
}

type ScheduledRuntimeHelpers = {
    tryAcquirePostingLock: (db: unknown, params: Record<string, unknown>) => Promise<string | null>
    initializeCronRuntimeState: (db: unknown, runId: string, state: RuntimeStateInput) => Promise<boolean>
    updateCronRuntimeState: (db: unknown, runId: string, patch: Partial<RuntimeStateInput>) => Promise<boolean>
    releaseScheduledRunLock: (db: unknown, lockKey: string | null, runId: string) => Promise<boolean>
    recoverStaleScheduledRun: (db: unknown, maxStaleMs?: number) => Promise<boolean>
}

class SqliteD1 {
    afterFirst: (() => void | Promise<void>) | null = null

    constructor(readonly database: DatabaseSync) { }

    prepare(sql: string) {
        const owner = this
        let values: unknown[] = []
        return {
            bind(...nextValues: unknown[]) {
                values = nextValues
                return this
            },
            async run() {
                const result = owner.database.prepare(sql).run(...values as any[])
                return { meta: { changes: Number(result.changes) } }
            },
            async first() {
                const row = owner.database.prepare(sql).get(...values as any[]) as Record<string, unknown> | undefined
                const hook = owner.afterFirst
                owner.afterFirst = null
                if (hook) await hook()
                return row || null
            },
        }
    }
}

function makeScheduledRuntimeHarness() {
    const source = getSource()
    const postingLockHelpers = sliceBetween(
        source,
        "type PostingLockScope = 'page' | 'video'",
        '\ntype NamespaceVideoStateRow',
        'posting lock helpers',
    )
    const runtimeHelpers = sliceBetween(
        source,
        'const CRON_PAGE_HEARTBEAT_INTERVAL_MS',
        '\nasync function handleScheduled',
        'scheduled runtime helpers',
    )
    const compiled = ts.transpileModule(`${postingLockHelpers}\n${runtimeHelpers}`, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    }).outputText
    const factory = new Function(
        `${compiled}
return {
    tryAcquirePostingLock,
    initializeCronRuntimeState,
    updateCronRuntimeState,
    releaseScheduledRunLock,
    recoverStaleScheduledRun,
}`,
    )
    const database = new DatabaseSync(':memory:')
    return {
        database,
        db: new SqliteD1(database),
        helpers: factory() as ScheduledRuntimeHelpers,
    }
}

function makeRuntimeState(heartbeatAt: string, overrides: Partial<RuntimeStateInput> = {}): RuntimeStateInput {
    return {
        status: 'starting',
        startedAt: heartbeatAt,
        finishedAt: null,
        heartbeatAt,
        currentPageId: null,
        currentPageName: null,
        currentNamespaceId: null,
        pagesTotal: 0,
        pagesVisited: 0,
        pagesPosted: 0,
        pagesFailed: 0,
        lastError: null,
        ...overrides,
    }
}

async function acquireAndInitialize(
    harness: ReturnType<typeof makeScheduledRuntimeHarness>,
    runId: string,
    state: RuntimeStateInput,
): Promise<string> {
    const lockKey = await harness.helpers.tryAcquirePostingLock(harness.db, {
        scope: 'page',
        namespaceId: '__scheduled__',
        pageId: 'run',
        videoId: runId,
        ttlMinutes: 10,
    })
    assert.equal(lockKey, 'page::__scheduled__::run')
    assert.equal(
        await harness.helpers.initializeCronRuntimeState(harness.db, runId, state),
        true,
        'lock owner must be able to initialize/take over the singleton runtime row',
    )
    return lockKey
}

function getPagesColumnMaintenanceSource(): string {
    return sliceBetween(
        getSource(),
        'async function ensurePagesOneCardColumns',
        '\nasync function publishVideoViaOneCard',
        'ensurePagesOneCardColumns'
    )
}

test('recoverStalePostingAttemptsForPage helper exists with safe invariants', () => {
    const body = getRecoverHelperSource()

    // Only fails rows that are actually stuck posting.
    assert.match(body, /status = 'posting'/, 'must only target posting rows')
    // Never clobbers a row that already published.
    assert.match(body, /TRIM\(COALESCE\(fb_post_id, ''\)\) = ''/, 'must require empty fb_post_id')
    // Bounded by a posted_at threshold.
    assert.match(body, /datetime\(posted_at\) < datetime\('now', \?\)/, 'must bound by posted_at age')
    // Scoped to a single namespace + page.
    assert.match(body, /bot_id = \?/, 'must scope to namespace')
    assert.match(body, /page_id = \?/, 'must scope to page')
    // Marks the row failed with a clear non-secret reason.
    assert.match(body, /status = 'failed'/, 'must mark the row failed')
    assert.match(body, /stale_posting_timeout_no_fb_post_id/, 'must use the documented default reason')
    assert.match(body, /comment_status = 'not_attempted'/, 'must reset comment status')
    // Lock cleanup is scoped to the page scope and stale locks only.
    assert.match(body, /DELETE FROM posting_locks/, 'must clean stale page lock')
    assert.match(body, /scope = 'page'/, 'lock cleanup must be page-scoped')
    assert.match(body, /datetime\(created_at\) < datetime\('now', \?\)/, 'lock cleanup must be age-bounded')
})

test('default recovery threshold gives Facebook Lite /video_reels enough processing headroom', () => {
    const source = getSource()
    assert.match(
        source,
        /const STALE_POSTING_RECOVERY_THRESHOLD_MINUTES = 15\b/,
        'STALE_POSTING_RECOVERY_THRESHOLD_MINUTES must be 15'
    )
})

test('Facebook Lite /video_reels upload is timeout-bounded, not a raw fetch that can leave posting rows stuck', () => {
    const source = getSource()
    const body = sliceBetween(
        source,
        'async function publishReelDirectWithTokenFallback',
        '\nasync function publishReelWithCommentTokenPrimaryFallback',
        'publishReelDirectWithTokenFallback'
    )

    assert.match(body, /fetchWithTimeout\(uploadUrl,/, 'video_reels upload must use fetchWithTimeout')
    assert.match(body, /facebook_reel_upload/, 'timeout label must identify the Facebook reel upload step')
    assert.doesNotMatch(body, /await fetch\(uploadUrl,/, 'video_reels upload must not use raw fetch')
})

test('force-post recovers stale posting rows before acquiring the page lock', () => {
    const body = getForcePostRouteSource()
    const recoverIdx = body.indexOf('recoverStalePostingAttemptsForPage')
    const lockIdx = body.indexOf('tryAcquirePostingLock')
    assert.notEqual(recoverIdx, -1, 'force-post must call recoverStalePostingAttemptsForPage')
    assert.notEqual(lockIdx, -1, 'force-post must still acquire the page lock')
    assert.ok(recoverIdx < lockIdx, 'recovery must run before acquiring the page lock')
})

test('retry-post recovers stale posting rows before its active-posting query', () => {
    const body = getRetryPostRouteSource()
    const recoverIdx = body.indexOf('recoverStalePostingAttemptsForPage')
    const activeIdx = body.indexOf('const activePosting')
    assert.notEqual(recoverIdx, -1, 'retry-post must call recoverStalePostingAttemptsForPage')
    assert.notEqual(activeIdx, -1, 'retry-post must still guard on active posting')
    assert.ok(recoverIdx < activeIdx, 'recovery must run before the active-posting guard')
})

test('scheduled cron recovers stale posting rows before the min-gap guard', () => {
    const source = getSource()
    const cronRecoverIdx = source.indexOf("reason: 'stale_posting_timeout_no_fb_post_id_cron'")
    assert.notEqual(cronRecoverIdx, -1, 'cron must call recoverStalePostingAttemptsForPage')
    const minGapIdx = source.indexOf('Universal min-gap guard', cronRecoverIdx)
    assert.notEqual(minGapIdx, -1, 'cron min-gap guard must follow the recovery call')
    assert.ok(cronRecoverIdx < minGapIdx, 'recovery must run before the min-gap guard')
})

test('scheduled runtime records awaited startup, first-page, completion, and failure phases', () => {
    const body = getScheduledSource()
    const initializationIdx = body.indexOf('initializeCronRuntimeState(env.DB, runId, {')
    const startingIdx = body.indexOf("status: 'starting'", initializationIdx)
    const maintenanceIdx = body.indexOf('await ensurePagesOneCardColumns')
    const pagesQueryIdx = body.indexOf('SELECT id, name, access_token, post_hours')
    const runningIdx = body.indexOf("status: 'running'", pagesQueryIdx)
    const visitIdx = body.indexOf('cronStats.pagesVisited += 1', runningIdx)
    const pageHeartbeatIdx = body.indexOf('await updateCronRuntimeState(env.DB, runId, {', visitIdx)
    const pageClaimIdx = body.indexOf('claimFastGalleryVideoForPosting({', pageHeartbeatIdx)

    assert.notEqual(initializationIdx, -1, 'cron must initialize runtime through the lock-verified takeover helper')
    assert.notEqual(startingIdx, -1, 'cron must persist a distinct startup phase')
    assert.ok(startingIdx < maintenanceIdx, 'startup state must be durable before schema maintenance')
    assert.ok(maintenanceIdx < pagesQueryIdx, 'bounded startup maintenance must complete before loading pages')
    assert.ok(pagesQueryIdx < runningIdx, 'running state must begin only after the page list is known')
    assert.ok(visitIdx < pageHeartbeatIdx, 'page visit count must be set before its heartbeat')
    assert.ok(pageHeartbeatIdx < pageClaimIdx, 'the awaited first-page heartbeat must precede candidate selection')
    assert.match(
        body.slice(visitIdx, pageClaimIdx),
        /await updateCronRuntimeState\(env\.DB, runId, \{[\s\S]*currentPageId:[\s\S]*pagesVisited:/,
        'the current-page heartbeat must be awaited and carry durable page identity/count'
    )
    assert.match(body, /setInterval\(\(\) => \{/, 'slow page work must keep a periodic runtime heartbeat')
    assert.match(body, /clearInterval\(pageHeartbeatTimer\)/, 'page heartbeat timer must always be stopped')
    assert.match(body, /await pageHeartbeatWrites/, 'queued heartbeat writes must be awaited before leaving the page')
    const pageFailureCatch = sliceBetween(
        body,
        '} catch (pageError) {',
        '\n            } finally {',
        'scheduled page failure catch'
    )
    assert.match(pageFailureCatch, /cronStats\.pagesFailed \+= 1/, 'one bad page must be counted')
    assert.match(pageFailureCatch, /\bcontinue\b/, 'one bad page must continue to later pages instead of aborting the run')
    assert.match(body, /status: fatalError \? 'failed' : 'completed'/, 'terminal runtime state must distinguish success from failure')
    assert.match(
        body,
        /releaseScheduledRunLock\(env\.DB, scheduledRunLockKey, runId\)/,
        'terminal cleanup must release only the lock token owned by this run',
    )
})

test('partial runtime heartbeats preserve current-page and error diagnostics unless explicitly cleared', () => {
    const body = getRuntimeUpdateSource()
    assert.match(body, /Object\.prototype\.hasOwnProperty\.call\(patch, field\)/, 'runtime updates must distinguish omitted fields from explicit null')
    assert.match(
        body,
        /current_page_id = CASE WHEN \? = 1 THEN \? ELSE current_page_id END/,
        'counter-only heartbeats must not clear current_page_id'
    )
    assert.match(
        body,
        /last_error = CASE WHEN \? = 1 THEN \? ELSE last_error END/,
        'counter-only heartbeats must not erase the latest page error'
    )
    assert.match(body, /AND run_id = \?/, 'every heartbeat/progress/terminal update must compare the owning run_id')
    assert.match(
        body,
        /AND status IN \('starting', 'running'\)/,
        'stale recovery must revoke later heartbeat/completion writes from the recovered run',
    )
    assert.doesNotMatch(body, /INSERT INTO cron_runtime_state/, 'subsequent updates must never retake ownership through an upsert')
})

test('a busy tick cannot overwrite or unlock a healthy active scheduled run', () => {
    const body = getScheduledSource()
    const busyStart = body.indexOf('if (!scheduledRunLockKey) {')
    const busyEnd = body.indexOf('\n    const cronStats = {', busyStart)
    assert.notEqual(busyStart, -1)
    assert.notEqual(busyEnd, -1)
    const busyBlock = body.slice(busyStart, busyEnd)

    assert.doesNotMatch(busyBlock, /status: 'busy'/, 'busy tick must leave the active run’s singleton runtime row untouched')
    assert.doesNotMatch(
        body,
        /datetime\(created_at\) < datetime\('now', '-2 minutes'\)/,
        'cron must not delete a healthy global lock solely because it is two minutes old'
    )
    assert.match(
        body,
        /run_id = posting_locks\.video_id/,
        'orphan cleanup must match the runtime owner token instead of deleting by status alone'
    )
    assert.match(body, /status NOT IN \('starting', 'running'\)/, 'only a matching terminal owner may be orphan-cleaned')
    assert.equal(
        body.match(/videoId: runId/g)?.length,
        2,
        'both initial and post-recovery acquisitions must stamp runId into the existing lock row',
    )
    const initializeIdx = body.indexOf('initializeCronRuntimeState(env.DB, runId, {')
    assert.ok(busyEnd < initializeIdx, 'runtime takeover must happen only after the final successful lock gate')
})

test('stale scheduled recovery uses heartbeat age for both startup and page processing', () => {
    const body = getScheduledRecoverySource()
    assert.match(body, /status !== 'starting' && status !== 'running'/, 'stale recovery must recognize both active phases')
    assert.doesNotMatch(body, /startupHung|20_000/, 'startup must not be killed by a special 20-second pages_visited shortcut')
    assert.match(body, /ageMs <= Math\.max\(30_000, maxStaleMs\)/, 'stale recovery must use the configured heartbeat threshold')
    assert.match(body, /AND run_id = \?[\s\S]*AND status = \?[\s\S]*AND heartbeat_at = \?/, 'stale marking must CAS the exact observed run')
    assert.match(body, /if \(Number\(recovered\.meta\?\.changes \|\| 0\) !== 1\) return false/, 'lock cleanup requires a successful stale-run CAS')
    assert.match(body, /AND video_id = \?[\s\S]*AND created_at = \?/, 'stale lock cleanup must compare the exact observed owner row')
})

test('behavior: stale run heartbeat cannot overwrite the newer runtime owner', async (t) => {
    const harness = makeScheduledRuntimeHarness()
    t.after(() => harness.database.close())
    const newerRunId = 'run-newer-heartbeat'
    const newerHeartbeat = new Date().toISOString()
    await acquireAndInitialize(
        harness,
        newerRunId,
        makeRuntimeState(newerHeartbeat, { status: 'running', pagesTotal: 3, pagesVisited: 1 }),
    )

    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, 'run-older-heartbeat', {
            status: 'completed',
            finishedAt: '2099-01-01T00:00:00.000Z',
            heartbeatAt: '2099-01-01T00:00:00.000Z',
            pagesVisited: 99,
            pagesPosted: 99,
        }),
        false,
        'an old owner must get zero matched rows',
    )
    let runtime = harness.database.prepare(
        `SELECT run_id, status, finished_at, heartbeat_at, pages_visited, pages_posted
         FROM cron_runtime_state WHERE id = 'scheduled'`,
    ).get() as Record<string, unknown>
    assert.equal(runtime.run_id, newerRunId)
    assert.equal(runtime.status, 'running')
    assert.equal(runtime.finished_at, null)
    assert.equal(runtime.heartbeat_at, newerHeartbeat)
    assert.equal(runtime.pages_visited, 1)
    assert.equal(runtime.pages_posted, 0)

    const ownerHeartbeat = new Date(Date.now() + 1_000).toISOString()
    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, newerRunId, {
            heartbeatAt: ownerHeartbeat,
            pagesVisited: 2,
            pagesPosted: 1,
        }),
        true,
    )
    runtime = harness.database.prepare(
        `SELECT run_id, heartbeat_at, pages_visited, pages_posted
         FROM cron_runtime_state WHERE id = 'scheduled'`,
    ).get() as Record<string, unknown>
    assert.equal(runtime.run_id, newerRunId)
    assert.equal(runtime.heartbeat_at, ownerHeartbeat)
    assert.equal(runtime.pages_visited, 2)
    assert.equal(runtime.pages_posted, 1)
})

test('behavior: old completion and release cannot delete a newer run lock', async (t) => {
    const harness = makeScheduledRuntimeHarness()
    t.after(() => harness.database.close())
    const newerRunId = 'run-newer-release'
    const lockKey = await acquireAndInitialize(
        harness,
        newerRunId,
        makeRuntimeState(new Date().toISOString(), { status: 'running' }),
    )

    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, 'run-older-release', {
            status: 'completed',
            finishedAt: new Date().toISOString(),
        }),
        false,
    )
    assert.equal(
        await harness.helpers.releaseScheduledRunLock(harness.db, lockKey, 'run-older-release'),
        false,
        'an old owner token must not match the newer lock row',
    )
    let lock = harness.database.prepare(
        `SELECT lock_key, video_id FROM posting_locks WHERE lock_key = ?`,
    ).get(lockKey) as Record<string, unknown>
    assert.equal(lock.video_id, newerRunId)
    const runtime = harness.database.prepare(
        `SELECT run_id, status FROM cron_runtime_state WHERE id = 'scheduled'`,
    ).get() as Record<string, unknown>
    assert.deepEqual({ ...runtime }, { run_id: newerRunId, status: 'running' })

    assert.equal(
        await harness.helpers.releaseScheduledRunLock(harness.db, lockKey, newerRunId),
        true,
        'the current owner must still be able to release its own row',
    )
    lock = harness.database.prepare(
        `SELECT lock_key, video_id FROM posting_locks WHERE lock_key = ?`,
    ).get(lockKey) as Record<string, unknown>
    assert.equal(lock, undefined)
})

test('behavior: old terminal release cannot delete a newer lock during acquire-to-initialize', async (t) => {
    const harness = makeScheduledRuntimeHarness()
    t.after(() => harness.database.close())
    const oldRunId = 'run-old-release-gap'
    const newerRunId = 'run-new-release-gap'
    const lockKey = await acquireAndInitialize(
        harness,
        oldRunId,
        makeRuntimeState(new Date().toISOString(), { status: 'running' }),
    )

    // Model a TTL takeover precisely: B owns the fixed lock key, but has not
    // initialized cron_runtime_state yet, so the singleton still names A.
    harness.database.prepare('DELETE FROM posting_locks WHERE lock_key = ?').run(lockKey)
    assert.equal(
        await harness.helpers.tryAcquirePostingLock(harness.db, {
            scope: 'page',
            namespaceId: '__scheduled__',
            pageId: 'run',
            videoId: newerRunId,
            ttlMinutes: 10,
        }),
        lockKey,
    )
    assert.equal(
        (harness.database.prepare(
            `SELECT run_id FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>).run_id,
        oldRunId,
    )

    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, oldRunId, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
        }),
        true,
        'A may finish while the runtime row still belongs to A',
    )
    assert.equal(
        await harness.helpers.releaseScheduledRunLock(harness.db, lockKey, oldRunId),
        false,
        'release must compare the lock-row owner, not the still-old runtime row',
    )
    assert.equal(
        (harness.database.prepare(
            `SELECT video_id FROM posting_locks WHERE lock_key = ?`,
        ).get(lockKey) as Record<string, unknown>).video_id,
        newerRunId,
    )

    assert.equal(
        await harness.helpers.initializeCronRuntimeState(
            harness.db,
            newerRunId,
            makeRuntimeState(new Date().toISOString()),
        ),
        true,
        'B must still be able to initialize after A finishes',
    )
    const runtime = harness.database.prepare(
        `SELECT run_id, status FROM cron_runtime_state WHERE id = 'scheduled'`,
    ).get() as Record<string, unknown>
    assert.deepEqual({ ...runtime }, { run_id: newerRunId, status: 'starting' })
})

test('behavior: stale recovery CAS and exact lock delete cannot clobber a newer run', async (t) => {
    await t.test('newer runtime takeover after the stale read makes the CAS fail', async (t) => {
        const harness = makeScheduledRuntimeHarness()
        t.after(() => harness.database.close())
        const staleAt = new Date(Date.now() - 5 * 60_000).toISOString()
        await acquireAndInitialize(harness, 'run-stale-takeover', makeRuntimeState(staleAt, { status: 'running' }))
        harness.db.afterFirst = async () => {
            harness.database.prepare(
                `DELETE FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
            ).run()
            await acquireAndInitialize(
                harness,
                'run-new-after-read',
                makeRuntimeState(new Date().toISOString(), { status: 'running', pagesVisited: 4 }),
            )
        }

        assert.equal(await harness.helpers.recoverStaleScheduledRun(harness.db, 30_000), false)
        const runtime = harness.database.prepare(
            `SELECT run_id, status, pages_visited FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>
        assert.deepEqual({ ...runtime }, { run_id: 'run-new-after-read', status: 'running', pages_visited: 4 })
        const lock = harness.database.prepare(
            `SELECT video_id FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
        ).get() as Record<string, unknown>
        assert.equal(lock.video_id, 'run-new-after-read')
    })

    await t.test('same owner heartbeat refresh after the stale read makes the CAS fail', async (t) => {
        const harness = makeScheduledRuntimeHarness()
        t.after(() => harness.database.close())
        const runId = 'run-heartbeat-refreshed'
        const staleAt = new Date(Date.now() - 5 * 60_000).toISOString()
        await acquireAndInitialize(harness, runId, makeRuntimeState(staleAt, { status: 'running' }))
        const freshHeartbeat = new Date().toISOString()
        harness.db.afterFirst = async () => {
            assert.equal(
                await harness.helpers.updateCronRuntimeState(harness.db, runId, { heartbeatAt: freshHeartbeat }),
                true,
            )
        }

        assert.equal(await harness.helpers.recoverStaleScheduledRun(harness.db, 30_000), false)
        const runtime = harness.database.prepare(
            `SELECT run_id, status, heartbeat_at FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>
        assert.deepEqual({ ...runtime }, { run_id: runId, status: 'running', heartbeat_at: freshHeartbeat })
        const lock = harness.database.prepare(
            `SELECT video_id FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
        ).get() as Record<string, unknown>
        assert.equal(lock.video_id, runId)
    })

    await t.test('new lock acquired before runtime initialization survives stale cleanup', async (t) => {
        const harness = makeScheduledRuntimeHarness()
        t.after(() => harness.database.close())
        const staleRunId = 'run-stale-acquire-gap'
        const newerRunId = 'run-new-acquire-gap'
        const staleAt = new Date(Date.now() - 5 * 60_000).toISOString()
        await acquireAndInitialize(harness, staleRunId, makeRuntimeState(staleAt, { status: 'running' }))
        harness.db.afterFirst = async () => {
            harness.database.prepare(
                `DELETE FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
            ).run()
            const lockKey = await harness.helpers.tryAcquirePostingLock(harness.db, {
                scope: 'page',
                namespaceId: '__scheduled__',
                pageId: 'run',
                videoId: newerRunId,
                ttlMinutes: 10,
            })
            assert.equal(lockKey, 'page::__scheduled__::run')
        }

        assert.equal(await harness.helpers.recoverStaleScheduledRun(harness.db, 30_000), true)
        const lock = harness.database.prepare(
            `SELECT video_id FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
        ).get() as Record<string, unknown>
        assert.equal(lock.video_id, newerRunId, 'compare-and-delete must not remove the newly acquired token')
        assert.equal(
            await harness.helpers.initializeCronRuntimeState(
                harness.db,
                newerRunId,
                makeRuntimeState(new Date().toISOString(), { status: 'running' }),
            ),
            true,
        )
        const runtime = harness.database.prepare(
            `SELECT run_id, status FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>
        assert.deepEqual({ ...runtime }, { run_id: newerRunId, status: 'running' })
    })

    await t.test('unchanged stale tokenized owner is failed and its own lock is removed', async (t) => {
        const harness = makeScheduledRuntimeHarness()
        t.after(() => harness.database.close())
        const runId = 'run-stale-tokenized-lock'
        const staleAt = new Date(Date.now() - 5 * 60_000).toISOString()
        await acquireAndInitialize(harness, runId, makeRuntimeState(staleAt, { status: 'running' }))

        assert.equal(await harness.helpers.recoverStaleScheduledRun(harness.db, 30_000), true)
        const runtime = harness.database.prepare(
            `SELECT run_id, status, last_error FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>
        assert.deepEqual({ ...runtime }, {
            run_id: runId,
            status: 'failed',
            last_error: `stale_scheduled_run_recovered:${runId}`,
        })
        const lock = harness.database.prepare(
            `SELECT video_id FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
        ).get()
        assert.equal(lock, undefined)
    })

    await t.test('unchanged stale owner is failed and its exact legacy lock row is removed', async (t) => {
        const harness = makeScheduledRuntimeHarness()
        t.after(() => harness.database.close())
        const runId = 'run-stale-legacy-lock'
        const staleAt = new Date(Date.now() - 5 * 60_000).toISOString()
        await acquireAndInitialize(harness, runId, makeRuntimeState(staleAt, { status: 'starting' }))
        harness.database.prepare(
            `UPDATE posting_locks SET video_id = '' WHERE lock_key = 'page::__scheduled__::run'`,
        ).run()

        assert.equal(await harness.helpers.recoverStaleScheduledRun(harness.db, 30_000), true)
        const runtime = harness.database.prepare(
            `SELECT run_id, status, last_error FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>
        assert.deepEqual({ ...runtime }, {
            run_id: runId,
            status: 'failed',
            last_error: `stale_scheduled_run_recovered:${runId}`,
        })
        assert.equal(
            await harness.helpers.updateCronRuntimeState(harness.db, runId, {
                status: 'completed',
                finishedAt: new Date().toISOString(),
                heartbeatAt: new Date().toISOString(),
            }),
            false,
            'a recovered stale run must not be able to rewrite failed as completed',
        )
        const runtimeAfterOldCompletion = harness.database.prepare(
            `SELECT run_id, status, last_error FROM cron_runtime_state WHERE id = 'scheduled'`,
        ).get() as Record<string, unknown>
        assert.deepEqual({ ...runtimeAfterOldCompletion }, {
            run_id: runId,
            status: 'failed',
            last_error: `stale_scheduled_run_recovered:${runId}`,
        })
        const lock = harness.database.prepare(
            `SELECT video_id FROM posting_locks WHERE lock_key = 'page::__scheduled__::run'`,
        ).get()
        assert.equal(lock, undefined)
    })
})

test('behavior: normal owner initializes, progresses, completes, and releases', async (t) => {
    const harness = makeScheduledRuntimeHarness()
    t.after(() => harness.database.close())
    const runId = 'run-normal-lifecycle'
    const startedAt = new Date().toISOString()
    const initialState = makeRuntimeState(startedAt)

    assert.equal(
        await harness.helpers.initializeCronRuntimeState(harness.db, runId, initialState),
        false,
        'runtime ownership cannot be initialized before the global lock is acquired',
    )
    assert.equal(
        harness.database.prepare(`SELECT run_id FROM cron_runtime_state WHERE id = 'scheduled'`).get(),
        undefined,
    )

    const lockKey = await acquireAndInitialize(harness, runId, initialState)
    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, runId, {
            status: 'running',
            heartbeatAt: new Date().toISOString(),
            pagesTotal: 2,
        }),
        true,
    )
    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, runId, {
            heartbeatAt: new Date().toISOString(),
            currentPageId: 'page-1',
            currentPageName: 'Page One',
            currentNamespaceId: 'namespace-1',
            pagesVisited: 1,
            pagesPosted: 1,
        }),
        true,
    )
    const finishedAt = new Date(Date.now() + 2_000).toISOString()
    assert.equal(
        await harness.helpers.updateCronRuntimeState(harness.db, runId, {
            status: 'completed',
            finishedAt,
            heartbeatAt: finishedAt,
            currentPageId: null,
            currentPageName: null,
            currentNamespaceId: null,
            pagesVisited: 2,
            pagesPosted: 1,
            pagesFailed: 0,
            lastError: null,
        }),
        true,
    )
    const runtime = harness.database.prepare(
        `SELECT run_id, status, finished_at, current_page_id, current_page_name,
                current_namespace_id, pages_total, pages_visited, pages_posted, pages_failed, last_error
         FROM cron_runtime_state WHERE id = 'scheduled'`,
    ).get() as Record<string, unknown>
    assert.deepEqual({ ...runtime }, {
        run_id: runId,
        status: 'completed',
        finished_at: finishedAt,
        current_page_id: null,
        current_page_name: null,
        current_namespace_id: null,
        pages_total: 2,
        pages_visited: 2,
        pages_posted: 1,
        pages_failed: 0,
        last_error: null,
    })
    assert.equal(await harness.helpers.releaseScheduledRunLock(harness.db, lockKey, runId), true)
    assert.equal(
        harness.database.prepare(`SELECT video_id FROM posting_locks WHERE lock_key = ?`).get(lockKey),
        undefined,
    )
})

test('startup page-column maintenance is schema-aware and cached instead of issuing failing ALTERs every tick', () => {
    const body = getPagesColumnMaintenanceSource()
    assert.match(body, /PRAGMA table_info\(pages\)/, 'maintenance must inspect the schema once')
    assert.match(body, /pagesOneCardColumnsReady/, 'maintenance must be cached for the Worker isolate')
    assert.match(body, /if \(existingColumns\.has\(column\.name\)\) continue/, 'existing columns must not be ALTERed again')
})
