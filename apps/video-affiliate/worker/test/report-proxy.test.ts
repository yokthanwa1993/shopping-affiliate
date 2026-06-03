import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildUpstreamUrl,
    handleReportProxyRequest,
    recognizeProxyTarget,
    type ReportProxyFetch,
} from '../src/report-proxy.js'

// Collect the headers a stub fetch observed, lowercased, so assertions about
// what does (and does not) reach upstream are case-insensitive.
function collectHeaders(init: RequestInit | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    const headers = init?.headers
    if (!headers) return out
    if (headers instanceof Headers) {
        headers.forEach((value, key) => { out[key.toLowerCase()] = value })
    } else if (Array.isArray(headers)) {
        for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value)
    } else {
        for (const [key, value] of Object.entries(headers as Record<string, string>)) {
            out[key.toLowerCase()] = String(value)
        }
    }
    return out
}

test('recognizeProxyTarget maps canonical Pubilo aliases to their upstream target', () => {
    assert.equal(recognizeProxyTarget('/click'), 'click')
    assert.equal(recognizeProxyTarget('/click/'), 'click')
    assert.equal(recognizeProxyTarget('/conversion'), 'conversion')
    assert.equal(recognizeProxyTarget('/conversion/'), 'conversion')
    // The Shopee/Lazada shortlink JSON bridge has three public spellings.
    assert.equal(recognizeProxyTarget('/custom_link'), 'custom_link')
    assert.equal(recognizeProxyTarget('/custom_link/'), 'custom_link')
    assert.equal(recognizeProxyTarget('/customlink'), 'custom_link')
    assert.equal(recognizeProxyTarget('/customlink/'), 'custom_link')
    assert.equal(recognizeProxyTarget('/link'), 'custom_link')
    assert.equal(recognizeProxyTarget('/link/'), 'custom_link')
})

test('recognizeProxyTarget keeps legacy *_report aliases working side by side', () => {
    assert.equal(recognizeProxyTarget('/click_report'), 'click')
    assert.equal(recognizeProxyTarget('/click_report/'), 'click')
    assert.equal(recognizeProxyTarget('/conversion_report'), 'conversion')
    assert.equal(recognizeProxyTarget('/conversion_report/'), 'conversion')
})

test('recognizeProxyTarget rejects anything that is not an exact recognized path', () => {
    // Sub-paths are never matched.
    assert.equal(recognizeProxyTarget('/click/extra'), null)
    assert.equal(recognizeProxyTarget('/conversion_report/extra/'), null)
    assert.equal(recognizeProxyTarget('/custom_link/extra'), null)
    // Upstream route names are not part of the public surface.
    assert.equal(recognizeProxyTarget('/click-report'), null)
    assert.equal(recognizeProxyTarget('/conversion-report'), null)
    // Near-misses must not collide with a recognized alias.
    assert.equal(recognizeProxyTarget('/customlinks'), null)
    assert.equal(recognizeProxyTarget('/links'), null)
    assert.equal(recognizeProxyTarget('/clicks'), null)
    assert.equal(recognizeProxyTarget('/api/click'), null)
    assert.equal(recognizeProxyTarget('/'), null)
    assert.equal(recognizeProxyTarget(''), null)
    assert.equal(recognizeProxyTarget(null), null)
    assert.equal(recognizeProxyTarget(undefined), null)
})

test('buildUpstreamUrl points click at the customlink click-report route', () => {
    assert.equal(
        buildUpstreamUrl('click', '?id=15130770000&time=25/05/2026'),
        'https://customlink.wwoom.com/click-report?id=15130770000&time=25/05/2026',
    )
    // A query string without a leading "?" is normalized the same way.
    assert.equal(
        buildUpstreamUrl('click', 'id=15130770000&time=25/05/2026'),
        'https://customlink.wwoom.com/click-report?id=15130770000&time=25/05/2026',
    )
})

test('buildUpstreamUrl points conversion at the customlink conversion-report route', () => {
    assert.equal(
        buildUpstreamUrl('conversion', '?id=15130770000&time=26/05/2026'),
        'https://customlink.wwoom.com/conversion-report?id=15130770000&time=26/05/2026',
    )
})

test('buildUpstreamUrl points custom_link at the customlink shortlink root', () => {
    assert.equal(
        buildUpstreamUrl('custom_link', '?url=https://shopee.co.th/product/1/2&sub_id=abc'),
        'https://customlink.wwoom.com/?url=https://shopee.co.th/product/1/2&sub_id=abc',
    )
})

test('buildUpstreamUrl resolves the /link alias to the same shortlink root', () => {
    // /link and /custom_link and /customlink all collapse to one upstream root.
    const target = recognizeProxyTarget('/link')
    assert.equal(target, 'custom_link')
    assert.equal(
        buildUpstreamUrl(target!, 'url=https://s.lazada.co.th/s.abc'),
        'https://customlink.wwoom.com/?url=https://s.lazada.co.th/s.abc',
    )
})

test('buildUpstreamUrl handles empty / null / undefined query strings', () => {
    assert.equal(
        buildUpstreamUrl('click', ''),
        'https://customlink.wwoom.com/click-report',
    )
    assert.equal(
        buildUpstreamUrl('conversion', null),
        'https://customlink.wwoom.com/conversion-report',
    )
    assert.equal(
        buildUpstreamUrl('custom_link', undefined),
        'https://customlink.wwoom.com/',
    )
})

test('handleReportProxyRequest returns null for unrelated paths', async () => {
    const response = await handleReportProxyRequest(new Request('https://api.pubilo.com/api/something'))
    assert.equal(response, null)
})

test('handleReportProxyRequest handles OPTIONS preflight with permissive CORS', async () => {
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/click/', { method: 'OPTIONS' }),
    )
    assert.ok(response)
    assert.equal(response!.status, 204)
    assert.equal(response!.headers.get('Access-Control-Allow-Origin'), '*')
    assert.match(response!.headers.get('Access-Control-Allow-Methods') ?? '', /GET/)
})

test('handleReportProxyRequest rejects non GET/HEAD with 405 and Allow header', async () => {
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/conversion', { method: 'POST' }),
    )
    assert.ok(response)
    assert.equal(response!.status, 405)
    assert.equal(response!.headers.get('Allow'), 'GET, HEAD, OPTIONS')
    assert.equal(response!.headers.get('Access-Control-Allow-Origin'), '*')
    const body = await response!.json() as { status: string; error: string }
    assert.equal(body.status, 'error')
    assert.equal(body.error, 'method_not_allowed')
})

test('handleReportProxyRequest proxies canonical GET /click to the click-report upstream without leaking auth', async () => {
    let observedUrl = ''
    let observedHeaders: Record<string, string> = {}
    const fetchImpl: ReportProxyFetch = async (input, init) => {
        observedUrl = String(input)
        observedHeaders = collectHeaders(init)
        return new Response(JSON.stringify({ status: 'ok', source: 'shopee_click_report_api' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/click?id=15130770000&time=25/05/2026', {
            method: 'GET',
            headers: {
                cookie: 'chearb_sess=sess_abc',
                'x-admin-token': 'secret',
                authorization: 'Bearer nope',
            },
        }),
        { fetchImpl },
    )
    assert.ok(response)
    assert.equal(response!.status, 200)
    assert.equal(
        observedUrl,
        'https://customlink.wwoom.com/click-report?id=15130770000&time=25/05/2026',
    )
    // Cookies, admin and auth headers must never be forwarded upstream.
    assert.equal(observedHeaders['cookie'], undefined)
    assert.equal(observedHeaders['x-admin-token'], undefined)
    assert.equal(observedHeaders['authorization'], undefined)
    assert.match(observedHeaders['accept'] ?? '', /application\/json/)
    assert.equal(response!.headers.get('Access-Control-Allow-Origin'), '*')
    assert.match(response!.headers.get('Content-Type') ?? '', /application\/json/)
    const body = await response!.json() as { status: string; source: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.source, 'shopee_click_report_api')
})

test('handleReportProxyRequest proxies the custom_link shortlink bridge to the upstream root', async () => {
    let observedUrl = ''
    let observedHeaders: Record<string, string> = {}
    const fetchImpl: ReportProxyFetch = async (input, init) => {
        observedUrl = String(input)
        observedHeaders = collectHeaders(init)
        return new Response(JSON.stringify({ status: 'ok', short_link: 'https://s.shopee.co.th/x' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/custom_link?url=https://shopee.co.th/product/1/2', {
            method: 'GET',
            headers: { cookie: 'chearb_sess=sess_abc', 'x-admin-token': 'secret' },
        }),
        { fetchImpl },
    )
    assert.ok(response)
    assert.equal(response!.status, 200)
    assert.equal(
        observedUrl,
        'https://customlink.wwoom.com/?url=https://shopee.co.th/product/1/2',
    )
    assert.equal(observedHeaders['cookie'], undefined)
    assert.equal(observedHeaders['x-admin-token'], undefined)
    const body = await response!.json() as { status: string; short_link: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.short_link, 'https://s.shopee.co.th/x')
})

test('handleReportProxyRequest still serves the legacy /click_report alias unchanged', async () => {
    let observedUrl = ''
    let observedHeaders: Record<string, string> = {}
    const fetchImpl: ReportProxyFetch = async (input, init) => {
        observedUrl = String(input)
        observedHeaders = collectHeaders(init)
        return new Response(JSON.stringify({ status: 'ok', source: 'shopee_click_report_api' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/click_report/?id=15130770000&time=25/05/2026', {
            method: 'GET',
            headers: { cookie: 'chearb_sess=sess_abc', 'x-admin-token': 'secret' },
        }),
        { fetchImpl },
    )
    assert.ok(response)
    assert.equal(response!.status, 200)
    assert.equal(
        observedUrl,
        'https://customlink.wwoom.com/click-report?id=15130770000&time=25/05/2026',
    )
    assert.equal(observedHeaders['cookie'], undefined)
    assert.equal(observedHeaders['x-admin-token'], undefined)
})

test('handleReportProxyRequest proxies HEAD without body and preserves status', async () => {
    let observedUrl = ''
    const fetchImpl: ReportProxyFetch = async (input) => {
        observedUrl = String(input)
        return new Response('ignored', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/conversion', { method: 'HEAD' }),
        { fetchImpl },
    )
    assert.ok(response)
    assert.equal(response!.status, 200)
    assert.equal(observedUrl, 'https://customlink.wwoom.com/conversion-report')
    const text = await response!.text()
    assert.equal(text, '')
})

test('handleReportProxyRequest surfaces upstream non-200 status without rewriting the body', async () => {
    const fetchImpl: ReportProxyFetch = async () =>
        new Response(JSON.stringify({ status: 'error', message: 'login_required' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        })
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/conversion/?id=1&time=25/05/2026'),
        { fetchImpl },
    )
    assert.ok(response)
    assert.equal(response!.status, 503)
    const body = await response!.json() as { status: string; message: string }
    assert.equal(body.status, 'error')
    assert.equal(body.message, 'login_required')
})

test('handleReportProxyRequest returns 502 when upstream fetch throws', async () => {
    const fetchImpl: ReportProxyFetch = async () => { throw new Error('boom') }
    const response = await handleReportProxyRequest(
        new Request('https://api.pubilo.com/click'),
        { fetchImpl },
    )
    assert.ok(response)
    assert.equal(response!.status, 502)
    const body = await response!.json() as { status: string; error: string }
    assert.equal(body.status, 'error')
    assert.equal(body.error, 'upstream_unreachable')
})
