# Obeya

A spatial workspace for directing AI coding agents the way an engineering director directs a
team. Every bugfix, feature and project is a card on one canvas. Agents do the work in the
background; you keep every essential decision — made by voice, from a narrated demo of the
finished work, without reading code or cycling through terminals.

The name is Toyota's *obeya*, the "big room" where every project hangs visibly on the walls.

**Status:** M3 — the canvas, agents that work on its cards (a worker per card in its own clone or
worktree, questions routed through a project agent or the Koordinator, review and approval on
the card), and a Koordinator that queues colliding cards, cuts large ones and learns the owner's
preferences.
See [`docs/plan.md`](docs/plan.md); the interaction reference is the mock in
[`design/mock/`](design/mock/index.html).

## Running

```bash
bun install
bun start ~/dev/app5            # canvas of that repository on http://127.0.0.1:4417
bun run dev ~/dev/app5          # same, with hot reload
bun test && bun run typecheck
```

Options: `--port <n>` (or `OBEYA_PORT`), `--adapter <name>` to override the one picked from the
`origin` URL, `--workspace <path>` (repeatable) or `--clones <n>` for adapters whose workers use
clones, `--permission-mode <mode>` for workers (default `auto`). Data and worktrees live in
`~/.obeya/` (`OBEYA_HOME` to move it). Workers run on the Claude Code login of the machine.
