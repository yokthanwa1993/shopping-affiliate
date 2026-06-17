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

// Shared cancel/clear button used across every pending/failed intake reply.
function getCancelKeyboardSource(): string {
    return sliceBetween(
        getSource(),
        '        const intakeCancelKeyboard = ',
        '\n        const findExistingDuplicateInboxVideo',
        'intakeCancelKeyboard',
    )
}

// Telegram channel-bot XHS intake branch.
function getTelegramXhsBranchSource(): string {
    return sliceBetween(
        getSource(),
        '        // กรณีส่ง XHS link',
        '\n        const shopeeLink = extractShopeeLink(text)',
        'Telegram XHS branch',
    )
}

// Telegram channel-bot video upload branch.
function getTelegramVideoBranchSource(): string {
    return sliceBetween(
        getSource(),
        '        // กรณีส่งวิดีโอมา',
        '\n        // กรณีส่ง XHS link',
        'Telegram video branch',
    )
}

// The shared intake helper that runs the slow materialize.
function getHandleVideoInputSource(): string {
    return sliceBetween(
        getSource(),
        '        const handleVideoInput = async (',
        '\n        // กรณีส่งวิดีโอมา',
        'handleVideoInput',
    )
}

// promptWaitingLink: missing Shopee/Lazada prompts (pending intake).
function getPromptWaitingLinkSource(): string {
    return sliceBetween(
        getSource(),
        '        const promptWaitingLink = async (state: WaitingVideoState) => {',
        '\n        const upsertInboxFromWaitingState',
        'promptWaitingLink',
    )
}

// Free-text fallback ("ข้อความอื่น") — invalid-link nag while pending.
function getOtherTextSource(): string {
    return sliceBetween(
        getSource(),
        '        // ข้อความอื่น',
        '\n        return c.text(\'ok\')\n    } catch',
        'free-text fallback',
    )
}

// Telegram channel-bot callback dispatch block.
function getChannelCallbackSource(): string {
    return sliceBetween(
        getSource(),
        '    // Handle callbacks (del_email:, close_setting, intake_cancel)',
        '\n    if (!msg) return c.text(\'ok\')',
        'channel-bot callback block',
    )
}

test('shared cancel keyboard triggers intake_cancel', () => {
    const kb = getCancelKeyboardSource()
    assert.match(kb, /callback_data: 'intake_cancel'/, 'cancel keyboard must fire intake_cancel')
    assert.match(kb, /inline_keyboard/, 'cancel keyboard must be an inline keyboard')
})

test('Telegram XHS branch acks (with cancel button) before slow handleVideoInput', () => {
    const branch = getTelegramXhsBranchSource()

    const ackIndex = branch.indexOf('รับลิงก์ XHS แล้ว')
    const cancelButtonIndex = branch.indexOf('reply_markup: intakeCancelKeyboard')
    const handleIndex = branch.indexOf('handleVideoInput(')
    assert.notEqual(ackIndex, -1, 'Telegram XHS branch must send an immediate ack')
    assert.notEqual(cancelButtonIndex, -1, 'ack must carry the inline cancel button')
    assert.notEqual(handleIndex, -1, 'Telegram XHS branch must still call handleVideoInput')
    assert.ok(ackIndex < handleIndex, 'ack must be sent before handleVideoInput (which materializes)')
    assert.ok(cancelButtonIndex < handleIndex, 'cancel button must be attached on the pre-work ack')
})

test('Telegram XHS branch clears stale cancel marker before starting', () => {
    const branch = getTelegramXhsBranchSource()
    const clearIndex = branch.indexOf('clearIntakeCancelled()')
    const handleIndex = branch.indexOf('handleVideoInput(')
    assert.notEqual(clearIndex, -1, 'fresh intake must clear any stale cancel marker')
    assert.ok(clearIndex < handleIndex, 'cancel marker must be cleared before the new intake runs')
})

test('Telegram video upload clears stale cancel marker before intake', () => {
    const branch = getTelegramVideoBranchSource()
    const clearIndex = branch.indexOf('clearIntakeCancelled()')
    const handleIndex = branch.indexOf('handleVideoInput(')
    assert.notEqual(clearIndex, -1, 'video upload must clear any stale cancel marker')
    assert.ok(clearIndex < handleIndex, 'stale marker must be cleared before handleVideoInput')
})

test('handleVideoInput aborts after materialize when intake was cancelled', () => {
    const fn = getHandleVideoInputSource()
    const materializeIndex = fn.indexOf('materializeOriginalVideoAsset(')
    const cancelCheckIndex = fn.indexOf('isIntakeCancelled()')
    assert.notEqual(materializeIndex, -1, 'handleVideoInput must still materialize the asset')
    assert.notEqual(cancelCheckIndex, -1, 'handleVideoInput must re-check the cancel marker')
    assert.ok(
        materializeIndex < cancelCheckIndex,
        'cancel check must run AFTER materialize so a late finish cannot resurrect the intake',
    )
    assert.match(fn, /clearWaitingVideoState\(\)/, 'cancel path must clear waiting state')
})

test('missing-link prompts carry the cancel button', () => {
    const fn = getPromptWaitingLinkSource()
    // Both the Lazada and Shopee prompt branches must attach the cancel button.
    const matches = fn.match(/reply_markup: intakeCancelKeyboard/g) || []
    assert.ok(matches.length >= 2, 'both Lazada and Shopee prompts must include the cancel button')
})

test('"already waiting" block reply carries the cancel button', () => {
    const fn = getHandleVideoInputSource()
    const block = sliceBetween(
        fn,
        'ยังมีวิดีโอที่รอลิงก์ค้างอยู่ 1 รายการ',
        'put(dedupKey',
        'already-waiting block',
    )
    assert.match(block, /reply_markup: intakeCancelKeyboard/, 'stuck-waiting reply must include cancel button')
})

test('invalid-link nag while pending carries the cancel button', () => {
    const fn = getOtherTextSource()
    const pendingBlock = sliceBetween(
        fn,
        'if (pendingState) {',
        '} else {',
        'pending invalid-link nag',
    )
    assert.match(pendingBlock, /reply_markup: intakeCancelKeyboard/, 'pending invalid-link nag must include cancel button')
})

test('intake_cancel callback marks cancellation and removes waiting state', () => {
    const cb = getChannelCallbackSource()
    assert.match(cb, /action === 'intake_cancel'/, 'callback must handle intake_cancel')
    assert.match(
        cb,
        /_waiting_video_cancelled\/\$\{chatId\}\.json/,
        'callback must write the per-chat cancellation marker',
    )
    assert.match(
        cb,
        /delete\(`_waiting_video\/\$\{chatId\}\.json`\)/,
        'callback must delete any saved waiting state',
    )
})
