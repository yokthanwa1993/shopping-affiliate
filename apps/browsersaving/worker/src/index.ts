import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import puppeteer from '@cloudflare/puppeteer';
import pako from 'pako';

type Bindings = {
    DB: D1Database;
    BUCKET: R2Bucket;
    MYBROWSER?: Fetcher;
    ENVIRONMENT: string;
    BROWSERSAVING_API_URL?: string;
    BROWSERSAVING_UPDATE_VERSION?: string;
    BROWSERSAVING_UPDATE_NOTES?: string;
    BROWSERSAVING_UPDATE_NOTES_PUBLISHED?: string;
    BROWSERSAVING_UPDATE_DMG_URL?: string;
    BROWSERSAVING_UPDATE_DMG_URL_X64?: string;
    BROWSERSAVING_UPDATE_DMG_SIGNATURE?: string;
    BROWSERSAVING_UPDATE_DMG_SIGNATURE_X64?: string;
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
    access_token: string | null;
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
const ADMIN_EMAIL = 'admin@browsersaving.local';
const ADMIN_PASSWORD = '!@7EvaYLj986';
const DEFAULT_VIDEO_AFFILIATE_EMAIL_RESOLVE_URL = 'https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev/api/auth/resolve-email';

function normalizeToken(raw: unknown): string {
    return String(raw || '').trim();
}

function looksLikeCommentAccessToken(raw: unknown): boolean {
    return /^EAAD6/i.test(normalizeToken(raw));
}

function isCommentRoleToken(token: string): boolean {
    const t = normalizeToken(token);
    return !!t;
}

function isPostRoleToken(token: string): boolean {
    const t = normalizeToken(token);
    return !!t;
}

function validateRoleTokenInput(raw: unknown, _mode: 'post' | 'comment', fieldName: string): { ok: true; token: string | null } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, token: null };
    const token = normalizeToken(raw);
    if (!token) return { ok: true, token: null };
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

function normalizeTrustedOwnerEmailFilters(rawValues: unknown[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const raw of rawValues || []) {
        const source = String(raw || '').trim();
        if (!source) continue;
        for (const part of source.split(',')) {
            const email = normalizeEmail(part);
            if (!isValidEmail(email)) continue;
            if (seen.has(email)) continue;
            seen.add(email);
            out.push(email);
        }
    }

    return out;
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

type FacebookAccountItem = {
    id?: string;
    name?: string;
    access_token?: string;
    picture?: { data?: { url?: string } };
};

function pickTargetFacebookPage(accounts: FacebookAccountItem[], profile: Partial<Profile>): FacebookAccountItem | null {
    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    const preferredPageId = String((profile as any).__preferred_page_id || '').trim();
    if (preferredPageId) {
        const byPreferredId = accounts.find((acc) => String(acc?.id || '').trim() === preferredPageId);
        if (byPreferredId) return byPreferredId;
    }

    const preferredPageName = normalizePageName((profile as any).__preferred_page_name || '');
    if (preferredPageName) {
        const byPreferredName = accounts.find((acc) => normalizePageName(acc?.name || '') === preferredPageName);
        if (byPreferredName) return byPreferredName;
    }

    const profileNameHint = normalizePageName(profile.name || '');
    const storedPageNameHint = normalizePageName(profile.page_name || '');
    const hasExplicitPageHint =
        !!storedPageNameHint &&
        storedPageNameHint !== profileNameHint;

    // Trust persisted hints only when user had already synced an explicit page name
    // that differs from the profile owner's personal name.
    if (hasExplicitPageHint) {
        const pageIdHint = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''));
        if (pageIdHint) {
            const byId = accounts.find((acc) => String(acc?.id || '').trim() === pageIdHint);
            if (byId) return byId;
        }

        const byName = accounts.find((acc) => normalizePageName(acc?.name || '') === storedPageNameHint);
        if (byName) return byName;
    }

    // No explicit page hint (or stale personal-name hint):
    // prefer a managed page whose name is different from the personal profile name.
    if (profileNameHint) {
        const nonPersonalNamedPage = accounts.find(
            (acc) => normalizePageName(acc?.name || '') !== profileNameHint
        );
        if (nonPersonalNamedPage) return nonPersonalNamedPage;
    }

    return accounts[0] || null;
}

async function resolvePreferredProfilePageHint(profile: Partial<Profile>): Promise<{
    pageId: string;
    pageName: string;
    pageAvatarUrl: string;
}> {
    const hintedPageId = parsePageIdFromAvatarUrl(String(profile.page_avatar_url || ''));
    const hintedPageName = String(profile.page_name || '').trim();
    const hintedAvatarUrl = String(profile.page_avatar_url || '').trim();
    const currentCommentPageToken = normalizeToken((profile as any)?.access_token);

    if (currentCommentPageToken) {
        try {
            const me = await fetchFacebookMeIdentity(currentCommentPageToken);
            const hintedPageNameNormalized = normalizePageName(hintedPageName);
            const matchesStoredHint =
                (!!hintedPageId && me.id === hintedPageId)
                || (!!hintedPageNameNormalized && normalizePageName(me.name) === hintedPageNameNormalized);
            if (!matchesStoredHint) {
                throw new Error('stored_access_token_hint_mismatch');
            }
            const pageId = String(me.id || '').trim() || hintedPageId;
            const pageName = String(me.name || '').trim() || hintedPageName || pageId;
            const pageAvatarUrl = String(me.pictureUrl || '').trim()
                || hintedAvatarUrl
                || (pageId ? `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large` : '');
            return { pageId, pageName, pageAvatarUrl };
        } catch {
            // Fall back to stored metadata below.
        }
    }

    return {
        pageId: hintedPageId,
        pageName: hintedPageName || hintedPageId,
        pageAvatarUrl: hintedAvatarUrl || (hintedPageId ? `https://graph.facebook.com/${encodeURIComponent(hintedPageId)}/picture?type=large` : ''),
    };
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

    const preferredHint = await resolvePreferredProfilePageHint(profile);
    const matched = pickTargetFacebookPage(accounts, {
        ...profile,
        __preferred_page_id: preferredHint.pageId,
        __preferred_page_name: preferredHint.pageName,
    } as Partial<Profile>);
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

async function fetchFacebookMeIdentity(tokenRaw: string): Promise<{ id: string; name: string; pictureUrl: string }> {
    const token = normalizeToken(tokenRaw);
    if (!token) throw new Error('facebook_me_identity_token_empty');

    const url = `https://graph.facebook.com/v21.0/me?fields=id,name,picture.type(large)&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => ({} as any));
    if (!response.ok) {
        const message = String(data?.error?.message || data?.error || `HTTP ${response.status}`);
        throw new Error(`facebook_me_identity_failed: ${message}`);
    }

    const id = String(data?.id || '').trim();
    if (!id) throw new Error('facebook_me_identity_missing_id');

    return {
        id,
        name: String(data?.name || '').trim(),
        pictureUrl: String(data?.picture?.data?.url || '').trim(),
    };
}

async function resolveStoredPageTokenForSync(tokenRaw: string, profile: Partial<Profile>): Promise<{
    pageToken: string;
    pageId: string;
    pageName: string;
    pageAvatarUrl: string;
}> {
    const token = normalizeToken(tokenRaw);
    if (!token) throw new Error('stored_page_token_empty');
    const preferredHint = await resolvePreferredProfilePageHint(profile);

    try {
        return await resolveProfilePageToken(token, profile);
    } catch (resolveErr) {
        try {
            const me = await fetchFacebookMeIdentity(token);
            const hintedPageId = String(preferredHint.pageId || '').trim();
            const hintedPageName = String(preferredHint.pageName || '').trim();
            const hintedAvatarUrl = String(preferredHint.pageAvatarUrl || '').trim();
            const hintedPageNameNormalized = normalizePageName(hintedPageName);
            const matchesHint =
                !hintedPageId && !hintedPageNameNormalized
                || (!!hintedPageId && me.id === hintedPageId)
                || (!!hintedPageNameNormalized && normalizePageName(me.name) === hintedPageNameNormalized);

            if (!matchesHint) {
                throw new Error(`stored_page_token_mismatch:${hintedPageId || hintedPageNameNormalized || 'unknown'}:${me.id}`);
            }

            const pageId = me.id || hintedPageId;
            const pageName = me.name || hintedPageName || pageId;
            const pageAvatarUrl = me.pictureUrl
                || hintedAvatarUrl
                || (pageId ? `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large` : '');

            return {
                pageToken: token,
                pageId,
                pageName,
                pageAvatarUrl,
            };
        } catch (identityErr) {
            if (identityErr instanceof Error && identityErr.message.startsWith('stored_page_token_mismatch:')) {
                throw identityErr;
            }
            throw resolveErr;
        }
    }
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

function normalizeLoginIdentifier(raw: unknown): string {
    const normalized = normalizeEmail(raw);
    return normalized === 'admin' || normalized === 'admin@browsersaving' ? ADMIN_EMAIL : normalized;
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

function isPublicApiPath(pathRaw: string): boolean {
    const path = String(pathRaw || '').trim();
    return path.startsWith('/api/auth/') || path.startsWith('/api/updates/');
}

function verifyVideoAffiliateProvisionSecret(c: any): boolean {
    const configured = String(c.env.VIDEO_AFFILIATE_TAG_SYNC_SECRET || '').trim();
    if (!configured) return false;
    const incoming = String(c.req.header('x-tag-sync-secret') || '').trim();
    return !!incoming && incoming === configured;
}

function hasTrustedVideoAffiliateAccess(c: any): boolean {
    return verifyVideoAffiliateProvisionSecret(c);
}

function isAdminEmail(raw: unknown): boolean {
    const normalized = normalizeEmail(raw);
    return normalized === ADMIN_EMAIL || normalized === 'admin@browsersaving' || normalized === 'admin';
}

function hasFullProfileAccess(c: any, authEmailRaw: unknown): boolean {
    return hasTrustedVideoAffiliateAccess(c) || isAdminEmail(authEmailRaw);
}

function getProfileOwnerScope(c: any, authEmailRaw: unknown): string {
    const authEmail = normalizeEmail(authEmailRaw);
    if (!authEmail) return '';
    return hasFullProfileAccess(c, authEmail) ? '' : authEmail;
}

function canWriteProfilesForOtherOwners(c: any, authEmail: string): boolean {
    return hasFullProfileAccess(c, authEmail);
}

function resolveProfileOwnerEmail(c: any, authEmailRaw: string, requestedOwnerEmailRaw: unknown): string | null {
    const authEmail = normalizeEmail(authEmailRaw);
    const requestedOwnerEmail = normalizeEmail(requestedOwnerEmailRaw);

    if (requestedOwnerEmail && canWriteProfilesForOtherOwners(c, authEmail)) {
        return requestedOwnerEmail;
    }

    return authEmail || requestedOwnerEmail || null;
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

async function ensureBuiltinAdminUser(db: D1Database): Promise<void> {
    const existing = await db.prepare(
        'SELECT email, password_hash, password_salt FROM bs_users WHERE email = ? LIMIT 1'
    ).bind(ADMIN_EMAIL).first<{ email?: string; password_hash?: string; password_salt?: string }>();

    const matchesConfiguredPassword = existing?.password_hash && existing?.password_salt
        ? await verifyPassword(ADMIN_PASSWORD, existing.password_salt, existing.password_hash)
        : false;

    if (matchesConfiguredPassword) return;

    const salt = randomHex(16);
    const hash = await hashPassword(ADMIN_PASSWORD, salt);

    if (existing?.email) {
        await db.prepare(
            "UPDATE bs_users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE email = ?"
        ).bind(hash, salt, ADMIN_EMAIL).run();
    } else {
        await db.prepare(
            "INSERT INTO bs_users (email, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
        ).bind(ADMIN_EMAIL, hash, salt).run();
    }
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
    const ownerScope = getProfileOwnerScope(c, authEmail);
    const fullAccess = hasFullProfileAccess(c, authEmail);
    if (!ownerScope && !fullAccess) return false;

    const includeDeleted = options.includeDeleted === true;
    const sql = ownerScope
        ? (includeDeleted
            ? "SELECT id FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            : "SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL AND lower(trim(coalesce(owner_email, ''))) = ?")
        : (includeDeleted
            ? 'SELECT id FROM profiles WHERE id = ?'
            : 'SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL');
    const row = ownerScope
        ? await c.env.DB.prepare(sql).bind(profileId, ownerScope).first<{ id?: string }>()
        : await c.env.DB.prepare(sql).bind(profileId).first<{ id?: string }>();
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

function buildVideoAffiliatePageSyncUrl(c: any): string {
    const configured = String(c.env.VIDEO_AFFILIATE_TAG_SYNC_URL || DEFAULT_VIDEO_AFFILIATE_TAG_SYNC_URL).trim();
    if (configured) return configured.replace(/\/tag-sync(?:\?.*)?$/i, '/profile-sync');
    return DEFAULT_VIDEO_AFFILIATE_TAG_SYNC_URL.replace(/\/tag-sync$/i, '/profile-sync');
}

async function pushVideoAffiliatePageSync(c: any, input: {
    profileId: string;
    pageId: string;
    pageName?: string;
    pageAvatarUrl?: string;
    accessToken: string;
    commentToken?: string;
}): Promise<{ namespaceId: string }> {
    const pageId = String(input.pageId || '').trim();
    const accessToken = normalizeToken(input.accessToken);
    const commentToken = normalizeToken(input.commentToken);
    if (!pageId || !accessToken) throw new Error('video_affiliate_page_sync_missing_required_fields');

    const authEmail = getAuthEmail(c);
    if (!authEmail) throw new Error('video_affiliate_auth_email_missing');

    let namespaceId = '';
    try {
        const workspace = await resolveVideoAffiliateWorkspaceByEmail(c, authEmail);
        if (workspace.namespaceId) namespaceId = workspace.namespaceId;
    } catch (err) {
        console.log(`[VIDEO-AFFILIATE] namespace resolve failed for ${authEmail}: ${String(err)}`);
    }
    if (!namespaceId) throw new Error('video_affiliate_namespace_not_found');

    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
    const secret = String(c.env.VIDEO_AFFILIATE_TAG_SYNC_SECRET || '').trim();
    if (secret) headers['x-tag-sync-secret'] = secret;

    const body = JSON.stringify({
        namespace_id: namespaceId,
        profile_id: String(input.profileId || '').trim() || null,
        page_id: pageId,
        page_name: String(input.pageName || '').trim() || null,
        page_avatar_url: String(input.pageAvatarUrl || '').trim() || null,
        access_token: accessToken,
        comment_token: commentToken || null,
    });

    let response: Response;
    if (c.env.VIDEO_AFFILIATE_SERVICE && typeof c.env.VIDEO_AFFILIATE_SERVICE.fetch === 'function') {
        response = await c.env.VIDEO_AFFILIATE_SERVICE.fetch('https://video-affiliate-worker/api/pages/profile-sync', {
            method: 'POST',
            headers,
            body,
        });
    } else {
        response = await fetch(buildVideoAffiliatePageSyncUrl(c), {
            method: 'POST',
            headers,
            body,
        });
    }

    const data = await response.json().catch(() => ({} as any));
    if (!response.ok || !data?.success) {
        const detail = String(data?.error || data?.details || `HTTP ${response.status}`).trim();
        throw new Error(`video_affiliate_page_sync_failed:${detail}`);
    }

    return { namespaceId };
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

app.use('/api/*', async (c, next) => {
    if (isPublicApiPath(c.req.path)) {
        await next();
        return;
    }

    if (hasTrustedVideoAffiliateAccess(c)) {
        await next();
        return;
    }

    const authEmail = getAuthEmail(c);
    const authToken = String(c.get('authToken') || '').trim();
    if (!authEmail || !authToken) {
        return c.json({ error: 'Unauthorized' }, 401);
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

app.post('/api/auth/provision-owner', async (c) => {
    if (!verifyVideoAffiliateProvisionSecret(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: any = {};
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }

    const email = normalizeEmail(body.email || '');
    const password = String(body.password || '');

    if (!isAdminLogin && !isValidEmail(email)) {
        return c.json({ error: 'Invalid email' }, 400);
    }
    if (!password || password.length < AUTH_PASSWORD_MIN_LENGTH) {
        return c.json({ error: `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters` }, 400);
    }

    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    const existing = await c.env.DB.prepare(
        'SELECT email FROM bs_users WHERE email = ? LIMIT 1'
    ).bind(email).first<{ email?: string }>();

    if (existing?.email) {
        await c.env.DB.prepare(
            "UPDATE bs_users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE email = ?"
        ).bind(hash, salt, email).run();
    } else {
        await c.env.DB.prepare(
            "INSERT INTO bs_users (email, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
        ).bind(email, hash, salt).run();
    }

    return c.json({ success: true, email, created: !existing?.email });
});

app.post('/api/auth/login', async (c) => {
    let body: any = {};
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }

    const email = normalizeLoginIdentifier(body.email || body.username || '');
    const password = String(body.password || '');
    const isAdminLogin = isAdminEmail(email);

    if (!isValidEmail(email)) {
        return c.json({ error: 'Invalid email' }, 400);
    }
    if (!password || password.length < AUTH_PASSWORD_MIN_LENGTH) {
        return c.json({ error: `Password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters` }, 400);
    }

    const db = c.env.DB;
    let accountCreated = false;
    if (isAdminLogin) {
        await ensureBuiltinAdminUser(db);
    }

    let workspace: {
        namespaceId: string;
        namespaces: string[];
        isOwner: boolean;
        isTeamMember: boolean;
    } = {
        namespaceId: '',
        namespaces: [],
        isOwner: isAdminLogin,
        isTeamMember: false,
    };
    if (!isAdminLogin) {
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
    }

    const user = await db.prepare(
        'SELECT email, password_hash, password_salt FROM bs_users WHERE email = ? LIMIT 1'
    ).bind(email).first<{ email?: string; password_hash?: string; password_salt?: string }>();

    if (!user) {
        return c.json({
            error: 'Account not provisioned',
            details: 'กรุณาให้ Owner สร้างบัญชีจากหน้าแอดมินก่อน',
        }, 403);
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

    if (!isAdminLogin) {
        await maybeClaimUnownedProfiles(db, email);
    }

    return c.json({
        success: true,
        session_token: sessionToken,
        email,
        expires_at: expiresAt,
        account_created: accountCreated,
        namespace_id: workspace.namespaceId || null,
        namespaces: workspace.namespaces,
        is_owner: workspace.isOwner,
        is_team_member: workspace.isTeamMember,
        is_admin: isAdminLogin,
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
    const ownerScope = getProfileOwnerScope(c, authEmail);
    const trustedOwnerEmails = hasTrustedVideoAffiliateAccess(c)
        ? normalizeTrustedOwnerEmailFilters([
            c.req.query('owner_email'),
            c.req.query('owner_emails'),
        ])
        : [];
    const whereParts: string[] = [];
    const binds: unknown[] = [];
    if (!includeDeleted) whereParts.push('deleted_at IS NULL');
    if (trustedOwnerEmails.length > 0) {
        whereParts.push(`lower(trim(coalesce(owner_email, ''))) IN (${trustedOwnerEmails.map(() => '?').join(',')})`);
        binds.push(...trustedOwnerEmails);
    } else if (ownerScope) {
        whereParts.push("lower(trim(coalesce(owner_email, ''))) = ?");
        binds.push(ownerScope);
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

// GET /api/profiles/name-conflicts - Find matching names that also exist in other workspaces
app.get('/api/profiles/name-conflicts', async (c) => {
    const authEmail = getAuthEmail(c);
    const query = normalizePageName(c.req.query('q') || '');

    if (!authEmail || query.length < 2) {
        return c.json([]);
    }

    const like = `%${query}%`;
    const { results } = await c.env.DB.prepare(
        `WITH current_matches AS (
            SELECT
                lower(trim(coalesce(name, ''))) AS normalized_name,
                MIN(name) AS sample_name,
                COUNT(*) AS current_count
            FROM profiles
            WHERE deleted_at IS NULL
              AND lower(trim(coalesce(owner_email, ''))) = ?
              AND lower(trim(coalesce(name, ''))) LIKE ?
            GROUP BY lower(trim(coalesce(name, '')))
        ),
        other_matches AS (
            SELECT
                lower(trim(coalesce(name, ''))) AS normalized_name,
                COUNT(*) AS other_count,
                COUNT(DISTINCT lower(trim(coalesce(owner_email, '')))) AS other_owner_count
            FROM profiles
            WHERE deleted_at IS NULL
              AND lower(trim(coalesce(owner_email, ''))) <> ''
              AND lower(trim(coalesce(owner_email, ''))) <> ?
              AND lower(trim(coalesce(name, ''))) LIKE ?
            GROUP BY lower(trim(coalesce(name, '')))
        )
        SELECT
            c.sample_name AS name,
            c.current_count AS current_count,
            o.other_count AS other_count,
            o.other_owner_count AS other_owner_count
        FROM current_matches c
        INNER JOIN other_matches o ON o.normalized_name = c.normalized_name
        ORDER BY o.other_owner_count DESC, o.other_count DESC, c.sample_name ASC
        LIMIT 10`
    ).bind(authEmail, like, authEmail, like).all<{
        name?: string;
        current_count?: number | string;
        other_count?: number | string;
        other_owner_count?: number | string;
    }>();

    return c.json(results.map((row) => ({
        name: String(row.name || '').trim(),
        current_count: Number(row.current_count || 0),
        other_count: Number(row.other_count || 0),
        other_owner_count: Number(row.other_owner_count || 0),
    })).filter((row) => row.name && row.other_count > 0 && row.other_owner_count > 0));
});

// POST /api/profiles - Create profile
app.post('/api/profiles', async (c) => {
    const body = await c.req.json();
    const authEmail = getAuthEmail(c);
    const ownerEmail = resolveProfileOwnerEmail(c, authEmail, body.owner_email);
    const accessTokenValidation = validateRoleTokenInput(body.access_token || body.comment_token, 'post', 'access_token');
    const postcronTokenValidation = validateRoleTokenInput(body.facebook_token || body.postcron_token, 'post', 'facebook_token');
    if (!accessTokenValidation.ok) return c.json({ error: accessTokenValidation.error }, 400);
    if (!postcronTokenValidation.ok) return c.json({ error: postcronTokenValidation.error }, 400);

    const accessToken = accessTokenValidation.token;
    const legacyToken = postcronTokenValidation.token;
    const nextTags = normalizeTagList(body.tags || []);

    const { results } = await c.env.DB.prepare(`
    INSERT INTO profiles (owner_email, name, proxy, homepage, notes, tags, totp_secret, uid, username, password, datr, access_token, facebook_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
        ownerEmail,
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
        accessToken,
        legacyToken
    ).all<Profile>();

    const profile = results[0];
    return c.json({
        ...profile,
        tags: JSON.parse(profile.tags || '[]'),
    });
});

// POST /api/import - Import profile with specific ID (for migration)
app.post('/api/import', async (c) => {
    const body = await c.req.json();
    const authEmail = getAuthEmail(c);
    const ownerEmail = resolveProfileOwnerEmail(c, authEmail, body.owner_email);
    const accessTokenValidation = validateRoleTokenInput(body.access_token || body.comment_token, 'post', 'access_token');
    const postcronTokenValidation = validateRoleTokenInput(body.facebook_token || body.postcron_token, 'post', 'facebook_token');
    if (!accessTokenValidation.ok) return c.json({ error: accessTokenValidation.error }, 400);
    if (!postcronTokenValidation.ok) return c.json({ error: postcronTokenValidation.error }, 400);

    const accessToken = accessTokenValidation.token;
    const legacyToken = postcronTokenValidation.token;
    const nextTags = normalizeTagList(body.tags || []);

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
    INSERT INTO profiles (id, owner_email, name, proxy, homepage, notes, tags, avatar_url, totp_secret, uid, username, password, datr, access_token, facebook_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
        body.id,
        ownerEmail,
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
        accessToken,
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
        const ownerScope = getProfileOwnerScope(c, authEmail);

        const accessTokenValidation = validateRoleTokenInput(body.access_token || body.comment_token, 'post', 'access_token');
        const postcronTokenValidation = validateRoleTokenInput(body.facebook_token || body.postcron_token, 'post', 'facebook_token');
        if (!accessTokenValidation.ok) return c.json({ error: accessTokenValidation.error }, 400);
        if (!postcronTokenValidation.ok) return c.json({ error: postcronTokenValidation.error }, 400);

        // Get existing profile
        const existing = ownerScope
            ? await c.env.DB.prepare(
                "SELECT * FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            ).bind(id, ownerScope).first<Profile>()
            : await c.env.DB.prepare(
                'SELECT * FROM profiles WHERE id = ?'
            ).bind(id).first<Profile>();

        if (!existing) {
            return c.json({ error: 'Not found' }, 404);
        }

        const requestedTags = body.tags !== undefined ? body.tags : JSON.parse(existing.tags || '[]');
        const nextTags = normalizeTagList(requestedTags);

        const nextAccessToken = (body.access_token !== undefined || body.comment_token !== undefined)
            ? accessTokenValidation.token
            : (existing.access_token ?? null);
        const nextFacebookToken = (body.facebook_token !== undefined || body.postcron_token !== undefined)
            ? postcronTokenValidation.token
            : (existing.facebook_token ?? null);

        // 🔒 Create backup snapshot before update
        await createBackup(c.env.DB, id, 'update', ownerScope);

        const updateSql = ownerScope
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
          access_token = ?,
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
          access_token = ?,
          facebook_token = ?,
          shopee_cookies = ?,
          page_name = ?,
          page_avatar_url = ?,
          updated_at = datetime('now')
        WHERE id = ?
        RETURNING *
      `;
        const updateBinds = ownerScope
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
                nextAccessToken,
                nextFacebookToken,
                body.shopee_cookies !== undefined
                    ? (body.shopee_cookies ? JSON.stringify(body.shopee_cookies) : null)
                    : (existing.shopee_cookies ?? null),
                body.page_name ?? existing.page_name ?? null,
                body.page_avatar_url ?? existing.page_avatar_url ?? null,
                id,
                ownerScope,
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
                nextAccessToken,
                nextFacebookToken,
                body.shopee_cookies !== undefined
                    ? (body.shopee_cookies ? JSON.stringify(body.shopee_cookies) : null)
                    : (existing.shopee_cookies ?? null),
                body.page_name ?? existing.page_name ?? null,
                body.page_avatar_url ?? existing.page_avatar_url ?? null,
                id
            ];
        const { results } = await c.env.DB.prepare(updateSql).bind(...updateBinds).all<Profile>();

        const profile = results[0];
        return c.json({
            ...profile,
            tags: JSON.parse(profile.tags || '[]'),
        });
    } catch (err: any) {
        console.error('PUT /api/profiles/:id error:', err);
        return c.json({ error: 'Database error', details: err?.message || String(err) }, 500);
    }
});

// POST /api/profiles/:id/move - Move profile to another workspace owner
app.post('/api/profiles/:id/move', async (c) => {
    try {
        const id = c.req.param('id');
        let body: any = {};
        try {
            body = await c.req.json();
        } catch {
            body = {};
        }

        const authEmail = normalizeEmail(getAuthEmail(c));
        if (!authEmail || !canWriteProfilesForOtherOwners(c, authEmail)) {
            return c.json({ error: 'Forbidden' }, 403);
        }

        const targetOwnerEmail = normalizeEmail(body.owner_email || body.target_owner_email || '');
        if (!targetOwnerEmail || !isValidEmail(targetOwnerEmail)) {
            return c.json({ error: 'Invalid owner_email' }, 400);
        }

        const existing = await c.env.DB.prepare(
            'SELECT * FROM profiles WHERE id = ? AND deleted_at IS NULL'
        ).bind(id).first<Profile>();

        if (!existing) {
            return c.json({ error: 'Not found' }, 404);
        }

        const currentOwnerEmail = normalizeEmail(existing.owner_email || '');
        if (currentOwnerEmail === targetOwnerEmail) {
            return c.json({
                ...existing,
                tags: JSON.parse(existing.tags || '[]'),
            });
        }

        const nameConflict = await c.env.DB.prepare(`
            SELECT id
            FROM profiles
            WHERE id <> ?
              AND deleted_at IS NULL
              AND lower(trim(coalesce(name, ''))) = ?
              AND lower(trim(coalesce(owner_email, ''))) = ?
            LIMIT 1
        `).bind(
            id,
            String(existing.name || '').trim().toLowerCase(),
            targetOwnerEmail
        ).first<{ id?: string }>();

        if (nameConflict?.id) {
            return c.json({ error: 'โปรไฟล์ชื่อนี้มีอยู่แล้วใน workspace ปลายทาง' }, 409);
        }

        await createBackup(c.env.DB, id, 'update');

        const { results } = await c.env.DB.prepare(`
            UPDATE profiles
            SET owner_email = ?, updated_at = datetime('now')
            WHERE id = ? AND deleted_at IS NULL
            RETURNING *
        `).bind(targetOwnerEmail, id).all<Profile>();

        const profile = results[0];
        if (!profile) {
            return c.json({ error: 'Move failed' }, 500);
        }

        return c.json({
            ...profile,
            tags: JSON.parse(profile.tags || '[]'),
        });
    } catch (err: any) {
        console.error('POST /api/profiles/:id/move error:', err);
        return c.json({ error: 'Database error', details: err?.message || String(err) }, 500);
    }
});

// PUT /api/profiles/:id/shopee-cookies - Update Shopee cookies only
app.put('/api/profiles/:id/shopee-cookies', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const authEmail = getAuthEmail(c);
    const ownerScope = getProfileOwnerScope(c, authEmail);

    const existing = ownerScope
        ? await c.env.DB.prepare(
            "SELECT * FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, ownerScope).first<Profile>()
        : await c.env.DB.prepare(
            'SELECT * FROM profiles WHERE id = ?'
        ).bind(id).first<Profile>();

    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }

    // Update only shopee_cookies field
    const { results } = ownerScope
        ? await c.env.DB.prepare(`
        UPDATE profiles SET
          shopee_cookies = ?,
          updated_at = datetime('now')
        WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?
        RETURNING *
    `).bind(
            body.shopee_cookies ? JSON.stringify(body.shopee_cookies) : null,
            id,
            ownerScope
        ).all<Profile>()
        : await c.env.DB.prepare(`
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
    const ownerScope = getProfileOwnerScope(c, authEmail);

    const profile = ownerScope
        ? await c.env.DB.prepare(
            "SELECT id, name, shopee_cookies FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, ownerScope).first<Profile>()
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
    const ownerScope = getProfileOwnerScope(c, authEmail);
    const existing = ownerScope
        ? await c.env.DB.prepare(
            "SELECT tags FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, ownerScope).first<{ tags?: string | null }>()
        : await c.env.DB.prepare('SELECT tags FROM profiles WHERE id = ?').bind(id).first<{ tags?: string | null }>();
    if (!existing) {
        return c.json({ error: 'Not found' }, 404);
    }
    const hadTags = normalizeTagList(existing?.tags || '[]').length > 0;

    // 🔒 Create backup snapshot before delete
    await createBackup(c.env.DB, id, 'delete', ownerScope);

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

        if (ownerScope) {
            await c.env.DB.prepare(
                "DELETE FROM profiles WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            ).bind(id, ownerScope).run();
        } else {
            await c.env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
        }
        console.log(`🗑️ Hard deleted profile: ${id}`);
    } else {
        // Soft delete - just mark as deleted
        if (ownerScope) {
            await c.env.DB.prepare(
                "UPDATE profiles SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?"
            ).bind(id, ownerScope).run();
        } else {
            await c.env.DB.prepare(
                "UPDATE profiles SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
            ).bind(id).run();
        }
        console.log(`🏷️ Soft deleted profile: ${id}`);
    }

    return c.json({ success: true, hard });
});

// POST /api/profiles/:id/restore - Restore soft-deleted profile
app.post('/api/profiles/:id/restore', async (c) => {
    const id = c.req.param('id');
    const authEmail = getAuthEmail(c);
    const ownerScope = getProfileOwnerScope(c, authEmail);

    const existing = ownerScope
        ? await c.env.DB.prepare(
            "SELECT * FROM profiles WHERE id = ? AND deleted_at IS NOT NULL AND lower(trim(coalesce(owner_email, ''))) = ?"
        ).bind(id, ownerScope).first<Profile>()
        : await c.env.DB.prepare(
            'SELECT * FROM profiles WHERE id = ? AND deleted_at IS NOT NULL'
        ).bind(id).first<Profile>();

    if (!existing) {
        return c.json({ error: 'Profile not found or not deleted' }, 404);
    }

    const { results } = ownerScope
        ? await c.env.DB.prepare(
            "UPDATE profiles SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ? RETURNING *"
        ).bind(id, ownerScope).all<Profile>()
        : await c.env.DB.prepare(
            "UPDATE profiles SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? RETURNING *"
        ).bind(id).all<Profile>();

    const profile = results[0];
    console.log(`♻️ Restored profile: ${profile.name}`);
    return c.json({
        ...profile,
        tags: JSON.parse(profile.tags || '[]'),
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
    const ownerScope = getProfileOwnerScope(c, authEmail);

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
    // Resolve access_token from snapshot (may have old postcron_token/comment_token)
    const snapshotAccessToken = normalizeToken(snapshot.access_token || snapshot.comment_token || snapshot.postcron_token) || null;

    // Create a backup of current state before restoring
    await createBackup(c.env.DB, id, 'update', ownerScope);

    const restoreSql = ownerScope
        ? `
    UPDATE profiles SET
      name = ?, proxy = ?, homepage = ?, notes = ?, tags = ?,
      avatar_url = ?, totp_secret = ?, uid = ?, username = ?, password = ?,
      datr = ?, access_token = ?, facebook_token = ?, deleted_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND lower(trim(coalesce(owner_email, ''))) = ?
    RETURNING *
  `
        : `
    UPDATE profiles SET
      name = ?, proxy = ?, homepage = ?, notes = ?, tags = ?,
      avatar_url = ?, totp_secret = ?, uid = ?, username = ?, password = ?,
      datr = ?, access_token = ?, facebook_token = ?, deleted_at = NULL, updated_at = datetime('now')
    WHERE id = ?
    RETURNING *
  `;
    const restoreBinds = ownerScope
        ? [
            snapshot.name, snapshot.proxy, snapshot.homepage, snapshot.notes,
            snapshot.tags, snapshot.avatar_url, snapshot.totp_secret,
            snapshot.uid, snapshot.username, snapshot.password,
            snapshot.datr ?? null,
            snapshotAccessToken,
            normalizeToken(snapshot.facebook_token) || null,
            id,
            ownerScope,
        ]
        : [
            snapshot.name, snapshot.proxy, snapshot.homepage, snapshot.notes,
            snapshot.tags, snapshot.avatar_url, snapshot.totp_secret,
            snapshot.uid, snapshot.username, snapshot.password,
            snapshot.datr ?? null,
            snapshotAccessToken,
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

app.get('/api/updates/manifest', async (c) => {
    const origin = new URL(c.req.url).origin;
    const latestObj = await c.env.BUCKET.get('updates/latest.json').catch(() => null);
    if (latestObj) {
        const latest = await latestObj.json<any>().catch(() => null);
        const version = String(latest?.version || '').trim();
        const notes = String(latest?.notes || '').trim();
        const pubDate = String(latest?.pub_date || latest?.published_at || '').trim() || new Date().toISOString();
        const rawPlatforms = latest && typeof latest === 'object' ? (latest.platforms || {}) as Record<string, any> : {};
        const platforms = Object.fromEntries(
            Object.entries(rawPlatforms).flatMap(([platform, entry]) => {
                const signature = String(entry?.signature || '').trim();
                const directUrl = String(entry?.url || '').trim();
                const objectKey = String(entry?.object_key || '').trim();
                const url = directUrl || (objectKey ? `${origin}/api/updates/download?key=${encodeURIComponent(objectKey)}` : '');
                if (!signature || !url) return [];
                return [[platform, { signature, url }]];
            })
        );

        if (version && Object.keys(platforms).length > 0) {
            return c.json({
                version,
                notes: notes || `BrowserSaving ${version}`,
                pub_date: pubDate,
                platforms,
            });
        }
    }

    const releaseVersion = (c.env.BROWSERSAVING_UPDATE_VERSION || '').trim();
    const releaseNotes = (
        c.env.BROWSERSAVING_UPDATE_NOTES || 'BrowserSaving update manifest'
    ).trim();
    const releaseDate = (
        c.env.BROWSERSAVING_UPDATE_NOTES_PUBLISHED ||
        new Date().toISOString()
    ).trim();
    const signatureArm64 = (c.env.BROWSERSAVING_UPDATE_DMG_SIGNATURE || '').trim();
    const signatureX64 = (c.env.BROWSERSAVING_UPDATE_DMG_SIGNATURE_X64 || '').trim();
    const urlArm64 = (c.env.BROWSERSAVING_UPDATE_DMG_URL || '').trim();
    const urlX64 = (c.env.BROWSERSAVING_UPDATE_DMG_URL_X64 || '').trim();

    if (!urlArm64 && !urlX64) {
        return c.json({ error: 'Update artifact not configured' }, 404);
    }

    return c.json({
        version: releaseVersion || '0.1.0',
        notes: releaseNotes,
        pub_date: releaseDate,
        platforms: {
            'darwin-aarch64': {
                signature: signatureArm64 || '',
                url: urlArm64 || urlX64 || '',
            },
            'darwin-x86_64': {
                signature: signatureX64 || signatureArm64 || '',
                url: urlX64 || urlArm64 || '',
            },
        },
    });
});

app.get('/api/updates/download', async (c) => {
    const key = String(c.req.query('key') || '').trim();
    if (!key || !key.startsWith('updates/')) {
        return c.json({ error: 'Invalid update key' }, 400);
    }

    const object = await c.env.BUCKET.get(key);
    if (!object) {
        return c.json({ error: 'Update artifact not found' }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=300');
    if (!headers.has('content-type')) {
        headers.set('content-type', 'application/octet-stream');
    }

    return new Response(object.body, { headers });
});

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
        console.log(`⚠️ No cookies found for ${profileId}; saving archive anyway`);
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

// GET /api/sync/:profileId/cookies - Extract cookies from R2 archive as JSON
app.get('/api/sync/:profileId/cookies', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: true });
    if (!allowed) return c.json({ error: 'Not found' }, 404);

    try {
        const cookies = await loadProfileBrowserCookies(c, profileId);
        console.log(`🍪 Extracted ${cookies.length} cookies for ${profileId}`);
        return c.json({ cookies, count: cookies.length });
    } catch (err) {
        console.error(`❌ Cookie extraction failed for ${profileId}: ${err}`);
        return c.json({ error: 'Cookie extraction failed', cookies: [], count: 0 }, 500);
    }
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

// === TOKEN API ===
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

async function saveProfileToken(c: any, profileId: string, token: string, _mode: 'post' | 'comment' = 'post') {
    const normalized = normalizeToken(token);
    if (!normalized) throw new Error('token_empty');

    await c.env.DB.prepare(
        "UPDATE profiles SET access_token = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(normalized, profileId).run();
}

async function saveLegacyPostcronToken(c: any, profileId: string, accessToken: string | null, postcronToken: string) {
    const normalizedPostcronToken = normalizeToken(postcronToken);
    if (!normalizedPostcronToken) throw new Error('postcron_token_empty');

    await c.env.DB.prepare(
        "UPDATE profiles SET access_token = ?, facebook_token = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(
        accessToken ? normalizeToken(accessToken) : null,
        normalizedPostcronToken,
        profileId
    ).run();
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadProfileForCommentToken(c: any, profileId: string): Promise<Profile | null> {
    return await c.env.DB.prepare(
        'SELECT id, name, tags, uid, username, password, totp_secret, datr, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).bind(profileId).first() as Profile | null;
}

type CommentTokenFetchResult =
    | {
        ok: true;
        profile: Profile;
        userToken: string;
        datrSource: 'profile' | 'archive' | 'none';
    }
    | {
        ok: false;
        status: number;
        body: Record<string, unknown>;
    };

async function fetchFreshCommentToken(c: any, profileId: string): Promise<CommentTokenFetchResult> {
    const profile = await loadProfileForCommentToken(c, profileId);
    if (!profile) {
        return { ok: false, status: 404, body: { error: 'Profile not found', profileId } };
    }

    const loginId = (profile.uid || profile.username || '').trim();
    if (!loginId || !profile.password) {
        return {
            ok: false,
            status: 400,
            body: {
                error: 'Missing uid/username or password in profile',
                profileId,
                profile: profile.name,
            },
        };
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
            const upstreamError = stringifyUnknown(result?.error) || `Token API failed (${response.status})`;
            return {
                ok: false,
                status: response.status >= 500 ? 502 : 400,
                body: {
                    error: upstreamError,
                    profileId,
                    profile: profile.name,
                    reason: stringifyUnknown(result?.reason) || null,
                    detail: stringifyUnknown(result?.detail || result?.error_user_msg) || null,
                },
            };
        }

        return {
            ok: true,
            profile,
            userToken,
            datrSource: datrResolved.source,
        };
    } catch (err) {
        return {
            ok: false,
            status: 500,
            body: {
                error: String(err),
                profileId,
                profile: profile.name,
            },
        };
    }
}

async function persistCommentTokenAndResolvedPage(c: any, input: {
    profileId: string;
    profileName: string;
    commentToken: string;
    resolvedPage: { pageToken: string; pageId: string; pageName: string; pageAvatarUrl: string };
}) {
    const resolvedCommentToken = normalizeToken(input.resolvedPage.pageToken);
    if (!resolvedCommentToken) throw new Error('resolved_comment_page_token_empty');

    await saveProfileToken(c, input.profileId, resolvedCommentToken, 'comment');
    await c.env.DB.prepare(
        "UPDATE profiles SET page_name = COALESCE(?, page_name), page_avatar_url = COALESCE(?, page_avatar_url), updated_at = datetime('now') WHERE id = ?"
    ).bind(
        input.resolvedPage.pageName || null,
        input.resolvedPage.pageAvatarUrl || null,
        input.profileId
    ).run();
    console.log(`🔑 ${input.profileName}: Token saved`);

    let videoAffiliateSync: { ok: boolean; namespace_id?: string; error?: string } = { ok: false };
    try {
        const synced = await pushVideoAffiliatePageSync(c, {
            profileId: input.profileId,
            pageId: input.resolvedPage.pageId,
            pageName: input.resolvedPage.pageName,
            pageAvatarUrl: input.resolvedPage.pageAvatarUrl,
            accessToken: resolvedCommentToken,
            commentToken: resolvedCommentToken,
        });
        videoAffiliateSync = { ok: true, namespace_id: synced.namespaceId };
    } catch (syncErr) {
        const message = String(syncErr || '');
        console.log(`[VIDEO-AFFILIATE] page sync failed for ${input.profileName}: ${message}`);
        videoAffiliateSync = { ok: false, error: message };
    }

    return videoAffiliateSync;
}

type PostcronTokenFetchResult = {
    ok: boolean;
    token: string | null;
    duration?: string | null;
    error?: string | null;
    reason?: string | null;
    detail?: string | null;
    pageId?: string | null;
    pageName?: string | null;
    pageAvatarUrl?: string | null;
    videoAffiliateSync?: { ok: boolean; namespace_id?: string; error?: string };
};

async function loadProfileForPostcronToken(c: any, profileId: string): Promise<Partial<Profile> | null> {
    return await c.env.DB.prepare(
        'SELECT id, name, access_token, facebook_token, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(profileId).first() as Partial<Profile> | null;
}

async function loadProfileBrowserCookies(c: any, profileId: string): Promise<any[]> {
    const key = `browser-data/${profileId}.tar.gz`;
    const object = await c.env.BUCKET.get(key);
    if (!object) return [];
    const bytes = new Uint8Array(await object.arrayBuffer());
    return extractCookiesFromTarGz(bytes);
}

async function fetchAndPersistPostcronToken(c: any, profileId: string, accessTokenOverride?: string | null): Promise<PostcronTokenFetchResult> {
    const profile = await loadProfileForPostcronToken(c, profileId);
    if (!profile?.id) {
        return { ok: false, token: null, error: 'Profile not found' };
    }

    if (!c.env.MYBROWSER) {
        return {
            ok: false,
            token: null,
            error: 'Cloudflare Browser Rendering binding is not configured',
        };
    }

    const preservedAccessToken = normalizeToken(accessTokenOverride)
        || normalizeToken(profile.access_token)
        || null;

    try {
        const startedAt = Date.now();
        const cookies = await loadProfileBrowserCookies(c, profileId);
        if (cookies.length === 0) {
            return {
                ok: false,
                token: null,
                error: 'Browser profile cookies not found',
                reason: 'browser_data_missing',
                detail: 'Upload/sync browser data before fetching Postcron token',
            };
        }

        const result = await extractPostcronToken(c.env.MYBROWSER, cookies);
        const token = normalizeToken(result?.token);
        const duration = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

        if (!token) {
            return {
                ok: false,
                token: null,
                duration,
                error: 'Cloudflare Browser Rendering failed to extract Postcron token',
                reason: stringifyUnknown(result?.reason) || 'session_expired',
                detail: stringifyUnknown(result?.detail || result?.url) || null,
            };
        }

        const resolvedPage = await resolveProfilePageToken(token, profile);
        await saveLegacyPostcronToken(c, profileId, preservedAccessToken, resolvedPage.pageToken);
        await c.env.DB.prepare(
            "UPDATE profiles SET page_name = COALESCE(?, page_name), page_avatar_url = COALESCE(?, page_avatar_url), updated_at = datetime('now') WHERE id = ?"
        ).bind(
            resolvedPage.pageName || null,
            resolvedPage.pageAvatarUrl || null,
            profileId
        ).run();

        let videoAffiliateSync: { ok: boolean; namespace_id?: string; error?: string } = { ok: false };
        try {
            const synced = await pushVideoAffiliatePageSync(c, {
                profileId,
                pageId: resolvedPage.pageId,
                pageName: resolvedPage.pageName,
                pageAvatarUrl: resolvedPage.pageAvatarUrl,
                accessToken: resolvedPage.pageToken,
                commentToken: preservedAccessToken || undefined,
            });
            videoAffiliateSync = { ok: true, namespace_id: synced.namespaceId };
        } catch (syncErr) {
            const message = String(syncErr || '');
            console.log(`[VIDEO-AFFILIATE] postcron page sync failed for ${String(profile.name || profileId)}: ${message}`);
            videoAffiliateSync = { ok: false, error: message };
        }

        return {
            ok: true,
            token: resolvedPage.pageToken,
            duration,
            pageId: resolvedPage.pageId || null,
            pageName: resolvedPage.pageName || null,
            pageAvatarUrl: resolvedPage.pageAvatarUrl || null,
            videoAffiliateSync,
        };
    } catch (err) {
        return {
            ok: false,
            token: null,
            error: String(err),
        };
    }
}

async function getStoredProfileTokens(c: any, profileId: string): Promise<{
    profileName: string;
    accessToken: string;
    postcronToken: string;
}> {
    const row = await loadProfileForPostcronToken(c, profileId);

    return {
        profileName: String(row?.name || '').trim(),
        accessToken: normalizeToken(row?.access_token) || '',
        postcronToken: normalizeToken(row?.facebook_token) || '',
    };
}

async function ensureStoredPostcronPageToken(c: any, profileId: string): Promise<{
    profileName: string;
    accessToken: string;
    postcronToken: string;
    pageId: string;
    pageName: string;
    pageAvatarUrl: string;
}> {
    const profile = await loadProfileForPostcronToken(c, profileId);
    if (!profile?.id) {
        return {
            profileName: '',
            accessToken: '',
            postcronToken: '',
            pageId: '',
            pageName: '',
            pageAvatarUrl: '',
        };
    }

    const profileName = String(profile.name || '').trim();
    const accessToken = normalizeToken(profile.access_token) || '';
    const storedPostcronToken = normalizeToken(profile.facebook_token) || '';
    if (!storedPostcronToken) {
        return {
            profileName,
            accessToken,
            postcronToken: '',
            pageId: '',
            pageName: String(profile.page_name || '').trim(),
            pageAvatarUrl: String(profile.page_avatar_url || '').trim(),
        };
    }

    try {
        const resolvedPage = await resolveStoredPageTokenForSync(storedPostcronToken, profile);
        if (resolvedPage.pageToken && resolvedPage.pageToken !== storedPostcronToken) {
            await saveLegacyPostcronToken(c, profileId, accessToken || null, resolvedPage.pageToken);
            await c.env.DB.prepare(
                "UPDATE profiles SET page_name = COALESCE(?, page_name), page_avatar_url = COALESCE(?, page_avatar_url), updated_at = datetime('now') WHERE id = ?"
            ).bind(
                resolvedPage.pageName || null,
                resolvedPage.pageAvatarUrl || null,
                profileId
            ).run();
            return {
                profileName,
                accessToken,
                postcronToken: resolvedPage.pageToken,
                pageId: resolvedPage.pageId || '',
                pageName: resolvedPage.pageName || '',
                pageAvatarUrl: resolvedPage.pageAvatarUrl || '',
            };
        }

        return {
            profileName,
            accessToken,
            postcronToken: resolvedPage.pageToken,
            pageId: resolvedPage.pageId || '',
            pageName: resolvedPage.pageName || '',
            pageAvatarUrl: resolvedPage.pageAvatarUrl || '',
        };
    } catch (err) {
        console.log(`[POSTCRON] stored token validation failed for ${profileId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const preferredHint = await resolvePreferredProfilePageHint(profile);

    return {
        profileName,
        accessToken,
        postcronToken: '',
        pageId: String(preferredHint.pageId || '').trim(),
        pageName: String(preferredHint.pageName || '').trim(),
        pageAvatarUrl: String(preferredHint.pageAvatarUrl || '').trim(),
    };
}

async function syncStoredPostcronPageTokenToVideoAffiliate(c: any, input: {
    profileId: string;
    profileName: string;
    accessToken: string;
    postcronToken: string;
    pageId: string;
    pageName: string;
    pageAvatarUrl: string;
}): Promise<{ ok: boolean; namespace_id?: string; error?: string }> {
    const pageId = String(input.pageId || '').trim();
    const postcronToken = normalizeToken(input.postcronToken);
    if (!pageId || !postcronToken) return { ok: false, error: 'page_identity_missing' };

    try {
        const synced = await pushVideoAffiliatePageSync(c, {
            profileId: input.profileId,
            pageId,
            pageName: String(input.pageName || '').trim() || pageId,
            pageAvatarUrl: String(input.pageAvatarUrl || '').trim()
                || `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`,
            accessToken: postcronToken,
            commentToken: normalizeToken(input.accessToken) || undefined,
        });
        return { ok: true, namespace_id: synced.namespaceId };
    } catch (syncErr) {
        const message = String(syncErr || '');
        console.log(`[VIDEO-AFFILIATE] stored postcron sync failed for ${input.profileName || input.profileId}: ${message}`);
        return { ok: false, error: message };
    }
}




async function handleGetToken(c: any, profileId: string) {
    const fetched = await fetchFreshCommentToken(c, profileId);
    if (!fetched.ok) {
        return c.json(fetched.body, fetched.status);
    }

    const { profile, userToken, datrSource } = fetched;

    try {
        const resolvedPage = await resolveProfilePageToken(userToken, profile);
        const videoAffiliateSync = await persistCommentTokenAndResolvedPage(c, {
            profileId,
            profileName: profile.name,
            commentToken: userToken,
            resolvedPage,
        });

        return c.json({
            success: true,
            profile: profile.name,
            profileId,
            token: resolvedPage.pageToken,
            raw_user_token: userToken,
            page_token: resolvedPage.pageToken,
            page_id: resolvedPage.pageId || null,
            page_name: resolvedPage.pageName || null,
            page_avatar_url: resolvedPage.pageAvatarUrl || null,
            datr_source: datrSource,
            savedAt: new Date().toISOString(),
            video_affiliate_sync: videoAffiliateSync,
        });
    } catch (err) {
        console.error(`❌ ${profile.name}: ${err}`);
        return c.json({
            error: `Failed to convert user token to page token via me/accounts: ${String(err)}`,
            profileId,
            profile: profile.name,
        }, 400);
    }
}

// GET /api/token/:profileId - Get access token via FB Lite API
app.get('/api/token/:profileId', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);
    return handleGetToken(c, profileId);
});

// GET /api/token/:profileId/postcron - Get and persist Postcron token while keeping access_token intact
app.get('/api/token/:profileId/postcron', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);

    const stored = await ensureStoredPostcronPageToken(c, profileId);
    if (stored.postcronToken) {
        const videoAffiliateSync = await syncStoredPostcronPageTokenToVideoAffiliate(c, {
            profileId,
            profileName: stored.profileName,
            accessToken: stored.accessToken,
            postcronToken: stored.postcronToken,
            pageId: stored.pageId,
            pageName: stored.pageName,
            pageAvatarUrl: stored.pageAvatarUrl,
        });

        return c.json({
            success: true,
            profile: stored.profileName || null,
            profileId,
            token: stored.postcronToken,
            token_source: 'saved_postcron',
            page_id: stored.pageId || null,
            page_name: stored.pageName || null,
            page_avatar_url: stored.pageAvatarUrl || null,
            video_affiliate_sync: videoAffiliateSync,
        });
    }

    const postcron = await fetchAndPersistPostcronToken(c, profileId);
    if (!postcron.ok || !postcron.token) {
        return c.json({
            success: false,
            profileId,
            token: null,
            duration: postcron.duration || null,
            error: postcron.error || 'Failed to fetch Postcron token',
            reason: postcron.reason || null,
            detail: postcron.detail || null,
        }, 400);
    }

    return c.json({
        success: true,
        profileId,
        token: postcron.token,
        duration: postcron.duration || null,
        page_id: postcron.pageId || null,
        page_name: postcron.pageName || null,
        page_avatar_url: postcron.pageAvatarUrl || null,
        video_affiliate_sync: postcron.videoAffiliateSync || null,
    });
});

// POST /api/token/:profileId/resolve - Resolve local user token, save comment token, and sync page token
app.post('/api/token/:profileId/resolve', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);

    const body = await c.req.json().catch(() => ({} as any));
    const userToken = normalizeToken(body?.user_token);
    if (!userToken) {
        return c.json({ error: 'Missing user_token', profileId }, 400);
    }

    const profile = await c.env.DB.prepare(
        'SELECT id, name, tags, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).bind(profileId).first<Profile>();

    if (!profile) {
        return c.json({ error: 'Profile not found', profileId }, 404);
    }

    try {
        // If pre-resolved page_token is provided, skip /me/accounts
        const preResolvedPageToken = normalizeToken(body?.page_token);
        let resolvedPage: { pageToken: string; pageId?: string; pageName?: string; pageAvatarUrl?: string };

        if (preResolvedPageToken) {
            // Use pre-resolved data from Windows token service
            resolvedPage = {
                pageToken: preResolvedPageToken,
                pageId: body?.page_id || profile.page_name || undefined,
                pageName: body?.page_name || profile.page_name || undefined,
                pageAvatarUrl: body?.page_avatar_url || profile.page_avatar_url || undefined,
            };
        } else {
            // Resolve via Facebook /me/accounts
            resolvedPage = await resolveProfilePageToken(userToken, profile);
        }

        const videoAffiliateSync = await persistCommentTokenAndResolvedPage(c, {
            profileId,
            profileName: profile.name,
            commentToken: preResolvedPageToken || userToken,
            resolvedPage,
        });

        return c.json({
            success: true,
            profile: profile.name,
            profileId,
            token: resolvedPage.pageToken,
            raw_user_token: userToken,
            page_token: resolvedPage.pageToken,
            token_source: preResolvedPageToken ? 'pre_resolved' : 'local_cli',
            page_id: resolvedPage.pageId || null,
            page_name: resolvedPage.pageName || null,
            page_avatar_url: resolvedPage.pageAvatarUrl || null,
            savedAt: new Date().toISOString(),
            video_affiliate_sync: videoAffiliateSync,
        });
    } catch (err) {
        console.error(`❌ ${profile.name}: ${err}`);
        return c.json({
            error: `Failed to resolve local user token: ${String(err)}`,
            profileId,
            profile: profile.name,
        }, 400);
    }
});

// Backward-compatible routes (now role-specific)
app.get('/api/postcron/:profileId/post', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);

    const stored = await ensureStoredPostcronPageToken(c, profileId);
    if (stored.postcronToken) {
        const videoAffiliateSync = await syncStoredPostcronPageTokenToVideoAffiliate(c, {
            profileId,
            profileName: stored.profileName,
            accessToken: stored.accessToken,
            postcronToken: stored.postcronToken,
            pageId: stored.pageId,
            pageName: stored.pageName,
            pageAvatarUrl: stored.pageAvatarUrl,
        });
        return c.json({
            success: true,
            profile: stored.profileName || null,
            profileId,
            token: stored.postcronToken,
            token_source: 'saved_postcron',
            page_id: stored.pageId || null,
            page_name: stored.pageName || null,
            page_avatar_url: stored.pageAvatarUrl || null,
            video_affiliate_sync: videoAffiliateSync,
        });
    }

    const postcron = await fetchAndPersistPostcronToken(c, profileId, stored.accessToken || null);
    if (!postcron.ok || !postcron.token) {
        return c.json({
            success: false,
            profile: stored.profileName || null,
            profileId,
            token: null,
            duration: postcron.duration || null,
            error: postcron.error || 'Failed to fetch Postcron token',
            reason: postcron.reason || null,
            detail: postcron.detail || null,
        }, 400);
    }

    return c.json({
        success: true,
        profile: stored.profileName || null,
        profileId,
        token: postcron.token,
        token_source: 'fresh_postcron',
        duration: postcron.duration || null,
        page_id: postcron.pageId || null,
        page_name: postcron.pageName || null,
        page_avatar_url: postcron.pageAvatarUrl || null,
        video_affiliate_sync: postcron.videoAffiliateSync || null,
    });
});

app.get('/api/postcron/:profileId/comment', async (c) => {
    const profileId = c.req.param('profileId');
    const allowed = await ensureProfileAccess(c, profileId, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found', profileId }, 404);

    const stored = await getStoredProfileTokens(c, profileId);
    if (looksLikeCommentAccessToken(stored.accessToken)) {
        return c.json({
            success: true,
            profile: stored.profileName || null,
            profileId,
            token: stored.accessToken,
            token_source: 'saved_access_token',
        });
    }

    return handleGetToken(c, profileId);
});

// GET /api/profiles/:id/page - Get Facebook Page info
app.get('/api/profiles/:id/page', async (c) => {
    const id = c.req.param('id');
    const allowed = await ensureProfileAccess(c, id, { includeDeleted: false });
    if (!allowed) return c.json({ error: 'Profile not found' }, 404);

    // Get profile with token
    const profile = await c.env.DB.prepare(
        'SELECT id, name, access_token, facebook_token, page_name, page_avatar_url FROM profiles WHERE id = ? AND deleted_at IS NULL'
    ).bind(id).first<Profile>();

    if (!profile) {
        return c.json({ error: 'Profile not found' }, 404);
    }

    const accessToken = normalizeToken(profile.access_token);
    const legacyToken = normalizeToken(profile.facebook_token);
    const graphToken = accessToken || legacyToken || '';
    if (!graphToken) {
        return c.json({
            error: 'No token',
            page_name: null,
            has_access_token: !!accessToken,
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
                stored_in_r2: !!r2ImageUrl,
                token_source: selectedToken?.role || null,
                prefer,
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

function normalizePuppeteerCookieSameSite(raw: unknown): 'Strict' | 'Lax' | 'None' | undefined {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return undefined;
    if (value === 'strict') return 'Strict';
    if (value === 'lax') return 'Lax';
    if (value === 'none' || value === 'no_restriction') return 'None';
    return undefined;
}

// Helper: Use Cloudflare Browser Rendering and extract Postcron token with injected cookies
async function extractPostcronToken(
    browserBinding: Fetcher,
    cookies: any[]
): Promise<PostcronExtractResult> {
    let browser: any = null;
    try {
        browser = await puppeteer.launch(browserBinding);
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout?.(30000);
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        );

        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

        const cookieParams = cookies.map((cookie: any) => {
            const sameSite = normalizePuppeteerCookieSameSite(cookie.same_site ?? cookie.sameSite);
            const expires = Number(cookie.expires);
            return {
                name: String(cookie.name || '').trim(),
                value: String(cookie.value || '').trim(),
                domain: String(cookie.domain || '').trim() || undefined,
                path: String(cookie.path || '/').trim() || '/',
                secure: cookie.secure ?? true,
                httpOnly: cookie.http_only ?? cookie.httpOnly ?? false,
                sameSite,
                expires: Number.isFinite(expires) && expires > 0 ? expires : undefined,
            };
        }).filter((cookie: any) => cookie.name && cookie.value && cookie.domain);

        if (cookieParams.length > 0) {
            await page.setCookie(...cookieParams);
        }
        console.log(`🍪 Injected ${cookieParams.length} cookies via Browser Rendering`);

        const inspectBarrier = async (): Promise<{
            url: string;
            checkpoint: boolean;
            login: boolean;
            security: boolean;
            automated: boolean;
            automated_keyword: string;
        }> => {
            const value = await page.evaluate(`(() => {
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
                    'we limit how often',
                ];
                let automatedKeyword = '';
                for (const keyword of autoKeywords) {
                    if (keyword && bodyText.includes(keyword.toLowerCase())) {
                        automatedKeyword = keyword;
                        break;
                    }
                }
                return {
                    url: href,
                    checkpoint: lowerUrl.includes('facebook.com/checkpoint'),
                    login: lowerUrl.includes('facebook.com/login'),
                    security: lowerUrl.includes('facebook.com/two_factor') || lowerUrl.includes('approvals_code') || lowerUrl.includes('save-device'),
                    automated: !!automatedKeyword,
                    automated_keyword: automatedKeyword,
                };
            })()`);
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
            for (let attempt = 1; attempt <= 3; attempt++) {
                const clickResult = await page.evaluate(`(() => {
                    const selectors = [
                        'div[role="button"][aria-label="ปิด"]',
                        'div[role="button"][aria-label*="ปิด"]',
                        '[role="button"][aria-label="Close"]',
                        '[role="button"][aria-label*="close" i]',
                        'button[aria-label="ปิด"]',
                        'button[aria-label="Close"]',
                    ];
                    for (const selector of selectors) {
                        const element = document.querySelector(selector);
                        if (element) {
                            const target = (element.closest && element.closest('[role="button"],button')) || element;
                            target.click();
                            return 'clicked:' + selector;
                        }
                    }
                    const all = document.querySelectorAll('div[role="button"], button, span, [aria-label]');
                    for (const element of all) {
                        const text = (element.textContent || '').trim().toLowerCase();
                        const label = ((element.getAttribute && element.getAttribute('aria-label')) || '').trim().toLowerCase();
                        if (text === 'ปิด' || text === 'close' || label === 'ปิด' || label === 'close') {
                            const target = (element.closest && element.closest('[role="button"],button')) || element;
                            target.click();
                            return 'clicked:fallback';
                        }
                    }
                    return 'not-found';
                })()`);

                console.log(`🧩 Barrier close (${phase}) attempt ${attempt}/3: ${clickResult}`);
                await sleep(2000);
                const inspected = await inspectBarrier();
                if (!inspected.checkpoint && !inspected.automated) {
                    return { ok: true, url: inspected.url, note: String(clickResult || '') };
                }
                if (clickResult === 'not-found') {
                    const failReason: PostcronExtractFailReason = inspected.checkpoint
                        ? 'facebook_checkpoint'
                        : 'facebook_automated_behavior';
                    return {
                        ok: false,
                        reason: failReason,
                        url: inspected.url,
                        note: String(clickResult || ''),
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

        const postcronUrl = 'https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook';
        await page.goto(postcronUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(5000);

        const initialInspect = await inspectBarrier();
        const initialUrl = initialInspect.url;
        const initialBarrier = classifyFacebookBarrierUrl(initialUrl);
        if (initialBarrier === 'facebook_login_required' || initialBarrier === 'facebook_security_confirmation') {
            return { token: null, reason: initialBarrier, url: initialUrl };
        }
        if (initialInspect.checkpoint || initialInspect.automated) {
            const dismissed = await dismissFacebookBarrier('initial');
            if (!dismissed.ok) {
                return {
                    token: null,
                    reason: dismissed.reason || (initialInspect.checkpoint ? 'facebook_checkpoint' : 'facebook_automated_behavior'),
                    url: dismissed.url || initialUrl,
                    detail: dismissed.detail || null,
                };
            }
        }

        await page.evaluate(`(() => {
            const selectors = [
                'div[aria-label*="ดำเนินการต่อ"]',
                'div[aria-label*="Continue"]',
                'button[name="__CONFIRM__"]',
                'input[value="Continue"]',
            ];
            for (const selector of selectors) {
                try {
                    const element = document.querySelector(selector);
                    if (element) {
                        element.click();
                        return;
                    }
                } catch {
                    // continue
                }
            }
            const buttons = document.querySelectorAll('div[role="button"], button');
            for (const button of buttons) {
                const text = button.textContent || '';
                if (text.includes('Continue') || text.includes('ดำเนินการต่อ')) {
                    button.click();
                    return;
                }
            }
        })()`);

        await sleep(5000);

        for (let attempt = 0; attempt < 5; attempt++) {
            const inspected = await inspectBarrier();
            const currentUrl = inspected.url || '';
            const barrier = classifyFacebookBarrierUrl(currentUrl);

            if (barrier === 'facebook_login_required' || barrier === 'facebook_security_confirmation') {
                return { token: null, reason: barrier, url: currentUrl };
            }
            if (inspected.checkpoint || inspected.automated) {
                const dismissed = await dismissFacebookBarrier(`loop-${attempt + 1}`);
                if (!dismissed.ok) {
                    return {
                        token: null,
                        reason: dismissed.reason || (inspected.checkpoint ? 'facebook_checkpoint' : 'facebook_automated_behavior'),
                        url: dismissed.url || currentUrl,
                        detail: dismissed.detail || null,
                    };
                }
                if (attempt < 4) await sleep(1500);
                continue;
            }

            const tokenMatch = currentUrl.match(/access_token=([^&]+)/);
            if (tokenMatch) {
                const token = decodeURIComponent(tokenMatch[1]);
                console.log(`🔑 Postcron token found: ${token.substring(0, 20)}...`);
                return { token, reason: null, url: currentUrl };
            }

            if (attempt < 4) await sleep(2000);
        }

        const finalInspect = await inspectBarrier();
        const finalReason: PostcronExtractFailReason =
            finalInspect.checkpoint
                ? 'facebook_checkpoint'
                : finalInspect.automated
                    ? 'facebook_automated_behavior'
                    : classifyFacebookBarrierUrl(finalInspect.url) || 'session_expired';
        return {
            token: null,
            reason: finalReason,
            url: finalInspect.url || null,
            detail: finalInspect.automated_keyword || null,
        };
    } finally {
        if (browser) {
            await browser.close().catch(() => null);
        }
    }
}

// Root
app.get('/', (c) => {
    return c.text('🚀 BrowserSaving API (Cloudflare Worker)');
});

export default app;
