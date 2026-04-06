const DEFAULT_APP_LIFF_ID = '2009652996-DJtEhoDn'
const DEFAULT_WEB_LIFF_ID = DEFAULT_APP_LIFF_ID

const getCurrentHost = () =>
  typeof window !== 'undefined'
    ? String(window.location.hostname || '').trim().toLowerCase()
    : ''

export const isWebHost = (host = getCurrentHost()) => host.startsWith('web.')
export const isAppHost = (host = getCurrentHost()) => host.startsWith('app.')

export const getAppMainLiffId = () =>
  String(import.meta.env.VITE_LINE_LIFF_ID_APP || DEFAULT_APP_LIFF_ID).trim() || DEFAULT_APP_LIFF_ID

export const getWebMainLiffId = () =>
  String(import.meta.env.VITE_LINE_LIFF_ID_WEB || DEFAULT_WEB_LIFF_ID).trim() || DEFAULT_WEB_LIFF_ID

export const getMainLiffIdForHost = (host = getCurrentHost()) =>
  isWebHost(host) ? getWebMainLiffId() : getAppMainLiffId()

export const getMainLiffUrlForHost = (host = getCurrentHost()) => {
  const liffId = getMainLiffIdForHost(host)
  return liffId ? `https://liff.line.me/${liffId}` : ''
}

export const getMissingMainLiffMessageForHost = (host = getCurrentHost()) =>
  isWebHost(host)
    ? 'ยังไม่ได้ตั้งค่า LINE LIFF สำหรับเว็บ (web.oomnn.com)'
    : 'ยังไม่ได้ตั้งค่า LINE LIFF'

export const getMainLiffInitOptionsForHost = (host = getCurrentHost()) => {
  const liffId = getMainLiffIdForHost(host)
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
