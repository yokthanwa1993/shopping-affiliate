# Page comment link rewrite workflow

Safe, history-preserving workflow for changing the Shopee shortlink inside
Facebook **Page/Reel comments** on the CHEARB page (`page_id 1008898512617594`,
namespace `1774858894802785816`).

Pure string/decision logic lives in `src/comment-link-registry.ts` (unit-tested,
no network). The route handlers in `src/index.ts` own all I/O (Graph reads/writes,
customlink mint, redirect expansion, D1). The legacy read-only audit endpoint is
unchanged.

## Safety model

- **Preview and job creation are read-only.** No Facebook writes, no customlink
  minting — they only compute the plan and persist an audit snapshot.
- **`dry_run` defaults to `true`.** `run` writes **only** when `dry_run` is
  explicitly `false` — persisted at job creation OR sent in the run body. Any
  ambiguity stays in the dry-run path.
- **`batch_size` default `5`, max `50`.** `stop_on_first_error` default `true`.
- **Never deletes comments. Never deletes evidence.** `old_message` /
  `old_shortlink` / `old_*` columns are retained for rollback & history.
- A write only happens after the new shortlink is minted, expanded, and its
  `utm_content` verified to carry the expected sub ids.
- Edit is preferred only for **page-owned** comments (`from.id === page_id`). If
  the edit fails (cross-app/token/permission), the old comment is left intact and
  a fresh page-owned comment is created (`action = create_new`).
- Comment targeting is **story-first**: `<page_id>_<post_id>` (canonical), then
  the reel/video object id as fallback.
- Stops the whole run on Graph code `368`, rate-limit codes (`4/17/32/613`),
  subcode `1390008`, or spam/blocked wording.
- No token, or dry-run ⇒ `skipped` / `would_edit` / `would_create`, no writes.
- All Graph/customlink errors are sanitized (`access_token`/`EAA…` redacted).

## Link logic

- Shortlink minted via `customlink.wwoom.com`, `id=15130770000`.
- `target_sub1` = operator-requested campaign.
- `target_sub2` = canonical `post_id` when resolved, else `fb_video_id` / `reel_id`
  (the fallback is flagged in `reason` via `sub2_fallback_*`).
- `target_sub3` = `page_id`.
- Expected `utm_content` on the expanded link: `<sub1>-<sub2>-<sub3>--`.
- `product_url` is canonicalized. When the Shopee shop/item ids can be parsed
  (`.../product/<shop>/<item>`, `.../<shopname>/<shop>/<item>`,
  `.../<slug>-i.<shop>.<item>`, or `shopid`/`itemid` query params) the **entire**
  query string + hash is dropped, yielding a clean product URL. Otherwise known
  tracking keys are stripped individually (UTM/sub/click ids plus stale Shopee
  junk: `__mobile__`, `gads_t_sig`, `mmp_pid`, affiliate/redirect params).
- `buildCustomlinkRequestUrl` canonicalizes `productUrl` defensively, so the
  customlink `url=` parameter can never carry stale Shopee tracking params.

## Endpoints (all under `/api/dashboard`)

| Method & path | Mode | Notes |
|---|---|---|
| `GET  /page-comment-link-registry` | read-only | Existing audit; filters `page_id, limit, offset, expand, status, sub1, has_comment, has_shopee_link`. Unchanged. |
| `POST /page-comment-link-rewrite-preview` | read-only | Body `{ page_id?, target_sub1, items[] }`. Returns per-item plan + persists registry snapshot. |
| `POST /page-comment-link-jobs` | read-only | Body `{ page_id?, target_sub1, items[], dry_run?, batch_size?, stop_on_first_error?, customlink_id? }`. Creates a job + items. Returns `job_id`. |
| `GET  /page-comment-link-jobs/:job_id` | read-only | Job + items. |
| `POST /page-comment-link-jobs/:job_id/run` | dry-run by default | Body `{ dry_run?, batch_size?, limit? }`. Writes only when `dry_run=false` (persisted or in body) AND a token is available. |
| `POST /page-comment-link-jobs/:job_id/verify` | read-only | Re-reads each written item's target; confirms the new comment + link. |
| `GET  /page-comment-link-jobs/:job_id/history` | read-only | Old/new message + link per item for manual rollback. |

`items[]` are the rows returned by the registry audit endpoint (the dashboard
fetches the audit, then posts the chosen rows to preview/jobs).

### Response shape (operator-friendly top-level fields)

Every endpoint preserves its existing nested fields (`summary`, `items`, `job`,
`batch`, `processed`, `results`, `requested_sub1`, …) and **additionally** surfaces
flat top-level fields so an operator/dashboard never has to dig into nested
objects:

| Endpoint | Added top-level fields |
|---|---|
| `POST preview` | `target_sub1`, `count_returned` (alongside `summary`) |
| `POST jobs` | `job_id`, `status`, `dry_run`, `write_mode` (always `false`), `target_sub1`, `counts`, `count_returned` |
| `GET jobs/:id` | `job_id`, `status`, `dry_run`, `write_mode`, `target_sub1`, `counts`, `count_returned` |
| `POST jobs/:id/run` | `job_id`, `status`, `dry_run` (what the run actually did), `write_mode`, `counts`, `count_returned` (kept `job_status`, `batch`, `processed`) |
| `POST jobs/:id/verify` | `job_id`, `status`, `dry_run` (always `true`), `write_mode` (always `false`), `counts`, `count_returned`, `checked`, `verified` |
| `GET jobs/:id/history` | `status`, `dry_run`, `write_mode`, `counts`, `count_returned` |

`dry_run`/`write_mode` on `run` reflect the **effective** behaviour: a write only
happens when a token is available AND write was requested (body `dry_run=false`)
or persisted (`dry_run=false` at job creation). Any ambiguity stays dry-run.

### Item statuses

Persisted: `planned` → `skipped` → `done` | `failed` | `verify_failed`.
`would_edit` / `would_create` are **response-only** hints during a dry run — a
dry run does NOT mutate item state, so writeable items stay `planned` and a later
`run` with `dry_run=false` still picks them up. `action` ∈ `edit | create_new | skip`.

## D1 schema

Tables added in `schema.sql` and `migrations/0020_page_comment_link_workflow.sql`:

- `page_comment_link_registry` — durable per-item audit snapshot (PK `page_id, fb_video_id`).
- `page_comment_link_jobs` — one rewrite batch (`dry_run`, `batch_size`, `stop_on_first_error`, counters).
- `page_comment_link_job_items` — per-comment plan/result with full old/new history (PK `job_id, item_index`).

Apply:

```bash
# from repo root
npm run db:migrate:video-affiliate:local   # local
npm run db:migrate:video-affiliate          # prod (schema.sql)
# or the single migration file:
wrangler d1 execute video-affiliate-db --local --file=./migrations/0020_page_comment_link_workflow.sql
```

Tables are also auto-created at runtime via `ensurePageCommentLinkWorkflowTables`,
matching the existing `CREATE TABLE IF NOT EXISTS` pattern.

## Tests

`npm test` (in `worker/`) covers the pure helpers: target sub building,
customlink URL, message replacement, verify parser, batch clamp, dry-run bool,
write-action selection, and Graph stop-signal detection.
