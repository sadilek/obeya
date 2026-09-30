# M2 Agents

> Plan doc for milestone M2 of [`docs/plan.md`](../plan.md). Obeya reads it as a project, so its
> own canvas shows this work. Deleted when M2 ships; durable content moves into `docs/plan.md`.

## Goal

Workers do the work on a card in the background: one Agent SDK session per card, in a leased
clone, reporting status to the card and asking only what they cannot decide. Acceptance: Obeya is
developed on its own canvas — a card started there comes back as a reviewed branch.

## Design

- **Auth.** The Agent SDK runs on the owner's subscription login: tested with no API key set, the
  session reports `apiKeySource: none`, in-process tools work, and `resume` keeps the context.
- **Worker.** One SDK session per card, `cwd` = the leased clone, on branch `obeya/<slug>`. It
  loads the repo's own settings and CLAUDE.md like an interactive session; the permission mode is
  `auto` unless configured otherwise. Input is a stream: answers and owner hints arrive as new
  user messages; after a restart the session resumes by id.
- **Tools** (in-process MCP): `report(status)`; `ask(question, options)` returns at once and the
  worker ends its turn, the answer arrives as the next message; `propose_card(kind, title,
  reason, suggestion)`; `ready_for_review(summary)`. A turn that ends without one of the last two
  gets one nudge, then becomes a question to the owner.
- **Routing.** A workstream's question goes to its project agent, which answers from the plan
  doc and the project's decision log or escalates to the owner. A standalone card's question goes
  to the owner (the Chief of Staff takes it over in M5). Every answer is on the card; one given on
  the owner's behalf can be overruled with a message.
- **Workspaces**, per adapter. *Clones* (OKE): registered (`--workspace <path>`) or created
  (`--clones <n>` under `~/.obeya/workspaces/<canvas>/`), leased on start if the tree is clean,
  released on approval; the branch stays in the clone for the PR (M4). *Worktrees* (Obeya): one
  per card under the same directory, created on start, kept across stop and restart, removed
  with its branch once the work has landed.
- **Review.** Until workers record demos (M3), `ready_for_review` puts the card in `waiting:
  review` with the worker's summary; the owner approves or sends feedback.
- **Landing.** The adapter says how approved work lands. OKE: a PR (M4). Obeya itself: straight
  onto `main`, no branches kept and no PRs — the worker's branch is rebased onto `main` and
  fast-forwarded. A failed rebase or uncommitted work sends the card back to its worker.
- **Parallel work** needs no coordination in M2 beyond separate workspaces; the Chief of Staff
  schedules conflicting cards later (see the open question in `docs/plan.md`).

## Workstreams

- [x] **W1:** Schema and runtime. Events, decisions, workspaces; the SDK behind an interface that
  tests can fake.
- [x] **W2:** Workspaces. Clone pool (register or create, lease, release) and a worktree per card;
  landing on `main` by rebase and fast-forward.
- [x] **W3:** Worker loop. Start, stream input, tools, nudge, stop, resume after restart.
- [ ] **W4:** Card UI for work. Start and stop, log, hints, questions with options, review,
  proposals with their link to the source card.
- [ ] **W5:** Obeya on Obeya. Adapter for this repo; a real card worked through end to end.
- [ ] **W6:** Project agents. One read-only session per project answering from plan doc and
  decision log, escalating to the owner.

## Open questions

- Which OKE clones may workers lease: the existing `~/dev/oke2`–`oke5`, or fresh ones?
