// Accounts Bridge cloud proxy slice — same Hono bridge shape as the /worker-api and /customlink
// slices. worker.ts owns host routing + the shared dashboard auth gate and delegates already-gated
// /accounts-bridge/* requests here.
//
// WHY THIS EXISTS: the dashboard runs on https://www.pubilo.com but the Accounts Bridge state now
// lives in a CLOUD Worker (apps/accounts-bridge/worker), so /dashboard/accounts works from any
// machine — not only the Mac on loopback. The browser calls same-origin /accounts-bridge/* and this
// proxy forwards to the cloud Worker, injecting the shared API key SERVER-SIDE. The key is read from
// env.ACCOUNTS_BRIDGE_API_KEY (a Worker secret) and is NEVER exposed to the React bundle.
//
// SAFETY:
//   * Only a fixed allowlist of token-free read endpoints + the command-enqueue/list endpoints is
//     proxied. The session/cookie/profile-archive (blob-bearing) routes are intentionally NOT mapped.
//   * Responses are defensively stripped of secret-shaped keys before reaching the browser.
//   * When ACCOUNTS_BRIDGE_WORKER_URL is unset, the proxy returns 503 cloud_bridge_not_configured so
//     the UI shows a clear "Cloud bridge not configured" state instead of falling back to localhost.

import { Hono } from 'hono'

import type { AuthEnv } from './auth'

const ACCOUNTS_BRIDGE_PREFIX = '/accounts-bridge'
const AUTH_HEADER = 'x-accounts-bridge-key'

// Secret-shaped key names dropped from any proxied JSON response (defence in depth — the cloud Worker
// already never returns secrets). Boolean readiness flags (…Present) are preserved.
const SECRET_KEY_RE = /token|cookie|password|secret|datr|dtsg/i

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key) && typeof raw !== 'boolean') continue
      out[key] = stripSecrets(raw)
    }
    return out
  }
  return value
}

// Map an allowed public sub-path (the part after /accounts-bridge) + method to its upstream path on
// the cloud Worker, or null when the route is not allowlisted. The blob-bearing routes (sessions /
// cookies / profile-archives) are deliberately absent.
export function resolveUpstreamPath(method: string, sub: string): string | null {
  const m = method.toUpperCase()
  if (m === 'GET' && sub === '/health') return '/health'
  // Accounts CRUD — the real Cloud Account Manager surface. All token-free / non-secret metadata only;
  // the blob-bearing session/cookie/profile-archive routes remain deliberately unmapped.
  if (m === 'GET' && sub === '/accounts') return '/v1/accounts'
  if (m === 'POST' && sub === '/accounts') return '/v1/accounts'
  const account = sub.match(/^\/accounts\/([a-z]+)\/([^/]+)$/)
  if (account && (m === 'GET' || m === 'PATCH' || m === 'DELETE')) {
    return `/v1/accounts/${account[1]}/${account[2]}`
  }
  // Write-only credential vault: only PUT is allowed; the body carries the write-only fields up, the
  // response is presence booleans only (no secret ever comes back down).
  const cred = sub.match(/^\/accounts\/([a-z]+)\/([^/]+)\/credentials$/)
  if (cred && m === 'PUT') return `/v1/accounts/${cred[1]}/${cred[2]}/credentials`
  // Avatar image bytes (multipart/json upload + image stream). Handled with binary passthrough below.
  const avatar = sub.match(/^\/accounts\/([a-z]+)\/([^/]+)\/avatar$/)
  if (avatar && (m === 'GET' || m === 'POST' || m === 'PUT' || m === 'DELETE')) {
    return `/v1/accounts/${avatar[1]}/${avatar[2]}/avatar`
  }
  if (m === 'GET' && sub === '/roles/facebook') return '/v1/roles/facebook'
  if (m === 'GET' && sub === '/agents') return '/v1/agents'
  const agentStatus = sub.match(/^\/agents\/([^/]+)\/status$/)
  if (m === 'GET' && agentStatus) return `/v1/agents/${agentStatus[1]}/status`
  if (m === 'GET' && sub === '/commands') return '/v1/commands'
  if (m === 'POST' && sub === '/commands') return '/v1/commands'
  return null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// Binary-safe passthrough for the avatar route. Uploads forward the raw body + original content-type
// (so multipart boundaries survive); the GET stream returns image bytes with their content-type. A
// JSON error body from upstream (e.g. 404 avatar_not_found) is still returned verbatim — no stripping
// is needed because the avatar endpoints never carry a secret in EITHER direction.
async function handleAvatarPassthrough(request: Request, target: URL, apiKey: string): Promise<Response> {
  const method = request.method.toUpperCase()
  const headers = new Headers()
  if (apiKey) headers.set(AUTH_HEADER, apiKey)
  const init: RequestInit = { method, headers, redirect: 'follow' }
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
    const ct = request.headers.get('content-type')
    if (ct) headers.set('content-type', ct)
    init.body = await request.arrayBuffer()
  }

  let upstream: Response
  try {
    upstream = await fetch(new Request(target.toString(), init))
  } catch {
    return jsonResponse({ error: 'cloud_bridge_unreachable' }, 502)
  }

  const outHeaders = new Headers()
  const ct = upstream.headers.get('content-type') || 'application/octet-stream'
  outHeaders.set('content-type', ct)
  outHeaders.set('cache-control', ct.startsWith('image/') ? 'private, max-age=300' : 'no-store')
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
}

// Allowlist + method gate for the Cloud Browser routes. These forward to the Mac bridge, NOT the
// cloud accounts Worker. Every route is token-free: start/status/input/stop carry JSON with no secret,
// screenshot streams a rasterized JPEG. There is deliberately NO eval/script route. Returns the
// matched upstream sub-path or null when the route is not allowlisted.
function resolveRemoteBrowserPath(method: string, sub: string): string | null {
  const m = method.toUpperCase()
  if (m === 'POST' && sub === '/remote-browser/start') return '/remote-browser/start'
  const op = sub.match(/^\/remote-browser\/([A-Za-z0-9_-]+)\/(status|screenshot|input|stop)$/)
  if (op) {
    const [, id, action] = op
    if ((action === 'status' || action === 'screenshot') && m === 'GET') return `/remote-browser/${id}/${action}`
    if ((action === 'input' || action === 'stop') && m === 'POST') return `/remote-browser/${id}/${action}`
  }
  return null
}

// Forward a Cloud Browser request to the Mac bridge. The screenshot route returns live image bytes —
// passed through verbatim with its content-type and never run through the JSON secret-stripper (it has
// no JSON body). JSON routes are still stripped of secret-shaped keys as defence in depth. When no
// bridge base URL is configured, returns 503 remote_browser_not_configured WITHOUT leaking localhost.
async function handleRemoteBrowserProxy(request: Request, env: AuthEnv, sub: string): Promise<Response> {
  const base = remoteBrowserBase(env)
  if (!base) return jsonResponse({ error: 'remote_browser_not_configured' }, 503)

  const upstreamPath = resolveRemoteBrowserPath(request.method, sub)
  if (!upstreamPath) return jsonResponse({ error: 'not_found' }, 404)

  const target = new URL(base + upstreamPath)
  const isScreenshot = upstreamPath.endsWith('/screenshot')
  // Forward the live-stream cache-buster so the <img> frame is never served stale.
  const t = new URL(request.url).searchParams.get('t')
  if (t) target.searchParams.set('t', t)

  // Shared secret the Mac bridge gates /remote-browser/* on (it accepts ACCOUNTS_BRIDGE_API_KEY as its
  // own fallback, so a single shared key configured on both sides just works). Injected SERVER-SIDE.
  const key = String(env.ACCOUNTS_BRIDGE_REMOTE_BROWSER_KEY || env.ACCOUNTS_BRIDGE_API_KEY || '').trim()
  const headers = new Headers()
  if (key) headers.set('x-remote-browser-key', key)
  const init: RequestInit = { method: request.method, headers, redirect: 'follow' }
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    const bodyText = await request.text()
    if (bodyText) {
      headers.set('content-type', 'application/json')
      init.body = bodyText
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(new Request(target.toString(), init))
  } catch {
    return jsonResponse({ error: 'remote_browser_unreachable' }, 502)
  }

  if (isScreenshot) {
    const ct = upstream.headers.get('content-type') || 'application/octet-stream'
    // Image frame → stream the bytes through unchanged; a JSON error (e.g. 404 session_not_found) is
    // also passed verbatim since the bridge never carries a secret on this route in either direction.
    const outHeaders = new Headers()
    outHeaders.set('content-type', ct)
    outHeaders.set('cache-control', 'no-store')
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
  }

  const text = await upstream.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      return jsonResponse({ error: 'remote_browser_bad_response' }, 502)
    }
  }
  return jsonResponse(stripSecrets(parsed ?? {}), upstream.status)
}

// Resolve the Mac bridge base URL for Cloud Browser routes. Shared by the HTTP proxy and the WebSocket
// stream proxy so both agree on configuration + 503 behavior.
function remoteBrowserBase(env: AuthEnv): string {
  return String(env.ACCOUNTS_BRIDGE_REMOTE_BROWSER_BASE_URL || env.FACEBOOK_TOKEN_CLOAK_BRIDGE_URL || '')
    .trim()
    .replace(/\/+$/, '')
}

// LIVE Cloud Browser stream: proxy the WebSocket upgrade for /remote-browser/:id/stream to the Mac
// bridge, injecting the shared secret SERVER-SIDE. Cloudflare Workers tunnel a WebSocket when the
// forwarded request keeps its `Upgrade: websocket` headers and the upstream answers 101 — we return
// that response unchanged so the client ↔ Mac bridge socket is bridged same-origin (the browser never
// holds the key and never talks to the bridge directly). The HTTP /screenshot route stays as a polling
// fallback when WebSockets are unavailable (returned by the viewer logic, not here).
async function handleRemoteBrowserStreamProxy(request: Request, env: AuthEnv, sub: string): Promise<Response> {
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    // Not an upgrade — make the contract explicit so the viewer falls back to screenshot polling.
    return jsonResponse({ error: 'expected_websocket_upgrade' }, 426)
  }
  const base = remoteBrowserBase(env)
  if (!base) return jsonResponse({ error: 'remote_browser_not_configured' }, 503)

  const m = sub.match(/^\/remote-browser\/([A-Za-z0-9_-]+)\/stream$/)
  if (!m) return jsonResponse({ error: 'not_found' }, 404)

  const target = new URL(`${base}/remote-browser/${m[1]}/stream`)
  // Forward optional quality/fps hints the viewer may set.
  const reqUrl = new URL(request.url)
  for (const key of ['quality', 'everyNthFrame', 'maxWidth', 'maxHeight']) {
    const v = reqUrl.searchParams.get(key)
    if (v != null) target.searchParams.set(key, v)
  }

  // Carry the WebSocket handshake headers through and inject the shared secret server-side.
  const key = String(env.ACCOUNTS_BRIDGE_REMOTE_BROWSER_KEY || env.ACCOUNTS_BRIDGE_API_KEY || '').trim()
  const headers = new Headers(request.headers)
  if (key) headers.set('x-remote-browser-key', key)

  try {
    // Returning the upstream 101 response (with its attached webSocket) lets the Worker runtime tunnel
    // the socket end-to-end. Do NOT read/clone the body — that would break the upgrade.
    return await fetch(target.toString(), { method: 'GET', headers })
  } catch {
    return jsonResponse({ error: 'remote_browser_unreachable' }, 502)
  }
}

async function handleAccountsBridgeProxy(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const sub = url.pathname.slice(ACCOUNTS_BRIDGE_PREFIX.length) || '/'

  // LIVE Cloud Browser stream (WebSocket) — branch FIRST so the upgrade is tunneled, never buffered.
  if (/^\/remote-browser\/[A-Za-z0-9_-]+\/stream$/.test(sub)) {
    return handleRemoteBrowserStreamProxy(request, env, sub)
  }

  // Cloud Browser routes go to the Mac bridge, not the cloud accounts Worker. Branch BEFORE the
  // accounts-worker plumbing so the two backends stay cleanly separated.
  if (sub.startsWith('/remote-browser/')) {
    return handleRemoteBrowserProxy(request, env, sub)
  }

  const baseUrl = String(env.ACCOUNTS_BRIDGE_WORKER_URL || '').trim().replace(/\/+$/, '')
  const apiKey = String(env.ACCOUNTS_BRIDGE_API_KEY || '').trim()
  if (!baseUrl) {
    // No cloud worker configured — tell the UI explicitly so it never tries localhost as a main path.
    return jsonResponse({ error: 'cloud_bridge_not_configured' }, 503)
  }

  const upstreamPath = resolveUpstreamPath(request.method, sub)
  if (!upstreamPath) return jsonResponse({ error: 'not_found' }, 404)

  const target = new URL(baseUrl + upstreamPath)
  // Forward only the safe query params we expect on the allowlisted GETs.
  for (const key of ['agent_id', 'status', 'limit', 'platform', 'include_archived']) {
    const v = url.searchParams.get(key)
    if (v != null) target.searchParams.set(key, v)
  }

  // Avatar routes carry IMAGE bytes — never JSON. Pass the request body (multipart/json/raw) and the
  // image response through verbatim, preserving content-type and NOT running the JSON secret-stripper.
  const isAvatar = upstreamPath.endsWith('/avatar')
  if (isAvatar) {
    return handleAvatarPassthrough(request, target, apiKey)
  }

  const headers = new Headers()
  headers.set('accept', 'application/json')
  if (apiKey) headers.set(AUTH_HEADER, apiKey)

  const init: RequestInit = { method: request.method, headers, redirect: 'follow' }
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    const bodyText = await request.text()
    if (bodyText) {
      headers.set('content-type', 'application/json')
      init.body = bodyText
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(new Request(target.toString(), init))
  } catch {
    return jsonResponse({ error: 'cloud_bridge_unreachable' }, 502)
  }

  const text = await upstream.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      // Non-JSON upstream — surface a stable shape rather than leaking raw bytes.
      return jsonResponse({ error: 'cloud_bridge_bad_response' }, 502)
    }
  }
  return jsonResponse(stripSecrets(parsed ?? {}), upstream.status)
}

// Hono app for the accounts-bridge proxy slice. worker.ts delegates the original request unchanged,
// so the public path stays /accounts-bridge/* and this matches it directly for every method.
export const accountsBridgeApp = new Hono<{ Bindings: AuthEnv }>()

accountsBridgeApp.all('/accounts-bridge/*', (c) => handleAccountsBridgeProxy(c.req.raw, c.env))
