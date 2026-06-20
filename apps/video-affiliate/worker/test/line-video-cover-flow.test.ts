import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const requireFromWorker = createRequire(`${process.cwd()}/package.json`)
const ts = requireFromWorker('typescript') as typeof import('typescript')

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

// Isolate the direct LINE video upload handler body so we can assert it mirrors
// the XHS branch's current-intake / stale-guard / visible-fallback invariants.
function getVideoHandlerSource(): string {
    return sliceBetween(
        getSource(),
        'async function handleLineVideoMessage(params: {',
        'async function ackAndStartLineWaitingVideoFinalization(params: {',
        'handleLineVideoMessage',
    )
}

// Isolate the LINE webhook handler body so we can assert it does NOT re-detach
// event processing by passing its own executionCtx down into handleLineEvent.
function getLineWebhookSource(): string {
    return sliceBetween(
        getSource(),
        "app.post('/api/line/webhook', async (c) => {",
        "app.post('/api/line/liff-login'",
        'LINE webhook handler',
    )
}

type HarnessSend = {
    replyToken: string
    messages: Array<Record<string, unknown>>
}

function makeLineVideoHandlerHarness(options: {
    coverPickerSendFails?: boolean
    firstTextFollowupFails?: boolean
} = {}) {
    const compiled = ts.transpileModule(getVideoHandlerSource(), {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
    }).outputText

    const lineUserId = 'line-user-1'
    const values = new Map<string, string>()
    const sends: HarnessSend[] = []
    const ackPushes: Array<{ lineUserId: string; messages: Array<Record<string, unknown>> }> = []
    const prompts: unknown[] = []
    const currentWrites: unknown[] = []
    const clearedCurrent: string[] = []
    let textFollowupFailuresRemaining = options.firstTextFollowupFails ? 1 : 0

    const bucket = {
        async get(key: string) {
            const value = values.get(key)
            if (value == null) return null
            return {
                async json() {
                    return JSON.parse(value)
                },
            }
        },
        async put(key: string, value: unknown) {
            values.set(key, typeof value === 'string' ? value : JSON.stringify(value))
            return null
        },
        async delete(keyOrKeys: string | string[]) {
            for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
                values.delete(key)
            }
        },
    }

    values.set(`_waiting_video_cancelled/${lineUserId}.json`, JSON.stringify({
        videoId: 'oldvideo',
        cancelledAt: '2026-06-20T10:00:00.000Z',
    }))

    const getLineCurrentVideoIntake = async (_bucket: typeof bucket, userId: string) => {
        const obj = await _bucket.get(`_waiting_video_current/${userId}.json`)
        return obj ? obj.json() : null
    }
    const putLineCurrentVideoIntake = async (_bucket: typeof bucket, userId: string, input: Record<string, unknown>) => {
        currentWrites.push(input)
        await _bucket.put(`_waiting_video_current/${userId}.json`, JSON.stringify(input))
        return input
    }
    const clearLineCurrentVideoIntake = async (_bucket: typeof bucket, userId: string) => {
        await _bucket.delete(`_waiting_video_current/${userId}.json`)
    }
    const clearLineCurrentVideoIntakeIfMatches = async (_bucket: typeof bucket, userId: string, videoId: string) => {
        const current = await getLineCurrentVideoIntake(_bucket, userId)
        if (String(current?.videoId || '') !== videoId) return
        clearedCurrent.push(videoId)
        await clearLineCurrentVideoIntake(_bucket, userId)
    }
    const isLineCurrentVideoIntake = async (_bucket: typeof bucket, userId: string, videoId: string) => {
        const current = await getLineCurrentVideoIntake(_bucket, userId)
        return String(current?.videoId || '') === videoId
    }
    const putLineWaitingVideoState = async (_bucket: typeof bucket, userId: string, input: Record<string, unknown>) => {
        await _bucket.put(`_waiting_video/${userId}.json`, JSON.stringify(input))
        return input
    }
    const lineReplyOrPush = async (params: {
        replyToken: string
        messages: Array<Record<string, unknown>>
    }) => {
        sends.push({
            replyToken: params.replyToken,
            messages: params.messages,
        })
        const firstMessage = params.messages[0] || {}
        if (options.coverPickerSendFails && firstMessage.type === 'flex') {
            throw new Error('line_cover_picker_send_failed')
        }
        if (
            textFollowupFailuresRemaining > 0
            && firstMessage.type === 'text'
            && /โหลดตัวเลือกปก|เกิดข้อผิดพลาด/.test(String(firstMessage.text || ''))
        ) {
            textFollowupFailuresRemaining--
            throw new Error('transient_line_text_followup_failed')
        }
    }
    const linePushMessage = async (_channelAccessToken: string, pushedLineUserId: string, messages: Array<Record<string, unknown>>) => {
        ackPushes.push({ lineUserId: pushedLineUserId, messages })
        return { ok: true }
    }
    const promptLineCoverOptions = async (params: {
        replyToken: string
        channelAccessToken: string
        lineUserId: string
    }) => {
        prompts.push(params)
        await lineReplyOrPush({
            replyToken: params.replyToken,
            messages: [{ type: 'flex', altText: 'เลือกปก' }],
        })
    }

    const factory = new Function(
        'crypto',
        'fetch',
        'putLineCurrentVideoIntake',
        'getLineCurrentVideoIntake',
        'clearLineCurrentVideoIntake',
        'clearLineCurrentVideoIntakeIfMatches',
        'isLineCurrentVideoIntake',
        'linePushMessage',
        'lineReplyOrPush',
        'assertDownloadedVideoResponse',
        'storeOriginalVideoBuffer',
        'backfillOriginalThumbnail',
        'putLineWaitingVideoState',
        'promptLineCoverOptions',
        'LINE_CANCEL_QUICK_REPLY_ITEM',
        `${compiled}
return handleLineVideoMessage`,
    )

    const handler = factory(
        { randomUUID: () => 'freshvid-0000-4000-8000-000000000000' },
        async () => new Response('video-bytes', { headers: { 'content-type': 'video/mp4' } }),
        putLineCurrentVideoIntake,
        getLineCurrentVideoIntake,
        clearLineCurrentVideoIntake,
        clearLineCurrentVideoIntakeIfMatches,
        isLineCurrentVideoIntake,
        linePushMessage,
        lineReplyOrPush,
        () => { },
        async () => 'https://worker.example/videos/freshvid_line_original.mp4',
        async () => ({ generated: true, thumbnailUrl: 'https://worker.example/thumb.webp' }),
        putLineWaitingVideoState,
        promptLineCoverOptions,
        { type: 'action', action: { type: 'message', label: 'ยกเลิกงาน', text: 'ยกเลิกงาน' } },
    ) as (params: Record<string, unknown>) => Promise<void>

    return {
        handler,
        bucket,
        lineUserId,
        values,
        sends,
        ackPushes,
        prompts,
        currentWrites,
        clearedCurrent,
    }
}

test('direct LINE video upload does NOT send a visible ack bubble before the cover picker', () => {
    const handler = getVideoHandlerSource()
    assert.doesNotMatch(
        handler,
        /รับวิดีโอแล้ว 🎬 กำลังเตรียมตัวเลือกปกให้นะ รอสักครู่\.\.\./,
        'direct video must NOT push a "รับวิดีโอแล้ว…" ack before the cover picker — the picker/error is the first visible response (matches XHS/link UX)',
    )
    assert.doesNotMatch(
        handler,
        /linePushMessage\(channelAccessToken, lineUserId/,
        'direct video must not pre-ack via linePushMessage; the cover picker must be the first meaningful bot response',
    )
})

test('direct LINE video follow-ups use the original reply token first with push fallback', () => {
    const handler = getVideoHandlerSource()
    assert.match(
        handler,
        /const followupReplyToken = replyToken/,
        'video follow-ups must use the original reply token first (cover-picker-first, no consuming ack)',
    )
    assert.match(
        handler,
        /replyToken: followupReplyToken/,
        'cover picker and failure paths must deliver via followupReplyToken with push fallback',
    )
})

test('behavior: direct video after cancel supersedes old state and reaches cover picker', async () => {
    const harness = makeLineVideoHandlerHarness()

    await harness.handler({
        env: {},
        bucket: harness.bucket,
        namespaceId: 'namespace-1',
        channelAccessToken: 'line-token',
        replyToken: 'reply-token-new-video',
        lineUserId: harness.lineUserId,
        messageId: 'line-message-1',
    })

    assert.equal(harness.ackPushes.length, 0, 'fresh direct video must NOT push any visible ack before the cover picker')
    assert.ok(
        !harness.sends.some((send) => send.messages.some((message) => /รับวิดีโอแล้ว 🎬/.test(String(message.text || '')))),
        'no "รับวิดีโอแล้ว 🎬" ack bubble may be delivered before the cover picker',
    )
    assert.equal(harness.prompts.length, 1, 'fresh direct video must attempt the cover picker as the first response')

    const coverSend = harness.sends.find((send) => send.messages.some((message) => message.type === 'flex'))
    assert.ok(coverSend, 'cover picker send must be the first meaningful response')
    assert.equal(
        coverSend.replyToken,
        'reply-token-new-video',
        'cover picker must use the fresh video reply token first instead of becoming push-only',
    )

    const current = JSON.parse(harness.values.get(`_waiting_video_current/${harness.lineUserId}.json`) || '{}')
    assert.equal(current.videoId, 'freshvid', 'fresh video must become the current intake')
    const oldCancel = JSON.parse(harness.values.get(`_waiting_video_cancelled/${harness.lineUserId}.json`) || '{}')
    assert.equal(oldCancel.videoId, 'oldvideo', 'old cancel marker must not classify the fresh video as cancelled')
})

test('behavior: direct video cover send failure retries visible error instead of ending at ack-only', async () => {
    const harness = makeLineVideoHandlerHarness({
        coverPickerSendFails: true,
        firstTextFollowupFails: true,
    })

    await harness.handler({
        env: {},
        bucket: harness.bucket,
        namespaceId: 'namespace-1',
        channelAccessToken: 'line-token',
        replyToken: 'reply-token-new-video',
        lineUserId: harness.lineUserId,
        messageId: 'line-message-1',
    })

    assert.equal(harness.ackPushes.length, 0, 'no ack push is attempted; the cover picker is the first response')
    assert.equal(harness.prompts.length, 1, 'cover picker should be attempted before fallback')

    const textFollowups = harness.sends.filter((send) => send.messages.some((message) => message.type === 'text'))
    assert.ok(
        textFollowups.some((send) => /รับวิดีโอแล้ว แต่โหลดตัวเลือกปกไม่สำเร็จ/.test(String(send.messages[0]?.text || ''))),
        'cover-prompt catch should attempt the specific visible fallback',
    )
    assert.ok(
        textFollowups.some((send) => /เกิดข้อผิดพลาดในการรับวิดีโอ/.test(String(send.messages[0]?.text || ''))),
        'if that fallback send fails, the outer catch must retry a visible error instead of returning after the ack',
    )
    assert.deepEqual(harness.clearedCurrent, ['freshvid'], 'terminal failure must clear only the matching fresh intake')
})

test('video branch establishes current-intake marker before slow download/store', () => {
    const handler = getVideoHandlerSource()

    const markerIndex = handler.indexOf('await putLineCurrentVideoIntake(bucket, lineUserId, {')
    const downloadIndex = handler.indexOf('await fetch(`https://api-data.line.me/v2/bot/message/')
    const storeIndex = handler.indexOf('await storeOriginalVideoBuffer({')
    assert.notEqual(markerIndex, -1, 'video branch must write a current-intake marker')
    assert.notEqual(downloadIndex, -1, 'video branch must still download video content from LINE')
    assert.notEqual(storeIndex, -1, 'video branch must still store the original video buffer')
    assert.ok(markerIndex < downloadIndex, 'current-intake marker must be written before the slow content download')
    assert.ok(markerIndex < storeIndex, 'current-intake marker must be written before the slow R2 store')
    assert.match(
        handler.slice(markerIndex, downloadIndex),
        /videoId,/,
        'current-intake marker must be keyed to this request videoId',
    )
})

test('video follow-up verifies current intake before writing waiting state and prompting covers', () => {
    const handler = getVideoHandlerSource()

    const guardFactoryIndex = handler.indexOf('const isCurrentVideoIntake = () => isLineCurrentVideoIntake(bucket, lineUserId, videoId)')
    const putIndex = handler.indexOf('const waitingState = await putLineWaitingVideoState(bucket, lineUserId, {')
    const promptIndex = handler.indexOf('await promptLineCoverOptions({', putIndex)
    assert.notEqual(guardFactoryIndex, -1, 'video follow-up must define a request-current guard')
    assert.notEqual(putIndex, -1, 'video follow-up must write waiting state')
    assert.notEqual(promptIndex, -1, 'video follow-up must prompt cover options')

    assert.match(
        handler.slice(guardFactoryIndex, putIndex),
        /if \(!\(await isCurrentVideoIntake\(\)\)\) return/,
        'video follow-up must verify current request before putLineWaitingVideoState',
    )
    assert.match(
        handler.slice(putIndex, promptIndex),
        /if \(!\(await isCurrentVideoIntake\(\)\)\) return/,
        'video follow-up must re-check current request before promptLineCoverOptions',
    )
})

test('video cover-prompt failure sends a visible follow-up fallback, not silence', () => {
    const handler = getVideoHandlerSource()

    const promptIndex = handler.indexOf('await promptLineCoverOptions({')
    assert.notEqual(promptIndex, -1, 'video branch must call promptLineCoverOptions')

    const catchIndex = handler.indexOf('} catch (e) {', promptIndex)
    assert.notEqual(catchIndex, -1, 'promptLineCoverOptions call must be wrapped in try/catch')

    const fallbackText = 'รับวิดีโอแล้ว แต่โหลดตัวเลือกปกไม่สำเร็จ ลองส่งวิดีโอใหม่อีกครั้ง'
    const fallbackIndex = handler.indexOf(fallbackText, catchIndex)
    assert.notEqual(fallbackIndex, -1, 'cover-prompt failure must surface a clear fallback message')

    const catchBlock = handler.slice(catchIndex, fallbackIndex)
    assert.match(catchBlock, /lineReplyOrPush\(/, 'fallback must be sent via lineReplyOrPush')
    assert.match(catchBlock, /replyToken: followupReplyToken/, 'fallback must use followupReplyToken with push fallback')
})

test('video download failure surfaces a visible error and clears the matching marker', () => {
    const handler = getVideoHandlerSource()

    const failGuardIndex = handler.indexOf('if (!contentResp.ok) {')
    const failTextIndex = handler.indexOf('ไม่สามารถดาวน์โหลดวิดีโอได้ กรุณาลองใหม่อีกครั้ง', failGuardIndex)
    assert.notEqual(failGuardIndex, -1, 'video branch must handle a failed content download')
    assert.notEqual(failTextIndex, -1, 'download failure must surface a clear error message')

    const block = handler.slice(failGuardIndex, failTextIndex)
    assert.match(
        block,
        /if \(!\(await isCurrentVideoIntake\(\)\)\) return/,
        'superseded download failure must return before pushing failure text',
    )

    const clearIndex = handler.indexOf('await clearLineCurrentVideoIntakeIfMatches(bucket, lineUserId, videoId)', failTextIndex)
    assert.notEqual(clearIndex, -1, 'download failure must clear current marker through the match helper')
})

test('superseded video follow-up exits silently before cover or failure pushes', () => {
    const handler = getVideoHandlerSource()

    // Cover-prompt catch must check current-intake before its push.
    const catchIndex = handler.indexOf('} catch (e) {')
    const coverFallbackIndex = handler.indexOf('รับวิดีโอแล้ว แต่โหลดตัวเลือกปกไม่สำเร็จ', catchIndex)
    assert.notEqual(catchIndex, -1, 'video branch must wrap the cover prompt')
    assert.notEqual(coverFallbackIndex, -1, 'video branch must keep the cover fallback message')
    assert.match(
        handler.slice(catchIndex, coverFallbackIndex),
        /if \(!\(await isCurrentVideoIntake\(\)\)\) return/,
        'superseded cover prompt failure must return before pushing the fallback',
    )

    // Last-resort outer catch must check current-intake before its push.
    const outerCatchIndex = handler.indexOf('})().catch(async (e) => {')
    const crashFailureIndex = handler.indexOf('เกิดข้อผิดพลาดในการรับวิดีโอ กรุณาลองใหม่อีกครั้ง', outerCatchIndex)
    assert.notEqual(outerCatchIndex, -1, 'video follow-up must keep a last-resort catch')
    assert.notEqual(crashFailureIndex, -1, 'video follow-up must keep a crash fallback message')
    assert.match(
        handler.slice(outerCatchIndex, crashFailureIndex),
        /if \(!\(await isLineCurrentVideoIntake\(bucket, lineUserId, videoId\)\)\) return/,
        'superseded crashed follow-up must return before pushing an old failure',
    )
})

test('active video terminal failures clear the current marker only through the match guard', () => {
    const handler = getVideoHandlerSource()

    // The video branch must never directly clear a possibly-newer current marker.
    assert.doesNotMatch(
        handler,
        /clearLineCurrentVideoIntake\(bucket, lineUserId\)/,
        'video terminal paths must not directly clear a possibly newer current marker',
    )

    // Outer crash catch: guard -> push -> clear, in that order.
    const outerCatchIndex = handler.indexOf('})().catch(async (e) => {')
    const crashBlock = handler.slice(outerCatchIndex)
    const crashGuardIndex = crashBlock.indexOf('if (!(await isLineCurrentVideoIntake(bucket, lineUserId, videoId))) return')
    const crashPushIndex = crashBlock.indexOf('await lineReplyOrPush({')
    const crashClearIndex = crashBlock.indexOf('await clearLineCurrentVideoIntakeIfMatches(bucket, lineUserId, videoId)')
    assert.notEqual(crashGuardIndex, -1, 'crash fallback must keep the stale/superseded guard')
    assert.notEqual(crashPushIndex, -1, 'crash fallback must still push a user-visible failure')
    assert.notEqual(crashClearIndex, -1, 'crash fallback must clear current marker through match helper')
    assert.ok(crashGuardIndex < crashPushIndex, 'stale crash fallback must return before pushing failure text')
    assert.ok(crashPushIndex < crashClearIndex, 'crash marker cleanup must happen after the failure push')
})

test('new video intake does not clear the user-level cancel marker for an older job', () => {
    const handler = getVideoHandlerSource()
    assert.doesNotMatch(
        handler,
        /clearLineWaitingVideoCancelled\(bucket, lineUserId\)/,
        'a fresh video upload must not clear the cancel marker of an older in-flight job (the videoId-scoped marker + current-intake supersede it)',
    )
})

// XHS regression guard: both the direct-video and XHS branches must continue to
// supersede older work through the SAME current-intake marker, so the shared
// getLineWaitingVideoState filter keeps cover/postback reads pointed at the
// newest clip regardless of source.
test('both LINE intake sources supersede older work via the current-intake marker', () => {
    const source = getSource()
    const videoHandler = getVideoHandlerSource()
    const xhsBranch = sliceBetween(
        source,
        "    // Check if it's an XHS link",
        '\n    if (!shopeeLink && !lazadaLink) {',
        'LINE XHS branch',
    )
    assert.match(videoHandler, /putLineCurrentVideoIntake\(bucket, lineUserId, \{/, 'video intake must set the current-intake marker')
    assert.match(xhsBranch, /putLineCurrentVideoIntake\(bucket, lineUserId, \{/, 'XHS intake must still set the current-intake marker')

    const waitingHelper = sliceBetween(
        source,
        'async function getLineWaitingVideoState(bucket: R2Bucket, lineUserId: string): Promise<LineWaitingVideoState | null> {',
        'async function putLineWaitingVideoState(bucket: R2Bucket, lineUserId: string, input: Partial<LineWaitingVideoState>): Promise<LineWaitingVideoState> {',
        'getLineWaitingVideoState helper',
    )
    assert.match(
        waitingHelper,
        /currentIntake\?\.videoId && state\.id !== currentIntake\.videoId/,
        'shared waiting-state read must keep filtering superseded state for both sources',
    )
})

// --- double-detach regression guards ---------------------------------------
// The live "ack then silence" failure was a double-detach: the webhook ran the
// event loop inside its own executionCtx.waitUntil AND passed that executionCtx
// down, so the direct-video handler registered a SECOND, nested waitUntil for
// the slow follow-up and returned early. The nested promise was not reliably
// awaited, so neither the cover picker nor its fallback ran. These tests lock in
// that the webhook keeps a single outer waitUntil and lets the handler await its
// follow-up inline.

test('LINE webhook still backgrounds event processing in one outer waitUntil', () => {
    const webhook = getLineWebhookSource()
    assert.match(
        webhook,
        /c\.executionCtx\.waitUntil\(\(async \(\) => \{/,
        'webhook must run the event loop inside executionCtx.waitUntil so it can return 200 immediately while the worker stays alive',
    )
    assert.match(
        webhook,
        /return c\.json\(\{ ok: true \}\)/,
        'webhook must still return 200 immediately after scheduling the background loop',
    )
})

test('LINE webhook does NOT pass its own executionCtx into handleLineEvent (no double-detach)', () => {
    const webhook = getLineWebhookSource()
    assert.match(
        webhook,
        /await handleLineEvent\(event, c\.env, channelAccessToken\)/,
        'webhook must call handleLineEvent WITHOUT executionCtx so the handler awaits its follow-up inside the outer waitUntil',
    )
    assert.doesNotMatch(
        webhook,
        /handleLineEvent\([^)]*c\.executionCtx[^)]*\)/,
        'webhook must NOT pass c.executionCtx down: that re-detaches the follow-up and the cover picker/fallback can be dropped before it runs',
    )
})

test('direct-video handler self-detaches only when a top-level executionCtx is provided', () => {
    const handler = getVideoHandlerSource()

    const branchIndex = handler.indexOf('if (executionCtx) {')
    assert.notEqual(branchIndex, -1, 'handler must keep an executionCtx guard for hypothetical top-level callers')

    const nestedWaitUntilIndex = handler.indexOf('executionCtx.waitUntil(followupPromise)', branchIndex)
    assert.notEqual(nestedWaitUntilIndex, -1, 'self-detach must use executionCtx.waitUntil(followupPromise)')
    assert.ok(
        nestedWaitUntilIndex > branchIndex && nestedWaitUntilIndex < branchIndex + 120,
        'the nested waitUntil must live INSIDE the executionCtx guard, not run unconditionally',
    )

    const inlineAwaitIndex = handler.indexOf('await followupPromise', nestedWaitUntilIndex)
    assert.notEqual(inlineAwaitIndex, -1, 'handler must await followupPromise inline as the fallback when no executionCtx is given')
    assert.ok(
        inlineAwaitIndex > nestedWaitUntilIndex,
        'inline await must follow the guarded self-detach so the webhook (no executionCtx) path awaits within the outer waitUntil',
    )

    // followupPromise must never be left dangling: it is either handed to a
    // top-level executionCtx.waitUntil OR awaited inline — exactly once each.
    const detachCount = (handler.match(/executionCtx\.waitUntil\(followupPromise\)/g) || []).length
    const inlineCount = (handler.match(/await followupPromise/g) || []).length
    assert.equal(detachCount, 1, 'handler must self-detach the follow-up in exactly one place (guarded)')
    assert.equal(inlineCount, 1, 'handler must await the follow-up inline in exactly one place (fallback)')
})
