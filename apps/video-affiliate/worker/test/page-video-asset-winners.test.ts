import assert from 'node:assert/strict'
import test from 'node:test'
import {
    aggregatePageVideoConversions,
    buildAssetLibraryVideoDescription,
    buildAssetLibraryVideoTitle,
    parsePageVideoSubId,
} from '../src/page-video-asset-winners.js'

test('parsePageVideoSubId extracts facebook video id and page id from tracked page-video sub id', () => {
    assert.deepEqual(
        parsePageVideoSubId('16MAY26FBSPCAD-1286330037005025-1008898512617594--'),
        {
            subId: '16MAY26FBSPCAD-1286330037005025-1008898512617594--',
            prefix: '16MAY26FBSPCAD',
            fbVideoId: '1286330037005025',
            pageId: '1008898512617594',
        },
    )
})

test('parsePageVideoSubId rejects generic campaign buckets and non matching pages', () => {
    assert.equal(parsePageVideoSubId('16MAY26FBSPCAD----'), null)
    assert.equal(parsePageVideoSubId('16MAY26FBSPCAD-SALES---'), null)
    assert.equal(parsePageVideoSubId('16MAY26FBSPCAD-1277007271270635ReAds---'), null)
    assert.equal(parsePageVideoSubId('16MAY26FBSPCAD-1286330037005025-1008898512617594--', '103881139378321'), null)
})

test('aggregatePageVideoConversions counts only raw rows that map to the target page videos', () => {
    const rows = [
        { utm_content: '16MAY26FBSPCAD-1286330037005025-1008898512617594--', actual_commission: 12.5, purchase_value: 100 },
        { utm_content: '16MAY26FBSPCAD-1286330037005025-1008898512617594--', actual_commission: '7.5', purchase_value: '50' },
        { sub_id: '1JUN26FBSPCAD-1290974216540607-1008898512617594--', commission: 1 },
        { utm_content: '16MAY26FBSPCAD----', actual_commission: 999 },
        { utm_content: '16MAY26FBSPCAD-122308924916016299-103881139378321--', actual_commission: 999 },
    ]

    const winners = aggregatePageVideoConversions(rows, '1008898512617594')

    assert.equal(winners.length, 2)
    assert.equal(winners[0].fbVideoId, '1286330037005025')
    assert.equal(winners[0].orders, 2)
    assert.equal(winners[0].commission, 20)
    assert.equal(winners[0].purchaseValue, 150)
    assert.equal(winners[1].fbVideoId, '1290974216540607')
    assert.equal(winners[1].orders, 1)
})

test('asset library title and description preserve searchable ids for Meta UI', () => {
    const title = buildAssetLibraryVideoTitle({
        systemVideoId: 'aa33bf7b',
        fbVideoId: '1286330037005025',
        orders7d: 12,
        originalTitle: 'ตะกร้าพับได้ มีล้อลาก ประหยัดพื้นที่',
    })
    const description = buildAssetLibraryVideoDescription({
        namespaceId: '1774858894802785816',
        pageId: '1008898512617594',
        fbVideoId: '1286330037005025',
        systemVideoId: 'aa33bf7b',
        sourceSubId: '16MAY26FBSPCAD-1286330037005025-1008898512617594--',
        orders7d: 12,
    })

    assert.match(title, /^WIN_12orders_aa33bf7b_/)
    assert.match(description, /source:page-video/)
    assert.match(description, /fb_video:1286330037005025/)
    assert.match(description, /system_video:aa33bf7b/)
    assert.match(description, /orders_7d:12/)
})
