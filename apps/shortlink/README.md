# Shopee Affiliate Shortlink

ระบบย่อลิ้ง Shopee Affiliate พร้อม Sub IDs — รับ Shopee URL แล้วคืน affiliate shortlink กลับมาเป็น JSON

---

## ภาพรวมระบบ

```
ผู้ใช้ส่ง URL                  Cloudflare Worker              Electron App (Ubuntu Desktop)
─────────────────────────────────────────────────────────────────────────────────────────────
GET /?url=...&sub1=yok  ──►  BridgeDO (Durable Object)  ──►  WebSocket (persistent)
                              รับ job → ส่งผ่าน WebSocket        ↓
                                                           expandUrl() + normalizeShopeeUrl()
                                                                ↓
                                                           executeJavaScript()
                                                                ↓
                                                      WebView: affiliate.shopee.co.th
                                                      (Shopee SDK inject security headers)
                                                                ↓
                                                      XHR → Shopee GraphQL API
                              ◄── ส่ง result กลับ    ◄──  { jobId, ok, shortLink, utmSource }
GET response JSON
```

**เหตุที่ต้องใช้ Electron WebView** — Shopee GraphQL API (`/api/v3/gql`) ต้องการ security headers ที่ Shopee SDK inject เข้า XHR โดยอัตโนมัติเมื่อรันจาก page context ของ affiliate.shopee.co.th เท่านั้น ไม่สามารถเรียกตรงจาก server ได้

**เหตุที่ expand URL ที่ Electron ไม่ใช่ Worker** — Cloudflare IP ถูก Shopee block ไม่ให้ follow redirect ของ `s.shopee.co.th` Electron รันบนเครื่อง Ubuntu ปกติจึง follow redirect ได้

---

## โครงสร้าง

```
apps/shortlink/
├── electron/
│   ├── main.js           ← Electron runtime หลักสำหรับทุก account
│   ├── main-neezs.js     ← compatibility wrapper สำหรับ neezs
│   ├── package.json
│   └── icons/
├── worker-chearb/        ← Cloudflare Worker สำหรับ account chearb
│   ├── src/
│   │   ├── index.js      ← Worker entry point + CORS
│   │   └── BridgeDO.js   ← Durable Object: WebSocket bridge + job queue
│   └── wrangler.toml
└── worker-neezs/         ← Cloudflare Worker สำหรับ account neezs
    └── wrangler.toml     ← ชี้ไปที่ worker-chearb/src เดิม (share code)
```

---

## Accounts

| Account | Electron | Port | Worker URL |
|---------|----------|------|------------|
| chearb | `main.js` | 3000 | `https://chearb-shopee-shortlink.yokthanwa1993-bc9.workers.dev` |
| neezs | `main.js` | 3001 | `https://neezs-shopee-shortlink.yokthanwa1993-bc9.workers.dev` |

แต่ละ account มี Worker แยกกัน และ Electron แยก session (`--user-data-dir`) ทำให้ login คนละ Shopee account ได้บนเครื่องเดียวกัน

---

## electron/

### หน้าที่
- เปิด WebView โหลด `https://affiliate.shopee.co.th/offer/custom_link`
- รัน HTTP server รับ shortlink request (chearb: 3000, neezs: 3001)
- เชื่อมต่อ Cloudflare Worker ผ่าน WebSocket persistent เพื่อรับ remote jobs
- ใช้ `executeJavaScript()` inject XHR เข้า WebView เพื่อเรียก Shopee API

### การทำงานของ generateLink()

```
HTTP request หรือ WebSocket job เข้ามา
    ↓
expandUrl()  →  s.shopee.co.th → follow redirect → URL เต็ม (พร้อม query string)
    ↓
normalizeShopeeUrl()  →  แปลงเป็น https://shopee.co.th/product/{shopId}/{itemId}
    ↓
executeJavaScript() inject XHR ใน WebView context
    ↓
XHR POST affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink
  Headers: Content-Type, affiliate-program-type: 1, csrf-token (จาก cookie)
  Shopee SDK hook XHR → auto-inject security headers
    ↓
parse response → batchCustomLink[0].shortLink + longLink
    ↓
extract utm_source จาก longLink
    ↓
return { shortLink, utmSource }
```

### URL Formats ที่รองรับ

| รูปแบบ | ตัวอย่าง |
|--------|---------|
| Short URL | `https://s.shopee.co.th/9zstijKyqQ` |
| i-i format | `https://shopee.co.th/i-i.1128143671.27358001883` |
| username/shopId/itemId | `https://shopee.co.th/opaanlp/1128143671/27358001883` |
| product format | `https://shopee.co.th/product/1128143671/27358001883` |

ทุก format จะถูก normalize เป็น `https://shopee.co.th/product/{shopId}/{itemId}` ก่อนส่งไป Shopee API

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/?url=...&sub1=...` | GET | ย่อลิ้ง Shopee URL |
| `/status` | GET | เช็คสถานะ server + WebView |
| `/debug` | GET | debug ข้อมูลใน WebView (url, cookie, title) |

### Cloudflare Bridge (WebSocket)

- เชื่อมต่อ `wss://[worker-url]/ws` แบบ persistent
- รับ job `{ jobId, payload }` จาก Worker → expand + normalize → ย่อลิ้ง → ส่ง result กลับ
- auto-reconnect ทุก 3 วินาที ถ้า disconnect

### รันบน Ubuntu Desktop

**chearb (account แรก):**
```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  nohup ~/shopee-shortlink/node_modules/.bin/electron \
  ~/shopee-shortlink \
  --no-sandbox --ozone-platform=wayland \
  --user-data-dir=/home/yok/.config/shopee-chearb > /tmp/electron-chearb.log 2>&1 &
```

**neezs (account สอง):**
```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  nohup ~/shopee-shortlink/node_modules/.bin/electron \
  ~/shopee-shortlink/main.js \
  --no-sandbox --ozone-platform=wayland \
  --user-data-dir=/home/yok/.config/shopee-neezs > /tmp/electron-neezs.log 2>&1 &
```

> **หมายเหตุ:** ต้อง login เข้า Shopee Affiliate ใน WebView ที่เปิดขึ้นมาครั้งแรก
> Session จะถูก save ไว้ใน `--user-data-dir` ที่กำหนด ไม่ต้อง login ซ้ำ

### รันบน macOS (เฉพาะ dev)

```bash
cd electron
npm install
node_modules/.bin/electron .
```

### Build .dmg (macOS)

```bash
bun run build
# ได้ไฟล์: dist/Shopee Shortlink-1.0.0-arm64.dmg
```

---

## worker-chearb/ และ worker-neezs/

### หน้าที่
รับ HTTP request จากภายนอก → ส่งงานไปให้ Electron ผ่าน WebSocket → รอผล → คืน JSON

### Durable Object: BridgeDO

Cloudflare Durable Object ทำหน้าที่เป็น "ตัวกลาง" ระหว่าง client กับ Electron

```
/ws endpoint    → Electron เชื่อมต่อ WebSocket ไว้ตลอด (1 connection)
/ endpoint      → Client ส่ง request → DO ส่ง job ผ่าน WebSocket → รอผล → response
```

**flow รายละเอียด:**
1. Client: `GET /?url=https://s.shopee.co.th/xxx&sub1=chearb`
2. Worker รับ request → ส่ง `{ jobId, payload: { rawUrl, subId1-5 } }` ไปทาง WebSocket
3. Electron รับ job → expand + normalize URL → เรียก Shopee API
4. Electron ส่ง `{ jobId, ok, shortLink, utmSource, normalizedUrl, redirectUrl }` กลับมา
5. Worker คืน JSON ให้ client

### Code Sharing

`worker-neezs/wrangler.toml` ชี้ main ไปที่ `../worker-chearb/src/index.js` — ใช้ code เดียวกัน ต่างแค่ชื่อ Worker และ Durable Object instance

### Deploy

```bash
# chearb
cd worker-chearb
wrangler deploy

# neezs
cd worker-neezs
wrangler deploy
```

---

## วิธีใช้งาน

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | ✅ | Shopee product URL (รองรับทุก format รวมถึง s.shopee.co.th) |
| `sub1` | ❌ | Sub ID 1 (tracking — มักใช้เป็นชื่อ account เช่น `chearb`) |
| `sub2`–`sub5` | ❌ | Sub ID 2–5 |

### Response

```json
{
  "originalLink": "https://s.shopee.co.th/9zstijKyqQ",
  "redirectLink": "https://shopee.co.th/opaanlp/1128143671/27358001883",
  "longLink":     "https://shopee.co.th/product/1128143671/27358001883",
  "shortLink":    "https://s.shopee.co.th/xxxxx",
  "utm_source":   "an_15130770000",
  "sub1": "chearb",
  "sub2": null,
  "sub3": null,
  "sub4": null,
  "sub5": null
}
```

| Field | Description |
|-------|-------------|
| `originalLink` | URL ที่ส่งมา (อาจเป็น s.shopee.co.th หรือ URL ยาว) |
| `redirectLink` | URL หลัง expand redirect (มีเฉพาะกรณีส่ง s.shopee.co.th มา) |
| `longLink` | URL normalize แล้ว รูปแบบ `/product/{shopId}/{itemId}` |
| `shortLink` | Affiliate shortlink ที่ได้จาก Shopee |
| `utm_source` | Publisher ID ของ account ที่ย่อ (ยืนยันว่าย่อถูก account) |

### Error Responses

| Status | ความหมาย |
|--------|----------|
| 400 | ไม่มี `url` parameter |
| 503 | Electron app ไม่ได้เชื่อมต่อ — เปิด app ก่อน |
| 504 | Electron ไม่ตอบกลับภายใน 20 วินาที |

---

## เงื่อนไขการทำงาน

1. **Electron app ต้องรันอยู่** — ถ้าปิด Worker จะ return 503
2. **ต้อง login Shopee Affiliate ใน WebView** — ครั้งแรกต้อง login ด้วยตัวเอง
3. **WebView ต้องอยู่ที่ affiliate.shopee.co.th** — ถ้า navigate ออกไป bridge จะหยุดทำงาน
4. **แต่ละ account ต้องใช้ `--user-data-dir` คนละ path** — ป้องกัน session ปนกัน

---

## สาเหตุที่ใช้ WebSocket แทน HTTP Long-Poll

เวอร์ชันแรกใช้ HTTP long-poll (Electron poll Worker ทุก 5 วินาที):
- Worst-case latency: 5+ วินาที
- ต้องทำ 2 HTTP requests ต่อ 1 job

เวอร์ชันปัจจุบันใช้ WebSocket persistent connection:
- Latency: ~0 ms (ส่งงานได้ทันทีที่ job เข้ามา)
- 1 round-trip ต่อ 1 job
- Total time (Worker → Electron → Shopee API → กลับ): ~0.5 วินาที
