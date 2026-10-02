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
  `~/.obeya` of a running Obeya): `bun scripts/scratch-obeya.ts <stage.json>` stages one with its
  cards in about a second (its header describes the stage file; `--stop <port>` ends it). Its
  workers are idle; with `--real-workers` they are real agents on the machine's Claude login.
- UI checks run in headless Chrome through the `chrome-headless` skill (`input` for trusted
  clicks, drags, keys held for push-to-talk; `start --fake-mic <wav>` for voice). A claude-in-chrome
  tab is often hidden, which freezes `requestAnimationFrame`: camera flights and the unfold never
  finish there.
- Voice on this machine: `OBEYA_WHISPER_PYTHON=/Users/sadilek/dev/stimmzwilling/.venv/bin/python`
  (has `mlx_whisper`; the model is cached).
- The Obeya instance for this repo runs on port 4417 with `~/.obeya`. It restarts itself once
  `main` moves to commits that change code, a commit of yours included (workers resume, the page
  reloads); docs-only commits leave it running. Keep tests off it.
- No project-specific logic in the core: anything Acme-specific belongs in the Acme repo adapter.
- UI strings live in one place, `src/ui/strings.ts` (German first, English later).
- A button that is easy to click by accident and sets a lot in motion gets an undo.
- The colleagues use Windows or Linux: features must work there; macOS-only tools (e.g. `say`)
  only as an additional option.
- Demo videos and voice recordings never go into git.
- Commit directly to `main`; this repo uses no feature branches or pull requests. An Obeya worker
  is the exception: it commits on its card's branch, and Obeya lands that branch on `main`.
