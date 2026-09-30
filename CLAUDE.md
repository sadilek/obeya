# CLAUDE.md

Obeya: a spatial canvas for directing AI coding agents. Goal, design and milestones are in
`docs/plan.md` — read it before changing anything, and keep it current in the same change.

- Bun + TypeScript throughout; tests with `bun test`.
- `design/mock/` is the interaction reference (camera, unfold, voice). It is a design artifact,
  not code to import.
- No project-specific logic in the core: anything Acme-specific belongs in the Acme repo adapter.
- UI strings live in one place (German first, English later).
- Demo videos and voice recordings never go into git.
