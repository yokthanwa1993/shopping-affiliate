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

// Isolate the XHS branch inside handleLineTextMessage: from the xhsMatch guard
// to the end of that branch (the `return` that closes the `if (xhsMatch)`).
function getXhsBranchSource(): string {
    return sliceBetween(
        getSource(),
        "    // Check if it's an XHS link",
        '\n    if (!shopeeLink && !lazadaLink) {',
        'LINE XHS branch',
    )
}

test('XHS link branch keeps cover picker as the first visible LINE response', () => {
    const branch = getXhsBranchSource()

    const unwantedAck = 'รับลิงก์ XHS แล้ว 🎬 กำลังดึงวิดีโอ/เตรียมตัวเลือกปกให้นะ รอสักครู่...'
    const resolveIndex = branch.indexOf("'/xhs/resolve'")
    const promptIndex = branch.indexOf('await promptLineCoverOptions({')
    assert.equal(branch.includes(unwantedAck), false, 'LINE XHS branch must not send the intermediate ack bubble')
    assert.notEqual(resolveIndex, -1, 'XHS branch must still call /xhs/resolve')
    assert.notEqual(promptIndex, -1, 'XHS branch must still send cover picker options')
})

test('XHS follow-ups keep the original reply token for cover-picker-first UX', () => {
    const branch = getXhsBranchSource()

    assert.match(
        branch,
        /const followupReplyToken = replyToken/,
        'follow-up messages must keep the original reply token so cover picker is first visible response',
    )
    assert.doesNotMatch(
        branch,
        /const followupReplyToken = ''/,
        'LINE XHS branch must not force push follow-ups via an empty token after an ack',
    )
    assert.match(branch, /replyToken: followupReplyToken/, 'cover picker and failure paths must use followupReplyToken')
})

test('XHS failure path still sends an explicit error message (no silence)', () => {
    const branch = getXhsBranchSource()
    assert.ok(
        branch.includes('โหลดวิดีโอจาก XHS ไม่สำเร็จ')
        || branch.includes('ลิงก์ XHS นี้อาจไม่ใช่โพสต์วิดีโอ'),
        'XHS failure must surface a clear error message to the user',
    )
})

test('XHS cover-prompt failure sends a visible fallback, not silence', () => {
    const branch = getXhsBranchSource()

    const promptIndex = branch.indexOf('await promptLineCoverOptions({')
    assert.notEqual(promptIndex, -1, 'XHS branch must call promptLineCoverOptions')

    // The cover prompt must be guarded so a send failure does not silently end
    // the flow. The catch must send the fallback through the same follow-up
    // token policy as the cover picker.
    const catchIndex = branch.indexOf('} catch (e) {', promptIndex)
    assert.notEqual(catchIndex, -1, 'promptLineCoverOptions call must be wrapped in try/catch')

    const fallbackText = 'รับลิงก์ XHS แล้ว แต่โหลดตัวเลือกปกไม่สำเร็จ ลองใหม่'
    const fallbackIndex = branch.indexOf(fallbackText, catchIndex)
    assert.notEqual(fallbackIndex, -1, 'cover-prompt failure must surface a clear fallback message')

    const catchBlock = branch.slice(catchIndex, fallbackIndex)
    assert.match(catchBlock, /lineReplyOrPush\(/, 'fallback must be sent via lineReplyOrPush')
    assert.match(catchBlock, /replyToken: followupReplyToken/, 'fallback must use followupReplyToken')
})

// Isolate the promptLineCoverOptions helper body so we can assert it no longer
// swallows the cover-picker send failure (callers rely on it propagating).
function getPromptLineCoverOptionsSource(): string {
    return sliceBetween(
        getSource(),
        'async function promptLineCoverOptions(params: {',
        'async function promptLineCoverTextPositionOptions(params: {',
        'promptLineCoverOptions helper',
    )
}

function getLineWaitingVideoStateSource(): string {
    return sliceBetween(
        getSource(),
        'async function getLineWaitingVideoState(bucket: R2Bucket, lineUserId: string): Promise<LineWaitingVideoState | null> {',
        'async function putLineWaitingVideoState(bucket: R2Bucket, lineUserId: string, input: Partial<LineWaitingVideoState>): Promise<LineWaitingVideoState> {',
        'getLineWaitingVideoState helper',
    )
}

function getLineCancelBlockSource(): string {
    return sliceBetween(
        getSource(),
        '    if (isLineCancelCommand(text)) {',
        '\n    if (waitingState?.awaitingStep ===',
        'LINE cancel block',
    )
}

function getLineCurrentVideoIntakeClearIfMatchesSource(): string {
    return sliceBetween(
        getSource(),
        'async function clearLineCurrentVideoIntakeIfMatches(bucket: R2Bucket, lineUserId: string, videoId: string): Promise<void> {',
        'async function isLineCurrentVideoIntake(bucket: R2Bucket, lineUserId: string, videoId: string): Promise<boolean> {',
        'clearLineCurrentVideoIntakeIfMatches helper',
    )
}

function getFinalizeLineWaitingVideoSource(): string {
    return sliceBetween(
        getSource(),
        'async function finalizeLineWaitingVideoAndStartProcessing(params: {',
        'async function handleLineVideoMessage(params: {',
        'finalizeLineWaitingVideoAndStartProcessing helper',
    )
}

test('promptLineCoverOptions does not swallow cover-picker send failure', () => {
    const helper = getPromptLineCoverOptionsSource()

    // It must still send the cover picker via lineReplyOrPush...
    assert.match(helper, /await lineReplyOrPush\(/, 'helper must send the cover picker via lineReplyOrPush')
    // ...but must NOT swallow the failure with a no-op catch, which would hide
    // a failed push from callers and strand the user on the ack.
    assert.doesNotMatch(
        helper,
        /\}\)\.catch\(\(\) => \{ ?\} ?\)/,
        'helper must not silently swallow the cover-picker send failure',
    )
})

test('XHS link branch establishes current intake marker before slow resolve/download', () => {
    const branch = getXhsBranchSource()

    const markerIndex = branch.indexOf('await putLineCurrentVideoIntake(bucket, lineUserId, {')
    const resolveIndex = branch.indexOf("'/xhs/resolve'")
    const downloadIndex = branch.indexOf('await fetch(resolvedVideoUrl, {')
    assert.notEqual(markerIndex, -1, 'XHS branch must write a current-intake marker')
    assert.notEqual(resolveIndex, -1, 'XHS branch must still resolve XHS URLs')
    assert.notEqual(downloadIndex, -1, 'XHS branch must still download resolved video URLs')
    assert.ok(markerIndex < resolveIndex, 'current-intake marker must be written before slow XHS resolve')
    assert.ok(markerIndex < downloadIndex, 'current-intake marker must be written before slow XHS download')
    assert.match(branch.slice(markerIndex, resolveIndex), /videoId,/, 'current-intake marker must be keyed to this request videoId')
})

test('XHS follow-up verifies current intake before writing waiting state and prompting covers', () => {
    const branch = getXhsBranchSource()

    const guardFactoryIndex = branch.indexOf('const isCurrentXhsIntake = () => isLineCurrentVideoIntake(bucket, lineUserId, videoId)')
    const putIndex = branch.indexOf('const waitingState = await putLineWaitingVideoState(bucket, lineUserId, {')
    const promptIndex = branch.indexOf('await promptLineCoverOptions({', putIndex)
    assert.notEqual(guardFactoryIndex, -1, 'XHS follow-up must define a request-current guard')
    assert.notEqual(putIndex, -1, 'XHS follow-up must write waiting state')
    assert.notEqual(promptIndex, -1, 'XHS follow-up must prompt cover options')

    assert.match(
        branch.slice(guardFactoryIndex, putIndex),
        /if \(!\(await isCurrentXhsIntake\(\)\)\) return/,
        'XHS follow-up must verify current request before putLineWaitingVideoState',
    )
    assert.match(
        branch.slice(putIndex, promptIndex),
        /if \(!\(await isCurrentXhsIntake\(\)\)\) return/,
        'XHS follow-up must re-check current request before promptLineCoverOptions',
    )
})

test('LINE waiting-state reads ignore state superseded by current intake marker', () => {
    const helper = getLineWaitingVideoStateSource()

    assert.match(helper, /getLineCurrentVideoIntake\(bucket, lineUserId\)/, 'waiting-state reads must consult current-intake marker')
    assert.match(helper, /currentIntake\?\.videoId && state\.id !== currentIntake\.videoId/, 'waiting state must be rejected when it is not current')
    assert.match(helper, /return null/, 'superseded waiting state must not be returned to cover\/postback handlers')
})

test('current-intake clear helper only clears a matching video id', () => {
    const helper = getLineCurrentVideoIntakeClearIfMatchesSource()

    const readIndex = helper.indexOf('const current = await getLineCurrentVideoIntake(bucket, userId).catch(() => null)')
    const guardIndex = helper.indexOf('if (current?.videoId !== normalizedVideoId) return')
    const clearIndex = helper.indexOf('await clearLineCurrentVideoIntake(bucket, userId)')
    assert.notEqual(readIndex, -1, 'match-clear helper must read the current marker')
    assert.notEqual(guardIndex, -1, 'match-clear helper must return when the marker belongs to another video')
    assert.notEqual(clearIndex, -1, 'match-clear helper must still clear the marker on match')
    assert.ok(readIndex < guardIndex, 'helper must read before comparing video ids')
    assert.ok(guardIndex < clearIndex, 'helper must compare video ids before clearing')
})

test('LINE finalization clears current intake marker with the match guard', () => {
    const finalize = getFinalizeLineWaitingVideoSource()

    const startIndex = finalize.indexOf('const startResult = await ensureInboxVideoProcessingStarted({')
    const clearWaitingIndex = finalize.indexOf('await clearLineWaitingVideoState(params.bucket, params.lineUserId)', startIndex)
    const clearCancelledIndex = finalize.indexOf('await clearLineWaitingVideoCancelled(params.bucket, params.lineUserId)', clearWaitingIndex)
    const clearCurrentIndex = finalize.indexOf('await clearLineCurrentVideoIntakeIfMatches(params.bucket, params.lineUserId, waitingState.id)', clearWaitingIndex)
    assert.notEqual(startIndex, -1, 'finalization must start processing')
    assert.notEqual(clearWaitingIndex, -1, 'finalization must clear waiting state after processing starts')
    assert.notEqual(clearCancelledIndex, -1, 'finalization must clear cancellation state after processing starts')
    assert.notEqual(clearCurrentIndex, -1, 'finalization must clear current marker through the match helper')
    assert.ok(clearWaitingIndex < clearCurrentIndex, 'current marker must be cleared with the same completed waiting id')
    assert.ok(clearCancelledIndex < clearCurrentIndex, 'current marker cleanup must stay with final waiting cleanup')
    assert.doesNotMatch(
        finalize.slice(clearWaitingIndex, clearCurrentIndex),
        /clearLineCurrentVideoIntake\(params\.bucket, params\.lineUserId\)/,
        'finalization must not directly clear an unguarded current marker',
    )
})

test('cancel and new XHS link do not clear or bypass old-request guard', () => {
    const branch = getXhsBranchSource()
    const cancelBlock = getLineCancelBlockSource()

    assert.doesNotMatch(
        branch,
        /clearLineWaitingVideoCancelled\(bucket, lineUserId\)/,
        'new XHS links must not clear the user-level cancel marker for an older in-flight job',
    )
    assert.match(
        cancelBlock,
        /clearLineCurrentVideoIntake\(bucket, lineUserId\)/,
        'cancel must invalidate the active current-intake marker',
    )
    assert.match(
        branch,
        /putLineCurrentVideoIntake\(bucket, lineUserId, \{/,
        'new XHS links must supersede older jobs through the current-intake marker',
    )
})

test('superseded XHS follow-up exits silently before cover or failure pushes', () => {
    const branch = getXhsBranchSource()

    const noOriginalIndex = branch.indexOf('if (!originalStored) {')
    const failureTextIndex = branch.indexOf('const failureText =', noOriginalIndex)
    assert.notEqual(noOriginalIndex, -1, 'XHS branch must handle original-store failure')
    assert.notEqual(failureTextIndex, -1, 'XHS branch must still prepare active-request failure text')
    assert.match(
        branch.slice(noOriginalIndex, failureTextIndex),
        /if \(!\(await isCurrentXhsIntake\(\)\)\) return/,
        'superseded download/resolve failure must return before building or pushing failure text',
    )

    const putIndex = branch.indexOf('const waitingState = await putLineWaitingVideoState(bucket, lineUserId, {')
    const coverFallbackIndex = branch.indexOf('รับลิงก์ XHS แล้ว แต่โหลดตัวเลือกปกไม่สำเร็จ', putIndex)
    assert.notEqual(coverFallbackIndex, -1, 'XHS branch must keep active-request cover fallback')
    assert.match(
        branch.slice(putIndex, coverFallbackIndex),
        /if \(!\(await isCurrentXhsIntake\(\)\)\) return/,
        'superseded cover prompt failure must return before pushing the fallback',
    )

    const outerCatchIndex = branch.indexOf('})().catch(async (error) => {')
    const crashFailureIndex = branch.indexOf('โหลดวิดีโอจาก XHS ไม่สำเร็จ ลองส่งลิงก์ใหม่อีกครั้ง', outerCatchIndex)
    assert.notEqual(outerCatchIndex, -1, 'XHS follow-up must keep a last-resort catch')
    assert.notEqual(crashFailureIndex, -1, 'XHS follow-up must keep active-request crash fallback')
    assert.match(
        branch.slice(outerCatchIndex, crashFailureIndex),
        /if \(!\(await isLineCurrentVideoIntake\(bucket, lineUserId, videoId\)\)\) return/,
        'superseded crashed follow-up must return before pushing an old failure',
    )
})

test('active XHS terminal failures clear current marker only through match guard', () => {
    const branch = getXhsBranchSource()

    assert.doesNotMatch(
        branch,
        /clearLineCurrentVideoIntake\(bucket, lineUserId\)/,
        'XHS terminal paths must not directly clear a possibly newer current marker',
    )

    const noOriginalIndex = branch.indexOf('if (!originalStored) {')
    const createdAtIndex = branch.indexOf('const createdAt = new Date().toISOString()', noOriginalIndex)
    const activeFailureBlock = branch.slice(noOriginalIndex, createdAtIndex)
    const failureGuardIndex = activeFailureBlock.indexOf('if (!(await isCurrentXhsIntake())) return')
    const failurePushIndex = activeFailureBlock.indexOf('await lineReplyOrPush({')
    const failureClearIndex = activeFailureBlock.indexOf('await clearLineCurrentVideoIntakeIfMatches(bucket, lineUserId, videoId)')
    assert.notEqual(noOriginalIndex, -1, 'XHS branch must handle original-store failure')
    assert.notEqual(createdAtIndex, -1, 'XHS branch must continue after original-store failure')
    assert.notEqual(failureGuardIndex, -1, 'active failure must keep the stale/superseded guard')
    assert.notEqual(failurePushIndex, -1, 'active failure must still push user-visible failure')
    assert.notEqual(failureClearIndex, -1, 'active failure must clear current marker through match helper')
    assert.ok(failureGuardIndex < failurePushIndex, 'stale failure must return before pushing failure text')
    assert.ok(failurePushIndex < failureClearIndex, 'active failure marker cleanup must happen after the failure push')

    const outerCatchIndex = branch.indexOf('})().catch(async (error) => {')
    const crashBlock = branch.slice(outerCatchIndex)
    const crashGuardIndex = crashBlock.indexOf('if (!(await isLineCurrentVideoIntake(bucket, lineUserId, videoId))) return')
    const crashPushIndex = crashBlock.indexOf('await lineReplyOrPush({')
    const crashClearIndex = crashBlock.indexOf('await clearLineCurrentVideoIntakeIfMatches(bucket, lineUserId, videoId)')
    assert.notEqual(outerCatchIndex, -1, 'XHS follow-up must keep a last-resort catch')
    assert.notEqual(crashGuardIndex, -1, 'crash fallback must keep the stale/superseded guard')
    assert.notEqual(crashPushIndex, -1, 'crash fallback must still push user-visible failure')
    assert.notEqual(crashClearIndex, -1, 'crash fallback must clear current marker through match helper')
    assert.ok(crashGuardIndex < crashPushIndex, 'stale crash fallback must return before pushing failure text')
    assert.ok(crashPushIndex < crashClearIndex, 'crash marker cleanup must happen after the failure push')
})
