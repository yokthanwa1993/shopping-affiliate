# Dashboard Settings Migration Implementation Plan

> **For Hermes:** Use Dev Lead delegation. Implement code work via Claude Code/Codex in inspectable sessions; Dev verifies diff/tests/build/live smoke before reporting done.

**Goal:** Move operational settings currently buried in the LINE/Telegram Mini App settings tab into the main web Dashboard, while keeping Mini App behavior working until dashboard parity is proven.

**Architecture:** Side-by-side migration. Dashboard becomes the primary operator surface for settings, backed by the existing video-affiliate Worker APIs and D1/R2 settings stores. Mini App settings remain as fallback/read-only/legacy until each section has parity and verification evidence.

**Tech Stack:** `apps/dashboard` Astro + Svelte, `apps/video-affiliate/worker` Cloudflare Worker APIs/D1/R2, `apps/video-affiliate/webapp` React Mini App legacy settings.

---

## Current inventory

### Existing Mini App settings source

Main file:
- `apps/video-affiliate/webapp/src/App.tsx`

Detected settings sections:
- `account`
- `pages`
- `team`
- `gemini`
- `shortlink`
- `post`
- `voice`
- `cover`
- `comment`
- `members`
- `monitor`
- `ads`

Related Mini App route:
- `apps/video-affiliate/webapp/src/routes/settings.tsx`

### Existing Dashboard settings surface

Main files:
- `apps/dashboard/src/components/SettingsPanel.svelte`
- `apps/dashboard/src/pages/settings.astro`
- `apps/dashboard/src/lib/api.ts`

Current dashboard limitation:
- Settings page is hard-coded to page `1008898512617594` / `เฉียบ`.
- It currently covers only a partial set: shortlink/comment/ad defaults/facebook sync token.
- It is not yet a full replacement for Mini App settings.

### Worker API anchors found

- `/api/dashboard/settings` GET/PUT
- `/api/settings/voice-prompt` GET/PUT/DELETE
- `/api/settings/voice-preview` POST
- `/api/settings/comment-template` GET/PUT/DELETE
- `/api/settings/comment-token` GET/PUT/DELETE
- `/api/settings/cover-template` GET/PUT
- `/api/settings/posting-order` GET/PUT
- `/api/settings/gemini-key` GET/PUT/DELETE
- `/api/settings/gemini-key-health` GET
- `/api/settings/gemini-key/check` POST
- `/api/settings/shopee-shortlink` GET/PUT/DELETE
- `/api/settings/shopee-shortlink/requirement` PUT
- `/api/settings/shopee-shortlink/processing-requirement` PUT
- `/api/pages/:id/posting-order-settings` GET/PUT

---

## Non-negotiable rules

1. Do not remove Mini App settings until the matching Dashboard section has verified parity.
2. Do not expose raw tokens/secrets in dashboard reads. Use masked values and write-only fields for secrets.
3. Keep old API contracts stable unless a new dashboard-safe endpoint is added side-by-side.
4. Every moved section needs:
   - read parity
   - save parity
   - validation parity
   - build/test evidence
   - one live smoke against production/staging-safe endpoint where practical
5. Dashboard must support page/workspace selection. No more hard-coded one-page settings as final state.
6. Large implementation work should be delegated to Claude Code/Codex; Dev verifies.

---

## Phase 0 — Discovery and contract map

**Objective:** Make the migration safe by mapping every settings section to its API, data store, auth rule, and risk level.

**Files to inspect:**
- `apps/video-affiliate/webapp/src/App.tsx`
- `apps/dashboard/src/components/SettingsPanel.svelte`
- `apps/video-affiliate/worker/src/index.ts`
- `apps/video-affiliate/worker/src/avatar-settings.ts`
- `apps/video-affiliate/worker/src/comment-template.ts`
- `apps/video-affiliate/worker/src/shortlink-template.ts`
- `apps/video-affiliate/worker/src/pipeline.ts`

**Deliverable:** A migration matrix with columns:
- Section
- Existing Mini App UI location
- Existing Worker endpoint(s)
- Data store key/table
- Auth required
- Secret exposure risk
- Dashboard target component
- Verification command/smoke

**Verification:**
- `git status --short`
- no production code changes in this phase
- matrix reviewed before Phase 1 implementation

---

## Phase 1 — Dashboard settings foundation

**Objective:** Convert Dashboard settings from single hard-coded page to real multi-page/workspace settings shell.

**Tasks:**
1. Add shared dashboard settings API client module.
2. Add page/workspace selector using a safe redacted pages endpoint.
3. Split `SettingsPanel.svelte` into shell + section components.
4. Add loading/error/saved state standard pattern.
5. Add route-level guard so dashboard settings requires authenticated operator session.

**Likely files:**
- Modify: `apps/dashboard/src/components/SettingsPanel.svelte`
- Create: `apps/dashboard/src/components/settings/SettingsShell.svelte`
- Create: `apps/dashboard/src/components/settings/PageSelector.svelte`
- Create: `apps/dashboard/src/lib/settingsApi.ts`
- Modify: `apps/dashboard/src/pages/settings.astro`
- Possibly add Worker endpoint: dashboard-safe page list with token hints only

**Tests/build:**
- `npm --prefix apps/dashboard run check`
- `npm run build:dashboard`
- worker tests if adding endpoint: `npm --prefix apps/video-affiliate/worker test`

**Live smoke:**
- Dashboard settings loads page list without raw tokens.
- Switching page changes fetched settings.
- Existing Mini App settings still loads.

---

## Phase 2 — Low-risk settings migration

**Objective:** Move non-secret/content settings first.

**Sections:**
1. Comment template
2. Cover template/style
3. Voice prompt/profile + preview
4. Posting order
5. Shopee shortlink non-secret config/requirements

**Expected components:**
- `CommentTemplateSettings.svelte`
- `CoverSettings.svelte`
- `VoiceSettings.svelte`
- `PostingOrderSettings.svelte`
- `ShortlinkSettings.svelte`

**Verification:**
- Save in Dashboard, reload Dashboard, values persist.
- Mini App reads the same saved value.
- Processing/posting flow still reads same Worker settings.
- `npm --prefix apps/dashboard run check`
- `npm run build:dashboard`
- `npm --prefix apps/video-affiliate/worker test` if endpoint behavior changes.

---

## Phase 3 — Operational/high-risk settings migration

**Objective:** Move sensitive or production-critical settings with write-only/masked handling.

**Sections:**
1. Gemini API keys + health/check
2. Facebook comment token
3. Facebook sync token
4. Pages/token pool/page ownership diagnostics
5. Team/members/admin access

**Rules:**
- Reads return only `present`, `masked`, `updated_at`, `health`, `last_error`.
- Writes accept new secret but never echo it.
- Delete/rotate actions require explicit button state and confirmation copy.
- UI must not store secrets in localStorage.
- Logs must redact tokens.

**Verification:**
- Secret endpoint response scan: no raw token values.
- Save/rotate smoke with dummy/safe value where possible.
- Health/check endpoint returns status without leaking secret.
- Worker tests include source assertions for redaction.

---

## Phase 4 — Monitoring/ops settings and repair console

**Objective:** Move operator monitoring out of Mini App into Dashboard.

**Sections:**
- Posting monitor
- Comment issue monitor
- Cron runtime state
- Failed/pending post-history rows
- Retry/repair actions with safe guards

**Rules:**
- Read-only first.
- Mutating repair buttons disabled by default and scoped to selected rows.
- No blanket retries.
- Show `comment_status`, `comment_error`, `fb_post_id`, page, posted time.

**Verification:**
- Monitor page matches Worker `/api` counts.
- No raw tokens returned.
- Dry-run repair mode before write mode.

---

## Phase 5 — Mini App cleanup / handoff

**Objective:** Remove clutter from Mini App only after Dashboard parity.

**Approach:**
- Keep Mini App settings tab as a minimal link/status page first.
- Add Dashboard deep link from Mini App settings.
- Hide migrated sections behind a feature flag, not hard delete.
- After 1–2 production cycles with no regressions, remove migrated UI code.

**Verification:**
- Mini App build passes.
- Dashboard build passes.
- User can still recover settings from Mini App fallback until final cutover.

---

## Execution model

Use small PR/commit units:
1. Plan/matrix only.
2. Dashboard shell + page selector.
3. Low-risk section 1–2 at a time.
4. Secret settings one at a time.
5. Monitor/repair console.
6. Mini App fallback cleanup.

Implementation agents:
- Use Claude Code for new dashboard components/greenfield UI.
- Use Codex for modifying existing Worker/Mini App logic.
- Dev Lead verifies every diff/test/build/smoke before reporting done.

---

## Immediate next step

Create the Phase 0 migration matrix from actual source and then delegate Phase 1 dashboard shell implementation.

---

## Implementation notes

### Phase 1 — implemented (2026-06-12)

- No new Worker endpoint was needed: existing `GET /api/dashboard/facebook-page-sources?namespace_id=...` already returns a redacted page list (`id/name/iconUrl/active/hasToken`, never raw tokens) and now backs the page selector.
- New adapter `apps/dashboard/src/lib/settingsApi.ts` — all settings UI traffic goes through it (page list, page-scoped `GET/PUT /api/dashboard/settings`). Static safe fallback to the default page when the page list is unreachable.
- `SettingsPanel.svelte` is now a thin wrapper around `settings/SettingsShell.svelte`; sections split into `ShortlinkCommentSection.svelte` + `AdsSchedulingSection.svelte`, plus `PageSelector.svelte`.
- Editing remains scoped to the default page (เฉียบ) — identical write behavior to the old panel. Other pages are read-only parity with the Facebook sync token value never rendered (status `present/updated_at` only). Save parity for all pages is Phase 2/3 work.
- Route guard already satisfied: dashboard worker entry (`src/worker.ts`) gates all pages and the `/worker-api` proxy behind the passkey session.
- Mini App settings untouched (`apps/video-affiliate/webapp/**` unchanged).
