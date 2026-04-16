export interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
}

const API_ORIGIN = 'https://api.oomnn.com'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/worker-api/')) {
      const target = new URL(url.pathname.replace(/^\/worker-api/, '') + url.search, API_ORIGIN)
      const headers = new Headers(request.headers)
      headers.delete('host')
      headers.set('x-forwarded-host', url.host)
      headers.set('x-forwarded-proto', url.protocol.replace(':', ''))

      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: 'follow',
      }

      if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
        init.body = request.body
      }

      return fetch(new Request(target.toString(), init))
    }

    return env.ASSETS.fetch(request)
  },
}
