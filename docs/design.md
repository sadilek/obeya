# Obeya — design

How Obeya works and why: what it does for the owner, how it is built, and the decisions behind it.
It describes what is built and is kept current in the same change. Work in progress is planned in
plan docs under `docs/plan/`, which Obeya shows as projects; when one is done, what lasts moves here
and the plan doc goes.

## Goal

A spatial workspace for directing AI coding agents the way an engineering director directs a
team: every task and every project is a card on one canvas; agents do the work in the
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
- **Every change gets a demo.** Its length follows the size of the change, not its kind: a small
  one 30–60 s, a larger one 1½–3 min, never padded; projects one demo per workstream. Backend behaviour is shown through the app's own inspection views; "covered by
  tests" is no reason to leave it out. What is to be looked at rather than watched (logo drafts,
  a layout, variants side by side) is shown as an HTML artifact instead of a video. Only when there
  is nothing to show at all ("das gibt es schon") does the worker hand over without one, and says
  why.
- **Voice first, mouse welcome.** Push-to-talk anywhere; buttons for the obvious actions. No live
  transcript: a short confirmation, written and spoken, with undo. What was said and answered
  stays in the log of the open card, or in the Koordinator's sheet.
- **Repo-agnostic core.** Project specifics live in a per-repo adapter. The first adapter is Acme.

## Concepts

- **Canvas** — a canvas spans one or more repositories; one Obeya serves several canvases.
- **Cards** — everything on the canvas is a card: a task (`task`; in the UI an *Aufgabe*), an idea,
  a prototype, or a `project`, a container backed by a plan doc whose workstreams are its child
  cards. Tasks have no further kind: whether one fixes a bug or adds something makes no difference
  to how it is worked on, so the owner does not pick one. A task's card names no kind either (that
  it is one shows); the others say what they are (idea, prototype, workstream number, project).
  The UI and the Koordinator say *Aufgabe* and *Folgeaufgabe*, never *Karte*.
- **States** — `idea` → `planned` → `working` → `waiting` (demo ready | question) →
  `approved` → `in PR` → `live`, or `done` when the work changed no code; an agent's `proposal`
  is started when accepted. An
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
  ("questions to me with at most three options", "solve rebase conflicts yourself"), or said
  outright ("Merk dir: …"). Shared by all agents, maintained by the Chief of Staff. A learned rule,
  or a learned change to a rule, is a proposal until the owner accepts it; agents follow active
  rules only. A rule the owner writes or says outright is active at once. Besides each input on its
  own, the Rückschau looks back over the last twenty or so for patterns across cards. It holds only
  rules at the level of Obeya: how the agents work with the owner through Obeya, whatever the
  repository. Whatever is about a repository (its conventions, product requirements, tools, and
  taste in code even when it holds in every repository) belongs in that repository's CLAUDE.md,
  where it is versioned, colleagues see it and Claude Code follows it outside Obeya too. Such a
  rule goes there through a card (see the Koordinator): once accepted when learned, at once when
  the owner writes or says it outright.

## Ideas

An idea is thought through on its card before anything is planned; no worker runs.

1. "Ich will über Export für Vermieter nachdenken" (voice or typed), or "Erst besprechen" on a
   planned card of the owner's, makes a card in state `idea`, and its exploration agent opens the
   discussion right away: with what the owner said, or with what the card says, which stays at the
   top of the conversation as its starting point ("Ausgangspunkt").
2. The unfolded idea is a conversation with its exploration agent: a read-only session (code, plan
   docs, the decision log, the preferences) resumed for every message, days later too. It asks
   back, shows variants with their trade-offs and says what they would cost. Its questions come
   with answer options, shown under its reply as radio buttons, or checkboxes when several fit
   together; the owner picks, may add their own words, and both go out as one message that names
   each question. The owner types in the
   panel or holds Space with the idea open; the reply stands in the panel, and only its short
   summary is spoken, when the owner spoke. What the agent read and thought on the way to a reply
   folds away under that reply ("Verlauf"), for whoever wants to follow it. With every reply the
   agent also says what it would do in the owner's place: the option it would pick for each of its
   questions ("Würde ich nehmen", with why), and the next step ("Nächster Schritt, wenn der Agent
   entscheiden müsste": answer first, build, plan, prototype, park or drop, with why). The card marks
   that click (the suggested button instead of "So bauen", the picked options), and the canvas card
   says it short ("Tipp: Prototyp"); the owner follows or overrules it, and the suggestion goes
   with their next message. The voice Koordinator reads it too, so "mach, was du vorschlägst"
   takes that step. Once the agent has replied, the open idea needs the
   owner like a waiting card ("Idee · du bist dran", badge, counted in "brauchen dich") until they
   answer, park, drop or decide it.
3. The agent keeps the brief ("Stand der Idee") on top of the card: goal, open and dropped
   variants, decisions, open questions, effort. The conversation is the means, the brief the
   result: whoever opens the card later reads the brief. The two stand side by side and never say
   the same: findings, variants and questions go into the brief, and a reply only carries the
   turn (what changed in the brief, which open question is next).
4. A prototype ("Prototyp bauen lassen"), when talking is not enough: a worker builds a throwaway one in its own workspace,
   on a card of its own below the idea, and records a demo. Several may run side by side, one per
   approach; each carries its approach in its title ("Prototyp: Logo – Wortmarke", the first words of
   what the owner asked it to show). The idea shows the demos of all its prototypes, each under its
   title, and its exploration agent hears what each found. While one is built, the idea no longer
   needs the owner; the agent's reply to its result makes it their turn again. A prototype's
   worker asks on its own card, and the questions with the owner's answers also go to the
   exploration agent, which takes them into the brief without replying, so the idea does not ask
   them again. It makes no cards: instead of `propose_card` it has `propose_build`, a proposal on
   its card to build the idea on it. A prototype never lands itself and does not count for
   collisions. It ends in one of two ways, and either way its card goes into the archive with log,
   demo and summary ("Prototyp · verworfen" or "Prototyp · gebaut"), never to come back: a new
   attempt is a new prototype. "Verwerfen" (also approving or deleting it) throws its workspace and
   branch away, whatever its state; "Diesen Prototyp bauen" (or accepting its worker's proposal)
   builds the idea on it, see 5.
5. Deciding: "So bauen" makes the brief the card's task and starts it at once, through the
   Koordinator like "Agent starten" (it waits only if it would likely conflict with running work).
   "Diesen Prototyp bauen", on a prototype, does the same on that prototype's branch: its workspace
   and branch (renamed for the idea) become the idea's, whose worker hears that the branch holds a
   throwaway prototype, to take over what carries and bring it to production quality (tests,
   checks, docs, shortcuts removed), with the prototype's handover and the owner's answers on it.
   The decision log says "So bauen, auf Prototyp „…“". Either way the idea's other prototypes are
   discarded, so one card remains. "Als Projekt planen" starts a
   worker on the idea's card the same way, which keeps its title and shows as "Idee → Projekt": it
   writes a plan doc with workstreams, which lands like any change (Acme: a PR). The project then
   takes the idea's place on the canvas (cards it would cover move aside, by as much as it outgrows
   the idea) and links back to it; the idea goes to the archive once its
   worker is done (put back, it stays). "Parken" and "Verwerfen" leave the card with its brief; talking
   to it opens it again. A dropped idea can be archived ("Archivieren" in it or its archive button on the canvas, as on
   a finished card; not while a prototype of it is on the canvas, and then the button is not shown): in the archive it shows its brief and conversation read-only and can go back to its
   place, where talking to it opens it again. Decisions from the conversation go into the decision log; lasting
   preferences are learned by the Koordinator as before.
   While the agent works on a reply, building and planning wait (so does "Diesen Prototyp bauen"):
   the buttons are disabled with "Antwort kommt gleich", and the server refuses them
   (`ideaThinking`). The reply almost always rewrites the brief, so a decision taken before it would
   build a brief the owner never read; once the reply is there, they decide again, nothing is kept
   for them. A voice command that builds or plans such an idea, or one that also discusses it
   ("nimm noch X auf und bau es dann"), only passes what was said to the agent, and the
   Koordinator says that building goes by a click once the reply is there. Parking and dropping
   act at once and end the turn, but lose nothing: the messages the agent has not answered (the
   one it worked on and those queued behind it) stay with the idea (`unread`, across restarts)
   and go to it first, with why its turn ended, when the conversation goes on. The same holds for
   a turn that ended with an error, and for messages queued when Obeya stopped.

## Card lifecycle

1. A card is created by the owner (voice or canvas) or proposed by an agent; the owner can
   edit a proposal, and accepting it starts it (it goes to the Koordinator like a started
   `planned` card) unless they only accept it as `planned`.
2. `working`: the worker leases a workspace, implements, runs the local reviews the repo adapter
   names, and records the demo.
3. `waiting: demo`: the card carries the demo. The owner approves or gives feedback; feedback
   sends the card back to `working`. The demo plays on its own the first time the card is opened
   (per browser; a new render counts as new), later it waits to be played. Each finding in the
   demo's report has "Als Aufgabe anlegen": a planned card with the finding as its text, below the
   card it comes from, in its repository; the finding then names that card. A follow-up's worker
   hears which card it comes from and that card's summary. A question in the demo report is an
   open question like a worker's: the owner answers it on the card or by voice, the worker hears
   the answer, and the demo keeps waiting for approval.
4. Where work lands through pull requests (Acme), approval puts the card `in PR`: its worker opens
   the PR and Obeya carries it to the merge. Review comments, failed checks and conflicts go to the
   worker; only what needs judgement — a review comment that questions a decision, a conflict with
   product meaning — comes back to the owner as a question on the card, and the answer returns it
   to the PR. A PR closed without a merge asks the owner whether to open it again or drop the work.
   Where work lands on `main` (Obeya), approval lands it at once.
5. Merged (or landed on `main`) → `live`. The demo stays on the card. The worker hears that its
   work is on main and may finish what was waiting for that (a data migration, say) before its
   session ends. Work that changed nothing in the repository (the task wanted a demo, an analysis,
   an answer) has nothing to land: approving it makes the card `done` ("Erledigt") without a pull
   request or a landing, and its worker finishes the same way. The owner sees that before
   approving: when the handover finds nothing on the branch (no commits, nothing uncommitted), the
   button reads "Freigeben und beenden", with a line that no pull request follows. A worker whose approved work turns
   out to change nothing (its branch emptied after the approval) closes the card itself with
   `close_unchanged`, which Obeya refuses while the workspace holds commits or uncommitted
   changes. Before, such a card waited in `in PR` for a pull request that could never come
   (Acme's demo card "Export bisher", 2026-10-02).
6. Archived, when the owner takes the finished card off the canvas ("Archivieren" on the card or
   its archive button on the canvas, shown while the pointer is on it, or all finished ones at
   once in the archive), or when a prototype ends (discarded or built; Ideas, 4). The archive
   (button or `A`) lists archived cards
   by day, the most recently archived first, as small cards on a timeline with the time they were
   archived; one unfolds from its card as on the canvas and can go back to the place it had. An
   ended prototype cannot: it shows, read-only, how it ended, its demo, summary and log.
7. A project ends when its plan doc goes (done, deleted): it moves into the
   archive with its workstreams, which are not listed on their own. Its sheet then shows, read-only,
   the goal and the workstreams as the doc last stood; each workstream unfolds with its log and demo.
   When the same file comes back, the project returns to its place. Every project's sheet, live or
   archived, lists its decisions and links the idea its plan doc was written from: when an idea's
   "Plan-Doc" card lands and its diff adds a doc in the plan directory, the project from that doc
   remembers the idea, whose card keeps its brief and conversation, and the idea's decisions join
   the project's. The project takes the idea's place, and the idea, once its worker is done, goes to
   the archive.

## Communication

Agents never talk to each other directly; the Obeya server is the mailbox, so every exchange is
visible on a card. A worker has four tools, served in-process: `report(status)`, a status line
on the card; `ask(question, options, multiple)`, which returns at once — the worker ends its turn
and the answer arrives as its next message (the owner picks one option, several when `multiple`,
or writes their own answer); `propose_card(title, reason, suggestion)`; and
`ready_for_review(summary, demo | no_demo)`. A turn that ends without `ask` or `ready_for_review` gets one nudge,
then its last words become a question to the owner. A turn that ends while the worker's own
background work runs (a demo render, a test suite, a watcher it started) is no such turn: the work
wakes the worker when it finishes or fires, so Obeya waits, and only after ten minutes without a
sign of life does it nudge. A
worker that went to the owner for having stopped and then works on by itself takes that question
back. The owner can send a note at any time; it reaches the worker without stopping it. The SDK
hands a waiting message to the agent only after its running tool call, so a note never cuts a
command off (tests and renders included), and workers keep their tool calls short instead: they
wait for anything external (a deploy, a CI run, a point in time) in the background
(`run_in_background`, Monitor) and end their turn, which a note starts again at once. A Bash
command in the foreground that sleeps longer than 30 seconds (`sleep N`, a polling loop without a
bound, counted from the command line by `foregroundSleep` in `src/server/runtime.ts`) is refused
with that reason; a leading `timeout N` bounds it. A worker answers a note in its log, saying what
it changes or why nothing, and asks when the note is unclear.

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
can be overruled: the owner's next word on the card goes to the learner with the answer it may
overrule, so overruling feeds the preference memory. Owner-facing text from agents is in
the owner's language (`src/core/locale.ts`).

## Architecture

- **Server** — Bun, TypeScript. HTTP + WebSocket to the UI, one API per canvas
  (`/api/c/<canvas>/…`, `/api/canvases` lists them); SQLite (`bun:sqlite`) under `~/.obeya/`.
  `obeya <repo>…` starts one canvas with the given repositories (`--name` names it);
  `obeya` starts the canvases `~/.obeya/canvases.json` lists, `obeya --config <file>` those of
  another file.
- **Configuration** — the canvases with their repositories (path, adapter, clones), seen and edited
  in the "Konfiguration" sheet: each canvas shows its id and whether it runs, each repository its id,
  adapter, whether workers use clones or worktrees, and the command that shares its demos (empty:
  the adapter's, or an export; see Sharing a demo); problems (no git repository, an unknown
  adapter, two canvases with one id, a canvas's home repository left out, a share command whose program is not there) show at the field while
  editing and keep it from being saved. Saving writes the file and restarts Obeya once no worker is
  in the middle of a turn (as for new code); the page reloads. Started with repositories on the
  command line, Obeya shows those, and saving makes the file the configuration it restarts with.
  Renaming a running canvas keeps its id (`id` in the file), so its cards stay. The server's own
  settings (port, data directory, the agents' permission mode) come from the command line and show
  read-only. The Koordinator reads the configuration (`config` tool) to answer questions about it
  and changes it on the owner's word (`configure`, the whole new list, checked like the sheet's),
  with the usual confirmation and undo window. Below the canvases the sheet has the demo settings
  (see Demos), saved on their own into `demo.json` in Obeya's home and read by the next render, so
  saving them restarts nothing.
- **Canvases and repositories** — each repository on a canvas has its adapter, workspaces,
  workers, project agents and PR watcher; the canvas has one board and one Koordinator, whose
  collision checks stay within a repository. The first repository is the canvas's home: its plan
  references and workspace directory are the ones a single-repository canvas always had, so
  canvases keep their data. The others' plan docs are referenced as `<repo>:<path>`; the owner's
  cards carry their repository, chosen in the panel before work begins (home by default), and a
  proposal or a cut package inherits it. The UI opens `?c=<canvas>`, the pill after the logo switches,
  and on a canvas with several repositories every card names its own. Cards on other canvases that
  need the owner show as a count at their entry in the switcher and, while it is closed, as the sum
  on the pill; the server pushes every canvas's count to all of them when one changes.
- **UI** — browser app, React + TypeScript. Custom canvas: camera with
  fly-to, unfold-in-place, semantic zoom, edge indicators, minimap, and a frosted top bar the
  canvas slides under. The logo (`src/ui/logo.tsx`: three cards in the colours of working, waiting
  and approved, "obeya" in Inter Bold as outlines) opens the bar, stands alone in the middle while
  the page loads, above "offline" when the server is gone, and is the favicon; `bun
  scripts/logo.tsx` writes it as the files in `src/ui/logo/`.
- **Agents** — Claude on the owner's subscription, no API billing, through the Agent SDK: it runs
  on the Claude Code login of the machine (tested without an API key: `apiKeySource: none`).
  A worker is one SDK session per card with streaming input, the repo's own settings and
  CLAUDE.md, and permission mode `auto` (`--permission-mode`); after a restart it resumes by
  session id. A project agent is one read-only session per project (Read, Grep, Glob on the Obeya
  checkout), resumed for each question, answering one question at a time. The SDK sits behind a
  small runtime interface, so the orchestration is tested against a fake. Two SDK hooks ride on
  every session: before a Bash call, the refusal of long foreground sleeps; after every tool call,
  what changed since the session's instructions were built (`AgentSpec.contextUpdate`) goes to the
  agent with that call's result. Workers and idea agents use it for the owner's preferences: a
  preference learned or changed while one runs reaches it once, at its next tool call, without a
  message or a new turn.
- **Workspaces** — per adapter. A pool of full clones leased by a card while it is worked on
  (Acme: csharpier finds no files inside a worktree, and parallel AppHosts per clone are proven),
  or a worktree per card (Obeya itself: any number in parallel), kept across stop and restart
  until the card's work has landed. Clones come from `--workspace <path>` or `--clones <n>`.
- **Landing** — per adapter. `pr` (Acme): approval leaves the branch for the PR loop. `main`
  (Obeya): approval rebases the branch onto `main` and fast-forwards the Obeya checkout; the card
  is `live`. Commits that conflict one by one but not as a whole land squashed into one commit.
  Uncommitted work or a real conflict sends the card back to its worker with the approval kept:
  its next handover (no new demo needed) lands on its own.
- **PR loop** — on approval the worker hears that its work goes out as a pull request, opened the
  way the repository does it (its own skills and conventions, a description for readers who have
  not seen Obeya), and reports it with the tool `pr_opened(url)`. From then on it may push its
  branch, never merges, and ends its turn after each round instead of handing over again. Per
  repository a watcher polls every open PR through `gh` every two minutes (state, mergeability,
  checks, conversation and review comments, inline comments), and right away when the owner comes
  back to an Obeya page (it becomes visible or gets the focus; at most once in 15 seconds): the
  owner merges on GitHub and returns, and before, the card stood "in PR" for up to two minutes
  after the merge (Acme's PR #821 on 2026-10-02: merged 12:12:40, seen 12:14:12). The watcher sits behind a small forge interface
  (`src/server/forge.ts`) so the loop is tested against a fake. New comments, failed checks (once
  per check and commit) and a conflict (once per commit) go to the worker as a message, which says
  what happened and leaves the how to the repository's ways (Acme: its `address-reviews` skill,
  which merges `main` instead of rebasing, replies on and resolves threads, and asks Greptile for a
  re-review after each push). Whatever the way, each review comment gets a reply in its own
  thread (what changed, or why not) and the thread is resolved unless the worker still wants the
  reviewer's answer; one summary comment for all is not enough. The owner's log gets a line for
  each event. Checked on Acme's PR #821 (2026-10-02): all five Greptile threads got their own reply
  and were resolved before the re-review ping; a page opened earlier showed the ping but neither
  the replies nor the resolutions until reloaded. Comments by the PR's author
  (the worker replying in the owner's name) and by accounts the adapter names as noise (Acme: the
  Cloudflare deploy bot) are skipped; an app's inline comments come as `<name>[bot]`, its
  conversation comments as `<name>`, and the watcher reads both as `<name>`. While the owner is
  asked, news waits. Once nothing is left for the worker, the card needs the owner: "Bereit zum
  Mergen" (once in the log, on the card and folded) when GitHub sees nothing in the way
  (`mergeStateStatus` clean), every check has passed, every review thread is resolved, the worker
  is not in a turn, and whoever the PR's author last asked for another look has answered since. A
  review bot often answers a re-review only by rewriting its summary (Greptile's new score, on Acme's
  PR #821 on 2026-10-02, with no new comment), so a rewrite counts as an answer; before, the watcher
  waited for new comments only and the card stood "in PR" with nothing left to do. The owner
  merges on GitHub; anything new for the worker takes the readiness back. A merge makes the card
  `live` (After landing, below). The card shows the PR
  with its link, its checks (each linked to its run), a conflict and whether it is ready to merge;
  folded, it reads "PR #42 · 1 Check rot · Konflikt" or "PR #42 · Bereit zum Mergen". Below the checks it shows the review as last polled, oldest
  first: each round a reviewer left comments on the code in ("Runde 2 · greptile-apps · 3
  Anmerkungen, 1 offen"), each comment folded to its first line with whether its thread is
  resolved and how many replies it has, unfolded with the file, the comment and the replies (the
  PR author's as "Agent"); between the rounds the conversation (a reviewer's summary, the
  worker's requests for another round; a comment rewritten since, like Greptile's summary each
  round, stands where it was last changed). Review bots write HTML into their Markdown: badges keep
  their name (Greptile's "P1"), folded parts, code and diagrams go. Whether a thread is resolved
  and when a comment was last changed only GraphQL says, so the watcher asks that too. Checked against real Acme pull requests (2026-10-01): `gh`
  reads their state, checks and comments; the first Acme card carried through to the merge is still
  to come.
- **After landing** — the worker is told its work is on main (or that its PR was merged) and may
  finish what remains, in its workspace, which stays at what landed until then (the card is `live`,
  "Agent erledigt den Rest"; notes reach it, "Anhalten" ends it). Ending a turn with nothing to wait
  for ends its session and removes worktree and branch (a clone is free again). When the landing
  changed Obeya's own running code, the worker is told Obeya restarts with it; what needs the new
  code waits through `after_restart`: the worker ends its turn, the restart goes ahead, and the
  resumed worker hears that Obeya now runs its change.
- **Self-update** — Obeya runs from a checkout that work lands on, so `live` must mean running.
  Without `--dev` the `obeya` process supervises the server: when the checkout its code comes from
  moves to commits that change code (not only docs), the server stops and starts again; when the
  commits since it started change `package.json` or `bun.lock`, it runs `bun install
  --frozen-lockfile` in the checkout first (a failure goes to the log and the restart goes ahead,
  the new code then fails where it imports what is missing); workers resume, and an open page reloads when it reconnects to a new server process. The restart waits
  until no worker is in the middle of a turn or waiting for its background work, even one that has
  asked or handed over meanwhile (at most 15 minutes), since it stops whatever a worker runs. The
  workers it waits for are told it is due, and so is a worker that starts a turn before it: they
  start nothing long, stop background work they can start again, and pause at the next safe point
  by ending their turn (no nudge, no question to the owner; the card's log says it paused). A
  resumed worker hears that what ran was stopped (exit code 137) and goes on. A worker that waits for the restart to finish its landed work is not
  in a turn and does not hold it up. The restart also waits while the owner watches a demo video or
  dictates in an open page (from the press until the command's undo window is over), past the
  15 minutes too: the page tells the server over its WebSocket whenever that starts or stops, and a
  page that closes lets go. While a restart waits, the bar shows it ("Neustart wartet auf
  N Agenten", "… auf dein Video", "… auf dein Diktat"; until when at most, while only agents hold
  it); hovering names why and the cards it waits for, and "Jetzt neu starten" (`POST /api/restart`)
  has it go ahead at once, its hover text saying what that cuts off. The page that reloads keeps
  what was open: just before the reload it writes down (per tab, in `sessionStorage`) the open card,
  project (its plan doc read or not) and sheet, the scroll position of every scrolled box in them,
  the drafts in their text fields and where the demo video stood; the new page opens them again
  without flights or unfold and puts positions and drafts back while their content loads
  (`src/ui/keep.ts`). The camera is kept anyway.
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
  while the pointer is on them; it starts the card (the queued one anyway) without unfolding it. A project starts all its
  planned workstreams at once ("Alle N starten" in the project card's head, "Alle N Workstreams
  starten" in its sheet, or by voice: start on the project): they queue in the plan's order, wait
  8 seconds in which "Rückgängig" takes the start back (the button is easily hit), and then one
  Koordinator turn sees them together with the
  plan doc, the cards in progress and those queued ahead. It puts them in an order and says for
  each what it waits for: a workstream it builds on (until that one has landed) or one it would
  likely conflict with; the rest start at once. A workstream may wait only for what comes before it
  in that order, so none wait for each other, and the order is the queue's from then on. The
  project's sheet names what each waiting workstream waits for. When the turn fails, each is judged
  on its own as if started alone; after a restart the joint turn runs again. Paths the adapter marks as soft (docs) do not count. "Aufteilen" cuts a planned card
  into 2–6 packages with disjoint files, or keeps it and says why. It answers questions of cards
  without a project, and after whatever the owner says it decides whether a lasting preference
  was stated and proposes it as a rule (the card's log says „Schlägt vor: …“), for the preference
  memory or, when it is about a repository, for that repository's CLAUDE.md (for each repository
  of the canvas when it holds in all of them; one proposal each); "Merk dir: …" by
  voice records a rule outright, sorted the same way. What it learns from: answers, notes and feedback to
  workers; an idea's discussion; the conversation with it (a reply or look-up at once, with its
  reply; a command once its undo window has passed, unless its words reach the learner another
  way, as a note or an idea's discussion do); and the text the owner writes in a card, once they
  pause typing for a minute or act on the card, with the text it had before (a proposal's, a
  finding a follow-up quotes). The owner's first note, answer or feedback on a card after an answer
  given in their name goes with that answer, which it may overrule. The learner reads an input with
  the card's text, what the owner said in the last three days (notes, feedback and answers to
  agents, ideas' discussions, the conversation with the Koordinator; at most 30), the agent's last
  message before it (taken when the input arrives, not when the learner's turn comes), the canvas's
  repositories, the active rules, the rules accepted for a CLAUDE.md, and the open and rejected
  proposals. Its prompt names the signals for a proposal: phrased
  generally ("immer", "nie", "ab jetzt"), a correction of how an agent works, a repetition of
  something said before, an overruled answer; it makes at most one proposal per input. The
  Rückschau counts the owner's inputs: what the learner reads, and clicks without words in a card
  (start, approve, accept or dismiss a proposal, park, start anyway, …), a deleted card, a command
  taken back, a rule proposal decided on; a spoken command counts once, as what was said. The
  count and when the history begins are settings of the canvas, so they survive a restart. At
  20, after the learner has read the input that completed the count, one read-only session in the
  home checkout reads what happened since the last Rückschau (at most the latest 300 lines): the
  cards' milestones (the owner's notes, answers and clicks, the agents' questions and hand-overs,
  answers given in the owner's name), the owner's words in ideas and to the Koordinator, taken back
  or not, the cards they deleted or dismissed, and the rule proposals they accepted or rejected.
  It looks for patterns seen at least twice on different cards and proposes up to three rules,
  each with a sentence on what it rests on and, like the learner, for the preferences or a
  repository's CLAUDE.md; the sheet shows that as their occasion („Aus der
  Rückschau: …“). Its
  sheet (button or `K`) shows the queue, the cards in progress and the preferences; open
  proposals stand above the rules with their occasion (the card and the owner's words, or the
  Rückschau), for a change the rule it changes, and where it goes („Gehört in“: the preferences or
  the CLAUDE.md of a repository; `target` in `preferences`), which the owner may switch. The owner
  accepts one, edits it before accepting, or rejects it; an accepted change takes the place of its
  rule. Rejected proposals are kept (state `rejected` in `preferences`), so the learner can see
  them. A rule accepted for a CLAUDE.md (state `filed`) goes into its repository's open card
  „CLAUDE.md ergänzen“ (planned and not yet with the Koordinator; the setting `claude_md_card:<repo>`
  names it), or into a new one when there is none; so does one the owner gives outright for a
  repository, by voice or in the sheet's field for a new rule, which has the same „Gehört in“; its worker writes the rules into the CLAUDE.md
  in the style of what is there. These cards start by themselves, through the Koordinator like any
  start, once no proposal waits any more, whatever its place: a waiting one might yet be switched
  to theirs, so several rules go in together. The card lands like any other (in Acme, through a pull
  request); until then the rule applies to no agent, and afterwards through the CLAUDE.md alone. The Koordinator
  button counts open proposals (violet, beside the grey count of queued cards); they do not
  count among the cards that need the owner and do not show on cards.
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
  approve, accept, dismiss, cut, stop, remember; on ideas: discuss, build, plan doc, prototype,
  park, drop; on prototypes: build on it, discard),
  checked against the cards' states in the turn, so an action that does not fit (a note to a card no agent
  works on) goes back to the Koordinator, which may reply instead. Start on a card queued behind
  others starts it now despite the likely conflict, like "Trotzdem starten"; it sees which cards a queued
  one waits for, so "starte alle wartenden Aufgaben" works. A reply answers questions too
  ("Was ist seit gestern passiert?"), as far as the cards and their history answer them.
  "Merk dir: …" ("ab jetzt immer …") is remember, with the open card as its occasion, once the undo
  window has passed. A rule on how agents work with the owner through Obeya becomes one of the
  owner's, active at once; one about a repository („Merk dir: in Acme immer …“) goes, like a learned
  one, into the card „CLAUDE.md ergänzen“ of the repositories it names (`repos`), without a
  proposal, since the owner said it. The confirmation says which of the two it went to. It may name
  the rule it changes, which then takes the new text, or, moved into a CLAUDE.md, goes. The
  Koordinator always sees the canvas's repositories, one included. The Koordinator gets the owner's rules, numbered, with every command,
  and follows them itself too.
  With a card open, the Koordinator gets its worker's whole summary and the findings of its demo,
  so "lege eine Folgeaufgabe für die ambient-Auffälligkeit an" makes a follow-up of that card with
  the finding as its text. One confirmation covers all actions; they run in order a few
  seconds after it reached the owner, so "Rückgängig" takes back anything, even an approval. Only
  talking to an idea goes on at once: it changes nothing, and said to the open idea it needs no
  confirmation, since the conversation shows it. The same commands can be typed in the
  Koordinator's sheet. What the owner said and the Koordinator's confirmation go into the log of
  the card that was open, and "Zurückgenommen." when taken back; with no card open, the sheet
  shows the conversation, newest last, in all the height the rest of the sheet leaves free (360px
  at least, unless it is shorter; with less room the sheet scrolls). Talk to an open idea is the exception: its conversation already holds it.
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
  in focus ("Koordinator · Aufgabe: …"). Card tags
  (`K1`, …) stay fixed for the session. Each command brings the cards as they are now and what
  happened since the previous one (state changes, questions, answers, hand-overs, the owner's
  notes, errors, new cards; not the workers' steps); a command the owner took back is told with the
  next. Every exchange is stored (`talk`). A session is not resumed: after a restart, and after 30
  commands so the context stays short, a fresh one starts from memory: the last 20 exchanges and
  the canvas's last 14 days (at most 60 steps), with times.
- **Voice out** — the default system voice speaks the confirmation, which the browser plays: a
  JXA sidecar keeps the macOS synthesizer loaded (about half a second a sentence), with `say` as
  the fallback. While a demo video plays nothing is said (the owner often gives a command and
  turns to the next demo); a video that starts cuts off what is being said. The written
  confirmation still shows.
- **Demos** — the demo skill's pipeline (scripted walkthrough, narrated video, report) is part of
  the repository: `plugin/` is a Claude Code plugin named `obeya` whose skill `demo`
  (`plugin/skills/demo/`) holds the instructions (`SKILL.md`, paths through `${CLAUDE_SKILL_DIR}`),
  the director (`lib/director.ts`, Playwright on the local Chrome, else Edge, else Playwright's
  own Chromium, as on Linux on ARM where there is no Chrome; cut with ffmpeg, run with plain
  `node`; on macOS, Linux and Windows, checked 2026-10-05), the overlay (`lib/overlay.js`) and the narration (`lib/tts.py`, synthesis and listening
  back with Whisper), with Playwright among Obeya's dependencies. Obeya loads the plugin into every
  worker session of a repository with demos (the Agent SDK's `plugins` option, a local plugin),
  so the worker has the skill as `obeya:demo`, which its brief names. The skill also runs without
  Obeya: as the plugin, or as a user skill that points to `plugin/skills/demo` (the owner's
  `~/.claude/skills/demo` is a link to it in the Obeya checkout). The demo settings
  (`lib/settings.ts`; `demo.json` in Obeya's home, `OBEYA_HOME` else `~/.obeya`) give the
  narration language (German or English: narration, captions, Whisper, the report page's words)
  and the voice, a provider: text in, WAV out (`lib/voices.ts` turns the settings into what
  `lib/tts.py` runs). Local ones run once per clip as a command with the text on stdin: Piper, the
  default (German `de_DE-thorsten-high`, English `en_US-ryan-high`; about twice real time on a
  laptop CPU, model loading included, and Whisper heard the test clips back word for word,
  measured 2026-10-02), Qwen3-TTS (1.7B, a stock speaker from the CustomVoice model or a clone of
  a clip with its transcript beside it from the Base model; MLX through mlx-audio on Apple
  Silicon, PyTorch through qwen-tts elsewhere, `lib/qwen3.py`), macOS `say` (offered on a Mac
  only), and the owner's own command (through the shell; it writes the WAV to `$DEMO_WAV`). Hosted
  ones are HTTP requests from templates in `tts.py`: Gemini, OpenAI (or another base URL with the
  same API), ElevenLabs, Azure, or the owner's own endpoint (POST `{"text", "language"}` as JSON,
  audio back), each with its key from its environment variable or a key file. Whatever comes back
  becomes a mono 16-bit WAV through ffmpeg (a voice command gets its text as UTF-8, with
  `PYTHONUTF8`: on Windows Piper read it in the code page otherwise); Whisper listens back in a throwaway uv environment:
  mlx-whisper on Apple Silicon, faster-whisper elsewhere (CUDA with a GPU, else int8 on the CPU;
  the clip decoded by ffmpeg, since its own PyAV decoder broke with newer PyAV). Listening back is
  optional: off in the settings ("Erzählung mit Whisper gegenhören", `listenBack: false`), or off
  for one render when uv cannot get Whisper or it fails to load; the clips then stay unheard and
  uncached as heard, one take each, the review table says "not heard back", and the report page's
  provenance says "nicht gegengehört" with why (otherwise "mit … gegengehört").
  Obeya installs Piper and Qwen3-TTS on request from the settings sheet, which shows what is
  missing and about how large it is first: each in a Python environment of its own made by uv
  under `voices/` in Obeya's home, Piper's voice files beside it, Qwen3's models in the Hugging
  Face cache, where a model downloaded before counts as installed (`node lib/voices.ts install`
  does the same without Obeya). A render refuses a voice that is not installed and says how to
  install it. The sheet also plays a sentence in the voice being chosen ("Anhören"). Local voices
  that load a large model (Qwen3-TTS, the owner's command) synthesise one at a time on the
  machine: `tts.py --lock ~/.cache/demo-skill/tts.lock` holds the file locked while it runs
  (`flock`, on Windows a byte-range lock through `msvcrt`; it works beside an older `lockf -k` on
  the same file). The owner's clone is such a command: it
  runs in the owner's voice project (Stimmzwilling, `scripts/demo_voice.py`) and never leaves the
  machine. Voices are not labelled as generated, a clone included: the whole demo is generated,
  and that is clear from where it is shown. The person follows from "Das ist meine eigene
  Stimme" in the settings: the first person only in the owner's own voice, otherwise the
  narration presents the work without "I". `node lib/settings.ts` prints what applies, for the
  agent writing the narration; `DEMO_VOICE` overrides the voice for one render (another provider,
  never the owner's own, or a `.wav` that Qwen3-TTS clones). Settings from before the providers
  carry over: `gemini` keeps its key file, `clone` becomes the owner's own command, still to be
  written. How to run each project's app
  for a demo is the adapter's `demo.howToRun` (Acme: AppHost, login, QA customer, migrations;
  Obeya: the scratch instance); without Obeya, `bun lib/recipe.ts` in a repository prints it. The
  worker records once the change is committed and checked, as the adapter says how to run the
  app (Obeya: a scratch instance from the worktree, staged by `scripts/scratch-obeya.ts` from a
  stage file before every take, its workers idle (`--idle-workers`) unless the change is about
  agents; Acme: the clone's AppHost), and hands over the directory, chapter titles and report with `ready_for_review`.
  Obeya takes the chapter times from the captions and serves the video, poster and captions of
  the card's demo (range requests). The card shows it with approve and feedback
  beside the video; feedback asks for a new render. When the result is something to look at
  rather than something that happens, the worker makes an HTML artifact instead (`kind: 'html'`):
  a directory with an `index.html` and the files it loads, handed over with the same report. The
  card shows the page in a frame where the video would be (no chapters); Obeya serves any file of
  that directory, none outside it, with a CSP sandbox and the frame's `sandbox`, so the page's
  scripts run in an origin of their own, away from Obeya's API. A handover with `no_demo` (the
  reason) instead is the exception the worker's brief names as such: the card waits for review
  with the summary and the reason, and a demo from an earlier handover leaves the card, since it
  showed other work. Artifacts stay in `~/demos/`, never in git; a pull request links a video demo
  only once it is shared (below).
- **Sharing a demo** — every video demo has "Teilen" beside it, on waiting cards and on cards long
  done (archived ones too); HTML artifacts and prototypes are not shared. Where it goes depends on
  the repository's share target: the command line in its configuration (`share`, see
  Configuration), else the command its adapter names (`demo.share`; Acme). With a target, the
  demo is published on a page. "Teilen" publishes right away, without a hold to take it back:
  "Nicht mehr teilen" withdraws the page just as easily (until 2026-10-02 it held 8 s with "Doch
  nicht"). Once the page is up, the card shows the link (open, copy) and "Nicht mehr teilen". A
  card that gets a new demo after sharing says the page still shows the earlier one and offers "Neu teilen"; nothing is replaced on its own. The page has a title and two to five
  sentences for colleagues who have never seen Obeya: where the repository has a target, `ready_for_review`
  takes them with a video demo (`demo.page`), and for a demo handed over before that a short
  read-only session writes them from the worker's last summary when the owner shares, kept with
  the demo afterwards. Obeya runs the command (`src/server/share.ts`) in the repository with
  `OBEYA_HOME` set, one call at a time: `publish` with the page as JSON on stdin (slug, title,
  text, chapters, PR URL, demo directory, and the slugs of the other pages it has shared), which
  prints the page's URL; `withdraw <slug>`. The slug comes from the card's title and id once and
  stays, so a link keeps working across publishing again. The command's stderr goes into the
  card's log, a failure with its output as an error, and the card stays as it was. A share held,
  publishing or withdrawing at a restart goes on after it.
  The pull request and the page link each other. A demo shared before approval goes into the
  worker's approval message with "link it in the description". Once a PR exists and the page is
  out (in either order: `pr_opened` after sharing, or sharing a card whose PR is open or merged),
  Obeya reads the description through the forge (`gh pr view --json body`) and, unless it
  contains the page's URL already, adds a line `Demo-Video: <url> <!-- obeya:demo -->`
  (`gh pr edit --body-file`); a later line of its own is found by the marker and replaced, not
  added again. A page shared before the PR existed is published again with the PR's link: what
  it showed then (title, text, chapters and demo directory, kept with the share), not a newer
  demo on the card, which still waits for "Neu teilen". The card goes on showing the link
  meanwhile; a PR reported while the page is going out gets a second round after it. A failure
  to read or edit the description goes into the card's log; the page stays shared. Withdrawing
  the page leaves the line in the description.
  Without a target, "Teilen" exports the same page as a file to pass on (`Sharing.export`,
  `GET …/cards/<id>/export?as=zip|html`): a ZIP with a folder named by the slug that holds
  `index.html` with the video, poster and captions beside it, or one HTML file with the video in
  base64, played from a blob so it seeks; only for videos up to 15 MiB (`EXPORT_HTML_MAX`, so the
  file still goes by mail), the button says so for larger ones. Nothing leaves Obeya, so an export
  is not held; the card's log names the file. Both pages carry their captions as cues in a script,
  since Chrome does not load a `<track>` for a page opened from disk. The page (`src/server/demo-page.ts`)
  is the one Acme's site shows, without its link to the overview. A share command from the
  configuration runs like the adapter's; its words are split at spaces outside quotes, a program
  given as a path and any script are found in the repository, and a script (`.ts`, `.js`) runs
  with Obeya's own Bun, so the same line works on Windows. The ZIP is written by Obeya
  (`src/server/zip.ts`, stored without compression: the video is compressed already).
  Acme's command (`src/adapters/team-share.ts`) keeps the site in `~/.obeya/team-share/site/` (a
  directory per demo with page, video, poster, captions and `meta.json`, and the overview, newest
  first) and deploys all of it with `wrangler pages deploy` to the Pages project `team-demos`,
  behind the same Cloudflare Access policy as the docs (`@example.com`). Account ID and API
  token are in `~/.obeya/team-share/cloudflare.env`. Pages serves no byte ranges (a range request
  gets the whole file with 200), and a browser cannot seek in a video streamed that way: the
  chapters and the progress bar jumped back to the start. The page therefore asks for a range
  first and, getting the whole file, plays the video from memory. Each call writes every page
  afresh from its `meta.json`, so pages shared earlier take a fixed template along. It refuses files over 25 MiB (the Pages limit)
  and a site that lacks a page Obeya has as shared (a lost directory would take them offline), and
  puts the directory back when a deployment fails. The owner sets it up once in Cloudflare (done
  2026-10-02), in this order: the Pages project `team-demos` (under Pages: the dashboard's plain
  "Create" makes a Worker on `workers.dev` instead); then the Access application for
  `team-demos.pages.dev` and `*.team-demos.pages.dev` with the docs' policy, whose domain Access
  offers to pick only once the project exists (no free text); and an API token with Pages edit
  rights in `cloudflare.env`. The command never creates the project itself.
- **Repo adapter** — how to start and refresh the stack, where the frontend URL comes from, the
  recipe for running the app in a demo (login, test data, migrations: `demo.howToRun`), where plan
  docs live, which reviews run, the command that shares demos (the
  configuration's takes its place).

## Data

Persistent (SQLite): canvases, cards (kind, state, position, parent; agent session, workspace,
branch, status line, open question or review summary (with the reason when there is no demo), the card it came from (a proposal's
source, a follow-up's card), estimated scope, queue,
when archived, the pull request (link, checks, the comments, failed checks and conflict already
passed on), an idea's status, brief and open questions with its agent's picks and suggested next step, a prototype's idea, how it ended and its worker's proposal to build on it, the prototype an idea is built on, landed work whose worker still
finishes; a project's plan doc as last read and the idea it came from; the plan docs an idea's landed
work added; the shared demo page: slug, link, the demo directory it shows, and whether it is held,
publishing or withdrawing),
card events (the log, with an error code where the UI words it and the owner's screenshots), a card's own
screenshots, workspaces and their leases,
decision log, preferences, the Koordinator's conversation with the owner (what was said, its
reply, the screenshots that came with it, the open card, whether it was taken back; a looked-up
question, the card it is about, its answer and who gave it), per-canvas settings (the home repository; the Rückschau's count and when its history begins).

Files under `~/.obeya/`: the owner's screenshots (`images/<canvas>/`), the configuration
(`canvases.json`), Acme's shared demo site and its Cloudflare credentials (`team-share/`).

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
- The worker opens and tends its PR the way the repository does it, rather than Obeya scripting
  the steps (2026-10-01): Obeya's first version told it to rebase and push with
  `--force-with-lease`, while Acme merges `main` into a PR branch, never force-pushes, and has its
  own skill for review comments. Obeya says what happened on the PR, the repository says how to
  answer it.
- Spoken output uses the macOS default voice (synthesizer sidecar, `say` as fallback).
- Obeya itself is developed without branches or PRs: approved work lands directly on `main`.
- Work without a change to the code ends in a state of its own, `done` ("Erledigt"), not `live`
  (2026-10-02): nothing went live. Whether there is anything to land Obeya reads from the
  workspace on approval, rather than from the worker's word; the worker's `close_unchanged` only
  covers work whose branch emptied after the approval. The owner still approves such work: its
  demo or summary is the result.
- Learned rules are proposals the owner accepts first, rather than stored silently as at first
  (2026-10-02): the owner wants to see every learned rule before it applies. Open proposals count
  on the Koordinator button only, not among the cards that need the owner nor on the cards. The
  Rückschau runs after about 20 inputs, neither daily nor only on request.
- Preferences hold only how agents work with the owner through Obeya; rules about a repository,
  taste in code that holds in every repository included, go into its CLAUDE.md (2026-10-02). At
  first the learner drew no line, and repository facts landed among the preferences, unversioned
  and unseen by colleagues and by Claude Code outside Obeya. Rejected: not learning repository
  rules (what the owner says would be lost), preferences scoped to a repository in the database
  (unversioned, invisible outside Obeya), the Koordinator committing to the CLAUDE.md on accept (it
  only reads, and nothing goes to Acme's `main` directly). Accepted ones collect in one card per
  repository that starts once no proposal waits, so several go in together without the owner
  starting it. A rule the owner says outright („Merk dir: …“) or writes in the sheet is sorted the
  same way and filed at once, without a proposal (2026-10-02): at first it always became a
  preference, so repository rules said outright still landed there.
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
- The sheets on the right (Koordinator, archive, configuration, a project's) are as wide as the
  owner drags their left edge: one width for all of them, and one for reading a plan doc, which
  follows the window until dragged. The browser remembers both; the canvas keeps 240 px beside the
  sheet, and the camera keeps a project beside it; a double-click on the edge goes back to the
  default (2026-10-02).
- A plan card gets a stored row the first time it is seen, so the owner's placement persists; its
  title, text and state always come from the doc. Each read also keeps the doc's last state on the
  project (title, goal, workstreams with key, label, title, text and state).
- A plan doc that disappears ends its project: the project goes into the archive with that last
  state, and returns with its placement when the same file comes back (2026-10-01). Ending is
  automatic rather than an explicit "abschließen", which can later sit on top. Obeya watches the
  plan directory and the nearest directory above it: git removes the plan directory with its last
  doc, and the directory's own watch then reports nothing (M5 stayed on the canvas until a
  restart). Reading old content
  from the git history instead was rejected as fragile (PRs and clones on Acme, renames); it served
  only once, to backfill Obeya's own projects from before
  (`scripts/backfill-archived-projects.ts`, run 2026-10-01 for M2, M3, M4, M6 and M7). Known edges: a doc missing only for a moment (a branch
  switch in the checkout) sends the project to the archive and back; a renamed doc makes a new
  project and leaves the old one archived. A project from before the doc was kept has nothing to
  show and stays hidden.
- A canvas belongs to a repository, not a checkout: the adapter names it (Acme: `acme`), so the
  clones share one. Adapters live in this repository (`src/adapters/`) and are picked by the
  `origin` URL; the generic one covers any repo with `docs/plan/`.
- A card has one fixed size; a delivered workstream shrinks to a chip, a project wraps its
  children, and a workstream cannot be dragged out of its project. New projects are placed in a
  grid below the existing ones. A proposal or follow-up goes below the card it came from, or, when
  something is in the way there (for a workstream: its own project), to the nearest spot clear of
  every card and project (2026-10-05).
- The dashed line from a proposal, follow-up or prototype to its card joins the sides that face
  each other (left and right when the two stand more beside than above each other) and runs above
  projects but below cards, so a line from a workstream stays visible over its project
  (2026-10-05).
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
- A project's workstreams started together are scheduled in one Koordinator turn rather than
  started one after the other through the single-card check (2026-10-02): workstreams of a plan
  often build on each other, which a check for merge conflicts alone does not see, and only a turn
  that sees all of them and the plan doc can choose the order. The workstreams that wait then go
  the usual way: they start once what they wait for has landed, judged again against what runs.
- Landing problems are classified: uncommitted work, rebase conflicts and branches emptied by the
  rebase (their commits are on main already) go back to the worker; a blocked Obeya checkout stays with the owner, and the card stays in review.
- An approval holds through what the worker fixes to land it: main moving on is no reason to ask
  the owner again. Feedback, a stop or a blocked Obeya checkout take it back.
- Refusals carry an error code; the UI words them (`src/ui/strings.ts`), the English detail is
  for developers.
- The owner archives only their own cards, and only once `live` or `done`, or an idea once dropped (a parked
  one is meant to come back, so it stays in sight); "all finished ones at once" leaves dropped
  ideas alone. A workstream stays with its
  project, where a delivered one is already a chip, and goes into the archive with it. Archiving
  keeps the card's position, demo and log.
- Prototypes stay cards of their own, and several may run for one idea (2026-10-02): parallel
  approaches are to be seen side by side, not hidden inside the idea. The one that convinces is not
  thrown away and rebuilt from `main`: the idea is built on its branch, so its commits go into the
  branch's history, and the worker's brief has to keep prototype quality from landing as it is.
  A discarded prototype keeps its demo, log and summary in the archive but not its code.
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
- A restart waits for what the owner does in the page only where a restart would destroy it
  (2026-10-02): a demo video that plays, a dictation until its command can no longer be taken back.
  Everything else (an open card, a sheet scrolled halfway, a draft) is kept across the reload
  instead of holding the restart off, so new code is not held back by a page that is merely open.
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
  through the exploration agent, which stays read-only. That worker runs on the idea's own card and
  starts with the decision, and the project replaces the idea on the canvas (2026-10-02): a
  separate planned "Plan-Doc" card in between had to be started by hand and left the idea standing
  next to its project.
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
- A demo is a video or an HTML artifact, chosen by the worker (2026-10-01): drafts to choose from
  (a logo for Obeya) say more as a page side by side than as a recording of one. The report, the
  open question and the follow-up cards are the same for both. Without any demo the owner would
  have to read to decide, so handing over without one needs a reason and stays the exception.
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
  where work lands there; for Acme, whose work lands through PRs, read them from `origin/main`?
- Which Acme clones may workers lease: the existing `~/dev/app2`–`app5`, or fresh ones?
- A plan doc without a `## Workstreams` checklist is not shown (in Acme: `parsed-view.md`,
  whose tasks sit under other headings). Fix such docs, or show them as projects without cards?
- Demos for open source (the pipeline in the repository, voices as providers, Windows and Linux,
  sharing beyond Acme): planned in [`docs/plan/demo-sharing.md`](plan/demo-sharing.md).
