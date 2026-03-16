const http = require('http')
const httpProxy = require('http-proxy')
const fs = require('fs')
const fsp = require('fs/promises')
const net = require('net')
const path = require('path')
const { randomBytes } = require('crypto')
const { spawn } = require('child_process')
const { gunzipSync } = require('zlib')
const puppeteer = require('puppeteer-core')
const { Hyperbrowser } = require('@hyperbrowser/sdk')

const PORT = Number(process.env.PORT || 8080)
const SESSION_ROOT = path.resolve(process.env.SESSION_ROOT || '/data/sessions')
const WORKER_URL = String(process.env.WORKER_URL || '').trim() || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev'
const SESSION_PUBLIC_BASE_URL = String(process.env.SESSION_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '')
const SESSION_PATH_PREFIX = normalizePrefix(process.env.SESSION_PATH_PREFIX || '/kasm')
const SESSION_VIEWER_MODE = String(process.env.SESSION_VIEWER_MODE || '').trim().toLowerCase() || 'proxy'
const SESSION_VIEWER_HOST = String(process.env.SESSION_VIEWER_HOST || '').trim()
const SESSION_VIEWER_PROTO = String(process.env.SESSION_VIEWER_PROTO || '').trim() || 'http'
const DISPLAY_START = Number(process.env.DISPLAY_START || 20)
const DISPLAY_END = Number(process.env.DISPLAY_END || 99)
const KASM_PORT_START = Number(process.env.KASM_PORT_START || 8620)
const KASM_PORT_END = Number(process.env.KASM_PORT_END || 8699)
const KASM_BIND_INTERFACE = String(process.env.KASM_BIND_INTERFACE || '').trim() || '127.0.0.1'
const KASM_PUBLIC_IP = String(process.env.KASM_PUBLIC_IP || '').trim() || KASM_BIND_INTERFACE
const KASM_CONNECT_HOST = String(process.env.KASM_CONNECT_HOST || '').trim() || '127.0.0.1'
const CHROME_BIN = String(process.env.CHROME_BIN || '').trim() || '/usr/bin/google-chrome'
const VNC_BIN = String(process.env.VNC_BIN || '').trim() || '/usr/bin/vncserver'
const KASM_PASSWD_BIN = String(process.env.KASM_PASSWD_BIN || '').trim() || '/usr/bin/kasmvncpasswd'
const SESSION_WIDTH = Number(process.env.SESSION_WIDTH || 1440)
const SESSION_HEIGHT = Number(process.env.SESSION_HEIGHT || 900)
const WAIT_TIMEOUT_MS = Number(process.env.SESSION_WAIT_TIMEOUT_MS || 20000)
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 30000)
const MAX_COMMAND_OUTPUT_CHARS = Number(process.env.MAX_COMMAND_OUTPUT_CHARS || 65536)
const KASM_USERNAME = String(process.env.KASM_USERNAME || '').trim() || 'browser'
const SESSION_BACKEND = String(process.env.SESSION_BACKEND || '').trim().toLowerCase() || 'kasm'
const HYPERBROWSER_API_KEY = String(process.env.HYPERBROWSER_API_KEY || '').trim()
const HYPERBROWSER_TIMEOUT_MINUTES = Math.max(5, Number(process.env.HYPERBROWSER_TIMEOUT_MINUTES || 60))
const HYPERBROWSER_LIVE_VIEW_TTL_SECONDS = Math.max(60, Number(process.env.HYPERBROWSER_LIVE_VIEW_TTL_SECONDS || 3600))
const HYPERBROWSER_ENABLE_WINDOW_MANAGER = String(process.env.HYPERBROWSER_ENABLE_WINDOW_MANAGER || 'true').trim().toLowerCase() !== 'false'
const HYPERBROWSER_VIEW_ONLY = String(process.env.HYPERBROWSER_VIEW_ONLY || 'false').trim().toLowerCase() === 'true'
const HYPERBROWSER_USE_STEALTH = String(process.env.HYPERBROWSER_USE_STEALTH || 'true').trim().toLowerCase() !== 'false'
const HYPERBROWSER_ACCEPT_COOKIES = String(process.env.HYPERBROWSER_ACCEPT_COOKIES || 'true').trim().toLowerCase() !== 'false'

const sessions = new Map()
const uploading = new Set()
const authCache = new Map()
const pendingStarts = new Map()
const reservedDisplays = new Set()
const reservedPorts = new Set()
let hyperbrowserClient = null
const proxy = httpProxy.createProxyServer({
  secure: false,
  changeOrigin: true,
  ws: true,
  xfwd: true,
})

proxy.on('error', (error, req, res) => {
  if (res && !res.headersSent) {
    json(res, 502, { error: 'Launcher proxy error', detail: String(error) })
    return
  }
  if (res && typeof res.end === 'function') {
    res.end()
  }
  if (!res && req?.socket) {
    req.socket.destroy()
  }
})

fs.mkdirSync(SESSION_ROOT, { recursive: true })

function normalizePrefix(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed || trimmed === '/') return '/kasm'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  })
  res.end(body)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  }
}

function sanitizeProfileId(value) {
  const profileId = String(value || '').trim()
  if (!profileId) throw new Error('Missing profile id')
  if (!/^[a-zA-Z0-9._-]+$/.test(profileId)) {
    throw new Error('Invalid profile id')
  }
  return profileId
}

function safeProfileName(value) {
  return String(value || '').trim() || 'BrowserSaving Profile'
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed === 'about:blank') return trimmed
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  return parsed.toString()
}

function sessionHomeDir(profileId) {
  return path.join(SESSION_ROOT, profileId, 'home')
}

function sessionChromeDir(profileId) {
  return path.join(SESSION_ROOT, profileId, 'chrome-profile')
}

function sessionChromeStageDir(profileId) {
  return path.join(SESSION_ROOT, profileId, 'chrome-profile.stage')
}

function sessionMetaPath(profileId) {
  return path.join(SESSION_ROOT, profileId, 'session.json')
}

function hyperProfileMetaPath(profileId) {
  return path.join(SESSION_ROOT, profileId, 'hyperbrowser-profile.json')
}

function sessionKasmPasswordPath(profileId) {
  return path.join(sessionHomeDir(profileId), '.kasmpasswd')
}

function kasmConfigPath(profileId) {
  return path.join(sessionHomeDir(profileId), '.vnc', 'kasmvnc.yaml')
}

function kasmStartupPath(profileId) {
  return path.join(sessionHomeDir(profileId), '.vnc', 'xstartup')
}

function buildSessionFromMeta(meta) {
  const profileId = sanitizeProfileId(meta?.profileId)
  return {
    backend: 'kasm',
    profileId,
    profileName: safeProfileName(meta?.profileName),
    homepage: String(meta?.homepage || '').trim(),
    authToken: '',
    viewerToken: String(meta?.viewerToken || '').trim(),
    kasmPassword: '',
    display: Number(meta?.display),
    kasmPort: Number(meta?.kasmPort),
    homeDir: sessionHomeDir(profileId),
    chromeDir: sessionChromeDir(profileId),
    createdAt: String(meta?.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
}

function buildProxyTarget(session) {
  return `http://${KASM_CONNECT_HOST}:${session.kasmPort}`
}

function isHyperbrowserBackend() {
  return SESSION_BACKEND === 'hyperbrowser'
}

function isHyperbrowserSession(session) {
  return String(session?.backend || '') === 'hyperbrowser'
}

function buildViewerUrl(req, profileId) {
  const session = sessions.get(profileId)
  if (!session) throw new Error('Session not found')
  if (isHyperbrowserSession(session)) {
    return String(session.viewerUrl || '').trim()
  }
  if (SESSION_VIEWER_MODE === 'direct-port') {
    const host = SESSION_VIEWER_HOST || new URL(inferRequestOrigin(req)).hostname
    return `${SESSION_VIEWER_PROTO}://${host}:${session.kasmPort}/vnc.html?autoconnect=1&resize=remote`
  }
  const origin = SESSION_PUBLIC_BASE_URL || inferRequestOrigin(req)
  return `${origin}${SESSION_PATH_PREFIX}/${encodeURIComponent(profileId)}/${encodeURIComponent(session.viewerToken)}/vnc.html?autoconnect=1&resize=remote`
}

function buildViewerWebsocketPath(session) {
  return `${SESSION_PATH_PREFIX}/${encodeURIComponent(session.profileId)}/${encodeURIComponent(session.viewerToken)}/websockify`
}

async function proxyViewerHtml(req, res, session, upstreamPath) {
  const upstreamUrl = `${buildProxyTarget(session)}${upstreamPath}`
  const upstream = await fetch(upstreamUrl, {
    headers: {
      accept: String(req.headers.accept || 'text/html'),
    },
  })

  if (!upstream.ok) {
    json(res, upstream.status, { error: 'Launcher proxy error', detail: `Viewer HTML upstream returned ${upstream.status}` })
    return
  }

  const websocketPath = buildViewerWebsocketPath(session)
  const html = (await upstream.text())
    .replace(/value="websockify"/g, `value="${websocketPath}"`)
    .replace(/value='websockify'/g, `value='${websocketPath}'`)

  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function inferRequestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').trim() || 'http'
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim()
  return `${proto}://${host}`
}

function buildWorkerHeaders(authToken) {
  const headers = {
    Accept: 'application/json',
  }
  if (authToken) {
    headers['x-auth-token'] = authToken
  }
  return headers
}

function clampViewport(viewport) {
  const width = Math.min(2560, Math.max(640, Math.round(Number(viewport?.width) || SESSION_WIDTH)))
  const height = Math.min(1600, Math.max(480, Math.round(Number(viewport?.height) || SESSION_HEIGHT)))
  const deviceScaleFactor = Math.min(3, Math.max(1, Number(viewport?.deviceScaleFactor) || 1))
  return { width, height, deviceScaleFactor }
}

function parseRequestedViewport(raw) {
  if (!raw || typeof raw !== 'object') return null
  return clampViewport(raw)
}

function shEscape(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function mapCookiesForPuppeteer(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie?.name && cookie?.value && cookie?.domain)
    .map((cookie) => {
      const mapped = {
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain),
        path: String(cookie.path || '/'),
        secure: cookie.secure ?? true,
        httpOnly: cookie.http_only ?? cookie.httpOnly ?? false,
      }
      const expires = Number(cookie.expires)
      if (Number.isFinite(expires) && expires > 0) {
        mapped.expires = expires
      }
      return mapped
    })
}

async function extractCookiesWithTar(gzipBuffer) {
  const profileId = `cookies-${randomHex(8)}`
  const tmpDir = path.join(SESSION_ROOT, profileId)
  const archivePath = path.join(tmpDir, 'cookies.tar.gz')
  const cookiesPath = path.join(tmpDir, 'cookies.json')

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    await fsp.writeFile(archivePath, gzipBuffer)
    await runCommand('tar', ['-xzf', archivePath, '-C', tmpDir, 'cookies.json']).catch(() => null)
    const raw = await fsp.readFile(cookiesPath, 'utf8').catch(() => '')
    return raw ? JSON.parse(raw) : []
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
  }
}

function parseTarForCookies(tarBuffer) {
  let offset = 0
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.slice(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break

    let nameEnd = 0
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1
    const name = header.slice(0, nameEnd).toString('ascii')
    const sizeStr = header.slice(124, 136).toString('ascii').replace(/\0/g, '').trim()
    const size = parseInt(sizeStr, 8) || 0

    offset += 512

    if (name === 'cookies.json' || name.endsWith('/cookies.json')) {
      const raw = tarBuffer.slice(offset, offset + size).toString('utf8')
      try {
        return JSON.parse(raw)
      } catch {
        return []
      }
    }

    offset += Math.ceil(size / 512) * 512
  }

  return []
}

async function downloadProfileCookies(profileId, authToken) {
  const response = await fetch(`${WORKER_URL}/api/sync/${encodeURIComponent(profileId)}/download`, {
    headers: buildWorkerHeaders(authToken),
  })

  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`Browser data download failed: HTTP ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < 100) return []

  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      let tarBuffer = gunzipSync(buffer)
      if (tarBuffer[0] === 0x1f && tarBuffer[1] === 0x8b) {
        tarBuffer = gunzipSync(tarBuffer)
      }
      return parseTarForCookies(tarBuffer)
    } catch {
      return extractCookiesWithTar(buffer)
    }
  }

  return parseTarForCookies(buffer)
}

async function uploadProfileCookies(profileId, authToken, cookies) {
  const profileDir = path.join(SESSION_ROOT, profileId)
  const tmpDir = path.join(profileDir, 'hyper-upload')
  const cookiesPath = path.join(tmpDir, 'cookies.json')
  const archivePath = path.join(tmpDir, 'browser-data.tar.gz')

  try {
    await fsp.mkdir(tmpDir, { recursive: true })
    await fsp.writeFile(cookiesPath, JSON.stringify(Array.isArray(cookies) ? cookies : [], null, 2), 'utf8')
    await runCommand('tar', ['-czf', archivePath, '-C', tmpDir, 'cookies.json'])
    const body = await fsp.readFile(archivePath)
    const response = await fetch(`${WORKER_URL}/api/sync/${encodeURIComponent(profileId)}/upload`, {
      method: 'POST',
      headers: {
        ...buildWorkerHeaders(authToken),
        'Content-Type': 'application/gzip',
      },
      body,
    })
    if (!response.ok) {
      throw new Error(`Browser data upload failed: HTTP ${response.status}`)
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
  }
}

async function snapshotSessionCookies(page) {
  const client = await page.target().createCDPSession()
  try {
    const payload = await client.send('Network.getAllCookies').catch(() => ({ cookies: [] }))
    return Array.isArray(payload?.cookies) ? payload.cookies : []
  } finally {
    await client.detach().catch(() => null)
  }
}

function getHyperbrowserClient() {
  if (!HYPERBROWSER_API_KEY) {
    throw new Error('Missing HYPERBROWSER_API_KEY')
  }
  if (!hyperbrowserClient) {
    hyperbrowserClient = new Hyperbrowser({ apiKey: HYPERBROWSER_API_KEY })
  }
  return hyperbrowserClient
}

async function readHyperProfileMeta(profileId) {
  const raw = await fsp.readFile(hyperProfileMetaPath(profileId), 'utf8')
  return JSON.parse(raw)
}

async function writeHyperProfileMeta(profileId, payload) {
  const body = JSON.stringify(payload, null, 2)
  await fsp.mkdir(path.join(SESSION_ROOT, profileId), { recursive: true })
  await fsp.writeFile(hyperProfileMetaPath(profileId), body, 'utf8')
}

async function ensureHyperbrowserProfileId(profile) {
  const client = getHyperbrowserClient()
  const profileId = sanitizeProfileId(profile?.id)
  const profileName = safeProfileName(profile?.name)
  const existing = await readHyperProfileMeta(profileId).catch(() => null)

  if (existing?.hyperProfileId) {
    try {
      await client.profiles.get(existing.hyperProfileId)
      return existing.hyperProfileId
    } catch {
      // Recreate when the stored profile no longer exists remotely.
    }
  }

  const created = await client.profiles.create({
    name: `${profileName} (${profileId})`,
  })
  const hyperProfileId = String(created?.id || '').trim()
  if (!hyperProfileId) {
    throw new Error('Hyperbrowser did not return a profile id')
  }
  await writeHyperProfileMeta(profileId, {
    hyperProfileId,
    profileName,
    updatedAt: new Date().toISOString(),
  })
  return hyperProfileId
}

async function getHyperbrowserLiveUrl(session) {
  const client = getHyperbrowserClient()
  const detail = await client.sessions.get(session.hyperSessionId, {
    liveViewTtlSeconds: HYPERBROWSER_LIVE_VIEW_TTL_SECONDS,
  })
  const liveUrl = String(detail?.liveUrl || '').trim()
  if (!liveUrl) {
    throw new Error('Hyperbrowser session did not return a live URL')
  }
  session.viewerUrl = liveUrl
  session.updatedAt = new Date().toISOString()
  return liveUrl
}

async function ensureSessionDirs(profileId) {
  await fsp.mkdir(path.join(sessionHomeDir(profileId), '.vnc'), { recursive: true })
  await fsp.mkdir(sessionChromeDir(profileId), { recursive: true })
}

async function readSessionMeta(profileId) {
  const raw = await fsp.readFile(sessionMetaPath(profileId), 'utf8')
  return JSON.parse(raw)
}

async function cleanupVncArtifacts(profileId) {
  const vncDir = path.join(sessionHomeDir(profileId), '.vnc')
  const entries = await fsp.readdir(vncDir).catch(() => [])
  await Promise.all(entries
    .filter((name) => name.endsWith('.pid') || name.endsWith('.log') || name.endsWith('.sock'))
    .map((name) => fsp.rm(path.join(vncDir, name), { force: true })))
}

async function cleanupChromeLocks(profileId) {
  const chromeDir = sessionChromeDir(profileId)
  await Promise.all([
    fsp.rm(path.join(chromeDir, 'SingletonCookie'), { force: true, recursive: true }),
    fsp.rm(path.join(chromeDir, 'SingletonLock'), { force: true, recursive: true }),
    fsp.rm(path.join(chromeDir, 'SingletonSocket'), { force: true, recursive: true }),
    fsp.rm(path.join(chromeDir, 'Default', 'LOCK'), { force: true }),
  ])
}

function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

function extractAuthToken(req) {
  const explicit = String(req.headers['x-auth-token'] || '').trim()
  if (explicit) return explicit
  const authorization = String(req.headers.authorization || '').trim()
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ? String(match[1]).trim() : ''
}

async function requireAuthorized(req) {
  const token = extractAuthToken(req)
  if (!token) {
    throw new Error('Unauthorized')
  }

  const cached = authCache.get(token)
  if (cached && (Date.now() - cached.checkedAt) < AUTH_CACHE_TTL_MS) {
    return token
  }

  const response = await fetch(`${WORKER_URL}/api/me`, {
    headers: {
      Accept: 'application/json',
      'x-auth-token': token,
    },
  })

  if (!response.ok) {
    throw new Error('Unauthorized')
  }

  authCache.set(token, { checkedAt: Date.now() })
  return token
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    const appendChunk = (current, chunk, markTruncated) => {
      if (current.length >= MAX_COMMAND_OUTPUT_CHARS) {
        markTruncated()
        return current
      }
      const remaining = MAX_COMMAND_OUTPUT_CHARS - current.length
      const text = chunk.toString('utf8')
      if (text.length <= remaining) {
        return current + text
      }
      markTruncated()
      return current + text.slice(0, remaining)
    }

    child.stdout?.on('data', (chunk) => {
      stdout = appendChunk(stdout, chunk, () => {
        stdoutTruncated = true
      })
    })
    child.stderr?.on('data', (chunk) => {
      stderr = appendChunk(stderr, chunk, () => {
        stderrTruncated = true
      })
    })
    if (typeof options.input === 'string' && child.stdin) {
      child.stdin.write(options.input)
    }
    child.stdin?.end()
    child.on('error', reject)
    child.on('close', (code) => {
      const finalStdout = stdoutTruncated ? `${stdout}\n...[stdout truncated]` : stdout
      const finalStderr = stderrTruncated ? `${stderr}\n...[stderr truncated]` : stderr
      if (code === 0) {
        resolve({ stdout: finalStdout, stderr: finalStderr })
        return
      }
      reject(new Error(finalStderr.trim() || finalStdout.trim() || `${command} exited with code ${code}`))
    })
  })
}

async function waitForHttp(port, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortReachable(port)) return
    await sleep(500)
  }
  throw new Error(`Timed out waiting for KasmVNC on port ${port}`)
}

async function isPortReachable(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: KASM_CONNECT_HOST,
      port,
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveFreeAllocation() {
  for (let display = DISPLAY_START; display <= DISPLAY_END; display++) {
    const kasmPort = KASM_PORT_START + (display - DISPLAY_START)
    if (kasmPort > KASM_PORT_END) break
    const taken = reservedDisplays.has(display)
      || reservedPorts.has(kasmPort)
      || Array.from(sessions.values()).some((session) => session.display === display || session.kasmPort === kasmPort)
    if (!taken) return { display, kasmPort }
  }
  throw new Error('No free KasmVNC slots available')
}

function reserveAllocation(display, kasmPort) {
  reservedDisplays.add(display)
  reservedPorts.add(kasmPort)
}

function releaseAllocation(display, kasmPort) {
  reservedDisplays.delete(display)
  reservedPorts.delete(kasmPort)
}

function sessionEnv(session) {
  return {
    ...process.env,
    HOME: session.homeDir,
    DISPLAY: `:${session.display}`,
  }
}

async function writeSessionFiles(session, initialUrl) {
  const startupUrl = normalizeUrl(initialUrl || session.homepage || 'about:blank') || 'about:blank'
  const vncDir = path.join(session.homeDir, '.vnc')
  const yaml = [
    'network:',
    '  protocol: http',
    `  interface: ${KASM_BIND_INTERFACE}`,
    `  websocket_port: ${session.kasmPort}`,
    '  ssl:',
    '    require_ssl: false',
    '  udp:',
    `    public_ip: ${KASM_PUBLIC_IP}`,
    `    port: ${session.kasmPort}`,
    'desktop:',
    '  allow_resize: true',
    '  resolution:',
    `    width: ${SESSION_WIDTH}`,
    `    height: ${SESSION_HEIGHT}`,
    '  pixel_depth: 24',
    'server:',
    '  http:',
    '    httpd_directory: /usr/share/kasmvnc/www',
    '  advanced:',
    `    kasm_password_file: ${sessionKasmPasswordPath(session.profileId)}`,
    'command_line:',
    '  prompt: false',
  ].join('\n') + '\n'

  const startupScript = `#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export HOME=${shEscape(session.homeDir)}
mkdir -p "$HOME/Downloads"
if command -v openbox-session >/dev/null 2>&1; then
  openbox-session >/tmp/openbox-${session.profileId}.log 2>&1 &
fi
exec ${shEscape(CHROME_BIN)} \\
  --user-data-dir=${shEscape(session.chromeDir)} \\
  --no-sandbox \\
  --disable-setuid-sandbox \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-dev-shm-usage \\
  --disable-session-crashed-bubble \\
  --hide-crash-restore-bubble \\
  --password-store=basic \\
  --ozone-platform=x11 \\
  --enable-unsafe-swiftshader \\
  --window-size=${SESSION_WIDTH},${SESSION_HEIGHT} \\
  --new-window \\
  ${shEscape(startupUrl)}
`

  await fsp.writeFile(path.join(session.homeDir, '.Xauthority'), '', 'utf8')
  await fsp.writeFile(path.join(vncDir, '.de-was-selected'), '', 'utf8')
  await runCommand(KASM_PASSWD_BIN, ['-u', KASM_USERNAME, '-w', sessionKasmPasswordPath(session.profileId)], {
    env: sessionEnv(session),
    input: `${session.kasmPassword}\n${session.kasmPassword}\n`,
  })
  await fsp.writeFile(kasmConfigPath(session.profileId), yaml, 'utf8')
  await fsp.writeFile(kasmStartupPath(session.profileId), startupScript, { mode: 0o755 })
}

async function writeSessionMeta(session) {
  const body = JSON.stringify({
    profileId: session.profileId,
    profileName: session.profileName,
    display: session.display,
    kasmPort: session.kasmPort,
    viewerToken: session.viewerToken,
    createdAt: session.createdAt,
    homepage: session.homepage,
  }, null, 2)
  await fsp.writeFile(sessionMetaPath(session.profileId), body, 'utf8')
}

async function syncProfileDown(session) {
  if (!session.authToken) return
  const response = await fetch(`${WORKER_URL}/api/sync/${encodeURIComponent(session.profileId)}/download`, {
    headers: { 'x-auth-token': session.authToken },
  })

  if (response.status === 404) return
  if (!response.ok) {
    throw new Error(`Browser data download failed: HTTP ${response.status}`)
  }

  const archivePath = path.join(SESSION_ROOT, session.profileId, 'download.tar.gz')
  const stageDir = sessionChromeStageDir(session.profileId)
  const data = Buffer.from(await response.arrayBuffer())
  await fsp.writeFile(archivePath, data)
  try {
    await fsp.rm(stageDir, { recursive: true, force: true })
    await fsp.mkdir(stageDir, { recursive: true })
    await runCommand('tar', ['-xzf', archivePath, '-C', stageDir])
    await fsp.rm(session.chromeDir, { recursive: true, force: true })
    await fsp.rename(stageDir, session.chromeDir)
  } finally {
    await fsp.rm(archivePath, { force: true })
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => null)
  }
}

async function syncProfileUp(session) {
  if (!session.authToken) return

  const entries = await fsp.readdir(session.chromeDir).catch(() => [])
  if (entries.length === 0) return

  const archivePath = path.join(SESSION_ROOT, session.profileId, 'upload.tar.gz')
  await runCommand('tar', ['-czf', archivePath, '-C', session.chromeDir, '.'])

  const archive = await fsp.readFile(archivePath)
  const response = await fetch(`${WORKER_URL}/api/sync/${encodeURIComponent(session.profileId)}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/gzip',
      'x-auth-token': session.authToken,
    },
    body: archive,
  })

  await fsp.rm(archivePath, { force: true })

  if (!response.ok) {
    throw new Error(`Browser data upload failed: HTTP ${response.status}`)
  }
}

async function sessionOwnsDisplay(session) {
  try {
    const { stdout } = await runCommand('ps', ['-ef'])
    const displayNeedle = `:${session.display}`
    const passwordNeedle = sessionKasmPasswordPath(session.profileId)
    return stdout.split('\n').some((line) => (
      line.includes('Xvnc') &&
      line.includes(displayNeedle) &&
      line.includes(passwordNeedle)
    ))
  } catch {
    return false
  }
}

async function isSessionHealthy(session) {
  if (isHyperbrowserSession(session)) {
    return isHyperbrowserSessionHealthy(session)
  }
  if (!(await sessionOwnsDisplay(session))) {
    return false
  }
  return isPortReachable(session.kasmPort)
}

async function openUrlInSession(session, url) {
  const targetUrl = normalizeUrl(url)
  if (!targetUrl) return
  const child = spawn(CHROME_BIN, [
    `--user-data-dir=${session.chromeDir}`,
    '--new-tab',
    targetUrl,
  ], {
    env: sessionEnv(session),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function openUrlInHyperbrowserSession(session, url) {
  const targetUrl = normalizeUrl(url)
  if (!targetUrl || !session.browser?.isConnected?.()) return
  const page = await session.browser.newPage()
  await page.setViewport(session.viewport).catch(() => null)
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  }).catch(() => null)
  session.page = page
  session.homepage = targetUrl
  session.updatedAt = new Date().toISOString()
}

async function isHyperbrowserSessionHealthy(session) {
  if (!session?.hyperSessionId || !session.browser?.isConnected?.()) {
    return false
  }
  try {
    const client = getHyperbrowserClient()
    const detail = await client.sessions.get(session.hyperSessionId, {
      liveViewTtlSeconds: HYPERBROWSER_LIVE_VIEW_TTL_SECONDS,
    })
    const status = String(detail?.status || '').trim().toLowerCase()
    if (status !== 'active') {
      return false
    }
    const liveUrl = String(detail?.liveUrl || '').trim()
    if (liveUrl) {
      session.viewerUrl = liveUrl
    }
    return true
  } catch {
    return false
  }
}

async function startHyperbrowserSession(profile, requestedUrl, authToken, requestedViewport) {
  const profileId = sanitizeProfileId(profile?.id)
  const inflight = pendingStarts.get(profileId)
  if (inflight) {
    return inflight
  }

  const startPromise = (async () => {
    const existing = sessions.get(profileId)
    if (existing && await isHyperbrowserSessionHealthy(existing)) {
      if (requestedUrl) {
        await openUrlInHyperbrowserSession(existing, requestedUrl)
      }
      await getHyperbrowserLiveUrl(existing).catch(() => null)
      existing.updatedAt = new Date().toISOString()
      return { session: existing, created: false }
    }

    if (existing) {
      sessions.delete(profileId)
    }

    const homepage = resolveProfileHomepage(profile, requestedUrl)
    const viewport = clampViewport(requestedViewport || {
      width: SESSION_WIDTH,
      height: SESSION_HEIGHT,
      deviceScaleFactor: 1,
    })
    const hyperProfileId = await ensureHyperbrowserProfileId(profile)
    const client = getHyperbrowserClient()
    const detail = await client.sessions.create({
      useStealth: HYPERBROWSER_USE_STEALTH,
      acceptCookies: HYPERBROWSER_ACCEPT_COOKIES,
      enableWindowManager: HYPERBROWSER_ENABLE_WINDOW_MANAGER,
      viewOnlyLiveView: HYPERBROWSER_VIEW_ONLY,
      liveViewTtlSeconds: HYPERBROWSER_LIVE_VIEW_TTL_SECONDS,
      timeoutMinutes: HYPERBROWSER_TIMEOUT_MINUTES,
      screen: {
        width: viewport.width,
        height: viewport.height,
      },
      profile: {
        id: hyperProfileId,
        persistChanges: true,
        persistNetworkCache: true,
      },
    })

    const hyperSessionId = String(detail?.id || '').trim()
    const wsEndpoint = String(detail?.wsEndpoint || '').trim()
    const viewerUrl = String(detail?.liveUrl || '').trim()
    if (!hyperSessionId || !wsEndpoint || !viewerUrl) {
      throw new Error('Hyperbrowser did not return a usable session payload')
    }

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null,
    })

    try {
      const existingPages = await browser.pages().catch(() => [])
      const page = existingPages[0] || await browser.newPage()
      await page.setViewport(viewport).catch(() => null)

      const cookies = await downloadProfileCookies(profileId, authToken).catch((error) => {
        console.warn(`[launcher] hyperbrowser cookie restore skipped for ${profileId}: ${String(error)}`)
        return []
      })
      const mappedCookies = mapCookiesForPuppeteer(cookies)
      if (mappedCookies.length > 0) {
        await page.setCookie(...mappedCookies).catch(() => null)
      }

      if (homepage) {
        await page.goto(homepage, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        }).catch(() => null)
      }

      const session = {
        backend: 'hyperbrowser',
        profileId,
        profileName: safeProfileName(profile?.name),
        homepage,
        authToken: String(authToken || '').trim(),
        viewerToken: '',
        viewerUrl,
        browser,
        page,
        viewport,
        hyperSessionId,
        hyperProfileId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      sessions.set(profileId, session)
      console.log(`[launcher] hyperbrowser session ready ${profileId} -> ${viewerUrl}`)
      return { session, created: true }
    } catch (error) {
      await browser.disconnect().catch(() => null)
      await client.sessions.stop(hyperSessionId).catch(() => null)
      throw error
    }
  })()

  pendingStarts.set(profileId, startPromise)
  try {
    return await startPromise
  } finally {
    pendingStarts.delete(profileId)
  }
}

async function stopHyperbrowserSession(profileId) {
  const normalizedProfileId = sanitizeProfileId(profileId)
  const session = sessions.get(normalizedProfileId)
  if (!session) {
    return { success: true, stopped: false }
  }

  uploading.add(normalizedProfileId)
  try {
    let uploaded = false
    const cookies = await snapshotSessionCookies(session.page).catch((error) => {
      console.warn(`[launcher] hyperbrowser cookie snapshot failed for ${normalizedProfileId}: ${String(error)}`)
      return []
    })
    await uploadProfileCookies(normalizedProfileId, session.authToken, cookies).then(() => {
      uploaded = true
    }).catch((error) => {
      console.warn(`[launcher] hyperbrowser cookie upload failed for ${normalizedProfileId}: ${String(error)}`)
    })
    await session.browser?.disconnect?.().catch(() => null)
    await getHyperbrowserClient().sessions.stop(session.hyperSessionId).catch((error) => {
      console.warn(`[launcher] hyperbrowser stop failed for ${normalizedProfileId}: ${String(error)}`)
    })
    sessions.delete(normalizedProfileId)
    return { success: true, stopped: true, uploaded }
  } finally {
    uploading.delete(normalizedProfileId)
  }
}

async function restoreSessionFromDisk(profileId) {
  if (sessions.has(profileId)) {
    return sessions.get(profileId)
  }

  const meta = await readSessionMeta(profileId).catch(() => null)
  if (!meta?.viewerToken) {
    return null
  }

  const session = buildSessionFromMeta(meta)
  if (!Number.isFinite(session.display) || !Number.isFinite(session.kasmPort)) {
    return null
  }

  if (!(await isSessionHealthy(session))) {
    await fsp.rm(sessionMetaPath(profileId), { force: true }).catch(() => null)
    return null
  }

  sessions.set(profileId, session)
  return session
}

async function restoreLiveSessionsFromDisk() {
  const entries = await fsp.readdir(SESSION_ROOT, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profileId = entry.name
    try {
      await restoreSessionFromDisk(profileId)
    } catch (error) {
      console.warn(`[launcher] failed to restore ${profileId}: ${String(error)}`)
    }
  }
}

async function startSession(profile, requestedUrl, authToken, requestedViewport = null) {
  if (isHyperbrowserBackend()) {
    return startHyperbrowserSession(profile, requestedUrl, authToken, requestedViewport)
  }

  const profileId = sanitizeProfileId(profile?.id)
  const inflight = pendingStarts.get(profileId)
  if (inflight) {
    return inflight
  }

  const startPromise = (async () => {
    const existing = sessions.get(profileId)

    if (existing && await isSessionHealthy(existing)) {
      if (requestedUrl) {
        await openUrlInSession(existing, requestedUrl)
      }
      existing.updatedAt = new Date().toISOString()
      return { session: existing, created: false }
    }

    if (existing) {
      sessions.delete(profileId)
    }

    const { display, kasmPort } = resolveFreeAllocation()
    reserveAllocation(display, kasmPort)
    const session = {
      profileId,
      profileName: safeProfileName(profile?.name),
      homepage: resolveProfileHomepage(profile, requestedUrl),
      authToken: String(authToken || '').trim(),
      viewerToken: randomHex(24),
      kasmPassword: randomHex(24),
      display,
      kasmPort,
      homeDir: sessionHomeDir(profileId),
      chromeDir: sessionChromeDir(profileId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    console.log(`[launcher] starting session ${profileId} on display :${display} port ${kasmPort}`)
    await ensureSessionDirs(profileId)
    await cleanupVncArtifacts(profileId)
    await runCommand('pkill', ['-f', `--user-data-dir=${session.chromeDir}`]).catch(() => null)
    await cleanupChromeLocks(profileId)
    await syncProfileDown(session).catch((error) => {
      console.warn(`[launcher] sync down skipped for ${profileId}: ${String(error)}`)
      return fsp.rm(session.chromeDir, { recursive: true, force: true })
        .then(() => fsp.mkdir(session.chromeDir, { recursive: true }))
        .catch(() => null)
    })
    await writeSessionFiles(session, requestedUrl)
    await writeSessionMeta(session)

    try {
      await runCommand(VNC_BIN, [
        `:${display}`,
        '-config',
        kasmConfigPath(profileId),
        '-interface',
        KASM_BIND_INTERFACE,
        '-geometry',
        `${SESSION_WIDTH}x${SESSION_HEIGHT}`,
        '-depth',
        '24',
        '-httpd',
        '/usr/share/kasmvnc/www',
        '-websocketPort',
        `${kasmPort}`,
        '-KasmPasswordFile',
        sessionKasmPasswordPath(profileId),
        '-DisableBasicAuth=1',
        '-xstartup',
        kasmStartupPath(profileId),
        'SecurityTypes=None',
      ], {
        env: sessionEnv(session),
      })

      await waitForHttp(kasmPort, WAIT_TIMEOUT_MS)
      sessions.set(profileId, session)
      console.log(`[launcher] session ready ${profileId} -> ${buildProxyTarget(session)}`)
      return { session, created: true }
    } catch (error) {
      await runCommand(VNC_BIN, ['-kill', `:${session.display}`], {
        env: sessionEnv(session),
      }).catch(() => null)
      await runCommand('pkill', ['-f', `--user-data-dir=${session.chromeDir}`]).catch(() => null)
      await fsp.rm(sessionMetaPath(profileId), { force: true }).catch(() => null)
      await cleanupVncArtifacts(profileId).catch(() => null)
      throw error
    } finally {
      releaseAllocation(display, kasmPort)
    }
  })()

  pendingStarts.set(profileId, startPromise)
  try {
    return await startPromise
  } finally {
    pendingStarts.delete(profileId)
  }
}

async function stopSession(profileId) {
  const normalizedProfileId = sanitizeProfileId(profileId)
  const session = sessions.get(normalizedProfileId)
  if (!session) {
    return { success: true, stopped: false }
  }

  if (isHyperbrowserSession(session)) {
    return stopHyperbrowserSession(normalizedProfileId)
  }

  uploading.add(normalizedProfileId)
  try {
    await syncProfileUp(session).catch((error) => {
      console.warn(`[launcher] sync up failed for ${normalizedProfileId}: ${String(error)}`)
    })
    await runCommand(VNC_BIN, ['-kill', `:${session.display}`], {
      env: sessionEnv(session),
    }).catch(() => null)
    await runCommand('pkill', ['-f', `--user-data-dir=${session.chromeDir}`]).catch(() => null)
    sessions.delete(normalizedProfileId)
    return { success: true, stopped: true }
  } finally {
    uploading.delete(normalizedProfileId)
  }
}

async function refreshSessions() {
  const dead = []
  for (const [profileId, session] of sessions.entries()) {
    if (!(await isSessionHealthy(session))) {
      dead.push(profileId)
    }
  }
  dead.forEach((profileId) => sessions.delete(profileId))
  if (!isHyperbrowserBackend()) {
    await restoreLiveSessionsFromDisk()
  }
}

function parseProxyPath(requestUrl) {
  const parsed = new URL(requestUrl, 'http://launcher.local')
  const prefix = `${SESSION_PATH_PREFIX}/`
  if (!parsed.pathname.startsWith(prefix)) return null

  const remainder = parsed.pathname.slice(prefix.length)
  const parts = remainder.split('/')
  if (parts.length < 3) return null

  const [rawProfileId, rawViewerToken, ...rest] = parts
  const profileId = decodeURIComponent(rawProfileId)
  const viewerToken = decodeURIComponent(rawViewerToken)
  const upstreamPath = `/${rest.join('/')}` || '/'
  return {
    profileId,
    viewerToken,
    upstreamPath: `${upstreamPath}${parsed.search}`,
  }
}

function resolveProfileHomepage(profile, requestedUrl) {
  const explicit = normalizeUrl(requestedUrl || '')
  if (explicit) return explicit

  const homepage = normalizeUrl(profile?.homepage || '')
  if (homepage) return homepage

  const uid = String(profile?.uid || '').trim()
  if (/^\d+$/.test(uid)) {
    return `https://www.facebook.com/profile.php?id=${uid}`
  }
  if (uid && !uid.includes('@')) {
    return `https://www.facebook.com/${encodeURIComponent(uid)}`
  }

  return 'https://www.facebook.com/'
}

async function handleLaunch(req, res) {
  const verifiedToken = await requireAuthorized(req)
  const body = await readJsonBody(req)
  const profile = body?.profile || {}
  const requestedUrl = body?.url || profile?.homepage || ''
  const requestedViewport = parseRequestedViewport(body?.viewport)
  const { session, created } = await startSession(profile, requestedUrl, verifiedToken, requestedViewport)
  json(res, 200, {
    success: true,
    created,
    profileId: session.profileId,
    profileName: session.profileName,
    viewer_url: buildViewerUrl(req, session.profileId),
  })
}

async function handleStatus(res) {
  await refreshSessions()
  json(res, 200, {
    success: true,
    running: Array.from(sessions.keys()),
    uploading: Array.from(uploading),
    android_running: [],
    android_uploading: [],
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    const parsedUrl = new URL(req.url, 'http://launcher.local')

    if (parsedUrl.pathname === '/health') {
      json(res, 200, {
        status: 'ok',
        sessions: sessions.size,
        backend: isHyperbrowserBackend() ? 'hyperbrowser' : 'kasm',
        hyperbrowser_configured: !!HYPERBROWSER_API_KEY,
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
      await requireAuthorized(req)
      await handleStatus(res)
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/sessions/launch') {
      await handleLaunch(req, res)
      return
    }

    const deleteMatch = parsedUrl.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'DELETE' && deleteMatch) {
      await requireAuthorized(req)
      const profileId = decodeURIComponent(deleteMatch[1])
      const result = await stopSession(profileId)
      json(res, 200, result)
      return
    }

    const proxyTarget = parseProxyPath(req.url)
    if (proxyTarget) {
      const session = sessions.get(proxyTarget.profileId) || await restoreSessionFromDisk(proxyTarget.profileId)
      if (!session || !(await isSessionHealthy(session))) {
        json(res, 404, { error: 'Session not found' })
        return
      }
      if (session.viewerToken !== proxyTarget.viewerToken) {
        json(res, 403, { error: 'Forbidden' })
        return
      }

      if (
        proxyTarget.upstreamPath.startsWith('/vnc.html')
        || proxyTarget.upstreamPath.startsWith('/vnc_lite.html')
      ) {
        await proxyViewerHtml(req, res, session, proxyTarget.upstreamPath)
        return
      }

      req.url = proxyTarget.upstreamPath
      proxy.web(req, res, { target: buildProxyTarget(session) })
      return
    }

    json(res, 404, { error: 'Not found' })
  } catch (error) {
    const detail = String(error)
    const statusCode = detail === 'Unauthorized' ? 401 : 500
    json(res, statusCode, { error: statusCode === 401 ? 'Unauthorized' : 'Launcher request failed', detail })
  }
})

server.on('upgrade', async (req, socket, head) => {
  const proxyTarget = parseProxyPath(req.url || '/')
  if (!proxyTarget) {
    socket.destroy()
    return
  }

  const session = sessions.get(proxyTarget.profileId) || await restoreSessionFromDisk(proxyTarget.profileId)
  if (!session || !(await isSessionHealthy(session))) {
    socket.destroy()
    return
  }
  if (session.viewerToken !== proxyTarget.viewerToken) {
    socket.destroy()
    return
  }

  const upstreamOrigin = `http://${KASM_CONNECT_HOST}:${session.kasmPort}`
  req.headers.host = `${KASM_CONNECT_HOST}:${session.kasmPort}`
  req.headers.origin = upstreamOrigin
  req.headers['sec-websocket-origin'] = upstreamOrigin
  req.url = proxyTarget.upstreamPath
  proxy.ws(req, socket, head, { target: buildProxyTarget(session) })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[launcher] listening on 0.0.0.0:${PORT}`)
  restoreLiveSessionsFromDisk().catch((error) => {
    console.warn(`[launcher] restore failed: ${String(error)}`)
  })
})
