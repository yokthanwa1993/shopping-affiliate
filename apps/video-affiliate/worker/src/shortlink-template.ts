export const MAX_SHORTLINK_URL_TEMPLATE_CHARS = 2048
export const MAX_SHORTLINK_SUB_ID_CHARS = 128

// Numeric customlink id for the admin CHEARB affiliate account. short.wwoom.com
// now routes through the Cloak shortlink bridge, which rejects the legacy
// account=CHEARB form (manual_login_required) but resolves a real shortLink for
// the id= form. See apps/affiliate-shortlink-cloak.
export const DEFAULT_SHOPEE_CUSTOMLINK_ID = '15130770000'

// Default Shopee shortlink request template used when a page/namespace has not
// configured its own. Routes through the Cloak bridge using id=15130770000
// instead of account=CHEARB so the bridge can mint a real shortLink.
export const DEFAULT_SHOPEE_SHORTLINK_URL_TEMPLATE =
    `https://short.wwoom.com/?id=${DEFAULT_SHOPEE_CUSTOMLINK_ID}&url={url}&sub1={sub_id}`

// Known affiliate-account → numeric customlink id mapping. The Cloak bridge only
// resolves the id= form, so map the known admin account to its id. Accounts
// without a known id keep the legacy account= form.
export const SHORTLINK_ACCOUNT_TO_CUSTOMLINK_ID: Record<string, string> = {
    CHEARB: DEFAULT_SHOPEE_CUSTOMLINK_ID,
}

// Build a Shopee shortlink request base URL (no {placeholders}) for an account.
// Accounts with a known customlink id resolve to the id= form so the Cloak bridge
// accepts them; unmapped accounts fall back to the legacy account= form.
export function buildShopeeShortlinkBaseUrl(baseHostUrl: string, account: string): string {
    const normalized = String(account || '').trim().toUpperCase()
    if (!normalized) return ''
    const url = new URL(baseHostUrl)
    const customlinkId = SHORTLINK_ACCOUNT_TO_CUSTOMLINK_ID[normalized]
    if (customlinkId) {
        url.searchParams.set('id', customlinkId)
    } else {
        url.searchParams.set('account', normalized)
    }
    return url.toString()
}

export function normalizeShortlinkUrlTemplate(rawValue: string): string {
    return String(rawValue || '').trim().slice(0, MAX_SHORTLINK_URL_TEMPLATE_CHARS)
}

export function normalizeShortlinkSubId(rawValue: string): string {
    return String(rawValue || '').trim().replace(/[\r\n\t]+/g, '').slice(0, MAX_SHORTLINK_SUB_ID_CHARS)
}

export interface ShortlinkTemplateSubIds {
    sub1: string
    sub2: string
    sub3: string
    sub4: string
    sub5: string
}

export function buildShortlinkRequestUrlFromTemplate(
    template: string,
    productUrl: string,
    subIds: ShortlinkTemplateSubIds,
    account?: string,
): string {
    return template
        .replace(/\{account\}/g, encodeURIComponent(account || ''))
        .replace(/\{url\}/g, encodeURIComponent(productUrl))
        .replace(/\{sub_id\}/g, encodeURIComponent(subIds.sub1))
        .replace(/\{sub_id2\}/g, encodeURIComponent(subIds.sub2))
        .replace(/\{sub_id3\}/g, encodeURIComponent(subIds.sub3))
        .replace(/\{sub_id4\}/g, encodeURIComponent(subIds.sub4))
        .replace(/\{sub_id5\}/g, encodeURIComponent(subIds.sub5))
}

// Posting-time Sub ID overrides attached to a freshly published post/reel/ad.
// sub2 = the Facebook post id, sub3 = the Facebook page id, sub4 = reserved
// (kept empty for the current outbound-tracking policy).
export type PostingCommentShortlinkSubIds = {
    postSubId2: string
    postSubId3: string
    postSubId4: string
}

// Facebook story/post ids arrive as either a bare post id or `pageId_postId`.
// Sub ID 2 must be the POST id tail, never the page id, so split on `_` and keep
// the tail. A bare value (no `_`) is already the post id.
export function normalizeFacebookPostSubIdForShortlink(value: string | null | undefined): string {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const tail = raw.includes('_') ? raw.split('_').pop() || '' : raw
    return normalizeShortlinkSubId(tail)
}

// Derive the posting-time comment Sub IDs for a freshly published Facebook post:
//   sub2 = post id tail (from story_id `pageId_postId` → `postId`)
//   sub3 = the page id that owns the post
//   sub4 = '' (post_history/log ids stay internal under the current policy)
export function buildPostingCommentShortlinkSubIds(input: {
    canonicalPostId?: string | null
    fbVideoId?: string | null
    reelId?: string | null
    pageId?: string | null
    historyId?: number | string | null
    logPrefix: string
}): PostingCommentShortlinkSubIds {
    const postSubId2 = normalizeFacebookPostSubIdForShortlink(input.canonicalPostId)
    if (!postSubId2) {
        console.log(`[${input.logPrefix}] Shopee comment shortlink sub2 missing: missing_page_story_object_id`)
    }

    const postSubId3 = normalizeShortlinkSubId(input.pageId || '')
    // New outbound tracking policy: keep post_history/log ids internal only.
    // Do not send them as Shopee/customlink sub4 for newly posted comments.
    const postSubId4 = ''

    return { postSubId2, postSubId3, postSubId4 }
}
