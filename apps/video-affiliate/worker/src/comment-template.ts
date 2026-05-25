// Pure helpers for the per-namespace Facebook comment templates (Settings → Comment Template).
//
// The settings UI exposes 3 ordered slots ("คอมเมนต์ 1/2/3"). When the system posts to
// Facebook it walks the slots in order and creates one comment per non-empty rendered
// slot, skipping empty slots.
//
// Legacy single-template storage (`comment_template_v1`) is preserved as a read-only
// fallback so existing rows continue to work until the new key is written.

export const COMMENT_TEMPLATE_SLOT_COUNT = 3
export const COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER = '{{shopee_link}}'
export const COMMENT_TEMPLATE_LAZADA_PLACEHOLDER = '{{lazada_link}}'

export const DEFAULT_COMMENT_TEMPLATE_TEXT = [
    '📌 พิกัดอยู่ตรงนี้เลย กดเข้าไปดูเองได้ 👇',
    '🧡 Shopee : {{shopee_link}}',
    '💙 Lazada : {{lazada_link}}',
    '',
    '✨ ของจริงงานดีนะ ลองเข้าไปส่องก่อน 👀🛍️',
    '🛡️ เพจเราเป็น Partner Shopee & Lazada ปลอดภัย ✅💯',
].join('\n')

export function normalizeCommentTemplateText(rawTemplate: unknown): string {
    return String(rawTemplate || '')
        .replace(/\r\n?/g, '\n')
        .trim()
}

// Coerce arbitrary input (parsed JSON, raw string, or array of unknowns) into a
// fixed-length list of normalized template strings. Padded with empty strings,
// truncated to slotCount.
export function normalizeCommentTemplateSlots(
    input: unknown,
    slotCount: number = COMMENT_TEMPLATE_SLOT_COUNT,
): string[] {
    const slots = new Array<string>(slotCount).fill('')
    if (Array.isArray(input)) {
        for (let i = 0; i < slotCount && i < input.length; i += 1) {
            slots[i] = normalizeCommentTemplateText(input[i])
        }
        return slots
    }
    if (typeof input === 'string') {
        slots[0] = normalizeCommentTemplateText(input)
        return slots
    }
    return slots
}

// Decode the value stored under `comment_templates_v1`. Falls back to treating the
// raw string as a single legacy template if it isn't a JSON array.
export function parseStoredCommentTemplatesValue(stored: unknown): string[] {
    if (stored == null) return normalizeCommentTemplateSlots(null)
    const raw = String(stored || '').trim()
    if (!raw) return normalizeCommentTemplateSlots(null)
    try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) return normalizeCommentTemplateSlots(parsed)
    } catch {
        // not JSON — treat as legacy single string
    }
    return normalizeCommentTemplateSlots(raw)
}

// Apply a fixed set of legacy templates (e.g. the old `comment_template_v1` value)
// only when the new templates list is fully empty. Returns the merged slots.
export function mergeLegacyCommentTemplate(
    slots: string[],
    legacyTemplate: unknown,
): string[] {
    const next = normalizeCommentTemplateSlots(slots)
    const legacy = normalizeCommentTemplateText(legacyTemplate)
    const hasAny = next.some((entry) => entry.trim().length > 0)
    if (!hasAny && legacy) {
        next[0] = legacy
    }
    return next
}

export function encodeCommentTemplatesForStorage(slots: string[]): string {
    return JSON.stringify(normalizeCommentTemplateSlots(slots))
}

export function selectNonEmptyCommentTemplates(slots: string[]): string[] {
    return normalizeCommentTemplateSlots(slots).filter((entry) => entry.trim().length > 0)
}

export function renderAffiliateCommentTemplate(
    rawTemplate: string,
    shopeeLink: string,
    lazadaLink = '',
): string {
    const template = normalizeCommentTemplateText(rawTemplate)
    if (!template) return ''
    const shopee = String(shopeeLink || '').trim().replace(/\?lp=aff$/, '').replace(/&lp=aff$/, '')
    const lazada = String(lazadaLink || '').trim()

    const renderedLines = template
        .split('\n')
        .map((line) =>
            line
                .split(COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER).join(shopee)
                .split(COMMENT_TEMPLATE_LAZADA_PLACEHOLDER).join(lazada)
        )
        .filter((line) => {
            const trimmed = line.trim()
            if (!trimmed) return true
            if (!shopee && /shopee/i.test(trimmed) && !/https?:\/\//i.test(trimmed)) return false
            if (!lazada && /lazada/i.test(trimmed) && !/https?:\/\//i.test(trimmed)) return false
            return true
        })

    return renderedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Render every non-empty slot with the same Shopee/Lazada substitutions, drop slots
// that render to an empty string, and return the ordered list. If all configured
// slots are empty, fall back to the default template so the system never silently
// posts nothing.
export function renderCommentTemplatesForPosting(params: {
    slots: string[]
    shopeeLink: string
    lazadaLink?: string
    fallbackTemplate?: string
}): string[] {
    const fallback = normalizeCommentTemplateText(
        params.fallbackTemplate || DEFAULT_COMMENT_TEMPLATE_TEXT,
    )
    const effectiveSlots = selectNonEmptyCommentTemplates(params.slots)
    const sourceSlots = effectiveSlots.length > 0 ? effectiveSlots : [fallback]
    const rendered = sourceSlots
        .map((template) => renderAffiliateCommentTemplate(template, params.shopeeLink, params.lazadaLink || ''))
        .filter((message) => message.trim().length > 0)
    return rendered
}

export type CommentTemplateValidationError = {
    slot: number
    code: 'too_long' | 'missing_shopee_placeholder'
    message: string
}

export function validateCommentTemplateSlots(params: {
    slots: string[]
    maxChars: number
    shopeePlaceholder?: string
}): { ok: true; slots: string[] } | { ok: false; error: CommentTemplateValidationError } {
    const placeholder = params.shopeePlaceholder || COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER
    const normalized = normalizeCommentTemplateSlots(params.slots)

    for (let i = 0; i < normalized.length; i += 1) {
        const value = normalized[i]
        if (value.length > params.maxChars) {
            return {
                ok: false,
                error: {
                    slot: i + 1,
                    code: 'too_long',
                    message: `Comment template ${i + 1} too long (max ${params.maxChars} chars) / เทมเพลตคอมเมนต์ ${i + 1} ยาวเกิน ${params.maxChars} ตัวอักษร`,
                },
            }
        }
        if (value && !value.includes(placeholder)) {
            return {
                ok: false,
                error: {
                    slot: i + 1,
                    code: 'missing_shopee_placeholder',
                    message: `Comment template ${i + 1} ต้องมี ${placeholder} อย่างน้อย 1 จุด`,
                },
            }
        }
    }

    return { ok: true, slots: normalized }
}
