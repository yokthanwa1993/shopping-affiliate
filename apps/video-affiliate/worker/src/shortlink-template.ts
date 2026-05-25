export const MAX_SHORTLINK_URL_TEMPLATE_CHARS = 2048
export const MAX_SHORTLINK_SUB_ID_CHARS = 128

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
