export type AppTabRoute = 'dashboard' | 'inbox' | 'processing' | 'gallery' | 'logs' | 'settings'

export const APP_TAB_ROUTES: AppTabRoute[] = ['dashboard', 'inbox', 'processing', 'gallery', 'logs', 'settings']

function decodeLiffStateUrl(liffState?: string | null) {
  const raw = String(liffState || '').trim()
  if (!raw) return null
  try {
    const decoded = decodeURIComponent(raw)
    const normalized = decoded.startsWith('/')
      ? `https://liff.local${decoded}`
      : `https://liff.local/${decoded}`
    return new URL(normalized)
  } catch {
    return null
  }
}

export function normalizeAppTabRoute(value?: string | null): AppTabRoute {
  const raw = String(value || '').trim().replace(/^\/+/, '').split('/').filter(Boolean)[0] || ''
  if (raw === 'pages') return 'settings'
  if (APP_TAB_ROUTES.includes(raw as AppTabRoute)) return raw as AppTabRoute
  return 'dashboard'
}

export function getAppTabPath(tab: AppTabRoute) {
  return tab === 'dashboard' ? '/' : `/${tab}`
}

export function getAppTabRouteFromSearch(search = ''): AppTabRoute {
  const params = new URLSearchParams(search)
  const fromParam = normalizeAppTabRoute(params.get('tab'))
  if (fromParam !== 'dashboard') return fromParam

  const liffStateUrl = decodeLiffStateUrl(params.get('liff.state'))
  const fromLiffState = normalizeAppTabRoute(liffStateUrl?.pathname || '')
  if (fromLiffState !== 'dashboard') return fromLiffState

  return 'dashboard'
}

export function getMergedSearchParams(search = '') {
  const params = new URLSearchParams(search)
  const liffStateUrl = decodeLiffStateUrl(params.get('liff.state'))
  if (liffStateUrl) {
    liffStateUrl.searchParams.forEach((value, key) => {
      if (!params.has(key)) {
        params.set(key, value)
      }
    })
  }
  return params
}

export function getInviteNamespaceFromSearch(search = '') {
  return String(getMergedSearchParams(search).get('invite') || '').trim()
}
export function getAppTabRouteFromLocation(pathname: string, search = ''): AppTabRoute {
  const fromPath = normalizeAppTabRoute(pathname)
  if (fromPath !== 'dashboard' || pathname === '/' || pathname === '') return fromPath
  return getAppTabRouteFromSearch(search)
}

export function stripLegacyTabSearchParams(search = '') {
  const params = getMergedSearchParams(search)
  params.delete('tab')
  params.delete('liff.state')
  const next = params.toString()
  return next ? `?${next}` : ''
}
