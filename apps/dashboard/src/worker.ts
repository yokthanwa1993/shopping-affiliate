import { Hono } from 'hono'
import {
  authApp,
  credentialCount,
  loadSession,
  type AuthEnv,
} from './server/auth'
import { customlinkApp } from './server/customlink'
import { jsonResponse } from './server/http'
import { workerApiApp } from './server/workerapi'

export interface Env extends AuthEnv {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
}

// The customlink shorten slice (constants, proxy logic and its Zod contract) now
// lives in ./server/customlink as a Hono app; this handler bridges to it. The
// /worker-api/* proxy (constants, attachment helpers and proxy logic) likewise
// lives in ./server/workerapi as a Hono app; the worker still owns the auth gate
// and decides `isWorkerApi` before delegating to it.

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

// ── Dashboard cutover switch (modernization "Cutover") ───────────────────────
// Single control that flips canonical https://www.pubilo.com/dashboard/* between
// the legacy Astro/Svelte pages and the React/Vite SPA. This is the entire
// cutover/rollback lever — no other code path changes when it is toggled.
//
//   false → /dashboard/* serves the existing Astro/Svelte pages (current
//           production behavior; fully reversible default).
//   true  → /dashboard/ and every deep route serve the React SPA shell from
//           dist/dashboard_next/. The Astro pages remain shipped in the bundle,
//           so flipping back to false is an instant rollback, and they also stay
//           reachable under the /dashboard_next/ preview alias.
//
// Paths in ASTRO_PINNED_DASHBOARD_PATHS keep serving the Svelte page even when
// this is true (their write flow is not yet ported to React).
const DASHBOARD_REACT_CUTOVER = true

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
const STATIC_PREFIXES = ['/_astro/', '/page-icons/', '/dashboard_next/assets/']
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

function legacyChearbTarget(pathname: string): string | null {
  if (LEGACY_CHEARB_MAP[pathname]) return LEGACY_CHEARB_MAP[pathname]
  if (pathname === '/chearb' || pathname.startsWith('/chearb/')) return '/'
  return null
}

// Canonical dashboard space lives under https://www.pubilo.com/dashboard/*.
const DASHBOARD_PATH_PREFIX = '/dashboard'

function isDashboardCanonicalPath(pathname: string): boolean {
  return pathname === DASHBOARD_PATH_PREFIX || pathname.startsWith(`${DASHBOARD_PATH_PREFIX}/`)
}

// Sibling preview space for the React/Vite dashboard (modernization Phase 3),
// served from dist/dashboard_next/ as a client-routed SPA. The underscore keeps
// it a distinct prefix from /dashboard, so it never collides with the
// /dashboard/* canonicalization above ('/dashboard_next/'.startsWith('/dashboard/')
// is false).
const DASHBOARD_NEXT_PREFIX = '/dashboard_next'

function isDashboardNextPath(pathname: string): boolean {
  return pathname === DASHBOARD_NEXT_PREFIX || pathname.startsWith(`${DASHBOARD_NEXT_PREFIX}/`)
}

// Public /dashboard/* document paths that must keep serving the Astro/Svelte
// page even after DASHBOARD_REACT_CUTOVER is on, because their behavior is not
// yet ported to React. Matched on the public path BEFORE the /dashboard →
// asset-path rewrite. Add a path here to roll a single page back to Astro
// without touching the global cutover flag.
//
// Create Ads was previously pinned on the assumption it was a multi-step WRITE
// flow. The Svelte CreateAdsPanel is in fact read-only (it lists ready gallery
// clips + high-view page posts and copies a System Video ID to the clipboard;
// it never POSTs an ad-creation job — the enqueue happens from the Page Posts /
// Gallery actions and the external ad tool). The React Create Ads route now
// ports that read-only panel at parity using the same GET endpoints, so the pin
// is no longer needed. Re-add the regex below to roll back instantly.
const ASTRO_PINNED_DASHBOARD_PATHS: RegExp[] = []

function isAstroPinnedDashboardPath(pathname: string): boolean {
  return ASTRO_PINNED_DASHBOARD_PATHS.some((re) => re.test(pathname))
}

// Map a public /dashboard/* path to the underlying Astro asset path so we can
// serve existing pages without duplicating static output. Underscore aliases
// map to existing kebab pages: /dashboard/custom_link → /custom-link, and
// /dashboard/page_posts (the canonical Page Posts URL) → /page-posts. The kebab
// form /dashboard/page-posts still serves the same asset for backwards compat.
function dashboardAssetPath(pathname: string): string {
  let rest = pathname === DASHBOARD_PATH_PREFIX ? '' : pathname.slice(DASHBOARD_PATH_PREFIX.length)
  if (rest === '' || rest === '/') return '/'
  rest = rest.replace(/^\/custom_link(\/|$)/, '/custom-link$1')
  rest = rest.replace(/^\/page_posts(\/|$)/, '/page-posts$1')
  // Astro emits each page as a directory (dist/<page>/index.html), so serve the
  // trailing-slash form. Returning the bare path makes the asset handler answer
  // with a 307 to /<page>/, bouncing the visitor out of the /dashboard space.
  if (!rest.endsWith('/')) rest += '/'
  return rest
}

// Map a legacy dashboard-host path to its canonical /dashboard/* path.
// Idempotent: paths already under /dashboard are returned unchanged so a
// double prefix can never form.
function legacyDashboardCanonicalPath(pathname: string): string {
  if (isDashboardCanonicalPath(pathname)) return pathname
  if (pathname === '/' || pathname === '') return `${DASHBOARD_PATH_PREFIX}/`
  // Page Posts canonical lives under the underscore alias, so legacy kebab
  // (and bare underscore) variants land directly on /dashboard/page_posts/.
  if (pathname === '/page-posts' || pathname === '/page-posts/' ||
      pathname === '/page_posts' || pathname === '/page_posts/') {
    return `${DASHBOARD_PATH_PREFIX}/page_posts/`
  }
  return `${DASHBOARD_PATH_PREFIX}${pathname}`
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

function redirectToLogin(url: URL, dashboardCanonical = false): Response {
  // When the request came in under /dashboard/*, keep the login round-trip in
  // that space so the post-auth `next` redirect stays canonical.
  const base = dashboardCanonical ? DASHBOARD_PATH_PREFIX : ''
  const loginPath = `${base}/login`
  const next = `${base}${url.pathname}${url.search}`
  const target = new URL(loginPath, url)
  if (next && next !== `${base}/` && next !== loginPath) target.searchParams.set('next', next)
  return Response.redirect(target.toString(), 302)
}

// ── Phase 8 final: top-level dispatch unified onto Hono ───────────────────────
// `dispatch()` is the previous raw Worker `fetch` handler body, kept verbatim. It
// still owns the entire control flow — host routing, apex/legacy redirects,
// dashboard canonicalization + React cutover, the /dashboard_next preview, the
// shared auth gate, the customlink / auth / worker-api Hono bridges, host landing
// rewrites and the final asset serving. Nothing about the routing decisions or
// external behavior changes here.
//
// The only structural change is the entry point: the worker is now a top-level
// `Hono<{ Bindings: Env }>` app (`export default app` at the bottom) that funnels
// every method + path into `dispatch` via one catch-all `app.all('*', …)`,
// completing the Phase 8 migration of the worker onto Hono after the customlink,
// /auth/* and /worker-api/* slices. Rollback is a one-liner: swap the export for
// `export default { fetch: dispatch }` to restore the plain Workers handler.
async function dispatch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Canonical customlink shorten alias under the /dashboard space. Computed
    // before the /dashboard → asset-path rewrite below so it still matches after
    // the public path is stripped.
    const isCanonicalCustomlinkApi =
      url.pathname === '/dashboard/api/custom-link/shorten' ||
      url.pathname === '/dashboard/api/custom-link/shorten/'

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

    // Canonical dashboard space: www.pubilo.com/dashboard/* serves the existing
    // dashboard pages without duplicate static output. Rewrite the public path
    // to its underlying asset path up front so auth gating, the /login flow and
    // asset serving below all operate on the real page path. Static assets
    // (/_astro, etc.) and the API proxies stay at the host root and are never
    // under /dashboard, so they are unaffected.
    // Canonicalize the legacy kebab Page Posts path to the underscore form
    // (/dashboard/page-posts/ → /dashboard/page_posts/) before the asset-path
    // rewrite, so the public URL stays single and canonical.
    if (WWW_HOSTS.has(url.hostname) && /^\/dashboard\/page-posts\/?$/.test(url.pathname)) {
      const target = new URL(`/dashboard/page_posts/${url.search}`, url)
      return Response.redirect(target.toString(), 301)
    }

    // When the cutover switch is on, canonical /dashboard/* document routes are
    // served by the React SPA instead of the Astro asset. Decide this on the
    // PUBLIC path here — before dashboardAssetPath() rewrites url.pathname below
    // and before the shared auth gate runs (so the SPA is gated identically to
    // the Astro pages). Pinned paths (write flows) stay on Astro.
    let dashboardCanonical = false
    let dashboardServeReact = false
    if (WWW_HOSTS.has(url.hostname) && isDashboardCanonicalPath(url.pathname)) {
      dashboardCanonical = true
      dashboardServeReact = DASHBOARD_REACT_CUTOVER && !isAstroPinnedDashboardPath(url.pathname)
      url.pathname = dashboardAssetPath(url.pathname)
    }

    // React preview SPA space (/dashboard_next/*) on the canonical www host.
    // Unlike /dashboard/* we do NOT rewrite the path here: hashed assets are
    // served as-is and document/deep routes are mapped to the SPA index at the
    // asset-serving step below — after the shared auth gate, so the preview is
    // gated exactly like the canonical dashboard.
    const dashboardNext = WWW_HOSTS.has(url.hostname) && isDashboardNextPath(url.pathname)

    // Auth endpoints (passkey + session lifecycle). Always available. Routing now
    // lives in the Hono `authApp` (./server/auth) — same bridge pattern as the
    // customlink slice; the worker still owns everything around it. authApp always
    // returns a Response (its notFound handler yields the same `not found` 404 for
    // unknown /auth/* paths or wrong methods, matching the previous dispatch).
    if (url.pathname.startsWith('/auth/')) {
      return authApp.fetch(request, env)
    }

    // Legacy dashboard host → canonical www, handled before auth gating so legacy
    // document navigations land on the canonical /dashboard/* origin first.
    if (DASHBOARD_HOSTS.has(url.hostname)) {
      // /chearb/* compatibility runs first so it keeps its legacy targets rather
      // than being swept into /dashboard/chearb by the generic redirect below.
      const chearbTarget = legacyChearbTarget(url.pathname)
      if (chearbTarget) {
        const redirectUrl = new URL(chearbTarget + url.search, url)
        return Response.redirect(redirectUrl.toString(), 301)
      }

      // GET/HEAD document routes → https://www.pubilo.com/dashboard/*. Static
      // assets, the /auth + /login flow, and the /worker-api + /customlink-api
      // proxies are excluded so POST/API clients keep working same-origin.
      if (
        ['GET', 'HEAD'].includes(request.method.toUpperCase()) &&
        !isStaticAssetPath(url.pathname) &&
        !isAuthPath(url.pathname) &&
        !url.pathname.startsWith('/auth/') &&
        !url.pathname.startsWith('/worker-api/') &&
        !url.pathname.startsWith('/customlink-api/')
      ) {
        const canonicalPath = legacyDashboardCanonicalPath(url.pathname)
        const target = new URL(canonicalPath + url.search, CANONICAL_WWW_ORIGIN)
        return Response.redirect(target.toString(), 301)
      }
    }

    // Gating: once any passkey credential exists, dashboard/admin HTML and the
    // /worker-api proxy require an authenticated session. Static assets and the
    // /login flow stay public so first-time setup and asset loading work.
    const isAuthEndpoint = isAuthPath(url.pathname)
    const isStatic = isStaticAssetPath(url.pathname)
    const isWorkerApi = url.pathname.startsWith('/worker-api/')
    const isCustomlinkApi = url.pathname.startsWith('/customlink-api/')
    if (!isAuthEndpoint && !isStatic) {
      const count = await credentialCount(env).catch(() => 0)
      if (count > 0) {
        const sess = await loadSession(env, request)
        if (!sess) {
          if (isWorkerApi || isCustomlinkApi || isCanonicalCustomlinkApi) {
            return jsonResponse({ error: 'authentication_required' }, 401)
          }
          // HTML / SPA navigation → redirect to /login. Only redirect when the
          // browser is asking for a document (GET, accepts text/html); for
          // other methods just return 401 so XHR/fetch callers see it.
          const accept = request.headers.get('accept') || ''
          if (request.method === 'GET' && accept.includes('text/html')) {
            return redirectToLogin(url, dashboardCanonical)
          }
          return new Response('Unauthorized', { status: 401 })
        }
      }
    }

    if (
      url.pathname === '/customlink-api/shorten' ||
      url.pathname === '/customlink-api/shorten/' ||
      isCanonicalCustomlinkApi
    ) {
      // Bridge every public shorten alias onto the Hono app's single canonical
      // /shorten route. The worker keeps owning routing/auth above; Hono + Zod
      // own the request/response contract. Preserve the original method and body
      // so the 405 (non-POST) and JSON-body paths behave exactly as before.
      const bridged = new Request(new URL('/shorten', url).toString(), request)
      return customlinkApp.fetch(bridged, env)
    }

    // Worker API proxy — unchanged behavior aside from the auth gate above.
    // Routing now lives in the Hono `workerApiApp` (./server/workerapi) — same
    // bridge pattern as the customlink and /auth/* slices. The worker still owns
    // the auth gate and `isWorkerApi` decision above; the original request (with
    // its /worker-api/* public path, method and body) is delegated unchanged, so
    // the upstream mapping, attachment handling and header forwarding behave
    // exactly as before.
    if (isWorkerApi) {
      return workerApiApp.fetch(request, env)
    }

    // React preview SPA: serve dist/dashboard_next/index.html for the entry and
    // every deep client route (TanStack Router resolves them in the browser).
    // Hashed assets under /dashboard_next/assets/* match isStaticAssetPath and
    // are served directly by the fallthrough below; the shared auth gate above
    // has already run, so this only serves the shell to allowed sessions.
    if (
      dashboardNext &&
      !isStatic &&
      ['GET', 'HEAD'].includes(request.method.toUpperCase())
    ) {
      // Fetch the CLEAN directory URL, not /dashboard_next/index.html: the
      // Assets layer auto-redirects "*/index.html" to the clean URL (307), which
      // would otherwise bounce deep routes back to /dashboard_next/ in a loop.
      // The clean dir URL resolves to dist/dashboard_next/index.html with 200,
      // and the browser keeps its deep-route URL for TanStack Router to resolve.
      const shellUrl = new URL(`${DASHBOARD_NEXT_PREFIX}/`, url)
      return env.ASSETS.fetch(new Request(shellUrl.toString(), request))
    }

    // Cutover: serve the React SPA shell for canonical /dashboard/* document
    // routes, exactly like the /dashboard_next preview block above. The shared
    // auth gate has already run and static assets were excluded, so only allowed
    // sessions reach here. Deep routes keep their /dashboard/* URL for TanStack
    // Router (its basepath adapts to the /dashboard mount). Rollback is a
    // one-line flip of DASHBOARD_REACT_CUTOVER back to false.
    if (
      dashboardServeReact &&
      !isStatic &&
      ['GET', 'HEAD'].includes(request.method.toUpperCase())
    ) {
      const shellUrl = new URL(`${DASHBOARD_NEXT_PREFIX}/`, url)
      return env.ASSETS.fetch(new Request(shellUrl.toString(), request))
    }

    // Per-host landing rewrites for www/admin. Skipped inside the canonical
    // dashboard space so /dashboard/ resolves to the dashboard index ('/')
    // instead of the www marketing landing.
    if (!dashboardCanonical) {
      const rewritten = rewriteForHost(url)
      if (rewritten) return env.ASSETS.fetch(rewritten)
    }

    // Serve the (possibly rewritten) path. For canonical dashboard requests the
    // URL pathname was rewritten above, so rebuild the request against it.
    if (dashboardCanonical) {
      return env.ASSETS.fetch(new Request(url.toString(), request))
    }
    return env.ASSETS.fetch(request)
}

// Top-level Hono app — the unified Phase 8 entry point. The single catch-all
// hands every request to `dispatch`: `c.req.raw` is the original, unmodified
// Request (so `new URL(...)`, the body stream and headers behave exactly as the
// previous raw handler), and `c.env` is the Workers env (typed via Bindings).
// This mirrors the "one fetch handler owns everything" shape, now expressed as a
// Hono app so future per-route middleware can attach without another rewrite.
const app = new Hono<{ Bindings: Env }>()

app.all('*', (c) => dispatch(c.req.raw, c.env))

export default app
