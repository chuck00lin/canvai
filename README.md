# pairsketch

**Pair programming, but on a whiteboard — humans and AI agents thinking in pictures, together.**

Terminals are a narrow pipe for visual thinkers, and today it is the only pipe we share with our agents. pairsketch gives any repository a shared whiteboard — like Miro or FigJam, except the participants include AI agents. Humans drag cards around in a browser (or in Obsidian); agents read and edit the same boards through MCP. The boards are plain [JSON Canvas](https://jsoncanvas.org) files living in your repo, versioned by git like everything else.

> **Status: design / RFC stage.** There is no code here yet — there is a [design document](docs/design.md) and a plan. We are collecting real-world use cases before locking the protocol. **If you have ever wished you could discuss architecture with an agent on a whiteboard instead of a terminal, [tell us about it](.github/ISSUE_TEMPLATE/use-case.yml)** — early requirements shape this project the most.

## The core idea

Diagrams have two possible sources of truth, and the split maps exactly onto who is good at what:

|  | Structure-first (e.g. Mermaid) | Position-first (e.g. JSON Canvas) |
|---|---|---|
| Truth | nodes & relations, layout derived | coordinates, layout stored |
| Natural for | **agents** — one line of text per relation | **humans** — dragging, grouping, whitespace as meaning |
| Weakness | positions have nowhere to live → can't drag | verbose coordinates → token cost, spatial reasoning |

pairsketch refuses to pick a side. Instead:

- **The persistence layer is position-first**: `discuss/*.canvas` files (JSON Canvas 1.0) in your repo, so human drags always have somewhere to land — and Obsidian opens them natively, for free.
- **The agent interface is structure-first**: agents speak semantic operations over MCP (`add_node`, `connect`, `insert_mermaid`, …) and read a coordinate-free structural projection. An auto-layout engine (ELK) turns structure into positions. **Agents never think in pixels.**
- **Human intent wins**: any node a human has dragged is *pinned*; auto-layout routes around it.
- **Mermaid is an I/O language, not a storage format**: agents can emit Mermaid, the hub explodes it into canvas nodes (parse → layout → nodes); dense structural diagrams (sequence, state) render *inside* cards as fenced blocks.

## Architecture

```mermaid
flowchart TB
  W["🧑 Web client — React Flow editor<br/>board list · active-board checkbox · md/mermaid cards"]
  A["🤖 Agent — Claude Code or any MCP client<br/>speaks structure, never pixels"]
  H["pairsketch hub — thin local server<br/>file watcher · WebSocket · MCP · ELK auto-layout"]
  F["repo/discuss/*.canvas<br/>JSON Canvas 1.0 · git-versioned · source of truth"]
  O["Obsidian (optional client)"]

  W <-->|WebSocket| H
  A <-->|"MCP: semantic ops + events"| H
  H <-->|"watch / atomic write"| F
  O -.->|"opens the same files"| F
```

*(Yes, that diagram is Mermaid. Structure-first formats are exactly right for docs — that's the point.)*

Every layer can fail independently: kill the server and humans still open boards in Obsidian; skip Obsidian and the web client works; close every client and agents still read the files. Choosing the persistence format well buys all of that.

### The active-board loop

1. The human ticks a board as **active** in the web sidebar.
2. The hub records it and notifies subscribed agents.
3. The agent's next `get_active_board` call focuses there — reads a structural projection, applies ops, and the human watches cards appear live.
4. Humans reply *on the board*: drag, annotate, or drop an `@agent` pin as a structured question.

### Planned MCP surface (draft)

| Tool | Purpose | Cost profile |
|---|---|---|
| `list_boards` / `get_active_board` | discover boards; find the human's current focus | O(boards) |
| `read_board(mode)` | `structure` (default, coordinate-free) · `full` · `region` | structure ≈ ⅓ of full |
| `apply_ops([...])` | batched semantic edits: add / update / connect / group / relative move | O(change) |
| `insert_mermaid(text)` | Mermaid → parse → ELK layout → canvas nodes | structure price, positions free |
| `events_since(cursor)` | what humans did since last sync (moves, new cards, pins) | O(diff) |

## Roadmap

- **Phase 0 — zero frontend.** MCP server + `.canvas` files + Obsidian as the viewer. Validates that discussing *on a board* beats discussing in a terminal, and measures real token costs. Turn-based collaboration.
- **Phase 1 — own client.** The thin local server (watcher + WebSocket + atomic writes that preserve unknown fields) and a React Flow editor with the active-board loop. Agent edits appear live in the browser.
- **Phase 2 — real-time.** CRDT document layer (Yjs), presence (human and agent cursors), Mermaid import-explode, the `@agent` pin protocol, multi-board portals.

**Non-goals:** an interactive Mermaid engine (the language has no position vocabulary — see the [design doc](docs/design.md#decision-2) for why every attempt converges back to a canvas); a cloud service (local-first, your repo is the backend); real-time CRDT before turn-based collaboration proves itself.

## Contributing

The most valuable contribution right now is a **use case**: who you are, what you'd put on the board, what the agent should do there. [Open a use-case issue](.github/ISSUE_TEMPLATE/use-case.yml) — or challenge the design decisions in [docs/design.md](docs/design.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

繁體中文說明請見 [README.zh-TW.md](README.zh-TW.md)。

## Prior art & credits

pairsketch stands on ideas validated by others: [Kanvas](https://github.com/XMihura/Kanvas) (humans + agents on Obsidian Canvas via semantic CLI ops), [Bragi Canvas](https://community.obsidian.md/plugins/bragi-canvas) (active canvas over local MCP), the Excalidraw MCP ecosystem ([excalidash-mcp](https://github.com/davifernan/excalidash-mcp), [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)) for live agent drawing, the [tldraw Agent Starter Kit](https://tldraw.dev/starter-kits/agent) for agent-on-canvas interaction design, and the [JSON Canvas](https://jsoncanvas.org) open format by Obsidian. The full survey with sources is in the [design doc](docs/design.md#prior-art).

## License

[MIT](LICENSE)
