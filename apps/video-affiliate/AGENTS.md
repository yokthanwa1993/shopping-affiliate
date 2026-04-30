# AGENTS.md — video-affiliate

ไฟล์นี้เป็น pointer สำหรับ AI agents ที่เริ่มทำงานจาก `apps/video-affiliate/`

ให้อ่าน context กลางของ monorepo ก่อนเสมอ:

- `../../AGENTS.md`
- `../../CLAUDE.md` สำหรับ Claude Code
- Obsidian project note: `/Users/yok-macmini/Documents/Obsidian Vault/projects/shopping-affiliate.md`

## สรุป video-affiliate

ระบบ Telegram Mini App สำหรับจัดการวิดีโอ affiliate และ auto-post ลง Facebook แบบ multi-tenant

Components:

- `worker/` — Cloudflare Worker API, auth, webhook, cron, DB/migrations
- `webapp/` — React + Vite Telegram Mini App UI
- `token-facebook-lite/` — Cloudflare Worker สำหรับ token helper
- `merge-rust/` — Cloudflare Container สำหรับ video processing / FFmpeg pipeline

## Agent workflow

User should not need to remind the agent to read context or save durable knowledge. Do this automatically:

1. อ่าน `../../AGENTS.md` เป็น context แรก
2. เช็ค `git status --short` จาก repo root
3. ก่อนงานใหญ่ query shared wiki เอง:
   - Claude Code: `/wiki-query video-affiliate <เรื่อง>`
   - Codex CLI: `$wiki-query video-affiliate <เรื่อง>`
   - Hermes: ใช้ `wiki-query`/Obsidian wiki
4. แก้เฉพาะ component ที่เกี่ยวข้องก่อน
5. หลังจบงานสำคัญ ใช้ `/wiki-capture` และ `/wiki-update` เอง เพื่อให้ Hermes/Codex/Claude มีความรู้เดียวกัน
6. ถ้ามี durable knowledge ใหม่ ให้ update Obsidian note `projects/shopping-affiliate.md` หรือ note ที่เกี่ยวข้องโดยไม่ต้องรอให้ user บอก

ห้ามบันทึก secrets/tokens/cookies/API keys ลง repo หรือ wiki
