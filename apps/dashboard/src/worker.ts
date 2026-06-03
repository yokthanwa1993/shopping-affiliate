import {
  credentialCount,
  dispatchAuth,
  loadSession,
  type AuthEnv,
} from './server/auth'

export interface Env extends AuthEnv {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
}

const API_ORIGIN = 'https://api.pubilo.com'

// Both the new pubilo.com family and the legacy oomnn.com family resolve to
// this same worker bundle during cutover. Keeping both host sets in the
// routing decisions lets old traffic keep working while DNS/SSL on pubilo
// finishes propagating.
const WWW_HOSTS = new Set(['www.pubilo.com', 'www.oomnn.com'])
const ADMIN_HOSTS = new Set(['admin.pubilo.com', 'admin.oomnn.com'])
const APEX_HOSTS = new Set(['pubilo.com', 'oomnn.com'])
const DASHBOARD_HOSTS = new Set(['dashboard.pubilo.com', 'dashboard.oomnn.com'])
const OOMNN_DASHBOARD_HOSTS = new Set(['dashboard.oomnn.com'])
const OOMNN_ADMIN_HOSTS = new Set(['admin.oomnn.com'])
const CANONICAL_WWW_ORIGIN = 'https://www.pubilo.com'
const CANONICAL_DASHBOARD_ORIGIN = 'https://dashboard.pubilo.com'
const CANONICAL_ADMIN_ORIGIN = 'https://admin.pubilo.com'

const LEGACY_CHEARB_MAP: Record<string, string> = {
  '/chearb': '/',
  '/chearb/': '/',
  '/chearb/processing': '/processing',
  '/chearb/processing/': '/processing',
  '/chearb/source-inventory': '/source-inventory',
  '/chearb/source-inventory/': '/source-inventory',
  '/chearb/gallery': '/gallery',
  '/chearb/gallery/': '/gallery',
}

// Paths that never require auth: login UI, auth endpoints, and static assets
// shipped with the Astro bundle.
const STATIC_PREFIXES = ['/_astro/', '/page-icons/']
const STATIC_FILES = new Set(['/favicon.ico', '/favicon.svg', '/robots.txt', '/sitemap.xml', '/sitemap-index.xml'])

function isStaticAssetPath(pathname: string): boolean {
  if (STATIC_FILES.has(pathname)) return true
  for (const prefix of STATIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true
  }
  return /\.[a-zA-Z0-9]{2,5}$/.test(pathname) && !pathname.endsWith('.html')
}

function isAuthPath(pathname: string): boolean {
  return pathname === '/login' || pathname === '/login/' || pathname.startsWith('/auth/')
}

function sanitizeDownloadFilename(input: string | null): string {
  const raw = String(input || '').trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120)
  if (!cleaned) return 'video_original.mp4'
  return /\.mp4$/i.test(cleaned) ? cleaned : `${cleaned}.mp4`
}

function shouldForceAttachment(url: URL): boolean {
  return url.searchParams.get('download') === '1'
    && /^\/worker-api\/api\/gallery\/[^/]+\/asset\/(?:original|public)$/i.test(url.pathname)
}

function legacyChearbTarget(pathname: string): string | null {
  if (LEGACY_CHEARB_MAP[pathname]) return LEGACY_CHEARB_MAP[pathname]
  if (pathname === '/chearb' || pathname.startsWith('/chearb/')) return '/'
  return null
}

function rewriteForHost(url: URL): Request | null {
  if (WWW_HOSTS.has(url.hostname) && (url.pathname === '/' || url.pathname === '')) {
    return new Request(new URL('/www/', url).toString(), { method: 'GET' })
  }
  if (ADMIN_HOSTS.has(url.hostname) && (url.pathname === '/' || url.pathname === '')) {
    return new Request(new URL('/admin/', url).toString(), { method: 'GET' })
  }
  return null
}

function redirectToLogin(url: URL): Response {
  const next = url.pathname + url.search
  const target = new URL('/login', url)
  if (next && next !== '/' && next !== '/login') target.searchParams.set('next', next)
  return Response.redirect(target.toString(), 302)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Apex (pubilo.com or legacy oomnn.com) → canonical https://www.pubilo.com/.
    if (APEX_HOSTS.has(url.hostname)) {
      const target = new URL(url.pathname + url.search, CANONICAL_WWW_ORIGIN)
      return Response.redirect(target.toString(), 301)
    }

    // Legacy oomnn dashboard/admin → canonical pubilo before any auth work, so
    // cookies and rpID stay anchored on pubilo.com.
    if (OOMNN_DASHBOARD_HOSTS.has(url.hostname) && !isStaticAssetPath(url.pathname)) {
      const target = new URL(url.pathname + url.search, CANONICAL_DASHBOARD_ORIGIN)
      return Response.redirect(target.toString(), 301)
    }
    if (OOMNN_ADMIN_HOSTS.has(url.hostname) && !isStaticAssetPath(url.pathname)) {
      const target = new URL(url.pathname + url.search, CANONICAL_ADMIN_ORIGIN)
      return Response.redirect(target.toString(), 301)
    }

    // Auth endpoints (passkey + session lifecycle). Always available.
    if (url.pathname.startsWith('/auth/')) {
      const res = await dispatchAuth(env, request)
      if (res) return res
      return new Response('not found', { status: 404 })
    }

    // Gating: once any passkey credential exists, dashboard/admin HTML and the
    // /worker-api proxy require an authenticated session. Static assets and the
    // /login flow stay public so first-time setup and asset loading work.
    const isAuthEndpoint = isAuthPath(url.pathname)
    const isStatic = isStaticAssetPath(url.pathname)
    const isWorkerApi = url.pathname.startsWith('/worker-api/')
    if (!isAuthEndpoint && !isStatic) {
      const count = await credentialCount(env).catch(() => 0)
      if (count > 0) {
        const sess = await loadSession(env, request)
        if (!sess) {
          if (isWorkerApi) {
            return new Response(JSON.stringify({ error: 'authentication_required' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            })
          }
          // HTML / SPA navigation → redirect to /login. Only redirect when the
          // browser is asking for a document (GET, accepts text/html); for
          // other methods just return 401 so XHR/fetch callers see it.
          const accept = request.headers.get('accept') || ''
          if (request.method === 'GET' && accept.includes('text/html')) {
            return redirectToLogin(url)
          }
          return new Response('Unauthorized', { status: 401 })
        }
      }
    }

    // Worker API proxy — unchanged behavior aside from the auth gate above.
    if (isWorkerApi) {
      const forceAttachment = shouldForceAttachment(url)
      const filename = sanitizeDownloadFilename(url.searchParams.get('filename'))
      const target = new URL(url.pathname.replace(/^\/worker-api/, '') + url.search, API_ORIGIN)
      target.searchParams.delete('download')
      target.searchParams.delete('filename')

      const headers = new Headers(request.headers)
      headers.delete('host')
      headers.set('x-forwarded-host', url.host)
      headers.set('x-forwarded-proto', url.protocol.replace(':', ''))

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
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      })
    }

    // Legacy /chearb/* redirects on dashboard hosts only.
    if (DASHBOARD_HOSTS.has(url.hostname)) {
      const target = legacyChearbTarget(url.pathname)
      if (target) {
        const redirectUrl = new URL(target + url.search, url)
        return Response.redirect(redirectUrl.toString(), 301)
      }
    }

    // Per-host landing rewrites for www/admin.
    const rewritten = rewriteForHost(url)
    if (rewritten) return env.ASSETS.fetch(rewritten)

    return env.ASSETS.fetch(request)
  },
}
