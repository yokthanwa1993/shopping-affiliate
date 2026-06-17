# Full system modernization plan

Owner: Hermes Dev Lead (driving) + Claude Code (implementation)
Status: **Cutover LIVE** — `/dashboard/*` serves the React/Vite SPA in production
(deploy `2813b2cd-0901-4012-a920-fe9162fb0965`, live-smoked by Hermes). Backend
modernization via **Phase 8 (Hono)** incremental bridge slices is now complete:
8A customlink shorten ✅, 8B `/auth/*` passkey routing ✅, 8C `/worker-api/*` proxy
✅, 8D top-level dispatch unification ✅ (all bridge-only, not a router rewrite).
Phases 6/9/10 not started.
Scope: `apps/dashboard` (frontend + worker) and, later, `apps/video-affiliate/worker`

This is a practical, repo-specific roadmap toward the agreed target stack. Every
phase is **independently shippable**, preserves existing routes and legacy
behavior, and never big-bang rewrites production. New Cloudflare bindings
(Queues, Hyperdrive, Durable Objects, R2/KV) are introduced only in the phase
that needs them, with the binding config + migration as that phase's first step.

## Target stack

| Layer | Target | Status |
|-------|--------|--------|
| UI framework | **React + Vite** (replaces Astro + Svelte islands) | foundation built (Phase 2) |
| Routing | **TanStack Router** | in foundation |
| Server state | **TanStack Query** | in foundation |
| Tables | **TanStack Table** | in foundation |
| Styling | **Tailwind CSS** + **shadcn/ui** | in foundation |
| Forms | **React Hook Form + Zod** | in foundation |
| Charts | **Recharts / shadcn Charts** | Phase 7 |
| Hosting | **Cloudflare Workers Assets** (already in `wrangler.jsonc`) | live |
| API/backend | **Hono** on the worker | Phase 8 |
| Validation | **Zod** contracts shared FE/worker | Phase 6 |
| ORM | **Drizzle ORM** | Phase 6 |
| Database | **PostgreSQL + Hyperdrive** (today: D1) | Phase 9 |
| Storage/edge | **R2, KV, Durable Objects, Queues** | Phase 9 |
| Auth | **Cloudflare Access or Better Auth** (today: passkey/WebAuthn) | Phase 10 |

### Direction change (recorded 2026-06-14)

Earlier revisions of this plan kept the dashboard on Svelte ("do not rewrite to
React") and layered `@tanstack/svelte-query` on top. That decision is
**superseded**: the agreed target is a React/Vite stack. The migration is still
incremental and side-by-side — Astro/Svelte stays live until each page reaches
parity — but new dashboard UI is written in React, not Svelte. The data-layer,
Zod, Drizzle, Queues, and auth goals from the previous plan are retained below,
re-sequenced around the React migration.

---

## Phase 1 — page_posts cache-first read path ✅ (shipped)

`GET /api/dashboard/facebook-page-videos` reads the D1 cache tables but used to
enrich every item with per-item DB queries (post_history reel lookup,
namespace_video_state per shopee link, fuzzy gallery_index LIKE). At
`limit=100..500` that became hundreds of sequential D1 round trips and timed out.

**Done:**

1. Route is cache-first and read-only (no writes on GET; enforced by tests).
2. Per-item loops replaced with bulk/bounded enrichment, response shape
   unchanged: one bounded page-scoped `post_history` read (`LIMIT 5000`,
   newest-first, matched in memory); shopee-link resolution via chunked `IN`
   (40/chunk); exact-title `gallery_index` via chunked `IN`; fuzzy `LIKE`
   fallback hard-capped at `FUZZY_TEXT_LOOKUP_CAP = 60` with a truncation log.
3. `PagePostsPanel.svelte` surfaces `total`, last-sync time, and a "synced whole
   page" badge, with incremental `offset` pagination ("โหลดเพิ่ม").
4. `worker/test/tagged-page-sync.test.ts` asserts the bulk/bounded enrichment.

**Follow-ups (carried forward):**
- Add `(bot_id, page_id, posted_at)` index for the bounded `post_history` read
  if EXPLAIN shows a scan (needs a migration → confirm before shipping).
- Materialize `system_video_id` onto `facebook_page_video_cache` at sync time so
  the read path needs zero join-time enrichment (highest-leverage; removes the
  fuzzy path). → folds into Phase 6.

---

## Phase 2 — React/Vite side-by-side foundation 🚧 (this run)

Stand up the target stack as an isolated, independently-buildable app — **no**
changes to the Astro source, the worker, or the tracked `dist/`.

**Done:**
- New app `apps/dashboard/react-dashboard/` (own `package.json` + `.gitignore`;
  `node_modules`/`dist` ignored). Builds via its own `vite build` — never
  regenerates the Astro `dist/`.
- React 19 + Vite 7 + `@vitejs/plugin-react`, mirroring `apps/video-affiliate/webapp`
  versions (TypeScript ~5.9.3, Vite ^7.2.4).
- **TanStack Router** (code-based route tree, browser history, basepath derived
  from Vite `base = /dashboard_next/`), **TanStack Query** provider,
  **TanStack Table** demo.
- **Tailwind v3 + shadcn/ui** (new-york, neutral, lucide, HSL CSS-variable theme)
  matching the webapp; hand-written UI primitives (no Radix dep yet).
- Typed API clients with **Zod**: `src/api/pagePosts.ts`
  (`/api/dashboard/facebook-page-videos`) and `src/api/customLink.ts`
  (`/customlink-api/shorten`). `src/api/client.ts` mirrors the live
  `lib/api.ts` (`/worker-api` base, default `x-bot-id`, same-origin creds).
- Three routes: Overview, Page Posts (Query + Table), Custom Link (**RHF + Zod**).

> **Scope note (important for reviewers).** The repo was already dirty with
> prior, unrelated production work before this run started — `worker.ts`,
> several Astro pages/Svelte components, the tracked `apps/dashboard/dist/`,
> `apps/video-affiliate/*`, and `AGENTS.md`/`CLAUDE.md` all carried pre-existing
> uncommitted edits. **This run did not touch any of them.** The acceptance
> checks below are about *what this run added/changed*, not about the cleanliness
> of the whole working tree. (Confirm attribution via file mtimes, not raw
> `git status`, which shows cumulative dirty state with no per-session origin.)

**Acceptance checks (verified):**
- `cd apps/dashboard/react-dashboard && npm install` succeeds (161 pkgs, exit 0).
- `npm run typecheck` (`tsc --noEmit`, strict) passes (exit 0).
- `npm run build` (`tsc --noEmit && vite build`) produces `dist/` with assets
  emitted under `/dashboard_next/` (verified in built `index.html`).
- `vite preview` smoke: `GET /dashboard_next/` → 200, JS asset → 200, deep route
  `/dashboard_next/page-posts` → 200 via SPA fallback.
- **Files added/changed by this run are limited to**
  `apps/dashboard/react-dashboard/**` (new app, `node_modules`/`dist`
  gitignored) and this plan doc. No edits by this run to `worker.ts`, Astro
  source/config, the Astro `dist/`, `apps/video-affiliate/*`, or
  `apps/facebook-token-cloak/*`.

**Known risk — tracked Astro `dist/`.** `apps/dashboard/dist/` is committed to
git (no `.gitignore` entry), so any `astro build` rewrites hashed chunks and all
`index.html` files, producing a large dirty diff every rebuild. Phase 3 (which
runs `astro build`) must account for this; the cleanest fix is to `.gitignore`
`apps/dashboard/dist/` and stop tracking the Astro build output as part of the
Phase 3 change. (This run's React app already gitignores its own `dist/`.)

---

## Phase 3 — wire `/dashboard_next/` into the worker (first deployable preview) ✅ (implemented)

The React preview is served live behind the existing dashboard worker as an
authenticated preview, with **minimal, additive** worker changes (Hermes
GitNexus impact on the `fetch` handler: LOW).

**Done:**
- **Build/copy pipeline.** `apps/dashboard/scripts/build-dashboard-next.mjs`
  builds the preview (installing its deps if needed) and copies its output into
  `dist/dashboard_next/`. `package.json` now has `build: "astro build && npm run
  build:next"` (plus `build:astro` and `build:next`), so a normal build/deploy
  emits the Astro app and then the React preview under `dist/dashboard_next/`.
  `react-dashboard/dist` and `node_modules` stay gitignored.
- **Worker routing (additive only).** In `apps/dashboard/src/worker.ts`:
  - `'/dashboard_next/assets/'` added to `STATIC_PREFIXES` so hashed JS/CSS
    bypass auth like `/_astro/` (they also already match the file-extension
    rule).
  - `DASHBOARD_NEXT_PREFIX` + `isDashboardNextPath()` helper; a `dashboardNext`
    flag computed under the same `WWW_HOSTS` check as the canonical dashboard.
  - For `dashboardNext && !isStatic` GET/HEAD, the worker serves the **clean dir
    URL** `/dashboard_next/` from Assets (which resolves to
    `dist/dashboard_next/index.html` with 200) for the entry and every deep
    client route — TanStack Router resolves the path in the browser. (Fetching
    `…/index.html` directly was avoided: the Assets layer 307-redirects
    `*/index.html` → clean URL, which would loop deep routes back to the entry.)
- **Auth model.** `/dashboard_next/` and deep routes are non-static/non-auth, so
  the existing shared gate applies (session required once any credential exists),
  exactly like `/dashboard/*`. No auth code changed. The underscore prefix can
  never collide with the `/dashboard/*` canonicalization.
- **No `wrangler.jsonc` change** — `dist/dashboard_next/` is inside the existing
  `assets.directory: ./dist`, so it ships automatically.

**Acceptance checks (verified locally):**
- `npm --prefix apps/dashboard/react-dashboard run build` → exit 0.
- `npm --prefix apps/dashboard run build` → Astro 16 pages + copy into
  `dist/dashboard_next/` (index.html references `/dashboard_next/assets/*`,
  which exist).
- `wrangler deploy --dry-run` bundles the worker, exit 0 (62 asset files).
- `wrangler dev` smoke with `--host www.pubilo.com`:
  - `/dashboard_next/`, `/dashboard_next/page-posts`, `/dashboard_next/custom-link`,
    `/dashboard_next` → **200**, React shell, 0 redirects (deep routes serve the
    SPA, not the root Astro index).
  - `/dashboard_next/assets/index-*.js` → **200 text/javascript** (no login
    redirect).
  - Existing routes unchanged: `/dashboard/` → 200 "Campaigns · Ads Manager",
    `/dashboard/page_posts/` → 200 "โพสต์เพจ", `/` → 200 landing. On the legacy
    `dashboard.pubilo.com` host, `/dashboard/` still 301→ canonical www
    (idempotent — untouched).
- **Not committed/deployed.** Production deploy from an isolated worktree, with
  no secrets logged, remains a manual follow-up.

**Residual risk / follow-up.** Auth-gated behavior (login redirect when
credentials exist) was reasoned, not live-smoked, because local `wrangler dev`
D1 is empty (`credentialCount=0`); it shares the exact gate code as the canonical
dashboard. Tracked Astro `dist/` still produces large rebuild diffs (see the
Phase 2 risk note) — gitignoring `apps/dashboard/dist/` is recommended alongside
the production deploy.

---

## Phase 4 — port read-only pages to React (parity)

Move the read-heavy panels to React behind TanStack Query/Table, one at a time,
keeping the Svelte version live until each reaches parity.

- Order: Page Posts → Gallery → History → Source Inventory → Campaigns.
- Centralize `min_views`/`limit`/`offset`/date-range as URL state (TanStack
  Router search params) so filters are shareable.
- Reuse the Zod-typed clients from Phase 2; add one per endpoint as ported.

**Acceptance checks (per page):** visual + data parity vs the live Svelte panel
on the same inputs; pagination and empty/error states verified; no new worker
behavior; typecheck/build green.

### Phase 4A — Page Posts route 🚧 (this run; live Svelte route untouched)

`react-dashboard/src/routes/page-posts.tsx` brought toward parity with the live
`PagePostsPanel.svelte`, all client-side (no worker/Svelte/route change):

- **Offset pagination via `useInfiniteQuery`** — parity defaults `min_views=100000`,
  `limit=48`; “โหลดเพิ่ม (N คลิป)” accumulates batches with `getNextPageParam`
  (next offset = rows loaded, stop at `total`); pages flattened and **de-duped by
  `storyId||videoId`** like the Svelte panel; header shows “แสดง X จาก total คลิป”.
- **Sync metadata surfaced** — `data_source` badge, `fullyScanned` →
  “sync ครบทั้งเพจ” badge, `lastSyncedAt`, and `lastFullScanAt` when present.
- **Safe download action** (new TanStack Table column) — when `systemVideoId`
  exists, link to `/worker-api/api/gallery/{id}/asset/public?namespace_id=…&download=1&filename=…`
  (the `download=1` + path combo triggers the worker's `shouldForceAttachment`
  attachment streaming); else fall back to a validated `videoUrl` (http(s) or
  same-origin `/worker-api` only — `javascript:`/`data:` rejected); else disabled.
  Download helpers live in `src/api/pagePosts.ts` (`systemVideoDownloadUrl`,
  `externalVideoUrl`, `sanitizeDownloadFilename` mirroring the worker).
- **No auto-query on mount preserved** — the query only fires on “โหลด” (the
  preview intentionally avoids hitting the prod API/auth on load; the Svelte panel
  auto-loads, which is a deliberate divergence for the preview).
- Zod schemas stay tolerant (`.nullish()` + `.passthrough()`).

Verified: `npm --prefix apps/dashboard/react-dashboard run build` and
`npm --prefix apps/dashboard run build` green; `vite preview` smoke →
`/dashboard_next/` and `/dashboard_next/page-posts` both 200 (React shell);
new strings (“โหลดเพิ่ม”, “ดาวน์โหลด”, “สแกนเต็มล่าสุด”) confirmed in the bundle.
Not committed. Remaining 4A parity gaps (page switcher, thumbnails/card grid,
sync/refresh actions, "สร้างแอด" link) are deferred to keep this slice read-only.

> Build note: the React bundle is ~502 kB (just over Vite's 500 kB warn) —
> code-splitting (route-level dynamic import) is a Phase 4 cleanup, not a blocker.

### Phase 4 — visible route + navigation parity 🚧 (this run; live routes untouched)

All read-only panels now exist as React routes wired into the TanStack Router
tree (`router.tsx`): Overview, Gallery, Source Inventory (with `/inbox` +
`/source-processing` aliases), Processing, Page Posts (`/page_posts` alias),
Custom Link, Campaigns, Create Ads (honest *bridge* page — the multi-step write
flow is deferred), Queue, History, Settings. Deep links under `/dashboard_next/*`
resolve for every page (router basepath derived from Vite `base`; worker SPA
fallback from Phase 3).

This run closed the **navigation gap**: `AppShell` previously surfaced only 3 of
the routes in the sidebar (Overview / Page Posts / Custom Link), so the other
ported pages were reachable only by typing the URL. The sidebar now mirrors the
production Astro nav (`apps/dashboard/src/layouts/Layout.astro`) ordering — all
read-only routes plus a footer-pinned Settings — using lucide icons in the
existing React-preview style (no redesign). `<Link to>` is type-checked against
the route tree, so nav/router parity is enforced by `tsc`.

Verified: `npm --prefix apps/dashboard/react-dashboard run typecheck` / `run
build` and `npm --prefix apps/dashboard run build` (Astro + `build:next` copy
into `dist/dashboard_next/`) all exit 0; new nav strings present in the bundle.
Not committed/deployed. Remaining work toward 100% cutover: Create Ads write
flow (Phase 5), per-page visual/data parity sign-off vs the Svelte panels, and
the admin/login/www routes (not part of the main nav, gated separately).

## Cutover — production `/dashboard/*` → React SPA ✅ (LIVE)

The single worker flag `DASHBOARD_REACT_CUTOVER` (apps/dashboard/src/worker.ts)
is **on**: canonical `https://www.pubilo.com/dashboard/*` document routes serve
the React SPA shell from `dist/dashboard_next/`; the Astro/Svelte pages remain
shipped in the bundle, so flipping the flag back to `false` is an instant,
code-only rollback. The same build is also reachable under the `/dashboard_next/`
alias (used as the rollback/preview URL). Deploy + live smoke (dashboard,
gallery, page_posts, settings, custom-link, processing, queue, history; console
0) done by Hermes.

### Production-readiness pass (this run; `apps/dashboard/**` only)

Goal: make the live cutover *feel* production, not a dev preview, and close the
two known parity blockers — without changing any live worker behavior beyond the
create-ads unpin.

- **Preview/dev/read-only copy removed from the canonical UI.** Dropped all
  user-facing "React preview" / "พรีวิว" / "โหมด dev" / endpoint-name +
  "(read-only)" subtitles and the "read-only" badges across every route
  (Overview, Gallery, Source Inventory, Processing, Page Posts, Custom Link,
  Campaigns, Queue, History, Settings). Sidebar sublabel is now just
  "Dashboard"; the self-referential "เปิดแดชบอร์ดจริง" preview footer is gone.
  The `/dashboard` vs `/dashboard_next` mount badge stays (accurate, not preview
  wording). Route descriptions were rewritten as plain operator-facing copy.
- **Document title fixed.** `index.html` `<title>` `PUBILO Dashboard · React
  preview` → `PUBILO Dashboard` (+ `<meta name="robots" content="noindex">`).
- **Create Ads ported to React at parity → unpinned from Astro.** Audit finding:
  the Svelte `CreateAdsPanel.svelte` is **read-only** — it lists ready gallery
  clips + high-view page posts (GET `/api/dashboard/gallery`,
  `/api/dashboard/facebook-page-videos`) and copies a System Video ID to the
  clipboard; it never POSTs an ad-creation job (the enqueue happens from the Page
  Posts / Gallery actions and the external ad tool). So the earlier "multi-step
  WRITE flow" assumption was wrong. `react-dashboard/src/routes/create-ads.tsx`
  now ports that panel faithfully (view toggle, thumbnails, copy-ID, refresh)
  using the existing Zod-typed clients, and `ASTRO_PINNED_DASHBOARD_PATHS` is
  emptied so `/dashboard/create-ads` serves React under the cutover. The pin
  regex is documented inline for one-line rollback.
- **Settings save audited — no fix needed (parity confirmed).** React
  `canEdit = pageId === DEFAULT_EDITABLE_PAGE_ID` exactly mirrors Svelte
  `canEdit = selectedPage.id === DEFAULT_PAGE.id`: both edit **only** the default
  page (เฉียบ) and PUT the same `/api/dashboard/settings` contract; other pages
  are view-only in both (Svelte "ดูอย่างเดียว (Phase 1)"). React additionally
  disables Save on a pristine form (RHF `isDirty` + empty token guard) — stricter
  than Svelte (which allows a redundant no-op PUT), not a regression. React can
  save the editable primary page just like Astro. Reworded the non-default-page
  label and decluttered the header copy.

Checks (all exit 0): `npm --prefix apps/dashboard/react-dashboard run typecheck`;
`… run build`; `npm --prefix apps/dashboard run build` (Astro 16 pages +
`build:next` copy into `dist/dashboard_next/`); `wrangler deploy --dry-run`
(62 asset files). Not committed/deployed — Hermes deploys + live-smokes.

### Remaining frontend parity notes (non-blocking)

- **Page Posts does not auto-load on mount** (Svelte auto-loads). Kept the manual
  "โหลด" trigger this pass to avoid an unprompted prod API hit on navigation;
  revisit if operators expect data on landing.
- Other deferred 4A polish (page switcher, card/thumbnail grid on Page Posts,
  sync/refresh actions) tracked under Phase 4.
- React bundle ~552 kB (over Vite's 500 kB warn) — route-level code-splitting is
  a Phase 4 cleanup, not a blocker.
- admin/login/www routes are gated separately and not part of the main React nav.

## Phase 5 — forms & mutations in React (RHF + Zod)

- Port Custom Link and Settings to React Hook Form + Zod, with optimistic
  updates / TanStack Query invalidation.
- Preserve existing API contracts and the Phase-1 settings read/write semantics
  (snake_case on the wire); add round-trip tests before cutover.

**Acceptance checks:** create/update flows match the Svelte panels; validation
errors surfaced client-side; no contract drift (diff request/response payloads).

## Phase 6 — typed contracts (Zod) + Drizzle for D1 hot paths

- Promote the Phase-2 Zod schemas into a shared contract module consumed by both
  the React client and the worker (`/api/dashboard/*` first).
- Introduce **Drizzle ORM** for the hottest D1 paths
  (`facebook_page_video_cache`, `post_history`, `gallery_index`), migrating
  incrementally behind existing helpers.
- Land the Phase-1 follow-ups: `(bot_id, page_id, posted_at)` index and
  materialized `system_video_id` on the cache table (removes fuzzy enrichment).

**Acceptance checks:** worker tests stay green; `tsc --noEmit` on the worker;
response shapes byte-compatible with current clients; EXPLAIN confirms index use.

### Phase 6A — shared contract primitives + worker contract home ✅ (this run; safe slice)

First Phase 6 slice, scoped to be **deployable with zero runtime change**. Two
build-boundary discoveries shaped it:

1. **The two roots are isolated and had no cross-imports.** `apps/dashboard`
   (worker/Astro, `tsconfig include: ["src"]`) and
   `apps/dashboard/react-dashboard` (Vite, own `node_modules`, stricter tsconfig:
   `verbatimModuleSyntax`, `noUnusedLocals`) are separate build roots. Until now
   they only *mirrored* each other via comments — no file was imported across the
   boundary.
2. **Different zod majors.** The worker resolves **zod@4.4.3**; the React subapp
   resolves **zod@3.25.76**. A shared *zod-schema* module cross-imported by both
   would compile against two different zod majors — types and runtime would differ
   per root. **Sharing zod schemas FE↔worker is therefore unsafe in this pass.**

What shipped instead (genuinely shared, but zod-free):

- **New `apps/dashboard/src/shared/customlinkContract.ts`** — a dependency-FREE
  module that is the single source of truth for the customlink invariants that
  were duplicated by hand: the affiliate-id regex (`/^[a-zA-Z0-9_-]{3,80}$/`), the
  field length caps (account ≤ 80, sub ≤ 300), the `sub1..sub5` param keys, the
  built-in preset ids, the blocked account labels, and `AFFILIATE_PRESETS`. Plain
  TS constants have no zod dependency, so both roots import this file safely.
- **New `apps/dashboard/src/server/contracts.ts`** — promotes the worker's Zod
  request/success schemas out of `customlink.ts` into one worker-side contract
  home (zod@4), composed from the shared primitives. Shapes are **byte-identical**
  to the previous inline definitions.
- **`src/server/customlink.ts`** now imports both modules: the schemas from
  `./contracts`, the constants from `../shared/customlinkContract` (the `.has()`
  membership Sets are rebuilt from the shared id/label lists, preserving exact
  semantics). All client-facing error codes unchanged.
- **`react-dashboard/src/api/customLink.ts`** imports the shared regex + length
  caps for its `customLinkRequestSchema` (still zod@3, still localized Thai
  messages, `id` still optional — UI concerns kept local) and re-exports
  `AFFILIATE_PRESETS` from the shared module, so `routes/custom-link.tsx`'s import
  is unchanged. This is the **first cross-root import** in the dashboard, and it
  is deliberately zod-free.

**Behavior:** byte-compatible — same request/response shapes, status codes and
error codes. The regex source, caps and preset ids are value-identical to the
removed literals.

**Verified (all exit 0):** `npm --prefix apps/dashboard/react-dashboard run build`
(tsc strict + Vite — cross-root shared file bundled, 1929 modules);
`npm --prefix apps/dashboard run check` (astro check, 0 errors/warnings, 28
files); `npm --prefix apps/dashboard run build` (Astro 16 pages + `build:next`);
`wrangler deploy --dry-run` (all bindings intact). **Not committed/deployed** —
safe for Hermes to deploy.

**Phase 6 remaining (typed contracts).**
- Sharing the *zod schemas* (request/success) FE↔worker is blocked on the zod
  major skew. Two paths: (a) align the React subapp onto zod@4 (its own build
  +impact pass), then promote the schemas into a shared module; or (b) keep the
  mirror convention and only ever cross-share zod-free primitives like above.
  Recommend (a) before sharing `settings` / `pagePosts` / `gallery` schemas, since
  those are larger and more prone to drift.
- `auth` passkey verify contracts (`registerVerifyRequestSchema` /
  `loginVerifyRequestSchema`) live worker-side only (no React touchpoint —
  @simplewebauthn owns the browser shape), so there is nothing to share there yet;
  they can move into `src/server/contracts.ts` for consistency in a later slice.

**Drizzle / D1 feasibility note (Phase 6/9).** The actual D1 hot paths
(`facebook_page_video_cache`, `post_history`, `gallery_index`) and the
`(bot_id, page_id, posted_at)` index + materialized `system_video_id` follow-ups
live in **`apps/video-affiliate/worker/src/index.ts`**, NOT in the dashboard
worker — the dashboard only proxies `/worker-api/*` to `https://api.pubilo.com`.
So Drizzle ORM adoption, schema indexing and materialized-column migrations are a
**separate `apps/video-affiliate` worker phase**: a different deployable, with its
own bindings, D1 migrations (local + prod), dedicated GitNexus impact analysis and
the video-affiliate deploy skill. It is explicitly **out of scope** for any
dashboard-only pass and must not be attempted from `apps/dashboard`. No Drizzle
work, bindings or migrations were introduced in this slice.

## Phase 7 — charts

- Add **Recharts / shadcn Charts** for the Overview and conversion summaries
  (spend/clicks/orders/commission), fed by existing read APIs.

**Acceptance checks:** numbers match the source endpoints; no new write paths.

## Phase 8 — Hono on the worker

- Refactor `apps/dashboard/src/worker.ts` routing onto **Hono** (router,
  middleware for auth/bot-scoping, typed handlers) without changing external
  behavior or routes. Keep Workers Assets + `run_worker_first`.

**Acceptance checks:** every current path (`/auth/*`, `/customlink-api/*`,
`/worker-api/*`, `/dashboard/*`, `/login`, legacy `/chearb/*`) behaves
identically; auth gating preserved; dry-run + smoke.

### Phase 8A — first Hono + Zod slice: customlink shorten ✅ (this run; bridge only)

First incremental step, deliberately **not** a big-bang router rewrite. The raw
`fetch` handler still owns host routing, redirects, the auth gate and asset
serving; only the `customlink shorten` API moved behind Hono + Zod.

- Added `hono` + `zod` to `apps/dashboard/package.json` (zod already resolved in
  the lockfile via the React subapp; `hono@4` newly installed).
- New `src/server/customlink.ts`: a `Hono` app exposing one canonical route
  (`POST /shorten`, with a `405 + Allow: POST` fallback for other methods) plus
  the **Zod contracts** — `customlinkShortenRequestSchema` (mirrors
  `react-dashboard/src/api/customLink.ts`) and `customlinkShortenSuccessSchema`
  (parsed before returning). The upstream proxy logic and every client-facing
  error code (`invalid_json`, `url_required`, `invalid_url`,
  `invalid_url_protocol`, `invalid_affiliate_id`, `manual_login_required`, …)
  are preserved 1:1 from the previous inline handler.
- New `src/server/http.ts`: tiny dependency-free helpers (`jsonResponse`,
  `isRecord`, `safeString`, `pickString`) shared by `worker.ts` and the Hono app.
- `worker.ts` bridges all three public aliases (`/customlink-api/shorten`,
  `/dashboard/api/custom-link/shorten`, ±trailing slash) onto the Hono app's
  `/shorten` route via `customlinkApp.fetch(...)`, preserving method + body.

**Verified:** `npm run build` (Astro + React subapp `tsc`) ✓; `astro check` shows
no new errors in the changed files (6 pre-existing `D1Database` errors in the
untouched `auth.ts` remain); `wrangler deploy --dry-run` bundles Hono + Zod ✓.
SPA serving, `/dashboard_next` rollback alias, `/dashboard/page-posts` redirect
and `dashboard.pubilo.com` legacy redirects untouched. **Not deployed** — Hermes
deploys after verification.

**Follow-up:** migrate `/worker-api/*` proxy and `/auth/*` onto Hono next
(separate slices), then unify the top-level dispatch — same bridge pattern, one
route family at a time.

### Phase 8B — second Hono + Zod slice: `/auth/*` passkey routing ✅ (this run; bridge only)

Next incremental step, again **not** a router rewrite. The raw `fetch` handler
still owns host routing, redirects, the shared auth gate and asset serving; only
the `/auth/*` route family moved behind Hono, with Zod gates on the verify
endpoints. Behavior is preserved 1:1 from the previous `dispatchAuth` if-chain.

- **New `authApp` Hono app in `src/server/auth.ts`** (`new Hono<{ Bindings:
  AuthEnv }>()`) registering the six real routes at their full paths with exact
  methods: `GET /auth/session/me`, `POST /auth/passkey/register/options`,
  `…/register/verify`, `…/login/options`, `…/login/verify`, `POST /auth/logout`.
  A `withSchema()` wrapper runs `ensureSchema(c.env)` before each matched route
  with the **identical `503 schema_unavailable` fallback**, then delegates to the
  existing handler via `handler(c.env, c.req.raw)` — handler bodies unchanged, so
  the passkey clients see no difference. `authApp.notFound()` returns the same
  `not found` 404 for an unknown `/auth/*` path or wrong method. As before,
  `ensureSchema` does **not** run for unmatched paths (only the six routes).
- **Zod contracts** `registerVerifyRequestSchema` / `loginVerifyRequestSchema`
  (`{ challengeId: string().min(1), response: record(...) }`) added as **formal
  contract gates** inside `handleRegisterVerify` / `handleLoginVerify`, right
  after the existing presence checks — same stable `invalid_request` 400 code,
  mirroring the customlink slice's "formal gate behind the granular checks"
  pattern. `response` is an open record because its shape is owned by
  @simplewebauthn and is verified cryptographically by the verify call anyway.
- **`worker.ts` bridge.** The early `/auth/*` block now does
  `return authApp.fetch(request, env)` instead of `await dispatchAuth(...)` +
  manual 404. `dispatchAuth` is **retained** (now unused by the worker) as a
  one-line rollback path.

**Verified (all exit 0):** `npm --prefix apps/dashboard run check` (astro check,
0 errors/warnings — incl. `auth.ts`/`worker.ts`); `npm --prefix apps/dashboard
run build` (Astro 16 pages + `build:next` copy into `dist/dashboard_next/`);
`wrangler deploy --dry-run` (62 asset files, Hono auth app bundled, all bindings
intact). GitNexus impact on `handleRegisterVerify`/`handleLoginVerify`: **LOW**
(direct caller `dispatchAuth`→`fetch` only). Source diff confined to
`apps/dashboard/src/server/auth.ts` + `apps/dashboard/src/worker.ts`. **Not
committed/deployed** — Hermes deploys + live-smokes the passkey login/session
flow.

**Follow-up:** migrate the `/worker-api/*` proxy onto Hono (last route family),
then unify the top-level dispatch (host routing + the shared auth gate as Hono
middleware) — completing Phase 8.

### Phase 8C — third Hono slice: `/worker-api/*` proxy ✅ (this run; bridge only)

Last route family before the top-level dispatch unification, again **not** a
router rewrite. The raw `fetch` handler still owns host routing, redirects,
dashboard canonicalization, the shared auth gate and asset serving, and still
decides `isWorkerApi` before delegating; only the proxy body moved behind Hono.
Behavior is preserved 1:1 from the previous inline `/worker-api` block.

- **New `workerApiApp` Hono app in `src/server/workerapi.ts`** (`new Hono()`)
  registering one wildcard route `app.all('/worker-api/*', …)`. The proxy
  constant `API_ORIGIN` (`https://api.pubilo.com`, value unchanged) and the
  attachment helpers `shouldForceAttachment` / `sanitizeDownloadFilename` moved
  out of `worker.ts` into this slice. The handler preserves every behavior point:
  - maps `/worker-api/<path>?query` → `https://api.pubilo.com/<path>?query`;
  - on `/worker-api/api/gallery/:id/asset/original` (or `/public`) with
    `?download=1`, strips `download` + `filename` before upstream, then copies the
    upstream response with a sanitized `Content-Disposition` attachment filename,
    `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`;
  - returns every other upstream response unchanged;
  - forwards method + headers, deletes `host`, sets `x-forwarded-host` /
    `x-forwarded-proto`; passes the body for non-GET/HEAD, none for GET/HEAD.
- **`worker.ts` bridge.** The `isWorkerApi` block now does
  `return workerApiApp.fetch(request, env)`, delegating the original request
  (its `/worker-api/*` public path, method and body) unchanged — so Hono matches
  the same public path with no rewrite (unlike the customlink slice).

**Verified (all exit 0):** `npm --prefix apps/dashboard run check` (astro check,
0 errors/warnings); `npm --prefix apps/dashboard run build` (Astro 16 pages +
`build:next` copy into `dist/dashboard_next/`); `wrangler deploy --dry-run` (62
asset files, Hono worker-api app bundled, all bindings intact). GitNexus impact
on the `worker.ts` fetch handler: **LOW**. Source diff confined to
`apps/dashboard/src/worker.ts` + the new `apps/dashboard/src/server/workerapi.ts`.
**Not committed/deployed** — Hermes deploys + live-smokes the proxy + download
attachment flow.

**Regression + fix (pass 2 live smoke).** Prod `b0038d58…` proxied normal JSON
routes fine, but the gallery **download attachment** lost its
`Content-Disposition` + `X-Content-Type-Options: nosniff` headers (only upstream's
own `cache-control: no-store` survived). Root cause: `shouldForceAttachment()`
required the `/worker-api` prefix in its regex, but at detection time in the
worker runtime the path arrived **without** the prefix, so detection returned
false — while the upstream target map still worked because its
`.replace(/^\/worker-api/, '')` is a no-op on the already-stripped shape. Fix
(in `workerapi.ts` only): a single `workerApiUpstreamPath()` strips an *optional*
`/worker-api` prefix, and **both** attachment detection and the target map derive
from it, so they can never disagree and both path shapes
(`/worker-api/api/gallery/…` and `/api/gallery/…`) are handled. All original
true/false cases preserved (verified via a path-matrix unit check); re-ran
check + build + dry-run (all exit 0). Not deployed — Hermes re-smokes.

**Follow-up:** unify the top-level dispatch (host routing + the shared auth gate
as Hono middleware) — completing Phase 8.

### Phase 8D — top-level dispatch unification ✅ (this run; safe bridge)

Final Phase 8 step: the worker's entry point is now a top-level
`Hono<{ Bindings: Env }>` app instead of a raw `export default { fetch }` object.
Deliberately a **safe bridge, not a route-table rewrite** — the entire existing
control flow is preserved verbatim, so external behavior is unchanged.

- **`worker.ts`.** The previous raw `fetch` handler body is moved unchanged into a
  named `async function dispatch(request, env)`. A top-level `const app = new
  Hono<{ Bindings: Env }>()` registers a single catch-all `app.all('*', (c) =>
  dispatch(c.req.raw, c.env))`, and the module now does `export default app`.
  `c.req.raw` is the original, unmodified `Request`, so `new URL(request.url)`,
  the body stream, headers and method all behave exactly as before; `c.env`
  carries the typed Workers bindings. No new module was added (router logic stays
  in `worker.ts`); `http.ts` / `auth.ts` / `customlink.ts` / `workerapi.ts` were
  not touched.
- **Why a catch-all rather than per-route Hono handlers.** The dispatch order is
  load-bearing (apex/legacy host redirects → dashboard canonicalization + cutover
  → `/auth/*` bridge → legacy dashboard-host redirect → shared auth gate →
  customlink/worker-api bridges → SPA shells → host landing rewrites → asset
  serving), and several decisions mutate/derive from `url` before the auth gate.
  Funnelling everything through `dispatch` keeps that order byte-for-byte; a route
  table would risk reordering. Per-route middleware can now attach incrementally
  on top of this app without another rewrite.
- **Rollback.** One-liner: replace `export default app` with
  `export default { fetch: dispatch }` to restore the plain Workers handler. All
  existing rollback levers (`DASHBOARD_REACT_CUTOVER`, `ASTRO_PINNED_DASHBOARD_PATHS`,
  the retained `dispatchAuth`) are untouched.

**Behavior intentionally unchanged:** apex `pubilo.com`/`oomnn.com` → `www`;
legacy oomnn dashboard/admin → pubilo; `dashboard.pubilo.com` legacy host +
`/chearb/*`; `/dashboard/page-posts/` → `/dashboard/page_posts/`; `/dashboard/*`
canonicalization + React cutover; `/dashboard_next/*` preview; static-asset
bypass; `authApp` for `/auth/*`; the shared auth gate (credentialCount /
loadSession, 401 JSON for worker/customlink APIs, login redirect for GET HTML
docs, 401 text otherwise); customlink + `/worker-api/*` bridges; host landing
rewrites; final `env.ASSETS.fetch`.

**Verified (all exit 0):** `npm --prefix apps/dashboard run check` (astro check,
0 errors/warnings); `npm --prefix apps/dashboard run build` (Astro 16 pages +
`build:next` copy); `wrangler deploy --dry-run` (62 asset files, `export default
app` Hono worker bundled, all bindings intact). A standalone probe confirmed the
catch-all preserves raw URL/pathname/search, method, the unconsumed body stream,
headers and `c.env` across apex/dashboard/customlink/worker-api/auth shapes.
Source diff confined to `apps/dashboard/src/worker.ts`. **Not committed/deployed**
— Hermes deploys + live-smokes. Phase 8 (Hono on the worker) is now complete.

## Phase 9 — data platform & background sync

- Move `/sync`, `/auto-sync`, `/full-resync`, `/refresh-all-views` off
  request-time onto **Cloudflare Queues / Durable Objects** so Facebook scans run
  in the background and the dashboard only ever reads cache. **Requires new
  bindings** — add binding config + migration as step one.
- Introduce **PostgreSQL + Hyperdrive** for relational/reporting workloads where
  D1 is a poor fit; keep D1 for edge-hot reads during transition. **R2** for
  media/exports, **KV** for config/feature flags.

**Acceptance checks:** page_posts becomes 100% cache-served (Facebook touched
only by scheduled/queued sync, never by a user GET); queue depth/retry metrics
observable; rollback path documented.

## Phase 10 — auth hardening

- Evaluate **Cloudflare Access** vs **Better Auth** to replace/augment the
  current passkey/WebAuthn flow; audit `requireAuthSession` across
  `/api/dashboard/*`; rate-limit sync endpoints; rotate long-lived tokens out of
  request paths. No secrets in repo/wiki; document the auth model in `AGENTS.md`.

**Acceptance checks:** every mutating route guarded; session/token handling
standardized; auth model documented.

---

## Cutover & decommission

**The cutover flip has shipped** — `DASHBOARD_REACT_CUTOVER = true` serves the
React build at `/dashboard/*`, and `ASTRO_PINNED_DASHBOARD_PATHS` is now empty
(no page falls back to Astro). The Astro/Svelte source + committed `dist/` are
deliberately **retained** as the rollback path: set the flag to `false` (or
re-add a path regex) to instantly restore Astro for all or one route. Decommission
(deleting the Astro pages/components and their `dist/` artifacts) is a later,
dedicated, reviewed change — only after a full production soak, and is gated on:
no rollback needed for N days, the Page Posts auto-load + remaining 4A polish
landed, and the committed `apps/dashboard/dist/` rebuild-diff noise resolved
(recommended: `.gitignore` the Astro `dist/` and build on deploy).

## Next phases (backend modernization — not started)

Sequencing after the frontend cutover. Each remains independently shippable and
introduces new Cloudflare bindings only in the phase that needs them.

1. **Phase 6 — Hono + Zod typed contracts.** Phase 8 (Hono) is done. Phase 6A
   (this run) promoted the customlink invariants into a shared zod-FREE module
   imported by both roots, and the worker's zod schemas into `src/server/
   contracts.ts` — see "Phase 6A" above. Remaining: sharing the *zod schemas*
   themselves (`pagePosts`, `customLink`, `settings`, …) is blocked on the
   worker(zod@4)/React(zod@3) major skew; align the React subapp to zod@4 first,
   then promote schemas into the shared module. Phase 8 (Hono) already landed:
   refactor
   `apps/dashboard/src/worker.ts`'s hand-rolled routing onto Hono (router +
   auth/bot-scoping middleware + typed handlers) with byte-identical external
   behavior on every existing path. Keep Workers Assets + `run_worker_first`.
2. **Phase 6/9 — Drizzle ORM on D1.** Introduce Drizzle for the hottest D1 paths
   (`facebook_page_video_cache`, `post_history`, `gallery_index`) behind existing
   helpers; land the Phase-1 follow-ups (`(bot_id, page_id, posted_at)` index;
   materialize `system_video_id` onto the cache table to delete the fuzzy
   enrichment path). Response shapes stay byte-compatible; EXPLAIN must confirm
   index use.
3. **Phase 9 — data platform & background sync, bindings only where justified.**
   Move `/sync`, `/auto-sync`, `/full-resync`, `/refresh-all-views` off
   request-time onto **Queues** (and a **Durable Object** only if a single-writer
   coordinator is genuinely needed) so Facebook scans run in the background and
   page_posts becomes 100% cache-served. Add **R2** for media/exports and **KV**
   for config/feature flags *when a concrete need appears* — not preemptively.
   Evaluate **PostgreSQL + Hyperdrive** only for relational/reporting workloads
   where D1 is a poor fit; keep D1 for edge-hot reads. **Workflows** only if a
   multi-step durable sync pipeline outgrows a plain queue consumer. Each binding
   lands with its config + migration as step one, and a documented rollback.
4. **Phase 10 — auth hardening.** Cloudflare Access vs Better Auth to
   replace/augment passkey/WebAuthn; audit `requireAuthSession` across
   `/api/dashboard/*`; rate-limit sync endpoints; keep long-lived tokens out of
   request paths. Document the auth model in `AGENTS.md`. No secrets in repo/wiki.

## Invariants (all phases)

- No big-bang rewrite; Astro/Svelte stays live until per-page parity is proven.
- No commits/pushes without explicit request; never overwrite unrelated dirty
  work (esp. `apps/video-affiliate/*`, deleted `apps/facebook-token-cloak/*`).
- Never expose/log secrets/tokens/cookies/passwords/connection strings.
- Existing live routes keep working: `/dashboard/`, `/dashboard/page_posts/`,
  `/dashboard/custom-link/`, `/dashboard/gallery/`, `/dashboard/settings/`, and
  legacy redirects.
- Run GitNexus impact before editing worker symbols; `detect_changes` before any
  commit.
