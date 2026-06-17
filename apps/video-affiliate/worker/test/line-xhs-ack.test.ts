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

test('XHS link branch acks before slow resolve/download', () => {
    const branch = getXhsBranchSource()

    const ackIndex = branch.indexOf('รับลิงก์ XHS แล้ว')
    const resolveIndex = branch.indexOf("'/xhs/resolve'")
    assert.notEqual(ackIndex, -1, 'XHS branch must send an immediate ack message')
    assert.notEqual(resolveIndex, -1, 'XHS branch must still call /xhs/resolve')
    assert.ok(
        ackIndex < resolveIndex,
        'ack message must be sent before the slow /xhs/resolve call',
    )
})

test('XHS ack consumes reply token then forces push for follow-ups', () => {
    const branch = getXhsBranchSource()

    // The ack uses the live reply token; follow-ups must use the emptied token.
    assert.match(
        branch,
        /const followupReplyToken = ''/,
        'follow-up messages must use an empty reply token so they push',
    )
    // The original reply token must not be reused after the ack for follow-ups.
    assert.doesNotMatch(
        branch,
        /const followupReplyToken = replyToken/,
        'follow-up token must not reuse the (now consumed) reply token',
    )
    // Cover picker and failure paths route through the emptied follow-up token.
    assert.match(branch, /replyToken: followupReplyToken/, 'follow-ups must use followupReplyToken')
})

test('XHS failure path still sends an explicit error message (no silence)', () => {
    const branch = getXhsBranchSource()
    assert.ok(
        branch.includes('โหลดวิดีโอจาก XHS ไม่สำเร็จ')
        || branch.includes('ลิงก์ XHS นี้อาจไม่ใช่โพสต์วิดีโอ'),
        'XHS failure must surface a clear error message to the user',
    )
})
