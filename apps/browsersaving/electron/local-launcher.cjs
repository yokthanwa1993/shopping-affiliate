const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')
const tar = require('tar')

const execFileAsync = promisify(execFile)

function sanitizeProfileId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function readCookiesFromProfileDir(profileDir) {
  const directPath = path.join(profileDir, 'cookies.json')
  if (await pathExists(directPath)) {
    const content = await fsp.readFile(directPath, 'utf8')
    const cookies = JSON.parse(content)
    return Array.isArray(cookies) ? cookies : []
  }
  return []
}

function readString(value, fallback = '') {
  const text = String(value || '').trim()
  return text || fallback
}

function resolveProfileHomepage(profile, requestedUrl) {
  const explicit = readString(requestedUrl)
  if (explicit) return explicit

  const homepage = readString(profile?.homepage)
  if (homepage) return homepage

  const uid = readString(profile?.uid)
  if (/^\d+$/.test(uid)) {
    return `https://www.facebook.com/profile.php?id=${uid}`
  }
  if (uid && !uid.includes('@')) {
    return `https://www.facebook.com/${encodeURIComponent(uid)}`
  }

  return 'https://www.facebook.com/'
}

function buildChromeArgs(profileDir, startupUrl, proxy) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-popup-blocking',
    `--user-data-dir=${profileDir}`,
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-quic',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--disable-sync',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    '--lang=th',
    '--accept-lang=th,th-TH,en-US,en',
    '--window-size=1440,900',
    '--new-window',
  ]

  if (proxy) {
    args.push(`--proxy-server=${proxy}`)
  }

  args.push(startupUrl)
  return args
}

async function findFileRecursive(rootDir, targetName) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isFile() && entry.name === targetName) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const match = await findFileRecursive(fullPath, targetName)
      if (match) return match
    }
  }
  return null
}

async function runCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  })
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath)
    return true
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

function createLocalLauncher(options) {
  const workerUrl = readString(options.workerUrl, 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev')
  const profilesRoot = path.join(options.userDataDir, 'profiles')
  const tempRoot = path.join(options.userDataDir, 'tmp')
  const usesEmbeddedWindow = typeof options.openSessionWindow === 'function'
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch
  const sessions = new Map()
  const uploading = new Set()

  let cachedBrowserPath = null

  async function ensureRoots() {
    await fsp.mkdir(profilesRoot, { recursive: true })
    await fsp.mkdir(tempRoot, { recursive: true })
  }

  async function findBrowserExecutable() {
    if (cachedBrowserPath && await pathExists(cachedBrowserPath)) {
      return cachedBrowserPath
    }

    const candidates = []
    const envPath = readString(process.env.BROWSERSAVING_CHROME_PATH)
    if (envPath) candidates.push(envPath)

    if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      )
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      )
    } else {
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      )
    }

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        cachedBrowserPath = candidate
        return candidate
      }
    }

    throw new Error('Chrome not found on this machine')
  }

  async function clearSessionFiles(profileDir) {
    const defaultProfile = path.join(profileDir, 'Default')
    const sessionFiles = [
      'Current Session',
      'Current Tabs',
      'Last Session',
      'Last Tabs',
    ]
    for (const file of sessionFiles) {
      await fsp.rm(path.join(defaultProfile, file), { force: true }).catch(() => null)
    }
  }

  async function downloadProfileData(profileId, authToken, profileDir) {
    if (!authToken) return

    if (await profileHasCachedData(profileDir)) {
      console.info(`[electron-launcher] using local cache for ${profileId} (skip download)`)
      return
    }

    const response = await doFetch(`${workerUrl}/api/sync/${encodeURIComponent(profileId)}/download`, {
      headers: { 'x-auth-token': authToken },
    })

    if (response.status === 404) return
    if (!response.ok) {
      throw new Error(`Browser data download failed: HTTP ${response.status}`)
    }

    const tmpDir = await fsp.mkdtemp(path.join(tempRoot, `${profileId}-download-`))
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

  async function downloadSessionCookies(profileId, authToken) {
    if (!authToken) return null

    const response = await doFetch(`${workerUrl}/api/sync/${encodeURIComponent(profileId)}/download`, {
      headers: { 'x-auth-token': authToken },
    })

    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Browser cookie download failed: HTTP ${response.status}`)
    }

    const tmpDir = await fsp.mkdtemp(path.join(tempRoot, `${profileId}-cookies-`))
    const archivePath = path.join(tmpDir, 'browser-data.tar.gz')
    const extractDir = path.join(tmpDir, 'extract')
    const archive = Buffer.from(await response.arrayBuffer())

    try {
      await fsp.mkdir(extractDir, { recursive: true })
      await fsp.writeFile(archivePath, archive)
      await tar.x({ file: archivePath, cwd: extractDir, gzip: true }).catch(async () => {
        await tar.x({ file: archivePath, cwd: extractDir, gzip: true }, ['cookies.json'])
      })

      const cookiesPath = await findFileRecursive(extractDir, 'cookies.json')
      if (!cookiesPath) return null

      const content = await fsp.readFile(cookiesPath, 'utf8')
      const cookies = JSON.parse(content)
      return Array.isArray(cookies) ? cookies : null
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
    }
  }

  async function uploadProfileData(session) {
    if (!session.authToken) return
    if (!(await pathExists(session.profileDir))) return

    const tmpDir = await fsp.mkdtemp(path.join(tempRoot, `${session.profileId}-upload-`))
    const archivePath = path.join(tmpDir, 'browser-data.tar.gz')
    const essentialFiles = [
      'Default/Cookies',
      'Default/Cookies-wal',
      'Default/Cookies-shm',
      'Default/Cookies-journal',
      'Default/Login Data',
      'Default/Login Data-wal',
      'Default/Login Data-shm',
      'Default/Login Data-journal',
      'Default/Preferences',
      'Default/Secure Preferences',
      'Default/Web Data',
      'Default/Web Data-wal',
      'Default/Web Data-shm',
      'Default/Web Data-journal',
      'Default/Bookmarks',
      'Default/Favicons',
      'Default/History',
      'Default/History-wal',
      'Default/History-shm',
      'Default/History-journal',
      'Local State',
      'First Run',
      'cookies.json',
    ]
    const essentialDirs = [
      'Default/Local Storage',
      'Default/Session Storage',
      'Default/IndexedDB',
      'Default/Local Extension Settings',
      'Default/Extension State',
      'Default/Service Worker',
      'Default/blob_storage',
      'Default/Shared Dictionary',
      'Default/Trust Tokens',
    ]
    const existingEntries = []

    try {
      for (const relativePath of essentialFiles) {
        if (await pathExists(path.join(session.profileDir, relativePath))) {
          existingEntries.push(relativePath)
        }
      }
      for (const relativePath of essentialDirs) {
        if (await pathExists(path.join(session.profileDir, relativePath))) {
          existingEntries.push(relativePath)
        }
      }

      if (existingEntries.length === 0) {
        return
      }

      await tar.c({
        cwd: session.profileDir,
        file: archivePath,
        gzip: true,
        portable: true,
      }, existingEntries)

      const archive = await fsp.readFile(archivePath)
      const response = await doFetch(`${workerUrl}/api/sync/${encodeURIComponent(session.profileId)}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/gzip',
          'x-auth-token': session.authToken,
        },
        body: archive,
      })

      if (!response.ok) {
        throw new Error(`Browser data upload failed: HTTP ${response.status}`)
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
    }
  }

  async function openUrlInExistingSession(session, url) {
    const browserPath = await findBrowserExecutable()
    const targetUrl = readString(url)
    if (!targetUrl) return

    const child = spawn(browserPath, [
      `--user-data-dir=${session.profileDir}`,
      '--new-tab',
      targetUrl,
    ], {
      stdio: 'ignore',
      windowsHide: false,
      detached: true,
    })
    child.unref()
  }

  async function finalizeSession(session) {
    if (session.finalizePromise) {
      return session.finalizePromise
    }

    session.finalizePromise = (async () => {
      sessions.delete(session.profileId)

      if (!session.uploaded) {
        uploading.add(session.profileId)
        try {
          if (typeof options.syncSessionToProfile === 'function') {
            await options.syncSessionToProfile(session)
            await uploadProfileData(session)
          } else {
            await uploadProfileData(session)
          }
          session.uploaded = true
        } finally {
          uploading.delete(session.profileId)
        }
      }
    })()

    return session.finalizePromise
  }

  async function terminateSession(session) {
    if (typeof options.closeSessionWindow === 'function') {
      await options.closeSessionWindow(session)
      return
    }

    if (!session.child?.pid) return

    if (process.platform === 'win32') {
      await runCommand('taskkill', ['/PID', String(session.child.pid), '/T', '/F']).catch(() => null)
      return
    }

    try {
      process.kill(session.child.pid, 'SIGTERM')
    } catch {
      return
    }
  }

  async function startSession(profile, requestedUrl, authToken) {
    const profileId = sanitizeProfileId(profile?.id)
    if (!profileId) {
      throw new Error('Missing profile id')
    }

    const existing = sessions.get(profileId)
    if (existing) {
      if (requestedUrl && typeof options.navigateSessionWindow === 'function') {
        await options.navigateSessionWindow(existing, requestedUrl)
      } else if (requestedUrl) {
        await openUrlInExistingSession(existing, requestedUrl)
      }
      return existing
    }

    await ensureRoots()

    const startupUrl = resolveProfileHomepage(profile, requestedUrl)
    const profileDir = path.join(profilesRoot, profileId)
    const session = {
      profileId,
      profileName: readString(profile?.name, profileId),
      profileDir,
      storagePath: path.join(profileDir, '_electron_session'),
      authToken: readString(authToken),
      child: null,
      stopping: false,
      uploaded: false,
      finalizePromise: null,
    }
    sessions.set(profileId, session)

    if (usesEmbeddedWindow) {
      await fsp.mkdir(profileDir, { recursive: true })
      await downloadProfileData(profileId, authToken, profileDir).catch((error) => {
        console.warn(`[electron-launcher] profile download skipped for ${profileId}: ${String(error)}`)
      })
      const cookies = await readCookiesFromProfileDir(profileDir).catch((error) => {
        console.warn(`[electron-launcher] cookie read skipped for ${profileId}: ${String(error)}`)
        return []
      })
      await options.openSessionWindow(session, {
        profile,
        startupUrl,
        requestedUrl: readString(requestedUrl),
        cookies: Array.isArray(cookies) ? cookies : [],
      })
      return session
    }

    await fsp.mkdir(profileDir, { recursive: true })
    await downloadProfileData(profileId, authToken, profileDir).catch((error) => {
      console.warn(`[electron-launcher] download skipped for ${profileId}: ${String(error)}`)
    })
    await clearSessionFiles(profileDir).catch(() => null)

    const browserPath = await findBrowserExecutable()
    const args = buildChromeArgs(profileDir, startupUrl, readString(profile?.proxy))
    const child = spawn(browserPath, args, {
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
    })
    session.child = child
    child.on('exit', () => {
      void finalizeSession(session).catch((error) => {
        console.warn(`[electron-launcher] finalize failed for ${profileId}: ${String(error)}`)
      })
    })

    return session
  }

  async function stopSession(profileId, authToken) {
    const normalizedProfileId = sanitizeProfileId(profileId)
    const session = sessions.get(normalizedProfileId)
    if (!session) {
      return { success: true, stopped: false, uploaded: false }
    }

    session.stopping = true
    if (authToken) session.authToken = readString(authToken)
    await terminateSession(session)
    await finalizeSession(session)
    return { success: true, stopped: true, uploaded: true }
  }

  async function notifySessionWindowClosed(profileId) {
    const normalizedProfileId = sanitizeProfileId(profileId)
    const session = sessions.get(normalizedProfileId)
    if (!session) return
    await finalizeSession(session)
  }

  function getStatus() {
    return {
      running: Array.from(sessions.keys()),
      uploading: Array.from(uploading),
      android_running: [],
      android_uploading: [],
    }
  }

  async function invoke(command, args = {}) {
    switch (command) {
      case 'launch_browser':
        await startSession(args.profile, null, args.authToken)
        return true
      case 'launch_browser_with_url':
        await startSession(args.profile, args.url, args.authToken)
        return true
      case 'stop_browser':
        return stopSession(args.profileId, args.authToken)
      case 'get_browser_status':
        return getStatus()
      case 'launch_browser_debug':
        await startSession(args.profile, null, args.authToken)
        return true
      case 'get_debug_logs':
        return { network: [], console: [], cookies: [] }
      case 'connect_cdp':
      case 'disconnect_cdp':
        throw new Error('Chrome debug console is not supported in Electron build yet')
      case 'launch_android_emulator':
        throw new Error('Android emulator is not supported in Electron build')
      case 'postcron_step_launch_headful':
      case 'postcron_step_navigate':
      case 'postcron_step_click':
      case 'postcron_step_extract':
      case 'postcron_close':
        throw new Error('Local Postcron flow is not supported in Electron build yet')
      default:
        throw new Error(`Unsupported desktop command: ${command}`)
    }
  }

  async function dispose() {
    const activeSessions = Array.from(sessions.values())
    await Promise.all(activeSessions.map(async (session) => {
      try {
        await stopSession(session.profileId, session.authToken)
      } catch (error) {
        console.warn(`[electron-launcher] dispose stop failed for ${session.profileId}: ${String(error)}`)
      }
    }))
  }

  return {
    invoke,
    dispose,
    notifySessionWindowClosed,
  }
}

module.exports = {
  createLocalLauncher,
}
