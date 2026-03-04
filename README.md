# shopping-affiliate (Monorepo)

รวม 2 ระบบที่ทำงานร่วมกันใน repo เดียว:

- `video-affiliate/` — Telegram Mini App + Worker + FFmpeg/Rust container
- `browsersaving/` — Browser Profile Manager (API + Worker + Tauri App)

วัตถุประสงค์ของโครงสร้างนี้คือให้ AI และทีมแก้ code ได้ใน workflow เดียว โดยคงขอบเขตของแต่ละ service ไว้ชัดเจน

## โครงสร้างไฟล์หลัก

- `video-affiliate/worker/` Cloudflare Worker API + webhook + cron + auth
- `video-affiliate/webapp/` Telegram Mini App (React + Vite)
- `video-affiliate/token-facebook-lite/` Cloudflare Worker สำหรับ token helper
- `video-affiliate/merge-rust/` Cloudflare Container สำหรับ pipeline/video processing

- `browsersaving/worker/` Cloudflare Worker จัดการ profiles/cookies
- `browsersaving/api/` Node API ดึง Postcron token
- `browsersaving/src/` Tauri + React UI
- `browsersaving/src-tauri/` Tauri Rust bridge

## คำสั่งที่รันจาก root

ใช้คำสั่งจาก root repo เพื่อควบคุมงานในแต่ละส่วนได้ง่ายขึ้น:

- `npm run start:video-affiliate:webapp`
- `npm run start:video-affiliate:worker`
- `npm run start:browsersaving:webapp`
- `npm run start:browsersaving:api`
- `npm run start:browsersaving:worker`
- `npm run tauri:dev:browsersaving`
- `npm run help:mono` (ดู command ช่วยเหลือแบบย่อ)

## แนวทางทำงานแบบ monorepo

1. แยกงานตาม boundary ให้ชัด
2. แก้เฉพาะไฟล์ในระบบที่เกี่ยวข้องก่อน (video-affiliate vs browsersaving)
3. ถ้าทำ endpoint/contract ร่วมกัน ให้อัปเดตทั้งสองฝั่งและเพิ่มบันทึกใน README
4. ไม่ย้ายไฟล์ไปยังที่อื่น ๆ โดยไม่จำเป็น เพื่อให้ deployment เดิมทำงานต่อได้

## Deployment (ตัวอย่างเดิมตาม AGENTS)

- Video Affiliate Worker: `video-affiliate/worker/wrangler.toml`
- Video Affiliate Pages: `video-affiliate/webapp`
- BrowserSaving Worker: `browsersaving/worker/wrangler.toml`
- BrowserSaving API: `browsersaving/api`
- BrowserSaving Desktop: `browsersaving/src` + `browsersaving/src-tauri`

## หมายเหตุ

- repository นี้เป็น monorepo เชิงการจัดการงาน (operational monorepo) ยังไม่บังคับให้ dependency ถูก install รวมที่ root
- ล๊อคไฟล์เดิมยังคงอยู่คนละโปรเจกต์เพื่อกันความเสี่ยงของการ deploy workflow เดิม
