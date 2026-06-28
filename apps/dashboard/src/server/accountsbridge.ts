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
  if (m === 'GET' && sub === '/accounts') return '/v1/accounts'
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

async function handleAccountsBridgeProxy(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const sub = url.pathname.slice(ACCOUNTS_BRIDGE_PREFIX.length) || '/'

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
  for (const key of ['agent_id', 'status', 'limit', 'platform']) {
    const v = url.searchParams.get(key)
    if (v != null) target.searchParams.set(key, v)
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
