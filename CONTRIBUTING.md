# Contributing

Obeya is built with Obeya. Its canvas over this repository holds the projects and tasks; agents
do most of the work on their cards, and every change comes back as a demo before it lands. The
same steps work for you, with or without Obeya running.

## Design doc first

[`docs/design.md`](docs/design.md) describes what Obeya does and why: goal, principles, behaviour
and the decisions behind them, as much as an experienced engineer would need to rebuild it with the
same features (its header says what belongs in it and what the code says instead). It is an index
of chapters under [`docs/design/`](docs/design/): read it, then the chapters your change touches,
and keep those current in the same change.

## Plan docs

Work larger than one change is planned in a plan doc under [`docs/plan/`](docs/plan/): the goal,
where things stand, the design, and the workstreams as a checklist (`- [ ] **W1:** …`). Obeya
shows each plan doc as a project with a card per workstream; the change that finishes a workstream
ticks it off in the doc, and once all are ticked the project goes into the archive. When the
project is done, what passes the design doc's test moves into it and the plan doc goes.

## Cards

A task is a card. Its agent works in its own clone or worktree on a branch of its own, asks on the
card when a decision is not its to make, runs `bun test --parallel` and `bun run typecheck`, and
hands over with a demo and a short summary. Approval lands the branch on `main`; feedback sends the
card back to its agent. Something it notices beyond its task becomes a proposed card, not a wider
change.

## Demos

Every change comes with a demo: a narrated video of the change in the running app, 30–60 s for a
small one, 1½–3 min for a larger one; something to look at rather than watch (layout drafts,
variants side by side) as an HTML page. The demo skill in [`plugin/`](plugin/) records them on a
scratch Obeya that `bun scripts/scratch-obeya.ts <stage.json>` stages with its cards in about a
second. Demo videos and voice recordings never go into git.

## The code

- Bun and TypeScript throughout. `src/core/` is shared by server and UI, `src/server/` is the Bun
  server with SQLite, `src/ui/` the React canvas, `src/adapters/` what Obeya knows of a repository
  (its defaults, its settings).
- Code that drives agents is tested against the fake runtime in `src/server/testing.ts` and real
  git repositories in a temp directory.
- UI strings live in `src/ui/strings.ts`.
- Nothing specific to one repository goes into the core: it belongs in that repository's settings
  (`.obeya/settings.json`, described in [`docs/settings.md`](docs/settings.md)).
- [`CLAUDE.md`](CLAUDE.md) holds the conventions for coding agents; they hold for people too.

## From outside

Issues and pull requests against `main` are welcome. A pull request that changes behaviour
updates the design doc and shows the change: a demo video linked from the pull request, or
screenshots.

With Obeya, set up a personal demo site once (Configuration → Demos → "Personal demo site":
GitHub Pages from a public repository with any GitHub account, from a private one with GitHub
Pro, or Cloudflare Pages with a free account; a few minutes). Your Obeya cannot deploy to the
project's own demo site, so "Share" puts your demo there instead, and Obeya writes the link into
your pull request's description by itself.
