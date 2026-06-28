// Client for the local Mac "Accounts Bridge" (apps/facebook-token-cloak), the token pool that
// manages Facebook Lite (posting) / Power Editor (ads) accounts on this machine. The dashboard runs
// on https://www.pubilo.com but this bridge listens on loopback only — browsers permit fetches to
// http://127.0.0.1 from an https page (the loopback carve-out in the mixed-content spec), and the
// bridge echoes our origin back via its narrow CORS allowlist for the safe accounts endpoints.
//
// SAFETY: this client only ever touches the token-free read/open/close endpoints, and the adapter
// below strips any raw secret-ish field (token/cookie/password/secret/datr/dtsg) by key name before
// the value reaches React. Readiness *booleans* (credentialPresent, datrPresent, …) are preserved —
// the bridge already returns presence flags, never the secrets themselves.

// Default to the documented loopback address; allow a build-time override for local dev setups.
export const ACCOUNTS_BRIDGE_BASE =
  (import.meta.env.VITE_ACCOUNTS_BRIDGE_URL as string | undefined)?.replace(/\/+$/, '') ||
  'http://127.0.0.1:8820'

// A key whose name contains any of these is treated as a raw secret and dropped from any response
// before it is rendered or stored — defence in depth on top of the bridge's own redaction. Note we
// only drop NON-boolean values: presence flags like `datrPresent: false` are safe readiness signals.
const SECRET_KEY_RE = /token|cookie|password|secret|datr|dtsg/i

function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      // Keep boolean readiness flags (…Present) even if the key matches; drop raw secret values.
      if (SECRET_KEY_RE.test(key) && typeof raw !== 'boolean') continue
      out[key] = stripSecrets(raw)
    }
    return out as T
  }
  return value
}

// Thrown when the local bridge cannot be reached at all (process not running, port closed, blocked).
// Callers render this as the "Offline" state rather than a hard error.
export class BridgeOfflineError extends Error {
  constructor(message = 'Accounts Bridge is offline') {
    super(message)
    this.name = 'BridgeOfflineError'
  }
}

interface BridgeRequestOptions {
  method?: string
  searchParams?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

async function bridgeFetch<T>(path: string, options: BridgeRequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000)
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const url = new URL(`${ACCOUNTS_BRIDGE_BASE}${path}`)
  for (const [key, val] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, val)
  }
  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      // No cookies/credentials — the bridge is token-free and CORS is non-credentialed.
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch {
    // Network-level failure (offline, refused, aborted) — the bridge is unreachable.
    throw new BridgeOfflineError()
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let json: unknown = undefined
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`Accounts Bridge returned non-JSON (HTTP ${response.status})`)
    }
  }
  if (!response.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json
        ? String((json as Record<string, unknown>).error)
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return stripSecrets((json ?? {}) as T)
}

// ── Public, sanitized response shapes (booleans + non-secret identifiers only) ──────────────────

export interface BridgeHealth {
  ok: boolean
  app: string
  host: string
  port: number
  backend: string
  keychainSupported: boolean
}

export interface BridgeAccount {
  account: string
  key: string
  displayName: string | null
  provider: string
  domain: string | null
  convertTokenMode: string
  inRegistry: boolean
  credentialPresent: boolean
  usernamePresent: boolean
  passwordPresent: boolean
  totpPresent: boolean
  datrPresent: boolean
  selectorPresent: boolean
  usernameHintPresent: boolean
}

export interface BridgeProfileStatus {
  account: string
  key: string
  profileDir: string
  profileExists: boolean
  running: boolean
  bridgeSession: boolean
  visibleSession: boolean
  lockPidPresent: boolean
  pidCount: number
  statusKnown: boolean
}

export interface BridgeStatusSummary {
  app: string
  facebook: {
    accountsCount: number
    roles: Record<string, unknown>
  }
  note?: string
}

export function fetchBridgeHealth(signal?: AbortSignal): Promise<BridgeHealth> {
  return bridgeFetch<BridgeHealth>('/health', { signal })
}

export async function fetchBridgeAccounts(signal?: AbortSignal): Promise<BridgeAccount[]> {
  const data = await bridgeFetch<{ accounts?: BridgeAccount[] }>('/accounts', { signal })
  return data.accounts ?? []
}

export function fetchBridgeStatus(signal?: AbortSignal): Promise<BridgeStatusSummary> {
  return bridgeFetch<BridgeStatusSummary>('/accounts/bridge/status', { signal })
}

export async function fetchProfileStatus(uid: string, signal?: AbortSignal): Promise<BridgeProfileStatus> {
  const data = await bridgeFetch<{ profile?: BridgeProfileStatus }>('/accounts/profile-status', {
    searchParams: { account: uid },
    signal,
  })
  if (!data.profile) throw new Error('Profile status unavailable')
  return data.profile
}

// User-triggered safe open: a VISIBLE browser session with autofill + submit explicitly off, so the
// operator can SEE which account is logged in without the bridge ever reading a credential, submitting
// a login, or minting a token.
export function openSafeSession(uid: string, signal?: AbortSignal): Promise<unknown> {
  return bridgeFetch<unknown>('/login', {
    searchParams: { account: uid, visible: '1', autofill: '0', submit: '0' },
    timeoutMs: 30000,
    signal,
  })
}

export function closeSession(uid: string, signal?: AbortSignal): Promise<unknown> {
  return bridgeFetch<unknown>('/login/close', {
    searchParams: { account: uid },
    timeoutMs: 15000,
    signal,
  })
}
