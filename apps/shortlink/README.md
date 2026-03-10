# Shopee Affiliate Shortlink

ระบบย่อลิ้ง Shopee Affiliate พร้อม Sub IDs — รับ Shopee URL แล้วคืน affiliate shortlink กลับมาเป็น JSON

---

## ภาพรวมระบบ

```
ผู้ใช้ส่ง URL                  Cloudflare Worker              Electron App (เครื่อง Ubuntu/Mac)
─────────────────────────────────────────────────────────────────────────────────────────────
GET /?url=...&sub1=yok  ──►  BridgeDO (Durable Object)  ──►  WebSocket (persistent)
                              รับ job → ส่งผ่าน WebSocket        ↓
                                                           executeJavaScript()
                                                                ↓
                                                      WebView: affiliate.shopee.co.th
                                                      (Shopee SDK inject security headers)
                                                                ↓
                                                      XHR → Shopee GraphQL API
                              ◄── ส่ง shortLink กลับ  ◄──  ส่งผล { jobId, ok, shortLink }
GET response JSON
```

**เหตุที่ต้องใช้ Electron WebView** — Shopee GraphQL API (`/api/v3/gql`) ต้องการ security headers ที่ Shopee SDK inject เข้า XHR โดยอัตโนมัติเมื่อรันจาก page context ของ affiliate.shopee.co.th เท่านั้น ไม่สามารถเรียกตรงจาก server ได้

---

## โครงสร้าง

```
apps/shortlink/
├── electron/          ← Electron app รันบนเครื่อง (Mac หรือ Ubuntu Desktop)
│   ├── main.js        ← entry point ทั้งหมด
│   ├── package.json
│   └── icons/
└── worker/            ← Cloudflare Worker (deployed)
    ├── src/
    │   ├── index.js   ← Worker entry point + CORS
    │   └── BridgeDO.js ← Durable Object: WebSocket bridge + job queue
    └── wrangler.toml
```

---

## electron/

### หน้าที่
- เปิด WebView โหลด `https://affiliate.shopee.co.th/offer/custom_link`
- รัน HTTP server บน `localhost:3000` รับ shortlink request
- เชื่อมต่อ Cloudflare Worker ผ่าน WebSocket (persistent) เพื่อรับ remote jobs
- ใช้ `executeJavaScript()` inject XHR เข้า WebView เพื่อเรียก Shopee API

### การทำงานของ generateLink()

```
HTTP request เข้า localhost:3000?url=...&sub1=...
    ↓
normalizeShopeeUrl()  →  แปลง URL ยาว → https://shopee.co.th/i-i.{shopId}.{itemId}
    ↓
executeJavaScript() inject ใน WebView context
    ↓
XHR POST affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink
  Headers: Content-Type, affiliate-program-type: 1, csrf-token (จาก cookie)
  Shopee SDK hook XHR → auto-inject security headers
    ↓
parse response → batchCustomLink[0].shortLink
    ↓
return JSON { originalUrl, shortLink, affiliateLink, sub1-5 }
```

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/?url=...&sub1=...` | GET | ย่อลิ้ง Shopee URL |
| `/status` | GET | เช็คสถานะ server + WebView |
| `/debug` | GET | debug ข้อมูลใน WebView (url, cookie, title) |

### Cloudflare Bridge (WebSocket)

- เชื่อมต่อ `wss://[worker-url]/ws` แบบ persistent
- รับ job `{ jobId, payload }` จาก Worker → ย่อลิ้ง → ส่ง `{ jobId, ok, shortLink }` กลับ
- auto-reconnect ทุก 3 วินาที ถ้า disconnect

### รันบน macOS

```bash
cd electron
npm install
node_modules/.bin/electron .
```

### รันบน Ubuntu Desktop

```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  node_modules/.bin/electron . --no-sandbox --ozone-platform=wayland
```

> **หมายเหตุ:** ต้อง login เข้า Shopee Affiliate ใน WebView ที่เปิดขึ้นมาครั้งแรก
> Session จะถูก save ไว้ใน `~/.config/shopee-shortlink/` ไม่ต้อง login ซ้ำ

### Build .dmg (macOS)

```bash
bun run build
# ได้ไฟล์: dist/Shopee Shortlink-1.0.0-arm64.dmg
```

---

## worker/

### หน้าที่
รับ HTTP request จากภายนอก → ส่งงานไปให้ Electron ผ่าน WebSocket → รอผล → คืน JSON

### Durable Object: BridgeDO

Cloudflare Durable Object ทำหน้าที่เป็น "ตัวกลาง" ระหว่าง client กับ Electron

```
/ws endpoint    → Electron เชื่อมต่อ WebSocket ไว้ตลอด (1 connection)
/ endpoint      → Client ส่ง request → DO ส่ง job ผ่าน WebSocket → รอผล → response
```

**flow รายละเอียด:**
1. Client: `GET /?url=https://shopee.co.th/i-i.xxx.yyy&sub1=yok`
2. DO สร้าง `jobId` + normalize URL
3. ส่ง `{ jobId, payload }` ไปทาง WebSocket ให้ Electron ทันที
4. รอ response จาก Electron (timeout 20 วินาที)
5. Electron ส่ง `{ jobId, ok, shortLink }` กลับมา
6. DO คืน JSON ให้ client

### Deploy

```bash
cd worker
npx wrangler deploy
```

Worker URL: `https://shopee-shortlink.yokthanwa1993-bc9.workers.dev`

---

## วิธีใช้งาน

### จากเครื่องเดียวกับ Electron (เร็วที่สุด ~0.2s)

```
http://localhost:3000?url=https://shopee.co.th/i-i.{shopId}.{itemId}&sub1=yok
```

### จากที่ไหนก็ได้ผ่าน Cloudflare Worker (~0.5s)

```
https://shopee-shortlink.yokthanwa1993-bc9.workers.dev?url=https://shopee.co.th/i-i.{shopId}.{itemId}&sub1=yok&sub2=ig
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | ✅ | Shopee product URL (รองรับ URL ยาวหรือสั้นก็ได้) |
| `sub1` | ❌ | Sub ID 1 (tracking) |
| `sub2` | ❌ | Sub ID 2 |
| `sub3` | ❌ | Sub ID 3 |
| `sub4` | ❌ | Sub ID 4 |
| `sub5` | ❌ | Sub ID 5 |

### Response

```json
{
  "originalUrl": "https://shopee.co.th/i-i.295061178.3946320824",
  "shortLink":   "https://shopee.co.th/i-i.295061178.3946320824",
  "affiliateLink": "https://s.shopee.co.th/xxxxx",
  "sub1": "yok",
  "sub2": null,
  "sub3": null,
  "sub4": null,
  "sub5": null
}
```

### Error Responses

| Status | ความหมาย |
|--------|----------|
| 400 | ไม่มี `url` parameter |
| 503 | Electron app ไม่ได้เชื่อมต่อ |
| 504 | Electron ไม่ตอบกลับภายใน 20 วินาที |

---

## เงื่อนไขการทำงาน

1. **Electron app ต้องรันอยู่** — ถ้าปิด Worker จะ return 503
2. **ต้อง login Shopee Affiliate ใน WebView** — ครั้งแรกต้อง login ด้วยตัวเอง
3. **WebView ต้องอยู่ที่ affiliate.shopee.co.th** — ถ้า navigate ออกไป bridge จะหยุดทำงาน

---

## สาเหตุที่ใช้ WebSocket แทน HTTP Long-Poll

เวอร์ชันแรกใช้ HTTP long-poll (Electron poll Worker ทุก 5 วินาที):
- Worst-case latency: 5+ วินาที
- ต้องทำ 2 HTTP requests ต่อ 1 job (poll + complete)

เวอร์ชันปัจจุบันใช้ WebSocket persistent connection:
- Latency: ~0 ms (ส่งงานได้ทันทีที่ job เข้ามา)
- 1 round-trip ต่อ 1 job
- Total time (Worker): ~0.5 วินาที
