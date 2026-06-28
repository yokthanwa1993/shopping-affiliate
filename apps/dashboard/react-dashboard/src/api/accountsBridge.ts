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
  if (response.status === 503 && errorCode === 'cloud_bridge_not_configured') {
    throw new CloudNotConfiguredError()
  }
  if (response.status === 502 || errorCode === 'cloud_bridge_unreachable' || errorCode === 'cloud_bridge_bad_response') {
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

export interface CloudAccount {
  account_uid: string
  platform: string
  display_label: string | null
  // Non-secret operator metadata (never cookies/tokens/passwords/datr/fb_dtsg/sessions).
  notes: string | null
  tags: string[]
  page_label: string | null
  account_role: string | null
  preferred_agent_id: string | null
  status: string
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
  page_label?: string | null
  account_role?: string | null
  preferred_agent_id?: string | null
  status?: string | null
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

// An agent is "live" only if it heartbeated recently — status alone can go stale when the agent dies.
export function isAgentLive(agent: CloudAgent | null | undefined, maxAgeMs = 60000): boolean {
  if (!agent || !agent.last_seen_at) return false
  const seen = Date.parse(agent.last_seen_at)
  if (Number.isNaN(seen)) return false
  return Date.now() - seen <= maxAgeMs
}
