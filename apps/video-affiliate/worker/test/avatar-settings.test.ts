import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AVATAR_CHROMAKEY_BLEND_DEFAULT,
    AVATAR_CHROMAKEY_SIMILARITY_DEFAULT,
    buildPageAvatarVideoKey,
    clampChromakeyBlend,
    clampChromakeySimilarity,
    sanitizeAvatarVersion,
    serializePageAvatarSettings,
} from '../src/avatar-settings.js'

test('buildPageAvatarVideoKey is deterministic for valid segments', () => {
    assert.equal(
        buildPageAvatarVideoKey('114142457961643', '1748500000000'),
        'page-assets/114142457961643/avatar/1748500000000.mp4',
    )
})

test('buildPageAvatarVideoKey strips path-traversal and slashes', () => {
    assert.equal(buildPageAvatarVideoKey('../../etc', '1748500000000'), 'page-assets/etc/avatar/1748500000000.mp4')
    assert.equal(buildPageAvatarVideoKey('114', 'a/b/../c'), 'page-assets/114/avatar/abc.mp4')
})

test('buildPageAvatarVideoKey returns empty when a segment is invalid', () => {
    assert.equal(buildPageAvatarVideoKey('', '123'), '')
    assert.equal(buildPageAvatarVideoKey('114', ''), '')
    assert.equal(buildPageAvatarVideoKey('114', '....'), '')
})

test('sanitizeAvatarVersion keeps safe chars and caps length', () => {
    assert.equal(sanitizeAvatarVersion('v_2026-05-29'), 'v_2026-05-29')
    assert.equal(sanitizeAvatarVersion('x'.repeat(100)).length, 40)
    assert.equal(sanitizeAvatarVersion('  ../bad.mp4  '), 'badmp4')
})

test('clampChromakeySimilarity is product-locked for crisp avatar output', () => {
    assert.equal(AVATAR_CHROMAKEY_SIMILARITY_DEFAULT, 0.14)
    assert.equal(clampChromakeySimilarity(0.5), AVATAR_CHROMAKEY_SIMILARITY_DEFAULT)
    assert.equal(clampChromakeySimilarity(5), AVATAR_CHROMAKEY_SIMILARITY_DEFAULT)
    assert.equal(clampChromakeySimilarity(-1), AVATAR_CHROMAKEY_SIMILARITY_DEFAULT)
    assert.equal(clampChromakeySimilarity('nope'), AVATAR_CHROMAKEY_SIMILARITY_DEFAULT)
})

test('clampChromakeyBlend is product-locked for crisp avatar output', () => {
    assert.equal(AVATAR_CHROMAKEY_BLEND_DEFAULT, 0.02)
    assert.equal(clampChromakeyBlend(0.25), AVATAR_CHROMAKEY_BLEND_DEFAULT)
    assert.equal(clampChromakeyBlend(9), AVATAR_CHROMAKEY_BLEND_DEFAULT)
    assert.equal(clampChromakeyBlend(-3), AVATAR_CHROMAKEY_BLEND_DEFAULT)
    assert.equal(clampChromakeyBlend(undefined), AVATAR_CHROMAKEY_BLEND_DEFAULT)
})

test('serializePageAvatarSettings hides keys and reports enabled only with a video', () => {
    const view = serializePageAvatarSettings({
        enabled: true,
        videoKey: 'page-assets/114/avatar/1.mp4',
        version: '1',
        chromakeySimilarity: AVATAR_CHROMAKEY_SIMILARITY_DEFAULT,
        chromakeyBlend: AVATAR_CHROMAKEY_BLEND_DEFAULT,
        updatedAt: '2026-05-29T00:00:00.000Z',
    })
    assert.equal(view.enabled, true)
    assert.equal(view.has_video, true)
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'videoKey'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'video_key'), false)

    const disabled = serializePageAvatarSettings({
        enabled: true,
        videoKey: '',
        version: '',
        chromakeySimilarity: AVATAR_CHROMAKEY_SIMILARITY_DEFAULT,
        chromakeyBlend: AVATAR_CHROMAKEY_BLEND_DEFAULT,
        updatedAt: '',
    })
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.has_video, false)
})
