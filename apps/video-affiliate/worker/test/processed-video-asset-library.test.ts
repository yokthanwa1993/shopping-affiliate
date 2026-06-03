import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PROCESSED_VIDEO_ASSET_LIBRARY_TABLE_SQL,
    buildProcessedVideoAssetFileUrl,
    normalizeMetaVideoStatus,
    parseProcessedVideoR2Key,
    sanitizeMetaGraphError,
} from '../src/processed-video-asset-library.js'

test('parseProcessedVideoR2Key accepts only final processed gallery json or mp4 keys', () => {
    assert.equal(parseProcessedVideoR2Key('videos/abc123.json'), 'abc123')
    assert.equal(parseProcessedVideoR2Key('videos/abc123.mp4'), 'abc123')
    assert.equal(parseProcessedVideoR2Key(' videos/abc123.mp4 '), 'abc123')
})

test('parseProcessedVideoR2Key rejects original assets, thumbnails, nested keys, and empty ids', () => {
    assert.equal(parseProcessedVideoR2Key('videos/abc123_original.mp4'), null)
    assert.equal(parseProcessedVideoR2Key('videos/abc123_line_original.mp4'), null)
    assert.equal(parseProcessedVideoR2Key('videos/abc123_thumb.webp'), null)
    assert.equal(parseProcessedVideoR2Key('videos/abc123_thumb.mp4'), null)
    assert.equal(parseProcessedVideoR2Key('videos/abc123_thumbnail.mp4'), null)
    assert.equal(parseProcessedVideoR2Key('videos/nested/abc123.mp4'), null)
    assert.equal(parseProcessedVideoR2Key('thumbs/abc123.mp4'), null)
    assert.equal(parseProcessedVideoR2Key('videos/.mp4'), null)
    assert.equal(parseProcessedVideoR2Key(''), null)
})

test('buildProcessedVideoAssetFileUrl uses the Worker public gallery asset route', () => {
    assert.equal(
        buildProcessedVideoAssetFileUrl('https://api.pubilo.com/', '1774858894802785816', '2695c305'),
        'https://api.pubilo.com/api/gallery/2695c305/asset/public?namespace_id=1774858894802785816',
    )
    assert.equal(
        buildProcessedVideoAssetFileUrl('https://worker.test', 'space id', 'video/id'),
        'https://worker.test/api/gallery/video%2Fid/asset/public?namespace_id=space%20id',
    )
})

test('normalizeMetaVideoStatus prefers Graph video_status and falls back to phase statuses', () => {
    assert.equal(normalizeMetaVideoStatus({ status: { video_status: 'ready', processing_phase: { status: 'complete' } } }), 'ready')
    assert.equal(normalizeMetaVideoStatus({ status: { processing_phase: { status: 'processing' } } }), 'processing')
    assert.equal(normalizeMetaVideoStatus({ status: { processing: { status: 'processing' } } }), 'processing')
    assert.equal(normalizeMetaVideoStatus({ status: { uploading_phase: { status: 'uploading' } } }), 'uploading')
    assert.equal(normalizeMetaVideoStatus({ status: 'ready' }), 'ready')
    assert.equal(normalizeMetaVideoStatus({ video_status: 'error' }), 'error')
    assert.equal(normalizeMetaVideoStatus({}), '')
})

test('processed video asset library SQL defines the requested key and non-secret columns', () => {
    assert.match(PROCESSED_VIDEO_ASSET_LIBRARY_TABLE_SQL, /processed_video_asset_library/)
    assert.match(PROCESSED_VIDEO_ASSET_LIBRARY_TABLE_SQL, /PRIMARY KEY \(namespace_id, system_video_id, ad_account\)/)
    assert.match(PROCESSED_VIDEO_ASSET_LIBRARY_TABLE_SQL, /advideo_id TEXT/)
    assert.doesNotMatch(PROCESSED_VIDEO_ASSET_LIBRARY_TABLE_SQL, /token|secret|cookie/i)
})

test('sanitizeMetaGraphError redacts access tokens from error strings', () => {
    assert.equal(
        sanitizeMetaGraphError('failed access_token=EAabcdefabcdefabcdefabcdef123456 and more'),
        'failed access_token=[REDACTED] and more',
    )
})
