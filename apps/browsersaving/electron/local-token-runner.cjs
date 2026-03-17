const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

function fileExists(targetPath) {
  try {
    return fs.existsSync(targetPath)
  } catch {
    return false
  }
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

function collectProcessOutput(child) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Python exited with code ${String(code)}`))
    })
  })
}

function createLocalTokenRunner({ logger = console.log, scriptRoot } = {}) {
  async function run(functionName, payload = {}) {
    const corePath = path.join(scriptRoot, 'core.py')
    if (!fileExists(corePath)) {
      throw new Error(`Local token core not found: ${corePath}`)
    }

    const candidate = await detectPythonCandidate()
    if (!candidate) {
      throw new Error('Python runtime not found (expected py/python in PATH)')
    }

    const bootstrap = [
      'import json, sys',
      `sys.path.insert(0, r'''${scriptRoot.replace(/\\/g, '\\\\')}''')`,
      `from core import ${functionName}`,
      'payload = json.loads(sys.stdin.read() or "{}")',
      `result, status = ${functionName}(payload)`,
      'print(json.dumps({"status": status, "body": result}, ensure_ascii=False))',
    ].join('; ')

    const child = spawn(candidate.command, [...candidate.args, '-c', bootstrap], {
      cwd: scriptRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    child.stdin.end(JSON.stringify(payload || {}))

    const { stdout, stderr } = await collectProcessOutput(child)
    if (stderr.trim()) {
      logger(`[electron-token-runner][stderr] ${stderr.trim()}`)
    }

    const raw = stdout.trim()
    if (!raw) {
      throw new Error('Local token runner returned empty output')
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Local token runner returned invalid JSON: ${raw}`)
    }

    return parsed
  }

  return {
    async getCommentToken(payload) {
      const result = await run('run_comment_token', payload)
      return result?.body || {}
    },
    async proxyCheck(payload) {
      const result = await run('run_proxy_check', payload)
      return result?.body || {}
    },
  }
}

module.exports = {
  createLocalTokenRunner,
}
