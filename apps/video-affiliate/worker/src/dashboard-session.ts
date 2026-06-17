// Dashboard passkey session bridge — pure, testable auth decisions.
//
// The React dashboard (apps/dashboard) authenticates operators with passkeys and
// stores their session in the `dashboard_passkey_sessions` table of the SAME
// shared D1 (video-affiliate-db). It talks to this worker through the
// `/worker-api` proxy (apps/dashboard/src/server/workerapi.ts), which forwards the
// browser `pubilo_dashboard_session` cookie upstream to api.pubilo.com.
//
// The dashboard NEVER holds a raw video `sess_...` token (users.session_token),
// so every write route guarded by requireAuthSession used to 401 for dashboard
// operators even though they were fully authenticated — the PageDetail "Save"
// (shortlink / posting-order / avatar settings + avatar upload) returned
// "Unauthorized". This module supplies the narrowly-scoped server-side bridge:
// the worker resolves the cookie against dashboard_passkey_sessions and treats a
// live row as an authenticated principal scoped to its namespace_id.
//
// SECURITY: a dashboard session authorizes a request ONLY within its own
// namespace. The request MUST carry a resolved botId (the dashboard sends it via
// the x-bot-id header) and it MUST equal the session's namespace_id — a blank
// botId never authorizes, and the namespace check is never bypassed. No
// token/cookie value is ever logged or echoed; callers only learn pass/fail.

export const DASHBOARD_SESSION_COOKIE_NAME = 'pubilo_dashboard_session'

// Header the dashboard proxy (apps/dashboard/src/server/workerapi.ts) sets from the
// browser's pubilo_dashboard_session cookie before forwarding to api.pubilo.com.
// The cross-subdomain cookie does not always survive the server-to-server proxy
// hop, so the proxy lifts it into this trusted header. The proxy STRIPS any
// client-provided value first and only re-adds it from the verified cookie, so the
// worker may trust it as equivalent to the cookie.
export const DASHBOARD_SESSION_HEADER_NAME = 'x-dashboard-session-id'

// Header the dashboard proxy sets to signal the passkey bootstrap window: the
// dashboard namespace has ZERO registered credentials, so it is in setup mode and
// the UI is intentionally accessible without a session. The proxy strips any
// client value and only sets it after confirming credential count is 0. The worker
// NEVER trusts this header alone — it independently re-confirms via the shared D1
// that the request's namespace has 0 credentials before authorizing a setup-mode
// write (see dashboardSetupModeAuthorizes).
export const DASHBOARD_SETUP_MODE_HEADER_NAME = 'x-dashboard-setup-mode'

// A live dashboard session row (already filtered to unexpired by the DB query).
// Mirrors the columns the dashboard worker writes in apps/dashboard/src/server/auth.ts.
export interface DashboardSessionRow {
    session_id: string
    user_id: string
    namespace_id: string
    expires_at: string
}

// Extract the dashboard session id from a raw Cookie header. Returns '' when the
// cookie is absent. Tolerates quoted values and `=`-containing payloads (base64url
// session ids never contain `=` once stripped, but be defensive).
export function extractDashboardSessionId(cookieHeader: string | null | undefined): string {
    const header = String(cookieHeader || '')
    if (!header) return ''
    for (const part of header.split(';')) {
        const segment = part.trim()
        if (!segment) continue
        const eq = segment.indexOf('=')
        if (eq <= 0) continue
        const name = segment.slice(0, eq).trim()
        if (name !== DASHBOARD_SESSION_COOKIE_NAME) continue
        let value = segment.slice(eq + 1).trim()
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1)
        }
        return value
    }
    return ''
}

// Resolve the dashboard session id from the two transports, preferring the
// x-dashboard-session-id header that the dashboard proxy injects from the verified
// cookie. The header is preferred because the browser cookie is not guaranteed to
// reach api.pubilo.com across the proxy hop; when the header is absent or blank we
// fall back to parsing the raw Cookie header directly. Returns '' when neither
// carries a value.
export function resolveDashboardSessionId(
    headerValue: string | null | undefined,
    cookieHeader: string | null | undefined,
): string {
    const fromHeader = String(headerValue || '').trim()
    if (fromHeader) return fromHeader
    return extractDashboardSessionId(cookieHeader)
}

// Pure authorization decision for a resolved dashboard session row.
//
//   - The session must exist and carry a non-empty namespace_id.
//   - `requestBotId` MUST be present (non-blank) AND equal the session
//     namespace_id. A blank/absent botId never authorizes — every dashboard write
//     route resolves a botId from the x-bot-id header, so a missing one signals an
//     unscoped request that must not pass through the bridge.
export function dashboardSessionAuthorizes(params: {
    session: DashboardSessionRow | null | undefined
    requestBotId?: string | null
}): boolean {
    const namespaceId = String(params.session?.namespace_id || '').trim()
    if (!namespaceId) return false
    const botId = String(params.requestBotId || '').trim()
    if (!botId) return false
    return botId === namespaceId
}

// Pure authorization decision for the setup-mode (passkey bootstrap) fallback. This
// is the LAST resort, only reached when there is no session at all.
//
//   - The proxy-set x-dashboard-setup-mode header must be exactly '1'.
//   - `requestBotId` MUST be present (non-blank) — setup mode is namespace-scoped.
//   - `credentialCount` MUST be exactly 0, i.e. the shared D1 confirmed the
//     namespace has no registered passkey credentials. A null/undefined count
//     (DB error, table missing, or simply not looked up) is treated as
//     unconfirmed and DENIES — the header is never trusted on its own.
export function dashboardSetupModeAuthorizes(params: {
    setupModeHeader: string | null | undefined
    requestBotId?: string | null
    credentialCount: number | null | undefined
}): boolean {
    if (String(params.setupModeHeader || '').trim() !== '1') return false
    const botId = String(params.requestBotId || '').trim()
    if (!botId) return false
    return params.credentialCount === 0
}
