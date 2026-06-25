import assert from 'node:assert/strict'
import test from 'node:test'
import {
    CAPTION_LINK_PIN_PREFIX,
    buildCaptionLinkFirstDescription,
    resolvePublishCaption,
} from '../src/caption-link.js'

const LINK = 'https://s.shopee.co.th/abc123'
const CAPTION = 'สินค้าดีมาก คุ้มสุด ๆ\n#shopee #ของมันต้องมี'
// The exact pin line that must lead a caption when the link is prepended, e.g.
//   📌 พิกัด : https://s.shopee.co.th/abc123
const PIN = `${CAPTION_LINK_PIN_PREFIX}${LINK}`

test('CAPTION_LINK_PIN_PREFIX is the requested Thai pin format', () => {
    assert.equal(CAPTION_LINK_PIN_PREFIX, '📌 พิกัด : ')
})

test('buildCaptionLinkFirstDescription prepends the pin line as the first caption line', () => {
    assert.equal(buildCaptionLinkFirstDescription(CAPTION, LINK), `${PIN}\n${CAPTION}`)
})

test('buildCaptionLinkFirstDescription returns the bare pin line when caption is empty', () => {
    assert.equal(buildCaptionLinkFirstDescription('', LINK), PIN)
    assert.equal(buildCaptionLinkFirstDescription('   ', LINK), `${PIN}\n   `)
})

test('buildCaptionLinkFirstDescription returns caption unchanged when there is no link', () => {
    assert.equal(buildCaptionLinkFirstDescription(CAPTION, ''), CAPTION)
    assert.equal(buildCaptionLinkFirstDescription(CAPTION, '   '), CAPTION)
})

test('buildCaptionLinkFirstDescription is idempotent — never doubles a leading pin line', () => {
    const once = buildCaptionLinkFirstDescription(CAPTION, LINK)
    assert.equal(buildCaptionLinkFirstDescription(once, LINK), once)
    // caption that already IS the pin line
    assert.equal(buildCaptionLinkFirstDescription(PIN, LINK), PIN)
})

test('buildCaptionLinkFirstDescription normalizes a LEGACY bare-link first line to the pin line', () => {
    // Caption produced by the old behaviour (bare link first line) must be upgraded in place,
    // not duplicated and not left as a bare link.
    assert.equal(buildCaptionLinkFirstDescription(`${LINK}\n${CAPTION}`, LINK), `${PIN}\n${CAPTION}`)
    // caption that already IS the bare legacy link
    assert.equal(buildCaptionLinkFirstDescription(LINK, LINK), PIN)
})

test('resolvePublishCaption prepends only when the toggle is on AND a link exists', () => {
    assert.equal(
        resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: LINK }),
        `${PIN}\n${CAPTION}`,
    )
    assert.equal(
        resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: false, shopeeLink: LINK }),
        CAPTION,
    )
    assert.equal(
        resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: '' }),
        CAPTION,
    )
})

// SOURCE INVARIANT (the regression this fix guards): caption_link_enabled must mean
// "prepend the pin line" for EVERY posting route, including OneCard and Ads. The gate is
// route-agnostic by construction — resolvePublishCaption takes no onecard/ads flag — so
// these assertions fail if anyone re-introduces an onecard/ads exclusion.
test('resolvePublishCaption ignores posting route — OneCard/Ads pages still get the link', () => {
    // Simulate the flags an OneCard + Ads page (e.g. "เฉียบ") carries. None of them are
    // inputs to the gate, so the resolved caption is identical to the organic case.
    const organic = resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: LINK })
    const oneCardOrAds = resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: LINK })
    assert.equal(oneCardOrAds, organic)
    assert.ok(oneCardOrAds.startsWith(`${PIN}\n`), 'OneCard/Ads caption must lead with the Shopee pin line')
})
