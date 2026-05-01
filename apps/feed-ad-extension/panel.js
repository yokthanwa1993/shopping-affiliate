// Feed Ad Creator — side panel logic.
//
// All real work happens in background.js (service worker). This file just:
//   1. Pre-fills sub_ids/ad_account/template_adset from worker settings on load
//   2. Pings status (Ads Manager tab + Shopee tab) every few seconds
//   3. Sends 'feedExt.createAd' message and renders progress + result

const $ = (s) => document.querySelector(s)
const els = {
    pageName: $('#page-name'),
    pageId: $('#page-id'),
    dotAds: $('#dot-ads'),
    dotShopee: $('#dot-shopee'),
    statusAds: $('#status-ads'),
    statusShopee: $('#status-shopee'),

    form: $('#form'),
    videoId: $('#video-id'),
    videoUrl: $('#video-url'),
    caption: $('#caption'),
    shopeeUrl: $('#shopee-url'),
    campaignId: $('#campaign-id'),
    newCampaignName: $('#new-campaign-name'),
    adAccount: $('#ad-account'),
    templateAdset: $('#template-adset'),
    thumbnailUrl: $('#thumbnail-url'),

    btnCreate: $('#btn-create'),
    btnClear: $('#btn-clear'),

    status: $('#status'),
    progress: $('#progress'),
    progressFill: $('#progress-fill'),
    progressText: $('#progress-text'),
    result: $('#result'),
    resultList: $('#result-list'),
}

// ────────────────────── Boot ──────────────────────

void boot()

async function boot() {
    refreshStatusLoop()
    try {
        const settings = await chrome.runtime.sendMessage({ type: 'feedExt.loadSettings' })
        if (settings?.ok) {
            if (settings.ad_account && !els.adAccount.value) els.adAccount.value = settings.ad_account
            if (settings.template_adset && !els.templateAdset.value) els.templateAdset.value = settings.template_adset
        }
    } catch { /* worker offline ก็ ok — ใช้ default ใน background.js */ }
}

els.form.addEventListener('submit', onCreate)
els.btnClear.addEventListener('click', onClear)

// ────────────────────── Status indicator ──────────────────────

async function refreshStatusLoop() {
    while (true) {
        await refreshStatusOnce()
        await sleep(5000)
    }
}

async function refreshStatusOnce() {
    try {
        const s = await chrome.runtime.sendMessage({ type: 'feedExt.status' })
        if (!s?.ok) return
        if (s.page_name && els.pageName) els.pageName.textContent = s.page_name
        if (s.page_id && els.pageId) els.pageId.textContent = `page_id ${s.page_id}`

        const adsOk = !!s.ads_manager_tab
        els.dotAds.className = `dot ${adsOk ? 'dot-green' : 'dot-red'}`
        els.statusAds.textContent = adsOk
            ? `Ads Manager: ✓`
            : `Ads Manager: ไม่พบ tab`

        const shopOk = !!s.shopee_tab
        els.dotShopee.className = `dot ${shopOk ? 'dot-green' : 'dot-yellow'}`
        els.statusShopee.textContent = shopOk
            ? `Shopee: ✓ (fallback พร้อม)`
            : `Shopee: ไม่มี tab (ใช้ wwoom)`
    } catch { /* ignore */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ────────────────────── Submit handler ──────────────────────

async function onCreate(e) {
    e.preventDefault()
    setBusy(true)
    hideResult()
    showStatus('กำลังเริ่ม pipeline ฟีด...', '')
    setProgress(5, 'เตรียม settings + shortening')

    const payload = {
        videoId: els.videoId.value.trim(),
        videoUrl: els.videoUrl.value.trim(),
        caption: els.caption.value.trim(),
        shopeeUrl: els.shopeeUrl.value.trim(),
        campaignId: els.campaignId.value.trim(),
        newCampaignName: els.newCampaignName.value.trim(),
        adAccount: els.adAccount.value.trim(),
        templateAdset: els.templateAdset.value.trim(),
        thumbnailUrl: els.thumbnailUrl.value.trim(),
    }

    if (!payload.videoId && !payload.videoUrl) {
        showStatus('ใส่ Video ID หรือ Video URL อย่างใดอย่างหนึ่ง', 'error')
        setBusy(false)
        hideProgress()
        return
    }
    if (!payload.caption) {
        showStatus('ใส่ caption ก่อน', 'error')
        setBusy(false)
        hideProgress()
        return
    }
    if (!payload.shopeeUrl) {
        showStatus('ใส่ Shopee URL ก่อน', 'error')
        setBusy(false)
        hideProgress()
        return
    }
    if (!payload.campaignId && !payload.newCampaignName) {
        showStatus('เลือก campaign — ใส่ Campaign ID เดิม หรือ ชื่อแคมเปญใหม่ อย่างใดอย่างหนึ่ง', 'error')
        setBusy(false)
        hideProgress()
        return
    }

    // Heuristic progress — pipeline takes ~80-200s end-to-end (upload, thumbnails 0-180s,
    // creative + story_id 75-150s, copy + ad + activate ~5s). The bg returns once done.
    const tickers = []
    tickers.push(setTimeout(() => setProgress(15, 'กำลังย่อ Shopee link → wwoom'), 1500))
    tickers.push(setTimeout(() => setProgress(28, 'กำลัง upload video / รอ thumbnails'), 8000))
    tickers.push(setTimeout(() => setProgress(50, 'กำลังสร้าง adcreative'), 30000))
    tickers.push(setTimeout(() => setProgress(70, 'กำลังรอ FB resolve story_id'), 60000))
    tickers.push(setTimeout(() => setProgress(85, 'กำลัง copy adset + create ad'), 130000))

    try {
        const resp = await chrome.runtime.sendMessage({ type: 'feedExt.createAd', payload })
        tickers.forEach(clearTimeout)

        if (!resp?.ok) {
            const stepLabel = resp?.step ? `[${resp.step}] ` : ''
            const fbCode = resp?.fb_error_code ? ` (FB code=${resp.fb_error_code})` : ''
            const trace = resp?.fb_trace_id ? ` · trace=${resp.fb_trace_id}` : ''
            showStatus(`❌ ${stepLabel}${resp?.error || 'unknown_error'}${fbCode}${trace}`, 'error')
            hideProgress()
            return
        }
        setProgress(100, '✅ สร้างแอดสำเร็จ')
        showResult(resp)
        showStatus('✅ สำเร็จ — แอดถูกตั้ง ACTIVE และโพสต์เผยแพร่บนเพจฟีด', 'success')
    } catch (err) {
        tickers.forEach(clearTimeout)
        showStatus(`❌ Exception: ${err?.message || String(err)}`, 'error')
        hideProgress()
    } finally {
        setBusy(false)
    }
}

function onClear() {
    els.videoId.value = ''
    els.videoUrl.value = ''
    els.caption.value = ''
    els.shopeeUrl.value = ''
    els.campaignId.value = ''
    els.newCampaignName.value = ''
    els.thumbnailUrl.value = ''
    hideResult()
    hideStatus()
    hideProgress()
    els.videoId.focus()
}

// ────────────────────── UI helpers ──────────────────────

function setBusy(busy) {
    els.btnCreate.disabled = busy
    els.btnClear.disabled = busy
    els.btnCreate.textContent = busy ? 'กำลังสร้าง...' : 'สร้างแอด ฟีด'
}

function showStatus(msg, variant) {
    els.status.textContent = msg
    els.status.classList.remove('hide')
    if (variant) els.status.dataset.v = variant
    else delete els.status.dataset.v
}
function hideStatus() {
    els.status.classList.add('hide')
    els.status.textContent = ''
    delete els.status.dataset.v
}

function setProgress(pct, label) {
    els.progress.classList.remove('hide')
    els.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`
    els.progressText.textContent = label || ''
}
function hideProgress() {
    els.progress.classList.add('hide')
    els.progressFill.style.width = '0%'
    els.progressText.textContent = ''
}

function showResult(r) {
    const items = [
        ['Story ID', r.story_id],
        ['Ad ID', r.ad_id],
        ['Adset ID', r.adset_id],
        ['Creative ID', r.creative_id],
        ['Video ID', r.video_id],
        ['Short link', r.short_link],
        ['Published to page', r.published_to_page ? 'ใช่' : `ไม่ (${r.publish_error || 'unknown'})`],
        ['Logged to worker', r.logged?.ok ? 'ใช่' : `ไม่ (${r.logged?.error || 'skip'})`],
        ['FB post URL', r.story_id ? `https://www.facebook.com/${String(r.story_id).replace('_', '/posts/')}` : '—'],
    ]
    els.resultList.innerHTML = ''
    for (const [k, v] of items) {
        const dt = document.createElement('dt')
        dt.textContent = k
        const dd = document.createElement('dd')
        if (typeof v === 'string' && /^https?:\/\//.test(v)) {
            const a = document.createElement('a')
            a.href = v
            a.target = '_blank'
            a.rel = 'noreferrer'
            a.textContent = v
            dd.appendChild(a)
        } else {
            dd.textContent = String(v ?? '—')
        }
        els.resultList.appendChild(dt)
        els.resultList.appendChild(dd)
    }
    els.result.classList.remove('hide')
}
function hideResult() {
    els.result.classList.add('hide')
    els.resultList.innerHTML = ''
}
