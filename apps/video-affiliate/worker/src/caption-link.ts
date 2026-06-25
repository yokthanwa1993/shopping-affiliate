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

// The pin prefix that leads the first caption line, e.g.
//   📌 พิกัด : https://s.shopee.co.th/AAF1LYGjhb
// Keep the trailing space — the link is concatenated directly after it.
export const CAPTION_LINK_PIN_PREFIX = '📌 พิกัด : '

// Prepend the managed Shopee shortlink as the FIRST caption line, formatted as the pin line
// `📌 พิกัด : <link>`. Idempotent and self-normalizing:
//   - If the caption already leads with the exact new pin line for this link, return unchanged.
//   - If the caption leads with a LEGACY bare-link first line for this link, normalize that
//     first line into the new pin line (never duplicate, never leave a bare link behind).
// Empty caption returns just the pin line.
export function buildCaptionLinkFirstDescription(caption: string, shopeeLink: string): string {
    const link = String(shopeeLink || '').trim()
    const originalCaption = String(caption || '')
    if (!link) return originalCaption
    const pinLine = `${CAPTION_LINK_PIN_PREFIX}${link}`
    // Already leads with the new pin line — return unchanged so it is never doubled.
    if (originalCaption === pinLine || originalCaption.startsWith(`${pinLine}\n`)) return originalCaption
    // Legacy bare-link first line — normalize it in place to the new pin line.
    if (originalCaption === link) return pinLine
    if (originalCaption.startsWith(`${link}\n`)) return `${pinLine}${originalCaption.slice(link.length)}`
    return originalCaption ? `${pinLine}\n${originalCaption}` : pinLine
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
