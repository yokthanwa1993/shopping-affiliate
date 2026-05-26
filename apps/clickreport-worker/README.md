# clickreport-worker

Tiny Cloudflare Worker that exposes `clickreport.wwoom.com` as a clean,
parameter-only URL surface on top of the real Shopee click-report bridge.

**Source of truth (upstream):** the Cloak bridge in
`apps/affiliate-shortlink-cloak/src/click-report.js`, currently reachable at:

```
https://customlink.wwoom.com/click-report?id=<affiliateId>&time=<DD/MM/YYYY>&page_size=<n>
```

This worker does not implement any logic of its own. It only rewrites the
request URL so consumers can call:

```
https://clickreport.wwoom.com/?time=26/05/2026
https://clickreport.wwoom.com/?id=15130770000&time=26/05/2026
https://clickreport.wwoom.com/?id=15142270000&time=25/05/2026&page_size=1
```

Both `/` and `/<anything>` are accepted; the worker always forwards to
`/click-report` upstream and preserves the query string verbatim.

## Behavior

| Aspect              | Behavior                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| Methods             | `GET` and `HEAD` proxy upstream. `OPTIONS` returns 204 + CORS.           |
| Other methods       | `405` JSON with header `Allow: GET, HEAD`.                               |
| Path                | Ignored. Always proxies to `https://customlink.wwoom.com/click-report`.  |
| Query string        | Preserved exactly (delegated to `URL.search`).                           |
| CORS                | `Access-Control-Allow-Origin: *` on every response.                      |
| Content-Type        | `application/json` — upstream JSON passed through; status preserved.     |
| Secrets / cookies   | None. No tokens, no `Set-Cookie`, no HTML.                               |
| Upstream failure    | `502` JSON `{ status: "error", error: "upstream_unreachable", ... }`.    |

The worker also does not modify the existing
`apps/affiliate-shortlink-cloak` server. The bridge there owns date parsing,
affiliate-id validation, login detection, and the actual Shopee API call.

## Local development

```sh
cd apps/clickreport-worker
npm install                       # installs nothing today; reserved for wrangler
npm run check                     # node --check src/index.js
npm test                          # node:test, no external deps
```

The handler is exported as `handleRequest(request, { fetch })`, so tests can
inject a mock `fetch` — see `test/worker.test.js`.

## Deploy (Hermes / human operator)

This repo does not deploy automatically. To roll out:

```sh
cd apps/clickreport-worker
npx wrangler login                # one-time
npx wrangler deploy
```

`wrangler.toml` registers a custom domain for `clickreport.wwoom.com`:

```toml
[[routes]]
pattern = "clickreport.wwoom.com"
custom_domain = true
```

Before deploying, confirm that `clickreport.wwoom.com` is **not** already
bound to a Cloudflare Tunnel or another Worker — Cloudflare will refuse
overlapping custom-domain bindings. If the tunnel still owns the hostname,
remove that mapping in the Zero Trust dashboard (or via `cloudflared`)
first.

If `custom_domain` syntax causes issues for the operator account, fall back
to the legacy route-pattern form:

```toml
routes = [
  { pattern = "clickreport.wwoom.com/*", zone_name = "wwoom.com" }
]
```

## Why a separate worker

- The Cloak bridge keeps its existing surface (`customlink.wwoom.com/click-report`).
- `clickreport.wwoom.com` gets a stable, no-path public URL that is trivial
  to swap if the upstream ever moves (one constant in `src/index.js`).
- Edge-cached, zero-cold-start CORS — no Node process required to serve the
  shape consumers see.
