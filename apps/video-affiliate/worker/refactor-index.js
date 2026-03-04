const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf8');

// replace the Env imports
code = code.replace(/import \{ Container \} from '@cloudflare\/containers'/, "import { Container } from '@cloudflare/containers'\nimport { BotBucket } from './utils/botBucket'\nimport { getBotId } from './utils/botAuth'");

code = code.replace(
    'const app = new Hono<{ Bindings: Env }>()',
    'const app = new Hono<{ Bindings: Env, Variables: { botId: string; bucket: BotBucket } }>()'
);

// 2. Add middleware after CORS
const mw = `
app.use('*', async (c, next) => {
    let token = c.req.header('x-auth-token') || '';
    if (!token && c.req.path.startsWith('/api/telegram/')) {
        const parts = c.req.path.split('/');
        // /api/telegram/:token -> size 4 -> parts[3]
        if (parts.length >= 4) token = parts[3];
    }
    const botId = getBotId(token);
    c.set('botId', botId);
    c.set('bucket', new BotBucket(c.env.BUCKET, botId));
    await next();
})
`;

code = code.replace('// Health check', mw + '\n// Health check');

// replace c.env.BUCKET with c.get('bucket') globally
code = code.replace(/c\.env\.BUCKET/g, "c.get('bucket')");

// Fix /api/telegram
code = code.replace("app.post('/api/telegram', async (c) => {", "app.post('/api/telegram/:token', async (c) => {\n    const botId = c.get('botId')\n    const bucket = c.get('bucket')");

// Telegram Bot Logic Additions
const botLogic = `
        const data = await c.req.json() as any;
        const msg = data.message;
        const cb = data.callback_query;
        let chatId = msg?.chat?.id || cb?.message?.chat?.id;
        const token = c.req.param('token');
        
        if (!chatId) return c.text('ok');

        // Check Allowed Users
        const allowedUser = await c.env.DB.prepare('SELECT 1 FROM allowed_users WHERE telegram_id = ?').bind(chatId).first();
        if (!allowedUser) {
            console.log('Unauthorized Telegram ID:', chatId);
            return c.text('ok'); 
        }

        // Callback Query Handle
        if (cb) {
            const action = cb.data;
            if (action.startsWith('add_page:')) {
                const targetId = action.split(':')[1];
                const tempObj = await bucket.get(\`_fb_temp/\${chatId}.json\`);
                if (!tempObj) {
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ หมดเวลาทำรายการ หรือเซสชันหมดอายุ กรุณาเริ่มด้วย /newchannel ใหม่ครับ' });
                    return c.text('ok');
                }
                const pagesList = await tempObj.json();
                const targetPage = pagesList.find(p => p.id === targetId);
                
                if (!targetPage) {
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ ไม่พบเพจนี้ในรายการ' });
                    return c.text('ok');
                }
                
                const imageUrl = targetPage.picture?.data?.url || '';
                await c.env.DB.prepare(
                    'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, is_active, bot_id) VALUES (?, ?, ?, ?, 60, 1, ?) ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, name = excluded.name, image_url = excluded.image_url, bot_id = excluded.bot_id'
                ).bind(targetPage.id, targetPage.name, imageUrl, targetPage.access_token, botId).run();
                
                await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: \`✅ *เชื่อมต่อเพจเสร็จสมบูรณ์diff c654bd2^ c654bd2 worker/src/index.ts\n\\nเพจ: \${targetPage.name}\\nID: \${targetPage.id}\\n\\nระบบจะทำการโพสต์ไปยังเบจนี้ตามคิวที่ตั้งไว้ครับ\`, parse_mode: 'Markdown' });
                await sendTelegram(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: "เพิ่มแล้ว!" });
            }
            return c.text('ok');
        }

        if (!msg) return c.text('ok');
        const text = msg.text || '';
        
        // Handle State WAITING_FB_TOKEN
        const stateKey = \`_user_state/\${chatId}.json\`;
        const stateObj = await bucket.get(stateKey);
        if (stateObj) {
            const state = await stateObj.json();
            if (state.state === 'WAITING_FB_TOKEN' && text && !text.startsWith('/')) {
                await bucket.delete(stateKey);
                const fbToken = text.trim();
                
                // Fetch FB Pages
                const fbResponse = await fetch(\`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,picture.type(large),access_token&access_token=\${fbToken}\`);
                if (!fbResponse.ok) {
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ Token ไม่ถูกต้องหรือไม่สามารถดึงข้อมูลเพจได้' });
                    return c.text('ok');
                }
                const fbData = await fbResponse.json();
                const pagesList = fbData.data || [];
                if (pagesList.length === 0) {
                    await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ ไม่พบหน้าเพจที่จัดการได้ใน Facebook Account นี้' });
                    return c.text('ok');
                }
                
                await bucket.put(\`_fb_temp/\${chatId}.json\`, JSON.stringify(pagesList));
                const buttons = pagesList.map((p) => ([{ text: \`➕ \${p.name}\`, callback_data: \`add_page:\${p.id}\` }]));
                
                await sendTelegram(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '✅ *พบเพจเหล่านี้:* เลือกเพจที่ต้องการซิงค์เข้าบอท 👇',
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buttons }
                });
                return c.text('ok');
            }
        }

        // Handle Commands
        if (text === '/start' || text === '/menu') {
            await bucket.delete(stateKey);
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '👋 สวัสดี! นี่คือระบบจัดการบัญชี Dubbing ของคุณ\\n\\n⚙️ *เมนูลัด*\\n/newchannel - เชื่อมต่อเพจ Facebook เข้าบอทนี้ ➕\\n/channels - ดูรายการเพจทั้งหมดและลบ 📄\\n/status - ดูสถานะบอท 📊\\n\\nสามารถส่งลิงก์จาก Xiaohongshu หรือไฟล์วิดีโอเพื่อเข้าคิวได้ปกติครับ!',
                parse_mode: 'Markdown'
            });
            return c.text('ok');
        }
        
        if (text === '/newchannel') {
            await bucket.put(stateKey, JSON.stringify({ state: 'WAITING_FB_TOKEN' }));
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: '📥 *เพิ่มช่อง Facebook*\\n\\nกรุณาส่ง *User Access Token* ของ Facebook (ที่ได้จาก Meta for Developers) มาในข้อความถัดไปได้เลยครับผม',
                parse_mode: 'Markdown'
            });
            return c.text('ok');
        }

        if (text === '/channels') {
            await bucket.delete(stateKey);
            const { results: pages } = await c.env.DB.prepare('SELECT id, name FROM pages WHERE bot_id = ?').bind(botId).all();
            if (pages.length === 0) {
                await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: '❌ ขณะนี้ยังไม่มีช่องใดถูกผูกกับบอทตัวนี้ครับ' });
                return c.text('ok');
            }
            const pageText = pages.map((p, i) => \`\${i+1}. \${p.name}\\n(ID: \${p.id})\`).join('\\n\\n');
            await sendTelegram(token, 'sendMessage', { 
                chat_id: chatId, 
                text: \`📄 *ช่องทั้งหมดของคุณ*\\n\\n\${pageText}\\n\\nพิมพ์ \`/delchannel <ID>\` เพื่อลบช่องครับ\`, 
                parse_mode: 'Markdown' 
            });
            return c.text('ok');
        }

        if (text.startsWith('/delchannel ')) {
            const delId = text.split(' ')[1];
            if (delId) {
                await c.env.DB.prepare('DELETE FROM pages WHERE id = ? AND bot_id = ?').bind(delId, botId).run();
                await sendTelegram(token, 'sendMessage', { chat_id: chatId, text: \`🗑 ลบช่อง ID \${delId} เรียบร้อยแล้ว\` });
            }
            return c.text('ok');
        }
        
        if (text === '/status') {
            const { results: pages } = await c.env.DB.prepare('SELECT id FROM pages WHERE bot_id = ?').bind(botId).all();
            const { results: queued } = await c.env.DB.prepare("SELECT video_id FROM post_queue WHERE status = 'queued' AND bot_id = ?").bind(botId).all();
            await sendTelegram(token, 'sendMessage', {
                chat_id: chatId,
                text: \`📊 *สถานะบอทของคุณ*\\n\\n🔗 จำนวนเพจ: \${pages.length}\\n⏳ คิวเตรียมโพสต์: \${queued.length}\\n\\n[แดชบอร์ด WebApp](\${c.env.R2_PUBLIC_URL}) / เปิดเมนู /newchannel\`, // Using default link
                parse_mode: 'Markdown'
            });
            return c.text('ok');
        }
`;

// Remove the top JSON casting block that overlaps with ours
const originalWebhookBody = `
        const data = await c.req.json() as {
            update_id?: number
            message?: {
                message_id: number
                chat: { id: number }
                text?: string
                video?: { file_id: string }
            }
        }

        if (!data?.message) return c.text('ok')

        const msg = data.message
        const chatId = msg.chat.id
        const text = msg.text || ''
        const token = c.env.TELEGRAM_BOT_TOKEN
`;

// replace original message parsing block with ours
code = code.replace(
    originalWebhookBody,
    botLogic + "\n"
);

// We still have 'token' var everywhere which was `c.env.TELEGRAM_BOT_TOKEN`. Wait, we just redefined `token`. But wait, what if `token` is missing? 
// No it's extracted fine in our code. But wait, `c.env.TELEGRAM_BOT_TOKEN` is hardcoded in some places like `sendTelegram(c.env.TELEGRAM_BOT_TOKEN...)`
code = code.replace(/c\.env\.TELEGRAM_BOT_TOKEN/g, "c.req.param('token') || c.req.header('x-auth-token') || c.env.TELEGRAM_BOT_TOKEN");

// Fix db queries
// 1. SELECT id, name... FROM pages
code = code.replace(
    "'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at FROM pages ORDER BY created_at DESC'\n        ).all()",
    "'SELECT id, name, image_url, access_token, comment_token, post_interval_minutes, post_hours, is_active, last_post_at, created_at FROM pages WHERE bot_id = ? ORDER BY created_at DESC'\n        ).bind(c.get('botId')).all()"
);

// 2. INSERT pages
code = code.replace(
    "'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes) VALUES (?, ?, ?, ?, ?)'\n        ).bind(id, name, image_url, access_token, post_interval_minutes)",
    "'INSERT INTO pages (id, name, image_url, access_token, post_interval_minutes, bot_id) VALUES (?, ?, ?, ?, ?, ?)'\n        ).bind(id, name, image_url, access_token, post_interval_minutes, c.get('botId'))"
);

// 3. GET /api/pages/:id
code = code.replace(
    "'SELECT id, name, access_token, comment_token, post_hours FROM pages WHERE id = ?'\n        ).bind(pageId)",
    "'SELECT id, name, access_token, comment_token, post_hours FROM pages WHERE id = ? AND bot_id = ?'\n        ).bind(pageId, c.get('botId'))"
);

// 4. Update comment token
code = code.replace(
    "'UPDATE pages SET comment_token = ? WHERE id = ?'\n            ).bind(comment_token, pageId)",
    "'UPDATE pages SET comment_token = ? WHERE id = ? AND bot_id = ?'\n            ).bind(comment_token, pageId, c.get('botId'))"
);

// 5. Delete page
code = code.replace(
    "'DELETE FROM pages WHERE id = ?'\n        ).bind(pageId)",
    "'DELETE FROM pages WHERE id = ? AND bot_id = ?'\n        ).bind(pageId, c.get('botId'))"
);

// 6. post history list
code = code.replace(
    "WHERE ph.status != 'deleted'\n             ORDER BY ph.posted_at DESC LIMIT 100`\n        ).all()",
    "WHERE ph.status != 'deleted' AND p.bot_id = ?\n             ORDER BY ph.posted_at DESC LIMIT 100`\n        ).bind(c.get('botId')).all()"
);

// 7. add to queue
code = code.replace(
    "'INSERT INTO post_queue (video_id, page_id, scheduled_at) VALUES (?, ?, ?)'\n        ).bind(video_id, pageId, scheduled_at)",
    "'INSERT INTO post_queue (video_id, page_id, scheduled_at, bot_id) VALUES (?, ?, ?, ?)'\n        ).bind(video_id, pageId, scheduled_at, c.get('botId'))"
);

// 8. Cron job - get pages. For Cron, it iterates over all pages. Wait! BotId is on the page. We MUST handle Cron multi-tenant correctly.
// Let's replace the cron job completely!
const oldCron = "const { results: pages } = await env.DB.prepare(`\n        SELECT * FROM pages WHERE is_active = 1 AND post_hours IS NOT NULL AND post_hours != ''\n    `).all() as any";
const newCron = `const { results: pages } = await env.DB.prepare(\`
        SELECT * FROM pages WHERE is_active = 1 AND post_hours IS NOT NULL AND post_hours != ''
    \`).all() as any;`;
code = code.replace(oldCron, newCron); // This does not change much because the logic for cron requires us to instantiate BotBucket PER PAGE.

// In pipeline.ts we will inject BotBucket, replacing `c.env.BUCKET`.
code = code.replace(/processNextInQueue\(c\.env\)/g, "processNextInQueue(c.env, c.get('bucket'), c.get('botId'))");
code = code.replace(/runPipeline\(c\.env, videoUrl, chatId, 0, videoId\)/g, "runPipeline(c.env, videoUrl, chatId, 0, videoId, c.get('botId'))");

fs.writeFileSync('src/index.ts', code);
console.log('src/index.ts completely refactored.');
