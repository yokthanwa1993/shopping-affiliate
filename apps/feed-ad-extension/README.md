# Feed Ad Creator (Chrome Extension)

**Headless extension** ที่ทำงานเบื้องหลังของ dashboard `/feed` — ผู้ใช้ไม่เคยกดเข้า extension. ทุกการกระทำเริ่มจากปุ่ม "สร้างแอด" บน `https://dashboard.oomnn.com/feed` แล้ว extension รับงานต่อในเงียบๆ

> **ขอบเขต**: extension นี้ **lock เฉพาะเพจฟีด** (page id `116759241338040`). เพจเฉียบและเพจอื่นใช้ Electron `video-onecard` เหมือนเดิม ไม่กระทบ. Worker endpoint `/api/dashboard/extension-ad-log` reject `page_id` ที่ไม่ใช่ฟีดด้วย HTTP 403

## หน้าที่ของ extension (ไม่มี UI)

1. **Shortlink Shopee** — เรียก `short.wwoom.com` (เหมือน worker create-ad). fallback: ถ้า wwoom พังและมี tab `affiliate.shopee.co.th` เปิดอยู่ จะ shorten ผ่าน GraphQL ของ Shopee ตรงๆ
2. **ดึง access_token + cookies** — อ่าน `window.__accessToken` + session cookies จาก tab Ads Manager ที่ผู้ใช้ login อยู่ (ผ่าน `chrome.scripting.executeScript({ world: 'MAIN' })`)
3. **FB ad pipeline** — รันใน MAIN world ของ Ads Manager tab:
   - upload video หรือ reuse video_id
   - poll thumbnails 60×3s
   - create adcreative
   - poll story_id 50×3s
   - copy template adset เข้า campaign
   - create ad → activate adset + ad → publish to page feed
4. **Log to worker** — POST `/api/dashboard/extension-ad-log` → `post_history` (`trigger_source=feed_extension`) + mark video posted

## Flow ที่ผู้ใช้เห็น (UI ทั้งหมดอยู่ที่ dashboard)

```
1. user เปิด dashboard /feed บน Chrome
2. กด "สร้างแอด" บน gallery/page-posts
3. ป๊อปอัปโชว์ "✅ สร้างผ่าน Feed Ad Creator extension v1.2.0"
4. user เลือก campaign + กด "⚡ โพสต์เลย (ผ่าน extension)"
5. dashboard postMessage → bridge.js → background.js → Ads Manager tab → graph.facebook.com
6. ระหว่าง pipeline (~80-200s) dashboard โชว์ progress bar
7. result กลับมา → dashboard โชว์ story_id, ad_id, FB post URL
```

ผู้ใช้ไม่เคยคลิก icon extension เลย

## Install (ครั้งเดียว)

1. เปิด Chrome → `chrome://extensions`
2. เปิด **Developer mode** (toggle มุมขวาบน)
3. กด **Load unpacked** → เลือกโฟลเดอร์: `apps/feed-ad-extension/`
4. ตรวจว่า icon "F" สีน้ำเงินโผล่บนแถบ extensions (pin หรือไม่ก็ได้)
5. เปิด tab Ads Manager: `https://adsmanager.facebook.com/...` แล้ว login บัญชีที่มี admin บนเพจฟีด
6. เปิด `https://dashboard.oomnn.com/feed` หรือ workers.dev URL

## Pre-requisites ทุกครั้งที่ใช้

- **Tab Ads Manager เปิดค้างใน Chrome** — extension อ่าน `window.__accessToken` จาก tab นี้
- (Optional) **Tab Shopee Affiliate เปิดค้าง** — fallback ถ้า wwoom shortener พัง

## Pipeline ที่รัน (เทียบกับ Electron)

| Step | Electron `video-onecard/electron.js` | Extension `background.js` (in MAIN world) |
|---|---|---|
| Token grab | scrape `window.__accessToken` ผ่าน `executeJavaScript` ทุก 15s | อ่าน `window.__accessToken` ใน MAIN world ตอน executeScript |
| Cookies | `useSessionCookies: true` ใน `net.request` | `credentials: 'include'` ใน `fetch` |
| Upload video | `POST /v21.0/{adAcc}/advideos` | เหมือนกัน |
| Thumbnail poll | 60×3s, gate `>= 1` | เหมือนกัน |
| Create creative | `POST /v21.0/{adAcc}/adcreatives` | เหมือนกัน |
| story_id poll | **50×3s** (เพิ่ง widen) | เหมือนกัน |
| Copy adset | `POST /v21.0/{adset}/copies` | เหมือนกัน |
| Create ad | `POST /v21.0/{adAcc}/ads` | เหมือนกัน |
| Activate | `status: ACTIVE` ทั้ง adset และ ad | เหมือนกัน |
| Publish to page | ดึง page token ผ่าน `/me/accounts` แล้ว `is_published=true` | เหมือนกัน |

## ไฟล์ในโปรเจ็ค

```
apps/feed-ad-extension/
├── manifest.json     ← MV3, headless (no popup, no side panel)
├── background.js     ← service worker — message bus + shortlink + FB pipeline
├── bridge.js         ← content script on dashboard.oomnn.com/* + workers.dev — handshake + forwarder
├── icons/            ← icon-{16,48,128}.png
└── README.md
```

ไม่มีไฟล์ panel/popup เพราะ extension ไม่มี UI

## Protocol (postMessage จาก dashboard)

```js
// dashboard side
window.postMessage({
  type: 'feedExt.createAd.request',
  requestId: 'unique-string',
  payload: {
    videoId, videoUrl, caption, shopeeUrl,
    campaignId, newCampaignName,
  },
}, '*')

// extension reply (via bridge.js)
window.postMessage({
  source: 'feed-ad-extension',
  type: 'feedExt.createAd.result',
  requestId: 'same-string',
  ok: true,
  story_id: '...',
  ad_id: '...',
  ...
}, '*')
```

Handshake (extension แจ้งว่าตัวเองออนไลน์):
```js
{ source: 'feed-ad-extension', type: 'feedExt.handshake', version: '1.2.0' }
```

Dashboard ใช้ handshake เพื่อโชว์ "✅ extension installed" บนป๊อปอัปสร้างแอด

## Worker endpoint

```
POST https://api.oomnn.com/api/dashboard/extension-ad-log
{
  "page_id": "116759241338040",      // hard-locked, อื่นๆ HTTP 403
  "video_id", "story_id",            // required
  "ad_id", "adset_id", "creative_id",
  "shopee_link", "short_link", "comment_id"
}
```

→ Insert into `post_history` (`trigger_source=feed_extension`) + `markNamespaceVideoPosted(...)`

## Settings ที่ extension อ่านจาก worker

```
GET https://api.oomnn.com/api/dashboard/settings?page_id=116759241338040
```

ดึง `sub_id`, `sub_id2-5`, `shortlink_url`, `ad_account`, `template_adset` ของฟีด (ที่ตั้งใน dashboard `/feed` → tab Settings)

## Troubleshooting

| ปัญหา | สาเหตุ / แก้ |
|---|---|
| ป๊อปอัปบน /feed โชว์ "⚠️ ไม่พบ extension" | (1) ติดตั้งใน chrome://extensions ก่อน (2) ถ้าติดแล้วยังไม่เห็น → reload extension แล้วรีเฟรช /feed |
| `[ads_manager_tab] ไม่มี tab Ads Manager` | เปิด `adsmanager.facebook.com` ใน Chrome ก่อนกดสร้าง |
| `[token] ไม่พบ window.__accessToken` | refresh tab Ads Manager — บางครั้ง FB ยัง inject ไม่เสร็จ |
| `[story_id] Timeout (150s)` | FB ช้ากว่าปกติมาก — ลองกดซ้ำ (transient) |
| `[shortlink] ย่อลิงก์ไม่สำเร็จ` | เช็ค `short.wwoom.com` ตอบ + ลอง refresh tab Shopee Affiliate |

## ที่ extension ไม่ทำ (โดยตั้งใจ)

- **ไม่มี UI** — ไม่มี popup, ไม่มี side panel, ไม่มี content UI ทุกอย่างผ่าน dashboard
- **ไม่ post comment ลงโพสต์** — แค่ create ad + publish to page. ส่วน comment cron ของ worker จัดการต่อให้ผ่าน flow ปกติ
- **ไม่ดึง gallery video list** — dashboard ส่ง video_id/video_url มาในคำสั่ง
- **ไม่แตะเพจอื่น** — page_id hardcoded `116759241338040`. worker endpoint ก็ reject อย่างอื่น

## Versions

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-05-01 | Standalone extension with side panel UI |
| 1.1.0 | 2026-05-01 | Added bridge.js content script for dashboard integration |
| **1.2.0** | **2026-05-01** | **Headless: removed side panel + popup. Extension runs entirely behind dashboard /feed** |
