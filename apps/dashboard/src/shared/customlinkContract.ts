// Shared, dependency-FREE contract primitives for the customlink shorten API.
//
// Single source of truth for the values that were previously duplicated, by
// hand, between the dashboard worker (src/server/customlink.ts) and the React
// client (react-dashboard/src/api/customLink.ts): the affiliate-id pattern, the
// field length limits, the sub-param keys and the public affiliate presets.
//
// Intentionally zod-FREE. The two build roots pin different zod majors (the
// worker resolves zod@4, the React subapp resolves zod@3), so a shared *zod
// schema* module is NOT safe to cross-import — its types and runtime would
// differ per root. These plain TypeScript constants have no dependencies, so the
// worker (Astro/tsc) and the React (Vite/tsc) build can both import this file
// safely. Each side composes its own zod schema from these primitives. See the
// Phase 6 feasibility note in docs/plans/full-system-modernization.md.

// Affiliate id: 3–80 chars of [a-zA-Z0-9_-]. Shared so the worker's strict gate
// and the client's form validation can never drift apart.
export const CUSTOMLINK_AFFILIATE_ID_REGEX = /^[a-zA-Z0-9_-]{3,80}$/

// Default affiliate id used when the client omits one (CHEARB preset).
export const DEFAULT_CUSTOMLINK_ID = '15130770000'

// Upstream field length caps applied on both ends.
export const CUSTOMLINK_ACCOUNT_MAX_LEN = 80
export const CUSTOMLINK_SUB_MAX_LEN = 300

// Optional Shopee sub-id passthrough params, in order.
export const CUSTOMLINK_PARAM_KEYS = ['sub1', 'sub2', 'sub3', 'sub4', 'sub5'] as const
export type CustomlinkParamKey = (typeof CUSTOMLINK_PARAM_KEYS)[number]

// Built-in affiliate preset ids. Upstream maps these numeric ids to the correct
// Shopee account on its own, so the proxy must NOT forward an `account` for them.
export const BUILTIN_CUSTOMLINK_IDS = ['15130770000', '15142270000'] as const

// UI labels that must never be forwarded as an upstream `account`, regardless of
// id (forwarding a label causes shopee_affiliate_account_conflict).
export const CUSTOMLINK_BLOCKED_ACCOUNTS = ['chearb', 'neezs'] as const

// Built-in affiliate presets surfaced in the React form. No secrets — these are
// public Shopee affiliate ids already used by the live dashboard. Ids match
// BUILTIN_CUSTOMLINK_IDS above.
export const AFFILIATE_PRESETS = [
  { label: 'CHEARB (เฉียบ)', id: '15130770000' },
  { label: 'NEEZS', id: '15142270000' },
] as const

// Topnav workspaces. The selected workspace is the single source of truth for
// the customlink affiliate preset, so the Custom Link form can never use one
// brand's id while another brand is selected.
export const WORKSPACES = ['CHEARB', 'NEEZS'] as const
export type Workspace = (typeof WORKSPACES)[number]

// Maps a workspace to its affiliate preset. `id` is the built-in Shopee
// affiliate id that the worker forwards upstream (account-free — see
// BUILTIN_CUSTOMLINK_IDS / CUSTOMLINK_BLOCKED_ACCOUNTS). `accountEmail` is a
// public, display-only label shown in the UI for clarity; it must NEVER be
// forwarded upstream as an `account` (that triggers
// shopee_affiliate_account_conflict). No secrets here.
export const WORKSPACE_AFFILIATES = {
  CHEARB: { id: '15130770000', accountEmail: 'affiliate@chearb.com' },
  NEEZS: { id: '15142270000', accountEmail: 'affiliate@neezs.com' },
} as const satisfies Record<Workspace, { id: string; accountEmail: string }>
