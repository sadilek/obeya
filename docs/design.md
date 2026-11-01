# Obeya — design

How Obeya works and why, written for an experienced engineer who would rebuild it with the same
features, however different the rebuild would look. A sentence belongs here if that engineer would
need it:

- behaviour seen from outside: by the owner on the canvas and the phone, by the agents (their tools
  and what their prompts promise), and by repositories (the settings format, what lands in git, the
  files Obeya writes);
- data and wire formats a rebuild must stay compatible with;
- constraints that are not obvious and that a rebuild would otherwise walk into (a platform quirk,
  the reason something unusual is needed);
- decisions: what was chosen, why, the alternative rejected, and the date, so a rebuild does not
  take a path already ruled out.

What the code shows stays out: function, field and file names, which module does what (a pointer is
fine where the code is otherwise hard to find), pixel values, colours and sort order unless the
number is the feature. So does history: a change that replaces behaviour rewrites the description,
and git keeps the old one; a decision names the rejected alternative, not the story of how it went.

How this document is written:

- Each chapter first says how its part of Obeya works now, in the present tense, then lists its
  **decisions**.
- A rule is described in one place; other chapters refer to it by its heading (see Landing).
- UI texts are quoted in German as the owner sees them („Freigeben“) where the wording matters or
  names the control; settings and API paths are in backticks.
- Work in progress is planned in plan docs under `docs/plan/`, which Obeya shows as projects; when
  one is done, what passes the test above moves into a chapter and the plan doc goes.

Chapters: Goal, Principles and Concepts follow below; every other chapter is a file of its own
under `docs/design/`, with its decisions at its end. Read this index, then the chapters a change
touches, and keep those current in the same change.

- [Ideas](design/ideas.md) — idea cards and their exploration agent: starting an idea, the
  discussion, the brief, prototypes, deciding what becomes of it, building it in a new repository,
  while the agent replies.
- [Card lifecycle](design/card-lifecycle.md) — a card's states from proposal to done: proposals
  (later starts, taking back, reworking by words), at work, waiting for approval (the handover
  report), approval and landing, live and done, archive, how projects end.
- [Communication](design/communication.md) — how workers and Obeya exchange messages: a worker's
  tools, turns that end without a handover, pausing an agent or a canvas's agents, snoozing a card, waiting without
  blocking, refused and confirmed tool calls, notes and replies, questions go to the owner.
- [Conversation on the card](design/conversation-on-the-card.md) — what the owner sees and does in
  a card's conversation: messages, reading order, replying to a message, the task as first message,
  card layout (the files beside the demo, trying the app by hand), screenshots and marking them,
  other files by their path, skills by `/`.
- [The canvas](design/the-canvas.md) — the UI around the cards: the bar, creating cards, cards on
  the canvas (a project arranged by its dependencies), moving around, unfolding a card, sheets,
  visual identity, groups on the canvas, refusals.
- [Agents and workspaces](design/agents-and-workspaces.md) — how agents run and where: agents,
  models and effort, workspaces (slots, the pool in the bar), folders without git, parking, hosts
  (running there, logins and files, a dropped connection).
- [Landing](design/landing.md) — how approved work reaches `main`: how work lands, the PR loop
  (watching the PR, ready to merge, the PR on the card), review cards for a contributor's pull
  request, after landing (restarts for landed code,
  finishing, questions after the work).
- [The Koordinator](design/the-koordinator.md) — the per-canvas agent the UI calls Obeya:
  scheduling and the queue, learning the owner's rules (Rückschau, rules for a CLAUDE.md), its
  sheet, Arbeitsrückschau, looked-up questions and threads, Question cards, its memory, wishes for
  Obeya's makers.
- [Voice](design/voice.md) — voice in (dictating or sending, drafts, the microphone), speech
  recognition (Parakeet, Whisper, a cloud service, the settings), who hears the words, commands to
  the Koordinator with confirmation and undo, voice latency, no voice out.
- [Demos](design/demos.md) — making and showing demos: the demo skill, the demo settings and
  voices, what a render needs, recording a demo (cutting waits, re-voicing, frames, highlights),
  the demo on the card (watching it, comments in the video, earlier demos), UI checks in a
  headless browser.
- [Sharing demos](design/sharing-demos.md) — demos on a page of their own for colleagues: where a
  demo goes, tags, several versions on one page, publishing (on approval too), outdated pages, the page
  and the pull request, export without a site, a repository's theme, static sites, several machines on one site.
- [Repositories and configuration](design/repositories-and-configuration.md) — canvases and
  repositories, main branch, Lesestand, plan docs (and how Obeya reads them), repository settings
  (`.obeya/settings.json`, problems, trusting commands, writing them), the Konfiguration dialog,
  live configuration, language.
- [Running Obeya](design/running-obeya.md) — the server (who may talk to it, other devices, the
  phone view, notifications on the phone, stalls), setup assistant, setting up git in a folder,
  self-update (waiting for workers and the owner, pulling from the upstream), stopping.
- [Distribution](design/distribution.md) — how Obeya gets to people: one file, the app, builds
  (signing, making a release), app updates, the site, the hero video.
- [Data](design/data.md) — what Obeya stores in SQLite and under `~/.obeya/`, and what it derives.
- [Open questions](#open-questions) — below.

## Goal

A spatial workspace for directing AI coding agents the way an engineering director directs a team:
every task and every project is a card on one canvas; agents do the work in the background; the
human keeps every essential decision — made by voice, from a narrated demo video, without reading
code or cycling through terminals.

*Obeya* is Japanese for "big room": in lean management, the room where every project hangs visibly
on the walls and decisions are made in front of the wall.

## Principles

- **One surface.** Everything starts on the canvas. Detail unfolds in place, animated, and folds
  back; nothing opens a new window, and the view never jumps.
- **Space is memory.** A card keeps the position its owner gave it and a fixed, readable size. A
  screen too small for everything shows a section of the canvas, never shrunken cards.
- **Decisions, not supervision.** The owner is pulled in only for a decision: a demo to approve, a
  question only they can answer, a proposal. Everything else runs.
- **Every change gets a demo.** Its length follows the size of the change, not its kind: a small one
  30–60 s, a larger one 1½–3 min, never padded; projects one demo per workstream. Backend behaviour
  is shown through the app's own inspection views; "covered by tests" is no reason to leave it out.
  What is to be looked at rather than watched (drafts side by side, a layout, an analysis, an
  answer) is an HTML artifact instead of a video; the worker picks, the video where either would
  do. There is no handover without one.
- **Voice first, mouse welcome.** Push-to-talk in Obeya's window; buttons for the obvious actions. No live
  transcript: what the owner says to an open card's agent shows in its conversation, a command to
  Obeya gets a short written confirmation with undo. What was said and answered stays in the
  conversation of the open card, or in the Koordinator's sheet. Obeya does not speak.
- **Repo-agnostic core.** Project specifics live in the repository's settings: in the repository
  itself (`.obeya/settings.json`), or set for this machine in the configuration.

## Concepts

- **Canvas** — a canvas spans one or more repositories; one Obeya serves several canvases.
- **Cards** — everything on the canvas is a card: a task, an idea, a prototype, a Question card (a
  thread of looked-up answers, see Looked-up threads), or a project, a container backed by a plan doc
  whose workstreams are its child cards. Tasks have no further kind: fixing a bug or adding
  something is worked on the same way, so the owner picks none and a task's card names none; the
  other cards say what they are (idea, prototype, workstream number, project). The UI and the
  Koordinator call a task *Aufgabe* and a follow-up *Folgeaufgabe*, never *Karte*; *Karte* is only a
  card on the canvas as such (moving, grouping, „Karte oder Projekt schließen“).
- **Groups** — besides by place, the owner sorts the canvas by group: a group has a name and a
  colour, and a card belongs to none or one; a project belongs as a whole, with its workstreams. A
  proposal, a follow-up and a prototype come into the group of the card they come from, a project
  written from an idea or a task into that card's; after that the group is the card's own. Moving a
  card never changes its group: in another group's territory it stands as an island. A group exists
  while a card belongs to it, on the canvas or in the archive; the last card leaving it ends it, and
  so does deleting it, which takes all its cards out (see Groups on the canvas).
- **States** — `idea` → `planned` → `working` → `waiting` (demo ready | question) → `approved` → `in
  PR` → `live`, or `done` when the work changed no code; an agent's `proposal` is started when
  accepted. Every handover brings a demo; where the repository has no recipe for running its app
  (Obeya's defaults have none), the worker finds that out from the repository. `waiting: review`
  (a handover without a demo) occurs only on old cards (see Demos, Decisions). An idea is `open`,
  `parked` or `dropped`.
- **Agents**
  - *Worker*, one per card while it is worked on: implementation, local reviews, demo.
  - *Project agent*, one per project, long-lived: knows the plan doc and the history of every
    workstream; the owner asks it in the project's sheet, or asks Obeya, which passes the question on.
  - *Exploration agent*, one per idea, long-lived, with a worker's tools: discusses the idea with
    the owner and keeps its brief.
  - *Koordinator* (Chief of Staff), one per canvas: takes voice input on the open canvas, creates
    and assigns cards, runs the workspace pool, keeps the preference memory, and schedules the work
    so that cards likely to conflict on merge are queued rather than run together (see Scheduling).
    The UI calls it *Obeya* in both languages: its replies, its sheet, the line under the microphone
    and its log lines on cards; its button at the top right is a speech-bubble icon with its counts,
    tooltip „Obeya (C)“. Prompts tell the agents the owner knows it as Obeya.
- **Preference memory** — rules distilled from the owner's answers and corrections ("questions to me
  with at most three options", "solve rebase conflicts yourself") or said outright ("Merk dir: …"),
  shared by all agents and kept by the Koordinator. A learned rule is a proposal until the owner
  accepts it; one said or written outright is active at once. It holds only rules about how agents
  work with the owner through Obeya; whatever is about a repository, its taste in code included,
  goes into that repository's CLAUDE.md through a card (see Learning the owner's rules).

### Decisions

- **Name**: Obeya.
- **The Koordinator is called Obeya in the UI** (2026-10-09): the owner has one counterpart, not a
  product plus a component in it.
- **Persistent local store**, not ephemeral.
- **Agents may propose cards.**
- **Open source** under the MIT licence, copyright Daniel Sadilek, in a public repository on GitHub
  (2026-10-06). Code, tests and docs name no other work projects. The README is written for
  strangers: the idea, a loop of the canvas at work, the site's screenshots of the canvas and the
  phone view (taken again at every release, so the README has no picture of its own that could go
  stale), the status, requirements, a quick start, how to connect a phone, a link to obeya.si, and
  near the end one sentence welcoming issues and pull requests, without asking for a star, which
  reads as needy. GitHub plays a video in a README only when uploaded through its web page (a
  `user-attachments` link no API makes), and a release asset shows as a download; so the loop is a
  GIF cut from the hero video (see Hero video), linked to the video on obeya.si (`#film`), which is
  always the current one (2026-10-19). Rejected: the video's first frame with a play button drawn on
  it, which beside the loop would show two near-identical canvases. `CONTRIBUTING.md` says how Obeya
  is built with Obeya (design doc, plan docs, cards, demos) and what a pull request from outside
  brings.
- **The repository on GitHub is made to be found** (2026-10-19): its homepage is obeya.si; its
  topics are a dozen that people search for and that have active topic pages (`claude-code`,
  `ai-agents`, `coding-agents`, `infinite-canvas` and the like; not `spatial-canvas`, with 15
  repositories). Its social preview (the wordmark and the site's headline beside the screenshot of
  the canvas) is made by `bun scripts/social-preview.ts`; GitHub's API cannot set it, so the owner
  uploads it when the canvas has changed enough.
- **Agents run only through the user's own installation of Claude Code and its login**: Obeya starts
  that installation and never uses the subscription's token itself. Tools that used the token
  against the API themselves were blocked; tools that start the official installation appear to be
  tolerated (T3 Code, Conductor).
- **No business and no cloud service for now** (2026-10-06): being known comes first. Considered and
  parked: hosting demos for sharing, remote access from the phone through a relay, voice as a
  service, a team canvas, a subscription covering the costs. Hosted agents were ruled out.

## Open questions

- Plan-doc sync: Obeya reads plan docs and never writes them; workers tick off their workstream in
  the doc as part of their change. Should the project agent keep the doc's progress instead?
- Cloud hosts, left out for now (2026-10-10): a host type whose slots are cloud instances, one per
  card (an EC2 `m8g.xlarge`, say, in the using repository's cloud account), launched from a prepared
  image when the other machines are full, stopped some minutes after the card's last turn (disk
  kept), started again on the owner's next message, terminated once the work has landed, with a cap
  on concurrent instances; image, network and IAM in the using repository's infrastructure.
  Estimated from the measurement under Agents and workspaces, Decisions: about $25 a month with the
  Mac alone at that load, nearly nothing with a second machine, $190–290 a month on demand at 36
  agents. Worth it only if parking and SSH hosts leave the owner short of slots. Reaching them, and
  a second machine away from home, would need more than plain SSH on the home network (Tailscale,
  say).
