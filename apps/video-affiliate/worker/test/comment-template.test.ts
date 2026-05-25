import assert from 'node:assert/strict'
import test from 'node:test'
import {
    COMMENT_TEMPLATE_LAZADA_PLACEHOLDER,
    COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER,
    COMMENT_TEMPLATE_SLOT_COUNT,
    DEFAULT_COMMENT_TEMPLATE_TEXT,
    encodeCommentTemplatesForStorage,
    mergeLegacyCommentTemplate,
    normalizeCommentTemplateSlots,
    normalizeCommentTemplateText,
    parseStoredCommentTemplatesValue,
    renderAffiliateCommentTemplate,
    renderCommentTemplatesForPosting,
    selectNonEmptyCommentTemplates,
    validateCommentTemplateSlots,
} from '../src/comment-template.js'

test('slot count is fixed to 3', () => {
    assert.equal(COMMENT_TEMPLATE_SLOT_COUNT, 3)
})

test('normalizeCommentTemplateText trims whitespace and normalizes line endings', () => {
    assert.equal(normalizeCommentTemplateText('  hello\r\nworld\r '), 'hello\nworld')
    assert.equal(normalizeCommentTemplateText(null), '')
    assert.equal(normalizeCommentTemplateText(undefined), '')
})

test('normalizeCommentTemplateSlots pads arrays to slot count and truncates extras', () => {
    assert.deepEqual(normalizeCommentTemplateSlots(['a']), ['a', '', ''])
    assert.deepEqual(normalizeCommentTemplateSlots(['a', 'b', 'c', 'd']), ['a', 'b', 'c'])
    assert.deepEqual(normalizeCommentTemplateSlots(null), ['', '', ''])
})

test('normalizeCommentTemplateSlots accepts a single string as slot 0 legacy fallback', () => {
    assert.deepEqual(normalizeCommentTemplateSlots('legacy single'), ['legacy single', '', ''])
})

test('parseStoredCommentTemplatesValue decodes a JSON array and falls back to legacy string', () => {
    assert.deepEqual(
        parseStoredCommentTemplatesValue(JSON.stringify(['one', 'two', 'three'])),
        ['one', 'two', 'three'],
    )
    assert.deepEqual(parseStoredCommentTemplatesValue('just a legacy template'), ['just a legacy template', '', ''])
    assert.deepEqual(parseStoredCommentTemplatesValue(''), ['', '', ''])
    assert.deepEqual(parseStoredCommentTemplatesValue(null), ['', '', ''])
})

test('mergeLegacyCommentTemplate only fills slot 0 when all new slots are empty', () => {
    assert.deepEqual(mergeLegacyCommentTemplate(['', '', ''], 'legacy'), ['legacy', '', ''])
    assert.deepEqual(mergeLegacyCommentTemplate(['custom', '', ''], 'legacy'), ['custom', '', ''])
    assert.deepEqual(mergeLegacyCommentTemplate(['', '', ''], ''), ['', '', ''])
})

test('encodeCommentTemplatesForStorage roundtrips through parseStoredCommentTemplatesValue', () => {
    const slots = ['คอมเมนต์ 1 {{shopee_link}}', 'คอมเมนต์ 2', '']
    const encoded = encodeCommentTemplatesForStorage(slots)
    assert.equal(typeof encoded, 'string')
    assert.deepEqual(parseStoredCommentTemplatesValue(encoded), slots)
})

test('selectNonEmptyCommentTemplates drops empty/whitespace-only slots', () => {
    assert.deepEqual(
        selectNonEmptyCommentTemplates(['one', '   ', 'three']),
        ['one', 'three'],
    )
})

test('renderAffiliateCommentTemplate substitutes shopee + lazada placeholders', () => {
    const rendered = renderAffiliateCommentTemplate(
        `Shopee: ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}\nLazada: ${COMMENT_TEMPLATE_LAZADA_PLACEHOLDER}`,
        'https://s.shopee.co.th/abc',
        'https://lazada.test/xyz',
    )
    assert.match(rendered, /https:\/\/s\.shopee\.co\.th\/abc/)
    assert.match(rendered, /https:\/\/lazada\.test\/xyz/)
})

test('renderAffiliateCommentTemplate drops lines mentioning Lazada when link is empty', () => {
    const rendered = renderAffiliateCommentTemplate(
        `Shopee: ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}\nLazada: ${COMMENT_TEMPLATE_LAZADA_PLACEHOLDER}`,
        'https://s.shopee.co.th/abc',
        '',
    )
    assert.ok(!/Lazada:/i.test(rendered), 'expected Lazada line to be stripped')
    assert.match(rendered, /https:\/\/s\.shopee\.co\.th\/abc/)
})

test('renderCommentTemplatesForPosting returns one rendered message per non-empty slot', () => {
    const messages = renderCommentTemplatesForPosting({
        slots: [
            `Slot1 ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`,
            '',
            `Slot3 ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`,
        ],
        shopeeLink: 'https://shopee.test/A',
        lazadaLink: '',
    })
    assert.equal(messages.length, 2)
    assert.match(messages[0], /^Slot1 https:\/\/shopee\.test\/A/)
    assert.match(messages[1], /^Slot3 https:\/\/shopee\.test\/A/)
})

test('renderCommentTemplatesForPosting falls back to the default template when all slots empty', () => {
    const messages = renderCommentTemplatesForPosting({
        slots: ['', '', ''],
        shopeeLink: 'https://shopee.test/B',
        lazadaLink: 'https://lazada.test/B',
    })
    assert.equal(messages.length, 1)
    assert.match(messages[0], /https:\/\/shopee\.test\/B/)
})

test('renderCommentTemplatesForPosting uses provided fallback when supplied', () => {
    const messages = renderCommentTemplatesForPosting({
        slots: [],
        shopeeLink: 'https://shopee.test/C',
        fallbackTemplate: `custom-fallback ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`,
    })
    assert.equal(messages.length, 1)
    assert.equal(messages[0], 'custom-fallback https://shopee.test/C')
})

test('validateCommentTemplateSlots rejects slots that exceed the char limit', () => {
    const result = validateCommentTemplateSlots({
        slots: ['x'.repeat(11), '', ''],
        maxChars: 10,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
        assert.equal(result.error.code, 'too_long')
        assert.equal(result.error.slot, 1)
    }
})

test('validateCommentTemplateSlots rejects non-empty slots missing the shopee placeholder', () => {
    const result = validateCommentTemplateSlots({
        slots: [`ok ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`, 'no placeholder here', ''],
        maxChars: 1000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
        assert.equal(result.error.code, 'missing_shopee_placeholder')
        assert.equal(result.error.slot, 2)
    }
})

test('validateCommentTemplateSlots accepts empty slots and normalizes the result', () => {
    const result = validateCommentTemplateSlots({
        slots: [`Buy: ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`, '', ''],
        maxChars: 1000,
    })
    assert.equal(result.ok, true)
    if (result.ok) {
        assert.deepEqual(result.slots, [`Buy: ${COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}`, '', ''])
    }
})

test('DEFAULT_COMMENT_TEMPLATE_TEXT contains both placeholders', () => {
    assert.ok(DEFAULT_COMMENT_TEMPLATE_TEXT.includes(COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER))
    assert.ok(DEFAULT_COMMENT_TEMPLATE_TEXT.includes(COMMENT_TEMPLATE_LAZADA_PLACEHOLDER))
})
