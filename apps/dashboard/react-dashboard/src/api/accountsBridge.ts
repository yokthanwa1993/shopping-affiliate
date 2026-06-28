// Client for the CLOUD Accounts Bridge, reached SAME-ORIGIN through the dashboard worker proxy at
// /accounts-bridge/* (apps/dashboard/src/server/accountsbridge.ts). The proxy injects the shared API
// key server-side and forwards to the Accounts Bridge Worker (apps/accounts-bridge/worker), so this
// page works from ANY machine — not only the Mac running the local bridge on loopback.
//
// The browser never talks to http://127.0.0.1:8820 anymore and never sees the API key. This file
// only touches token-free read endpoints plus the non-secret command queue (enqueue/list), and the
// adapter below strips any secret-shaped field by key name as defence in depth on top of the proxy +
// worker redaction.

// Same-origin proxy base. No localhost fallback: when the cloud worker URL is not configured the
// proxy returns 503 cloud_bridge_not_configured and the UI shows a clear "not configured" message.
export const ACCOUNTS_BRIDGE_BASE = '/accounts-bridge'

const SECRET_KEY_RE = /token|cookie|password|secret|datr|dtsg/i

function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key) && typeof raw !== 'boolean') continue
      out[key] = stripSecrets(raw)
    }
    return out as T
  }
  return value
}

// The cloud worker proxy is reachable but the cloud bridge URL is not configured server-side. The UI
// renders this distinctly from a transport failure — it is an operator/config problem, not "offline".
export class CloudNotConfiguredError extends Error {
  constructor(message = 'Cloud bridge not configured') {
    super(message)
    this.name = 'CloudNotConfiguredError'
  }
}

// Thrown when the cloud bridge cannot be reached at all (proxy 502 / network failure). The UI renders
// this as the cloud-connectivity "Offline" state.
export class BridgeOfflineError extends Error {
  constructor(message = 'Cloud Accounts Bridge is unreachable') {
    super(message)
    this.name = 'BridgeOfflineError'
  }
}

interface BridgeRequestOptions {
  method?: string
  body?: unknown
  searchParams?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

async function bridgeFetch<T>(path: string, options: BridgeRequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000)
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const url = new URL(`${ACCOUNTS_BRIDGE_BASE}${path}`, window.location.origin)
  for (const [key, val] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, val)
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined
  if (options.body !== undefined && options.body !== null) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    headers['Content-Type'] = 'application/json'
  }
  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      // Same-origin so the dashboard session cookie authenticates the proxy hop.
      credentials: 'same-origin',
      headers,
      body,
      signal: controller.signal,
    })
  } catch {
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
  const errorCode =
    json && typeof json === 'object' && 'error' in json ? String((json as Record<string, unknown>).error) : null
  if (response.status === 503 && (errorCode === 'cloud_bridge_not_configured' || errorCode === 'remote_browser_not_configured')) {
    throw new CloudNotConfiguredError(
      errorCode === 'remote_browser_not_configured' ? 'Cloud Browser bridge not configured' : undefined,
    )
  }
  if (
    response.status === 502 ||
    errorCode === 'cloud_bridge_unreachable' ||
    errorCode === 'cloud_bridge_bad_response' ||
    errorCode === 'remote_browser_unreachable' ||
    errorCode === 'remote_browser_bad_response'
  ) {
    throw new BridgeOfflineError()
  }
  if (!response.ok) {
    throw new Error(errorCode || `HTTP ${response.status}`)
  }
  return stripSecrets((json ?? {}) as T)
}

// ── Public, sanitized cloud shapes ──────────────────────────────────────────────────────────────

export interface CloudHealth {
  ok: boolean
  service: string
  api: string
}

// Which sensitive fields are STORED (write-only vault). The raw values never reach the browser.
export interface CredentialPresence {
  password: boolean
  datr_cookie: boolean
  totp_secret: boolean
  proxy_url: boolean
}

export type AccountTag = 'post' | 'comment' | 'mobile'

export interface CloudAccount {
  account_uid: string
  platform: string
  display_label: string | null
  // Non-secret operator metadata (never cookies/tokens/passwords/datr/fb_dtsg/sessions).
  notes: string | null
  tags: string[]
  tag: AccountTag | string | null
  page_label: string | null
  account_role: string | null
  homepage_url: string | null
  email: string | null
  preferred_agent_id: string | null
  status: string
  // Avatar pointer/flag — bytes are streamed from the avatar endpoint, never inlined here.
  avatar_present: boolean
  avatar_mime?: string | null
  avatar_updated_at?: string | null
  // Presence-only view of the encrypted credential vault + a host-only (credential-free) proxy hint.
  credential_presence: CredentialPresence
  proxy_host_hint: string | null
  created_at?: string
  updated_at?: string
}

// Input shape for create/update. Identity (account_uid/platform) is only set on create.
export interface CloudAccountInput {
  account_uid?: string
  platform?: string
  display_label?: string | null
  notes?: string | null
  tags?: string[] | string | null
  tag?: AccountTag | string | null
  page_label?: string | null
  account_role?: string | null
  homepage_url?: string | null
  email?: string | null
  preferred_agent_id?: string | null
  status?: string | null
}

// Write-only credential input. Each value is sent UP only; a blank/omitted field keeps the existing
// stored value, and `clear_<field>: true` removes it. No raw value ever comes back.
export interface CredentialInput {
  password?: string
  datr_cookie?: string
  totp_secret?: string
  proxy_url?: string
  clear_password?: boolean
  clear_datr_cookie?: boolean
  clear_totp_secret?: boolean
  clear_proxy_url?: boolean
}

// account_uid is a numeric platform UID (5–32 digits). The server is the source of truth, but we
// validate client-side too so the form can give immediate Thai feedback before any round-trip.
export function isValidAccountUid(uid: string): boolean {
  return /^[0-9]{5,32}$/.test(uid.trim())
}

export type AgentStatus = 'online' | 'idle' | 'busy' | 'error' | 'offline'

export interface CloudAgent {
  agent_id: string
  label: string | null
  status: AgentStatus
  detail: Record<string, unknown> | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export type CommandAction = 'open_profile' | 'close_profile' | 'sync_accounts' | 'status'
export type CommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface CloudCommand {
  id: string
  agent_id: string
  action: CommandAction
  account_uid: string | null
  status: CommandStatus
  error_code: string | null
  error_message: string | null
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export function fetchCloudHealth(signal?: AbortSignal): Promise<CloudHealth> {
  return bridgeFetch<CloudHealth>('/health', { signal })
}

export async function fetchCloudAccounts(signal?: AbortSignal, includeArchived = false): Promise<CloudAccount[]> {
  const searchParams: Record<string, string> = { platform: 'facebook' }
  if (includeArchived) searchParams.include_archived = '1'
  const data = await bridgeFetch<{ accounts?: CloudAccount[] }>('/accounts', { searchParams, signal })
  return data.accounts ?? []
}

// Create a new cloud account (non-secret metadata only). The dashboard proxy injects the API key
// server-side; this never holds it. Returns the created (or pre-existing) public account.
export async function createCloudAccount(input: CloudAccountInput): Promise<{ account: CloudAccount; created: boolean }> {
  const body: CloudAccountInput = { platform: 'facebook', ...input }
  const data = await bridgeFetch<{ account: CloudAccount; created: boolean }>('/accounts', {
    method: 'POST',
    body,
    timeoutMs: 15000,
  })
  return data
}

// Update mutable metadata/status on an existing account. account_uid/platform are immutable identity.
export async function updateCloudAccount(
  platform: string,
  accountUid: string,
  patch: CloudAccountInput,
): Promise<CloudAccount> {
  const data = await bridgeFetch<{ account: CloudAccount }>(`/accounts/${platform}/${accountUid}`, {
    method: 'PATCH',
    body: patch,
    timeoutMs: 15000,
  })
  return data.account
}

// Soft-archive an account (status='archived'). NEVER deletes the account or any sealed session/cookie/
// profile archive — those keep their own lifecycle. Returns the archived public account.
export async function archiveCloudAccount(platform: string, accountUid: string): Promise<CloudAccount> {
  const data = await bridgeFetch<{ account: CloudAccount; archived: boolean }>(`/accounts/${platform}/${accountUid}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  })
  return data.account
}

// Save sensitive credentials into the WRITE-ONLY vault. Returns presence flags only — never the raw
// values. Blank fields are left untouched server-side; pass clear_<field> to remove one.
export async function putAccountCredentials(
  platform: string,
  accountUid: string,
  input: CredentialInput,
): Promise<{ credential_presence: CredentialPresence; proxy_host_hint: string | null }> {
  return bridgeFetch<{ credential_presence: CredentialPresence; proxy_host_hint: string | null }>(
    `/accounts/${platform}/${accountUid}/credentials`,
    { method: 'PUT', body: input, timeoutMs: 15000 },
  )
}

// Same-origin URL for an account's avatar image. Cache-busted by avatar_updated_at so a freshly
// uploaded image shows immediately. Returns null when no avatar is stored.
export function accountAvatarUrl(account: Pick<CloudAccount, 'platform' | 'account_uid' | 'avatar_present' | 'avatar_updated_at'>): string | null {
  if (!account.avatar_present) return null
  const v = account.avatar_updated_at ? `?v=${encodeURIComponent(account.avatar_updated_at)}` : ''
  return `${ACCOUNTS_BRIDGE_BASE}/accounts/${account.platform}/${account.account_uid}/avatar${v}`
}

// Upload an avatar image (png/jpeg/webp, ≤2MB) via multipart FormData. The browser sets the multipart
// boundary; the dashboard proxy forwards the bytes verbatim. Returns the updated account.
export async function uploadAccountAvatar(platform: string, accountUid: string, file: File): Promise<CloudAccount> {
  const form = new FormData()
  form.append('file', file)
  const url = new URL(`${ACCOUNTS_BRIDGE_BASE}/accounts/${platform}/${accountUid}/avatar`, window.location.origin)
  let response: Response
  try {
    response = await fetch(url.toString(), { method: 'POST', credentials: 'same-origin', body: form })
  } catch {
    throw new BridgeOfflineError()
  }
  const text = await response.text()
  let json: unknown = undefined
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`Avatar upload returned non-JSON (HTTP ${response.status})`)
    }
  }
  const errorCode =
    json && typeof json === 'object' && 'error' in json ? String((json as Record<string, unknown>).error) : null
  if (response.status === 503 && errorCode === 'cloud_bridge_not_configured') throw new CloudNotConfiguredError()
  if (response.status === 502 || errorCode === 'cloud_bridge_unreachable') throw new BridgeOfflineError()
  if (!response.ok) throw new Error(errorCode || `HTTP ${response.status}`)
  return (json as { account: CloudAccount }).account
}

// Remove an account's avatar. Returns the updated account.
export async function deleteAccountAvatar(platform: string, accountUid: string): Promise<CloudAccount> {
  const data = await bridgeFetch<{ account: CloudAccount }>(`/accounts/${platform}/${accountUid}/avatar`, {
    method: 'DELETE',
    timeoutMs: 15000,
  })
  return data.account
}

export async function fetchCloudAgents(signal?: AbortSignal): Promise<CloudAgent[]> {
  const data = await bridgeFetch<{ agents?: CloudAgent[] }>('/agents', { signal })
  return data.agents ?? []
}

export async function fetchCloudCommands(agentId?: string, limit = 20, signal?: AbortSignal): Promise<CloudCommand[]> {
  const searchParams: Record<string, string> = { limit: String(limit) }
  if (agentId) searchParams.agent_id = agentId
  const data = await bridgeFetch<{ commands?: CloudCommand[] }>('/commands', { searchParams, signal })
  return data.commands ?? []
}

export async function enqueueCommand(input: {
  agent_id: string
  action: CommandAction
  account_uid?: string
}): Promise<CloudCommand> {
  const data = await bridgeFetch<{ command: CloudCommand }>('/commands', { method: 'POST', body: input, timeoutMs: 15000 })
  return data.command
}

// "Open on Mac": enqueue an open_profile command. The Mac agent opens a VISIBLE Facebook Lite window
// with autofill + submit OFF — no credential is read, no login is submitted, no token is minted.
export function openOnMac(agentId: string, accountUid: string): Promise<CloudCommand> {
  return enqueueCommand({ agent_id: agentId, action: 'open_profile', account_uid: accountUid })
}

// "Close on Mac": enqueue a close_profile command.
export function closeOnMac(agentId: string, accountUid: string): Promise<CloudCommand> {
  return enqueueCommand({ agent_id: agentId, action: 'close_profile', account_uid: accountUid })
}

// ── Cloud Browser (remote browser) ───────────────────────────────────────────────────────────────
// Open + stream + drive a single visible page on the Mac's persistent profile from a dashboard tab.
// The screenshot is loaded via <img> (same-origin URL); start/status/input/stop are JSON. None of
// these carry a secret — status exposes only id/url/title/status/viewport, screenshot is a JPEG frame.

export type RemoteBrowserStatus = 'running' | 'closing' | 'closed'

export interface RemoteBrowserSession {
  id: string
  account_uid: string
  url: string | null
  title: string | null
  status: RemoteBrowserStatus
  viewport: { width: number; height: number } | null
  started_at?: string
}

// The fixed, validated input vocabulary mirrored from the Mac bridge — NO eval/script action exists.
export type RemoteBrowserAction = 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'back' | 'forward' | 'reload'

export interface RemoteBrowserInputPayload {
  x?: number
  y?: number
  text?: string
  key?: string
  deltaX?: number
  deltaY?: number
  url?: string
}

// Start a Cloud Browser session for an account. Returns the session handle (unguessable id) + initial
// status. The dashboard then opens /accounts/browser/:id which streams the screenshot and relays input.
export async function startRemoteBrowser(accountUid: string, initialUrl?: string): Promise<RemoteBrowserSession> {
  const body: { account_uid: string; initial_url?: string } = { account_uid: accountUid }
  if (initialUrl) body.initial_url = initialUrl
  const data = await bridgeFetch<{ session: RemoteBrowserSession }>('/remote-browser/start', {
    method: 'POST',
    body,
    timeoutMs: 30000,
  })
  return data.session
}

export async function getRemoteBrowserStatus(sessionId: string, signal?: AbortSignal): Promise<RemoteBrowserSession> {
  const data = await bridgeFetch<{ session: RemoteBrowserSession }>(
    `/remote-browser/${encodeURIComponent(sessionId)}/status`,
    { signal },
  )
  return data.session
}

// Same-origin URL for the live viewport frame. Cache-busted by `nonce` so each poll fetches a fresh
// image. Loaded by an <img> tag; the dashboard session cookie authenticates the proxy hop.
export function remoteBrowserScreenshotUrl(sessionId: string, nonce: number | string): string {
  // `t` matches the cache-buster the dashboard proxy forwards upstream; it also varies the same-origin
  // URL so the browser never serves a stale frame from cache.
  return `${ACCOUNTS_BRIDGE_BASE}/remote-browser/${encodeURIComponent(sessionId)}/screenshot?t=${encodeURIComponent(String(nonce))}`
}

// Same-origin WebSocket URL for the LIVE CDP screencast stream. The dashboard worker proxy tunnels the
// upgrade to the Mac bridge, injecting the shared secret server-side — the browser never holds the key
// and never talks to the bridge directly. Returns a ws:// or wss:// URL matching the page scheme.
export function remoteBrowserStreamUrl(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${ACCOUNTS_BRIDGE_BASE}/remote-browser/${encodeURIComponent(sessionId)}/stream`
}

// Messages the bridge pushes down the screencast WebSocket. `frame` carries base64 JPEG bytes; `status`
// mirrors the secret-free session status; `error` is a stable code. None ever carry a secret.
export type RemoteBrowserStreamMessage =
  | { type: 'frame'; sessionId: string; seq: number; data: string; metadata?: { deviceWidth?: number; deviceHeight?: number } | null }
  | { type: 'status'; sessionId: string; url: string | null; title: string | null; viewport: { width: number; height: number } | null; status: RemoteBrowserStatus }
  | { type: 'error'; error: string }

// Messages the viewer sends UP the WebSocket. Mirrors the bridge's fixed input vocabulary — there is NO
// eval / raw-CDP message. Mouse/key map onto CDP Input.dispatch*; navigate/command drive the page.
export type RemoteBrowserStreamInput =
  | { type: 'mouse'; event: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'; x: number; y: number; button?: 'none' | 'left' | 'middle' | 'right'; clickCount?: number; deltaX?: number; deltaY?: number }
  | { type: 'key'; event: 'keyDown' | 'keyUp' | 'char'; key?: string; code?: string; text?: string; windowsVirtualKeyCode?: number }
  | { type: 'navigate'; url: string }
  | { type: 'command'; command: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'status' }

// Relay one validated input action to the remote page (click/type/key/scroll/navigate/back/forward/reload).
export async function sendRemoteBrowserInput(
  sessionId: string,
  action: RemoteBrowserAction,
  payload: RemoteBrowserInputPayload = {},
): Promise<void> {
  await bridgeFetch(`/remote-browser/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    body: { action, payload },
    timeoutMs: 30000,
  })
}

// Stop the session: the Mac closes the page/context and uploads the sealed profile archive so the next
// open restores it. Returns only metadata (no secret, no bytes).
export async function stopRemoteBrowser(sessionId: string): Promise<void> {
  await bridgeFetch(`/remote-browser/${encodeURIComponent(sessionId)}/stop`, { method: 'POST', timeoutMs: 30000 })
}

// An agent is "live" only if it heartbeated recently — status alone can go stale when the agent dies.
export function isAgentLive(agent: CloudAgent | null | undefined, maxAgeMs = 60000): boolean {
  if (!agent || !agent.last_seen_at) return false
  const seen = Date.parse(agent.last_seen_at)
  if (Number.isNaN(seen)) return false
  return Date.now() - seen <= maxAgeMs
}
