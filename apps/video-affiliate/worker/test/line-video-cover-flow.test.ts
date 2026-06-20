import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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

test('direct LINE video upload still acks within the reply window', () => {
    const handler = getVideoHandlerSource()
    assert.match(
        handler,
        /รับวิดีโอแล้ว 🎬 กำลังเตรียมตัวเลือกปกให้นะ รอสักครู่\.\.\./,
        'video upload must ack before slow download/store work',
    )
})

test('direct LINE video follow-ups are push-only after the ack', () => {
    const handler = getVideoHandlerSource()
    assert.match(
        handler,
        /const followupReplyToken = ''/,
        'video follow-ups must be push-only (empty reply token) because the ack consumes the reply token',
    )
    assert.match(
        handler,
        /replyToken: followupReplyToken/,
        'cover picker and failure paths must deliver via followupReplyToken (push)',
    )
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

test('video cover-prompt failure sends a visible push-only fallback, not silence', () => {
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
    assert.match(catchBlock, /replyToken: followupReplyToken/, 'fallback must use followupReplyToken (push-only)')
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
