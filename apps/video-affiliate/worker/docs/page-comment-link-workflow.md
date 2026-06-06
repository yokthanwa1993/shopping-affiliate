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
- Comment targeting is **story-first**: the canonical page-story target
  `<page_id>_<post_id>` comes first, and the reel/video object id is used **only as
  a fallback when no `post_id` / page-story object exists**. Whenever a page-story
  target is known, no read/write/verify candidate list includes the bare reel
  object id. See **Canonical comment target invariant**.
- Stops the whole run on Graph code `368`, rate-limit codes (`4/17/32/613`),
  subcode `1390008`, or spam/blocked wording.
- No token, or dry-run ⇒ `skipped` / `would_edit` / `would_create`, no writes.
- All Graph/customlink errors are sanitized (`access_token`/`EAA…` redacted).

## Canonical comment target invariant

Facebook Reels expose **two** related object ids: the bare reel/video object id
(surfaced as `fb_reel_url` / `reel_id` / `fb_video_id`) and the page-story object
id `<page_id>_<post_id>` that actually appears on the page feed (`fb_post_id` /
`post_id`). Comments on the reel object do **not** propagate to the page-story, so
the canonical post/comment target for **rewrite, comment read/write and verify**
**MUST** be the page-story object id `<page_id>_<post_id>` whenever a `post_id`
exists. The bare reel object id is a fallback **only** when no `post_id` /
page-story object exists. The same rule governs the candidate lists built by
`buildVisibleCommentTargetCandidates` and `buildPostingCommentTargetCandidates`:
when an `fb_post_id` / page-story exists they return only page-story candidates
(full `<page_id>_<post_id>` and the bare story tail) and **never** the reel
object id, so no read/write/verify can target the reel; the reel id is emitted
solely when no `fb_post_id` / page-story is present.

`resolveCanonicalCommentTarget` (in `src/comment-targeting.ts`) is the single
enforcement point. The rule it applies:

- `canonical_post_id` / `post_canonical` already full (`<digits>_<digits>`) ⇒ use
  as-is (`source: canonical_post_id`).
- A bare numeric `post_id` (or bare `canonical_post_id`) ⇒ compose
  `<page_id>_<post_id>` (`source: page_story_object` / `canonical_post_id`).
- An existing `comment_target_id` is honoured **only** when it is already a full
  page-story id (`source: existing_full_story`). A **bare reel target is never
  silently kept** when a page-story can be resolved.
- No `post_id` / page-story at all ⇒ fall back to the reel object id
  (`source: reel_id`, `fallback: true`, `reason:
  comment_target_fallback_reel_id,page_story_object_missing`).

### Response fields

Every item/job/history/verify response that exposes `comment_target_id` also
exposes the alias **`page_story_object_id`** (same value — the full canonical
target). The existing `comment_target_id` D1 column is unchanged (no migration);
the alias is a response/read-time addition. Responses additionally carry
`reel_id` / `fb_video_id` (the reel/source video object), the numeric `post_id`
tail when available, and — when the reel fallback is taken —
`comment_target_source`, `comment_target_fallback` and
`comment_target_fallback_reason` so the fallback is never silent. This holds for
**every** item, including already-written ones: `comment_target_id` /
`page_story_object_id` always report the canonical page-story object
(`<page_id>_<post_id>`) whenever a post_id / page-story can be resolved — a
`new_comment_id` on a row does **not** pin a stale bare reel target, so the
verify endpoint always re-reads the visible page-story object, not the reel. The
stored target (or reel) is only reported when no page-story object can be
resolved, and that fallback stays flagged.

### No Facebook writes

Preview, job creation, `GET job`, verify and history are **read-only** against
Facebook — they only resolve/compute the canonical target and read `/comments`.
The **only** write path is `run` in effective write mode (`dry_run=false` AND a
token is available), and even then only after the new shortlink is minted,
expanded and verified. The canonical target rule applies identically to that
write path: when a `post_id` / page-story object exists, a fresh page-owned
comment is created and verified only on the page-story candidates. The bare reel
object is a fallback only when no `post_id` / page-story object exists.

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

### Affiliate id (account id) tracking

Separate from the `sub1..sub5` campaign ids, every link also carries an
**affiliate account id**. Only the **plain numeric** id is ever parsed, stored or
compared — e.g. `15130770000`, never `an_15130770000` and never a full
`mmp_pid`/`utm_source` token:

- `parseAffiliateId(url)` reads the id from the customlink wrapper
  (`customlink.wwoom.com/?id=<id>`) or the expanded Shopee form
  (`utm_source=an_<id>` / `mmp_pid=an_<id>`). Both go through the shared
  fail-closed `normalizeShortlinkExpectedUtmId` (strips `an_`, digits-only,
  length-capped), so a raw token can never be mistaken for an id. Returns `''`
  when nothing valid is found.
- `resolveTargetAffiliateId(override?)` is the id the rewrite SHOULD mint with:
  the CHEARB `CUSTOMLINK_DEFAULT_ID` (`15130770000`) unless a numeric override
  normalises cleanly.
- `verifyAffiliateId(expandedUrl, target)` compares by **strict numeric-string
  equality only** (`new_affiliate_id === target_affiliate_id`): no id on the
  link → `missing`; present but unequal (or no target) → `mismatch`; equal →
  `verified`. The raw customlink URL is NOT stored for this — the numeric id is
  enough.

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

Both the registry and job-items tables carry affiliate-id tracking columns:
`old_affiliate_id`, `target_affiliate_id`, `new_affiliate_id` (plain numeric
strings), `affiliate_verify_status` (`'' | verified | mismatch | missing`), and
`affiliate_id_match` (`INTEGER 0/1`). Existing D1 tables receive those columns
through `migrations/0022_page_comment_link_affiliate_id_tracking.sql`.

Apply:

```bash
# from repo root
npm run db:migrate:video-affiliate:local   # local
npm run db:migrate:video-affiliate          # prod (schema.sql)
# or the workflow migration files:
wrangler d1 execute video-affiliate-db --local --file=./migrations/0020_page_comment_link_workflow.sql
wrangler d1 execute video-affiliate-db --local --file=./migrations/0021_page_comment_link_job_items_target_sub4.sql
wrangler d1 execute video-affiliate-db --local --file=./migrations/0022_page_comment_link_affiliate_id_tracking.sql
```

Tables are also auto-created at runtime via `ensurePageCommentLinkWorkflowTables`,
matching the existing `CREATE TABLE IF NOT EXISTS` pattern.

## Tests

`npm test` (in `worker/`) covers the pure helpers: target sub building,
customlink URL, message replacement, verify parser, batch clamp, dry-run bool,
write-action selection, and Graph stop-signal detection.

`resolveCanonicalCommentTarget` is covered in `test/comment-targeting.test.ts`
(and cross-checked in `test/comment-link-registry.test.ts`): a `reel_id` +
`post_id` item resolves `target` / `page_story_object_id` to
`<page_id>_<post_id>` (never the bare reel id), full/bare `canonical_post_id` and
an existing full page-story id are honoured, and a missing `post_id` falls back
to the reel id with `reason` containing `comment_target_fallback_reel_id` /
`page_story_object_missing`.
