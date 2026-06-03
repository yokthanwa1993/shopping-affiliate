# Dashboard V3 (apps/dashboard)

Operator console for PUBILO affiliate automation. Live at https://dashboard.pubilo.com

## Stack

- **Astro 6** (static output → `./dist/`)
- **Svelte 5 islands** via `@astrojs/svelte` for interactive data panels
- **Tailwind CSS v4** via `@tailwindcss/vite` (CSS-first config in `src/styles/global.css`)
- **TypeScript** (Astro `strict` tsconfig)
- **Cloudflare Worker Static Assets** (`src/worker.ts`) — handles domain routing, `/chearb` legacy redirects, and the `/worker-api/*` reverse proxy to `api.pubilo.com`

No React runtime in the V3 build.

## Routes

| Host                   | Path                       | Behavior                                                |
|------------------------|----------------------------|---------------------------------------------------------|
| dashboard.pubilo.com   | `/`                        | V3 overview (cards + API status)                        |
| dashboard.pubilo.com   | `/gallery`                 | Gallery cards (ready videos)                            |
| dashboard.pubilo.com   | `/source-inventory`        | Source inventory — page posts                           |
| dashboard.pubilo.com   | `/inbox`                   | Inbox — original clips                                  |
| dashboard.pubilo.com   | `/source-processing`       | Source processing pipeline                              |
| dashboard.pubilo.com   | `/campaigns`               | Campaigns list                                          |
| dashboard.pubilo.com   | `/create-ads`              | Create ads workflow                                     |
| dashboard.pubilo.com   | `/processing`              | Ad queue (active/failed/completed)                      |
| dashboard.pubilo.com   | `/history`                 | History log                                             |
| dashboard.pubilo.com   | `/settings`                | Settings                                                |
| dashboard.pubilo.com   | `/chearb`                  | 301 → `/` (legacy)                                      |
| dashboard.pubilo.com   | `/chearb/processing`       | 301 → `/processing` (legacy)                            |
| dashboard.pubilo.com   | `/chearb/source-inventory` | 301 → `/source-inventory` (legacy)                      |
| dashboard.pubilo.com   | `/chearb/gallery`          | 301 → `/gallery` (legacy)                               |
| dashboard.pubilo.com   | `/chearb/*` (other)        | 301 → `/` (legacy)                                      |
| admin.pubilo.com       | `/`                        | Admin shell (served from `/admin/`, internal-only, `noindex`) |
| www.pubilo.com         | `/`                        | Public landing (served from `/www/`)                    |
| pubilo.com             | `/*`                       | 301 → `https://www.pubilo.com/<path>?<query>`           |
| any host               | `/worker-api/*`            | Reverse proxy to `https://api.pubilo.com/*` (with attachment download support for gallery assets) |

### Cutover compatibility (oomnn.com → pubilo.com)

During the pubilo cutover the worker keeps serving the legacy oomnn family
(`dashboard.oomnn.com`, `admin.oomnn.com`, `www.oomnn.com`, `oomnn.com`).
Same worker bundle handles both hostname sets. Apex traffic on either
`pubilo.com` or `oomnn.com` redirects to the new canonical `https://www.pubilo.com/`.
Legacy oomnn routes are still listed in `wrangler.jsonc` and will be removed
in a follow-up deploy once pubilo smoke is green.

## Local dev

```bash
cd apps/dashboard
npm install
npm run dev          # astro dev on :4174 (proxies /worker-api → api.pubilo.com)
npm run build        # static output to ./dist/
npm run preview
```

## Deploy

```bash
cd apps/dashboard
npm run build
HOME=/Users/yok-macmini npx wrangler deploy
# or
HOME=/Users/yok-macmini npm run deploy
```

## Smoke URLs

```
https://dashboard.pubilo.com/                     → 200, Dashboard V3 marker
https://dashboard.pubilo.com/gallery              → 200
https://dashboard.pubilo.com/source-inventory     → 200  (page posts)
https://dashboard.pubilo.com/inbox                → 200  (original clips)
https://dashboard.pubilo.com/source-processing    → 200
https://dashboard.pubilo.com/campaigns            → 200
https://dashboard.pubilo.com/create-ads           → 200
https://dashboard.pubilo.com/processing           → 200  (ad queue)
https://dashboard.pubilo.com/history              → 200
https://dashboard.pubilo.com/settings             → 200
https://dashboard.pubilo.com/chearb               → 301 → /
https://dashboard.pubilo.com/chearb/processing    → 301 → /processing
https://dashboard.pubilo.com/chearb/source-inventory → 301 → /source-inventory
https://dashboard.pubilo.com/chearb/gallery       → 301 → /gallery
https://dashboard.pubilo.com/chearb/anything-else → 301 → /
https://admin.pubilo.com/                         → 200, PUBILO Admin marker
https://www.pubilo.com/                           → 200, public landing marker
https://pubilo.com/                               → 301 → https://www.pubilo.com/
```

## Rollback

Cloudflare keeps previous deployment versions. To roll back to the previous version:

```bash
cd apps/dashboard
HOME=/Users/yok-macmini npx wrangler rollback
```

Interactively pick the previous version (the one BEFORE the pubilo cutover).
Rolling back the worker script restores the pre-cutover routing logic
(oomnn canonical, no pubilo host handling). Cloudflare custom_domain bindings
for the pubilo hosts are added by the cutover deploy and remain on the worker
after a script rollback; they can be detached manually from the Cloudflare
dashboard if a full revert is required.

## Worker-api contract

`src/worker.ts` proxies `/worker-api/*` to `https://api.pubilo.com/*`:
- Strips the `/worker-api` prefix
- Forwards method + body for non-GET/HEAD
- Sets `x-forwarded-host` / `x-forwarded-proto`
- For `/worker-api/api/gallery/{id}/asset/{original|public}` with `?download=1`, returns the upstream body with `Content-Disposition: attachment; filename="<sanitized>.mp4"`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`

## Architecture notes

- Output is **fully static**. Pages are pre-rendered into `dist/<route>/index.html`. Cloudflare Static Assets serves them directly; SPA fallback (`not_found_handling: single-page-application`) returns `dist/index.html` for unknown routes.
- Worker runs **first** (`run_worker_first: true`) so legacy redirects, host rewrites, and the `/worker-api` proxy are evaluated before assets are served.
- Per-host page selection is done in the worker by rewriting the request URL before delegating to `env.ASSETS`. `www` → `/www/index.html`, `admin` → `/admin/index.html`.
- Svelte islands hydrate with `client:load` and fetch data from `/worker-api` on mount with bounded query params and 12–15s timeouts.
