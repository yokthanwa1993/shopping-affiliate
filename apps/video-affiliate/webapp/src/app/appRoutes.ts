export type AppTabRoute = 'dashboard' | 'inbox' | 'processing' | 'gallery' | 'logs' | 'settings'

export const APP_TAB_ROUTES: AppTabRoute[] = ['dashboard', 'inbox', 'processing', 'gallery', 'logs', 'settings']

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

  const liffState = params.get('liff.state')
  const fromLiffState = normalizeAppTabRoute(liffState ? decodeURIComponent(liffState) : '')
  if (fromLiffState !== 'dashboard') {
    try { localStorage.setItem('_liff_tab', fromLiffState) } catch {}
    return fromLiffState
  }

  try {
    const saved = localStorage.getItem('_liff_tab')
    const fromSaved = normalizeAppTabRoute(saved)
    if (fromSaved !== 'dashboard') {
      localStorage.removeItem('_liff_tab')
      return fromSaved
    }
  } catch {}

  return 'dashboard'
}

export function getAppTabRouteFromLocation(pathname: string, search = ''): AppTabRoute {
  const fromPath = normalizeAppTabRoute(pathname)
  if (fromPath !== 'dashboard' || pathname === '/' || pathname === '') return fromPath
  return getAppTabRouteFromSearch(search)
}

export function stripLegacyTabSearchParams(search = '') {
  const params = new URLSearchParams(search)
  params.delete('tab')
  params.delete('liff.state')
  const next = params.toString()
  return next ? `?${next}` : ''
}
