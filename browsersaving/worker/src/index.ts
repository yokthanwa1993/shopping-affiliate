import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import pako from 'pako';

type Bindings = {
    DB: D1Database;
    BUCKET: R2Bucket;
    ENVIRONMENT: string;
    TOKEN_FACEBOOK_LITE_SERVICE?: Fetcher;
    VIDEO_AFFILIATE_TAG_SYNC_URL?: string;
    VIDEO_AFFILIATE_EMAIL_RESOLVE_URL?: string;
    VIDEO_AFFILIATE_NAMESPACE_ID?: string;
    VIDEO_AFFILIATE_TAG_SYNC_SECRET?: string;
    VIDEO_AFFILIATE_SERVICE?: Fetcher;
    // R2 S3 API credentials (for presigned URLs)
    R2_ACCOUNT_ID: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
};

interface Profile {
    id: string;
    owner_email: string | null;
    name: string;
    proxy: string;
    homepage: string;
    notes: string;
    tags: string;
    avatar_url: string | null;
    totp_secret: string | null;
    uid: string | null;
    username: string | null;
    password: string | null;
    datr: string | null;
    postcron_token: string | null;
    comment_token: string | null;
    facebook_token: string | null;
    shopee_cookies: string | null;
    page_name: string | null;
    page_avatar_url: string | null;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
}

type AppVariables = {
    authEmail: string;
    authToken: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();
const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const AUTH_PASSWORD_MIN_LENGTH = 6;
const AUTH_TOKEN_PREFIX = 'sess_bs_';
const DEFAULT_VIDEO_AFFILIATE_EMAIL_RESOLVE_URL = 'https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev/api/auth/resolve-email';

function normalizeToken(raw: unknown): string {
    return String(raw || '').trim();
}

function isCommentRoleToken(token: string): boolean {
    const t = normalizeToken(token);
    return !!t;
}

function isPostRoleToken(token: string): boolean {
    const t = normalizeToken(token);
    return !!t;
}

function validateRoleTokenInput(raw: unknown, mode: 'post' | 'comment', fieldName: string): { ok: true; token: string | null } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, token: null };
    const token = normalizeToken(raw);
    if (!token) return { ok: true, token: null };

    if (mode === 'comment') {
        if (!isCommentRoleToken(token)) {
            return { ok: false, error: `${fieldName} must not be empty` };
        }
        return { ok: true, token };
    }

    if (!isPostRoleToken(token)) {
        return { ok: false, error: `${fieldName} must not be empty` };
    }
    return { ok: true, token };
}

function parsePageIdFromAvatarUrl(raw: string): string {
    const input = String(raw || '').trim();
    if (!input) return '';

    const pageAvatarMatch = input.match(/\/page-avatars\/(\d+)(?:[./?]|$)/i);
    if (pageAvatarMatch?.[1]) return String(pageAvatarMatch[1]).trim();

    const graphMatch = input.match(/graph\.facebook\.com\/(\d+)\/picture/i);
    if (graphMatch?.[1]) return String(graphMatch[1]).trim();

    return '';
}

function normalizePageName(raw: unknown): string {
    return String(raw || '').trim().toLowerCase();
}

function normalizeTagList(raw: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: unknown) => {
        const tag = String(value || '').trim().toLowerCase();
        if (!tag || seen.has(tag)) return;
        seen.add(tag);
        out.push(tag);
    };

    if (Array.isArray(raw)) {
        for (const item of raw) push(item);
    } else if (typeof raw === 'string') {
        const text = raw.trim();
        if (text.startsWith('[') && text.endsWith(']')) {
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                    for (const item of parsed) push(item);
                }
            } catch {
                // fallthrough
            }
        }
        if (out.length === 0 && text) {
            for (const item of text.split(',')) push(item);
        }
    }

    return out.sort();
}

function sameTagList(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const DEFAULT_VIDEO_AFFILIATE_TAG_SYNC_URL = 'https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev/api/pages/tag-sync';

function hasVideoAffiliateRoleTag(tags: string[]): boolean {
    const normalized = normalizeTagList(tags || []);
    return normalized.includes('post') || normalized.includes('comment');
}

function getRoleTagState(rawTags: unknown): {
    tags: string[];
    hasPost: boolean;
    hasComment: boolean;
    hasConflict: boolean;
} {
    const tags = normalizeTagList(rawTags);
    const hasPost = tags.includes('post');
    const hasComment = tags.includes('comment');
    return {
        tags,
        hasPost,
        hasComment,
        hasConflict: hasPost && hasComment,
    };
}

function enforceRoleTokenByTags(
    tags: string[],
    postToken: string | null,
    commentToken: string | null,
): { postToken: string | null; commentToken: string | null } {
    const roleState = getRoleTagState(tags);
    if (roleState.hasPost && !roleState.hasComment) {
        return { postToken, commentToken: null };
    }
    if (roleState.hasComment && !roleState.hasPost) {
        return { postToken: null, commentToken };
    }
    return { postToken, commentToken };
}

async function triggerVideoAffiliateTagSync(
    c: any,
    options: { forceFullSync?: boolean; email?: string } = {},
) {
    const endpoint = String(c.env.VIDEO_AFFILIATE_TAG_SYNC_URL || DEFAULT_VIDEO_AFFILIATE_TAG_SYNC_URL).trim();
    if (!endpoint) return { ok: false as const, skipped: 'missing_endpoint' };

    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
    const secret = String(c.env.VIDEO_AFFILIATE_TAG_SYNC_SECRET || '').trim();
    if (secret) headers['x-tag-sync-secret'] = secret;

    const payload: Record<string, unknown> = {};
    const email = normalizeEmail(options.email || '');
    if (email) {
        payload.email = email;
    } else {
        const namespaceId = String(c.env.VIDEO_AFFILIATE_NAMESPACE_ID || '').trim();
        if (namespaceId) payload.namespace_id = namespaceId;
    }
    if (options.forceFullSync === true) payload.force_full_sync = true;

    const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({} as any));
    if (!resp.ok) {
        const details = String(data?.error || data?.details || `HTTP ${resp.status}`);
        throw new Error(`video_affiliate_tag_sync_failed: ${details}`);
    }
    return { ok: true as const, data };
}

type FacebookAccountItem = {
    id?: string;
    name?: string;
    access_token?: string;
    picture?: { data?: { url?: string } };
};

function pickTargetFacebookPage(accounts: FacebookAccountItem[], profile: Partial<Profile>): FacebookAccountItem | null {
    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    const pageIdHint = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''));
    if (pageIdHint) {
        const byId = accounts.find((acc) => String(acc?.id || '').trim() === pageIdHint);
        if (byId) return byId;
    }

    const pageNameHint = normalizePageName(profile.page_name || profile.name || '');
    if (pageNameHint) {
        const byName = accounts.find((acc) => normalizePageName(acc?.name || '') === pageNameHint);
        if (byName) return byName;
    }

    if (accounts.length === 1) return accounts[0];
    return null;
}

async function resolveProfilePageToken(userToken: string, profile: Partial<Profile>) {
    const token = normalizeToken(userToken);
    if (!token) throw new Error('user_token_empty');

    const url = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,picture.type(large)&limit=200&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => ({} as any));
    if (!response.ok) {
        const message = String(data?.error?.message || data?.error || `HTTP ${response.status}`);
        throw new Error(`facebook_me_accounts_failed: ${message}`);
    }

    const accounts = Array.isArray(data?.data) ? (data.data as FacebookAccountItem[]) : [];
    if (accounts.length === 0) throw new Error('facebook_me_accounts_empty');

    const matched = pickTargetFacebookPage(accounts, profile);
    if (!matched) {
        throw new Error('facebook_me_accounts_ambiguous_profile_page_not_matched');
    }

    const pageToken = normalizeToken(matched?.access_token);
    if (!isPostRoleToken(pageToken)) {
        throw new Error('page_token_invalid_prefix');
    }

    const pageId = String(matched?.id || '').trim();
    const pageName = String(matched?.name || '').trim();
    const pageAvatarUrl = String(matched?.picture?.data?.url || '').trim();

    return { pageToken, pageId, pageName, pageAvatarUrl };
}

// CORS
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
}));

function normalizeEmail(raw: unknown): string {
    return String(raw || '').trim().toLowerCase();
}

function isValidEmail(raw: string): boolean {
    const email = normalizeEmail(raw);
    return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function extractAuthToken(c: any): string {
    const explicit = String(c.req.header('x-auth-token') || '').trim();
    if (explicit) return explicit;
    const authorization = String(c.req.header('authorization') || '').trim();
    const matched = authorization.match(/^Bearer\s+(.+)$/i);
    return matched?.[1] ? String(matched[1]).trim() : '';
}

function getAuthEmail(c: any): string {
    return normalizeEmail(c.get('authEmail') || '');
}

function randomHex(bytes = 16): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function createAuthSessionToken(): string {
    return `${AUTH_TOKEN_PREFIX}${randomHex(24)}`;
}

function buildSessionExpiryIso(seconds = AUTH_SESSION_TTL_SECONDS): string {
    return new Date(Date.now() + Math.max(60, seconds) * 1000).toISOString();
}

async function sha256Hex(raw: string): Promise<string> {
    const data = new TextEncoder().encode(String(raw || ''));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
    return sha256Hex(`${salt}:${String(password || '')}`);
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
    const actual = await hashPassword(password, salt);
    return actual === String(expectedHash || '').trim();
}

async function maybeClaimUnownedProfiles(db: D1Database, email: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const owned = await db.prepare(
        "SELECT COUNT(*) AS total FROM profiles WHERE lower(trim(coalesce(owner_email, ''))) = ?"
    ).bind(normalizedEmail).first<{ total?: number }>();
    if (Number(owned?.total || 0) > 0) return;

    const assigned = await db.prepare(
        "SELECT COUNT(*) AS total FROM profiles WHERE owner_email IS NOT NULL AND trim(owner_email) <> ''"
    ).first<{ total?: number }>();
    if (Number(assigned?.total || 0) > 0) return;

    await db.prepare(
        "UPDATE profiles SET owner_email = ?, updated_at = datetime('now') WHERE owner_email IS NULL OR trim(owner_email) = ''"
    ).bind(normalizedEmail).run();
}

async function ensureProfileAccess(c: any, profileId: string, options: { includeDeleted?: boolean } = {}): Promise<boolean> {
    const authEmail = getAuthEmail(c);
    if (!authEmail) return true;

    const includeDeleted = options.includeDeleted === true;
    const sql = includeDeleted
        ? 'SELECT id FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, \'\'))) = ?'
        : 'SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL AND lower(trim(coalesce(owner_email, \'\'))) = ?';
    const row = await c.env.DB.prepare(sql).bind(profileId, authEmail).first<{ id?: string }>();
    return !!row?.id;
}

async function resolveVideoAffiliateWorkspaceByEmail(c: any, email: string): Promise<{
    namespaceId: string;
    namespaces: string[];
    isOwner: boolean;
    isTeamMember: boolean;
}> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) throw new Error('invalid_email');

    const endpoint = String(c.env.VIDEO_AFFILIATE_EMAIL_RESOLVE_URL || DEFAULT_VIDEO_AFFILIATE_EMAIL_RESOLVE_URL).trim();
    if (!endpoint) throw new Error('video_affiliate_resolve_endpoint_missing');

    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
    const secret = String(c.env.VIDEO_AFFILIATE_TAG_SYNC_SECRET || '').trim();
    if (secret) headers['x-tag-sync-secret'] = secret;

    let response: Response;
    if (c.env.VIDEO_AFFILIATE_SERVICE && typeof c.env.VIDEO_AFFILIATE_SERVICE.fetch === 'function') {
        response = await c.env.VIDEO_AFFILIATE_SERVICE.fetch('https://video-affiliate-worker/api/auth/resolve-email', {
            method: 'POST',
            headers,
            body: JSON.stringify({ email: normalizedEmail }),
        });
    } else {
        response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ email: normalizedEmail }),
        });
    }
    const data = await response.json().catch(() => ({} as any));
    if (!response.ok || !data?.success) {
        const detail = String(data?.error || data?.details || `HTTP ${response.status}`).trim();
        throw new Error(`video_affiliate_email_resolve_failed:${detail}`);
    }

    const namespaces = Array.isArray(data?.namespaces)
        ? data.namespaces.map((item: unknown) => String(item || '').trim()).filter(Boolean)
        : [];
    const namespaceId = String(data?.namespace_id || namespaces[0] || '').trim();
    if (!namespaceId) {
        throw new Error('video_affiliate_namespace_not_found');
    }

    return {
        namespaceId,
        namespaces,
        isOwner: !!data?.is_owner,
        isTeamMember: !!data?.is_team_member,
    };
}

app.use('/api/*', async (c, next) => {
    c.set('authEmail', '');
    c.set('authToken', '');

    const token = extractAuthToken(c);
    if (!token) {
        await next();
        return;
    }

    try {
        const session = await c.env.DB.prepare(
            `SELECT u.email AS email
             FROM bs_sessions s
             INNER JOIN bs_users u ON u.email = s.user_email
             WHERE s.token = ?
               AND datetime(s.expires_at) > datetime('now')
             LIMIT 1`
        ).bind(token).first<{ email?: string }>();

        const email = normalizeEmail(session?.email || '');
        if (email) {
            c.set('authEmail', email);
            c.set('authToken', token);
            await c.env.DB.prepare(
                "UPDATE bs_sessions SET updated_at = datetime('now') WHERE token = ?"
            ).bind(token).run();
        }
    } catch (err) {
        console.log(`auth middleware lookup failed: ${String(err)}`);
    }

    await next();
});

// Health check
app.get('/health', async (c) => {
    try {
        await c.env.DB.prepare('SELECT 1').first();
        return c.json({ status: 'ok', database: 'connected', storage: 'r2' });
    } catch (e) {
        return c.json({ status: 'error', database: 'disconnected', error: String(e) }, 500);
    }
});

// === AUTH APIs ===

app.post('/api/auth/login', async (c) => {
    let body: any = {};
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }

    const email = normalizeEmail(body.email || '');
    const password = String(body.password || '');

    if (!isValidEmail(email)) {
        return c.json({ error: 'Invalid email' }, 400);
    }
    if (!password || password.length < AUTH_PASSWORD_MIN_LENGTH) {
        return c.json({ error: `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters` }, 400);
    }

    const db = c.env.DB;
    let accountCreated = false;

    let workspace: {
        namespaceId: string;
        namespaces: string[];
        isOwner: boolean;
        isTeamMember: boolean;
    };
    try {
        workspace = await resolveVideoAffiliateWorkspaceByEmail(c, email);
    } catch (err) {
        const message = String(err || '');
        const details = message.replace(/^video_affiliate_email_resolve_failed:/, '').trim();
        return c.json({
            error: 'Email not found in video-affiliate workspace',
            details: details || message || 'email_resolve_failed',
        }, 403);
    }

    let user = await db.prepare(
        'SELECT email, password_hash, password_salt FROM bs_users WHERE email = ? LIMIT 1'
    ).bind(email).first<{ email?: string; password_hash?: string; password_salt?: string }>();

    if (!user) {
        const salt = randomHex(16);
        const hash = await hashPassword(password, salt);
        await db.prepare(
            "INSERT INTO bs_users (email, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
        ).bind(email, hash, salt).run();
        accountCreated = true;

        user = await db.prepare(
            'SELECT email, password_hash, password_salt FROM bs_users WHERE email = ? LIMIT 1'
        ).bind(email).first<{ email?: string; password_hash?: string; password_salt?: string }>();
    }

    const valid = user?.password_hash && user?.password_salt
        ? await verifyPassword(password, user.password_salt, user.password_hash)
        : false;
    if (!valid) {
        return c.json({ error: 'Invalid email or password' }, 401);
    }

    const sessionToken = createAuthSessionToken();
    const expiresAt = buildSessionExpiryIso();
    await db.prepare("DELETE FROM bs_sessions WHERE user_email = ?").bind(email).run();
    await db.prepare(
        "INSERT INTO bs_sessions (token, user_email, expires_at, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    ).bind(sessionToken, email, expiresAt).run();

    await maybeClaimUnownedProfiles(db, email);

    return c.json({
        success: true,
        session_token: sessionToken,
        email,
        expires_at: expiresAt,
        account_created: accountCreated,
        namespace_id: workspace.namespaceId,
        namespaces: workspace.namespaces,
        is_owner: workspace.isOwner,
        is_team_member: workspace.isTeamMember,
    });
});

app.post('/api/auth/logout', async (c) => {
    const token = extractAuthToken(c);
    if (!token) return c.json({ ok: true });
    await c.env.DB.prepare('DELETE FROM bs_sessions WHERE token = ?').bind(token).run();
    return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
    const email = getAuthEmail(c);
    const token = String(c.get('authToken') || '').trim();
    if (!email || !token) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const session = await c.env.DB.prepare(
        'SELECT expires_at FROM bs_sessions WHERE token = ? LIMIT 1'
    ).bind(token).first<{ expires_at?: string }>();

    return c.json({
        email,
        expires_at: session?.expires_at || null,
    });
});

// === PROFILE APIs ===

// Helper: create backup snapshot before destructive operations
async function createBackup(db: D1Database, profileId: string, action: 'update' | 'delete', ownerEmail = '') {
    const authEmail = normalizeEmail(ownerEmail);
    const profile = authEmail
        ? await db.prepare(
            'SELECT * FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, \'\'))) = ?'
        ).bind(profileId, authEmail).first()
        : await db.prepare('SELECT * FROM profiles WHERE id = ?').bind(profileId).first();
    if (profile) {
        await db.prepare(
            'INSERT INTO profile_backups (profile_id, action, snapshot) VALUES (?, ?, ?)'
        ).bind(profileId, action, JSON.stringify(profile)).run();
    }
    return profile;
}

// GET /api/profiles - List all profiles (excludes soft-deleted)
app.get('/api/profiles', async (c) => {
    const includeDeleted = c.req.query('include_deleted') === 'true';
    const authEmail = getAuthEmail(c);
    const whereParts: string[] = [];
    const binds: unknown[] = [];
    if (!includeDeleted) whereParts.push('deleted_at IS NULL');
    if (authEmail) {
        whereParts.push("lower(trim(coalesce(owner_email, ''))) = ?");
        binds.push(authEmail);
    }
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const query = `SELECT * FROM profiles ${whereSql} ORDER BY created_at DESC`;

    const { results } = await c.env.DB.prepare(query).bind(...binds).all<Profile>();

    // Parse tags JSON string to array
    const profiles = results.map(p => ({
        ...p,
        tags: JSON.parse(p.tags || '[]')
    }));

    return c.json(profiles);
});

// POST /api/profiles - Create profile
app.post('/api/profiles', async (c) => {
    const body = await c.req.json();
    const authEmail = getAuthEmail(c);
    const postTokenValidation = validateRoleTokenInput(body.postcron_token, 'post', 'postcron_token');
    if (!postTokenValidation.ok) return c.json({ error: postTokenValidation.error }, 400);

    const commentTokenValidation = validateRoleTokenInput(body.comment_token, 'comment', 'comment_token');
    if (!commentTokenValidation.ok) return c.json({ error: commentTokenValidation.error }, 400);

    let postcronToken = postTokenValidation.token;
    let commentToken = commentTokenValidation.token;
    const legacyToken = body.facebook_token !== undefined ? (normalizeToken(body.facebook_token) || null) : null;
    const nextTags = normalizeTagList(body.tags || []);
    const roleState = getRoleTagState(nextTags);
    if (roleState.hasConflict) {
        return c.json({ error: 'Profile tag cannot contain both post and comment at the same time' }, 400);
    }
    const normalizedTokens = enforceRoleTokenByTags(nextTags, postcronToken, commentToken);
    postcronToken = normalizedTokens.postToken;
    commentToken = normalizedTokens.commentToken;

    const { results } = await c.env.DB.prepare(`
    INSERT INTO profiles (owner_email, name, proxy, homepage, notes, tags, totp_secret, uid, username, password, datr, postcron_token, comment_token, facebook_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
        authEmail || null,
        body.name || 'New Profile',
        body.proxy || '',
        body.homepage || '',
        body.notes || '',
        JSON.stringify(nextTags),
        body.totp_secret || null,
        body.uid || null,
        body.username || null,
        body.password || null,
        body.datr || null,
        postcronToken,
        commentToken,
        legacyToken
    ).all<Profile>();

    const profile = results[0];
    let tagSync: any = null;
    if (nextTags.length > 0) {
        try {
            tagSync = await triggerVideoAffiliateTagSync(c, {
                forceFullSync: hasVideoAffiliateRoleTag(nextTags),
                email: authEmail || undefined,
            });
        } catch (syncErr: any) {
            const message = syncErr?.message || String(syncErr);
            console.log(`tag-sync failed for new profile ${profile?.id || 'unknown'}: ${message}`);
            tagSync = { ok: false, error: message };
        }
    }
    return c.json({
        ...profile,
        tags: JSON.parse(profile.tags || '[]'),
        tag_sync: tagSync,
    });
});

// POST /api/import - Import profile with specific ID (for migration)
app.post('/api/import', async (c) => {
    const body = await c.req.json();
    const authEmail = getAuthEmail(c);
    const postTokenValidation = validateRoleTokenInput(body.postcron_token, 'post', 'postcron_token');
    if (!postTokenValidation.ok) return c.json({ error: postTokenValidation.error }, 400);

    const commentTokenValidation = validateRoleTokenInput(body.comment_token, 'comment', 'comment_token');
    if (!commentTokenValidation.ok) return c.json({ error: commentTokenValidation.error }, 400);

    let postcronToken = postTokenValidation.token;
    let commentToken = commentTokenValidation.token;
    const legacyToken = body.facebook_token !== undefined ? (normalizeToken(body.facebook_token) || null) : null;
    const nextTags = normalizeTagList(body.tags || []);
    const roleState = getRoleTagState(nextTags);
    if (roleState.hasConflict) {
        return c.json({ error: 'Profile tag cannot contain both post and comment at the same time' }, 400);
    }
    const normalizedTokens = enforceRoleTokenByTags(nextTags, postcronToken, commentToken);
    postcronToken = normalizedTokens.postToken;
    commentToken = normalizedTokens.commentToken;

    if (!body.id) {
        return c.json({ error: 'id is required' }, 400);
    }

    // Check if profile already exists
    const existing = await c.env.DB.prepare(
        'SELECT id FROM profiles WHERE id = ?'
    ).bind(body.id).first();

    if (existing) {
        return c.json({ error: 'Profile already exists', id: body.id }, 409);
    }

    const { results } = await c.env.DB.prepare(`
    INSERT INTO profiles (id, owner_email, name, proxy, homepage, notes, tags, avatar_url, totp_secret, uid, username, password, datr, postcron_token, comment_token, facebook_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
        body.id,
        authEmail || normalizeEmail(body.owner_email || '') || null,
        body.name || 'New Profile',
        body.proxy || '',
        body.homepage || '',
        body.notes || '',
        JSON.stringify(nextTags),
        body.avatar_url || null,
        body.totp_secret || null,
        body.uid || null,
        body.username || null,
        body.password || null,
        body.datr || null,
        postcronToken,
        commentToken,
        legacyToken,
        body.created_at || new Date().toISOString(),
        body.updated_at || new Date().toISOString()
    ).all<Profile>();

    const profile = results[0];
    return c.json({
        ...profile,
        tags: JSON.parse(profile.tags || '[]')
    });
});

// PUT /api/profiles/:id - Update profile (with backup)
app.put('/api/profiles/:id', async (c) => {
    try {
        const id = c.req.param('id');
        const body = await c.req.json();
        const authEmail = getAuthEmail(c);

        const postTokenValidation = validateRoleTokenInput(body.postcron_token, 'post', 'postcron_token');
        if (!postTokenValidation.ok) return c.json({ error: postTokenValidation.error }, 400);

        const commentTokenValidation = validateRoleTokenInput(body.comment_token, 'comment', 'comment_token');
        if (!commentTokenValidation.ok) return c.json({ error: commentTokenValidation.error }, 400);

        // Get existing profile
        const existing = authEmail
            ? await c.env.DB.prepare(
                "SELECT * FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            ).bind(id, authEmail).first<Profile>()
            : await c.env.DB.prepare(
                'SELECT * FROM profiles WHERE id = ?'
            ).bind(id).first<Profile>();

        if (!existing) {
            return c.json({ error: 'Not found' }, 404);
        }

        const existingTags = normalizeTagList(existing.tags || '[]');
        const requestedTags = body.tags !== undefined ? body.tags : JSON.parse(existing.tags || '[]');
        const nextTags = normalizeTagList(requestedTags);
        const roleState = getRoleTagState(nextTags);
        if (roleState.hasConflict) {
            return c.json({ error: 'Profile tag cannot contain both post and comment at the same time' }, 400);
        }
        const tagsChanged = !sameTagList(existingTags, nextTags);

        const requestedPostToken = body.postcron_token !== undefined ? postTokenValidation.token : (existing.postcron_token ?? null);
        const requestedCommentToken = body.comment_token !== undefined ? commentTokenValidation.token : (existing.comment_token ?? null);
        const normalizedTokens = enforceRoleTokenByTags(nextTags, requestedPostToken, requestedCommentToken);
        const nextPostToken = normalizedTokens.postToken;
        const nextCommentToken = normalizedTokens.commentToken;

        // 🔒 Create backup snapshot before update
        await createBackup(c.env.DB, id, 'update', authEmail);

        const updateSql = authEmail
            ? `
        UPDATE profiles SET
          name = ?,
          proxy = ?,
          homepage = ?,
          notes = ?,
          tags = ?,
          avatar_url = ?,
          totp_secret = ?,
          uid = ?,
          username = ?,
          password = ?,
          datr = ?,
          postcron_token = ?,
          comment_token = ?,
          facebook_token = ?,
          shopee_cookies = ?,
          page_name = ?,
          page_avatar_url = ?,
          updated_at = datetime('now')
        WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?
        RETURNING *
      `
            : `
        UPDATE profiles SET
          name = ?,
          proxy = ?,
          homepage = ?,
          notes = ?,
          tags = ?,
          avatar_url = ?,
          totp_secret = ?,
          uid = ?,
          username = ?,
          password = ?,
          datr = ?,
          postcron_token = ?,
          comment_token = ?,
          facebook_token = ?,
          shopee_cookies = ?,
          page_name = ?,
          page_avatar_url = ?,
          updated_at = datetime('now')
        WHERE id = ?
        RETURNING *
      `;
        const updateBinds = authEmail
            ? [
                body.name ?? existing.name ?? null,
                body.proxy ?? existing.proxy ?? null,
                body.homepage ?? existing.homepage ?? null,
                body.notes ?? existing.notes ?? null,
                JSON.stringify(nextTags),
                body.avatar_url ?? existing.avatar_url ?? null,
                body.totp_secret ?? existing.totp_secret ?? null,
                body.uid ?? existing.uid ?? null,
                body.username ?? existing.username ?? null,
                body.password ?? existing.password ?? null,
                body.datr ?? existing.datr ?? null,
                nextPostToken,
                nextCommentToken,
                body.facebook_token !== undefined ? (normalizeToken(body.facebook_token) || null) : (existing.facebook_token ?? null),
                body.shopee_cookies !== undefined
                    ? (body.shopee_cookies ? JSON.stringify(body.shopee_cookies) : null)
                    : (existing.shopee_cookies ?? null),
                body.page_name ?? existing.page_name ?? null,
                body.page_avatar_url ?? existing.page_avatar_url ?? null,
                id,
                authEmail,
            ]
            : [
            body.name ?? existing.name ?? null,
            body.proxy ?? existing.proxy ?? null,
            body.homepage ?? existing.homepage ?? null,
            body.notes ?? existing.notes ?? null,
            JSON.stringify(nextTags),
            body.avatar_url ?? existing.avatar_url ?? null,
            body.totp_secret ?? existing.totp_secret ?? null,
            body.uid ?? existing.uid ?? null,
            body.username ?? existing.username ?? null,
            body.password ?? existing.password ?? null,
            body.datr ?? existing.datr ?? null,
            nextPostToken,
            nextCommentToken,
            body.facebook_token !== undefined ? (normalizeToken(body.facebook_token) || null) : (existing.facebook_token ?? null),
            body.shopee_cookies !== undefined 
                ? (body.shopee_cookies ? JSON.stringify(body.shopee_cookies) : null)
                : (existing.shopee_cookies ?? null),
            body.page_name ?? existing.page_name ?? null,
            body.page_avatar_url ?? existing.page_avatar_url ?? null,
            id
        ];
        const { results } = await c.env.DB.prepare(updateSql).bind(...updateBinds).all<Profile>();

        const profile = results[0];
        let tagSync: any = null;
        if (tagsChanged) {
            try {
                tagSync = await triggerVideoAffiliateTagSync(c, {
                    forceFullSync: hasVideoAffiliateRoleTag(nextTags),
                    email: authEmail || undefined,
                });
            } catch (syncErr: any) {
                const message = syncErr?.message || String(syncErr);
                console.log(`tag-sync failed for profile ${id}: ${message}`);
                tagSync = { ok: false, error: message };
            }
        }
        return c.json({
            ...profile,
            tags: JSON.parse(profile.tags || '[]'),
            tag_sync: tagSync,
        });
    } catch (err: any) {
        console.error('PUT /api/profiles/:id error:', err);
        return c.json({ error: 'Database error', details: err?.message || String(err) }, 500);
    }
});

// PUT /api/profiles/:id/shopee-cookies - Update Shopee cookies only
app.put('/api/profiles/:id/shopee-cookies', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const authEmail = getAuthEmail(c);

    const existing = authEmail
        ? await c.env.DB.prepare(
            "SELECT * FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, authEmail).first<Profile>()
        : await c.env.DB.prepare(
            'SELECT * FROM profiles WHERE id = ?'
        ).bind(id).first<Profile>();
    
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }
    
    // Update only shopee_cookies field
    const { results } = await c.env.DB.prepare(`
        UPDATE profiles SET
          shopee_cookies = ?,
          updated_at = datetime('now')
        WHERE id = ?
        RETURNING *
    `).bind(
        body.shopee_cookies ? JSON.stringify(body.shopee_cookies) : null,
        id
    ).all<Profile>();
    
    const profile = results[0];
    return c.json({
        success: true,
        profile: profile.name,
        shopee_cookies_updated: !!profile.shopee_cookies
    });
});

// GET /api/profiles/:id/shopee-cookies - Get Shopee cookies
app.get('/api/profiles/:id/shopee-cookies', async (c) => {
    const id = c.req.param('id');
    const authEmail = getAuthEmail(c);

    const profile = authEmail
        ? await c.env.DB.prepare(
            "SELECT id, name, shopee_cookies FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, authEmail).first<Profile>()
        : await c.env.DB.prepare(
            'SELECT id, name, shopee_cookies FROM profiles WHERE id = ?'
        ).bind(id).first<Profile>();
    
    if (!profile) {
        return c.json({ error: 'Not found' }, 404);
    }
    
    if (!profile.shopee_cookies) {
        return c.json({ error: 'No Shopee cookies found' }, 404);
    }
    
    try {
        const cookies = JSON.parse(profile.shopee_cookies);
        return c.json({
            profile: profile.name,
            cookies
        });
    } catch {
        return c.json({ error: 'Invalid cookies format' }, 500);
    }
});

// DELETE /api/profiles/:id - Soft delete (recoverable)
app.delete('/api/profiles/:id', async (c) => {
    const id = c.req.param('id');
    const hard = c.req.query('hard') === 'true';
    const authEmail = getAuthEmail(c);
    const existing = authEmail
        ? await c.env.DB.prepare(
            "SELECT tags FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, authEmail).first<{ tags?: string | null }>()
        : await c.env.DB.prepare('SELECT tags FROM profiles WHERE id = ?').bind(id).first<{ tags?: string | null }>();
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }
    const hadTags = normalizeTagList(existing?.tags || '[]').length > 0;

    // 🔒 Create backup snapshot before delete
    await createBackup(c.env.DB, id, 'delete', authEmail);

    if (hard) {
        // Hard delete - permanent, removes everything
        try {
            await c.env.BUCKET.delete(`browser-data/${id}.tar.gz`);
        } catch { }
        try {
            await c.env.BUCKET.delete(`android-data/${id}.tar.gz`);
        } catch { }

        const avatarList = await c.env.BUCKET.list({ prefix: `avatars/${id}` });
        for (const obj of avatarList.objects) {
            await c.env.BUCKET.delete(obj.key);
        }

        if (authEmail) {
            await c.env.DB.prepare(
                "DELETE FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            ).bind(id, authEmail).run();
        } else {
            await c.env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
        }
        console.log(`🗑️ Hard deleted profile: ${id}`);
    } else {
        // Soft delete - just mark as deleted
        if (authEmail) {
            await c.env.DB.prepare(
                "UPDATE profiles SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            ).bind(id, authEmail).run();
        } else {
            await c.env.DB.prepare(
                "UPDATE profiles SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
            ).bind(id).run();
        }
        console.log(`🏷️ Soft deleted profile: ${id}`);
    }

    let tagSync: any = null;
    if (hadTags) {
        try {
            tagSync = await triggerVideoAffiliateTagSync(c, { email: authEmail || undefined });
        } catch (syncErr: any) {
            const message = syncErr?.message || String(syncErr);
            console.log(`tag-sync failed after delete ${id}: ${message}`);
            tagSync = { ok: false, error: message };
        }
    }

    return c.json({ success: true, hard, tag_sync: tagSync });
});

// POST /api/profiles/:id/restore - Restore soft-deleted profile
app.post('/api/profiles/:id/restore', async (c) => {
    const id = c.req.param('id');
    const authEmail = getAuthEmail(c);

    const existing = authEmail
        ? await c.env.DB.prepare(
            "SELECT * FROM profiles WHERE id = ? AND deleted_at IS NOT NULL AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, authEmail).first<Profile>()
        : await c.env.DB.prepare(
            'SELECT * FROM profiles WHERE id = ? AND deleted_at IS NOT NULL'
        ).bind(id).first<Profile>();

    if (!existing) {
        return c.json({ error: 'Profile not found or not deleted' }, 404);
    }

    const { results } = authEmail
        ? await c.env.DB.prepare(
            "UPDATE profiles SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ? RETURNING *"
        ).bind(id, authEmail).all<Profile>()
        : await c.env.DB.prepare(
            "UPDATE profiles SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? RETURNING *"
        ).bind(id).all<Profile>();

    const profile = results[0];
    console.log(`♻️ Restored profile: ${profile.name}`);
    let tagSync: any = null;
    const restoredTags = normalizeTagList(profile?.tags || '[]');
    if (restoredTags.length > 0) {
        try {
            tagSync = await triggerVideoAffiliateTagSync(c, {
                forceFullSync: hasVideoAffiliateRoleTag(restoredTags),
                email: authEmail || undefined,
            });
        } catch (syncErr: any) {
            const message = syncErr?.message || String(syncErr);
            console.log(`tag-sync failed after restore ${id}: ${message}`);
            tagSync = { ok: false, error: message };
        }
    }
    return c.json({
        ...profile,
        tags: JSON.parse(profile.tags || '[]'),
        tag_sync: tagSync,
    });
});

// GET /api/profiles/:id/backups - List backup snapshots for a profile
app.get('/api/profiles/:id/backups', async (c) => {
    const id = c.req.param('id');
    const authEmail = getAuthEmail(c);

    if (authEmail) {
        const allowed = await ensureProfileAccess(c, id, { includeDeleted: true });
        if (!allowed) return c.json({ error: 'Not found' }, 404);
    }

    const { results } = await c.env.DB.prepare(
        'SELECT * FROM profile_backups WHERE profile_id = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(id).all();

    const backups = results.map((b: any) => ({
        ...b,
        snapshot: JSON.parse(b.snapshot)
    }));

    return c.json(backups);
});

// POST /api/profiles/:id/backups/:backupId/restore - Restore from a specific backup snapshot
app.post('/api/profiles/:id/backups/:backupId/restore', async (c) => {
    const id = c.req.param('id');
    const backupId = c.req.param('backupId');
    const authEmail = getAuthEmail(c);

    if (authEmail) {
        const allowed = await ensureProfileAccess(c, id, { includeDeleted: true });
        if (!allowed) return c.json({ error: 'Not found' }, 404);
    }

    const backup = await c.env.DB.prepare(
        'SELECT * FROM profile_backups WHERE backup_id = ? AND profile_id = ?'
    ).bind(backupId, id).first<any>();

    if (!backup) {
        return c.json({ error: 'Backup not found' }, 404);
    }

    const snapshot = JSON.parse(backup.snapshot);
    const snapshotPostValidation = validateRoleTokenInput(snapshot.postcron_token, 'post', 'snapshot.postcron_token');
    if (!snapshotPostValidation.ok) return c.json({ error: snapshotPostValidation.error }, 400);

    const snapshotCommentValidation = validateRoleTokenInput(snapshot.comment_token, 'comment', 'snapshot.comment_token');
    if (!snapshotCommentValidation.ok) return c.json({ error: snapshotCommentValidation.error }, 400);

    // Create a backup of current state before restoring
    await createBackup(c.env.DB, id, 'update', authEmail);

    const restoreSql = authEmail
        ? `
    UPDATE profiles SET
      name = ?, proxy = ?, homepage = ?, notes = ?, tags = ?,
      avatar_url = ?, totp_secret = ?, uid = ?, username = ?, password = ?,
      datr = ?, postcron_token = ?, comment_token = ?, facebook_token = ?, deleted_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?
    RETURNING *
  `
        : `
    UPDATE profiles SET
      name = ?, proxy = ?, homepage = ?, notes = ?, tags = ?,
      avatar_url = ?, totp_secret = ?, uid = ?, username = ?, password = ?,
      datr = ?, postcron_token = ?, comment_token = ?, facebook_token = ?, deleted_at = NULL, updated_at = datetime('now')
    WHERE id = ?
    RETURNING *
  `;
    const restoreBinds = authEmail
        ? [
            snapshot.name, snapshot.proxy, snapshot.homepage, snapshot.notes,
            snapshot.tags, snapshot.avatar_url, snapshot.totp_secret,
            snapshot.uid, snapshot.username, snapshot.password,
            snapshot.datr ?? null,
            snapshotPostValidation.token,
            snapshotCommentValidation.token,
            normalizeToken(snapshot.facebook_token) || null,
            id,
            authEmail,
        ]
        : [
            snapshot.name, snapshot.proxy, snapshot.homepage, snapshot.notes,
            snapshot.tags, snapshot.avatar_url, snapshot.totp_secret,
            snapshot.uid, snapshot.username, snapshot.password,
            snapshot.datr ?? null,
            snapshotPostValidation.token,
            snapshotCommentValidation.token,
            normalizeToken(snapshot.facebook_token) || null,
            id,
        ];
    const { results } = await c.env.DB.prepare(restoreSql).bind(...restoreBinds).all<Profile>();

    const profile = results[0];
    console.log(`♻️ Restored profile from backup #${backupId}: ${profile.name}`);
    return c.json({
        ...profile,
        tags: JSON.parse(profile.tags || '[]')
    });
});

// === AVATAR APIs ===

// POST /api/avatar/:id - Upload avatar
app.post('/api/avatar/:id', async (c) => {
    const id = c.req.param('id');
    const allowed = await ensureProfileAccess(c, id, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const formData = await c.req.formData();
    const file = formData.get('avatar') as File;

    if (!file) {
        return c.json({ error: 'No file' }, 400);
    }

    // Delete old avatars
    const oldAvatars = await c.env.BUCKET.list({ prefix: `avatars/${id}` });
    for (const obj of oldAvatars.objects) {
        await c.env.BUCKET.delete(obj.key);
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const timestamp = Date.now();
    const key = `avatars/${id}_${timestamp}.${ext}`;

    await c.env.BUCKET.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || 'image/png' }
    });

    const avatarUrl = `/storage/${key}`;

    // Update profile
    await c.env.DB.prepare(
        'UPDATE profiles SET avatar_url = ? WHERE id = ?'
    ).bind(avatarUrl, id).run();

    return c.json({ avatar: avatarUrl });
});

// === STORAGE APIs ===

// GET /storage/* - Serve files from R2
app.get('/storage/*', async (c) => {
    const key = c.req.path.replace('/storage/', '');
    const object = await c.env.BUCKET.get(key);

    if (!object) {
        return c.text('Not found', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);

    // Cache control - avatars and page avatars cache forever
    if (key.startsWith('avatars/') || key.startsWith('page-avatars/')) {
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
        headers.set('Cache-Control', 'public, max-age=31536000');
    }

    return new Response(object.body, { headers });
});

// === BROWSER DATA SYNC APIs ===

// POST /api/sync/:profileId/upload - Upload browser data to R2
app.post('/api/sync/:profileId/upload', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const buffer = await c.req.arrayBuffer();
    const key = `browser-data/${profileId}.tar.gz`;
    const bytes = new Uint8Array(buffer);

    if (bytes.byteLength < 1024) {
        return c.json({ error: 'Invalid browser archive: file too small' }, 400);
    }

    const cookies = await extractCookiesFromTarGz(bytes);
    if (!cookies || cookies.length === 0) {
        return c.json({ error: 'Invalid browser archive: cookies.json missing or unreadable' }, 400);
    }

    const datr = extractDatrFromCookies(cookies);
    if (datr) {
        await c.env.DB.prepare(
            "UPDATE profiles SET datr = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(datr, profileId).run();
    }

    await c.env.BUCKET.put(key, buffer, {
        httpMetadata: { contentType: 'application/gzip' }
    });

    console.log(`📥 Uploaded browser data: ${profileId} (${cookies.length} cookies, datr: ${datr ? 'saved' : 'not found'})`);
    return c.json({ success: true, cookies: cookies.length, datr_saved: !!datr });
});

// GET /api/sync/:profileId/download - Download browser data from R2
app.get('/api/sync/:profileId/download', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const key = `browser-data/${profileId}.tar.gz`;

    const object = await c.env.BUCKET.get(key);

    if (!object) {
        return c.text('No data', 404);
    }

    console.log(`📤 Downloaded browser data: ${profileId}`);
    return new Response(object.body, {
        headers: { 'Content-Type': 'application/gzip' }
    });
});

// === PRESIGNED URL APIs (Fast direct R2 access) ===

// Helper to create S3 client for R2
function getS3Client(c: any) {
    return new S3Client({
        region: 'auto',
        endpoint: `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: c.env.R2_ACCESS_KEY_ID,
            secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

// GET /api/presigned/:profileId/upload - Get presigned URL for upload
app.get('/api/presigned/:profileId/upload', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const key = `browser-data/${profileId}.tar.gz`;

    const s3 = getS3Client(c);
    const command = new PutObjectCommand({
        Bucket: 'browsersaving',
        Key: key,
        ContentType: 'application/gzip',
    });

    // URL valid for 10 minutes
    const url = await getSignedUrl(s3, command, { expiresIn: 600 });

    console.log(`🔗 Generated upload URL for: ${profileId}`);
    return c.json({ url, key });
});

// GET /api/presigned/:profileId/download - Get presigned URL for download
app.get('/api/presigned/:profileId/download', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const key = `browser-data/${profileId}.tar.gz`;

    // First check if file exists
    const exists = await c.env.BUCKET.head(key);
    if (!exists) {
        return c.json({ url: null, exists: false });
    }

    const s3 = getS3Client(c);
    const command = new GetObjectCommand({
        Bucket: 'browsersaving',
        Key: key,
    });

    // URL valid for 10 minutes
    const url = await getSignedUrl(s3, command, { expiresIn: 600 });

    console.log(`🔗 Generated download URL for: ${profileId}`);
    return c.json({ url, exists: true });
});

// === ANDROID DATA SYNC APIs ===

// POST /api/android-sync/:profileId/upload - Upload Android profile archive to R2
app.post('/api/android-sync/:profileId/upload', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const buffer = await c.req.arrayBuffer();
    const key = `android-data/${profileId}.tar.gz`;

    if (buffer.byteLength < 1024) {
        return c.json({ error: 'Invalid Android archive: file too small' }, 400);
    }

    await c.env.BUCKET.put(key, buffer, {
        httpMetadata: { contentType: 'application/gzip' }
    });

    console.log(`🤖 Uploaded Android data: ${profileId} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
    return c.json({ success: true, size: buffer.byteLength });
});

// GET /api/android-sync/:profileId/download - Download Android profile archive from R2
app.get('/api/android-sync/:profileId/download', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const key = `android-data/${profileId}.tar.gz`;

    const object = await c.env.BUCKET.get(key);
    if (!object) {
        return c.text('No data', 404);
    }

    console.log(`🤖 Downloaded Android data: ${profileId}`);
    return new Response(object.body, {
        headers: { 'Content-Type': 'application/gzip' }
    });
});

// GET /api/android-presigned/:profileId/upload - Get presigned URL for Android data upload
app.get('/api/android-presigned/:profileId/upload', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const key = `android-data/${profileId}.tar.gz`;

    const s3 = getS3Client(c);
    const command = new PutObjectCommand({
        Bucket: 'browsersaving',
        Key: key,
        ContentType: 'application/gzip',
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 600 });
    console.log(`🤖🔗 Generated Android upload URL for: ${profileId}`);
    return c.json({ url, key });
});

// GET /api/android-presigned/:profileId/download - Get presigned URL for Android data download
app.get('/api/android-presigned/:profileId/download', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);
    const key = `android-data/${profileId}.tar.gz`;

    const exists = await c.env.BUCKET.head(key);
    if (!exists) {
        return c.json({ url: null, exists: false });
    }

    const s3 = getS3Client(c);
    const command = new GetObjectCommand({
        Bucket: 'browsersaving',
        Key: key,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 600 });
    console.log(`🤖🔗 Generated Android download URL for: ${profileId}`);
    return c.json({ url, exists: true });
});

// === POSTCRON TOKEN API ===
const POSTCRON_BROWSERLESS_HOST = 'browserless.lslly.com';
const POSTCRON_BROWSERLESS_TOKEN = '77482ddfd0ec44d1c1a8b55ddf352d98';
const COMMENT_TOKEN_API_URL = 'https://token-facebook-lite.yokthanwa1993-bc9.workers.dev/token';

async function requestCommentTokenFromTokenFacebookLite(c: any, payload: Record<string, unknown>) {
    if (c.env.TOKEN_FACEBOOK_LITE_SERVICE) {
        return c.env.TOKEN_FACEBOOK_LITE_SERVICE.fetch('https://token-facebook-lite/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    }

    return fetch(COMMENT_TOKEN_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

async function saveProfileToken(c: any, profileId: string, token: string, mode: 'post' | 'comment') {
    const normalized = normalizeToken(token);
    if (!normalized) throw new Error(`${mode}_token_empty`);

    if (mode === 'post') {
        await c.env.DB.prepare(
            "UPDATE profiles SET postcron_token = ?, comment_token = NULL, updated_at = datetime('now') WHERE id = ?"
        ).bind(normalized, profileId).run();
        return;
    }

    await c.env.DB.prepare(
        "UPDATE profiles SET comment_token = ?, postcron_token = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(normalized, profileId).run();
}

function extractDatrFromCookies(cookies: any[]): string | null {
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    for (const cookie of cookies) {
        const name = String(cookie?.name || '').trim().toLowerCase();
        if (name !== 'datr') continue;
        const value = String(cookie?.value || '').trim();
        if (!value) continue;
        const domain = String(cookie?.domain || '').trim().toLowerCase();
        if (!domain || domain.includes('facebook.com')) return value;
    }
    return null;
}

async function resolveProfileDatr(c: any, profileId: string, existingDatr?: string | null): Promise<{ datr: string | null; source: 'profile' | 'archive' | 'none' }> {
    const current = String(existingDatr || '').trim();
    if (current) return { datr: current, source: 'profile' };

    try {
        const key = `browser-data/${profileId}.tar.gz`;
        const object = await c.env.BUCKET.get(key);
        if (!object) return { datr: null, source: 'none' };

        const bytes = new Uint8Array(await object.arrayBuffer());
        const cookies = await extractCookiesFromTarGz(bytes);
        const datr = extractDatrFromCookies(cookies);
        if (!datr) return { datr: null, source: 'none' };

        await c.env.DB.prepare(
            "UPDATE profiles SET datr = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(datr, profileId).run();

        return { datr, source: 'archive' };
    } catch (err) {
        console.log(`⚠️ resolveProfileDatr failed for ${profileId}: ${String(err)}`);
        return { datr: null, source: 'none' };
    }
}

function stringifyUnknown(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function buildTokenExtractFailureCopy(reason: string | null): { error: string; hintTh: string; actionRequired: string } {
    if (reason === 'facebook_checkpoint') {
        return {
            error: 'Facebook checkpoint required',
            hintTh: 'เจอหน้า Checkpoint ของ Facebook ระบบพยายามกดปิดแล้วแต่ยังไม่ผ่าน ให้เปิดโปรไฟล์นี้ไปยืนยันหน้า checkpoint แล้ว Stop และลองใหม่',
            actionRequired: 'Complete Facebook checkpoint for this profile manually, stop to sync cookies, then retry.',
        };
    }
    if (reason === 'facebook_automated_behavior') {
        return {
            error: 'Facebook automated behavior warning',
            hintTh: 'เจอหน้าเตือนพฤติกรรมอัตโนมัติ ระบบพยายามกดปิดให้อัตโนมัติแล้ว แต่ยังไม่ผ่าน ให้เข้าโปรไฟล์นี้ไปยืนยัน/ปิดแจ้งเตือนด้วยมือ แล้ว Stop และลองใหม่',
            actionRequired: 'Open this profile and clear Facebook automated-behavior warning, stop profile to sync cookies, then retry.',
        };
    }
    if (reason === 'facebook_login_required') {
        return {
            error: 'Facebook login required',
            hintTh: 'Facebook หลุด login ให้เปิดโปรไฟล์นี้ล็อกอินใหม่ แล้ว Stop และลองใหม่',
            actionRequired: 'Log in to Facebook in this profile, stop profile to sync cookies, then retry.',
        };
    }
    if (reason === 'facebook_security_confirmation') {
        return {
            error: 'Facebook security confirmation required',
            hintTh: 'Facebook ต้องยืนยันความปลอดภัยเพิ่มเติม ให้ยืนยันให้เสร็จ แล้ว Stop และลองใหม่',
            actionRequired: 'Complete Facebook security confirmation for this profile, stop profile, then retry.',
        };
    }
    return {
        error: 'Failed to extract token — Facebook session may be expired',
        hintTh: 'เปิดเบราเซอร์โปรไฟล์นี้แล้วล็อกอิน Facebook ใหม่ จากนั้น Stop แล้วลองใหม่',
        actionRequired: 'Open profile browser, refresh Facebook session/cookies, stop profile, then retry.',
    };
}

async function loadArchiveCookies(c: any, profileId: string): Promise<{
    allCookies: any[];
    facebookCookies: any[];
    error?: string;
}> {
    try {
        const key = `browser-data/${profileId}.tar.gz`;
        const object = await c.env.BUCKET.get(key);
        if (!object) return { allCookies: [], facebookCookies: [], error: 'archive_not_found' };

        const archiveBuffer = await object.arrayBuffer();
        const allCookies = await extractCookiesFromTarGz(new Uint8Array(archiveBuffer));
        if (!allCookies || allCookies.length === 0) {
            return { allCookies: [], facebookCookies: [], error: 'cookies_not_found' };
        }

        const facebookCookies = allCookies.filter((cookie: any) => String(cookie?.domain || '').includes('facebook.com'));
        if (facebookCookies.length === 0) {
            return { allCookies, facebookCookies: [], error: 'facebook_cookies_not_found' };
        }

        return { allCookies, facebookCookies };
    } catch (err) {
        return { allCookies: [], facebookCookies: [], error: `cookies_load_failed:${String(err)}` };
    }
}

async function diagnoseFacebookBarrierWithBrowserless(c: any, profileId: string): Promise<{
    extract: PostcronExtractResult | null;
    diagnosticsError?: string;
    cookieCount?: number;
    facebookCookieCount?: number;
}> {
    const loaded = await loadArchiveCookies(c, profileId);
    if (loaded.error) {
        return { extract: null, diagnosticsError: loaded.error };
    }

    try {
        const extract = await extractPostcronTokenWithRetry(
            POSTCRON_BROWSERLESS_HOST,
            POSTCRON_BROWSERLESS_TOKEN,
            loaded.allCookies,
        );
        return {
            extract,
            cookieCount: loaded.allCookies.length,
            facebookCookieCount: loaded.facebookCookies.length,
        };
    } catch (err) {
        return {
            extract: null,
            diagnosticsError: `browserless_extract_failed:${String(err)}`,
            cookieCount: loaded.allCookies.length,
            facebookCookieCount: loaded.facebookCookies.length,
        };
    }
}

function isRetryableBrowserlessError(err: unknown): boolean {
    const text = stringifyUnknown(err).toLowerCase();
    if (!text) return false;
    return text.includes('websocket error')
        || text.includes('switching protocols')
        || text.includes(' 502 ')
        || text.includes('received 502')
        || text.includes('cloudflare');
}

async function extractPostcronTokenWithRetry(
    browserlessHost: string,
    browserlessToken: string,
    cookies: any[],
): Promise<PostcronExtractResult> {
    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await extractPostcronToken(browserlessHost, browserlessToken, cookies);
        } catch (err) {
            lastError = err;
            if (!isRetryableBrowserlessError(err) || attempt >= maxAttempts) {
                throw err;
            }
            const waitMs = 600 * attempt;
            console.log(`⚠️ Browserless transient error (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms: ${stringifyUnknown(err)}`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
    throw lastError || new Error('extract_postcron_token_retry_exhausted');
}

async function handlePostToken(c: any, profileId: string) {
    const profile = await c.env.DB.prepare(
        'SELECT id, name, tags, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).bind(profileId).first<Profile>();

    if (!profile) {
        return c.json({ error: 'Profile not found', profileId }, 404);
    }

    const roleState = getRoleTagState(profile.tags || '[]');
    if (roleState.hasConflict) {
        return c.json({
            error: 'Profile has both post and comment tags. Keep only one role tag before syncing token.',
            profileId,
            profile: profile.name,
        }, 400);
    }
    if (!roleState.hasPost) {
        return c.json({
            error: 'Profile is not tagged as post. Add post tag before syncing post token.',
            profileId,
            profile: profile.name,
        }, 400);
    }

    const loaded = await loadArchiveCookies(c, profileId);
    if (loaded.error === 'archive_not_found') {
        return c.json({ error: 'No browser data in R2. Start browser → login Facebook → Stop first', profileId }, 404);
    }
    if (loaded.error === 'cookies_not_found') {
        return c.json({ error: 'No cookies found in archive. Start browser → login Facebook → Stop first', profileId }, 400);
    }
    if (loaded.error === 'facebook_cookies_not_found') {
        return c.json({ error: 'No Facebook cookies. Start browser → login Facebook → Stop first', profileId }, 400);
    }
    if (loaded.error) {
        return c.json({ error: `Failed to load archive cookies: ${loaded.error}`, profileId }, 500);
    }

    const cookies = loaded.allCookies;
    const fbCookies = loaded.facebookCookies;
    console.log(`🍪 ${profile.name}: ${cookies.length} cookies (${fbCookies.length} Facebook)`);

    try {
        const extract = await extractPostcronTokenWithRetry(POSTCRON_BROWSERLESS_HOST, POSTCRON_BROWSERLESS_TOKEN, cookies);
        const userToken = String(extract?.token || '').trim();

        if (!userToken) {
            const reason = String(extract?.reason || 'session_expired').trim();
            const currentUrl = String(extract?.url || '').trim() || null;
            const detail = String(extract?.detail || '').trim() || null;
            const copy = buildTokenExtractFailureCopy(reason);

            return c.json({
                error: copy.error,
                reason,
                profileId,
                profile: profile.name,
                current_url: currentUrl,
                detail,
                action_required: copy.actionRequired,
                hint_th: copy.hintTh,
            }, 400);
        }

        let resolvedPage: { pageToken: string; pageId: string; pageName: string; pageAvatarUrl: string };
        try {
            resolvedPage = await resolveProfilePageToken(userToken, profile);
        } catch (resolveErr) {
            return c.json({
                error: `Failed to convert user token to page token via me/accounts: ${String(resolveErr)}`,
                profileId,
                profile: profile.name,
            }, 400);
        }

        await saveProfileToken(c, profileId, resolvedPage.pageToken, 'post');
        await c.env.DB.prepare(
            "UPDATE profiles SET page_name = COALESCE(?, page_name), page_avatar_url = COALESCE(?, page_avatar_url), updated_at = datetime('now') WHERE id = ?"
        ).bind(
            resolvedPage.pageName || null,
            resolvedPage.pageAvatarUrl || null,
            profileId
        ).run();
        console.log(`🔑 ${profile.name}: Post page token saved`);

        return c.json({
            success: true,
            mode: 'post',
            profile: profile.name,
            profileId,
            token: resolvedPage.pageToken,
            page_id: resolvedPage.pageId || null,
            page_name: resolvedPage.pageName || null,
            page_avatar_url: resolvedPage.pageAvatarUrl || null,
            savedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error(`❌ ${profile.name}: ${err}`);
        return c.json({ error: String(err), profileId, profile: profile.name }, 500);
    }
}

async function handleCommentToken(c: any, profileId: string) {
    const profile = await c.env.DB.prepare(
        'SELECT id, name, tags, uid, username, password, totp_secret, datr, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).bind(profileId).first<Profile>();

    if (!profile) {
        return c.json({ error: 'Profile not found', profileId }, 404);
    }

    const roleState = getRoleTagState(profile.tags || '[]');
    if (roleState.hasConflict) {
        return c.json({
            error: 'Profile has both post and comment tags. Keep only one role tag before syncing token.',
            profileId,
            profile: profile.name,
        }, 400);
    }
    if (!roleState.hasComment) {
        return c.json({
            error: 'Profile is not tagged as comment. Add comment tag before syncing comment token.',
            profileId,
            profile: profile.name,
        }, 400);
    }

    const loginId = (profile.uid || profile.username || '').trim();
    if (!loginId || !profile.password) {
        return c.json({
            error: 'Missing uid/username or password in profile',
            profileId,
            profile: profile.name
        }, 400);
    }

    try {
        const datrResolved = await resolveProfileDatr(c, profileId, profile.datr || null);
        const response = await requestCommentTokenFromTokenFacebookLite(c, {
            identifier: loginId,
            password: profile.password,
            twofa: profile.totp_secret || null,
            datr: datrResolved.datr || null,
            target_app: 'FB_LITE',
        });

        const result = await response.json().catch(() => ({} as any));
        const userToken =
            normalizeToken(result?.converted_token?.access_token) ||
            normalizeToken(result?.token) ||
            '';

        if (!response.ok || !result?.success || !userToken) {
            const upstreamError = stringifyUnknown(result?.error) || `Comment token API failed (${response.status})`;
            const diagnostics = await diagnoseFacebookBarrierWithBrowserless(c, profileId);
            const diagnosedReason = String(diagnostics.extract?.reason || '').trim();
            const diagnosedUrl = String(diagnostics.extract?.url || '').trim() || null;
            const diagnosedDetail = String(diagnostics.extract?.detail || '').trim() || null;

            if (diagnosedReason) {
                const copy = buildTokenExtractFailureCopy(diagnosedReason);
                return c.json({
                    error: copy.error,
                    reason: diagnosedReason,
                    profileId,
                    profile: profile.name,
                    current_url: diagnosedUrl,
                    detail: diagnosedDetail,
                    action_required: copy.actionRequired,
                    hint_th: copy.hintTh,
                    upstream_error: upstreamError,
                    diagnostics_error: diagnostics.diagnosticsError || null,
                    diagnostics_cookie_count: diagnostics.cookieCount ?? null,
                    diagnostics_facebook_cookies: diagnostics.facebookCookieCount ?? null,
                }, 400);
            }

            return c.json({
                error: upstreamError,
                profileId,
                profile: profile.name,
                reason: stringifyUnknown(result?.reason) || null,
                detail: stringifyUnknown(result?.detail || result?.error_user_msg) || null,
                diagnostics_error: diagnostics.diagnosticsError || null,
                diagnostics_cookie_count: diagnostics.cookieCount ?? null,
                diagnostics_facebook_cookies: diagnostics.facebookCookieCount ?? null,
            }, response.status >= 500 ? 502 : 400);
        }

        let resolvedPage: { pageToken: string; pageId: string; pageName: string; pageAvatarUrl: string };
        try {
            resolvedPage = await resolveProfilePageToken(userToken, profile);
        } catch (resolveErr) {
            return c.json({
                error: `Failed to convert user token to page token via me/accounts: ${String(resolveErr)}`,
                profileId,
                profile: profile.name,
            }, 400);
        }

        await saveProfileToken(c, profileId, resolvedPage.pageToken, 'comment');
        await c.env.DB.prepare(
            "UPDATE profiles SET page_name = COALESCE(?, page_name), page_avatar_url = COALESCE(?, page_avatar_url), updated_at = datetime('now') WHERE id = ?"
        ).bind(
            resolvedPage.pageName || null,
            resolvedPage.pageAvatarUrl || null,
            profileId
        ).run();
        console.log(`🔑 ${profile.name}: Comment page token saved`);

        return c.json({
            success: true,
            mode: 'comment',
            profile: profile.name,
            profileId,
            token: resolvedPage.pageToken,
            page_id: resolvedPage.pageId || null,
            page_name: resolvedPage.pageName || null,
            page_avatar_url: resolvedPage.pageAvatarUrl || null,
            token_type: result?.converted_token?.target_app || 'FB_LITE',
            datr_source: datrResolved.source,
            savedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error(`❌ ${profile.name}: ${err}`);
        return c.json({ error: String(err), profileId, profile: profile.name }, 500);
    }
}

// GET /api/postcron/:profileId/post - Post token
app.get('/api/postcron/:profileId/post', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);
    return handlePostToken(c, profileId);
});

// GET /api/postcron/:profileId/comment - Comment token
app.get('/api/postcron/:profileId/comment', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);
    return handleCommentToken(c, profileId);
});

// GET /api/profiles/:id/page - Get Facebook Page info
app.get('/api/profiles/:id/page', async (c) => {
    const id = c.req.param('id');
    const allowed = await ensureProfileAccess(c, id, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found' }, 404);
    
    // Get profile with token
    const profile = await c.env.DB.prepare(
        'SELECT id, name, postcron_token, comment_token, facebook_token, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).bind(id).first<Profile>();
    
    if (!profile) {
        return c.json({ error: 'Profile not found' }, 404);
    }
    
    const postToken = normalizeToken(profile.postcron_token);
    const commentToken = normalizeToken(profile.comment_token);
    const legacyToken = normalizeToken(profile.facebook_token);
    const graphToken =
        (postToken || '') ||
        (commentToken || '') ||
        (legacyToken || '');
    if (!graphToken) {
        return c.json({
            error: 'No token',
            page_name: null,
            has_post_token: !!postToken,
            has_comment_token: isCommentRoleToken(commentToken),
        });
    }
    
    try {
        // Prefer /me/accounts (works with user token), fallback to /me (works with page token).
        let pageName = '';
        let pageId = '';
        let facebookImageUrl: string | null = null;

        const response = await fetch(
            `https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(graphToken)}&fields=name,id,picture.type(large)&limit=200`
        );
        const data = await response.json().catch(() => ({} as any));

        if (response.ok && Array.isArray(data?.data) && data.data.length > 0) {
            const matched = pickTargetFacebookPage(data.data as FacebookAccountItem[], profile);
            const firstPage = matched || data.data[0];
            pageName = String(firstPage?.name || '').trim();
            pageId = String(firstPage?.id || '').trim();
            facebookImageUrl = String(firstPage?.picture?.data?.url || '').trim() || null;
        } else {
            const meResp = await fetch(
                `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(graphToken)}&fields=id,name,picture.type(large)`
            );
            const meData = await meResp.json().catch(() => ({} as any));
            if (!meResp.ok) {
                const errorText = String(meData?.error?.message || meData?.error || `HTTP ${meResp.status}`);
                console.log(`Facebook API error for ${profile.name}: ${errorText}`);
                return c.json({ error: `Facebook API failed: ${errorText}`, page_name: null });
            }
            pageName = String(meData?.name || '').trim();
            pageId = String(meData?.id || '').trim();
            facebookImageUrl = String(meData?.picture?.data?.url || '').trim() || null;
        }

        if (pageId) {
            
            let r2ImageUrl = null;
            
            // Download image from Facebook and upload to R2
            if (facebookImageUrl) {
                try {
                    console.log('Downloading page image for ' + profile.name + ' from Facebook...');
                    const imageResponse = await fetch(facebookImageUrl);
                    
                    if (imageResponse.ok) {
                        const imageBuffer = await imageResponse.arrayBuffer();
                        const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
                        const fileExt = contentType.includes('png') ? 'png' : 'jpg';
                        const r2Key = 'page-avatars/' + pageId + '.' + fileExt;
                        
                        console.log('Uploading to R2: ' + r2Key);
                        await c.env.BUCKET.put(r2Key, imageBuffer, {
                            contentType: contentType,
                            customMetadata: {
                                profileId: id,
                                profileName: profile.name,
                                pageName: pageName,
                                pageId: pageId
                            }
                        });
                        
                        // Generate public URL for the image
                        r2ImageUrl = c.req.url.split('/api')[0] + '/storage/' + r2Key;
                        console.log('Image saved to R2: ' + r2ImageUrl);
                    } else {
                        console.log('Failed to download image: ' + imageResponse.status);
                    }
                } catch (imgErr) {
                    console.error('Error processing image for ' + profile.name + ':', imgErr);
                    // Fall back to Facebook URL if upload fails
                    r2ImageUrl = facebookImageUrl;
                }
            }
            
            // Save page_name and page_avatar_url (R2 URL) to database
            const finalAvatarUrl = r2ImageUrl || facebookImageUrl;
            await c.env.DB.prepare(
                'UPDATE profiles SET page_name = ?, page_avatar_url = ? WHERE id = ?'
            ).bind(pageName, finalAvatarUrl, id).run();
            
            return c.json({ 
                success: true, 
                page_name: pageName,
                page_avatar_url: finalAvatarUrl,
                page_id: pageId,
                profile: profile.name,
                stored_in_r2: !!r2ImageUrl
            });
        } else {
            return c.json({ page_name: null, message: 'No pages found' });
        }
    } catch (err) {
        console.error(`Error fetching page for ${profile.name}: ${err}`);
        return c.json({ error: String(err), page_name: null });
    }
});

// Helper: Extract cookies.json from tar.gz archive
async function extractCookiesFromTarGz(gzData: Uint8Array): Promise<any[]> {
    let tarData: Uint8Array = gzData;
    const isGzip = gzData.length >= 2 && gzData[0] === 0x1f && gzData[1] === 0x8b;

    // Use pako streaming inflate because it can still yield usable partial output
    // for truncated gzip files produced by interrupted uploads.
    if (isGzip) {
        try {
            const chunks: Uint8Array[] = [];
            const inflator = new pako.Inflate();
            inflator.onData = (chunk: Uint8Array) => {
                chunks.push(chunk);
            };
            inflator.push(gzData, true);

            const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            if (totalSize > 0) {
                tarData = concatUint8Arrays(chunks, totalSize);
                console.log(`📦 Decompressed tar bytes: ${tarData.length}${inflator.err ? ' (partial)' : ''}`);
            } else {
                console.log(`⚠️ Gzip decompress returned empty output (err=${inflator.err ?? 'none'}), fallback to raw tar parse`);
            }
        } catch (err) {
            console.log(`⚠️ Gzip decompress failed, fallback to raw tar parse: ${String(err)}`);
        }
    }

    return parseCookiesFromTar(tarData);
}

function concatUint8Arrays(chunks: Uint8Array[], totalSize: number): Uint8Array {
    const out = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function parseTarSize(sizeField: Uint8Array): number {
    // GNU/base-256 binary size encoding
    if (sizeField.length > 0 && (sizeField[0] & 0x80) !== 0) {
        let value = 0n;
        for (let i = 0; i < sizeField.length; i++) {
            value = (value << 8n) | BigInt(sizeField[i]);
        }
        const bits = BigInt(sizeField.length * 8 - 1);
        const mask = (1n << bits) - 1n;
        const positive = value & mask;
        return Number(positive);
    }

    const raw = new TextDecoder().decode(sizeField).replace(/\0/g, '').trim();
    if (!raw) return 0;
    const size = parseInt(raw, 8);
    return Number.isFinite(size) && size >= 0 ? size : 0;
}

function parseCookiesFromTar(tarData: Uint8Array): any[] {
    const decoder = new TextDecoder();

    const parseHeaderAt = (headerOffset: number): any[] | null => {
        if (headerOffset + 512 > tarData.length) return null;
        const header = tarData.slice(headerOffset, headerOffset + 512);
        if (header.every(b => b === 0)) return null;

        let nameEnd = 0;
        while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
        const name = decoder.decode(header.slice(0, nameEnd));
        if (!(name === 'cookies.json' || name.endsWith('/cookies.json'))) return null;

        const size = parseTarSize(header.slice(124, 136));
        const dataStart = headerOffset + 512;
        const dataEnd = Math.min(dataStart + size, tarData.length);
        if (dataStart >= dataEnd) return null;

        try {
            return JSON.parse(decoder.decode(tarData.slice(dataStart, dataEnd)));
        } catch {
            return null;
        }
    };

    // Fast path: regular tar iteration
    let offset = 0;
    while (offset + 512 <= tarData.length) {
        const found = parseHeaderAt(offset);
        if (found) return found;

        const header = tarData.slice(offset, offset + 512);
        if (header.every(b => b === 0)) break;

        const size = parseTarSize(header.slice(124, 136));
        const paddedSize = Math.ceil(size / 512) * 512;
        const nextOffset = offset + 512 + paddedSize;
        if (!Number.isFinite(nextOffset) || nextOffset <= offset || nextOffset > tarData.length + 512) {
            break;
        }
        offset = nextOffset;
    }

    // Recovery path for malformed tar indexes: brute-force each 512-byte header boundary.
    for (let headerOffset = 0; headerOffset + 512 <= tarData.length; headerOffset += 512) {
        const found = parseHeaderAt(headerOffset);
        if (found) return found;
    }

    return [];
}

function classifyFacebookBarrierUrl(url: string): 'facebook_checkpoint' | 'facebook_login_required' | 'facebook_security_confirmation' | null {
    const normalized = String(url || '').toLowerCase();
    if (!normalized) return null;
    if (normalized.includes('facebook.com/checkpoint')) return 'facebook_checkpoint';
    if (normalized.includes('facebook.com/login')) return 'facebook_login_required';
    if (normalized.includes('facebook.com/two_factor') || normalized.includes('approvals_code') || normalized.includes('save-device')) {
        return 'facebook_security_confirmation';
    }
    return null;
}

type PostcronExtractFailReason =
    | 'facebook_checkpoint'
    | 'facebook_login_required'
    | 'facebook_security_confirmation'
    | 'facebook_automated_behavior'
    | 'session_expired';

type PostcronExtractResult = {
    token: string | null;
    reason: PostcronExtractFailReason | null;
    url: string | null;
    detail?: string | null;
}

// Helper: Connect to Browserless and extract Postcron token via raw CDP
async function extractPostcronToken(
    browserlessHost: string,
    browserlessToken: string,
    cookies: any[]
): Promise<PostcronExtractResult> {
    const wsUrl = `wss://${browserlessHost}/?token=${browserlessToken}`;

    return new Promise(async (resolve, reject) => {
        const stringifyWsError = (err: unknown): string => {
            if (!err) return 'unknown_websocket_error';
            if (typeof err === 'string') return err;
            if (err instanceof Error) return `${err.name}: ${err.message}`;
            try {
                const anyErr = err as any;
                const payload: Record<string, unknown> = {};
                if (typeof anyErr?.type === 'string') payload.type = anyErr.type;
                if (typeof anyErr?.message === 'string') payload.message = anyErr.message;
                if (anyErr?.error !== undefined) payload.error = String(anyErr.error);
                if (typeof anyErr?.code === 'number' || typeof anyErr?.code === 'string') payload.code = anyErr.code;
                if (Object.keys(payload).length > 0) return JSON.stringify(payload);
                return String(err);
            } catch {
                return String(err);
            }
        };

        let msgId = 1;
        let targetId = '';
        let sessionId = '';
        let resolved = false;
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                ws.close();
                reject('Timeout: Token extraction took too long (30s)');
            }
        }, 30000);

        const ws = new WebSocket(wsUrl);

        const sendCDP = (method: string, params: any = {}, sid?: string) => {
            const id = msgId++;
            const msg: any = { id, method, params };
            if (sid) msg.sessionId = sid;
            ws.send(JSON.stringify(msg));
            return id;
        };

        const pendingCallbacks = new Map<number, { resolve: (result: any) => void; reject: (err: unknown) => void }>();

        const sendAndWait = (method: string, params: any = {}, sid?: string): Promise<any> => {
            return new Promise((resolveOne, rejectOne) => {
                const id = sendCDP(method, params, sid);
                pendingCallbacks.set(id, { resolve: resolveOne, reject: rejectOne });
            });
        };

        ws.addEventListener('open', async () => {
            try {
                // Create a new browser context (incognito-like)
                const ctx = await sendAndWait('Target.createBrowserContext', {});
                const browserContextId = ctx.browserContextId;

                // Create a new page
                const target = await sendAndWait('Target.createTarget', {
                    url: 'about:blank',
                    browserContextId,
                });
                targetId = target.targetId;

                // Attach to the page
                const attached = await sendAndWait('Target.attachToTarget', {
                    targetId,
                    flatten: true,
                });
                sessionId = attached.sessionId;

                // Enable Network and Page domains
                await sendAndWait('Network.enable', {}, sessionId);
                await sendAndWait('Page.enable', {}, sessionId);

                // Set cookies
                const cookieParams = cookies.map((c: any) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    secure: c.secure ?? true,
                    httpOnly: c.http_only ?? c.httpOnly ?? false,
                    sameSite: c.same_site ?? c.sameSite ?? undefined,
                })).filter((c: any) => c.name && c.value && c.domain);

                await sendAndWait('Network.setCookies', { cookies: cookieParams }, sessionId);
                console.log(`🍪 Injected ${cookieParams.length} cookies`);

                // Navigate to Postcron OAuth
                const postcronUrl = 'https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook';
                await sendAndWait('Page.navigate', { url: postcronUrl }, sessionId);

                // Wait for navigation
                await new Promise(r => setTimeout(r, 5000));

                const inspectBarrier = async (): Promise<{
                    url: string;
                    checkpoint: boolean;
                    login: boolean;
                    security: boolean;
                    automated: boolean;
                    automated_keyword: string;
                }> => {
                    const inspectScript = `
                        (function() {
                            const href = String(window.location.href || '');
                            const lowerUrl = href.toLowerCase();
                            const bodyText = String((document.body && document.body.innerText) || '').toLowerCase();
                            const autoKeywords = [
                                'พฤติกรรมอัตโนมัติ',
                                'พฤติกรรมที่ไม่ปกติ',
                                'เราได้ตรวจพบกิจกรรมที่ผิดปกติ',
                                'automated behavior',
                                'unusual activity',
                                'suspicious activity',
                                'we limit how often'
                            ];
                            let automatedKeyword = '';
                            for (const k of autoKeywords) {
                                if (k && bodyText.includes(k.toLowerCase())) {
                                    automatedKeyword = k;
                                    break;
                                }
                            }
                            return {
                                url: href,
                                checkpoint: lowerUrl.includes('facebook.com/checkpoint'),
                                login: lowerUrl.includes('facebook.com/login'),
                                security: lowerUrl.includes('facebook.com/two_factor') || lowerUrl.includes('approvals_code') || lowerUrl.includes('save-device'),
                                automated: !!automatedKeyword,
                                automated_keyword: automatedKeyword
                            };
                        })()
                    `;
                    const result = await sendAndWait('Runtime.evaluate', {
                        expression: inspectScript,
                        returnByValue: true,
                    }, sessionId);
                    const value = result?.result?.value || {};
                    return {
                        url: String(value?.url || ''),
                        checkpoint: !!value?.checkpoint,
                        login: !!value?.login,
                        security: !!value?.security,
                        automated: !!value?.automated,
                        automated_keyword: String(value?.automated_keyword || ''),
                    };
                };

                const dismissFacebookBarrier = async (phase: string): Promise<{ ok: boolean; reason?: PostcronExtractFailReason; url: string; note: string; detail?: string }> => {
                    const closeScript = `
                        (function() {
                            const selectors = [
                                'div[role="button"][aria-label="ปิด"]',
                                'div[role="button"][aria-label*="ปิด"]',
                                '[role="button"][aria-label="Close"]',
                                '[role="button"][aria-label*="close" i]',
                                'button[aria-label="ปิด"]',
                                'button[aria-label="Close"]'
                            ];
                            for (const sel of selectors) {
                                const el = document.querySelector(sel);
                                if (el) {
                                    const target = (el.closest && el.closest('[role="button"],button')) || el;
                                    target.click();
                                    return 'clicked:' + sel;
                                }
                            }
                            const all = document.querySelectorAll('div[role="button"], button, span, [aria-label]');
                            for (const el of all) {
                                const txt = (el.textContent || '').trim().toLowerCase();
                                const label = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim().toLowerCase();
                                if (txt === 'ปิด' || txt === 'close' || label === 'ปิด' || label === 'close') {
                                    const target = (el.closest && el.closest('[role="button"],button')) || el;
                                    target.click();
                                    return 'clicked:fallback';
                                }
                            }
                            return 'not-found';
                        })()
                    `;

                    for (let attempt = 1; attempt <= 3; attempt++) {
                        const click = await sendAndWait('Runtime.evaluate', {
                            expression: closeScript,
                            returnByValue: true,
                        }, sessionId);
                        const clickResult = String(click?.result?.value || 'unknown');
                        console.log(`🧩 Barrier close (${phase}) attempt ${attempt}/3: ${clickResult}`);

                        await new Promise(r => setTimeout(r, 2000));
                        const inspected = await inspectBarrier();
                        if (!inspected.checkpoint && !inspected.automated) {
                            console.log(`✅ Barrier dismissed (${phase}) -> ${inspected.url.substring(0, 90)}`);
                            return { ok: true, url: inspected.url, note: clickResult };
                        }

                        if (clickResult === 'not-found') {
                            const failReason: PostcronExtractFailReason = inspected.checkpoint
                                ? 'facebook_checkpoint'
                                : 'facebook_automated_behavior';
                            return {
                                ok: false,
                                reason: failReason,
                                url: inspected.url,
                                note: clickResult,
                                detail: inspected.automated_keyword || undefined,
                            };
                        }
                    }

                    const inspected = await inspectBarrier();
                    const failReason: PostcronExtractFailReason = inspected.checkpoint
                        ? 'facebook_checkpoint'
                        : 'facebook_automated_behavior';
                    return {
                        ok: false,
                        reason: failReason,
                        url: inspected.url,
                        note: 'barrier-still-open',
                        detail: inspected.automated_keyword || undefined,
                    };
                };

                const initialInspect = await inspectBarrier();
                const currentUrl = initialInspect.url;
                console.log(`📍 After navigate: ${currentUrl.substring(0, 80)}...`);

                const initialBarrier = classifyFacebookBarrierUrl(currentUrl);
                if (initialBarrier === 'facebook_login_required' || initialBarrier === 'facebook_security_confirmation') {
                    resolved = true;
                    clearTimeout(timeout);
                    ws.close();
                    resolve({ token: null, reason: initialBarrier, url: currentUrl });
                    return;
                }
                if (initialInspect.checkpoint || initialInspect.automated) {
                    const dismissed = await dismissFacebookBarrier('initial');
                    if (!dismissed.ok) {
                        resolved = true;
                        clearTimeout(timeout);
                        ws.close();
                        resolve({
                            token: null,
                            reason: dismissed.reason || (initialInspect.checkpoint ? 'facebook_checkpoint' : 'facebook_automated_behavior'),
                            url: dismissed.url || currentUrl,
                            detail: dismissed.detail || null,
                        });
                        return;
                    }
                }

                // Try to click "Continue" / "ดำเนินการต่อ" button
                const clickScript = `
                    (function() {
                        const selectors = [
                            'div[aria-label*="ดำเนินการต่อ"]',
                            'div[aria-label*="Continue"]',
                            'button[name="__CONFIRM__"]',
                            'input[value="Continue"]'
                        ];
                        for (const sel of selectors) {
                            try {
                                const el = document.querySelector(sel);
                                if (el) { el.click(); return 'clicked: ' + sel; }
                            } catch(e) {}
                        }
                        // Fallback: find by text
                        const allBtns = document.querySelectorAll('div[role="button"], button');
                        for (const btn of allBtns) {
                            const txt = btn.textContent || '';
                            if (txt.includes('Continue') || txt.includes('ดำเนินการต่อ')) {
                                btn.click();
                                return 'clicked by text: ' + txt.trim().substring(0, 30);
                            }
                        }
                        return 'no button found';
                    })()
                `;

                await sendAndWait('Runtime.evaluate', {
                    expression: clickScript,
                    returnByValue: true,
                }, sessionId);

                // Wait for redirect after click
                await new Promise(r => setTimeout(r, 5000));

                // Check for token in URL (try multiple times)
                for (let attempt = 0; attempt < 5; attempt++) {
                    const inspected = await inspectBarrier();
                    const url = inspected.url || '';
                    const barrier = classifyFacebookBarrierUrl(url);

                    if (barrier === 'facebook_login_required' || barrier === 'facebook_security_confirmation') {
                        resolved = true;
                        clearTimeout(timeout);
                        ws.close();
                        resolve({ token: null, reason: barrier, url });
                        return;
                    }
                    if (inspected.checkpoint || inspected.automated) {
                        const dismissed = await dismissFacebookBarrier(`loop-${attempt + 1}`);
                        if (!dismissed.ok) {
                            resolved = true;
                            clearTimeout(timeout);
                            ws.close();
                            resolve({
                                token: null,
                                reason: dismissed.reason || (inspected.checkpoint ? 'facebook_checkpoint' : 'facebook_automated_behavior'),
                                url: dismissed.url || url,
                                detail: dismissed.detail || null,
                            });
                            return;
                        }
                        if (attempt < 4) await new Promise(r => setTimeout(r, 1500));
                        continue;
                    }

                    const tokenMatch = url.match(/access_token=([^&]+)/);
                    if (tokenMatch) {
                        const token = decodeURIComponent(tokenMatch[1]);
                        console.log(`🔑 Token found: ${token.substring(0, 20)}...`);
                        resolved = true;
                        clearTimeout(timeout);
                        ws.close();
                        resolve({ token, reason: null, url });
                        return;
                    }

                    if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
                }

                // No token found
                const finalInspect = await inspectBarrier();
                const finalReason: PostcronExtractFailReason =
                    finalInspect.checkpoint
                        ? 'facebook_checkpoint'
                        : finalInspect.automated
                            ? 'facebook_automated_behavior'
                            : classifyFacebookBarrierUrl(finalInspect.url) || 'session_expired';
                resolved = true;
                clearTimeout(timeout);
                ws.close();
                resolve({
                    token: null,
                    reason: finalReason,
                    url: finalInspect.url || null,
                    detail: finalInspect.automated_keyword || null,
                });
            } catch (err) {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    ws.close();
                    reject(String(err));
                }
            }
        });

        ws.addEventListener('message', (event) => {
            try {
                const msg = JSON.parse(event.data as string);
                if (msg.id && pendingCallbacks.has(msg.id)) {
                    const cb = pendingCallbacks.get(msg.id)!;
                    pendingCallbacks.delete(msg.id);
                    if (msg.error) {
                        cb.reject(`CDP ${String(msg.error?.code || 'ERR')}: ${String(msg.error?.message || JSON.stringify(msg.error))}`);
                    } else {
                        cb.resolve(msg.result || {});
                    }
                }
            } catch {
                // ignore non-JSON CDP events
            }
        });

        ws.addEventListener('error', (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                try { ws.close(); } catch { }
                reject(`WebSocket error: ${stringifyWsError(err)}`);
            }
        });

        ws.addEventListener('close', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject('WebSocket closed unexpectedly');
            }
        });
    });
}

// Root
app.get('/', (c) => {
    return c.text('🚀 BrowserSaving API (Cloudflare Worker)');
});

export default app;
