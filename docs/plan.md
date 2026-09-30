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

- **Canvas** — a canvas spans one or more repositories; one Obeya serves several canvases.
- **Cards** — `bugfix`, `feature`, `project`. A project is a container backed by a plan doc; its
  workstreams are its child cards.
- **States** — `proposal` → `planned` → `working` → `waiting` (demo ready | question) →
  `approved` → `in PR` → `live`. An adapter that does not require demos lets a worker hand over
  with a written summary alone: `waiting: review`.
- **Agents**
  - *Worker*, one per card while it is worked on: implementation, local reviews, demo.
  - *Project agent*, one per project, long-lived: knows the plan doc and the history of every
    workstream.
  - *Chief of Staff* (in the UI: *Koordinator*), one per canvas: takes voice input on the open
    canvas, creates and assigns cards, runs the workspace pool, and keeps the preference memory.
    It also schedules the work: it cuts work packages so they can run in parallel, detects cards
    whose changes are likely to collide, and does not run those at the same time but queues them.
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
6. Archived, when the owner takes the finished card off the canvas ("Archivieren" on the card, or
   all finished ones at once in the archive). The archive (button or `A`) lists archived cards
   by day, the most recently archived first; one unfolds from its row as on the canvas and can go
   back to the place it had.

## Communication

Agents never talk to each other directly; the Obeya server is the mailbox, so every exchange is
visible on a card. A worker has four tools, served in-process: `report(status)`, a status line
on the card; `ask(question, options)`, which returns at once — the worker ends its turn and the
answer arrives as its next message; `propose_card(kind, title, reason, suggestion)`; and
`ready_for_review(summary)`. A turn that ends without `ask` or `ready_for_review` gets one nudge,
then its last words become a question to the owner. The owner can send a note at any time; it
reaches the worker without stopping it.

A worker's question goes to its project agent (a standalone card's goes to the Chief of Staff,
until then to the owner), which answers from the plan doc, the decision log and the preference
memory. Only what needs the owner reaches the owner: product decisions, trade-offs, anything
irreversible or external. An answer given on the owner's behalf stays visible on the card and
can be overruled; overruling feeds the preference memory. Owner-facing text from agents is in
the owner's language (`src/core/locale.ts`).

## Architecture

- **Server** — Bun, TypeScript. HTTP + WebSocket to the UI, one API per canvas
  (`/api/c/<canvas>/…`, `/api/canvases` lists them); SQLite (`bun:sqlite`) under `~/.obeya/`.
  `obeya <repo>…` starts one canvas with the given repositories (`--name` names it);
  `obeya --config <file>` starts the canvases a JSON file lists.
- **Canvases and repositories** — each repository on a canvas has its adapter, workspaces,
  workers, project agents and PR watcher; the canvas has one board and one Koordinator, whose
  collision checks stay within a repository. The first repository is the canvas's home: its plan
  references and workspace directory are the ones a single-repository canvas always had, so
  canvases keep their data. The others' plan docs are referenced as `<repo>:<path>`; the owner's
  cards carry their repository, chosen in the panel before work begins (home by default), and a
  proposal or a cut package inherits it. The UI opens `?c=<canvas>`, the top-left pill switches,
  and on a canvas with several repositories every card names its own.
- **UI** — browser app, React + TypeScript. Custom canvas grown from `design/mock/`: camera with
  fly-to, unfold-in-place, semantic zoom, edge indicators, minimap.
- **Agents** — Claude on the owner's subscription, no API billing, through the Agent SDK: it runs
  on the Claude Code login of the machine (tested without an API key: `apiKeySource: none`).
  A worker is one SDK session per card with streaming input, the repo's own settings and
  CLAUDE.md, and permission mode `auto` (`--permission-mode`); after a restart it resumes by
  session id. A project agent is one read-only session per project (Read, Grep, Glob on the Obeya
  checkout), resumed for each question, answering one question at a time. The SDK sits behind a
  small runtime interface, so the orchestration is tested against a fake.
- **Workspaces** — per adapter. A pool of full clones leased by a card while it is worked on
  (OKE: csharpier finds no files inside a worktree, and parallel AppHosts per clone are proven),
  or a worktree per card (Obeya itself: any number in parallel), kept across stop and restart
  until the card's work has landed. Clones come from `--workspace <path>` or `--clones <n>`.
- **Landing** — per adapter. `pr` (OKE): approval leaves the branch for the PR loop. `main`
  (Obeya): approval rebases the branch onto `main` and fast-forwards the Obeya checkout; the card
  is `live`, worktree and branch are removed. Uncommitted work or a failed rebase sends the card
  back to its worker.
- **Koordinator** — read-only SDK turns on the Obeya checkout, one decision at a time. Before a
  card starts it estimates the files the card will change and judges collisions with cards in
  progress (their estimated and actual changes); a card that overlaps or collides waits, with the
  reason, and starts on its own once what it waits for has landed or stopped — the owner can start
  it anyway. Paths the adapter marks as soft (docs) do not count. "Aufteilen" cuts a planned card
  into 2–6 packages with disjoint files, or keeps it and says why. It answers questions of cards
  without a project, and after each owner answer, note or feedback it decides whether a lasting
  preference was stated and records it as a rule every agent gets. Its sheet (button or `K`)
  shows the queue, the cards in progress and the preferences.
- **Voice in** — push-to-talk (hold Space or the mic button); the browser records and posts the
  audio with the focus (open card, project in view). A Whisper (MLX) sidecar keeps the model
  loaded and transcribes in German with the canvas's titles as vocabulary
  (`OBEYA_WHISPER_PYTHON`, else `uv` with mlx-whisper). A quick, low-effort Koordinator turn reads
  the transcript as speech that may be misheard and picks one action (new card, start, note,
  answer, feedback, approve, accept, dismiss, cut, stop) or just replies; it writes the
  confirmation. The action runs a few seconds after the confirmation reached the owner, so
  "Rückgängig" takes back anything, even an approval. The same commands can be typed in the
  Koordinator's sheet. The transcript goes to the server log only.
- **Voice latency** — pressing Space (or focusing the typed command) gets everything ready while
  the owner speaks: the Whisper sidecar starts and loads its model, the speech sidecar starts, and
  the Koordinator's agent for the command starts up and waits (after each command the next one
  waits; one that fails after waiting is replaced once). The written confirmation comes back as
  soon as the Koordinator has decided, and the undo window starts with it; the spoken one follows
  from its own URL.
- **Voice out** — the default system voice speaks the confirmation, which the browser plays: a
  JXA sidecar keeps the macOS synthesizer loaded (about half a second a sentence), with `say` as
  the fallback.
- **Demos** — the `demo` skill's pipeline (scripted walkthrough, narrated video, report). The
  worker records once the change is committed and checked, as the adapter says how to run the
  app (Obeya: a scratch instance from the worktree on a scratch repository; OKE: the clone's
  AppHost), and hands over the directory, chapter titles and report with `ready_for_review`.
  Obeya takes the chapter times from the captions and serves the video, poster and captions of
  the card's demo (range requests). The card shows it as in the mock, with approve and feedback
  beside the video; feedback asks for a new render. Artifacts stay in `~/demos/`, never in git;
  sharing them through object storage behind the team's login and linking them from the PR comes
  with the PR loop.
- **Repo adapter** — how to start and refresh the stack, where the frontend URL comes from, the
  login recipe, where plan docs live, which reviews run, demo conventions.

## Data

Persistent (SQLite): canvases, cards (kind, state, position, parent; agent session, workspace,
branch, status line, open question or review summary, proposal source, estimated scope, queue,
when archived),
card events (the log, with an error code where the UI words it), workspaces and their leases,
decision log, preferences, per-canvas settings (the Koordinator's session); later PR links.

Derived, not stored: git, PR and CI state (read from git and GitHub), plan-doc content (read from
the repository).

## Milestones

- [x] **M1 Canvas.** Bun server, UI from the mock, persistence, manual cards, projects read from
  plan docs (read-only), OKE adapter skeleton.
- [x] **M2 Agents.** Workers per card in clones or worktrees; status, log, questions, review and
  proposals on the card; project agents; subscription auth settled. Acceptance met: Obeya is
  developed on its own canvas, and the first worker-built change landed on `main`.
- [x] **M3 Koordinator.** The Chief of Staff without voice: schedules cards so that likely
  collisions do not run at the same time (queued instead), cuts work packages for parallel work,
  answers standalone cards' questions, keeps the preference memory.
- [x] **M4 Demo loop.** Worker records the demo; the card waits; approve or feedback. First
  worker-recorded demo approved on Obeya itself.
- [ ] **M5 PR loop.** Approval opens the PR; monitoring through review bot, CI and conflicts to
  the merge; judgement questions routed to the card. Built and tested against a fake forge
  ([`docs/plan/pr-loop.md`](plan/pr-loop.md)); the live run on OKE waits for the owner's go.
- [x] **M6 Voice.** Push-to-talk with the Whisper sidecar, routing by focus, spoken confirmation
  with undo; the Koordinator takes voice input.
- [x] **M7 Beyond one repo.** Several repositories per canvas, several canvases.
- [ ] **M8 Ideas.** Discuss and explore a feature before deciding to build it (proposed
  2026-09-30; the owner builds it through Obeya itself):
  - A card in a new state *Idee*, before `planned`; no worker runs on it.
  - An exploration agent per idea with a lasting, resumed session, read-only (code, plan docs,
    decisions, preferences). The owner talks to it by voice or text in the unfolded card; its
    answers show as a conversation there, spoken only as a short summary.
  - The agent keeps a "Stand der Idee" on the card: goal, variants kept and dropped, decisions,
    open questions. The conversation is the means, that text the result.
  - Optional spike: a worker builds a throwaway prototype in its own workspace and shows it as a
    demo on the card; it never lands.
  - Deciding: small → the card becomes `planned` with that text as its brief; large → the agent
    writes a plan doc (landing like any change), which appears as a project for the Koordinator
    to cut and schedule; or park/discard, keeping the text. Decisions go to the decision log.
  - Separately: a short-term memory for commands to the Koordinator (follow-ups such as "und die
    zweite auch"); today every command is read in a fresh session.

## Decisions

- Name: Obeya.
- Runtime: Bun; browser UI served locally; native shell (Tauri) only if global push-to-talk needs
  it.
- Persistent local store, not ephemeral.
- One canvas per repository to start; since M7 a canvas may span several, and one Obeya serves
  several canvases.
- Agents may propose cards.
- Approval triggers the PR and its monitoring to the merge, not the merge itself.
- Spoken output uses the macOS default voice (synthesizer sidecar, `say` as fallback).
- Obeya itself is developed without branches or PRs: approved work lands directly on `main`.
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
- An unfolded card is as tall as its content, up to a limit per state beyond which it scrolls, and
  follows its content while open.
- Manual cards are created by double-click, the button or `n`, and edited in the unfolded card;
  a new card closed without a title is dropped. Deleting offers undo.
- The server words no UI text for refusals: it answers `{ code, error }` with a stable code
  (`ErrorCode` in `src/core/types.ts`) and an English detail, and log entries of a failed start
  carry the code too. The UI shows its text for the code from `strings.ts`, a generic one for
  anything else.
- A start that fails after the Koordinator took it drops the card back to planned; the unfolded
  planned card then shows the last log entry, when it is an error, as the reason.
- The scheduling Chief of Staff comes before demos and PRs (M3): with worktrees several workers
  run at once on Obeya itself.
- A card waits rather than risking a collision; the Koordinator's estimate is taken once, before
  the start, and a waiting card is checked again against what runs when its blockers finish.
- Landing problems are classified: uncommitted work, rebase conflicts and empty branches go back
  to the worker; a blocked Obeya checkout stays with the owner, and the card stays in review.
- Refusals carry an error code; the UI words them (`src/ui/strings.ts`), the English detail is
  for developers.
- Only the owner's cards are archived, and only once `live`; a workstream stays with its project,
  where a delivered one is already a chip. Archiving keeps the card's position, demo and log.
- Voice commands are read by the Koordinator, not matched by rules, and always wait a few seconds
  for undo; nothing spoken takes effect without a confirmation the owner could take back.

## Open questions

- Voice latency: from letting go to the written confirmation about 2.8 s, to the spoken one about
  3.3 s, the first command after a start included, measured on a small scratch canvas (before:
  5.3 s, 7.2 s for the first command). Most of what is left is the Koordinator's model turn (about
  2 s); Sonnet or Haiku, or a shorter system prompt, saved nothing reliable in measurements, so it
  stays as it is.

- Plan-doc sync: Obeya reads plan docs and never writes them; workers tick off their workstream
  in the doc as part of their change. Should the project agent keep the doc's progress instead?
- Plan docs are read from the working tree of the checkout Obeya is started on. Fine for Obeya,
  where work lands there; for OKE, whose work lands through PRs, read them from `origin/main`?
- Which OKE clones may workers lease: the existing `~/dev/oke2`–`oke5`, or fresh ones?
- A plan doc without a `## Workstreams` checklist is not shown (in OKE: `utilmd-parsed-view.md`,
  whose tasks sit under other headings). Fix such docs, or show them as projects without cards?
- UI language: German first, all strings in one place for an English release.
- Demo sharing beyond the team: narration in a cloned voice.
