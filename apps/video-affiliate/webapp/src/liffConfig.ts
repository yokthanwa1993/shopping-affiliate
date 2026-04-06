const DEFAULT_APP_LIFF_ID = '2009652996-DJtEhoDn'
const DEFAULT_WEB_LIFF_ID = '2009652996-SPBvE4F4'
const APP_DASHBOARD_LIFF_ID = '2009652996-2SnLQJeD'
const APP_GALLERY_LIFF_ID = '2009652996-OGTCnapx'
const APP_LOGS_LIFF_ID = '2009652996-vBsuawCH'
const APP_SETTINGS_LIFF_ID = '2009652996-PgxNlX5l'
const APP_PROCESSING_LIFF_ID = '2009652996-d9c9yYJ2'

const getCurrentHost = () =>
  typeof window !== 'undefined'
    ? String(window.location.hostname || '').trim().toLowerCase()
    : ''

const getCurrentPathname = () =>
  typeof window !== 'undefined'
    ? String(window.location.pathname || '').trim().toLowerCase()
    : ''

export const isWebHost = (host = getCurrentHost()) => host.startsWith('web.')
export const isAppHost = (host = getCurrentHost()) => host.startsWith('app.')

export const getAppMainLiffId = () =>
  String(import.meta.env.VITE_LINE_LIFF_ID_APP || DEFAULT_APP_LIFF_ID).trim() || DEFAULT_APP_LIFF_ID

export const getWebMainLiffId = () =>
  String(import.meta.env.VITE_LINE_LIFF_ID_WEB || DEFAULT_WEB_LIFF_ID).trim() || DEFAULT_WEB_LIFF_ID

const getAppScopedLiffIdForPath = (pathname = getCurrentPathname()) => {
  const segment = String(pathname || '').trim().replace(/^\/+/, '').split('/')[0] || ''
  if (segment === '' || segment === 'dashboard') return APP_DASHBOARD_LIFF_ID
  if (segment === 'gallery') return APP_GALLERY_LIFF_ID
  if (segment === 'logs') return APP_LOGS_LIFF_ID
  if (segment === 'settings') return APP_SETTINGS_LIFF_ID
  if (segment === 'processing') return APP_PROCESSING_LIFF_ID
  return getAppMainLiffId()
}

export const getMainLiffIdForHost = (host = getCurrentHost(), pathname = getCurrentPathname()) =>
  isWebHost(host) ? getWebMainLiffId() : getAppScopedLiffIdForPath(pathname)

export const getMainLiffUrlForHost = (host = getCurrentHost(), pathname = getCurrentPathname()) => {
  const liffId = getMainLiffIdForHost(host, pathname)
  return liffId ? `https://liff.line.me/${liffId}` : ''
}

export const getMissingMainLiffMessageForHost = (host = getCurrentHost()) =>
  isWebHost(host)
    ? 'ยังไม่ได้ตั้งค่า LINE LIFF สำหรับเว็บ (web.oomnn.com)'
    : 'ยังไม่ได้ตั้งค่า LINE LIFF'

export const getMainLiffInitOptionsForHost = (host = getCurrentHost(), pathname = getCurrentPathname()) => {
  const liffId = getMainLiffIdForHost(host, pathname)
  if (!liffId) return null
  return {
    liffId,
    withLoginOnExternalBrowser: isWebHost(host),
  }
}

export const waitForLiffSdk = (timeoutMs = 5000): Promise<any | null> => {
  if (typeof window === 'undefined') return Promise.resolve(null)
  const existing = (window as any).liff
  if (existing) return Promise.resolve(existing)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const liff = (window as any).liff
      if (liff) {
        window.clearInterval(timer)
        resolve(liff)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        resolve(null)
      }
    }, 80)
  })
}
