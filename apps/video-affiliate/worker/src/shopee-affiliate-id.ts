export const MAX_SHORTLINK_EXPECTED_UTM_ID_CHARS = 32

export function normalizeShortlinkExpectedUtmId(rawValue: string | null | undefined): string {
    const value = String(rawValue || '').trim().replace(/^an_/i, '')
    if (!value) return ''
    if (!/^\d+$/.test(value)) return ''
    return value.slice(0, MAX_SHORTLINK_EXPECTED_UTM_ID_CHARS)
}

export function extractShopeeUtmSourceFromLink(link: string | null | undefined): string {
    try {
        return String(new URL(String(link || '').trim()).searchParams.get('utm_source') || '').trim()
    } catch {
        return ''
    }
}

// Shopee shortlinks redirect to product URLs whose affiliate id may live in
// `utm_source=an_<id>` (legacy) or `mmp_pid=an_<id>` (newer affiliate bridge
// output). Treat both as equivalent so the namespace's expected affiliate id
// matches either form. Returns the normalized numeric id (no `an_` prefix), or
// '' if neither parameter contains a valid id. Both lookups go through the
// same fail-closed normalizer, so unrelated or malformed values still return ''.
export function extractShopeeAffiliateIdFromLink(link: string | null | undefined): string {
    const raw = String(link || '').trim()
    if (!raw) return ''
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return ''
    }
    const utm = normalizeShortlinkExpectedUtmId(url.searchParams.get('utm_source'))
    if (utm) return utm
    const mmp = normalizeShortlinkExpectedUtmId(url.searchParams.get('mmp_pid'))
    if (mmp) return mmp
    return ''
}
