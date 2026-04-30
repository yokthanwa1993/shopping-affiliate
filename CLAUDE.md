# Claude Code context — shopping-affiliate

Claude Code auto-loads this file when started in this project. The user should not need to remind Claude to read context or save memory.

Required automatic behavior:

1. Read `AGENTS.md` in repo root before doing non-trivial work. It is the shared context for Hermes, Codex CLI, and Claude Code.
2. Query/read the shared Obsidian wiki before non-trivial work, especially `projects/shopping-affiliate.md`.
3. If new durable knowledge appears during the task, update/capture it into the wiki before finishing.
4. Do not wait for the user to say “อ่าน AGENTS.md”, “query wiki”, or “บันทึกไว้”. Do it proactively.
5. Never save secrets/tokens/cookies/API keys/connection strings into repo or wiki.

สรุปสั้น:

- Repo: `/Users/yok-macmini/Developer/shopping-affiliate`
- Shared knowledge base: `/Users/yok-macmini/Documents/Obsidian Vault`
- Obsidian-wiki config: `~/.obsidian-wiki/config`
- Project note: `projects/shopping-affiliate.md`
- ใช้ `/wiki-query <คำถาม>` เพื่อดึงความรู้เดิม
- ใช้ `/wiki-capture ...` และ `/wiki-update` เพื่อให้ Hermes/Codex/Claude เห็นความรู้เดียวกัน

ถ้ามีคำสั่ง/architecture/decision ใหม่ ให้ update `AGENTS.md`, README ที่เกี่ยวข้อง และ Obsidian project note ให้ตรงกัน
