// Caption-link helpers — the per-page "ใส่ลิงก์ในแคปชั่น" (caption_link_enabled) toggle.
//
// When a page enables this toggle, the managed Shopee shortlink is prepended as the FIRST
// line of the published FB post caption. This MUST apply to every posting route — organic
// Reel, OneCard publish, the CloakBrowser session bridge, AND the OneCard/Ads create-ad path
// — not just the plain organic post. Keeping the gate in one place (resolvePublishCaption)
// stops a future edit from silently excluding OneCard/Ads again. The companion test asserts
// that invariant.
//
// This only affects the POST caption. Comment text, the CTA button link, shortlink reminting
// and token-source routing are all computed elsewhere and are intentionally untouched here.

// Prepend `shopeeLink` as the first caption line. Idempotent: if the caption already leads
// with the exact same link (a caller that already prepended it, or a re-run), it is returned
// unchanged so the link is never doubled.
export function buildCaptionLinkFirstDescription(caption: string, shopeeLink: string): string {
    const link = String(shopeeLink || '').trim()
    const originalCaption = String(caption || '')
    if (!link) return originalCaption
    if (originalCaption === link || originalCaption.startsWith(`${link}\n`)) return originalCaption
    return originalCaption ? `${link}\n${originalCaption}` : link
}

// Resolve the caption to publish for a page. The gate is deliberately route-agnostic:
// prepend whenever the page has the toggle on AND a managed link exists. It does NOT inspect
// onecard/ads flags — those routes honor the toggle too.
export function resolvePublishCaption(params: {
    caption: string
    captionLinkEnabled: boolean
    shopeeLink: string
}): string {
    const link = String(params.shopeeLink || '').trim()
    return params.captionLinkEnabled && link
        ? buildCaptionLinkFirstDescription(params.caption, link)
        : String(params.caption || '')
}
