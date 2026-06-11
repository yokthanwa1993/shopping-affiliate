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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **shopping-affiliate** (15370 symbols, 30433 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/shopping-affiliate/context` | Codebase overview, check index freshness |
| `gitnexus://repo/shopping-affiliate/clusters` | All functional areas |
| `gitnexus://repo/shopping-affiliate/processes` | All execution flows |
| `gitnexus://repo/shopping-affiliate/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
