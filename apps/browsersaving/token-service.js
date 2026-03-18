/**
 * Token Facebook Lite Service — Node.js port
 * 
 * POST /token  — Generate Facebook Lite token from credentials
 * GET  /health — Health check
 * 
 * Requires: npm install node-fetch otpauth node-forge
 */

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')

const PORT = 3457

// ===== Facebook Password Encryption =====

async function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }) }
        catch { resolve({ status: res.statusCode, data: body }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(options.timeout || 30000, () => { req.destroy(); reject(new Error('Timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function postForm(url, formData, headers = {}, timeout = 30000) {
  const body = new URLSearchParams(formData).toString()
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, data }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')) })
    req.write(body)
    req.end()
  })
}

async function getPublicKey(timeout = 30000) {
  const params = new URLSearchParams({
    version: '2',
    flow: 'CONTROLLER_INITIALIZATION',
    method: 'GET',
    fb_api_req_friendly_name: 'pwdKeyFetch',
    fb_api_caller_class: 'com.facebook.auth.login.AuthOperations',
    access_token: '438142079694454|fc0a7caa49b192f64f6f5a6d9643bb28',
  })
  const resp = await postForm(`https://b-graph.facebook.com/pwd_key_fetch?${params}`, {}, {}, timeout)
  const publicKey = resp.data?.public_key
  const keyId = String(resp.data?.key_id || '25')
  if (!publicKey) throw new Error('Facebook public key not returned')
  return { publicKey, keyId }
}

function encryptPassword(password, publicKey, keyId) {
  const randKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)

  // RSA encrypt the random key
  const encryptedRandKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    randKey
  )

  // AES-GCM encrypt the password
  const currentTime = Math.floor(Date.now() / 1000)
  const cipher = crypto.createCipheriv('aes-256-gcm', randKey, iv)
  cipher.setAAD(Buffer.from(String(currentTime), 'utf8'))
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Build buffer
  const buf = Buffer.alloc(2 + iv.length + 2 + encryptedRandKey.length + authTag.length + encrypted.length)
  let offset = 0
  buf.writeUInt8(1, offset); offset += 1
  buf.writeUInt8(parseInt(keyId), offset); offset += 1
  iv.copy(buf, offset); offset += iv.length
  buf.writeUInt16LE(encryptedRandKey.length, offset); offset += 2
  encryptedRandKey.copy(buf, offset); offset += encryptedRandKey.length
  authTag.copy(buf, offset); offset += authTag.length
  encrypted.copy(buf, offset)

  const encoded = buf.toString('base64')
  return `#PWD_FB4A:2:${currentTime}:${encoded}`
}

// ===== TOTP =====

function generateTOTP(secret) {
  const cleanSecret = secret.replace(/\s/g, '').toUpperCase()
  // Base32 decode
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of cleanSecret) {
    const val = alphabet.indexOf(c)
    if (val === -1) continue
    bits += val.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2))
  }
  const key = Buffer.from(bytes)

  const epoch = Math.floor(Date.now() / 1000)
  const counter = Math.floor(epoch / 30)
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeUInt32BE(0, 0)
  counterBuf.writeUInt32BE(counter, 4)

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest()
  const offset2 = hmac[hmac.length - 1] & 0x0f
  const code = ((hmac[offset2] & 0x7f) << 24 | hmac[offset2 + 1] << 16 | hmac[offset2 + 2] << 8 | hmac[offset2 + 3]) % 1000000
  return String(code).padStart(6, '0')
}

// ===== Facebook App Tokens =====

const FB_APPS = {
  FB_ANDROID: '350685531728',
  MESSENGER_ANDROID: '256002347743983',
  FB_LITE: '275254692598279',
  MESSENGER_LITE: '200424423651082',
  ADS_MANAGER_ANDROID: '438142079694454',
  PAGES_MANAGER_ANDROID: '121876164619130',
}

function extractTokenPrefix(token) {
  for (let i = 0; i < token.length; i++) {
    if (token[i] >= 'a' && token[i] <= 'z') return token.substring(0, i)
  }
  return token
}

// ===== Facebook Login =====

const FB_BASE_HEADERS = {
  'x-fb-net-hni': '45201',
  'zero-rated': '0',
  'x-fb-sim-hni': '45201',
  'x-fb-connection-quality': 'EXCELLENT',
  'x-fb-friendly-name': 'authenticate',
  'x-fb-connection-bandwidth': '78032897',
  'x-tigon-is-retry': 'False',
  'authorization': 'OAuth null',
  'x-fb-connection-type': 'WIFI',
  'x-fb-device-group': '3342',
  'priority': 'u=3,i',
  'x-fb-http-engine': 'Liger',
  'x-fb-client-ip': 'True',
  'x-fb-server-cluster': 'True',
  'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 9; 23113RKC6C Build/PQ3A.190705.08211809) [FBAN/FB4A;FBAV/417.0.0.33.65;FBPN/com.facebook.katana;FBLC/vi_VN;FBBV/480086274;FBCR/MobiFone;FBMF/Redmi;FBBD/Redmi;FBDV/23113RKC6C;FBSV/9;FBCA/x86:armeabi-v7a;FBDM/{density=1.5,width=1280,height=720};FB_FW/1;FBRV/0;]',
  'x-fb-request-analytics-tags': '{"network_tags":{"product":"350685531728","retry_attempt":"0"},"application_tags":"unknown"}',
}

async function convertToken(accessToken, targetApp, timeout) {
  const appId = FB_APPS[targetApp]
  if (!appId) return null

  const resp = await postForm('https://api.facebook.com/method/auth.getSessionforApp', {
    access_token: accessToken,
    format: 'json',
    new_app_id: appId,
    generate_session_cookies: '1',
  }, {}, timeout)

  const token = resp.data?.access_token
  if (!token) return null

  const cookiesDict = {}
  const cookiesParts = []
  for (const cookie of (resp.data?.session_cookies || [])) {
    if (cookie?.name && cookie?.value != null) {
      cookiesDict[cookie.name] = cookie.value
      cookiesParts.push(`${cookie.name}=${cookie.value}`)
    }
  }

  return {
    target_app: targetApp,
    token_prefix: extractTokenPrefix(token),
    access_token: token,
    cookies: { dict: cookiesDict, string: cookiesParts.join('; ') },
  }
}

function randomStr(len, chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function randomDigits(len) {
  let s = ''
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10)
  return s
}

async function facebookLogin({ identifier, password, twofa, datr, target_app = 'FB_LITE', timeout_seconds = 30 }) {
  const timeout = timeout_seconds * 1000

  // Encrypt password if not already encrypted
  let encPassword = password
  if (!password.startsWith('#PWD_FB4A')) {
    const { publicKey, keyId } = await getPublicKey(timeout)
    encPassword = encryptPassword(password, publicKey, keyId)
  }

  const deviceId = crypto.randomUUID()
  const adid = crypto.randomUUID()
  const secureFamilyDeviceId = crypto.randomUUID()
  const machineId = datr || randomStr(24)
  const jazoest = randomDigits(5)
  const simSerial = randomDigits(20)

  const loginData = {
    format: 'json',
    email: identifier,
    password: encPassword,
    credentials_type: 'password',
    generate_session_cookies: '1',
    locale: 'vi_VN',
    client_country_code: 'VN',
    api_key: '882a8490361da98702bf97a021ddc14d',
    access_token: '350685531728|62f8ce9f74b12f84c123cc23437a4a32',
    adid,
    device_id: deviceId,
    generate_analytics_claim: '1',
    community_id: '',
    linked_guest_account_userid: '',
    cpl: 'true',
    try_num: '1',
    family_device_id: deviceId,
    secure_family_device_id: secureFamilyDeviceId,
    sim_serials: `["${simSerial}"]`,
    openid_flow: 'android_login',
    openid_provider: 'google',
    openid_tokens: '[]',
    account_switcher_uids: `["${identifier}"]`,
    fb4a_shared_phone_cpl_experiment: 'fb4a_shared_phone_nonce_cpl_at_risk_v3',
    fb4a_shared_phone_cpl_group: 'enable_v3_at_risk',
    enroll_misauth: 'false',
    error_detail_type: 'button_with_disabled',
    source: 'login',
    machine_id: machineId,
    jazoest,
    meta_inf_fbmeta: 'V2_UNTAGGED',
    advertiser_id: adid,
    encrypted_msisdn: '',
    currently_logged_in_userid: '0',
    fb_api_req_friendly_name: 'authenticate',
    fb_api_caller_class: 'Fb4aAuthHandler',
    sig: '214049b9f17c38bd767de53752b53946',
  }

  const resp = await postForm('https://b-graph.facebook.com/auth/login', loginData, FB_BASE_HEADERS, timeout)
  const payload = resp.data

  if (typeof payload !== 'object') {
    throw new Error(`Unexpected response: ${String(payload).substring(0, 200)}`)
  }

  // Success
  if (payload.access_token) {
    const original = {
      token_prefix: extractTokenPrefix(payload.access_token),
      access_token: payload.access_token,
    }
    const converted = await convertToken(payload.access_token, target_app, timeout)
    return { success: true, original_token: original, converted_token: converted }
  }

  // 2FA required
  const error = payload.error || {}
  const errorData = error.error_data || {}
  if (errorData.login_first_factor && errorData.uid) {
    if (!twofa) {
      return { success: false, error: '2FA is required but twofa secret was not provided' }
    }

    const twofactorCode = generateTOTP(twofa)
    const twoFAData = {
      locale: 'vi_VN',
      format: 'json',
      email: identifier,
      device_id: deviceId,
      access_token: '350685531728|62f8ce9f74b12f84c123cc23437a4a32',
      generate_session_cookies: 'true',
      generate_machine_id: '1',
      twofactor_code: twofactorCode,
      credentials_type: 'two_factor',
      error_detail_type: 'button_with_disabled',
      first_factor: errorData.login_first_factor,
      password: encPassword,
      userid: errorData.uid,
      machine_id: errorData.login_first_factor,
    }

    const resp2 = await postForm('https://b-graph.facebook.com/auth/login', twoFAData, FB_BASE_HEADERS, timeout)
    const payload2 = resp2.data

    if (payload2.access_token) {
      const original = {
        token_prefix: extractTokenPrefix(payload2.access_token),
        access_token: payload2.access_token,
      }
      const converted = await convertToken(payload2.access_token, target_app, timeout)
      return { success: true, original_token: original, converted_token: converted }
    }

    const err2 = payload2.error || {}
    return {
      success: false,
      error: err2.message || 'unknown 2fa error',
      error_user_msg: err2.error_user_msg,
    }
  }

  return {
    success: false,
    error: error.message || 'unknown response format',
    error_user_msg: error.error_user_msg,
  }
}

// ===== Postcron Token Extraction (Puppeteer) =====

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function extractPostcronTokenLocal(cookies) {
  const puppeteer = require('puppeteer-core')
  let browser = null

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
      ],
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36')

    // Navigate to Facebook first to set domain
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Inject cookies
    const cookieParams = cookies.map(c => ({
      name: String(c.name || '').trim(),
      value: String(c.value || '').trim(),
      domain: String(c.domain || '').trim() || undefined,
      path: String(c.path || '/').trim() || '/',
      secure: c.secure ?? true,
      httpOnly: c.http_only ?? c.httpOnly ?? false,
      sameSite: normalizeCookieSameSite(c.same_site ?? c.sameSite),
      expires: Number.isFinite(Number(c.expires)) && Number(c.expires) > 0 ? Number(c.expires) : undefined,
    })).filter(c => c.name && c.value && c.domain)

    if (cookieParams.length > 0) {
      await page.setCookie(...cookieParams)
    }
    console.log(`[Postcron] Injected ${cookieParams.length} cookies`)

    // Navigate to Postcron OAuth URL
    const postcronUrl = 'https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook'
    await page.goto(postcronUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)

    // Check for barriers
    const inspect = async () => {
      return await page.evaluate(() => {
        const href = window.location.href || ''
        const lower = href.toLowerCase()
        const bodyText = (document.body?.innerText || '').toLowerCase()
        const autoKeywords = ['พฤติกรรมอัตโนมัติ', 'พฤติกรรมที่ไม่ปกติ', 'เราได้ตรวจพบกิจกรรมที่ผิดปกติ',
          'automated behavior', 'unusual activity', 'suspicious activity', 'we limit how often']
        let automatedKeyword = ''
        for (const kw of autoKeywords) {
          if (bodyText.includes(kw.toLowerCase())) { automatedKeyword = kw; break }
        }
        return {
          url: href,
          checkpoint: lower.includes('facebook.com/checkpoint'),
          login: lower.includes('facebook.com/login'),
          security: lower.includes('facebook.com/two_factor') || lower.includes('approvals_code'),
          automated: !!automatedKeyword,
          automated_keyword: automatedKeyword,
        }
      })
    }

    const initialState = await inspect()
    if (initialState.login) return { token: null, reason: 'facebook_login_required', url: initialState.url }
    if (initialState.security) return { token: null, reason: 'facebook_security_confirmation', url: initialState.url }

    // Try to dismiss Facebook barriers
    if (initialState.checkpoint || initialState.automated) {
      const dismissed = await dismissBarrier(page)
      if (!dismissed) {
        return {
          token: null,
          reason: initialState.checkpoint ? 'facebook_checkpoint' : 'facebook_automated_behavior',
          url: initialState.url,
          detail: initialState.automated_keyword,
        }
      }
    }

    // Click "Continue" button if present
    await page.evaluate(() => {
      const selectors = [
        'div[aria-label*="ดำเนินการต่อ"]', 'div[aria-label*="Continue"]',
        'button[name="__CONFIRM__"]', 'input[value="Continue"]',
      ]
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el) { el.click(); return }
      }
      const buttons = document.querySelectorAll('div[role="button"], button')
      for (const btn of buttons) {
        const text = btn.textContent || ''
        if (text.includes('Continue') || text.includes('ดำเนินการต่อ')) { btn.click(); return }
      }
    })
    await sleep(5000)

    // Poll for token in URL
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await inspect()

      if (state.login) return { token: null, reason: 'facebook_login_required', url: state.url }
      if (state.security) return { token: null, reason: 'facebook_security_confirmation', url: state.url }

      if (state.checkpoint || state.automated) {
        const dismissed = await dismissBarrier(page)
        if (!dismissed) {
          return {
            token: null,
            reason: state.checkpoint ? 'facebook_checkpoint' : 'facebook_automated_behavior',
            url: state.url,
            detail: state.automated_keyword,
          }
        }
        if (attempt < 4) await sleep(1500)
        continue
      }

      const tokenMatch = state.url.match(/access_token=([^&]+)/)
      if (tokenMatch) {
        return { token: decodeURIComponent(tokenMatch[1]), reason: null, url: state.url }
      }

      if (attempt < 4) await sleep(2000)
    }

    const finalState = await inspect()
    return {
      token: null,
      reason: finalState.checkpoint ? 'facebook_checkpoint'
        : finalState.automated ? 'facebook_automated_behavior'
        : 'session_expired',
      url: finalState.url,
      detail: finalState.automated_keyword || null,
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

async function dismissBarrier(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await page.evaluate(() => {
      const selectors = [
        'div[role="button"][aria-label="ปิด"]', 'div[role="button"][aria-label*="ปิด"]',
        '[role="button"][aria-label="Close"]', '[role="button"][aria-label*="close" i]',
        'button[aria-label="ปิด"]', 'button[aria-label="Close"]',
      ]
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el) { (el.closest('[role="button"],button') || el).click(); return true }
      }
      const all = document.querySelectorAll('div[role="button"], button, span, [aria-label]')
      for (const el of all) {
        const text = (el.textContent || '').trim().toLowerCase()
        const label = (el.getAttribute?.('aria-label') || '').trim().toLowerCase()
        if (text === 'ปิด' || text === 'close' || label === 'ปิด' || label === 'close') {
          (el.closest('[role="button"],button') || el).click()
          return true
        }
      }
      return false
    })
    await sleep(2000)
    const state = await page.evaluate(() => {
      const href = window.location.href || ''
      return {
        checkpoint: href.toLowerCase().includes('facebook.com/checkpoint'),
        automated: false,
      }
    })
    if (!state.checkpoint) return true
    if (!clicked) return false
  }
  return false
}

function normalizeCookieSameSite(val) {
  const s = String(val || '').toLowerCase()
  if (s === 'strict') return 'Strict'
  if (s === 'lax') return 'Lax'
  if (s === 'none' || s === 'no_restriction') return 'None'
  return 'Lax'
}

// ===== Page Token Resolution =====

async function resolvePageToken(userToken, hints = {}) {
  const token = String(userToken || '').trim()
  if (!token) throw new Error('user_token_empty')

  const graphUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,picture.type(large)&limit=200&access_token=${encodeURIComponent(token)}`
  const resp = await fetchJSON(graphUrl)

  if (resp.status !== 200 || resp.data?.error) {
    throw new Error(`facebook_me_accounts_failed: ${resp.data?.error?.message || `HTTP ${resp.status}`}`)
  }

  const accounts = Array.isArray(resp.data?.data) ? resp.data.data : []
  if (accounts.length === 0) throw new Error('facebook_me_accounts_empty')

  // Find matching page
  let matched = null
  if (hints.page_id) {
    matched = accounts.find(a => String(a.id) === String(hints.page_id))
  }
  if (!matched && hints.page_name) {
    const name = hints.page_name.toLowerCase()
    matched = accounts.find(a => String(a.name || '').toLowerCase() === name)
  }
  if (!matched) {
    matched = accounts[0] // fallback to first page
  }

  return {
    page_token: matched.access_token,
    page_id: matched.id,
    page_name: matched.name,
    page_avatar_url: matched.picture?.data?.url || '',
  }
}

// ===== HTTP Server =====

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try { resolve(JSON.parse(body)) }
      catch { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const body = await readBody(req)
    const { identifier, password, twofa, datr, target_app, timeout_seconds } = body

    if (!identifier || !password) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Missing identifier or password' }))
      return
    }

    try {
      console.log(`[Token] Login request for ${identifier}`)
      const result = await facebookLogin({
        identifier: String(identifier).trim(),
        password: String(password),
        twofa: twofa || null,
        datr: datr || null,
        target_app: target_app || 'FB_LITE',
        timeout_seconds: timeout_seconds || 30,
      })

      if (!result.success) {
        console.log(`[Token] Login failed for ${identifier}: ${result.error}`)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      console.log(`[Token] Login success for ${identifier}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      console.error(`[Token] Error for ${identifier}:`, err.message)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: `network_error: ${err.message}` }))
    }
    return
  }

  // Also handle /api/comment-token for compatibility
  if (url.pathname === '/api/comment-token' && req.method === 'POST') {
    // Redirect to /token handler
    req.url = '/token'
    server.emit('request', req, res)
    return
  }

  // POST /postcron-token — Extract Postcron token using Puppeteer + local Chrome
  if (url.pathname === '/postcron-token' && req.method === 'POST') {
    const body = await readBody(req)
    const { cookies, profile_name } = body

    if (!Array.isArray(cookies) || cookies.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Missing cookies array' }))
      return
    }

    try {
      console.log(`[Postcron] Extracting token for ${profile_name || 'unknown'}...`)
      const result = await extractPostcronTokenLocal(cookies)

      if (!result.token) {
        console.log(`[Postcron] Failed for ${profile_name}: ${result.reason}`)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: `Postcron token extraction failed: ${result.reason || 'unknown'}`,
          reason: result.reason,
          detail: result.detail || result.url,
        }))
        return
      }

      console.log(`[Postcron] Token found for ${profile_name}: ${result.token.substring(0, 20)}...`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        token: result.token,
        url: result.url,
      }))
    } catch (err) {
      console.error(`[Postcron] Error:`, err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: err.message }))
    }
    return
  }

  // POST /resolve-page-token — Convert user token to page token via Graph API
  if (url.pathname === '/resolve-page-token' && req.method === 'POST') {
    const body = await readBody(req)
    const { user_token, page_name, page_id } = body

    if (!user_token) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Missing user_token' }))
      return
    }

    try {
      const result = await resolvePageToken(user_token, { page_name, page_id })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, ...result }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: err.message }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🔑 Token Facebook Lite Service
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Local:   http://localhost:${PORT}
  Network: http://0.0.0.0:${PORT}

  Endpoints:
    GET  /health             — Health check
    POST /token              — Generate Facebook Lite token
    POST /postcron-token     — Extract Postcron token (Puppeteer)
    POST /resolve-page-token — Convert user token to page token
  `)
})
