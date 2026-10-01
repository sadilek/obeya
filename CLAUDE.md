# CLAUDE.md

Obeya: a spatial canvas for directing AI coding agents. Goal, behaviour, architecture and the
decisions behind them are in `docs/design.md` — read it before changing anything, and keep it
current in the same change. Work in progress is planned in plan docs under `docs/plan/` (Obeya
shows them as projects); when one is done, what lasts moves into `docs/design.md` and the doc goes.

- Bun + TypeScript throughout; tests with `bun test`, types with `bun run typecheck`.
- `src/core/` is shared by server and UI (types, plan-doc parser, layout); `src/server/` is the
  Bun server with SQLite; `src/ui/` the React canvas; `src/adapters/` the repo adapters.
- Code that drives agents is tested against the fake runtime in `src/server/testing.ts` and real
  git repositories in a temp directory (`gitRepo` there; git calls are what makes tests slow).
  Live runs go against a scratch git repository with a plan doc and a scratch `OBEYA_HOME` (never
  `~/.obeya` of a running Obeya), e.g.
  `OBEYA_HOME=$(mktemp -d) bun src/server/main.ts <scratch repo> --adapter obeya --port 4420`;
  they start real agents on the machine's Claude login.
- UI checks run in headless Chrome through the `chrome-headless` skill (`input` for trusted
  clicks, drags, keys held for push-to-talk; `start --fake-mic <wav>` for voice). A claude-in-chrome
  tab is often hidden, which freezes `requestAnimationFrame`: camera flights and the unfold never
  finish there.
- Voice on this machine: `OBEYA_WHISPER_PYTHON=/Users/sadilek/dev/stimmzwilling/.venv/bin/python`
  (has `mlx_whisper`; the model is cached).
- The Obeya instance for this repo runs on port 4417 with `~/.obeya`. It restarts itself once
  `main` moves to commits that change code, a commit of yours included (workers resume, the page
  reloads); docs-only commits leave it running. Keep tests off it.
- `design/mock/` is the interaction reference (camera, unfold, voice). It is a design artifact,
  not code to import.
- No project-specific logic in the core: anything OKE-specific belongs in the OKE repo adapter.
- UI strings live in one place, `src/ui/strings.ts` (German first, English later).
- Demo videos and voice recordings never go into git.
- Commit directly to `main`; this repo uses no feature branches or pull requests. An Obeya worker
  is the exception: it commits on its card's branch, and Obeya lands that branch on `main`.
