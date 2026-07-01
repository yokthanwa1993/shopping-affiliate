// Facebook post log hashtag — pure helpers.
//
// Every NEW visible Facebook Page post gets a short, unique "log hashtag" appended
// to its caption, e.g. `#f2skgi`. The tag is the operator/CGO/Hermes lookup key: given
// the tag, we can pull the full token-free record (page, ids, links, sub ids, source,
// status/error, snapshot) back out of the `facebook_post_log_tags` table.
//
// Design invariants (mirrored by the companion test):
//   - Code is 6 chars of base36 lowercase [a-z0-9]. No secrets, no predictable data.
//   - We WRITE the tag as its OWN final caption line (`\n#code`). We DETECT an existing
//     log tag as a *lone* `#[a-z0-9]{6}` line. This keeps normal inline Thai hashtag
//     clusters (e.g. `#shopee #ของมันต้องมี`) from ever being mistaken for a log tag,
//     while making the append idempotent across retries.
//   - Snapshot/record building strips anything token/cookie/secret shaped so a log row
//     can never leak an access token, cookie, fb_dtsg, password, etc.

export const POST_LOG_CODE_LENGTH = 6
// base36 lowercase — [a-z0-9]
export const POST_LOG_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

// A log code is exactly 6 base36-lowercase chars. A log HASHTAG is that, `#`-prefixed.
export const POST_LOG_CODE_RE = /^[a-z0-9]{6}$/
// A caption line that is ONLY a log hashtag (surrounding whitespace tolerated).
const POST_LOG_TAG_LINE_RE = /^\s*#([a-z0-9]{6})\s*$/

// Default randomness source: prefer crypto (uniform, non-predictable) and fall back to
// Math.random only if crypto is somehow unavailable. Returns a float in [0, 1).
function defaultRandomUnit(): number {
    const cryptoObj: Crypto | undefined =
        typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const buf = new Uint32Array(1)
        cryptoObj.getRandomValues(buf)
        return buf[0] / 0x100000000
    }
    return Math.random()
}

// Generate a single 6-char base36-lowercase log code. `randomUnit` is injectable for
// deterministic tests; it must return a float in [0, 1). Callers handle collisions by
// re-generating (the DB has a UNIQUE index on log_code).
export function generatePostLogCode(randomUnit: () => number = defaultRandomUnit): string {
    let out = ''
    for (let i = 0; i < POST_LOG_CODE_LENGTH; i++) {
        const r = randomUnit()
        const clamped = r >= 0 && r < 1 ? r : 0
        const idx = Math.floor(clamped * POST_LOG_CODE_ALPHABET.length) % POST_LOG_CODE_ALPHABET.length
        out += POST_LOG_CODE_ALPHABET[idx]
    }
    return out
}

export function isValidPostLogCode(value: unknown): boolean {
    return typeof value === 'string' && POST_LOG_CODE_RE.test(value)
}

// Normalize a user/operator-supplied tag or code into a bare 6-char code, or '' if it
// is not a valid log code. Accepts `#f2skgi`, `f2skgi`, ` #F2SKGI `, etc.
export function normalizePostLogCode(value: string | null | undefined): string {
    const raw = String(value ?? '').trim().replace(/^#/, '').trim().toLowerCase()
    return POST_LOG_CODE_RE.test(raw) ? raw : ''
}

// `#` + code. No validation here on purpose — callers pass codes they generated.
export function formatPostLogHashtag(code: string): string {
    return `#${code}`
}

// Return the code of the FIRST lone `#code` line in the caption, or null. This is the
// exact shape we write, so it is what we detect for idempotency. Inline hashtags among
// other text/tags on the same line are intentionally NOT matched.
export function extractExistingPostLogCode(caption: string | null | undefined): string | null {
    const text = String(caption ?? '')
    if (!text) return null
    for (const line of text.split('\n')) {
        const m = line.match(POST_LOG_TAG_LINE_RE)
        if (m) return m[1]
    }
    return null
}

export type PostLogTagResolution = {
    // The caption to publish (original + appended tag line, or unchanged if one existed).
    caption: string
    // The log code that ends up in the caption (the reused one, or the freshly generated one).
    code: string
    hashtag: string
    // True only when we actually appended a new tag line this call.
    appended: boolean
    // True when the caption already carried a lone log-tag line before this call.
    alreadyPresent: boolean
}

// Resolve the publish caption + log code, appending the tag EXACTLY once.
//   - If the caption already has a lone log-tag line, reuse that code and leave the
//     caption untouched (no duplicate).
//   - Otherwise append `\n#code` (or just `#code` when the caption is empty).
// `code` is the freshly generated candidate; pass a collision-free code from the caller.
export function resolveCaptionWithPostLogTag(params: {
    caption: string | null | undefined
    code: string
}): PostLogTagResolution {
    const original = String(params.caption ?? '')
    const existing = extractExistingPostLogCode(original)
    if (existing) {
        return {
            caption: original,
            code: existing,
            hashtag: formatPostLogHashtag(existing),
            appended: false,
            alreadyPresent: true,
        }
    }
    const code = params.code
    const hashtag = formatPostLogHashtag(code)
    const caption = original ? `${original}\n${hashtag}` : hashtag
    return { caption, code, hashtag, appended: true, alreadyPresent: false }
}

// ---------------------------------------------------------------------------------------
// Token-free log record shaping.
// ---------------------------------------------------------------------------------------

// Keys whose presence anywhere in a snapshot object means "this holds a secret" — dropped
// entirely (not redacted-in-place) so a log row can never carry a live credential. Matched
// case-insensitively as a substring of the key name.
const SECRET_KEY_PATTERNS = [
    'token',
    'cookie',
    'fb_dtsg',
    'dtsg',
    'access_token',
    'password',
    'passwd',
    'secret',
    'datr',
    'totp',
    'apikey',
    'api_key',
    'api-key',
    'authorization',
    'bearer',
    'credential',
    'session_secret',
    'private_key',
    'client_secret',
    'refresh_token',
    'jwt',
    'xs=',
    'c_user',
]

export function isSecretKey(key: string): boolean {
    const k = String(key || '').toLowerCase()
    return SECRET_KEY_PATTERNS.some((p) => k.includes(p))
}

// Deep-clone `value` dropping any object entry whose key looks secret. Arrays and nested
// objects are walked. Non-plain values pass through. Guards against cycles/huge depth.
export function sanitizeSnapshot(value: unknown, depth = 0): unknown {
    if (depth > 12) return null
    if (Array.isArray(value)) return value.map((v) => sanitizeSnapshot(v, depth + 1))
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (isSecretKey(k)) continue
            out[k] = sanitizeSnapshot(v, depth + 1)
        }
        return out
    }
    return value
}

// Serialize a sanitized snapshot to a JSON string, capped so a runaway object can never
// blow up a D1 row. Returns '' on empty/failure.
export function serializeSnapshot(value: unknown, maxChars = 20000): string {
    if (value === undefined || value === null) return ''
    try {
        const json = JSON.stringify(sanitizeSnapshot(value))
        if (!json) return ''
        return json.length > maxChars ? json.slice(0, maxChars) : json
    } catch {
        return ''
    }
}

// The full token-free shape persisted to `facebook_post_log_tags`. Every field is a
// primitive/string; `sub_ids` and `snapshot_json` are pre-serialized JSON strings.
export type PostLogRecord = {
    log_code: string
    hashtag: string
    bot_id: string
    namespace_id: string
    page_id: string
    page_name: string
    history_id: number | null
    story_id: string
    fb_post_id: string
    fb_video_id: string
    reel_id: string
    source_video_id: string
    system_video_id: string
    caption_before: string
    caption_after: string
    shopee_link: string
    original_link: string
    shortlink: string
    comment_link: string
    sub_ids: string
    posting_source: string
    comment_source: string
    status: string
    error: string
    snapshot_json: string
}

export type PostLogRecordInput = {
    log_code: string
    hashtag?: string
    bot_id?: string | number | null
    namespace_id?: string | number | null
    page_id?: string | number | null
    page_name?: string | null
    history_id?: number | string | null
    story_id?: string | null
    fb_post_id?: string | null
    fb_video_id?: string | null
    reel_id?: string | null
    source_video_id?: string | null
    system_video_id?: string | null
    caption_before?: string | null
    caption_after?: string | null
    shopee_link?: string | null
    original_link?: string | null
    shortlink?: string | null
    comment_link?: string | null
    sub_ids?: unknown
    posting_source?: string | null
    comment_source?: string | null
    status?: string | null
    error?: string | null
    snapshot?: unknown
}

function str(v: unknown): string {
    if (v === undefined || v === null) return ''
    return String(v)
}

function subIdsToJson(subIds: unknown): string {
    if (subIds === undefined || subIds === null || subIds === '') return ''
    if (typeof subIds === 'string') return subIds
    return serializeSnapshot(subIds, 2000)
}

// Build the token-free row object. Any secret-shaped fields inside `snapshot`/`sub_ids`
// are stripped by sanitizeSnapshot; the top-level fields are plain non-secret metadata.
export function buildPostLogRecord(input: PostLogRecordInput): PostLogRecord {
    const code = normalizePostLogCode(input.log_code) || String(input.log_code || '')
    let historyId: number | null = null
    if (input.history_id !== undefined && input.history_id !== null && input.history_id !== '') {
        const n = Number(input.history_id)
        historyId = Number.isFinite(n) ? n : null
    }
    return {
        log_code: code,
        hashtag: input.hashtag ? String(input.hashtag) : formatPostLogHashtag(code),
        bot_id: str(input.bot_id),
        namespace_id: str(input.namespace_id),
        page_id: str(input.page_id),
        page_name: str(input.page_name),
        history_id: historyId,
        story_id: str(input.story_id),
        fb_post_id: str(input.fb_post_id),
        fb_video_id: str(input.fb_video_id),
        reel_id: str(input.reel_id),
        source_video_id: str(input.source_video_id),
        system_video_id: str(input.system_video_id),
        caption_before: str(input.caption_before),
        caption_after: str(input.caption_after),
        shopee_link: str(input.shopee_link),
        original_link: str(input.original_link),
        shortlink: str(input.shortlink),
        comment_link: str(input.comment_link),
        sub_ids: subIdsToJson(input.sub_ids),
        posting_source: str(input.posting_source),
        comment_source: str(input.comment_source),
        status: str(input.status),
        error: str(input.error).slice(0, 2000),
        snapshot_json: serializeSnapshot(input.snapshot),
    }
}

// Safety net for the read API: strip any secret-shaped key from an outgoing log row,
// including a nested parsed snapshot, before returning it over the wire.
export function toSafePostLogOutput(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!row) return null
    const safe = sanitizeSnapshot(row) as Record<string, unknown>
    // Re-parse snapshot_json so callers get structured, already-sanitized data.
    if (typeof safe.snapshot_json === 'string' && safe.snapshot_json) {
        try {
            safe.snapshot = sanitizeSnapshot(JSON.parse(safe.snapshot_json))
        } catch {
            /* leave snapshot_json string as-is */
        }
    }
    if (typeof safe.sub_ids === 'string' && safe.sub_ids) {
        try {
            safe.sub_ids_parsed = sanitizeSnapshot(JSON.parse(safe.sub_ids))
        } catch {
            /* non-JSON sub_ids stays a string */
        }
    }
    return safe
}
