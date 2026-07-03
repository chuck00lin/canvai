# CLAUDE.md — pairsketch

Repo-native visual discussion boards for humans + AI agents. JSON Canvas files as source of truth, thin local server (watcher/WebSocket/MCP/ELK layout), React Flow web client, Obsidian as optional client.

## Ground rules

- **This is a PUBLIC open-source repo.** Internal discussion notes, meeting transcripts, experiments, and scratch tests never go here — they live in `../pairsketch-internal/` (outside this repo). When in doubt, put it there.
- Public docs and code comments are **English**. `README.zh-TW.md` is the one translated file; keep it in sync on substantive README changes.
- `docs/design.md` is the source of truth for design decisions (numbered D1–D5). Don't contradict it silently — change it (and say why) or open an issue.

## Non-negotiable invariants (from the design doc)

1. `.canvas` round-trips preserve unknown fields (Advanced Canvas compatibility) and match Obsidian's serialization to keep git diffs minimal. Test-enforced once code exists.
2. Agents never compute absolute coordinates — agent-reachable write paths go through semantic ops + ELK auto-layout; human-dragged nodes are `pinned` and auto-layout routes around them.
3. Mermaid is I/O only (embed in cards, one-way import/explode) — never the persistence format. Rationale: design doc D2.
4. Concurrency stays turn-based (atomic writes, last-write-wins, event feed) until Phase 2; no CRDT before then.

## Status & layout

- Current phase: **pre-code (RFC)**. Next milestone: Phase 0 — MCP server + `.canvas` + Obsidian as viewer.
- Planned monorepo: `packages/canvas-kit` (format lib), `packages/hub` (server + MCP), `packages/web` (React Flow client). TypeScript.
- License MIT. Do not vendor code from GPL projects (notably obsidian-advanced-canvas); format compatibility only.
