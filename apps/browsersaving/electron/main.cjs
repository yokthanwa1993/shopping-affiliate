const { app, BrowserWindow, ipcMain, shell, session: electronSession } = require('electron')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const http = require('http')
const { createLocalLauncher } = require('./local-launcher.cjs')
const { createMobileEgressProxy } = require('./mobile-egress-proxy.cjs')
const { createLocalTokenService } = require('./local-token-service.cjs')

const DIST_DIR = path.join(__dirname, '..', 'dist')

const DEFAULT_RUNTIME_CONFIG = {
  serverUrl: process.env.BROWSERSAVING_SERVER_URL || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev',
  apiUrl: process.env.BROWSERSAVING_API_URL || 'https://browsersaving-api.pubilo.com',
  commentTokenServiceUrl: process.env.BROWSERSAVING_COMMENT_TOKEN_URL || 'https://token.pubilo.com/api/comment-token',
  remoteLauncherUrl: '',
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

let mainWindow = null
let webServer = null
let baseUrl = ''
const profileWindows = new Map()
let mobileProxy = null
let mobileProxyState = null
let localTokenService = null

const ELECTRON_PROFILE_IMPORT_MAP = [
  { to: ['Cookies'], candidates: [['Default', 'Cookies'], ['Default', 'Network', 'Cookies']] },
  { to: ['Cookies-journal'], candidates: [['Default', 'Cookies-journal'], ['Default', 'Network', 'Cookies-journal']] },
  { to: ['Local Storage'], candidates: [['Default', 'Local Storage']] },
  { to: ['Session Storage'], candidates: [['Default', 'Session Storage']] },
  { to: ['IndexedDB'], candidates: [['Default', 'IndexedDB']] },
  { to: ['Service Worker'], candidates: [['Default', 'Service Worker']] },
  { to: ['blob_storage'], candidates: [['Default', 'blob_storage']] },
  { to: ['Shared Dictionary'], candidates: [['Default', 'Shared Dictionary']] },
  { to: ['DIPS'], candidates: [['Default', 'DIPS']] },
  { to: ['DIPS-wal'], candidates: [['Default', 'DIPS-wal']] },
  { to: ['Trust Tokens'], candidates: [['Default', 'Trust Tokens']] },
  { to: ['Trust Tokens-journal'], candidates: [['Default', 'Trust Tokens-journal']] },
  { to: ['Preferences'], candidates: [['Default', 'Preferences']] },
]

const ELECTRON_PROFILE_EXPORT_MAP = [
  { from: ['Cookies'], to: ['Default', 'Cookies'] },
  { from: ['Cookies-journal'], to: ['Default', 'Cookies-journal'] },
  { from: ['Local Storage'], to: ['Default', 'Local Storage'] },
  { from: ['Session Storage'], to: ['Default', 'Session Storage'] },
  { from: ['IndexedDB'], to: ['Default', 'IndexedDB'] },
  { from: ['Service Worker'], to: ['Default', 'Service Worker'] },
  { from: ['blob_storage'], to: ['Default', 'blob_storage'] },
  { from: ['Shared Dictionary'], to: ['Default', 'Shared Dictionary'] },
  { from: ['DIPS'], to: ['Default', 'DIPS'] },
  { from: ['DIPS-wal'], to: ['Default', 'DIPS-wal'] },
  { from: ['Trust Tokens'], to: ['Default', 'Trust Tokens'] },
  { from: ['Trust Tokens-journal'], to: ['Default', 'Trust Tokens-journal'] },
  { from: ['Preferences'], to: ['Default', 'Preferences'] },
]

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function ensureParentDir(targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
}

async function removePathIfExists(targetPath) {
  await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => null)
}

async function copyPathIfExists(sourcePath, targetPath) {
  if (!(await pathExists(sourcePath))) return false
  await removePathIfExists(targetPath)
  await ensureParentDir(targetPath)
  await fsp.cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  })
  return true
}

function isLockLikeError(error) {
  const code = String(error?.code || '').toUpperCase()
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function copyPathIfExistsWithRetries(sourcePath, targetPath, { retries = 6, delayMs = 250, allowLockFailure = false } = {}) {
  let attempt = 0
  while (attempt <= retries) {
    try {
      return await copyPathIfExists(sourcePath, targetPath)
    } catch (error) {
      const retryable = isLockLikeError(error)
      if (!retryable || attempt === retries) {
        if (allowLockFailure && retryable) {
          console.warn(`[electron] skipped locked path ${sourcePath}: ${String(error)}`)
          return false
        }
        throw error
      }
      await delay(delayMs * (attempt + 1))
      attempt += 1
    }
  }
  return false
}

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true })
}

async function directoryHasEntries(targetPath) {
  try {
    const entries = await fsp.readdir(targetPath)
    return entries.length > 0
  } catch {
    return false
  }
}

function toCookieUrl(cookie) {
  const domain = String(cookie?.domain || '').trim().replace(/^\./, '')
  if (!domain) return null
  const secure = cookie?.secure !== false
  const pathName = String(cookie?.path || '/').trim() || '/'
  return `${secure ? 'https' : 'http'}://${domain}${pathName.startsWith('/') ? pathName : `/${pathName}`}`
}

function toElectronSameSite(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'strict') return 'strict'
  if (normalized === 'lax') return 'lax'
  if (normalized === 'none' || normalized === 'no_restriction') return 'no_restriction'
  return 'unspecified'
}

function fromElectronSameSite(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'no_restriction' || normalized === 'none') return 'None'
  return 'Unspecified'
}

async function clearSessionCookies(ses) {
  const cookies = await ses.cookies.get({})
  await Promise.all(cookies.map(async (cookie) => {
    const url = toCookieUrl(cookie)
    if (!url) return
    await ses.cookies.remove(url, cookie.name).catch(() => null)
  }))
}

async function importSessionCookies(ses, cookies, { replace = false } = {}) {
  if (!Array.isArray(cookies) || cookies.length === 0) return
  if (replace) {
    await clearSessionCookies(ses)
  }
  for (const cookie of cookies) {
    const url = toCookieUrl(cookie)
    if (!url) continue
    const payload = {
      url,
      name: String(cookie.name || '').trim(),
      value: String(cookie.value || '').trim(),
      path: String(cookie.path || '/').trim() || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.http_only ?? cookie.httpOnly ?? false,
      sameSite: toElectronSameSite(cookie.same_site ?? cookie.sameSite),
    }
    if (cookie.domain) {
      payload.domain = String(cookie.domain).trim()
    }
    const expires = Number(cookie.expires ?? cookie.expirationDate)
    if (Number.isFinite(expires) && expires > 0) {
      payload.expirationDate = expires
    }
    await ses.cookies.set(payload).catch((error) => {
      console.warn(`[electron] failed to set cookie ${payload.name}: ${String(error)}`)
    })
  }
}

async function exportSessionCookies(ses) {
  const cookies = await ses.cookies.get({})
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: cookie.secure ?? true,
    http_only: cookie.httpOnly ?? false,
    expires: Number.isFinite(cookie.expirationDate) ? cookie.expirationDate : -1,
    same_site: fromElectronSameSite(cookie.sameSite),
  }))
}

async function ensureSessionStorageBootstrapped(sessionState) {
  await ensureDir(sessionState.profileDir)
  await ensureDir(sessionState.storagePath)

  const hasExistingStorage = await directoryHasEntries(sessionState.storagePath)
  if (hasExistingStorage) {
    return
  }

  for (const entry of ELECTRON_PROFILE_IMPORT_MAP) {
    for (const candidate of entry.candidates) {
      const sourcePath = path.join(sessionState.profileDir, ...candidate)
      const targetPath = path.join(sessionState.storagePath, ...entry.to)
      if (await copyPathIfExists(sourcePath, targetPath)) {
        break
      }
    }
  }
}

async function syncSessionToProfile(sessionState) {
  const ses = sessionState.electronSession || electronSession.fromPath(sessionState.storagePath)
  try {
    const flushResult = ses.flushStorageData()
    if (flushResult && typeof flushResult.then === 'function') {
      await flushResult
    }
  } catch {
    // Best effort only.
  }

  await delay(500)

  await ensureDir(path.join(sessionState.profileDir, 'Default'))

  const cookies = await exportSessionCookies(ses)
  await fsp.writeFile(
    path.join(sessionState.profileDir, 'cookies.json'),
    JSON.stringify(cookies, null, 2),
    'utf8'
  )

  for (const entry of ELECTRON_PROFILE_EXPORT_MAP) {
    const sourcePath = path.join(sessionState.storagePath, ...entry.from)
    const targetPath = path.join(sessionState.profileDir, ...entry.to)
    const basename = path.basename(sourcePath).toLowerCase()
    const allowLockFailure = basename === 'cookies' || basename === 'cookies-journal'
    await copyPathIfExistsWithRetries(sourcePath, targetPath, {
      retries: allowLockFailure ? 8 : 4,
      delayMs: 250,
      allowLockFailure,
    })
  }
}

async function applyMobileProxyToSession(ses) {
  if (!mobileProxyState || !ses) return

  await ses.setProxy({
    proxyRules: mobileProxyState.proxyRules,
    proxyBypassRules: mobileProxyState.proxyBypassRules,
  })

  if (typeof ses.forceReloadProxyConfig === 'function') {
    await ses.forceReloadProxyConfig().catch(() => null)
  }

  if (typeof ses.closeAllConnections === 'function') {
    await ses.closeAllConnections().catch(() => null)
  }
}

function createProfileChildWindow(targetUrl, ses, profileName) {
  const child = new BrowserWindow({
    title: `BrowserSaving - ${profileName}`,
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
    },
  })
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      createProfileChildWindow(url, ses, profileName)
    } else {
      shell.openExternal(url).catch(() => null)
    }
    return { action: 'deny' }
  })
  void child.loadURL(targetUrl)
  return child
}

async function openProfileWindow(sessionState, startupState) {
  const existing = profileWindows.get(sessionState.profileId)
  if (existing && !existing.isDestroyed()) {
    if (startupState?.startupUrl) {
      await existing.loadURL(startupState.startupUrl)
    }
    existing.show()
    existing.focus()
    return
  }

  await ensureSessionStorageBootstrapped(sessionState)
  const ses = electronSession.fromPath(sessionState.storagePath)
  sessionState.electronSession = ses
  await applyMobileProxyToSession(ses)

  if (Array.isArray(startupState?.cookies) && startupState.cookies.length > 0) {
    await importSessionCookies(ses, startupState.cookies, { replace: true })
  }

  const win = new BrowserWindow({
    title: `BrowserSaving - ${sessionState.profileName}`,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    center: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
    },
  })

  profileWindows.set(sessionState.profileId, win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      createProfileChildWindow(url, ses, sessionState.profileName)
    } else {
      shell.openExternal(url).catch(() => null)
    }
    return { action: 'deny' }
  })

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    profileWindows.delete(sessionState.profileId)
    void launcher.notifySessionWindowClosed(sessionState.profileId).catch((error) => {
      console.warn(`[electron] profile window close sync failed: ${String(error)}`)
    })
  })

  await win.loadURL(startupState.startupUrl)
}

async function navigateProfileWindow(sessionState, targetUrl) {
  const win = profileWindows.get(sessionState.profileId)
  if (!win || win.isDestroyed()) {
    await openProfileWindow(sessionState, {
      startupUrl: targetUrl,
      cookies: [],
    })
    return
  }
  await win.loadURL(targetUrl)
  win.show()
  win.focus()
}

async function closeProfileWindow(sessionState) {
  const win = profileWindows.get(sessionState.profileId)
  if (!win || win.isDestroyed()) return
  win.close()
}

const launcher = createLocalLauncher({
  userDataDir: app.getPath('userData'),
  workerUrl: DEFAULT_RUNTIME_CONFIG.serverUrl,
  openSessionWindow: openProfileWindow,
  navigateSessionWindow: navigateProfileWindow,
  closeSessionWindow: closeProfileWindow,
  syncSessionToProfile,
})

function getBundledTokenServiceDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'token')
  }
  return path.join(__dirname, '..', 'token')
}

function isInside(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function createRuntimeConfigScript() {
  return `window.__BROWSERSAVING_RUNTIME_CONFIG__ = ${JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2)};`
}

function serveFile(res, targetPath) {
  const ext = path.extname(targetPath).toLowerCase()
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' })
  fs.createReadStream(targetPath).pipe(res)
}

async function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
        const pathname = decodeURIComponent(requestUrl.pathname)

        if (pathname === '/runtime-config.js') {
          const body = createRuntimeConfigScript()
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
          res.end(body)
          return
        }

        const requestedPath = pathname === '/' ? '/index.html' : pathname
        const filePath = path.normalize(path.join(DIST_DIR, requestedPath))

        if (isInside(DIST_DIR, filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          serveFile(res, filePath)
          return
        }

        const fallbackPath = path.join(DIST_DIR, 'index.html')
        serveFile(res, fallbackPath)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(String(error))
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve local web server address'))
        return
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

function createChildWindow(targetUrl) {
  const child = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  child.loadURL(targetUrl)
  return child
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: 'BrowserSaving',
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl)) {
      createChildWindow(url)
      return { action: 'deny' }
    }

    shell.openExternal(url).catch(() => null)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  await mainWindow.loadURL(baseUrl)
}

ipcMain.handle('browsersaving:invoke', async (_event, command, args) => {
  return launcher.invoke(String(command || ''), args || {})
})

ipcMain.handle('browsersaving:relaunch', async () => {
  app.relaunch()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (app.isQuittingGracefully) return
  event.preventDefault()
  app.isQuittingGracefully = true
  void launcher.dispose()
    .catch((error) => {
      console.warn(`[electron] launcher dispose failed: ${String(error)}`)
    })
    .finally(() => {
      app.quit()
    })
})

app.whenReady().then(async () => {
  if (
    process.platform === 'win32' &&
    !process.env.BROWSERSAVING_COMMENT_TOKEN_URL &&
    process.env.BROWSERSAVING_LOCAL_TOKEN_SERVICE !== '0'
  ) {
    localTokenService = createLocalTokenService({
      scriptRoot: getBundledTokenServiceDir(),
      port: Number(process.env.BROWSERSAVING_LOCAL_TOKEN_PORT || 5517),
      logger: (message) => console.log(message),
    })

    const tokenState = await localTokenService.start().catch((error) => {
      console.warn(`[electron] local token service disabled: ${String(error)}`)
      return null
    })

    if (tokenState?.serviceUrl) {
      DEFAULT_RUNTIME_CONFIG.commentTokenServiceUrl = `${tokenState.serviceUrl}/api/comment-token`
    }
  }

  if (process.platform === 'win32' && process.env.BROWSERSAVING_MOBILE_PROXY !== '0') {
    mobileProxy = createMobileEgressProxy({
      interfaceAlias: process.env.BROWSERSAVING_MOBILE_INTERFACE_ALIAS || 'Ethernet 3',
      localAddress: process.env.BROWSERSAVING_MOBILE_LOCAL_ADDRESS || '',
      logger: (message) => console.log(message),
    })
    mobileProxyState = await mobileProxy.start().catch((error) => {
      console.warn(`[electron] mobile proxy disabled: ${String(error)}`)
      return null
    })
  }

  const serverState = await startStaticServer()
  webServer = serverState.server
  baseUrl = serverState.url
  await createMainWindow()
})

app.on('quit', () => {
  if (webServer) {
    webServer.close()
    webServer = null
  }
  if (mobileProxy) {
    void mobileProxy.stop().catch(() => null)
    mobileProxy = null
    mobileProxyState = null
  }
  if (localTokenService) {
    void localTokenService.stop().catch(() => null)
    localTokenService = null
  }
})
