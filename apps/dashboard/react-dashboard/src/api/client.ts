// Typed fetch helper for the React preview. Mirrors the contract of
// apps/dashboard/src/lib/api.ts:fetchJson — same `/worker-api` base, the same
// default `x-bot-id` namespace header, and same-origin credentials — so the
// preview talks to the existing worker exactly like the Svelte panels do.

export const WORKER_API_BASE = '/worker-api'

// CHEARB / เฉียบ workspace namespace. The worker's bot-scoping middleware needs
// this header to resolve the right D1 namespace; without it list endpoints
// return empty rows.
export const CHIEB_NAMESPACE_ID = '1774858894802785816'

// Default workspace page (เฉียบ) — used as the page_posts default filter.
export const DEFAULT_PAGE_ID = '1008898512617594'
export const DEFAULT_PAGE_NAME = 'เฉียบ'

// Default Facebook Ads account for the เฉียบ workspace. Mirrors
// apps/dashboard/src/lib/api.ts:DEFAULT_AD_ACCOUNT; campaigns fall back to this
// when settings don't pin an ad_account.
export const DEFAULT_AD_ACCOUNT = 'act_1030797047648459'

export interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function extractErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === 'object' && 'error' in json) {
    const message = (json as Record<string, unknown>).error
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

export async function workerFetchJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timer = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const absolute = isAbsoluteUrl(path)
    const url = absolute ? path : `${WORKER_API_BASE}${path}`
    const headers = new Headers(options.headers ?? {})
    if (!absolute && !headers.has('x-bot-id')) {
      headers.set('x-bot-id', CHIEB_NAMESPACE_ID)
    }
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: controller.signal,
      credentials: absolute ? 'omit' : 'same-origin',
    }
    if (options.body !== undefined && options.body !== null) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    }
    const response = await fetch(url, init)
    const text = await response.text()
    let json: unknown = undefined
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`Response is not JSON (HTTP ${response.status})`)
      }
    }
    if (!response.ok) {
      throw new Error(extractErrorMessage(json, `HTTP ${response.status} ${response.statusText}`))
    }
    return (json ?? {}) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}
