# PUBILO Dashboard — React/Vite preview (`dashboard-next`)

Side-by-side **foundation** for migrating the PUBILO dashboard to the target stack
(React + Vite + TanStack + Tailwind + shadcn/ui + React Hook Form + Zod).

It started as an independently buildable Phase 2 app, and Phase 3 now wires the
build into the existing Cloudflare Worker as an authenticated preview at
`/dashboard_next/`. The current production dashboard remains Astro/Svelte until
page-by-page parity is proven.

This is the Phase 2/3 foundation from `docs/plans/full-system-modernization.md` —
prove the target stack side-by-side, keep everything else live, then flip pages
one at a time after parity.

## Layout

```
react-dashboard/
  src/
    api/         Zod-typed API clients (pagePosts.ts, customLink.ts) + fetch helper
    components/  AppShell + shadcn-style UI primitives (ui/)
    lib/         cn(), queryClient, formatting helpers
    routes/      overview / page-posts / custom-link (code-based TanStack Router)
    router.tsx   route tree + router (basepath derived from Vite base)
    main.tsx     QueryClientProvider + RouterProvider mount
```

## Develop

```bash
cd apps/dashboard/react-dashboard
npm install
npm run dev        # http://localhost:5174/dashboard_next/
```

Dev proxies mirror the live topology (both overridable via env so you never hit
prod by accident):

| Path | Proxied to | Override env |
|------|-----------|--------------|
| `/worker-api/*` | `https://api.pubilo.com` (video-affiliate worker — read APIs) | `DASHBOARD_WORKER_API` |
| `/customlink-api/*` | `https://www.pubilo.com` (dashboard worker — Shopee shortlink) | `DASHBOARD_CUSTOMLINK_API` |

> The `/api/dashboard/facebook-page-videos` read needs a dashboard session
> cookie; in dev without login it may return 401/empty — the UI handles that.
> The custom-link form **does** POST to the real worker when submitted, so only
> submit when you intend to mint a link.

## Verify

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run build       # tsc --noEmit && vite build  → dist/ (gitignored here)
npm run preview     # serve the production build at /dashboard_next/
```

## Live worker wiring (Phase 3)

The build emits assets under `base: '/dashboard_next/'`, and `apps/dashboard`
now runs `astro build && npm run build:next`. The `build:next` script builds this
React app, then copies `react-dashboard/dist/` into `apps/dashboard/dist/dashboard_next/`
so a normal `wrangler deploy` ships both apps.

Current worker behavior:

- `run_worker_first: true` means the worker runs for every request, including
  static assets.
- `/dashboard_next/assets/*` is whitelisted as static so hashed React assets load
  directly.
- document/deep routes under `/dashboard_next/*` fall back to
  `dist/dashboard_next/index.html`, allowing TanStack Router browser-history
  routes such as `/dashboard_next/page-posts`.
- the preview shell is gated by the same session path as the live dashboard; local
  `wrangler dev` with an empty D1 may not exercise that gate fully.

Until the React pages reach parity, the live `/dashboard/*` routes remain the
Astro/Svelte dashboard.

## Page Posts route (Phase 4A)

`/dashboard_next/page-posts` is being brought toward parity with the live Svelte
`PagePostsPanel` (the live `/dashboard/page_posts/` route is untouched):

- TanStack Query **`useInfiniteQuery`** offset pagination (defaults
  `min_views=100000`, `limit=48`) with a “โหลดเพิ่ม” button; pages are flattened
  and de-duped by `storyId||videoId`; header shows “แสดง X จาก total คลิป”.
- Sync metadata: `data_source` badge, `fullyScanned` badge, `lastSyncedAt` /
  `lastFullScanAt`.
- Safe download action: `systemVideoId` →
  `/worker-api/api/gallery/{id}/asset/public?...&download=1&filename=...` (worker
  forces attachment), else a validated `videoUrl` (http(s) or `/worker-api` only).
- No auto-query on mount — the read fires only on “โหลด”.

## Conventions mirrored from the repo

- `src/api/client.ts` mirrors `apps/dashboard/src/lib/api.ts`: `/worker-api`
  base, default `x-bot-id` namespace header, same-origin credentials.
- Tailwind v3 + shadcn/ui (new-york, neutral, lucide) and the HSL CSS-variable
  theme match `apps/video-affiliate/webapp` (the in-repo React reference).
- No Radix dependency yet — UI primitives are hand-written shadcn-style; run the
  shadcn CLI later (`components.json` is configured) when more are needed.
