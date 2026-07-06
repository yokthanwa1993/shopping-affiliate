const DEFAULT_WORKER_URL = 'https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev'
const PUBLIC_API_URL = 'https://api.oomnn.com'

const getCurrentHost = () =>
  typeof window !== 'undefined'
    ? String(window.location.hostname || '').trim().toLowerCase()
    : ''

// Public webapp hosts that route to the production worker API.
// Both pubilo.com (new canonical) and oomnn.com (legacy, still routed during
// cutover) qualify.
export const isPublicWebappHost = (host = getCurrentHost()) =>
  host.endsWith('.pubilo.com') || host.endsWith('.oomnn.com')

export function getApiBaseUrl() {
  const envUrl = String(import.meta.env.VITE_WORKER_URL || '').trim().replace(/\/+$/, '')
  if (isPublicWebappHost()) {
    return PUBLIC_API_URL
  }
  return envUrl || DEFAULT_WORKER_URL
}

export const API_BASE_URL = getApiBaseUrl()

export const shouldUseHeaderAuth = (host = getCurrentHost()) => !isPublicWebappHost(host)
