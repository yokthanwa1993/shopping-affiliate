# Video Affiliate

ระบบ Telegram Mini App สำหรับจัดการวิดีโอ affiliate และ auto-post ลง Facebook แบบ multi-tenant

## Components
- `worker/` — Cloudflare Worker (API, auth, webhook, cron)
- `merge-rust/` — Cloudflare Container สำหรับ pipeline/FFmpeg
- `webapp/` — React + Vite (Mini App UI)

## Production
- Worker: `https://video-affiliate-worker.yokthanwa1993-bc9.workers.dev`
- Webapp: `https://video-affiliate-webapp.pages.dev`

## Deploy
### Worker
```bash
cd worker
npx wrangler deploy
```

### Webapp
```bash
cd webapp
npm run build
npx wrangler pages deploy dist --project-name video-affiliate-webapp --branch main --commit-dirty=true
```

### Container
```bash
cd merge-rust
wrangler containers build . --tag video-affiliate-worker-mergecontainer:v{VERSION}
docker tag video-affiliate-worker-mergecontainer:v{VERSION} video-affiliate-worker-mergecontainer:v{VERSION}
wrangler containers push video-affiliate-worker-mergecontainer:v{VERSION}
```

## Session Behavior
- ผู้ใช้ login ครั้งเดียวอยู่ถาวรจนกว่าจะกด logout
- Webapp รับเฉพาะ session token (`sess_...`)
- ข้อมูลแยกตาม `namespace_id` (owner/team)

## Naming Convention (ห้ามใช้ชื่อเก่า)
- ใช้ `video-affiliate-*` ทุกจุด
- หลีกเลี่ยงชื่อ legacy ใน runtime และเอกสาร

ดูรายละเอียดเชิงระบบที่ [AGENTS.md](/Users/yok/Developer/shopping-affiliate/video-affiliate/AGENTS.md)
