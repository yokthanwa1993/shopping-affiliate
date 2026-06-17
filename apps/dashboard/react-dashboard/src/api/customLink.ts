import { z } from 'zod'
import {
  CUSTOMLINK_ACCOUNT_MAX_LEN,
  CUSTOMLINK_AFFILIATE_ID_REGEX,
  CUSTOMLINK_SUB_MAX_LEN,
} from '../../../src/shared/customlinkContract'

// Zod contract for POST /customlink-api/shorten (dashboard worker, same-origin).
// Mirrors the worker's validation in apps/dashboard/src/server/contracts.ts:
// affiliate id pattern, optional account + sub1..sub5. The worker returns a
// sanitized body with `status` of 'ok' | 'error' | 'manual_login_required'.
//
// The affiliate-id pattern and length caps are imported from the shared,
// framework-free contract module so this client schema (zod@3) and the worker
// schema (zod@4) can never drift on those invariants. The schemas themselves are
// NOT shared because the two build roots pin different zod majors — see the note
// in apps/dashboard/src/shared/customlinkContract.ts.

export const customLinkRequestSchema = z.object({
  url: z.string().url('กรุณาใส่ลิงก์สินค้าที่ถูกต้อง (ขึ้นต้นด้วย http/https)'),
  id: z
    .string()
    .regex(CUSTOMLINK_AFFILIATE_ID_REGEX, 'Affiliate ID ต้องเป็น 3-80 ตัวอักษร (a-z, 0-9, _ -)')
    .optional(),
  account: z.string().max(CUSTOMLINK_ACCOUNT_MAX_LEN).optional(),
  sub1: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub2: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub3: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub4: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub5: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
})

export type CustomLinkRequest = z.infer<typeof customLinkRequestSchema>

export const customLinkResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    status: z.string().optional(),
    shortLink: z.string().optional(),
    longLink: z.string().optional(),
    original: z.string().optional(),
    error: z.string().optional(),
    upstreamStatus: z.number().optional(),
    manual_login_required: z.boolean().optional(),
  })
  .passthrough()

export type CustomLinkResponse = z.infer<typeof customLinkResponseSchema>

// Built-in affiliate presets surfaced in the form (no secrets — these are public
// Shopee affiliate ids already used by the live dashboard). Re-exported from the
// shared contract module so the preset ids match the worker's built-in id list;
// the consuming route still imports `AFFILIATE_PRESETS` from this module.
export { AFFILIATE_PRESETS } from '../../../src/shared/customlinkContract'

export async function shortenCustomLink(
  input: CustomLinkRequest,
  signal?: AbortSignal,
): Promise<CustomLinkResponse> {
  // Drop empty optional fields so we don't send blank sub-ids.
  const payload: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim()) payload[key] = value.trim()
  }
  const response = await fetch('/customlink-api/shorten', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
    signal,
  })
  const text = await response.text()
  let json: unknown = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`Response is not JSON (HTTP ${response.status})`)
    }
  }
  const parsed = customLinkResponseSchema.parse(json)
  // The worker encodes its own failures in the body (status 'error' /
  // 'manual_login_required' with an `error` message) and the UI branches on
  // that, so we return non-2xx responses that carry a structured error. But an
  // opaque non-2xx with no structured error (e.g. a proxy/5xx error page) must
  // bubble up as a thrown error, not a silent "no shortLink" result.
  if (
    !response.ok &&
    !parsed.error &&
    parsed.status !== 'error' &&
    parsed.status !== 'manual_login_required'
  ) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  return parsed
}
