// Per-page avatar video settings — pure helpers (no I/O), unit-testable.
//
// Product contract (see force-post integration):
//   - Avatar is a per-page VIDEO layer (green-screen), applied only at posting time
//     after a video is claimed for the page and before publishing to Facebook.
//   - It is NEVER inserted during central processing.
//   - The avatar video is full-canvas, already composed by the user. We scale the
//     whole frame to the final 720x1280, chromakey/despill green, overlay at 0:0.
//     We do NOT crop, reposition, or shrink the subject.
//
// Storage: page-scoped keys in the existing dashboard_settings table via
// getPageSetting/setPageSetting (page:{pageId}:{key}). Zero new migration.

// Setting keys (versioned suffix lets us evolve the schema without clobbering).
export const AVATAR_ENABLED_KEY = 'avatar_enabled_v1'
export const AVATAR_VIDEO_KEY_KEY = 'avatar_video_key_v1'
export const AVATAR_VERSION_KEY = 'avatar_version_v1'
export const AVATAR_CHROMAKEY_SIMILARITY_KEY = 'avatar_chromakey_similarity_v1'
export const AVATAR_CHROMAKEY_BLEND_KEY = 'avatar_chromakey_blend_v1'
export const AVATAR_UPDATED_AT_KEY = 'avatar_updated_at_v1'

// Chromakey tuning is product-owned, not user-editable. Keep it low so we remove
// only the green screen and do not eat into the avatar subject or make it fade.
// The merge container keeps the same defaults for direct /avatar-compose calls.
export const AVATAR_CHROMAKEY_SIMILARITY_DEFAULT = 0.14
export const AVATAR_CHROMAKEY_SIMILARITY_MIN = 0.01
export const AVATAR_CHROMAKEY_SIMILARITY_MAX = 1.0
export const AVATAR_CHROMAKEY_BLEND_DEFAULT = 0.02
export const AVATAR_CHROMAKEY_BLEND_MIN = 0.0
export const AVATAR_CHROMAKEY_BLEND_MAX = 1.0

export const AVATAR_VERSION_MAX_CHARS = 40
export const AVATAR_PAGE_ID_MAX_CHARS = 64

export interface PageAvatarSettings {
    enabled: boolean
    videoKey: string
    version: string
    chromakeySimilarity: number
    chromakeyBlend: number
    updatedAt: string
}

export interface PageAvatarSettingsView {
    enabled: boolean
    has_video: boolean
    version: string
    chromakey_similarity: number
    chromakey_blend: number
    updated_at: string
}

// Keep only filesystem/url-safe characters. Returns '' for anything that would
// allow path traversal or break the deterministic key (slashes, dots, etc.).
function sanitizeSegment(raw: unknown, maxChars: number): string {
    const cleaned = String(raw ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '')
    return cleaned.slice(0, maxChars)
}

export function sanitizeAvatarPageId(pageId: unknown): string {
    return sanitizeSegment(pageId, AVATAR_PAGE_ID_MAX_CHARS)
}

export function sanitizeAvatarVersion(version: unknown): string {
    return sanitizeSegment(version, AVATAR_VERSION_MAX_CHARS)
}

// Deterministic, namespace-relative R2 key (BotBucket prepends the botId).
// Returns '' when either segment is invalid so callers fail closed.
export function buildPageAvatarVideoKey(pageId: unknown, version: unknown): string {
    const safePageId = sanitizeAvatarPageId(pageId)
    const safeVersion = sanitizeAvatarVersion(version)
    if (!safePageId || !safeVersion) return ''
    return `page-assets/${safePageId}/avatar/${safeVersion}.mp4`
}

export function clampChromakeySimilarity(value: unknown): number {
    // Locked by product request: ignore old DB/user-provided values such as
    // 0.30 that made avatars look translucent. Keep helper name for callers.
    void value
    return AVATAR_CHROMAKEY_SIMILARITY_DEFAULT
}

export function clampChromakeyBlend(value: unknown): number {
    // Locked by product request: blend stays near zero for a crisp subject.
    void value
    return AVATAR_CHROMAKEY_BLEND_DEFAULT
}

// Sanitized, secret-free projection returned to the webapp. Never echoes tokens.
export function serializePageAvatarSettings(settings: PageAvatarSettings): PageAvatarSettingsView {
    return {
        enabled: settings.enabled === true && settings.videoKey.length > 0,
        has_video: settings.videoKey.length > 0,
        version: settings.version,
        chromakey_similarity: settings.chromakeySimilarity,
        chromakey_blend: settings.chromakeyBlend,
        updated_at: settings.updatedAt,
    }
}
