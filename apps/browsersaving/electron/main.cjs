const { app, BrowserWindow, ipcMain, shell, session: electronSession } = require('electron')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const http = require('http')
const tar = require('tar')
const { createLocalLauncher } = require('./local-launcher.cjs')
const {
  createMobileEgressProxy,
  fetchViaMobileProxy,
  getMobileProxyUrl,
} = require('./mobile-egress-proxy.cjs')
const { createLocalTokenRunner } = require('./local-token-runner.cjs')

const DIST_DIR = path.join(__dirname, '..', 'dist')

const DEFAULT_RUNTIME_CONFIG = {
  serverUrl: process.env.BROWSERSAVING_SERVER_URL || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev',
  apiUrl: process.env.BROWSERSAVING_API_URL || 'https://browsersaving-api.pubilo.com',
  commentTokenServiceUrl: process.env.BROWSERSAVING_COMMENT_TOKEN_URL || 'https://token.lslly.com/api/comment-token',
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
let localTokenRunner = null
let postcronState = null

function readString(value, fallback = '') {
  const text = String(value || '').trim()
  return text || fallback
}

function sanitizeProfileId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_')
}

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

async function profileHasCachedData(profileDir) {
  const defaultDir = path.join(profileDir, 'Default')
  const checks = [
    path.join(profileDir, 'cookies.json'),
    path.join(defaultDir, 'Cookies'),
    path.join(defaultDir, 'Preferences'),
    path.join(defaultDir, 'Local Storage'),
    path.join(defaultDir, 'IndexedDB'),
  ]

  for (const targetPath of checks) {
    if (await pathExists(targetPath)) return true
  }
  return false
}

async function readCookiesFromProfileDir(profileDir) {
  const cookiesPath = path.join(profileDir, 'cookies.json')
  if (!(await pathExists(cookiesPath))) return []
  const content = await fsp.readFile(cookiesPath, 'utf8')
  const cookies = JSON.parse(content)
  return Array.isArray(cookies) ? cookies : []
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

async function ensureStorageBootstrappedFromProfile(profileDir, storagePath) {
  await ensureDir(profileDir)
  await ensureDir(storagePath)

  const hasExistingStorage = await directoryHasEntries(storagePath)
  if (hasExistingStorage) {
    return
  }

  for (const entry of ELECTRON_PROFILE_IMPORT_MAP) {
    for (const candidate of entry.candidates) {
      const sourcePath = path.join(profileDir, ...candidate)
      const targetPath = path.join(storagePath, ...entry.to)
      if (await copyPathIfExists(sourcePath, targetPath)) {
        break
      }
    }
  }
}

async function ensureSessionStorageBootstrapped(sessionState) {
  await ensureStorageBootstrappedFromProfile(sessionState.profileDir, sessionState.storagePath)
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

async function fetchWithMobileEgress(url, init = {}) {
  return fetchViaMobileProxy(url, init, mobileProxyState)
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(text)
  }
}

function buildWorkerHeaders(authToken, extraHeaders = {}) {
  const headers = new Headers(extraHeaders)
  const normalizedToken = readString(authToken)
  if (normalizedToken) {
    headers.set('x-auth-token', normalizedToken)
  }
  return headers
}

async function ensureProfileDataAvailable(profileId, authToken, profileDir) {
  if (await profileHasCachedData(profileDir)) {
    return
  }

  const normalizedToken = readString(authToken)
  if (!normalizedToken) {
    throw new Error('Missing auth token for profile download')
  }

  const response = await fetchWithMobileEgress(`${DEFAULT_RUNTIME_CONFIG.serverUrl}/api/sync/${encodeURIComponent(profileId)}/download`, {
    headers: buildWorkerHeaders(normalizedToken),
  })

  if (response.status === 404) {
    return
  }
  if (!response.ok) {
    throw new Error(`Browser data download failed: HTTP ${response.status}`)
  }

  const tmpDir = await fsp.mkdtemp(path.join(app.getPath('temp'), `${profileId}-download-`))
  const archivePath = path.join(tmpDir, 'browser-data.tar.gz')
  const archive = Buffer.from(await response.arrayBuffer())

  try {
    await fsp.writeFile(archivePath, archive)
    await fsp.rm(profileDir, { recursive: true, force: true })
    await fsp.mkdir(profileDir, { recursive: true })
    await tar.x({ file: archivePath, cwd: profileDir, gzip: true })
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
  }
}

async function resolveCommentTokenLocal(profileId, userToken, authToken) {
  const response = await fetchWithMobileEgress(`${DEFAULT_RUNTIME_CONFIG.serverUrl}/api/token/${encodeURIComponent(profileId)}/resolve`, {
    method: 'POST',
    headers: buildWorkerHeaders(authToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ user_token: readString(userToken) }),
  })
  const data = await readJsonResponse(response).catch((error) => {
    throw new Error(String(error))
  })
  if (!response.ok || !data?.success) {
    throw new Error(String(data?.error || data?.detail || `HTTP ${response.status}`))
  }
  return data
}

async function savePostcronTokenLocal(profileId, token, authToken) {
  const response = await fetchWithMobileEgress(`${DEFAULT_RUNTIME_CONFIG.serverUrl}/api/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PUT',
    headers: buildWorkerHeaders(authToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ facebook_token: readString(token) }),
  })
  const data = await readJsonResponse(response).catch((error) => {
    throw new Error(String(error))
  })
  if (!response.ok) {
    throw new Error(String(data?.error || `HTTP ${response.status}`))
  }
  return {
    success: true,
    token: readString(token),
    page_name: readString(data?.page_name),
    page_avatar_url: readString(data?.page_avatar_url),
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

function getProfilesRoot() {
  return path.join(app.getPath('userData'), 'profiles')
}

function getPostcronStoragePath(profileDir) {
  return path.join(profileDir, '_electron_postcron')
}

function createPostcronChildWindow(targetUrl, ses, profileId) {
  const child = new BrowserWindow({
    title: `BrowserSaving - Postcron ${profileId}`,
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
      createPostcronChildWindow(url, ses, profileId)
    } else {
      shell.openExternal(url).catch(() => null)
    }
    return { action: 'deny' }
  })
  void child.loadURL(targetUrl)
  return child
}

async function clearPostcronState() {
  const current = postcronState
  postcronState = null
  if (!current?.window || current.window.isDestroyed()) return
  current.window.removeAllListeners('closed')
  current.window.close()
}

async function postcronStepLaunchHeadful({ profileId, authToken } = {}) {
  const normalizedProfileId = sanitizeProfileId(profileId)
  if (!normalizedProfileId) {
    throw new Error('Missing profile id')
  }

  await clearPostcronState()

  const profileDir = path.join(getProfilesRoot(), normalizedProfileId)
  const storagePath = getPostcronStoragePath(profileDir)

  await fsp.mkdir(getProfilesRoot(), { recursive: true })
  await ensureProfileDataAvailable(normalizedProfileId, authToken, profileDir)
  await fsp.rm(storagePath, { recursive: true, force: true }).catch(() => null)
  await ensureStorageBootstrappedFromProfile(profileDir, storagePath)

  const ses = electronSession.fromPath(storagePath)
  await applyMobileProxyToSession(ses)

  const cookies = await readCookiesFromProfileDir(profileDir).catch(() => [])
  if (Array.isArray(cookies) && cookies.length > 0) {
    await importSessionCookies(ses, cookies, { replace: true })
  }

  const win = new BrowserWindow({
    title: `BrowserSaving - Postcron ${normalizedProfileId}`,
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    center: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void win.loadURL(url).catch(() => null)
    } else {
      shell.openExternal(url).catch(() => null)
    }
    return { action: 'deny' }
  })

  win.on('closed', () => {
    if (postcronState?.window === win) {
      postcronState = null
    }
  })

  await win.loadURL('about:blank')

  postcronState = {
    profileId: normalizedProfileId,
    profileDir,
    storagePath,
    authToken: readString(authToken),
    session: ses,
    window: win,
  }

  return `Postcron background session opened. ${Array.isArray(cookies) ? cookies.length : 0} cookies loaded via Electron/D-Link.`
}

function requirePostcronState() {
  if (!postcronState?.window || postcronState.window.isDestroyed()) {
    throw new Error('No browser session. Run Step 1 first.')
  }
  return postcronState
}

async function getPostcronWindowUrl() {
  const state = requirePostcronState()
  const current = state.window.webContents.getURL()
  return readString(current, 'about:blank')
}

async function postcronStepNavigate() {
  const state = requirePostcronState()
  const oauthUrl = 'https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook'
  await state.window.loadURL(oauthUrl)
  await delay(5000)
  const url = await getPostcronWindowUrl()
  if (!url || url === 'about:blank') {
    throw new Error('Failed to navigate: page stayed on about:blank')
  }
  return `Current URL: ${url.slice(0, 200)}`
}

async function postcronEvaluate(script) {
  const state = requirePostcronState()
  return state.window.webContents.executeJavaScript(script, true)
}

function extractAccessTokenFromUrl(url) {
  const normalizedUrl = readString(url)
  if (!normalizedUrl || !normalizedUrl.includes('access_token=')) return ''

  const hashIndex = normalizedUrl.indexOf('#')
  if (hashIndex !== -1) {
    const fragment = normalizedUrl.slice(hashIndex + 1)
    const params = new URLSearchParams(fragment)
    const token = readString(params.get('access_token'))
    if (token) return token
  }

  const queryIndex = normalizedUrl.indexOf('?')
  if (queryIndex !== -1) {
    const endIndex = hashIndex !== -1 ? hashIndex : undefined
    const params = new URLSearchParams(normalizedUrl.slice(queryIndex + 1, endIndex))
    const token = readString(params.get('access_token'))
    if (token) return token
  }

  return ''
}

async function postcronInspectPage() {
  return postcronEvaluate(`
    (() => {
      const url = window.location.href;
      const extractToken = (inputUrl) => {
        if (!String(inputUrl || '').includes('access_token=')) return '';
        const hashIndex = inputUrl.indexOf('#');
        if (hashIndex !== -1) {
          const params = new URLSearchParams(inputUrl.slice(hashIndex + 1));
          const token = params.get('access_token');
          if (token) return token;
        }
        const queryIndex = inputUrl.indexOf('?');
        if (queryIndex !== -1) {
          const endIndex = hashIndex !== -1 ? hashIndex : undefined;
          const params = new URLSearchParams(inputUrl.slice(queryIndex + 1, endIndex));
          const token = params.get('access_token');
          if (token) return token;
        }
        return '';
      };

      const clickSelectors = [
        'button[name="__CONFIRM__"]',
        'div[aria-label*="ดำเนินการต่อ"]',
        'div[aria-label*="Continue"]',
        '[role="button"][aria-label*="ดำเนินการต่อ"]',
        '[role="button"][aria-label*="Continue"]',
      ];

      const clickButton = (node, label) => {
        if (!node) return null;
        node.click();
        return {
          action: 'clicked',
          buttonText: String(label || node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 120),
        };
      };

      const directToken = extractToken(url);
      if (directToken) {
        return { success: true, token: directToken, url, action: 'token_in_url', buttonText: '' };
      }

      for (const selector of clickSelectors) {
        try {
          const node = document.querySelector(selector);
          if (node) {
            const clicked = clickButton(node, selector);
            if (clicked) {
              return { success: false, token: '', url: window.location.href, ...clicked };
            }
          }
        } catch (error) {}
      }

      const xpath = "//div[@role='button']//span[contains(text(),'ดำเนินการต่อ') or contains(text(),'Continue')]";
      try {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const labelNode = result.singleNodeValue;
        if (labelNode) {
          const button = labelNode.closest('[role="button"]');
          const clicked = clickButton(button, labelNode.textContent || '');
          if (clicked) {
            return { success: false, token: '', url: window.location.href, ...clicked };
          }
        }
      } catch (error) {}

      const textButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const node of textButtons) {
        const label = String(node.textContent || node.getAttribute('aria-label') || '').trim();
        if (!label) continue;
        if (label.includes('ดำเนินการต่อ') || label.includes('Continue')) {
          const clicked = clickButton(node, label);
          if (clicked) {
            return { success: false, token: '', url: window.location.href, ...clicked };
          }
        }
      }

      return {
        success: false,
        token: '',
        url,
        action: 'no_button',
        buttonText: '',
        title: document.title || '',
      };
    })()
  `)
}

async function waitForPostcronToken({ timeoutMs = 45000, pollMs = 1500 } = {}) {
  const startedAt = Date.now()
  let lastUrl = ''
  let lastAction = ''
  let lastButtonText = ''

  while (Date.now() - startedAt < timeoutMs) {
    const state = requirePostcronState()
    const currentUrl = await getPostcronWindowUrl().catch(() => '')
    lastUrl = readString(currentUrl, lastUrl)

    const directToken = extractAccessTokenFromUrl(lastUrl)
    if (directToken) {
      return { token: directToken, url: lastUrl, action: 'token_in_url', buttonText: lastButtonText }
    }

    const inspected = await postcronInspectPage().catch(() => null)
    const inspectedUrl = readString(inspected?.url, lastUrl)
    if (inspectedUrl) lastUrl = inspectedUrl

    const inspectedToken = extractAccessTokenFromUrl(lastUrl) || readString(inspected?.token)
    if (inspectedToken) {
      return {
        token: inspectedToken,
        url: lastUrl,
        action: readString(inspected?.action, 'token_in_url'),
        buttonText: readString(inspected?.buttonText),
      }
    }

    lastAction = readString(inspected?.action, lastAction || 'waiting')
    lastButtonText = readString(inspected?.buttonText, lastButtonText)

    if (lastUrl.includes('forced_account_switch')) {
      await state.window.loadURL('https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook')
    }

    await delay(pollMs)
  }

  throw new Error(`Postcron token timeout. Last URL: ${lastUrl || 'unknown'}${lastAction ? ` | action=${lastAction}` : ''}${lastButtonText ? ` | button=${lastButtonText}` : ''}`)
}

async function fetchPostcronTokenLocal({ profileId, authToken } = {}) {
  let launchCompleted = false
  try {
    await postcronStepLaunchHeadful({ profileId, authToken })
    launchCompleted = true
    await postcronStepNavigate()

    const extracted = await waitForPostcronToken()
    const token = readString(extracted?.token)
    if (!token) {
      throw new Error('Local Postcron extraction returned empty token')
    }

    const saved = await savePostcronTokenLocal(profileId, token, authToken)
    return {
      success: true,
      token,
      url: readString(extracted?.url),
      page_name: readString(saved?.page_name),
      page_avatar_url: readString(saved?.page_avatar_url),
    }
  } finally {
    if (launchCompleted) {
      await postcronClose().catch(() => null)
    }
  }
}

async function postcronStepClick() {
  requirePostcronState()
  const initialResult = await postcronEvaluate(`
    (() => {
      const selectors = [
        'button[name="__CONFIRM__"]',
        'div[aria-label*="ดำเนินการต่อ"]',
        'div[aria-label*="Continue"]',
      ];
      for (const selector of selectors) {
        try {
          const btn = document.querySelector(selector);
          if (btn) { btn.click(); return 'clicked: ' + selector; }
        } catch (error) {}
      }
      const xpath = "//div[@role='button']//span[contains(text(),'ดำเนินการต่อ') or contains(text(),'Continue')]";
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (result.singleNodeValue) {
        const btn = result.singleNodeValue.closest('[role="button"]');
        if (btn) { btn.click(); return 'clicked xpath: ' + String(result.singleNodeValue.textContent || '').trim().slice(0, 50); }
      }
      const accountLink = document.querySelector('a[href*="profile.php"]');
      if (accountLink) { accountLink.click(); return 'clicked account link'; }
      return 'no_button';
    })()
  `)

  await delay(3000)
  let url = await getPostcronWindowUrl()

  if (!url.includes('access_token=') && !url.includes('postcron.com')) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = requirePostcronState()
      if (url.includes('forced_account_switch')) {
        await state.window.loadURL('https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook')
        await delay(5000)
      }

      await postcronEvaluate(`
        (() => {
          const selectors = ['button[name="__CONFIRM__"]', 'div[aria-label*="ดำเนินการต่อ"]', 'div[aria-label*="Continue"]'];
          for (const selector of selectors) {
            const btn = document.querySelector(selector);
            if (btn) { btn.click(); return 'clicked: ' + selector; }
          }
          const xpath = "//div[@role='button']//span[contains(text(),'ดำเนินการต่อ') or contains(text(),'Continue')]";
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (result.singleNodeValue) {
            const btn = result.singleNodeValue.closest('[role=\"button\"]');
            if (btn) { btn.click(); return 'clicked xpath: ' + String(result.singleNodeValue.textContent || '').trim().slice(0, 50); }
          }
          return 'no_button';
        })()
      `).catch(() => null)

      await delay(3000)
      url = await getPostcronWindowUrl()
      if (url.includes('access_token=') || url.includes('postcron.com')) {
        return 'Done - redirected to postcron callback'
      }
    }
  }

  return `${String(initialResult || 'unknown')}\n\nURL: ${url.slice(0, 200)}`
}

async function postcronStepExtract() {
  requirePostcronState()

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await postcronEvaluate(`
      (() => {
        const url = window.location.href;
        if (url.includes('access_token=')) {
          const hashIndex = url.indexOf('#');
          if (hashIndex !== -1) {
            const fragment = url.substring(hashIndex + 1);
            const params = new URLSearchParams(fragment);
            const token = params.get('access_token');
            if (token) return { success: true, token, source: 'fragment', url };
          }
          const queryIndex = url.indexOf('?');
          if (queryIndex !== -1) {
            const query = url.substring(queryIndex + 1, hashIndex !== -1 ? hashIndex : undefined);
            const params = new URLSearchParams(query);
            const token = params.get('access_token');
            if (token) return { success: true, token, source: 'query', url };
          }
        }
        return { success: false, url, error: 'No access_token found' };
      })()
    `)

    const token = readString(result?.token)
    if (token) {
      return {
        success: true,
        token,
        url: readString(result?.url),
      }
    }

    await delay(2000)
  }

  throw new Error('Failed to extract token after multiple attempts')
}

async function postcronClose() {
  await clearPostcronState()
  return 'Postcron browser closed'
}

const launcher = createLocalLauncher({
  userDataDir: app.getPath('userData'),
  workerUrl: DEFAULT_RUNTIME_CONFIG.serverUrl,
  fetchImpl: fetchWithMobileEgress,
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
  if (String(command || '') === 'get_comment_token_local') {
    if (!localTokenRunner) {
      localTokenRunner = createLocalTokenRunner({
        scriptRoot: getBundledTokenServiceDir(),
        logger: (message) => console.log(message),
      })
    }
    const payload = {
      ...(args || {}),
      proxy: getMobileProxyUrl(mobileProxyState) || readString(args?.proxy),
    }
    return localTokenRunner.getCommentToken(payload)
  }
  if (String(command || '') === 'resolve_comment_token_local') {
    return resolveCommentTokenLocal(args?.profileId, args?.userToken, args?.authToken)
  }
  if (String(command || '') === 'save_postcron_token_local') {
    return savePostcronTokenLocal(args?.profileId, args?.token, args?.authToken)
  }
  if (String(command || '') === 'fetch_postcron_token_local') {
    return fetchPostcronTokenLocal(args || {})
  }
  if (String(command || '') === 'postcron_step_launch_headful') {
    return postcronStepLaunchHeadful(args || {})
  }
  if (String(command || '') === 'postcron_step_navigate') {
    return postcronStepNavigate()
  }
  if (String(command || '') === 'postcron_step_click') {
    return postcronStepClick()
  }
  if (String(command || '') === 'postcron_step_extract') {
    return postcronStepExtract()
  }
  if (String(command || '') === 'postcron_close') {
    return postcronClose()
  }
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
  void Promise.all([
    launcher.dispose().catch((error) => {
      console.warn(`[electron] launcher dispose failed: ${String(error)}`)
    }),
    clearPostcronState().catch((error) => {
      console.warn(`[electron] postcron dispose failed: ${String(error)}`)
    }),
  ]).finally(() => {
    app.quit()
  })
})

app.whenReady().then(async () => {
  if (process.platform === 'win32' && process.env.BROWSERSAVING_LOCAL_TOKEN_SERVICE !== '0') {
    localTokenRunner = createLocalTokenRunner({
      scriptRoot: getBundledTokenServiceDir(),
      logger: (message) => console.log(message),
    })
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
  localTokenRunner = null
})
