# AGENTS.md — Shopee Affiliate Shortlink System

คู่มือสำหรับ AI Agent ที่จะทำงานกับโปรเจคนี้ อ่านไฟล์นี้ก่อนทุกครั้ง

---

## ภาพรวมระบบ

ระบบประกอบด้วย 2 ส่วนหลักที่ทำงานร่วมกัน:

```
[Client] → HTTP GET /?url=...
               ↓
    [Cloudflare Worker] (always on, public URL)
    BridgeDO Durable Object
               ↓ WebSocket (persistent)
    [Electron App บน Ubuntu] (รันอยู่บนเครื่อง 172.19.20.9)
    WebView: affiliate.shopee.co.th
               ↓ XHR (Shopee SDK inject security headers)
    [Shopee GraphQL API]
               ↓
    shortLink + utmSource กลับมา
```

---

## Accounts และ Services

| Account | Worker | Worker URL | Electron Port | User Data Dir |
|---------|--------|------------|---------------|---------------|
| chearb | `chearb-shopee-shortlink` | `https://chearb-shopee-shortlink.yokthanwa1993-bc9.workers.dev` | 3000 | `~/.config/shopee-chearb` |
| neezs | `neezs-shopee-shortlink` | `https://neezs-shopee-shortlink.yokthanwa1993-bc9.workers.dev` | 3001 | `~/.config/shopee-neezs` |

### Shopee Affiliate Credentials

| Account | Email | Password |
|---------|-------|----------|
| chearb | `affiliate@chearb.com` | `!@7EvaYLj986` |
| neezs | `affiliate@neezs.com` | `!Affiliate@neezs` |

---

## โครงสร้างไฟล์

```
apps/shortlink/
├── electron/
│   ├── main.js           ← Electron entry point สำหรับ account chearb
│   ├── main-neezs.js     ← Electron entry point สำหรับ account neezs
│   │                        (generate จาก main.js โดย sed — ห้ามแก้มือ)
│   ├── package.json
│   └── icons/tray.png
├── worker-chearb/
│   ├── src/
│   │   ├── index.js      ← Worker entry point + CORS
│   │   └── BridgeDO.js   ← Durable Object: WebSocket bridge + job queue
│   └── wrangler.toml     ← name = "chearb-shopee-shortlink"
└── worker-neezs/
    └── wrangler.toml     ← name = "neezs-shopee-shortlink"
                             main = "../worker-chearb/src/index.js" (share code)
```

**กฎสำคัญ:** `main-neezs.js` ต้อง generate จาก `main.js` เสมอ ห้ามแก้มือ — ใช้คำสั่ง:
```bash
sed 's/const PORT = 3000/const PORT = 3001/; s/chearb-shopee-shortlink/neezs-shopee-shortlink/g; s/affiliate@chearb\.com/affiliate@neezs.com/g; s/!@7EvaYLj986/!Affiliate@neezs/g' electron/main.js > electron/main-neezs.js
```

---

## เครื่อง Ubuntu (Server)

### SSH Access
```
Host: 172.19.20.9
User: yok
Auth: SSH key (ไม่ต้องใส่ password)
```

```bash
ssh yok@172.19.20.9
```

### โครงสร้างบน Ubuntu
```
~/shopee-shortlink/
├── main.js           ← copy มาจาก electron/main.js
├── main-neezs.js     ← copy มาจาก electron/main-neezs.js
├── package.json
├── node_modules/     ← มีอยู่แล้ว ไม่ต้อง npm install ใหม่
└── icons/tray.png
```

### สถานะ Electron ปัจจุบัน
ดูสถานะ process:
```bash
ssh yok@172.19.20.9 "ps aux | grep electron | grep -v grep"
```

เช็ค log:
```bash
ssh yok@172.19.20.9 "tail -20 /tmp/electron-chearb.log"
ssh yok@172.19.20.9 "tail -20 /tmp/electron-neezs.log"
```

เช็คว่า login อยู่ไหม:
```bash
ssh yok@172.19.20.9 "curl -s http://localhost:3000/status"  # chearb
ssh yok@172.19.20.9 "curl -s http://localhost:3001/status"  # neezs
```

Response ที่ดี: `{"loggedIn":true}`

---

## Deploy Workflow

### เมื่อแก้ไข electron/main.js

**ขั้นตอน (ทำตามลำดับ):**

1. แก้ไข `electron/main.js`
2. Regenerate `main-neezs.js`:
```bash
sed 's/const PORT = 3000/const PORT = 3001/; s/chearb-shopee-shortlink/neezs-shopee-shortlink/g; s/affiliate@chearb\.com/affiliate@neezs.com/g; s/!@7EvaYLj986/!Affiliate@neezs/g' apps/shortlink/electron/main.js > apps/shortlink/electron/main-neezs.js
```
3. Copy ไป Ubuntu:
```bash
scp apps/shortlink/electron/main.js yok@172.19.20.9:~/shopee-shortlink/main.js
scp apps/shortlink/electron/main-neezs.js yok@172.19.20.9:~/shopee-shortlink/main-neezs.js
```
4. Restart Electron บน Ubuntu:
```bash
ssh -T yok@172.19.20.9 << 'EOF'
pkill -f 'electron' 2>/dev/null; sleep 2

# chearb
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  nohup /home/yok/shopee-shortlink/node_modules/.bin/electron \
  /home/yok/shopee-shortlink \
  --no-sandbox --ozone-platform=wayland \
  --user-data-dir=/home/yok/.config/shopee-chearb > /tmp/electron-chearb.log 2>&1 &

# neezs
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  nohup /home/yok/shopee-shortlink/node_modules/.bin/electron \
  /home/yok/shopee-shortlink/main-neezs.js \
  --no-sandbox --ozone-platform=wayland \
  --user-data-dir=/home/yok/.config/shopee-neezs > /tmp/electron-neezs.log 2>&1 &

sleep 15
curl -s http://localhost:3000/status
curl -s http://localhost:3001/status
EOF
```
5. ตรวจสอบ `loggedIn: true` ทั้งสอง

### เมื่อแก้ไข Worker (BridgeDO.js หรือ index.js)

**Deploy chearb:**
```bash
cd apps/shortlink/worker-chearb
wrangler deploy
```

**Deploy neezs** (share code กัน ถ้า source เปลี่ยนต้อง deploy ทั้งคู่):
```bash
cd apps/shortlink/worker-neezs
wrangler deploy
```

**ข้อควรระวัง:** `worker-neezs/wrangler.toml` ชี้ main ไปที่ `../worker-chearb/src/index.js` — deploy จาก directory `worker-neezs` เท่านั้น อย่า deploy จาก `worker-chearb` แล้วคิดว่า neezs อัพเดตด้วย

### เมื่อแก้ทั้ง Worker และ Electron

ทำทั้ง 2 ขั้นตอนข้างต้น โดย deploy Worker ก่อน restart Electron ทีหลัง

---

## Auto-Login System

Electron มีระบบ auto-login อัตโนมัติ:

1. เมื่อ WebView โหลดเสร็จ (`did-finish-load`) ระบบเช็ค URL
2. ถ้า URL มี `/buyer/login` → เรียก `autoLogin()`
3. `autoLogin()` ใช้ retry loop (รอสูงสุด 5 วินาที) รอให้ React render form
4. Set value ด้วย native input setter (ไม่ใช่ `.value =` ตรงๆ เพราะ React จะไม่เห็น)
5. Dispatch `input` + `change` events
6. หา button ที่มีข้อความ "เข้าสู่ระบบ" แล้ว click
7. หลัง login สำเร็จ navigate ไป `/offer/custom_link` → `did-navigate` event → `startBridge()`

**Session Persistence:** cookies ถูก save ใน `--user-data-dir` ทำให้ครั้งต่อไปที่เปิด Electron จะ logged in อยู่แล้ว auto-login จะทำงานก็ต่อเมื่อ session หมดอายุเท่านั้น

---

## Autostart บน Ubuntu

ไฟล์ autostart อยู่ที่ `~/.config/autostart/` บน Ubuntu:
- `shopee-chearb.desktop` — รัน chearb ตอน login เข้า desktop
- `shopee-neezs.desktop` — รัน neezs ตอน login เข้า desktop

**ข้อจำกัด:** autostart ทำงานหลัง login เข้า GNOME desktop เท่านั้น ถ้าเครื่องมี auto-login (GDM config) จะรันอัตโนมัติหลัง boot โดยไม่ต้องมีคนนั่งอยู่

---

## Testing

### ทดสอบ chearb
```bash
curl -s "https://chearb-shopee-shortlink.yokthanwa1993-bc9.workers.dev?url=https://s.shopee.co.th/9zstijKyqQ&sub1=chearb" | python3 -m json.tool
```

### ทดสอบ neezs
```bash
curl -s "https://neezs-shopee-shortlink.yokthanwa1993-bc9.workers.dev?url=https://s.shopee.co.th/9zstijKyqQ&sub1=neezs" | python3 -m json.tool
```

**Response ที่ถูกต้อง:**
```json
{
  "originalLink": "https://s.shopee.co.th/9zstijKyqQ",
  "redirectLink": "https://shopee.co.th/opaanlp/1128143671/27358001883",
  "longLink":     "https://shopee.co.th/product/1128143671/27358001883",
  "shortLink":    "https://s.shopee.co.th/xxxxx",
  "utm_source":   "an_15130770000",
  "sub1": "chearb"
}
```

**ยืนยัน account จาก `utm_source`:**
- chearb = `an_15130770000`
- neezs = `an_15142270000`

### Error Cases

| Error | สาเหตุ | วิธีแก้ |
|-------|--------|---------|
| `{"error":"Electron app ไม่ได้เชื่อมต่อ"}` (503) | Electron ไม่ได้รัน | Start Electron บน Ubuntu |
| `{"error":"XHR network error"}` | Electron รันอยู่แต่ยังไม่ได้ login | รอ auto-login (15-20 วินาที) หรือเช็ค `/status` |
| `{"error":"Shopee failCode: 2"}` | URL ที่ส่งไป Shopee API ไม่ถูกต้อง | เช็ค normalizeShopeeUrl |
| `{"error":"หมดเวลา"}` (504) | Electron ไม่ตอบกลับใน 20 วินาที | เช็ค log บน Ubuntu |

---

## Git Workflow

Repository: `github.com/yokthanwa1993/shopping-affiliate`
Working dir: `/Users/yok/Developer/shopping-affiliate`
Branch: `main`

```bash
cd /Users/yok/Developer/shopping-affiliate
git add apps/shortlink/
git commit -m "feat/fix/chore(shortlink): ..."
git push
```

**ไม่ต้อง push ขึ้น Ubuntu** — ใช้ `scp` copy ไฟล์โดยตรงแทน (Ubuntu ไม่ได้ pull จาก git)

---

## ข้อควรระวัง

1. **อย่าแก้ `main-neezs.js` มือ** — generate จาก `main.js` เสมอ ไม่งั้นจะ out of sync
2. **Worker neezs share code กับ chearb** — ถ้าแก้ `BridgeDO.js` หรือ `index.js` ต้อง deploy ทั้ง 2 worker
3. **`s.shopee.co.th` expand ที่ Electron ไม่ใช่ Worker** — Cloudflare IP ถูก Shopee block
4. **Session cookie บน Ubuntu** — อยู่ใน `~/.config/shopee-chearb` และ `~/.config/shopee-neezs` ห้ามลบ
5. **WebSocket 101 response** — `index.js` ต้อง `return resp` ตรงๆ ห้าม wrap ด้วย `new Response()`
