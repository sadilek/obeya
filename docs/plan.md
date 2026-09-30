# Obeya — plan

A living plan: decisions in flight and progress. Durable content moves into `docs/` pages as
milestones land.

## Goal

A spatial workspace for directing AI coding agents the way an engineering director directs a
team: every bugfix, feature and project is a card on one canvas; agents do the work in the
background; the human keeps every essential decision — made by voice, from a narrated demo
video, without reading code or cycling through terminals.

The name is Toyota's *obeya*, the "big room" where every project hangs visibly on the walls and
decisions are made in front of the wall.

## Principles

- **One surface.** Everything starts on the canvas. Detail unfolds in place, animated, and folds
  back; nothing opens a new window, and the view never jumps.
- **Space is memory.** A card keeps the position its owner gave it and a fixed, readable size. A
  screen too small for everything shows a section of the canvas, never shrunken cards.
- **Decisions, not supervision.** The owner is pulled in only for a decision: a demo to approve,
  a question only they can answer, a proposal. Everything else runs.
- **Every change gets a demo.** Bugfixes 30–60 s, features 1½–3 min, projects one demo per
  workstream. Backend behaviour is shown through the app's own inspection views; "covered by
  tests" is no reason to leave it out.
- **Voice first, mouse welcome.** Push-to-talk anywhere; buttons for the obvious actions. The
  transcript is not shown: a short confirmation, written and spoken, with undo.
- **Repo-agnostic core.** Project specifics live in a per-repo adapter. The first adapter is OKE.

## Concepts

- **Canvas** — one per repository in v1.
- **Cards** — `bugfix`, `feature`, `project`. A project is a container backed by a plan doc; its
  workstreams are its child cards.
- **States** — `proposal` → `planned` → `working` → `waiting` (demo ready | question) →
  `approved` → `in PR` → `live`.
- **Agents**
  - *Worker*, one per card while it is worked on: implementation, local reviews, demo.
  - *Project agent*, one per project, long-lived: knows the plan doc and the history of every
    workstream.
  - *Chief of Staff*, one per canvas: takes voice input on the open canvas, creates and assigns
    cards, runs the workspace pool, and keeps the preference memory.
- **Preference memory** — rules distilled from every answer and correction the owner gives
  ("billing changes always get the Codex review", "labels: precise over short"). Shared by all
  agents, maintained by the Chief of Staff.

## Card lifecycle

1. A card is created by the owner (voice or canvas) or proposed by an agent; a proposal becomes
   `planned` when accepted.
2. `working`: the worker leases a workspace, implements, runs the local reviews the repo adapter
   names, and records the demo.
3. `waiting: demo`: the card carries the demo. The owner approves or gives feedback; feedback
   sends the card back to `working`.
4. Approval opens the PR (demo linked, report as description) and starts monitoring: review bot
   comments (Greptile) are handled by the worker, CI is watched, conflicts are rebased. Only
   what needs judgement — a review comment that questions a decision, a conflict with product
   meaning — comes back to the owner as a question on the card.
5. Merged → `live`. The demo stays on the card.

## Communication

Agents never talk to each other directly; the Obeya server is the mailbox, so every exchange is
visible on a card. Each agent gets a few tools: `ask` (question upward), `report` (status),
`propose_card`, `ready_for_review`.

A worker's question goes to its project agent (a standalone card's goes to the Chief of Staff),
which answers from the plan doc, the decision log and the preference memory. Only what needs the
owner reaches the owner: product decisions, trade-offs, anything irreversible or external. An
answer given on the owner's behalf stays visible on the card and can be overruled; overruling
feeds the preference memory.

## Architecture

- **Server** — Bun, TypeScript. HTTP + WebSocket to the UI; SQLite (`bun:sqlite`) under
  `~/.obeya/`.
- **UI** — browser app, React + TypeScript. Custom canvas grown from `design/mock/`: camera with
  fly-to, unfold-in-place, semantic zoom, edge indicators, minimap.
- **Agents** — Claude on the owner's subscription, no API billing. Headless `claude` CLI is
  proven on the subscription; the Agent SDK is used if it can run on the same login (settled in
  M2).
- **Workspaces** — a pool of full clones per repository, leased by a card while it is worked on.
  Clones, not worktrees: in OKE, csharpier finds no files inside a worktree, and parallel
  AppHosts per clone are proven.
- **Voice in** — local Whisper (MLX) sidecar with a domain vocabulary; the agent prompt states
  that input is speech and may carry recognition errors.
- **Voice out** — macOS `say` with the default system voice, streamed sentence by sentence.
- **Demos** — the `demo` skill's pipeline (scripted walkthrough, narrated video, report).
  Artifacts on disk; shared through object storage behind the team's login and linked from the
  PR. Never in git.
- **Repo adapter** — how to start and refresh the stack, where the frontend URL comes from, the
  login recipe, where plan docs live, which reviews run, demo conventions.

## Data

Persistent (SQLite): canvases, cards (kind, state, position, size, parent), links card ↔ branch /
PR / agent session / workspace, messages, decision log, preference memory.

Derived, not stored: git, PR and CI state (read from git and GitHub), plan-doc content (read from
the repository).

## Milestones

- [x] **M1 Canvas.** Bun server, UI from the mock, persistence, manual cards, projects read from
  plan docs (read-only), OKE adapter skeleton. Voice and the proposal links of the mock wait for
  M5 and M2.
- [ ] **M2 Agents.** Worker sessions per card on the clone pool; status and log streamed to the
  card; `ask` / `report`; project agents; subscription auth settled.
- [ ] **M3 Demo loop.** Worker records the demo; the card waits; approve or feedback.
- [ ] **M4 PR loop.** Approval opens the PR; monitoring through review bot, CI and conflicts to
  the merge; judgement questions routed to the card.
- [ ] **M5 Voice.** Push-to-talk with the Whisper sidecar, routing by focus, spoken confirmation
  with undo; Chief of Staff with preference memory.
- [ ] **M6 Beyond one repo.** Several repositories per canvas, several canvases.

## Decisions

- Name: Obeya.
- Runtime: Bun; browser UI served locally; native shell (Tauri) only if global push-to-talk needs
  it.
- Persistent local store, not ephemeral.
- One canvas per repository to start.
- Agents may propose cards.
- Approval triggers the PR and its monitoring to the merge, not the merge itself.
- Spoken output uses `say` with the default voice.
- Plan docs as projects: a doc in the adapter's plan directory is a project when its
  `## Workstreams` section has a checklist; each top-level item is a workstream (`**W3:** Title.
  Details`). Checked means `live`, `(in review)` after the label means `in PR`, anything else
  `planned`. The goal is the first paragraph under `## Goal` / `## Ziel`.
- A plan card gets a stored row the first time it is seen, so the owner's placement persists; its
  title, text and state always come from the doc. When a doc disappears its rows stay, hidden,
  and its placement returns with it.
- A canvas belongs to a repository, not a checkout: the adapter names it (OKE: `oke`), so the
  clones share one. Adapters live in this repository (`src/adapters/`) and are picked by the
  `origin` URL; the generic one covers any repo with `docs/plan/`.
- Card sizes are fixed per kind; a delivered workstream shrinks to a chip, a project wraps its
  children, and a workstream cannot be dragged out of its project. New projects are placed in a
  grid below the existing ones.
- Manual cards are created by double-click, the button or `n`, and edited in the unfolded card;
  a new card closed without a title is dropped. Deleting offers undo.

## Open questions

- Agent SDK on subscription auth, or headless CLI sessions (M2).
- Plan-doc sync: read-only in M1; writing workstream progress back through the project agent
  later.
- Plan docs are read from the working tree of the checkout Obeya is started on. Once workers lease
  clones (M2), read them from `origin/main` instead?
- A plan doc without a `## Workstreams` checklist is not shown (in OKE: `utilmd-parsed-view.md`,
  whose tasks sit under other headings). Fix such docs, or show them as projects without cards?
- UI language: German first, all strings in one place for an English release.
- Demo sharing beyond the team: narration in a cloned voice.
