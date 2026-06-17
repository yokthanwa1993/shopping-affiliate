// Worker API proxy slice — migrated onto Hono as part of the dashboard Worker
// modernization (after the customlink shorten and /auth/* slices). Same bridge
// shape: the raw fetch handler in worker.ts still owns host routing, redirects,
// dashboard canonicalization, the shared auth gate and asset serving, decides
// `isWorkerApi`, and delegates every already-gated /worker-api/* request here.
//
// Behavior is preserved 1:1 from the previous inline block in worker.ts:
//   - The proxy maps /worker-api/<path>?query → https://api.pubilo.com/<path>?query.
//   - For download attachments on /worker-api/api/gallery/:id/asset/original (or
//     /public) with ?download=1, the download + filename query params are stripped
//     before upstream, then the upstream response is copied with a sanitized
//     Content-Disposition attachment filename, X-Content-Type-Options: nosniff and
//     Cache-Control: no-store.
//   - For every other proxy response, the upstream response is returned unchanged.
//   - method and headers are forwarded; host is removed; x-forwarded-host and
//     x-forwarded-proto are set. For non-GET/HEAD the request body is passed
//     through; GET/HEAD send no body.

import { Hono } from 'hono'

import { type AuthEnv, credentialCount, readSessionId } from './auth'

const API_ORIGIN = 'https://api.pubilo.com'

// Trusted header the upstream video worker reads as the dashboard session id (see
// apps/video-affiliate/worker/src/dashboard-session.ts). The browser's
// pubilo_dashboard_session cookie is domain-scoped to .pubilo.com and does not
// reliably survive this server-to-server proxy hop to api.pubilo.com, so the proxy
// lifts the verified cookie value into this header. Any client-supplied value is
// stripped first so only the cookie-derived id is ever forwarded.
const DASHBOARD_SESSION_HEADER = 'x-dashboard-session-id'

// Trusted header signalling the passkey bootstrap window: the dashboard namespace
// has ZERO registered credentials (setup mode), so there is no session to bridge
// but the UI is intentionally accessible. The proxy strips any client value and
// only sets it after server-side confirming credentialCount === 0. The upstream
// worker re-confirms the 0-credential state against D1 before honoring it.
const DASHBOARD_SETUP_MODE_HEADER = 'x-dashboard-setup-mode'

export function sanitizeDownloadFilename(input: string | null): string {
  const raw = String(input || '').trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120)
  if (!cleaned) return 'video_original.mp4'
  return /\.mp4$/i.test(cleaned) ? cleaned : `${cleaned}.mp4`
}

// The path of the upstream resource, with the public `/worker-api` mount prefix
// stripped if present. Both attachment detection and the upstream target map are
// derived from THIS so they can never disagree about the same request.
//
// Robustness: depending on how the request reaches this Hono app (delegated raw
// from worker.ts, or — after a future top-level dispatch unification — routed by
// Hono under a `/worker-api` basePath that strips the mount), `url.pathname` may
// arrive WITH the `/worker-api` prefix (`/worker-api/api/gallery/…`) or WITHOUT
// it (`/api/gallery/…`). The old detection regex required the prefix, so when the
// stripped shape was presented it silently returned false — attachment headers
// were dropped while the proxy still worked (the target map's prefix strip is a
// no-op on the already-stripped shape). Normalizing once fixes both shapes.
function workerApiUpstreamPath(pathname: string): string {
  return pathname.replace(/^\/worker-api/, '')
}

export function shouldForceAttachment(url: URL): boolean {
  return url.searchParams.get('download') === '1'
    && /^\/api\/gallery\/[^/]+\/asset\/(?:original|public)$/i.test(workerApiUpstreamPath(url.pathname))
}

async function handleWorkerApiProxy(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url)

  const forceAttachment = shouldForceAttachment(url)
  const filename = sanitizeDownloadFilename(url.searchParams.get('filename'))
  const target = new URL(workerApiUpstreamPath(url.pathname) + url.search, API_ORIGIN)
  target.searchParams.delete('download')
  target.searchParams.delete('filename')

  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''))

  // Dashboard session bridge: strip any client-supplied session/setup headers, then
  // re-add ONLY server-derived values. This guarantees the upstream worker receives
  // a trustworthy signal even when the cross-subdomain cookie does not survive the
  // proxy hop, and that neither header can be spoofed by the browser.
  headers.delete(DASHBOARD_SESSION_HEADER)
  headers.delete(DASHBOARD_SETUP_MODE_HEADER)
  const dashboardSessionId = readSessionId(request)
  if (dashboardSessionId) {
    headers.set(DASHBOARD_SESSION_HEADER, dashboardSessionId)
  } else {
    // No session — during the passkey bootstrap window (zero registered credentials)
    // the dashboard is in setup mode. Signal it so the worker can authorize
    // namespace-scoped setup writes; the worker independently re-confirms the
    // 0-credential state against D1, so this header is only a hint. Any error
    // computing the count leaves the header unset (fail closed).
    let credentials: number | null = null
    try {
      credentials = await credentialCount(env)
    } catch {
      credentials = null
    }
    if (credentials === 0) {
      headers.set(DASHBOARD_SETUP_MODE_HEADER, '1')
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'follow',
  }

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    init.body = request.body
  }

  const upstreamResponse = await fetch(new Request(target.toString(), init))
  if (!forceAttachment) return upstreamResponse

  const responseHeaders = new Headers(upstreamResponse.headers)
  responseHeaders.set('Content-Disposition', `attachment; filename="${filename}"`)
  responseHeaders.set('X-Content-Type-Options', 'nosniff')
  responseHeaders.set('Cache-Control', 'no-store')
  // Expose the two custom attachment headers to same-origin JS. The browser
  // classifies the proxied asset response as `cors`, so without this only the
  // CORS-safelisted response headers (cache-control, content-length,
  // content-type) are readable from fetch() — Content-Disposition and
  // X-Content-Type-Options would be set on the wire but invisible to JS and to
  // download tooling. Additive and scoped to the attachment branch only.
  responseHeaders.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Content-Type-Options')
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  })
}

// Hono app for the worker-api proxy slice. worker.ts delegates the original
// request unchanged (`workerApiApp.fetch(request, env)`), so the public path
// stays /worker-api/* and this app matches it directly — no path rewrite, unlike
// the customlink slice. The wildcard captures the entire /worker-api/* family for
// every method (the proxy forwards the method to upstream as-is).
export const workerApiApp = new Hono<{ Bindings: AuthEnv }>()

workerApiApp.all('/worker-api/*', (c) => handleWorkerApiProxy(c.req.raw, c.env))
