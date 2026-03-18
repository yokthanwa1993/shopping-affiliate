// BrowserSaving HTTP Launcher — Standalone Node.js server
// Runs on port 3456, launches Chrome with profile data
// Also proxies CDP WebSocket connections for remote viewing
const http = require('http')
const { exec, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT = 3456
const SERVER_URL = 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev'

// Track running browsers: { profileId: { pid, debugPort } }
const runningBrowsers = {}
// Track profiles that are currently launching so parallel starts don't reuse the same debug port
const pendingBrowsers = {}
// Track recently released ports to avoid reuse (prevents old viewer tabs from reconnecting)
const recentlyUsedPorts = new Map() // port -> release timestamp
// Track reserved debug ports while a browser is still launching
const reservedDebugPorts = new Set()
// Track temp upload files per CDP port so they can be cleaned up when the session ends
const uploadedFilesByPort = new Map() // port -> { dir, files:Set<string> }

function normalizeAuthToken(raw) {
  return typeof raw === 'string' ? raw.trim() : ''
}

function getCacheDir() {
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'BrowserSaving')
    : path.join(os.homedir(), 'Library', 'Caches', 'BrowserSaving')
  return path.join(base, 'cache')
}

function getChromePath() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  }
  return 'google-chrome'
}

function findAvailablePort(existing) {
  let port = 49152 + (process.pid % 10000)
  const usedPorts = Object.values(existing).map(b => b.debugPort)
  const pendingPorts = Object.values(pendingBrowsers).map(b => b.debugPort)
  const now = Date.now()
  // Clean up ports older than 30s
  for (const [p, ts] of recentlyUsedPorts) {
    if (now - ts > 30000) recentlyUsedPorts.delete(p)
  }
  while (
    usedPorts.includes(port)
    || pendingPorts.includes(port)
    || reservedDebugPorts.has(port)
    || recentlyUsedPorts.has(port)
  ) {
    port++
  }
  return port
}

function reserveDebugPort(debugPort) {
  if (debugPort) reservedDebugPorts.add(Number(debugPort))
}

function releaseDebugPort(debugPort) {
  if (debugPort) reservedDebugPorts.delete(Number(debugPort))
}

function sanitizeUploadFileName(rawName) {
  let decoded = ''
  try {
    decoded = decodeURIComponent(String(rawName || ''))
  } catch {
    decoded = String(rawName || '')
  }

  const base = path.basename(decoded || 'upload.bin')
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 120)
  return safe || 'upload.bin'
}

function getUploadBucket(debugPort) {
  const key = Number(debugPort || 0)
  let bucket = uploadedFilesByPort.get(key)
  if (bucket && fs.existsSync(bucket.dir)) return bucket

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `browsersaving-upload-${key}-`))
  bucket = { dir, files: new Set() }
  uploadedFilesByPort.set(key, bucket)
  return bucket
}

function saveUploadedFile(debugPort, rawName, buffer) {
  const bucket = getUploadBucket(debugPort)
  const safeName = sanitizeUploadFileName(rawName)
  const uniqueName = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}-${safeName}`
  const filePath = path.join(bucket.dir, uniqueName)
  fs.writeFileSync(filePath, buffer)
  bucket.files.add(filePath)
  return filePath
}

function cleanupUploadedFiles(debugPort) {
  const key = Number(debugPort || 0)
  const bucket = uploadedFilesByPort.get(key)
  if (!bucket) return

  uploadedFilesByPort.delete(key)

  for (const filePath of bucket.files) {
    try { fs.unlinkSync(filePath) } catch {}
  }
  try { fs.rmSync(bucket.dir, { recursive: true, force: true }) } catch {}
}

function findRunningBrowserByPort(debugPort) {
  const targetPort = Number(debugPort || 0)
  return Object.entries(runningBrowsers).find(([, browser]) => Number(browser?.debugPort || 0) === targetPort) || null
}

function readBinaryBody(req, maxBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    function finish(err, value) {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }

    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        finish(new Error(`Upload too large (max ${maxBytes} bytes)`))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(Buffer.from(chunk))
    })

    req.on('end', () => finish(null, Buffer.concat(chunks)))
    req.on('error', (err) => finish(err))
  })
}

async function downloadBrowserData(profileId, authToken = '') {
  try {
    const cacheDir = path.join(getCacheDir(), profileId)
    const defaultDir = path.join(cacheDir, 'Default')

    // FAST PATH: If local profile has data, skip download
    if (fs.existsSync(defaultDir)) {
      const hasCookies = fs.existsSync(path.join(defaultDir, 'Cookies'))
      const hasPrefs = fs.existsSync(path.join(defaultDir, 'Preferences'))
      if (hasCookies || hasPrefs) {
        console.log(`[Launcher] Using local cache for ${profileId} (skip download)`)
        return
      }
    }

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

    // Correct API endpoint: /api/sync/{id}/download
    const url = `${SERVER_URL}/api/sync/${profileId}/download`
    console.log(`[Launcher] Downloading data for ${profileId}...`)
    console.log(`[Launcher] URL: ${url}`)
    const headers = authToken ? { 'x-auth-token': authToken } : undefined
    const resp = await fetch(url, { headers })
    if (resp.status === 404) {
      console.log(`[Launcher] No existing data for ${profileId}, starting fresh`)
      return
    }
    if (!resp.ok) {
      console.log(`[Launcher] Download returned ${resp.status}, starting fresh`)
      return
    }
    const buffer = await resp.arrayBuffer()
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2)
    console.log(`[Launcher] Downloaded ${sizeMB} MB`)

    // Save to OS temp dir (NOT inside cacheDir, which will be cleared)
    const tarPath = path.join(os.tmpdir(), `browser-${profileId}.tar.gz`)
    fs.writeFileSync(tarPath, Buffer.from(buffer))

    // Clear old cache and extract fresh
    if (fs.existsSync(cacheDir)) {
      try { fs.rmSync(cacheDir, { recursive: true, force: true }) } catch {}
    }
    fs.mkdirSync(cacheDir, { recursive: true })

    return new Promise((resolve) => {
      exec(`tar -xzf "${tarPath}" -C "${cacheDir}" 2>&1`, (err) => {
        if (err) console.log(`[Launcher] Extract warning: ${err.message}`)
        try { fs.unlinkSync(tarPath) } catch {}
        
        // Verify extraction
        const hasDefault = fs.existsSync(path.join(cacheDir, 'Default'))
        console.log(`[Launcher] Data ready for ${profileId} (Default dir: ${hasDefault})`)
        resolve()
      })
    })
  } catch (e) {
    console.log(`[Launcher] Download failed: ${e.message}`)
  }
}

// Wait for Chrome CDP to be ready
async function waitForCDPReady(port, maxWaitMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          let body = ''
          res.on('data', chunk => body += chunk)
          res.on('end', () => resolve(JSON.parse(body)))
        }).on('error', reject)
      })
      return data
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw new Error('CDP not ready after ' + maxWaitMs + 'ms')
}

// Fetch cookies from Worker API
async function fetchCookiesFromAPI(profileId, authToken = '') {
  const url = `${SERVER_URL}/api/sync/${profileId}/cookies`
  try {
    const headers = authToken ? { 'x-auth-token': authToken } : undefined
    const resp = await fetch(url, { headers })
    if (!resp.ok) {
      console.log(`[Launcher] Cookie fetch failed: HTTP ${resp.status}`)
      return []
    }
    const data = await resp.json().catch(() => ({}))
    return Array.isArray(data.cookies) ? data.cookies : []
  } catch (e) {
    console.log(`[Launcher] Cookie fetch failed: ${e.message}`)
    return []
  }
}

// Read local cookies.json fallback
function readLocalCookies(profileId) {
  const cookiesPath = path.join(getCacheDir(), profileId, 'cookies.json')
  if (!fs.existsSync(cookiesPath)) return []
  try {
    const data = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

// Inject cookies into Chrome via CDP WebSocket (must use page-level, not browser-level)
async function injectCookiesViaCDP(port, cookies) {
  const WebSocket = require('ws')
  
  // Get page-level WebSocket URL (Network.setCookies only works on page targets)
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch { resolve([]) }
      })
    }).on('error', reject)
  })

  if (!pages || pages.length === 0) throw new Error('No pages found in Chrome')
  const wsUrl = pages[0].webSocketDebuggerUrl
  if (!wsUrl) throw new Error('No WebSocket URL from page')

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let injected = 0

    ws.on('open', () => {
      const cdpCookies = cookies.map(c => ({
        name: c.name || '',
        value: c.value || '',
        domain: c.domain || '',
        path: c.path || '/',
        secure: c.secure || false,
        httpOnly: c.httpOnly || false,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      })).filter(c => c.name && c.domain)

      if (cdpCookies.length === 0) {
        ws.close()
        resolve(0)
        return
      }

      ws.send(JSON.stringify({
        id: 1,
        method: 'Network.setCookies',
        params: { cookies: cdpCookies }
      }))
      injected = cdpCookies.length
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === 1 && msg.error) {
          console.log(`[Launcher] setCookies error: ${JSON.stringify(msg.error)}`)
          injected = 0
        }
      } catch {}
      ws.close()
      resolve(injected)
    })

    ws.on('error', (e) => { ws.close(); reject(e) })
    setTimeout(() => { ws.close(); resolve(injected) }, 10000)
  })
}

// Main cookie injection flow
async function injectCookiesAfterLaunch(profileId, debugPort, authToken = '') {
  console.log(`[Launcher] Waiting for CDP ready on port ${debugPort}...`)
  await waitForCDPReady(debugPort)
  console.log(`[Launcher] CDP ready, fetching cookies...`)

  // Try Worker API first
  let cookies = await fetchCookiesFromAPI(profileId, authToken)
  console.log(`[Launcher] Worker API returned ${cookies.length} cookies`)

  // Fallback to local cookies.json
  if (cookies.length === 0) {
    cookies = readLocalCookies(profileId)
    console.log(`[Launcher] Local cookies.json: ${cookies.length} cookies`)
  }

  if (cookies.length === 0) {
    console.log(`[Launcher] No cookies to inject for ${profileId}`)
    return
  }

  const injected = await injectCookiesViaCDP(debugPort, cookies)
  console.log(`[Launcher] Injected ${injected}/${cookies.length} cookies for ${profileId}`)

  // Navigate to homepage after injection to apply cookies
  try {
    const pages = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${debugPort}/json`, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => resolve(JSON.parse(body)))
      }).on('error', reject)
    })
    if (pages.length > 0) {
      const pageWsUrl = pages[0].webSocketDebuggerUrl
      const WebSocket = require('ws')
      const ws = new WebSocket(pageWsUrl)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Page.navigate',
          params: { url: 'https://www.facebook.com/' }
        }))
        setTimeout(() => ws.close(), 2000)
      })
    }
  } catch (e) {
    console.log(`[Launcher] Navigate after inject failed: ${e.message}`)
  }
}

// Export all cookies from running Chrome via CDP
async function exportCookiesViaCDP(port) {
  const WebSocket = require('ws')

  // Get page WebSocket URL
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch { resolve([]) }
      })
    }).on('error', reject)
  })

  if (!pages || pages.length === 0) throw new Error('No pages found')
  const wsUrl = pages[0].webSocketDebuggerUrl
  if (!wsUrl) throw new Error('No WebSocket URL')

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Storage.getCookies',
        params: {}
      }))
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === 1) {
          const cookies = (msg.result && msg.result.cookies) || []
          // Format cookies for persistence
          const formatted = cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
          }))
          ws.close()
          resolve(formatted)
        }
      } catch {}
    })

    ws.on('error', (e) => { ws.close(); reject(e) })
    setTimeout(() => { ws.close(); resolve([]) }, 10000)
  })
}

// Upload browser data (cookies.json + essential files) to Cloudflare Worker
async function uploadCookiesToCloud(profileId, cacheDir, authToken = '') {
  const { execSync } = require('child_process')

  // Create tar.gz with cookies.json and essential browser files
  const tempTar = path.join(os.tmpdir(), `upload-${profileId.substring(0, 8)}.tar.gz`)

  // Collect files to include
  const filesToInclude = []
  const essentialFiles = [
    'cookies.json',
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Login Data',
    'Default/Login Data-journal',
    'Default/Preferences',
    'Default/Secure Preferences',
    'Default/Web Data',
    'Default/Web Data-journal',
    'Default/Favicons',
    'Default/History',
    'Default/History-journal',
    'Local State',
  ]

  for (const f of essentialFiles) {
    const fullPath = path.join(cacheDir, f)
    if (fs.existsSync(fullPath)) {
      filesToInclude.push(f)
    }
  }

  // Add Local Storage directory if exists
  const localStorageDir = path.join(cacheDir, 'Default', 'Local Storage')
  if (fs.existsSync(localStorageDir)) {
    filesToInclude.push('Default/Local Storage')
  }

  if (filesToInclude.length === 0) {
    console.log('[Launcher] No files to upload')
    return
  }

  // Create tar.gz
  try {
    const tarCmd = process.platform === 'win32'
      ? `tar -czf "${tempTar}" ${filesToInclude.map(f => `"${f}"`).join(' ')}`
      : `tar -czf "${tempTar}" ${filesToInclude.map(f => `'${f}'`).join(' ')}`

    execSync(tarCmd, { cwd: cacheDir, timeout: 30000 })
    console.log(`[Launcher] Created tar.gz: ${fs.statSync(tempTar).size} bytes`)
  } catch (e) {
    console.log(`[Launcher] tar creation failed: ${e.message}`)
    return
  }

  // Upload to Worker API
  const tarData = fs.readFileSync(tempTar)
  const uploadUrl = `${SERVER_URL}/api/sync/${profileId}/upload`

  try {
    const headers = {
      'Content-Type': 'application/gzip',
    }
    if (authToken) {
      headers['x-auth-token'] = authToken
    }

    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: tarData,
    })
    const body = await resp.text()
    console.log(`[Launcher] Upload response: ${resp.status} ${body.substring(0, 200)}`)
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }
  } catch (e) {
    console.log(`[Launcher] Upload failed: ${e.message}`)
    throw e
  }

  // Cleanup temp file
  try { fs.unlinkSync(tempTar) } catch {}
}

function launchChrome(profile, debugPort) {
  const chromePath = getChromePath()
  const cacheDir = path.join(getCacheDir(), profile.id)
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  // Remove Chrome lock files that prevent re-launching after crash
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.unlinkSync(path.join(cacheDir, lockFile)) } catch {}
  }

  // Fix Chrome "Restore pages" dialog
  const defaultDir = path.join(cacheDir, 'Default')
  if (fs.existsSync(defaultDir)) {
    // Delete session restore files
    for (const f of ['Last Session', 'Last Tabs', 'Current Session', 'Current Tabs']) {
      try { fs.unlinkSync(path.join(defaultDir, f)) } catch {}
    }
    // Fix Preferences JSON
    for (const pf of ['Preferences']) {
      const p = path.join(defaultDir, pf)
      try {
        if (fs.existsSync(p)) {
          const prefs = JSON.parse(fs.readFileSync(p, 'utf8'))
          // Mark clean exit
          if (prefs.profile) {
            prefs.profile.exit_type = 'Normal'
            prefs.profile.exited_cleanly = true
          }
          // Disable session restore
          if (!prefs.session) prefs.session = {}
          prefs.session.restore_on_startup = 1 // 1 = new tab, 4 = URLs, 5 = last session
          // Remove crash recovery flags
          delete prefs.session_cookie_restored_on_startup
          fs.writeFileSync(p, JSON.stringify(prefs))
        }
      } catch (e) {
        // Fallback: regex replacement
        try {
          let data = fs.readFileSync(p, 'utf8')
          data = data.replace(/"exit_type"\s*:\s*"[^"]*"/, '"exit_type":"Normal"')
          data = data.replace(/"exited_cleanly"\s*:\s*false/, '"exited_cleanly":true')
          fs.writeFileSync(p, data)
        } catch {}
      }
    }
  }

  const args = [
    `--user-data-dir=${cacheDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    '--lang=th',
    '--accept-lang=th,th-TH,en-US,en',
    `--remote-debugging-port=${debugPort}`,
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-sync',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--noerrdialogs',
    '--hide-crash-restore-bubble',
    '--disable-features=InfiniteSessionRestore',
  ]

  const homepage = (profile.homepage || '').trim()
  if (homepage) {
    args.push(homepage)
  } else {
    args.push('chrome://extensions/')
  }

  console.log(`[Launcher] Starting Chrome: ${chromePath}`)
  console.log(`[Launcher] Debug port: ${debugPort}`)

  const child = spawn(chromePath, args, {
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
  })
  child.unref()
  return child.pid
}

function killProcess(pid, debugPort) {
  try {
    if (process.platform === 'win32') {
      // Kill by PID tree
      exec(`taskkill /PID ${pid} /F /T`, () => {})
      // Also kill by debug port (Chrome may have different PID)
      if (debugPort) {
        exec(`powershell -Command "Get-NetTCPConnection -LocalPort ${debugPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`, () => {})
      }
    } else {
      process.kill(pid)
    }
  } catch {}
  if (debugPort) cleanupUploadedFiles(debugPort)
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-file-name, x-file-type, x-file-last-modified')
}

function sendJSON(res, statusCode, data) {
  setCorsHeaders(res)
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body)) }
      catch { resolve({}) }
    })
  })
}

// Proxy HTTP request to Chrome CDP on localhost
function proxyCDP(req, res, targetPort, targetPath) {
  setCorsHeaders(res)
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  }
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', (e) => {
    sendJSON(res, 502, { error: `CDP proxy error: ${e.message}` })
  })
  req.pipe(proxyReq)
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res)
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  // GET /api/status
  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      running: Object.keys(runningBrowsers),
      launching: Object.keys(pendingBrowsers),
      uploading: [],
    })
    return
  }

  // GET /api/cdp/:port/json — proxy CDP page list
  const cdpJsonMatch = url.pathname.match(/^\/api\/cdp\/(\d+)\/json$/)
  if (cdpJsonMatch && req.method === 'GET') {
    const targetPort = parseInt(cdpJsonMatch[1])
    proxyCDP(req, res, targetPort, '/json')
    return
  }

  // POST /api/cdp/:port/file — receive file bytes from viewer and store locally for DOM.setFileInputFiles
  const cdpFileMatch = url.pathname.match(/^\/api\/cdp\/(\d+)\/file$/)
  if (cdpFileMatch && req.method === 'POST') {
    const targetPort = parseInt(cdpFileMatch[1])
    const browserEntry = findRunningBrowserByPort(targetPort)
    if (!browserEntry) {
      sendJSON(res, 404, { success: false, error: 'Browser session not found for this port' })
      return
    }

    try {
      const fileBuffer = await readBinaryBody(req)
      if (!fileBuffer || fileBuffer.length === 0) {
        sendJSON(res, 400, { success: false, error: 'Empty upload body' })
        return
      }

      const rawNameHeader = req.headers['x-file-name']
      const rawName = Array.isArray(rawNameHeader) ? rawNameHeader[0] : rawNameHeader
      const filePath = saveUploadedFile(targetPort, rawName, fileBuffer)

      sendJSON(res, 200, {
        success: true,
        path: filePath,
        size: fileBuffer.length,
      })
    } catch (e) {
      const message = String(e?.message || e || 'Upload failed')
      const status = /too large/i.test(message) ? 413 : 500
      sendJSON(res, status, { success: false, error: message })
    }
    return
  }

  // POST /api/launch
  if (url.pathname === '/api/launch' && req.method === 'POST') {
    const body = await readBody(req)
    const profile = body.profile
    const authToken = normalizeAuthToken(body.auth_token)
    if (!profile || !profile.id) {
      sendJSON(res, 400, { success: false, error: 'Missing profile' })
      return
    }

    if (runningBrowsers[profile.id]) {
      sendJSON(res, 409, { success: false, error: 'Browser already running' })
      return
    }
    if (pendingBrowsers[profile.id]) {
      sendJSON(res, 409, { success: false, error: 'Browser is still launching' })
      return
    }

    let debugPort = 0
    try {
      debugPort = findAvailablePort(runningBrowsers)
      reserveDebugPort(debugPort)
      pendingBrowsers[profile.id] = { debugPort, name: profile.name, authToken }

      await downloadBrowserData(profile.id, authToken)

      const pid = launchChrome(profile, debugPort)
      console.log(`[Launcher] Chrome launched PID=${pid} port=${debugPort} for ${profile.name}`)

      runningBrowsers[profile.id] = { pid, debugPort, name: profile.name, authToken }
      delete pendingBrowsers[profile.id]
      releaseDebugPort(debugPort)

      // Inject cookies in background (don't block response)
      injectCookiesAfterLaunch(profile.id, debugPort, authToken).catch(e => {
        console.log(`[Launcher] Cookie injection failed: ${e.message}`)
      })

      // Monitor browser by checking CDP port (not PID — Chrome may change PID on Windows)
      const checkInterval = setInterval(() => {
        const req = http.get(`http://127.0.0.1:${debugPort}/json/version`, (res) => {
          let data = ''
          res.on('data', c => data += c)
          res.on('end', () => {
            // CDP still responding — browser is alive
          })
        })
        req.on('error', () => {
          // CDP not responding — browser has exited
          if (runningBrowsers[profile.id]) {
            console.log(`[Launcher] Chrome on port ${debugPort} no longer responding — marking stopped`)
            delete runningBrowsers[profile.id]
            releaseDebugPort(debugPort)
            cleanupUploadedFiles(debugPort)
          }
          clearInterval(checkInterval)
        })
        req.setTimeout(3000, () => {
          req.destroy()
        })
      }, 5000)

      const name = encodeURIComponent(profile.name)
      const serverHost = req.headers.host?.split(':')[0] || '100.82.152.81'
      const viewerUrl = `/remote-viewer.html?host=${serverHost}&port=${debugPort}&name=${name}`

      sendJSON(res, 200, {
        success: true,
        debug_port: debugPort,
        viewer_url: viewerUrl,
      })
    } catch (e) {
      delete pendingBrowsers[profile.id]
      releaseDebugPort(debugPort)
      sendJSON(res, 500, { success: false, error: e.message })
    }
    return
  }

  // POST /api/stop
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    const body = await readBody(req)
    const profileId = body.profile_id
    if (!profileId) {
      sendJSON(res, 400, { success: false, error: 'Missing profile_id' })
      return
    }

    const browser = runningBrowsers[profileId]
    if (browser) {
      const authToken = normalizeAuthToken(body.auth_token) || normalizeAuthToken(browser.authToken)
      let cookies = []
      // Step 1: Export cookies while Chrome is still running
      try {
        console.log(`[Launcher] Exporting cookies before stop for ${profileId}...`)
        cookies = await exportCookiesViaCDP(browser.debugPort)
        console.log(`[Launcher] Exported ${cookies.length} cookies`)
      } catch (e) {
        console.log(`[Launcher] Cookie export failed: ${e.message}`)
      }

      // Step 2: Kill Chrome + reserve port
      recentlyUsedPorts.set(browser.debugPort, Date.now())
      killProcess(browser.pid, browser.debugPort)
      delete runningBrowsers[profileId]
      releaseDebugPort(browser.debugPort)
      console.log(`[Launcher] Stopped browser for ${profileId} (port ${browser.debugPort} reserved 30s)`)

      // Step 3: Wait for file locks to release, then save + upload
      if (cookies.length > 0) {
        await new Promise(r => setTimeout(r, 1500))
        try {
          const cacheDir = path.join(getCacheDir(), profileId)
          if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
          const cookiesPath = path.join(cacheDir, 'cookies.json')
          fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2))
          console.log(`[Launcher] Saved cookies.json locally`)

          // Upload to Cloudflare Worker
          await uploadCookiesToCloud(profileId, cacheDir, authToken)
        } catch (e) {
          console.log(`[Launcher] Save/upload failed: ${e.message}`)
        }
      }
    }

    sendJSON(res, 200, { success: true })
    return
  }

  // 404
  sendJSON(res, 404, { success: false, error: 'Not found' })
})

// WebSocket upgrade handler — proxy CDP WebSocket connections
server.on('upgrade', (req, socket, head) => {
  // Expected path: /api/cdp/:port/devtools/...
  const match = req.url.match(/^\/api\/cdp\/(\d+)(\/devtools\/.*)$/)
  if (!match) {
    socket.destroy()
    return
  }

  const targetPort = parseInt(match[1])
  const targetPath = match[2]

  console.log(`[WS-Proxy] Proxying WebSocket to 127.0.0.1:${targetPort}${targetPath}`)

  const net = require('net')
  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    // Build HTTP upgrade request to upstream
    let upgradeReq = `GET ${targetPath} HTTP/1.1\r\n`
    upgradeReq += `Host: 127.0.0.1:${targetPort}\r\n`
    upgradeReq += `Upgrade: websocket\r\n`
    upgradeReq += `Connection: Upgrade\r\n`

    // Forward relevant headers
    for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
      if (req.headers[key]) {
        upgradeReq += `${key}: ${req.headers[key]}\r\n`
      }
    }
    upgradeReq += '\r\n'

    upstream.write(upgradeReq)
    if (head.length > 0) upstream.write(head)

    // Once upstream responds, relay everything bidirectionally
    let headerParsed = false
    let headerBuf = Buffer.alloc(0)

    upstream.on('data', (data) => {
      if (!headerParsed) {
        headerBuf = Buffer.concat([headerBuf, data])
        const headerEnd = headerBuf.indexOf('\r\n\r\n')
        if (headerEnd === -1) return

        // Send the HTTP response header to the client
        const headers = headerBuf.slice(0, headerEnd + 4)
        socket.write(headers)

        // Send remaining data
        const remaining = headerBuf.slice(headerEnd + 4)
        if (remaining.length > 0) socket.write(remaining)

        headerParsed = true

        // Now just pipe bidirectionally
        upstream.pipe(socket)
        socket.pipe(upstream)
      }
    })
  })

  upstream.on('error', (e) => {
    console.log(`[WS-Proxy] Error connecting to Chrome: ${e.message}`)
    socket.destroy()
  })

  socket.on('error', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(``)
  console.log(`  🚀 BrowserSaving Launcher Server`)
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`  Local:   http://localhost:${PORT}`)
  console.log(`  Network: http://0.0.0.0:${PORT}`)
  console.log(``)
  console.log(`  Endpoints:`)
  console.log(`    GET  /api/status        — running browsers`)
  console.log(`    POST /api/launch        — launch Chrome`)
  console.log(`    POST /api/stop          — stop Chrome`)
  console.log(`    GET  /api/cdp/:port/json — CDP page list (proxy)`)
  console.log(`    POST /api/cdp/:port/file — upload file for remote chooser`)
  console.log(`    WS   /api/cdp/:port/devtools/... — CDP WebSocket (proxy)`)
  console.log(``)
})
