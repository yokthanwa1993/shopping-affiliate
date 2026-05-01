// Content script — bridges dashboard /feed page ↔ extension background.
//
// Runs on:
//   - https://dashboard.oomnn.com/* (production)
//   - https://ads-manager-dashboard.yokthanwa1993-bc9.workers.dev/* (workers.dev preview)
//
// Protocol (all via window.postMessage on the dashboard origin):
//
//   1. On document_idle, bridge announces the extension is present:
//        { source: 'feed-ad-extension', type: 'feedExt.handshake', version }
//      Dashboard sets extensionAvailable=true on receipt.
//
//   2. Dashboard requests a create-ad job:
//        { type: 'feedExt.createAd.request', requestId, payload: { ... } }
//      Bridge forwards via chrome.runtime.sendMessage to background, awaits
//      result, then replies:
//        { source: 'feed-ad-extension', type: 'feedExt.createAd.result',
//          requestId, ok, ...result }
//
//   3. Dashboard can ask the bridge to ping the extension at any time:
//        { type: 'feedExt.ping.request', requestId }
//      → reply with handshake-shaped object so the dashboard can re-detect.
//
// Why postMessage and not chrome.runtime.sendMessage(extensionId, ...)?
// Extension IDs change every reinstall when loaded unpacked, and pinning
// "externally_connectable" would require the dashboard to know the ID.
// A content_script + window bus is ID-agnostic.

(() => {
    const SOURCE = 'feed-ad-extension'
    const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest)
        ? (chrome.runtime.getManifest().version || 'unknown')
        : 'unknown'

    function announce() {
        try {
            window.postMessage({ source: SOURCE, type: 'feedExt.handshake', version: VERSION }, '*')
        } catch { /* ignore */ }
    }

    // Announce immediately + on visibility change (in case dashboard mounted
    // its listener after this script ran).
    announce()
    setTimeout(announce, 250)
    setTimeout(announce, 1000)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) announce() })

    window.addEventListener('message', async (e) => {
        if (e.source !== window) return
        const msg = e.data
        if (!msg || typeof msg !== 'object') return
        if (msg.source === SOURCE) return // never echo our own messages

        // Ping → handshake reply
        if (msg.type === 'feedExt.ping.request') {
            window.postMessage({ source: SOURCE, type: 'feedExt.handshake', version: VERSION, requestId: msg.requestId || null }, '*')
            return
        }

        // Create-ad request → forward to background
        if (msg.type === 'feedExt.createAd.request') {
            const requestId = msg.requestId
            if (!requestId) return
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'feedExt.createAd', payload: msg.payload || {} })
                window.postMessage({
                    source: SOURCE,
                    type: 'feedExt.createAd.result',
                    requestId,
                    ...(resp || { ok: false, error: 'no_response_from_background' }),
                }, '*')
            } catch (err) {
                window.postMessage({
                    source: SOURCE,
                    type: 'feedExt.createAd.result',
                    requestId,
                    ok: false,
                    error: err?.message || String(err),
                }, '*')
            }
            return
        }

        // List-campaigns request → forward to background
        if (msg.type === 'feedExt.listCampaigns.request') {
            const requestId = msg.requestId
            if (!requestId) return
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'feedExt.listCampaigns', payload: msg.payload || {} })
                window.postMessage({
                    source: SOURCE,
                    type: 'feedExt.listCampaigns.result',
                    requestId,
                    ...(resp || { ok: false, error: 'no_response_from_background' }),
                }, '*')
            } catch (err) {
                window.postMessage({
                    source: SOURCE,
                    type: 'feedExt.listCampaigns.result',
                    requestId,
                    ok: false,
                    error: err?.message || String(err),
                }, '*')
            }
            return
        }
    })
})()
