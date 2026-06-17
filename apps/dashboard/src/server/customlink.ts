// Custom-link shorten API slice — first route migrated to Hono + Zod as part of
// the dashboard Worker modernization. This is intentionally a *bridge*: the raw
// fetch handler in worker.ts still owns host routing, redirects, the auth gate
// and asset serving, and simply delegates the customlink shorten request to this
// Hono app. The upstream proxy logic and the exact error codes returned to the
// browser are preserved 1:1 from the previous inline implementation, so there is
// no behavior change for existing callers (Svelte CustomLinkPanel and the React
// custom-link route, which already validate the response with the matching Zod
// contract in react-dashboard/src/api/customLink.ts).

import { Hono } from 'hono'
import {
  customlinkShortenRequestSchema,
  customlinkShortenSuccessSchema,
} from './contracts'
import { isRecord, jsonResponse, pickString, safeString } from './http'
import {
  BUILTIN_CUSTOMLINK_IDS as BUILTIN_CUSTOMLINK_ID_LIST,
  CUSTOMLINK_ACCOUNT_MAX_LEN,
  CUSTOMLINK_AFFILIATE_ID_REGEX,
  CUSTOMLINK_BLOCKED_ACCOUNTS as CUSTOMLINK_BLOCKED_ACCOUNT_LIST,
  CUSTOMLINK_PARAM_KEYS,
  CUSTOMLINK_SUB_MAX_LEN,
  DEFAULT_CUSTOMLINK_ID,
} from '../shared/customlinkContract'

const CUSTOMLINK_ORIGIN = 'https://customlink.wwoom.com'

// Membership sets built from the shared id/label lists, so the `.has()` checks
// below keep their exact previous semantics while the underlying values stay a
// single source of truth in ../shared/customlinkContract.
const BUILTIN_CUSTOMLINK_IDS = new Set<string>(BUILTIN_CUSTOMLINK_ID_LIST)
const CUSTOMLINK_BLOCKED_ACCOUNTS = new Set<string>(CUSTOMLINK_BLOCKED_ACCOUNT_LIST)

// The Zod request/success contracts now live in ./contracts (worker-side, zod@4)
// and are imported above. Their shapes are byte-identical to the previous inline
// definitions; the granular error codes (url_required, invalid_url, …) are still
// produced by the explicit checks below so the UI keeps the precise messages it
// branches on, with the schema as the formal contract gate behind them.

function sanitizeClientValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}...` : value
  }
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeClientValue(item, depth + 1))
  if (!isRecord(value)) return String(value)

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (/token|secret|cookie|authorization|password|api[-_]?key/i.test(key)) {
      out[key] = '[REDACTED]'
    } else {
      out[key] = sanitizeClientValue(raw, depth + 1)
    }
  }
  return out
}

function includesLoginRequiredSignal(value: unknown): boolean {
  if (typeof value === 'string') {
    return /manual[_ -]?login[_ -]?required|login required|please login|not logged in|session expired|unauthori[sz]ed|authentication required/i.test(value)
  }
  if (Array.isArray(value)) return value.some((item) => includesLoginRequiredSignal(item))
  if (isRecord(value)) {
    return Object.entries(value).some(([key, item]) => {
      if (/manual[_ -]?login[_ -]?required/i.test(key) && item === true) return true
      if (/login|auth|session/i.test(key) && typeof item === 'string') {
        return /required|expired|invalid|failed|missing|unauthori[sz]ed|please login/i.test(item)
      }
      return includesLoginRequiredSignal(item)
    })
  }
  return false
}

function extractShortLink(upstream: unknown): string {
  return pickString(upstream, ['shortLink', 'short_link', 'shortlink', 'shortUrl', 'short_url', 'shopeeLink', 'shopee_link'])
}

function extractLongLink(upstream: unknown): string {
  return pickString(upstream, ['longLink', 'long_link', 'longUrl', 'long_url', 'destinationLink', 'destination_link'])
}

function extractOriginalLink(upstream: unknown): string {
  return pickString(upstream, ['original', 'originalUrl', 'original_url', 'productUrl', 'product_url', 'url'])
}

async function handleCustomlinkShorten(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ ok: false, status: 'error', error: 'invalid_json' }, 400)
  }

  if (!isRecord(body)) {
    return jsonResponse({ ok: false, status: 'error', error: 'invalid_payload' }, 400)
  }

  const productUrl = pickString(body, ['url', 'productUrl', 'product_url'])
  if (!productUrl) {
    return jsonResponse({ ok: false, status: 'error', error: 'url_required' }, 400)
  }

  let parsedProductUrl: URL
  try {
    parsedProductUrl = new URL(productUrl)
  } catch {
    return jsonResponse({ ok: false, status: 'error', error: 'invalid_url' }, 400)
  }
  if (!['http:', 'https:'].includes(parsedProductUrl.protocol)) {
    return jsonResponse({ ok: false, status: 'error', error: 'invalid_url_protocol' }, 400)
  }

  const affiliateId = pickString(body, ['id', 'affiliateId', 'affiliate_id']) || DEFAULT_CUSTOMLINK_ID
  if (!CUSTOMLINK_AFFILIATE_ID_REGEX.test(affiliateId)) {
    return jsonResponse({ ok: false, status: 'error', error: 'invalid_affiliate_id' }, 400)
  }

  const account = pickString(body, ['account', 'accountAlias', 'account_alias'])

  // Formal contract gate: the granular checks above already guarantee these
  // invariants, so a failure here means an unexpected normalized shape. Keep the
  // existing generic code so the client sees a stable error.
  const normalized: Record<string, string> = { url: productUrl, id: affiliateId }
  if (account) normalized.account = account
  for (const key of CUSTOMLINK_PARAM_KEYS) {
    const value = safeString(body[key])
    if (value) normalized[key] = value
  }
  if (!customlinkShortenRequestSchema.safeParse(normalized).success) {
    return jsonResponse({ ok: false, status: 'error', error: 'invalid_payload' }, 400)
  }

  const upstreamUrl = new URL('/', CUSTOMLINK_ORIGIN)
  upstreamUrl.searchParams.set('id', affiliateId)
  upstreamUrl.searchParams.set('url', productUrl)

  // Only forward `account` for non-built-in (custom) ids, and never forward a
  // blocked UI label. Built-in preset ids are resolved to their account upstream
  // by id alone, so forwarding a label would cause an account conflict.
  if (
    account &&
    !BUILTIN_CUSTOMLINK_IDS.has(affiliateId) &&
    !CUSTOMLINK_BLOCKED_ACCOUNTS.has(account.trim().toLowerCase())
  ) {
    upstreamUrl.searchParams.set('account', account.slice(0, CUSTOMLINK_ACCOUNT_MAX_LEN))
  }

  for (const key of CUSTOMLINK_PARAM_KEYS) {
    const value = safeString(body[key])
    if (value) upstreamUrl.searchParams.set(key, value.slice(0, CUSTOMLINK_SUB_MAX_LEN))
  }

  let upstreamResponse: Response
  let upstreamText = ''
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
    })
    upstreamText = await upstreamResponse.text()
  } catch {
    return jsonResponse({ ok: false, status: 'error', error: 'upstream_unreachable' }, 502)
  }

  let upstreamJson: unknown = null
  if (upstreamText) {
    try {
      upstreamJson = JSON.parse(upstreamText)
    } catch {
      upstreamJson = { body: upstreamText.slice(0, 2000) }
    }
  }

  const manualLoginRequired = [401, 403].includes(upstreamResponse.status) || includesLoginRequiredSignal(upstreamJson)
  if (!upstreamResponse.ok) {
    return jsonResponse(
      {
        ok: false,
        status: manualLoginRequired ? 'manual_login_required' : 'error',
        error: manualLoginRequired ? 'manual_login_required' : 'upstream_error',
        upstreamStatus: upstreamResponse.status,
        details: sanitizeClientValue(upstreamJson),
      },
      manualLoginRequired ? 409 : 502,
    )
  }

  const shortLink = extractShortLink(upstreamJson)
  if (!shortLink) {
    return jsonResponse(
      {
        ok: false,
        status: manualLoginRequired ? 'manual_login_required' : 'error',
        error: manualLoginRequired ? 'manual_login_required' : 'shortlink_missing',
        upstreamStatus: upstreamResponse.status,
        details: sanitizeClientValue(upstreamJson),
      },
      manualLoginRequired ? 409 : 502,
    )
  }

  const payload = customlinkShortenSuccessSchema.parse({
    ok: true,
    status: 'ok',
    shortLink,
    longLink: extractLongLink(upstreamJson),
    original: extractOriginalLink(upstreamJson),
    upstreamStatus: upstreamResponse.status,
    details: sanitizeClientValue(upstreamJson),
  })
  return jsonResponse(payload)
}

// Hono app for the customlink slice. worker.ts rewrites every public shorten
// alias (/customlink-api/shorten, /dashboard/api/custom-link/shorten, with or
// without a trailing slash) to the internal /shorten path before delegating
// here, so this app only needs the one canonical route. Non-POST methods get the
// same 405 + Allow: POST as the previous inline handler.
export const customlinkApp = new Hono()

customlinkApp.post('/shorten', (c) => handleCustomlinkShorten(c.req.raw))

customlinkApp.all('/shorten', () =>
  jsonResponse({ ok: false, status: 'error', error: 'method_not_allowed' }, 405, { Allow: 'POST' }),
)
