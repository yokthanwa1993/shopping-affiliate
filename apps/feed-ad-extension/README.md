# Feed Ad Creator (Chrome Extension)

สร้างแอด LikePage ให้ **เพจ ฟีด** (page id `116759241338040`) ผ่าน Ads Manager session ใน Chrome ของพี่ — แทน Electron flow ของฟีดเท่านั้น

> **สำคัญ — ขอบเขต**: extension นี้ **lock เฉพาะเพจฟีด**. เพจเฉียบ (และเพจอื่น) ยังใช้ Electron `video-onecard` เหมือนเดิม ไม่กระทบ. Worker endpoint `/api/dashboard/extension-ad-log` reject `page_id` ที่ไม่ใช่ฟีดด้วย HTTP 403

## สิ่งที่ extension ทำ (port จาก `apps/video-onecard/electron.js`)

1. **Shopee shortening** — เรียก `short.wwoom.com` (เหมือน worker create-ad). fallback: ถ้า wwoom พัง + มี tab `affiliate.shopee.co.th` เปิดอยู่ จะ shorten ผ่าน GraphQL ของ Shopee ตรงๆ (pattern เดียวกับ shortlink-v2)
2. **FB ad pipeline** — รันใน MAIN world ของ tab Ads Manager (ใช้ `window.__accessToken` + cookies):
   - upload video (`/{adAccount}/advideos`) หรือ reuse video_id
   - poll thumbnails 60×3s
   - create adcreative
   - **poll story_id 50×3s** (= 150s, เผื่อ FB ตอบช้า)
   - copy template adset เข้า campaign (มีอยู่แล้ว / สร้างใหม่)
   - create ad → activate adset + ad → publish to page feed (`is_published=true`)
3. **Log to worker** — POST `/api/dashboard/extension-ad-log` เพื่อใส่ `post_history` (`trigger_source=feed_extension`) + mark video posted

## Install (โหลดแบบ unpacked)

1. เปิด Chrome → `chrome://extensions`
2. เปิด **Developer mode** (มุมขวาบน)
3. กด **Load unpacked** → เลือกโฟลเดอร์นี้: `apps/feed-ad-extension/`
4. ตรึง icon ไว้บน toolbar (กดรูปปริศนาแล้ว pin)
5. คลิก icon → side panel เปิด

## ใช้งาน

### Pre-requisite

- เปิด tab `https://adsmanager.facebook.com/...` ใน Chrome และ login บัญชีที่มี admin บนเพจฟีด
- (ทางเลือก) เปิด tab `https://affiliate.shopee.co.th/...` ค้างไว้ ถ้าอยากให้ extension fallback ไป Shopee tab ตอน wwoom พัง

### กรอกฟอร์มใน side panel

| Field | ใส่อะไร | Required |
|---|---|---|
| Video ID | FB video id ของวิดีโอที่อัปขึ้น FB แล้ว (เช่น จากตาราง `facebook_page_video_cache`) | one of |
| Video URL | URL ของวิดีโอ (R2/CDN) — ระบบจะ upload ผ่าน `/advideos` ใหม่ | one of |
| Caption | ข้อความหลักของแอด (extension ใส่ `📌 พิกัด : <shortlink>` ให้บรรทัดบนสุดอัตโนมัติ) | ✓ |
| Shopee URL | shopee link เต็ม / s.shopee.co.th | ✓ |
| Existing Campaign ID | campaign id ที่มีอยู่ (เช่น `120245064878470263`) | one of |
| สร้างแคมเปญใหม่ | ชื่อแคมเปญใหม่ (FB จะใช้ objective + buying_type ของ template adset) | one of |
| Ad Account / Template Adset (ขั้นสูง) | override settings — ปกติโหลดอัตโนมัติจาก worker | optional |
| Thumbnail URL (ขั้นสูง) | ถ้ามี thumbnail valid อยู่แล้วจะ skip thumbnail polling | optional |

กด **สร้างแอด ฟีด** → progress bar เลื่อน → แสดง story_id, ad_id, adset_id, FB post URL

## Pipeline ที่รัน (เทียบกับ Electron)

| Step | Electron `video-onecard/electron.js` | Extension `background.js` (in MAIN world) |
|---|---|---|
| Token grab | scrape `window.__accessToken` ผ่าน `executeJavaScript` ทุก 15s | อ่าน `window.__accessToken` ตรงๆ ใน MAIN world |
| Cookies | `useSessionCookies: true` ใน `net.request` | `credentials: 'include'` ใน `fetch` (FB ตั้ง cookies SameSite=None) |
| Upload video | `POST /v21.0/{adAcc}/advideos` | เหมือนกัน |
| Thumbnail poll | 60×3s, gate `>= 1` | เหมือนกัน |
| Create creative | `POST /v21.0/{adAcc}/adcreatives` | เหมือนกัน |
| story_id poll | **50×3s** (เพิ่ง widen จาก 25 → 50 วันนี้) | เหมือนกัน |
| Copy adset | `POST /v21.0/{adset}/copies` | เหมือนกัน |
| Create ad | `POST /v21.0/{adAcc}/ads` | เหมือนกัน |
| Activate | `status: ACTIVE` ทั้ง adset และ ad | เหมือนกัน |
| Publish to page | ดึง page token ผ่าน `/me/accounts` แล้ว `is_published=true` | เหมือนกัน |

## Worker endpoint ที่เพิ่มสำหรับ extension

```
POST https://api.oomnn.com/api/dashboard/extension-ad-log
{
  "page_id": "116759241338040",      // hard-locked
  "video_id": "...",
  "story_id": "...",
  "ad_id": "...",
  "adset_id": "...",
  "creative_id": "...",
  "shopee_link": "...",
  "short_link": "...",
  "comment_id": "..."                // optional
}
```

→ Insert into `post_history` (`trigger_source=feed_extension`) + `markNamespaceVideoPosted(...)` ให้เพจฟีด

## Settings ที่ extension อ่านจาก worker

```
GET https://api.oomnn.com/api/dashboard/settings?page_id=116759241338040
```

ดึง `sub_id`, `sub_id2-5`, `shortlink_url`, `ad_account`, `template_adset` ของฟีด (ที่ตั้งใน dashboard `/feed/settings`)

## Troubleshooting

| ปัญหา | สาเหตุ / แก้ |
|---|---|
| `ไม่มี tab Ads Manager เปิดอยู่` | เปิด `https://adsmanager.facebook.com/...` ใน Chrome ก่อน |
| `ไม่พบ window.__accessToken` | refresh หน้า Ads Manager แล้วลองใหม่ — บางครั้ง FB ยัง inject ไม่เสร็จ |
| `[story_id] Timeout (150s)` | FB ช้ากว่าปกติมาก — ลองกดซ้ำ (transient) |
| `ย่อลิ้ง wwoom + Shopee tab ไม่ work` | เช็ค `short.wwoom.com` ตอบ + ลอง refresh tab Shopee Affiliate (cookies expired?) |
| Extension origin ไม่ใช่ chrome-extension://... | ปกติ background fetch มี host_permissions ของ api.oomnn.com → ไม่ผ่าน CORS check |

## ไฟล์ในโปรเจ็ค

```
apps/feed-ad-extension/
├── manifest.json     ← MV3, host_permissions: facebook + graph + shopee + wwoom + api.oomnn
├── background.js     ← service worker — shortlink + FB ad pipeline (MAIN world)
├── panel.html        ← side panel UI
├── panel.js          ← UI logic
├── panel.css
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

## ที่ extension ไม่ทำ (โดยตั้งใจ)

- **ไม่ post comment** — แค่สร้าง ad + publish to page. ส่วน comment cron ของ worker จะจัดการต่อให้ผ่าน flow ปกติ (เพราะ post_history ถูกเขียนแล้ว `trigger_source=feed_extension`)
- **ไม่สร้าง campaign objective ที่ไม่ตรง** — ใช้ `objective` + `buying_type` ของ `template_adset.campaign` เพื่อกัน FB error 1815149
- **ไม่ดึง gallery video list** — extension ทำงาน standalone, ใช้ video_id/video_url ที่กรอกเอง. (ขั้นต่อไป: ถ้าต้องการ wire เข้า dashboard `/feed`, ส่งผ่าน `chrome.runtime.sendMessage` จาก content script ได้)
- **ไม่แตะเพจอื่น** — page_id hardcode `116759241338040`. worker endpoint ก็ reject อย่างอื่น
