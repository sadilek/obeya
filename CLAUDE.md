# CLAUDE.md

Obeya: a spatial canvas for directing AI coding agents. Goal, design and milestones are in
`docs/plan.md` — read it before changing anything, and keep it current in the same change.

- Bun + TypeScript throughout; tests with `bun test`, types with `bun run typecheck`.
- `src/core/` is shared by server and UI (types, plan-doc parser, layout); `src/server/` is the
  Bun server with SQLite; `src/ui/` the React canvas; `src/adapters/` the repo adapters.
- `design/mock/` is the interaction reference (camera, unfold, voice). It is a design artifact,
  not code to import.
- No project-specific logic in the core: anything OKE-specific belongs in the OKE repo adapter.
- UI strings live in one place, `src/ui/strings.ts` (German first, English later).
- Demo videos and voice recordings never go into git.
