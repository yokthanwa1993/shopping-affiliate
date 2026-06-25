// Public proxy aliases on api.pubilo.com (and legacy api.oomnn.com during
// cutover) for the Shopee/Lazada APIs hosted at customlink.wwoom.com.
//
// Canonical Pubilo aliases (current public contract):
//   /click[/]        -> https://customlink.wwoom.com/click-report
//   /conversion[/]   -> https://customlink.wwoom.com/conversion-report
//   /income[/]       -> https://customlink.wwoom.com/daily-income-report  (Shopee dashboard/detail summary)
//   /custom_link[/]  -> https://customlink.wwoom.com/   (Shopee/Lazada shortlink JSON bridge)
//   /customlink[/]   -> https://customlink.wwoom.com/
//   /link[/]         -> https://customlink.wwoom.com/
//
// Income aliases (all collapse to the one daily-income-report upstream):
//   /income[/]         /income_report[/]
//   /daily_income[/]   /daily-income[/]
//
// Legacy aliases (kept working exactly as before, side by side):
//   /click_report[/]       -> https://customlink.wwoom.com/click-report
//   /conversion_report[/]  -> https://customlink.wwoom.com/conversion-report
//
// Query string is forwarded verbatim. No cookies/auth/admin tokens are passed
// upstream so this surface stays a truly public alias.

// Upstream destination behind each recognized path. Several public aliases can
// map to the same target (e.g. /click and the legacy /click_report).
export type ProxyTarget = 'click' | 'conversion' | 'income' | 'custom_link'

const UPSTREAM_HOST = 'https://customlink.wwoom.com'

const UPSTREAM_PATH: Record<ProxyTarget, string> = {
    click: '/click-report',
    conversion: '/conversion-report',
    income: '/daily-income-report',
    custom_link: '/',
}

const RECOGNIZED_PATHS: Record<string, ProxyTarget> = {
    // Canonical Pubilo public aliases.
    '/click': 'click',
    '/click/': 'click',
    '/conversion': 'conversion',
    '/conversion/': 'conversion',
    // Daily income dashboard-detail summary — same upstream behind several
    // read-only spellings the dashboard can call.
    '/income': 'income',
    '/income/': 'income',
    '/income_report': 'income',
    '/income_report/': 'income',
    '/daily_income': 'income',
    '/daily_income/': 'income',
    '/daily-income': 'income',
    '/daily-income/': 'income',
    '/custom_link': 'custom_link',
    '/custom_link/': 'custom_link',
    '/customlink': 'custom_link',
    '/customlink/': 'custom_link',
    '/link': 'custom_link',
    '/link/': 'custom_link',
    // Legacy aliases — preserved unchanged so existing callers keep working.
    '/click_report': 'click',
    '/click_report/': 'click',
    '/conversion_report': 'conversion',
    '/conversion_report/': 'conversion',
}

export function recognizeProxyTarget(pathname: string | null | undefined): ProxyTarget | null {
    const path = String(pathname || '')
    return RECOGNIZED_PATHS[path] ?? null
}

export function buildUpstreamUrl(target: ProxyTarget, queryString: string | null | undefined): string {
    const upstreamPath = UPSTREAM_PATH[target]
    const rawQuery = String(queryString || '')
    const normalizedQuery = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery
    return normalizedQuery
        ? `${UPSTREAM_HOST}${upstreamPath}?${normalizedQuery}`
        : `${UPSTREAM_HOST}${upstreamPath}`
}

function buildCorsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    }
}

function buildJsonErrorResponse(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({ status: 'error', error: code, message }), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...buildCorsHeaders(),
        },
    })
}

// Fetch driver indirection so tests can swap in a stub without touching network.
export type ReportProxyFetch = (input: string, init?: RequestInit) => Promise<Response>

export async function handleReportProxyRequest(
    request: Request,
    options: { fetchImpl?: ReportProxyFetch } = {},
): Promise<Response | null> {
    const url = new URL(request.url)
    const target = recognizeProxyTarget(url.pathname)
    if (!target) return null

    const method = request.method.toUpperCase()

    if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: buildCorsHeaders() })
    }

    if (method !== 'GET' && method !== 'HEAD') {
        return new Response(JSON.stringify({ status: 'error', error: 'method_not_allowed' }), {
            status: 405,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Allow: 'GET, HEAD, OPTIONS',
                ...buildCorsHeaders(),
            },
        })
    }

    const upstreamUrl = buildUpstreamUrl(target, url.search)
    const fetchImpl = options.fetchImpl ?? fetch

    let upstreamResponse: Response
    try {
        upstreamResponse = await fetchImpl(upstreamUrl, {
            method,
            // Do not forward cookies/auth headers; the alias is public.
            headers: { Accept: 'application/json' },
            redirect: 'follow',
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return buildJsonErrorResponse(502, 'upstream_unreachable', message.slice(0, 200))
    }

    const upstreamContentType = upstreamResponse.headers.get('Content-Type')
        || 'application/json; charset=utf-8'

    const responseHeaders: Record<string, string> = {
        'Content-Type': upstreamContentType,
        ...buildCorsHeaders(),
    }

    const cacheControl = upstreamResponse.headers.get('Cache-Control')
    if (cacheControl) responseHeaders['Cache-Control'] = cacheControl

    if (method === 'HEAD') {
        return new Response(null, {
            status: upstreamResponse.status,
            headers: responseHeaders,
        })
    }

    const body = await upstreamResponse.arrayBuffer()
    return new Response(body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
    })
}
