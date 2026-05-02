// Feed Ad Creator — service worker (headless).
//
// No UI: extension runs entirely behind dashboard.oomnn.com/feed. The dashboard
// page is the only thing the operator interacts with. This worker just:
//   1. Receives 'feedExt.createAd' messages forwarded by content_script bridge.js
//   2. Reads the operator's settings (sub_id, ad_account, template_adset) from
//      api.oomnn.com so dashboard /feed/settings stays the source of truth
//   3. Shortens the Shopee URL via short.wwoom.com (with affiliate-tab fallback)
//   4. Pulls window.__accessToken + cookies out of the operator's logged-in
//      Ads Manager tab via chrome.scripting.executeScript({ world: 'MAIN' })
//      — same trick the Electron BrowserWindow used, just inside Chrome
//   5. Runs the full FB Graph pipeline in that page's context (cookies attach
//      automatically, anti-bot validators see calls coming from facebook.com)
//   6. Logs the result to api.oomnn.com so post_history matches what cron sees

// ────────────────────── Constants ──────────────────────

// History: this constant used to point at ฉ่ำ (page id 116759241338040).
// User switched the extension target to ฉ่ำ on 2026-05-02. Behaviour is
// identical — only the page id literal changed.
const FEED_PAGE_ID = '114142457961643'           // เพจ ฉ่ำ
const FEED_PAGE_NAME = 'ฉ่ำ'

const WORKER_BASE = 'https://api.oomnn.com'
const SHORTLINK_BASE = 'https://short.wwoom.com'

const DEFAULT_AD_ACCOUNT = 'act_1030797047648459'
const DEFAULT_TEMPLATE_ADSET = '120244389710100263'

const ADS_MANAGER_TAB_PATTERNS = [
    'https://adsmanager.facebook.com/*',
    'https://www.facebook.com/adsmanager/*',
    'https://business.facebook.com/adsmanager/*',
]

const SHOPEE_TAB_PATTERN = 'https://affiliate.shopee.co.th/*'

// ────────────────────── Message bus ──────────────────────
//
// Only one entry point: 'feedExt.createAd'. Everything the extension does
// (settings load, shortlink, pipeline, log) is folded into this one handler so
// the dashboard side stays a single round-trip.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'feedExt.createAd') {
        runCreateAdPipeline(msg.payload || {})
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }))
        return true
    }
    if (msg?.type === 'feedExt.listCampaigns') {
        runListCampaigns(msg.payload || {})
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }))
        return true
    }
    if (msg?.type === 'feedExt.status') {
        runStatusCheck(msg.payload || {})
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }))
        return true
    }
    return false
})

// ────────────────────── Status / readiness check ──────────────────────
//
// Mirrors what the Electron app exposes via /token /session /pages, but for
// our Chrome flow:
//   - Is there an Ads Manager tab open?
//   - Does that tab have window.__accessToken + DTSGInitData + c_user?
//   - Can we hit graph.facebook.com/{adAccount} with that token? (catches the
//     "ad account not in this user's permissions" case before the user clicks
//     สร้างแอด and waits 80s for the pipeline to fail at /campaigns)
//   - Is there a Shopee Affiliate tab open? (only matters for shortlink_provider='extension')

async function runStatusCheck({ adAccount }) {
    const settings = await loadFeedSettings().catch(() => null)
    const effAdAccount = String(adAccount || settings?.ad_account || DEFAULT_AD_ACCOUNT).trim()
    const effTemplateAdset = String(settings?.template_adset || DEFAULT_TEMPLATE_ADSET).trim()

    const adsTabs = await findTabsByPatterns(ADS_MANAGER_TAB_PATTERNS)
    const shopeeTab = await findTabByPattern(SHOPEE_TAB_PATTERN)

    let inspect = null
    if (adsTabs[0]) {
        try {
            const exec = await chrome.scripting.executeScript({
                target: { tabId: adsTabs[0].id },
                world: 'MAIN',
                func: fbInspectMainWorld,
                args: [{ adAccount: effAdAccount, templateAdset: effTemplateAdset }],
            })
            inspect = exec?.[0]?.result || { error: 'pipeline_no_result' }
        } catch (e) {
            inspect = { error: e?.message || String(e) }
        }
    }

    return {
        ok: true,
        version: chrome.runtime.getManifest().version,
        page_id: FEED_PAGE_ID,
        page_name: FEED_PAGE_NAME,
        ads_manager_tab: adsTabs[0]
            ? { url: adsTabs[0].url, title: adsTabs[0].title || '', status: adsTabs[0].status }
            : null,
        shopee_tab: shopeeTab
            ? { url: shopeeTab.url, title: shopeeTab.title || '', status: shopeeTab.status }
            : null,
        inspect,
        ad_account: effAdAccount,
        template_adset: effTemplateAdset,
        settings_loaded: !!settings,
        shortlink_provider: settings?.shortlink_provider || 'api',
    }
}

// Runs INSIDE Ads Manager tab (MAIN world). Reads creds + does a cheap
// graph.facebook.com smoke test to verify the ad_account is reachable from
// this user's session. Reports presence + truncated tail (no full token).
async function fbInspectMainWorld({ adAccount, templateAdset }) {
    const accessToken = window.__accessToken || ''
    // fb_dtsg detection across multiple FB UI versions. Not strictly required
    // by our pipeline (we use access_token in the URL) — informational only.
    let fbDtsg = ''
    try {
        const candidates = [
            window.DTSGInitData?.token,
            window.DTSGInitialData?.token,
            window.__DTSGInitData?.token,
            window.__bbox?.define?.['DTSGInitData']?.token,
        ].filter(Boolean)
        if (candidates.length > 0) fbDtsg = String(candidates[0])
        if (!fbDtsg) {
            const html = document.documentElement.outerHTML || ''
            const patterns = [
                /"dtsg":\{"token":"([^"]+)"/,
                /"DTSGInitData",\[\],\{"token":"([^"]+)"/,
                /"asyncSignal":"[^"]*","dtsg":\{"token":"([^"]+)"/,
                /name="fb_dtsg" value="([^"]+)"/,
            ]
            for (const p of patterns) {
                const m = html.match(p)
                if (m) { fbDtsg = m[1]; break }
            }
        }
    } catch { /* ignore */ }
    const cuserMatch = (document.cookie || '').match(/c_user=(\d+)/)
    const cuser = cuserMatch ? cuserMatch[1] : ''
    const cookieCount = (document.cookie || '').split(';').filter(Boolean).length

    let adAccountStatus = { tested: false }
    let pageAccessOk = { tested: false }
    let promotableLinkage = { tested: false }
    if (accessToken && adAccount) {
        try {
            const r = await fetch(
                `https://graph.facebook.com/v21.0/${adAccount}?fields=id,name,account_status,currency&access_token=${encodeURIComponent(accessToken)}`,
                { credentials: 'include' }
            )
            const j = await r.json().catch(() => ({}))
            if (j?.error) {
                adAccountStatus = { tested: true, ok: false, error: String(j.error.message || ''), code: j.error.code, fb_trace_id: j.error.fbtrace_id }
            } else {
                adAccountStatus = { tested: true, ok: true, id: j.id, name: j.name, account_status: j.account_status, currency: j.currency }
            }
        } catch (e) {
            adAccountStatus = { tested: true, ok: false, error: e?.message || String(e) }
        }
        try {
            const r = await fetch(
                `https://graph.facebook.com/v21.0/114142457961643?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
                { credentials: 'include' }
            )
            const j = await r.json().catch(() => ({}))
            if (j?.error) {
                pageAccessOk = { tested: true, ok: false, error: String(j.error.message || ''), code: j.error.code }
            } else {
                pageAccessOk = { tested: true, ok: true, id: j.id, name: j.name }
            }
        } catch (e) {
            pageAccessOk = { tested: true, ok: false, error: e?.message || String(e) }
        }
        // ── promotable_pages — the test that actually catches FB code=10 at
        // /adcreatives. Even when both ad_account + page can be READ, FB
        // refuses to create a creative referencing both unless they're linked
        // in Business Manager. promotable_pages returns exactly the set that
        // a creative on this ad_account is allowed to reference.
        try {
            const r = await fetch(
                `https://graph.facebook.com/v21.0/${adAccount}/promote_pages?fields=id,name&limit=200&access_token=${encodeURIComponent(accessToken)}`,
                { credentials: 'include' }
            )
            const j = await r.json().catch(() => ({}))
            if (j?.error) {
                promotableLinkage = { tested: true, ok: false, error: String(j.error.message || ''), code: j.error.code }
            } else {
                const pages = Array.isArray(j?.data) ? j.data : []
                const feedInList = pages.find((p) => String(p?.id || '') === '114142457961643')
                promotableLinkage = {
                    tested: true,
                    ok: !!feedInList,
                    total_pages: pages.length,
                    feed_in_promotable: !!feedInList,
                    sample: pages.slice(0, 5).map((p) => ({ id: p.id, name: p.name })),
                }
            }
        } catch (e) {
            promotableLinkage = { tested: true, ok: false, error: e?.message || String(e) }
        }
    }

    // Template adset must live in the SAME ad_account we're creating ads for —
    // FB's /copies endpoint refuses cross-account adset copies with code=100
    // "Invalid parameter". This is the most common cause for ฉ่ำ failing at
    // step 'copy' when the operator's template_adset was originally created
    // for the เฉียบ ad account.
    let templateAdsetCheck = { tested: false }
    if (accessToken && templateAdset) {
        try {
            const r = await fetch(
                `https://graph.facebook.com/v21.0/${templateAdset}?fields=id,name,account_id,status,campaign{id,name,objective,buying_type}&access_token=${encodeURIComponent(accessToken)}`,
                { credentials: 'include' }
            )
            const j = await r.json().catch(() => ({}))
            if (j?.error) {
                templateAdsetCheck = { tested: true, ok: false, error: String(j.error.message || ''), code: j.error.code }
            } else {
                const tplAccount = String(j.account_id || '').trim()
                const cleanAdAccount = String(adAccount || '').replace(/^act_/, '').trim()
                const matches = tplAccount === cleanAdAccount
                templateAdsetCheck = {
                    tested: true,
                    ok: matches,
                    template_id: j.id,
                    template_name: j.name || '',
                    template_account_id: tplAccount,
                    expected_account_id: cleanAdAccount,
                    status: j.status,
                    objective: j?.campaign?.objective || '',
                    buying_type: j?.campaign?.buying_type || '',
                    parent_campaign_name: j?.campaign?.name || '',
                }
            }
        } catch (e) {
            templateAdsetCheck = { tested: true, ok: false, error: e?.message || String(e) }
        }
    }

    return {
        access_token_present: !!accessToken,
        access_token_len: accessToken.length,
        access_token_tail: accessToken ? accessToken.slice(-6) : '',
        fb_dtsg_present: !!fbDtsg,
        fb_dtsg_len: fbDtsg.length,
        c_user: cuser,
        cookie_count: cookieCount,
        page_url: window.location.href,
        ad_account_status: adAccountStatus,
        page_access_ok: pageAccessOk,
        promotable_linkage: promotableLinkage,
        template_adset_check: templateAdsetCheck,
    }
}

// ────────────────────── Campaign list ──────────────────────
//
// Replaces the worker's /api/dashboard/campaigns proxy for ฉ่ำ — that proxy
// hits Electron's /graph endpoint, which uses the Electron user's session.
// For ฉ่ำ the operator may have a different ad_account whose campaigns the
// Electron session can't see. Instead we read campaigns from inside the user's
// own Ads Manager tab (same place the create-ad pipeline reads tokens).

async function runListCampaigns({ adAccount }) {
    const settings = await loadFeedSettings().catch(() => null)
    const effAdAccount = String(adAccount || settings?.ad_account || DEFAULT_AD_ACCOUNT).trim()

    const adsTabs = await findTabsByPatterns(ADS_MANAGER_TAB_PATTERNS)
    if (!adsTabs.length) {
        return { ok: false, error: 'ไม่มี tab Ads Manager เปิดอยู่ — เปิด adsmanager.facebook.com ก่อน' }
    }

    const exec = await chrome.scripting.executeScript({
        target: { tabId: adsTabs[0].id },
        world: 'MAIN',
        func: fbListCampaignsMainWorld,
        args: [{ adAccount: effAdAccount }],
    })

    const result = exec?.[0]?.result
    if (!result) return { ok: false, error: 'pipeline ไม่ตอบกลับ' }
    return result
}

async function fbListCampaignsMainWorld({ adAccount }) {
    const accessToken = window.__accessToken
    if (!accessToken) return { ok: false, error: 'ไม่พบ window.__accessToken — refresh tab Ads Manager' }

    const fbFetch = async (url) => {
        const r = await fetch(url, { credentials: 'include' })
        const t = await r.text()
        try { return JSON.parse(t) } catch { return { __raw: t } }
    }

    // Pull `value` for action_type='link_click' out of the FB insights
    // cost_per_action_type array. That's the same number Ads Manager UI
    // shows as 'ต้นทุนต่อการคลิกลิงก์'.
    const pickCostPerAction = (insights, actionType) => {
        const arr = Array.isArray(insights?.cost_per_action_type) ? insights.cost_per_action_type : []
        const hit = arr.find((entry) => String(entry?.action_type || '').trim() === actionType)
        return hit ? String(hit.value || '') : ''
    }

    // Pull more than the visible limit (10) so after we filter out paused
    // /archived/etc. we still have enough ACTIVE campaigns to show. Operator
    // wants only ACTIVE in the create-ad picker — paused ones just clutter
    // the list (same FB UX as Ads Manager's 'Active' filter).
    const camp = await fbFetch(`https://graph.facebook.com/v21.0/${adAccount}/campaigns?fields=id,name,effective_status,daily_budget,start_time&limit=30&access_token=${encodeURIComponent(accessToken)}`)
    if (camp?.error) return { ok: false, error: `[campaigns] ${camp.error.message}`, fb_error_code: camp.error.code }
    const allCampaigns = Array.isArray(camp?.data) ? camp.data : []
    const campaigns = allCampaigns.filter((c) => String(c?.effective_status || '').trim() === 'ACTIVE').slice(0, 10)

    const result = []
    for (const c of campaigns) {
        const adsets = await fbFetch(`https://graph.facebook.com/v21.0/${c.id}/adsets?fields=id,effective_status&limit=50&access_token=${encodeURIComponent(accessToken)}`)
        const aArr = Array.isArray(adsets?.data) ? adsets.data : []
        const liveAdsets = aArr.filter((a) => a.effective_status !== 'DELETED' && a.effective_status !== 'ARCHIVED')

        // Insights — same shape as worker /api/dashboard/campaigns.
        const ins = await fbFetch(`https://graph.facebook.com/v21.0/${c.id}/insights?fields=spend,cost_per_action_type,actions&date_preset=lifetime&access_token=${encodeURIComponent(accessToken)}`)
        const insRow = Array.isArray(ins?.data) ? (ins.data[0] || {}) : {}

        result.push({
            id: c.id,
            name: c.name || c.id,
            status: c.effective_status || 'UNKNOWN',
            adsetCount: liveAdsets.length,
            costPerLinkClick: pickCostPerAction(insRow, 'link_click'),
        })
    }

    return { ok: true, campaigns: result, ad_account: adAccount }
}

// ────────────────────── Worker settings (per-page) ──────────────────────

async function loadFeedSettings() {
    const url = `${WORKER_BASE}/api/dashboard/settings?page_id=${encodeURIComponent(FEED_PAGE_ID)}`
    const r = await fetch(url, { method: 'GET' })
    if (!r.ok) throw new Error(`โหลด settings ของฉ่ำจาก worker ไม่สำเร็จ (HTTP ${r.status})`)
    const d = await r.json()
    // shortlink_provider toggles between two strict modes:
    //   'api'        → only short.wwoom.com (no fallback)
    //   'extension'  → only affiliate.shopee.co.th tab (no fallback)
    // Anything unrecognized → 'api' (matches the historical behaviour).
    const provider = String(d.shortlink_provider || '').trim().toLowerCase() === 'extension' ? 'extension' : 'api'
    return {
        sub_id: String(d.sub_id || ''),
        sub_id2: String(d.sub_id2 || ''),
        sub_id3: String(d.sub_id3 || ''),
        sub_id4: String(d.sub_id4 || ''),
        sub_id5: String(d.sub_id5 || ''),
        shortlink_url: String(d.shortlink_url || `${SHORTLINK_BASE}/?account=CHEARB&url={url}&sub1={sub_id}`),
        shortlink_provider: provider,
        ad_account: String(d.ad_account || DEFAULT_AD_ACCOUNT),
        template_adset: String(d.template_adset || DEFAULT_TEMPLATE_ADSET),
        // Comment template — used by Step 8 ของ pipeline (post first comment with
        // shortlink). Earlier versions forgot to forward this field, so even
        // when DB had a value the pipeline saw 'empty' and skipped the comment.
        comment_template: String(d.comment_template || ''),
    }
}

// ────────────────────── Shopee shortening ──────────────────────
//
// `provider` is set per-page in dashboard /feed Settings → "ย่อลิงก์ผ่าน":
//   'api'       → call short.wwoom.com (commission to CHEARB account)
//   'extension' → call affiliate.shopee.co.th GraphQL via the user's logged-in
//                 Shopee tab (commission to user's own Shopee Affiliate account)
//
// Each mode is strict: no silent fallback to the other provider. If wwoom
// fails in 'api' mode we surface the error so the operator knows wwoom is
// down rather than getting an unexpected commission split. Same for extension
// mode if the Shopee tab isn't logged in.

async function shortenShopee({ provider, shopeeUrl, subId, subId2, subId3, subId4, subId5, shortlinkUrlTemplate }) {
    const url = String(shopeeUrl || '').trim()
    if (!url) throw new Error('ไม่มี shopee URL')
    const mode = provider === 'extension' ? 'extension' : 'api'

    // ── extension mode: direct GraphQL via Shopee Affiliate tab ──
    if (mode === 'extension') {
        const shopeeTab = await findTabByPattern(SHOPEE_TAB_PATTERN)
        if (!shopeeTab) {
            throw new Error('โหมด Extension: ต้องเปิด tab https://affiliate.shopee.co.th/ ค้างไว้ + login บัญชี Shopee Affiliate ของพี่')
        }
        const advancedLinkParams = {}
        if (subId) advancedLinkParams.subId1 = String(subId)
        if (subId2) advancedLinkParams.subId2 = String(subId2)
        if (subId3) advancedLinkParams.subId3 = String(subId3)
        if (subId4) advancedLinkParams.subId4 = String(subId4)
        if (subId5) advancedLinkParams.subId5 = String(subId5)
        const gqlBody = {
            operationName: 'batchGetCustomLink',
            query: 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }',
            variables: { linkParams: [{ originalLink: url, advancedLinkParams }], sourceCaller: 'CUSTOM_LINK_CALLER' },
        }
        const results = await chrome.scripting.executeScript({
            target: { tabId: shopeeTab.id },
            world: 'MAIN',
            func: shopeePageXhr,
            args: ['https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink', gqlBody],
        })
        const result = results?.[0]?.result
        if (!result) throw new Error('โหมด Extension: Shopee tab ไม่ตอบกลับ — ลอง refresh tab affiliate.shopee.co.th')
        if (!result.ok) throw new Error(`โหมด Extension: ${result.error || 'Shopee shortening ไม่สำเร็จ'}`)
        return { source: 'shopee_tab', shortLink: cleanShortLink(result.shortLink) }
    }

    // ── api mode (default): short.wwoom.com ──
    const tpl = String(shortlinkUrlTemplate || '').trim()
        || `${SHORTLINK_BASE}/?account=CHEARB&url={url}&sub1={sub_id}&sub2={sub_id2}&sub3={sub_id3}&sub4={sub_id4}&sub5={sub_id5}`
    const built = tpl
        .replace('{url}', encodeURIComponent(url))
        .replace('{sub_id}', encodeURIComponent(String(subId || '')))
        .replace('{sub_id2}', encodeURIComponent(String(subId2 || '')))
        .replace('{sub_id3}', encodeURIComponent(String(subId3 || '')))
        .replace('{sub_id4}', encodeURIComponent(String(subId4 || '')))
        .replace('{sub_id5}', encodeURIComponent(String(subId5 || '')))

    let lastError = ''
    try {
        const r = await fetch(built, { method: 'GET' })
        if (r.ok) {
            const j = await r.json().catch(() => ({}))
            const sl = String(j.shortLink || j.short_link || '').trim()
            if (sl) return { source: 'wwoom', shortLink: cleanShortLink(sl) }
            lastError = `wwoom ตอบ HTTP 200 แต่ไม่มี shortLink ใน response`
        } else {
            lastError = `wwoom ตอบ HTTP ${r.status}`
        }
    } catch (e) {
        lastError = `เชื่อมต่อ wwoom ไม่ได้: ${e?.message || e}`
    }
    throw new Error(`โหมด API: ${lastError} — สลับเป็น "Extension" ใน Settings ถ้า wwoom พังต่อเนื่อง`)
}

function cleanShortLink(s) {
    return String(s || '').trim().replace(/\?lp=aff$/, '').replace(/&lp=aff$/, '')
}

// Runs INSIDE Shopee Affiliate page (MAIN world). XHR (not fetch) so the
// anti-bot SDK interceptors auto-attach x-sap-sec, af-ac-enc-dat, etc.
function shopeePageXhr(endpoint, body) {
    return new Promise((resolve) => {
        try {
            const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/)
            const csrfToken = csrfMatch ? csrfMatch[1] : ''
            const xhr = new XMLHttpRequest()
            xhr.open('POST', endpoint, true)
            xhr.withCredentials = true
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8')
            xhr.setRequestHeader('affiliate-program-type', '1')
            if (csrfToken) xhr.setRequestHeader('csrf-token', csrfToken)
            xhr.onload = () => {
                try {
                    if (xhr.status !== 200) {
                        resolve({ ok: false, error: `Shopee API ${xhr.status}: ${xhr.responseText.slice(0, 200)}` })
                        return
                    }
                    const data = JSON.parse(xhr.responseText)
                    const links = data?.data?.batchCustomLink
                    if (!links?.length) { resolve({ ok: false, error: 'Shopee ไม่ส่งผลลัพธ์กลับมา' }); return }
                    const link = links[0]
                    if (link.failCode && link.failCode !== 0) { resolve({ ok: false, error: `Shopee error code: ${link.failCode}` }); return }
                    if (!link.shortLink) { resolve({ ok: false, error: 'ไม่ได้ short link กลับมา' }); return }
                    resolve({ ok: true, shortLink: link.shortLink })
                } catch (err) { resolve({ ok: false, error: 'อ่านผลลัพธ์จาก Shopee ไม่ได้: ' + err.message }) }
            }
            xhr.onerror = () => resolve({ ok: false, error: 'เชื่อมต่อ Shopee API ไม่ได้' })
            xhr.ontimeout = () => resolve({ ok: false, error: 'Shopee API ไม่ตอบกลับ (timeout)' })
            xhr.timeout = 15000
            xhr.send(JSON.stringify(body))
        } catch (err) { resolve({ ok: false, error: err.message || String(err) }) }
    })
}

// ────────────────────── Ad creation pipeline ──────────────────────

async function runCreateAdPipeline(payload) {
    const {
        videoUrl, videoId, caption, shopeeUrl,
        campaignId, newCampaignName,
        adAccount, templateAdset,
        thumbnailUrl,
        subId2: overrideSub2, subId3: overrideSub3,
        subId4: overrideSub4, subId5: overrideSub5,
    } = payload || {}

    if (!caption) return { ok: false, step: 'validate', error: 'ไม่มี caption' }
    if (!videoUrl && !videoId) return { ok: false, step: 'validate', error: 'ต้องใส่ video_url หรือ video_id' }
    if (!campaignId && !newCampaignName) return { ok: false, step: 'validate', error: 'ต้องเลือก campaign_id หรือ new_campaign_name' }

    // 1. Settings (always re-read so dashboard /feed/settings stays source of truth)
    const settings = await loadFeedSettings().catch((e) => ({ __err: e?.message || String(e) }))
    if (settings?.__err) return { ok: false, step: 'settings', error: settings.__err }

    const effAdAccount = String(adAccount || settings.ad_account || DEFAULT_AD_ACCOUNT).trim()
    const effTemplateAdset = String(templateAdset || settings.template_adset || DEFAULT_TEMPLATE_ADSET).trim()

    // 2. Shorten shopee → goes into caption + CTA + comment (matches Electron format)
    let shortLink = ''
    const shopeeLink = String(shopeeUrl || '').trim()
    if (shopeeLink) {
        try {
            // Per-ad override (passed in from popup) wins over per-page settings.
            // Empty override = fall back to settings.sub_id2-5 default.
            const sl = await shortenShopee({
                provider: settings.shortlink_provider,    // 'api' | 'extension', strict per mode
                shopeeUrl: shopeeLink,
                subId: settings.sub_id,
                subId2: String(overrideSub2 || '').trim() || settings.sub_id2,
                subId3: String(overrideSub3 || '').trim() || settings.sub_id3,
                subId4: String(overrideSub4 || '').trim() || settings.sub_id4,
                subId5: String(overrideSub5 || '').trim() || settings.sub_id5,
                shortlinkUrlTemplate: settings.shortlink_url,
            })
            shortLink = sl.shortLink
        } catch (e) {
            return { ok: false, step: 'shortlink', error: e.message || String(e), provider: settings.shortlink_provider }
        }
    }
    if (!shortLink) return { ok: false, step: 'shortlink', error: 'ย่อลิงก์ Shopee ไม่สำเร็จ — เช็คว่า shopee URL ถูก + เช็คโหมด API/Extension ใน Settings' }

    // 3. Build final caption (matches video-onecard electron format)
    // Caption matches cron post format — operator's caption verbatim, no
    // shortlink prefix. The shortlink lives in the first comment (step 8) +
    // the ad CTA button only, so the page feed post reads identical to
    // every other cron-driven post on the page.
    const finalCaption = caption

    // 4. Find Ads Manager tab — required because window.__accessToken + session
    //    cookies live there. No tab → no token → can't call graph.
    const adsTabs = await findTabsByPatterns(ADS_MANAGER_TAB_PATTERNS)
    if (!adsTabs.length) {
        return { ok: false, step: 'ads_manager_tab', error: 'ไม่มี tab Ads Manager เปิดอยู่ — เปิด adsmanager.facebook.com แล้วลองใหม่ (ต้อง login บัญชีที่มี admin บนเพจฉ่ำ)' }
    }

    // Build comment text (matches Electron's worker comment step). Reads
    // settings.comment_template (per-page) and replaces {shopee_link} with
    // the wwoom shortLink. Empty template = silent skip.
    const commentTemplate = String(settings.comment_template || '').trim()
    const commentText = commentTemplate && shortLink
        ? commentTemplate.replace(/\{shopee_link\}/g, shortLink)
        : ''

    // 5. Run pipeline IN-PLACE in Ads Manager tab (MAIN world)
    const pipelineArgs = {
        pageId: FEED_PAGE_ID,
        videoId: String(videoId || ''),
        videoUrl: String(videoUrl || ''),
        caption: finalCaption,
        ctaLink: shortLink,
        adAccount: effAdAccount,
        templateAdset: effTemplateAdset,
        campaignId: String(campaignId || ''),
        newCampaignName: String(newCampaignName || ''),
        thumbnailUrl: String(thumbnailUrl || ''),
        commentText,
    }

    const exec = await chrome.scripting.executeScript({
        target: { tabId: adsTabs[0].id },
        world: 'MAIN',
        func: fbAdPipelineMainWorld,
        args: [pipelineArgs],
    })

    const result = exec?.[0]?.result
    if (!result) return { ok: false, step: 'pipeline', error: 'pipeline ไม่ตอบกลับ — Ads Manager tab อาจถูกปิด' }
    if (!result.ok) return { ...result, short_link: shortLink, shopee_link: shopeeLink, page_name: FEED_PAGE_NAME }

    // 6. Log to worker (post_history insert + mark video as posted in namespace_video_state)
    let logged = null
    try {
        const logResp = await fetch(`${WORKER_BASE}/api/dashboard/extension-ad-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                page_id: FEED_PAGE_ID,
                video_id: result.video_id || videoId || '',
                story_id: result.story_id,
                ad_id: result.ad_id,
                adset_id: result.adset_id,
                creative_id: result.creative_id,
                shopee_link: shopeeLink,
                short_link: shortLink,
                comment_id: result.comment_id || '',
            }),
        })
        logged = await logResp.json().catch(() => null)
    } catch (e) {
        logged = { ok: false, error: e?.message || String(e) }
    }

    return {
        ok: true,
        ...result,
        page_id: FEED_PAGE_ID,
        page_name: FEED_PAGE_NAME,
        short_link: shortLink,
        shopee_link: shopeeLink,
        final_caption: finalCaption,
        logged,
    }
}

// ────────────────────── MAIN-world: full FB pipeline ──────────────────────
//
// Runs INSIDE the Ads Manager tab. Has access to:
//   - window.__accessToken (user-scoped, written by FB on adsmanager pages)
//   - session cookies for facebook.com → graph.facebook.com (via fetch credentials)
//   - The same security context the Ads Manager UI itself uses
//
// All arguments are serialized — must pass primitives only.

async function fbAdPipelineMainWorld(args) {
    const { pageId, videoId, videoUrl, caption, ctaLink, adAccount, templateAdset, campaignId, newCampaignName, thumbnailUrl, commentText } = args

    const accessToken = window.__accessToken
    if (!accessToken) {
        return { ok: false, step: 'token', error: 'ไม่พบ window.__accessToken — refresh หน้า Ads Manager แล้วลองใหม่ (login ยังอยู่ไหม?)' }
    }

    const fbFetch = async (url, init = {}) => {
        const resp = await fetch(url, { credentials: 'include', ...init })
        const txt = await resp.text()
        let json = null
        try { json = txt ? JSON.parse(txt) : null } catch { /* ignore */ }
        return { status: resp.status, json, text: txt }
    }

    // ── Step 0: read template CTA type (so new ads inherit operator's CTA setting) ──
    let ctaType = 'SHOP_NOW'
    try {
        const tplAds = await fbFetch(`https://graph.facebook.com/v21.0/${templateAdset}/ads?fields=creative{id}&limit=1&access_token=${encodeURIComponent(accessToken)}`)
        const tplCreativeId = tplAds.json?.data?.[0]?.creative?.id
        if (tplCreativeId) {
            const tplCr = await fbFetch(`https://graph.facebook.com/v21.0/${tplCreativeId}?fields=call_to_action_type&access_token=${encodeURIComponent(accessToken)}`)
            if (tplCr.json?.call_to_action_type) ctaType = String(tplCr.json.call_to_action_type).trim()
        }
    } catch { /* keep fallback */ }

    // ── Step 1: upload video (if video_url) or reuse existing video_id ──
    let vidId = videoId
    if (!vidId && videoUrl) {
        const r = await fbFetch(
            `https://graph.facebook.com/v21.0/${adAccount}/advideos?access_token=${encodeURIComponent(accessToken)}&file_url=${encodeURIComponent(videoUrl)}`,
            { method: 'POST' }
        )
        if (r.json?.error) return { ok: false, step: 'upload', error: r.json.error.message, fb_error_code: r.json.error.code, fb_trace_id: r.json.error.fbtrace_id }
        vidId = r.json?.id
        if (!vidId) return { ok: false, step: 'upload', error: 'no_video_id_returned', preview: r.text.substring(0, 300) }
    }

    // ── Step 2: poll thumbnails (60×3s = 180s) — matches Electron ──
    let thumb = /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null
    if (!thumb) {
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 3000))
            const r = await fbFetch(`https://graph.facebook.com/${vidId}?access_token=${encodeURIComponent(accessToken)}&fields=thumbnails`)
            if (r.json?.error) return { ok: false, step: 'thumbnails', error: r.json.error.message, fb_error_code: r.json.error.code, fb_trace_id: r.json.error.fbtrace_id }
            if (r.json?.thumbnails?.data?.length >= 1) { thumb = r.json.thumbnails.data[0].uri; break }
        }
    }
    if (!thumb) return { ok: false, step: 'thumbnails', error: 'Timeout (180s) — FB ยังประมวลผล video ไม่เสร็จ' }

    // ── Step 3: create adcreative ──
    const isLikePageCta = ctaType === 'LIKE_PAGE' || !ctaLink
    const ctaSpec = isLikePageCta
        ? { type: 'LIKE_PAGE', value: { page: pageId } }
        : { type: ctaType, value: { link: ctaLink, link_format: 'VIDEO_LPP' } }
    const crBody = {
        name: caption.substring(0, 50),
        object_story_spec: {
            page_id: pageId,
            video_data: { video_id: vidId, message: caption, image_url: thumb, call_to_action: ctaSpec },
        },
    }
    const cr = await fbFetch(
        `https://graph.facebook.com/v21.0/${adAccount}/adcreatives?access_token=${encodeURIComponent(accessToken)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody) }
    )
    if (cr.json?.error) return { ok: false, step: 'creative', error: cr.json.error.message, fb_error_code: cr.json.error.code, fb_trace_id: cr.json.error.fbtrace_id, cta_type: ctaType, cta_link: ctaLink }
    const creativeId = cr.json?.id
    if (!creativeId) return { ok: false, step: 'creative', error: 'no_creative_id', preview: cr.text.substring(0, 300) }

    // ── Step 4: poll story_id (50×3s = 150s) — matches Electron's recent widening ──
    let storyId = null
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const r = await fbFetch(`https://graph.facebook.com/${creativeId}?access_token=${encodeURIComponent(accessToken)}&fields=effective_object_story_id`)
        if (r.json?.effective_object_story_id) { storyId = r.json.effective_object_story_id; break }
    }
    if (!storyId) return { ok: false, step: 'story_id', error: 'Timeout (150s) — FB ยังสร้าง story ไม่เสร็จ', creative_id: creativeId, video_id: vidId }

    // ── Step 5: resolve campaign (existing or new) ──
    //
    // Campaign create payload mirrors apps/video-onecard/electron.js:438-447 exactly.
    // Earlier extension code drifted from Electron in 3 ways that all break /copies:
    //   1. special_ad_categories: '[]' (STRING)  →  must be []  (ARRAY)
    //   2. status: 'PAUSED'                      →  Electron uses ACTIVE before /copies
    //   3. missing daily_budget + bid_strategy   →  /copies needs the parent campaign
    //      to have budget settings before deep-copying an adset (which itself has
    //      lifetime/daily budget that must align with the parent campaign's CBO state)
    // FB rejected /copies with code=100 'Invalid parameter' because of #1 + #3.
    let targetCampaignId = String(campaignId || '').trim()
    if (!targetCampaignId && newCampaignName) {
        const tpl = await fbFetch(`https://graph.facebook.com/v21.0/${templateAdset}?fields=campaign{objective,buying_type}&access_token=${encodeURIComponent(accessToken)}`)
        const objective = tpl.json?.campaign?.objective || 'OUTCOME_ENGAGEMENT'
        const newCamp = await fbFetch(
            `https://graph.facebook.com/v21.0/${adAccount}/campaigns?access_token=${encodeURIComponent(accessToken)}`,
            {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newCampaignName,
                    objective,
                    status: 'ACTIVE',
                    special_ad_categories: [],
                    daily_budget: '100000',
                    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
                }),
            }
        )
        if (newCamp.json?.error) return { ok: false, step: 'new_campaign', error: newCamp.json.error.message, fb_error_code: newCamp.json.error.code, fb_trace_id: newCamp.json.error.fbtrace_id, creative_id: creativeId, story_id: storyId, attempted_objective: objective }
        targetCampaignId = newCamp.json?.id
    }
    if (!targetCampaignId) return { ok: false, step: 'campaign', error: 'ต้องระบุ campaign_id หรือ new_campaign_name', creative_id: creativeId, story_id: storyId }

    // ── Step 5b: copy template adset into chosen campaign (PAUSED) ──
    const copy = await fbFetch(
        `https://graph.facebook.com/v21.0/${templateAdset}/copies?access_token=${encodeURIComponent(accessToken)}`,
        {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deep_copy: true, status_option: 'PAUSED', campaign_id: targetCampaignId }),
        }
    )
    if (copy.json?.error) return { ok: false, step: 'copy', error: copy.json.error.message, fb_error_code: copy.json.error.code, fb_trace_id: copy.json.error.fbtrace_id, template_adset: templateAdset, target_campaign: targetCampaignId, creative_id: creativeId, story_id: storyId }
    const newAdset = copy.json?.copied_adset_id
    if (!newAdset) return { ok: false, step: 'copy', error: 'no_copied_adset_id', preview: copy.text.substring(0, 300) }

    // ── Step 6: create ad (PAUSED) ──
    const adResp = await fbFetch(
        `https://graph.facebook.com/v21.0/${adAccount}/ads?access_token=${encodeURIComponent(accessToken)}`,
        {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: caption.substring(0, 50), adset_id: newAdset, creative: { creative_id: creativeId }, status: 'PAUSED' }),
        }
    )
    if (adResp.json?.error) return { ok: false, step: 'ad', error: adResp.json.error.message, fb_error_code: adResp.json.error.code, fb_trace_id: adResp.json.error.fbtrace_id, adset_id: newAdset, creative_id: creativeId, story_id: storyId }
    const newAd = adResp.json?.id
    if (!newAd) return { ok: false, step: 'ad', error: 'no_ad_id', preview: adResp.text.substring(0, 300) }

    // ── Step 7: rename adset (storyId for traceability) + activate adset + ad ──
    await fbFetch(
        `https://graph.facebook.com/v21.0/${newAdset}?access_token=${encodeURIComponent(accessToken)}`,
        {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: storyId, status: 'ACTIVE' }),
        }
    )
    await fbFetch(
        `https://graph.facebook.com/v21.0/${newAd}?access_token=${encodeURIComponent(accessToken)}`,
        {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ACTIVE' }),
        }
    )

    // ── Step 7.5: publish to page feed (so post is visible organically too) ──
    let publishedToPage = false
    let publishError = ''
    let pageToken = ''
    try {
        const pagesRes = await fbFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id&limit=100&access_token=${encodeURIComponent(accessToken)}`)
        const pages = (pagesRes.json?.data || [])
        const page = pages.find((p) => p.id === pageId)
        pageToken = page ? page.access_token : ''
        if (pageToken) {
            const pubResp = await fbFetch(
                `https://graph.facebook.com/v21.0/${storyId}?access_token=${encodeURIComponent(pageToken)}`,
                {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ is_published: true }),
                }
            )
            if (pubResp.json?.error) publishError = String(pubResp.json.error.message || '').substring(0, 200)
            else publishedToPage = true
        } else {
            publishError = 'page_token_not_found'
        }
    } catch (e) { publishError = e.message || String(e) }

    // ── Step 8: post first comment with shortlink (matches Electron's worker
    // comment step). Uses page access_token (same one used to publish), since
    // page tokens can comment on their own page's posts. Skip silently if
    // commentText is empty (operator left comment_template blank in /feed/settings)
    // or if we couldn't get the page token in step 7.5.
    let commentPosted = false
    let commentId = ''
    let commentError = ''
    if (commentText && pageToken) {
        try {
            const cm = await fbFetch(
                `https://graph.facebook.com/v21.0/${storyId}/comments?access_token=${encodeURIComponent(pageToken)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: commentText }),
                }
            )
            if (cm.json?.error) {
                commentError = String(cm.json.error.message || '').substring(0, 200)
            } else if (cm.json?.id) {
                commentPosted = true
                commentId = String(cm.json.id)
            } else {
                commentError = 'no_comment_id_returned'
            }
        } catch (e) {
            commentError = e?.message || String(e)
        }
    } else if (!commentText) {
        commentError = 'no_comment_template (settings.comment_template empty)'
    } else if (!pageToken) {
        commentError = 'no_page_token (publish-to-page skipped)'
    }

    return {
        ok: true,
        story_id: storyId,
        ad_id: newAd,
        adset_id: newAdset,
        creative_id: creativeId,
        video_id: vidId,
        published_to_page: publishedToPage,
        publish_error: publishError || undefined,
        comment_posted: commentPosted,
        comment_id: commentId || undefined,
        comment_error: commentError || undefined,
    }
}

// ────────────────────── Tab finders ──────────────────────

async function findTabByPattern(pattern) {
    const tabs = await chrome.tabs.query({ url: pattern })
    for (const t of tabs) if (t.status === 'complete' && t.id) return t
    for (const t of tabs) if (t.id) return t
    return null
}

async function findTabsByPatterns(patterns) {
    const all = []
    for (const p of patterns) {
        const tabs = await chrome.tabs.query({ url: p }).catch(() => [])
        for (const t of tabs) if (t.id) all.push(t)
    }
    all.sort((a, b) => (a.status === 'complete' ? -1 : 1) - (b.status === 'complete' ? -1 : 1))
    return all
}
