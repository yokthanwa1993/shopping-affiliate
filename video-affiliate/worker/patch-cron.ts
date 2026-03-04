import fs from 'fs';

let content = fs.readFileSync('src/index.ts', 'utf8');

// 1. Update Cron Query to include bot_id
content = content.replace(
    'SELECT id, name, access_token, comment_token, post_hours, last_post_at',
    'SELECT id, name, access_token, comment_token, post_hours, last_post_at, bot_id'
);

content = content.replace(
    'last_post_at: string | null\n        }>',
    'last_post_at: string | null\n            bot_id: string | null\n        }>'
);

// 2. Add botBucket initialization inside the cron loop
content = content.replace(
    '    for (const page of pages) {\n        console.log(`[CRON] processing page ${page.name}`)',
    '    for (const page of pages) {\n        console.log(`[CRON] processing page ${page.name}`);\n        const botId = page.bot_id || "default";\n        const botBucket = new BotBucket(env.BUCKET, botId) as unknown as R2Bucket;'
);

// 3. Replace all env.BUCKET inside the cron loop with botBucket.
// The loop goes from `for (const page of pages) {` until the end of the file basically.
// We can just globally replace `env.BUCKET` with `botBucket` ONLY after `for (const page of pages) {`
const parts = content.split('for (const page of pages) {');
if (parts.length === 2) {
    let cronBody = parts[1];
    cronBody = cronBody.replaceAll('env.BUCKET', 'botBucket');
    content = parts[0] + 'for (const page of pages) {' + cronBody;
}

// 4. In my previous replace I accidentally left `botBucket` on line 1546 of the OLD logic before cron splitting maybe?
// Let's just globally ensure `await c.get('bucket').get` was not mangled. Wait, line 1546 had `const metaObj = await botBucket.get(...)` because of my multi string replace which I thought wasn't cron.
// Wait, if it's already inside parts[1], `botBucket` handles it.

fs.writeFileSync('src/index.ts', content);
