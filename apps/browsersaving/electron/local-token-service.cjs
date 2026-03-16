const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fileExists(targetPath) {
  try {
    return fs.existsSync(targetPath)
  } catch {
    return false
  }
}

function requestJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode || 0,
            body: body ? JSON.parse(body) : {},
          })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('request_timeout'))
    })
  })
}

async function waitForHealth(url, { retries = 20, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await requestJson(url)
      if (response.statusCode === 200 && response.body?.status === 'ok') {
        return response.body
      }
    } catch {
      // retry
    }
    await delay(delayMs)
  }
  throw new Error('Local token service health check timed out')
}

function buildPythonCandidates() {
  const envPath = String(process.env.BROWSERSAVING_PYTHON_BIN || '').trim()
  const candidates = []
  if (envPath) {
    candidates.push({ command: envPath, args: [] })
  }
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', args: ['-3'] })
    candidates.push({ command: 'python', args: [] })
  } else {
    candidates.push({ command: 'python3', args: [] })
    candidates.push({ command: 'python', args: [] })
  }
  return candidates
}

function probePythonCandidate(candidate) {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, [...candidate.args, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function detectPythonCandidate() {
  for (const candidate of buildPythonCandidates()) {
    const ok = await probePythonCandidate(candidate)
    if (ok) return candidate
  }
  return null
}

function createLocalTokenService({ logger = console.log, scriptRoot, port = 5517 } = {}) {
  let child = null
  let serviceUrl = `http://127.0.0.1:${port}`

  async function start() {
    const appPath = path.join(scriptRoot, 'app.py')
    if (!fileExists(appPath)) {
      throw new Error(`Local token service script not found: ${appPath}`)
    }

    try {
      await waitForHealth(`${serviceUrl}/health`, { retries: 2, delayMs: 200 })
      logger(`[electron-token] reusing existing local token service at ${serviceUrl}`)
      return { serviceUrl, reused: true }
    } catch {
      // start a fresh child below
    }

    const candidate = await detectPythonCandidate()
    if (!candidate) {
      throw new Error('Python runtime not found (expected py/python in PATH)')
    }

    const bootstrap = [
      'import sys',
      `sys.path.insert(0, r'''${scriptRoot.replace(/\\/g, '\\\\')}''')`,
      'from app import app',
      `app.run(host='127.0.0.1', port=${port}, debug=False, use_reloader=False, threaded=True)`,
    ].join('; ')

    child = spawn(candidate.command, [...candidate.args, '-c', bootstrap], {
      cwd: scriptRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        BROWSERSAVING_TOKEN_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    child.stdout.on('data', (chunk) => {
      logger(`[electron-token] ${String(chunk).trim()}`)
    })
    child.stderr.on('data', (chunk) => {
      logger(`[electron-token][stderr] ${String(chunk).trim()}`)
    })
    child.once('exit', (code, signal) => {
      logger(`[electron-token] exited code=${String(code)} signal=${String(signal)}`)
      child = null
    })

    await waitForHealth(`${serviceUrl}/health`)
    logger(`[electron-token] local token service ready at ${serviceUrl}`)
    return { serviceUrl, reused: false }
  }

  async function stop() {
    if (!child || child.killed) return
    const current = child
    child = null
    current.kill()
    await delay(300)
    if (!current.killed) {
      current.kill('SIGKILL')
    }
  }

  return {
    start,
    stop,
    get serviceUrl() {
      return serviceUrl
    },
  }
}

module.exports = {
  createLocalTokenService,
}
