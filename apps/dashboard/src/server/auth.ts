import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server'

export interface AuthEnv {
  DB: D1Database
  PASSKEY_RP_ID: string
  PASSKEY_RP_NAME: string
  PASSKEY_NAMESPACE_ID: string
  PASSKEY_WORKSPACE_NAME: string
  PASSKEY_BOOTSTRAP_DISPLAY_NAME: string
  // Accounts Bridge cloud proxy (server-side only). URL is a non-secret var; the API key is a Worker
  // SECRET (set via `wrangler secret put ACCOUNTS_BRIDGE_API_KEY`) and is never exposed to the bundle.
  // Optional: when ACCOUNTS_BRIDGE_WORKER_URL is unset the proxy returns cloud_bridge_not_configured.
  ACCOUNTS_BRIDGE_WORKER_URL?: string
  ACCOUNTS_BRIDGE_API_KEY?: string
  // Cloud Browser (remote browser) base URL. The /accounts-bridge/remote-browser/* routes forward to
  // THIS origin — the Mac facebook-token-cloak bridge (a public tunnel of 127.0.0.1:8820), NOT the
  // cloud accounts Worker — because screenshots stream live binary frames off the Mac's Chromium.
  // Optional: when unset the proxy returns 503 remote_browser_not_configured (it never leaks
  // localhost). FACEBOOK_TOKEN_CLOAK_BRIDGE_URL is accepted as a fallback name for the same origin.
  ACCOUNTS_BRIDGE_REMOTE_BROWSER_BASE_URL?: string
  FACEBOOK_TOKEN_CLOAK_BRIDGE_URL?: string
  // Shared secret the proxy injects as x-remote-browser-key when forwarding to the Mac bridge. The
  // bridge gates its /remote-browser/* routes on this (cloudflared makes tunnel traffic look like
  // loopback, so the header is the real auth). A Worker SECRET, never exposed to the bundle. When
  // unset the proxy falls back to ACCOUNTS_BRIDGE_API_KEY — matching the bridge's own fallback.
  ACCOUNTS_BRIDGE_REMOTE_BROWSER_KEY?: string
}

export const SESSION_COOKIE = 'pubilo_dashboard_session'
const SESSION_TTL_SEC = 60 * 60 * 24 * 30
const CHALLENGE_TTL_SEC = 60 * 5

export function isPubiloHost(host: string): boolean {
  const h = host.split(':')[0]
  return h === 'pubilo.com' || h.endsWith('.pubilo.com')
}

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS dashboard_passkey_users (
     id TEXT PRIMARY KEY,
     email TEXT,
     display_name TEXT,
     workspace_name TEXT NOT NULL,
     namespace_id TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_users_email
     ON dashboard_passkey_users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_users_namespace
     ON dashboard_passkey_users(namespace_id)`,
  `CREATE TABLE IF NOT EXISTS dashboard_passkey_credentials (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     namespace_id TEXT NOT NULL,
     credential_id TEXT NOT NULL UNIQUE,
     public_key TEXT NOT NULL,
     counter INTEGER NOT NULL DEFAULT 0,
     transports TEXT,
     device_type TEXT,
     backed_up INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_credentials_user
     ON dashboard_passkey_credentials(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_credentials_namespace
     ON dashboard_passkey_credentials(namespace_id)`,
  `CREATE TABLE IF NOT EXISTS dashboard_passkey_challenges (
     id TEXT PRIMARY KEY,
     user_id TEXT,
     challenge TEXT NOT NULL,
     type TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_challenges_expires
     ON dashboard_passkey_challenges(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_challenges_user
     ON dashboard_passkey_challenges(user_id)`,
  `CREATE TABLE IF NOT EXISTS dashboard_passkey_sessions (
     session_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     namespace_id TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_sessions_user
     ON dashboard_passkey_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_sessions_expires
     ON dashboard_passkey_sessions(expires_at)`,
]

let schemaReadyCache: WeakSet<D1Database> | null = null

function markSchemaReady(db: D1Database): void {
  if (!schemaReadyCache) schemaReadyCache = new WeakSet<D1Database>()
  schemaReadyCache.add(db)
}

function isSchemaReady(db: D1Database): boolean {
  return !!schemaReadyCache && schemaReadyCache.has(db)
}

export async function ensureSchema(env: AuthEnv): Promise<void> {
  if (isSchemaReady(env.DB)) return
  for (const stmt of SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO dashboard_passkey_users
       (id, email, display_name, workspace_name, namespace_id)
     VALUES (?, NULL, ?, ?, ?)`,
  )
    .bind(
      env.PASSKEY_NAMESPACE_ID,
      env.PASSKEY_BOOTSTRAP_DISPLAY_NAME,
      env.PASSKEY_WORKSPACE_NAME,
      env.PASSKEY_NAMESPACE_ID,
    )
    .run()
  markSchemaReady(env.DB)
}

function rpIdForHost(host: string, fallback: string): string {
  const h = host.split(':')[0]
  if (isPubiloHost(h)) return 'pubilo.com'
  if (h === 'localhost' || h === '127.0.0.1') return 'localhost'
  return h || fallback
}

function originForRequest(request: Request): string {
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

function cookieAttrs(host: string, maxAge: number): string {
  const parts = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']
  if (isPubiloHost(host)) parts.push('Domain=.pubilo.com')
  parts.push(`Max-Age=${maxAge}`)
  return parts.join('; ')
}

export function setSessionCookieHeader(host: string, sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; ${cookieAttrs(host, SESSION_TTL_SEC)}`
}

export function clearSessionCookieHeader(host: string): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(host, 0)}`
}

export function readSessionId(req: Request): string | null {
  const cookie = req.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=') || null
  }
  return null
}

function randomToken(byteLen = 24): string {
  const buf = new Uint8Array(byteLen)
  crypto.getRandomValues(buf)
  return isoBase64URL.fromBuffer(buf)
}

interface UserRow {
  id: string
  email: string | null
  display_name: string | null
  workspace_name: string
  namespace_id: string
}

interface CredentialRow {
  id: string
  user_id: string
  namespace_id: string
  credential_id: string
  public_key: string
  counter: number
  transports: string | null
}

interface SessionRow {
  session_id: string
  user_id: string
  namespace_id: string
  expires_at: string
}

async function getBootstrapUser(env: AuthEnv): Promise<UserRow> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, workspace_name, namespace_id
       FROM dashboard_passkey_users
      WHERE id = ?`,
  )
    .bind(env.PASSKEY_NAMESPACE_ID)
    .first<UserRow>()
  if (row) return row
  await env.DB.prepare(
    `INSERT INTO dashboard_passkey_users (id, email, display_name, workspace_name, namespace_id)
     VALUES (?, NULL, ?, ?, ?)`,
  )
    .bind(env.PASSKEY_NAMESPACE_ID, env.PASSKEY_BOOTSTRAP_DISPLAY_NAME, env.PASSKEY_WORKSPACE_NAME, env.PASSKEY_NAMESPACE_ID)
    .run()
  return {
    id: env.PASSKEY_NAMESPACE_ID,
    email: null,
    display_name: env.PASSKEY_BOOTSTRAP_DISPLAY_NAME,
    workspace_name: env.PASSKEY_WORKSPACE_NAME,
    namespace_id: env.PASSKEY_NAMESPACE_ID,
  }
}

export async function credentialCount(env: AuthEnv): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM dashboard_passkey_credentials WHERE namespace_id = ?`,
  )
    .bind(env.PASSKEY_NAMESPACE_ID)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export interface AuthenticatedSession {
  session: SessionRow
  user: UserRow
}

export async function loadSession(env: AuthEnv, req: Request): Promise<AuthenticatedSession | null> {
  const sid = readSessionId(req)
  if (!sid) return null
  const session = await env.DB.prepare(
    `SELECT session_id, user_id, namespace_id, expires_at
       FROM dashboard_passkey_sessions
      WHERE session_id = ? AND datetime(expires_at) > datetime('now')`,
  )
    .bind(sid)
    .first<SessionRow>()
  if (!session) return null
  const user = await env.DB.prepare(
    `SELECT id, email, display_name, workspace_name, namespace_id
       FROM dashboard_passkey_users WHERE id = ?`,
  )
    .bind(session.user_id)
    .first<UserRow>()
  if (!user) return null
  return { session, user }
}

async function createSession(env: AuthEnv, userId: string): Promise<string> {
  const sessionId = randomToken(32)
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString()
  await env.DB.prepare(
    `INSERT INTO dashboard_passkey_sessions (session_id, user_id, namespace_id, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, env.PASSKEY_NAMESPACE_ID, expiresAt)
    .run()
  return sessionId
}

async function deleteSession(env: AuthEnv, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM dashboard_passkey_sessions WHERE session_id = ?`)
    .bind(sessionId)
    .run()
}

async function storeChallenge(
  env: AuthEnv,
  type: 'registration' | 'authentication',
  challenge: string,
  userId: string | null,
): Promise<string> {
  const id = randomToken(16)
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SEC * 1000).toISOString()
  await env.DB.prepare(
    `INSERT INTO dashboard_passkey_challenges (id, user_id, challenge, type, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, challenge, type, expiresAt)
    .run()
  return id
}

async function consumeChallenge(
  env: AuthEnv,
  id: string,
  type: 'registration' | 'authentication',
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT challenge FROM dashboard_passkey_challenges
      WHERE id = ? AND type = ? AND datetime(expires_at) > datetime('now')`,
  )
    .bind(id, type)
    .first<{ challenge: string }>()
  if (!row) return null
  await env.DB.prepare(`DELETE FROM dashboard_passkey_challenges WHERE id = ?`)
    .bind(id)
    .run()
  return row.challenge
}

async function listCredentialsForUser(env: AuthEnv, userId: string): Promise<CredentialRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_id, namespace_id, credential_id, public_key, counter, transports
       FROM dashboard_passkey_credentials WHERE user_id = ?`,
  )
    .bind(userId)
    .all<CredentialRow>()
  return result.results ?? []
}

async function findCredentialById(
  env: AuthEnv,
  credentialId: string,
): Promise<CredentialRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, namespace_id, credential_id, public_key, counter, transports
       FROM dashboard_passkey_credentials WHERE credential_id = ?`,
  )
    .bind(credentialId)
    .first<CredentialRow>()
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { ...init, headers })
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as AuthenticatorTransportFuture[]
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// ── Zod contracts ────────────────────────────────────────────────────────────
// Formal request contracts for the passkey verify endpoints, mirroring the
// customlink slice: the granular `invalid_request` checks below still produce the
// exact error the clients branch on, and these schemas are the formal gate that
// backs them. The `response` object is left as an open record because its shape
// is owned by @simplewebauthn's RegistrationResponseJSON/AuthenticationResponseJSON
// types, which the verify functions validate cryptographically anyway.
export const registerVerifyRequestSchema = z.object({
  challengeId: z.string().min(1),
  response: z.record(z.string(), z.unknown()),
})

export const loginVerifyRequestSchema = z.object({
  challengeId: z.string().min(1),
  response: z.record(z.string(), z.unknown()),
})

export async function handleSessionMe(env: AuthEnv, req: Request): Promise<Response> {
  let setup = true
  try {
    setup = (await credentialCount(env)) === 0
  } catch {
    // Schema not applied yet — treat as setup-required so the dashboard stays
    // usable until the D1 migration lands.
    return jsonResponse({
      authenticated: false,
      setupRequired: true,
      schemaReady: false,
      namespaceId: env.PASSKEY_NAMESPACE_ID,
      workspaceId: env.PASSKEY_NAMESPACE_ID,
    })
  }
  const sess = await loadSession(env, req).catch(() => null)
  if (sess) {
    return jsonResponse({
      authenticated: true,
      setupRequired: false,
      user: {
        id: sess.user.id,
        email: sess.user.email,
        displayName: sess.user.display_name,
        workspaceName: sess.user.workspace_name,
      },
      namespaceId: env.PASSKEY_NAMESPACE_ID,
      workspaceId: env.PASSKEY_NAMESPACE_ID,
    })
  }
  return jsonResponse({
    authenticated: false,
    setupRequired: setup,
    namespaceId: env.PASSKEY_NAMESPACE_ID,
    workspaceId: env.PASSKEY_NAMESPACE_ID,
  })
}

export async function handleRegisterOptions(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sess = await loadSession(env, req)
  const setup = (await credentialCount(env)) === 0
  if (!sess && !setup) {
    return jsonResponse({ error: 'authentication_required' }, { status: 401 })
  }
  let body: { email?: string; displayName?: string } = {}
  if (req.method !== 'GET') {
    try {
      body = (await req.json()) as { email?: string; displayName?: string }
    } catch {
      body = {}
    }
  }
  const user = sess ? sess.user : await getBootstrapUser(env)
  if (setup && (body.email || body.displayName)) {
    const nextEmail = body.email?.trim() || user.email
    const nextDisplay = body.displayName?.trim() || user.display_name
    await env.DB.prepare(
      `UPDATE dashboard_passkey_users
          SET email = ?, display_name = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(nextEmail, nextDisplay, user.id)
      .run()
    user.email = nextEmail ?? null
    user.display_name = nextDisplay ?? null
  }
  const credentials = await listCredentialsForUser(env, user.id)
  const options = await generateRegistrationOptions({
    rpName: env.PASSKEY_RP_NAME,
    rpID: rpIdForHost(url.host, env.PASSKEY_RP_ID),
    userID: new TextEncoder().encode(user.id),
    userName: user.email || `${user.display_name || 'user'}@${env.PASSKEY_WORKSPACE_NAME.toLowerCase()}`,
    userDisplayName: user.display_name || env.PASSKEY_BOOTSTRAP_DISPLAY_NAME,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: credentials.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
  })
  const challengeId = await storeChallenge(env, 'registration', options.challenge, user.id)
  return jsonResponse({ challengeId, options })
}

export async function handleRegisterVerify(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sess = await loadSession(env, req)
  const setup = (await credentialCount(env)) === 0
  if (!sess && !setup) {
    return jsonResponse({ error: 'authentication_required' }, { status: 401 })
  }
  const payload = (await req.json()) as {
    challengeId?: string
    response?: RegistrationResponseJSON
  }
  if (!payload.challengeId || !payload.response) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 })
  }
  // Formal contract gate (see registerVerifyRequestSchema). The check above
  // already guarantees both fields are present; this rejects malformed shapes
  // (e.g. a non-string challengeId) with the same stable error code.
  if (!registerVerifyRequestSchema.safeParse(payload).success) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 })
  }
  const expectedChallenge = await consumeChallenge(env, payload.challengeId, 'registration')
  if (!expectedChallenge) {
    return jsonResponse({ error: 'challenge_expired' }, { status: 400 })
  }
  const user = sess ? sess.user : await getBootstrapUser(env)
  const rpID = rpIdForHost(url.host, env.PASSKEY_RP_ID)
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: payload.response,
      expectedChallenge,
      expectedOrigin: originForRequest(req),
      expectedRPID: rpID,
      requireUserVerification: false,
    })
  } catch (err) {
    return jsonResponse({ error: 'verification_failed', detail: String(err) }, { status: 400 })
  }
  if (!verification.verified || !verification.registrationInfo) {
    return jsonResponse({ error: 'verification_failed' }, { status: 400 })
  }
  const info = verification.registrationInfo
  const credentialIdStr: string = info.credential.id
  const publicKeyB64 = isoBase64URL.fromBuffer(info.credential.publicKey)
  const rowId = randomToken(16)
  await env.DB.prepare(
    `INSERT INTO dashboard_passkey_credentials
       (id, user_id, namespace_id, credential_id, public_key, counter, transports, device_type, backed_up)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      rowId,
      user.id,
      env.PASSKEY_NAMESPACE_ID,
      credentialIdStr,
      publicKeyB64,
      info.credential.counter,
      info.credential.transports ? JSON.stringify(info.credential.transports) : null,
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
    )
    .run()
  const sessionId = await createSession(env, user.id)
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  headers.append('Set-Cookie', setSessionCookieHeader(url.host, sessionId))
  return new Response(
    JSON.stringify({ verified: true, user: { id: user.id, displayName: user.display_name, workspaceName: user.workspace_name } }),
    { status: 200, headers },
  )
}

export async function handleLoginOptions(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const result = await env.DB.prepare(
    `SELECT credential_id, transports FROM dashboard_passkey_credentials WHERE namespace_id = ?`,
  )
    .bind(env.PASSKEY_NAMESPACE_ID)
    .all<{ credential_id: string; transports: string | null }>()
  const creds = result.results ?? []
  if (creds.length === 0) {
    return jsonResponse({ error: 'setup_required' }, { status: 409 })
  }
  const options = await generateAuthenticationOptions({
    rpID: rpIdForHost(url.host, env.PASSKEY_RP_ID),
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
  })
  const challengeId = await storeChallenge(env, 'authentication', options.challenge, null)
  return jsonResponse({ challengeId, options })
}

export async function handleLoginVerify(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const payload = (await req.json()) as {
    challengeId?: string
    response?: AuthenticationResponseJSON
  }
  if (!payload.challengeId || !payload.response) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 })
  }
  // Formal contract gate (see loginVerifyRequestSchema). Same stable error code
  // as the presence check above; rejects malformed shapes before any DB work.
  if (!loginVerifyRequestSchema.safeParse(payload).success) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 })
  }
  const expectedChallenge = await consumeChallenge(env, payload.challengeId, 'authentication')
  if (!expectedChallenge) {
    return jsonResponse({ error: 'challenge_expired' }, { status: 400 })
  }
  const credentialIdStr = payload.response.id
  const cred = await findCredentialById(env, credentialIdStr)
  if (!cred) {
    return jsonResponse({ error: 'credential_not_found' }, { status: 404 })
  }
  const publicKey = isoBase64URL.toBuffer(cred.public_key)
  const credentialForVerify: WebAuthnCredential = {
    id: cred.credential_id,
    publicKey,
    counter: cred.counter,
    transports: parseTransports(cred.transports),
  }
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: payload.response,
      expectedChallenge,
      expectedOrigin: originForRequest(req),
      expectedRPID: rpIdForHost(url.host, env.PASSKEY_RP_ID),
      credential: credentialForVerify,
      requireUserVerification: false,
    })
  } catch (err) {
    return jsonResponse({ error: 'verification_failed', detail: String(err) }, { status: 400 })
  }
  if (!verification.verified) {
    return jsonResponse({ error: 'verification_failed' }, { status: 400 })
  }
  await env.DB.prepare(
    `UPDATE dashboard_passkey_credentials
        SET counter = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(verification.authenticationInfo.newCounter, cred.id)
    .run()
  const sessionId = await createSession(env, cred.user_id)
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  headers.append('Set-Cookie', setSessionCookieHeader(url.host, sessionId))
  return new Response(JSON.stringify({ verified: true }), { status: 200, headers })
}

export async function handleLogout(env: AuthEnv, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sid = readSessionId(req)
  if (sid) await deleteSession(env, sid)
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  headers.append('Set-Cookie', clearSessionCookieHeader(url.host))
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
}

export async function dispatchAuth(env: AuthEnv, req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname
  const isAuthRoute =
    path === '/auth/session/me' ||
    path === '/auth/passkey/register/options' ||
    path === '/auth/passkey/register/verify' ||
    path === '/auth/passkey/login/options' ||
    path === '/auth/passkey/login/verify' ||
    path === '/auth/logout'
  if (isAuthRoute) {
    try {
      await ensureSchema(env)
    } catch (err) {
      return jsonResponse(
        { error: 'schema_unavailable', detail: String(err) },
        { status: 503 },
      )
    }
  }
  if (path === '/auth/session/me' && req.method === 'GET') return handleSessionMe(env, req)
  if (path === '/auth/passkey/register/options' && req.method === 'POST') return handleRegisterOptions(env, req)
  if (path === '/auth/passkey/register/verify' && req.method === 'POST') return handleRegisterVerify(env, req)
  if (path === '/auth/passkey/login/options' && req.method === 'POST') return handleLoginOptions(env, req)
  if (path === '/auth/passkey/login/verify' && req.method === 'POST') return handleLoginVerify(env, req)
  if (path === '/auth/logout' && req.method === 'POST') return handleLogout(env, req)
  return null
}

// ── Hono app: /auth/* routing ────────────────────────────────────────────────
// Second route family migrated onto Hono (after the customlink shorten slice).
// Same bridge shape: the raw fetch handler in worker.ts still owns host routing,
// redirects, the shared auth gate and asset serving, and delegates every
// /auth/* request here. Behavior is preserved 1:1 from dispatchAuth above:
//   - ensureSchema runs before each matched route, with the identical 503
//     `schema_unavailable` fallback (and, like before, does NOT run for an
//     unknown /auth/* path — only for the six real routes).
//   - method/path matching is identical; an unknown path or wrong method falls
//     through to the same `not found` 404.
//   - handler bodies are unchanged, so the passkey clients see no difference.
// `dispatchAuth` is retained (unused by the worker now) as a one-line rollback.
type AuthBindings = { Bindings: AuthEnv }

function withSchema(
  handler: (env: AuthEnv, req: Request) => Promise<Response>,
): (c: Context<AuthBindings>) => Promise<Response> {
  return async (c) => {
    try {
      await ensureSchema(c.env)
    } catch (err) {
      return jsonResponse({ error: 'schema_unavailable', detail: String(err) }, { status: 503 })
    }
    return handler(c.env, c.req.raw)
  }
}

export const authApp = new Hono<AuthBindings>()

authApp.get('/auth/session/me', withSchema(handleSessionMe))
authApp.post('/auth/passkey/register/options', withSchema(handleRegisterOptions))
authApp.post('/auth/passkey/register/verify', withSchema(handleRegisterVerify))
authApp.post('/auth/passkey/login/options', withSchema(handleLoginOptions))
authApp.post('/auth/passkey/login/verify', withSchema(handleLoginVerify))
authApp.post('/auth/logout', withSchema(handleLogout))

authApp.notFound(() => new Response('not found', { status: 404 }))
