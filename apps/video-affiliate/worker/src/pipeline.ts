/**
 * Dubbing Pipeline — 100% Cloudflare Native
 * ffmpeg merge รันใน Cloudflare Container
 */

import { BotBucket } from './utils/botBucket'

const EXPECTED_PIPELINE_ENGINE_VERSION = '2026-03-12.01'
const VOICE_PROMPT_KEY = 'voice_script_prompt_v1'
const GEMINI_API_KEY_SETTING_KEY = 'gemini_api_key_v1'
const MAX_VOICE_PROMPT_CHARS = 12000

export const DEFAULT_VOICE_PROMPT_TEMPLATE = `คุณคือคอนเทนต์ครีเอเตอร์และนักพากย์มืออาชีพสำหรับคลิปสั้นแนว Reels

งานของคุณ:
1) วิเคราะห์วิดีโออย่างละเอียดก่อนเขียน: ฉากเปิด, การกระทำหลัก, จุดพีค, อารมณ์, และเจตนาของคลิป
2) เลือกแนวพากย์ให้เหมาะกับเนื้อหาจริง (รีวิวสินค้า/สาธิต/ไวรัล/เล่าเรื่อง/ตลก)
3) เขียนบทพากย์ไทยที่ลื่นไหล ฟังธรรมชาติ ไม่ท่องแพทเทิร์นเดิม

กฎบังคับ:
- ห้ามใช้คำเปิดซ้ำทุกคลิป เช่น "แม่จ๋า", "อุ๊ยตาย", "ของมันต้องมี" เว้นแต่ภาพบังคับจริง
- ห้ามใช้คำหรือโครงประโยคซ้ำติดกัน ต้องมีความหลากหลายของถ้อยคำ
- ทุกประโยคต้องอิงสิ่งที่เห็นในวิดีโอจริง ห้ามมโนรายละเอียดที่ไม่ปรากฏ
- ถ้าเป็นคลิปไวรัล/บันเทิงที่ไม่ใช่รีวิวสินค้า ให้พากย์แบบเล่าเหตุการณ์หรือคอมเมนต์เชิงคอนเทนต์แทนการ hard sell
- ถ้าคลิปมีสินค้าและจุดขายชัดเจน ค่อยใส่ CTA สั้นๆ ท้ายคลิปแบบพอดี
- ห้ามขึ้นต้นด้วยคำว่า "สวัสดี"
- โทนโดยรวมต้องเป็นมืออาชีพ มีพลัง และตรงจังหวะภาพ`

export type Env = {
    DB: D1Database
    BUCKET: R2Bucket // Raw bucket, use with BotBucket if needed
    MERGE_CONTAINER: DurableObjectNamespace
    BROWSERSAVING_SERVICE?: Fetcher
    TELEGRAM_BOT_TOKEN: string
    WORKER_URL?: string
    R2_PUBLIC_URL: string
    R2_ACCOUNT_ID: string
    R2_ACCESS_KEY_ID: string
    R2_SECRET_ACCESS_KEY: string
    GEMINI_MODEL: string
    CORS_ORIGIN: string
    WEBAPP_URL?: string
    BROWSERSAVING_WORKER_URL?: string
    BROWSERSAVING_API_URL?: string
    TAG_SYNC_PUSH_SECRET?: string
}

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

function buildScopedWebAppUrl(baseUrl: string, botScope: string) {
    const scope = String(botScope || '').trim()
    if (!scope) return baseUrl
    try {
        const url = new URL(baseUrl)
        url.searchParams.set('bot', scope)
        return url.toString()
    } catch {
        return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}bot=${encodeURIComponent(scope)}`
    }
}

function buildScopedGalleryWebAppUrl(baseUrl: string, botScope: string, videoId: string, store: 'shopee' | 'lazada' = 'lazada') {
    const scopedBaseUrl = buildScopedWebAppUrl(baseUrl, botScope)
    try {
        const url = new URL(scopedBaseUrl)
        url.pathname = '/gallery'
        url.searchParams.set('store', store)
        const trimmedVideoId = String(videoId || '').trim()
        if (trimmedVideoId) {
            url.searchParams.set('q', trimmedVideoId)
        } else {
            url.searchParams.delete('q')
        }
        return url.toString()
    } catch {
        const params = new URLSearchParams()
        const scope = String(botScope || '').trim()
        const trimmedVideoId = String(videoId || '').trim()
        if (scope) params.set('bot', scope)
        params.set('store', store)
        if (trimmedVideoId) params.set('q', trimmedVideoId)
        const query = params.toString()
        return `${baseUrl.replace(/\/+$/, '')}/gallery${query ? `?${query}` : ''}`
    }
}

export async function getVoicePromptTemplate(db: D1Database, namespaceId: string): Promise<{ prompt: string; source: 'custom' | 'default'; updatedAt: string | null }> {
    await ensureNamespaceSettingsTable(db)
    const row = await db.prepare(
        'SELECT value, updated_at FROM namespace_settings WHERE namespace_id = ? AND key = ?'
    ).bind(namespaceId, VOICE_PROMPT_KEY).first() as { value?: string; updated_at?: string } | null

    const custom = String(row?.value || '').trim()
    if (custom) {
        return { prompt: custom.slice(0, MAX_VOICE_PROMPT_CHARS), source: 'custom', updatedAt: row?.updated_at || null }
    }
    return { prompt: DEFAULT_VOICE_PROMPT_TEMPLATE, source: 'default', updatedAt: null }
}

export async function setVoicePromptTemplate(db: D1Database, namespaceId: string, rawPrompt: string) {
    await ensureNamespaceSettingsTable(db)
    const prompt = String(rawPrompt || '').trim()
    if (!prompt) {
        await db.prepare(
            'DELETE FROM namespace_settings WHERE namespace_id = ? AND key = ?'
        ).bind(namespaceId, VOICE_PROMPT_KEY).run()
        return { prompt: DEFAULT_VOICE_PROMPT_TEMPLATE, source: 'default' as const }
    }

    const normalized = prompt.slice(0, MAX_VOICE_PROMPT_CHARS)
    await db.prepare(
        `INSERT INTO namespace_settings (namespace_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(namespace_id, key)
         DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(namespaceId, VOICE_PROMPT_KEY, normalized).run()

    return { prompt: normalized, source: 'custom' as const }
}

async function getNamespaceGeminiApiKey(db: D1Database, namespaceId: string): Promise<string> {
    await ensureNamespaceSettingsTable(db)
    const row = await db.prepare(
        'SELECT value FROM namespace_settings WHERE namespace_id = ? AND key = ?'
    ).bind(namespaceId, GEMINI_API_KEY_SETTING_KEY).first() as { value?: string } | null
    return String(row?.value || '').trim()
}

// ==================== Telegram Helpers ====================

export async function sendTelegram(token: string, method: string, body: Record<string, unknown>) {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    return resp.json() as Promise<{ ok: boolean; result?: Record<string, unknown> }>
}

// ==================== XHS Download ====================

async function resolveXhsVideo(url: string, env: Env): Promise<string | null> {
    // เรียก Container เพื่อ resolve XHS URL
    const containerId = env.MERGE_CONTAINER.idFromName('merge-worker')
    const containerStub = env.MERGE_CONTAINER.get(containerId)

    const resp = await containerStub.fetch('http://container/xhs/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    })

    if (!resp.ok) return null

    const data = await resp.json() as { video_url?: string }
    return data?.video_url || null
}

// ==================== Gallery Cache ====================

async function listAllByPrefix(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
    const objects: R2Object[] = []
    let cursor: string | undefined
    do {
        const page = await bucket.list(cursor ? { prefix, cursor } : { prefix })
        objects.push(...page.objects)
        cursor = page.truncated && page.cursor ? page.cursor : undefined
    } while (cursor)
    return objects
}

function normalizeGalleryCacheVideo(
    key: string,
    raw: Record<string, unknown>,
    namespaceId?: string,
): Record<string, unknown> {
    const derivedId = String(key.match(/^videos\/(.+)\.json$/)?.[1] || '').trim()
    const normalizedId = String(raw.id || derivedId).trim() || derivedId
    const normalizedNamespaceId = String(raw.namespace_id || namespaceId || '').trim()

    return {
        ...raw,
        ...(normalizedId ? { id: normalizedId } : {}),
        ...(normalizedNamespaceId ? { namespace_id: normalizedNamespaceId } : {}),
    }
}

/** Rebuild _cache/gallery.json — อ่าน .json ทั้งหมดแล้วรวมเป็นไฟล์เดียว */
export async function rebuildGalleryCache(bucket: R2Bucket, botId?: string): Promise<unknown[]> {
    const b = botId ? new (await import('./utils/botBucket')).BotBucket(bucket, botId) : bucket
    const objects = await listAllByPrefix(b as unknown as R2Bucket, 'videos/')
    const videos: unknown[] = []

    for (const obj of objects) {
        if (!obj.key.endsWith('.json')) continue
        const metaObj = await b.get(obj.key)
        if (!metaObj) continue
        const rawVideo = await metaObj.json() as Record<string, unknown>
        videos.push(normalizeGalleryCacheVideo(obj.key, rawVideo, botId))
    }

    videos.sort((a: any, b: any) =>
        (b.createdAt || '').localeCompare(a.createdAt || '')
    )

    await b.put('_cache/gallery.json', JSON.stringify({ videos }), {
        httpMetadata: { contentType: 'application/json' },
    })

    return videos
}

/** Incremental delete — อ่าน cache เดิม แล้ว filter ออก 1 video */
export async function removeFromGalleryCache(bucket: R2Bucket, videoId: string, botId?: string): Promise<void> {
    const b = botId ? new (await import('./utils/botBucket')).BotBucket(bucket, botId) : bucket
    const cacheObj = await b.get('_cache/gallery.json')
    if (!cacheObj) return
    const cache = await cacheObj.json() as { videos: Record<string, unknown>[] }
    const videos = (cache.videos || []).filter(v => v.id !== videoId)
    await b.put('_cache/gallery.json', JSON.stringify({ videos }), {
        httpMetadata: { contentType: 'application/json' },
    })
}

/** Incremental update — อ่าน cache เดิม แล้ว upsert เฉพาะ 1 video */
export async function updateGalleryCache(bucket: R2Bucket, videoId: string, botId?: string): Promise<void> {
    const b = botId ? new (await import('./utils/botBucket')).BotBucket(bucket, botId) : bucket
    // อ่าน metadata ของ video ที่เปลี่ยน
    const metaObj = await b.get(`videos/${videoId}.json`)
    if (!metaObj) return

    const updatedVideo = await metaObj.json() as Record<string, unknown>

    // อ่าน cache เดิม
    let videos: Record<string, unknown>[] = []
    const cacheObj = await b.get('_cache/gallery.json')
    if (cacheObj) {
        const cache = await cacheObj.json() as { videos: Record<string, unknown>[] }
        videos = cache.videos || []
    }

    // Upsert: แทนที่ตัวเดิม หรือเพิ่มใหม่
    const idx = videos.findIndex(v => v.id === videoId)
    const existingVideo = idx >= 0 ? videos[idx] : undefined
    const normalizedVideo = normalizeGalleryCacheVideo(`videos/${videoId}.json`, {
        ...(existingVideo || {}),
        ...updatedVideo,
    }, String(updatedVideo.namespace_id || existingVideo?.namespace_id || botId || '').trim() || undefined)
    if (idx >= 0) {
        videos[idx] = normalizedVideo
    } else {
        videos.unshift(normalizedVideo) // เพิ่มใหม่ที่หัว (ล่าสุด)
    }

    // Sort by createdAt desc
    videos.sort((a, b) =>
        ((b.createdAt as string) || '').localeCompare((a.createdAt as string) || '')
    )

    await b.put('_cache/gallery.json', JSON.stringify({ videos }), {
        httpMetadata: { contentType: 'application/json' },
    })
}

// ==================== Main Pipeline ====================

export async function runPipeline(
    env: Env,
    videoUrl: string,
    chatId: number,
    statusMsgId: number,
    videoId: string,
    botId: string,
    shopeeLink?: string | null,
    lazadaLink?: string | null,
) {
    let token = env.TELEGRAM_BOT_TOKEN
    try {
        const ch = await env.DB.prepare('SELECT bot_token FROM channels WHERE bot_id = ?').bind(botId).first() as any
        if (ch?.bot_token) {
            token = ch.bot_token
            console.log(`[PIPELINE] Using channel bot token for botId=${botId}`)
        } else {
            console.log(`[PIPELINE] No channel found for botId=${botId}, using default token`)
        }
    } catch (e) {
        console.log(`[PIPELINE] DB lookup failed, using default token: ${e}`)
    }
    const apiKey = await getNamespaceGeminiApiKey(env.DB, botId).catch(() => '')
    if (!apiKey) {
        throw new Error('ยังไม่ได้ตั้ง Gemini API key สำหรับ workspace นี้')
    }
    const model = env.GEMINI_MODEL || 'gemini-3-flash-preview'
    const voicePrompt = await getVoicePromptTemplate(env.DB, botId)
        .then((v) => v.prompt)
        .catch(() => DEFAULT_VOICE_PROMPT_TEMPLATE)

    try {
        // ถ้าเป็น XHS link → resolve URL จริงก่อน (เร็ว ~1-2 วินาที)
        let directVideoUrl = videoUrl
        if (videoUrl.includes('xhs') || videoUrl.includes('xiaohongshu')) {
            const resolved = await resolveXhsVideo(videoUrl, env)
            if (!resolved) throw new Error('ไม่พบวิดีโอใน XHS link นี้')
            directVideoUrl = resolved
        }

        // ส่งงานทั้งหมดไป Container /pipeline — รัน background ไม่มี time limit
        const containerId = env.MERGE_CONTAINER.idFromName('merge-worker')
        const containerStub = env.MERGE_CONTAINER.get(containerId)

        const payload = JSON.stringify({
            token,
            video_url: directVideoUrl,
            chat_id: chatId,
            msg_id: statusMsgId,
            api_key: apiKey,
            model,
            script_prompt: voicePrompt,
            r2_public_url: env.R2_PUBLIC_URL,
            worker_url: String(env.WORKER_URL || '').trim() || 'https://video-affiliate-worker.onlyy-gor.workers.dev',
            completion_webapp_url: buildScopedGalleryWebAppUrl(
                env.WEBAPP_URL || 'https://video-affiliate-webapp-38v.pages.dev',
                botId,
                videoId,
                'lazada',
            ),
            video_id: videoId,
            bot_id: botId,
            shopee_link: String(shopeeLink || '').trim() || undefined,
            lazada_link: String(lazadaLink || '').trim() || undefined,
        })

        // Health check ก่อน — รอ Container boot สูงสุด 3 ครั้ง × 3 วินาที = 9 วินาที
        let containerReady = false
        for (let i = 0; i < 3; i++) {
            try {
                const hResp = await containerStub.fetch('http://container/health')
                const hText = await hResp.text()
                if (!hText.startsWith('<') && hResp.ok) {
                    const hJson = JSON.parse(hText) as { build?: string; status?: string; pipeline_engine_version?: string }
                    if (!hJson.pipeline_engine_version) {
                        throw new Error('Container health response invalid: missing pipeline_engine_version')
                    }
                    if (hJson.pipeline_engine_version !== EXPECTED_PIPELINE_ENGINE_VERSION) {
                        throw new Error(
                            `Container version mismatch: expected ${EXPECTED_PIPELINE_ENGINE_VERSION}, got ${hJson.pipeline_engine_version}`
                        )
                    }
                    console.log(
                        `[PIPELINE] Container health ok status=${hJson.status || 'unknown'} build=${hJson.build || 'unknown'} version=${hJson.pipeline_engine_version}`
                    )
                    containerReady = true
                    break
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                if (msg.includes('Container version mismatch') || msg.includes('Container health response invalid')) {
                    throw err
                }
                // Container ยัง boot
            }
            await new Promise(r => setTimeout(r, 3000))
        }

        if (!containerReady) {
            throw new Error('⏳ Container กำลัง boot ใหม่ กรุณาลองส่งลิงก์อีกครั้งใน 30 วินาที')
        }

        // Dispatch pipeline
        const resp = await containerStub.fetch('http://container/pipeline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        })

        const body = await resp.text()
        if (body.startsWith('<') || !resp.ok) {
            throw new Error(`Container pipeline error ${resp.status}: ${body.slice(0, 100)}`)
        }

        console.log(`[PIPELINE] Dispatched to container for chat_id=${chatId}`)

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        console.error(`[PIPELINE] ผิดพลาด: ${errMsg}`)

        try {
            const botBucket = new BotBucket(env.BUCKET, botId)
            const key = `_processing/${videoId}.json`
            const existingObj = await botBucket.get(key)
            let current: Record<string, unknown> = {}
            if (existingObj) {
                try {
                    current = await existingObj.json() as Record<string, unknown>
                } catch {
                    current = {}
                }
            }

            const nowIso = new Date().toISOString()
            await botBucket.put(key, JSON.stringify({
                ...current,
                id: videoId,
                videoUrl,
                shopeeLink: String(shopeeLink || '').trim() || undefined,
                lazadaLink: String(lazadaLink || '').trim() || undefined,
                chatId,
                status: 'failed',
                error: errMsg,
                updatedAt: nowIso,
                createdAt: String(current.createdAt || '').trim() || nowIso,
            }), {
                httpMetadata: { contentType: 'application/json' },
            })
        } catch (persistErr) {
            console.error(`[PIPELINE] mark failed error: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`)
        }

        if (statusMsgId) {
            await sendTelegram(token, 'editMessageText', {
                chat_id: chatId,
                message_id: statusMsgId,
                text: `❌ ผิดพลาด\n\n${errMsg.slice(0, 150)}`,
                parse_mode: 'HTML',
            }).catch(() => { })
        } else {
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: `❌ ผิดพลาด\n\n${errMsg.slice(0, 150)}`,
                parse_mode: 'HTML',
            }).catch(() => { })
        }

        await processNextInQueue(env, botId).catch((queueErr) => {
            console.error(`[PIPELINE] queue next error: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`)
        })
    }
}


/** เช็คคิวและเริ่มทำอันถัดไป (ถ้ามี) */
export async function processNextInQueue(env: Env, botId: string): Promise<boolean> {
    const botBucket = new BotBucket(env.BUCKET, botId)
    // เช็คว่ายังมี pipeline กำลังรันอยู่ไหม (ข้าม status: failed)
    const processingList = await botBucket.list({ prefix: '_processing/' })
    if (processingList.objects.length > 0) {
        let hasActive = false
        for (const obj of processingList.objects) {
            const file = await botBucket.get(obj.key)
            if (!file) continue
            const data = await file.json() as any
            if (data.status !== 'failed') { hasActive = true; break }
        }
        if (hasActive) {
            console.log('[QUEUE] Pipeline still running, skip')
            return false
        }
    }

    // เช็คคิว
    const queueList = await botBucket.list({ prefix: '_queue/' })
    if (queueList.objects.length === 0) {
        console.log('[QUEUE] No jobs in queue')
        return false
    }

    // เอาตัวที่เก่าที่สุด (sorted by key/timestamp)
    const sorted = queueList.objects.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime())
    const oldest = sorted[0]

    const jobData = await botBucket.get(oldest.key)
    if (!jobData) return false

    const job = await jobData.json() as { id: string; videoUrl: string; chatId: number; shopeeLink?: string; lazadaLink?: string }

    // ย้ายจาก _queue → _processing
    await botBucket.delete(oldest.key)
    await botBucket.put(`_processing/${job.id}.json`, JSON.stringify({
        ...job,
        status: 'processing',
        createdAt: new Date().toISOString(),
    }), {
        httpMetadata: { contentType: 'application/json' },
    })

    // เริ่ม pipeline — need to await directly since we're in waitUntil already
    await runPipeline(env, job.videoUrl, job.chatId, 0, job.id, botId, job.shopeeLink, job.lazadaLink)

    return true
}
