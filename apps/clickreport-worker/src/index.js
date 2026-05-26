const UPSTREAM_ORIGIN = 'https://customlink.wwoom.com';
const UPSTREAM_PATH = '/click-report';
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

export function buildUpstreamUrl(requestUrl, opts = {}) {
  const origin = opts.upstreamOrigin || UPSTREAM_ORIGIN;
  const path = opts.upstreamPath || UPSTREAM_PATH;
  const src = new URL(requestUrl);
  const dst = new URL(path, origin);
  dst.search = src.search;
  return dst.toString();
}

function corsHeaders(extra) {
  const headers = new Headers(extra || {});
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return headers;
}

function jsonResponse(status, body, extraHeaders) {
  const headers = corsHeaders(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleRequest(request, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    const headers = corsHeaders();
    headers.set('Allow', ALLOWED_METHODS);
    return new Response(null, { status: 204, headers });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return jsonResponse(405, {
      status: 'error',
      error: 'method_not_allowed',
      message: 'Only GET and HEAD are supported.',
    }, { Allow: 'GET, HEAD' });
  }

  const upstreamUrl = buildUpstreamUrl(request.url, opts);

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (err) {
    return jsonResponse(502, {
      status: 'error',
      error: 'upstream_unreachable',
      message: 'Failed to reach customlink.wwoom.com click-report bridge.',
      detail: String(err && err.message ? err.message : err).slice(0, 300),
    });
  }

  const headers = corsHeaders();
  const upstreamCT = upstream.headers.get('content-type');
  headers.set('Content-Type', upstreamCT && /json/i.test(upstreamCT) ? upstreamCT : 'application/json; charset=utf-8');

  const body = method === 'HEAD' ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers });
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
