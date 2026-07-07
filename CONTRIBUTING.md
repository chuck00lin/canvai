# Contributing to canvai

Thanks for stopping by — this project is at the stage where contributions shape it the most.

## Right now: use cases beat code

canvai is in the design/RFC phase. Before the protocol freezes, the most valuable thing you can give us is a **concrete use case**:

- Who are you (role, workflow)?
- What discussion would you put on a board, in which kind of repo?
- What should the *human* do on the board? What should the *agent* do?
- What does your current terminal-only workflow make painful?

→ [Open a use-case issue](.github/ISSUE_TEMPLATE/use-case.yml). Real scenarios directly decide MCP tool shapes, the active-board UX, and roadmap priorities.

## Challenging the design

The [design document](docs/design.md) numbers its decisions (D1–D5) precisely so they can be argued with. If you think a decision is wrong, open an issue that names the decision, states the failure scenario, and (ideally) proposes an alternative. "This won't work for my use case because…" is a great issue.

## Code contributions

The codebase is a TypeScript monorepo: `canvas-kit` and `hub` shipped with Phase 0, `web` arrives with Phase 1. Run `npm test` before sending a PR. For large features, open an issue first — the protocol is still converging. Small PRs to docs (typos, clarity, translations) are welcome any time.

Two invariants that will be enforced by tests from day one; keep them in mind for any early code:

1. **Round-trip fidelity**: reading and writing a `.canvas` file must preserve unknown fields (Advanced Canvas compatibility) and match Obsidian's serialization closely enough to keep git diffs minimal.
2. **Agents never compute absolute coordinates**: every write path an agent can reach goes through semantic ops + layout.

## Conduct

Be kind, be concrete, assume good faith. Disagreements should cite scenarios, not adjectives.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
