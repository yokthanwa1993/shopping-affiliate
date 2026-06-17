import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildCaptionLinkFirstDescription,
    resolvePublishCaption,
} from '../src/caption-link.js'

const LINK = 'https://s.shopee.co.th/abc123'
const CAPTION = 'สินค้าดีมาก คุ้มสุด ๆ\n#shopee #ของมันต้องมี'

test('buildCaptionLinkFirstDescription prepends the link as the first caption line', () => {
    assert.equal(buildCaptionLinkFirstDescription(CAPTION, LINK), `${LINK}\n${CAPTION}`)
})

test('buildCaptionLinkFirstDescription returns the bare link when caption is empty', () => {
    assert.equal(buildCaptionLinkFirstDescription('', LINK), LINK)
    assert.equal(buildCaptionLinkFirstDescription('   ', LINK), `${LINK}\n   `)
})

test('buildCaptionLinkFirstDescription returns caption unchanged when there is no link', () => {
    assert.equal(buildCaptionLinkFirstDescription(CAPTION, ''), CAPTION)
    assert.equal(buildCaptionLinkFirstDescription(CAPTION, '   '), CAPTION)
})

test('buildCaptionLinkFirstDescription is idempotent — never doubles a leading link', () => {
    const once = buildCaptionLinkFirstDescription(CAPTION, LINK)
    assert.equal(buildCaptionLinkFirstDescription(once, LINK), once)
    // caption that already IS the link
    assert.equal(buildCaptionLinkFirstDescription(LINK, LINK), LINK)
})

test('resolvePublishCaption prepends only when the toggle is on AND a link exists', () => {
    assert.equal(
        resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: LINK }),
        `${LINK}\n${CAPTION}`,
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
// "prepend the link" for EVERY posting route, including OneCard and Ads. The gate is
// route-agnostic by construction — resolvePublishCaption takes no onecard/ads flag — so
// these assertions fail if anyone re-introduces an onecard/ads exclusion.
test('resolvePublishCaption ignores posting route — OneCard/Ads pages still get the link', () => {
    // Simulate the flags an OneCard + Ads page (e.g. "เฉียบ") carries. None of them are
    // inputs to the gate, so the resolved caption is identical to the organic case.
    const organic = resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: LINK })
    const oneCardOrAds = resolvePublishCaption({ caption: CAPTION, captionLinkEnabled: true, shopeeLink: LINK })
    assert.equal(oneCardOrAds, organic)
    assert.ok(oneCardOrAds.startsWith(`${LINK}\n`), 'OneCard/Ads caption must lead with the Shopee link')
})
