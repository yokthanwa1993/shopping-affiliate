import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AI_CLIP_PREFIX,
    AI_CLIP_SOURCE_LABEL,
    AI_CLIP_SOURCE_TYPE,
    aiClipNamespacePrefix,
    aiClipOriginalAssetKey,
    aiClipProcessingSourceUrl,
    aiClipRecordKey,
    aiClipStatus,
    buildAiClipProcessingQueueJob,
    buildAiClipResponse,
    decideAiClipProcessing,
    filterAiClipsByView,
    generateAiClipId,
    isAiClipLinkValid,
    isAiClipProcessed,
    isAllowedAiClipUpload,
    normalizeAiClipRecord,
    parseAiClipView,
    sanitizeAiClipId,
    sanitizeAiClipLink,
    sanitizeAiClipTitle,
    selectNextAiClipToProcess,
    sortAiClipRecords,
    type AiClipRecord,
} from '../src/ai-clips.js'

function record(overrides: Partial<AiClipRecord> = {}): AiClipRecord {
    const base = normalizeAiClipRecord({
        id: 'ai_abc_def',
        namespaceId: '1774858894802785816',
        title: 'demo',
        createdAt: '2026-06-29T00:00:00.000Z',
        updatedAt: '2026-06-29T00:00:00.000Z',
        processedAt: '',
        contentType: 'video/mp4',
        originalFileName: 'demo.mp4',
        sizeBytes: 1234,
        ...overrides,
    })
    assert.ok(base)
    return base
}

test('parseAiClipView defaults to unprocessed', () => {
    assert.equal(parseAiClipView('processed'), 'processed')
    assert.equal(parseAiClipView('PROCESSED'), 'processed')
    assert.equal(parseAiClipView('unprocessed'), 'unprocessed')
    assert.equal(parseAiClipView(''), 'unprocessed')
    assert.equal(parseAiClipView(undefined), 'unprocessed')
    assert.equal(parseAiClipView('garbage'), 'unprocessed')
})

test('generateAiClipId returns a short 7-digit numeric id', () => {
    const id = generateAiClipId(1_700_000_000_000, 'ABcd12==ef')
    assert.match(id, /^\d{7}$/)
    assert.notEqual(id, generateAiClipId(1_700_000_000_001, 'ABcd12==ef'))
})

test('sanitizeAiClipId strips path traversal and unsafe chars', () => {
    assert.equal(sanitizeAiClipId('../../etc/passwd'), 'etcpasswd')
    assert.equal(sanitizeAiClipId('1234567'), '1234567')
    assert.equal(sanitizeAiClipId('a b/c'), 'abc')
    assert.equal(sanitizeAiClipId(''), '')
})

test('aiClipRecordKey lives under the dedicated namespace prefix (never _inbox/)', () => {
    const ns = '1774858894802785816'
    assert.equal(aiClipNamespacePrefix(ns), `${AI_CLIP_PREFIX}${ns}/`)
    const key = aiClipRecordKey(ns, '1234567')
    assert.equal(key, `${AI_CLIP_PREFIX}${ns}/1234567.json`)
    assert.ok(!key.startsWith('_inbox/'))
    assert.equal(aiClipRecordKey(ns, '../escape'), `${AI_CLIP_PREFIX}${ns}/escape.json`)
    assert.equal(aiClipRecordKey('', '1234567'), '')
    assert.equal(aiClipRecordKey(ns, ''), '')
})

test('aiClipOriginalAssetKey is sanitized and never points at legacy inbox', () => {
    assert.equal(aiClipOriginalAssetKey('1234567'), 'videos/1234567_original.mp4')
    assert.equal(aiClipOriginalAssetKey('../1234567'), 'videos/1234567_original.mp4')
    assert.ok(!aiClipOriginalAssetKey('1234567').startsWith('_inbox/'))
    assert.equal(aiClipOriginalAssetKey(''), '')
})

test('sanitizeAiClipTitle trims, collapses and bounds length', () => {
    assert.equal(sanitizeAiClipTitle('  hello   world  '), 'hello world')
    assert.equal(sanitizeAiClipTitle('x'.repeat(500)).length, 200)
    assert.equal(sanitizeAiClipTitle(undefined), '')
})

test('isAllowedAiClipUpload accepts video extensions + types only', () => {
    assert.equal(isAllowedAiClipUpload('video/mp4', 'a.mp4'), true)
    assert.equal(isAllowedAiClipUpload('video/quicktime', 'a.mov'), true)
    assert.equal(isAllowedAiClipUpload('video/webm', 'a.webm'), true)
    // Empty content-type tolerated when the extension is valid (browsers omit it for some .mov)
    assert.equal(isAllowedAiClipUpload('', 'a.mov'), true)
    // Bad extension always rejected
    assert.equal(isAllowedAiClipUpload('video/mp4', 'a.exe'), false)
    assert.equal(isAllowedAiClipUpload('text/html', 'a.mp4'), false)
    assert.equal(isAllowedAiClipUpload('image/png', 'a.png'), false)
})

test('normalizeAiClipRecord rejects empty id and pins source type', () => {
    assert.equal(normalizeAiClipRecord({ id: '' }), null)
    assert.equal(normalizeAiClipRecord(null), null)
    const r = record()
    assert.equal(r.namespaceId, '1774858894802785816')
    assert.equal(r.sourceType, AI_CLIP_SOURCE_TYPE)
    assert.equal(r.sourceLabel, AI_CLIP_SOURCE_LABEL)
    // Links default to '' when not provided.
    assert.equal(r.shopeeLink, '')
    assert.equal(r.lazadaLink, '')
})

test('sanitizeAiClipLink keeps http(s) urls, trims, and drops anything else', () => {
    assert.equal(sanitizeAiClipLink('  https://shopee.co.th/x  '), 'https://shopee.co.th/x')
    assert.equal(sanitizeAiClipLink('http://lazada.co.th/y'), 'http://lazada.co.th/y')
    assert.equal(sanitizeAiClipLink(''), '')
    assert.equal(sanitizeAiClipLink(undefined), '')
    // Non-http(s) / malformed values are dropped to '' (never stored half-valid).
    assert.equal(sanitizeAiClipLink('shopee.co.th/x'), '')
    assert.equal(sanitizeAiClipLink('javascript:alert(1)'), '')
    assert.equal(sanitizeAiClipLink('ftp://host/file'), '')
    assert.equal(sanitizeAiClipLink('https://'), '')
})

test('isAiClipLinkValid allows empty + http(s), rejects malformed non-empty', () => {
    assert.equal(isAiClipLinkValid(''), true)
    assert.equal(isAiClipLinkValid(undefined), true)
    assert.equal(isAiClipLinkValid('https://shopee.co.th/x'), true)
    assert.equal(isAiClipLinkValid('not-a-url'), false)
    assert.equal(isAiClipLinkValid('javascript:alert(1)'), false)
})

test('normalizeAiClipRecord persists valid links and drops invalid ones', () => {
    const good = record({ shopeeLink: 'https://shopee.co.th/abc', lazadaLink: 'http://lazada.co.th/def' })
    assert.equal(good.shopeeLink, 'https://shopee.co.th/abc')
    assert.equal(good.lazadaLink, 'http://lazada.co.th/def')
    const bad = record({ shopeeLink: 'shopee.co.th/abc', lazadaLink: 'javascript:alert(1)' })
    assert.equal(bad.shopeeLink, '')
    assert.equal(bad.lazadaLink, '')
})

test('processed lifecycle is driven by processedAt presence', () => {
    assert.equal(isAiClipProcessed(record({ processedAt: '' })), false)
    assert.equal(isAiClipProcessed(record({ processedAt: '2026-06-29T01:00:00.000Z' })), true)
    assert.equal(aiClipStatus(record({ processedAt: '' })), 'unprocessed')
    assert.equal(aiClipStatus(record({ processedAt: '2026-06-29T01:00:00.000Z' })), 'processed')
})

test('filterAiClipsByView splits unprocessed vs processed', () => {
    const a = record({ id: 'ai_a', processedAt: '' })
    const b = record({ id: 'ai_b', processedAt: '2026-06-29T01:00:00.000Z' })
    assert.deepEqual(filterAiClipsByView([a, b], 'unprocessed').map((r) => r.id), ['ai_a'])
    assert.deepEqual(filterAiClipsByView([a, b], 'processed').map((r) => r.id), ['ai_b'])
})

test('sortAiClipRecords is newest-first', () => {
    const older = record({ id: 'ai_old', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' })
    const newer = record({ id: 'ai_new', createdAt: '2026-06-28T00:00:00.000Z', updatedAt: '2026-06-28T00:00:00.000Z' })
    assert.deepEqual(sortAiClipRecords([older, newer]).map((r) => r.id), ['ai_new', 'ai_old'])
})


test('buildAiClipResponse falls back to the 7-digit id as the display title', () => {
    const record = normalizeAiClipRecord({
        id: '1234567',
        namespaceId: '1774858894802785816',
        originalFileName: 'long-human-file-name.webm',
        createdAt: '2026-06-29T00:00:00.000Z',
    })
    assert.ok(record)
    const response = buildAiClipResponse(record!, {
        namespaceId: '1774858894802785816',
        workerUrl: 'https://api.pubilo.com',
    })
    assert.equal(response.title, '1234567')
})

test('buildAiClipResponse points playback/thumb at namespace-scoped asset endpoints', () => {
    const resp = buildAiClipResponse(record({ id: 'ai_xyz' }), {
        namespaceId: '1774858894802785816',
        workerUrl: 'https://worker.example.dev',
    })
    assert.equal(resp.sourceType, AI_CLIP_SOURCE_TYPE)
    assert.equal(resp.status, 'unprocessed')
    assert.equal(resp.hasShopeeLink, false)
    assert.equal(resp.hasLazadaLink, false)
    assert.equal(resp.shopeeLink, '')
    assert.equal(resp.shopee_link, '')
    assert.equal(resp.lazadaLink, '')
    assert.equal(resp.lazada_link, '')
    assert.equal(
        resp.originalUrl,
        'https://worker.example.dev/api/gallery/ai_xyz/asset/original?namespace_id=1774858894802785816',
    )
    assert.equal(
        resp.thumbnailUrl,
        'https://worker.example.dev/api/gallery/ai_xyz/asset/original-thumb?namespace_id=1774858894802785816',
    )
    // No worker URL → empty asset URLs rather than a malformed link
    const bare = buildAiClipResponse(record({ id: 'ai_xyz' }), { namespaceId: 'ns', workerUrl: '' })
    assert.equal(bare.originalUrl, '')
})

test('buildAiClipResponse surfaces paired links in both camel + snake case', () => {
    const resp = buildAiClipResponse(
        record({ id: 'ai_lnk', shopeeLink: 'https://shopee.co.th/p', lazadaLink: 'https://lazada.co.th/p' }),
        { namespaceId: '1774858894802785816', workerUrl: 'https://worker.example.dev' },
    )
    assert.equal(resp.shopeeLink, 'https://shopee.co.th/p')
    assert.equal(resp.shopee_link, 'https://shopee.co.th/p')
    assert.equal(resp.lazadaLink, 'https://lazada.co.th/p')
    assert.equal(resp.lazada_link, 'https://lazada.co.th/p')
    assert.equal(resp.hasShopeeLink, true)
    assert.equal(resp.hasLazadaLink, true)
})


test('buildAiClipResponse uses the final public asset for processed playback', () => {
    const resp = buildAiClipResponse(
        record({ id: '1234567', processedAt: '2026-06-29T01:00:00.000Z' }),
        { namespaceId: '1774858894802785816', workerUrl: 'https://worker.example.dev' },
    )
    assert.equal(
        resp.videoUrl,
        'https://worker.example.dev/api/gallery/1234567/asset/public?namespace_id=1774858894802785816',
    )
    assert.equal(resp.previewUrl, resp.videoUrl)
    assert.equal(
        resp.originalUrl,
        'https://worker.example.dev/api/gallery/1234567/asset/original?namespace_id=1774858894802785816',
    )
})

// ── Processing handoff helpers ───────────────────────────────────────────────────────────

test('decideAiClipProcessing queues an unprocessed, not-in-flight clip', () => {
    const d = decideAiClipProcessing(record({ id: '1234567' }), { inFlight: false, requireProductLinks: false })
    assert.equal(d.kind, 'queue')
    assert.equal(d.reason, 'queued')
})

test('decideAiClipProcessing skips an already-processed clip', () => {
    const d = decideAiClipProcessing(
        record({ id: '1234567', processedAt: '2026-06-29T01:00:00.000Z' }),
        { inFlight: false, requireProductLinks: false },
    )
    assert.equal(d.kind, 'skipped_processed')
    assert.equal(d.reason, 'already_processed')
})

test('decideAiClipProcessing skips a clip already queued/processing', () => {
    const d = decideAiClipProcessing(record({ id: '1234567' }), { inFlight: true, requireProductLinks: false })
    assert.equal(d.kind, 'skipped_in_flight')
    assert.equal(d.reason, 'already_queued_or_processing')
})

test('decideAiClipProcessing processed check wins over in-flight', () => {
    const d = decideAiClipProcessing(
        record({ id: '1234567', processedAt: '2026-06-29T01:00:00.000Z' }),
        { inFlight: true, requireProductLinks: false },
    )
    assert.equal(d.kind, 'skipped_processed')
})

test('decideAiClipProcessing blocks missing links only when links are required', () => {
    const noLinks = record({ id: '1234567', shopeeLink: '', lazadaLink: '' })
    // Not required (default) → still queued even without links
    assert.equal(decideAiClipProcessing(noLinks, { inFlight: false, requireProductLinks: false }).kind, 'queue')
    // Required + missing → blocked with explicit reason
    const blocked = decideAiClipProcessing(noLinks, { inFlight: false, requireProductLinks: true })
    assert.equal(blocked.kind, 'blocked_missing_links')
    assert.equal(blocked.reason, 'missing_product_links')
    // Required + only one link → still blocked
    const oneLink = record({ id: '1234567', shopeeLink: 'https://shopee.co.th/p', lazadaLink: '' })
    assert.equal(decideAiClipProcessing(oneLink, { inFlight: false, requireProductLinks: true }).kind, 'blocked_missing_links')
    // Required + both links → queued
    const bothLinks = record({ id: '1234567', shopeeLink: 'https://shopee.co.th/p', lazadaLink: 'https://lazada.co.th/p' })
    assert.equal(decideAiClipProcessing(bothLinks, { inFlight: false, requireProductLinks: true }).kind, 'queue')
})

test('aiClipProcessingSourceUrl points at the internal original asset route', () => {
    const url = aiClipProcessingSourceUrl(record({ id: '1234567' }), {
        workerUrl: 'https://worker.example.dev',
        namespaceId: '1774858894802785816',
    })
    assert.equal(
        url,
        'https://worker.example.dev/api/gallery/1234567/asset/original?namespace_id=1774858894802785816',
    )
    // No worker URL → empty (caller reports missing_original_asset_url instead of queuing)
    assert.equal(aiClipProcessingSourceUrl(record({ id: '1234567' }), { workerUrl: '', namespaceId: 'ns' }), '')
})

test('buildAiClipProcessingQueueJob produces a legacy _queue-compatible job', () => {
    const job = buildAiClipProcessingQueueJob(
        record({ id: '1234567', shopeeLink: 'https://shopee.co.th/p', lazadaLink: 'https://lazada.co.th/p' }),
        { workerUrl: 'https://worker.example.dev', namespaceId: '1774858894802785816', nowIso: '2026-06-29T02:00:00.000Z' },
    )
    assert.ok(job)
    assert.equal(job.id, '1234567')
    assert.equal(job.videoUrl, 'https://worker.example.dev/api/gallery/1234567/asset/original?namespace_id=1774858894802785816')
    assert.equal(job.chatId, 0) // no Telegram completion DM for operator uploads
    assert.equal(job.shopeeLink, 'https://shopee.co.th/p')
    assert.equal(job.lazadaLink, 'https://lazada.co.th/p')
    assert.equal(job.status, 'queued')
    assert.equal(job.createdAt, '2026-06-29T02:00:00.000Z')
    assert.equal(job.sourceType, AI_CLIP_SOURCE_TYPE)
})

// ── One-at-a-time selection (never bulk-enqueue the source library) ──────────────────────

// Build the (knownIds, processedIds, unprocessed) context the route passes selectNextAiClipToProcess.
function selectionCtx(records: AiClipRecord[]) {
    const sorted = sortAiClipRecords(records)
    return {
        unprocessed: sorted.filter((r) => !isAiClipProcessed(r)),
        knownIds: new Set(sorted.map((r) => r.id)),
        processedIds: new Set(sorted.filter((r) => isAiClipProcessed(r)).map((r) => r.id)),
    }
}

test('selectNextAiClipToProcess (omit ids) starts at most ONE clip and leaves the rest as backlog', () => {
    const records = [
        record({ id: '1000001', createdAt: '2026-06-20T00:00:00.000Z', updatedAt: '2026-06-20T00:00:00.000Z' }),
        record({ id: '1000002', createdAt: '2026-06-25T00:00:00.000Z', updatedAt: '2026-06-25T00:00:00.000Z' }),
        record({ id: '1000003', createdAt: '2026-06-28T00:00:00.000Z', updatedAt: '2026-06-28T00:00:00.000Z' }),
    ]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, { requestedIds: [], inFlight: false, knownIds, processedIds })
    // Exactly one selected — the first in UI order (newest-first per sortAiClipRecords).
    assert.equal(sel.reason, 'selected')
    assert.equal(sel.selectedId, '1000003')
    // The other two unprocessed clips stay in the source library, NOT enqueued.
    assert.equal(sel.backlog, 2)
    assert.deepEqual(sel.notFoundIds, [])
    assert.deepEqual(sel.skippedProcessedIds, [])
})

test('selectNextAiClipToProcess defers the whole backlog when a job is already in flight', () => {
    const records = [record({ id: '1000001' }), record({ id: '1000002' }), record({ id: '1000003' })]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, { requestedIds: [], inFlight: true, knownIds, processedIds })
    // Nothing selected — the durable queue is never grown while a job runs.
    assert.equal(sel.selectedId, '')
    assert.equal(sel.reason, 'already_in_flight')
    // All three eligible clips reported as deferred backlog.
    assert.equal(sel.backlog, 3)
})

test('selectNextAiClipToProcess (explicit multiple ids) still starts ONLY the first eligible one', () => {
    const records = [record({ id: '1000001' }), record({ id: '1000002' }), record({ id: '1000003' })]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, {
        requestedIds: ['1000002', '1000003', '1000001'],
        inFlight: false,
        knownIds,
        processedIds,
    })
    // First in request order wins; the remaining two requested ids stay as backlog — no long queue.
    assert.equal(sel.reason, 'selected')
    assert.equal(sel.selectedId, '1000002')
    assert.equal(sel.backlog, 2)
})

test('selectNextAiClipToProcess (explicit ids) defers all when a job is already accepted/in-flight', () => {
    const records = [record({ id: '1000001' }), record({ id: '1000002' }), record({ id: '1000003' })]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, {
        requestedIds: ['1000001', '1000002', '1000003'],
        inFlight: true,
        knownIds,
        processedIds,
    })
    // A second accepted call with three ids must NOT enqueue anything — never a long queue.
    assert.equal(sel.selectedId, '')
    assert.equal(sel.reason, 'already_in_flight')
    assert.equal(sel.backlog, 3)
})

test('selectNextAiClipToProcess surfaces not-found + already-processed explicit ids without dropping them', () => {
    const records = [
        record({ id: '1000001' }),
        record({ id: '1000002', processedAt: '2026-06-29T01:00:00.000Z' }),
    ]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, {
        requestedIds: ['9999999', '1000002', '1000001'],
        inFlight: false,
        knownIds,
        processedIds,
    })
    assert.equal(sel.selectedId, '1000001') // first eligible (known + unprocessed)
    assert.equal(sel.backlog, 0)
    assert.deepEqual(sel.notFoundIds, ['9999999'])
    assert.deepEqual(sel.skippedProcessedIds, ['1000002'])
})

test('selectNextAiClipToProcess reports no eligible clip when nothing is unprocessed', () => {
    const records = [record({ id: '1000001', processedAt: '2026-06-29T01:00:00.000Z' })]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, { requestedIds: [], inFlight: false, knownIds, processedIds })
    assert.equal(sel.selectedId, '')
    assert.equal(sel.reason, 'no_eligible_clip')
    assert.equal(sel.backlog, 0)
})

test('selectNextAiClipToProcess dedups repeated explicit ids before selecting', () => {
    const records = [record({ id: '1000001' }), record({ id: '1000002' })]
    const { unprocessed, knownIds, processedIds } = selectionCtx(records)
    const sel = selectNextAiClipToProcess(unprocessed, {
        requestedIds: ['1000001', '1000001', '1000002'],
        inFlight: false,
        knownIds,
        processedIds,
    })
    assert.equal(sel.selectedId, '1000001')
    // De-duped: only one remaining distinct eligible id stays as backlog.
    assert.equal(sel.backlog, 1)
})

test('buildAiClipProcessingQueueJob preserves an absent link as empty + returns null without a source url', () => {
    const job = buildAiClipProcessingQueueJob(record({ id: '1234567', shopeeLink: '', lazadaLink: '' }), {
        workerUrl: 'https://worker.example.dev',
        namespaceId: '1774858894802785816',
        nowIso: '2026-06-29T02:00:00.000Z',
    })
    assert.ok(job)
    assert.equal(job.shopeeLink, '')
    assert.equal(job.lazadaLink, '')
    // Unbuildable source url (no worker URL) → null so the route never queues a doomed job
    assert.equal(
        buildAiClipProcessingQueueJob(record({ id: '1234567' }), { workerUrl: '', namespaceId: 'ns', nowIso: 'x' }),
        null,
    )
})
