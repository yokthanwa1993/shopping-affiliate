const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const dns = require('dns')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

function readString(value, fallback = '') {
  const text = String(value || '').trim()
  return text || fallback
}

function normalizeHeaders(headers) {
  const next = { ...headers }
  delete next['proxy-connection']
  delete next['Proxy-Connection']
  delete next.connection
  delete next.Connection
  return next
}

function parseConnectAuthority(authority) {
  const text = readString(authority)
  if (!text) return null

  if (text.startsWith('[')) {
    const closing = text.indexOf(']')
    if (closing === -1) return null
    const host = text.slice(1, closing)
    const portText = text.slice(closing + 2)
    const port = Number(portText || 443)
    if (!host || !Number.isInteger(port)) return null
    return { host, port }
  }

  const separator = text.lastIndexOf(':')
  if (separator === -1) {
    return { host: text, port: 443 }
  }

  const host = text.slice(0, separator)
  const port = Number(text.slice(separator + 1) || 443)
  if (!host || !Number.isInteger(port)) return null
  return { host, port }
}

async function detectWindowsInterfaceAddress(interfaceAlias) {
  const alias = readString(interfaceAlias)
  if (!alias) return ''

  const command = [
    '-NoProfile',
    '-Command',
    `(Get-NetIPAddress -InterfaceAlias '${alias.replace(/'/g, "''")}' -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress -First 1)`,
  ]

  try {
    const { stdout } = await execFileAsync('powershell', command, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    return readString(stdout)
  } catch {
    return ''
  }
}

function detectPrivateFallbackAddress() {
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') continue
      if (entry.address.startsWith('192.168.0.')) return entry.address
    }
  }
  return ''
}

async function resolveMobileLocalAddress(options = {}) {
  const explicit = readString(options.localAddress || process.env.BROWSERSAVING_MOBILE_LOCAL_ADDRESS)
  if (explicit) return explicit

  if (process.platform === 'win32') {
    const aliases = [
      readString(options.interfaceAlias || process.env.BROWSERSAVING_MOBILE_INTERFACE_ALIAS, 'Ethernet 3'),
      'Ethernet 3',
      'Ethernet 2',
      'USB Ethernet',
    ].filter(Boolean)

    for (const alias of aliases) {
      const address = await detectWindowsInterfaceAddress(alias)
      if (address) return address
    }
  }

  return detectPrivateFallbackAddress()
}

function createMobileEgressProxy(options = {}) {
  let server = null
  let state = null
  const lookupIpv4 = (hostname, lookupOptions, callback) => {
    const nextOptions = typeof lookupOptions === 'function' ? {} : { ...(lookupOptions || {}) }
    const nextCallback = typeof lookupOptions === 'function' ? lookupOptions : callback
    dns.lookup(hostname, {
      ...nextOptions,
      family: 4,
      hints: dns.ADDRCONFIG,
    }, nextCallback)
  }

  function log(message) {
    if (typeof options.logger === 'function') {
      options.logger(message)
    }
  }

  function handleProxyHttpRequest(clientReq, clientRes, localAddress) {
    let targetUrl
    try {
      const rawUrl = readString(clientReq.url)
      const absoluteUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? rawUrl
        : `http://${clientReq.headers.host || ''}${rawUrl}`
      targetUrl = new URL(absoluteUrl)
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      clientRes.end('Invalid proxy request URL')
      return
    }

    const transport = targetUrl.protocol === 'https:' ? https : http
    const upstream = transport.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80)),
      method: clientReq.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: normalizeHeaders(clientReq.headers),
      localAddress,
      family: 4,
      lookup: lookupIpv4,
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
    })

    upstream.on('error', (error) => {
      log(`[mobile-proxy] http upstream failed for ${targetUrl.hostname}: ${String(error)}`)
      clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      clientRes.end(`Proxy request failed: ${String(error)}`)
    })

    clientReq.on('aborted', () => {
      upstream.destroy()
    })

    clientReq.pipe(upstream)
  }

  function handleProxyConnectRequest(clientReq, clientSocket, head, localAddress) {
    const authority = parseConnectAuthority(clientReq.url)
    if (!authority) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      clientSocket.destroy()
      return
    }

    const upstreamSocket = net.connect({
      host: authority.host,
      port: authority.port,
      localAddress,
      family: 4,
      lookup: lookupIpv4,
    })

    upstreamSocket.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) {
        upstreamSocket.write(head)
      }
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })

    upstreamSocket.on('error', () => {
      log(`[mobile-proxy] connect tunnel failed for ${authority.host}:${authority.port}`)
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      clientSocket.destroy()
    })

    clientSocket.on('error', () => {
      upstreamSocket.destroy()
    })
  }

  async function start() {
    if (state) return state

    const localAddress = await resolveMobileLocalAddress(options)
    if (!localAddress) {
      log('[mobile-proxy] skipped: mobile adapter address not found')
      return null
    }

    server = http.createServer((req, res) => {
      handleProxyHttpRequest(req, res, localAddress)
    })
    server.on('connect', (req, socket, head) => {
      handleProxyConnectRequest(req, socket, head, localAddress)
    })

    const address = await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve(server.address())
      })
    })

    if (!address || typeof address === 'string') {
      throw new Error('Failed to start mobile egress proxy')
    }

    state = {
      localAddress,
      listenHost: '127.0.0.1',
      listenPort: address.port,
      proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
      proxyBypassRules: '127.0.0.1;localhost;::1;<local>',
    }

    log(`[mobile-proxy] listening on 127.0.0.1:${address.port}, egress ${localAddress}`)
    return state
  }

  async function stop() {
    const currentServer = server
    server = null
    state = null
    if (!currentServer) return
    await new Promise((resolve) => currentServer.close(() => resolve()))
  }

  function getState() {
    return state
  }

  return {
    start,
    stop,
    getState,
  }
}

module.exports = {
  createMobileEgressProxy,
  resolveMobileLocalAddress,
}
