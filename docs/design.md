# Obeya — design

How Obeya works and why: what it does for the owner, how it is built, and the decisions behind it.
It describes what is built and is kept current in the same change. Work in progress is planned in
plan docs under `docs/plan/`, which Obeya shows as projects; when one is done, what lasts moves here
and the plan doc goes.

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
- **Voice first, mouse welcome.** Push-to-talk anywhere; buttons for the obvious actions. No live
  transcript: a short confirmation, written and spoken, with undo. What was said and answered
  stays in the log of the open card, or in the Koordinator's sheet.
- **Repo-agnostic core.** Project specifics live in a per-repo adapter. The first adapter is OKE.

## Concepts

- **Canvas** — a canvas spans one or more repositories; one Obeya serves several canvases.
- **Cards** — `bugfix`, `feature`, `project`. A project is a container backed by a plan doc; its
  workstreams are its child cards.
- **States** — `idea` → `planned` → `working` → `waiting` (demo ready | question) →
  `approved` → `in PR` → `live`; an agent's `proposal` is started when accepted. An
  adapter that does not require demos lets a worker hand over with a written summary alone:
  `waiting: review`. An idea is `open`, `parked` or `dropped`.
- **Agents**
  - *Worker*, one per card while it is worked on: implementation, local reviews, demo.
  - *Project agent*, one per project, long-lived: knows the plan doc and the history of every
    workstream.
  - *Exploration agent*, one per idea, long-lived and read-only: discusses the idea with the owner
    and keeps its brief.
  - *Chief of Staff* (in the UI: *Koordinator*), one per canvas: takes voice input on the open
    canvas, creates and assigns cards, runs the workspace pool, and keeps the preference memory.
    It also schedules the work: it cuts work packages so they can run in parallel, detects cards
    whose changes are likely to conflict on merge, and does not run those at the same time but
    queues them.
- **Preference memory** — rules distilled from every answer and correction the owner gives
  ("billing changes always get the Codex review", "labels: precise over short"). Shared by all
  agents, maintained by the Chief of Staff.

## Ideas

An idea is thought through on its card before anything is planned; no worker runs.

1. "Ich will über Export für Vermieter nachdenken" (voice or typed), or "Erst besprechen" on a
   planned card of the owner's, makes a card in state `idea`.
2. The unfolded idea is a conversation with its exploration agent: a read-only session (code, plan
   docs, the decision log, the preferences) resumed for every message, days later too. It asks
   back, shows variants with their trade-offs and says what they would cost. Its questions come
   with answer options, shown under its reply as radio buttons, or checkboxes when several fit
   together; the owner picks, may add their own words, and both go out as one message that names
   each question. The owner types in the
   panel or holds Space with the idea open; the reply stands in the panel, and only its short
   summary is spoken, when the owner spoke. What the agent read and thought on the way to a reply
   folds away under that reply ("Verlauf"), for whoever wants to follow it. Once the agent has replied, the open idea needs the
   owner like a waiting card ("Idee · du bist dran", badge, counted in "brauchen dich") until they
   answer, park, drop or decide it.
3. The agent keeps the brief ("Stand der Idee") on top of the card: goal, open and dropped
   variants, decisions, open questions, effort. The conversation is the means, the brief the
   result: whoever opens the card later reads the brief. The two stand side by side and never say
   the same: findings, variants and questions go into the brief, and a reply only carries the
   turn (what changed in the brief, which open question is next).
4. A prototype ("Prototyp bauen lassen"), when talking is not enough: a worker builds a throwaway one in its own workspace
   and records a demo, which shows on the idea; the exploration agent hears what it found. The
   prototype never lands and does not count for collisions; approving it discards workspace and branch.
5. Deciding: "So bauen" makes the brief the card's task and starts it at once, through the
   Koordinator like "Agent starten" (it waits only if it would likely conflict with running work). "Als Projekt planen" plans a
   card whose worker writes a plan doc with workstreams, which lands like any change (OKE: a PR)
   and then appears as a project, linked back to the idea. "Parken" and "Verwerfen" leave the card with its brief; talking
   to it opens it again. Decisions from the conversation go into the decision log; lasting
   preferences are learned by the Koordinator as before.

## Card lifecycle

1. A card is created by the owner (voice or canvas) or proposed by an agent; the owner can
   edit a proposal, and accepting it starts it (it goes to the Koordinator like a started
   `planned` card) unless they only accept it as `planned`.
2. `working`: the worker leases a workspace, implements, runs the local reviews the repo adapter
   names, and records the demo.
3. `waiting: demo`: the card carries the demo. The owner approves or gives feedback; feedback
   sends the card back to `working`. The demo plays on its own the first time the card is opened
   (per browser; a new render counts as new), later it waits to be played. Each finding in the
   demo's report has "Als Karte anlegen": a planned card with the finding as its text, below the
   card it comes from, in its repository; the finding then names that card. A follow-up's worker
   hears which card it comes from and that card's summary. A question in the demo report is an
   open question like a worker's: the owner answers it on the card or by voice, the worker hears
   the answer, and the demo keeps waiting for approval.
4. Approval opens the PR (demo linked, report as description) and starts monitoring: review bot
   comments (Greptile) are handled by the worker, CI is watched, conflicts are rebased. Only
   what needs judgement — a review comment that questions a decision, a conflict with product
   meaning — comes back to the owner as a question on the card.
5. Merged (or landed on `main`) → `live`. The demo stays on the card. The worker hears that its
   work is on main and may finish what was waiting for that (a data migration, say) before its
   session ends.
6. Archived, when the owner takes the finished card off the canvas ("Archivieren" on the card, or
   all finished ones at once in the archive). The archive (button or `A`) lists archived cards
   by day, the most recently archived first; one unfolds from its row as on the canvas and can go
   back to the place it had.
7. A project ends when its plan doc goes (done, deleted): it moves into the
   archive with its workstreams, which are not listed on their own. Its sheet then shows, read-only,
   the goal and the workstreams as the doc last stood; each workstream unfolds with its log and demo.
   When the same file comes back, the project returns to its place. Every project's sheet, live or
   archived, lists its decisions and links the idea its plan doc was written from: when an idea's
   "Plan-Doc" card lands and its diff adds a doc in the plan directory, the project from that doc
   remembers the idea, whose card keeps its brief and conversation, and the idea's decisions join
   the project's.

## Communication

Agents never talk to each other directly; the Obeya server is the mailbox, so every exchange is
visible on a card. A worker has four tools, served in-process: `report(status)`, a status line
on the card; `ask(question, options, multiple)`, which returns at once — the worker ends its turn
and the answer arrives as its next message (the owner picks one option, several when `multiple`,
or writes their own answer); `propose_card(kind, title, reason, suggestion)`; and
`ready_for_review(summary)`. A turn that ends without `ask` or `ready_for_review` gets one nudge,
then its last words become a question to the owner. A turn that ends while the worker's own
background work runs (a demo render, a test suite, a watcher it started) is no such turn: the work
wakes the worker when it finishes or fires, so Obeya waits, and only after ten minutes without a
sign of life does it nudge. A
worker that went to the owner for having stopped and then works on by itself takes that question
back. The owner can send a note at any time; it reaches the worker without stopping it.

Obeya's messages to a worker say what happened — feedback, an answer, a note, a landing that
failed, the landing — not step by step what to do: workers are full agents. Whether a demo is
recorded again after feedback is the worker's call; a handover without a new demo keeps the one on
the card.

What the owner writes on a card (a note, feedback, an answer, talk to an idea) may carry
screenshots: pasted (⌘V), dropped or picked in the text field, scaled down in the browser to at
most 2000 px, and uploaded at once. They show as thumbnails in the card's log or conversation,
large on a click, and reach the agent as images in the message, with their file paths.

A card's task takes screenshots the same way: in its description field, while the card is planned.
They show under the task, and its worker gets them with the task when it starts (an idea's
exploration agent, when a planned card becomes an idea; building an idea adds the screenshots the
owner showed in its discussion; a cut card's packages inherit them). A command typed in the
Koordinator's sheet may carry screenshots too: the Koordinator sees them, and they go with every
action of the command that creates or concerns a card (new card or idea, start, note, answer,
feedback, talk to an idea); said with a start, they join the card's task. A spoken command carries
screenshots the same way: picked with the small button to the right of the microphone, dropped on
it, or pasted (⌘V) anywhere outside a text field, they show beside the microphone and go with the
next recording; one in which nothing was heard or understood leaves them there.

A worker's question goes to its project agent (a standalone card's goes to the Chief of Staff),
which answers from the plan doc, the decision log and the preference memory. Only what needs the owner reaches the owner: product decisions, trade-offs, anything
irreversible or external. An answer given on the owner's behalf stays visible on the card and
can be overruled; overruling feeds the preference memory. Owner-facing text from agents is in
the owner's language (`src/core/locale.ts`).

## Architecture

- **Server** — Bun, TypeScript. HTTP + WebSocket to the UI, one API per canvas
  (`/api/c/<canvas>/…`, `/api/canvases` lists them); SQLite (`bun:sqlite`) under `~/.obeya/`.
  `obeya <repo>…` starts one canvas with the given repositories (`--name` names it);
  `obeya` starts the canvases `~/.obeya/canvases.json` lists, `obeya --config <file>` those of
  another file.
- **Configuration** — the canvases with their repositories (path, adapter, clones), seen and edited
  in the "Konfiguration" sheet: each canvas shows its id and whether it runs, each repository its id,
  adapter and whether workers use clones or worktrees; problems (no git repository, an unknown
  adapter, two canvases with one id, a canvas's home repository left out) show at the field while
  editing and keep it from being saved. Saving writes the file and restarts Obeya once no worker is
  in the middle of a turn (as for new code); the page reloads. Started with repositories on the
  command line, Obeya shows those, and saving makes the file the configuration it restarts with.
  Renaming a running canvas keeps its id (`id` in the file), so its cards stay. The server's own
  settings (port, data directory, the agents' permission mode) come from the command line and show
  read-only. The Koordinator reads the configuration (`config` tool) to answer questions about it
  and changes it on the owner's word (`configure`, the whole new list, checked like the sheet's),
  with the usual confirmation and undo window.
- **Canvases and repositories** — each repository on a canvas has its adapter, workspaces,
  workers, project agents and PR watcher; the canvas has one board and one Koordinator, whose
  collision checks stay within a repository. The first repository is the canvas's home: its plan
  references and workspace directory are the ones a single-repository canvas always had, so
  canvases keep their data. The others' plan docs are referenced as `<repo>:<path>`; the owner's
  cards carry their repository, chosen in the panel before work begins (home by default), and a
  proposal or a cut package inherits it. The UI opens `?c=<canvas>`, the top-left pill switches,
  and on a canvas with several repositories every card names its own.
- **UI** — browser app, React + TypeScript. Custom canvas grown from `design/mock/`: camera with
  fly-to, unfold-in-place, semantic zoom, edge indicators, minimap, and a frosted top bar the
  canvas slides under.
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
  is `live`. Commits that conflict one by one but not as a whole land squashed into one commit.
  Uncommitted work or a real conflict sends the card back to its worker with the approval kept:
  its next handover (no new demo needed) lands on its own.
- **After landing** — the worker is told its work is on main (or that its PR was merged) and may
  finish what remains, in its workspace, which stays at what landed until then (the card is `live`,
  "Agent erledigt den Rest"; notes reach it, "Anhalten" ends it). Ending a turn with nothing to wait
  for ends its session and removes worktree and branch (a clone is free again). When the landing
  changed Obeya's own running code, the worker is told Obeya restarts with it; what needs the new
  code waits through `after_restart`: the worker ends its turn, the restart goes ahead, and the
  resumed worker hears that Obeya now runs its change.
- **Self-update** — Obeya runs from a checkout that work lands on, so `live` must mean running.
  Without `--dev` the `obeya` process supervises the server: when the checkout its code comes from
  moves to commits that change code (not only docs), the server stops and starts again; workers
  resume, and an open page reloads when it reconnects to a new server process. The restart waits
  until no worker is in the middle of a turn or waiting for its background work, even one that has
  asked or handed over meanwhile (at most 15 minutes), since it stops whatever a worker runs. The
  workers it waits for are told it is due, and so is a worker that starts a turn before it: they
  start nothing long, stop background work they can start again, and pause at the next safe point
  by ending their turn (no nudge, no question to the owner; the card's log says it paused). A
  resumed worker hears that what ran was stopped (exit code 137) and goes on. A worker that waits for the restart to finish its landed work is not
  in a turn and does not hold it up. While a restart waits, the bar shows it ("Neustart wartet auf
  N Agenten", until when at most); hovering names why and the cards it waits for, and "Jetzt neu
  starten" (`POST /api/restart`) has it go ahead at once, its hover text saying what that cuts off.
- **Koordinator** — read-only SDK turns on the Obeya checkout, one decision at a time. Before a
  card starts it estimates the files the card will change and judges whether running it next to
  the cards in progress likely ends in merge conflicts. Cards queued before it count too: a card
  likely to conflict with one of them waits behind it rather than overtaking it, and once that one
  has started, until it has landed (fairer, at the cost of some parallelism). A card judged again
  sees only the cards queued before it, so no two cards wait for each other. For each card in progress it sees the
  estimated files and what the branch has changed so far: each file with the changed line ranges
  and git's function context. Sharing a file does not keep a card waiting (additions in different
  places merge cleanly); the same lines or function, or code that one card moves, renames or
  reformats while the other edits it, do. In doubt the card runs: a conflict that happens anyway
  goes back to its worker on landing. A card likely to conflict waits, with the reason (one that
  starts says which files it shares and why that is fine); once what it waits for has landed or
  stopped it starts, or, while other work runs that may have started meanwhile, it is judged
  again — the owner can start it anyway. Cards whose turn comes together go in the order they came
  to the Koordinator, the one waiting longest first. On the canvas, a planned card and one waiting in the queue show a play button
  while the pointer is on them; it starts the card (the queued one anyway) without unfolding it. Paths the adapter marks as soft (docs) do not count. "Aufteilen" cuts a planned card
  into 2–6 packages with disjoint files, or keeps it and says why. It answers questions of cards
  without a project, and after each owner answer, note or feedback it decides whether a lasting
  preference was stated and records it as a rule every agent gets. Its sheet (button or `K`)
  shows the queue, the cards in progress and the preferences.
- **Voice in** — push-to-talk (hold Space or the mic button); the browser records and posts the
  audio with the focus (open card, project in view). A Whisper (MLX) sidecar keeps the model
  loaded and transcribes in German with the canvas's titles as vocabulary
  (`OBEYA_WHISPER_PYTHON`, else `uv` with mlx-whisper). A recording without audible speech gives
  „Ich habe nichts gehört.“, one Whisper cannot make sense of „Das habe ich nicht verstanden.“; the
  Koordinator gets neither to guess from. How Whisper fails on such recordings (the titles talk it
  into loops, guesses or its words for silence) and how they are told apart is in
  `voice/whisper_sidecar.py` and `src/server/voice.ts`. The log has each recording's length and
  level next to the transcript. While the owner holds the key, a level that stays flat for 1.5 s
  shows „Das Mikrofon liefert keinen Ton.“ under the mic. The first press after a page load opens
  the microphone (about 0.2–0.3 s); let go before it is open, nothing is recorded (rather than a
  recording that runs on unheld) and the owner hears „Das Mikrofon war noch nicht bereit“. A quick, low-effort Koordinator turn reads
  the transcript as speech that may be misheard and either acts or replies. Acting takes one or
  more actions from one sentence, up to 20 (new card, new idea, start, note, answer, feedback,
  approve, accept, dismiss, cut, stop; on ideas: discuss, build, plan doc, prototype, park, drop),
  checked against the cards' states in the turn, so an action that does not fit (a note to a card no agent
  works on) goes back to the Koordinator, which may reply instead. Start on a card queued behind
  others starts it now despite the likely conflict, like "Trotzdem starten"; it sees which cards a queued
  one waits for, so "starte alle wartenden Karten" works. A reply answers questions too
  ("Was ist seit gestern passiert?"), as far as the cards and their history answer them.
  With a card open, the Koordinator gets its worker's whole summary and the findings of its demo,
  so "lege eine Folgekarte für die ambient-Auffälligkeit an" makes a follow-up of that card with
  the finding as its text. One confirmation covers all actions; they run in order a few
  seconds after it reached the owner, so "Rückgängig" takes back anything, even an approval. Only
  talking to an idea goes on at once: it changes nothing, and said to the open idea it needs no
  confirmation, since the conversation shows it. The same commands can be typed in the
  Koordinator's sheet. What the owner said and the Koordinator's confirmation go into the log of
  the card that was open, and "Zurückgenommen." when taken back; with no card open, the sheet
  shows the conversation. Talk to an open idea is the exception: its conversation already holds it.
- **Looked-up questions** — a question that needs reading ("Was würde der Agent hier machen, wenn
  ich starte?", what the plan says, how something works) the quick turn does not answer: it
  acknowledges it ("Ich schaue im Plan nach.") and passes it on. A question about a project or one
  of its workstreams goes to the project agent, in the project's session; any other to a thorough
  read-only Koordinator turn (effort medium) on the card's repository. Both get the question, the
  card's state and log, and the task its worker gets at the start (`Workers.startBrief`), from
  which, the plan doc and the repository's instructions they derive the worker's steps. The answer
  comes 10–30 s later: spoken in short wherever the owner is, in full in the log of the card that
  was open, else in the Koordinator's sheet; what the agent reads shows on the open card meanwhile.
  The Koordinator hears the answer with the next command, and it is part of its stored memory. A
  question still open at a restart is looked up again.
- **Voice latency** — pressing Space (or focusing the typed command) gets everything ready while
  the owner speaks: the Whisper sidecar starts and loads its model, the speech sidecar starts, and
  the Koordinator's session starts up if it is not running (one that fails is replaced once, for
  the same command). The written confirmation comes back as
  soon as the Koordinator has decided, and the undo window starts with it; the spoken one follows
  from its own URL. Measured on a small scratch canvas, letting go to the written confirmation
  takes about 2.8 s, to the spoken one about 3.3 s, the first command after a start included. Most
  of it is the Koordinator's model turn (about 2 s); Sonnet or Haiku, or a shorter system prompt,
  saved nothing reliable in measurements, so it stays as it is.
- **Koordinator memory** — the owner's commands go to one ongoing Koordinator session per canvas,
  one after the other, so it understands "die andere auch" or "nein, die von vorhin". It sees a
  card's open question, also one in a demo report, so a bare "ja" to it is an answer, not an
  approval. Under the mic the UI names who listens: the Koordinator, and the card, idea or project
  in focus ("Koordinator · Karte: …"). Card tags
  (`K1`, …) stay fixed for the session. Each command brings the cards as they are now and what
  happened since the previous one (state changes, questions, answers, hand-overs, the owner's
  notes, errors, new cards; not the workers' steps); a command the owner took back is told with the
  next. Every exchange is stored (`talk`). A session is not resumed: after a restart, and after 30
  commands so the context stays short, a fresh one starts from memory: the last 20 exchanges and
  the canvas's last 14 days (at most 60 steps), with times.
- **Voice out** — the default system voice speaks the confirmation, which the browser plays: a
  JXA sidecar keeps the macOS synthesizer loaded (about half a second a sentence), with `say` as
  the fallback.
- **Demos** — the `demo` skill's pipeline (scripted walkthrough, narrated video, report). The
  worker records once the change is committed and checked, as the adapter says how to run the
  app (Obeya: a scratch instance from the worktree, staged by `scripts/scratch-obeya.ts` from a
  stage file before every take, its workers idle (`--idle-workers`) unless the change is about
  agents; OKE: the clone's AppHost), and hands over the directory, chapter titles and report with `ready_for_review`.
  Obeya takes the chapter times from the captions and serves the video, poster and captions of
  the card's demo (range requests). The card shows it as in the mock, with approve and feedback
  beside the video; feedback asks for a new render. Artifacts stay in `~/demos/`, never in git;
  sharing them through object storage behind the team's login and linking them from the PR comes
  with the PR loop.
- **Repo adapter** — how to start and refresh the stack, where the frontend URL comes from, the
  login recipe, where plan docs live, which reviews run, demo conventions.

## Data

Persistent (SQLite): canvases, cards (kind, state, position, parent; agent session, workspace,
branch, status line, open question or review summary, the card it came from (a proposal's
source, a follow-up's card), estimated scope, queue,
when archived, the PR link, an idea's status, brief and open questions, a prototype's idea, landed work whose worker still
finishes; a project's plan doc as last read and the idea it came from; the plan docs an idea's landed
work added),
card events (the log, with an error code where the UI words it and the owner's screenshots), a card's own
screenshots, workspaces and their leases,
decision log, preferences, the Koordinator's conversation with the owner (what was said, its
reply, the screenshots that came with it, the open card, whether it was taken back; a looked-up
question, the card it is about, its answer and who gave it), per-canvas settings (the Koordinator's session for questions).

Files under `~/.obeya/`: the owner's screenshots (`images/<canvas>/`), the configuration
(`canvases.json`).

Derived, not stored: git, PR and CI state (read from git and GitHub), plan-doc content (read from
the repository; the copy on the project is only for the archive).

## Decisions

- Name: Obeya.
- Runtime: Bun; browser UI served locally; native shell (Tauri) only if global push-to-talk needs
  it.
- Persistent local store, not ephemeral.
- A canvas may span several repositories, and one Obeya serves several canvases (at first it was
  one canvas per repository).
- Agents may propose cards.
- Approval triggers the PR and its monitoring to the merge, not the merge itself.
- Spoken output uses the macOS default voice (synthesizer sidecar, `say` as fallback).
- Obeya itself is developed without branches or PRs: approved work lands directly on `main`.
- This page describes what is built; work in progress lives in plan docs, which the canvas shows as
  projects. The milestone list it once kept repeated what the canvas shows and went (2026-10-01).
- Plan docs as projects: a doc in the adapter's plan directory is a project when its
  `## Workstreams` section has a checklist; each top-level item is a workstream (`**W3:** Title.
  Details`). Checked means `live`, `(in review)` after the label means `in PR`, anything else
  `planned`. The goal is the first paragraph under `## Goal` / `## Ziel`.
- The owner reads a plan doc where the project is: "Plandokument lesen" in the project's sheet
  widens it and shows the doc as written, rendered, kept current with the file; a workstream's
  card opens it at the workstream's item. Esc goes back to the workstreams. The server hands out
  only docs it shows as projects, by project card, never a path.
- A plan card gets a stored row the first time it is seen, so the owner's placement persists; its
  title, text and state always come from the doc. Each read also keeps the doc's last state on the
  project (title, goal, workstreams with key, label, title, text and state).
- A plan doc that disappears ends its project: the project goes into the archive with that last
  state, and returns with its placement when the same file comes back (2026-10-01). Ending is
  automatic rather than an explicit "abschließen", which can later sit on top. Reading old content
  from the git history instead was rejected as fragile (PRs and clones on OKE, renames); it served
  only once, to backfill Obeya's own projects from before
  (`scripts/backfill-archived-projects.ts`, run 2026-10-01 for M2, M3, M4, M6 and M7). Known edges: a doc missing only for a moment (a branch
  switch in the checkout) sends the project to the archive and back; a renamed doc makes a new
  project and leaves the old one archived. A project from before the doc was kept has nothing to
  show and stays hidden.
- A canvas belongs to a repository, not a checkout: the adapter names it (OKE: `oke`), so the
  clones share one. Adapters live in this repository (`src/adapters/`) and are picked by the
  `origin` URL; the generic one covers any repo with `docs/plan/`.
- Card sizes are fixed per kind; a delivered workstream shrinks to a chip, a project wraps its
  children, and a workstream cannot be dragged out of its project. New projects are placed in a
  grid below the existing ones.
- A card dragged to an edge of the view scrolls it that way, faster the nearer the edge, but only
  as far as the rest of the canvas reaches plus room to drop the card beside it; a card picked up
  at an edge scrolls only once the pointer moves towards it (2026-10-01).
- Panning, scrolling and zooming stop where the view would show no card any more: a strip of the
  nearest card (120 px, or all of a smaller one) stays in sight above the minimap, so the owner
  never lands on an empty view and pans back without the minimap. A gap between cards wider than
  the view is crossed by the minimap. When cards go or the window shrinks and none is left in
  view, the camera flies to the nearest; the minimap and the overview key land next to content
  too (2026-10-01).
- An unfolded card is as tall as its content, up to a limit per state beyond which it scrolls, and
  follows its content while open.
- Opening a card takes 300 ms: a 130 ms flight brings it to the middle, then it unfolds in 170 ms;
  closing runs the same in reverse. Fast enough not to wait on, long enough to keep the context.
- Manual cards are created by double-click, the button or `n`, and edited in the unfolded card;
  a new card closed without a title is dropped. Deleting offers undo.
- The server words no UI text for refusals: it answers `{ code, error }` with a stable code
  (`ErrorCode` in `src/core/types.ts`) and an English detail, and log entries of a failed start
  carry the code too. The UI shows its text for the code from `strings.ts`, a generic one for
  anything else.
- A start that fails after the Koordinator took it drops the card back to planned; the unfolded
  planned card then shows the last log entry, when it is an error, as the reason.
- A card waits rather than risking a collision; the Koordinator's estimate is taken once, before
  the start, and a waiting card is checked again against what runs when its blockers finish.
- A new card does not overtake a queued one it likely conflicts with: it queues behind it, also
  when that one waits for something far from done. Fairness over parallelism; the owner can still
  start it anyway.
- Landing problems are classified: uncommitted work, rebase conflicts and empty branches go back
  to the worker; a blocked Obeya checkout stays with the owner, and the card stays in review.
- An approval holds through what the worker fixes to land it: main moving on is no reason to ask
  the owner again. Feedback, a stop or a blocked Obeya checkout take it back.
- Refusals carry an error code; the UI words them (`src/ui/strings.ts`), the English detail is
  for developers.
- The owner archives only their own cards, and only once `live`; a workstream stays with its
  project, where a delivered one is already a chip, and goes into the archive with it. Archiving
  keeps the card's position, demo and log.
- A project links the idea it came from by what the idea's landed work added to the plan directory,
  not by title or time, and shows the decisions of both.
- Obeya restarts itself for new code on its own checkout instead of hot reloading: a restart is a
  path that already exists (workers resume by session id), hot reloading keeps old state alive
  next to new code. It also restarts for commits made outside Obeya.
- A due restart is announced to the workers, which pause for it themselves, rather than waiting
  for a moment in which none is busy (2026-10-01): with six workers in parallel such a moment
  rarely came, and the 15 minutes ran out in the middle of test runs and demo renders (four of the
  restarts after the waiting rule came in). An agent knows where its work can stop; a lock it sets
  before long commands would hold restarts off just as well but rests on every agent remembering
  it, and restarting each worker on its own between steps is impossible with one server process.
- Voice commands are read by the Koordinator, not matched by rules, and always wait a few seconds
  for undo; nothing spoken takes effect without a confirmation the owner could take back. Talking
  to an idea is the exception: it only adds to a conversation.
- An agent's question to the owner is a first-class thing with answer options, not prose: the
  owner answers with a click, and their own words are always possible beside the options. The
  answer travels as text (question and pick), so the conversation reads the same later and a
  spoken answer takes the same path.
- A discussion lives on a card, not in the conversation with the Koordinator: an exploration
  parked on the canvas is found there again with its brief, and the Koordinator only passes the
  owner's words on. A big idea becomes a project through a worker writing its plan doc, not
  through the exploration agent, which stays read-only.
- The Koordinator's memory lives in the store, not in the agent session: a session is never
  resumed, and a new one (restart, or a long session) starts from the stored conversation and the
  cards' history. That keeps the context short over weeks, and restart and renewal are one path.
  The card history is part of it, because the owner asks about progress over time ("was ist seit
  gestern passiert?") and refers to cards by what happened to them.
- Workers are told what happened, not what to do next: they are full agents and judge the next
  step themselves (re-rendering a demo, say). Protocol stays where Obeya depends on it: hand over
  with `ready_for_review`, ask with `ask`, report the PR with `pr_opened`.
- Landed work's worker keeps its workspace and session until it is done, instead of ending with
  the approval: what a change needs after it is on main (a migration against the running Obeya)
  is done by the agent that knows the change. A landing costs one short worker turn for it.
- Obeya's configuration is the file `canvases.json`, edited in the UI or by the Koordinator; a
  change takes effect through a restart rather than live (2026-10-01): a restart is a path that
  already exists and waits for workers, and building canvases at runtime would keep half-old state.
  Saving the configuration of a command-line start switches Obeya to the file, so what was edited is
  what runs.
- Screenshots reach agents as images in the message, not as files for them to read: an exploration
  agent may only read its checkout, and the agent sees the image without a step of its own.
- Obeya spawns git, a few thousand times in a test run: on macOS it calls the binary `xcrun --find
  git` names, not the `/usr/bin/git` shim, which looks it up again on every call (10 ms a call
  instead of 4). Test repositories are copies of a template committed once per set of files
  (`gitRepo` in `src/server/testing.ts`). Together they halved the test suite.
- A demo's scratch Obeya is staged by a script from a stage file rather than by hand (2026-10-01):
  in the 14 card runs before, the demo took longer than the change itself, and every worker wrote
  its own staging (curl, sqlite, server start) with the same mistakes: the wrong API path, a
  server that restarted on the worker's commit, a staged "working" card that a real agent resumed,
  real agents the Koordinator started mid-take. The script writes the cards' fields straight into
  the database, so any state is a line in the stage file, and the workers are idle unless asked.

## Open questions

- Plan-doc sync: Obeya reads plan docs and never writes them; workers tick off their workstream
  in the doc as part of their change. Should the project agent keep the doc's progress instead?
- Plan docs are read from the working tree of the checkout Obeya is started on. Fine for Obeya,
  where work lands there; for OKE, whose work lands through PRs, read them from `origin/main`?
- Which OKE clones may workers lease: the existing `~/dev/oke2`–`oke5`, or fresh ones?
- A plan doc without a `## Workstreams` checklist is not shown (in OKE: `utilmd-parsed-view.md`,
  whose tasks sit under other headings). Fix such docs, or show them as projects without cards?
- Demo sharing beyond the team: narration in a cloned voice.
