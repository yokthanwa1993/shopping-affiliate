# Claude Code context — video-affiliate

Claude Code auto-loads this file when started inside `apps/video-affiliate`. The user should not need to remind Claude to read context or save memory.

Required automatic behavior:

1. อ่าน `../../AGENTS.md` และ `./AGENTS.md` ก่อนเริ่มงานสำคัญ
2. Query shared wiki เองก่อนงานใหญ่: `/wiki-query video-affiliate <คำถาม>`
3. ถ้ามี durable knowledge ใหม่ ให้ `/wiki-capture ...`, `/wiki-update`, หรือ update `projects/shopping-affiliate.md` เองก่อนจบงาน
4. ห้ามบันทึก secrets/tokens/cookies/API keys ลง repo หรือ wiki

Shared knowledge base:

- Obsidian vault: `/Users/yok-macmini/Documents/Obsidian Vault`
- Project note: `projects/shopping-affiliate.md`
