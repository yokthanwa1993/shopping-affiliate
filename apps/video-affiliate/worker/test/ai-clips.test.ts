import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AI_CLIP_PREFIX,
    AI_CLIP_SOURCE_LABEL,
    AI_CLIP_SOURCE_TYPE,
    aiClipNamespacePrefix,
    aiClipOriginalAssetKey,
    aiClipRecordKey,
    aiClipStatus,
    buildAiClipResponse,
    filterAiClipsByView,
    generateAiClipId,
    isAiClipProcessed,
    isAllowedAiClipUpload,
    normalizeAiClipRecord,
    parseAiClipView,
    sanitizeAiClipId,
    sanitizeAiClipTitle,
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

test('generateAiClipId is time-sortable and prefixed', () => {
    const id = generateAiClipId(1_700_000_000_000, 'ABcd12==ef')
    assert.match(id, /^ai_[a-z0-9]+_[a-z0-9]+$/)
    assert.ok(id.startsWith('ai_'))
})

test('sanitizeAiClipId strips path traversal and unsafe chars', () => {
    assert.equal(sanitizeAiClipId('../../etc/passwd'), 'etcpasswd')
    assert.equal(sanitizeAiClipId('ai_123_abc'), 'ai_123_abc')
    assert.equal(sanitizeAiClipId('a b/c'), 'abc')
    assert.equal(sanitizeAiClipId(''), '')
})

test('aiClipRecordKey lives under the dedicated namespace prefix (never _inbox/)', () => {
    const ns = '1774858894802785816'
    assert.equal(aiClipNamespacePrefix(ns), `${AI_CLIP_PREFIX}${ns}/`)
    const key = aiClipRecordKey(ns, 'ai_123_abc')
    assert.equal(key, `${AI_CLIP_PREFIX}${ns}/ai_123_abc.json`)
    assert.ok(!key.startsWith('_inbox/'))
    assert.equal(aiClipRecordKey(ns, '../escape'), `${AI_CLIP_PREFIX}${ns}/escape.json`)
    assert.equal(aiClipRecordKey('', 'ai_123_abc'), '')
    assert.equal(aiClipRecordKey(ns, ''), '')
})

test('aiClipOriginalAssetKey is sanitized and never points at legacy inbox', () => {
    assert.equal(aiClipOriginalAssetKey('ai_123_abc'), 'videos/ai_123_abc_original.mp4')
    assert.equal(aiClipOriginalAssetKey('../ai_123'), 'videos/ai_123_original.mp4')
    assert.ok(!aiClipOriginalAssetKey('ai_123_abc').startsWith('_inbox/'))
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

test('buildAiClipResponse points playback/thumb at namespace-scoped asset endpoints', () => {
    const resp = buildAiClipResponse(record({ id: 'ai_xyz' }), {
        namespaceId: '1774858894802785816',
        workerUrl: 'https://worker.example.dev',
    })
    assert.equal(resp.sourceType, AI_CLIP_SOURCE_TYPE)
    assert.equal(resp.status, 'unprocessed')
    assert.equal(resp.hasShopeeLink, false)
    assert.equal(resp.hasLazadaLink, false)
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
