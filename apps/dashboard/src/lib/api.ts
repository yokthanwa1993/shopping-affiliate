export const WORKER_API_BASE = '/worker-api'

export const CHIEB_NAMESPACE_ID = '1774858894802785816'

// Default workspace page (เฉียบ). Used by panels that need a fallback when
// /api/dashboard/facebook-page-sources is unreachable — also the page whose
// settings the dashboard reads/writes. Switching workspaces is not exposed in
// the Astro/Svelte dashboard yet.
export const DEFAULT_PAGE = {
  id: '1008898512617594',
  name: 'เฉียบ',
  slug: 'chearb',
  iconUrl: '/page-icons/chieb.jpg',
}

export const DEFAULT_AD_ACCOUNT = 'act_1030797047648459'

export interface FetchJsonOptions {
  signal?: AbortSignal
  timeoutMs?: number
  method?: string
  body?: BodyInit | null
  headers?: HeadersInit
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export async function fetchJson<T>(path: string, options: FetchJsonOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timer = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const url = isAbsoluteUrl(path) ? path : `${WORKER_API_BASE}${path}`
    // Inbox / processing / post-history all rely on the bot scoping middleware
    // on the worker. Without x-bot-id the worker can't pick the right bot/D1
    // namespace and returns empty rows. Send by default for /worker-api requests
    // and let callers override per-request if they ever need a different bot.
    const sendsBotHeader = !isAbsoluteUrl(path)
    const headers = new Headers(options.headers ?? {})
    if (sendsBotHeader && !headers.has('x-bot-id')) {
      headers.set('x-bot-id', CHIEB_NAMESPACE_ID)
    }
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: controller.signal,
      // /worker-api is same-origin so the pubilo_dashboard_session cookie
      // travels with it. Absolute URLs (rare) are opt-in via the caller.
      credentials: isAbsoluteUrl(path) ? 'omit' : 'same-origin',
    }
    if (options.body !== undefined && options.body !== null) {
      init.body = options.body
      if (!headers.has('Content-Type') && typeof options.body === 'string') {
        headers.set('Content-Type', 'application/json')
      }
    }
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const text = await response.text()
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Response is not JSON (status ${response.status})`)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function formatThaiDateTime(value: string | undefined | null): string {
  if (!value) return ''
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
  const parseable = hasTz ? trimmed : trimmed.replace(' ', 'T') + 'Z'
  const d = new Date(parseable)
  if (Number.isNaN(d.getTime())) return trimmed
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
}

export function formatCompactViews(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

export function todayBangkokDate(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(new Date())
}
