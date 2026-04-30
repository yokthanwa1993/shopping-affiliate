# AGENTS.md — shopping-affiliate

ไฟล์นี้คือ context กลางของโปรเจกต์สำหรับ AI agents ทุกตัวที่เข้ามาทำงานใน repo นี้ เช่น Hermes, Codex CLI และ Claude Code

## Automatic startup + shared memory policy

AI agents must not wait for the user to say “อ่าน AGENTS.md”, “query wiki”, or “บันทึกไว้”. When working anywhere inside this repo, do this automatically:

1. Treat this `AGENTS.md` as the first project context file.
2. Before non-trivial work, search/read the shared Obsidian wiki for relevant existing knowledge.
3. Use `projects/shopping-affiliate.md` as the shared project note.
4. During work, keep track of durable findings: architecture decisions, commands that worked/failed, deployment steps, invariants, integration contracts, recurring bugs, and troubleshooting conclusions.
5. Before finishing, write durable findings back to the shared wiki/project notes without waiting for the user to ask.
6. Do not save temporary TODOs, raw logs, secrets, tokens, cookies, API keys, private connection strings, or one-off noisy details. Use `[REDACTED]` if a secret must be referenced.

## Source of truth สำหรับความรู้ร่วมกัน

- Knowledge base หลักอยู่ที่ Obsidian vault: `/Users/yok-macmini/Documents/Obsidian Vault`
- ระบบจัดการ wiki ใช้ repo: `/Users/yok-macmini/Developer/obsidian-wiki`
- Config กลางอยู่ที่: `~/.obsidian-wiki/config`
- ทั้ง Hermes, Codex CLI และ Claude Code มี obsidian-wiki skills ชุดเดียวกัน 25 ตัว และชี้ไปที่ vault เดียวกัน
- ก่อนเริ่มงานใหญ่ ให้ค้นความรู้เดิมจาก wiki เองโดยอัตโนมัติ เช่น `wiki-query` / `$wiki-query` / `/wiki-query`
- หลังทำงานสำคัญเสร็จ ให้ capture/update ความรู้กลับเข้า wiki เอง เพื่อให้ agent ตัวอื่นอ่านต่อได้
- ห้ามบันทึก secrets, tokens, API keys, cookies หรือ connection strings ลงใน repo/Obsidian/wiki; ให้ใช้ `[REDACTED]` ถ้าจำเป็นต้องกล่าวถึง

## Project overview

`shopping-affiliate` เป็น operational monorepo สำหรับหลายระบบ affiliate/shopping automation ที่ทำงานร่วมกัน แต่ยังคง dependency และ deployment แยกตาม app เพื่อไม่ให้กระทบ production เดิม

ระบบหลักใน repo:

1. `apps/video-affiliate/`
   - Telegram Mini App สำหรับจัดการวิดีโอ affiliate และ auto-post ลง Facebook แบบ multi-tenant
   - มี Cloudflare Worker, React/Vite webapp, token helper และ FFmpeg/Rust container

2. `apps/browsersaving/`
   - Browser Profile Manager สำหรับจัดการ browser profiles/cookies/token workflows
   - มี webapp, Node API, Cloudflare Worker และ Tauri desktop bridge

3. `apps/dashboard/`
   - Dashboard web UI แยกสำหรับงานจัดการ/monitoring

4. `apps/affiliate-shortlink/`
   - ระบบ shortlink/affiliate link tooling เดิม

5. `apps/video-onecard/`
   - ระบบ video/one-card helper เดิม

## Important boundaries

- แก้เฉพาะ app ที่เกี่ยวข้องกับ task ก่อน อย่า refactor ข้ามระบบถ้าไม่จำเป็น
- อย่าย้ายโครงสร้างไฟล์หรือรวม dependency โดยไม่มีเหตุผล เพราะ repo นี้ตั้งใจคง deployment workflow เดิมไว้
- ถ้าแก้ API contract ระหว่าง frontend/worker/backend ต้องอัปเดตทั้งสองฝั่งและบันทึกลง README/wiki
- อย่า commit/generated build output, secrets, tokens, cookies หรือข้อมูล runtime ที่ไม่ควรอยู่ใน git
- ก่อนแก้ไฟล์ ให้ดู `git status` เพราะ repo อาจมีงานค้างของ user อยู่แล้ว ห้าม overwrite งานคนอื่นโดยไม่ตรวจ

## Main app: video-affiliate

Path: `apps/video-affiliate/`

Components:

- `worker/` — Cloudflare Worker API, auth, webhook, cron, database/migrations
- `webapp/` — React + Vite Telegram Mini App UI
- `token-facebook-lite/` — Cloudflare Worker สำหรับ token helper
- `merge-rust/` — Cloudflare Container สำหรับ video processing / FFmpeg pipeline

Production references from README:

- Worker: `https://video-affiliate-worker.onlyy-gor.workers.dev`
- Webapp: `https://video-affiliate-webapp-38v.pages.dev`

Naming rule:

- ใช้ชื่อ `video-affiliate-*` สำหรับ runtime/deploy/docs ใหม่
- หลีกเลี่ยงชื่อ legacy ใน runtime และเอกสาร

## Root commands

รันจาก repo root `/Users/yok-macmini/Developer/shopping-affiliate`:

```bash
npm run start:video-affiliate:webapp
npm run build:video-affiliate:webapp
npm run preview:video-affiliate:webapp
npm run start:video-affiliate:worker
npm run deploy:video-affiliate:worker
npm run db:create:video-affiliate
npm run db:migrate:video-affiliate
npm run db:migrate:video-affiliate:local
npm run deploy:video-affiliate:token-facebook-lite
npm run check:video-affiliate:token-facebook-lite

npm run start:browsersaving:webapp
npm run build:browsersaving:webapp
npm run preview:browsersaving:webapp
npm run tauri:dev:browsersaving
npm run tauri:build:browsersaving
npm run start:browsersaving:api
npm run start:browsersaving:worker
npm run deploy:browsersaving:worker
npm run db:migrate:browsersaving:local
npm run db:migrate:browsersaving:prod

npm run start:dashboard
npm run build:dashboard
npm run preview:dashboard
npm run help:mono
```

## Recommended agent workflow

### ก่อนเริ่มงาน

1. อ่านไฟล์นี้ก่อน
2. เช็คสถานะ repo:
   ```bash
   git status --short
   ```
3. ถาม wiki ว่าเคยมี context อะไรเกี่ยวกับงานนี้หรือไม่:
   - Hermes: ใช้ skill `wiki-query` หรือถามให้ Hermes ค้น Obsidian wiki
   - Claude Code: `/wiki-query <คำถาม>`
   - Codex CLI: `$wiki-query <คำถาม>` หรือขอให้ใช้ `wiki-query`
4. อ่าน README ของ app ที่เกี่ยวข้อง
5. สรุป scope ก่อนแก้ code ถ้างานใหญ่หรือเสี่ยงกระทบหลายระบบ

### ระหว่างทำงาน

- ใช้ไฟล์ที่มีอยู่เป็น source of truth ก่อนเดา
- แก้ทีละ boundary: worker/webapp/container/api/desktop
- ถ้าแก้ schema/migration ให้ระบุ local/prod migration command ให้ชัด
- ถ้าเจอความรู้สำคัญหรือ pattern ใหม่ ให้บันทึกไว้สำหรับ wiki update

### ก่อนจบงาน

1. รัน check/build/test เท่าที่เกี่ยวข้องกับ app ที่แก้
2. ตรวจ `git diff` ว่ามีแต่ไฟล์ที่ตั้งใจแก้
3. อัปเดต README หรือ note ถ้า behavior/command/deploy เปลี่ยน
4. Capture ความรู้ใหม่กลับเข้า Obsidian wiki:
   - `/wiki-capture <สรุปสิ่งที่ทำ/ข้อควรจำ>`
   - `/wiki-update`

## Shared wiki commands

คำสั่งหลักของ obsidian-wiki ที่ใช้ร่วมกัน:

- `/wiki-query <คำถาม>` — ถามความรู้ใน Obsidian wiki
- `/wiki-ingest <ไฟล์หรือโฟลเดอร์>` — นำเอกสาร/ข้อมูลเข้า wiki
- `/wiki-history-ingest claude` — ingest ประวัติ Claude Code
- `/wiki-history-ingest codex` — ingest ประวัติ Codex CLI
- `/wiki-update` — sync/ปรับปรุง graph/wiki
- `/wiki-status` — ดูสถานะ wiki
- `/wiki-lint` — ตรวจ/ซ่อม link/tag/wiki health
- `/wiki-capture <ข้อความ>` — จดความรู้เร็วเข้าระบบ

## Notes for each agent

### Hermes

- Hermes ใช้ persistent memory ของตัวเองด้วย แต่ project knowledge ที่ต้องแชร์ข้าม agent ให้เก็บใน Obsidian wiki เป็นหลัก
- ถ้าทำงานผ่าน Telegram หรือ Hermes CLI ให้ใช้ tools อ่าน/เขียนไฟล์และ sync note เข้า vault เดียวกัน

### Claude Code

- Claude Code อ่าน `CLAUDE.md` และ `AGENTS.md` จาก project root
- ใช้ slash commands ของ obsidian-wiki ได้จาก global skills เช่น `/wiki-query`, `/wiki-capture`, `/wiki-update`

### Codex CLI

- Codex อ่าน `AGENTS.md` จาก project root
- ใช้ obsidian-wiki skills จาก `~/.codex/skills`
- ให้เริ่มด้วยการอ่านไฟล์นี้และ query wiki ก่อนงานใหญ่

## Current shared knowledge note

Obsidian note สำหรับโปรเจกต์นี้ควรอยู่ที่:

- `projects/shopping-affiliate.md`

ถ้าพบว่า note นั้นล้าสมัย ให้ update note และ wikilinks ที่เกี่ยวข้องทันที
