export interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
}

const API_ORIGIN = 'https://api.oomnn.com'

function sanitizeDownloadFilename(input: string | null): string {
  const raw = String(input || '').trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120)
  if (!cleaned) return 'video_original.mp4'
  return /\.mp4$/i.test(cleaned) ? cleaned : `${cleaned}.mp4`
}

function shouldForceAttachment(url: URL): boolean {
  return url.searchParams.get('download') === '1'
    && /^\/worker-api\/api\/gallery\/[^/]+\/asset\/(?:original|public)$/i.test(url.pathname)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/worker-api/')) {
      const forceAttachment = shouldForceAttachment(url)
      const filename = sanitizeDownloadFilename(url.searchParams.get('filename'))
      const target = new URL(url.pathname.replace(/^\/worker-api/, '') + url.search, API_ORIGIN)
      target.searchParams.delete('download')
      target.searchParams.delete('filename')

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

      const upstreamResponse = await fetch(new Request(target.toString(), init))
      if (!forceAttachment) return upstreamResponse

      const responseHeaders = new Headers(upstreamResponse.headers)
      responseHeaders.set('Content-Disposition', `attachment; filename="${filename}"`)
      responseHeaders.set('X-Content-Type-Options', 'nosniff')
      responseHeaders.set('Cache-Control', 'no-store')
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      })
    }

    return env.ASSETS.fetch(request)
  },
}
