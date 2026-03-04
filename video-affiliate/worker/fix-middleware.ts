import fs from 'fs';

let content = fs.readFileSync('src/index.ts', 'utf8');

// Fix middleware
const toReplace = `app.use('*', async (c, next) => {
    let token = c.req.header('x-auth-token') || '';
    if (!token && c.req.path.startsWith('/api/telegram/')) {
        const parts = c.req.path.split('/');
        if (parts.length >= 4) token = parts[3];
    }
    const botId = getBotId(token);
    c.set('botId', botId);
    c.set('bucket', new BotBucket(c.get('bucket'), botId) as unknown as R2Bucket);
    await next();
})`;

// The issue is `c.get('bucket')` inside middleware before it's set. It should be `c.env.BUCKET`.
const replacement = `app.use('*', async (c, next) => {
    let token = c.req.header('x-auth-token') || '';
    if (!token && c.req.path.startsWith('/api/telegram/')) {
        const parts = c.req.path.split('/');
        if (parts.length >= 4) token = parts[3];
    }
    const botId = getBotId(token);
    c.set('botId', botId);
    c.set('bucket', new BotBucket(c.env.BUCKET, botId) as unknown as R2Bucket);
    await next();
})`;

content = content.replace(toReplace, replacement);

fs.writeFileSync('src/index.ts', content);
