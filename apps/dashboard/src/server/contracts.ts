// Worker-side Zod contracts for the dashboard API slices (Phase 6). Promoted out
// of the individual Hono bridge files so the worker has one canonical home for
// its request/response schemas. These are the worker's authoritative validation
// gates (zod@4, the worker's resolved major); the React client mirrors the same
// shapes against zod@3 from the shared, zod-free primitives in
// ../shared/customlinkContract — see that file's note on why the *schemas*
// themselves are not cross-imported.

import { z } from 'zod'
import {
  CUSTOMLINK_ACCOUNT_MAX_LEN,
  CUSTOMLINK_AFFILIATE_ID_REGEX,
  CUSTOMLINK_SUB_MAX_LEN,
} from '../shared/customlinkContract'

// Request schema is applied to the *normalized* payload (after alias resolution
// in handleCustomlinkShorten), mirroring react-dashboard/src/api/customLink.ts so
// both ends of the same-origin call agree on one shape. Shapes are byte-identical
// to the previous inline definition in src/server/customlink.ts.
export const customlinkShortenRequestSchema = z.object({
  url: z.string().min(1),
  id: z.string().regex(CUSTOMLINK_AFFILIATE_ID_REGEX),
  account: z.string().max(CUSTOMLINK_ACCOUNT_MAX_LEN).optional(),
  sub1: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub2: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub3: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub4: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
  sub5: z.string().max(CUSTOMLINK_SUB_MAX_LEN).optional(),
})

export type CustomlinkShortenRequest = z.infer<typeof customlinkShortenRequestSchema>

// Success response contract. Parsed before returning so a malformed success body
// can never reach the client; matches the success branch of the React/Svelte
// response handling.
export const customlinkShortenSuccessSchema = z.object({
  ok: z.literal(true),
  status: z.literal('ok'),
  shortLink: z.string().min(1),
  longLink: z.string(),
  original: z.string(),
  upstreamStatus: z.number(),
  details: z.unknown(),
})
