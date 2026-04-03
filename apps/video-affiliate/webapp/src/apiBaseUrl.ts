const DEFAULT_WORKER_URL = 'https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev'
const OOMNN_API_URL = 'https://api.oomnn.com'

const getCurrentHost = () =>
  typeof window !== 'undefined'
    ? String(window.location.hostname || '').trim().toLowerCase()
    : ''

export const isOomnnHost = (host = getCurrentHost()) => host.endsWith('.oomnn.com')

export function getApiBaseUrl() {
  const envUrl = String(import.meta.env.VITE_WORKER_URL || '').trim().replace(/\/+$/, '')
  if (isOomnnHost()) {
    return OOMNN_API_URL
  }
  return envUrl || DEFAULT_WORKER_URL
}

export const API_BASE_URL = getApiBaseUrl()

export const shouldUseHeaderAuth = (host = getCurrentHost()) => !isOomnnHost(host)
