// Feed Ad Creator — service worker
//
// Hard-locked to เพจ ฟีด (page id 116759241338040). The whole ad creation
// pipeline runs inside the user's logged-in Ads Manager tab (MAIN world)
// because that's where window.__accessToken + session cookies live, exactly
// like the Electron app's BrowserWindow trick — just shifted into a real
// Chrome tab so we don't have to keep an Electron BrowserWindow alive.
//
// Why MAIN world (not service worker fetch)?
//   - The fetches that work against graph.facebook.com without an explicit
//     long-lived token are the ones originating from facebook.com pages
//     with their cookies + tokens attached. Service-worker fetches don't
//     get those for free.
//   - Same reason Shopee shortening goes through the affiliate tab: the
//     anti-bot SDK auto-injects security headers when called from the
//     real page context.
//
// Service worker keep-alive: long-running pipeline awaits live INSIDE the
// Ads Manager tab via a single executeScript call, so the SW doesn't need
// to stay awake for 100+ seconds. SW only handles message bus + worker log.

// ────────────────────── Constants ──────────────────────

const FEED_PAGE_ID = '116759241338040'           // เพจ ฟีด
const FEED_PAGE_NAME = 'ฟีด'

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

// ────────────────────── Side panel setup ──────────────────────

chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => { })
})

// ────────────────────── Message bus ──────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'feedExt.status') {
        getStatus().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
    }
    if (msg?.type === 'feedExt.loadSettings') {
        loadFeedSettings().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
    }
    if (msg?.type === 'feedExt.shortenShopee') {
        shortenShopee(msg.payload || {})
            .then((r) => sendResponse({ ok: true, ...r }))
            .catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
    }
    if (msg?.type === 'feedExt.createAd') {
        runCreateAdPipeline(msg.payload || {})
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: e.message }))
        return true
    }
    return false
})

// ────────────────────── Status check ──────────────────────

async function getStatus() {
    const adsTabs = await findTabsByPatterns(ADS_MANAGER_TAB_PATTERNS)
    const shopeeTab = await findTabByPattern(SHOPEE_TAB_PATTERN)
    return {
        ok: true,
        page_id: FEED_PAGE_ID,
        page_name: FEED_PAGE_NAME,
        ads_manager_tab: adsTabs[0] ? { id: adsTabs[0].id, url: adsTabs[0].url } : null,
        shopee_tab: shopeeTab ? { id: shopeeTab.id, url: shopeeTab.url } : null,
        worker_base: WORKER_BASE,
    }
}

// ────────────────────── Worker settings (sub_id, ad_account, etc.) ──────────────────────

async function loadFeedSettings() {
    const url = `${WORKER_BASE}/api/dashboard/settings?page_id=${encodeURIComponent(FEED_PAGE_ID)}`
    const r = await fetch(url, { method: 'GET' })
    if (!r.ok) throw new Error(`โหลด settings ของฟีดจาก worker ไม่สำเร็จ (HTTP ${r.status})`)
    const d = await r.json()
    return {
        ok: true,
        sub_id: String(d.sub_id || ''),
        sub_id2: String(d.sub_id2 || ''),
        sub_id3: String(d.sub_id3 || ''),
        sub_id4: String(d.sub_id4 || ''),
        sub_id5: String(d.sub_id5 || ''),
        shortlink_url: String(d.shortlink_url || `${SHORTLINK_BASE}/?account=CHEARB&url={url}&sub1={sub_id}`),
        ad_account: String(d.ad_account || DEFAULT_AD_ACCOUNT),
        template_adset: String(d.template_adset || DEFAULT_TEMPLATE_ADSET),
        comment_template: String(d.comment_template || ''),
    }
}

// ────────────────────── Shopee shortening ──────────────────────
//
// Two paths supported:
//   1. via short.wwoom.com (default — matches existing dashboard /create-ad
//      flow exactly, sub_ids forwarded into wwoom-tracked s.shopee.co.th URL)
//   2. via affiliate.shopee.co.th tab (fallback — only used if wwoom returns
//      empty / fails AND a Shopee tab is available in Chrome)
//
// We keep wwoom as primary so the extension produces identical short links to
// the Electron pipeline (same account, same sub_id encoding).

async function shortenShopee({ shopeeUrl, subId, subId2, subId3, subId4, subId5, shortlinkUrlTemplate }) {
    const url = String(shopeeUrl || '').trim()
    if (!url) throw new Error('ไม่มี shopee URL')

    // Path 1: wwoom shortener
    const tpl = String(shortlinkUrlTemplate || '').trim()
        || `${SHORTLINK_BASE}/?account=CHEARB&url={url}&sub1={sub_id}&sub2={sub_id2}&sub3={sub_id3}&sub4={sub_id4}&sub5={sub_id5}`
    const built = tpl
        .replace('{url}', encodeURIComponent(url))
        .replace('{sub_id}', encodeURIComponent(String(subId || '')))
        .replace('{sub_id2}', encodeURIComponent(String(subId2 || '')))
        .replace('{sub_id3}', encodeURIComponent(String(subId3 || '')))
        .replace('{sub_id4}', encodeURIComponent(String(subId4 || '')))
        .replace('{sub_id5}', encodeURIComponent(String(subId5 || '')))

    try {
        const r = await fetch(built, { method: 'GET' })
        if (r.ok) {
            const j = await r.json().catch(() => ({}))
            const sl = String(j.shortLink || j.short_link || '').trim()
            if (sl) return { source: 'wwoom', shortLink: cleanShortLink(sl), longLink: String(j.longLink || '') }
        }
    } catch (e) {
        // Fall through to Shopee tab
    }

    // Path 2: Shopee tab (fallback) — direct GraphQL via the user's logged-in
    // affiliate tab. Borrowed from shortlink-v2 reference extension.
    const shopeeTab = await findTabByPattern(SHOPEE_TAB_PATTERN)
    if (!shopeeTab) {
        throw new Error('ย่อลิงก์ wwoom ไม่สำเร็จ และไม่มี tab Shopee Affiliate เปิดอยู่ — เปิด affiliate.shopee.co.th แล้วลองใหม่')
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
    if (!result) throw new Error('Shopee tab ไม่ตอบกลับ')
    if (!result.ok) throw new Error(result.error || 'Shopee shortening ไม่สำเร็จ')
    return { source: 'shopee_tab', shortLink: cleanShortLink(result.shortLink), longLink: '' }
}

function cleanShortLink(s) {
    return String(s || '').trim().replace(/\?lp=aff$/, '').replace(/&lp=aff$/, '')
}

// Runs INSIDE Shopee Affiliate page (MAIN world). Same pattern as shortlink-v2:
// XHR so Shopee's anti-bot SDK interceptors auto-attach x-sap-sec headers.
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
    } = payload || {}

    if (!caption) return { ok: false, error: 'ไม่มี caption' }
    if (!videoUrl && !videoId) return { ok: false, error: 'ต้องใส่ video_url หรือ video_id' }

    // 1. Settings
    const settings = await loadFeedSettings().catch(() => null)
    if (!settings?.ok) return { ok: false, error: 'โหลด settings ฟีดจาก worker ไม่สำเร็จ' }

    const effAdAccount = String(adAccount || settings.ad_account || DEFAULT_AD_ACCOUNT).trim()
    const effTemplateAdset = String(templateAdset || settings.template_adset || DEFAULT_TEMPLATE_ADSET).trim()

    // 2. Shorten shopee link → wwoom (this is the link that goes into caption + comment)
    let shortLink = ''
    let shopeeLink = String(shopeeUrl || '').trim()
    if (shopeeLink) {
        try {
            const sl = await shortenShopee({
                shopeeUrl: shopeeLink,
                subId: settings.sub_id, subId2: settings.sub_id2, subId3: settings.sub_id3,
                subId4: settings.sub_id4, subId5: settings.sub_id5,
                shortlinkUrlTemplate: settings.shortlink_url,
            })
            shortLink = sl.shortLink
        } catch (e) {
            return { ok: false, step: 'shortlink', error: e.message }
        }
    }
    if (!shortLink) return { ok: false, step: 'shortlink', error: 'ไม่ได้ short link — ใส่ shopee URL ที่ valid + ลอง refresh tab affiliate.shopee.co.th' }

    // 3. Build final caption (matches video-onecard electron format)
    const finalCaption = `📌 พิกัด : ${shortLink}\n${caption}`

    // 4. Find Ads Manager tab
    const adsTabs = await findTabsByPatterns(ADS_MANAGER_TAB_PATTERNS)
    if (!adsTabs.length) {
        return { ok: false, step: 'ads_manager_tab', error: 'ไม่มี tab Ads Manager เปิดอยู่ — เปิด adsmanager.facebook.com แล้วลองใหม่' }
    }

    // 5. Pipeline (in MAIN world of Ads Manager tab — needs cookies + window.__accessToken)
    const pipelineArgs = {
        pageId: FEED_PAGE_ID,
        videoId: String(videoId || ''),
        videoUrl: String(videoUrl || ''),
        caption: finalCaption,
        ctaLink: shortLink,            // CTA goes to wwoom → tracking
        adAccount: effAdAccount,
        templateAdset: effTemplateAdset,
        campaignId: String(campaignId || ''),
        newCampaignName: String(newCampaignName || ''),
        thumbnailUrl: String(thumbnailUrl || ''),
    }

    const exec = await chrome.scripting.executeScript({
        target: { tabId: adsTabs[0].id },
        world: 'MAIN',
        func: fbAdPipelineMainWorld,
        args: [pipelineArgs],
    })

    const result = exec?.[0]?.result
    if (!result) return { ok: false, step: 'pipeline', error: 'pipeline ไม่ตอบกลับ — Ads Manager tab อาจถูกปิด' }
    if (!result.ok) return { ...result, short_link: shortLink, shopee_link: shopeeLink }

    // 6. Log to worker (post_history insert + mark video as posted)
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
            }),
        })
        logged = await logResp.json().catch(() => null)
    } catch (e) {
        logged = { ok: false, error: e.message }
    }

    return {
        ok: true,
        ...result,
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
    const { pageId, videoId, videoUrl, caption, ctaLink, adAccount, templateAdset, campaignId, newCampaignName, thumbnailUrl } = args

    function tokenTail(t) { return String(t || '').slice(-6) }
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
        if (r.json?.error) return { ok: false, step: 'upload', error: r.json.error.message, fb_error_code: r.json.error.code, fb_trace_id: r.json.error.fbtrace_id, token_tail: tokenTail(accessToken) }
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

    // ── Step 4: poll story_id (50×3s = 150s) — matches the recent Electron widening ──
    let storyId = null
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const r = await fbFetch(`https://graph.facebook.com/${creativeId}?access_token=${encodeURIComponent(accessToken)}&fields=effective_object_story_id`)
        if (r.json?.effective_object_story_id) { storyId = r.json.effective_object_story_id; break }
    }
    if (!storyId) return { ok: false, step: 'story_id', error: 'Timeout (150s) — FB ยังสร้าง story ไม่เสร็จ', creative_id: creativeId, video_id: vidId }

    // ── Step 5: resolve campaign (existing or new) ──
    let targetCampaignId = String(campaignId || '').trim()
    if (!targetCampaignId && newCampaignName) {
        // Read template adset's campaign objective so new campaigns match it (otherwise FB error 1815149).
        const tpl = await fbFetch(`https://graph.facebook.com/v21.0/${templateAdset}?fields=campaign{objective,buying_type}&access_token=${encodeURIComponent(accessToken)}`)
        const objective = tpl.json?.campaign?.objective || 'OUTCOME_ENGAGEMENT'
        const buyingType = tpl.json?.campaign?.buying_type || 'AUCTION'
        const newCamp = await fbFetch(
            `https://graph.facebook.com/v21.0/${adAccount}/campaigns?access_token=${encodeURIComponent(accessToken)}`,
            {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newCampaignName, objective, buying_type: buyingType, status: 'PAUSED', special_ad_categories: '[]' }),
            }
        )
        if (newCamp.json?.error) return { ok: false, step: 'new_campaign', error: newCamp.json.error.message, fb_error_code: newCamp.json.error.code, fb_trace_id: newCamp.json.error.fbtrace_id, creative_id: creativeId, story_id: storyId }
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
    try {
        const pagesRes = await fbFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id&limit=100&access_token=${encodeURIComponent(accessToken)}`)
        const pages = (pagesRes.json?.data || [])
        const page = pages.find((p) => p.id === pageId)
        const pageToken = page ? page.access_token : ''
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

    return {
        ok: true,
        story_id: storyId,
        ad_id: newAd,
        adset_id: newAdset,
        creative_id: creativeId,
        video_id: vidId,
        published_to_page: publishedToPage,
        publish_error: publishError || undefined,
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
    // Prefer fully loaded tabs first
    all.sort((a, b) => (a.status === 'complete' ? -1 : 1) - (b.status === 'complete' ? -1 : 1))
    return all
}
