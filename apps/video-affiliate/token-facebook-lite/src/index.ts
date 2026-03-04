import { Container } from '@cloudflare/containers'

interface Env {
  TOKEN_FACEBOOK_LITE: any
}

export class TokenFacebookLite extends Container {
  defaultPort = 8080
  sleepAfter = '15m'
  enableInternet = true
}

function containerKeyFromRequest(request: Request): string {
  const url = new URL(request.url)
  const explicit = url.searchParams.get('instance')
  if (explicit && explicit.trim()) return explicit.trim()
  return 'singleton'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, service: 'token-facebook-lite' }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    const instanceKey = containerKeyFromRequest(request)
    const container = env.TOKEN_FACEBOOK_LITE.getByName(instanceKey)
    await container.startAndWaitForPorts()
    return container.fetch(request)
  },
}
