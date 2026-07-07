# CLAUDE.md — canvai

Repo-native visual discussion boards for humans + AI agents. JSON Canvas files as source of truth, thin local server (watcher/WebSocket/MCP/ELK layout), React Flow web client, Obsidian as optional client.

## Ground rules

- **This is a PUBLIC open-source repo.** Internal discussion notes, meeting transcripts, experiments, and scratch tests never go here — they live in `../canvai-internal/` (outside this repo). When in doubt, put it there.
- Public docs and code comments are **English**. `README.zh-TW.md` is the one translated file; keep it in sync on substantive README changes.
- `docs/design.md` is the source of truth for design decisions (numbered D1–D5). Don't contradict it silently — change it (and say why) or open an issue.

## Non-negotiable invariants (from the design doc)

1. `.canvas` round-trips preserve unknown fields (Advanced Canvas compatibility) and mirror each file's serialization dialect to keep git diffs minimal. Test-enforced: `packages/canvas-kit/test/io.test.ts` (byte-identical round-trips) and the hub e2e.
2. Agents never compute absolute coordinates — agent-reachable write paths go through semantic ops + ELK auto-layout; human-dragged nodes are `pinned` and auto-layout routes around them.
3. Mermaid is I/O only (embed in cards, one-way import/explode) — never the persistence format. Rationale: design doc D2.
4. Concurrency stays turn-based (atomic writes, last-write-wins, event feed) until Phase 2; no CRDT before then.

## Status & layout

- Current phase: **Phase 0 + Phase 1 core shipped** — `packages/canvas-kit` (round-trip io, projection, ops, diff, pinned-aware ELK layout), `packages/hub` (MCP stdio server + `serve` mode: watcher/WebSocket/REST), `packages/web` (React Flow client; Vite build, needs DOM lib so it has its own tsconfig and is excluded from the root one). The two hub processes coordinate purely through files (`.canvas`, `.canvai/state.json`, `.canvai/events.jsonl`). Next: field-test the live loop, measure the token bill of a real discussion turn, then Phase 2 (Yjs, presence, mermaid explode, @agent pins).
- No build step for hub/kit: Node ≥ 23.6 runs the TypeScript directly (erasable syntax only — no enums/namespaces; relative imports use `.ts` extensions). Web builds with `npm run web:build`. `npm test` (vitest, includes MCP + serve e2e) and `npm run typecheck` must stay green.
- Dev commands: `npm run serve` (HTTP/WS on 5199), `npm run web:dev` (Vite dev server proxying to 5199), `npm run hub` (MCP stdio).
- Dogfooding: `.mcp.json` registers the hub for this repo; `discuss/roadmap.canvas` is a live board — feel free to update it via apply_ops when the roadmap changes.
- License MIT. Do not vendor code from GPL projects (notably obsidian-advanced-canvas); format compatibility only.
