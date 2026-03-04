import fs from 'fs';

let code = fs.readFileSync('src/index.ts', 'utf8');

// replace the Env imports
code = code.replace(/import \{ Container \} from '@cloudflare\/containers'/, "import { Container } from '@cloudflare/containers'\nimport { BotBucket } from './utils/botBucket'\nimport { getBotId } from './utils/botAuth'");

code = code.replace(
    'const app = new Hono<{ Bindings: Env }>()',
    'const app = new Hono<{ Bindings: Env, Variables: { botId: string; bucket: R2Bucket } }>()'
);

// Add middleware after CORS
const mw = `
app.use('*', async (c, next) => {
    let token = c.req.header('x-auth-token') || '';
    if (!token && c.req.path.startsWith('/api/telegram/')) {
        const parts = c.req.path.split('/');
        if (parts.length >= 4) token = parts[3];
    }
    const botId = getBotId(token);
    c.set('botId', botId);
    c.set('bucket', new BotBucket(c.env.BUCKET, botId) as unknown as R2Bucket);
    await next();
})
`;

code = code.replace('// Health check', mw + '\n// Health check');

// Fix /api/telegram to accommodate :token and multi-tenant webhook logic
code = code.replace("app.post('/api/telegram', async (c) => {", `app.post('/api/telegram/:token?', async (c) => {
    const data = await c.req.json() as any
    const msg = data.message
    const cb = data.callback_query
    const chatId = msg?.chat?.id || cb?.message?.chat?.id
    const token = c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN
    const botId = c.get('botId') || 'default'

    // Verify User Access
    if (chatId) {
        const allowedUser = await c.env.DB.prepare('SELECT 1 FROM allowed_users WHERE telegram_id = ?').bind(chatId).first()
        if (!allowedUser) {
            console.log('Unauthorized Telegram ID:', chatId)
            return c.text('ok')
        }
    } else {
        return c.text('ok')
    }

    // Process Callback Query First
    if (cb) {
        const action = cb.data as string
        if (action.startsWith('add_page:')) {
            const targetId = action.split(':')[1]
            const tempObj = await c.env.BUCKET.get(\`_fb_temp/\${chatId}.json\`)
            if (tempObj) {
                const pagesList = await tempObj.json() as any[]
                const targetPage = pagesList.find(p => p.id === targetId)
                if (targetPage) {
                    const imageUrl = targetPage.picture?.data?.url || ''
                    await c.env.DB.prepare(
                        'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, 60, 1, ?) ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, name = excluded.name, image_url = excluded.image_url, bot_id = excluded.bot_id'
                    ).bind(targetPage.id, targetPage.name, imageUrl, targetPage.access_token, botId).run()
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: \`✅ *เชื่อมต่อเพจเสร็จสมบูรณ์!*\\nเพจ: \${targetPage.name}\\n\\nระบบจะทำการโพสต์ไปยังเพจนี้ตามคิวที่ตั้งไว้\`, parse_mode: 'Markdown' })
                }
            }
            await sendTelegram(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: "เพิ่มข้อมูลสำเร็จ!" }).catch(()=>null)
        }
        return c.text('ok')
    }

    if (!msg) return c.text('ok')
    const text = msg.text || ''

    // Telegram UI Configuration Commands (Bot UI)
    const stateKey = \`_user_state/\${chatId}.json\`
    
    if (text === '/start' || text === '/menu') {
        await c.env.BUCKET.delete(stateKey)
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: '👋 *ระบบโพสต์อัตโนมัติ Video Affiliate*\\n\\n⚙️ *เมนูลัด*\\n🔹 /newchannel - เชื่อมต่อเพจ Facebook เข้าบอท\\n🔹 /channels - ดูรายการเพจทั้งหมดและจัดการ\\n🔹 /status - ดูสถานะการทำงานบอท\\n\\nสามารถส่งลิงก์วิดีโอเข้าคิวได้เลย!',
            parse_mode: 'Markdown'
        })
        return c.text('ok')
    }

    if (text === '/newchannel') {
        await c.env.BUCKET.put(stateKey, JSON.stringify({ state: 'WAITING_FB_TOKEN' }), { httpMetadata: { contentType: 'application/json' } })
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: '📥 *เพิ่มช่อง Facebook*\\n\\nกรุณาส่ง *User Access Token* ของ Facebook (ที่ได้จาก Meta for Developers) มาในข้อความถัดไปได้เลยครับผม',
            parse_mode: 'Markdown'
        })
        return c.text('ok')
    }

    if (text === '/channels') {
        await c.env.BUCKET.delete(stateKey)
        const { results: pages } = await c.env.DB.prepare('SELECT id, name FROM pages WHERE bot_id = ?').bind(botId).all() as any
        if (pages.length === 0) {
            await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ ขณะนี้ยังไม่มีช่องใดถูกผูกกับบอทตัวนี้ครับ' })
            return c.text('ok')
        }
        const pageText = pages.map((p: any, i: number) => \`\${i+1}. \${p.name}\\n(ID: \${p.id})\`).join('\\n\\n')
        await sendTelegram(token, 'sendMessage', { 
            chat_id: chatId, 
            text: \`📄 *ช่องทั้งหมดของคุณ*\\n\\n\${pageText}\\n\\nพิมพ์ /delchannel <ID> เพื่อลบช่องครับ\`, 
            parse_mode: 'Markdown' 
        })
        return c.text('ok')
    }

    if (text.startsWith('/delchannel ')) {
        const delId = text.split(' ')[1]
        if (delId) {
            await c.env.DB.prepare('DELETE FROM pages WHERE id = ? AND bot_id = ?').bind(delId, botId).run()
            await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: \`🗑 ลบช่อง ID \${delId} เรียบร้อยแล้ว\` })
        }
        return c.text('ok')
    }

    if (text === '/status') {
        const { results: pages } = await c.env.DB.prepare('SELECT id FROM pages WHERE bot_id = ?').bind(botId).all() as any
        const { results: queued } = await c.env.DB.prepare("SELECT video_id FROM post_queue WHERE status = 'queued' AND bot_id = ?").bind(botId).all() as any
        await sendTelegram(token, 'sendMessage', {
            chat_id: chatId,
            text: \`📊 *สถานะบอทของคุณ*\\n\\n🔗 จำนวนเพจ: \${pages.length}\\n⏳ คิวเตรียมโพสต์: \${queued.length}\\n\\n[แดชบอร์ด WebApp](\${c.env.R2_PUBLIC_URL})\`,
            parse_mode: 'Markdown'
        })
        return c.text('ok')
    }

    const stateObj = await c.env.BUCKET.get(stateKey)
    if (stateObj) {
        const state = await stateObj.json() as any
        if (state.state === 'WAITING_FB_TOKEN' && text && !text.startsWith('/')) {
            await c.env.BUCKET.delete(stateKey)
            const fbToken = text.trim()
            
            const fbResponse = await fetch(\`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,picture.type(large),access_token&access_token=\${fbToken}\`)
            if (!fbResponse.ok) {
                await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ Token ไม่ถูกต้องหรือไม่สามารถดึงข้อมูลเพจได้' })
                return c.text('ok')
            }
            const fbData = await fbResponse.json() as any
            const pagesList = fbData.data || []
            if (pagesList.length === 0) {
                await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ ไม่พบหน้าเพจที่จัดการได้ในบัญชีนี้' })
                return c.text('ok')
            }
            
            await c.env.BUCKET.put(\`_fb_temp/\${chatId}.json\`, JSON.stringify(pagesList), { httpMetadata: { contentType: 'application/json' } })
            const buttons = pagesList.map((p: any) => ([{ text: \`➕ \${p.name}\`, callback_data: \`add_page:\${p.id}\` }]))
            
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '✅ *พบเพจเหล่านี้:* เลือกเพจที่ต้องการซิงค์เข้าบอท 👇',
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            })
            return c.text('ok')
        }
    }
    // ORIGINAL WEBHOOK CONTINUES HERE
    // \`data\` has already been defined, so we just wrap it with try-catch fallback or assign to old variables.
    // The previous code had:
    // const data = await c.req.json() ... 
    // const msg = data.message;
    // const token = c.env.TELEGRAM_BOT_TOKEN;
`);

// The original webhook had "const data = await c.req.json() as { ... }"
// Let's remove this re-declaration because we already declared data, msg, token.
code = code.replace(
    /const data = await c\.req\.json\(\) as \{\n\s+update_id\?: number[\s\S]*?const token = c.env.TELEGRAM_BOT_TOKEN\n/g,
    "// Variables defined upstream\n"
);

// We must replace ALL `c.env.BUCKET` inside route handlers with `c.get('bucket')`. And `c.env.TELEGRAM_BOT_TOKEN` with dynamically obtained token.
code = code.replaceAll('c.env.BUCKET', "c.get('bucket')");
code = code.replaceAll('c.env.TELEGRAM_BOT_TOKEN', "(c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN)");

// Fix runPipeline to accept botId!
code = code.replaceAll("runPipeline(c.env, videoUrl, chatId, 0, videoId)", "runPipeline(c.env, videoUrl, chatId, 0, videoId, c.get('botId'))");
code = code.replaceAll("processNextInQueue(c.env)", "processNextInQueue(c.env, c.get('botId'))");
code = code.replaceAll("processNextInQueue(env)", "processNextInQueue(env, 'default')"); // For cron

// Add BotId to all DB interactions.
// Pages
code = code.replaceAll(
    "'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes) VALUES (?, ?, ?, ?, ?)'\n        ).bind(id, name, image_url, access_token, post_interval_minutes)",
    "'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, bot_id) VALUES (?, ?, ?, ?, ?, ?)'\n        ).bind(id, name, image_url, access_token, post_interval_minutes, c.get('botId'))"
);
code = code.replaceAll(
    "'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, is_active) VALUES (?, ?, ?, ?, 60, 1)'\n                ).bind(pageId, pageName, pageImageUrl, pageAccessToken)",
    "'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, 60, 1, ?)'\n                ).bind(pageId, pageName, pageImageUrl, pageAccessToken, c.get('botId'))"
);
code = code.replaceAll(
    "'SELECT id, name, access_token, comment_token, post_hours FROM pages WHERE id = ?'\n        ).bind(pageId)",
    "'SELECT id, name, access_token, comment_token, post_hours FROM pages WHERE id = ? AND bot_id = ?'\n        ).bind(pageId, c.get('botId'))"
);
code = code.replaceAll(
    "'UPDATE pages SET comment_token = ? WHERE id = ?'\n            ).bind(comment_token, pageId)",
    "'UPDATE pages SET comment_token = ? WHERE id = ? AND bot_id = ?'\n            ).bind(comment_token, pageId, c.get('botId'))"
);
code = code.replaceAll(
    "'DELETE FROM pages WHERE id = ?'\n        ).bind(pageId)",
    "'DELETE FROM pages WHERE id = ? AND bot_id = ?'\n        ).bind(pageId, c.get('botId'))"
);
code = code.replaceAll(
    "WHERE ph.status != 'deleted'\\n             ORDER BY ph.posted_at DESC LIMIT 100",
    "WHERE ph.status != 'deleted' AND p.bot_id = ?\\n             ORDER BY ph.posted_at DESC LIMIT 100`\\n        ).bind(c.get('botId'))"
);
code = code.replaceAll(
    "'INSERT INTO post_queue (video_id, page_id, scheduled_at) VALUES (?, ?, ?)'\n        ).bind(video_id, pageId, scheduled_at)",
    "'INSERT INTO post_queue (video_id, page_id, scheduled_at, bot_id) VALUES (?, ?, ?, ?)'\n        ).bind(video_id, pageId, scheduled_at, c.get('botId'))"
);
code = code.replaceAll(
    "'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at FROM pages ORDER BY created_at DESC'\n        ).all()",
    "'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at FROM pages WHERE bot_id = ? ORDER BY created_at DESC'\n        ).bind(c.get('botId')).all()"
);

// Cron Job Support for multi-tenant BotBucket
const cronTarget = `const { results: pages } = await env.DB.prepare(\`
        SELECT * FROM pages WHERE is_active = 1 AND post_hours IS NOT NULL AND post_hours != ''
    \`).all() as any

    for (const page of pages) {`;

const newCron = `const { results: pages } = await env.DB.prepare(\`
        SELECT * FROM pages WHERE is_active = 1 AND post_hours IS NOT NULL AND post_hours != ''
    \`).all() as any

    for (const page of pages) {
        const botId = page.bot_id || 'default';
        const botBucket = new BotBucket(env.BUCKET, botId) as unknown as R2Bucket;`;

code = code.replaceAll(cronTarget, newCron);
code = code.replaceAll("const metaObj = await env.BUCKET.get(`videos/${unpostedId}.json`)", "const metaObj = await botBucket.get(`videos/${unpostedId}.json`)");
code = code.replaceAll("const meta = await metaObj.json() as { publicUrl: string; script?: string; title?: string; shopeeLink?: string }", "const meta = await metaObj.json() as { publicUrl: string; script?: string; title?: string; shopeeLink?: string; category?: string }");


fs.writeFileSync('src/index.ts', code);
console.log('src/index.ts completely refactored.');
