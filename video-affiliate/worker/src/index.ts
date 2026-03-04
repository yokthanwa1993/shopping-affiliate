import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { Container } from '@cloudflare/containers'
import * as nodeCrypto from 'node:crypto'
import { Buffer as NodeBuffer } from 'node:buffer'
import { BotBucket } from './utils/botBucket'
import { getBotId } from './utils/botAuth'
import {
    type Env,
    rebuildGalleryCache,
    updateGalleryCache,
    removeFromGalleryCache,
    sendTelegram,
    runPipeline,
    processNextInQueue,
    getVoicePromptTemplate,
    setVoicePromptTemplate,
} from './pipeline'
import { ADMIN_HTML } from './admin-page'

type FacebookSdkApiClient = {
    call: (method: string, path: string, params?: Record<string, unknown>) => Promise<unknown>
}
type FacebookSdkApi = { init: (accessToken: string) => FacebookSdkApiClient }

let facebookAdsApi: FacebookSdkApi | null = null
let facebookAdsApiPromise: Promise<FacebookSdkApi> | null = null

function ensureFacebookSdkRequireShim() {
    const g = globalThis as any
    if (typeof g.require === 'function') return

    const moduleMap: Record<string, unknown> = {
        crypto: nodeCrypto,
        buffer: { Buffer: NodeBuffer },
    }

    g.require = (moduleName: string) => {
        if (moduleName in moduleMap) return moduleMap[moduleName]
        throw new Error(`[FACEBOOK-SDK] Unsupported require("${moduleName}") in Workers runtime`)
    }
}

async function getFacebookAdsApi(): Promise<FacebookSdkApi> {
    if (facebookAdsApi) return facebookAdsApi
    if (!facebookAdsApiPromise) {
        facebookAdsApiPromise = (async () => {
            ensureFacebookSdkRequireShim()
            const g = globalThis as any
            const hadWindow = Object.prototype.hasOwnProperty.call(g, 'window')
            const prevWindow = g.window
            const prevNoNode = g.JS_SHA256_NO_NODE_JS
            const prevNoCommonJs = g.JS_SHA256_NO_COMMON_JS

            let sdk: any
            try {
                g.window = g
                g.JS_SHA256_NO_NODE_JS = true
                g.JS_SHA256_NO_COMMON_JS = true
                sdk = await import('facebook-nodejs-business-sdk') as any
            } finally {
                if (hadWindow) {
                    g.window = prevWindow
                } else {
                    delete g.window
                }
                g.JS_SHA256_NO_NODE_JS = prevNoNode
                g.JS_SHA256_NO_COMMON_JS = prevNoCommonJs
            }

            const resolved = sdk?.FacebookAdsApi || sdk?.default?.FacebookAdsApi
            if (!resolved || typeof resolved.init !== 'function') {
                throw new Error('facebook_sdk_load_failed')
            }
            facebookAdsApi = resolved as FacebookSdkApi
            return facebookAdsApi
        })()
    }
    return facebookAdsApiPromise
}

const app = new Hono<{ Bindings: Env, Variables: { botId: string; bucket: R2Bucket } }>()
const MAX_VOICE_PROMPT_CHARS = 12000
const MAX_GEMINI_API_KEY_CHARS = 512

// CORS
app.use('*', async (c, next) => {
    const corsMiddleware = cors({
        origin: c.env.CORS_ORIGIN || '*',
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'x-auth-token', 'x-admin-token', 'x-bot-id', 'x-tag-sync-secret'],
        exposeHeaders: ['Content-Type'],
    })
    return corsMiddleware(c, next)
})


app.use('*', async (c, next) => {
    let token = c.req.header('x-auth-token') || '';
    if (!token && c.req.path.startsWith('/api/telegram/')) {
        const parts = c.req.path.split('/');
        if (parts.length >= 4) token = parts[3];
    }
    // Session token auth (webapp)
    if (token.startsWith('sess_')) {
        const user = await c.env.DB.prepare('SELECT namespace_id FROM users WHERE session_token = ?').bind(token).first() as any
        if (!user?.namespace_id) return c.json({ error: 'Unauthorized' }, 401)
        const botId = String(user.namespace_id)
        c.set('botId', botId);
        c.set('bucket', new BotBucket(c.env.BUCKET, botId) as unknown as R2Bucket);
    } else {
        const botId = c.req.header('x-bot-id') || getBotId(token);
        if (!c.req.path.startsWith('/api/telegram/') && !c.req.path.startsWith('/api/r2')) {
            console.log(`[API REQUEST] path: ${c.req.path} | raw-token: ${token?.substring(0, 15)} | botId: ${botId}`)
        }
        c.set('botId', botId);
        c.set('bucket', new BotBucket(c.env.BUCKET, botId) as unknown as R2Bucket);
    }
    await next();
})

async function requireOwnerSession(c: Context<{ Bindings: Env, Variables: { botId: string; bucket: R2Bucket } }>) {
    const token = c.req.header('x-auth-token') || ''
    if (!token.startsWith('sess_')) {
        return { ok: false as const, response: c.json({ error: 'Unauthorized' }, 401) }
    }
    const user = await c.env.DB.prepare('SELECT email FROM users WHERE session_token = ?').bind(token).first() as { email?: string } | null
    if (!user?.email) {
        return { ok: false as const, response: c.json({ error: 'Unauthorized' }, 401) }
    }
    const isOwner = await c.env.DB.prepare('SELECT 1 AS ok FROM allowed_emails WHERE email = ?').bind(String(user.email).trim().toLowerCase()).first()
    if (!isOwner) {
        return { ok: false as const, response: c.json({ error: 'Forbidden' }, 403) }
    }
    return { ok: true as const }
}

async function resolveNamespacesForTagSync(
    db: D1Database,
    input: { namespaceId?: string; email?: string },
): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (value: unknown) => {
        const ns = String(value || '').trim()
        if (!ns || ns === 'default') return
        if (seen.has(ns)) return
        seen.add(ns)
        out.push(ns)
    }

    push(input.namespaceId)

    const email = String(input.email || '').trim().toLowerCase()
    if (email) {
        const mapped = await db.prepare(
            'SELECT namespace_id FROM email_namespaces WHERE email = ?'
        ).bind(email).first() as { namespace_id?: string } | null
        push(mapped?.namespace_id)

        const fromUsers = await db.prepare(
            `SELECT DISTINCT namespace_id
             FROM users
             WHERE email = ?
               AND namespace_id IS NOT NULL
               AND TRIM(namespace_id) <> ''`
        ).bind(email).all() as { results?: Array<{ namespace_id?: string }> }
        for (const row of (fromUsers.results || [])) push(row?.namespace_id)
    }

    return out
}

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'video-affiliate-worker' }))

// Push sync from BrowserSaving after tag updates.
// Default mode is metadata-only (no heavy Graph calls).
app.post('/api/pages/tag-sync', async (c) => {
    let body: any = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const forceFullSync = body?.force_full_sync === true
    const configuredSecret = String(c.env.TAG_SYNC_PUSH_SECRET || '').trim()
    const providedSecret = String(c.req.header('x-tag-sync-secret') || '').trim()

    let namespaces: string[] = []

    if (configuredSecret && providedSecret === configuredSecret) {
        const namespaceId = String(body?.namespace_id || body?.namespaceId || c.req.header('x-bot-id') || '').trim()
        const email = String(body?.email || '').trim().toLowerCase()
        namespaces = await resolveNamespacesForTagSync(c.env.DB, { namespaceId, email })
    } else {
        const owner = await requireOwnerSession(c)
        if (!owner.ok) return owner.response
        namespaces = [String(c.get('botId') || '').trim()].filter(Boolean)
    }

    if (namespaces.length === 0) {
        return c.json({ error: 'namespace_not_found' }, 400)
    }

    const result: Array<{ namespace_id: string; pages_count: number }> = []
    for (const ns of namespaces) {
        await syncTaggedPagesFromProfileMetadata(c.env, ns).catch((e) => {
            console.log(`[TAG-SYNC] metadata sync failed ns=${ns}: ${String(e)}`)
        })

        if (forceFullSync) {
            await autoSyncPagesForNamespace(c.env, ns, { force: true }).catch((e) => {
                console.log(`[TAG-SYNC] full sync failed ns=${ns}: ${String(e)}`)
            })
        }

        const row = await c.env.DB.prepare(
            'SELECT COUNT(*) AS total FROM pages WHERE bot_id = ?'
        ).bind(ns).first() as { total?: number } | null
        result.push({
            namespace_id: ns,
            pages_count: Number(row?.total || 0),
        })
    }

    return c.json({
        success: true,
        mode: forceFullSync ? 'full' : 'metadata',
        synced: result,
    })
})

// TEMP MIGRATION ENDPOINT
app.get('/api/migrate-bucket-back', async (c) => {
    const fromPrefix = c.req.query('from') || '8328894625/'
    const toPrefix = c.req.query('to') || ''

    try {
        const bucket = c.env.BUCKET
        const list = await bucket.list({ prefix: fromPrefix })
        const stats = { copied: 0, skipped: 0, errors: [] as string[] }

        for (const obj of list.objects) {
            // we only want things starting with 8328894625/
            if (!obj.key.startsWith(fromPrefix)) continue;
            const newKey = obj.key.replace(fromPrefix, toPrefix);

            try {
                const oldObj = await bucket.get(obj.key)
                if (oldObj) {
                    await bucket.put(newKey, oldObj.body, {
                        httpMetadata: oldObj.httpMetadata,
                        customMetadata: oldObj.customMetadata
                    })
                    stats.copied++
                } else {
                    stats.skipped++
                }
            } catch (err: any) {
                stats.errors.push(`Failed to copy ${obj.key}: ${err.message}`)
            }
        }
        return c.json({ ok: true, stats })
    } catch (e: any) {
        return c.json({ error: e.message }, 500)
    }
})

// ==================== R2 Upload Proxy (Container เรียกกลับมา) ====================

app.put('/api/r2-upload/:key{.+}', async (c) => {
    // Auth: ใช้ token header ตรวจสอบ
    const authToken = c.req.header('x-auth-token')
    if (authToken !== (c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN)) {
        return c.json({ error: 'unauthorized' }, 401)
    }

    const key = c.req.param('key')
    const contentType = c.req.header('content-type') || 'application/octet-stream'
    const body = await c.req.arrayBuffer()

    await c.get('bucket').put(key, body, {
        httpMetadata: { contentType },
    })

    return c.json({ ok: true, key, size: body.byteLength })
})

app.get('/api/r2-proxy/:key{.+}', async (c) => {
    const authToken = c.req.header('x-auth-token')
    if (authToken !== (c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN)) return c.json({ error: 'unauthorized' }, 401)

    const key = c.req.param('key')
    const obj = await c.get('bucket').get(key)
    if (!obj) return c.json({ error: 'not found' }, 404)

    return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream' } })
})

app.delete('/api/r2-proxy/:key{.+}', async (c) => {
    const authToken = c.req.header('x-auth-token')
    if (authToken !== (c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN)) return c.json({ error: 'unauthorized' }, 401)

    const key = c.req.param('key')
    await c.get('bucket').delete(key)
    return c.json({ ok: true, key })
})

// ==================== CATEGORIES HELPER ====================

const DEFAULT_CATEGORIES = ['เครื่องมือช่าง', 'อาหาร', 'เครื่องครัว', 'ของใช้ในบ้าน', 'เฟอร์นิเจอร์', 'บิวตี้', 'แฟชั่น', 'อิเล็กทรอนิกส์', 'สุขภาพ', 'กีฬา', 'สัตว์เลี้ยง', 'ยานยนต์', 'อื่นๆ']

async function getCategories(bucket: R2Bucket): Promise<string[]> {
    const obj = await bucket.get('_config/categories.json')
    if (obj) return await obj.json() as string[]
    return DEFAULT_CATEGORIES
}

function toThaiDateString(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    const thai = new Date(date.getTime() + (7 * 60 * 60 * 1000))
    return thai.toISOString().split('T')[0]
}

function uniqueVideoIds(ids: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of ids) {
        const id = String(raw || '').trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push(id)
    }
    return out
}

function parseVideoCreatedAtMs(value: unknown): number {
    const ms = new Date(String(value || '')).getTime()
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

function dedupeVideosById(videos: any[]): any[] {
    const byId = new Map<string, any>()
    for (const video of videos || []) {
        const id = String(video?.id || '').trim()
        if (!id) continue
        const prev = byId.get(id)
        if (!prev) {
            byId.set(id, video)
            continue
        }
        const prevTs = new Date(String(prev?.updatedAt || prev?.createdAt || '')).getTime()
        const nextTs = new Date(String(video?.updatedAt || video?.createdAt || '')).getTime()
        if ((Number.isFinite(nextTs) ? nextTs : 0) >= (Number.isFinite(prevTs) ? prevTs : 0)) {
            byId.set(id, video)
        }
    }
    return Array.from(byId.values())
}

async function listAllVideoJsonIds(bucket: R2Bucket): Promise<string[]> {
    const objects = await listAllVideoObjects(bucket)
    const ids: string[] = []
    for (const obj of objects) {
        if (!obj.key.endsWith('.json')) continue
        ids.push(obj.key.replace('videos/', '').replace('.json', ''))
    }
    return uniqueVideoIds(ids)
}

async function listAllVideoObjects(bucket: R2Bucket): Promise<R2Object[]> {
    const objects: R2Object[] = []
    let cursor: string | undefined
    do {
        const page = await bucket.list(cursor ? { prefix: 'videos/', cursor } : { prefix: 'videos/' })
        objects.push(...page.objects)
        cursor = page.truncated && page.cursor ? page.cursor : undefined
    } while (cursor)
    return objects
}

async function orderVideoIdsOldestFirst(bucket: R2Bucket, candidateIds: string[]): Promise<string[]> {
    const normalizedIds = uniqueVideoIds(candidateIds)
    if (normalizedIds.length <= 1) return normalizedIds

    try {
        const cacheObj = await bucket.get('_cache/gallery.json')
        if (!cacheObj) return normalizedIds

        const payload = await cacheObj.json() as { videos?: Array<{ id?: unknown; createdAt?: unknown }> }
        const cacheVideos = Array.isArray(payload?.videos) ? payload.videos : []
        const idSet = new Set(normalizedIds)
        const orderedFromCache: Array<{ id: string; createdAtMs: number; index: number }> = []

        for (let i = 0; i < cacheVideos.length; i += 1) {
            const row = cacheVideos[i]
            const id = String(row?.id || '').trim()
            if (!id || !idSet.has(id)) continue
            orderedFromCache.push({
                id,
                createdAtMs: parseVideoCreatedAtMs(row?.createdAt),
                index: i,
            })
        }

        orderedFromCache.sort((a, b) => {
            if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs
            return a.index - b.index
        })

        const seen = new Set<string>()
        const orderedIds: string[] = []
        for (const row of orderedFromCache) {
            if (seen.has(row.id)) continue
            seen.add(row.id)
            orderedIds.push(row.id)
        }
        for (const id of normalizedIds) {
            if (!seen.has(id)) orderedIds.push(id)
        }
        return orderedIds
    } catch (e) {
        console.log(`[VIDEO ORDER] failed to read gallery cache for oldest-first: ${e instanceof Error ? e.message : String(e)}`)
        return normalizedIds
    }
}

function hasShopeeLinkInMeta(meta: Record<string, unknown>): boolean {
    return !!normalizeMetaShopeeLink(meta)
}

async function pickOldestPostableVideo(
    bucket: R2Bucket,
    candidateIds: string[],
): Promise<{ id: string; meta: Record<string, unknown>; shopeeLink: string } | null> {
    const orderedIds = await orderVideoIdsOldestFirst(bucket, candidateIds)
    if (orderedIds.length === 0) return null

    const cacheHasLink = new Map<string, boolean>()
    const cacheShopeeLink = new Map<string, string>()
    try {
        const cacheObj = await bucket.get('_cache/gallery.json')
        if (cacheObj) {
            const payload = await cacheObj.json() as { videos?: Array<Record<string, unknown>> }
            const rows = Array.isArray(payload?.videos) ? payload.videos : []
            for (const row of rows) {
                const id = String(row?.id || '').trim()
                if (!id) continue
                const shopeeFromCache = normalizeMetaShopeeLink(row) || ''
                cacheHasLink.set(id, !!shopeeFromCache)
                if (shopeeFromCache) {
                    cacheShopeeLink.set(id, shopeeFromCache)
                }
            }
        }
    } catch (e) {
        console.log(`[VIDEO PICK] failed to read gallery cache: ${e instanceof Error ? e.message : String(e)}`)
    }

    const strictCandidates: string[] = []
    const unknownCandidates: string[] = []
    for (const id of orderedIds) {
        if (cacheHasLink.has(id)) {
            if (cacheHasLink.get(id)) strictCandidates.push(id)
            continue
        }
        unknownCandidates.push(id)
    }

    const scanOrder = [...strictCandidates, ...unknownCandidates]
    for (const id of scanOrder) {
        const metaObj = await bucket.get(`videos/${id}.json`)
        if (!metaObj) continue
        const meta = await metaObj.json() as Record<string, unknown>
        const shopeeLink = normalizeMetaShopeeLink(meta) || cacheShopeeLink.get(id) || ''
        if (!shopeeLink) continue
        return { id, meta, shopeeLink }
    }

    return null
}

// ==================== ADMIN PANEL ====================

app.get('/admin', (c) => c.html(ADMIN_HTML))

// Auth check middleware for all /admin/api/* except /admin/api/auth
const adminAuthMiddleware = async (c: any, next: any) => {
    const adminToken = c.req.query('t') || c.req.header('x-admin-token')
    if (!adminToken) return c.json({ error: 'Unauthorized' }, 401)
    const setting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setting_password'").first() as any
    if (!setting || adminToken.trim() !== setting.value?.trim()) return c.json({ error: 'Unauthorized' }, 401)
    await next()
}

app.post('/admin/api/auth', async (c) => {
    const { password } = await c.req.json() as { password: string }
    const setting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setting_password'").first() as any
    if (!setting || !password || password.trim() !== setting.value?.trim()) return c.json({ error: 'Wrong password' }, 401)
    return c.json({ ok: true })
})

app.post('/admin/api/auto-auth', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { chat_id?: string | number }
    const chatId = String(body?.chat_id || '').trim()
    if (!chatId) return c.json({ error: 'Invalid chat_id' }, 400)

    const grantKey = `_admin_grant/${chatId}.json`
    const grantObj = await c.env.BUCKET.get(grantKey)
    if (!grantObj) return c.json({ error: 'Unauthorized' }, 401)

    let expiresAt = 0
    try {
        const grant = await grantObj.json() as any
        expiresAt = Number(grant?.expires_at || 0)
    } catch {
        expiresAt = 0
    }

    if (!expiresAt || Date.now() > expiresAt) {
        await c.env.BUCKET.delete(grantKey).catch(() => { })
        return c.json({ error: 'Grant expired' }, 401)
    }

    const setting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setting_password'").first() as any
    const adminToken = String(setting?.value || '').trim()
    if (!adminToken) return c.json({ error: 'Admin password not set' }, 401)

    return c.json({ ok: true, token: adminToken })
})

app.use('/admin/api/*', adminAuthMiddleware)

// Retry latest failed comments (admin-only)
app.post('/admin/api/comments/retry', async (c) => {
    try {
        const botId = String(c.get('botId') || '').trim()
        if (!botId) return c.json({ error: 'missing_namespace' }, 400)

        const body = await c.req.json().catch(() => ({})) as {
            count?: number
            ids?: number[]
            links?: Record<string, string>
        }

        const requestedIds = Array.isArray(body?.ids) ? body.ids.filter((id) => Number.isFinite(Number(id))) : []
        const count = requestedIds.length > 0
            ? requestedIds.length
            : Math.min(Math.max(Number(body?.count || 2), 1), 10)

        const rows = requestedIds.length > 0
            ? await c.env.DB.prepare(
                `SELECT ph.*, p.name as page_name, p.comment_token, p.access_token
                 FROM post_history ph
                 JOIN pages p ON ph.page_id = p.id
                 WHERE ph.bot_id = ? AND p.bot_id = ? AND ph.id IN (${requestedIds.map(() => '?').join(',')})
                 ORDER BY ph.posted_at DESC, ph.id DESC`
            ).bind(botId, botId, ...requestedIds.map((id) => Number(id))).all()
            : await c.env.DB.prepare(
                `SELECT ph.*, p.name as page_name, p.comment_token, p.access_token
                 FROM post_history ph
                 JOIN pages p ON ph.page_id = p.id
                 WHERE ph.bot_id = ? AND p.bot_id = ? AND ph.comment_status = 'failed'
                 ORDER BY datetime(ph.posted_at) DESC, ph.id DESC
                 LIMIT ?`
            ).bind(botId, botId, count).all()

        const results: Array<{ id: number; ok: boolean; error?: string; comment_id?: string }> = []
        const list = (rows as { results?: any[] }).results || []

        for (const row of list) {
            const historyId = Number(row.id)
            const pageId = String(row.page_id || '').trim()
            const pageName = String(row.page_name || '').trim()
            const fbPostId = String(row.fb_post_id || '').trim()
            const fbReelUrl = String(row.fb_reel_url || '').trim()
            const manualLink = body?.links ? body.links[String(historyId)] : ''

            const targetFromUrl = fbReelUrl
                ? extractReelIdFromPermalink(normalizeFacebookPermalink(fbReelUrl))
                : ''
            const targetId = fbPostId || targetFromUrl

            if (!pageId || !targetId) {
                const err = 'comment_target_missing'
                await c.env.DB.prepare(
                    "UPDATE post_history SET comment_status='failed', comment_error=? WHERE id=?"
                ).bind(err, historyId).run()
                results.push({ id: historyId, ok: false, error: err })
                continue
            }

            const tokenCandidates = await getPageTokenCandidates({
                db: c.env.DB,
                namespaceId: botId,
                pageId,
                primaryPostToken: String(row.access_token || ''),
                primaryCommentToken: String(row.comment_token || ''),
            })
            const commentToken = String(tokenCandidates.commentTokens[0] || row.comment_token || '').trim()
            const commentTokenHint = deriveCommentTokenHint(commentToken)

            if (!commentToken) {
                const err = 'comment_token_missing'
                await c.env.DB.prepare(
                    "UPDATE post_history SET comment_status='failed', comment_error=?, comment_token_hint=? WHERE id=?"
                ).bind(err, commentTokenHint, historyId).run()
                results.push({ id: historyId, ok: false, error: err })
                continue
            }

            const shopeeLink = await resolveShopeeLinkForRetry({
                db: c.env.DB,
                bucket: c.get('bucket'),
                namespaceId: botId,
                videoId: String(row.video_id || ''),
                preferred: manualLink || String(row.shopee_link || ''),
            })

            if (!shopeeLink) {
                const err = 'shopee_link_missing'
                await c.env.DB.prepare(
                    "UPDATE post_history SET comment_status='failed', comment_error=?, comment_token_hint=? WHERE id=?"
                ).bind(err, commentTokenHint, historyId).run()
                results.push({ id: historyId, ok: false, error: err })
                continue
            }

            const commentResult = await postShopeeCommentStrict({
                fbVideoId: targetId,
                shopeeLink,
                commentToken,
                pageId,
                logPrefix: `RETRY ${pageName || pageId} ${historyId}`,
            })

            if (commentResult.ok) {
                await c.env.DB.prepare(
                    "UPDATE post_history SET comment_status='success', comment_error=NULL, comment_fb_id=?, comment_token_hint=? WHERE id=?"
                ).bind(commentResult.id || null, commentTokenHint, historyId).run()
                results.push({ id: historyId, ok: true, comment_id: commentResult.id })
            } else {
                await c.env.DB.prepare(
                    "UPDATE post_history SET comment_status='failed', comment_error=?, comment_token_hint=? WHERE id=?"
                ).bind(commentResult.error || 'comment_failed', commentTokenHint, historyId).run()
                results.push({ id: historyId, ok: false, error: commentResult.error || 'comment_failed' })
            }
        }

        return c.json({ ok: true, count: results.length, results })
    } catch (e) {
        return c.json({ error: 'retry_failed', details: String(e) }, 500)
    }
})

app.get('/admin/api/data', async (c) => {
    const teamsRes = await c.env.DB.prepare(
        `SELECT
            ae.email,
            ae.created_at,
            (
                SELECT u.telegram_id
                FROM users u
                WHERE u.email = ae.email
                ORDER BY datetime(u.created_at) DESC, u.telegram_id DESC
                LIMIT 1
            ) AS telegram_id,
            COALESCE(
                (
                    SELECT en.namespace_id
                    FROM email_namespaces en
                    WHERE en.email = ae.email
                    LIMIT 1
                ),
                (
                    SELECT u2.namespace_id
                    FROM users u2
                    WHERE u2.email = ae.email
                    ORDER BY datetime(u2.created_at) ASC, u2.telegram_id ASC
                    LIMIT 1
                )
            ) AS namespace_id,
            EXISTS(
                SELECT 1
                FROM users us
                WHERE us.email = ae.email
                  AND us.session_token IS NOT NULL
                  AND TRIM(us.session_token) <> ''
            ) AS active_session
         FROM allowed_emails ae
         ORDER BY ae.created_at DESC`
    ).all()

    const pagesTotalRes = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM pages`
    ).first() as any
    const pagesActiveRes = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM pages WHERE is_active = 1`
    ).first() as any
    const postsTotalRes = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM post_history WHERE status IN ('success','posting')`
    ).first() as any
    const postsTodayRes = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM post_history WHERE status IN ('success','posting') AND date(posted_at) = date('now')`
    ).first() as any
    const latestPostRes = await c.env.DB.prepare(
        `SELECT posted_at FROM post_history WHERE status IN ('success','posting') ORDER BY datetime(posted_at) DESC LIMIT 1`
    ).first() as any
    const namespacePagesRes = await c.env.DB.prepare(
        `SELECT bot_id AS namespace_id, COUNT(*) AS pages_count
         FROM pages
         GROUP BY bot_id
         ORDER BY pages_count DESC
         LIMIT 8`
    ).all() as any
    const namespacePostsRes = await c.env.DB.prepare(
        `SELECT bot_id AS namespace_id, COUNT(*) AS posts_count
         FROM post_history
         WHERE status IN ('success','posting')
         GROUP BY bot_id`
    ).all() as any

    const teams = (teamsRes.results || []) as any[]
    const activeOwners = teams.filter((t) => Number(t.active_session) === 1).length
    const namespaces = new Set(teams.map((t) => String(t.namespace_id || '').trim()).filter(Boolean)).size

    const postCountMap = new Map<string, number>()
    for (const row of (namespacePostsRes.results || []) as any[]) {
        const ns = String(row.namespace_id || '').trim()
        if (!ns) continue
        postCountMap.set(ns, Number(row.posts_count || 0))
    }
    const namespaceStats = ((namespacePagesRes.results || []) as any[]).map((row) => {
        const ns = String(row.namespace_id || '').trim()
        return {
            namespace_id: ns,
            pages_count: Number(row.pages_count || 0),
            posts_count: Number(postCountMap.get(ns) || 0),
        }
    })

    return c.json({
        teams,
        dashboard: {
            owners_total: teams.length,
            owners_active: activeOwners,
            namespaces_total: namespaces,
            pages_total: Number(pagesTotalRes?.total || 0),
            pages_active: Number(pagesActiveRes?.total || 0),
            posts_total: Number(postsTotalRes?.total || 0),
            posts_today: Number(postsTodayRes?.total || 0),
            latest_post_at: latestPostRes?.posted_at || null,
            namespace_stats: namespaceStats,
        }
    })
})

const toChanges = (result: any) => Number(result?.meta?.changes || 0)

const resolveNamespaceForOwnerEmail = async (db: D1Database, emailLower: string): Promise<string> => {
    try {
        const mapped = await db.prepare('SELECT namespace_id FROM email_namespaces WHERE email = ?').bind(emailLower).first() as any
        if (mapped?.namespace_id) return String(mapped.namespace_id).trim()
    } catch {
        // ignore missing mapping table in older db states
    }

    const fromUsers = await db.prepare(
        'SELECT namespace_id FROM users WHERE email = ? ORDER BY datetime(created_at) ASC, telegram_id ASC LIMIT 1'
    ).bind(emailLower).first() as any
    return String(fromUsers?.namespace_id || '').trim()
}

const deleteNamespaceR2Objects = async (bucket: R2Bucket, namespaceId: string) => {
    // "default" namespace has no prefix and may contain shared keys; never mass-delete it.
    if (!namespaceId || namespaceId === 'default') return 0

    let deleted = 0
    let cursor: string | undefined = undefined

    while (true) {
        const listRes = await bucket.list({ prefix: `${namespaceId}/`, cursor })
        const keys = (listRes.objects || []).map((obj) => obj.key).filter(Boolean)
        if (keys.length > 0) {
            await bucket.delete(keys)
            deleted += keys.length
        }
        if (!listRes.truncated) break
        cursor = listRes.cursor
        if (!cursor) break
    }

    return deleted
}

app.post('/admin/api/emails', async (c) => {
    const { email } = await c.req.json() as { email: string }
    if (!email || !email.includes('@')) return c.json({ error: 'Invalid email' }, 400)
    await c.env.DB.prepare('INSERT OR IGNORE INTO allowed_emails (email) VALUES (?)').bind(email.trim().toLowerCase()).run()
    return c.json({ ok: true })
})

app.delete('/admin/api/users/:email', async (c) => {
    const email = decodeURIComponent(c.req.param('email') || '').trim().toLowerCase()
    if (!email || !email.includes('@')) return c.json({ error: 'Invalid email' }, 400)

    const namespaceId = await resolveNamespaceForOwnerEmail(c.env.DB, email)

    // Fallback: legacy behavior if we cannot resolve a namespace.
    if (!namespaceId) {
        await c.env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run()
        try {
            await c.env.DB.prepare('DELETE FROM email_namespaces WHERE email = ?').bind(email).run()
        } catch { /* ignore when migration is not applied yet */ }
        await c.env.DB.prepare('DELETE FROM allowed_emails WHERE email = ?').bind(email).run()
        await c.env.DB.prepare('DELETE FROM team_members WHERE email = ?').bind(email).run()
        return c.json({ ok: true, mode: 'legacy_user_delete' })
    }

    // Collect owner emails linked to this workspace before deleting mappings.
    const mappedOwnerEmailsRes = await c.env.DB.prepare(
        'SELECT email FROM email_namespaces WHERE namespace_id = ?'
    ).bind(namespaceId).all() as any
    const ownerEmails = new Set<string>([email])
    for (const row of (mappedOwnerEmailsRes.results || []) as any[]) {
        const mappedEmail = String(row?.email || '').trim().toLowerCase()
        if (mappedEmail) ownerEmails.add(mappedEmail)
    }

    const deleted: Record<string, number> = {}
    deleted.post_queue = toChanges(await c.env.DB.prepare('DELETE FROM post_queue WHERE bot_id = ?').bind(namespaceId).run())
    deleted.post_history = toChanges(await c.env.DB.prepare('DELETE FROM post_history WHERE bot_id = ?').bind(namespaceId).run())
    deleted.pages = toChanges(await c.env.DB.prepare('DELETE FROM pages WHERE bot_id = ?').bind(namespaceId).run())
    deleted.channels = toChanges(await c.env.DB.prepare('DELETE FROM channels WHERE bot_id = ?').bind(namespaceId).run())
    deleted.team_members_owner = toChanges(await c.env.DB.prepare('DELETE FROM team_members WHERE owner_namespace_id = ?').bind(namespaceId).run())
    deleted.users_namespace = toChanges(await c.env.DB.prepare('DELETE FROM users WHERE namespace_id = ?').bind(namespaceId).run())

    try {
        deleted.email_namespaces = toChanges(await c.env.DB.prepare('DELETE FROM email_namespaces WHERE namespace_id = ?').bind(namespaceId).run())
    } catch {
        deleted.email_namespaces = 0
    }

    let removedAllowedEmails = 0
    for (const ownerEmail of ownerEmails) {
        removedAllowedEmails += toChanges(await c.env.DB.prepare('DELETE FROM allowed_emails WHERE email = ?').bind(ownerEmail).run())
    }
    deleted.allowed_emails = removedAllowedEmails

    const r2Deleted = await deleteNamespaceR2Objects(c.env.BUCKET, namespaceId)

    return c.json({
        ok: true,
        deleted_namespace: namespaceId,
        deleted,
        r2_deleted_objects: r2Deleted,
    })
})

// ==================== AUTH ====================

app.post('/api/auth/login', async (c) => {
    const { email, tg_id } = await c.req.json()

    // Auto-login by tg_id (Telegram WebApp init)
    if (tg_id && !email) {
        const user = await c.env.DB.prepare(
            'SELECT session_token FROM users WHERE telegram_id = ?'
        ).bind(String(tg_id)).first() as any
        if (user?.session_token) return c.json({ session_token: user.session_token })
        return c.json({ error: 'Not registered' }, 401)
    }

    // Email login
    if (!email || !email.includes('@')) return c.json({ error: 'Invalid email' }, 400)
    const emailLower = email.toLowerCase()

    // Check owner (allowed_emails) or team member
    const allowed = await c.env.DB.prepare('SELECT email FROM allowed_emails WHERE email = ?').bind(emailLower).first() as any
    const isOwner = !!allowed
    const teamMember = !isOwner ? await c.env.DB.prepare('SELECT owner_namespace_id FROM team_members WHERE email = ?').bind(emailLower).first() as any : null
    if (!allowed && !teamMember) return c.json({ error: 'Email not allowed' }, 403)

    const sessionToken = 'sess_' + crypto.randomUUID().replace(/-/g, '')

    // Resolve canonical namespace:
    // - Owner: lock by email mapping only (prevent Telegram account cross-contamination)
    // - Team member: always use owner namespace
    let namespaceId: string | null = teamMember?.owner_namespace_id ? String(teamMember.owner_namespace_id) : null

    // Priority #1: canonical email mapping table (owner only)
    if (!namespaceId && isOwner) {
        try {
            const mapped = await c.env.DB.prepare('SELECT namespace_id FROM email_namespaces WHERE email = ?').bind(emailLower).first() as any
            if (mapped?.namespace_id) namespaceId = String(mapped.namespace_id)
        } catch (e) {
            console.log(`[AUTH] email_namespaces lookup skipped: ${String(e)}`)
        }
    }

    // Priority #2: historical namespace from same email (owner only)
    if (!namespaceId && isOwner) {
        const byEmail = await c.env.DB.prepare(
            'SELECT namespace_id FROM users WHERE email = ? ORDER BY datetime(created_at) ASC, telegram_id ASC LIMIT 1'
        ).bind(emailLower).first() as any
        if (byEmail?.namespace_id) namespaceId = String(byEmail.namespace_id)
    }

    // Priority #3: team member fallback by telegram row (legacy support only)
    if (!namespaceId && !isOwner && tg_id) {
        const byTg = await c.env.DB.prepare('SELECT namespace_id FROM users WHERE telegram_id = ?').bind(String(tg_id)).first() as any
        if (byTg?.namespace_id) namespaceId = String(byTg.namespace_id)
    }

    // Priority #4: create new namespace once
    if (!namespaceId) {
        namespaceId = isOwner ? emailLower.split('@')[0] : (tg_id ? String(tg_id) : emailLower.split('@')[0])
    }

    // Persist canonical email mapping for owners only (do not auto-rewrite existing mapping)
    if (isOwner) {
        try {
            await c.env.DB.prepare(
                `INSERT OR IGNORE INTO email_namespaces (email, namespace_id, created_at, updated_at)
                 VALUES (?, ?, datetime('now'), datetime('now'))`
            ).bind(emailLower, namespaceId).run()
        } catch (e) {
            console.log(`[AUTH] email_namespaces insert skipped: ${String(e)}`)
        }
    }

    // Normalize all rows for this email to avoid workspace drift
    await c.env.DB.prepare('UPDATE users SET namespace_id = ? WHERE email = ?')
        .bind(namespaceId, emailLower).run()

    let bindTgId = tg_id ? Number(tg_id) : null;

    if (bindTgId) {
        // Upsert: ถ้า telegram_id นี้มีอยู่แล้ว → update, ถ้าไม่มี → insert ใหม่
        // รองรับ 1 email login จากหลาย Telegram account
        const existingTgRow = await c.env.DB.prepare('SELECT email FROM users WHERE telegram_id = ?').bind(bindTgId).first() as any;
        if (existingTgRow) {
            // telegram_id นี้เคย login → update email + session
            await c.env.DB.prepare('UPDATE users SET email = ?, namespace_id = ?, session_token = ? WHERE telegram_id = ?')
                .bind(emailLower, namespaceId, sessionToken, bindTgId).run();
        } else {
            // telegram_id ใหม่ → insert row ใหม่ (email เดียวกันมีได้หลาย row)
            await c.env.DB.prepare('INSERT INTO users (telegram_id, email, namespace_id, session_token) VALUES (?, ?, ?, ?)')
                .bind(bindTgId, emailLower, namespaceId, sessionToken).run();
        }
    } else {
        // ไม่มี tg_id → insert โดยไม่ผูก telegram
        await c.env.DB.prepare('INSERT INTO users (email, namespace_id, session_token) VALUES (?, ?, ?)')
            .bind(emailLower, namespaceId, sessionToken).run();
    }

    return c.json({ session_token: sessionToken, is_owner: isOwner })
})

app.post('/api/auth/logout', async (c) => {
    const token = c.req.header('x-auth-token') || ''
    if (!token.startsWith('sess_')) return c.json({ error: 'Unauthorized' }, 401)
    await c.env.DB.prepare("UPDATE users SET session_token = '' WHERE session_token = ?").bind(token).run()
    return c.json({ ok: true })
})

// ==================== TEAM MANAGEMENT ====================

app.get('/api/team', async (c) => {
    const namespaceId = c.get('botId')
    const { results } = await c.env.DB.prepare(
        'SELECT email, created_at FROM team_members WHERE owner_namespace_id = ? ORDER BY created_at DESC'
    ).bind(namespaceId).all()
    return c.json({ members: results })
})

app.post('/api/team', async (c) => {
    const { email } = await c.req.json() as any
    if (!email || !email.includes('@')) return c.json({ error: 'Invalid email' }, 400)
    const namespaceId = c.get('botId')
    await c.env.DB.prepare('INSERT OR IGNORE INTO team_members (owner_namespace_id, email) VALUES (?, ?)')
        .bind(namespaceId, email.trim().toLowerCase()).run()
    return c.json({ ok: true })
})

app.delete('/api/team/:email', async (c) => {
    const email = decodeURIComponent(c.req.param('email'))
    const namespaceId = c.get('botId')
    // Also clear their session if logged in
    await c.env.DB.prepare("UPDATE users SET session_token = '' WHERE email = ? AND namespace_id = ?")
        .bind(email, namespaceId).run()
    await c.env.DB.prepare('DELETE FROM team_members WHERE email = ? AND owner_namespace_id = ?')
        .bind(email, namespaceId).run()
    return c.json({ ok: true })
})

app.get('/api/me', async (c) => {
    const token = c.req.header('x-auth-token') || ''
    if (!token.startsWith('sess_')) return c.json({ error: 'Unauthorized' }, 401)
    const user = await c.env.DB.prepare('SELECT email, namespace_id FROM users WHERE session_token = ?').bind(token).first() as any
    if (!user) return c.json({ error: 'Not found' }, 404)
    const isOwner = await c.env.DB.prepare('SELECT email FROM allowed_emails WHERE email = ?').bind(user.email).first()
    return c.json({ email: user.email, namespace_id: user.namespace_id, is_owner: !!isOwner })
})

app.get('/api/settings/voice-prompt', async (c) => {
    const ownerCheck = await requireOwnerSession(c)
    if (!ownerCheck.ok) return ownerCheck.response

    const namespaceId = c.get('botId')
    const promptMeta = await getVoicePromptTemplate(c.env.DB, namespaceId)
    return c.json({
        prompt: promptMeta.prompt,
        source: promptMeta.source,
        updated_at: promptMeta.updatedAt,
        max_chars: MAX_VOICE_PROMPT_CHARS,
    })
})

app.put('/api/settings/voice-prompt', async (c) => {
    const ownerCheck = await requireOwnerSession(c)
    if (!ownerCheck.ok) return ownerCheck.response

    const body = await c.req.json().catch(() => ({})) as { prompt?: string }
    const prompt = String(body.prompt || '').trim()
    if (prompt.length > MAX_VOICE_PROMPT_CHARS) {
        return c.json({ error: `Prompt too long (max ${MAX_VOICE_PROMPT_CHARS} chars)` }, 400)
    }

    const namespaceId = c.get('botId')
    await setVoicePromptTemplate(c.env.DB, namespaceId, prompt)
    const latest = await getVoicePromptTemplate(c.env.DB, namespaceId)
    return c.json({
        ok: true,
        prompt: latest.prompt,
        source: latest.source,
        updated_at: latest.updatedAt,
        max_chars: MAX_VOICE_PROMPT_CHARS,
    })
})

app.get('/api/settings/gemini-key', async (c) => {
    const ownerCheck = await requireOwnerSession(c)
    if (!ownerCheck.ok) return ownerCheck.response

    const namespaceId = c.get('botId')
    const settings = await getNamespaceGeminiApiKeySettings(c.env.DB, namespaceId, c.env.GOOGLE_API_KEY)
    return c.json({
        ...settings,
        max_chars: MAX_GEMINI_API_KEY_CHARS,
    })
})

app.put('/api/settings/gemini-key', async (c) => {
    const ownerCheck = await requireOwnerSession(c)
    if (!ownerCheck.ok) return ownerCheck.response

    const body = await c.req.json().catch(() => ({})) as { api_key?: string; apiKey?: string }
    const apiKey = String(body.api_key ?? body.apiKey ?? '').trim()
    if (apiKey.length > MAX_GEMINI_API_KEY_CHARS) {
        return c.json({ error: `Gemini API key too long (max ${MAX_GEMINI_API_KEY_CHARS} chars)` }, 400)
    }

    const namespaceId = c.get('botId')
    await setNamespaceGeminiApiKey(c.env.DB, namespaceId, apiKey)
    const settings = await getNamespaceGeminiApiKeySettings(c.env.DB, namespaceId, c.env.GOOGLE_API_KEY)
    return c.json({
        ok: true,
        ...settings,
        max_chars: MAX_GEMINI_API_KEY_CHARS,
    })
})

app.delete('/api/settings/gemini-key', async (c) => {
    const ownerCheck = await requireOwnerSession(c)
    if (!ownerCheck.ok) return ownerCheck.response

    const namespaceId = c.get('botId')
    await setNamespaceGeminiApiKey(c.env.DB, namespaceId, '')
    const settings = await getNamespaceGeminiApiKeySettings(c.env.DB, namespaceId, c.env.GOOGLE_API_KEY)
    return c.json({
        ok: true,
        ...settings,
        max_chars: MAX_GEMINI_API_KEY_CHARS,
    })
})

// ==================== TELEGRAM WEBHOOK ====================

app.post('/api/telegram/:token?', async (c) => {
    const data = await c.req.json() as any
    const msg = data.message
    const cb = data.callback_query
    const chatId = msg?.chat?.id || cb?.message?.chat?.id
    const token = c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN
    const botId = c.get('botId') || 'default'
    const workerUrl = new URL(c.req.url).origin
    const adminStateKey = `_admin_auth/${chatId}.json`
    const ADMIN_AUTH_TTL_MS = 10 * 60 * 1000

    if (!chatId) return c.text('ok')

    console.log('[WEBHOOK] chatId:', chatId, 'token:', token?.substring(0, 15), 'botId:', botId, 'isParam:', c.req.param('token')?.substring(0, 15))

    const clearAdminAuthPending = async () => {
        await c.env.BUCKET.delete(adminStateKey).catch(() => { })
    }

    const askAdminPassword = async () => {
        await c.env.BUCKET.put(adminStateKey, JSON.stringify({ expires_at: Date.now() + ADMIN_AUTH_TTL_MS }), {
            httpMetadata: { contentType: 'application/json' },
        })
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: '🔐  Password',
        })
    }

    const sendAdminPanelLink = async () => {
        const setting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setting_password'").first() as any
        const password = String(setting?.value || '').trim()
        if (!password) {
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '❌ ยังไม่ได้ตั้งรหัสผ่านแอดมินในระบบ',
            })
            return
        }

        await c.env.BUCKET.put(`_admin_grant/${chatId}.json`, JSON.stringify({ expires_at: Date.now() + ADMIN_AUTH_TTL_MS }), {
            httpMetadata: { contentType: 'application/json' },
        })

        const adminUrl = `${workerUrl}/admin?t=${encodeURIComponent(password)}&v=${Date.now()}`
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: `✅ รหัสถูกต้อง\n${adminUrl}`,
            reply_markup: { inline_keyboard: [[{ text: '⚙️ เปิด Admin Panel', web_app: { url: adminUrl } }]] },
        })
    }

    const tryHandleAdminPasswordInput = async (inputText: string) => {
        if (!inputText || inputText.startsWith('/')) return false

        const pendingObj = await c.env.BUCKET.get(adminStateKey)
        if (!pendingObj) return false

        let expiresAt = 0
        try {
            const pending = await pendingObj.json() as any
            expiresAt = Number(pending?.expires_at || 0)
        } catch {
            expiresAt = 0
        }

        if (!expiresAt || Date.now() > expiresAt) {
            await clearAdminAuthPending()
            return false
        }

        const setting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'setting_password'").first() as any
        const password = String(setting?.value || '').trim()
        if (!password) {
            await clearAdminAuthPending()
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '❌ ยังไม่ได้ตั้งรหัสผ่านแอดมินในระบบ',
            })
            return true
        }

        if (inputText.trim() !== password) {
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '❌ รหัสผ่านไม่ถูกต้อง ลองใหม่อีกครั้ง หรือพิมพ์ /canceladmin',
            })
            return true
        }

        await clearAdminAuthPending()
        await sendAdminPanelLink()
        return true
    }

    // Check if this token belongs to a registered Channel Bot
    const isChannelBot = await c.env.DB.prepare('SELECT 1 FROM channels WHERE bot_token = ?').bind(token).first()
    console.log('[WEBHOOK] isChannelBot:', !!isChannelBot)

    // ==================== SETTING BOT (ไม่ใช่ Channel Bot) ====================
    if (!isChannelBot) {
        // Verify allowed user
        const allowedUser = await c.env.DB.prepare('SELECT 1 FROM allowed_users WHERE telegram_id = ?').bind(chatId).first()
        console.log('[SETTING] allowedUser:', !!allowedUser, 'text:', msg?.text)
        if (!allowedUser) return c.text('ok')

        const stateKey = `_setting_state/${chatId}.json`

        // Setting Bot: Callback Queries
        if (cb) {
            const action = cb.data as string
            if (action.startsWith('del_channel:')) {
                const delBotId = action.replace('del_channel:', '')
                await c.env.DB.prepare('DELETE FROM channels WHERE bot_id = ? AND owner_telegram_id = ?').bind(delBotId, chatId).run()
                await sendTelegram(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `🗑 ลบช่องเรียบร้อยแล้ว` })
            } else if (action.startsWith('view_bot:')) {
                const viewBotId = action.replace('view_bot:', '')
                const ch = await c.env.DB.prepare('SELECT bot_id, bot_username, name, bot_token FROM channels WHERE bot_id = ? AND owner_telegram_id = ?').bind(viewBotId, chatId).first() as any
                if (ch) {
                    const pageCount = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM pages WHERE bot_id = ?').bind(ch.bot_id).first() as any
                    let text = `🤖 *${ch.name || 'ไม่มีชื่อ'}*\n`
                    text += `├ @${ch.bot_username || '—'}\n`
                    text += `├ เพจ: ${pageCount?.cnt || 0} เพจ\n`
                    text += `└ ID: \`${ch.bot_id}\`\n\n`
                    text += `เลือกดำเนินการกับบอทตัวนี้:`

                    const webAppUrl = c.env.WEBAPP_URL || 'https://video-affiliate-webapp.pages.dev'

                    const buttons = [
                        [{ text: `📱 เปิดหน้าจัดการระบบ (Mini App)`, web_app: { url: webAppUrl } }],
                        [{ text: `🗑 ลบ ${ch.name || ch.bot_username}`, callback_data: `del_channel:${ch.bot_id}` }],
                        [{ text: `🔙 กลับรายการช่องทั้งหมด`, callback_data: `back_to_list` }]
                    ]
                    await sendTelegram(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } })
                }
            } else if (action === 'back_to_list') {
                const { results: channels } = await c.env.DB.prepare(
                    'SELECT bot_id, bot_username, name FROM channels WHERE owner_telegram_id = ? ORDER BY created_at DESC'
                ).bind(chatId).all() as any

                if (channels.length === 0) {
                    await sendTelegram(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: '📭 ยังไม่มีช่องที่ลงทะเบียนไว้\n\nใช้ /newchannel เพื่อเพิ่มช่องใหม่' })
                } else {
                    const buttons: any[][] = []
                    let row: any[] = []
                    for (const ch of channels) {
                        row.push({ text: `@${ch.bot_username}`, callback_data: `view_bot:${ch.bot_id}` })
                        if (row.length === 2) {
                            buttons.push(row)
                            row = []
                        }
                    }
                    if (row.length > 0) buttons.push(row)
                    await sendTelegram(token, 'editMessageText', {
                        chat_id: chatId,
                        message_id: cb.message.message_id,
                        text: 'Choose a bot from the list below:',
                        reply_markup: { inline_keyboard: buttons }
                    })
                }
            }
            await sendTelegram(token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => null)
            return c.text('ok')
        }

        if (!msg) return c.text('ok')
        const text = msg.text || ''

        if (text === '/canceladmin') {
            await clearAdminAuthPending()
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: 'ยกเลิกการเปิด /admin แล้ว',
            })
            return c.text('ok')
        }

        if (await tryHandleAdminPasswordInput(text)) return c.text('ok')

        // /admin
        if (text === '/admin') {
            await askAdminPassword()
            return c.text('ok')
        }

        // /start
        if (text === '/start' || text === '/menu') {
            await c.env.BUCKET.delete(stateKey).catch(() => { })
            console.log('[SETTING] /start from', chatId, 'token:', token?.substring(0, 10) + '...')
            const result = await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: `⚙️ *Video Affiliate — ตั้งค่าช่อง*

📋 *คำสั่ง*
🔹 /newchannel — เพิ่มช่องใหม่ (ส่ง Bot Token)
🔹 /mychannel — ดูช่องทั้งหมดของคุณ

1 ช่อง = 1 บอท Telegram
แต่ละช่องมีแดชบอร์ดและเพจแยกกัน`,
                parse_mode: 'Markdown'
            })
            console.log('[SETTING] sendTelegram result:', JSON.stringify(result))
            return c.text('ok')
        }

        // /newchannel
        if (text === '/newchannel') {
            await c.env.BUCKET.put(stateKey, JSON.stringify({ state: 'WAITING_BOT_TOKEN' }), { httpMetadata: { contentType: 'application/json' } })
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '🤖 *เพิ่มช่องใหม่*\n\nกรุณาส่ง *Bot Token* ที่ได้จาก @BotFather มาเลยครับ\n\nตัวอย่าง:\n`8328894625:AAEgMQwFeBkTLTYP-s5feVUsc7B64jTInAs`',
                parse_mode: 'Markdown'
            })
            return c.text('ok')
        }

        // /mychannel
        if (text === '/mychannel') {
            await c.env.BUCKET.delete(stateKey).catch(() => { })
            const { results: channels } = await c.env.DB.prepare(
                'SELECT bot_id, bot_username, name FROM channels WHERE owner_telegram_id = ? ORDER BY created_at DESC'
            ).bind(chatId).all() as any

            if (channels.length === 0) {
                await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '📭 ยังไม่มีช่องที่ลงทะเบียนไว้\n\nใช้ /newchannel เพื่อเพิ่มช่องใหม่' })
                return c.text('ok')
            }

            const buttons: any[][] = []
            let row: any[] = []
            for (const ch of channels) {
                row.push({ text: `@${ch.bot_username}`, callback_data: `view_bot:${ch.bot_id}` })
                if (row.length === 2) {
                    buttons.push(row)
                    row = []
                }
            }
            if (row.length > 0) buttons.push(row)

            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: 'Choose a bot from the list below:',
                reply_markup: { inline_keyboard: buttons }
            })
            return c.text('ok')
        }

        // Handle state: waiting for bot token
        const stateObj = await c.env.BUCKET.get(stateKey)
        if (stateObj) {
            const state = await stateObj.json() as any

            if (state.state === 'WAITING_BOT_TOKEN' && text && !text.startsWith('/')) {
                await c.env.BUCKET.delete(stateKey)
                const botToken = text.trim()

                // Validate token via Telegram getMe
                const getMeResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
                if (!getMeResp.ok) {
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ Bot Token ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่\n\nใช้ /newchannel เพื่อลองอีกครั้ง' })
                    return c.text('ok')
                }
                const getMeData = await getMeResp.json() as any
                const botInfo = getMeData.result
                const newBotId = getBotId(botToken)

                // Check if already registered
                const existing = await c.env.DB.prepare('SELECT 1 FROM channels WHERE bot_id = ?').bind(newBotId).first()
                if (existing) {
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: `⚠️ ช่อง @${botInfo.username} ลงทะเบียนไว้แล้ว` })
                    return c.text('ok')
                }

                // Register channel
                await c.env.DB.prepare(
                    'INSERT INTO channels (bot_id, bot_token, bot_username, owner_telegram_id, name) VALUES (?, ?, ?, ?, ?)'
                ).bind(newBotId, botToken, botInfo.username || '', chatId, botInfo.first_name || '').run()

                // Add owner to allowed_users if not already
                await c.env.DB.prepare(
                    'INSERT INTO allowed_users (telegram_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING'
                ).bind(chatId, botInfo.first_name || 'owner').run()

                // Set webhook for the new channel bot
                const webhookUrl = `${workerUrl}/api/telegram/${botToken}`
                await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: webhookUrl })
                })

                await sendTelegram(token, 'sendMessage', {
                    chat_id: chatId,
                    text: `✅ *ลงทะเบียนช่องสำเร็จ!*\n\n🤖 ชื่อ: *${botInfo.first_name}*\n👤 @${botInfo.username}\n🔗 Webhook: ตั้งค่าแล้ว\n\nตอนนี้ไปที่ @${botInfo.username} แล้วส่งวิดีโอได้เลย!\nจัดการเพจ Facebook ผ่าน WebApp ของช่องนั้น`,
                    parse_mode: 'Markdown'
                })
                return c.text('ok')
            }
        }

        // Unknown message for Setting Bot
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: '❓ ไม่เข้าใจคำสั่ง\n\nใช้ /start เพื่อดูเมนู'
        })
        return c.text('ok')
    }

    // ==================== CHANNEL BOT (ช่องที่ลงทะเบียนแล้ว) ====================

    // Handle callbacks (del_email:, close_setting)
    if (cb) {
        const action = cb.data as string
        if (action.startsWith('del_email:')) {
            const email = action.replace('del_email:', '')
            await c.env.DB.prepare('DELETE FROM allowed_emails WHERE email = ?').bind(email).run()
            await c.env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run()
            await sendTelegram(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `🗑 ลบ ${email} แล้ว` })
        } else if (action === 'close_setting') {
            await sendTelegram(token, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: '✅ ปิดการตั้งค่า' })
        }
        await sendTelegram(token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => null)
        return c.text('ok')
    }

    if (!msg) return c.text('ok')
    const text = msg.text || ''

    if (text === '/canceladmin') {
        await clearAdminAuthPending()
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: 'ยกเลิกการเปิด /admin แล้ว',
        })
        return c.text('ok')
    }

    if (await tryHandleAdminPasswordInput(text)) return c.text('ok')

    // Auth state & user lookup (session_token NULL = logged out)
    const userRecord = await c.env.DB.prepare('SELECT namespace_id, session_token FROM users WHERE telegram_id = ?').bind(chatId).first() as any

    // /logout command — ล้าง session จาก bot side
    if (text === '/logout') {
        await c.env.DB.prepare("UPDATE users SET session_token = '' WHERE telegram_id = ?").bind(chatId).run()
        const appUrl = c.env.WEBAPP_URL || 'https://video-affiliate-webapp.pages.dev'
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: '✅ ออกจากระบบแล้ว\n\nกด "เปิด Workspace" เพื่อ login ใหม่',
            reply_markup: { inline_keyboard: [[{ text: '🚀 เปิด Workspace', web_app: { url: appUrl } }]] }
        })
        return c.text('ok')
    }

    // /admin command — เปิดหน้า Admin Panel
    if (text === '/admin') {
        await askAdminPassword()
        return c.text('ok')
    }

    // Block unauthenticated/logged-out users — send Mini App button to open Workspace
    if (!userRecord || !userRecord.session_token) {
        const appUrl = c.env.WEBAPP_URL || 'https://video-affiliate-webapp.pages.dev'
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: '👋 กรุณาเปิด Workspace เพื่อเริ่มใช้งาน',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🚀 เปิด Workspace', web_app: { url: appUrl } }
                ]]
            }
        })
        return c.text('ok')
    }

    // Block unknown slash commands for authenticated users
    if (text.startsWith('/')) {
        return c.text('ok')
    }

    // Set user namespace as botId
    c.set('botId', userRecord.namespace_id)
    c.set('bucket', new BotBucket(c.env.BUCKET, userRecord.namespace_id) as unknown as R2Bucket)

    try {
        // Variables defined upstream

        // Dedup: ป้องกัน Telegram retry ขณะ pipeline ยังรันอยู่
        const dedupKey = `_dedup/${data.update_id || msg.message_id}`
        const existing = await c.get('bucket').head(dedupKey)
        if (existing) return c.text('ok')

        const pendingCategoryKey = `_pending_category/${chatId}.json`
        const waitingVideoKey = `_waiting_video/${chatId}.json`
        const extractShopeeLink = (input: string): string => {
            const raw = String(input || '')
            const match = raw.match(/https?:\/\/\S*shopee\S+/i) || raw.match(/https?:\/\/shope\.ee\S+/i)
            return String(match?.[0] || '').trim()
        }

        const CATEGORIES = await getCategories(c.get('bucket'))

        // กรณีเลือกหมวดหมู่ → บันทึก category
        const pendingCatObj = await c.get('bucket').get(pendingCategoryKey)
        if (pendingCatObj && text.trim() && CATEGORIES.includes(text.trim())) {
            const pending = await pendingCatObj.json() as { videoId: string }

            // ตอบ user ก่อนเลย (ไว)
            const [, metaObj] = await Promise.all([
                c.get('bucket').delete(pendingCategoryKey),
                c.get('bucket').get(`videos/${pending.videoId}.json`),
                sendTelegram(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '📝 บันทึกหมวดหมู่แล้ว',
                    reply_markup: { remove_keyboard: true },
                }),
            ])

            // บันทึก metadata + cache ทีหลัง
            if (metaObj) {
                const meta = await metaObj.json() as Record<string, unknown>
                meta.category = text.trim()
                await c.get('bucket').put(`videos/${pending.videoId}.json`, JSON.stringify(meta, null, 2), {
                    httpMetadata: { contentType: 'application/json' },
                })
                await updateGalleryCache(c.get('bucket'), pending.videoId)
            }

            return c.text('ok')
        }

        const handleExecution = async (shopeeLink: string) => {
            const normalizedShopeeLink = String(shopeeLink || '').trim()
            if (!normalizedShopeeLink) return false
            const waitingVideoStr = await c.get('bucket').get(waitingVideoKey)
            if (waitingVideoStr) {
                const { videoUrl } = await waitingVideoStr.json() as { videoUrl: string }
                await c.get('bucket').delete(waitingVideoKey)

                const videoId = crypto.randomUUID().replace(/-/g, '').slice(0, 8)

                // เช็คว่ามี pipeline กำลังรันอยู่ไหม (ข้าม status: failed)
                const processingList = await c.get('bucket').list({ prefix: '_processing/' })
                let isRunning = false
                for (const obj of processingList.objects) {
                    const file = await c.get('bucket').get(obj.key)
                    if (!file) continue
                    const data = await file.json() as any
                    if (data.status !== 'failed') { isRunning = true; break }
                }

                if (isRunning) {
                    // มีอันกำลังทำอยู่ → เข้าคิวรอ
                    await c.get('bucket').put(`_queue/${videoId}.json`, JSON.stringify({
                        id: videoId,
                        videoUrl,
                        shopeeLink: normalizedShopeeLink,
                        chatId,
                        createdAt: new Date().toISOString(),
                        status: 'queued'
                    }), {
                        httpMetadata: { contentType: 'application/json' },
                    })
                    await sendTelegram(token, 'sendMessage', {
                        chat_id: chatId,
                        text: 'กำลังประมวลผลวีดีโอ ✅',
                    })
                } else {
                    // ไม่มีอันกำลังทำ → เริ่มเลย
                    await c.get('bucket').put(`_processing/${videoId}.json`, JSON.stringify({
                        id: videoId,
                        videoUrl,
                        shopeeLink: normalizedShopeeLink,
                        chatId,
                        createdAt: new Date().toISOString(),
                        status: 'processing'
                    }), {
                        httpMetadata: { contentType: 'application/json' },
                    })
                    await sendTelegram(token, 'sendMessage', {
                        chat_id: chatId,
                        text: 'กำลังประมวลผลวีดีโอ ✅',
                    })
                    c.executionCtx.waitUntil(runPipeline(c.env, videoUrl, chatId, 0, videoId, c.get('botId'), normalizedShopeeLink))
                }

                await recordLinkSubmission({
                    db: c.env.DB,
                    namespaceId: c.get('botId'),
                    telegramId: String(chatId),
                    videoId,
                    shopeeLink: normalizedShopeeLink,
                }).catch((e) => {
                    console.error(`[DASHBOARD] failed to record link submission: ${e instanceof Error ? e.message : String(e)}`)
                })
                await c.get('bucket').put(dedupKey, 'processing')
                return true
            }
            return false
        }

        // Helper สำหรับรวมการเซฟวิดีโอที่รอลิงก์ Shopee
        const handleVideoInput = async (videoUrl: string, immediateShopeeLink?: string) => {
            const hasWaitingVideo = await c.get('bucket').head(waitingVideoKey)
            if (hasWaitingVideo) {
                await sendTelegram(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '❌ ยังมีวิดีโอที่รอลิงก์ Shopee อยู่ 1 รายการ\nกรุณาส่งลิงก์ของคลิปก่อนหน้าให้ครบก่อน',
                })
                await c.get('bucket').put(dedupKey, 'processing')
                return
            }

            await c.get('bucket').put(waitingVideoKey, JSON.stringify({ videoUrl }), {
                httpMetadata: { contentType: 'application/json' },
            })

            if (immediateShopeeLink) {
                const executed = await handleExecution(immediateShopeeLink)
                if (executed) return
            }

            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: 'ส่งลิ้ง Shopee ของคลิปนี้มาเลย 🛒',
            })
            await c.get('bucket').put(dedupKey, 'processing')
        }

        // กรณีส่งวิดีโอมา
        if (msg.video) {
            const fileInfo = await fetch(
                `https://api.telegram.org/bot${token}/getFile?file_id=${msg.video.file_id}`
            ).then(r => r.json()) as { ok: boolean; result?: { file_path: string } }

            if (fileInfo.ok && fileInfo.result) {
                const videoUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`
                const shopeeFromCaption = extractShopeeLink(msg.caption || '')
                await handleVideoInput(videoUrl, shopeeFromCaption || undefined)
            }
            return c.text('ok')
        }

        // กรณีส่ง XHS link
        const xhsMatch = text.match(/https?:\/\/(xhslink\.com|www\.xiaohongshu\.com)\S+/)
        if (xhsMatch) {
            const videoUrl = xhsMatch[0]
            await handleVideoInput(videoUrl)
            return c.text('ok')
        }

        // กรณีส่ง Shopee link 
        const shopeeLink = extractShopeeLink(text)
        if (shopeeLink) {

            // ถ้ารอวิดีโออยู่ แล้วส่ง Shopee Link -> สั่งทำ Pipeline หักเข้า Background
            const executed = await handleExecution(shopeeLink)
            if (executed) return c.text('ok')
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '❌ ไม่มีวิดีโอที่รอลิงก์ Shopee\n\nส่งวิดีโอหรือลิงก์ XHS มาก่อน',
            })
            await c.get('bucket').put(dedupKey, 'processing')
            return c.text('ok')
        }

        if (text === '/skip') {
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '❌ ปิดคำสั่ง /skip แล้ว\nทุกคลิปต้องมี Shopee link ก่อนเริ่มประมวลผล',
            })
            return c.text('ok')
        }

        // /start
        if (text === '/start') {
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '👋 สวัสดี! ส่งลิงก์วิดีโอจาก Xiaohongshu หรืออัพโหลดวิดีโอมาเลย',
            })
            return c.text('ok')
        }

        // ข้อความอื่น
        if (text.trim()) {
            const hasPending = await c.get('bucket').head(waitingVideoKey)
            if (hasPending) {
                await sendTelegram(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '❌ ลิงก์ Shopee ไม่ถูกต้อง\n\nส่งลิงก์ที่ขึ้นต้นด้วย https://s.shopee.co.th/... หรือ https://shopee.co.th/...',
                })
            } else {
                await sendTelegram(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '❌ รองรับเฉพาะลิงก์ Xiaohongshu หรืออัพโหลดวิดีโอเท่านั้น\n\nตัวอย่าง: http://xhslink.com/...',
                })
            }
        }

        return c.text('ok')
    } catch (e) {
        console.error('[TELEGRAM] Handler error:', e instanceof Error ? e.message : String(e))
        return c.text('ok')
    }
})

// ล้าง dedup keys (กรณีค้าง)
app.delete('/api/dedup', async (c) => {
    const list = await c.get('bucket').list({ prefix: '_dedup/' })
    for (const obj of list.objects) {
        await c.get('bucket').delete(obj.key)
    }
    return c.json({ deleted: list.objects.length })
})

// ==================== PROCESSING QUEUE ====================

function normalizeProcessingStepName(stepName: unknown): string {
    const raw = typeof stepName === 'string' ? stepName : ''
    if (!raw) return raw

    let normalized = raw
    if (normalized.includes('แกะเวลาเสียง')) {
        normalized = normalized.replace('แกะเวลาเสียง', 'สร้างซับจากเสียงพากย์')
    }
    if (normalized.includes('Word Sync')) {
        normalized = normalized.replace('Word Sync', 'Gemini SRT')
    }
    if (normalized.includes('Gemini Audio Sync')) {
        normalized = normalized.replace('Gemini Audio Sync', 'Gemini SRT')
    }
    return normalized
}

function sanitizeProcessingError(raw: unknown): string {
    const text = String(raw || '').trim()
    if (!text) return ''
    return text
        .replace(/([?&]key=)[^&)\s]+/gi, '$1***')
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
}

app.get('/api/processing', async (c) => {
    try {
        const list = await c.get('bucket').list({ prefix: '_processing/' })
        const prefix = '_processing/'
        const tasks = await Promise.all(
            list.objects.map(async obj => {
                const data = await c.get('bucket').get(obj.key)
                if (!data) return null

                let json: Record<string, unknown> = {}
                try {
                    json = await data.json() as Record<string, unknown>
                } catch {
                    json = {}
                }

                const keyId = obj.key.startsWith(prefix)
                    ? obj.key.slice(prefix.length).replace(/\.json$/i, '').trim()
                    : obj.key.trim()
                const id = String(json.id || keyId || '').trim()

                // orphan/corrupted entry without usable id: auto-clean to prevent UI zombie rows
                if (!id) {
                    await c.get('bucket').delete(obj.key).catch(() => { })
                    return null
                }

                const createdAt = String(json.createdAt || '').trim() || obj.uploaded.toISOString()
                const status = String(json.status || '').trim() || 'processing'
                const error = sanitizeProcessingError(json.error || json.error_message)

                return {
                    ...json,
                    id,
                    createdAt,
                    status,
                    error,
                    stepName: normalizeProcessingStepName(json.stepName),
                }
            })
        )
        const videos = (tasks.filter(Boolean) as Array<Record<string, unknown>>)
        videos.sort((a, b) => {
            const at = new Date(String(a.createdAt || '')).getTime()
            const bt = new Date(String(b.createdAt || '')).getTime()
            return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
        })
        return c.json({ videos }, 200, { 'Cache-Control': 'no-store' })
    } catch (e) {
        return c.json({ error: String(e) }, 500)
    }
})

app.delete('/api/processing/:id', async (c) => {
    try {
        await c.get('bucket').delete(`_processing/${c.req.param('id')}.json`)
        c.executionCtx.waitUntil(processNextInQueue(c.env, c.get('botId')))
        return c.json({ ok: true })
    } catch (e) {
        return c.json({ error: String(e) }, 500)
    }
})

app.get('/api/my-bots', async (c) => {
    const tgId = c.req.query('tg_id')
    if (!tgId) return c.json({ bots: [] })
    try {
        const { results } = await c.env.DB.prepare(
            'SELECT bot_id, bot_username, name, bot_token FROM channels WHERE owner_telegram_id = ? ORDER BY created_at DESC'
        ).bind(tgId).all()
        return c.json({ bots: results })
    } catch (e) {
        return c.json({ bots: [] })
    }
})

app.get('/api/stats', async (c) => {
    const bucket = c.get('bucket')
    try {
        const cacheObj = await bucket.get('_cache/gallery.json')
        return c.json({ total: cacheObj ? 1 : 0 })
    } catch (e) {
        return c.json({ total: 0 })
    }
})

// Refresh gallery cache for a specific video (called by container after pipeline completes)
app.post('/api/gallery/refresh/:id', async (c) => {
    try {
        await updateGalleryCache(c.get('bucket'), c.req.param('id'))

        // เช็คคิว → ถ้ามีงานรอ ให้เริ่มทำอันถัดไป
        c.executionCtx.waitUntil(processNextInQueue(c.env, c.get('botId')))

        return c.json({ ok: true })
    } catch (e) {
        return c.json({ error: String(e) }, 500)
    }
})

// Process next queued job
app.post('/api/queue/next', async (c) => {
    try {
        const started = await processNextInQueue(c.env, c.get('botId'))
        return c.json({ ok: true, started })
    } catch (e) {
        return c.json({ error: String(e) }, 500)
    }
})

// Get queue items
app.get('/api/queue', async (c) => {
    try {
        const list = await c.get('bucket').list({ prefix: '_queue/' })
        const items = []
        for (const obj of list.objects) {
            const data = await c.get('bucket').get(obj.key)
            if (data) items.push(await data.json())
        }
        return c.json({ queue: items })
    } catch (e) {
        return c.json({ queue: [], error: String(e) })
    }
})

// Delete queue item
app.delete('/api/queue/:id', async (c) => {
    try {
        await c.get('bucket').delete(`_queue/${c.req.param('id')}.json`)
        c.executionCtx.waitUntil(processNextInQueue(c.env, c.get('botId')))
        return c.json({ ok: true })
    } catch (e) {
        return c.json({ error: String(e) }, 500)
    }
})

// ==================== CATEGORIES API ====================

app.get('/api/categories', async (c) => {
    const cats = await getCategories(c.get('bucket'))
    return c.json({ categories: cats })
})

app.put('/api/categories', async (c) => {
    const body = await c.req.json() as { categories: string[] }
    await c.get('bucket').put('_config/categories.json', JSON.stringify(body.categories), {
        httpMetadata: { contentType: 'application/json' },
    })
    return c.json({ success: true })
})

// ==================== GALLERY API (R2) ====================

app.get('/api/gallery', async (c) => {
    const r2Url = c.env.R2_PUBLIC_URL
    const botId = c.get('botId')
    const fixUrls = (data: any) => {
        const s = JSON.stringify(data)
        // Fix old pub URLs to new bucket with botId prefix
        return JSON.parse(s.replace(/https:\/\/pub-[a-f0-9]+\.r2\.dev\/videos\//g, `${r2Url}/${botId}/videos/`))
    }
    try {
        // "ยังไม่ได้ใช้" = video_id ที่ยังไม่มี fb_post_id จริง
        const postedIds = await getConfirmedPostedVideoIds({
            db: c.env.DB,
            namespaceId: botId,
        })

        const cached = await c.get('bucket').get('_cache/gallery.json')
        if (cached) {
            const data = await cached.json() as { videos: any[] }
            const filteredVideos = dedupeVideosById(data.videos || [])
                .filter((v: any) => !postedIds.has(String(v?.id || '').trim()))
            return c.json(fixUrls({ videos: filteredVideos }), 200, { 'Cache-Control': 'private, max-age=15', 'Vary': 'x-auth-token' })
        }

        const videos = await rebuildGalleryCache(c.get('bucket'))
        const filteredVideos = videos
            .filter((v: any) => !postedIds.has(String((v as any)?.id || '').trim()))
        return c.json(fixUrls({ videos: filteredVideos }))
    } catch (e) {
        return c.json({ videos: [], error: String(e) })
    }
})

// Get videos that have been posted (used videos)
app.get('/api/gallery/used', async (c) => {
    const r2Url = c.env.R2_PUBLIC_URL
    const botId = c.get('botId')
    const fixUrls = (data: any) => {
        const s = JSON.stringify(data)
        return JSON.parse(s.replace(/https:\/\/pub-[a-f0-9]+\.r2\.dev\/videos\//g, `${r2Url}/${botId}/videos/`))
    }
    try {
        // "โพสต์แล้ว" = video_id ที่มี fb_post_id จริง
        const postedIds = Array.from(await getConfirmedPostedVideoIds({
            db: c.env.DB,
            namespaceId: botId,
        }))

        // Fast path: read one cached gallery object and filter by posted IDs.
        // This avoids N R2 reads when history is large.
        const postedIdSet = new Set(postedIds)
        const cached = await c.get('bucket').get('_cache/gallery.json')
        let sourceVideos: any[] = []
        if (cached) {
            const data = await cached.json() as { videos?: any[] }
            sourceVideos = data.videos || []
        } else {
            sourceVideos = await rebuildGalleryCache(c.get('bucket'))
        }

        const videos = dedupeVideosById(sourceVideos)
            .filter((v: any) => postedIdSet.has(String(v?.id || '').trim()))

        // Sort by createdAt desc
        videos.sort((a: any, b: any) => {
            return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        })

        return c.json(fixUrls({ videos }), 200, { 'Cache-Control': 'private, max-age=15', 'Vary': 'x-auth-token' })
    } catch (e) {
        return c.json({ videos: [], error: String(e) }, 500)
    }
})

// Get original videos across all namespaces (owner/admin view)
const getAllOriginalGallery = async (
    c: Context<{ Bindings: Env, Variables: { botId: string; bucket: R2Bucket } }>
) => {
    try {
        const token = c.req.header('x-auth-token') || ''
        if (!token.startsWith('sess_')) return c.json({ error: 'Unauthorized' }, 401)

        const me = await c.env.DB.prepare(
            'SELECT email FROM users WHERE session_token = ?'
        ).bind(token).first() as { email?: string } | null
        if (!me?.email) return c.json({ error: 'Unauthorized' }, 401)

        const isOwner = await c.env.DB.prepare(
            'SELECT 1 FROM allowed_emails WHERE email = ? LIMIT 1'
        ).bind(String(me.email).trim().toLowerCase()).first()
        if (!isOwner) return c.json({ error: 'Forbidden' }, 403)

        const cacheKey = '_admin_cache/all_original_videos.json'
        const cached = await c.env.BUCKET.get(cacheKey)
        if (cached) {
            const payload = await cached.json() as { created_at?: string; videos?: unknown[] }
            const createdAt = payload?.created_at ? new Date(payload.created_at).getTime() : 0
            if (createdAt > 0 && (Date.now() - createdAt) < 60_000) {
                return c.json({ videos: payload.videos || [] }, 200, { 'Cache-Control': 'private, max-age=30', 'Vary': 'x-auth-token' })
            }
        }

        const namespaceEmailMap = new Map<string, string>()
        try {
            const nsRows = await c.env.DB.prepare(
                'SELECT namespace_id, MIN(email) AS email FROM users WHERE namespace_id IS NOT NULL AND TRIM(namespace_id) <> \'\' GROUP BY namespace_id'
            ).all() as { results?: Array<{ namespace_id?: string; email?: string }> }
            for (const row of nsRows.results || []) {
                const ns = String(row.namespace_id || '').trim()
                if (!ns) continue
                namespaceEmailMap.set(ns, String(row.email || '').trim().toLowerCase())
            }
        } catch {
            // Best effort only.
        }

        const videos: Array<{
            id: string
            video_id: string
            namespace_id: string
            owner_email: string
            original_url: string
            source_key: string
            created_at: string
            size: number
        }> = []

        let cursor: string | undefined = undefined
        do {
            const listed = await c.env.BUCKET.list({ prefix: '', cursor })
            for (const obj of listed.objects) {
                const key = String(obj.key || '')
                const match = key.match(/^([^/]+)\/videos\/(.+)_original\.mp4$/)
                if (!match) continue

                const namespaceId = String(match[1] || '').trim()
                const videoId = String(match[2] || '').trim()
                if (!namespaceId || !videoId) continue

                videos.push({
                    id: `${namespaceId}:${videoId}`,
                    video_id: videoId,
                    namespace_id: namespaceId,
                    owner_email: namespaceEmailMap.get(namespaceId) || '',
                    original_url: `${c.env.R2_PUBLIC_URL}/${namespaceId}/videos/${videoId}_original.mp4`,
                    source_key: key,
                    created_at: obj.uploaded.toISOString(),
                    size: Number(obj.size || 0),
                })
            }
            cursor = listed.truncated ? listed.cursor : undefined
        } while (cursor)

        videos.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

        await c.env.BUCKET.put(cacheKey, JSON.stringify({
            created_at: new Date().toISOString(),
            videos,
        }), {
            httpMetadata: { contentType: 'application/json' },
        })

        return c.json({ videos }, 200, { 'Cache-Control': 'private, max-age=30', 'Vary': 'x-auth-token' })
    } catch (e) {
        return c.json({ videos: [], error: String(e) }, 500)
    }
}

app.get('/api/admin/gallery/all-original', getAllOriginalGallery)
app.get('/api/gallery/all-original', getAllOriginalGallery)

app.put('/api/gallery/:id', async (c) => {
    const id = c.req.param('id')
    try {
        const body = await c.req.json() as { shopeeLink?: string; category?: string; title?: string }
        const metaObj = await c.get('bucket').get(`videos/${id}.json`)
        if (!metaObj) return c.json({ error: 'Video not found' }, 404)
        const meta = await metaObj.json() as Record<string, unknown>
        let changed = false
        if (body.shopeeLink !== undefined) {
            const normalizedShopeeLink = String(body.shopeeLink || '').trim()
            meta.shopeeLink = normalizedShopeeLink
            if (normalizedShopeeLink) {
                meta.linkSubmittedAt = new Date().toISOString()
            }
            changed = true
        }
        if (body.category !== undefined) {
            meta.category = body.category
            changed = true
        }
        if (body.title !== undefined) {
            meta.title = body.title
            changed = true
        }
        if (changed) {
            meta.updatedAt = new Date().toISOString()
        }
        await c.get('bucket').put(`videos/${id}.json`, JSON.stringify(meta, null, 2), {
            httpMetadata: { contentType: 'application/json' },
        })
        await updateGalleryCache(c.get('bucket'), id)
        return c.json({ success: true })
    } catch {
        return c.json({ error: 'Failed to update video' }, 500)
    }
})

app.delete('/api/gallery/:id', async (c) => {
    const id = c.req.param('id')
    const bucket = c.get('bucket')
    try {
        // Update cache first (fast: read 1 file, write 1 file) — user sees result instantly
        await removeFromGalleryCache(bucket, id)
        // Delete all R2 files in parallel + return response immediately
        c.executionCtx.waitUntil(Promise.all([
            bucket.delete(`videos/${id}.json`),
            bucket.delete(`videos/${id}.mp4`),
            bucket.delete(`videos/${id}_original.mp4`),
            bucket.delete(`videos/${id}_thumb.webp`),
        ]))
        return c.json({ success: true })
    } catch {
        return c.json({ error: 'Failed to delete video' }, 500)
    }
})

app.get('/api/gallery/:id', async (c) => {
    const id = c.req.param('id')
    try {
        const metaObj = await c.get('bucket').get(`videos/${id}.json`)
        if (!metaObj) return c.json({ error: 'ไม่พบวิดีโอ' }, 404)
        const metadata = await metaObj.json()
        return c.json(metadata)
    } catch {
        return c.json({ error: 'ไม่พบวิดีโอ' }, 404)
    }
})

// ==================== PAGES API ====================

const FB_GRAPH_V19 = 'https://graph.facebook.com/v19.0'
const FB_GRAPH_V21 = 'https://graph.facebook.com/v21.0'
const FACEBOOK_GRAPH_SDK_TIMEOUT_MS = 45000
const DEFAULT_BROWSERSAVING_WORKER_URL = 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev'
const DEFAULT_BROWSERSAVING_API_URL = 'https://browsersaving-api.lslly.com'
const BROWSERSAVING_SERVICE_BASE = 'service://browsersaving-worker'
const NS_SETTING_PAGES_SYNC_ENABLED = 'pages_sync_enabled'
const NS_SETTING_PAGES_SYNC_POST_SELECTORS = 'pages_sync_post_selectors'
const NS_SETTING_PAGES_SYNC_COMMENT_SELECTORS = 'pages_sync_comment_selectors'
const NS_SETTING_PAGES_SYNC_LAST_AT_MS = 'pages_sync_last_at_ms'
const NS_SETTING_PAGES_TOKEN_MIGRATE_LAST_AT_MS = 'pages_token_migrate_last_at_ms'
const NS_SETTING_PAGES_TOKEN_POOL_V1 = 'pages_token_pool_v1'
const NS_SETTING_GEMINI_API_KEY = 'gemini_api_key_v1'
const DEFAULT_PAGES_SYNC_POST_SELECTORS = 'tag:post'
const DEFAULT_PAGES_SYNC_COMMENT_SELECTORS = 'tag:comment'
const PAGES_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000
const PAGES_TOKEN_MIGRATE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

type FacebookErrorLike = {
    message?: string
    code?: number
    error_subcode?: number
}

type NamespacePagesSyncConfig = {
    enabled: boolean
    postSelectors: string[]
    commentSelectors: string[]
}

type PageTokenPoolEntry = {
    post_tokens: string[]
    comment_tokens: string[]
    updated_at?: string
}

type NamespacePageTokenPool = Record<string, PageTokenPoolEntry>

async function ensureNamespaceSettingsTable(db: D1Database) {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS namespace_settings (
            namespace_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (namespace_id, key)
        )`
    ).run()
}

function parseSelectorList(raw: string, fallback: string): string[] {
    const source = String(raw || '').trim() || fallback
    const out: string[] = []
    const seen = new Set<string>()
    for (const part of source.split(',')) {
        const selector = String(part || '').trim()
        if (!selector) continue
        const key = selector.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(selector)
    }
    return out
}

async function getNamespacePagesSyncConfig(db: D1Database, namespaceId: string): Promise<NamespacePagesSyncConfig> {
    await ensureNamespaceSettingsTable(db)
    const { results } = await db.prepare(
        `SELECT key, value
         FROM namespace_settings
         WHERE namespace_id = ?
           AND key IN (?, ?, ?)`
    ).bind(
        namespaceId,
        NS_SETTING_PAGES_SYNC_ENABLED,
        NS_SETTING_PAGES_SYNC_POST_SELECTORS,
        NS_SETTING_PAGES_SYNC_COMMENT_SELECTORS,
    ).all() as { results?: Array<{ key?: string; value?: string }> }

    const valueMap = new Map<string, string>()
    for (const row of results || []) {
        const key = String(row?.key || '').trim()
        if (!key) continue
        valueMap.set(key, String(row?.value || '').trim())
    }

    const hasExplicitEnabled = valueMap.has(NS_SETTING_PAGES_SYNC_ENABLED)
    const enabledRaw = String(valueMap.get(NS_SETTING_PAGES_SYNC_ENABLED) || '').trim().toLowerCase()
    let enabled = !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'off' || enabledRaw === 'no')

    // Legacy namespaces (non-numeric ids from older builds) are disabled by default
    // unless explicitly opted-in with pages_sync_enabled.
    if (!hasExplicitEnabled && !/^\d+$/.test(String(namespaceId || '').trim())) {
        enabled = false
    }

    const postSelectors = parseSelectorList(
        String(valueMap.get(NS_SETTING_PAGES_SYNC_POST_SELECTORS) || ''),
        DEFAULT_PAGES_SYNC_POST_SELECTORS,
    )
    const commentSelectors = parseSelectorList(
        String(valueMap.get(NS_SETTING_PAGES_SYNC_COMMENT_SELECTORS) || ''),
        DEFAULT_PAGES_SYNC_COMMENT_SELECTORS,
    )

    return { enabled, postSelectors, commentSelectors }
}

async function getNamespaceSettingMs(db: D1Database, namespaceId: string, key: string): Promise<number> {
    await ensureNamespaceSettingsTable(db)
    const row = await db.prepare(
        'SELECT value FROM namespace_settings WHERE namespace_id = ? AND key = ?'
    ).bind(namespaceId, key).first() as { value?: string } | null
    const parsed = Number(String(row?.value || '').trim())
    return Number.isFinite(parsed) ? parsed : 0
}

async function setNamespaceSettingMs(db: D1Database, namespaceId: string, key: string, valueMs: number): Promise<void> {
    await ensureNamespaceSettingsTable(db)
    const value = String(Math.max(0, Math.floor(Number(valueMs) || 0)))
    await db.prepare(
        `INSERT INTO namespace_settings (namespace_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(namespace_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')`
    ).bind(namespaceId, key, value).run()
}

function maskApiKeyForDisplay(rawValue: string): string {
    const value = String(rawValue || '').trim()
    if (!value) return ''
    if (value.length <= 8) {
        const left = value.slice(0, 2)
        const right = value.slice(-2)
        return `${left}...${right}`
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`
}

async function getNamespaceGeminiApiKeyEntry(db: D1Database, namespaceId: string): Promise<{ key: string; updatedAt: string | null }> {
    await ensureNamespaceSettingsTable(db)
    const row = await db.prepare(
        'SELECT value, updated_at FROM namespace_settings WHERE namespace_id = ? AND key = ?'
    ).bind(namespaceId, NS_SETTING_GEMINI_API_KEY).first() as { value?: string; updated_at?: string } | null
    return {
        key: String(row?.value || '').trim(),
        updatedAt: String(row?.updated_at || '').trim() || null,
    }
}

async function setNamespaceGeminiApiKey(db: D1Database, namespaceId: string, rawApiKey: string): Promise<void> {
    await ensureNamespaceSettingsTable(db)
    const apiKey = String(rawApiKey || '').trim().slice(0, MAX_GEMINI_API_KEY_CHARS)
    if (!apiKey) {
        await db.prepare(
            'DELETE FROM namespace_settings WHERE namespace_id = ? AND key = ?'
        ).bind(namespaceId, NS_SETTING_GEMINI_API_KEY).run()
        return
    }

    await db.prepare(
        `INSERT INTO namespace_settings (namespace_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(namespace_id, key)
         DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(namespaceId, NS_SETTING_GEMINI_API_KEY, apiKey).run()
}

async function resolveNamespaceGeminiApiKey(db: D1Database, namespaceId: string, fallbackApiKey?: string): Promise<string> {
    const workspace = await getNamespaceGeminiApiKeyEntry(db, namespaceId)
    if (workspace.key) return workspace.key
    return String(fallbackApiKey || '').trim()
}

async function getNamespaceGeminiApiKeySettings(db: D1Database, namespaceId: string, fallbackApiKey?: string) {
    const workspace = await getNamespaceGeminiApiKeyEntry(db, namespaceId)
    const fallback = String(fallbackApiKey || '').trim()
    const effective = workspace.key || fallback
    const source: 'workspace' | 'global' | 'none' = workspace.key
        ? 'workspace'
        : fallback
            ? 'global'
            : 'none'
    return {
        has_key: !!effective,
        masked_key: maskApiKeyForDisplay(effective),
        source,
        updated_at: workspace.updatedAt,
    }
}

async function getNamespacePagesLastSyncAtMs(db: D1Database, namespaceId: string): Promise<number> {
    return getNamespaceSettingMs(db, namespaceId, NS_SETTING_PAGES_SYNC_LAST_AT_MS)
}

async function setNamespacePagesLastSyncAtMs(db: D1Database, namespaceId: string, valueMs: number): Promise<void> {
    await setNamespaceSettingMs(db, namespaceId, NS_SETTING_PAGES_SYNC_LAST_AT_MS, valueMs)
}

async function getNamespacePagesTokenMigrateLastAtMs(db: D1Database, namespaceId: string): Promise<number> {
    return getNamespaceSettingMs(db, namespaceId, NS_SETTING_PAGES_TOKEN_MIGRATE_LAST_AT_MS)
}

async function setNamespacePagesTokenMigrateLastAtMs(db: D1Database, namespaceId: string, valueMs: number): Promise<void> {
    await setNamespaceSettingMs(db, namespaceId, NS_SETTING_PAGES_TOKEN_MIGRATE_LAST_AT_MS, valueMs)
}

function uniqueTokens(raw: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of raw) {
        const token = String(item || '').trim()
        if (!token) continue
        const key = token.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(token)
    }
    return out
}

function isTokenString(token: string): boolean {
    return !!String(token || '').trim()
}

function isCommentRoleToken(token: string): boolean {
    const t = String(token || '').trim()
    if (!t) return false
    return t.toUpperCase().startsWith('EAAD6')
}

function isPostRoleToken(token: string): boolean {
    return isTokenString(token)
}

function normalizePostTokenPool(tokens: string[]): string[] {
    return uniqueTokens(tokens.filter((t) => isPostRoleToken(t)))
}

function normalizeCommentTokenPool(tokens: string[]): string[] {
    return uniqueTokens(tokens.filter((t) => isCommentRoleToken(t)))
}

function preferCommentToken(existingRaw: string, candidateRaw: string): string {
    const existing = String(existingRaw || '').trim()
    const candidate = String(candidateRaw || '').trim()
    if (isCommentRoleToken(existing)) return existing
    if (isCommentRoleToken(candidate)) return candidate
    if (existing) return existing
    return candidate
}

async function getNamespacePagesTokenPool(db: D1Database, namespaceId: string): Promise<NamespacePageTokenPool> {
    await ensureNamespaceSettingsTable(db)
    const row = await db.prepare(
        'SELECT value FROM namespace_settings WHERE namespace_id = ? AND key = ?'
    ).bind(namespaceId, NS_SETTING_PAGES_TOKEN_POOL_V1).first() as { value?: string } | null

    const raw = String(row?.value || '').trim()
    if (!raw) return {}

    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object') return {}
        const out: NamespacePageTokenPool = {}
        for (const [pageIdRaw, entryRaw] of Object.entries(parsed)) {
            const pageId = String(pageIdRaw || '').trim()
            if (!pageId || !entryRaw || typeof entryRaw !== 'object') continue
            const entryObj = entryRaw as Record<string, unknown>
            const postTokens = normalizePostTokenPool(Array.isArray(entryObj.post_tokens) ? entryObj.post_tokens.map((x) => String(x || '')) : [])
            const commentTokens = normalizeCommentTokenPool(Array.isArray(entryObj.comment_tokens) ? entryObj.comment_tokens.map((x) => String(x || '')) : [])
            out[pageId] = {
                post_tokens: postTokens,
                comment_tokens: commentTokens,
                updated_at: typeof entryObj.updated_at === 'string' ? entryObj.updated_at : undefined,
            }
        }
        return out
    } catch {
        return {}
    }
}

async function setNamespacePagesTokenPool(db: D1Database, namespaceId: string, pool: NamespacePageTokenPool): Promise<void> {
    await ensureNamespaceSettingsTable(db)
    const normalized: NamespacePageTokenPool = {}
    for (const [pageIdRaw, entryRaw] of Object.entries(pool || {})) {
        const pageId = String(pageIdRaw || '').trim()
        if (!pageId || !entryRaw) continue
        const postTokens = normalizePostTokenPool(Array.isArray(entryRaw.post_tokens) ? entryRaw.post_tokens : [])
        const commentTokens = normalizeCommentTokenPool(Array.isArray(entryRaw.comment_tokens) ? entryRaw.comment_tokens : [])
        if (postTokens.length === 0 && commentTokens.length === 0) continue
        normalized[pageId] = {
            post_tokens: postTokens,
            comment_tokens: commentTokens,
            updated_at: entryRaw.updated_at || new Date().toISOString(),
        }
    }

    const value = JSON.stringify(normalized)
    await db.prepare(
        `INSERT INTO namespace_settings (namespace_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(namespace_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')`
    ).bind(namespaceId, NS_SETTING_PAGES_TOKEN_POOL_V1, value).run()
}

async function getPageTokenCandidates(params: {
    db: D1Database
    namespaceId: string
    pageId: string
    primaryPostToken?: string | null
    primaryCommentToken?: string | null
}): Promise<{ postTokens: string[]; commentTokens: string[] }> {
    const pageId = String(params.pageId || '').trim()
    const primaryPost = String(params.primaryPostToken || '').trim()
    const primaryComment = String(params.primaryCommentToken || '').trim()

    const pool = await getNamespacePagesTokenPool(params.db, params.namespaceId)
    const entry = pool[pageId]

    const postTokens = normalizePostTokenPool([
        primaryPost,
        ...(entry?.post_tokens || []),
    ])
    const commentTokens = normalizeCommentTokenPool([
        primaryComment,
        ...(entry?.comment_tokens || []),
    ])

    return { postTokens, commentTokens }
}

function getFacebookErrorMessage(rawError: unknown): string {
    const parsed = parseFacebookErrorLike(rawError)
    return String(parsed?.message || (rawError instanceof Error ? rawError.message : String(rawError))).trim()
}

function shouldAttemptFacebookBarrierAutoRecover(rawError: unknown): boolean {
    const message = getFacebookErrorMessage(rawError).toLowerCase()
    if (!message) return false
    return message.includes('you cannot access the app till you log in to www.facebook.com')
        || message.includes('log in to www.facebook.com and follow the instructions')
        || message.includes('follow the instructions given')
        || message.includes('facebook checkpoint')
        || message.includes('facebook.com/checkpoint')
        || message.includes('facebook_checkpoint')
        || message.includes('facebook_automated_behavior')
        || message.includes('automated behavior')
        || message.includes('พฤติกรรมอัตโนมัติ')
}

async function refreshPagePostTokensFromBrowserSaving(params: {
    env: Env
    db: D1Database
    namespaceId: string
    pageId: string
    pageName: string
    currentPostTokens: string[]
    logPrefix: string
}): Promise<{ postTokens: string[]; profileCount: number; errors: string[] }> {
    const namespaceId = String(params.namespaceId || '').trim()
    const pageId = String(params.pageId || '').trim()
    const pageName = String(params.pageName || '').trim()
    if (!namespaceId || !pageId) {
        throw new Error('checkpoint_recover_invalid_namespace_or_page')
    }

    const cfg = await getNamespacePagesSyncConfig(params.db, namespaceId)
    if (!cfg.enabled) throw new Error('checkpoint_recover_pages_sync_disabled')

    const profiles = await fetchBrowserSavingProfiles(params.env)
    const postProfiles = collectProfilesBySelectors(profiles, cfg.postSelectors)
    const pageProfiles = postProfiles.filter((profile) => matchesProfileToPage(profile, pageId, pageName))
    if (pageProfiles.length === 0) {
        throw new Error(`checkpoint_recover_no_post_profile_for_page:${pageId}`)
    }

    const resolved = await resolveTaggedProfilesToPageRecords(pageProfiles, params.env, 'post')
    const records = resolved.byId.get(pageId) || []
    const resolvedTokens = normalizePostTokenPool(records.map((record) => String(record.access_token || '').trim()))
    if (resolvedTokens.length === 0) {
        const details = resolved.errors.join(' | ') || 'no_token_after_profile_resolve'
        throw new Error(`checkpoint_recover_no_token:${details}`)
    }

    const mergedTokens = normalizePostTokenPool([
        ...resolvedTokens,
        ...(params.currentPostTokens || []),
    ])
    const primary = String(mergedTokens[0] || '').trim()
    if (!primary) {
        throw new Error('checkpoint_recover_primary_token_missing')
    }

    await params.db.prepare(
        'UPDATE pages SET access_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
    ).bind(primary, pageId, namespaceId).run()

    try {
        const tokenPool = await getNamespacePagesTokenPool(params.db, namespaceId)
        const existingEntry = tokenPool[pageId] || { post_tokens: [], comment_tokens: [] }
        tokenPool[pageId] = {
            post_tokens: normalizePostTokenPool([
                ...mergedTokens,
                ...(existingEntry.post_tokens || []),
            ]),
            comment_tokens: normalizeCommentTokenPool(existingEntry.comment_tokens || []),
            updated_at: new Date().toISOString(),
        }
        await setNamespacePagesTokenPool(params.db, namespaceId, tokenPool)
    } catch (e) {
        console.log(`[${params.logPrefix}] checkpoint recover: token pool update skipped (${e instanceof Error ? e.message : String(e)})`)
    }

    return {
        postTokens: mergedTokens,
        profileCount: pageProfiles.length,
        errors: resolved.errors,
    }
}

async function initReelUploadWithPostingTokenAutoRecover(params: {
    env: Env
    db: D1Database
    namespaceId: string
    pageId: string
    pageName: string
    postTokens: string[]
    logPrefix: string
}): Promise<{
    video_id?: string
    upload_url?: string
    postingToken: string
    tried: number
}> {
    const initialTokens = normalizePostTokenPool(params.postTokens || [])
    try {
        return await initReelUploadWithPostingTokenFallback({
            pageId: params.pageId,
            postTokens: initialTokens,
            logPrefix: params.logPrefix,
        })
    } catch (firstErr) {
        if (!shouldAttemptFacebookBarrierAutoRecover(firstErr)) throw firstErr

        console.warn(`[${params.logPrefix}] checkpoint/automated barrier detected. Trying BrowserSaving auto-recover + retry...`)

        let recoveredTokens = initialTokens
        try {
            const refreshed = await refreshPagePostTokensFromBrowserSaving({
                env: params.env,
                db: params.db,
                namespaceId: params.namespaceId,
                pageId: params.pageId,
                pageName: params.pageName,
                currentPostTokens: initialTokens,
                logPrefix: params.logPrefix,
            })
            recoveredTokens = refreshed.postTokens
            console.log(
                `[${params.logPrefix}] checkpoint recover success: profiles=${refreshed.profileCount} tokens=${recoveredTokens.length} warnings=${refreshed.errors.length}`,
            )
        } catch (recoverErr) {
            console.error(`[${params.logPrefix}] checkpoint recover failed: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`)
            throw firstErr
        }

        try {
            const retried = await initReelUploadWithPostingTokenFallback({
                pageId: params.pageId,
                postTokens: recoveredTokens,
                logPrefix: `${params.logPrefix} RECOVER-RETRY`,
            })
            return retried
        } catch (retryErr) {
            const firstMsg = getFacebookErrorMessage(firstErr)
            const retryMsg = getFacebookErrorMessage(retryErr)
            throw new Error(`post_retry_after_checkpoint_failed: ${firstMsg || 'unknown_first_error'} | ${retryMsg || 'unknown_retry_error'}`)
        }
    }
}

async function getPostedVideoIds(params: {
    db: D1Database
    namespaceId?: string
}): Promise<Set<string>> {
    const namespaceId = String(params.namespaceId || '').trim()
    const hasNamespace = !!namespaceId

    const sql = hasNamespace
        ? `SELECT DISTINCT video_id
           FROM post_history
           WHERE bot_id = ?
             AND (
               status IN ('success', 'posting')
               OR TRIM(COALESCE(fb_post_id, '')) <> ''
               OR TRIM(COALESCE(fb_reel_url, '')) <> ''
             )`
        : `SELECT DISTINCT video_id
           FROM post_history
           WHERE status IN ('success', 'posting')
              OR TRIM(COALESCE(fb_post_id, '')) <> ''
              OR TRIM(COALESCE(fb_reel_url, '')) <> ''`

    const result = hasNamespace
        ? await params.db.prepare(sql).bind(namespaceId).all() as { results?: Array<{ video_id?: string }> }
        : await params.db.prepare(sql).all() as { results?: Array<{ video_id?: string }> }

    const out = new Set<string>()
    for (const row of result.results || []) {
        const id = String(row?.video_id || '').trim()
        if (id) out.add(id)
    }
    return out
}

async function getConfirmedPostedVideoIds(params: {
    db: D1Database
    namespaceId?: string
}): Promise<Set<string>> {
    const namespaceId = String(params.namespaceId || '').trim()
    const hasNamespace = !!namespaceId
    const sql = hasNamespace
        ? `SELECT DISTINCT video_id
           FROM post_history
           WHERE bot_id = ?
             AND TRIM(COALESCE(fb_post_id, '')) <> ''`
        : `SELECT DISTINCT video_id
           FROM post_history
           WHERE TRIM(COALESCE(fb_post_id, '')) <> ''`

    const result = hasNamespace
        ? await params.db.prepare(sql).bind(namespaceId).all() as { results?: Array<{ video_id?: string }> }
        : await params.db.prepare(sql).all() as { results?: Array<{ video_id?: string }> }

    const out = new Set<string>()
    for (const row of result.results || []) {
        const id = String(row?.video_id || '').trim()
        if (id) out.add(id)
    }
    return out
}

async function getPostingVideoIds(params: {
    db: D1Database
    namespaceId?: string
}): Promise<Set<string>> {
    const namespaceId = String(params.namespaceId || '').trim()
    const hasNamespace = !!namespaceId
    const sql = hasNamespace
        ? `SELECT DISTINCT video_id FROM post_history WHERE bot_id = ? AND status = 'posting'`
        : `SELECT DISTINCT video_id FROM post_history WHERE status = 'posting'`
    const result = hasNamespace
        ? await params.db.prepare(sql).bind(namespaceId).all() as { results?: Array<{ video_id?: string }> }
        : await params.db.prepare(sql).all() as { results?: Array<{ video_id?: string }> }
    const out = new Set<string>()
    for (const row of result.results || []) {
        const id = String(row?.video_id || '').trim()
        if (id) out.add(id)
    }
    return out
}

async function ensureLinkSubmissionsTable(db: D1Database): Promise<void> {
    await db.prepare(
        `CREATE TABLE IF NOT EXISTS link_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace_id TEXT NOT NULL,
            telegram_id TEXT NOT NULL,
            video_id TEXT NOT NULL,
            shopee_link TEXT NOT NULL,
            created_at TEXT NOT NULL
        )`
    ).run()

    await db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_link_submissions_ns_created ON link_submissions(namespace_id, created_at)'
    ).run()
    await db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_link_submissions_ns_tg_created ON link_submissions(namespace_id, telegram_id, created_at)'
    ).run()
    await db.prepare(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_link_submissions_ns_video ON link_submissions(namespace_id, video_id)'
    ).run()
}

async function recordLinkSubmission(params: {
    db: D1Database
    namespaceId: string
    telegramId: string
    videoId: string
    shopeeLink: string
    createdAt?: string
}): Promise<void> {
    const namespaceId = String(params.namespaceId || '').trim()
    const telegramId = String(params.telegramId || '').trim()
    const videoId = String(params.videoId || '').trim()
    const shopeeLink = String(params.shopeeLink || '').trim()
    const createdAt = String(params.createdAt || '').trim() || new Date().toISOString()
    if (!namespaceId || !telegramId || !videoId || !shopeeLink) return

    await ensureLinkSubmissionsTable(params.db)
    await params.db.prepare(
        `INSERT OR IGNORE INTO link_submissions
            (namespace_id, telegram_id, video_id, shopee_link, created_at)
         VALUES (?, ?, ?, ?, ?)`
    ).bind(namespaceId, telegramId, videoId, shopeeLink, createdAt).run()
}

class FacebookRequestFailedError extends Error {
    code: number
    subcode: number
    constructor(message: string, code = 0, subcode = 0) {
        super(message)
        this.name = 'FacebookRequestFailedError'
        this.code = code
        this.subcode = subcode
    }
}

function parseFacebookErrorLike(raw: unknown): FacebookErrorLike | null {
    const src = raw as any
    const candidates = [
        src?.error,
        src?.response?.data?.error,
        src?.response?.error,
        src?.response?.body?.error,
    ]

    for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object') {
            const message = typeof candidate.message === 'string' ? candidate.message : ''
            if (message) {
                return {
                    message,
                    code: Number(candidate.code || 0),
                    error_subcode: Number(candidate.error_subcode || 0),
                }
            }
        }
    }

    const fallbackMessage = typeof src?.message === 'string' ? src.message : ''
    if (fallbackMessage) return { message: fallbackMessage, code: 0, error_subcode: 0 }
    return null
}

function toFacebookRequestFailedError(raw: unknown, fallbackMessage: string): FacebookRequestFailedError {
    const parsed = parseFacebookErrorLike(raw)
    return new FacebookRequestFailedError(
        parsed?.message || fallbackMessage,
        Number(parsed?.code || 0),
        Number(parsed?.error_subcode || 0),
    )
}

function buildFacebookGraphUrl(path: string, query: Record<string, string | number | undefined>): string {
    const url = new URL(path)
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(key, String(value))
    }
    return url.toString()
}

async function withFacebookSdkTimeout<T>(task: Promise<T>, actionLabel: string): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    try {
        return await Promise.race<T>([
            task,
            new Promise<T>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new FacebookRequestFailedError(`${actionLabel}_timeout_${FACEBOOK_GRAPH_SDK_TIMEOUT_MS}ms`, 0, 0))
                }, FACEBOOK_GRAPH_SDK_TIMEOUT_MS)
            }),
        ])
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
    }
}

async function facebookGraphRawGet<T>(
    path: string,
    query: Record<string, string | number | undefined>,
): Promise<T> {
    const url = buildFacebookGraphUrl(path, query)
    const resp = await fetchWithTimeout(url, { method: 'GET' }, FACEBOOK_GRAPH_SDK_TIMEOUT_MS, 'facebook_graph_raw_get')
    const data = await resp.json().catch(() => ({}))
    const graphErr = parseFacebookErrorLike(data)
    if (!resp.ok || graphErr?.message) {
        const message = graphErr?.message || `facebook_graph_raw_get_http_${resp.status}`
        throw new FacebookRequestFailedError(message, Number(graphErr?.code || 0), Number(graphErr?.error_subcode || 0))
    }
    return data as T
}

async function facebookGraphRawPost<T>(
    path: string,
    body: Record<string, string | number | boolean | undefined>,
): Promise<T> {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === null || value === '') continue
        form.set(key, String(value))
    }
    const resp = await fetchWithTimeout(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
    }, FACEBOOK_GRAPH_SDK_TIMEOUT_MS, 'facebook_graph_raw_post')
    const data = await resp.json().catch(() => ({}))
    const graphErr = parseFacebookErrorLike(data)
    if (!resp.ok || graphErr?.message) {
        const message = graphErr?.message || `facebook_graph_raw_post_http_${resp.status}`
        throw new FacebookRequestFailedError(message, Number(graphErr?.code || 0), Number(graphErr?.error_subcode || 0))
    }
    return data as T
}

async function facebookGraphGet<T>(
    accessToken: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
): Promise<T> {
    const token = String(accessToken || '').trim()
    if (!token) throw new FacebookRequestFailedError('facebook_access_token_missing', 0, 0)
    const fbApi = await getFacebookAdsApi()
    const api = fbApi.init(token)
    const url = buildFacebookGraphUrl(path, { ...query, access_token: token })
    try {
        const result = await withFacebookSdkTimeout(api.call('GET', url), 'facebook_graph_get')
        const graphErr = parseFacebookErrorLike(result)
        if (graphErr?.message) {
            throw new FacebookRequestFailedError(graphErr.message, Number(graphErr.code || 0), Number(graphErr.error_subcode || 0))
        }
        return result as T
    } catch (err) {
        throw toFacebookRequestFailedError(err, 'facebook_graph_get_failed')
    }
}

async function facebookGraphPost<T>(
    accessToken: string,
    path: string,
    body: Record<string, unknown>,
): Promise<T> {
    const token = String(accessToken || '').trim()
    if (!token) throw new FacebookRequestFailedError('facebook_access_token_missing', 0, 0)
    const fbApi = await getFacebookAdsApi()
    const api = fbApi.init(token)
    try {
        const result = await withFacebookSdkTimeout(api.call('POST', path, {
            ...body,
            access_token: token,
        }), 'facebook_graph_post')
        const graphErr = parseFacebookErrorLike(result)
        if (graphErr?.message) {
            throw new FacebookRequestFailedError(graphErr.message, Number(graphErr.code || 0), Number(graphErr.error_subcode || 0))
        }
        return result as T
    } catch (err) {
        throw toFacebookRequestFailedError(err, 'facebook_graph_post_failed')
    }
}

async function facebookGraphDelete(
    accessToken: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
): Promise<void> {
    const token = String(accessToken || '').trim()
    if (!token) throw new FacebookRequestFailedError('facebook_access_token_missing', 0, 0)
    const fbApi = await getFacebookAdsApi()
    const api = fbApi.init(token)
    const url = buildFacebookGraphUrl(path, { ...query, access_token: token })
    try {
        const result = await withFacebookSdkTimeout(api.call('DELETE', url), 'facebook_graph_delete')
        const graphErr = parseFacebookErrorLike(result)
        if (graphErr?.message) {
            throw new FacebookRequestFailedError(graphErr.message, Number(graphErr.code || 0), Number(graphErr.error_subcode || 0))
        }
    } catch (err) {
        throw toFacebookRequestFailedError(err, 'facebook_graph_delete_failed')
    }
}

type BrowserSavingTokenMode = 'post' | 'comment'
type AutoSyncTokenCandidate = {
    token: string
    selector: string
    mode: BrowserSavingTokenMode
    reason?: string
    profileId?: string
    profileName?: string
}

type BrowserSavingProfileRecord = {
    id?: string
    name?: string
    tags?: unknown
    deleted_at?: string | null
    page_name?: string
    page_avatar_url?: string
    uid?: string
    username?: string
    facebook_token?: string
    postcron_token?: string
    comment_token?: string
}

function looksLikeBrowserSavingProfileId(raw: string): boolean {
    const value = String(raw || '').trim()
    // Accept standard UUID format used by BrowserSaving profile IDs.
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function parseBrowserSavingTagSelector(raw: string): string | null {
    const input = String(raw || '').trim()
    const match = input.match(/^tag:(.+)$/i)
    if (!match) return null
    const tag = String(match[1] || '').trim().toLowerCase()
    return tag || null
}

function hasBrowserSavingServiceBinding(env: Env): env is Env & { BROWSERSAVING_SERVICE: Fetcher } {
    const maybe = (env as any)?.BROWSERSAVING_SERVICE
    return !!maybe && typeof maybe.fetch === 'function'
}

function buildBrowserSavingBaseUrls(env: Env): string[] {
    const candidates = [
        hasBrowserSavingServiceBinding(env) ? BROWSERSAVING_SERVICE_BASE : '',
        DEFAULT_BROWSERSAVING_WORKER_URL,
        String(env.BROWSERSAVING_WORKER_URL || '').trim(),
        String(env.BROWSERSAVING_API_URL || '').trim(),
        DEFAULT_BROWSERSAVING_API_URL,
    ]

    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of candidates) {
        const base = String(raw || '').trim().replace(/\/+$/, '')
        if (!base) continue
        const key = base.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(base)
    }
    return out
}

function buildBrowserSavingRequestLabel(base: string, path: string): string {
    const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`
    if (base === BROWSERSAVING_SERVICE_BASE) return `service:browsersaving-worker${normalizedPath}`
    return `${base}${normalizedPath}`
}

async function fetchFromBrowserSavingBase(
    env: Env,
    base: string,
    path: string,
    init?: RequestInit,
): Promise<Response> {
    const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`
    if (base === BROWSERSAVING_SERVICE_BASE) {
        if (!hasBrowserSavingServiceBinding(env)) {
            throw new Error('service_binding_missing:BROWSERSAVING_SERVICE')
        }
        // Service binding call avoids cross-worker workers.dev 404 from edge egress.
        return env.BROWSERSAVING_SERVICE.fetch(`https://browsersaving-worker${normalizedPath}`, init)
    }
    return fetch(`${base}${normalizedPath}`, init)
}

function normalizeBrowserSavingProfileTags(raw: unknown): string[] {
    const out: string[] = []
    const seen = new Set<string>()

    const pushTag = (value: unknown) => {
        const tag = String(value || '').trim().toLowerCase()
        if (!tag || seen.has(tag)) return
        seen.add(tag)
        out.push(tag)
    }

    if (Array.isArray(raw)) {
        for (const item of raw) pushTag(item)
    } else if (typeof raw === 'string') {
        const text = raw.trim()
        if (text.startsWith('[') && text.endsWith(']')) {
            try {
                const parsed = JSON.parse(text)
                if (Array.isArray(parsed)) {
                    for (const item of parsed) pushTag(item)
                }
            } catch {
                // fallback below
            }
        }
        if (out.length === 0) {
            for (const part of text.split(',')) pushTag(part)
        }
    }

    return out
}

async function fetchBrowserSavingProfiles(env: Env): Promise<BrowserSavingProfileRecord[]> {
    const endpointBases = buildBrowserSavingBaseUrls(env)

    const errors: string[] = []
    for (const base of endpointBases) {
        const path = '/api/profiles'
        const label = buildBrowserSavingRequestLabel(base, path)
        try {
            const resp = await fetchFromBrowserSavingBase(env, base, path, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            })
            const data = await resp.json().catch(() => null)
            if (!resp.ok) {
                const details = typeof data === 'object' && data
                    ? String((data as any)?.error || (data as any)?.details || `HTTP ${resp.status}`)
                    : `HTTP ${resp.status}`
                errors.push(`${label}: ${details}`)
                continue
            }
            if (!Array.isArray(data)) {
                errors.push(`${label}: invalid_profiles_payload`)
                continue
            }
            return data as BrowserSavingProfileRecord[]
        } catch (e) {
            errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    throw new Error(`browsersaving_profiles_fetch_failed: ${errors.join(' | ') || 'no_endpoint_available'}`)
}

function collectProfilesBySelectors(
    profiles: BrowserSavingProfileRecord[],
    selectors: string[],
): BrowserSavingProfileRecord[] {
    const selected: BrowserSavingProfileRecord[] = []
    const seen = new Set<string>()

    const pushProfile = (profile: BrowserSavingProfileRecord | null | undefined) => {
        if (!profile || profile.deleted_at) return
        const id = String(profile.id || '').trim()
        if (!id) return
        const key = id.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        selected.push(profile)
    }

    for (const selectorRaw of selectors) {
        const selector = String(selectorRaw || '').trim()
        if (!selector) continue

        const tag = parseBrowserSavingTagSelector(selector)
        if (tag) {
            for (const profile of profiles) {
                const tags = normalizeBrowserSavingProfileTags(profile.tags)
                if (tags.includes(tag)) pushProfile(profile)
            }
            continue
        }

        if (looksLikeBrowserSavingProfileId(selector)) {
            pushProfile(profiles.find((profile) => String(profile.id || '').trim().toLowerCase() === selector.toLowerCase()))
        }
    }

    return selected
}

function parsePageIdFromAvatarUrl(raw: string): string {
    const input = String(raw || '').trim()
    if (!input) return ''

    const pageAvatarMatch = input.match(/\/page-avatars\/(\d+)(?:[./?]|$)/i)
    if (pageAvatarMatch?.[1]) return String(pageAvatarMatch[1]).trim()

    const graphMatch = input.match(/graph\.facebook\.com\/(\d+)\/picture/i)
    if (graphMatch?.[1]) return String(graphMatch[1]).trim()

    return ''
}

function isLikelyNumericFacebookId(raw: string): boolean {
    return /^\d+$/.test(String(raw || '').trim())
}

function normalizePageName(raw: string): string {
    return String(raw || '').trim().toLowerCase()
}

const COMMENT_MESSAGE_TEMPLATE_TEXT = `
📌 พิกัดอยู่ตรงนี้ :
🔎 เผื่อใครกำลังหาอยู่ :
✨ ของน่าสนใจ ลองดู :
📍 แปะพิกัดไว้ให้ :
💬 มีคนถามมา เลยเอามาแปะ :
🛒 ลองดูตัวนี้ :
👀 ใครกำลังมองหาอยู่ :
📦 เจอมาเลยเอามาฝาก :
💡 เผื่อมีคนสนใจ :
⭐ ตัวนี้น่าสนใจดี :
📍 เผื่อกำลังหาอยู่ :
🔗 แปะลิงก์ไว้ตรงนี้ :
🧾 เผื่อมีคนกำลังหา :
🛍️ ตัวนี้น่าลอง :
👇 ลองดูรายละเอียด :
📢 เอามาฝากเผื่อถูกใจ :
🔎 ลองเข้าไปดู :
🧩 เผื่อใครกำลังมองหา :
📌 ของน่าสนใจเลย :
🛒 ใครกำลังดูอยู่ :
⭐ เผื่อมีคนอยากรู้ :
📍 ตัวนี้น่าสนใจ :
🔗 ลิงก์อยู่ตรงนี้ :
💬 เผื่อมีคนกำลังหาอยู่ :
👀 ลองเข้าไปส่องดู :
📦 เจอแล้วเอามาแชร์ :
🛍️ แปะพิกัดไว้ :
✨ ของน่าสนใจอีกตัว :
📌 เผื่อกำลังมองหา :
🔎 ลองดูข้อมูล :
🧾 ใครกำลังหาอยู่ :
👇 กดดูรายละเอียด :
📢 เผื่อมีคนสนใจตัวนี้ :
🛒 ตัวนี้ดูโอเค :
📍 ลองดูตัวนี้ :
⭐ ของดีอีกตัว :
💡 เผื่อกำลังเลือกอยู่ :
🔗 ลองเข้าไปดูข้อมูล :
📦 แปะไว้เผื่อมีคนถาม :
👀 ใครกำลังหาแบบนี้ :
🛍️ เผื่อถูกใจ :
📌 ตัวนี้น่าสนใจนะ :
🔎 เผื่อกำลังดูอยู่ :
📍 ลองดูรายละเอียด :
⭐ เผื่อกำลังมองหาอยู่ :
💬 เอามาฝากเผื่อสนใจ :
🛒 เผื่อใครกำลังหา :
📦 ลองเข้าไปดูรายละเอียด :
👇 พิกัดตามนี้ :
✨ ตัวนี้น่าสนใจดีนะ :
📌 เผื่อกำลังสนใจ :
🔗 ลองดูตัวนี้ก่อน :
🛍️ เผื่อมีคนกำลังมองหา :
👀 แปะไว้ให้ดู :
📍 ของน่าสนใจ :
⭐ ลองเข้าไปดูหน่อย :
🔎 เผื่อกำลังหาแบบนี้ :
💡 เอามาแชร์ :
🛒 เผื่อกำลังตัดสินใจ :
📦 ของดีอีกตัวหนึ่ง :
👇 ใครสนใจลองดู :
📌 ลองดูข้อมูลก่อน :
🛍️ เผื่อกำลังมองหาอยู่ :
🔗 พิกัดตามลิงก์นี้ :
⭐ ตัวนี้ดูดีนะ :
👀 เผื่อใครสนใจ :
📍 แปะลิงก์ไว้ :
🛒 ลองดูเผื่อถูกใจ :
🔎 ของน่าสนใจมาก :
📦 เผื่อกำลังหาอยู่พอดี :
💬 ลองดูตัวนี้ก่อน :
⭐ เผื่อมีคนกำลังหา :
📌 ของน่าสนใจเลย :
🛍️ ลองเข้าไปส่อง :
👇 เผื่อมีคนอยากรู้ :
🔗 เผื่อใครกำลังเล็ง :
📍 ตัวนี้น่าสนใจจริง :
🛒 ลองดูข้อมูลเพิ่มเติม :
👀 เผื่อกำลังหาอยู่พอดี :
📦 เอามาฝาก :
⭐ ลองเข้าไปดูตัวนี้ :
📌 เผื่อมีคนกำลังสนใจ :
🛍️ ของน่าสนใจอีกชิ้น :
🔎 ลองดูรายละเอียดก่อน :
👇 เผื่อใครกำลังมองหา :
📍 ลองดูเผื่อใช่ :
⭐ เผื่อกำลังจะซื้อ :
🛒 ตัวนี้ดูน่าสนใจ :
🔗 เผื่อมีคนกำลังหาอยู่ :
📦 ลองดูตัวนี้นะ :
👀 เผื่อกำลังเล็งอยู่ :
📌 ของน่าสนใจมาก :
🛍️ ใครกำลังดูอยู่ :
⭐ ลองเข้าไปดูข้อมูล :
🔎 เผื่อใครกำลังหาแบบนี้ :
👇 ลองดูตัวนี้ :
📍 เผื่อมีคนกำลังสนใจ :
🛒 ลองดูเผื่อโอเค :
📦 แปะพิกัดให้ :
⭐ เผื่อใครกำลังมองหาอยู่ :
`

const COMMENT_MESSAGE_TEMPLATES = COMMENT_MESSAGE_TEMPLATE_TEXT
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

function pickRandomCommentTemplate(): string {
    if (COMMENT_MESSAGE_TEMPLATES.length === 0) return '📍 พิกัดอยู่ตรงนี้ :'
    try {
        const buf = new Uint32Array(1)
        crypto.getRandomValues(buf)
        return COMMENT_MESSAGE_TEMPLATES[buf[0] % COMMENT_MESSAGE_TEMPLATES.length]
    } catch {
        return COMMENT_MESSAGE_TEMPLATES[Math.floor(Math.random() * COMMENT_MESSAGE_TEMPLATES.length)]
    }
}

function buildShopeeCommentMessage(shopeeLink: string): string {
    const link = String(shopeeLink || '').trim()
    const prefix = pickRandomCommentTemplate()
    return `${prefix}\n${link}`
}

function pickProfilePostToken(profile: BrowserSavingProfileRecord): string {
    const postToken = String(profile.postcron_token || '').trim()
    return isPostRoleToken(postToken) ? postToken : ''
}

function pickProfileCommentToken(profile: BrowserSavingProfileRecord): string {
    const commentToken = String(profile.comment_token || '').trim()
    return isCommentRoleToken(commentToken) ? commentToken : ''
}

function matchesProfileToPage(profile: BrowserSavingProfileRecord, pageId: string, pageName: string): boolean {
    const targetId = String(pageId || '').trim()
    const targetName = normalizePageName(pageName)

    const pageIdFromAvatar = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''))
    if (targetId && pageIdFromAvatar && pageIdFromAvatar === targetId) return true

    const profilePageName = normalizePageName(String(profile.page_name || profile.name || ''))
    if (targetName && profilePageName && profilePageName === targetName) return true

    return false
}

function pickTargetPageForProfile(
    profile: BrowserSavingProfileRecord,
    accounts: Array<{ id?: string; name?: string; access_token?: string }>,
): { id: string; name: string; access_token: string } | null {
    if (!Array.isArray(accounts) || accounts.length === 0) return null

    const targetNameRaw = String(profile.page_name || '').trim()
    const targetName = targetNameRaw.toLowerCase()
    if (targetName) {
        const exact = accounts.find((account) => String(account?.name || '').trim().toLowerCase() === targetName)
        if (exact) {
            const id = String(exact.id || '').trim()
            const accessToken = String(exact.access_token || '').trim()
            const name = String(exact.name || '').trim() || targetNameRaw || id
            if (id && accessToken) return { id, name, access_token: accessToken }
        }
    }

    const pageIdFromAvatar = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''))
    if (pageIdFromAvatar) {
        const matched = accounts.find((account) => String(account?.id || '').trim() === pageIdFromAvatar)
        if (matched) {
            const id = String(matched.id || '').trim()
            const accessToken = String(matched.access_token || '').trim()
            const name = String(matched.name || '').trim() || targetNameRaw || id
            if (id && accessToken) return { id, name, access_token: accessToken }
        }
    }

    // Last resort: if account list has one page only, use it.
    if (accounts.length === 1) {
        const only = accounts[0]
        const id = String(only.id || '').trim()
        const accessToken = String(only.access_token || '').trim()
        const name = String(only.name || '').trim() || targetNameRaw || id
        if (id && accessToken) return { id, name, access_token: accessToken }
    }

    return null
}

async function resolveTaggedProfilesToPageRecords(
    profiles: BrowserSavingProfileRecord[],
    env?: Env,
    mode: BrowserSavingTokenMode = 'post',
): Promise<{
    byId: Map<string, Array<{ id: string; name: string; image_url: string; access_token: string; user_token: string; profile_id: string; profile_name: string }>>
    errors: string[]
}> {
    const byId = new Map<string, Array<{ id: string; name: string; image_url: string; access_token: string; user_token: string; profile_id: string; profile_name: string }>>()
    const errors: string[] = []

    const tasks = profiles.map(async (profile) => {
        const profileId = String(profile.id || '').trim()
        const profileName = String(profile.name || '').trim()
        const pageNameHint = String(profile.page_name || '').trim()
        const lookupToken = pickProfilePostToken(profile)
        const localRoleToken = mode === 'comment'
            ? pickProfileCommentToken(profile)
            : pickProfilePostToken(profile)
        if (!profileId) return

        // Role token must come from role-specific slot only (no cross fallback).
        if (!localRoleToken && !env) throw new Error(`profile:${profileId}:${mode}_token_missing`)
        // Page lookup for /me/accounts uses role token in each mode.
        if (mode === 'post' && !lookupToken && !env) throw new Error(`profile:${profileId}:post_lookup_token_missing`)

        let endpointToken = ''
        if (env) {
            const endpointResolved = await resolveBrowserSavingProfileToken(env, profileId, mode)
            endpointToken = String(endpointResolved.token || '').trim()
        } else {
            endpointToken = localRoleToken
        }
        if (!endpointToken) {
            throw new Error(`profile:${profileId}:${mode}_token_missing`)
        }

        // Convert each role token to page token via /me/accounts.
        // For comment mode, prefer post lookup token first to avoid failures when
        // endpointToken is already page-scoped and cannot call /me/accounts.
        const lookupCandidates = uniqueTokens([
            mode === 'comment' ? lookupToken : '',
            endpointToken,
            mode === 'post' ? lookupToken : '',
        ])

        let pageId = ''
        let pageAccessToken = ''
        let pageName = ''
        for (const candidate of lookupCandidates) {
            if (!candidate) continue
            try {
                const accounts = await fetchMeAccountsViaHttp(candidate)
                const matched = pickTargetPageForProfile(profile, accounts)
                if (!matched) continue
                pageId = String(matched.id || '').trim()
                pageAccessToken = String(matched.access_token || '').trim()
                pageName = String(matched.name || '').trim()
                if (pageId && pageAccessToken) break
            } catch {
                // try next candidate
            }
        }

        // Fallback: endpoint token is already page token.
        if (!pageId && isPostRoleToken(endpointToken)) {
            try {
                const me = await fetchMeIdentityViaHttp(endpointToken)
                const meId = String(me?.id || '').trim()
                const meName = String(me?.name || '').trim()
                if (meId && matchesProfileToPage(profile, meId, meName)) {
                    pageId = meId
                    pageName = meName
                    pageAccessToken = endpointToken
                }
            } catch {
                // keep error handling below
            }
        }

        if (!pageId || !pageAccessToken) {
            throw new Error(`profile:${profileId}:page_not_found_in_me_accounts(${pageNameHint || profileName || 'unknown'})`)
        }

        return {
            id: pageId,
            name: pageName || pageNameHint || pageId,
            image_url: `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`,
            access_token: pageAccessToken,
            user_token: endpointToken,
            profile_id: profileId,
            profile_name: profileName,
        }
    })

    const results = await Promise.allSettled(tasks)
    for (const result of results) {
        if (result.status === 'fulfilled') {
            if (!result.value) continue
            const pageId = String(result.value.id || '').trim()
            if (!pageId) continue
            const current = byId.get(pageId) || []
            const dedupeKey = `${String(result.value.profile_id || '').trim().toLowerCase()}::${String(result.value.access_token || '').trim().toLowerCase()}::${String(result.value.user_token || '').trim().toLowerCase()}`
            const exists = current.some((item) => {
                const k = `${String(item.profile_id || '').trim().toLowerCase()}::${String(item.access_token || '').trim().toLowerCase()}::${String(item.user_token || '').trim().toLowerCase()}`
                return k === dedupeKey
            })
            if (!exists) current.push(result.value)
            byId.set(pageId, current)
            continue
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        errors.push(message)
    }

    return { byId, errors }
}

async function syncTaggedPagesFromProfileMetadata(env: Env, namespaceId: string): Promise<void> {
    const ns = String(namespaceId || '').trim()
    if (!ns || ns === 'default') return

    const cfg = await getNamespacePagesSyncConfig(env.DB, ns)
    if (!cfg.enabled) return

    const hasTagSelector =
        cfg.postSelectors.some((s) => parseBrowserSavingTagSelector(s) !== null) ||
        cfg.commentSelectors.some((s) => parseBrowserSavingTagSelector(s) !== null)
    if (!hasTagSelector) return

    const profiles = await fetchBrowserSavingProfiles(env)
    const mergedSelectors = Array.from(new Set(
        [...cfg.postSelectors, ...cfg.commentSelectors]
            .map((s) => String(s || '').trim())
            .filter(Boolean)
    ))
    const selectedProfiles = collectProfilesBySelectors(profiles, mergedSelectors)

    const pageMap = new Map<string, { id: string; name: string; image_url: string }>()
    for (const profile of selectedProfiles) {
        const profileId = String(profile.id || '').trim()
        if (!profileId) continue
        const pageIdFromAvatar = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''))
        const pageName = String(profile.page_name || '').trim() || String(profile.name || '').trim() || pageIdFromAvatar || profileId
        const pageNameKey = normalizePageName(pageName)
        const fallbackId = `tagged-${encodeURIComponent(pageNameKey || profileId)}`
        const pageId = pageIdFromAvatar || fallbackId
        const pageKey = pageNameKey || pageId
        const imageUrl = String(profile.page_avatar_url || '').trim() ||
            (pageIdFromAvatar ? `https://graph.facebook.com/${encodeURIComponent(pageIdFromAvatar)}/picture?type=large` : '')

        const existing = pageMap.get(pageKey)
        if (!existing) {
            pageMap.set(pageKey, { id: pageId, name: pageName, image_url: imageUrl })
            continue
        }
        if (!isLikelyNumericFacebookId(existing.id) && isLikelyNumericFacebookId(pageId)) {
            existing.id = pageId
        }
        if (!existing.image_url && imageUrl) existing.image_url = imageUrl
        if ((!existing.name || existing.name === existing.id) && pageName) existing.name = pageName
    }

    if (pageMap.size === 0) return

    const existingRows = await env.DB.prepare(
        'SELECT id, name, bot_id, access_token, comment_token, post_interval_minutes, is_active FROM pages WHERE bot_id = ?'
    ).bind(ns).all() as {
        results?: Array<{
            id?: string
            name?: string
            bot_id?: string
            access_token?: string | null
            comment_token?: string | null
            post_interval_minutes?: number | null
            is_active?: number | null
        }>
    }
    const existingById = new Map<string, {
        access_token: string
        comment_token: string
        post_interval_minutes: number
        is_active: number
    }>()
    const existingIdByName = new Map<string, string>()
    for (const row of (existingRows.results || [])) {
        const rowId = String(row?.id || '').trim()
        if (!rowId) continue
        const rowNameKey = normalizePageName(String(row?.name || '').trim())
        if (rowNameKey && !existingIdByName.has(rowNameKey)) existingIdByName.set(rowNameKey, rowId)
        existingById.set(rowId, {
            access_token: String(row?.access_token || '').trim(),
            comment_token: String(row?.comment_token || '').trim(),
            post_interval_minutes: Number(row?.post_interval_minutes || 60) || 60,
            is_active: Number(row?.is_active || 0) ? 1 : 0,
        })
    }

    const desiredIds = new Set<string>()
    for (const page of pageMap.values()) {
        let pageId = page.id
        // Metadata sync may not have numeric page id (e.g. CDN avatar URLs).
        // Preserve existing row id by page name to avoid replacing page ids with tagged-* placeholders.
        if (!isLikelyNumericFacebookId(pageId)) {
            const byNameId = existingIdByName.get(normalizePageName(page.name))
            if (byNameId) pageId = byNameId
        }
        desiredIds.add(pageId)
        const existing = existingById.get(pageId)

        if (existing) {
            await env.DB.prepare(
                'UPDATE pages SET name = ?, image_url = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
            ).bind(page.name, page.image_url, pageId, ns).run()
            continue
        }

        const existingInOtherNamespace = await env.DB.prepare(
            'SELECT bot_id FROM pages WHERE id = ? LIMIT 1'
        ).bind(pageId).first() as { bot_id?: string } | null
        if (existingInOtherNamespace?.bot_id && String(existingInOtherNamespace.bot_id) !== ns) {
            continue
        }

        await env.DB.prepare(
            'INSERT INTO pages (id, name, image_url, access_token, comment_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            pageId,
            page.name,
            page.image_url,
            '',
            null,
            60,
            0,
            ns,
        ).run()
    }

    const staleRows = await env.DB.prepare(
        'SELECT id FROM pages WHERE bot_id = ?'
    ).bind(ns).all() as { results?: Array<{ id?: string }> }
    const staleIds = (staleRows.results || [])
        .map((row) => String(row?.id || '').trim())
        .filter((id) => id && !desiredIds.has(id))

    for (const staleId of staleIds) {
        await env.DB.prepare('DELETE FROM pages WHERE id = ? AND bot_id = ?').bind(staleId, ns).run()
    }
}

function extractProfileIdsFromTagAmbiguousError(raw: string): string[] {
    const text = String(raw || '')
    const out: string[] = []
    const seen = new Set<string>()
    const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
    for (const idRaw of matches) {
        const id = String(idRaw || '').trim()
        if (!looksLikeBrowserSavingProfileId(id)) continue
        const key = id.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(id)
    }
    return out
}

async function resolveProfileIdsFromTagAmbiguousFallback(
    env: Env,
    tag: string,
    mode: BrowserSavingTokenMode,
): Promise<Array<{ id: string; name?: string }>> {
    const endpointBases = buildBrowserSavingBaseUrls(env)

    const collected = new Map<string, { id: string; name?: string }>()
    const errors: string[] = []

    for (const baseUrl of endpointBases) {
        const candidatePaths = [
            `/api/postcron/tag/${encodeURIComponent(tag)}/${mode}`,
            `/api/postcron/by-tag/${encodeURIComponent(tag)}/${mode}`,
        ]

        for (const path of candidatePaths) {
            const label = buildBrowserSavingRequestLabel(baseUrl, path)
            try {
                const resp = await fetchFromBrowserSavingBase(env, baseUrl, path, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                })
                const data = await resp.json().catch(() => ({} as any)) as any
                const details = String(data?.details || data?.error || '').trim()

                if (resp.ok) {
                    const selectedId = String(data?.selected_profile_id || '').trim()
                    const selectedName = String(data?.selected_profile_name || '').trim()
                    if (looksLikeBrowserSavingProfileId(selectedId)) {
                        collected.set(selectedId.toLowerCase(), {
                            id: selectedId,
                            name: selectedName || undefined,
                        })
                    }
                    continue
                }

                if (details.toLowerCase().includes('tag_not_found')) {
                    continue
                }

                const ids = extractProfileIdsFromTagAmbiguousError(details)
                if (ids.length > 0) {
                    for (const id of ids) {
                        const key = id.toLowerCase()
                        if (!collected.has(key)) {
                            collected.set(key, { id })
                        }
                    }
                    continue
                }

                errors.push(`${label}: ${details || `HTTP ${resp.status}`}`)
            } catch (e) {
                errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
    }

    if (collected.size > 0) return Array.from(collected.values())
    throw new Error(`tag_ambiguous_fallback_failed(${tag},${mode}): ${errors.join(' | ') || 'no_profile_id_found'}`)
}

async function resolveTagTokenCandidatesForAutoSync(
    env: Env,
    selector: string,
    mode: BrowserSavingTokenMode,
    profiles: BrowserSavingProfileRecord[],
    profilesFetchError = '',
): Promise<AutoSyncTokenCandidate[]> {
    const tag = parseBrowserSavingTagSelector(selector)
    if (!tag) return []

    const matchedProfiles = (profiles || []).filter((profile) => {
        if (!profile || profile.deleted_at) return false
        const tags = normalizeBrowserSavingProfileTags(profile.tags)
        return tags.includes(tag)
    })

    const candidates: AutoSyncTokenCandidate[] = []
    const errors: string[] = []

    const matchedTasks = matchedProfiles.map(async (profile) => {
        const profileId = String(profile?.id || '').trim()
        if (!profileId) return null
        const resolved = await resolveBrowserSavingProfileToken(env, profileId, mode)
        const token = String(resolved.token || '').trim()
        if (!token) throw new Error(`${profileId}:empty_token`)
        return {
            token,
            selector,
            mode,
            reason: resolved.reason || `tag:${tag}`,
            profileId,
            profileName: String(profile?.name || '').trim() || undefined,
        } satisfies AutoSyncTokenCandidate
    })
    const matchedResults = await Promise.allSettled(matchedTasks)
    for (const result of matchedResults) {
        if (result.status === 'fulfilled') {
            if (result.value) candidates.push(result.value)
            continue
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        errors.push(message)
    }

    if (candidates.length > 0) return candidates

    // If /api/profiles is not available from worker runtime, fallback by parsing
    // profile IDs from tag_ambiguous responses, then resolve token per profile ID.
    try {
        const fallbackProfiles = await resolveProfileIdsFromTagAmbiguousFallback(env, tag, mode)
        const fallbackTasks = fallbackProfiles.map(async (profile) => {
            const profileId = String(profile?.id || '').trim()
            if (!profileId) return null
            const resolved = await resolveBrowserSavingProfileToken(env, profileId, mode)
            const token = String(resolved.token || '').trim()
            if (!token) throw new Error(`${profileId}:empty_token`)
            return {
                token,
                selector,
                mode,
                reason: resolved.reason || `tag:${tag} (fallback-ambiguous)`,
                profileId,
                profileName: String(profile?.name || '').trim() || undefined,
            } satisfies AutoSyncTokenCandidate
        })
        const fallbackResults = await Promise.allSettled(fallbackTasks)
        for (const result of fallbackResults) {
            if (result.status === 'fulfilled') {
                if (result.value) candidates.push(result.value)
                continue
            }
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
            errors.push(message)
        }
    } catch (e) {
        errors.push(`${profilesFetchError ? `profiles_fetch:${profilesFetchError} | ` : ''}${e instanceof Error ? e.message : String(e)}`)
    }

    if (candidates.length > 0) return candidates

    // Fallback for older BrowserSaving deployments that only support single tag token endpoint.
    try {
        const fallback = await resolveBrowserSavingProfileTokenByTag(env, tag, mode)
        const token = String(fallback.token || '').trim()
        if (token) {
            return [{
                token,
                selector,
                mode,
                reason: fallback.reason || `tag:${tag}`,
            }]
        }
    } catch (e) {
        errors.push(`fallback:${e instanceof Error ? e.message : String(e)}`)
    }

    throw new Error(`tag_selector_resolution_failed(${selector},${mode}): ${errors.join(' | ') || 'no_profile_with_tag'}`)
}

async function resolveUserTokenCandidatesFromSelectors(
    env: Env,
    selectors: string[],
    mode: BrowserSavingTokenMode,
): Promise<AutoSyncTokenCandidate[]> {
    const out: AutoSyncTokenCandidate[] = []
    const seen = new Set<string>()
    const errors: string[] = []

    let profiles: BrowserSavingProfileRecord[] = []
    let profilesLoaded = false
    let profilesFetchError = ''

    for (const selectorRaw of selectors) {
        const selector = String(selectorRaw || '').trim()
        if (!selector) continue
        try {
            const tag = parseBrowserSavingTagSelector(selector)
            if (tag) {
                if (!profilesLoaded) {
                    try {
                        profiles = await fetchBrowserSavingProfiles(env)
                    } catch (e) {
                        profiles = []
                        profilesFetchError = e instanceof Error ? e.message : String(e)
                    }
                    profilesLoaded = true
                }
                const tagCandidates = await resolveTagTokenCandidatesForAutoSync(env, selector, mode, profiles, profilesFetchError)
                for (const candidate of tagCandidates) {
                    const token = String(candidate.token || '').trim()
                    if (!token) continue
                    const dedupeKey = `${mode}:${token}`
                    if (seen.has(dedupeKey)) continue
                    seen.add(dedupeKey)
                    out.push(candidate)
                }
                continue
            }

            const resolved = await resolveUserTokenInput(env, selector, mode)
            const token = String(resolved.token || '').trim()
            if (!token) {
                errors.push(`${selector}:empty_token`)
                continue
            }
            const dedupeKey = `${mode}:${token}`
            if (seen.has(dedupeKey)) continue
            seen.add(dedupeKey)
            out.push({
                token,
                selector,
                mode,
                reason: resolved.reason,
            })
        } catch (e) {
            errors.push(`${selector}:${e instanceof Error ? e.message : String(e)}`)
        }
    }

    if (out.length === 0) {
        throw new Error(`selectors_resolution_failed(${mode}): ${errors.join(' | ') || 'no_selector'}`)
    }

    return out
}

async function resolveBrowserSavingProfileTokenByTag(
    env: Env,
    tag: string,
    mode: BrowserSavingTokenMode = 'post',
): Promise<{ token: string; reason?: string }> {
    const endpointBases = buildBrowserSavingBaseUrls(env)

    const normalizedTag = String(tag || '').trim().toLowerCase()
    const errors: string[] = []

    for (const baseUrl of endpointBases) {
        const candidatePaths = [
            `/api/postcron/tag/${encodeURIComponent(normalizedTag)}/${mode}`,
            `/api/postcron/by-tag/${encodeURIComponent(normalizedTag)}/${mode}`,
        ]

        for (const path of candidatePaths) {
            const label = buildBrowserSavingRequestLabel(baseUrl, path)
            try {
                const resp = await fetchFromBrowserSavingBase(env, baseUrl, path, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                })
                const data = await resp.json().catch(() => ({} as any)) as any
                if (!resp.ok) {
                    const details = String(data?.details || data?.error || `HTTP ${resp.status}`)
                    if (details.toLowerCase().includes('tag_not_found')) {
                        throw new Error(`tag_not_found:${normalizedTag}`)
                    }
                    errors.push(`${label}: ${details}`)
                    continue
                }

                const token = String(data?.token || '').trim()
                if (!token) {
                    errors.push(`${label}: token_missing`)
                    continue
                }

                const selectedId = String(data?.selected_profile_id || '').trim()
                const selectedName = String(data?.selected_profile_name || '').trim()
                return {
                    token,
                    reason: `tag:${normalizedTag} -> profile:${selectedId || '?'}${selectedName ? `(${selectedName})` : ''} via ${label}`,
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e)
                if (String(message).toLowerCase().includes('tag_not_found')) {
                    throw new Error(`tag_not_found:${normalizedTag}`)
                }
                errors.push(`${label}: ${message}`)
            }
        }
    }

    throw new Error(`browsersaving_tag_resolve_failed: ${errors.join(' | ') || 'no_endpoint_available'}`)
}

async function resolveBrowserSavingProfileToken(
    env: Env,
    profileId: string,
    mode: BrowserSavingTokenMode = 'post',
): Promise<{ token: string; reason?: string }> {
    const endpointBases = buildBrowserSavingBaseUrls(env)

    const errors: string[] = []
    for (const baseUrl of endpointBases) {
        const candidatePaths = mode === 'comment'
            ? [
                `/api/postcron/${encodeURIComponent(profileId)}/comment`,
            ]
            : [
                `/api/postcron/${encodeURIComponent(profileId)}/post`,
            ]

        for (const path of candidatePaths) {
            const label = buildBrowserSavingRequestLabel(baseUrl, path)
            try {
                const resp = await fetchFromBrowserSavingBase(env, baseUrl, path, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                })
                const data = await resp.json().catch(() => ({} as any)) as any
                if (!resp.ok) {
                    const details = String(data?.details || data?.error || `HTTP ${resp.status}`)
                    errors.push(`${label}: ${details}`)
                    continue
                }

                const token = String(data?.token || '').trim()
                if (!token) {
                    errors.push(`${label}: token_missing`)
                    continue
                }

                return { token, reason: `profile:${profileId}:${mode} via ${label}` }
            } catch (e) {
                errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
    }

    throw new Error(`browsersaving_token_fetch_failed: ${errors.join(' | ') || 'no_endpoint_available'}`)
}

async function resolveUserTokenInput(
    env: Env,
    rawInput: string,
    mode: BrowserSavingTokenMode = 'post',
): Promise<{ token: string; source: 'browsersaving_profile_id' | 'provided_as_is'; reason?: string }> {
    const input = String(rawInput || '').trim()
    if (!input) return { token: '', source: 'provided_as_is', reason: 'empty_token' }

    const tag = parseBrowserSavingTagSelector(input)
    if (tag) {
        const resolved = await resolveBrowserSavingProfileTokenByTag(env, tag, mode)
        const resolvedToken = String(resolved.token || '').trim()
        if (!isTokenString(resolvedToken)) {
            throw new Error(`${mode}_token_invalid_from_tag`)
        }
        return {
            token: resolvedToken,
            source: 'browsersaving_profile_id',
            reason: resolved.reason,
        }
    }

    if (looksLikeBrowserSavingProfileId(input)) {
        const resolved = await resolveBrowserSavingProfileToken(env, input, mode)
        const resolvedToken = String(resolved.token || '').trim()
        if (!isTokenString(resolvedToken)) {
            throw new Error(`${mode}_token_invalid_from_profile`)
        }
        return {
            token: resolvedToken,
            source: 'browsersaving_profile_id',
            reason: resolved.reason,
        }
    }

    if (!isTokenString(input)) {
        throw new Error('token_empty')
    }
    return { token: input, source: 'provided_as_is' }
}

async function fetchMeAccountsViaHttp(accessToken: string): Promise<Array<{ id?: string; name?: string; picture?: { data?: { url?: string } }; access_token?: string }>> {
    const token = String(accessToken || '').trim()
    if (!token) return []

    const url = buildFacebookGraphUrl(`${FB_GRAPH_V21}/me/accounts`, {
        fields: 'id,name,picture.type(large),access_token',
        limit: 200,
        access_token: token,
    })
    const resp = await fetch(url, { method: 'GET' })
    const data = await resp.json().catch(() => ({} as any)) as any
    if (!resp.ok) {
        const message = String(data?.error?.message || data?.error || `HTTP ${resp.status}`)
        throw new FacebookRequestFailedError(message, Number(data?.error?.code || 0), Number(data?.error?.error_subcode || 0))
    }
    const pages = Array.isArray(data?.data) ? data.data : []
    return pages as Array<{ id?: string; name?: string; picture?: { data?: { url?: string } }; access_token?: string }>
}

async function fetchMeIdentityViaHttp(accessToken: string): Promise<{ id?: string; name?: string } | null> {
    const token = String(accessToken || '').trim()
    if (!token) return null

    const url = buildFacebookGraphUrl(`${FB_GRAPH_V21}/me`, {
        fields: 'id,name',
        access_token: token,
    })
    const resp = await fetch(url, { method: 'GET' })
    const data = await resp.json().catch(() => ({} as any))
    if (!resp.ok) {
        const message = String(data?.error?.message || data?.error || `HTTP ${resp.status}`)
        throw new FacebookRequestFailedError(message, Number(data?.error?.code || 0), Number(data?.error?.error_subcode || 0))
    }
    const id = String(data?.id || '').trim()
    const name = String(data?.name || '').trim()
    if (!id) return null
    return { id, name }
}

// Accept either page token or user token.
// If a user token is provided, resolve the page-scoped token via /me/accounts.
// Returns page-scoped token for both post/comment modes.
async function resolvePageScopedToken(
    rawToken: string,
    pageId: string,
    env: Env,
    mode: BrowserSavingTokenMode = 'post',
): Promise<{ token: string; source: 'resolved_from_me_accounts' | 'provided_as_is' | 'browsersaving_profile_id'; reason?: string }> {
    const tokenInput = await resolveUserTokenInput(env, rawToken, mode)
    const token = tokenInput.token
    if (!token) return { token: '', source: 'provided_as_is', reason: 'empty_token' }

    const isTokenValidForMode = mode === 'comment' ? isCommentRoleToken : isPostRoleToken
    const resolveFromMeAccountsData = (items: Array<{ id?: string; access_token?: string }>): { token: string; source: 'resolved_from_me_accounts' | 'provided_as_is' | 'browsersaving_profile_id'; reason?: string } => {
        const matched = items.find((p) => String(p.id || '') === String(pageId))
        const pageToken = String(matched?.access_token || '').trim()
        if (isTokenValidForMode(pageToken)) {
            return {
                token: pageToken,
                source: tokenInput.source === 'browsersaving_profile_id' ? 'browsersaving_profile_id' : 'resolved_from_me_accounts',
                reason: tokenInput.reason,
            }
        }
        return {
            token: '',
            source: tokenInput.source === 'browsersaving_profile_id' ? 'browsersaving_profile_id' : 'provided_as_is',
            reason: tokenInput.source === 'browsersaving_profile_id'
                ? `page_not_found_in_me_accounts (${tokenInput.reason || 'browsersaving_profile_id'})`
                : 'page_not_found_in_me_accounts',
        }
    }

    try {
        const data = await facebookGraphGet<{ data?: Array<{ id?: string; access_token?: string }> }>(
            token,
            `${FB_GRAPH_V21}/me/accounts`,
            {
                fields: 'id,access_token',
                limit: 200,
            },
        )
        return resolveFromMeAccountsData(data.data || [])
    } catch (e) {
        console.log(`[PAGES] resolvePageScopedToken sdk fallback: ${String(e)}`)
        if (isTokenValidForMode(token)) {
            try {
                const me = await fetchMeIdentityViaHttp(token)
                const meId = String(me?.id || '').trim()
                if (meId && String(pageId || '').trim() === meId) {
                    return {
                        token,
                        source: tokenInput.source === 'browsersaving_profile_id' ? 'browsersaving_profile_id' : 'provided_as_is',
                        reason: tokenInput.reason || 'already_page_scoped_token',
                    }
                }
            } catch {
                // continue to /me/accounts fallback below
            }
        }
        try {
            const pages = await fetchMeAccountsViaHttp(token)
            return resolveFromMeAccountsData(pages)
        } catch (fallbackErr) {
            const err = parseFacebookErrorLike(fallbackErr) || parseFacebookErrorLike(e)
            const reason = err?.message || String(fallbackErr instanceof Error ? fallbackErr.message : fallbackErr)
            return {
                token: '',
                source: tokenInput.source === 'browsersaving_profile_id' ? 'browsersaving_profile_id' : 'provided_as_is',
                reason: tokenInput.source === 'browsersaving_profile_id'
                    ? `${reason} (${tokenInput.reason || 'browsersaving_profile_id'})`
                    : reason,
            }
        }
    }
}

function sameTokenList(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (String(a[i] || '').trim() !== String(b[i] || '').trim()) return false
    }
    return true
}

async function resolveTokenForSpecificPage(
    rawToken: string,
    pageIdRaw: string,
    cache: Map<string, string>,
    mode: BrowserSavingTokenMode = 'post',
): Promise<string> {
    const token = String(rawToken || '').trim()
    const pageId = String(pageIdRaw || '').trim()
    if (!token || !pageId) return ''

    const cacheKey = `${pageId.toLowerCase()}::${token.toLowerCase()}`
    if (cache.has(cacheKey)) return String(cache.get(cacheKey) || '')

    const isTokenValidForMode = mode === 'comment' ? isCommentRoleToken : isPostRoleToken

    // Case 1: token is already a page-scoped token for this page.
    if (isTokenValidForMode(token)) {
        try {
            const me = await fetchMeIdentityViaHttp(token)
            const meId = String(me?.id || '').trim()
            if (meId && meId === pageId) {
                cache.set(cacheKey, token)
                return token
            }
        } catch {
            // Continue to /me/accounts conversion.
        }
    }

    // Case 2: token is user-scoped token; convert to page-scoped token via /me/accounts.
    try {
        const accounts = await fetchMeAccountsViaHttp(token)
        const matched = accounts.find((item) => String(item?.id || '').trim() === pageId)
        const pageToken = String(matched?.access_token || '').trim()
        if (isTokenValidForMode(pageToken)) {
            cache.set(cacheKey, pageToken)
            return pageToken
        }
    } catch {
        // Keep as unresolved below.
    }

    cache.set(cacheKey, '')
    return ''
}

async function maybeMigrateNamespaceStoredPageTokens(
    env: Env,
    namespaceId: string,
    options: { force?: boolean } = {},
): Promise<{ skipped: boolean; scanned: number; updatedRows: number; updatedAccess: number; updatedComment: number; updatedPoolPages: number; errors: string[] }> {
    const ns = String(namespaceId || '').trim()
    if (!ns || ns === 'default') {
        return { skipped: true, scanned: 0, updatedRows: 0, updatedAccess: 0, updatedComment: 0, updatedPoolPages: 0, errors: [] }
    }

    const nowMs = Date.now()
    const shouldForce = options.force === true
    if (!shouldForce) {
        const lastAtMs = await getNamespacePagesTokenMigrateLastAtMs(env.DB, ns)
        if (lastAtMs > 0 && (nowMs - lastAtMs) < PAGES_TOKEN_MIGRATE_MIN_INTERVAL_MS) {
            return { skipped: true, scanned: 0, updatedRows: 0, updatedAccess: 0, updatedComment: 0, updatedPoolPages: 0, errors: [] }
        }
    }
    await setNamespacePagesTokenMigrateLastAtMs(env.DB, ns, nowMs)

    const rows = await env.DB.prepare(
        'SELECT id, access_token, comment_token FROM pages WHERE bot_id = ?'
    ).bind(ns).all() as { results?: Array<{ id?: string; access_token?: string | null; comment_token?: string | null }> }

    const tokenCache = new Map<string, string>()
    const errors: string[] = []
    let scanned = 0
    let updatedRows = 0
    let updatedAccess = 0
    let updatedComment = 0

    const existingPool = await getNamespacePagesTokenPool(env.DB, ns)
    const nextPool: NamespacePageTokenPool = { ...existingPool }
    let updatedPoolPages = 0

    for (const row of rows.results || []) {
        const pageId = String(row?.id || '').trim()
        if (!pageId) continue
        scanned += 1

        const accessRaw = String(row?.access_token || '').trim()
        const commentRaw = String(row?.comment_token || '').trim()
        let nextAccess = accessRaw
        let nextComment = commentRaw

        if (accessRaw) {
            try {
                const resolved = await resolveTokenForSpecificPage(accessRaw, pageId, tokenCache, 'post')
                if (resolved && resolved !== accessRaw) {
                    nextAccess = resolved
                    updatedAccess += 1
                }
            } catch (e) {
                errors.push(`access:${pageId}:${e instanceof Error ? e.message : String(e)}`)
            }
        }

        if (commentRaw) {
            try {
                const resolved = await resolveTokenForSpecificPage(commentRaw, pageId, tokenCache, 'comment')
                if (resolved && resolved !== commentRaw) {
                    nextComment = resolved
                    updatedComment += 1
                }
            } catch (e) {
                errors.push(`comment:${pageId}:${e instanceof Error ? e.message : String(e)}`)
            }
        }

        nextComment = preferCommentToken(commentRaw, nextComment)
        if (nextAccess !== accessRaw || nextComment !== commentRaw) {
            await env.DB.prepare(
                'UPDATE pages SET access_token = ?, comment_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
            ).bind(nextAccess, nextComment || null, pageId, ns).run()
            updatedRows += 1
        }

        const poolEntry = existingPool[pageId]
        if (!poolEntry) continue

        const nextPostPoolRaw: string[] = []
        for (const token of poolEntry.post_tokens || []) {
            const current = String(token || '').trim()
            if (!current) continue
            try {
                const resolved = await resolveTokenForSpecificPage(current, pageId, tokenCache)
                nextPostPoolRaw.push(resolved || current)
            } catch {
                nextPostPoolRaw.push(current)
            }
        }

        const nextCommentPoolRaw: string[] = []
        for (const token of poolEntry.comment_tokens || []) {
            const current = String(token || '').trim()
            if (!current) continue
            try {
                const resolved = await resolveTokenForSpecificPage(current, pageId, tokenCache, 'comment')
                nextCommentPoolRaw.push(resolved || current)
            } catch {
                nextCommentPoolRaw.push(current)
            }
        }

        const nextPostPool = normalizePostTokenPool(nextPostPoolRaw)
        const nextCommentPool = normalizeCommentTokenPool(nextCommentPoolRaw)
        const currentPostPool = normalizePostTokenPool(poolEntry.post_tokens || [])
        const currentCommentPool = normalizeCommentTokenPool(poolEntry.comment_tokens || [])

        if (!sameTokenList(nextPostPool, currentPostPool) || !sameTokenList(nextCommentPool, currentCommentPool)) {
            nextPool[pageId] = {
                post_tokens: nextPostPool,
                comment_tokens: nextCommentPool,
                updated_at: new Date().toISOString(),
            }
            updatedPoolPages += 1
        }
    }

    if (updatedPoolPages > 0) {
        await setNamespacePagesTokenPool(env.DB, ns, nextPool)
    }

    if (updatedRows > 0 || updatedPoolPages > 0 || errors.length > 0) {
        console.log(
            `[PAGES-TOKEN-MIGRATE] namespace=${ns} scanned=${scanned} updated_rows=${updatedRows} updated_access=${updatedAccess} updated_comment=${updatedComment} updated_pool_pages=${updatedPoolPages} errors=${errors.length}`
        )
    }

    return { skipped: false, scanned, updatedRows, updatedAccess, updatedComment, updatedPoolPages, errors }
}

async function resolveUserTokenFromSelectors(
    env: Env,
    selectors: string[],
    mode: BrowserSavingTokenMode,
): Promise<{ token: string; selector: string; reason?: string }> {
    const errors: string[] = []
    for (const selectorRaw of selectors) {
        const selector = String(selectorRaw || '').trim()
        if (!selector) continue
        try {
            const resolved = await resolveUserTokenInput(env, selector, mode)
            const token = String(resolved.token || '').trim()
            if (!token) {
                errors.push(`${selector}:empty_token`)
                continue
            }
            return {
                token,
                selector,
                reason: resolved.reason,
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            errors.push(`${selector}:${msg}`)
        }
    }
    throw new Error(`selectors_resolution_failed(${mode}): ${errors.join(' | ') || 'no_selector'}`)
}

async function autoSyncPagesForNamespace(
    env: Env,
    namespaceId: string,
    options: { force?: boolean } = {},
): Promise<void> {
    const ns = String(namespaceId || '').trim()
    if (!ns || ns === 'default') return

    try {
        await maybeMigrateNamespaceStoredPageTokens(env, ns)
    } catch (e) {
        console.log(`[PAGES-TOKEN-MIGRATE] namespace=${ns} failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    const cfg = await getNamespacePagesSyncConfig(env.DB, ns)
    if (!cfg.enabled) return

    const shouldForce = options.force === true
    const hasTagSelector =
        cfg.postSelectors.some((s) => parseBrowserSavingTagSelector(s) !== null) ||
        cfg.commentSelectors.some((s) => parseBrowserSavingTagSelector(s) !== null)

    // Default behavior for tag-based mode: metadata-only sync (fast, no Graph flood).
    // Full token sync in tag mode runs only when explicitly forced.
    if (hasTagSelector && !shouldForce) {
        await syncTaggedPagesFromProfileMetadata(env, ns).catch((e) => {
            console.log(`[PAGES-AUTO-SYNC] namespace=${ns} metadata-only sync failed (${String(e)})`)
        })
        return
    }

    const nowMs = Date.now()
    const lastSyncAtMs = await getNamespacePagesLastSyncAtMs(env.DB, ns)
    if (!shouldForce && lastSyncAtMs > 0 && (nowMs - lastSyncAtMs) < PAGES_SYNC_MIN_INTERVAL_MS) {
        return
    }
    await setNamespacePagesLastSyncAtMs(env.DB, ns, nowMs)

    // Preferred path: derive page list directly from BrowserSaving tagged profiles.
    // This keeps UI aligned with tags.
    if (hasTagSelector) {
        try {
            const profiles = await fetchBrowserSavingProfiles(env)
            const postProfiles = collectProfilesBySelectors(profiles, cfg.postSelectors)
            const commentProfiles = collectProfilesBySelectors(profiles, cfg.commentSelectors)

            const postResolved = await resolveTaggedProfilesToPageRecords(postProfiles, env, 'post')
            const commentResolved = await resolveTaggedProfilesToPageRecords(commentProfiles, env, 'comment')

            const pageMap = new Map<string, { id: string; name: string; image_url: string; access_token: string }>()
            const commentTokenByPage = new Map<string, string>()
            const postTokenPoolByPage = new Map<string, string[]>()
            const commentTokenPoolByPage = new Map<string, string[]>()

            // Source-of-truth for page listing = tagged profiles metadata.
            // Even if token resolution fails, page should still appear in UI.
            const addPageFromProfile = (profile: BrowserSavingProfileRecord) => {
                const profileId = String(profile.id || '').trim()
                if (!profileId) return

                const pageIdFromAvatar = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''))
                const pageName = String(profile.page_name || '').trim() || String(profile.name || '').trim() || pageIdFromAvatar || profileId
                const pageNameKey = normalizePageName(pageName)
                const fallbackId = `tagged-${encodeURIComponent(pageNameKey || profileId)}`
                const pageId = pageIdFromAvatar || fallbackId
                const pageKey = pageNameKey || pageId
                const imageUrl = String(profile.page_avatar_url || '').trim() ||
                    (pageIdFromAvatar ? `https://graph.facebook.com/${encodeURIComponent(pageIdFromAvatar)}/picture?type=large` : '')

                const existing = pageMap.get(pageKey)
                if (!existing) {
                    pageMap.set(pageKey, {
                        id: pageId,
                        name: pageName,
                        image_url: imageUrl,
                        access_token: '',
                    })
                    return
                }

                if (!isLikelyNumericFacebookId(existing.id) && isLikelyNumericFacebookId(pageId)) {
                    existing.id = pageId
                }
                if (!existing.image_url && imageUrl) existing.image_url = imageUrl
                if ((!existing.name || existing.name === existing.id) && pageName) existing.name = pageName
            }

            for (const profile of postProfiles) addPageFromProfile(profile)
            for (const profile of commentProfiles) addPageFromProfile(profile)

            // Build per-page token pools from all tagged profiles.
            const allResolvedPageIds = new Set<string>()
            for (const pid of postResolved.byId.keys()) allResolvedPageIds.add(pid)
            for (const pid of commentResolved.byId.keys()) allResolvedPageIds.add(pid)

            for (const pageId of allResolvedPageIds) {
                const postRecords = postResolved.byId.get(pageId) || []
                const commentRecords = commentResolved.byId.get(pageId) || []

                const baseRecord = postRecords[0] || commentRecords[0]
                if (!baseRecord) continue

                const postTokens = normalizePostTokenPool(postRecords.map((r) => String(r.access_token || '').trim()))
                const commentTokens = normalizeCommentTokenPool(commentRecords.map((r) => String(r.access_token || '').trim()))

                // Strict role: post fallback can use only post-tag profiles.
                const mergedPostTokens = uniqueTokens([...postTokens])

                postTokenPoolByPage.set(pageId, mergedPostTokens)
                commentTokenPoolByPage.set(pageId, commentTokens)

                const pageName = String(baseRecord.name || '').trim() || pageId
                const pageImageUrl = String(baseRecord.image_url || '').trim() ||
                    `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`
                const pageKey = normalizePageName(pageName) || pageId
                const existingPage = pageMap.get(pageKey)
                if (existingPage) {
                    existingPage.id = pageId
                    existingPage.name = pageName || existingPage.name
                    existingPage.image_url = pageImageUrl || existingPage.image_url
                    existingPage.access_token = mergedPostTokens[0] || existingPage.access_token
                } else {
                    pageMap.set(pageKey, { id: pageId, name: pageName, image_url: pageImageUrl, access_token: mergedPostTokens[0] || '' })
                }

                if (commentTokens.length > 0) {
                    commentTokenByPage.set(pageId, commentTokens[0])
                }
            }

            // Fallback for pages that still have tagged-* ids:
            // derive real page id from profile token identity (/me),
            // then keep strict role-specific token pools.
            const profileRolesById = new Map<string, Set<'post' | 'comment'>>()
            const profileById = new Map<string, BrowserSavingProfileRecord>()
            const upsertProfileRole = (profile: BrowserSavingProfileRecord, role: 'post' | 'comment') => {
                const profileId = String(profile.id || '').trim()
                if (!profileId) return
                const key = profileId.toLowerCase()
                if (!profileRolesById.has(key)) profileRolesById.set(key, new Set())
                profileRolesById.get(key)!.add(role)
                if (!profileById.has(key)) profileById.set(key, profile)
            }
            for (const profile of postProfiles) upsertProfileRole(profile, 'post')
            for (const profile of commentProfiles) upsertProfileRole(profile, 'comment')

            const profileIdentityCache = new Map<string, { id: string; name: string } | null>()
            const resolveProfileIdentity = async (profile: BrowserSavingProfileRecord): Promise<{ id: string; name: string } | null> => {
                const profileId = String(profile.id || '').trim()
                if (!profileId) return null
                const cacheKey = profileId.toLowerCase()
                if (profileIdentityCache.has(cacheKey)) return profileIdentityCache.get(cacheKey) || null

                const tokenCandidates = uniqueTokens([
                    pickProfilePostToken(profile),
                    pickProfileCommentToken(profile),
                ])
                for (const token of tokenCandidates) {
                    if (!token) continue
                    try {
                        const me = await fetchMeIdentityViaHttp(token)
                        const meId = String(me?.id || '').trim()
                        if (!isLikelyNumericFacebookId(meId)) continue
                        const meName = String(me?.name || '').trim() || meId
                        const resolved = { id: meId, name: meName }
                        profileIdentityCache.set(cacheKey, resolved)
                        return resolved
                    } catch {
                        // try next token
                    }
                }

                profileIdentityCache.set(cacheKey, null)
                return null
            }
            const appendPoolToken = (pool: Map<string, string[]>, pageId: string, token: string, mode: 'post' | 'comment') => {
                const tokenValue = String(token || '').trim()
                if (!pageId || !tokenValue) return
                const current = pool.get(pageId) || []
                const next = mode === 'post'
                    ? normalizePostTokenPool([...current, tokenValue])
                    : normalizeCommentTokenPool([...current, tokenValue])
                pool.set(pageId, next)
            }

            for (const [pageKey, pageRecord] of pageMap.entries()) {
                const currentId = String(pageRecord.id || '').trim()
                if (isLikelyNumericFacebookId(currentId)) continue

                const matchingProfiles = Array.from(profileById.values()).filter((profile) => {
                    const profilePageName = normalizePageName(String(profile.page_name || profile.name || ''))
                    return !!profilePageName && profilePageName === pageKey
                })
                if (matchingProfiles.length === 0) continue

                let resolvedPageId = ''
                let resolvedPageName = ''
                for (const profile of matchingProfiles) {
                    const identity = await resolveProfileIdentity(profile)
                    if (!identity?.id) continue
                    if (!resolvedPageId) {
                        resolvedPageId = identity.id
                        resolvedPageName = identity.name
                    }
                    if (resolvedPageId !== identity.id) continue

                    const profileKey = String(profile.id || '').trim().toLowerCase()
                    const roles = profileRolesById.get(profileKey)
                    if (!roles) continue

                    if (roles.has('post')) {
                        appendPoolToken(postTokenPoolByPage, resolvedPageId, pickProfilePostToken(profile), 'post')
                    }
                    if (roles.has('comment')) {
                        const commentToken = pickProfileCommentToken(profile)
                        appendPoolToken(commentTokenPoolByPage, resolvedPageId, commentToken, 'comment')
                        if (commentToken && !commentTokenByPage.has(resolvedPageId)) {
                            commentTokenByPage.set(resolvedPageId, commentToken)
                        }
                    }
                }

                if (!resolvedPageId) continue
                const oldId = pageRecord.id
                pageRecord.id = resolvedPageId
                if (resolvedPageName) pageRecord.name = resolvedPageName
                if (!pageRecord.image_url) {
                    pageRecord.image_url = `https://graph.facebook.com/${encodeURIComponent(resolvedPageId)}/picture?type=large`
                }
                const postPool = postTokenPoolByPage.get(resolvedPageId) || []
                if (!pageRecord.access_token && postPool.length > 0) {
                    pageRecord.access_token = postPool[0] || ''
                }

                if (oldId && oldId !== resolvedPageId) {
                    const oldPostPool = postTokenPoolByPage.get(oldId) || []
                    if (oldPostPool.length > 0) {
                        postTokenPoolByPage.set(
                            resolvedPageId,
                            normalizePostTokenPool([...(postTokenPoolByPage.get(resolvedPageId) || []), ...oldPostPool]),
                        )
                        postTokenPoolByPage.delete(oldId)
                    }
                    const oldCommentPool = commentTokenPoolByPage.get(oldId) || []
                    if (oldCommentPool.length > 0) {
                        commentTokenPoolByPage.set(
                            resolvedPageId,
                            normalizeCommentTokenPool([...(commentTokenPoolByPage.get(resolvedPageId) || []), ...oldCommentPool]),
                        )
                        commentTokenPoolByPage.delete(oldId)
                    }
                    const oldCommentPrimary = String(commentTokenByPage.get(oldId) || '').trim()
                    if (oldCommentPrimary && !commentTokenByPage.has(resolvedPageId)) {
                        commentTokenByPage.set(resolvedPageId, oldCommentPrimary)
                    }
                    commentTokenByPage.delete(oldId)
                }
            }

            if (pageMap.size > 0) {
                let imported = 0
                let updated = 0
                let moved = 0
                let deleted = 0
                const desiredPageIds = new Set<string>()
                const existingPool = await getNamespacePagesTokenPool(env.DB, ns)
                const nextPool: NamespacePageTokenPool = { ...existingPool }
                const existingRowsInNamespace = await env.DB.prepare(
                    'SELECT id, access_token, comment_token, post_interval_minutes, is_active FROM pages WHERE bot_id = ?'
                ).bind(ns).all() as {
                    results?: Array<{
                        id?: string
                        access_token?: string | null
                        comment_token?: string | null
                        post_interval_minutes?: number | null
                        is_active?: number | null
                    }>
                }
                const existingById = new Map<string, {
                    access_token: string
                    comment_token: string
                    post_interval_minutes: number
                    is_active: number
                }>()
                for (const row of (existingRowsInNamespace.results || [])) {
                    const rowId = String(row?.id || '').trim()
                    if (!rowId) continue
                    existingById.set(rowId, {
                        access_token: String(row?.access_token || '').trim(),
                        comment_token: String(row?.comment_token || '').trim(),
                        post_interval_minutes: Number(row?.post_interval_minutes || 60) || 60,
                        is_active: Number(row?.is_active || 0) ? 1 : 0,
                    })
                }

                for (const page of pageMap.values()) {
                    const pageId = page.id
                    desiredPageIds.add(pageId)
                    const existingRow = existingById.get(pageId)
                    const existingAccessToken = String(existingRow?.access_token || '').trim()
                    const existingCommentToken = String(existingRow?.comment_token || '').trim()

                    const pagePostPool = normalizePostTokenPool([
                        ...(postTokenPoolByPage.get(pageId) || []),
                        ...(existingPool[pageId]?.post_tokens || []),
                        existingAccessToken,
                        page.access_token,
                    ])
                    const pageCommentPool = normalizeCommentTokenPool([
                        existingCommentToken,
                        ...(commentTokenPoolByPage.get(pageId) || []),
                        ...(existingPool[pageId]?.comment_tokens || []),
                        String(commentTokenByPage.get(pageId) || '').trim(),
                    ])

                    // Strict role separation: never re-introduce raw DB tokens that failed prefix validation.
                    const primaryPostToken = String(pagePostPool[0] || '').trim()
                    const pageCommentTokenRaw = String(pageCommentPool[0] || '').trim()
                    const pageCommentToken = preferCommentToken(existingCommentToken, pageCommentTokenRaw)
                    nextPool[pageId] = {
                        post_tokens: pagePostPool,
                        comment_tokens: pageCommentPool,
                        updated_at: new Date().toISOString(),
                    }

                    const existingInNamespace = await env.DB.prepare(
                        'SELECT id FROM pages WHERE id = ? AND bot_id = ?'
                    ).bind(pageId, ns).first()

                    if (existingInNamespace) {
                        await env.DB.prepare(
                            'UPDATE pages SET access_token = ?, comment_token = ?, image_url = ?, name = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                        ).bind(primaryPostToken, pageCommentToken || null, page.image_url, page.name, pageId, ns).run()
                        updated += 1
                        continue
                    }

                    const existingInOtherNamespace = await env.DB.prepare(
                        'SELECT bot_id FROM pages WHERE id = ?'
                    ).bind(pageId).first() as { bot_id?: string } | null
                    if (existingInOtherNamespace?.bot_id) {
                        const safeCommentToken = preferCommentToken('', pageCommentTokenRaw)
                        await env.DB.prepare(
                            'UPDATE pages SET bot_id = ?, access_token = ?, comment_token = ?, image_url = ?, name = ?, updated_at = datetime("now") WHERE id = ?'
                        ).bind(ns, primaryPostToken, safeCommentToken || null, page.image_url, page.name, pageId).run()
                        moved += 1
                        continue
                    }

                    const defaultIsActive = primaryPostToken ? 1 : 0
                    const insertCommentToken = preferCommentToken('', pageCommentTokenRaw)
                    await env.DB.prepare(
                        'INSERT INTO pages (id, name, image_url, access_token, comment_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                    ).bind(pageId, page.name, page.image_url, primaryPostToken, insertCommentToken || null, 60, defaultIsActive, ns).run()
                    imported += 1
                }

                // tags-only mode: prune stale pages that are no longer tagged.
                const existingRows = await env.DB.prepare(
                    'SELECT id FROM pages WHERE bot_id = ?'
                ).bind(ns).all() as { results?: Array<{ id?: string }> }

                const staleIds = (existingRows.results || [])
                    .map((row) => String(row?.id || '').trim())
                    .filter((id) => id && !desiredPageIds.has(id))

                for (const staleId of staleIds) {
                    await env.DB.prepare(
                        'DELETE FROM pages WHERE id = ? AND bot_id = ?'
                    ).bind(staleId, ns).run()
                    delete nextPool[staleId]
                    deleted += 1
                }
                await setNamespacePagesTokenPool(env.DB, ns, nextPool)

                if (
                    imported > 0 || updated > 0 || moved > 0 || deleted > 0 ||
                    postResolved.errors.length > 0 || commentResolved.errors.length > 0
                ) {
                    console.log(
                        `[PAGES-AUTO-SYNC] namespace=${ns} source=profiles imported=${imported} updated=${updated} moved=${moved} deleted=${deleted} post_profiles=${postProfiles.length} comment_profiles=${commentProfiles.length} post_errors=${postResolved.errors.length} comment_errors=${commentResolved.errors.length}`
                    )
                }
                return
            }

            // In tag mode, if we cannot resolve any tagged page, do not fallback to broad /me/accounts import.
            console.log(
                `[PAGES-AUTO-SYNC] namespace=${ns} source=profiles skip: no_tagged_pages_resolved post_profiles=${postProfiles.length} comment_profiles=${commentProfiles.length} post_errors=${postResolved.errors.length} comment_errors=${commentResolved.errors.length}`
            )
            return
        } catch (e) {
            console.log(`[PAGES-AUTO-SYNC] namespace=${ns} source=profiles failed (${e instanceof Error ? e.message : String(e)})`)
            // In tag mode we prefer strict correctness over broad fallback.
            return
        }
    }

    let postCandidates: AutoSyncTokenCandidate[]
    try {
        postCandidates = await resolveUserTokenCandidatesFromSelectors(env, cfg.postSelectors, 'post')
    } catch (e) {
        console.log(`[PAGES-AUTO-SYNC] namespace=${ns} skip: cannot resolve post selector (${e instanceof Error ? e.message : String(e)})`)
        return
    }

    let commentCandidates: AutoSyncTokenCandidate[] = []
    try {
        commentCandidates = await resolveUserTokenCandidatesFromSelectors(env, cfg.commentSelectors, 'comment')
    } catch (e) {
        console.log(`[PAGES-AUTO-SYNC] namespace=${ns} comment selectors unavailable (${e instanceof Error ? e.message : String(e)})`)
    }

    const pageMap = new Map<string, { id: string; name: string; image_url: string; access_token: string }>()
    const postFetchErrors: string[] = []
    const postResults = await Promise.allSettled(postCandidates.map(async (candidate) => {
        const fbPages = await fetchMeAccountsViaHttp(candidate.token)
        return { candidate, fbPages }
    }))
    for (const result of postResults) {
        if (result.status === 'rejected') {
            const parsed = parseFacebookErrorLike(result.reason)
            const msg = parsed?.message || (result.reason instanceof Error ? result.reason.message : String(result.reason))
            postFetchErrors.push(msg)
            continue
        }
        for (const fbPage of result.value.fbPages) {
            const pageId = String(fbPage?.id || '').trim()
            if (!pageId) continue
            const pageAccessToken = String(fbPage?.access_token || '').trim()
            if (!isPostRoleToken(pageAccessToken)) continue
            if (pageMap.has(pageId)) continue
            const pageName = String(fbPage?.name || '').trim() || pageId
            const pageImageUrl = `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`
            pageMap.set(pageId, {
                id: pageId,
                name: pageName,
                image_url: pageImageUrl,
                access_token: pageAccessToken,
            })
        }
    }
    if (pageMap.size === 0) {
        console.log(`[PAGES-AUTO-SYNC] namespace=${ns} skip: no pages from post selectors (${postFetchErrors.join(' | ') || 'empty'})`)
        return
    }

    const commentTokenByPage = new Map<string, string>()
    const commentFetchErrors: string[] = []
    for (const candidate of commentCandidates) {
        const token = String(candidate.token || '').trim()
        if (!token) continue
    }
    const commentResults = await Promise.allSettled(commentCandidates.map(async (candidate) => {
        const candidateToken = String(candidate.token || '').trim()
        if (!candidateToken) {
            return {
                candidate,
                candidateToken: '',
                commentPages: [] as Array<{ id?: string; access_token?: string }>,
                pageIdentity: null as { id?: string; name?: string } | null,
            }
        }

        try {
            const commentPages = await fetchMeAccountsViaHttp(candidateToken)
            return {
                candidate,
                candidateToken,
                commentPages,
                pageIdentity: null as { id?: string; name?: string } | null,
            }
        } catch (e) {
            if (!isPostRoleToken(candidateToken)) throw e
            const pageIdentity = await fetchMeIdentityViaHttp(candidateToken).catch(() => null)
            if (!pageIdentity?.id) throw e
            return {
                candidate,
                candidateToken,
                commentPages: [] as Array<{ id?: string; access_token?: string }>,
                pageIdentity,
            }
        }
    }))
    for (const result of commentResults) {
        if (result.status === 'rejected') {
            const parsed = parseFacebookErrorLike(result.reason)
            const msg = parsed?.message || (result.reason instanceof Error ? result.reason.message : String(result.reason))
            commentFetchErrors.push(msg)
            continue
        }
        for (const item of result.value.commentPages) {
            const pid = String(item?.id || '').trim()
            if (!pid) continue
            if (!pageMap.has(pid)) continue
            if (commentTokenByPage.has(pid)) continue
            const commentPageToken = String(item?.access_token || '').trim()
            if (!isCommentRoleToken(commentPageToken)) continue
            commentTokenByPage.set(pid, commentPageToken)
        }
        const pageIdentity = result.value.pageIdentity
        const candidateToken = String(result.value.candidateToken || '').trim()
        const identityPageId = String(pageIdentity?.id || '').trim()
        if (identityPageId && pageMap.has(identityPageId) && !commentTokenByPage.has(identityPageId) && isCommentRoleToken(candidateToken)) {
            commentTokenByPage.set(identityPageId, candidateToken)
        }
    }

    let imported = 0
    let updated = 0
    let conflicts = 0
    const desiredPageIds = new Set<string>()

    for (const page of pageMap.values()) {
        const pageId = page.id
        desiredPageIds.add(pageId)

        const pageCommentTokenRaw = String(commentTokenByPage.get(pageId) || '').trim()

        const existingInNamespace = await env.DB.prepare(
            'SELECT id, comment_token FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(pageId, ns).first() as { id?: string; comment_token?: string | null } | null

        if (existingInNamespace?.id) {
            const existingCommentToken = String(existingInNamespace.comment_token || '').trim()
            const pageCommentToken = preferCommentToken(existingCommentToken, pageCommentTokenRaw)
            await env.DB.prepare(
                'UPDATE pages SET access_token = ?, comment_token = ?, image_url = ?, name = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
            ).bind(page.access_token, pageCommentToken || null, page.image_url, page.name, pageId, ns).run()
            updated += 1
            continue
        }

        const existingInOtherNamespace = await env.DB.prepare(
            'SELECT bot_id FROM pages WHERE id = ?'
        ).bind(pageId).first() as { bot_id?: string } | null
        if (existingInOtherNamespace?.bot_id) {
            conflicts += 1
            continue
        }

        const pageCommentToken = preferCommentToken('', pageCommentTokenRaw)
        await env.DB.prepare(
            'INSERT INTO pages (id, name, image_url, access_token, comment_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, ?, 60, 1, ?)'
        ).bind(pageId, page.name, page.image_url, page.access_token, pageCommentToken || null, ns).run()
        imported += 1
    }

    let deleted = 0
    const canPrune = desiredPageIds.size > 0 && postFetchErrors.length === 0 && commentFetchErrors.length === 0
    if (canPrune) {
        const existingRows = await env.DB.prepare(
            'SELECT id FROM pages WHERE bot_id = ?'
        ).bind(ns).all() as { results?: Array<{ id?: string }> }

        const staleIds = (existingRows.results || [])
            .map((row) => String(row?.id || '').trim())
            .filter((id) => id && !desiredPageIds.has(id))

        for (const staleId of staleIds) {
            await env.DB.prepare(
                'DELETE FROM pages WHERE id = ? AND bot_id = ?'
            ).bind(staleId, ns).run()
            deleted += 1
        }
    }

    if (imported > 0 || updated > 0 || conflicts > 0 || deleted > 0 || commentFetchErrors.length > 0 || postFetchErrors.length > 0) {
        console.log(
            `[PAGES-AUTO-SYNC] namespace=${ns} imported=${imported} updated=${updated} deleted=${deleted} conflicts=${conflicts} post_selectors=${cfg.postSelectors.join(',')} comment_selectors=${cfg.commentSelectors.join(',')} post_fetch_errors=${postFetchErrors.length} comment_fetch_errors=${commentFetchErrors.length}`
        )
    }
}

async function autoSyncPagesFromBrowserSavingTags(env: Env): Promise<void> {
    const namespaces = new Set<string>()

    try {
        const { results: userNamespaces } = await env.DB.prepare(
            `SELECT DISTINCT namespace_id AS ns
             FROM users
             WHERE namespace_id IS NOT NULL
               AND TRIM(namespace_id) <> ''`
        ).all() as { results?: Array<{ ns?: string }> }
        for (const row of userNamespaces || []) {
            const ns = String(row?.ns || '').trim()
            if (ns) namespaces.add(ns)
        }
    } catch (e) {
        console.log(`[PAGES-AUTO-SYNC] users namespace lookup failed: ${String(e)}`)
    }

    try {
        const { results: pageNamespaces } = await env.DB.prepare(
            `SELECT DISTINCT bot_id AS ns
             FROM pages
             WHERE bot_id IS NOT NULL
               AND TRIM(bot_id) <> ''`
        ).all() as { results?: Array<{ ns?: string }> }
        for (const row of pageNamespaces || []) {
            const ns = String(row?.ns || '').trim()
            if (ns) namespaces.add(ns)
        }
    } catch (e) {
        console.log(`[PAGES-AUTO-SYNC] pages namespace lookup failed: ${String(e)}`)
    }

    for (const ns of namespaces) {
        try {
            await autoSyncPagesForNamespace(env, ns)
        } catch (e) {
            console.log(`[PAGES-AUTO-SYNC] namespace=${ns} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
}

function isDeprecatedSingularStatusesError(message: string, code: number): boolean {
    const msg = String(message || '').toLowerCase()
    if (code === 12 && msg.includes('singular statuses api')) return true
    return msg.includes('singular statuses api is deprecated')
}

function buildCommentTargetCandidates(targetIdRaw: string, pageIdRaw?: string): string[] {
    const targetId = String(targetIdRaw || '').trim()
    const pageId = String(pageIdRaw || '').trim()
    if (!targetId) return []

    const candidates: string[] = [targetId]
    const hasUnderscore = targetId.includes('_')

    if (hasUnderscore) {
        const tail = targetId.split('_').pop() || ''
        if (tail) {
            candidates.push(tail)
            if (pageId) candidates.push(`${pageId}_${tail}`)
        }
    } else if (pageId) {
        candidates.push(`${pageId}_${targetId}`)
    }

    if (pageId && !targetId.startsWith(`${pageId}_`)) {
        candidates.push(`${pageId}_${targetId}`)
    }

    return uniqueTokens(candidates)
}

async function resolveCommentTargetIdViaGraph(params: {
    targetId: string
    accessToken: string
    logPrefix: string
}): Promise<string> {
    const targetId = String(params.targetId || '').trim()
    const accessToken = String(params.accessToken || '').trim()
    if (!targetId || !accessToken) return ''

    try {
        const detail = await facebookGraphRawGet<{
            id?: string
            post_id?: string
            object_id?: string
            permalink_url?: string
        }>(
            `${FB_GRAPH_V19}/${targetId}`,
            {
                fields: 'id,post_id,object_id,permalink_url',
                access_token: accessToken,
            },
        )

        const candidates = uniqueTokens([
            String(detail?.post_id || '').trim(),
            String(detail?.object_id || '').trim(),
            String(detail?.id || '').trim(),
        ])
        const preferred = candidates.find((id) => id.includes('_') && id !== targetId)
            || candidates.find((id) => id !== targetId)
            || ''
        if (preferred) {
            console.log(`[${params.logPrefix}] comment target remapped ${targetId} -> ${preferred}`)
        }
        return preferred
    } catch (e) {
        const msg = parseFacebookErrorLike(e)?.message || (e instanceof Error ? e.message : String(e))
        console.log(`[${params.logPrefix}] comment target resolve failed for ${targetId}: ${msg}`)
        return ''
    }
}

async function postShopeeCommentStrict(params: {
    fbVideoId: string
    shopeeLink: string
    commentToken?: string | null
    pageId?: string
    logPrefix: string
}): Promise<{ ok: boolean; id?: string; error?: string; code?: number; subcode?: number }> {
    const commentToken = String(params.commentToken || '').trim()
    if (!commentToken) {
        return { ok: false, error: 'comment_token_missing', code: 0, subcode: 0 }
    }

    const initialTargetId = String(params.fbVideoId || '').trim()
    if (!initialTargetId) {
        return { ok: false, error: 'comment_target_missing', code: 0, subcode: 0 }
    }

    const tried = new Set<string>()
    const tryPostComment = async (targetId: string) => {
        const tid = String(targetId || '').trim()
        if (!tid || tried.has(tid)) return { ok: false as const, error: 'empty_target', code: 0, subcode: 0 }
        tried.add(tid)
        const result = await facebookGraphRawPost<{ id?: string }>(
            `${FB_GRAPH_V19}/${tid}/comments`,
            {
                message: buildShopeeCommentMessage(params.shopeeLink),
                access_token: commentToken,
            },
        )
        if (result.id) {
            console.log(`[${params.logPrefix}] comment SUCCESS (COMMENT_TOKEN) target=${tid} id=${result.id}`)
            return { ok: true as const, id: result.id }
        }
        console.error(`[${params.logPrefix}] comment FAILED (COMMENT_TOKEN): missing_comment_id target=${tid}`)
        return { ok: false as const, error: 'missing_comment_id', code: 0, subcode: 0 }
    }

    try {
        const firstAttempt = await tryPostComment(initialTargetId)
        if (firstAttempt.ok) return firstAttempt
        return { ok: false, error: firstAttempt.error, code: 0, subcode: 0 }
    } catch (e) {
        const parsed = parseFacebookErrorLike(e)
        const err = String(parsed?.message || (e instanceof Error ? e.message : String(e)))
        const code = Number(parsed?.code || 0)
        const subcode = Number(parsed?.error_subcode || 0)

        if (isDeprecatedSingularStatusesError(err, code)) {
            const candidates = buildCommentTargetCandidates(initialTargetId, params.pageId)
            try {
                const resolved = await resolveCommentTargetIdViaGraph({
                    targetId: initialTargetId,
                    accessToken: commentToken,
                    logPrefix: params.logPrefix,
                })
                if (resolved) candidates.unshift(resolved)
            } catch {
                // ignore resolve errors and continue with candidates
            }

            for (const candidate of candidates) {
                try {
                    const attempt = await tryPostComment(candidate)
                    if (attempt.ok) return attempt
                } catch (retryErr) {
                    const retryParsed = parseFacebookErrorLike(retryErr)
                    const retryMsg = String(retryParsed?.message || (retryErr instanceof Error ? retryErr.message : String(retryErr)))
                    console.error(`[${params.logPrefix}] comment retry failed target=${candidate}: ${retryMsg}`)
                }
            }
        }

        console.error(`[${params.logPrefix}] comment EXCEPTION (COMMENT_TOKEN): ${err}`)
        return { ok: false, error: err, code, subcode }
    }
}

async function postShopeeCommentWithFallback(params: {
    fbVideoId: string
    shopeeLink: string
    commentTokens: string[]
    pageId?: string
    logPrefix: string
}): Promise<{ ok: boolean; id?: string; error?: string; code?: number; subcode?: number; tried: number }> {
    const commentTokens = normalizeCommentTokenPool(params.commentTokens || [])
    if (commentTokens.length === 0) {
        return { ok: false, error: 'comment_token_missing', code: 0, subcode: 0, tried: 0 }
    }

    const result = await postShopeeCommentStrict({
        fbVideoId: params.fbVideoId,
        shopeeLink: params.shopeeLink,
        commentToken: commentTokens[0],
        pageId: params.pageId,
        logPrefix: params.logPrefix,
    })
    return { ...result, tried: 1 }
}

function deriveCommentTokenHint(token?: string | null): string | null {
    const normalized = String(token || '').trim()
    if (!normalized) return null
    if (normalized.length <= 10) return normalized
    return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`
}

function buildExpectedCaptionFromMeta(meta: Record<string, unknown>): string {
    const title = metaToString(meta, 'title')
    if (!title) return ''
    const category = metaToString(meta, 'category')
    return `${title}\n#สินค้า #ของน่าใช้ #ช็อปปิ้งออนไลน์${category ? ` #${category}` : ''}`
}

async function reconcilePostingHistoryRows(params: {
    env: Env
    bucket: R2Bucket
    botId: string
    logPrefix: string
}): Promise<void> {
    const { env, bucket, botId, logPrefix } = params
    const { results } = await env.DB.prepare(
        `SELECT ph.id, ph.page_id, ph.video_id, ph.posted_at, ph.comment_status,
                p.name AS page_name, p.access_token, p.comment_token
         FROM post_history ph
         JOIN pages p ON p.id = ph.page_id
         WHERE ph.status = 'posting' AND ph.bot_id = ? AND p.bot_id = ?
         ORDER BY ph.posted_at DESC
         LIMIT 20`
    ).bind(botId, botId).all() as {
        results: Array<{
            id: number
            page_id: string
            video_id: string
            posted_at: string
            comment_status?: string | null
            page_name?: string
            access_token?: string
            comment_token?: string | null
        }>
    }

    for (const row of results || []) {
        try {
            const postedAtMs = Date.parse(String(row.posted_at || ''))
            if (Number.isFinite(postedAtMs) && Date.now() - postedAtMs < 45000) {
                // allow active upload flow to complete first
                continue
            }

            const metaObj = await bucket.get(`videos/${row.video_id}.json`)
            if (!metaObj) continue
            const meta = await metaObj.json() as Record<string, unknown>
            const expectedCaption = buildExpectedCaptionFromMeta(meta)
            if (!expectedCaption) continue

            const recovered = await recoverPublishedReelFromRecentFeed({
                accessToken: String(row.access_token || '').trim(),
                pageId: String(row.page_id || '').trim(),
                expectedCaption,
                notBeforeIso: String(row.posted_at || ''),
                logPrefix: `${logPrefix} RECON ${row.id}`,
            })

            if (recovered.published && recovered.post_id) {
                const recoveredPostId = String(recovered.post_id || '').trim()
                const recoveredReelUrl = String(recovered.permalink_url || '').trim() || `https://www.facebook.com/reel/${recoveredPostId}/`
                const shopeeLink = normalizeMetaShopeeLink(meta) || ''
                const commentTokenHint = deriveCommentTokenHint(row.comment_token)
                let commentStatus = shopeeLink ? 'pending' : 'not_configured'
                let commentError: string | null = null
                let commentFbId: string | null = null

                if (shopeeLink) {
                    const commentResult = await postShopeeCommentStrict({
                        fbVideoId: recoveredPostId,
                        shopeeLink,
                        commentToken: row.comment_token || '',
                        pageId: row.page_id,
                        logPrefix: `${logPrefix} RECON ${row.id}`,
                    })
                    if (commentResult.ok) {
                        commentStatus = 'success'
                        commentFbId = commentResult.id || null
                    } else {
                        commentStatus = 'failed'
                        commentError = commentResult.error || 'comment_failed'
                    }
                }

                await env.DB.prepare(
                    "UPDATE post_history SET status='success', fb_post_id=?, fb_reel_url=?, error_message=NULL, comment_status=?, comment_token_hint=?, comment_error=?, comment_fb_id=? WHERE id=? AND status='posting'"
                ).bind(
                    recoveredPostId,
                    recoveredReelUrl,
                    commentStatus,
                    commentTokenHint,
                    commentError,
                    commentFbId,
                    row.id,
                ).run()

                await clearVideoShopeeLink(bucket, row.video_id)
                continue
            }

            // prevent indefinite stuck state
            if (Number.isFinite(postedAtMs) && Date.now() - postedAtMs > 20 * 60 * 1000) {
                await env.DB.prepare(
                    "UPDATE post_history SET status='failed', error_message='posting_timeout_no_publish_confirmation', comment_status='not_attempted' WHERE id=? AND status='posting'"
                ).bind(row.id).run()
            }
        } catch (e) {
            console.error(`[${logPrefix}] reconcile row ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
}

function isVideoProcessingErrorMessage(message: string): boolean {
    const normalized = String(message || '').toLowerCase()
    return normalized.includes('video is processing') ||
        normalized.includes('get-the-upload-status') ||
        normalized.includes('upload status')
}

function waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 120000, label = 'fetch'): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(`${label}_timeout_${timeoutMs}ms`), timeoutMs)
    try {
        return await fetch(input, { ...init, signal: controller.signal })
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.toLowerCase().includes('abort')) {
            throw new Error(`${label}_timeout_${timeoutMs}ms`)
        }
        throw e
    } finally {
        clearTimeout(timeoutId)
    }
}

function extractStatusText(status: unknown): string {
    if (!status || typeof status !== 'object') return ''
    const s = status as any
    const parts = [
        s?.video_status,
        s?.processing_phase?.status,
        s?.publishing_phase?.status,
        s?.uploading_phase?.status,
        s?.processing_phase,
        s?.publishing_phase,
        s?.uploading_phase,
    ].map((value) => String(value || '').trim()).filter(Boolean)
    return parts.join(' | ')
}

function isPublishedStatusText(statusText: string): boolean {
    const normalized = String(statusText || '').toLowerCase()
    if (!normalized) return false
    return normalized.includes('published') ||
        normalized.includes('ready') ||
        normalized.includes('complete') ||
        normalized.includes('completed') ||
        normalized.includes('finish') ||
        normalized.includes('success')
}

function shouldPollAfterFinishError(rawError: unknown): boolean {
    const parsed = parseFacebookErrorLike(rawError)
    const code = Number(parsed?.code || 0)
    const subcode = Number(parsed?.error_subcode || 0)
    const message = String(parsed?.message || (rawError instanceof Error ? rawError.message : String(rawError))).toLowerCase()

    // Important: Facebook may return code 200 with "Video is Processing"
    // which is a transient state, not a true permission denial.
    if (isVideoProcessingErrorMessage(message)) return true

    if (code === 190 || subcode === 463 || subcode === 467) return false // auth token expired/invalid
    if (code === 200) return false // permission error
    if (message.includes('log in to www.facebook.com')) return false
    if (message.includes('permission')) return false
    if (message.includes('access token')) return false
    if (message.includes('checkpoint')) return false
    return true
}

async function pollPublishedReelAfterProcessing(params: {
    accessToken: string
    fbVideoId: string
    logPrefix: string
}): Promise<{ published: boolean; post_id?: string; permalink_url?: string }> {
    const pollDelays = [3000, 5000, 8000, 12000, 15000, 20000, 25000, 30000]

    for (let i = 0; i < pollDelays.length; i++) {
        await waitMs(pollDelays[i])
        try {
            const detail = await facebookGraphRawGet<{ id?: string; post_id?: string; permalink_url?: string; status?: unknown }>(
                `${FB_GRAPH_V19}/${params.fbVideoId}`,
                { fields: 'id,post_id,permalink_url,status', access_token: params.accessToken },
            )
            const objectId = String(detail?.id || '').trim()
            const postId = String(detail?.post_id || '').trim()
            const permalink = String(detail?.permalink_url || '').trim()
            const statusText = extractStatusText(detail?.status)
            console.log(`[${params.logPrefix}] poll upload status attempt ${i + 1}/${pollDelays.length}: ${statusText || 'no-status'}`)

            if (postId) {
                console.log(`[${params.logPrefix}] publish confirmed by post_id: ${postId}`)
                return { published: true, post_id: postId, permalink_url: permalink || undefined }
            }

            if (permalink && objectId) {
                console.log(`[${params.logPrefix}] publish confirmed by permalink + object id: ${objectId}`)
                return { published: true, post_id: objectId, permalink_url: permalink }
            }

            if (isPublishedStatusText(statusText) && objectId) {
                console.log(`[${params.logPrefix}] publish confirmed by published status + object id: ${objectId}`)
                return { published: true, post_id: objectId, permalink_url: permalink || undefined }
            }
        } catch (e) {
            const msg = parseFacebookErrorLike(e)?.message || (e instanceof Error ? e.message : String(e))
            console.log(`[${params.logPrefix}] poll upload status attempt ${i + 1} failed: ${msg}`)
        }
    }

    return { published: false }
}

function normalizeCaptionForMatch(input: string): string {
    return String(input || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeFacebookPermalink(rawPermalink: string): string {
    const cleaned = String(rawPermalink || '').trim()
    if (!cleaned) return ''
    if (cleaned.startsWith('/')) return `https://www.facebook.com${cleaned}`
    return cleaned
}

function extractReelIdFromPermalink(permalink: string): string {
    const clean = String(permalink || '').trim()
    if (!clean) return ''
    const reelMatch = clean.match(/\/reel\/(\d+)/i)
    if (reelMatch?.[1]) return reelMatch[1]
    const watchMatch = clean.match(/[?&]v=(\d+)/i)
    if (watchMatch?.[1]) return watchMatch[1]
    return ''
}

async function recoverPublishedReelFromRecentFeed(params: {
    accessToken: string
    pageId: string
    expectedCaption?: string
    notBeforeIso?: string
    logPrefix: string
}): Promise<{ published: boolean; post_id?: string; permalink_url?: string }> {
    const fallbackWindowMs = 15 * 60 * 1000
    const notBeforeRaw = params.notBeforeIso ? Date.parse(params.notBeforeIso) : Date.now() - fallbackWindowMs
    const notBeforeMs = Number.isFinite(notBeforeRaw) ? notBeforeRaw : Date.now() - fallbackWindowMs
    const oldestAllowed = notBeforeMs - 120000
    const expectedNorm = normalizeCaptionForMatch(params.expectedCaption || '')

    const feed = await facebookGraphRawGet<{ data?: Array<{ id?: string; created_time?: string; permalink_url?: string; message?: string }> }>(
        `${FB_GRAPH_V19}/${params.pageId}/feed`,
        { fields: 'id,created_time,permalink_url,message', limit: '15', access_token: params.accessToken },
    )

    const items = Array.isArray(feed?.data) ? feed.data : []
    for (const item of items) {
        const createdTime = String(item?.created_time || '').trim()
        const createdMs = createdTime ? Date.parse(createdTime) : Number.NaN
        if (Number.isFinite(createdMs) && createdMs < oldestAllowed) continue

        const message = String(item?.message || '').trim()
        if (expectedNorm) {
            const messageNorm = normalizeCaptionForMatch(message)
            if (!messageNorm) continue
            const isExact = messageNorm === expectedNorm
            const isPrefixLike = messageNorm.startsWith(expectedNorm) || expectedNorm.startsWith(messageNorm)
            if (!isExact && !isPrefixLike) continue
        }

        const permalink = normalizeFacebookPermalink(String(item?.permalink_url || ''))
        const reelId = extractReelIdFromPermalink(permalink)
        const fallbackId = String(item?.id || '').trim()
        const postId = reelId || fallbackId
        if (!postId) continue

        console.log(`[${params.logPrefix}] recovered from page feed: ${postId}`)
        return {
            published: true,
            post_id: postId,
            permalink_url: permalink || (reelId ? `https://www.facebook.com/reel/${reelId}/` : undefined),
        }
    }

    return { published: false }
}

async function finishReelPublishWithRetry(params: {
    accessToken: string
    pageId: string
    fbVideoId: string
    description: string
    logPrefix: string
}): Promise<{ success?: boolean; post_id?: string; permalink_url?: string }> {
    const retryDelaysMs = [0, 3000, 7000, 12000]
    let lastError: unknown = null
    let finishAccepted = false
    let finishPermalink: string | undefined

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
        const delayMs = retryDelaysMs[attempt]
        if (delayMs > 0) {
            console.log(`[${params.logPrefix}] finish retry wait ${delayMs}ms (attempt ${attempt + 1}/${retryDelaysMs.length})`)
            await waitMs(delayMs)
        }

        try {
            const finishResult = await facebookGraphPost<{ success?: boolean; permalink_url?: string }>(
                params.accessToken,
                `${FB_GRAPH_V19}/${params.pageId}/video_reels`,
                {
                    upload_phase: 'finish',
                    video_id: params.fbVideoId,
                    video_state: 'PUBLISHED',
                    description: params.description,
                },
            )
            finishAccepted = true
            finishPermalink = String(finishResult?.permalink_url || '').trim() || undefined
            break
        } catch (e) {
            lastError = e
            const parsed = parseFacebookErrorLike(e)
            const message = parsed?.message || (e instanceof Error ? e.message : String(e))
            const shouldRetry = isVideoProcessingErrorMessage(message)
            console.error(`[${params.logPrefix}] finish attempt ${attempt + 1}/${retryDelaysMs.length} failed: ${message}`)

            if (!shouldRetry || attempt === retryDelaysMs.length - 1) {
                break
            }
        }
    }

    if (finishAccepted || (lastError && shouldPollAfterFinishError(lastError))) {
        const recovered = await pollPublishedReelAfterProcessing({
            accessToken: params.accessToken,
            fbVideoId: params.fbVideoId,
            logPrefix: params.logPrefix,
        })
        if (recovered.published && recovered.post_id) {
            console.log(`[${params.logPrefix}] finish recovered: reel published after processing delay`)
            return {
                success: true,
                post_id: recovered.post_id,
                permalink_url: recovered.permalink_url || finishPermalink,
            }
        }
    }

    if (lastError) {
        throw lastError
    }

    if (finishAccepted) {
        throw new Error('facebook_publish_not_confirmed_no_post_id')
    }

    throw (lastError || new Error('facebook_finish_failed'))
}

async function initReelUploadWithPostingTokenFallback(params: {
    pageId: string
    postTokens: string[]
    logPrefix: string
}): Promise<{
    video_id?: string
    upload_url?: string
    postingToken: string
    tried: number
}> {
    const candidates = normalizePostTokenPool(params.postTokens || [])
    if (candidates.length === 0) throw new FacebookRequestFailedError('facebook_access_token_missing', 0, 0)
    const path = `${FB_GRAPH_V19}/${params.pageId}/video_reels`
    const errors: string[] = []

    for (const token of candidates) {
        try {
            const initData = await facebookGraphPost<{ video_id?: string; upload_url?: string }>(
                token,
                path,
                { upload_phase: 'start' },
            )
            const videoId = String(initData.video_id || '').trim()
            const uploadUrl = String(initData.upload_url || '').trim()
            if (!videoId || !uploadUrl) {
                throw new Error('No upload URL or video ID returned')
            }
            return {
                ...initData,
                postingToken: token,
                tried: errors.length + 1,
            }
        } catch (err) {
            const msg = parseFacebookErrorLike(err)?.message || (err instanceof Error ? err.message : String(err))
            errors.push(msg)
            console.warn(`[${params.logPrefix}] post token failed, trying next candidate (${msg})`)
        }
    }

    throw new Error(`all_post_tokens_failed: ${errors.join(' | ') || 'unknown_error'}`)
}

function metaToString(meta: Record<string, unknown>, key: string): string {
    const value = meta[key]
    return typeof value === 'string' ? value.trim() : ''
}

const SHOPEE_LINK_KEYS = ['shopeeLink', 'shopee_link', 'shopeeUrl', 'shopee_url', 'shopee', 'link'] as const
const SHOPEE_LINK_RE = /https?:\/\/(?:[^"\s<>]+\.)?(?:shopee\.co\.th|s\.shopee\.co\.th)\S*/i

function pickFirstShopeeUrl(value: unknown): string | null {
    if (typeof value === 'string') {
        const match = value.match(SHOPEE_LINK_RE)
        return match ? match[0].trim() : null
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = pickFirstShopeeUrl(item)
            if (hit) return hit
        }
    }
    return null
}

function normalizeMetaShopeeLink(meta: Record<string, unknown>): string | null {
    for (const key of SHOPEE_LINK_KEYS) {
        const value = meta[key]
        const found = pickFirstShopeeUrl(value)
        if (found) return found
    }
    return null
}

async function resolveShopeeLinkForRetry(params: {
    db: D1Database
    bucket: R2Bucket
    namespaceId: string
    videoId: string
    preferred?: string | null
}): Promise<string> {
    const preferred = pickFirstShopeeUrl(params.preferred || '') || ''
    if (preferred) return preferred

    const ns = String(params.namespaceId || '').trim()
    const vid = String(params.videoId || '').trim()
    if (!ns || !vid) return ''

    try {
        await ensureLinkSubmissionsTable(params.db)
        const fromSub = await params.db.prepare(
            'SELECT shopee_link FROM link_submissions WHERE namespace_id = ? AND video_id = ? ORDER BY datetime(created_at) DESC LIMIT 1'
        ).bind(ns, vid).first() as { shopee_link?: string } | null
        const linkSub = pickFirstShopeeUrl(fromSub?.shopee_link || '') || ''
        if (linkSub) return linkSub
    } catch {
        // ignore lookup errors
    }

    try {
        const metaObj = await params.bucket.get(`videos/${vid}.json`)
        if (metaObj) {
            const meta = await metaObj.json() as Record<string, unknown>
            const link = normalizeMetaShopeeLink(meta) || ''
            if (link) return link
        }
    } catch {
        // ignore
    }

    return ''
}

async function clearVideoShopeeLink(bucket: R2Bucket, videoId: string): Promise<void> {
    const id = String(videoId || '').trim()
    if (!id) return
    try {
        const key = `videos/${id}.json`
        const metaObj = await bucket.get(key)
        if (!metaObj) return

        const meta = await metaObj.json() as Record<string, unknown>
        let changed = false
        for (const linkKey of SHOPEE_LINK_KEYS) {
            if (meta[linkKey] !== undefined) {
                delete meta[linkKey]
                changed = true
            }
        }

        if (!changed) return

        meta.updatedAt = new Date().toISOString()
        await bucket.put(key, JSON.stringify(meta, null, 2), {
            httpMetadata: { contentType: 'application/json' },
        })
        await updateGalleryCache(bucket, id)
    } catch (e) {
        console.error(`[GALLERY] clear Shopee link failed for video ${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
}

async function notifyCommentTokenIssue(
    env: Env,
    botId: string,
    pageId: string,
    pageName: string,
    reason: string,
): Promise<void> {
    const cooldownMs = 15 * 60 * 1000
    const key = `_alerts/comment_token/${botId}/${pageId}.json`
    try {
        const prev = await env.BUCKET.get(key)
        if (prev) {
            const p = await prev.json() as { sent_at?: string }
            const last = p?.sent_at ? new Date(p.sent_at).getTime() : 0
            if (last > 0 && Date.now() - last < cooldownMs) return
        }
    } catch {
        // ignore
    }

    const recipients = new Set<string>()
    try {
        const owners = await env.DB.prepare(
            'SELECT DISTINCT owner_telegram_id FROM channels WHERE bot_id = ?'
        ).bind(botId).all() as { results?: Array<{ owner_telegram_id?: string | number }> }
        for (const row of owners.results || []) {
            const id = String(row.owner_telegram_id || '').trim()
            if (id) recipients.add(id)
        }
    } catch {
        // ignore
    }

    if (recipients.size === 0) {
        try {
            const nsUsers = await env.DB.prepare(
                'SELECT DISTINCT telegram_id FROM users WHERE namespace_id = ? AND telegram_id IS NOT NULL AND TRIM(telegram_id) <> \'\''
            ).bind(botId).all() as { results?: Array<{ telegram_id?: string | number }> }
            for (const row of nsUsers.results || []) {
                const id = String(row.telegram_id || '').trim()
                if (id) recipients.add(id)
            }
        } catch {
            // ignore
        }
    }

    if (recipients.size === 0) {
        console.error(`[COMMENT-ALERT] no admin recipient for botId=${botId}, page=${pageName}, reason=${reason}`)
        return
    }

    const text =
        `⚠️ Auto comment หยุดทำงาน\n` +
        `เพจ: ${pageName}\n` +
        `สาเหตุ: ${reason}\n\n` +
        `กรุณาไปแก้ Comment Token ในหน้า Pages แล้วกด Save\n` +
        `ระบบจะไม่ใช้ token อื่นแทน`

    for (const chatId of recipients) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
            chat_id: chatId,
            text,
        }).catch(() => null)
    }

    await env.BUCKET.put(key, JSON.stringify({
        sent_at: new Date().toISOString(),
        reason,
    }), {
        httpMetadata: { contentType: 'application/json' },
    })
}

// Get all pages
app.get('/api/pages', async (c) => {
    try {
        const botId = c.get('botId')
        const syncCfg = await getNamespacePagesSyncConfig(c.env.DB, botId).catch(() => null)
        const hasTagSelector = Boolean(syncCfg) && (
            syncCfg!.postSelectors.some((s) => parseBrowserSavingTagSelector(s) !== null) ||
            syncCfg!.commentSelectors.some((s) => parseBrowserSavingTagSelector(s) !== null)
        )

        const loadPages = async () => (((await c.env.DB.prepare(
            'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at, updated_at FROM pages WHERE bot_id = ? ORDER BY created_at DESC'
        ).bind(botId).all()).results || []) as any[])
        const current = await loadPages()

        // Tag mode is source-of-truth from BrowserSaving profile tags.
        // Keep this endpoint fast with metadata-only sync for immediate UI.
        if (hasTagSelector) {
            await syncTaggedPagesFromProfileMetadata(c.env, botId).catch((e) => {
                console.log(`[PAGES] quick tag-metadata sync failed: ${String(e)}`)
            })
            const refreshed = await loadPages()
            if (refreshed.length > 0) return c.json({ pages: refreshed })
            return c.json({ pages: current })
        }

        if (current.length > 0) return c.json({ pages: current })

        const syncPromise = autoSyncPagesForNamespace(c.env, botId)
        const timeoutMs = 8000
        const timed = await Promise.race([
            syncPromise.then(() => true).catch(() => false),
            waitMs(timeoutMs).then(() => false),
        ])
        if (!timed) {
            c.executionCtx.waitUntil(syncPromise.catch(() => undefined))
            return c.json({ pages: current })
        }

        const refreshed = await loadPages()

        return c.json({ pages: refreshed })
    } catch (e) {
        return c.json({ error: 'Failed to fetch pages' }, 500)
    }
})

app.get('/api/dashboard', async (c) => {
    try {
        const botId = c.get('botId')
        const requestedDate = String(c.req.query('date') || '').trim()
        const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
            ? requestedDate
            : toThaiDateString(new Date())

        await ensureLinkSubmissionsTable(c.env.DB)

        const [postsAllRow, postsOnDateRow, linksAllRow, linksOnDateRow, usersRes, linksByAdminRes] = await Promise.all([
            c.env.DB.prepare(
                "SELECT COUNT(*) AS total FROM post_history WHERE bot_id = ? AND status IN ('success','posting')"
            ).bind(botId).first() as Promise<{ total?: number } | null>,
            c.env.DB.prepare(
                "SELECT COUNT(*) AS total FROM post_history WHERE bot_id = ? AND status IN ('success','posting') AND date(datetime(posted_at, '+7 hours')) = ?"
            ).bind(botId, targetDate).first() as Promise<{ total?: number } | null>,
            c.env.DB.prepare(
                'SELECT COUNT(*) AS total FROM link_submissions WHERE namespace_id = ?'
            ).bind(botId).first() as Promise<{ total?: number } | null>,
            c.env.DB.prepare(
                "SELECT COUNT(*) AS total FROM link_submissions WHERE namespace_id = ? AND date(datetime(created_at, '+7 hours')) = ?"
            ).bind(botId, targetDate).first() as Promise<{ total?: number } | null>,
            c.env.DB.prepare(
                'SELECT telegram_id, email FROM users WHERE namespace_id = ? AND telegram_id IS NOT NULL AND TRIM(telegram_id) <> \'\''
            ).bind(botId).all() as Promise<{ results?: Array<{ telegram_id?: string | number; email?: string }> }>,
            c.env.DB.prepare(
                "SELECT telegram_id, COUNT(*) AS total FROM link_submissions WHERE namespace_id = ? AND date(datetime(created_at, '+7 hours')) = ? GROUP BY telegram_id"
            ).bind(botId, targetDate).all() as Promise<{ results?: Array<{ telegram_id?: string | number; total?: number }> }>,
        ])

        const emailByTelegram = new Map<string, string>()
        for (const row of usersRes.results || []) {
            const telegramId = String(row?.telegram_id || '').trim()
            const email = String(row?.email || '').trim().toLowerCase()
            if (telegramId && email && !emailByTelegram.has(telegramId)) {
                emailByTelegram.set(telegramId, email)
            }
        }

        const adminMap = new Map<string, { telegram_id: string; email: string; links: number }>()
        for (const row of linksByAdminRes.results || []) {
            const telegramId = String(row?.telegram_id || '').trim()
            const count = Math.max(0, Number(row?.total || 0))
            if (!count) continue
            const key = telegramId || 'unknown'
            const existing = adminMap.get(key)
            if (existing) {
                existing.links += count
                continue
            }

            const email = telegramId
                ? (emailByTelegram.get(telegramId) || `telegram:${telegramId}`)
                : 'unknown'

            adminMap.set(key, {
                telegram_id: telegramId || '-',
                email,
                links: count,
            })
        }

        const admins = Array.from(adminMap.values()).sort((a, b) => {
            if (b.links !== a.links) return b.links - a.links
            return a.email.localeCompare(b.email)
        })

        return c.json({
            date: targetDate,
            totals: {
                posts_all: Number(postsAllRow?.total || 0),
                posts_on_date: Number(postsOnDateRow?.total || 0),
                links_all: Number(linksAllRow?.total || 0),
                links_on_date: Number(linksOnDateRow?.total || 0),
            },
            admins,
        })
    } catch (e) {
        console.error(`[DASHBOARD] Failed to build dashboard: ${String(e)}`)
        return c.json({ error: 'Failed to fetch dashboard' }, 500)
    }
})

// Get single page
app.get('/api/pages/:id', async (c) => {
    const id = c.req.param('id')
    try {
        const page = await c.env.DB.prepare(
            'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at, updated_at FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(id, c.get('botId')).first()
        if (!page) return c.json({ error: 'Page not found' }, 404)
        return c.json({ page })
    } catch (e) {
        return c.json({ error: 'Failed to fetch page' }, 500)
    }
})

app.get('/api/pages/:id/tag-profiles', async (c) => {
    const pageId = String(c.req.param('id') || '').trim()
    const botId = c.get('botId')

    if (!pageId) return c.json({ error: 'Page ID is required' }, 400)

    try {
        const page = await c.env.DB.prepare(
            'SELECT id, name FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(pageId, botId).first() as { id?: string; name?: string } | null

        if (!page?.id) return c.json({ error: 'Page not found' }, 404)

        const cfg = await getNamespacePagesSyncConfig(c.env.DB, botId)
        const profiles = await fetchBrowserSavingProfiles(c.env)
        const postProfiles = collectProfilesBySelectors(profiles, cfg.postSelectors)
        const commentProfiles = collectProfilesBySelectors(profiles, cfg.commentSelectors)

        const byProfileId = new Map<string, {
            profile_id: string
            profile_name: string
            facebook_name: string
            roles: Array<'post' | 'comment'>
            tags: string[]
            post_token: string
            comment_token: string
        }>()

        const upsertRole = (profile: BrowserSavingProfileRecord, role: 'post' | 'comment') => {
            if (!matchesProfileToPage(profile, String(page.id || ''), String(page.name || ''))) return

            const id = String(profile.id || '').trim()
            if (!id) return
            const key = id.toLowerCase()
            const profileName = String(profile.name || '').trim() || id
            const facebookName = String(profile.username || profile.uid || '').trim()
            const tags = normalizeBrowserSavingProfileTags(profile.tags)

            const existing = byProfileId.get(key)
            if (!existing) {
                const postToken = pickProfilePostToken(profile)
                const commentToken = pickProfileCommentToken(profile)
                byProfileId.set(key, {
                    profile_id: id,
                    profile_name: profileName,
                    facebook_name: facebookName,
                    roles: [role],
                    tags,
                    post_token: postToken,
                    comment_token: commentToken,
                })
                return
            }

            if (!existing.roles.includes(role)) existing.roles.push(role)
            if (!existing.facebook_name && facebookName) existing.facebook_name = facebookName
            if (!existing.post_token) existing.post_token = pickProfilePostToken(profile)
            if (!existing.comment_token) existing.comment_token = pickProfileCommentToken(profile)
            if (existing.tags.length === 0 && tags.length > 0) existing.tags = tags
        }

        for (const profile of postProfiles) upsertRole(profile, 'post')
        for (const profile of commentProfiles) upsertRole(profile, 'comment')

        const items = Array.from(byProfileId.values()).sort((a, b) => {
            const aBoth = a.roles.length > 1 ? 1 : 0
            const bBoth = b.roles.length > 1 ? 1 : 0
            if (aBoth !== bBoth) return bBoth - aBoth
            if (a.roles.includes('post') !== b.roles.includes('post')) {
                return a.roles.includes('post') ? -1 : 1
            }
            return a.profile_name.localeCompare(b.profile_name)
        })

        const resolvedItems = await Promise.all(items.map(async (item) => {
            let post_token = String(item.post_token || '').trim()
            let comment_token = String(item.comment_token || '').trim()
            let post_token_scoped = false
            let comment_token_scoped = false

            if (item.roles.includes('post') && post_token) {
                try {
                    const resolved = await resolvePageScopedToken(post_token, String(page.id || ''), c.env, 'post')
                    if (resolved.token) {
                        post_token = String(resolved.token).trim()
                        post_token_scoped = true
                    } else {
                        post_token = ''
                    }
                } catch {
                    post_token = ''
                }
            }

            if (item.roles.includes('comment') && comment_token) {
                try {
                    const resolved = await resolvePageScopedToken(comment_token, String(page.id || ''), c.env, 'comment')
                    if (resolved.token) {
                        comment_token = String(resolved.token).trim()
                        comment_token_scoped = true
                    } else {
                        comment_token = ''
                    }
                } catch {
                    comment_token = ''
                }
            }

            return { ...item, post_token, comment_token, post_token_scoped, comment_token_scoped }
        }))

        try {
            const pageRecord = await c.env.DB.prepare(
                'SELECT access_token, comment_token FROM pages WHERE id = ? AND bot_id = ?'
            ).bind(String(page.id || ''), botId).first() as { access_token?: string | null; comment_token?: string | null } | null

            const storedAccess = String(pageRecord?.access_token || '').trim()
            const storedComment = String(pageRecord?.comment_token || '').trim()
            let storedAccessScoped = storedAccess
            let storedCommentScoped = storedComment
            if (storedAccess) {
                try {
                    const accessResolved = await resolvePageScopedToken(storedAccess, String(page.id || ''), c.env, 'post')
                    storedAccessScoped = String(accessResolved.token || '').trim()
                } catch {
                    storedAccessScoped = ''
                }
            }
            if (storedComment) {
                try {
                    const commentResolved = await resolvePageScopedToken(storedComment, String(page.id || ''), c.env, 'comment')
                    storedCommentScoped = String(commentResolved.token || '').trim()
                } catch {
                    storedCommentScoped = ''
                }
            }

            const discoveredPostTokens = normalizePostTokenPool(
                resolvedItems
                    .filter((item) => item.roles.includes('post') && item.post_token_scoped)
                    .map((item) => String(item.post_token || '').trim()),
            )
            const discoveredCommentTokens = normalizeCommentTokenPool(
                resolvedItems
                    .filter((item) => item.roles.includes('comment') && item.comment_token_scoped)
                    .map((item) => String(item.comment_token || '').trim()),
            )

            const tokenPool = await getNamespacePagesTokenPool(c.env.DB, botId)
            const existingEntry = tokenPool[String(page.id || '')] || { post_tokens: [], comment_tokens: [] }

            const nextPostPool = normalizePostTokenPool([
                ...(existingEntry.post_tokens || []),
                ...(discoveredPostTokens || []),
                storedAccessScoped,
            ])
            const nextCommentPool = normalizeCommentTokenPool([
                ...(existingEntry.comment_tokens || []),
                ...(discoveredCommentTokens || []),
                storedCommentScoped,
            ])

            const nextAccess = storedAccessScoped || nextPostPool[0] || ''
            const nextComment = preferCommentToken(storedComment, storedCommentScoped || nextCommentPool[0] || '')

            if (
                nextAccess !== storedAccess ||
                nextComment !== storedComment ||
                !sameTokenList(existingEntry.post_tokens || [], nextPostPool) ||
                !sameTokenList(existingEntry.comment_tokens || [], nextCommentPool)
            ) {
                await c.env.DB.prepare(
                    'UPDATE pages SET access_token = ?, comment_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                ).bind(nextAccess || null, nextComment || null, String(page.id || ''), botId).run()

                tokenPool[String(page.id || '')] = {
                    post_tokens: nextPostPool,
                    comment_tokens: nextCommentPool,
                    updated_at: new Date().toISOString(),
                }
                await setNamespacePagesTokenPool(c.env.DB, botId, tokenPool)
            }
        } catch (e) {
            console.log(`[TAG-PROFILES] token sync before display failed: ${e instanceof Error ? e.message : String(e)}`)
        }

        return c.json({
            page: { id: String(page.id || ''), name: String(page.name || '') },
            summary: {
                profiles_total: items.length,
                post_profiles: items.filter((item) => item.roles.includes('post')).length,
                comment_profiles: items.filter((item) => item.roles.includes('comment')).length,
            },
            profiles: resolvedItems,
        })
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return c.json({ error: `Failed to fetch tagged profiles: ${message}` }, 500)
    }
})

app.put('/api/pages/:id/tag-profiles/:profileId/token', async (c) => {
    const pageId = String(c.req.param('id') || '').trim()
    const profileId = String(c.req.param('profileId') || '').trim()
    const botId = c.get('botId')

    if (!pageId) return c.json({ error: 'Page ID is required' }, 400)
    if (!profileId || !looksLikeBrowserSavingProfileId(profileId)) {
        return c.json({ error: 'Profile ID is invalid' }, 400)
    }

    let body: any = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const modeRaw = String(body?.mode || '').trim().toLowerCase()
    const mode: BrowserSavingTokenMode | null = modeRaw === 'post' || modeRaw === 'comment'
        ? modeRaw
        : null
    if (!mode) {
        return c.json({ error: 'mode must be post or comment' }, 400)
    }

        const token = String(body?.token || '').trim()

    try {
        const page = await c.env.DB.prepare(
            'SELECT id, name FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(pageId, botId).first() as { id?: string; name?: string } | null
        if (!page?.id) return c.json({ error: 'Page not found' }, 404)

        const cfg = await getNamespacePagesSyncConfig(c.env.DB, botId)
        const profiles = await fetchBrowserSavingProfiles(c.env)
        const scopedProfiles = collectProfilesBySelectors(
            profiles,
            mode === 'post' ? cfg.postSelectors : cfg.commentSelectors,
        ).filter((profile) => {
            return matchesProfileToPage(profile, String(page.id || ''), String(page.name || ''))
        })

        const targetProfile = scopedProfiles.find((profile) => {
            return String(profile.id || '').trim().toLowerCase() === profileId.toLowerCase()
        })
        if (!targetProfile) {
            return c.json({
                error: 'Profile not found in tagged profiles for this page',
                code: 'PROFILE_NOT_TAGGED_FOR_PAGE',
            }, 404)
        }

        const updatePayload: Record<string, string | null> = mode === 'post'
            ? { postcron_token: token || null }
            : { comment_token: token || null }

        const endpointBases = buildBrowserSavingBaseUrls(c.env)
        const path = `/api/profiles/${encodeURIComponent(profileId)}`
        const errors: string[] = []

        for (const baseUrl of endpointBases) {
            const label = buildBrowserSavingRequestLabel(baseUrl, path)
            try {
                const resp = await fetchFromBrowserSavingBase(c.env, baseUrl, path, {
                    method: 'PUT',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(updatePayload),
                })
                const data = await resp.json().catch(() => ({} as any)) as any
                if (!resp.ok) {
                    const details = String(data?.error || data?.details || `HTTP ${resp.status}`)
                    errors.push(`${label}: ${details}`)
                    continue
                }

                const profile = data?.profile || null
                const savedTokenRaw = mode === 'post'
                    ? String(profile?.postcron_token || '').trim()
                    : String(profile?.comment_token || '').trim()
                const savedToken = token
                    ? (savedTokenRaw || token)
                    : ''
                let scopedToken = ''
                let scopedSource = ''
                let scopedReason = ''

                if (savedToken) {
                    const scoped = await resolvePageScopedToken(savedToken, pageId, c.env, mode)
                    scopedSource = String(scoped.source || '')
                    scopedReason = String(scoped.reason || '')
                    scopedToken = String(scoped.token || '').trim()
                    if (!scopedToken) {
                        const reason = String(scoped.reason || 'token_conversion_failed')
                        errors.push(`${label}: page_token_conversion_failed_${reason}`)
                        continue
                    }
                }
                if (!savedToken) {
                    scopedToken = ''
                }

                let sync_error: string | undefined
                try {
                    await autoSyncPagesForNamespace(c.env, botId)
                } catch (syncErr) {
                    sync_error = syncErr instanceof Error ? syncErr.message : String(syncErr)
                }

                if (mode === 'post') {
                    await c.env.DB.prepare(
                        'UPDATE pages SET access_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                    ).bind(scopedToken || null, pageId, botId).run()
                } else {
                    await c.env.DB.prepare(
                        'UPDATE pages SET comment_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                    ).bind(scopedToken || null, pageId, botId).run()
                }

                try {
                    const tokenPool = await getNamespacePagesTokenPool(c.env.DB, botId)
                    const existingEntry = tokenPool[pageId] || { post_tokens: [], comment_tokens: [] }
                    const nextPostTokens = mode === 'post'
                        ? normalizePostTokenPool([scopedToken, ...(existingEntry.post_tokens || [])])
                        : normalizePostTokenPool(existingEntry.post_tokens || [])
                    const nextCommentTokens = mode === 'comment'
                        ? normalizeCommentTokenPool([scopedToken, ...(existingEntry.comment_tokens || [])])
                        : normalizeCommentTokenPool(existingEntry.comment_tokens || [])
                    tokenPool[pageId] = {
                        post_tokens: nextPostTokens,
                        comment_tokens: nextCommentTokens,
                        updated_at: new Date().toISOString(),
                    }
                    await setNamespacePagesTokenPool(c.env.DB, botId, tokenPool)
                } catch (e) {
                    console.log(`[PAGES-TOKEN-POOL] failed to update token pool for page ${pageId}: ${e instanceof Error ? e.message : String(e)}`)
                }

                if (mode === 'comment') {
                    const issueKey = `_alerts/comment_token/${botId}/${pageId}.json`
                    await c.env.BUCKET.delete(issueKey).catch(() => undefined)
                }

                return c.json({
                    success: true,
                    page_id: pageId,
                    profile_id: profileId,
                    mode,
                    token: scopedToken || savedToken,
                    scoped_token: scopedToken || '',
                    token_scope: scopedSource,
                    scope_reason: scopedReason,
                    sync_error,
                })
            } catch (e) {
                errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
            }
        }

        return c.json({
            error: 'Failed to update BrowserSaving profile token',
            details: errors.join(' | ') || 'no_endpoint_available',
        }, 502)
    } catch (e) {
        return c.json({ error: `Failed to update tagged profile token: ${e instanceof Error ? e.message : String(e)}` }, 500)
    }
})

// Create page
app.post('/api/pages', async (c) => {
    try {
        const body = await c.req.json()
        const { id, name, image_url, access_token, post_interval_minutes = 60 } = body
        const botId = c.get('botId')
        const postToken = String(access_token || '').trim()
        const existingInNamespace = await c.env.DB.prepare(
            'SELECT id FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(id, botId).first()
        if (existingInNamespace) {
            return c.json({ success: true, id, updated: false })
        }

        const existingInOtherNamespace = await c.env.DB.prepare(
            'SELECT bot_id FROM pages WHERE id = ?'
        ).bind(id).first() as any
        if (existingInOtherNamespace?.bot_id) {
            return c.json({
                error: 'Page is already connected to another workspace',
                code: 'PAGE_ALREADY_BOUND',
                existing_bot_id: String(existingInOtherNamespace.bot_id),
            }, 409)
        }

        await c.env.DB.prepare(
            'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, bot_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, name, image_url, postToken, post_interval_minutes, botId).run()

        return c.json({ success: true, id })
    } catch (e) {
        return c.json({ error: 'Failed to create page' }, 500)
    }
})

// Update page settings
app.put('/api/pages/:id', async (c) => {
    const id = c.req.param('id')
    try {
        const body = await c.req.json()
        const { post_interval_minutes, post_hours, is_active, access_token, comment_token } = body
        let normalizedPostHours = post_hours as string | undefined
        let normalizedInterval = post_interval_minutes as number | undefined

        const page = await c.env.DB.prepare(
            'SELECT id, access_token FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(id, c.get('botId')).first() as { id: string; access_token?: string | null } | null
        if (!page) return c.json({ error: 'Page not found' }, 404)
        let effectivePostToken = String(page.access_token || '').trim()

        // Normalize schedule payload:
        // - Slot mode: "2:10,9:35,16:42"
        // - Interval mode: "every:30"
        if (typeof normalizedPostHours === 'string') {
            const trimmed = normalizedPostHours.trim()
            const intervalMatch = trimmed.match(/^every:(\d{1,4})$/i)
            if (intervalMatch) {
                const parsed = Math.max(5, Math.min(720, parseInt(intervalMatch[1], 10) || 60))
                normalizedPostHours = `every:${parsed}`
                if (normalizedInterval === undefined) normalizedInterval = parsed
            } else {
                normalizedPostHours = trimmed
            }
        }
        if (normalizedInterval !== undefined) {
            const parsed = Number(normalizedInterval)
            normalizedInterval = Math.max(5, Math.min(720, Number.isFinite(parsed) ? Math.floor(parsed) : 60))
        }

        const tokenUpdated = access_token !== undefined || comment_token !== undefined

        // Update access_token if provided
        const resolved: { access_token?: string; comment_token?: string } = {}
        const resolved_details: { access_token?: string; comment_token?: string } = {}
        if (access_token !== undefined) {
            const accessResolved = await resolvePageScopedToken(String(access_token), id, c.env, 'post')
            await c.env.DB.prepare(
                'UPDATE pages SET access_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
            ).bind(accessResolved.token, id, c.get('botId')).run()
            effectivePostToken = String(accessResolved.token || '').trim()
            resolved.access_token = accessResolved.source
            if (accessResolved.reason) resolved_details.access_token = accessResolved.reason
        }

        // Update comment_token if provided
        if (comment_token !== undefined) {
            const commentRaw = String(comment_token || '').trim()
            let commentToSave = ''
            if (commentRaw) {
                const commentResolved = await resolvePageScopedToken(commentRaw, id, c.env, 'comment')
                commentToSave = commentResolved.token
                resolved.comment_token = commentResolved.source
                if (commentResolved.reason) resolved_details.comment_token = commentResolved.reason
            } else {
                resolved.comment_token = 'provided_as_is'
            }
            await c.env.DB.prepare(
                'UPDATE pages SET comment_token = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
            ).bind(commentToSave, id, c.get('botId')).run()
        }

        // Support both old interval and new hours-based scheduling
        if (normalizedPostHours !== undefined) {
            if (is_active !== undefined) {
                await c.env.DB.prepare(
                    'UPDATE pages SET post_hours = ?, is_active = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                ).bind(normalizedPostHours, is_active ? 1 : 0, id, c.get('botId')).run()
            } else {
                await c.env.DB.prepare(
                    'UPDATE pages SET post_hours = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                ).bind(normalizedPostHours, id, c.get('botId')).run()
            }
        }
        if (normalizedInterval !== undefined) {
            if (is_active !== undefined) {
                await c.env.DB.prepare(
                    'UPDATE pages SET post_interval_minutes = ?, is_active = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                ).bind(normalizedInterval, is_active ? 1 : 0, id, c.get('botId')).run()
            } else {
                await c.env.DB.prepare(
                    'UPDATE pages SET post_interval_minutes = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                ).bind(normalizedInterval, id, c.get('botId')).run()
            }
        }
        if (is_active !== undefined && normalizedPostHours === undefined && normalizedInterval === undefined) {
            await c.env.DB.prepare(
                'UPDATE pages SET is_active = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
            ).bind(is_active ? 1 : 0, id, c.get('botId')).run()
        }
        if (tokenUpdated) {
            const issueKey = `_alerts/comment_token/${c.get('botId')}/${id}.json`
            await c.env.BUCKET.delete(issueKey).catch(() => undefined)
        }

        const updatedPage = await c.env.DB.prepare(
            'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at, updated_at FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(id, c.get('botId')).first()

        return c.json({ success: true, resolved, resolved_details, page: updatedPage })
    } catch (e) {
        return c.json({ error: 'Failed to update page' }, 500)
    }
})

// Delete page
app.delete('/api/pages/:id', async (c) => {
    const id = c.req.param('id')
    try {
        const deleted = await c.env.DB.prepare('DELETE FROM pages WHERE id = ? AND bot_id = ?').bind(id, c.get('botId')).run() as any
        if (!deleted?.meta?.changes) return c.json({ error: 'Page not found' }, 404)
        return c.json({ success: true })
    } catch (e) {
        return c.json({ error: 'Failed to delete page' }, 500)
    }
})

// ==================== FACEBOOK IMPORT ====================

app.post('/api/pages/import', async (c) => {
    try {
        const body = await c.req.json()
        const { user_token, post_profile_id, comment_profile_id, post_user_token, comment_user_token } = body || {}
        const botId = c.get('botId')

        const legacyInput = String(user_token || '').trim()
        const postRawInput = String(post_profile_id || post_user_token || legacyInput).trim()
        const commentRawInput = String(comment_profile_id || comment_user_token || '').trim()

        if (!postRawInput) {
            return c.json({ error: 'Post profile ID/token is required' }, 400)
        }
        if (!commentRawInput) {
            return c.json({ error: 'Comment profile ID/token is required' }, 400)
        }

        let postImportToken = postRawInput
        let postImportSource: 'browsersaving_profile_id' | 'provided_as_is' = 'provided_as_is'
        let postImportReason = ''
        try {
            const resolved = await resolveUserTokenInput(c.env, postRawInput, 'post')
            postImportToken = resolved.token
            postImportSource = resolved.source
            postImportReason = String(resolved.reason || '')
        } catch (e) {
            return c.json({
                error: 'Failed to resolve post token input',
                details: e instanceof Error ? e.message : String(e),
            }, 400)
        }

        let commentImportToken = commentRawInput
        let commentImportSource: 'browsersaving_profile_id' | 'provided_as_is' = 'provided_as_is'
        let commentImportReason = ''
        try {
            const resolved = await resolveUserTokenInput(c.env, commentRawInput, 'comment')
            commentImportToken = resolved.token
            commentImportSource = resolved.source
            commentImportReason = String(resolved.reason || '')
        } catch (e) {
            return c.json({
                error: 'Failed to resolve comment token input',
                details: e instanceof Error ? e.message : String(e),
            }, 400)
        }

        let fbPages: Array<{ id?: string; name?: string; picture?: { data?: { url?: string } }; access_token?: string }> = []
        try {
            fbPages = await fetchMeAccountsViaHttp(postImportToken)
        } catch (e) {
            const parsed = parseFacebookErrorLike(e)
            return c.json({
                error: 'Facebook API error',
                details: parsed?.message || (e instanceof Error ? e.message : 'Unknown error')
            }, 400)
        }

        if (fbPages.length === 0) {
            return c.json({ error: 'No pages found for this account' }, 404)
        }

        const imported: { id: string; name: string }[] = []
        const updated: { id: string; name: string; reason: string }[] = []
        const conflicts: { id: string; name: string; reason: string; existing_bot_id: string }[] = []
        const invalidPostTokenPages: { id: string; name: string; reason: string }[] = []
        const commentPageTokenById = new Map<string, string>()

        if (String(commentImportToken || '').trim()) {
            try {
                const commentPages = await fetchMeAccountsViaHttp(commentImportToken)
                for (const item of commentPages) {
                    const id = String(item?.id || '').trim()
                    const token = String(item?.access_token || '').trim()
                    if (!id || !isCommentRoleToken(token)) continue
                    if (!commentPageTokenById.has(id)) commentPageTokenById.set(id, token)
                }
            } catch (e) {
                const parsed = parseFacebookErrorLike(e)
                return c.json({
                    error: 'Failed to resolve comment page tokens via /me/accounts',
                    details: parsed?.message || (e instanceof Error ? e.message : String(e)),
                }, 400)
            }
        }

        for (const fbPage of fbPages) {
            const pageId = String(fbPage.id || '').trim()
            if (!pageId) continue
            const pageName = String(fbPage.name || '').trim() || pageId
            const pageImageUrl = pageId
                ? `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`
                : (fbPage.picture?.data?.url || '')
            const pageAccessToken = String(fbPage.access_token || '').trim()
            if (!isPostRoleToken(pageAccessToken)) {
                invalidPostTokenPages.push({
                    id: pageId,
                    name: pageName,
                    reason: 'post_token_prefix_invalid_from_me_accounts',
                })
                continue
            }
            const pageCommentTokenRaw = String(commentPageTokenById.get(pageId) || '').trim()

            const existingInNamespace = await c.env.DB.prepare(
                'SELECT id, comment_token FROM pages WHERE id = ? AND bot_id = ?'
            ).bind(pageId, botId).first() as { id?: string; comment_token?: string | null } | null

            if (existingInNamespace?.id) {
                const existingCommentToken = String(existingInNamespace.comment_token || '').trim()
                const pageCommentToken = preferCommentToken(existingCommentToken, pageCommentTokenRaw)
                await c.env.DB.prepare(
                    'UPDATE pages SET access_token = ?, comment_token = ?, image_url = ?, name = ?, updated_at = datetime("now") WHERE id = ? AND bot_id = ?'
                ).bind(pageAccessToken, pageCommentToken || null, pageImageUrl, pageName, pageId, botId).run()
                updated.push({ id: pageId, name: pageName, reason: 'updated' })
                continue
            }

            // Important: pages.id is globally unique in current schema.
            // If this page exists in another workspace, do not overwrite cross-tenant data.
            const existingInOtherNamespace = await c.env.DB.prepare(
                'SELECT bot_id FROM pages WHERE id = ?'
            ).bind(pageId).first() as any
            if (existingInOtherNamespace?.bot_id) {
                conflicts.push({
                    id: pageId,
                    name: pageName,
                    reason: 'already_connected_to_other_workspace',
                    existing_bot_id: String(existingInOtherNamespace.bot_id),
                })
            } else {
                const pageCommentToken = preferCommentToken('', pageCommentTokenRaw)
                await c.env.DB.prepare(
                    'INSERT INTO pages (id, name, image_url, access_token, comment_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, ?, 60, 1, ?)'
                ).bind(pageId, pageName, pageImageUrl, pageAccessToken, pageCommentToken || null, botId).run()
                imported.push({ id: pageId, name: pageName })
            }
        }

        return c.json({
            success: true,
            imported: imported.length,
            updated: updated.length,
            conflicts: conflicts.length,
            invalid_post_token_pages: invalidPostTokenPages.length,
            source: postImportSource,
            source_reason: postImportReason || undefined,
            source_comment: commentImportSource,
            source_comment_reason: commentImportReason || undefined,
            pages: [...imported, ...updated],
            conflict_pages: conflicts,
            invalid_pages: invalidPostTokenPages,
        })
    } catch (e) {
        return c.json({ error: 'Failed to import pages', details: String(e) }, 500)
    }
})

// ==================== POST QUEUE API ====================

app.get('/api/pages/:id/queue', async (c) => {
    const pageId = c.req.param('id')
    try {
        const { results } = await c.env.DB.prepare(
            'SELECT * FROM post_queue WHERE page_id = ? ORDER BY scheduled_at ASC'
        ).bind(pageId).all()
        return c.json({ queue: results })
    } catch (e) {
        return c.json({ error: 'Failed to fetch queue' }, 500)
    }
})

app.post('/api/pages/:id/queue', async (c) => {
    const pageId = c.req.param('id')
    try {
        const body = await c.req.json()
        const { video_id, scheduled_at } = body

        await c.env.DB.prepare(
            'INSERT INTO post_queue (video_id, page_id, scheduled_at, bot_id) VALUES (?, ?, ?, ?)'
        ).bind(video_id, pageId, scheduled_at, c.get('botId')).run()

        return c.json({ success: true })
    } catch (e) {
        return c.json({ error: 'Failed to add to queue' }, 500)
    }
})

// ==================== POST HISTORY API ====================

app.get('/api/post-history', async (c) => {
    try {
        const botId = c.get('botId')
        await reconcilePostingHistoryRows({
            env: c.env,
            bucket: c.get('bucket'),
            botId,
            logPrefix: 'POST-HISTORY',
        })
        const { results } = await c.env.DB.prepare(
            `SELECT ph.*, p.name as page_name, p.image_url as page_image
             FROM post_history ph
             JOIN pages p ON ph.page_id = p.id
             WHERE ph.status != 'deleted' AND p.bot_id = ?
             ORDER BY ph.posted_at DESC LIMIT 100`
        ).bind(botId).all()
        return c.json({ history: results }, 200, { 'Cache-Control': 'no-store' })
    } catch (e) {
        return c.json({ error: 'Failed to fetch history' }, 500)
    }
})

app.delete('/api/post-history/:id', async (c) => {
    try {
        const id = c.req.param('id')
        const row = await c.env.DB.prepare(
            'SELECT ph.fb_post_id, p.access_token FROM post_history ph JOIN pages p ON ph.page_id = p.id WHERE ph.id = ?'
        ).bind(id).first() as { fb_post_id?: string; access_token: string } | null

        if (row?.fb_post_id && row.access_token) {
            await facebookGraphDelete(row.access_token, `${FB_GRAPH_V19}/${row.fb_post_id}`).catch(() => { })
        }

        // Mark as hidden instead of deleting (keep record to prevent re-posting same video)
        await c.env.DB.prepare("UPDATE post_history SET status = 'deleted' WHERE id = ?").bind(id).run()
        return c.json({ success: true })
    } catch {
        return c.json({ error: 'Failed to delete' }, 500)
    }
})

app.get('/api/pages/:id/history', async (c) => {
    const pageId = c.req.param('id')
    try {
        const { results } = await c.env.DB.prepare(
            'SELECT * FROM post_history WHERE page_id = ? ORDER BY posted_at DESC LIMIT 50'
        ).bind(pageId).all()
        return c.json({ history: results })
    } catch (e) {
        return c.json({ error: 'Failed to fetch history' }, 500)
    }
})

app.get('/api/pages/:id/stats', async (c) => {
    const pageId = c.req.param('id')
    try {
        const today = await c.env.DB.prepare(
            "SELECT COUNT(*) as count FROM post_history WHERE page_id = ? AND date(posted_at) = date('now')"
        ).bind(pageId).first()

        const week = await c.env.DB.prepare(
            "SELECT COUNT(*) as count FROM post_history WHERE page_id = ? AND posted_at >= datetime('now', '-7 days')"
        ).bind(pageId).first()

        const total = await c.env.DB.prepare(
            'SELECT COUNT(*) as count FROM post_history WHERE page_id = ?'
        ).bind(pageId).first()

        return c.json({
            today: today?.count || 0,
            week: week?.count || 0,
            total: total?.count || 0
        })
    } catch (e) {
        return c.json({ error: 'Failed to fetch stats' }, 500)
    }
})

// ==================== SCHEDULER ====================

app.get('/api/scheduler/process', async (c) => {
    try {
        const { results: pendingPosts } = await c.env.DB.prepare(
            "SELECT pq.*, p.access_token, p.name as page_name FROM post_queue pq JOIN pages p ON pq.page_id = p.id WHERE pq.status = 'pending' AND pq.scheduled_at <= datetime('now') AND p.is_active = 1 LIMIT 10"
        ).all()

        const processed: number[] = []

        for (const post of pendingPosts || []) {
            await c.env.DB.prepare(
                "UPDATE post_queue SET status = 'processing' WHERE id = ?"
            ).bind(post.id).run()

            // TODO: Implement actual Facebook Reels posting
            await c.env.DB.prepare(
                'INSERT INTO post_history (video_id, page_id, fb_post_id, status) VALUES (?, ?, ?, ?)'
            ).bind(post.video_id, post.page_id, 'simulated_' + Date.now(), 'success').run()

            await c.env.DB.prepare(
                'DELETE FROM post_queue WHERE id = ?'
            ).bind(post.id).run()

            await c.env.DB.prepare(
                "UPDATE pages SET last_post_at = datetime('now') WHERE id = ?"
            ).bind(post.page_id).run()

            processed.push(post.id as number)
        }

        return c.json({ processed: processed.length, ids: processed })
    } catch (e) {
        return c.json({ error: 'Scheduler failed', details: String(e) }, 500)
    }
})

// Generate short caption from long script using Gemini
async function generateCaption(script: string, apiKey: string, model: string): Promise<string> {
    try {
        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `สร้างแคปชั่น Facebook Reels จาก script นี้ 1 บรรทัด มี emoji ดึงดูด จบประโยคสมบูรณ์ ห้ามตัดคำกลางคัน ตอบแค่แคปชั่น:\n\n${script}` }] }],
                    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
                }),
            }
        )
        const result = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        const caption = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        return caption || script.slice(0, 100)
    } catch {
        return script.slice(0, 100)
    }
}

// Generate title for ONE video at a time (call repeatedly to process all)
app.post('/api/generate-title/:id', async (c) => {
    const env = c.env
    const id = c.req.param('id')
    const apiKey = await resolveNamespaceGeminiApiKey(env.DB, String(c.get('botId') || ''), env.GOOGLE_API_KEY)
    const model = env.GEMINI_MODEL || 'gemini-3-flash-preview'

    const obj = await env.BUCKET.get(`videos/${id}.json`)
    if (!obj) return c.json({ error: 'not found' }, 404)
    const meta = await obj.json() as Record<string, unknown>
    if (!meta.script) return c.json({ error: 'no script' }, 400)

    const script = (meta.script as string).slice(0, 300)
    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `จาก script รีวิวสินค้านี้ ช่วยเขียนแคปชั่น Facebook Reels ให้หน่อย

ตัวอย่างแคปชั่นที่ดี:
- "🔧 ประแจ 8 in 1 ตัวเดียวครบ ไม่ต้องหาหลายอัน!"
- "⚡ เลื่อยไร้สายจิ๋วแต่แจ๋ว ตัดกิ่งไม้ได้ลื่นปรื๊ด!"
- "🛠️ คีมเชื่อมรุ่นใหม่ หนีบแน่น เชื่อมนานมือไม่พอง!"

กฎสำคัญ:
- ตอบแค่ 1 บรรทัดเท่านั้น ห้ามขึ้นบรรทัดใหม่
- ใส่ emoji นำหน้า 1 ตัว
- ต้องจบประโยคสมบูรณ์ ห้ามตัดคำกลางคัน
- ตอบแค่แคปชั่น ไม่ต้องใส่เครื่องหมายคำพูด

script: ${script}`
                    }]
                }],
                generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
            }),
        }
    )
    const result = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    let title = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
    if (title.startsWith('"') && title.endsWith('"')) title = title.slice(1, -1)
    if (title.startsWith('\u201c') && title.endsWith('\u201d')) title = title.slice(1, -1)

    if (!title) return c.json({ error: 'no title generated' }, 500)

    meta.title = title
    await env.BUCKET.put(`videos/${id}.json`, JSON.stringify(meta, null, 2), {
        httpMetadata: { contentType: 'application/json' },
    })

    return c.json({ id, title })
})

// Rebuild gallery cache
app.post('/api/rebuild-cache', async (c) => {
    const videos = await rebuildGalleryCache(c.get('bucket'))
    return c.json({ rebuilt: true, count: videos.length })
})

// List videos needing titles
app.get('/api/generate-titles/pending', async (c) => {
    const videoIds = await listAllVideoJsonIds(c.get('bucket'))
    const pending: Array<{ id: string; currentTitle: string }> = []
    for (const id of videoIds) {
        const obj = await c.get('bucket').get(`videos/${id}.json`)
        if (!obj) continue
        const meta = await obj.json() as Record<string, unknown>
        if (!meta.script) continue
        pending.push({ id, currentTitle: (meta.title as string) || '' })
    }
    return c.json({ total: pending.length, videos: pending })
})

// Force post for a specific page (bypass time check)
app.post('/api/pages/:id/force-post', async (c) => {
    const pageId = c.req.param('id')
    const env = c.env
    const botId = c.get('botId')
    let pageName = ''
    let pageAccessToken = ''
    let pageCommentToken: string | null = null
    let selectedVideoId = ''
    let fbVideoId = ''
    let selectedCaption = ''
    let attemptPostedAtIso = ''
    let normalizedShopeeLink = ''
    let commentTokenHint: string | null = null
    let skipComment = false
    let postTokenCandidates: string[] = []
    let commentTokenCandidates: string[] = []

    try {
        // Check if skip comment
        const body = await c.req.json().catch(() => ({})) as { skipComment?: boolean }
        skipComment = body.skipComment === true
        // Get page info
        const page = await env.DB.prepare(
            'SELECT id, name, access_token, comment_token, post_hours FROM pages WHERE id = ? AND bot_id = ?'
        ).bind(pageId, botId).first() as { id: string; name: string; access_token: string; comment_token: string | null; post_hours: string } | null

        if (!page) return c.json({ error: 'Page not found' }, 404)
        pageName = page.name
        pageAccessToken = String(page.access_token || '').trim()
        pageCommentToken = page.comment_token || null
        const tokenCandidates = await getPageTokenCandidates({
            db: env.DB,
            namespaceId: botId,
            pageId: page.id,
            primaryPostToken: pageAccessToken,
            primaryCommentToken: pageCommentToken,
        })
        postTokenCandidates = tokenCandidates.postTokens.length > 0
            ? tokenCandidates.postTokens
            : normalizePostTokenPool([pageAccessToken])
        commentTokenCandidates = tokenCandidates.commentTokens.length > 0
            ? tokenCandidates.commentTokens
            : normalizeCommentTokenPool([String(pageCommentToken || '')])
        pageCommentToken = commentTokenCandidates[0] || null

        // Get a video that hasn't been posted to this page yet
        const allVideoIds = await listAllVideoJsonIds(c.get('bucket'))

        if (allVideoIds.length === 0) return c.json({ error: 'No videos available' }, 404)

        // Skip videos that were already posted (or currently posting) in this namespace
        const postedIds = await getPostedVideoIds({
            db: env.DB,
            namespaceId: botId,
        })

        // Find all unposted videos and pick oldest candidate.
        const unpostedVideos = allVideoIds.filter(id => !postedIds.has(id))
        if (unpostedVideos.length === 0) return c.json({ error: 'No unposted videos left' }, 404)

        const pickedVideo = await pickOldestPostableVideo(c.get('bucket'), unpostedVideos)
        if (!pickedVideo) return c.json({ error: 'No readable video metadata left' }, 404)
        const unpostedId = pickedVideo.id
        const meta = pickedVideo.meta
        selectedVideoId = unpostedId
        normalizedShopeeLink = pickedVideo.shopeeLink
        const title = metaToString(meta, 'title')
        const script = metaToString(meta, 'script')
        const publicUrl = metaToString(meta, 'publicUrl')
        const category = metaToString(meta, 'category')

        if (!publicUrl) {
            return c.json({ error: 'Video public URL missing' }, 400)
        }

        // Use title if available, otherwise generate caption from script
        const apiKey = await resolveNamespaceGeminiApiKey(env.DB, botId, env.GOOGLE_API_KEY)
        const model = env.GEMINI_MODEL || 'gemini-3-flash-preview'
        let caption = title
            ? title
            : script
                ? await generateCaption(script, apiKey, model)
                : 'AI Dubbed Video'
        caption += `\n#สินค้า #ของน่าใช้ #ช็อปปิ้งออนไลน์${category ? ` #${category}` : ''}`
        selectedCaption = caption

        commentTokenHint = deriveCommentTokenHint(pageCommentToken)
        const initialCommentStatus = normalizedShopeeLink ? 'pending' : 'not_configured'
        // Record attempt BEFORE posting (prevents duplicate on failure)
        const nowStr = new Date().toISOString()
        attemptPostedAtIso = nowStr
        await env.DB.prepare(
            'INSERT INTO post_history (page_id, video_id, posted_at, status, bot_id, comment_status, comment_token_hint, comment_error, comment_fb_id, shopee_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            page.id,
            unpostedId,
            nowStr,
            'posting',
            botId,
            initialCommentStatus,
            commentTokenHint,
            null,
            null,
            normalizedShopeeLink || null,
        ).run()
        await env.DB.prepare('UPDATE pages SET last_post_at = ? WHERE id = ?').bind(nowStr, page.id).run()

        // Handle legacy publicUrl without namespace path
        let realVideoUrl = publicUrl
        if (realVideoUrl && realVideoUrl.includes('pub-') && !realVideoUrl.includes(`/${botId}/`)) {
            realVideoUrl = realVideoUrl.replace(/https:\/\/pub-[a-f0-9]+\.r2\.dev\/videos\//g, `${env.R2_PUBLIC_URL}/${botId}/videos/`)
        }

        // Post to Facebook Reels
        const initData = await initReelUploadWithPostingTokenAutoRecover({
            env,
            db: env.DB,
            namespaceId: botId,
            pageId: page.id,
            pageName: page.name,
            postTokens: postTokenCandidates,
            logPrefix: 'FORCE-POST',
        })
        const postingToken = String(initData.postingToken || pageAccessToken).trim()

        fbVideoId = String(initData.video_id || '').trim()
        const upload_url = String(initData.upload_url || '').trim()
        if (!upload_url || !fbVideoId) throw new Error('No upload URL or video ID returned')

        const videoResp = await fetchWithTimeout(realVideoUrl, {}, 60000, 'force_download_video')
        if (!videoResp.ok) throw new Error(`Fetch video failed with status ${videoResp.status}`)
        const videoBuffer = await videoResp.arrayBuffer()
        if (videoBuffer.byteLength < 100000) throw new Error(`Video too small (${videoBuffer.byteLength} bytes). Download failed.`)

        const uploadResp = await fetchWithTimeout(upload_url, {
            method: 'POST',
            headers: {
                'Authorization': `OAuth ${postingToken}`,
                'offset': '0',
                'file_size': videoBuffer.byteLength.toString(),
            },
            body: videoBuffer,
        }, 120000, 'force_upload_video')
        const uploadData = await uploadResp.json() as { success?: boolean; error?: { message: string } }
        if (uploadData.error) throw new Error(uploadData.error.message)

        const finishData = await finishReelPublishWithRetry({
            accessToken: postingToken,
            pageId: page.id,
            fbVideoId,
            description: caption,
            logPrefix: 'FORCE-POST',
        })

        const confirmedPostId = String(finishData.post_id || '').trim() || fbVideoId
        const fbReelUrl = finishData.permalink_url || `https://www.facebook.com/watch/?v=${fbVideoId}`

        // Wait 10s for video to be processed before commenting (unless skipped)
        let commentStatus = initialCommentStatus
        let commentError: string | null = null
        let commentFbId: string | null = null
        const commentTargetId = confirmedPostId || fbVideoId

            if (normalizedShopeeLink && !skipComment) {
                await new Promise(r => setTimeout(r, 10000))
                const commentResult = await postShopeeCommentWithFallback({
                    fbVideoId: commentTargetId,
                    shopeeLink: normalizedShopeeLink,
                    commentTokens: commentTokenCandidates,
                    pageId: page.id,
                    logPrefix: 'FORCE-POST',
                })
            if (!commentResult.ok) {
                commentStatus = 'failed'
                commentError = commentResult.error || 'comment_failed'
                console.error(`[FORCE-POST] Comment failed for ${fbVideoId}: ${commentResult.error}`)
                await notifyCommentTokenIssue(
                    env,
                    botId,
                    page.id,
                    page.name,
                    commentError,
                ).catch((notifyErr) => {
                    console.error(`[FORCE-POST] notifyCommentTokenIssue failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
                })
            } else {
                commentStatus = 'success'
                commentFbId = commentResult.id || null
            }
        } else if (skipComment) {
            commentStatus = 'skipped'
            console.log(`[FORCE-POST] Skipped comment for ${fbVideoId}`)
        }

        // Update to success
        await env.DB.prepare(
            "UPDATE post_history SET fb_post_id = ?, fb_reel_url = ?, status = 'success', error_message = NULL, comment_status = ?, comment_token_hint = ?, comment_error = ?, comment_fb_id = ? WHERE page_id = ? AND video_id = ? AND status = 'posting'"
        ).bind(confirmedPostId, fbReelUrl, commentStatus, commentTokenHint, commentError, commentFbId, page.id, unpostedId).run()

        await clearVideoShopeeLink(c.get('bucket'), unpostedId)
        return c.json({ success: true, page: page.name, video_id: unpostedId, fb_video_id: fbVideoId, fb_post_id: confirmedPostId, fb_reel_url: fbReelUrl })
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)

        // Recovery path: if Facebook already accepted the reel and it becomes published
        // after a transient upload/finish error, mark history as success instead of failed.
        if (pageAccessToken && pageId && selectedVideoId) {
            try {
                let recoveredPostId = ''
                let recoveredReelUrl = ''

                if (fbVideoId) {
                    const recovered = await pollPublishedReelAfterProcessing({
                        accessToken: pageAccessToken,
                        fbVideoId,
                        logPrefix: 'FORCE-POST-RECOVER',
                    })
                    if (recovered.published && recovered.post_id) {
                        recoveredPostId = String(recovered.post_id || '').trim() || fbVideoId
                        recoveredReelUrl = String(recovered.permalink_url || '').trim() || `https://www.facebook.com/reel/${recoveredPostId}`
                    }
                }

                if (!recoveredPostId && selectedCaption) {
                    const feedRecovered = await recoverPublishedReelFromRecentFeed({
                        accessToken: pageAccessToken,
                        pageId,
                        expectedCaption: selectedCaption,
                        notBeforeIso: attemptPostedAtIso,
                        logPrefix: 'FORCE-POST-RECOVER-FEED',
                    })
                    if (feedRecovered.published && feedRecovered.post_id) {
                        recoveredPostId = String(feedRecovered.post_id || '').trim()
                        recoveredReelUrl = String(feedRecovered.permalink_url || '').trim() || `https://www.facebook.com/reel/${recoveredPostId}`
                    }
                }

                if (recoveredPostId) {
                    if (!recoveredReelUrl) {
                        recoveredReelUrl = `https://www.facebook.com/reel/${recoveredPostId}`
                    }

                    let commentStatus = normalizedShopeeLink ? 'pending' : 'not_configured'
                    let commentError: string | null = null
                    let commentFbId: string | null = null
                    const commentTargetId = recoveredPostId || fbVideoId

                    if (normalizedShopeeLink && !skipComment) {
                        await waitMs(10000)
                        const commentResult = await postShopeeCommentWithFallback({
                            fbVideoId: commentTargetId,
                            shopeeLink: normalizedShopeeLink,
                            commentTokens: commentTokenCandidates,
                            pageId,
                            logPrefix: 'FORCE-POST-RECOVER',
                        })
                        if (!commentResult.ok) {
                            commentStatus = 'failed'
                            commentError = commentResult.error || 'comment_failed'
                            await notifyCommentTokenIssue(
                                env,
                                botId,
                                pageId,
                                pageName || pageId,
                                commentError,
                            ).catch((notifyErr) => {
                                console.error(`[FORCE-POST-RECOVER] notifyCommentTokenIssue failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
                            })
                        } else {
                            commentStatus = 'success'
                            commentFbId = commentResult.id || null
                        }
                    } else if (skipComment) {
                        commentStatus = 'skipped'
                    }

                    await env.DB.prepare(
                        "UPDATE post_history SET fb_post_id = ?, fb_reel_url = ?, status = 'success', error_message = NULL, comment_status = ?, comment_token_hint = ?, comment_error = ?, comment_fb_id = ? WHERE page_id = ? AND video_id = ? AND status IN ('posting','failed')"
                    ).bind(
                        recoveredPostId,
                        recoveredReelUrl,
                        commentStatus,
                        commentTokenHint,
                        commentError,
                        commentFbId,
                        pageId,
                        selectedVideoId,
                    ).run()

                    await clearVideoShopeeLink(c.get('bucket'), selectedVideoId)
                    return c.json({
                        success: true,
                        recovered: true,
                        page: pageName || pageId,
                        video_id: selectedVideoId,
                        fb_video_id: fbVideoId,
                        fb_post_id: recoveredPostId,
                        fb_reel_url: recoveredReelUrl,
                    })
                }
            } catch (recoverErr) {
                console.error(`[FORCE-POST-RECOVER] failed: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`)
            }
        }

        try {
            if (selectedVideoId) {
                await env.DB.prepare(
                    "UPDATE post_history SET status = 'failed', error_message = ?, comment_status = 'not_attempted' WHERE page_id = ? AND video_id = ? AND status = 'posting'"
                ).bind(errorMsg, pageId, selectedVideoId).run()
            } else {
                await env.DB.prepare(
                    "UPDATE post_history SET status = 'failed', error_message = ?, comment_status = 'not_attempted' WHERE id = (SELECT id FROM post_history WHERE page_id = ? AND status = 'posting' ORDER BY id DESC LIMIT 1)"
                ).bind(errorMsg, pageId).run()
            }
        } catch { }
        return c.json({ error: 'Post failed', details: errorMsg }, 500)
    }
})

// ==================== MANUAL REEL POST (ใส่ Page ID + Token เอง) ====================

app.post('/api/manual-post-reel', async (c) => {
    const t0 = Date.now()

    try {
        const body = await c.req.json() as {
            pageId: string
            accessToken: string
            videoUrl: string
            caption?: string
            commentToken?: string
            shopeeLink?: string
        }

        const { pageId, accessToken, videoUrl, caption, commentToken, shopeeLink } = body

        if (!pageId || !accessToken || !videoUrl) {
            return c.json({ error: 'Missing required fields: pageId, accessToken, videoUrl' }, 400)
        }

        console.log(`[MANUAL-REEL] Starting for page ${pageId}`)
        console.log(`[MANUAL-REEL] Video: ${videoUrl}`)

        // Step 1: Init upload
        let initData: { video_id?: string; upload_url?: string }
        try {
            initData = await facebookGraphPost<{ video_id?: string; upload_url?: string }>(
                accessToken,
                `${FB_GRAPH_V19}/${pageId}/video_reels`,
                { upload_phase: 'start' },
            )
        } catch (e) {
            const parsed = parseFacebookErrorLike(e)
            return c.json({ error: `Init failed: ${parsed?.message || (e instanceof Error ? e.message : 'unknown')}`, stage: 'init' }, 400)
        }

        const { video_id: fbVideoId, upload_url } = initData
        if (!upload_url || !fbVideoId) {
            return c.json({ error: 'No upload URL or video ID returned', stage: 'init' }, 400)
        }
        console.log(`[MANUAL-REEL] Init OK: video_id=${fbVideoId}`)

        // Step 2: Upload video
        const videoResp = await fetch(videoUrl)
        if (!videoResp.ok) {
            return c.json({ error: `Cannot fetch video: HTTP ${videoResp.status}`, stage: 'fetch-video' }, 400)
        }
        const videoBuffer = await videoResp.arrayBuffer()
        console.log(`[MANUAL-REEL] Video size: ${(videoBuffer.byteLength / 1024 / 1024).toFixed(1)}MB`)

        const uploadResp = await fetch(upload_url, {
            method: 'POST',
            headers: {
                'Authorization': `OAuth ${accessToken}`,
                'offset': '0',
                'file_size': videoBuffer.byteLength.toString(),
            },
            body: videoBuffer,
        })
        const uploadData = await uploadResp.json() as { success?: boolean; error?: { message: string } }
        if (uploadData.error) {
            return c.json({ error: `Upload failed: ${uploadData.error.message}`, stage: 'upload' }, 400)
        }
        console.log(`[MANUAL-REEL] Upload OK`)

        // Step 3: Finish (publish)
        let finishData: { success?: boolean; post_id?: string; permalink_url?: string }
        try {
            finishData = await finishReelPublishWithRetry({
                accessToken,
                pageId,
                fbVideoId,
                description: caption || '',
                logPrefix: 'MANUAL-REEL',
            })
        } catch (e) {
            const parsed = parseFacebookErrorLike(e)
            return c.json({ error: `Publish failed: ${parsed?.message || (e instanceof Error ? e.message : 'unknown')}`, stage: 'finish' }, 400)
        }

        const dur = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`[MANUAL-REEL] ✅ Published: ${fbVideoId} in ${dur}s`)
        const confirmedPostId = String(finishData.post_id || '').trim() || fbVideoId
        const fbReelUrl = String(finishData.permalink_url || '').trim() || `https://www.facebook.com/watch/?v=${fbVideoId}`

        // Step 4: Auto comment (if shopeeLink provided)
        let commentResult: string | null = null
        if (shopeeLink) {
            console.log(`[MANUAL-REEL] Waiting 10s before commenting...`)
            await new Promise(r => setTimeout(r, 10000))
            try {
                const res = await postShopeeCommentStrict({
                    fbVideoId: confirmedPostId || fbVideoId,
                    shopeeLink,
                    commentToken: commentToken || '',
                    pageId,
                    logPrefix: 'MANUAL-REEL',
                })
                if (res.ok) {
                    commentResult = res.id || 'ok'
                } else {
                    commentResult = `failed: ${res.error || 'unknown'}`
                    const page = await c.env.DB.prepare(
                        'SELECT id, name, bot_id FROM pages WHERE id = ? LIMIT 1'
                    ).bind(pageId).first() as { id?: string; name?: string; bot_id?: string } | null
                    if (page?.id && page?.bot_id) {
                        await notifyCommentTokenIssue(
                            c.env,
                            String(page.bot_id),
                            String(page.id),
                            String(page.name || page.id),
                            res.error || 'comment_failed',
                        ).catch((notifyErr) => {
                            console.error(`[MANUAL-REEL] notifyCommentTokenIssue failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
                        })
                    }
                }
            } catch (e) {
                commentResult = `exception: ${e instanceof Error ? e.message : String(e)}`
            }
        }

        return c.json({
            success: true,
            videoId: fbVideoId,
            postId: confirmedPostId,
            reelUrl: fbReelUrl,
            pageId,
            caption: caption || '',
            duration: dur + 's',
            comment: commentResult,
        })
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        console.error(`[MANUAL-REEL] ❌ Error:`, errorMsg)
        return c.json({ error: errorMsg, stage: 'exception' }, 500)
    }
})

// ==================== SCHEDULED HANDLER (CRON) ====================

async function handleScheduled(env: Env) {
    console.log('[CRON] Starting auto-post check...')

    // Keep Container warm — ping /health ทุก 1 นาที ไม่ให้ sleep
    try {
        const containerId = env.MERGE_CONTAINER.idFromName('merge-worker')
        const containerStub = env.MERGE_CONTAINER.get(containerId)
        await containerStub.fetch('http://container/health')
        console.log('[CRON] Container warm-up ping sent')
    } catch {
        console.log('[CRON] Container warm-up ping failed (booting...)')
    }

    // Process pending comments — คอมเมนต์ลิงก์ Shopee ที่ค้างไว้ (รอ ≥1 นาที)
    try {
        const pendingList = await env.BUCKET.list({ prefix: '_pending_comments/' })
        const nowMs = Date.now()
        for (const obj of pendingList.objects) {
            // เช็คว่าสร้างมาอย่างน้อย 1 นาทีแล้ว
            const ageMs = nowMs - obj.uploaded.getTime()
            if (ageMs < 60_000) {
                console.log(`[CRON] Pending comment ${obj.key}: too recent (${Math.round(ageMs / 1000)}s), waiting...`)
                continue
            }

            const dataObj = await env.BUCKET.get(obj.key)
            if (!dataObj) continue
            const data = await dataObj.json() as {
                fbVideoId: string
                commentToken?: string
                accessToken?: string // legacy key
                shopeeLink: string
                postToken?: string
            }
            const pendingCommentToken = String(data.commentToken || '').trim()
            if (!pendingCommentToken) {
                console.error(`[CRON] Pending comment ${data.fbVideoId}: missing commentToken (legacy accessToken is blocked)`)
                await env.BUCKET.delete(obj.key)
                continue
            }

            try {
                console.log(`[CRON] Pending comment ${data.fbVideoId}: using comment token ${pendingCommentToken.slice(0, 30)}...`)
                const result = await postShopeeCommentStrict({
                    fbVideoId: data.fbVideoId,
                    shopeeLink: data.shopeeLink,
                    commentToken: pendingCommentToken,
                    logPrefix: 'CRON-PENDING',
                })
                if (!result.ok) {
                    console.error(`[CRON] Pending comment ${data.fbVideoId}: FAILED: ${result.error || 'unknown'}`)
                } else {
                    console.log(`[CRON] Pending comment ${data.fbVideoId}: SUCCESS (id: ${result.id})`)
                }
            } catch (e) {
                console.error(`[CRON] Comment failed for ${data.fbVideoId}: ${e}`)
            }

            // ลบ pending ไม่ว่าจะสำเร็จหรือไม่ (ป้องกัน retry ไม่สิ้นสุด)
            await env.BUCKET.delete(obj.key)
        }
    } catch (e) {
        console.error(`[CRON] Pending comments error: ${e}`)
    }


    // Get current time in Thailand timezone (UTC+7) using proper Intl
    const now = new Date()
    const nowISO = now.toISOString()

    // Use Intl.DateTimeFormat for accurate Thailand time
    const thaiTimeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
    const thaiDateFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })

    const thaiTimeParts = thaiTimeFormatter.formatToParts(now)
    const thaiHour = parseInt(thaiTimeParts.find(p => p.type === 'hour')?.value || '0', 10)
    const thaiMinute = parseInt(thaiTimeParts.find(p => p.type === 'minute')?.value || '0', 10)

    const thaiDateParts = thaiDateFormatter.formatToParts(now)
    const thaiYear = thaiDateParts.find(p => p.type === 'year')?.value
    const thaiMonth = thaiDateParts.find(p => p.type === 'month')?.value
    const thaiDay = thaiDateParts.find(p => p.type === 'day')?.value
    const todayStr = `${thaiYear}-${thaiMonth}-${thaiDay}`
    const slotEarlyToleranceMinutes = 1
    const slotLateGraceRaw = parseInt(String((env as any).CRON_SLOT_GRACE_MINUTES || '10'), 10)
    const slotLateGraceMinutes = Number.isFinite(slotLateGraceRaw)
        ? Math.max(1, Math.min(60, slotLateGraceRaw))
        : 10
    const formatSlot = (slot: { hour: number; minute: number }) => `${slot.hour}:${slot.minute.toString().padStart(2, '0')}`

    // 1. Get active pages with their post_hours
    const { results: pages } = await env.DB.prepare(`
        SELECT id, name, access_token, comment_token, post_hours, last_post_at, bot_id
        FROM pages
        WHERE is_active = 1 AND post_hours IS NOT NULL AND post_hours != ''
    `).all() as {
        results: Array<{
            id: string
            name: string
            access_token: string
            comment_token: string | null
            post_hours: string
            last_post_at: string | null
            bot_id: string | null
        }>
    }

    // Current time in minutes since midnight (Thailand)
    const nowMinutes = thaiHour * 60 + thaiMinute

    console.log(`[CRON] Found ${pages.length} active pages, Thai time: ${thaiHour}:${thaiMinute.toString().padStart(2, '0')} (${nowMinutes}m), date: ${todayStr}`)

    // Get all video namespaces (default + any telegram_ids that have videos)
    const videoNamespaceCache: Record<string, string[]> = {}
    const videoNamespaceOldestFirstCache: Record<string, string[]> = {}
    const geminiApiKeyByNamespace = new Map<string, string>()

    for (const page of pages) {
        // ใช้ bot_id ของ page เป็น namespace สำหรับหา videos
        const botId = page.bot_id || 'default';
        
        // ถ้ายังไม่เคยดึง videos ของ namespace นี้
        if (!videoNamespaceCache[botId]) {
            const botBucket = new BotBucket(env.BUCKET, botId) as unknown as R2Bucket
            const videoIds = await listAllVideoJsonIds(botBucket)
            videoNamespaceCache[botId] = videoIds
            videoNamespaceOldestFirstCache[botId] = await orderVideoIdsOldestFirst(botBucket, videoIds)
            console.log(`[CRON] Page ${page.name}: botId=${botId}, found ${videoIds.length} videos`)
        }
        
        // สร้าง bucket สำหรับ namespace นี้
        const botBucket = new BotBucket(env.BUCKET, botId) as unknown as R2Bucket
        
        const rawSchedule = (page.post_hours || '').trim()
        const intervalMatch = rawSchedule.match(/^every:(\d{1,4})$/i)

        // CRITICAL: Atomic dedup using R2 (prevents concurrent cron executions from double-posting)
        let dedupKey = ''
        if (intervalMatch) {
            const intervalMinutes = Math.max(5, Math.min(720, parseInt(intervalMatch[1], 10) || 60))
            const intervalMs = intervalMinutes * 60_000
            const nowMs = now.getTime()
            const lastPostedMs = page.last_post_at ? new Date(page.last_post_at).getTime() : 0
            const elapsedMs = page.last_post_at ? (nowMs - lastPostedMs) : Number.POSITIVE_INFINITY

            if (page.last_post_at && elapsedMs < intervalMs) {
                const remainMin = Math.ceil((intervalMs - elapsedMs) / 60_000)
                console.log(`[CRON] Page ${page.name}: skip (interval every ${intervalMinutes}m, remaining ${remainMin}m)`)
                continue
            }

            const intervalBucket = Math.floor(nowMs / intervalMs)
            dedupKey = `_cron_dedup/${page.id}/interval_${intervalMinutes}_${intervalBucket}`
            console.log(`[CRON] Page ${page.name}: posting by interval every ${intervalMinutes}m`)
        } else {
            const scheduledTimes = rawSchedule
                .split(',')
                .map(part => part.trim())
                .filter(Boolean)
                .map((trimmed) => {
                    if (trimmed.includes(':')) {
                        const [h, m] = trimmed.split(':').map(Number)
                        const normalizedHour = h === 24 ? 0 : h
                        return {
                            hour: normalizedHour,
                            minute: m,
                            totalMin: normalizedHour * 60 + m,
                            rawHour: h,
                        }
                    }
                    const h = Number(trimmed)
                    const normalizedHour = h === 24 ? 0 : h
                    return {
                        hour: normalizedHour,
                        minute: 0,
                        totalMin: normalizedHour * 60,
                        rawHour: h,
                    }
                })
                .filter(({ hour, minute, totalMin, rawHour }) =>
                    Number.isFinite(rawHour) &&
                    Number.isFinite(minute) &&
                    Number.isFinite(totalMin) &&
                    rawHour >= 0 &&
                    rawHour <= 24 &&
                    minute >= 0 &&
                    minute <= 59
                )
                .sort((a, b) => a.totalMin - b.totalMin)

            if (scheduledTimes.length === 0) {
                console.log(`[CRON] Page ${page.name}: skip (invalid slots: ${rawSchedule || 'empty'})`)
                continue
            }

            // Find a slot that is due now (allow small early trigger and delayed catch-up window).
            const { results: todayPosts } = await env.DB.prepare(
                "SELECT posted_at FROM post_history WHERE page_id = ? AND bot_id = ? AND status IN ('success','posting')"
            ).bind(page.id, botId).all() as { results: Array<{ posted_at: string }> }

            // Helper to get Thai time parts from ISO date
            const getThaiTimeParts = (isoDate: string) => {
                const d = new Date(isoDate)
                const timeParts = thaiTimeFormatter.formatToParts(d)
                const dateParts = thaiDateFormatter.formatToParts(d)
                const hour = parseInt(timeParts.find(p => p.type === 'hour')?.value || '0', 10)
                const minute = parseInt(timeParts.find(p => p.type === 'minute')?.value || '0', 10)
                const year = dateParts.find(p => p.type === 'year')?.value
                const month = dateParts.find(p => p.type === 'month')?.value
                const day = dateParts.find(p => p.type === 'day')?.value
                return {
                    totalMin: hour * 60 + minute,
                    dateStr: `${year}-${month}-${day}`
                }
            }

            const postedSlots = new Set(todayPosts.map(p => getThaiTimeParts(p.posted_at))
                .filter(pt => pt.dateStr === todayStr)
                .map(pt => pt.totalMin))

            const dueSlots = scheduledTimes.filter(({ totalMin }) => {
                if (postedSlots.has(totalMin)) return false
                const lagMinutes = nowMinutes - totalMin
                return lagMinutes >= -slotEarlyToleranceMinutes && lagMinutes <= slotLateGraceMinutes
            })
            const matchedSlot = dueSlots.length > 0
                ? dueSlots.reduce((latest, slot) => (slot.totalMin > latest.totalMin ? slot : latest), dueSlots[0])
                : null

            if (!matchedSlot) {
                const unpostedFutureSlot = scheduledTimes.find((slot) => !postedSlots.has(slot.totalMin) && slot.totalMin >= nowMinutes) || null
                const unpostedPastSlot = [...scheduledTimes].reverse().find((slot) => !postedSlots.has(slot.totalMin) && slot.totalMin < nowMinutes) || null
                const hintSlot = unpostedFutureSlot || unpostedPastSlot
                const hintText = hintSlot ? formatSlot(hintSlot) : 'none'
                console.log(
                    `[CRON] Page ${page.name}: skip (no due slot, now=${nowMinutes}m, grace=${slotLateGraceMinutes}m, next=${hintText}, slots=${rawSchedule})`
                )
                continue
            }

            const slotLagMinutes = nowMinutes - matchedSlot.totalMin
            const slotLagText = slotLagMinutes >= 0 ? `+${slotLagMinutes}` : `${slotLagMinutes}`
            console.log(`[CRON] Page ${page.name}: posting for slot ${formatSlot(matchedSlot)} (lag ${slotLagText}m)`)
            dedupKey = `_cron_dedup/${page.id}/${todayStr}/${matchedSlot.hour}_${matchedSlot.minute}`
        }

        const existingDedup = await botBucket.head(dedupKey)
        if (existingDedup) {
            console.log(`[CRON] Page ${page.name}: already posted for this schedule window (dedup key exists)`)
            continue
        }
        // Set dedup key immediately (before any async operations) - TTL 24 hours
        await botBucket.put(dedupKey, nowISO, {
            httpMetadata: { contentType: 'text/plain' },
            customMetadata: { createdAt: nowISO }
        })

        // 2. Get a video that hasn't been posted to this page yet
        // ใช้ video จาก cache แล้ว
        const allVideoIds = videoNamespaceOldestFirstCache[botId] || videoNamespaceCache[botId] || []
        console.log(`[CRON] Page ${page.name}: found ${allVideoIds.length} videos in R2`)

        if (allVideoIds.length === 0) {
            console.log(`[CRON] No videos available for page ${page.name}`)
            await botBucket.delete(dedupKey).catch(() => { }) // Clean up dedup key
            continue
        }

        // Skip videos that are already posted (or currently posting) in this namespace.
        const postedIds = await getPostedVideoIds({
            db: env.DB,
            namespaceId: botId,
        })
        console.log(`[CRON] Page ${page.name}: videos already posted in this namespace: ${Array.from(postedIds).join(', ') || 'none'}`)

        // Find all unposted videos and pick oldest candidate.
        const unpostedVideos = allVideoIds.filter(id => !postedIds.has(id))
        if (unpostedVideos.length === 0) {
            console.log(`[CRON] Page ${page.name}: no unposted videos`)
            await botBucket.delete(dedupKey).catch(() => { }) // Clean up dedup key
            continue
        }
        const pickedVideo = await pickOldestPostableVideo(botBucket, unpostedVideos)
        if (!pickedVideo) {
            console.log(`[CRON] Page ${page.name}: no readable video metadata left`)
            await botBucket.delete(dedupKey).catch(() => { }) // Clean up dedup key
            continue
        }
        const unpostedId = pickedVideo.id

        // Get video metadata
        const meta = pickedVideo.meta
        const normalizedShopeeLink = pickedVideo.shopeeLink
        const title = metaToString(meta, 'title')
        const script = metaToString(meta, 'script')
        const publicUrl = metaToString(meta, 'publicUrl')
        const category = metaToString(meta, 'category')

        // Generate short caption from script (no Shopee link)
        let apiKey = geminiApiKeyByNamespace.get(botId)
        if (!apiKey) {
            apiKey = await resolveNamespaceGeminiApiKey(env.DB, botId, env.GOOGLE_API_KEY)
            geminiApiKeyByNamespace.set(botId, apiKey)
        }
        const geminiModel = env.GEMINI_MODEL || 'gemini-3-flash-preview'
        let caption = title
            ? title
            : script
                ? await generateCaption(script, apiKey, geminiModel)
                : 'AI Dubbed Video'
        caption += `\n#สินค้า #ของน่าใช้ #ช็อปปิ้งออนไลน์${category ? ` #${category}` : ''}`

        // Handle legacy publicUrls without botId or wrong domain
        let realVideoUrl = publicUrl
        if (realVideoUrl && realVideoUrl.includes('pub-') && !realVideoUrl.includes(`/${botId}/`)) {
            realVideoUrl = realVideoUrl.replace(/https:\/\/pub-[a-f0-9]+\.r2\.dev\/videos\//g, `${env.R2_PUBLIC_URL}/${botId}/videos/`)
        }
        if (!realVideoUrl) {
            throw new Error('Video public URL missing')
        }

        console.log(`[CRON] Page ${page.name}: posting video ${unpostedId} — caption: ${caption}`)

        const tokenCandidates = await getPageTokenCandidates({
            db: env.DB,
            namespaceId: botId,
            pageId: String(page.id || ''),
            primaryPostToken: String(page.access_token || ''),
            primaryCommentToken: String(page.comment_token || ''),
        })
        const postTokenCandidates = tokenCandidates.postTokens.length > 0
            ? tokenCandidates.postTokens
            : normalizePostTokenPool([String(page.access_token || '')])
        const commentTokenCandidates = tokenCandidates.commentTokens.length > 0
            ? tokenCandidates.commentTokens
            : normalizeCommentTokenPool([String(page.comment_token || '')])
        const commentTokenHint = deriveCommentTokenHint(commentTokenCandidates[0] || null)
        const initialCommentStatus = normalizedShopeeLink ? 'pending' : 'not_configured'
        // 3. Record attempt BEFORE posting (prevents duplicate posts if FB succeeds but D1 fails after)
        await env.DB.prepare(
            'INSERT INTO post_history (page_id, video_id, posted_at, status, bot_id, comment_status, comment_token_hint, comment_error, comment_fb_id, shopee_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            page.id,
            unpostedId,
            nowISO,
            'posting',
            botId,
            initialCommentStatus,
            commentTokenHint,
            null,
            null,
            normalizedShopeeLink || null,
        ).run()
        await env.DB.prepare('UPDATE pages SET last_post_at = ? WHERE id = ? AND bot_id = ?').bind(nowISO, page.id, botId).run()

        let fbVideoId = ''
        let postingTokenUsed = String(postTokenCandidates[0] || page.access_token || '').trim()
        try {
            // Initialize upload
            const initData = await initReelUploadWithPostingTokenAutoRecover({
                env,
                db: env.DB,
                namespaceId: botId,
                pageId: String(page.id || ''),
                pageName: String(page.name || ''),
                postTokens: postTokenCandidates,
                logPrefix: `CRON ${page.name}`,
            })
            postingTokenUsed = String(initData.postingToken || postingTokenUsed).trim()

            fbVideoId = String(initData.video_id || '').trim()
            const upload_url = String(initData.upload_url || '').trim()
            if (!upload_url || !fbVideoId) {
                throw new Error('No upload URL or video ID returned')
            }

            // Download video and upload to Facebook
            const videoResp = await fetchWithTimeout(realVideoUrl, {}, 60000, 'cron_download_video')
            if (!videoResp.ok) throw new Error(`Fetch video failed with status ${videoResp.status}`)
            const videoBuffer = await videoResp.arrayBuffer()
            if (videoBuffer.byteLength < 100000) throw new Error(`Video too small (${videoBuffer.byteLength} bytes). Download failed.`) // Prevent HTML error uploads

            const uploadResp = await fetchWithTimeout(upload_url, {
                method: 'POST',
                headers: {
                    'Authorization': `OAuth ${postingTokenUsed}`,
                    'offset': '0',
                    'file_size': videoBuffer.byteLength.toString(),
                },
                body: videoBuffer,
            }, 120000, 'cron_upload_video')
            const uploadData = await uploadResp.json() as { success?: boolean; error?: { message: string } }

            if (uploadData.error) {
                throw new Error(uploadData.error.message)
            }

            // Finish upload (retry if Facebook still processing uploaded video)
            const finishData = await finishReelPublishWithRetry({
                accessToken: postingTokenUsed,
                pageId: page.id,
                fbVideoId,
                description: caption,
                logPrefix: `CRON ${page.name}`,
            })
            const confirmedPostId = String(finishData.post_id || '').trim() || fbVideoId
            const fbReelUrl = String(finishData.permalink_url || '').trim() || `https://www.facebook.com/reel/${confirmedPostId}`

            // คอมเม้นท์เลยหลังรอ 10 วินาที
            let commentStatus = initialCommentStatus
            let commentError: string | null = null
            let commentFbId: string | null = null
            const commentTargetId = confirmedPostId || fbVideoId

            if (normalizedShopeeLink) {
                console.log(`[CRON] Page ${page.name}: waiting 10s before comment...`)
                await new Promise(r => setTimeout(r, 10000))
                const commentResult = await postShopeeCommentWithFallback({
                    fbVideoId: commentTargetId,
                    shopeeLink: normalizedShopeeLink,
                    commentTokens: commentTokenCandidates,
                    pageId: page.id,
                    logPrefix: `CRON ${page.name}`,
                })
                if (!commentResult.ok) {
                    commentStatus = 'failed'
                    commentError = commentResult.error || 'comment_failed'
                    console.error(`[CRON] Page ${page.name}: comment FAILED: ${commentResult.error}`)
                    await notifyCommentTokenIssue(
                        env,
                        botId,
                        page.id,
                        page.name,
                        commentError,
                    ).catch((notifyErr) => {
                        console.error(`[CRON] Page ${page.name}: notifyCommentTokenIssue failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
                    })
                } else {
                    commentStatus = 'success'
                    commentFbId = commentResult.id || null
                }
            }

            // Update to success
                await env.DB.prepare(
                    "UPDATE post_history SET fb_post_id = ?, fb_reel_url = ?, status = 'success', error_message = NULL, comment_status = ?, comment_token_hint = ?, comment_error = ?, comment_fb_id = ? WHERE page_id = ? AND video_id = ? AND status = 'posting' AND bot_id = ?"
                ).bind(confirmedPostId, fbReelUrl, commentStatus, commentTokenHint, commentError, commentFbId, page.id, unpostedId, botId).run()

                await clearVideoShopeeLink(botBucket, unpostedId)
                console.log(`[CRON] Page ${page.name}: posted successfully (fb_video_id: ${fbVideoId}, post_id: ${confirmedPostId})`)

        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e)
            console.error(`[CRON] Page ${page.name}: post failed - ${errorMsg}`)

            // Recovery path: Facebook may already publish this reel even when upload/finish returns transient errors.
            let recovered = false
            try {
                let recoveredPostId = ''
                let recoveredReelUrl = ''

                if (fbVideoId) {
                    const recoveredResult = await pollPublishedReelAfterProcessing({
                        accessToken: postingTokenUsed || String(page.access_token || ''),
                        fbVideoId,
                        logPrefix: `CRON ${page.name} RECOVER`,
                    })
                    if (recoveredResult.published && recoveredResult.post_id) {
                        recoveredPostId = String(recoveredResult.post_id || '').trim() || fbVideoId
                        recoveredReelUrl = String(recoveredResult.permalink_url || '').trim() || `https://www.facebook.com/reel/${recoveredPostId}`
                    }
                }

                if (!recoveredPostId && caption) {
                    const feedRecovered = await recoverPublishedReelFromRecentFeed({
                        accessToken: page.access_token,
                        pageId: page.id,
                        expectedCaption: caption,
                        notBeforeIso: nowISO,
                        logPrefix: `CRON ${page.name} RECOVER-FEED`,
                    })
                    if (feedRecovered.published && feedRecovered.post_id) {
                        recoveredPostId = String(feedRecovered.post_id || '').trim()
                        recoveredReelUrl = String(feedRecovered.permalink_url || '').trim() || `https://www.facebook.com/reel/${recoveredPostId}`
                    }
                }

                if (recoveredPostId) {
                    if (!recoveredReelUrl) {
                        recoveredReelUrl = `https://www.facebook.com/reel/${recoveredPostId}`
                    }

                    let commentStatus = initialCommentStatus
                    let commentError: string | null = null
                    let commentFbId: string | null = null
                    const commentTargetId = recoveredPostId || fbVideoId

                    if (normalizedShopeeLink) {
                        console.log(`[CRON] Page ${page.name}: recovery comment wait 10s...`)
                        await waitMs(10000)
                        const commentResult = await postShopeeCommentWithFallback({
                            fbVideoId: commentTargetId,
                            shopeeLink: normalizedShopeeLink,
                            commentTokens: commentTokenCandidates,
                            pageId: page.id,
                            logPrefix: `CRON ${page.name} RECOVER`,
                        })
                        if (!commentResult.ok) {
                            commentStatus = 'failed'
                            commentError = commentResult.error || 'comment_failed'
                            await notifyCommentTokenIssue(
                                env,
                                botId,
                                page.id,
                                page.name,
                                commentError,
                            ).catch((notifyErr) => {
                                console.error(`[CRON] Page ${page.name}: recover notifyCommentTokenIssue failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`)
                            })
                        } else {
                            commentStatus = 'success'
                            commentFbId = commentResult.id || null
                        }
                    }

                    await env.DB.prepare(
                        "UPDATE post_history SET fb_post_id = ?, fb_reel_url = ?, status = 'success', error_message = NULL, comment_status = ?, comment_token_hint = ?, comment_error = ?, comment_fb_id = ? WHERE page_id = ? AND video_id = ? AND status IN ('posting','failed') AND bot_id = ?"
                    ).bind(
                        recoveredPostId,
                        recoveredReelUrl,
                        commentStatus,
                        commentTokenHint,
                        commentError,
                        commentFbId,
                        page.id,
                        unpostedId,
                        botId,
                    ).run()

                    await clearVideoShopeeLink(botBucket, unpostedId)
                    console.log(`[CRON] Page ${page.name}: recovered as success (fb_video_id: ${fbVideoId}, post_id: ${recoveredPostId})`)
                    recovered = true
                }
            } catch (recoverErr) {
                console.error(`[CRON] Page ${page.name}: recover failed - ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`)
            }

            if (recovered) {
                continue
            }

            // Update to failed
            await env.DB.prepare(
                "UPDATE post_history SET status = 'failed', error_message = ?, comment_status = 'not_attempted' WHERE page_id = ? AND video_id = ? AND status = 'posting' AND bot_id = ?"
            ).bind(errorMsg, page.id, unpostedId, botId).run()

            // Clean up dedup key to allow retry in next cron cycle
            await botBucket.delete(dedupKey).catch(() => { })
        }
    }

    console.log('[CRON] Auto-post check complete')
}

// Container class สำหรับ FFmpeg merge + Full Pipeline
export class MergeContainer extends Container {
    defaultPort = 8080
    sleepAfter = '10m'
}

/** Watchdog: ตรวจจับ job ค้าง → ย้ายกลับ queue เพื่อ retry (สูงสุด 3 ครั้ง) */
async function watchdogStuckJobs(env: Env) {
    const MAX_RETRIES = 3
    const STUCK_THRESHOLD_MS = 10 * 60 * 1000 // 10 นาที
    const now = Date.now()

    // รวบรวม botId ทั้งหมด (default + ทุก channel ที่ลงทะเบียน)
    const botIds: string[] = ['default']
    try {
        const { results } = await env.DB.prepare('SELECT DISTINCT bot_id FROM channels').all()
        for (const row of results) {
            const id = (row as any).bot_id
            if (id && id !== 'default') botIds.push(id)
        }
    } catch { /* DB might not have channels yet */ }

    for (const botId of botIds) {
        const botBucket = new BotBucket(env.BUCKET, botId)
        try {
            const list = await botBucket.list({ prefix: '_processing/' })
            if (list.objects.length === 0) continue

            for (const obj of list.objects) {
                const data = await botBucket.get(obj.key)
                if (!data) continue

                const job = await data.json() as {
                    id: string; videoUrl: string; chatId: number;
                    shopeeLink?: string; updatedAt?: string; createdAt?: string;
                    retryCount?: number; step?: number; stepName?: string; status?: string;
                }

                if (job.status === 'failed') continue // ข้ามที่ mark failed แล้ว

                // เช็คว่าค้างหรือยัง
                const lastUpdate = job.updatedAt || job.createdAt || obj.uploaded.toISOString()
                const elapsed = now - new Date(lastUpdate).getTime()

                if (elapsed < STUCK_THRESHOLD_MS) continue // ยังไม่ค้าง

                const retryCount = (job.retryCount || 0) + 1
                const stuckStep = job.stepName || `step ${job.step || '?'}`

                console.log(`[WATCHDOG] Job ${job.id} (bot: ${botId}) stuck at "${stuckStep}" for ${Math.round(elapsed / 1000)}s (retry #${retryCount})`)

                // ลบจาก _processing/
                await botBucket.delete(obj.key)

                if (retryCount > MAX_RETRIES) {
                    console.log(`[WATCHDOG] Job ${job.id} exceeded max retries (${MAX_RETRIES}), marking as failed`)
                    await sendTelegram(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
                        chat_id: job.chatId,
                        text: `❌ วิดีโอ ${job.id} ล้มเหลวหลัง retry ${MAX_RETRIES} ครั้ง\nกรุณาส่งลิงก์ใหม่อีกครั้ง`,
                    }).catch(() => { })
                } else {
                    // ย้ายกลับ _queue/ เพื่อ retry
                    await botBucket.put(`_queue/${job.id}.json`, JSON.stringify({
                        id: job.id,
                        videoUrl: job.videoUrl,
                        chatId: job.chatId,
                        shopeeLink: job.shopeeLink || '',
                        createdAt: new Date().toISOString(),
                        status: 'queued',
                        retryCount,
                    }), {
                        httpMetadata: { contentType: 'application/json' },
                    })
                    console.log(`[WATCHDOG] Job ${job.id} moved back to queue (retry #${retryCount})`)
                }
            }

            // ลองเริ่มอันถัดไปในคิวของ bot นี้
            await processNextInQueue(env, botId)
        } catch (e) {
            console.error(`[WATCHDOG] Error for bot ${botId}:`, e instanceof Error ? e.message : String(e))
        }
    }
}

export default {
    fetch: app.fetch,
    scheduled: async (event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
        // Watchdog ทำงานก่อน → ตรวจจับ job ค้าง + retry
        await watchdogStuckJobs(env)
        // Background sync tokens/page mapping from BrowserSaving tags.
        await autoSyncPagesFromBrowserSavingTags(env)
        await handleScheduled(env)
    },
}
