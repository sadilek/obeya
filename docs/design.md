# Obeya — design

How Obeya works and why: what it does for the owner, how it is built, and the decisions behind it.
It describes what is built and is kept current in the same change. Work in progress is planned in
plan docs under `docs/plan/`, which Obeya shows as projects; when one is done, what lasts moves here
and the plan doc goes.

How this document is written:

- Each chapter first says how its part of Obeya works now, in the present tense, then lists its
  **decisions**: what was chosen, why, what was rejected, and what it replaced, with the date. A
  change that replaces behaviour adds the old behaviour and the reason for the change there, not
  into the description.
- UI texts are quoted in German as the owner sees them („Freigeben“); code, files, settings and API
  paths are in backticks, with the file where it helps to find them.
- A chapter refers to another by its heading (see Landing).

Contents:

- [Goal](#goal)
- [Principles](#principles)
- [Concepts](#concepts)
- [Ideas](#ideas) — starting an idea, the discussion, the brief, prototypes, deciding, while the
  agent replies
- [Card lifecycle](#card-lifecycle) — proposals, at work, waiting for approval, approval and
  landing, live and done, archive, projects end
- [Communication](#communication) — a worker's tools, turns that end without a handover, pausing an
  agent, snoozing a card, waiting without blocking, refused and confirmed tool calls, notes and replies, the
  conversation, reading order, replying to a message, the task as first message, card layout,
  screenshots, marking screenshots, questions go to the owner
- [The canvas](#the-canvas) — the bar, creating cards, cards on the canvas, moving around, unfolding
  a card, sheets, visual identity, groups on the canvas, refusals
- [Agents and workspaces](#agents-and-workspaces) — agents, models and effort, workspaces, folders
  without git, parking, hosts
- [Landing](#landing) — how work lands, PR loop, after landing
- [The Koordinator](#the-koordinator) — scheduling, learning the owner's rules, the Koordinator's
  sheet, Arbeitsrückschau, looked-up questions, looked-up threads, Koordinator memory, wishes for
  Obeya's makers
- [Voice](#voice) — voice in, speech recognition, who hears the words, commands to the Koordinator,
  voice latency, no voice out, push-to-talk anywhere
- [Demos](#demos) — the demo skill, the demo settings and voices, what a render needs, recording a
  demo, the demo on the card, sharing a demo, UI checks
- [Repositories and configuration](#repositories-and-configuration) — canvases and repositories,
  main branch, Lesestand, plan docs, repository settings, the Konfiguration dialog, live
  configuration, language
- [Running Obeya](#running-obeya) — server, setup assistant, setting up git in a folder,
  self-update, pulling from the upstream, stopping
- [Distribution](#distribution) — one file, app, builds, app updates, site, hero video
- [Data](#data)
- [Open questions](#open-questions)

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
  What is to be looked at rather than watched (logo drafts, a layout, variants side by side, an
  analysis, an answer) is shown as an HTML artifact instead of a video; the worker picks which, the
  video where either would do. There is no handover without one.
- **Voice first, mouse welcome.** Push-to-talk anywhere; buttons for the obvious actions. No live
  transcript: what the owner says to an open card's agent shows in its conversation, a command to
  Obeya gets a short written confirmation with undo. What was said and answered stays in the
  conversation of the open card, or in the Koordinator's sheet. Obeya does not speak.
- **Repo-agnostic core.** Project specifics live in the repository's settings: in the repository
  itself (`.obeya/settings.json`), or set for this machine in the configuration.

## Concepts

- **Canvas** — a canvas spans one or more repositories; one Obeya serves several canvases.
- **Cards** — everything on the canvas is a card: a task (`task`; in the UI an *Aufgabe*), an idea,
  a prototype, a Question card (`question`, a thread of looked-up answers, see Looked-up threads),
  or a `project`, a container backed by a plan doc whose workstreams are its child cards. Tasks have
  no further kind: whether one fixes a bug or adds something makes no difference to how it is worked
  on, so the owner does not pick one. A task's card names no kind either (that it is one shows); the
  others say what they are (idea, prototype, workstream number, project). A task is an *Aufgabe* and
  a follow-up a *Folgeaufgabe* in the UI and the Koordinator's words, never a *Karte*; *Karte* stays
  only for a card on the canvas as such (moving, grouping, „Karte oder Projekt schließen“).
- **Groups** — besides by place, the owner sorts the canvas by group: a group has a name and a
  colour, and a card belongs to none or one. A project belongs to one as a whole, with its
  workstreams. A proposal, a follow-up and a prototype come into the group of the card they come
  from, a project written from an idea or a task into that card's; after that the group is the
  card's own. Moving a card never changes its group: a card in another group's territory stands
  there as an island. A group exists while a card belongs to it, on the canvas or in the archive;
  the last card leaving it ends it, and so does deleting it, which takes all its cards out.
- **States** — `idea` → `planned` → `working` → `waiting` (demo ready | question) → `approved` → `in
  PR` → `live`, or `done` when the work changed no code; an agent's `proposal` is started when
  accepted. Every handover brings a demo; where the repository has no recipe for running its app
  (Obeya's defaults have none), the worker finds that out from the repository. `waiting: review`,
  a handover with a written summary alone, is left only on cards from before 2026-10-15 (see the
  decisions under Demos). An idea is `open`, `parked` or `dropped`.
- **Agents**
  - *Worker*, one per card while it is worked on: implementation, local reviews, demo.
  - *Project agent*, one per project, long-lived: knows the plan doc and the history of every
    workstream.
  - *Exploration agent*, one per idea, long-lived, with a worker's tools: discusses the idea with
    the owner and keeps its brief.
  - *Chief of Staff* (in the code and these docs: *Koordinator*), one per canvas: takes voice input
    on the open canvas, creates and assigns cards, runs the workspace pool, and keeps the preference
    memory. It also schedules the work: it detects cards whose changes are likely to conflict on
    merge, and does not run those at the same time but queues them. The UI calls it simply *Obeya*
    in both languages: the owner has one counterpart, not a product plus a component in it. Its
    replies, its sheet, the line under the microphone and its log lines on cards say Obeya; the
    top-right button is a speech-bubble icon with its counts, tooltip „Obeya (C)“. Prompts tell the
    agents the owner knows it as Obeya.
- **Preference memory** — rules distilled from every answer and correction the owner gives
  ("questions to me with at most three options", "solve rebase conflicts yourself"), or said
  outright ("Merk dir: …"). Shared by all agents, maintained by the Chief of Staff. A learned rule,
  or a learned change to a rule, is a proposal until the owner accepts it; agents follow active
  rules only. A rule the owner writes or says outright is active at once. Besides each input on its
  own, the Rückschau looks back over the last twenty or so for patterns across cards. It holds only
  rules at the level of Obeya: how the agents work with the owner through Obeya, whatever the
  repository. Whatever is about a repository (its conventions, product requirements, tools, and
  taste in code even when it holds in every repository) belongs in that repository's CLAUDE.md,
  where it is versioned, colleagues see it and Claude Code follows it outside Obeya too. Such a rule
  goes there through a card (see Learning the owner's rules): once accepted when learned, at once
  when the owner writes or says it outright.

### Decisions

- **Name**: Obeya.
- **The Koordinator is called Obeya in the UI** (2026-10-09): the owner has one counterpart, not a
  product plus a component in it.
- **This page describes what is built**; work in progress lives in plan docs, which the canvas shows
  as projects. The milestone list it once kept repeated what the canvas shows and went (2026-10-01).
- **Persistent local store**, not ephemeral.
- **Agents may propose cards.**
- **Open source** under the MIT licence, copyright Daniel Sadilek (`LICENSE`, the README,
  `package.json`), in a public repository on GitHub (2026-10-06). Code, tests and docs name no other
  work projects. The README is written for strangers: the idea, a loop of the canvas at work linked to the hero video, the site's screenshots of
  the canvas and of the phone view (`site/img/canvas.png`, `phone.png`, `phone-demo.png`, taken
  again at every release, so the README shows no picture of its own that could go stale; until
  2026-10-17 it had `docs/images/canvas.png`, taken once), the status, requirements, a quick start,
  how to connect a phone, a link to obeya.si. GitHub plays a video in a README only when it was uploaded through its web page (a
  `user-attachments` link, which no API makes and every re-render would have to replace); a link to
  the release asset shows as a download. So the README plays a GIF of the canvas at work (a wall
  arranged, a task said that appears as a card), cut from the hero video (see Hero video), linked to
  the video on obeya.si (`#film`), which is always the current one; near the end one sentence welcomes
  issues and pull requests, without asking for a star, which read as needy (2026-10-19). Until then it showed the video's first frame with
  the site's play button drawn on it (2026-10-12); a loop above that picture would have shown two
  near-identical canvases in a row, so the loop took its place. `CONTRIBUTING.md` says how Obeya
  is built with Obeya (design doc, plan docs, cards, demos) and what a pull request from outside
  brings.
- **The repository on GitHub is made to be found** (2026-10-19): its homepage is obeya.si, and its
  topics are a dozen that people search for and that have active topic pages (`claude-code`,
  `ai-agents`, `coding-agents`, `agent-orchestration`, `developer-tools`, `git-worktree`,
  `voice-control`, `infinite-canvas` and the like; `spatial-canvas` had 15 repositories and was left
  out). Its social preview, the picture a shared link shows, is the wordmark and the site's
  headline beside the site's screenshot of the canvas, 1280×640, made by
  `bun scripts/social-preview.ts`; GitHub's API cannot set it, so the owner uploads it (Settings →
  General → Social preview) when the canvas has changed enough to need it.
- **Agents run only through the user's own installation of Claude Code and its login**: Obeya starts
  that installation and never uses the subscription's token itself. Tools that used the token
  against the API themselves were blocked; tools that start the official installation appear to be
  tolerated (T3 Code, Conductor).
- **No business and no cloud service for now**: being known comes first (2026-10-06). Considered and
  parked: hosting demos for sharing, remote access from the phone through a relay, voice as a
  service, a team canvas, and a subscription covering the costs. Hosted agents were ruled out.

## Ideas

An idea is thought through on its card before anything is planned; no worker runs.

### Starting an idea

"Ich will über Export für Vermieter nachdenken" (voice or typed), or "Als Idee besprechen" on a
planned card of the owner's that nobody has worked on, makes a card in state `idea`, and its
exploration agent opens the discussion right away: with what the owner said, or with what the card
says, which stays at the top of the conversation as its starting point ("Ausgangspunkt").

Such a planned task offers its ways on in one row: "Agent starten", "Als Idee besprechen" and "Als
Projekt planen", each with a tooltip saying what follows the click, and "Löschen" set apart at the
right end, as in every button row with it. "Als Projekt planen" does on the task what it does on an
idea (see Deciding): a worker writes a plan doc from the task's title, text and screenshots on the
task's card („Aufgabe → Projekt“), the decision log says so, and once the doc has landed the project
takes the task's place, the task going to the archive (by voice: `plan_doc`, „plane das als
Projekt“). The mark that a card becomes a project is a column of its own (`becomes_project`), not
part of the idea's JSON. A card that was being cut into packages by the former "Aufteilen" when
Obeya stopped is planned again.

### The discussion

The unfolded idea is a conversation with its exploration agent: a session on the repository's
Lesestand (code, plan docs, the decision log, the preferences) resumed for every message, days later
too. Should that session be gone (Claude prunes old ones, after weeks), a new one starts with where
the idea stands: the brief, the titles of its mocks, the prototypes planned, the latest six of those
built (running or ended, with their summaries), the part marked to split off and the latest twenty
messages of the conversation, in the order the agent read them, so it goes on from there instead of
writing the brief afresh (until 2026-10-20 it heard only the card's title and text). An idea its agent
has not taken up yet (a new one, a Question card just turned into one) starts without it. It has a worker's tools in the workers' permission mode, so what the discussion depends on
beyond the text (the git history, file dates, a release or CI run with gh, the web) it checks
instead of guessing. What it does itself starts no work. It asks back, shows variants with their
trade-offs and says what they would cost.

Its questions come with answer options, shown under its reply as radio buttons, or checkboxes when
several fit together; the owner picks, may add their own words, and both go out as one message that
names each question. The questions stand in the conversation as the agent's messages, like a worker's;
while they wait for the owner they stand at its end, where they are answered, and once answered (or
while the agent works on a reply, which may settle them) they stay where they were asked, the options picked ticked on them, the alternatives beside, and the owner's
message under them holds only their own words (until 2026-10-20 an answered question stood only as a
bold line of the owner's message, without the alternatives). The owner types in the panel or holds Space with the idea open; both go
straight to the agent, as on every card an agent listens on (see Voice in), spoken words as soon as
the speech recognition has written them down (picked options too, with the words beside them). The
agent passes on with `to_obeya` what asks Obeya for something (build it, plan it, a prototype, park,
drop, anything about another card). The reply stands in the panel. What the agent read and thought
on the way to a reply folds away under that reply ("Verlauf"), for whoever wants to follow it. A turn
that ends while the agent's background work runs (a download, a watcher) does not hand the idea to
the owner: it shows the agent at work, with its words so far (a reply that it waits for the work
among them), until that work wakes it and it goes on, and what the owner says meanwhile goes to it at
once. Should the work never wake it, its last words are the reply after all, with the same limits as
for a worker (three hours while it runs, ten minutes after it ended).

With every reply the agent also says what it would do in the owner's place: the option it would pick
for each of its questions ("Würde ich nehmen", with why), and the next step ("Nächster Schritt, wenn
der Agent entscheiden müsste": answer first, build, split off a task, plan, prototype, park or
drop, with why). The card marks that click (the suggested button instead of "So bauen", the picked
options), and the canvas card says it short ("Tipp: Prototyp"); the owner follows or overrules it,
and the suggestion goes with their next message. Each suggestion is a button on the card: answering
needs questions to answer, splitting off a task a task marked for it, and a suggestion without them
is none. The agent's instructions say what each step does to the rest of the idea (building ends the
conversation and drops its prototypes, planned and running; splitting off a task keeps the idea, its
conversation and its prototypes; planning keeps the prototypes for the workstream that builds on
them), so it does not recommend a click for what the click does not do.
The voice Koordinator reads it too, so "mach, was du vorschlägst" takes that step (said to the
Koordinator, or to the agent, which passes it on).

Once the agent has replied, the open idea needs the owner like a waiting card ("Idee · du bist
dran", badge, counted in "brauchen dich") until they answer, park, drop or decide it.

### The brief

The agent keeps the brief ("Stand der Idee") on top of the card: goal, open and dropped variants,
decisions, open questions, effort. The conversation is the means, the brief the result: whoever
opens the card later reads the brief. The two stand side by side and never say the same: findings,
variants and questions go into the brief, and a reply only carries the turn (what changed in the
brief, which open question is next).

A variant that is something to look at (a layout, a dialog) comes with a mock: a few lines of HTML
the agent passes with the brief (`update_brief`'s `mocks`, one per variant, with its title; left
out, the mocks stay) or, for something the brief has no place for, with its reply. The card shows
each in the frame of a worker's HTML artifact (sandboxed, scripts in an origin of their own, nothing
loaded from the internet; see The demo on the card), sized
to its content, the brief's side by side under it. A worker who builds the idea or a prototype of it
gets the brief's mocks as HTML after the brief.

### Prototypes

A prototype ("Prototyp bauen lassen"), when talking is not enough: a worker builds a throwaway one
in its own workspace, on a card of its own below the idea, and records a demo. Several may run side
by side, one per approach; each carries its approach in its title ("Prototyp: Logo – Wortmarke", the
first words of what the owner asked it to show).

When the brief plans prototypes of several variants, the agent also passes them to Obeya
(`plan_prototypes`: per variant a few words and what its prototype shows); "Prototyp bauen lassen"
then offers them as checkboxes, each chosen unless its prototype runs already, beside a field for an
approach of the owner's own, and starts one worker per variant at once, its title the variant's
words and its task that variant only. Spoken without words, it starts the planned variants that have
none running; without planned variants, an empty field is the idea as it stands.

The idea shows the demos of all its prototypes, each under its title, and its exploration agent
hears what each found. While one is built, the idea no longer needs the owner; the agent's reply to
the result of the last one built makes it their turn again. A reply meanwhile (to something the
owner said, to an earlier prototype's result) gives them the turn only when it asks them something:
otherwise they still wait for the prototypes, and a prototype that has handed over needs them on its
own card. A prototype's worker asks on its own card, and the questions
with the owner's answers also go to the exploration agent, which takes them into the brief without
replying, so the idea does not ask them again. It makes no cards: instead of `propose_card` it has
`propose_build`, a proposal on its card to build the idea on it.

A prototype never lands itself and does not count for collisions. It ends in one of two ways, and
either way its card goes into the archive with log, demo and summary ("Prototyp · verworfen" or
"Prototyp · gebaut"), never to come back: a new attempt is a new prototype. "Verwerfen" (also
approving or deleting it) throws its workspace and branch away, whatever its state; "Diesen Prototyp
bauen" (or accepting its worker's proposal) builds the idea on it, see Deciding.

### Deciding

"So bauen" makes the brief the card's task and starts it at once, through the Koordinator like
"Agent starten" (it waits only if it would likely conflict with running work).

"Diesen Prototyp bauen", on a prototype, does the same on that prototype's branch: its workspace and
branch (renamed for the idea) become the idea's, whose worker hears that the branch holds a
throwaway prototype, to take over what carries and bring it to production quality (tests, checks,
docs, shortcuts removed), with the prototype's handover and the owner's answers on it. The decision
log says "So bauen, auf Prototyp „…“". Either way the idea's other prototypes are discarded, so one
card remains.

"Als Projekt planen" starts a worker on the idea's card the same way, which keeps its title and
shows as "Idee → Projekt": it writes a plan doc with workstreams, which lands like any change (a PR,
say). The project then takes the idea's place on the canvas (cards it would cover move aside, by as
much as it outgrows the idea) and links back to it; the idea goes to the archive once its worker is
done (put back, it stays). The idea's prototypes stay on the canvas, each still naming its idea, and
the plan doc's worker hears what each showed (its handover, or that it is still being built), so the
doc builds on them instead of planning them again; only the workstream that builds on the chosen
prototype mentions prototypes. While the doc is written, "Diesen Prototyp bauen" waits for the
project; once it stands, the button builds that workstream (the one nobody has started that mentions
prototypes; the owner picks another, or picks one where the doc names none or several), and it is
built on the prototype's branch as an idea would be ("Auf Prototyp „…“" in the project's decisions),
its worker told to take the workstream from the plan doc; the idea's other prototypes are discarded.

"Teilaufgabe abtrennen" ("Split off a task"), when part of the idea is settled and part still open
(the game logic of an app settled, its pictures still to be prototyped): the agent marks the settled
part (`plan_split`: its title and a brief that stands on its own as a worker's task, the whole value
each time, empty when there is none any more), and only then does the button show, next to "So
bauen", with that task folded under the brief ("Teilaufgabe zum Abtrennen: „…“"). The click makes
that part a task of its own beside the idea, in its group and linked to it, with the screenshots the
owner showed in the discussion and a line after it saying it is the settled part of the idea and the
open part is not its, and starts it through the Koordinator like "So bauen" (by voice: `split_off`).
The decision log records it on the idea ("Teilaufgabe abtrennen: „…“"). The idea stays open with its
conversation, its agent and its prototypes, planned and running; the split is cleared, and the agent hears that the part is now that task, trims
the brief to what is open and replies. "So bauen", "Diesen Prototyp bauen" and "Als Projekt planen"
work on the idea later as before. It is not a second way to break work up beside the plan doc: it
only separates what is settled from what is open, always into one task and the remaining idea.

"Parken" and "Verwerfen" leave the card with its brief; talking to it opens it again. A parked or
dropped idea can be archived ("Archivieren" in it or its archive button on the canvas, as on a finished card; not
while a prototype of it is on the canvas, and then the button is not shown): in the archive it shows
its brief and conversation read-only and can go back to its place, where talking to it opens it
again. Decisions from the conversation go into the decision log; lasting preferences are learned by
the Koordinator as before.

### While the agent replies

While the agent works on a reply, planning waits (so do "Teilaufgabe abtrennen" and "Diesen
Prototyp bauen"): the buttons are disabled with "Antwort kommt gleich", and the server refuses them
(`ideaThinking`). The reply almost
always rewrites the brief, so a plan taken before it would start from a brief the owner never read.

"So bauen" does not wait: clicked during a reply, the idea is built once the agent has answered all
it was told, with the brief it leaves, unless its reply asks questions; then nothing is built, the
conversation says why, and the owner decides again. The panel stays open while it waits: the button
reads "Baut nach der Antwort …" with "Doch nicht bauen" beside it, and the canvas card says "baut
nach der Antwort". The agent hears of the click with its next step, as the brief it leaves becomes
the task. A turn that ends without a reply (an error, a restart), parking or dropping call the
building off too.

Asked to plan such an idea, or to build its settled part (`split_off`), while its agent works on
a reply (by the agent, which passes the owner's words on, or in the Koordinator's sheet along with
talk to the idea), the Koordinator says that it goes by a click once the reply is there; asked to build it ("nimm noch X auf und bau es
dann"), it builds after the reply, like the click.

Parking and dropping act at once and end the turn, but lose nothing: the messages the agent has not
answered (the one it worked on and those queued behind it) stay with the idea (`unread`, across
restarts) and go to it first, with why its turn ended, when the conversation goes on. The same holds
for a turn that ended with an error, and for messages queued when Obeya stopped.

### Decisions

- **A discussion lives on a card, not in the conversation with the Koordinator**: an exploration
  parked on the canvas is found there again with its brief, and the Koordinator only passes the
  owner's words on. A question to Obeya that asks for an opinion or a way forward („Was meinst du,
  was wir da jetzt machen sollen?“, „Wie sollten wir … angehen?“) becomes an idea card at once, with
  the owner's words and screenshots, and its exploration agent opens the discussion, when no agent
  on the open card takes it (2026-10-09): a wrong guess costs one card, taken back with
  „Rückgängig“. Questions of fact and look-ups stay in the conversation.
- **A big idea becomes a project through a worker writing its plan doc**, not through the
  exploration agent, which discusses and does not build. That worker runs on the idea's own card and
  starts with the decision, and the project replaces the idea on the canvas (2026-10-02): a separate
  planned "Plan-Doc" card in between had to be started by hand and left the idea standing next to
  its project.
- **One way to break work up: the plan doc** (2026-10-12). Until then a planned task's row read
  "Agent starten · Aufteilen · Erst besprechen · Löschen", which said little about what follows, and
  "Aufteilen" had the Koordinator cut the card into 2–6 packages that replaced it. Aufteilen went:
  it was a second way to break work up beside the plan doc, and "Alle starten" on a project already
  plans which workstreams run in parallel.
- **The exploration agent has a worker's tools** (2026-10-12): until then it was read-only (Read,
  Grep, Glob) and answered from the text what it could have checked.
- **Prototypes stay cards of their own, and several may run for one idea** (2026-10-02): parallel
  approaches are to be seen side by side, not hidden inside the idea. The one that convinces is not
  thrown away and rebuilt from `main`: the idea is built on its branch, so its commits go into the
  branch's history, and the worker's brief has to keep prototype quality from landing as it is. A
  discarded prototype keeps its demo, log and summary in the archive but not its code.
- **Planned variants become one prototype each** (2026-10-05): three clicks with an empty field had
  started three prototypes of the same brief, which planned three variants.
- **Planning an idea takes its prototypes along** (2026-10-06): before, planning left the prototypes
  behind unmentioned: the plan doc planned them again as workstreams, and once the idea was
  archived, building on one failed with a 400.
- **"Teilaufgabe abtrennen" builds the settled part and keeps the idea** (2026-10-18). An idea's
  agent had
  recommended "So bauen" with "start the two picture prototypes alongside it", which no button did:
  building turned the idea into a task and dropped the planned prototypes without a word. Two other
  ways were weighed. Restricting the agent to the steps there were gave a correct but clumsy route
  (prototypes first, then a plan doc, the settled part waiting); one button for "build and start the
  prototypes" was dropped because building ends the idea the prototypes belong to. Since then every
  suggested step is a button, and the agent's instructions say what each does to the rest of the idea.
  It was first called "Fertiges bauen", which suggested the part was finished rather than settled.
- **"So bauen" does not wait for the agent's reply** (2026-10-06): the last answer of a session is
  often clear and simple, and the owner knows that building comes next.
- **Mocks in a field of their own** (2026-10-05): an idea's agent shows how a variant looks as a
  mock beside the brief and the reply, not as HTML in their Markdown: the agent writes no artifact
  files, the Markdown renderer stays without HTML, and the owner sees simple options without having
  a prototype built.
- **A project links the idea it came from** by what the idea's landed work added to the plan
  directory, not by title or time, and shows the decisions of both.

## Card lifecycle

A card is created by the owner (voice or canvas) or proposed by an agent, worked on by a worker,
handed over with a demo, approved, and lands; finished cards go to the archive.

### Proposals

The owner can edit a proposal, and accepting it starts it (it goes to the Koordinator like a started
`planned` card) unless they only accept it as `planned`. A worker writes a proposal's text for the
agent that will take the card on, as the owner would write a card: no "I" or "my question" of its
own, other cards named by their title. Apart from the text it says why, for the owner only (beside
"Vorgeschlagen vom Agenten der Aufgabe …"), and what the owner has to decide, as questions with
options. The owner may pick options on the proposal before taking it; accepting writes the questions
into the text, those with a pick under "Entschieden:", the others under "Offene Fragen:", so the new
worker reads what is settled and asks the rest.

A worker may also propose an idea, for something to think through first: it shows as "✦ Vorschlag ·
Idee", and "Übernehmen und besprechen" makes it an open idea whose exploration agent opens the
discussion with the text and its questions; "Als Aufgabe übernehmen" plans it as a task instead.
The other way round, „Als Idee besprechen“ on a proposed task makes it an open idea the same way,
whose agent hears that it was proposed to be built and the owner wants to think it through first;
said to the Koordinator („erst als Idee besprechen“), it is `accept` with `idea`.

#### A proposal its agent takes back

A worker takes back a proposal of its own that turned out wrong or needless with `withdraw_proposal`
(its title, why, and `replaced_by` when another of its proposals takes its place), or proposes the
better one with `propose_card`'s `replaces` naming the old title. Obeya finds the latest of the
card's proposals by that title (case, quotes and markdown aside) and answers the worker what became
of it; a title that matches none gets the list of its proposals back. A proposal still open goes
from the canvas at once, while it is reworked too; the proposing card's conversation says „Zieht den
Vorschlag „…“ zurück: …“ or „Ersetzt den Vorschlag „…“ durch „…““. It is kept deleted with the
mark, so the Rückschau does not read it as one the owner dismissed. One the owner has accepted
already (as a task or an idea, planned or at work) carries the mark (`Item.superseded`) until it is
finished: its canvas card reads „Ersetzt durch „…““ or „Vom Agenten zurückgezogen“, it needs the
owner (a push says so), and its panel says who replaced it by what and why, with „Entfernen“ (as
„Löschen“: its worker stops, with an undo) and „Behalten“ (the mark goes). Said to the Koordinator,
they are `dismiss` and `keep`. A finished card stays as it is.

#### Reworking a proposal by words

Instead of editing a proposal by hand, the owner may say (or type into its field „Was soll anders
werden?“) what should change. With the proposal open, the words go straight to a read-only agent
(`revisions.ts`, in the card's repository), as on a card with an agent, without the Koordinator or
an undo window („Agent · Vorschlag: …“ under the mic). It rewrites title, text, reason and questions
by those words, keeping what they did not touch; a question the words settle goes, and its decision
into the text. What the words ask of Obeya (accept or dismiss the proposal, a rule, another card) it
passes on with `to_obeya`; accepting passed on that way waits for the rework as the button does, and
words that only did that leave the proposal as it was. Said of a proposal that is not open, the
Koordinator reads the words as `revise`. What the words only ask („Was würdest du nehmen?“) the
reviser answers and leaves the proposal as it was there.

As with an idea, the conversation about it stands beside the proposal, its open questions at the end
of it and the field under it; a question stands where it was asked once it is settled (or while the
proposal is reworked), so the owner still sees what they answered; the proposal's text and reason
are on the left, its buttons below both. The text box is as tall as the text and the panel grows
with it up to the screen's height; only beyond that does the box scroll. Options picked there and
sent („Antworten“, with words or without) go to the reviser at once, without the Koordinator or an
undo window, and stand in the conversation as the owner's words; accepting instead takes the picks
into the text as above.

Meanwhile the proposal shows „wird überarbeitet“ (in the conversation, above the field), cannot be
edited or only accepted („Übernehmen“), and is not among the cards that need the owner. Words said
meanwhile wait, unread, for the rework after it, which takes them in together
(`Proposal.revising.next`). The owner's words stand in its conversation, then the reviser's reply
(its answer to what they asked, and what it changed), „Vorschlag überarbeitet.“ when the proposal
reads otherwise now, and the questions it asks anew. An agent that ends without a text leaves the
proposal as it was, with the error. A revision still running at a restart starts again.

„Übernehmen und starten“ (on a proposed idea „Übernehmen und besprechen“, on a proposed task also
„Als Idee besprechen“) does not wait, as "So bauen" on an idea does not: clicked during a revision, the proposal is accepted and started once the
new text is there, unless it still has questions; then it stays a proposal, and the conversation
says why, as it does when the reviser ends without a text. The panel stays open while it waits: the
button reads „Startet nach der Überarbeitung …“ with „Doch nicht übernehmen“ beside it, and the
canvas card says „danach übernommen“. The waiting button and its take-back are one component with an
idea's. Said by voice to the Koordinator while the proposal is reworked, accepting is still refused
(see Commands to the Koordinator).

### At work

`working`: the worker leases a workspace, implements, runs the checks the repository's settings name,
and records the demo.

### Waiting for approval

`waiting: demo`: the card carries the demo. The owner approves or gives feedback. Feedback, like
anything the owner writes or says on the card then, goes to the worker at once, and the work still
waits for approval: while the worker takes the words in, the card is at work („Agent arbeitet an
deiner Nachricht“, no badge, not counted as needing the owner), „Freigeben“ stays, and a change the
words call for comes as a new handover. A worker whose words asked Obeya for something instead (gib
frei, a follow-up) passes them on (`to_obeya`), and once its turn ends the card is the owner's
again. A turn that ends without a new demo (a reply, a handover that keeps the demo) leaves the card
reading „Agent hat geantwortet, wartet auf dich“ (`answered`) instead of „Demo bereit“, whether or
not the owner had watched the demo; a new demo reads „Demo bereit“ again. Only words for the owner
answer them: a reply, what the worker says, or Obeya's result of `to_obeya`; an answer to earlier
words does not count. A turn that ends without any (it broke off with an error, its session ended)
leaves the card at „Demo bereit“, and the conversation says the agent stopped without answering, so
the owner writes again. A worker that a background
command wakes after such a turn (a test run it said a new handover waits for) works on towards what
it told the owner: from its first step the card is at work again, as while it took the words in,
until its turn ends.

A card has one field for the owner's words with one Send (`ownerField` in `src/ui/talk.ts`): under
such a demo it takes the answer and feedback together. The words go to the worker as the answer (in
the decision log as such), and a change they also ask for comes as a new handover.

#### The handover report

The worker's summary is its handover in the card's conversation below, not repeated under the demo:
what changed for the user and what the owner needs to know, in a few short paragraphs at most. A
later handover says only what the one before and the worker's replies since have not said yet, often
a sentence: the owner has the rest in the conversation above it. Until 2026-10-15 the tool and the
worker's instructions called the summary the whole report, the one thing the owner reads at the end,
so a handover after feedback repeated the reply just before it nearly word for word. Until
2026-10-16 the reply told the worker its turn goes on („carry on with your work“) and the handover
tool asked for „what is new since your last handover and your replies after it“, so a worker that
answered a note on handed-over work and had nothing to change handed over again with the reply's
facts; now the reply alone ends such a turn. Whoever reads the card's report beyond its conversation (a follow-up's worker, the Koordinator, a
prototype's idea, a shared page's text) gets the whole of it, as the card's summary: the first
handover since the worker started, then „Danach im Gespräch:“ with its replies and later handovers
in order (`report` in `src/server/workers.ts`). A problem the worker noticed beyond the task is a proposal (`propose_card`), not
a line in the report. A follow-up's worker hears which card it comes from and that card's summary.

A question in the demo report is an open question like a worker's: the owner answers it on the card
or by voice, the worker hears the answer, and the demo keeps waiting for approval. While the worker
takes in the answer (it may rework the demo and hand over anew), the card is at work as after
feedback. Once its turn ends, a demo still waiting is the owner's again; a restart resumes that turn
like a working card's, also when the worker ended it to pause for the restart.

#### Watching the demo

The demo plays on its own the first time the card is opened (per browser; a new render counts as
new) in a page in sight, later it waits to be played, with a big play button over it like a shared
page's (also when the browser blocks the first play).

Z or the magnifier on the video zooms it out of the card to as large as the window allows above the
microphone, over the greyed page (`useZoom` in `src/ui/detail.tsx`): the same video element, so it
keeps playing, growing out of its place and back; Z again, Esc or a click beside it ends it, and the
card stays open. Hovering the magnifier shows the key beside it until the owner first zoomed with Z
(per browser).

Space tapped plays and pauses the video, so a demo that waits is started with it. The recording
starts with the press, so no word is cut off, but with a demo video open the microphone lights up
only once Space stays down for 200 ms (`SPACE_SHOWS_MS`), so a tap does not flicker it; without a
video Space has nothing to play, so the microphone lights up at once. ← and → jump 5 seconds back
and forward (`useSeekKeys`). The browser's controls keep every key to themselves once clicked, so
the video hands the focus back to the page at once. Not when the controls take it again within a
second (`MENU_FOCUS_MS`): their overflow menu (⋮) takes the focus as it opens, right after the
press on its button gave it to them, and closes when it loses it, so handing it back left the menu
dead. Without a mouse (a phone, a tablet: `pointer: fine` does not match) there are no keys, and the
video keeps the focus. A press or click on the controls never reaches the page, only the focus
does, which is why the menu is told apart by time. A click on the controls shows the arrow keys over them for a moment,
until the owner first jumped with them (per browser).

#### Comments at a place in the video

What the owner types or says while the video stands somewhere in the middle is about that place
(`src/ui/spot.ts`): Space (or the microphone) held while it plays pauses it, so the speech
recognition does not hear the narration, and the recording goes out with the place; letting go plays
it on, while a video the owner had paused stays where it is, as it does after words dictated into
the field. Typing in the field pauses it too; above the field stands the place like a quote (its
frame, „1:23 · chapter“, × to take it out), the placeholder says „Etwas zu 1:23 schreiben oder
Leertaste halten“, and Enter sends and plays on. „Hier kommentieren“ (its speech bubble drawn like
the magnifier) on the video beside the magnifier pauses it and puts the cursor into the field; both
show only while the mouse is over the video, so they do not cover the picture; the controls (`?`)
have a section for the video. At the start or the end, the words are about the work as a whole and
go out as before.

The browser draws the frame from the video (same origin) and uploads it as a screenshot; the server
adds the chapter and the sentence of the narration at that time (`placeIn` in `src/server/demo.ts`,
by its share of the scene's caption) and keeps the place on the event (`CardEvent.spot`). The
conversation shows the words with the frame and „▶ 1:23 · chapter“, a click plays the video from
there; it stays at its newest comment also once the frames have loaded (`useStickToEnd`, which the
Koordinator's sheet shares).

On a card waiting for approval, such comments do not go to the worker one by one: the conversation
shows each at once, with „N Kommentare gehen an den Agenten, sobald du fertig geschaut hast“ and
„Jetzt senden“ under the last, and Obeya holds them back (`held` on the card) until the owner has
finished watching: the owner sends them („Jetzt senden“, for an owner who watched the video already
and went back to one place, so need not sit through the rest), the video ends, the card closes, the
video stands for three minutes, the owner writes or says something without a place (it goes in the
same message, after them), or approves (the worker hears them with the approval, to propose as a
card what still matters). Ten minutes after the last one without such a sign (a browser gone away, a
restart) they go anyway. The release waits 1.5 s, so an approval clicked as the card folds takes
them; „Jetzt senden“ does not wait.

Until they go, each stands dashed with a bin in its corner: taking one back takes it out of the log
(`eventGone` to the pages), and the worker never hears it; its words go back into the card's field
if that is empty, as with a note not read yet (see Reading order); once sent, it can no longer go.
Held, they are unread (`CardEvent.unread`): they stand at the end, below whatever the worker does
meanwhile (it may still be taking in earlier words on the handover), and once sent they move to
where they went (`readAfter`).

The worker gets them in one message, each as `[Demo video at 1:23, chapter „…“, narration: „…“]`
above the words, with its frame as an image, and reworks the demo once instead of for each comment;
a comment is no answer to the demo report's question. On a card at work or finished, a comment with
a place goes at once, with its place and frame.

#### Earlier demos

A new demo replaces the one on the card, but the card keeps the one before (`CardRow.demos`, served
under `/api/cards/:id/demos/:n/`): a demo after feedback often shows only what changed. Once there
is one, plain text above the video, left of „Teilen“ in the same line, says which is shown
(„Neueste Demo 2 von 2 · 13:37“), with ‹ and › to step back and forth, and „Zur neuesten“ two or
more steps back; an earlier one's text is in colour („Frühere Demo 1 von 2“), so it is not taken
for the latest. Sharing is about the demo shown, an earlier one too (see Sharing a demo), and the
text of a demo on the shared page carries a small share icon. Until the owner's feedback on 2026-10-16 the line
was a bar of its own below sharing, coloured for an earlier demo. Stepping is no sign the owner has
finished watching (see above), and a new handover leaves them on the demo they look at. An earlier
demo whose directory a later one was rendered into, or whose files are gone (demos are deleted to
free space), is not offered.

A comment on a place keeps the demo it is in (`Spot.demo`, the handover it came with): a click on
it shows that demo and plays it from there, and words on a place in an earlier demo reach the
worker as about the earlier demo video, one a later handover of its replaced.

### Approval and landing

Where work lands through pull requests, the approve button reads "Freigeben (PR)", and approval
puts the card `in PR`: its worker opens the PR (until it reports one, the card reads „Freigegeben ·
Agent öffnet den PR“ with the worker's status line, not "in PR" without a link) and Obeya carries it through the merge, which it does itself (see
PR loop). Review comments, failed checks and conflicts go to the worker; only what needs judgement —
a review comment that questions a decision, a conflict with product meaning — comes back to the
owner as a question on the card, and the answer returns it to the PR. A PR closed without a merge
asks the owner whether to open it again or drop the work.

Where the repository's settings allow it (`direct`), the owner may instead approve with "Direkt auf main" beside
"Freigeben (PR)", or by voice ("gib frei ohne PR"): Obeya pushes the work onto the default branch
itself, without a pull request, review or the PR's CI, and the card is `live`. Where work lands on
`main` (Obeya), approval lands it at once.

A click on an approve button folds the card at once, without waiting for the server (a push onto
main takes seconds): until the answer, the card on the canvas says what is under way („wird direkt
auf main gepusht …“) and a message with a spinner stands above the microphone. The answer turns the
message into the confirmation, or, when the landing is refused, into the card's title and why, with
the card waiting for review again.

### Live and done

Merged (or landed on `main`) → `live`. The demo stays on the card. The worker hears that its work is
on main and may finish what was waiting for that (a data migration, say) before its session ends
(see After landing).

Work that changed nothing in the repository (the task wanted a demo, an analysis, an answer) has
nothing to land: approving it makes the card `done` ("Erledigt") without a pull request or a
landing, and its worker finishes the same way. The owner sees that before approving: when the
handover finds nothing on the branch (no commits, nothing uncommitted), the button reads "Beenden"
instead of "Freigeben", with a line that no pull request follows: there is nothing to release, only
the card to close. A worker whose approved work turns out to change nothing (its branch emptied
after the approval) closes the card itself with `close_unchanged`, which Obeya refuses while the
workspace holds commits or uncommitted changes.

A finished card (`live` or `done`) an agent worked on keeps its field for the owner's words once
that agent's session has ended: a question there („Nachfrage an den Agenten“) resumes the agent that
did the work (see After landing), which answers on the card and ends again.

### Archive

A card is archived when the owner takes the finished card off the canvas ("Archivieren" on the card
or its archive button on the canvas, shown while the pointer is on it, or all finished ones at once
in the archive), or when a prototype ends (discarded or built; see Prototypes). A task the owner
stopped („Gestoppt“: planned again, its branch still the card's) goes the same way, one at a time,
with its conversation, for the owner to come back to (a question an agent answered, say); „Neu
starten“ and „Löschen“ stand beside it. Not while it waits to start, and not while its workspace
holds work that has not landed (the button is greyed and says so): archiving would leave that work
unseen in a clone. A stopped card opens as a card an agent worked on, the task as its conversation's
first message.

The archive (button or `A`) lists archived cards under its button in the bar, as the queue does, by
day, the most recently archived first, as small cards on a timeline with the time they were
archived, each labelled with its kind or state („Idee → Projekt“, „Projekt“) unless it is a plain
task, nearly every entry, which goes without one; one unfolds from its card as on the canvas and can
go back to the place it had. An ended prototype cannot: it shows, read-only, how it ended, its demo
and conversation.

A search field over the list, with the cursor in it as the list opens, filters it as the owner
types: a card stays when it holds every word typed (case and accents aside) in its title, text,
summary, last status or label, a project also in its goal and workstreams; the words are marked in
the titles. The search stays while the list is closed, selected when it opens again, so typing
starts a new one and a card folds back into the list it was opened from. The list stays under the
dim while that card is open, so the card folds back into it; a click beside it or Esc closes it.

### Projects end

A project ends when every workstream in its plan doc is ticked on the default branch, or when the
doc goes (deleted): it moves into the archive with its workstreams, which are not listed on their
own. A workstream card still at work then (in progress, or its worker finishing after the landing)
keeps the project on the canvas, as its doc last stood if the doc is gone, until it is done: the
project goes into the archive once that worker is done, not at the landing. Opened from the archive, its sheet shows,
read-only, the goal and the workstreams as the doc last stood; each workstream unfolds with its
conversation and demo. When the same file comes back, or an open workstream is added to it, the
project returns to its place.

Every project's sheet, live or archived, lists its decisions and links the idea its plan doc was
written from: when an idea decided as a project („Idee → Projekt“) lands and its diff adds a doc in
the plan directory, the project from that doc remembers the idea, whose card keeps its brief and
conversation, and the idea's decisions join the project's. The project takes the idea's place, and
the idea, once its worker is done, goes to the archive. A task planned as a project („Aufgabe →
Projekt“) is linked the same way.

### Decisions

- **A proposal is written for the next worker, with its reason and questions apart.** Before, a
  proposal was the worker's reason and suggestion as one text, in the first person, with open
  questions buried in it; taken as it was, it went to the next worker as if the owner had written
  it.
- **A proposal the owner talks about is rewritten by an agent of its own**, not by its proposing
  worker or in the Koordinator's quick turn (2026-10-06): the worker may be gone or busy with its
  own card, and writing a whole card text would slow every confirmation down. Before, the owner
  could only type the changes into the proposal's text themselves.
- **On an open proposal, the owner's words go straight to its reviser**, which passes on what asks
  Obeya for something, as on any card with an agent (2026-10-14). Before, the Koordinator read them
  first, since they might accept or dismiss the proposal rather than change it: the reviser started
  only after the undo window, meanwhile the owner's words stood above the question they asked about,
  and on a task the same words would have gone straight to its agent.
- **The reviser replies, and a settled question stays where it was asked** (2026-10-14). Before, the
  reviser could not reply, and a question lived only at the end of the conversation: the owner who
  asked about it saw neither the question nor an answer once it was settled, only their own words.
  Before 2026-10-14 the field was gone during a rework, too.
- **Accepting a proposal does not wait for its rework** (2026-10-06: the owner who answered the last
  question knows that starting comes next). Before, the button was disabled until the new text was
  there.
- **A proposed task can be taken as an idea** (2026-10-16). Before, a proposal could become an idea
  only when its worker had proposed one: the owner who wanted to discuss and prototype a proposed
  task first had to ask the Koordinator to make an idea of it.
- **An agent takes back its own proposal** (2026-10-17): an open one goes at once, an accepted one
  only marked, for the owner to remove, since the owner chose it and work on it may be under way.
  Before, a worker could only say in a new proposal's text that it replaced an older one: both stood
  on the canvas, and the owner started both.
- **Feedback keeps the approval** (2026-10-08). Before, feedback sent the card back to `working` and
  took the approval away until the next handover, so it waited for "Rückgängig" like a command.
- **Earlier demos stay on the card** (2026-10-16). Until then a new demo replaced the one before for
  good: a demo after feedback that showed only the corrected part left the owner without the
  original, and a comment on a place in it played the new video from that time.
- **A turn without a new demo reads „Agent hat geantwortet“** (2026-10-15). Until then the card read
  „Demo bereit“ after any answer.
- **Only words for the owner count as an answer** (2026-10-19). Until then any end of a turn on
  their words counted, and a session that ended without one left the answer to the words before
  standing: the card read „Agent hat geantwortet, wartet auf dich“ under a question no agent had
  seen.
- **The demo zooms within the window** (2026-10-12): full screen was too much on a large monitor and
  hid where the owner was; before, the owner zoomed in with the operating system.
- **Space and the arrows reach the video** (2026-10-14). Before, the microphone flickered at every
  tap of Space on a demo, and then the 200 ms delay held everywhere, also without a video. A click
  on the progress bar took Space away (no pause, no recording), and the arrows worked only after
  that click.
- **Comments are tied to a place in the video** (2026-10-12). Before, nothing tied the owner's words
  to a place in the video: they named the time themselves or took a screenshot, and the video ran on
  while they spoke. The comment button stood on the video always until then. Until 2026-10-14 the
  frames loading after the jump to the end pushed the newest comments below the edge after a few of
  them.
- **Comments are held until the owner has watched** (2026-10-12): before, a comment once said
  stayed, and only the end of the video sent them early. Until 2026-10-15 each held comment stood
  where it was said, so the worker's steps after it showed below comments it had not heard yet.
- **A demo that a worker reworks after an answer is at work, not the owner's** (2026-10-07). Before,
  the card kept its badge while the worker reworked the demo the answer asked for, and a worker that
  paused for a restart there was never resumed: the card waited with a demo its worker had not
  finished.
- **Approval covers the PR, its monitoring and the merge** (2026-10-05): the owner approves the
  demo, not the code, so a second click on GitHub once checks and review are through added nothing
  but waiting. At first Obeya left the merge to the owner.
- **An approve click folds the card at once.** Before, the card stayed open with nothing to show the
  click had registered until the push was through.
- **Work without a change to the code ends in a state of its own**, `done` ("Erledigt"), not `live`
  (2026-10-02): nothing went live. Whether there is anything to land Obeya reads from the workspace
  on approval, rather than from the worker's word; the worker's `close_unchanged` only covers work
  whose branch emptied after the approval. The owner still approves such work: its demo or summary
  is the result. Before, such a card waited in `in PR` for a pull request that could never come (a
  demo card on 2026-10-02).
- **A finished card keeps a field for questions to its agent** (2026-10-08). Until then a live card
  had no field, and asking its agent was no longer possible.
- **What the owner archives**: only their own cards, and only once `live` or `done`, or an idea once
  parked or dropped; "all finished ones at once" leaves ideas alone. A workstream stays with its project, where a delivered one is already
  a chip, and goes into the archive with it. Archiving keeps the card's position, demo and log.
- **A parked idea can be archived too** (2026-10-15). Until then only a dropped one could: a parked
  idea was meant to come back, so it stayed in sight. But an idea whose result the owner used outside
  Obeya (a post written with its agent) is done, neither dropped nor to come back, and stayed on the
  canvas for good.
- **A stopped task can be archived and opens like a card an agent worked on** (2026-10-15). Until
  then a stopped card could only be started again or deleted, and it opened as a planned card nobody
  had worked on: the task in its edit field, the conversation squeezed below it.
- **The archive drops down from the bar** (2026-10-09): until then it was a sheet on the right.
- **No card goes into the archive while its worker finishes after the landing** (2026-10-16). Until
  then a project whose doc went with its last workstream's landing (as docs go in Obeya's own
  repository) went into the archive at once, its workstreams with it. Its worker, looked up only
  among the cards on the canvas, never ended its turn: the clone stayed taken, by "a card that is
  not on the canvas" in the Workspaces popover, and the owner could neither see nor answer it. Such
  projects come back on the next start, their workers finish, and they go into the archive again.

## Communication

Agents never talk to each other directly; the Obeya server is the mailbox, so every exchange is
visible on a card.

### A worker's tools

A worker has its tools served in-process:

- `report(status)`, a status line on the card, which belongs to the stretch of work it reports on: a
  handover and an approval clear it, and a line reported while pausing for a restart gives way to
  the one from before once the worker paused.
- `reply(text)`, its answer to a note or feedback in the card's conversation, which does not end its
  turn: with work left the worker carries on; with none (its work handed over, the note changing
  nothing) its turn ends with the reply, and the card goes on waiting for approval.
- `ask(question, options, multiple, pick, pick_why)`, which returns at once — the worker ends its
  turn and the answer arrives as its next message. The owner picks one option, several when
  `multiple`, or writes their own answer, or both; `pick` and `pick_why` are the options the worker
  would choose if it had to decide, and why, which the card marks "Würde ich nehmen" the way an
  idea's questions show its agent's pick. The options picked go apart from the owner's words
  (`picks` of the answer): the worker reads `They picked „…“.` and, below it, what they `added in
  their own words`; the log keeps both as one text, picks first, for whoever reads it later
  (decision log, Koordinator). An answer leaves the card open, picked or written, and stands in its
  conversation at once.
- `propose_card(title, task, reason, idea?, questions?, replaces?)` and
  `withdraw_proposal(title, why, replaced_by?)` (see Proposals).
- `ready_for_review(summary, demo)`, whose summary is the report the owner reads.
- `app_running(url)`, where the app in its workspace opens in a browser, for the owner to try it by
  hand (see Trying the app by hand); in a workspace on another machine, Obeya forwards its port.
- `snooze(until, why, card, state)`, when it has nothing to do until a point in time further off
  than a background command can wait, or until another card gets somewhere (see Snoozing a card).
- `to_obeya(request)`, for what the owner's words to it ask of Obeya rather than of the worker (see
  Voice in).

Obeya's messages to a worker say what happened — feedback, an answer, a note, a landing that failed,
the landing — not step by step what to do: workers are full agents. Whether a demo is recorded again
after feedback is the worker's call; a handover without a new demo keeps the one on the card. The
card shows that demo while its worker works again or waits on a question, without playing it on its
own and with the hint that it is the last handover's and the agent is working on the task again;
sharing stays beside it.

### Turns that end without a handover

A turn that ends without `ask` or `ready_for_review` gets one nudge, then its last words become a
question to the owner; when that turn failed in the session (the SDK reports an error result, e.g.
Claude not logged in on the machine), the question is the error in words for the owner instead. A
worker that went to the owner for having stopped and then works on by itself takes that question
back.

A turn the account's usage limit stopped (the five-hour session limit, a weekly one: the SDK's
`rate_limit_event` says `rejected` and when it resets, the API error is `rate_limit`; without the
event, the message's „resets 7:20pm (Europe/Berlin)“ says when, `resetIn`) is neither
nudged nor a question: the card's log says when the worker goes on, its status line reads
„Nutzungslimit · weiter um 14:40“, and ten seconds after the reset Obeya tells the worker to go on
where it stopped (a limit that holds past its reset time is tried again after a minute, one without
a reset time every 15 minutes). Meanwhile the worker is not busy, so a restart need not wait for it
(the resumed session runs into the limit again and waits anew), and a note from the owner reaches it
at once. Once it works again its status line from before is back. The conversation shows the limit
as a line where it happened, with what the worker did until then above it, not folded into the
message that follows the owner's next words. A worker the limit stops while it takes in the owner's
words on its handover is still at them: the card does not wait for the owner meanwhile. One whose background work runs on (a demo render) says so on its
status line too and goes on at the reset without waiting for that work to wake it; it stays busy
while the work runs, which a restart would cut off.

The other agents wait for the limit the same way (`withLimitWait` in `runtime.ts`, which an agent
joins with `onLimit`): a look-up and a project agent, a Question card's agent, an idea's exploration
agent, the reviser of a proposal, and the Koordinator's own small jobs (naming a card, checking a
queued card or a project's workstreams, the learner, the Rückschau, the Arbeitsrückschau). The turn
the limit stopped is neither an error nor over: ten seconds after the reset (with a worker's retries
when the time is unknown or passes) the session is told to go on where it stopped, and the owner's
words meanwhile wait for its next turn as during any other. Where the agent waits says until when:
under a looked-up question in the sheet „Nutzungslimit · schlägt das um 19:20 von selbst nach“ (on
the card it was asked on, a line in its conversation), and on a card, on its face, beside its state
and in the agent's bubble, „Nutzungslimit · weiter um 19:20“ (`Item.limitedUntil`, `Talk.limitedUntil`,
held in memory). After a restart they are resumed with their work (a question looked up, an idea's
reply, a proposal being reworked, a card being named or checked), run into the limit again and wait
anew; ending the session (pausing the agent, parking the idea) ends the wait. Two do not wait: a demo
page shared without the worker's text, which takes the card's title and the summary's start as
before, and the draft of a wish, whose owner is waiting for it in the dialog (see „Wishes for
Obeya's makers“). Workers and Obeya's chat handle the limit themselves, as described above and in
„Confirmation and undo“.

A turn that ends while the worker's own background work runs (a demo render, a test suite, a watcher
it started) is no such turn: the work wakes the worker when it finishes or fires, so Obeya waits,
also after the landing, where an ended turn would otherwise finish the card and take the work's
workspace with it. The session reports each change in how much background work runs, and Obeya waits
as long as some does, bounded only by the work's own limits (a command in the background stops after
two hours at most, a watcher after half an hour; Obeya gives up after three hours for a session that
never says the work ended). A deploy that takes twenty minutes is waited for. Only ten minutes after
the work ended without a sign of life from the worker does Obeya nudge. So does a turn in which the
worker said and did nothing: a session resumed after a restart first ends a turn of its own over
what the previous one left (a background command the restart stopped), and counting that would use
up the nudge before the worker's own turn, whose status line would then reach the owner as a
question.

### Pausing an agent

The owner can send a note at any time; it reaches the worker without stopping it. The owner can also
pause the agent while it works on something: the conversation's bubble that shows it at work („Agent
arbeitet …“) has a pause mark at its right, faint until pointed at but always there (a mark that
shows only on hover would hide it from first-time users and touch screens); by voice „halt mal an“.

The bubble and the pause follow the same condition (`pausable` in `src/core/types.ts`, which the
server checks too): a Question card's agent reading, an idea's agent working on its reply, a worker
in a turn (`Item.inTurn`, which the server sets from the worker's live session, background work
included), whatever the card's state: at work, taking in the owner's words on its handover, in its
PR (on review comments or a note), finishing after the landing. An idle agent shows no bubble and
offers no pause: a PR card whose worker opened the PR and waits for review has nothing running, and
a note or the PR's review starts its next turn (its field then reads „Hinweis an den Agenten – er
macht sich daran“, not that it works on). The agent reworking a proposal has no pause: its rework is
short and starts again from the owner's words.

A worker's bubble also names the background work that runs: under „Im Hintergrund“ each task as the
agent described it (the SDK's `background_tasks_changed` list, `Item.background`), with how long it
has run („Run the test suite seit 2 min“), counting on while the card is open; a task that ends
leaves the list. That is what the bubble shows when only background work keeps the turn open (right
after a question, reply or handover), where it would otherwise show no step and no gist. Obeya
learns no start time from the SDK and counts from when it first saw the task; the SDK's own
housekeeping, which wakes no one, does not show (`backgroundWork` in `src/server/runtime.ts`).

Pausing ends the agent's session at once, in the middle of a step if need be, with whatever it ran,
and keeps the card's state and the session (`paused` on the card's row). A worker keeps its
workspace and branch, its slot is free, and its app is parked after the grace like a waiting
card's; one paused on its handover leaves the card waiting for approval („Demo bereit · Agent
pausiert“), Freigeben included. An idea's agent keeps the messages it had not answered (as when the
idea is parked), a Question card's agent what it was asked (the thread's pending words).

The bubble stays where the agent stopped, standing still in pencil grey: „Agent pausiert · ▶
Weitermachen“, with the line „Pausiert.“ under it (the bubble and the field say how it goes on, so
the line does not, and still reads right once it went on); going on, like a message, brings the
bubble at work to the end again, below that line, the owner's words and „Weiter.“, while the steps
it took until the pause stay above the line, as the agent's message there. The card on the canvas
reads paused too, without the moving line; a restart of Obeya leaves every paused agent paused.

„Weitermachen“ (by voice „mach weiter“) resumes the same session, and the agent hears that it was
paused and that what ran was stopped (exit code 137); what the owner writes to a paused agent
resumes it the same way and goes along (the field says so: „Hinweis an den Agenten – er macht damit
weiter“), for an idea's or a Question card's agent together with what it had not answered. What
Obeya has for a paused worker meanwhile (its pull request's review, the landing of a merged PR) and
a message it had not taken in yet wait and go along then.

„Stoppen“ stays in the card's action row: it ends the agent and plans the card again, a decision
about the card.

### Snoozing a card

A card can be set aside until a point in time: by its worker, which has nothing to do until then (a
test that runs for two weeks, a check at midnight, a report on the 31st), or by the owner. A worker
can also set itself aside until another card of the canvas gets somewhere: until it is done (its work
on main, or closed without a change) or waits for the owner (asks, hands over, or as a proposal or an
idea's questions), as a release waits
for the fix another card makes. Obeya holds the time and the card (`snoozed` on the card's row: until
when, on which card for what, by whom, what the agent does then), not the agent's session. No other
condition: waiting until CI is green stays background work, minutes rather than days.

The worker snoozes itself with `snooze(until, why, card, state)` and ends its turn: `until` a time,
`card` the title of the card to wait on (an exact title, else a part only one open card's title
holds) with `state` `done` (the default) or `waits_for_owner`, or both, and it wakes at whichever
comes first. A card that is there already is refused, as is a time that passed. It takes effect at
once, without asking the owner. Its session ends with that turn, and whatever it still ran in the
background with it; workspace and branch stay, its slot is free, its app is parked after the grace
like a waiting card's, and no nudge or question follows the turn. A worker snoozes only while the
card is at work (started, in its pull request, finishing after the landing); a question or a
handover in the same turn takes the snooze back. Its instructions send a wait for a point in time
that is further off than a background command can wait (two hours), or for another card, to
`snooze`; checkpoints one
after the other are one snooze after another, the worker checking and snoozing to the next each
time it wakes. Idea and Question cards' agents have no such tool: they never wait on the world.

The owner snoozes with „Später …“ in the card's action row (a visible button, with its clock mark):
this evening 18:00 (while that is more than half an hour off), tomorrow 08:00, next Monday 08:00, or
a date and time to pick (`SnoozeMenu` in `src/ui/snooze.tsx`, one component for every kind of card;
by voice „stell das bis morgen früh zurück“, `snooze` with the local time). It is offered on any card
at work and on any card that waits for the owner (`snoozable` in `src/core/types.ts`):

- A card at work stops as on a pause (see Pausing an agent): its session ends at once, mid-step if
  need be, and what Obeya has for it meanwhile waits; at the time it goes on where it stopped.
- A card that waits for the owner (a question, a demo, a proposal, an idea whose agent replied, a
  pull request ready to merge) leaves „brauchen dich“, Tab and the phone's „Für dich“ until then and
  comes back at the time like a snoozed mail, with a push to the phone as when it first waited;
  nothing goes to its agent, and background work its worker still runs (a render it asked beside)
  goes on, with the pause on its bubble. Answering it all the same (or its idea parked, its proposal
  reworked) ends the snooze: it no longer waits for the owner.

Waking: a timer (every 15 s), every change on the board (so a card that only passes through the
state waited for, asked and answered at once, counts) and every start of Obeya look for snoozed
cards whose time has come or whose card they wait on got there (`wakeDue` in `src/server/canvas.ts`, `awaited` in
`src/core/types.ts`), or no longer gets there by itself (stopped, archived, removed, an idea
dropped), so a restart touches no snoozed card and a time missed while
Obeya was not running or the machine slept is caught up at the next start or wake. The worker hears
that it is now the time it snoozed until, or what became of the card it waited on, and what for (and that the owner moved that time, when they
did); snoozed by the owner, that the owner snoozed it until then and what ran was stopped. The owner's words to the card, „Jetzt zurückholen“, and for
a worker that snoozed itself whatever Obeya has for it (a review, the landing, a failed check) wake
it earlier; it hears what woke it (woken by the owner without words, that they want to know where
things stand) and may snooze again once it dealt with that. What Obeya has for a
worker the owner snoozed waits until it wakes, as on a pause. A question for the owner that arises
meanwhile (its pull request closed, a tool call to allow) ends a worker's snooze, so it reaches
them. A restart announced in the turn the worker snoozes in ends its session after the turn the
notice starts; a restart a worker waited for after the landing wakes it once Obeya runs again.

On the canvas a snoozed card is pushed back on greyed stock, its line still in pencil grey with a
clock: „◷ Zurückgestellt bis morgen, 00:05“ (today and tomorrow by name, later days by weekday and
date; „◷ Zurückgestellt bis „…“ erledigt ist“ for one that waits on a card, with „spätestens …“
when it has a time too), and over it who snoozed it and why („vom Agenten · Prüfen, ob der Test den Kellerlüfter
eingeschaltet hat“). It counts neither as at work nor as needing the owner; on the phone it stands at
the end of its list („Läuft“, or „Für dich“ for one that waited for the owner). Its conversation has
a line where it happened, „Zurückgestellt bis Sa 31.10., 08:00 · …“, which while it lasts carries
„Jetzt zurückholen“ and „Ändern“ (the same menu; it changes the time, whoever snoozed it), and on
waking a line that says why it is back: „Wieder da: Zeitpunkt erreicht“, „… von dir zurückgeholt“,
„… Neues für den Agenten“, „… die Karte braucht dich“, or what became of the card it waited on („…
„Tests auf Linux grün machen“ ist erledigt“). Until 2026-10-17 that line said who had snoozed the
card („Wieder da (vom Agenten zurückgestellt)“), which the snooze line says already and which did
not tell why it was back. The field reads
„Hinweis an den Agenten – er wacht damit auf“.

### Waiting without blocking

The SDK hands a waiting message to the agent only after its running tool call, so a note never cuts
a command off (tests and renders included), and workers keep their tool calls short instead: they
wait for anything external (a deploy, a CI run, a process to finish) in the background
(`run_in_background`, Monitor) and end their turn, which a note starts again at once. A point in time
further off than that, they snooze until (see Snoozing a card).

A Bash command in the foreground that sleeps longer than 30 seconds (`sleep N`, a polling loop
without a bound, counted from the command line by `foregroundSleep` in `src/server/runtime.ts`) is
refused with that reason. `timeout N` (or `gtimeout`) bounds the command it starts, wherever that
stands in the line (`cd app && timeout 28 bash -c 'until …; do sleep 2; done'`). The text of a
heredoc is data (a script written with `cat > f <<'EOF'`, a commit message) and counts only when a
shell runs it (`bash <<EOF`, `cat <<EOF | sh`, `ssh host <<EOF`). The refusal names two bounded
waits that pass it, one without `timeout`, which macOS lacks.

### Refused and confirmed tool calls

A tool call refused without anyone being asked (a deny rule of the settings, auto mode's classifier,
the permission mode, a hook, Obeya's own refusal of a foreground wait) stands in the card's
conversation as a line, not folded under a message: „Nicht erlaubt (Regel in den Einstellungen): $
…“, with the deciding component's words when the SDK gives any (its `permission_denied` message; a
deny rule names no rule, only that one decided).

A tool call the settings want a person to confirm (an `ask` rule, say for write access to a
database) reaches the owner instead of being refused: the SDK's `canUseTool` makes it the question
the card waits on, with the command whole and Claude Code's reason, and the options „Erlauben“ and
„Ablehnen“. The call waits for the answer within the worker's turn; meanwhile the worker counts as
waiting for the owner, so a restart need not wait for it. „Erlauben“ runs the call (the owner's
words with it reach the worker as the next message); „Ablehnen“, words alone or a note refuse it,
with the owner's words in the call's result. Two such calls at once are asked one after the other. A
restart while the question is open leaves it on the card; answered then, the resumed worker hears
the answer, and a call the owner allowed runs once without asking again when the worker makes it
anew. It is no decision for the project's log. Claude Code's own question tool (`AskUserQuestion`)
is refused with a pointer to `ask`.

### Notes and replies

A worker answers a note or feedback with `reply`, saying what it changes or why nothing, and asks
when the note is unclear. Its words after a reply are its words when a step of its work follows
them; the closing words of a turn in which it replied mostly repeat that message (often in English
on a German canvas), so they fold under it in the conversation, the last of its steps, whatever the
card's state (event kind `closing`). Those after a handover repeat the handover a third time after
the reply and the summary, and the log leaves them out (until 2026-10-15 they folded under it as
well). The steps it took between that message and
its closing words (a card it proposed after replying, say) fold under the message with them.

A note while the card waits on the worker's question takes that question back: the card goes back to
work (in its pull request, or finishing after the landing, where it was), and the worker hears that
its question („…“) is withdrawn, goes on if the note settled it and asks anew if not. The note is no
answer, so nothing goes into the decision log. Words on a demo whose report asks a question answer
it (see The handover report).

### The conversation

Every card shows its exchanges as a conversation („Gespräch“), the way an idea does (`talkTurns` in
`src/ui/talk.ts`). Messages are:

- what the owner says (notes, answers, feedback, spoken or typed, with screenshots, standing once as
  the agent got them);
- the agent's questions (a worker's, an idea's, a proposal's) with their options and the pick
  (marked on the question only: the owner's message under it holds just their own words, and a pick
  alone is no message of its own; an idea's and a proposal's answer names its questions in its
  text, `answerText`, which the conversation reads back, `readAnswer`);
- its replies;
- its handovers (the one a demo came with carries its report's question, muted once answered; a
  later handover that keeps the demo leaves it there). A later handover that follows the worker's
  reply in the same turn stands under that reply, after a dashed line, as „Übergabe“ with its time
  and what changed, not as a message of its own; its steps and closing words fold with the reply's;
- what the Koordinator looked up for the owner.

Small lines between them are the state changes (started, pull request opened, approved, landed,
stopped, errors, the usage limit that stopped the agent). Everything else folds away under the agent's next message as „Verlauf“ (a worker's
closing words after a reply under that message, as its last step): tool calls, thoughts,
status lines, the Koordinator's confirmations, Obeya's notes (restarts, sessions, what happens on
the pull request).

A note the worker answered without `reply` (a card from before it, a worker that forgot) is answered
by the first words the worker said after it, unless a reply follows them before the owner says more:
then they were a step on the way to it. Once no agent works on the card and no question is open, no
message is coming for the steps after the last one: they go where they happened, before the lines
that came later. The agent's last words among them stand as its message (the closing words after a
landing, say), a turn it ended without words as its steps, and what only Obeya or the Koordinator
noted there goes.

The agent's words are kept whole up to 12 000 characters, as an idea agent's replies are (a worker's
`reply` is cut at 2000). While the worker works, also while it takes in the owner's words on its
handover, the conversation ends with it at work and its latest step, cut to its first line and 140
characters, whole while the mouse is over it; the question the card waits on (its own, or the one in
its demo report) stands at the end with its options, and the card's one field under it. A worker
that asks while its background work runs (a test suite, a review it started) is still in its turn:
its question stands with its options, and the bubble at work below it; a question a
note took back stays, without options, „Durch deinen Hinweis erledigt“. A question answered or asked
anew has no orange edge either: only its label „Agent · Frage“ stays orange, a turn where the owner
had something to do. Until 2026-10-17 an answered question kept its
orange edge, which also marks the messages new to the owner, so it looked as if it still waited. A card that was an idea
continues the idea's conversation in the same list.

Which questions are open is one rule for every kind of card (`openQuestions` in `src/core/types.ts`):
an open idea's while its agent is not at work on a reply, a proposal's while it is not reworked, a
worker's while the card waits for its answer, the one in a demo report while it is not answered. A
reply being worked on may settle them, so meanwhile nothing is answered; a parked or dropped idea
waits for nobody. Whatever shows a question as open reads that rule: the conversation takes each out
of where it was last asked and puts it at its end under „Frage an dich“ („Fragen an dich“ for
several) with its options, the field under it reads „Eigene Antwort oder Anmerkung – optional“ and
„Antworten“ only while they stand there, and the canvas card's line, the phone's count and the
Koordinator's view of the cards name the same questions. Until 2026-10-21 each kind of card decided
this on its own, in up to six places: the field under an idea or a proposal being reworked offered
to answer questions it did not show, a parked idea's questions stood to be answered at its end while
the phone counted none, a proposal's face named no question, the Koordinator saw an idea's questions
only where its agent had picked an option, and the heading read „Frage an dich“, „Offene Fragen“,
„Frage des Agenten“ or „Offene Frage“ depending on the card.

The messages new to the owner keep an orange edge until the conversation goes (the card closes, on
the phone its panel), as the answers that waited do in Obeya's sheet: those after the last event
they had in view and after their own last words (`unseenTurns` in `src/ui/talk.ts`, the messages the
phone's button counts). A message that comes while the conversation is in view (the page not hidden)
is seen as it comes and gets no edge; one that came while the page was hidden keeps it. What it holds
counts as seen while it is in view, in this browser (`useSeen` in `src/ui/seen.ts`, localStorage);
the conversation itself keeps that, in the code every card kind shares, on the desktop as on the
phone. Until 2026-10-17 only the phone kept what was seen, for its button's count, and no message
was marked; that day the marks came, at first also on messages that came while the conversation was
open, which the owner had watched arrive.

A conversation that stands at its end stays there as it grows: the agent's next step, a message, a
question, a frame loading. Scrolled up to read further back, the owner stays where they are, however
much comes meanwhile; only their own words (a note, an answer, a comment, an action like a pause)
take it to its end (`useStickToEnd` in `src/ui/stickToEnd.ts`, which Obeya's sheet shares). Until
2026-10-20 every step of a working agent took a card's conversation back to its end, so the owner
could not read up while it worked.

### Reading order

A conversation shows things in the order the agent saw them, on every card the same way. The owner's
words stand where the agent read them, not where they were sent: Obeya holds them while the agent is
in a turn and marks the moment it takes them in on their line of the log (`CardEvent.readAfter`: the
last line read before them; `talkTurns` sorts them in after it). The agent's steps from before then
close above them, as its last words among them or, without words, as a block of its steps („Agent ·
Verlauf“); its steps after them and its reply stand below.

Until it has read them, they stand below its work, muted and dashed, marked „Noch nicht gelesen ·
beim nächsten Schritt“ on a task and „… · nach der laufenden Antwort“ on an idea, a proposal or a
Question card, several in the order sent (`CardEvent.unread`). Each has a bin: taking it back takes
it out of the log, and no agent hears it; its text and screenshots go back into the card's field
when that is empty, else they are gone, since newer words stand there (`giveBack` in
`src/ui/draft.ts`, shared with the demo comments Obeya holds back). It takes effect at once, without
undo: the words are back in the field, or were meant to go.

That a line was read reaches an open card as the line again, over the canvas's WebSocket, like a new
line. A page whose connection was lost meanwhile (a phone locked, a network switched) never got it:
each open card's log (`useEvents`) loads anew once the connection is back, else the words would stay
„Noch nicht gelesen“ below the reply that answered them.

When an agent reads them:

- A worker: with the result of its next tool step, through the hook that passes it preferences and
  decisions (`AgentSpec.contextUpdate`, `unheard` on the card), screenshots as their files, which it
  opens itself, since a tool result carries no images. A turn that ends before another step starts
  the next with them. A session that ends first (paused, a restart, a machine cut off) gets them
  with the message it goes on with; after a stop they wait for the next start.
- An idea's agent, a proposal's reviser, a Question card's agent: when their next turn starts, after
  the reply they waited for.

Words said while the agent is between turns start its next one and are read at once.

### Replying to a message

The owner can reply to one message of a conversation, as in chat apps, on a card and in Obeya's
sheet alike: a button in the corner of each message (shown while the pointer is on it; `Msg` and
`Quote` in `src/ui/message.tsx`) puts the message as a quote above the field, with × (or Escape,
before it closes the card or the sidebar) to take it out; what the owner then types or says with
push-to-talk goes out with it. Until the owner has replied once, the latest message they did not
write shows its button without the pointer, so they find it. The quote is part of the field's draft
(`src/ui/reply.ts`), so it outlives closing the card and a page load like the words beside it. Their
message shows the quote above their words, in the colour of who said it, its first lines only; a
click on it scrolls to the message and lights it up.

On a card the reply names the message's event id (`replyTo`), and the agent reads `[In reply to your
message: „…“]` above the words (`replyNote` in `src/server/board.ts`): the first 160 characters or
so of what it has whole in its session anyway (its own words, the owner's words to it), else the
whole message (Obeya's words in the card's conversation, which the worker never got; the
Koordinator, which reads the field where no agent listens, gets it whole too). A reply works on
every card with a conversation and a field, the same way. Only messages can be replied to, not
steps or state lines; a `replyTo` that is not a message of the card is dropped and the words go
alone.

In the sheet a message is one part of an exchange (`TalkRef`: what the owner said, the Koordinator's
reply, the answer it looked up), kept with the owner's words (`Talk.replyTo`, column `reply_to`).
The Koordinator reads the message whole (`talkReplyNote` in `src/server/commands.ts`), a looked-up
answer by its tag (`A12`), so a reply to an answer follows up on it. Only the sheet's own exchanges
can be replied to there; anything else is dropped.

### The task as first message

A task's conversation starts with the task: once the agent starts, the card's text and screenshots
stand as its first message, above the line that the agent started, the way an idea's starting point
does (`Seed` in `src/ui/detail.tsx`), so the conversation reads from the start: what was asked, what
the agent did, what the owner added. Its label says where the text comes from: „Du“ on the owner's
own card (typed or spoken), „Plan-Doc“ for a workstream, „Idee“ for a prototype, „Vorschlag“ for an
agent's proposal the owner accepted (the card keeps that it was one, `proposed`), „Obeya“ for one
from the Arbeitsrückschau. A long text shows its first eight lines or so, with „mehr“ for the rest
(an idea's starting point too), and „Voraussichtlich betroffen“ folds under it. A card that was an
idea has no such message: its brief stands on the left, and its conversation goes on from the
idea's.

### Card layout

Every card with a conversation is laid out the same way (`Split` and `Talk` in `src/ui/detail.tsx`):
idea, proposal, and a task an agent worked on. What the card is about stands on the left (an idea's
brief, a proposal's text, a task's demo with its chapters and sharing, its pull request, what
landed, a decided idea's brief), the conversation on the right with the questions it waits on at its
end and the owner's one field with one Send under it, and the decisions (build, accept, approve,
stop, archive) in a row below both. A task that has nothing for the left yet (the agent at work, a
question before the first demo) is its conversation alone, the card only as wide as it (`talkAlone`
in `src/ui/talk.ts`), and widens to the split once there is a result. A task waiting in the queue
for its first start (Obeya checking it, behind other cards, waiting for a workspace) is a split as
well, as wide as a proposal's: its text in full on the left under what it waits for, its conversation on the
right (`waitsFirstStart`). What the owner types into its field waits there unread, and goes to the
worker with the task once it starts (`unheard`, as for words in the middle of a turn); spoken words
go to the Koordinator as on any card without an agent, which passes a note on the same way.

A task's branch (and its plan doc) stands under its title, with the size of its change beside it
(„+120 −30 in 5 Dateien“, `Branch` in `src/ui/diff.tsx`): before landing, the branch in its
workspace against the default branch, committed or not, new files included; once landed, what the
landing put on the default branch (`Shipped.base..commit`: the default branch before a landing on
main, a merge commit's first parent; a card whose merge commit GitHub did not name has none; an archived card keeps its size and diff). A click shows the whole diff over the page, file by file, with
large files folded; while the card has a workspace, „Pfad kopieren“ copies its directory
(`host:/dir` on another machine). The owner rarely reads the code, so it stays a quiet line, read
when the card opens and again as the work moves on (`GET …/cards/:id/diff`, `?full` for the diff
itself, cut off past 2 MB).

#### Trying the app by hand

While the app runs in the card's workspace, „App öffnen ↗“ at the end of that line opens it in a new
tab, for the owner to try the work by hand. Rarely wanted, so it is a link among the line's others,
nothing more. Obeya neither starts the app nor finds its address: the worker gives it with
`app_running(url)` once the app runs (its brief asks for that beside the recipe; an empty url when
it stops it), and the card holds it (`app` on the card's row, `Item.app`) until the worker clears
it, Obeya parks the card, or the workspace goes. The link shows only while the app answers there:
the open card asks every ten seconds (`GET …/cards/:id/app`, a `HEAD` request with a 1.5 s limit;
any HTTP answer counts, an error page too), so an app the worker stopped without saying so, or one
that died with a restart, shows none. The link goes through Obeya (`GET …/cards/:id/app/open`,
redirecting to the address): opening it keeps the app running for at least 30 minutes after
(`TRY_GRACE`), so parking does not stop it under the owner; an app no longer recorded gets a line
saying so instead.

A workspace on another machine (see Hosts) reports an address that only that machine reaches. There
the probe and the link go through a forward of that address's port to a free port here (`ssh -L`
on a connection of its own, `SshHost.forward`), and the link redirects to `localhost` at that port,
with the address's path. Obeya makes the forward when the card first asks whether the app answers,
and ends it once the card no longer offers the app (the worker cleared or changed it, Obeya parked
the card, its workspace went) or Obeya stops; its command there waits for stdin, so it ends with
Obeya even when Obeya dies. A forward gone with a dropped connection is made again at the next
probe, on the same port while that is free, so an open tab goes on working. Only that one port is
forwarded: a page that talks to an API on another port of that machine finds nothing here (the
worker's brief says so). The port here is one the system picks, never the address's own number,
which a stack in a clone here may need when it starts again.

### Screenshots

What the owner writes on a card (a note, feedback, an answer, talk to an idea) may carry
screenshots: pasted (⌘V), dropped or picked in the text field, scaled down in the browser to at most
2000 px, and uploaded at once. They show as thumbnails in the field and in the card's log or
conversation, and reach the agent as images in the message, with their file paths. A click on a
thumbnail grows the screenshot out of it to as large as the window allows, over the greyed page,
like the demo video's zoom (`Lightbox` in `src/ui/shots.tsx`); Esc or a click puts it back into its
thumbnail, and the card stays open.

A card's task takes screenshots the same way: in its description field, while the card is planned.
They show under the task, and its worker gets them with the task when it starts (an idea's
exploration agent, when a planned card becomes an idea; building an idea adds the screenshots the
owner showed in its discussion).

A command typed in the Koordinator's sheet may carry screenshots too: the Koordinator sees them, and
they go with every action of the command that creates or concerns a card (new card or idea, start,
note, answer, feedback, talk to an idea); said with a start, they join the card's task. A spoken
command carries screenshots the same way: those in the field of the open card, or of Obeya's sidebar
when no card is open, go with the next recording (see Voice in: one draft per field). Dropped on the
microphone or pasted (⌘V) anywhere outside a text field, they land in that field. Only where no
field is spoken to (the canvas with no card open and the sidebar closed) the microphone keeps
screenshots of its own: picked with the small button to its right, dropped on it or pasted, they
show beside it. They are for Obeya, as the sidebar's field is: opening the sidebar moves them into
its field, and closing it moves the screenshots in that field back beside the microphone (its words
stay in it); an open card leaves them beside the microphone, out of sight until it closes. A recording in which nothing was heard or understood leaves them where they were,
and so does one Obeya refused. When the connection breaks before the answer (the browser cuts it
off as the page goes to another canvas or reloads, or the network drops), the page cannot tell
whether Obeya has the command: it names each recording (`?sent=<id>`), asks Obeya whether that one
arrived (`GET …/voice/arrived/<id>`, asked again until Obeya answers), and gives the field its words
and screenshots back only when it has not. Until Obeya answers, the command's line above the
microphone still shows it being read; when Obeya has it, the line says so („Obeya hat es; nur die
Antwort kam nicht an.“) instead of „Das hat nicht geklappt“. A page that goes away never hears, and
gives nothing back.

### Marking screenshots

A screenshot still in a field (any `ShotStrip`: a card's field, the sidebar's, the microphone's, a
planned card's task) opens ready to be marked, to point the agent at a spot: a drag on it frames a
region in signal red with a thin white edge (so it reads on light and dark screenshots), a click (a
drag shorter than 5 px) sets a red pin. Frames and pins are numbered together, 1, 2, 3 … in the
order set, for the text to refer to: a pin shows its white number in a red circle, a frame in a red
square on its top left corner, above it like a tab (inside, where the image ends above the frame),
so a small frame does not read as a pin. Square and frame are one shape: the white edge runs around
both, and the red of the square runs into the frame's line. No tool to pick: the gesture decides.
Line and pin take the same share of the image at any size (`src/ui/marks.ts`).

A bar under the image has Undo (also ⌘Z / Ctrl+Z), which takes back the last mark, again and again
down to the unmarked screenshot (an undone mark's number goes to the next one; there is no "clear
all"), and Done; a hint in it says how to mark until the owner has marked once. A click on the image
marks instead of closing; Esc, Done or a click beside the image closes it.

On closing, the browser draws the marks into the original (through the same size limits as a pasted
screenshot), uploads the result, and that takes the original's place in the field: the agent gets
only the marked image, and the field waits to send until it is uploaded. The marks stay apart as
shapes in image pixels beside the original (`Markup` in `src/ui/draft.ts`, by the id of the marked
image, kept per tab and canvas like the drafts, the newest 100), so reopened, even after a reload,
the original shows with its marks and Undo goes on working; with every mark undone the field holds
the original again. A sent screenshot stays as it was sent: in the log its enlarged view only shows
it. The server and the agents see nothing of this; a marked screenshot is one more uploaded image.

### Questions go to the owner

A worker's question goes straight to the owner, with the worker's own pick: no other agent answers
it on the owner's behalf. The worker asks only what it should not decide itself (product behaviour,
trade-offs, anything irreversible or external) and settles the rest alone. What a project has
decided reaches its workstreams' workers instead: a worker's task holds its project's decision log
("Decisions taken in this project so far") beside the pointer to the plan doc, and a decision
recorded while it runs reaches it once at its next tool call, the way a learned preference does.
Answers given in the owner's name before then stay in the decision logs, marked "(an agent)", and
show on their cards as before. Owner-facing text from agents is in the owner's language: that of
their latest words, else the conversation language (see Language).

### Decisions

- **A card shows a conversation instead of its log** (2026-10-05): the owner reads what was said and
  decided, not every tool call, which stays a click away under each message. Rejected: the
  conversation beside the log (every message twice). A worker answers notes with a tool of its own
  (`reply`); its last words before the owner's next message would often be "Ich committe jetzt", and
  a small model summing up each turn costs on every turn for nothing `reply` does not do. A note
  withdraws an open question rather than counting as its answer, which would put a remark into the
  decision log as a decision.
- **An agent's question to the owner is a first-class thing with answer options**, not prose: the
  owner answers with a click, and their own words are always possible beside the options. The answer
  travels as text (question and pick), so the conversation reads the same later and a spoken answer
  takes the same path.
- **Picks go apart from the owner's words** (2026-10-15). Until then the pick went out as the first
  line of the owner's words, so the worker could not tell it from them, and the owner's message
  repeated the pick as its first line. An answer with a pick folded the card („Antwort ist beim
  Agenten.“), one without kept it open.
- **A worker's question goes straight to the owner, with the worker's own pick** (2026-10-07).
  Before, a project agent answered a workstream's questions and the Koordinator those of a card
  without a project, escalating only what they could not settle; they were allowed technical
  judgement calls "a senior engineer would make without asking". The Koordinator then decided
  against building a feature, weighing the work against what it would save, which was the owner's
  call. An advisor knew barely more than the worker: the Koordinator saw no other cards, and a
  project agent's only edge was the project's decision log, which now goes to the worker. Narrowing
  the advisor's rules or having it only suggest were dropped: the worker's own pick gives the owner
  what a suggestion would.
- **Workers are told what happened, not what to do next**: they are full agents and judge the next
  step themselves (re-rendering a demo, say). Protocol stays where Obeya depends on it: hand over
  with `ready_for_review`, ask with `ask`, report the PR with `pr_opened`.
- **The last demo stays in view while the worker works again** (2026-10-08). Before, feedback or a
  note hid it until the next handover.
- **A status line belongs to the stretch of work it reports on** (2026-10-09). Before, a card the
  owner approved for a PR read „In PR · Paused for restart; next: …“, a line from before the
  handover, while its worker was rebasing for the PR.
- **Background work keeps a turn open** (2026-10-12). Until then a turn counted as ended ten minutes
  after its end whatever still ran, and a worker watching a deploy after the landing lost its
  watcher and its promise to go on.
- **The pause sits on the bubble of the running turn** (2026-10-15). Until then „Pausieren“ and
  „Weitermachen“ stood in the card's action row beside „Stoppen“, for workers only, and pause was
  offered for every card at work, in its PR or finishing after the landing: on a PR card whose
  worker was idle there was nothing to pause, and a worker taking in the owner's words on a waiting
  card, which the owner watches most closely (before a paid render, say), could not be paused. The
  action row holds decisions about the card; pausing is about the turn running now, so it moved to
  where the owner watches that turn. Until 2026-10-14 „Stoppen“ was called „Anhalten“, which reads
  like a pause, and was the only way to halt an agent, losing its session. Rejected: pausing at the
  next safe point, as for a restart: the owner pauses an agent that goes the wrong way, and waiting
  for its step to end lets it go on doing so.
- **Waits of hours or days are a snooze Obeya holds** (2026-10-17). Until then a worker that had to
  wait days (a controlled test running two weeks, a check at midnight) kept its turn open with chained
  background sleeps of at most two hours, each wake a model turn. The card read as at work for days
  and held a slot; every restart of Obeya cut in (notice, stopping the sleep, „Pausiert bis zum
  Neustart“, resuming, a new sleep, a message: about 35 times in one day, nearly all of a card's 239
  events); reminders the worker set in its own session were unknown to Obeya; and a night without
  network turned a failed turn into a stuck question, so the midnight check never ran. Rejected:
  the agent only proposing a snooze for the owner to click (a click per checkpoint moves the noise to
  the owner, and a snooze is undone with one click); keeping the agent's own waits and only hiding
  the restart noise (the card would still look busy, hold a slot, wake every two hours and fail on a
  network gap); conditions besides a time („bis CI grün ist“, which background work covers; another
card's state came later, see below). German
  wording follows Gmail's „Zurückstellen“, which owners know.
- **A worker can snooze until another card gets somewhere** (2026-10-17). Until then a release that
  waited for a fix on another card snoozed until a guessed time (an hour on), to look whether the fix
  was on main, and would have snoozed again if not; Obeya knew all along when that card landed. The
  states to wait for are the two another card's result shows in: done, or waiting for the owner
  (its demo to compare against, its question). Rejected: any change of the card's state (each
  start, handover and approval would wake the worker for nothing); a waiting card the owner sets up
  (the worker knows what it waits for, the owner should not have to wire it).
- **A question stands while background work keeps the turn open** (2026-10-16). Until then a card
  whose worker asked while its background work ran read „Frage an dich“ in its header, but the
  conversation showed only the agent at work: the question and its options stood only once nothing
  ran.
- **Refused and confirmed tool calls reach the card** (2026-10-09). Before, Obeya dropped the SDK's
  denials, and an `ask` rule refused the call silently, as there was nobody to ask.
- **Closing words fold under the message they repeat** (2026-10-09). Until then they were dropped
  after a handover or a finished card's follow-up and showed as a second message after any other
  reply. Until 2026-10-15 the steps between that message and the closing words stood below it as a
  message of their own with nothing but „Verlauf: 1 Schritt“, and a note's first words before a
  reply stood as a message of their own above the reply.
- **A demo report's question stays on its handover** (2026-10-09). Until then the question moved to
  the newest handover and stood there orange, as if open.
- **Agent words are kept long** (2026-10-09): until then a worker's were cut at 600 characters, so a
  last message ended in „…“. Until then too only the card's state said that the worker was at work.
- **The conversation shows things in the order the agent saw them** (2026-10-14). Before, a note
  went straight into the worker's session, which the CLI folded in at its next step, but Obeya
  learned only at the turn's end which messages a turn had taken (and the SDK cannot take one back
  but by a control request); the conversation showed every step of the turn in one bubble at its
  end, below the note, so the steps from before it stood after it.
- **Replies to a single message, as in chat apps** (2026-10-09), in Obeya's sheet too (2026-10-15):
  until then only a card's conversation had them. Since then the quote is part of the field's draft,
  and survives a reload; before, it lived in the page alone, one for all cards.
- **The task is the conversation's first message** (2026-10-08). Before, the task stood on the left
  as a section of its own („Auftrag“), open until there was a demo, and tasks were the only cards
  whose starting point was not in their conversation.
- **One layout for every card with a conversation** (2026-10-07). Before, a task stacked demo,
  buttons, feedback field and conversation in one column, and a demo with a question had a field and
  a Send of its own inside the question, with „Freigeben“ between it and the feedback field.
- **Screenshots reach agents as images in the message**, not as files for them to read: the agent
  sees the image without a step of its own. Until 2026-10-12 the thumbnails in the field did not
  open.
- **A spoken command takes the screenshots of the field it speaks to** (2026-10-12). Until then the
  microphone always had a store of its own, also beside an open card's field: a screenshot pasted
  into the field and then spoken about went out without it. Until 2026-10-15 a recording the page
  cut off by going away counted as failed, and the screenshots came back on the next load, to go out
  a second time with the next command. The fix then told a page that was leaving by its `pagehide`;
  in the owner's Chrome the screenshots still came back after a quick switch to another canvas and
  back (2026-10-16), so since then Obeya, not the browser's timing, says whether the command arrived.
  Until 2026-10-17 the microphone's screenshots hid when the sidebar opened, and those in the
  sidebar's field when it closed: to the owner they looked lost.
- **Marking without tools: the gesture decides** (owner, 2026-10-14): a free pen came out rough with
  mouse or trackpad, and a switch between pen, frame and number was one more choice each time.
  Frames got numbers like pins on 2026-10-15 (owner); until then only pins had them.
- **The worker gives the app's address; the link shows only while the app answers** (2026-10-16).
  Before, a card offered no way into its running app, and the owner who wanted to try the work by
  hand had to find the port. Rejected: Obeya finding the address itself from the ports the
  workspace's processes listen on (a stack in Docker listens elsewhere, and only the worker knows
  which port is the page); a mark on the card on the canvas (it is wanted rarely); starting a parked
  app from the link (that is the worker's, from the recipe, and the owner can ask it to). For a
  workspace on another machine only the reported address's port is forwarded (2026-10-16, owner):
  forwarding more ports would need the worker to name them, and would only help a page that names
  them if each kept its number here, where the stacks of clones here need them. Until 2026-10-16
  those workspaces had no `app_running` and no link.

## The canvas

The UI is a browser app, React + TypeScript, with a custom canvas: camera with fly-to,
unfold-in-place, semantic zoom, edge indicators, minimap, and a frosted top bar the canvas slides
under.

### The bar

The bar keeps no hint line: `?` (or the round `?` button beside "Neue Aufgabe") shows the legend of
mouse and keys as a box over the greyed page (`src/ui/help.tsx`), and Esc, `?` or a click beside it
closes it. The `?` button only teaches the key: opened by the button, the legend's foot says that
`?` opens it too and that the button goes once the key has; the first time the key opens it, the
foot says the button has gone, and it stays gone (per browser). Under its sections the legend has
the link „Wunsch oder Fehler melden“ (see Wishes for Obeya's makers).

Left in the bar, after the canvas switcher: the archive's button, the queue's and "Neue Aufgabe".
The queue's button counts the waiting cards (grey); a click lists them under it in turn, each with
what it waits for and the buttons that move it, and a row opens its card; a click beside the list or
Esc closes it. The archive's button lists the archive under it the same way (`src/ui/archive.tsx`).
The bar's buttons are all one height.

The bar's buttons always fit into it (`src/ui/barFit.ts`): narrower than its contents, beside a wide
sheet or in a narrow window, it gives up in steps the wordmark for the sign and the branch, then the
labels for icons a few at a time, then the pool and `?`, then all but the sheets'
buttons. Which
step is measured (the bar's right end within its padding) whenever its width or contents change,
because the same width holds a short branch or a long one and one machine's clones or three.

The logo (`src/ui/logo.tsx`: three cards in the inks of working, waiting and approved, "obeya" in
Newsreader SemiBold as outlines) opens the bar, stands alone in the middle while the page loads,
above "offline" when the server is gone, and is the favicon; `bun scripts/logo.tsx` writes it as the
files in `src/ui/logo/`, the app's icon source with them (`bunx tauri icon app/icons/source.png -o
app/icons` makes the rest; keep only the files tracked).

### Creating cards

Manual cards are created by double-click or `n`, and edited in the unfolded card; it opens with the
cursor in the text field. The title is optional (its field says so): a card closed or started with a
text or screenshots but no title gets one from Obeya (`Koordinator.name`, a short read-only session
of the „Kleine Aufgaben“ group; the text's first line when it gives none), before its start is
judged; until then the canvas shows the text's first line, muted. A title the owner types meanwhile
stands. A new card closed empty is dropped, and so is one left empty by a closed page, on Obeya's
next start. Deleting offers undo.

An empty canvas names speaking first (hold Space and say what Obeya should build; the card appears
where the pointer is on letting go), the double-click second; above the notes on the plan
directories, with a fixed space between (it follows them when the view moves). The bar's "New task"
button only teaches the double-click: it opens a note saying so with one "Got it", and goes for good
(per browser) once the owner has created a card by double-click, which keeps the bar uncluttered.

### Cards on the canvas

A card has one fixed size; a delivered workstream shrinks to a chip once its agent is done, a
project wraps its children, and a workstream cannot be dragged out of its project. New projects are
placed in a grid below the existing ones. A proposal or follow-up goes below the card it came from,
or, when something is in the way there (for a workstream: its own project), to the nearest spot
clear of every card and project. The dashed line from a proposal, follow-up or prototype to its card
joins the sides that face each other (left and right when the two stand more beside than above each
other) and runs above projects but below cards, so a line from a workstream stays visible over its
project.

On the canvas, a planned card and one waiting in the queue show a play button while the pointer is
on them; it starts the card (the queued one anyway) without unfolding it. While the pointer is on a
card, the waits around it show (see Scheduling).

### Moving around

A card dragged to an edge of the view scrolls it that way, faster the nearer the edge, but only as
far as the rest of the canvas reaches plus room to drop the card beside it; a card picked up at an
edge scrolls only once the pointer moves towards it.

Panning, scrolling and zooming stop where the view would show no card any more: a strip of the
nearest card (120 px, or all of a smaller one) stays in sight above the minimap, so the owner never
lands on an empty view and pans back without the minimap. A gap between cards wider than the view is
crossed by the minimap. When cards go or the window shrinks and none is left in view, the camera
flies to the nearest; the minimap and the overview key land next to content too.

The minimap sits in the bottom left corner, as in tldraw, clear of the sheets on the right. A click
on it flies there; a press that moves lets the view follow the pointer on the minimap until it is
let go, gliding after it so a press far from the view does not jump.

### Unfolding a card

Opening a card takes 300 ms: a 130 ms flight brings it to the middle, then it unfolds in 170 ms;
closing runs the same in reverse. Fast enough not to wait on, long enough to keep the context.

An unfolded card is as tall as its content, up to a limit per state beyond which it scrolls, and
follows its content while open. Where its bottom lies under the microphone, the content gets that
much room below it, so the last row (an idea's „Parken“, „Verwerfen“) scrolls up past the microphone
instead of staying under it. A task whose conversation stands alone is 640 px wide, the
conversation's widest, and otherwise sized like a split.

A card with a conversation beside what it is about (an idea, a proposal, a task an agent worked on
with a result) is up to 1600 px wide instead, the conversation a third of the width (400–560 px), and as
tall as its taller column, at least 320 px, up to the room from 12 px below the window's top edge
down to the microphone; it stands in the middle of the canvas (left of a docked sheet), above the
microphone, and keeps at least a conversation's 640 px beside a sheet dragged wide. Beyond that room
what the card is about and the conversation scroll inside their columns, the panel not at all; the
panel shows no scrollbar of its own. Only a window too low for a split of 320 px lets the panel
reach under the microphone and scroll. A proposal's text box grows with its text up to the room
that leaves the reason below it in view, then scrolls. A card stands below
the top bar while it fits there; one that needs more room reaches over the bar, which the dim covers
while a card is open anyway, up to 12 px below the window's top edge.

### Sheets

The sheets on the right (Obeya's, a project's, a plan doc being read) are a sidebar docked to the
window's right edge, from top to bottom: a straight edge with a divider line, no shadow, no gap. A
sheet's heading keeps clear of the button in its top corner. Obeya's is headed only "Obeya", as its
button is named. The canvas is what remains to its left: the top bar ends at the sidebar, the
microphone with its lines and the confirmations above it, the edge indicators, the minimap's frame
and an unfolding card all keep to that rest. Opening a sheet moves the view left by half the sheet's
width, so the middle of the view stays its middle; closing it or dragging its edge moves it back by
as much (`besideSheet`). A card opened beside a sheet goes back to its view beside whatever sheet is
open when it closes; a project's sheet stays while one of its cards is open, under the dim. A window
up to 760 px wide lays the sheet over the canvas instead.

Obeya's button, a speech bubble with its counts, is the bar's rightmost; while its sidebar is open
the button stays where it was and becomes the sidebar's top corner, closing it again. Opening and
closing only change its colour: it is one element fixed over the room the bar keeps for it, never
moved into another parent. The other sheets have a ✕ there.

Esc closes any of the sheets, from a text field in it too, as from a card's field; a field being
edited (a preference, say) takes Esc first, to cancel the edit, and says so with a `data-esc`
attribute, which the canvas's key handler steps aside for. With a card open beside a sheet, the
first Esc closes the card, the second the sheet.

The sheets are as wide as the owner drags their left edge: one width for all of them, and one for
reading a plan doc, which follows the window until dragged. The browser remembers both; the canvas
keeps 240 px beside the sheet, and the camera keeps a project beside it; a double-click on the edge
goes back to the default.

### Visual identity

Index cards pinned to a wall, so that nobody takes Obeya for the stock AI-generated interface.
Everything is in `src/ui/styles.css` (the PTT panel's window repeats the tokens in `panel.css`).

- *The card*: off-white card stock (`--card`) on a warm board (`--bg`, dotted), corners nearly
  square (2 px), a short hard shadow instead of a soft blur, and the state as a rule across the top
  in its ink (4 px; 3 px on a chip; 8 px zoomed out, where the title also grows, so the state reads
  as a band from afar). No ruled lines. The owner's turn is an orange frame and a pushpin with "!"
  that pulses; an idea is on rose-tinted stock; a proposal is only pencilled in (a dashed outline,
  no stock); a queued card's rule is dashed; done and live cards fade and go slightly yellow (not
  while their agent still works after the landing: then only their state line is in the working ink,
  with the moving line). Under the pointer a card lifts a little; dragged, it tilts as if held in
  the hand. The moving line beside "at work" is a pencil stroke drawn again and again.
- *Inks* (light / dark): planned `#a0978a` / `#8a8274` pencil grey; working `#1d5fe0` / `#5b95ff`
  clear blue; waiting for the owner `#f27405` / `#ff8a1c` strong orange (frame, pin, pulse, every
  count of what waits); approved `#3d9a1f` / `#78c448` yellow-green; in PR `#08888e` / `#27b9b6`
  petrol; proposal `#7b4fd6` / `#a587ff` violet; idea `#dc2f5e` / `#ff6289` madder red; live and
  done `#b4ab98` / `#5f594e`. Failures `--error`, cautions `--warn`; what is written on a fill of
  ink (a badge, the play button) is `--on-ink`, white in light and near black in dark. Dark mode is
  black card stock written on in white pencil: its inks are as far apart as in light (blue and green
  never confusable, orange the loudest).
- *Light or dark*: as the system, until the owner chooses Hell or Dunkel under Allgemein in the
  Konfiguration dialog (three buttons side by side, the choice `theme` in `settings.json`,
  `/api/theme`). The page asks for it before its first render, as for the language, and sets
  `data-theme` on its root, which the stylesheets (`styles.css`, `panel.css`) read beside
  `prefers-color-scheme`; a choice applies at once, without loading again (`src/ui/theme.ts`). The
  PTT panel asks again each time the key is held, as it stays open while the app runs.
  `color-scheme` follows the look, so native controls and the pages in a frame (a worker's HTML
  artifact, a mock) take it too. The site and the shared demo pages keep the system's.
- *Type*: titles and headings in Newsreader (a serif with optical sizes; a plan doc read in the
  sheet is set in it too), everything else in IBM Plex Sans Condensed. Both are under the SIL Open
  Font License and served from `src/ui/fonts/` with their licence files (latin subsets from
  Fontsource); Google Fonts is not loaded. Code stays in the system's monospace.
- *Carried through*: pills, menus, the panel, the sheets, dialogs, buttons and fields use the same
  palette and type and the same nearly square corners (3 px, 4 px for project frames), with the
  cards' hard shadow, but no paper texture of their own. An unfolded card keeps its rule across the
  top. Dots, the microphone, spinners and the pin stay round. The site and the shared demo pages use
  the same palette and type.

### Groups on the canvas

Each group shows as a territory behind its cards (`src/ui/groups.tsx`, `src/ui/territory.ts`): a
soft, slightly glowing outline over a faint area in the group's colour, with a dotted line inside
along the cards. Group colours appear only there and in the minimap, never on a card, so they do not
compete with the states' colours. Zoomed far out, the groups' names stand pale over their
territories.

A territory is the contour of an energy field (Bubble Sets): the group's cards pull, near cards are
linked so they share one territory (not across another card), and every other card pushes back;
where two groups meet, the stronger holds the ground, which makes a card amid another group an
island. Of the cards' pull only the strongest counts at each point, not their sum, and the narrow
gap between two cards facing each other pulls like a card: summed, the edge bulged out over every
gap. A card's pull is squeezed on a side that faces another card across a narrow gap, so the edge
runs along the gap's middle the whole side long and turns round there: pushed back only near the
other card, it hung down beside it as a tip at the corner.

The browser computes it with `d3-contour`, each group on its own grid around its cards on one 16 px
lattice, resamples each contour evenly and smooths it with a Gaussian (σ 20 px), so corners come out
round and even rather than with the grid's facets and the kinks where territories meet, and computes
a group's field again only when something within its reach moved, its contour only when its own or a
neighbour's field changed; one that took longer than 8 ms makes the next wait, so a dragged card
keeps the frame rate and its territory follows a little later. At rest nothing is computed and
nothing moves. Measured in headless Chrome on 100 cards in four groups that all overlap
(2026-10-05): the first computation 21 ms, a move that changes all four 5 ms (median; 14 ms at
most), dragging at 60 fps, nothing at rest.

When cards change group, wherever the change comes from (the colour ring, the Koordinator, another
page), a wave runs out from where it was assigned (else from the cards' middle), reaches the cards
one after the other, and their territory springs out a little too far and settles; a light runs once
along the new edge. The wave is over in 0.9 s: see the decision on large animations below.

Assigning: Shift + drag on the canvas draws a lasso (without Shift it pans as before), a right click
on a card takes that card (a workstream: its project); either opens a ring of colour balls at the
pointer with the groups, "+" (a new group, named in place) and "∅" (none). Each group's name stands
outside its ball, so all show at once, with how many of its cards are still to be done (not
finished, archived or a dropped idea; a project counts by its workstreams): a group at 0 goes pale,
a candidate for deleting. Behind the ring and the names the canvas steps back under a frosted halo
that fades out at its edge, so they read on a busy canvas. While the ring is open the canvas behind it holds
still: its endless animations (the selection's drifting dashes, a working card's line) pause. Moving towards a ball or onto its name
picks it, a click takes it, Escape closes the ring. The picked group's name carries a ×: it deletes
the group (its cards, archived ones too, belong to none), and "Rückgängig" brings it back in its
colour with the same cards.

By voice, the Koordinator's `group` (cards into a group by name, a new name creates it), `ungroup`
and `rename_group`; it sees each card's group and the canvas's groups. The API: `POST
/api/c/<canvas>/groups` (name and first cards, a colour when one comes back; a name a group has
already takes that group), `PATCH …/groups/<id>` (name), `DELETE …/groups/<id>` (returns the group
and its cards), `POST …/assign` (cards and a group, `null` for none); the snapshot carries the
groups, every card its group.

### Refusals

The server words no UI text for refusals: it answers `{ code, error }` with a stable code
(`ErrorCode` in `src/core/types.ts`) and an English detail, for developers, and log entries of a
failed start carry the code too. The UI shows its text for the code from `src/ui/strings.ts`, a
generic one for anything else.

### Decisions

- **The look is the index card** (2026-10-10). Two prototypes were built side by side: the index
  card and a Swiss editorial card (a square black frame, a solid state band, Schibsted Grotesk),
  which was sharper from a distance but closer to a known designer style. A seal (a kanji stamp for
  the state) and a kanban ticket (ruled fields, a punched hole) were not pursued. The index card's
  ruled lines were dropped, and its inks made clearer than its first version's fountain-pen blue and
  bottle green, which stood too close together. Before, a card was a white box with 14 px rounding,
  a soft two-layer shadow, a 5 px state stripe down its left, all set in Inter, with Tailwind's
  default colours for the states.
- **Groups show as contours behind the cards, drawn in SVG**, rather than a WebGL shader
  (2026-10-05). Three prototypes were built: a shader with waving "plasma" areas, one with
  territories and a drifting honeycomb, and contours. All ran smoothly at about 30 cards; the owner
  chose the contours, which are calm, need no WebGL and cost nothing at rest, over the shaders'
  livelier look, which costs frames all the time. The territories animate only when something
  changes.
- **Nothing on the canvas animates a large area for a second or longer** (2026-10-15). Chrome's
  screen capture (a demo's screencast, a shared tab) locks onto a large area that changes every frame
  for about a second; once it stops, the capture drops every other change for about 0.27 s, while
  the window itself keeps drawing. On the hero video's canvas that left two gaps of 267 ms in the
  recording: when the ring closed (the selection's dashes drifting under the halo made its blur
  render again every frame) and when the wave ended (then 1.5 s). Now the canvas holds still behind
  the open ring and the wave lasts 0.9 s. Dropping the halo's blur would also have closed the first
  gap, but left the cards' text readable behind the ring's names.
- **A group ends with its last card**: it is made by putting cards into it, so there is never an
  empty group to clean up. Deleting one ends it at once by taking its cards out, for a group whose
  last cards sit in the archive, out of reach of the ring (2026-10-06).
- **Placement and lines** (2026-10-05): a proposal or follow-up finds the nearest free spot when its
  own place is taken; the dashed line to its card joins the sides that face each other and runs
  above projects but below cards.
- **Edge scrolling and the panning limit** (2026-10-01): a drag scrolls only as far as the canvas
  reaches, and the view never lands on emptiness. The minimap follows a moving press (2026-10-06).
- **The `?` and "Neue Aufgabe" buttons only teach** (2026-10-15). Until then the `?` button stood
  there always, and "Neue Aufgabe" created a card in the middle.
- **A card's title is optional** (2026-10-15). Before, a card needed a title, the cursor started in
  the title field, and a card closed without a title was dropped with its text.
- **Archive, queue and "Neue Aufgabe" sit left in the bar** (2026-10-09). Until then the queue was a
  section of the Koordinator's sheet, counted on Obeya's button, and the archive's button sat on the
  right.
- **The bar measures what fits** (2026-10-12). Until then two container queries on the bar's width
  chose the step, and a long branch, a large pool or a restart's notice pushed the buttons past the
  bar's end under Obeya's button and the sheet.
- **An unfolded card is as large as its content, up to the room it has** (2026-10-08). Before it
  filled that room, with empty space below a short conversation and a short brief on a large screen,
  and a scrollbar stood at the panel's right edge whenever the content came out a few pixels higher
  than the panel. Before it filled the room it stayed at 1120 × 880 px with the columns 600 px high,
  small on a large screen. Since 2026-10-09 a card may reach over the bar: before, the bar's 64 px
  stayed free, which cost a card on a window of moderate height much of its room.
- **A proposal grows with its conversation too** (2026-10-21). Before, only its text and questions
  set its height (up to the screen's), and the conversation filled that height and scrolled in it:
  a proposal with a short text and a long conversation stayed small with a scrollbar beside unused
  room on a tall screen.
- **The sheets are a docked sidebar** (2026-10-06, 2026-10-09). Before, the sheets were rounded
  panels with a shadow floating 14 px from the window's edge over a full-window canvas: cards were
  cut off at their edge, and the microphone and its lines stayed in the window's middle, partly
  under them, so a sheet wide enough to reach the microphone ended above it and its height jumped as
  it was widened. Obeya's button becomes the sidebar's corner (the owner's wish): before, closing
  put it back into the bar, which still ended at the sidebar, so it showed up left of it and slid
  right with the bar. Until 2026-10-12 Obeya's sheet was headed "Obeya" over "Planung und
  Präferenzen", which ran under the button. Until 2026-10-14 Esc left Obeya's sidebar open and did
  nothing in any sheet's field. The sheets' width is dragged (2026-10-02).

## Agents and workspaces

### Agents

Claude on the owner's subscription, no API billing, through the Agent SDK: it runs on the Claude
Code login of the machine (tested without an API key: `apiKeySource: none`). From the checkout it
runs the Claude Code binary the SDK brings for the platform (its optional package, 224 MB); the
compiled binary carries none and runs the machine's own installation (`claude` on the `PATH`, else
`~/.local/bin`, where the official installer puts it); `OBEYA_CLAUDE` names another. Both ran
workers and the Koordinator in the binary on macOS, Windows and Linux on 2026-10-07 (the SDK 0.3.285
with its Claude Code 2.1.285, and the installed 2.1.292). Agents get Obeya's environment without the
marks of a Claude Code session that may have started it (`CLAUDE_CODE_*`, `CLAUDECODE`,
`CLAUDE_PID`) and of Obeya's own supervisor (`OBEYA_SUPERVISED`, `BUN_BE_BUN`), but with
`CLAUDE_CODE_OAUTH_TOKEN`, the login of a machine without a keychain.

A worker is one SDK session per card with streaming input, the repo's own settings and CLAUDE.md
(Claude Code's settings sources left as they are; a repository whose own Claude Code configuration the
owner has not trusted yet gets none of it, see Trusting a repository's commands),
and permission mode `auto` (`--permission-mode`); after a restart it resumes by session id. A
project agent is one session per project on the repository's Lesestand, resumed for each question,
answering the owner's questions about the project and its workstreams one at a time. It, ideas'
exploration agents and the Koordinator's look-ups have a worker's tools in the workers' permission
mode (see Looked-up questions); the other agents that only judge or answer from the text (the quick
reading of commands, estimates, the learner and the like) are read-only: Read, Grep and Glob, mode
`dontAsk`. The SDK sits behind a small runtime interface, so the orchestration is tested against a
fake.

Two SDK hooks ride on every session: before a Bash call, the refusal of long foreground sleeps;
after every tool call, what changed since the session's instructions were built
(`AgentSpec.contextUpdate`) goes to the agent with that call's result; not with a subagent's calls,
whose results the agent never sees. Workers and idea agents use it for the owner's preferences: a
preference learned or changed while one runs reaches it once, at its next tool call, without a
message or a new turn. A workstream's worker hears its project's new decisions the same way (those
on its own card it heard as answers), and the owner's notes that came during its turn (see Reading
order). A worker's session also has `canUseTool`: a call the settings want confirmed becomes the
question its card waits on (see Refused and confirmed tool calls). Its own Obeya tools run without
asking through a `PreToolUse` hook that allows them.

### Models and effort

Every agent belongs to one of four groups, each with its model and effort: the Koordinator (voice
commands, estimates and schedules, look-ups, project agents, learner, Rückschau, proposal rewrites),
the workers on cards, the exploration agents of ideas, and small jobs (the Arbeitsrückschau's notes
and proposals, the text of a shared demo's page, a card's title). The owner chooses both in the
Konfiguration dialog: the model is Claude Code's default or one of its aliases (Fable, Opus, Sonnet,
Haiku, each the newest of its family), the effort always a fixed level (low to max). Preset
(`AGENT_DEFAULTS`) is Opus for every group, with high effort for workers and exploration agents,
medium for the Koordinator and small jobs; the sheet marks the presets.

The choices live in `settings.json` under `agents`, only where they differ from the presets
(`src/server/settings.ts`); every session names its group (`AgentSpec.role`), and `withAgentSetting`
(`runtime.ts`), which wraps the canvas's runtimes, asks for the group's setting at each start.
Saving restarts nothing and takes effect for every agent that starts afterwards; a session at work
keeps what it started with, except the voice commands' session, which is opened anew once the
Koordinator's setting changed, as it is for another language.

### Workspaces

Per the repository's settings, worktrees unless they say clones. A pool of full clones leased by a card while it is
worked on (for a repository whose tools break inside a worktree, or that runs its own app stack per
clone), or a worktree per card (Obeya itself: any number in parallel unless the repository has
`slots`), kept across stop and restart until the card's work has landed and its worker has finished
what remains after it. Clones come from the
repository's `clones` or `workspaces` in the configuration, or on the command line from `--workspace
<path>` or `--clones <n>`; a repository whose configuration names clones (these, or `hosts`) works
in clones whatever its settings say.

#### Slots

A repository's workers in clones are capped by slots, not by clones: a slot is room for one busy
worker (in a turn, or waiting for its background work), and a machine has a number of them (`slots`
for this one, per host for the others; as many as it has clones when left out). A new card takes a
clean free clone on the first machine, this one first and then the hosts in the configuration's
order, whose busy workers leave it a slot; with none, it waits in the queue for a slot (`workspace:
'slots'`, "Wartet auf freien Slot") and starts once a turn ends somewhere. A card holds its clone
until its work lands, but a slot only while its worker is at work: waiting for the owner it holds
none. A message to a waiting card is never held back for a slot, so a machine may go over its slots
for a while when the owner answers several cards in a row; the owner's question to a finished card
takes a clone on a busy machine when no machine has a slot. Slots count per repository: two
repositories on one machine each have their own.

A repository in worktrees can have slots too (`slots`, in the Konfiguration dialog under its row): a
new card makes its worktree only while fewer of its workers are busy, else it waits for a slot the
same way; left out, any number work at once.

#### A finished card's question

The owner's question to a finished card does not wait for a slot, nor for a clone. A clean free
clone is its first choice (full tooling); with every clone leased or the free ones dirty, it runs in
a temporary worktree (`followUpTree`): detached at the head of the card's branch, made the way the
Lesestand is (hooks off) from the clone on this machine that holds the branch, else from the
configured checkout at `origin`'s copy of the branch or at the default branch; under
`follow-up/<card>` in the repository's workspaces directory, in no pool and taking no clone, and
removed (with `git worktree prune` in its clone) once the follow-up ends.

Its worker is told the repository's app stack and tooling may not run there; if answering needs
them, it calls `need_clone`, tells the owner with `reply` and ends its turn: session and worktree
end, and the card waits without a workspace for the next clean free clone, its status line „Wartet
auf Workspace“ (it counts in the pill with the cards waiting for a workspace). The Koordinator's
drain gives it the next one, before the queued cards (`leasable(true)`, then `takeClone`), and its
session resumes there by itself; what the owner says meanwhile waits for that message.

#### The pool in the bar

For each repository that uses clones, the top bar shows the pool ("Workspaces"): per machine, named
once there is more than one, a dot per clone, solid while its card's worker is at work and pale
while the card holds it otherwise, and how many new cards could start now ("2 frei" or "alle
belegt"); over it, each machine's slots at work and clones taken, the cards that hold one (those at
work first), and how many cards wait for a workspace or a slot. The snapshot carries the pools
(`workspaces`, by machine): leases change only with a card, and a worker's turn starting or ending
changes the board, so they ride on its updates. Worktrees are never short: a repository in worktrees
shows a dot per slot, solid while a worker is at work, and none without slots, so a canvas of only
those without slots shows no pill.

### Folders without git

A repository on a canvas may be a folder that is not a git repository and is to stay one: a
family's document archive in a cloud drive, say, where a `.git` would mean sync conflicts and
thousands of small files, and git would copy every scan into its object store and every card's
worktree. Its entry in the configuration says so (`"git": false`, `RepoConfig.git`); the first
canvas and „+ Repository“ offer it beside setting up git (see Setting up git in a folder). Such a
repository has no branch, no landing, no pull requests, no prototypes, no hosts and no clones; the
UI offers none of them there (the configuration dialog shows neither main branch nor landing,
workspaces, clones, slots or hosts, and „Für alle ins Repository übernehmen“ is left out: the
folder's `.obeya/settings.json` is written there like any other file).

**Workspaces.** `FolderWorkspaces` (`src/server/folder.ts`) gives every card the folder itself, any
number at once; nothing lands, and approving makes the card `done` („Freigegeben. Die Änderungen
bleiben im Ordner: erledigt.“), as for a card with nothing to land. A finished card's question runs
in the folder too. The worker's instructions say it works directly in a folder others work in at the
same time, and that the card lists what it changed; a handover needs a demo only where something
can be seen (an HTML artifact for a draft or an overview), since the change list shows the rest.

**Each card's changes.** Obeya keeps a manifest of the folder (each file's and directory's path,
size, mtime, ctime and inode; skipped: what Finder, Drive and office suites keep for themselves,
`.DS_Store`, `.tmp.drive*`, `~$…` lock files and the like). Every tool call of a card's agent that
may write (not Read, Grep, Glob and the like) opens a window from its `PreToolUse` hook to its
`PostToolUse` hook (`AgentSpec.watch`, waited for: the agent goes on once its change is recorded);
then Obeya reads the folder again and gives each change to the cards whose windows were open when it
happened, by its ctime, which no tool sets (a deleted file by its directory's). So a change is a
card's own even while other cards, the owner, a scanner or the sync client change the folder at the
same time; a change outside every window is no card's. A window opens at the time as the file
system stamps a ctime, read off a file of Obeya's own written then: Linux stamps it from a coarse
clock up to a tick (1 to 10 ms) behind the system's, and by the system's time a change right after
the window opened would have come before it. Before the window opens, the folder is read
too, so what the owner changed just before is not the call's. An editing tool (Edit, Write,
NotebookEdit) takes only its own file (through a link, the file it points to), and the folder is
read only there; a script's call reads all of it, before and after (on the owner's document folder,
4,615 files: 0.3 s; 45,717 entries: 0.5 s). A change that happened while calls of two cards ran
cannot be told apart: both cards list it, and neither undo touches it. Background work keeps a window open while it runs;
the end of a turn closes any window whose end the hooks never told. A file only in the cloud (a
dataless file of a file provider: no blocks on disk) is never read, hashed or copied, which would
download it. What a card changed is one entry per path, from before its first change to after its
last (added, changed, moved, deleted; a moved directory is one move), with a hash of what it wrote;
kept in `folder_cards`, and after the card is done too. Agents that only read (the Koordinator,
project agents) are not followed.

The card shows the list in the place of its branch („Im Ordner geändert: 4 Dateien +12 −1 ·
Rückgängig: vollständig“) and below it beside the handover (↪ moved, ＋ added, ✎ changed, ✕ deleted),
and „Ansehen“ shows it over the page with the diffs of text files whose earlier version Obeya kept
(`git diff --no-index`; a file counts as text up to 1 MB without a NUL byte in its first 8,000).

**Undo.** „Änderungen verwerfen“ on a card waiting for approval puts back what it changed, after
eight seconds in which the button counts down in itself („Änderungen verwerfen 7 s ×“, the × in red,
„Noch einmal klicken bricht ab“ beside it) and a second click calls it off: putting files back cannot itself be taken
back. Before a card's first call that may write, Obeya makes its undo ready under its home
(`undo/<canvas>/<repo>/<card>`):

- where the file system clones (APFS `clonefile` on a Mac, reflink on btrfs and XFS; probed by
  cloning one file with `COPYFILE_FICLONE_FORCE`), a clone of the whole folder: it shares the bytes
  until a file changes (measured on the 8.1 GB folder: 0.86 s, no space taken, 0.39 s to remove), so
  it grows only by the old versions of what changed meanwhile. The card's undo is full.
- where it does not (Obeya's home on another volume, NTFS, ext4, and so far Windows' ReFS and Dev
  Drive, which Bun reaches no clone call for), copies of the folder's text files. The card's undo is
  partial.

Either way, an editing tool's file is copied just before it writes it the first time. Undo puts back
only what the card changed, from the copy that matches the file as it was before the card's first
change (size and mtime): added files are deleted, changed and deleted ones put back (written beside
and renamed over), then moves moved back, so a directory the card moved takes back what the card
changed in it. Left alone are a file someone changed after the card (its ctime and inode are no
longer what the card left, and its hash where Obeya read it, else its size and mtime, differ), one
no copy was kept of (a script overwrote or deleted it under a partial undo), and a change two cards'
calls shared; the card's log names them, its list keeps them, and its worker hears what happened
with its next message. The card says which undo it has, and each entry of its list what discarding
would do with it, before the owner decides. The undo goes when the card is done or its changes are
discarded (and is made afresh if its worker goes on).

**Lesestand and settings.** The folder is its own Lesestand; its plan docs and `.obeya/settings.json`
(and its Claude Code configuration, for the trust check) are read from it as they are
(`isFolder`, `readSharedFiles`). A plan doc „Als Projekt planen“ writes is named at the start, as
for a plan folder outside the repository: nothing of it lands.

### Parking

A card that waits for the owner (handed over, asked, its pull request open), its worker without a
turn or background work, has the app in its workspace stopped after a grace of five minutes
(`OBEYA_PARK_GRACE` in seconds for a demo or a live check; a quick reply should not pay for a
restart): Obeya runs the settings' `app.stop` there through the platform's shell
(`src/server/app-command.ts`; one from the repository only once the owner trusted it, see Trusting
a repository's commands), unless `app.keep` exits 0 (the app holds data that must stay; the
card says it keeps running, and the owner who wants it stopped anyway tells the worker). An app the
owner opened from the card is stopped no sooner than 30 minutes after (see Trying the app by hand).
The card's log says the app was stopped (`parked` on the card's row); the next message to the worker carries a
line that it was, telling it to start it again as the recipe says, and clears it. A message that
arrives while the stop runs waits for it, so the worker cannot start the app only to have it
stopped. A stop that fails is an
error on the card, and the worker hears nothing. After a restart, waiting cards are parked the same
way. The workspace stays the card's; only its processes go.

### Hosts

Other machines a repository's workers run on, reached over SSH (`src/server/hosts.ts`). The
configuration lists them per repository (`hosts`: name, SSH target, the directory there that holds
the clones, how many, how many slots), and the Konfiguration dialog edits them under the clones, one
table row per machine, as the Koordinator's `configure` does by voice; only a repository that works
in clones and lands through its remote can have them (`hostRepo`), and a name stands for one machine
across the configuration (`hostName`). Obeya clones the repository there itself in the background
(an unreachable host is tried again every two minutes; the log says what went wrong once, and again
only when that changes or the clones are in place) and registers each clone as the workspace
`ssh://<host>/<path>`; a new card goes there when the machines before it have no slot (see Slots).

#### Running there

A workspace's name says where it is, so every git call in it (`git`, `gitAsync`, `exists`), the
stack commands and the worker's session run there through `ssh` without the callers
knowing: `ssh <target> exec sh -c '…'` with the installers' directories on its `PATH` (the host's own
`~/.zshenv` adds the rest; `exec`, so a login shell that forks for a command, as dash does, does not
stay as the session's parent with another pid), one shared connection where the platform has `ControlMaster` (not
Windows; its sockets in `/tmp/obeya-ssh-<uid>`, the owner's alone, since whoever reaches a socket
uses its connection), `BatchMode` so nothing prompts, and keep-alives that notice a dropped link within 45 s.

The calls the server waits for (`git`, `exists`: looking for a clean free clone, a card's changes)
block it, and ssh gives up on a host that does not answer only after seconds (5 s for a `.local`
name it cannot resolve): once a connection to a host has failed, these fail at once instead, the
host counting as unreachable, and a call 30 s later or after has it asked again in the background;
when it answers, the board counts as changed, so cards waiting for a clone look again. The calls
that do not block go out as ever, and their answers say whether the host is back.

#### Logins and files

Nothing secret is stored there: the repository's GitHub login (what `git credential fill` gives in
its checkout here, so the account its own configuration picks) and the Claude login (`claude-token`
in Obeya's home, from `claude setup-token`) travel as the first line of stdin of each command and
session, and the clones' credential helper reads `GH_TOKEN` (with an empty helper before it, so
macOS's keychain does not keep it). The clones are marked trusted in the host's `~/.claude.json`,
since nobody answers the folder dialog there and the repository's own permission rules would not
apply.

The session is the Agent SDK's `spawnClaudeCodeProcess`: Claude Code started through `ssh` in the
workspace, with Obeya's tools and hooks over its stdin and stdout as here (checked on the owner's
second MacBook, macOS x86_64, 2026-10-09). Before a host's first session in a run of Obeya, the
plugin and the `playwright-core` its demo skill imports go to `~/.obeya/remote` there (again only
when they changed), with the owner's demo settings (the voice reference as a path here, without a
key file), and the session gets that directory as `OBEYA_HOME`. `OBEYA_URL` is a port there
forwarded (`-R`, one per session) to a server of Obeya's that answers narration clips and nothing
else (`serveNarration`, its address the workers' `OBEYA_NARRATION_URL`), since everyone on that
machine reaches the port: forwarded to Obeya itself, the port let anyone there run commands here
through its settings until 2026-10-16. A narration clip comes back in the reply (`inline`, base64,
the only kind that server takes) instead of a file on Obeya's machine: the owner's own voice, which
only this Mac can run, narrates demos rendered there.

Files cross at fixed points: the owner's screenshots are copied to `~/.obeya/remote/images` there
with the message that carries them, and the message names them by their paths there; a demo named in
a handover is copied here (`<home>/hosts/<host>/<path>`), afresh at each handover, and served and
shared from that copy (a path with `.` or `..` in it is refused: the copy replaces what is at its
place, and `/../../..` was the owner's home); the Arbeitsrückschau reads a session's transcript from there. gh on a pull
request runs here, on its URL.

#### A dropped connection

A dropped connection (ssh's exit code 255), or a host that cannot be reached to get the plugin
before the session starts, ends the session as a restart does (`lost`): the card says so, Obeya
asks every 30 s whether the host answers, then resumes the session by its id with the message it
had not yet taken, or with word of the drop if it was at work (a session that never started there
has no id: a new one starts with the message it was to begin with); a card waiting for the owner
needs no session until their next message. The session that resumes ends the one the drop may
have left running there first (by the pid it wrote; never itself, as a host that restarted since,
a container say, gives out the same pids again).

What a host needs installed: git, Claude Code and what the repository's own work needs (for the
owner's work repository: .NET, Bun, Node, uv, Docker, Chrome, ffmpeg); Homebrew no longer serves
Intel Macs, so those went into the user's home there by their own installers.

### Decisions

- **The installed app runs the machine's own Claude Code**, not the binary the Agent SDK brings
  (2026-10-07): that one would add 224 MB to every download, put Anthropic's proprietary binary into
  an MIT app and keep its version until the next release of Obeya. The two may drift apart in their
  protocol; it held with every version tried, and the setup assistant names the version Obeya was
  checked with.
- **Obeya's tools are allowed by a hook** (2026-10-10): as bare `allowedTools` they had the SDK
  print a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning with a stack trace into Obeya's log at every
  worker start.
- **Workers run on more than one machine, capped by busy workers rather than by workspaces**
  (2026-10-10). Measured on the owner's Mac (M4 Pro, 48 GB), 1–8 Oct 2026, on the canvas of their
  work repository: workers were in a turn for 74 of the 963 worker-hours they held a workspace (8
  %), at most 8 at once, and busy work beyond 3 at once came to 17.6 worker-hours in 5 working days.
  The 5–9 held clones each kept their app stack running, which filled the 48 GB and a 20 GB swap;
  the Claude Code processes took 2.3 GB in all. So a waiting card stops its stack (parking), a
  machine counts slots for busy workers, and a card that finds none here goes to another machine
  over SSH (the owner's second MacBook first), where it stays until its work lands, since its
  workspace and its session live there. Nothing secret is stored on such a host; the logins travel
  with each command. Until 2026-10-10 the clones were the only cap, and a card went to another
  machine only once every clone here was leased; until 2026-10-09 a waiting card's stack ran until
  someone stopped it by hand.
- **Worktrees by default** (2026-10-14). Until then Obeya's defaults (then the generic adapter),
  and so every new canvas of a repository that did not say otherwise, used clones; a canvas set up then has `clones` in its
  configuration and keeps them. Until 2026-10-14 nothing capped the workers of a repository in
  worktrees.
- **A finished card's question takes a temporary worktree when no clone is free** (2026-10-15).
  Before, the question failed with an error when no clean clone was free, and nothing waited.
  Rejected: queuing every such question at once (clones are often held for days by cards in review
  or in a pull request), and answering in the Lesestand (other agents read there at the same time).
- **A folder may stay without git** (2026-10-20): a document archive in a cloud drive (8.1 GB, 4,615
  files, 2,289 of them PDFs, 327 plain text) cannot take a `.git` without sync conflicts and copies of
  every scan, so the only offer, setting up git, ruled it out. Cards work in the folder itself, several
  at once with the Koordinator's overlap check on files and directories; each card's changes are told
  apart by the ctime of what changed during its tool calls; undo is full from a clone of the folder
  where the file system clones, partial elsewhere. Rejected: a shadow git outside the folder (it copies
  every file into git and the whole folder into each card's worktree), and a copy per card applied on
  approval (cheap only where cloning works; working in place in parallel was chosen).
- **An unreachable host fails fast** (2026-10-12). Until then each look for a free clone asked an
  unreachable host twice per clone there, with five clones there almost a minute in which Obeya
  answered nothing, at every change of the board while a card waited.

## Landing

### How work lands

In a folder without git nothing lands: what a card changed is in the folder already, and approving
makes the card `done` (see Folders without git). Elsewhere:

As the repository's `.obeya/settings.json` or the owner for this machine set it (see Repository
settings), read at each approval:

- `pr`: approval leaves the branch for the PR loop.
- `main` (Obeya): approval rebases the branch onto `main` and fast-forwards the Obeya checkout; the
  card is `live`.

A card whose own branch changes `land` or `direct` in `.obeya/settings.json` (the card that sets up
the settings, say) lands as its branch says, unless the settings for this machine say otherwise
(`landingOf` in `src/server/workers.ts`): the owner approves the change with the work, and answered
in that card how work lands. The handover records it (`lands` on the card), so the approve button
says so before the click. Where the branch has the work go out as a pull request in a repository
that lands on main, the canvas watches the repository's pull requests from the moment the worker
reports one.

Where the settings do not say, it is detected (`detectedLand` in `src/adapters/index.ts`): `pr`
where `origin` is on GitHub, else `main`. On GitHub means github.com (or a subdomain of it) or a host the GitHub CLI is logged into,
read from its `hosts.yml` (`ghHosts` in `src/server/repo.ts`, where gh keeps it on each system)
rather than asked of `gh auth status`, which checks each login over the network. A repository on
another forge (GitLab, Codeberg, a server of its own) lands on its local main and pushes nothing,
unless its settings say `pr`: Obeya follows pull requests on Forgejo and Gitea too (see Watching the
PR), but whether a repository's agents can open one there only its own tooling says.

Commits that conflict one by one but not as a whole land squashed into one commit. The last commit
that lands for a card with a shared demo names its page in a trailer (`Demo-Video: <url>`, see
Publishing on approval). Uncommitted work
or a real conflict sends the card back to its worker with the approval kept: its next handover (no
new demo needed) lands on its own.

`pr` with `direct`: an approval "Direkt auf main" (`approve(card, { direct })`, refused with
`noDirect` where the settings lack `direct`) lands in the card's clone or worktree instead of a PR
(`pushToMain`): fetch, rebase onto `origin/<default>` (squash as above), `git push origin
HEAD:<default>`, never forced. A push turned away because the default branch moved meanwhile is
fetched, rebased and pushed once more; any other refusal (a protected branch, missing rights) stays
with the owner (`landPush`), the card back in review. Conflicts and uncommitted work go back to the
worker with the approval kept as above; since only a direct approval is held where work goes out as
a PR, its next handover is pushed directly too. The Obeya checkout is left alone; the read tree is
refreshed and plan docs the card adds are registered, as after a merge. The worker hears that its
work is on main, as after a landing. The settings' checks run before the handover as always; Obeya
does not watch the CI on the default branch.

Landing runs git without blocking the server (`gitAsync`): fetch, rebase and push take seconds over
the network, in which the page, the workers and the other canvases go on being served. Landings of
one repository run one after the other, so two approvals at once do not race on its main; a card
whose work is landing refuses another approval (`notReady`), and a restart of Obeya waits for it
like for a worker in the middle of a turn. The approval's answer still waits for the landing, and
its refusals (`landPush`, say) come back as before.

The click ends the owner's turn at once: Obeya records the approval (`approved_at`) before it lands,
and the card, still `waiting`, is `landing` (“wird freigegeben …” in the approved colour), no longer
counted in "brauchen dich" nor reached by Tab. A refusal, or a restart that cut the landing off,
gives the card back to the owner. Tab goes on from the card it opened last by its place on the
canvas, so the card that dropped out does not make it skip the next one.

### PR loop

On approval (unless "Direkt auf main", see How work lands) the worker hears that its work goes out
as a pull request, opened the way the repository does it (its own skills and conventions, a
description for readers who have not seen Obeya), and reports it with the tool `pr_opened(url)`,
which takes a pull request on GitHub (`…/pull/<n>`) or on Forgejo and Gitea (`…/pulls/<n>`: Codeberg,
a server of one's own, also below a path).
From then on it may push its branch, never merges, and ends its turn after each round instead of
handing over again.

#### Watching the PR

Per repository a watcher polls every open PR every two minutes (state, mergeability, checks,
conversation and review comments, inline comments), and right away when the owner comes back to an
Obeya page (it becomes visible or gets the focus; at most once in 15 seconds): the owner merges on
GitHub and returns. The watcher sits behind a small forge interface (`src/server/forge.ts`), which
picks the forge by the PR's URL, so the loop is tested against a fake:

- GitHub through `gh`, as the account that owns the repository (the PR's, or the `origin` a new PR
  goes to) where gh has a login for it, its token as `GH_TOKEN`, whatever account gh has active:
  another one does not see a private repository of the owner, and the watcher would never learn of
  the merge.
- Forgejo and Gitea (`src/server/forgejo.ts`) through their REST API (`<server>/api/v1`), with
  curl and the login git has for the repository (`git credential fill` with `origin`'s URL where
  that is the repository, so a helper keyed by its path finds it: the keychain, Git Credential
  Manager, libsecret; never asking). Where git has none, an access token stored as git's password
  for the host serves; a push over https with it stores it. Forgejo keeps no review threads: the
  inline comments on one line of one file are a thread, the first opens it, and it is resolved when
  one of them is. It says only whether it can merge now, which it cannot while it still checks a
  new push (seconds to minutes) either: a head it cannot merge is a conflict only when it still
  cannot at the next look. Its times come in the server's zone and the committer's; the watcher
  compares them in UTC. Checks are the head
  commit's statuses, every page of them (Forgejo Actions report there). A pull request on the settings' share goes to
  the forge of `origin`.

A PR that cannot be read for ten minutes (a login missing, say, not the network gone for a moment)
says why on its card, once ("Obeya kann den Pull Request nicht lesen: …"); without it, the card
waited for a merge it never saw.

New comments, failed checks (once per check and commit) and a conflict (once per commit) go to the
worker as a message, which says what happened and leaves the how to the repository's ways (say, a
skill of its own that merges `main` instead of rebasing, replies on and resolves threads, and asks
Greptile for a re-review after each push). Whatever the way, each review comment gets a reply in its
own thread (what changed, or why not) and the thread is resolved unless the worker still wants the
reviewer's answer; one summary comment for all is not enough. The owner's log gets a line for each
event. Comments by the PR's author (the worker replying in the owner's name) and by accounts the
settings name as noise (`prNoise`) (a deploy preview bot, say) are skipped; an app's inline comments come as
`<name>[bot]`, its conversation comments as `<name>`, and the watcher reads both as `<name>`. While
the owner is asked, news waits.

#### Ready to merge

Once nothing is left for the worker, the card needs the owner: "Bereit zum Mergen" (once in the log,
on the card and folded) when

- the forge sees nothing in the way (GitHub's `mergeStateStatus` clean; on Forgejo mergeable and no
  draft),
- every check has passed and every review thread is resolved,
- the worker is not in a turn,
- a reviewer who wrote has written since the PR's own changes last changed (the committer date of
  its newest commit that is not a merge: merging the base in brings changes reviewed there, mostly
  elsewhere in the code),
- and whoever the PR's author last asked for another look has answered since. A review bot often
  answers a re-review only by rewriting its summary (Greptile's new score, with no new comment), so
  a rewrite counts as an answer.

A review older than the changes is about an older state: the worker hears, once per commit and when
it is not in a turn, that its reviewers have not seen its latest push, and asks them the
repository's way (its own skill, or a comment mentioning the bot); the message on new review
comments already says to ask once pushed. A PR no reviewer wrote on waits for nobody.

A ready PR whose reviewer's latest confidence is below 4/5 ("Confidence Score: 3/5" in Greptile's
summary) Obeya does not merge: the card needs the owner ("Bereit zum Mergen · Review nur 3/5"), who
merges on GitHub or tells the worker what is missing; a new review at 4/5 or better lets Obeya merge
again. Once ready, Obeya merges the PR itself (`gh pr merge` with the method the repository allows,
squash first, and `--match-head-commit`, so a push since is never merged unchecked; on Forgejo the
merge API with the first allowed style and `head_commit_id`) and the card is
`live` (see After landing) in the same round. When GitHub refuses the merge (branch protection
wanting a human approval, say), the card says why ("Obeya konnte nicht mergen: …") and needs the
owner, who merges on GitHub; Obeya tries again each round, so it goes through once the reason is
gone. Anything new for the worker takes the readiness back.

#### The PR on the card

The card shows the PR with its link, its checks (each linked to its run), a conflict and a ready PR
Obeya could not merge; folded, it reads "PR #42 · 1 Check rot · Konflikt" or "PR #42 · Bereit zum
Mergen". Below the checks it shows the review as last polled, oldest first: each round a reviewer
left comments on the code in ("Runde 2 · greptile-apps · 3 Anmerkungen, 1 offen"), each comment
folded to its first line with whether its thread is resolved and how many replies it has, unfolded
with the file, the comment and the replies (the PR author's as "Agent"); between the rounds the
conversation (a reviewer's summary, the worker's requests for another round; a comment rewritten
since, like Greptile's summary each round, stands where it was last changed). Review bots write HTML
into their Markdown: badges keep their name (Greptile's "P1"), folded parts, code and diagrams go.
Whether a thread is resolved and when a comment was last changed only GraphQL says, so the watcher
asks that too. Checked against real pull requests (2026-10-01): `gh` reads their state, checks and
comments; on 2026-10-02 all five Greptile threads of a PR got their own reply and were resolved
before the re-review ping.

### After landing

The worker is told its work is on main (or that its PR was merged) and may finish what remains, in
its workspace, which stays at what landed until then (the card is `live`, "Live · Agent arbeitet";
notes reach it, the pause on its working bubble halts it, "Stoppen" ends it). Ending a turn with
nothing to wait for ends its session and removes worktree and branch (a clone is free again).

A turn that ends while a message from Obeya is still to come is not that turn: work approved while
its worker ends a reply (the owner said yes to its question and approved at once) lands while the
reply's turn finishes, and the notice of the landing, too late for that turn, starts one of its own.
The runtime gives each message it sends a uuid and checks it against those the turn's result names
as taken (the CLI also lists those it took in the middle of a turn); the session, workspace and busy
state stay until the turn that took the last one ends.

#### Restarts for landed code

When the landing changed Obeya's own running code, the worker is told Obeya restarts with it; where
it changed where the repository's agents work (`workspaces` in its `.obeya/settings.json`, landed on
the local main), that they restart with it (see Live configuration); a new version of the settings
that leaves them where they work applies at once, and the worker hears nothing of a restart
(`restartsFor`: `obeya`, `repo`, or none). What needs the new code waits through `after_restart`:
the worker ends its turn, the restart goes ahead, and the resumed worker hears that Obeya now runs
its change. Work pushed straight onto the remote's main applies once the Lesestand fetches it. A
worker there that was told of a due restart in its turn and ends it pauses for it, as while it
works: session and workspace stay, and the restart resumes it.

#### Failed turns while finishing

A turn there that an error cut off (the API overloaded, say) does not count as done: like a turn
that ends without a handover while the worker works, it is tried once more, and if that fails too
the owner gets the reason as a question ("Nochmal versuchen", or "Stoppen" to end the card without
the rest); the card's conversation shows a question asked while finishing like any other, not the
worker at work. While a restart is due, the failed turn instead pauses for it, which resumes the
worker, so that a second try does not hold up the restart. A turn there that the usage limit stopped
is not done either: it waits for the limit as while the worker works (status line, not busy, told to
go on after the reset), then the worker finishes what remained.

#### How a finishing card looks

On the canvas, a card finishing shows its status line as one at work does. It looks awake: the live
stock and the "Live" label, but not faded, its state line in the working ink with the moving line
("Live · Agent arbeitet", also in the detail view; "Erledigt · Agent arbeitet" for a `done` card,
"Live · Agent antwortet" for a follow-up), and a workstream stays at the size of a task instead of
shrinking to a chip, which hides state and status line; once its agent is done, it fades as live.

#### Questions after the work

A follow-up on a finished card whose worker has ended goes the same way: what the owner says on the
card (typed in its field, or spoken with it open: straight to that agent, as on a card at work)
resumes the worker's session in a fresh workspace on the card's branch (a free clone, else a
temporary worktree; see A finished card's question), where main may have moved on since (resuming
finds the session from any directory). The card stays `live` or `done`, "Agent antwortet"; the
worker answers with `reply` (its closing words after that fold under it, as after any reply), and
its turn's end frees the workspace again (a temporary worktree is removed). One that asked for a
full clone (`need_clone`) stays "Agent antwortet" with the status line „Wartet auf Workspace“ until
a clone is free, and "Stoppen" ends the wait. Commits there do not land: a change the follow-up
calls for becomes a card of its own (`propose_card`). The Arbeitsrückschau read the card's runs when
its work ended and does not count it again. A card no agent worked on (no branch), a prototype or an
archived card has no field.

### Decisions

- **Obeya itself is developed without branches or PRs**: approved work lands directly on `main`.
- **The worker opens and tends its PR the way the repository does it**, rather than Obeya scripting
  the steps (2026-10-01): Obeya's first version told it to rebase and push with
  `--force-with-lease`, while the first repository it opened PRs in merges `main` into a PR branch,
  never force-pushes, and has its own skill for review comments. Obeya says what happened on the PR,
  the repository says how to answer it.
- **The card that changes how work lands lands the new way, and gh runs as the repository's owner**
  (2026-10-16). Before, Obeya read `land` only from the default branch: the card that set up a
  GitHub repository's settings wrote `land: main` as the owner had answered, yet its approval went
  out as a pull request, under a button that said only "Freigeben". The merged PR then left the
  card "in PR": the watcher ran gh as the machine's active account, which could not see the
  owner's private repository.
- **Landing is detected from the remote** (2026-10-14). Until then Obeya's defaults had `pr`
  whatever the remote, so approving work in a repository without one told the worker to open a pull
  request that could not exist.
- **A repository whose work goes out as pull requests may let the owner push a card's work straight
  onto its default branch**, chosen per card at the approval, by button or voice (2026-10-06): an
  approval "mit direktem Commit auf main ohne Pull Request" had opened a PR anyway, since approval
  took no parameter and the spoken "ohne PR" was lost. Whether a repository allows it is its
  settings' `direct`, off by default; there is no rule by path. Obeya pushes, not the worker, and
  only fast-forwards. A card already in its PR does not switch.
- **Landing problems are classified**: uncommitted work, rebase conflicts and branches emptied by
  the rebase (their commits are on main already) go back to the worker; a blocked Obeya checkout or
  a push the remote turns away stays with the owner, and the card stays in review.
- **An approval holds through what the worker fixes to land it**: main moving on is no reason to ask
  the owner again. A stop, a blocked Obeya checkout or a push the remote turns away take it back;
  what the owner writes meanwhile is a note to the worker.
- **Landing does not block the server, and the click ends the owner's turn** (2026-10-10). Before,
  the whole server stood still until the push was through, and the card went on needing the owner
  for the seconds of the push, so Tab right after approving came back to it.
- **Obeya follows pull requests on Forgejo and Gitea** (2026-10-17). Until then only GitHub's: a
  card of a repository on Codeberg whose PR had been merged stood „Agent öffnet den PR“ for good,
  since `pr_opened` refused the Codeberg URL, and nothing could set it live. The API is called with
  curl and git's login rather than a CLI (`tea`, `fj`), which hardly any machine has. The default
  landing stays `main` there: an agent opens a PR on Forgejo only with tooling its repository brings.
- **The watcher polls when the owner comes back.** Before, the card stood "in PR" for up to two
  minutes after the merge (a PR on 2026-10-02: merged 12:12:40, seen 12:14:12).
- **A rewritten summary counts as a reviewer's answer, and an old review as no review**
  (2026-10-02). Before, the watcher waited for new comments only and the card stood "in PR" with
  nothing left to do; and a PR went in on Greptile's 3/5 of its first commit, since the worker
  pushed its fixes, replied in the threads and resolved them, but asked for no new review, and a PR
  nobody asked about counted as reviewed.
- **Obeya merges a ready PR itself** (2026-10-05). Before, Obeya left the merge to the owner on
  GitHub, and a ready PR stood for days with the card saying only "Bereit zum Mergen" (one PR ready
  2026-10-03 was still open 2026-10-05).
- **Landed work's worker keeps its workspace and session until it is done**, instead of ending with
  the approval: what a change needs after it is on main (a migration against the running Obeya) is
  done by the agent that knows the change. A landing costs one short worker turn for it.
- **The landing notice is a turn of its own** (2026-10-13). Before, the reply's turn counted as the
  one after the landing and ended the session, and the worker never heard that its work was on main:
  what it had promised for after the landing (publishing the hero video) stayed undone.
- **A direct push restarts like a landing, and a worker pauses for it** (2026-10-09). Before, a
  direct push never counted as restarting, and a turn ended for the restart ended the card, so what
  the worker had left for after the restart was never done.
- **Failed and limited turns after the landing are retried** (2026-10). Before, such a turn ended
  the card, and what remained after the landing was silently left undone; the same held for a turn
  the usage limit stopped. Before, only the detail view showed the status line of a finishing card.
- **A turn on the owner's words that the usage limit stopped is still at them** (2026-10-16).
  Before, Obeya counted it as answered: the card said „Agent hat geantwortet, wartet auf dich“,
  stopped its app and never went on by itself. A limit hit while background work ran showed only
  once that work ended, and the worker went on only when it woke it. The limit's note folded into
  the next message, which put it under the reply to words the owner wrote after the reset.
- **Look-ups, ideas and the other agents wait for the usage limit too** (2026-10-17). Before, only
  workers and Obeya's chat did: a looked-up question was answered with „Ich konnte die Frage nicht
  beantworten (You've hit your session limit …)“, an idea's turn ended in that error, a proposal's
  rework failed, a card started without a title was named after its text's start, a queued card
  started without its check, and the draft of a wish stood as the owner wrote it for good.
  Each now waits where it shows and goes on by itself; the shared wrapper does the waiting, so an
  agent added later waits by passing `onLimit`.
- **A finishing card looks awake** (2026-10-13). Before, it faded at the landing like a finished
  card, its state line in the pale live ink ("Agent erledigt den Rest", which suggested a small
  remainder, where a release still has tag, build and uploads to do), and a workstream became a
  chip. Rejected: the stock and rule of a card at work with an "on main" stamp (it sorted the card
  with those at work), and several landings per card (a second change would have no demo and no
  approval of its own; a code fix during a release goes through a card of its own).

## The Koordinator

Read-only SDK turns on the Lesestand of the card's repository (the home repository's without a
card), one decision at a time (its look-ups excepted, see Looked-up questions). It schedules the
cards, reads the owner's commands (see Commands to the Koordinator), looks things up, and learns the
owner's rules.

### Scheduling

Before a card starts the Koordinator estimates the files the card will change and judges whether
running it next to the cards in progress likely ends in merge conflicts. In a folder without git
(see Folders without git) it estimates the files and directories the card will touch and judges
whether it would get in the way of a card in progress: the same files changed, moved or deleted, a
directory reorganised that the other works in; working side by side in one directory does not
count. For a card in progress it sees its change list where a branch has its changed lines, and no
paths are soft. A card waits there as anywhere, and „Trotzdem starten“ starts it at the owner's own
risk. Cards queued before it
count too: a card likely to conflict with one of them waits behind it rather than overtaking it, and
once that one has started, until it has landed (fairer, at the cost of some parallelism). A card
judged again sees only the cards queued before it, so no two cards wait for each other.

For each card in progress it sees the estimated files and what the branch has changed so far: each
file with the changed line ranges and git's function context. Sharing a file does not keep a card
waiting (additions in different places merge cleanly); the same lines or function, or code that one
card moves, renames or reformats while the other edits it, do. In doubt the card runs: a conflict
that happens anyway goes back to its worker on landing. Paths the settings mark as soft (`softPaths`, docs) do
not count.

A card likely to conflict waits, with the reason (one that starts says which files it shares and why
that is fine); once what it waits for has landed or stopped it starts, or, while other work runs
that may have started meanwhile, it is judged again — the owner can start it anyway.

#### Waiting for a workspace

A card the Koordinator lets start while no workspace is free (all clones leased, or every free one
with uncommitted changes) waits for one in its place in the queue, shown as "Wartet auf Workspace"
with the reason, and starts by itself once one is free; cards queued after it count it as ahead of
them. Its reason on the open card ends in a link ("Anzahl der Klone ändern", "Anzahl der Slots
ändern" when slots are the limit) that opens the configuration at its repository's clone count or
slots (a repository in worktrees has only the slots), scrolled there and focused, since the owner
may not know the pool is the limit nor where it is set. Clones only free up with a change of the
board (stop, landing, a discarded prototype), so the Koordinator looks then; free clones found dirty
are looked at again after a minute at the latest.

A start that fails after the Koordinator took it drops the card back to planned; the unfolded
planned card then shows the last log entry, when it is an error, as the reason. A start that finds
no workspace is no failure but a wait. Cards left that way are picked up as waiting when Obeya
starts.

#### The queue's order

Cards whose turn comes together go in the order they came to the Koordinator, the one waiting
longest first. The owner sets the order where the waits leave it open (`src/core/queue.ts`): a
waiting card moves one place earlier or later ("Früher", "Später" on the card, which says its place,
and on its row in the queue's list) and swaps its place (`since`) with the card it passes. It does
not pass a card it waits for or one waiting for it, nor one the Koordinator is judging, since that
one's waits come from the cards ahead of it; nor does a card being judged move. Such a button stays
grey and says why when clicked; at the head or the end of the queue it is off. The new order counts
like the old one: who goes first once free, who gets a free workspace, and which cards count as
ahead when one is judged again.

While the pointer is on a card, the waits around it show over every step, both ways
(`src/ui/deps.ts`): the cards it waits for ("kommt zuerst"), those waiting for it ("wartet darauf"),
each with a ring and an arrow from the card waited for to the card waiting.

#### Starting a whole project

A project starts all its planned workstreams at once ("Alle N starten" in the project card's head,
"Alle N Workstreams starten" in its sheet, or by voice: start on the project): they queue in the
plan's order, wait 8 seconds in which "Rückgängig" takes the start back (the button is easily hit),
and then one Koordinator turn sees them together with the plan doc, the cards in progress and those
queued ahead. It puts them in an order and says for each what it waits for: a workstream it builds
on (until that one has landed) or one it would likely conflict with; the rest start at once. A
workstream may wait only for what comes before it in that order, so none wait for each other, and
the order is the queue's from then on. The project's sheet names what each waiting workstream waits
for. When the turn fails, each is judged on its own as if started alone; after a restart the joint
turn runs again.

### Learning the owner's rules

After whatever the owner says, the Koordinator decides whether a lasting preference was stated and
proposes it as a rule (the card's log says „Schlägt vor: …“), for the preference memory or, when it
is about a repository, for that repository's CLAUDE.md (for each repository of the canvas when it
holds in all of them; one proposal each); "Merk dir: …" by voice records a rule outright, sorted the
same way.

What it learns from: answers, notes and feedback to workers; an idea's discussion; the conversation
with it (a reply or look-up at once, with its reply; a command once its undo window has passed,
unless its words reach the learner another way, as a note or an idea's discussion do); and the text
the owner writes in a card, once they pause typing for a minute or act on the card, with the text it
had before (a proposal's, a follow-up's).

The learner reads an input with the card's text, what the owner said in the last three days (notes,
feedback and answers to agents, ideas' discussions, the conversation with the Koordinator; at most
30), the agent's last message before it (taken when the input arrives, not when the learner's turn
comes), the canvas's repositories, the active rules, the rules accepted for a CLAUDE.md, and the
open and rejected proposals. Its prompt names the signals for a proposal: phrased generally
("immer", "nie", "ab jetzt"), a correction of how an agent works, a repetition of something said
before; it makes at most one proposal per input.

#### The Rückschau

The Rückschau counts the owner's inputs: what the learner reads, and clicks without words in a card
(start, approve, accept or dismiss a proposal, park, start anyway, …), a deleted card, a command
taken back, a rule proposal decided on; a spoken command counts once, as what was said. The count
and when the history begins are settings of the canvas, so they survive a restart. At 20, after the
learner has read the input that completed the count, one read-only session in the home repository's
Lesestand reads what happened since the last Rückschau (at most the latest 300 lines): the cards'
milestones (the owner's notes, answers and clicks, the agents' questions and hand-overs, answers
given in the owner's name), the owner's words in ideas and to the Koordinator, taken back or not,
the cards they deleted or dismissed, and the rule proposals they accepted or rejected. It looks for
patterns seen at least twice on different cards and proposes up to three rules, each with a sentence
on what it rests on and, like the learner, for the preferences or a repository's CLAUDE.md; the
sheet shows that as their occasion („Aus der Rückschau: …“).

#### Proposals and rules in the sheet

Open proposals stand in the Koordinator's sheet (see The Koordinator's sheet) with their occasion
(the card and the owner's words, or the Rückschau), for a change the rule it changes, and where it
goes („Gehört in“: the preferences or the CLAUDE.md of a repository; `target` in `preferences`),
which the owner may switch. The owner accepts one, edits it before accepting, or rejects it; an
accepted change takes the place of its rule. Rejected proposals are kept (state `rejected` in
`preferences`), so the learner can see them. Values for a repository's settings the Arbeitsrückschau
proposes stand under the rules in the same section (see Setting proposals). The Koordinator button
counts open proposals (violet); they do not count among the cards that need the owner and do not
show on cards. The Koordinator gets the owner's rules, numbered, with every command, and follows
them itself too.

#### Rules for a CLAUDE.md

A rule accepted for a CLAUDE.md (state `filed`) goes into its repository's open card „CLAUDE.md
ergänzen“ (planned and not yet with the Koordinator; the setting `claude_md_card:<repo>` names it),
or into a new one when there is none; so does one the owner gives outright for a repository, by
voice or in the sheet's field for a new rule, which has the same „Gehört in“; its worker writes the
rules into the CLAUDE.md in the style of what is there. These cards start by themselves, through the
Koordinator like any start, once no proposal waits any more, whatever its place: a waiting one might
yet be switched to theirs, so several rules go in together. The card lands like any other (through a
pull request where work lands that way); until then the rule applies to no agent, and afterwards
through the CLAUDE.md alone.

### The Koordinator's sheet

Its sheet (button or `C`) gives the conversation with the Koordinator the height it has, with the
field to write in under it (the same as a card's, `src/ui/composer.tsx`: one frame as wide as the
conversation, the text growing with what is written up to 30 % of the window, the screenshot button,
the microphone that dictates into it (see Voice in) and Send in its bottom corner beside the text's
scrollbar). Opened with its button or `C`, the sheet puts the cursor in that field, so the owner
writes at once (the owner, 2026-10-19); opened with Tab, going through what needs the owner, it does
not, so the next Tab goes on to the next. Its placeholder shows in full, on two lines where it needs them: it often says what the
agent does with a message (the owner, 2026-10-17, after it had been cut off with „…“). Beside a short text the
three buttons stand side by side; once the text is about as high as the three on top of each other
(three lines on the phone), they stack in a narrow column, screenshot, microphone, Send from top to
bottom, and the text gets the width they free, about 55 px a line. Long dictated messages had kept
the narrow column beside the buttons on every line. Whether they stack is decided by the text's
height at the width it has beside the stack, whichever way they stand, so a text near the threshold
does not switch back and forth as the width changes with them. Below its cap the text box does not
scroll: its height was rounded, and the fraction of a pixel left over showed a scrollbar beside a
text that fit. Send is an arrow in a dark circle, as in chat apps, with what it does, „Senden“ or
„Antworten“, as its tooltip; only a button that starts something rather than sends keeps its words,
„Prototyp starten“.

Below that come sections that open and close, each a head with its count: the open proposals
(„Vorschläge (2)“, shown while there are any, open whenever a proposal came after the owner closed
them) and the preferences (always there, closed by default). Whether a section is open is kept per
canvas in the browser, so a reload keeps it. What runs is not listed there: the canvas shows it.

With no card open, the sheet shows the conversation, newest last, in all the height the sheet has;
an open section below takes from it down to 200px, and below that the sheet scrolls. Its messages
look like a card's (`Msg` and `Body` in `src/ui/message.tsx`, shared by both): the owner's on the
right, who and when above, the text as markdown (each line a paragraph, lists, tables, code, quotes
holding all of these in turn; the same parser as plan docs, `blocks` in `src/ui/markdown.tsx`), a
taken-back reply struck through. A web address in the text is a link, as a markdown link is, shown
without its `https://` and without the punctuation the sentence put after it; links keep the text's
ink with a faint line under it, and the pointer marks one like a highlighter.

### Arbeitsrückschau

Obeya looks back at how the workers worked, to make future runs cheaper (`src/server/work-retro.ts`,
`src/server/transcript.ts`): where a worker went wrong and corrected itself (a command with wrong
flags, a script that failed and was rewritten, a long search for how to start something), above all
the same detour on several cards. A feature of its own beside the Rückschau, with its parts (a
read-only reading session, a count in the canvas's settings, proposals on the usual way), but a
different source (the workers' transcripts, not the owner's words), beat (finished cards, not the
owner's inputs), place (the repository of the friction, not the home repository) and result (feature
cards and values for settings, not only rules). It runs in two stages.

#### Friction notes

When a card's work ends (landed, closed without a change, a prototype discarded or built, or a card
deleted with work not finished), Obeya draws an excerpt from the transcripts of its runs without a
model. The Agent SDK keeps a session's transcript at `<CLAUDE_CONFIG_DIR or
~/.claude>/projects/<cwd, non-alphanumerics as „-“>/<session id>.jsonl`, after the workspace has
gone too; Obeya looks there first and then in every directory, as the naming may change. A card's
runs are its `session_id` and the earlier ones in its log: a start from scratch (and a session that
replaces another) logs the session before as „Der frühere Lauf (Sitzung …) bleibt für die
Arbeitsrückschau erhalten.“

The excerpt holds the failed tool calls with their error (start and end, about 800 characters),
similar calls in a row (a failed one and its correction; a command three times or more), files
written whole more than once, the worker's words before and after each, and how many tool calls the
run took and after how many it first changed a file. Calls cut off by a restart (exit code 137) or
stopped by the owner do not count; subagents' lines are left out. A missing file or a format it
cannot read gives no excerpt and no error.

A short read-only session in the repository's Lesestand (a small job, see Models and effort) makes
0–3 friction notes of a non-empty excerpt (what went wrong, what it cost, what would have prevented
it), stored per repository and card in `friction`; an empty excerpt gets no session. It is told the
repository's settings a retrospective may propose (checks, setup, soft paths, „App für die Demo
starten“) as they apply now, so a worker working out what one would have said (how to start the app,
which checks to run) becomes a note whose fix names the setting and the value the run shows works.

#### The retrospective

Every 10 finished cards of a repository (counted when work ends, whether or not they had friction; a
card that never ran does not count; the setting `work_retro_cards:<repo>`), after the notes of the
card that completed the count, the retrospective runs. A new repository's first ones come sooner
(`WORK_RETRO_RAMP`): after its first finished card, then after 2 more and 4 more, then every 10, so
the owner does not wait long for the first improvements; the retrospectives a repository had are
counted (`work_retro_runs:<repo>`, the owner's own included).

The retrospective is one read-only session in that repository's Lesestand, so it sees its CLAUDE.md,
scripts and skills, reads the notes since the last one (`work_retro_since:<repo>`) card by card,
with the proposals of earlier retrospectives: those the owner dismissed, so it does not repeat them,
and those waiting or taken. It proposes at most three things, each resting on friction on at least
two cards (tags the tool checks):

- a feature card (a script, a skill, a fix to a tool) that waits as a proposal in a free spot, with
  a sentence on the cards it rests on (`retro` on the card, shown under the title as „Aus der
  Arbeitsrückschau: …“ and in its body; its state reads „Vorschlag von Obeya“ where a worker's
  proposal reads „Vorschlag eines Agenten“);
- a line for the repository's CLAUDE.md, which goes the way of the Rückschau's rules (a proposal for
  „CLAUDE.md von <repo>“, then the card „CLAUDE.md ergänzen“);
- a value for one of the repository's settings (`PROPOSED_SETTINGS`: `checks`, `setup`, `softPaths`,
  the app's `run`), for knowledge the workers each worked out themselves; its brief lists
  those settings as they apply now (this machine's and the repository's settings in front of Obeya's
  defaults, `settingsNow` in the canvas). Every handover brings a demo, so an empty „So läuft die App“
  is the usual case: each worker finds out how to run the app, and the retrospective proposes the
  recipe they arrived at.

Nothing is created silently and nothing starts by itself; skills of the user (`~/.claude/skills`)
are out of scope. The owner can ask the Koordinator for it at once („Mach eine Arbeitsrückschau für
den Shop“, the action `work_retro`): it reads the notes since the last one, the count starts again,
and the owner hears what came of it.

#### Setting proposals

A setting proposal (`setting_proposals`, one waiting per setting and repository) waits in Obeya's
sheet under „Vorschläge“ beside the rules, marked as what it is, a change to the configuration: a
cog and „Konfiguration ändern · <repo>“ over the setting's name, then the value now („Bisher“,
„(leer)“ where empty) above the new one („Neu“, a list one entry a line), the sentence it rests on
and the cards, each a link; „Zur Einstellung ↗“ beside the setting's name opens the configuration
dialog at that setting of the repository, folded open and marked (`ConfigFocus` with `settings`).
The Koordinator button counts it.

The new value stands in a field the owner may change right there (the line under it says so, and
once changed offers it „Wie vorgeschlagen“ again; the edit is kept per tab, so it outlives closing
the sheet and a reload). The owner takes what stands in the field with one of two buttons, neither
preselected: „Auf diesem Rechner“ sets it in this machine's settings (`Config.takeSetting` through
`Config.save`, applying at once), „Für alle ins Repository“ puts this value alone into
`.obeya/settings.json` the way „Für alle ins Repository übernehmen“ does (see Repository settings):
committed on the main branch where work lands there, this machine's own value for that setting then
going so the repository's applies here too; as a pull request otherwise, the value set on this
machine meanwhile (it goes once the merge brings the file, `takenOver`). A line under the buttons
says what each does; a notice says where the value went (with the pull request's link). „Verwerfen“
keeps it as rejected, and the next retrospective hears what became of each.

### Looked-up questions

A question that needs reading ("Was würde der Agent hier machen, wenn ich starte?", what the plan
says, how something works) the quick turn does not answer: it acknowledges it ("Ich schaue im Plan
nach.") and passes it on. A question about a project or one of its workstreams goes to the project
agent, in the project's session; any other to a thorough Koordinator turn on the card's repository.
Both have the tools a worker has, in the workers' permission mode (`auto` unless `--permission-mode`
says otherwise): the shell, gh, the web, files outside the repository. So they check what the text
alone does not say (which render in a directory is newest, whether a script ran, what a GitHub
release holds, a CI run) instead of answering that they cannot see it. A call the settings want
confirmed is refused, as there is no card to ask the owner on. The quick reading of a command stays
read-only, so it answers in seconds; what needs checking it passes to the look-up.

A question about the work of an agent on a card (also one waiting for review: „Ist sichergestellt,
dass …?“) is not looked up but goes to that agent, as a note or as feedback: its work is on its
branch, not in the Lesestand the look-up reads, and the card shows the agent at work while it
answers. `look_up` on such a card is refused with that hint (asked with the card open, the words
went to that agent anyway). Both get the question, the card's state and log, and the task its worker
gets at the start (`Workers.startBrief`), from which, the plan doc and the repository's instructions
they derive the worker's steps.

The answer comes 10–30 s later: written above the mic wherever the owner is (its start), in full in
the log of the card that was open, else in the Koordinator's sheet; what the agent reads shows on
the open card meanwhile. An answer in the sheet waits there unread (`unread` in `talk`) until the
owner has the sheet in view (open, the page not hidden): until then Obeya's button counts the unread
answers in orange, the colour of everything that waits for the owner, Obeya counts once in "brauchen
dich" and in the canvas's count in the switcher (`waitingOn`), and Tab goes there too, after the
cards that need the owner. The answers that waited keep an orange edge until the sheet closes; one
that comes while the sheet is in view is read as it comes, without the edge. An answer on a card's
log is read there and does not wait in the sheet. The quick turn's own reply waits the same way when
it only answers (no actions, nothing looked up; also the reply that the words could not be read): a
long answer takes the quick turn 20 s and more, and the owner may close the sheet or go to another
canvas meanwhile. Until 2026-10-19 only looked-up answers waited, and such a reply came unmarked,
with nothing on Obeya's button. A confirmation of actions does not wait: the canvas shows what it
did, and its line above the mic carries „Rückgängig“.

The Koordinator hears the answer with the next command, in full as the owner saw it (a card it
offers at the end is one "ja" away), and it is part of its stored memory. A question still open at a
restart is looked up again.

### Looked-up threads

A look-up starts a thread, and the owner can go on with it (`src/server/answers.ts`). The
Koordinator knows each answer by a tag (`A12`, the exchange's id) in what it hears of it and in its
memory; when the owner's words follow up on one („und im Oktober?“, „mach mir ein Excel daraus“),
`look_up` names it in `follows` (in doubt the newest). The follow-up then resumes the session of the
agent that found that answer (its id stands on the exchange in `talk`), which still has all it read
and computed; a project's questions go on in its project agent as before. Turns of one thread queue,
so two never run in one session at once. A session that cannot be resumed (its transcript gone) is
replaced by a fresh agent that gets the first question's context and the thread so far. The
follow-up stands under the owner's words with „↳ setzt fort: „…““ (and „liest …“ while it is looked
up), so the owner sees which answer Obeya took it for; its answer stands in the sheet or the open
card's log as any.

A turn that ends while the agent's background work runs (a download, a long query) is no answer
(`inform` in `src/server/advisor.ts`): the look-up goes on reading, in the sheet or on its Question
card, until that work wakes the agent and it answers. Should the work never wake it, its last words
are the answer after all, with the same limits as for a worker (three hours while it runs, ten
minutes after it ended). Until 2026-10-19 a look-up's turn took its words so far („still
downloading …“) as the answer and closed the session, which stopped that work. Ideas and look-ups
wait for that work alike (`BackgroundWait` in `src/server/runtime.ts`), and so do the owner's words
meanwhile: on a Question card they go into the waiting session at once (see Question cards).

#### Files with an answer

Every thread has an output directory outside every repository, `~/.obeya/answers/<canvas>/<thread>/`
(never in git, like demos), named in each turn's message and given to the agent as a directory of
its own (`additionalDirectories`): files the owner asks for or that help go there (a spreadsheet of
the numbers, a chart or page, the queries and scripts behind them, a draft as a document; no list of
types), and `answer_owner` passes them with `files` (path and a one-line caption). A path outside
the directory, or no file, is refused and the agent asked again. Under its text the answer shows
them, in the sheet, a card's log and a Question card alike (`AnswerFiles` in `src/ui/message.tsx`):
a page in the sandboxed frame of an HTML artifact (same CSP, key, height report), an image inline, any
other file as a chip that opens it with the system's app (`open`, `explorer.exe`, `xdg-open` on the
machine Obeya runs on; where that fails the browser downloads it; a file that is no document, a
`.command` or `.bat` the agent wrote, say, is shown selected in its folder instead, as opening it
would run it), with ↓ to download, and „Im
Ordner zeigen“ for the directory. A follow-up writes into the same directory, so it builds on the
files already there.

#### Question cards

Every looked-up answer has „Als Karte“ in its head, always in view: the thread moves onto a
**Question card** (`kind: 'question'`), next to the card whose log held it or where there is room,
its question as the title, its exchanges (the owner's words, the answers with their files and times)
as its conversation, the same session going on. While the card is on the canvas, the sheet keeps a
line „Auf der Karte „…““ in place of each of its answers, which opens the card; once it is archived
(„Erledigt“) or deleted, the answers stand in the sheet again, each with „Als Karte“. A follow-up
asked in the sheet afterwards goes to the card's agent and stands on the card.

On the card the owner's words go straight to that agent (`CanvasRuntime.tell` → `ask`, the shared
conversation, Send and unsent input), words that come while it reads go in with its next turn
(unread until then, and the owner can take them back), and it passes on with `to_obeya` what asks Obeya; a note the Koordinator passes to the card goes there
too. It holds answers, not work: its state is `done`, but it has a look of its own (a white card
with a blue-grey edge, „FRAGE“), shows the number of answers and files and whether its agent reads,
is not taken by „Erledigte archivieren“, and has no brief and no build, plan, prototype or park
buttons. It has two: „Als Idee besprechen“ (not while its agent reads) makes it an idea (`task` in
state `idea`) whose exploration agent starts afresh from the thread and its directory, and
„Erledigt“ archives it. „Als Karte“ on a thread already moved opens its card, back from the archive
if need be. The Koordinator lists Question cards among the cards it sees.

While its agent's turn waits for its background work (a download, a long query, see Looked-up
threads), the owner's words go into that session at once, read, as an idea's do, together with what
waited since the turn began; its answer answers them too, so „stop that, take 2023 instead“ reaches
it while the download runs. Words that come once it works again, or once that work ended and is about
to wake it, wait as before; a session that fails after it heard them hands them to the fresh one. Until 2026-10-19
they waited, unread, until the job finished and the agent had answered the question before.

### Koordinator memory

The owner's commands go to one ongoing Koordinator session per canvas, one after the other, so it
understands "die andere auch" or "nein, die von vorhin". It sees a card's open question, also one in
a demo report, so "ja" to it is an answer, not an approval. Card tags (`K1`, …) stay fixed for the
session. Each command brings the cards as they are now and what happened since the previous one
(state changes, questions, answers, hand-overs, the owner's notes, errors, new cards; not the
workers' steps); a command the owner took back is told with the next. Every exchange is stored
(`talk`), requests agents passed on included, with the owner's words.

A session that fails while reading a command (an error result, which the SDK also reports as a
`success` with `is_error`) is replaced by a fresh one for the same command; should that fail too,
the owner hears the reason („Ich konnte das nicht lesen. Claude ist auf diesem Rechner nicht
angemeldet: …“), not „nicht verstanden“. A session is not resumed: after a restart, and after 30
commands so the context stays short, a fresh one starts from memory: the last 20 exchanges and the
canvas's last 14 days (at most 60 steps), with times. Of the answers it looked up, the newest five
come in full, older ones clipped to 400 characters.

### Wishes for Obeya's makers

The owner tells Obeya's makers what is missing or broken from inside Obeya, as an issue on GitHub
that they submit themselves under their own account (`src/ui/wish.tsx`, `src/server/wish.ts`,
`src/core/wish.ts`). The repository is fixed, sadilek/obeya: the app runs without a checkout whose
`origin` could name another.

Four ways lead to the draft, a dialog over the page: the quiet link „Wunsch oder Fehler melden“ (with
„Entwurf offen“ beside it while a draft waits) under „Einrichtung prüfen“ at the foot of the
Konfiguration dialog's list of sections, the same link under the legend's sections, words to Obeya
(„Obeya, Feedback: …“, „Sag den Entwicklern von Obeya …“: the action `wish`, which opens the draft
at once with what was said, without an undo window, since it sends nothing), and the link under a
reply that says Obeya cannot do what the owner asked. The bar gets no icon of its own: it would
stand there always for something used rarely. Obeya's sheet had the link at its foot until
2026-10-17; it took a line of its own there (the owner).

The dialog's field is the shared composer (text, screenshots, microphone). What the owner writes or
says there a small job (`chores`, read-only, in a temporary directory) writes up as a title and a
body in English, the repository's language, adding nothing they did not say; a body that stands
already is reworked with the new words. The body ends with one line about this Obeya: its version,
the system, and `app`, `checkout <commit>` or `binary`. Nothing from cards, repositories, paths or
the conversation goes in unless the owner wrote it, or it is the request Obeya could not do and its
answer. Without a written issue (not logged in, say) the owner's own words stand in the draft, with
a line that says so. When it was the usage limit, the line says when Obeya writes the draft by itself
(„Das Nutzungslimit ist erreicht: Obeya schreibt den Entwurf um 19:20 von selbst …“), and the page
does that once the limit lifts, after a reload too (the draft keeps the words); a draft the owner
edits meanwhile stays as they made it. Title and body stand editable, exactly as they go out, above the line that the
issue appears publicly on GitHub under the owner's account.

„Auf GitHub öffnen ↗“ opens GitHub's page for a new issue, prefilled (`issues/new?title=…&body=…`),
in a new tab, which the app's shell hands to the system's browser on every platform. Screenshots
cannot travel in the link: the dialog says to paste them there, and the click puts the first on the
clipboard (as PNG). The link stays under 8000 characters: a longer body is cut, with a line at the
cut, and without a screenshot waiting there the whole body goes on the clipboard. Then the draft is
gone, and the dialog says what is on the clipboard. Until then the draft (title, body, screenshots)
is kept per tab and canvas like every input, and so is what stands in its field. A wish that comes
while a draft with something of the owner's in it stands (text in its body, screenshots) does not
replace it: at the top of the dialog, above that draft, stand the words the new one is to be written
from and the offer to discard the draft and write the new one; opening the draft on GitHub writes
the new one too. A draft with nothing more than a title gives way at once (until 2026-10-19 it held
the new wish back too, and the owner, who saw only that draft open with a line below it, took the
wish for lost). The draft remembers the wish it was written from, so the link under that reply opens
it again as it stands rather than offering to replace it with itself.

The Koordinator's `reply` carries the flag `wish` when it says Obeya cannot do what the owner asked
because Obeya has no such feature: not when it is unclear what they mean, when something failed just
now, when a request does not fit a card's state, or for a question of fact (a look-up is never
flagged). A flagged reply, in the sheet or on the card that was open, shows „↗ Als Wunsch melden“
under its text, which opens the draft with what the owner asked and what Obeya answered; on a card
such an answer stands in the conversation rather than folding away with the confirmations. The
exchange keeps what the draft starts from (`talk.wish`, `events.wish`). An agent that passed the
owner's words on through `to_obeya` gets the answer with a note that the owner finds that link under
it; for `wish` the page opens the draft from the notice that reaches it. `commands.test.ts` checks
the flag's way through, `commands.live.test.ts` the judgement against the real model on both sides
of the line.

### Decisions

- **Wishes go out as a prefilled GitHub issue the owner submits** (2026-10-16), under their own
  account, with Obeya holding no token. Rejected: posting through gh (it publishes with only Obeya's
  preview as the check), a hosted endpoint of Obeya's (a service to run, spam, a privacy notice),
  and mail (attachments by hand, and it exposes an address). Obeya offers it itself as a link under
  its reply that it cannot do something, rather than never (nobody would learn where Obeya falls
  short) or by collecting such requests under „Vorschläge“ (late, and without their context). The
  action is called `wish`, since `feedback` is feedback on a card's work.
- **The Koordinator waits on a card for a step it announced** (2026-10-18). Until then it said
  „once the repository is there, I'll add the canvas“ when it started a task that creates a
  repository, and nothing came: no turn of its runs without words of the owner's, who had to say
  „Task done.“ for the canvas to come. Rejected: having it promise nothing it cannot take by itself
  (the owner asked for both in one breath, and would have to come back for the second); a
  follow-up card whose worker adds the canvas (configuration is the Koordinator's, with its check
  and undo, and the worker would have to pass it back to Obeya anyway); waiting for any condition
  other than the two a worker waits for on another card, which cover what a card's result shows in.
- **A card waits rather than risking a collision**; the Koordinator's estimate is taken once, before
  the start, and a waiting card is checked again against what runs when its blockers finish.
- **A new card does not overtake a queued one it likely conflicts with**: it queues behind it, also
  when that one waits for something far from done. Fairness over parallelism; the owner can still
  start it anyway.
- **A card waiting to start stays full size and takes notes** (2026-10-16). Before, an accepted
  proposal shrank to a planned card's panel (900 px wide, scrolling past 480 px) while Obeya checked
  it, with its text alone and no field: what the owner thought of meanwhile waited until the agent
  ran. Spoken words still go to the Koordinator there, since „trotzdem starten“ and „aus der
  Warteschlange“ are what is said to a waiting card, and no agent is there yet to pass them on.
- **A start that finds no workspace is a wait, not a failure** (2026-10-05): before, such a card
  stood as "Geplant" with "Kein Workspace frei" as its last failure and never started by itself,
  though the owner had started it.
- **The owner reorders the queue with buttons that move a card one place**, not by dragging
  (2026-10-08): the waits fix part of the order, and a button can say at the card where they stop
  it, where a drag would only fail on dropping. Only cards with a decision move, and none passes one
  being judged: its turn reads the cards ahead of it, and a card moved behind it could otherwise end
  up waiting for a card that waits for it.
- **A project's workstreams started together are scheduled in one Koordinator turn** rather than
  started one after the other through the single-card check (2026-10-02): workstreams of a plan
  often build on each other, which a check for merge conflicts alone does not see, and only a turn
  that sees all of them and the plan doc can choose the order. The workstreams that wait then go the
  usual way: they start once what they wait for has landed, judged again against what runs.
- **Learned rules are proposals the owner accepts first**, rather than stored silently as at first
  (2026-10-02): the owner wants to see every learned rule before it applies. Open proposals count on
  Obeya's button only, not among the cards that need the owner nor on the cards. The Rückschau runs
  after about 20 inputs, neither daily nor only on request.
- **Preferences hold only how agents work with the owner through Obeya**; rules about a repository,
  taste in code that holds in every repository included, go into its CLAUDE.md (2026-10-02). At
  first the learner drew no line, and repository facts landed among the preferences, unversioned and
  unseen by colleagues and by Claude Code outside Obeya. Rejected: not learning repository rules
  (what the owner says would be lost), preferences scoped to a repository in the database
  (unversioned, invisible outside Obeya), the Koordinator committing to the CLAUDE.md on accept (it
  only reads, and where work lands through PRs nothing goes to `main` directly). Accepted ones
  collect in one card per repository that starts once no proposal waits, so several go in together
  without the owner starting it. A rule the owner says outright („Merk dir: …“) or writes in the
  sheet is sorted the same way and filed at once, without a proposal (2026-10-02): at first it
  always became a preference, so repository rules said outright still landed there.
- **The Arbeitsrückschau learns from the workers' transcripts, in two stages** (2026-10-05): an
  excerpt drawn without a model when a card's work ends, made into a few friction notes, and a
  retrospective over the notes of about ten cards in the repository's checkout. Rejected: building
  it into the Rückschau (the card log's tool lines have no results, and source, beat, place and
  result all differ), the worker reporting its own detours at the hand-over (patchy, and it makes
  every hand-over longer), and raw transcripts in the retrospective (far too much context). It runs
  on its beat and on the owner's word; its results are proposals in the repository of the friction,
  never cards created or started silently.
- **The Arbeitsrückschau proposes values for a repository's settings too** (2026-10-15), once demos
  were required by default and workers kept working out how to start the app. They wait in Obeya's
  sheet beside the rules rather than as cards on the canvas: taking one is a click, no work for an
  agent. Where the value goes is the owner's choice each time, this machine or the repository for
  everyone, with neither as a default; for everyone it is that one value, not all this machine set.
  Rejected: workers' hand-over summaries saying how they ran the app (longer summaries for the
  owner, for something the friction notes carry with their fix), and proposing the landing, the main
  branch or where workers work, which are the owner's choices rather than knowledge friction shows
  missing. The owner asked for the proposal to show plainly that it changes the configuration
  (2026-10-15), hence its head, the link into the dialog, and the value edited in place (until then
  an „Ändern“ button opened it, and the owner could not tell what it did). The retrospective's ramp
  for a new repository (after 1, 2 more and 4 more cards) came with it: at 10 cards from the start,
  the first improvements came late.
- **The sheet's conversation looks like a card's** (2026-10-09). Until then the sheet showed a log
  of its own (time and name in a column of monospace, the answers' markdown as raw lines), and Send
  stood beside the field as a button with its word, and an icon lay over the scrollbar. Until
  2026-10-10 messages knew only paragraphs and bullet lists, and an agent's table showed as raw
  lines of `|`; until 2026-10-12 a quote, in a message or a plan doc, ran its lines together into
  one paragraph and showed its lists and code as raw text; until 2026-10-15 a bare address was plain
  text.
- **Look-ups have a worker's tools** (2026-10-12): until then they were read-only (Read, Grep, Glob)
  and answered that they could not see what they could have checked. Until 2026-10-09 the
  Koordinator heard only the first 1500 characters of an answer, and asked back when the owner said
  yes to a card offered further on.
- **A look-up is a thread with files** (2026-10-14). Until then the look-up agent was one-shot: a
  follow-up went to a fresh agent that got only the owner's words and the card, and started over;
  and an answer was markdown only, and the agent ran in the Lesestand, where files would have been
  left as uncommitted changes nobody saw.
- **The Koordinator's memory lives in the store, not in the agent session**: a session is never
  resumed, and a new one (restart, or a long session) starts from the stored conversation and the
  cards' history. That keeps the context short over weeks, and restart and renewal are one path. The
  card history is part of it, because the owner asks about progress over time ("was ist seit gestern
  passiert?") and refers to cards by what happened to them.

## Voice

### Voice in

Push-to-talk: hold Space or the mic button; in the app also a key held in another app (see
Push-to-talk anywhere). The browser records and posts the audio with the focus (open card, project
in view).

#### Dictating or sending

Where the cursor is decides what becomes of the words. With the cursor in a text field under a
conversation (a card's, Obeya's sidebar's) they are dictated into it, at the cursor, and nothing is
sent: the owner adds to them, pastes a screenshot, and sends with Enter. Otherwise they go out at
once with what stands in the field of the card in view (or of the sidebar with no card open): its
words before the spoken ones, its screenshots, the message it quotes; the field empties as they go,
and gets them back when nothing was heard. The focus decides rather than whether a field is in view,
because on a card one almost always is, also when the owner just wants to say something at once; a
click into the field or beside it switches. The app's push-to-talk key in another app always sends
at once: no field has the cursor there.

A dictation starts three ways: the microphone in the field beside its screenshot button, the
microphone at the bottom (pressing it keeps the cursor where it is), or Space held in the field.
Space pressed in the field is held back: let go within 250 ms, or another key pressed meanwhile
(fast typing overlaps keys), and it is typed as a keystroke (⌘Z takes it back); held longer, the
recording starts, and let go before a recording would count (600 ms in all) it is typed after all.
While Space is down the field is read-only: Chrome on the Mac
hides the pointer at every key pressed into an editable field, and the key repeating while held made
the pointer flicker wildly as the mouse moved.
While the owner speaks into a field it is framed in blue, and the line under it and under the
microphone says „→ ins Feld · abschicken mit Enter“; while the recognition writes, „Wird
aufgeschrieben …“; nothing heard leaves the field as it was and says so under it. Otherwise the line
under the microphone names who hears it and what goes with it („→ Agent · Aufgabe: … mit Text und 1
Screenshot“). `POST /voice?listen` only transcribes and returns the words; a form with `audio` and
`text` puts the field's words before the spoken ones.

#### Drafts

Each field keeps its draft (text, screenshots, the options picked for the questions above it; the
quote in `src/ui/reply.ts`) in one store per field (`src/ui/draft.ts`) rather than in the field, so
the microphone reads and writes it, and a draft outlives closing the card. Picks count only while
the same questions stand. The drafts of the cards, the sidebar and the microphone are also written
down per tab and canvas (`sessionStorage`) as they change, so they outlive a page load: switching to
another canvas and back (a page load of its own) or a restart.

#### The microphone

The log has each recording's length and level next to the transcript. While the owner holds the key,
a level that stays flat for 1.5 s shows „Das Mikrofon liefert keinen Ton.“ under the mic. The first
press after a page load opens the microphone (about 0.2–0.3 s); let go before it is open, nothing is
recorded (rather than a recording that runs on unheld) and the owner hears „Das Mikrofon war noch
nicht bereit“. The microphone is not opened on page load: in the log of 1–5 Oct 2026 (22 page loads
with a recording after them) the first recording after a load failed no more often than later ones,
and opening it early would keep the browser's microphone indicator on all the time.

A recording without audible speech gives „Ich habe nichts gehört.“, one Whisper cannot make sense of
„Das habe ich nicht verstanden.“; the Koordinator gets neither to guess from. How Whisper fails on
such recordings (the titles talk it into loops, guesses or its words for silence) and how they are
told apart is in `voice/transcribe_sidecar.py` and `src/server/voice.ts`.

### Speech recognition

A sidecar on this machine keeps the speech recognition's model loaded
(`voice/transcribe_sidecar.py`, `src/server/voice.ts`): Parakeet TDT 0.6B v3 by default, on every
platform, the Mac included (NVIDIA's model as int8 ONNX through `onnx-asr` and ONNX Runtime on the
CPU, fetched through uv without PyTorch or MLX; about 640 MB of model, 4 threads at most). Measured
on an M4 Pro with 8 s of the owner's German speech (2026-10-14; all three wrote the same text):
faster-whisper large-v3-turbo int8 on 4 CPU threads 4.4 s, mlx-whisper on the Mac's GPU 0.93 s (0.40
s of it telling the language), Parakeet on 4 CPU threads 0.23 s (0.71 s with 12, so the threads are
capped).

Parakeet hears 25 European languages by itself, so there is no language pass; it takes no prompt, so
the card titles no longer steer what it writes (the Koordinator still reads with them in mind); and
it neither loops nor writes subtitle phrases on silence, so the second pass stays with Whisper. A
recording longer than a minute is heard in parts of at most 60 s, each cut at the quietest moment of
its last 20 s: Parakeet attends to the whole recording at once and its memory grows with it (1.8 GB
of process for 57 s). Without the card titles it writes some compounds and verb forms differently
(Piper's „Starte die Karte Export“ became „Startet die Karteexport“), which the Koordinator reads
through.

#### Whisper

Whisper stays as the backend `OBEYA_WHISPER_BACKEND` picks (`mlx`, `faster`, or `whisper` for this
platform's), unchanged: it transcribes with the canvas's titles as vocabulary, in the language it
hears spoken in the first 30 seconds of the ones Obeya speaks (German or English), not the
interface's: the owner may run the interface in English and speak German. With MLX hearing the
language is one more encoder pass, about 0.4 s on an M-series Mac. With faster-whisper the first
30-second window is encoded once, its encoder output tells German from English and is handed to the
decode of that window (`generate_segments` takes it, `transcribe` passes none), so a short command
costs one encoder pass (measured 2026-10-08; faster-whisper's own `multilingual` would pick from all
languages and may hear a short German command as Dutch).

mlx-whisper on Apple Silicon, faster-whisper elsewhere (CUDA when there is a GPU, falling back to
the CPU when its libraries are missing; int8 on the CPU), large-v3-turbo on both. Every backend gets
the recording decoded by ffmpeg, and its Python from `OBEYA_WHISPER_PYTHON` (a Python with the
package), else from `uv` with the backend's package (`listenKit` in `src/server/voice.ts`). On a CPU large-v3-turbo in int8 takes about 4 s for a spoken command on
GitHub's 4-core Ubuntu runner and 12 s on its 4-core Windows Server runner (float32 took twice as
long; `small` 1–2.5 s, but on Windows it heard „rechnen“ for „Rechnungen“; measured 2026-10-06), and
`OBEYA_WHISPER_MODEL` picks another Whisper model.

Checked on macOS, Ubuntu on ARM in Docker, and GitHub's Ubuntu x64 and Windows Server 2025 runners
with Whisper (2026-10-06), on macOS with Parakeet (2026-10-14): the settings check, installing from
it, and a command spoken by Piper heard word for word through `POST /voice`
(`src/server/voice.live.test.ts` with `OBEYA_LIVE_VOICE=<home>`).

#### A cloud service

Where the machine's own recognition is too slow even so, the recordings go to a cloud service
instead (see The Spracheingabe settings): Obeya then sends each one to it as it came from the
browser, with the card titles as a prompt where the service takes one, and a request it fails,
refuses or does not answer within 30 s says so under the mic („Groq hat die Aufnahme nicht erkannt
(401: Invalid API Key).“), the words staying in the field, instead of hanging.

#### The Spracheingabe settings

The configuration dialog's section "Spracheingabe" ("Voice") checks what voice in needs on this
machine (`src/server/voice-setup.ts`): the speech recognition (the package in uv's cache or the
given Python, the model in the Hugging Face cache), ffmpeg and uv, each missing piece with how to
install it here, as for demos. "Installieren" loads the recognition, which fetches it the first time
(about 710 MB for Parakeet: the model and its package; Whisper about 1.8 GB), so the first command
does not wait for the download, and then measures it: it transcribes a short German sentence Obeya
ships with (`voice/check-de.ogg`, 4.1 s, spoken by Piper as in the live voice test) and times it,
loaded and warm (twice, the faster one counting: the first recording after loading takes longer).
Its line then says „Parakeet · 0,3 s für einen kurzen Satz“, or, over one second per second of
speech, „zu langsam“ with the time, and opens the cloud offer below it; „Erneut messen“ measures
again. The measurement is kept in `voice.json` in Obeya's home for the backend it was made with. The
setup assistant's „Sprachbefehle“ shows the same line, built once (`RecognitionDetail` in
`src/ui/setup.tsx`). With Parakeet it should seldom be slow; it is the safety net.

The cloud offer („Über einen Cloud-Dienst erkennen“, a link under the line until it is needed) is
one client for the OpenAI-style `/audio/transcriptions` endpoint (`src/server/voice-cloud.ts`) with
three presets: Groq (whisper-large-v3-turbo, offered first: free with an e-mail sign-up and no card,
2,000 requests and 8 h of audio a day, then $0.04 an hour; it takes the card titles as a prompt),
Mistral (Voxtral Mini Transcribe, $0.003/min, hosted in the EU; no prompt), and any
OpenAI-compatible endpoint (OpenAI itself with gpt-4o-mini-transcribe at $0.003/min, or a server of
one's own, with its address and model). Each says that the recordings leave the machine and links to
where its key is had; "Testen" sends the check's sentence and, once the service wrote it down, uses
it from the next recording on, with the time it took. Base URL, model and key are kept per machine
in `voice.json` (readable by the owner alone), never in a repository; the page only learns that
there is a key. With a service in use nothing of the above is needed on the machine, and the line
names it, with „Wieder auf diesem Rechner erkennen“. The server lets a request run 120 s idle
instead of Bun's 10 s: a command answers once it is transcribed and read, which on a busy CPU took
longer.

### Who hears the words

Who hears it depends on what is open, and the line under the mic says so; under a card's text field
only when Obeya reads it rather than the card's agent, which the open card makes plain enough
("Agent · Aufgabe: …", "Agent · Idee: …", "Obeya · Aufgabe: …", "Obeya · Projekt: …"); the words go
exactly where it says (`agentListens` in `src/core/types.ts`, the same for the label and the route).

On a card an agent listens on (its worker at work, waiting, in a pull request or finishing after the
landing, the one a question resumes on a finished card, a prototype's worker, an idea's exploration
agent, the agent that reworks a proposal unless it is at it already) what the owner types or says
goes straight to that agent (`CanvasRuntime.tell`), typed words at once, spoken ones as soon as the
speech recognition has written them down, with the screenshots shown with them: by the card's state,
talk to an idea, the answer to the worker's question, or else words the worker takes in (a note
while it works, words on its handover, a question after its work; see Waiting for approval and
Questions after the work). Spoken words carry the remark that speech recognition may have misheard
them. They stand in the card's conversation under „Du“ at once; nothing waits for "Rückgängig", and
there is no line above the mic for typed words (a recording shows „„Export“ · wird aufgeschrieben …“
while the recognition works). Clicks on answer options go straight to the agent, as do typed and
spoken words.

#### Passing a request on to Obeya

Words that ask Obeya for something rather than the agent (approve, pause, stop, start, a follow-up
or new card, "Merk dir", grouping cards, an action on another card, a question about the canvas or
another card) the agent passes on with `to_obeya(request)`, one tool built once for workers,
prototypes' workers and exploration agents (`src/server/to-obeya.ts`), whose instructions say in one
paragraph what Obeya does for them through it. The Koordinator reads the request with the owner's
own words beside it, spoken or typed (the newest on the card when Obeya restarted since), and the
card in focus, as it reads any command (`Commander.forward`). Where the owner has said nothing on
the card yet, the card's task stands in for their words once the owner gave it (typed it, the
Koordinator wrote it from what they said to Obeya, or they accepted an agent's proposal and so made
its words their own): "lege ein Repo und einen Canvas dafür an"
becomes a task that ends with asking Obeya for the canvas, and the Koordinator takes that step
(unless it waits on the card to take a step itself, see A step once a card gets somewhere: then
that step is Obeya's). A proposal the owner has not accepted yet is no such task, and there nothing
is passed on: words an agent read in a proposal, a file or a pull request comment are no request of
the owner's, and the Koordinator would have taken them for one. Otherwise: actions with a confirmation and „Rückgängig“ (above the mic, as a notice that
reaches every open page, and in the card's conversation), a reply, or a look-up. Its confirmation or
reply is the tool's result. It passes nothing back to that agent as a note, an answer, feedback or
talk: the agent has the words already (refused if it tries). An agent at work probably sees the
words only at its next tool call, so a forwarded request may wait behind a long step (a render);
"gib frei" typed on a card waiting for review costs the worker a turn before it reaches the
Koordinator, several seconds, where the button „Freigeben“ is immediate.

On any other card (planned, queued, finished without an agent), with a project open or nothing, the
Koordinator reads the words, with that card or project in focus. Under the mic, and under a card's
text field, the UI then names it as Obeya, with the card or project in focus ("Obeya · Aufgabe: …").

### Commands to the Koordinator

A Koordinator turn reads the transcript as speech that may be misheard (typed words as written) and
either acts or replies. The Koordinator learns whether the words were typed, and in which field (a
proposal's).

Acting takes one or more actions from one sentence, up to 20: new card, new idea, start, taking a
card out of the queue, note, answer, feedback, approve, accept, dismiss, revise, stop, remember,
Arbeitsrückschau, putting cards into a group or out of it, renaming a group, changing the
configuration (`configure`, see The Konfiguration dialog), a wish for Obeya's makers (`wish`, see
Wishes for Obeya's makers), waiting on a card to take a step then (`wait_for`, see A step once a
card gets somewhere); on ideas: discuss, build, plan doc (on a
planned task of the owner's nobody has worked on too), prototype, park, drop; on prototypes: build
on it, discard. The actions are checked against the cards' states in the turn, so an action that
does not fit (a note to a card no agent works on) goes back to the Koordinator, which may reply
instead.

#### New cards

A new card, a follow-up too, starts at once, through the Koordinator like "Agent starten" (checked
for conflicts, queued if need be), unless the owner says it should wait („nur notieren“, „für
später“, „noch nicht starten“): then it stays planned. Left to its own judgement, the Koordinator
kept about one in five plainly asked-for tasks planned („Tipjar should split the bill …“), so the
`start` field of `new_card` says this outright, and left out it counts as starting.

Work on the machine that is no change to code (creating a repository, installing a tool, converting
files) is a new card too: its agent has the shell and does it with the owner's permission, in its
repository or outside it. The Koordinator's prompt says what a card's agent can do; without that, it
read „leg mir ein Repo in ~/dev/… an und eine Leinwand dafür“ against the `config` tool, found that
a canvas needs a repository that exists, and told the owner to run `git init` themselves, flagged as
something Obeya cannot do (2026-10-18). What only Obeya does after the work (the canvas on the new
repository) still needs the owner to ask again once the card is done. `commands.live.test.ts`
checks such requests with the configuration in reach, as Obeya runs.

A new card or idea (not a follow-up, which goes below the card it follows) lands in view: centred on
where the pointer was on the canvas when the owner stopped speaking (or sent the typed words), else
in the middle of the view, moved to the nearest free spot wholly in view (`freeSpotNear` with the
view); with a card or project open, in the view closing it goes back to. The page sends that place
with the command (`?place=`) and reports its view with its focus, which places what comes without
one (the app's key in another app, a request an agent passes on). The camera flies to the new card
only when it landed out of view.

Asking for an opinion or a way forward, with no agent on the open card to take it, is a new idea
with the owner's words (see the decisions under Ideas). With a card open, the Koordinator gets its
worker's whole summary, so "lege eine Folgeaufgabe für den ambient-Ton an" makes a follow-up of that
card with what the summary says about it.

#### Other commands

Start on a card queued behind others starts it now despite the likely conflict, like "Trotzdem
starten"; it sees which cards a queued one waits for, so "starte alle wartenden Aufgaben" works;
"nimm sie aus der Warteschlange" takes a queued card back to planned, like "Aus der Warteschlange
nehmen". A reply answers questions too ("Was ist seit gestern passiert?"), as far as the cards and
their history answer them.

"Merk dir: …" ("ab jetzt immer …") is remember, with the open card as its occasion, once the undo
window has passed. A rule on how agents work with the owner through Obeya becomes one of the
owner's, active at once; one about a repository („Merk dir: im Shop immer …“) goes, like a learned
one, into the card „CLAUDE.md ergänzen“ of the repositories it names (`repos`), without a proposal,
since the owner said it. The confirmation says which of the two it went to. It may name the rule it
changes, which then takes the new text, or, moved into a CLAUDE.md, goes. The Koordinator always
sees the canvas's repositories, one included.

What the owner says to the Koordinator about a proposal is, in doubt, a revision (`revise`, with
their words and the undo window); accepting in the same breath, or while it is reworked, is refused,
since the owner should see what they take. A note, an answer or feedback the Koordinator passes to a
card's agent (said in its sheet: „sag dem Export, …“) waits for undo like every command to Obeya,
and spoken words reach the agent with the remark that speech recognition may have misheard them.

#### A step once a card gets somewhere

What can only follow once a card gets somewhere (a canvas for the repository a new task creates,
starting „Login“ once „Export“ has landed, passing words on once a card waits for the owner) the
Koordinator waits for, as a worker snoozes on another card: `wait_for` in the same act, `on` a card
by its tag or on a new card of the same act by its title, until it is done (the default) or waits
for the owner (`awaited` in `src/core/types.ts`), with the step written out so it stands on its own
(`then`, its card tags written as titles, since another session tags cards anew). A card already
there is refused (the step is due now), as is a step without text. The agent of the card waited on
may read the step in its task and ask Obeya for it (`to_obeya`); without words of the owner's on
the card nothing is passed on (the task does not stand in for them here), and the answer tells it that Obeya takes that step itself. The
wait stands on the exchange whose reply announced it (`talk.waits`), so it outlives a restart; the
Koordinator sees its waits with every command and drops one on the owner's word (`stop_waiting`).

Every change of the board, the 15 s timer and every start look for waits whose card got there or no
longer gets there by itself (stopped, archived, removed, dropped), beside the snoozed cards
(`Commander.due`, called from `wakeDue`). A new exchange without words of the owner's takes such a
wait up: the Koordinator hears what it said it would do, what became of the card (its state and
its worker's summary; a card that got done counts as done, also for a wait until it waits for the
owner), and takes the step, or replies what became of the card instead. The wait goes only once
that is decided, so a restart meanwhile takes it up again, and dropping it meanwhile takes back what
was decided. Several steps on one card each stand.
Its reply reaches the owner as a notice, with „Rückgängig“ where it has actions, as for words the
usage limit held (which also holds this turn, the same way); its actions run after the undo window.
The exchange stands where the waiting one was: in the sheet, or on the card that was open then.

In the sheet, the reply that announced the step carries a line under it while the wait lasts, „◷
Wartet, bis „Repository anlegen“ erledigt ist“ (or „… auf dich wartet“), with „Nicht mehr warten“,
which drops the step at once (the Koordinator hears that with the next command). The exchange that
took it up starts with a line in place of the owner's words, „„Repository anlegen“ ist erledigt“
(or what else became of the card), and Obeya's reply under it.

#### Confirmation and undo

One confirmation covers all actions; they run in order a few seconds after it reached the owner, so
"Rückgängig" takes back anything, even an approval. A page that opens in that window (a reload)
shows the confirmation with „Rückgängig“ again for the rest of it. Only talking to an idea goes on
at once: it changes nothing.

What the owner said to the Koordinator goes into the conversation of the card that was open, or with
none open into the sheet, at once (spoken words once the recognition has written them down), with
„Obeya liest …“ under it until its confirmation follows (on a card folded away), and
"Zurückgenommen." when taken back. Words the Koordinator was reading when Obeya stopped get a reply
that says so (`Board.interruptTalk`).

Words the usage limit keeps the Koordinator from reading wait for it, as a worker does: the reply
says when they are read („Das Nutzungslimit ist erreicht. Ich lese das um 19:20 von selbst.“), in the
sheet as „Nutzungslimit · liest das um 19:20 von selbst“ under them, and ten seconds after the reset
the Koordinator reads them by itself (the same retries as a worker's when the time is unknown or
passes), knowing when they were said; the reply reaches the owner as a notice, with „Rückgängig“
where it has actions. Words said meanwhile try the held ones first, in order, and wait behind them
while the limit holds. Held words survive a restart (`talk.held`).

`commands.live.test.ts` checks against the real model (`OBEYA_LIVE=1`) that requests passed on from
each state an agent is on become Obeya's actions, that commands on cards without an agent are read
right, that a new task starts unless the owner says it should wait, and that with no card open a
question for an opinion becomes an idea and one of fact stays a reply.

#### Commands on their way

After letting go of Space the microphone is free at once, and the owner may navigate or speak again:
the target is fixed when the key goes down. Each recording has its own small line above the
microphone („„Export“ · wird verstanden …“, for a card's agent „… · wird aufgeschrieben …“), which
becomes its confirmation with „Rückgängig“, or disappears when the words went to the open card's
agent. A command typed to the Koordinator gets no such line while it is read (its conversation shows
the words and „Obeya liest …“), only its confirmation with „Rückgängig“; a request typed in the
configuration dialog, whose conversation is out of view, keeps the line. Several stack, oldest
first, and the server reads them one after the other. A confirmation that arrives while another card
is open starts with the card it is about; so does one for a request an agent passed on, and an
answer looked up. A reply that stands in Obeya's sheet while the sheet is open (on the phone, its
conversation) gets no line: the owner reads it there already (2026-10-17). Only one with
„Rückgängig“ keeps it, since the sheet offers no undo. The server marks the exchange of the sheet a
reply or a notice answers (`talk`); the page checks that its sheet shows that exchange, so a
spoken command with a card open, a reply for another canvas and a failure keep their line.

### Voice latency

Pressing Space (or focusing a field the Koordinator reads) gets everything ready while the owner
speaks: the recognition's sidecar starts and loads its model (not with a cloud service), and the
Koordinator's session starts up if it is not running (one that fails is replaced once, for the same
command). On a card with an agent the words reach it as soon as the recognition has written them
down (typed ones at once). Elsewhere the written confirmation comes back as soon as the Koordinator
has decided, and the undo window starts with it. Measured on a small scratch canvas, letting go to
the written confirmation takes about 2.8 s, the first command after a start included. Most of it is
the Koordinator's model turn (about 2 s); Sonnet or Haiku, or a shorter system prompt, saved nothing
reliable in measurements, so it stays as it is.

### No voice out

Obeya does not speak. Confirmations and answers are written: in the card's conversation, in the
Koordinator's sheet, and in the line above the mic. Demo narration is a pipeline of its own (see
Demos).

### Push-to-talk anywhere

In the app, a key held while another app is in front records a command (`app/src/keys.rs`, `mic.rs`,
`ptt.rs`). Space cannot be that key (it would be taken from every other app), so by default it is
the right Option key on a Mac and the right Ctrl key elsewhere (right Alt is AltGr on many European
layouts); the configuration dialog takes another by pressing it ("Sprachtaste überall"): a key
nobody types with held alone (a modifier, an F key, Pause …), or modifiers and a key such as
Ctrl+Shift+Space (`src/core/push-key.ts`, saved as `pushKey` in `settings.json`). A key alone is
only listened to, so it still reaches the app in front: a tap of it does nothing, only holding it
past 0.3 s records, and another key going down while it is held makes it a shortcut, not a recording
(modifiers with it do not count).

On a Mac a listen-only event tap hears it, which needs "Input Monitoring": the system asks once, and
until it is allowed the settings and the setup assistant (a line under voice while the app runs) say
so and open the system settings' page; on Windows a low-level keyboard hook, on X11 XInput2's raw
key events. A combination goes through Tauri's global-shortcut plugin, which takes it for itself (no
permission on a Mac). Wayland gives an app no keys of others: there the desktop's Global Shortcuts
portal binds the key as a shortcut the owner confirms in the desktop's dialog (the settings then
show what it is bound to), and without the portal there is only the window's Space.

The shell records itself (a webview in the background cannot be relied on to): the default
microphone opens when the key goes down, so the first words are not lost, and the recording goes as
a WAV to the canvas's `/voice` with where the owner was last: every page tells the server what it
has in view (`focus` over its WebSocket, on every change and when it gets the focus back), and `GET
/api/focus` gives the newest of the open pages, else the first canvas with nothing in focus.

A floating panel at the bottom of the screen the pointer is on (`/panel`, served by the server, so
its strings are the UI's) never takes the keyboard: it shows that Obeya listens and to whom (with
the level, and „Das Mikrofon liefert keinen Ton.“), then the command being read, then what the
recognition heard (`text` in `/voice`'s answer) with the confirmation and „Rückgängig“ for the undo
window, or, said to the open card's agent, „An den Agenten gegangen.“; it fits its window to its
lines through the app's one command (`panel_fit`, allowed to that page in
`app/capabilities/panel.json`) and hides it when none are left.

Every two seconds the shell tells the server what it hears (`POST /api/push-to-talk/shell`: on,
permission, bind, none, unsupported, error) and gets the key that applies, so a key chosen in the
settings applies at once. `bun run app` (`scripts/app.ts`) builds the shell and starts it from the
checkout: it opens a window on the Obeya of the home, or starts `bun src/server/main.ts` (which
updates itself as `bun start` does), so the checkout has the key too. `bun scripts/check-ptt.ts`
checks it with the shell's check mode (the key from stdin, a WAV as the microphone; or, under X11,
the real keyboard pressed by xdotool): the report, a tap, a shortcut, and a command that reaches
Obeya and comes back to the panel. A restart is not held off while the shell records or reads a
command (the page holds it for its own); a command cut off by one shows „Das hat nicht geklappt“ in
the panel.

### Decisions

- **The focus decides between dictating and sending** (2026-10-12): always dictating into the field
  would have made every spoken message two steps. Until then spoken words always went out at once,
  without what was typed in the field; and the drafts lived in the page alone, so a canvas switch
  lost them; the picks lived in the card's view, and a restart lost them while the words came back.
- **Voice in hears with Parakeet everywhere, the Mac included** (2026-10-14): on a CPU it is about 19× faster than Whisper, and 4× faster than Whisper on the
  Mac's GPU, and the owner found its recognition good enough in daily use elsewhere. Whisper on a
  CPU had been the reason a small fanless Windows box took about a minute for a short sentence: the
  language pass, the transcription and often a second pass without the card titles. Whisper stays as
  an optional backend. A smaller Whisper was dropped for Parakeet (it misheard German words),
  Moonshine (English only) and the browser's own recognition (not in the app's webview on Windows,
  and it sends the audio to Google without saying so) too. Where the machine is too slow even for
  Parakeet, a cloud service: Groq first (free), Mistral (EU), or any OpenAI-compatible endpoint.
- **Whisper hears the spoken language, not the interface's** (2026-10-08): Whisper told to expect
  English then translated German into broken English, unsure of its words, so long dictations (more
  windows that can fail) ended in „not understood“ (6–8 Oct 2026). With faster-whisper telling the
  language had been one more encoder pass, on a CPU as long as a short command's whole transcription
  (4.2 s on the owner's Mac's CPU).
- **Voice and demos fetch their Python sidecars through uv on first use**, in the app as in the
  checkout (2026-10-06): bundling Python with the speech recognition would add hundreds of MB per
  platform for everyone, differ by GPU (MLX, CUDA, CPU) and need every native library signed and
  notarised, and the models, the large part, are downloaded on first use anyway.
- **Commands to Obeya are read by the Koordinator, not matched by rules, and always wait a few
  seconds for undo**; no command takes effect without a confirmation the owner could take back.
  Talking to an idea is the exception: it only adds to a conversation. So is whatever the owner says
  to the agent of the open card (2026-10-05 for notes and answers, 2026-10-08 for feedback too): it
  only adds to what the agent knows, the card's conversation shows it, and pressing Send or letting
  go of Space is the deliberate act. Feedback no longer takes the approval away, so it needs no undo
  either (see Waiting for approval).
- **A confirmed command outlives the server that confirmed it** (2026-10-12): it waits for undo in
  the database (`commands`), and a restart waits for it. A stop or "Jetzt neu starten" in the window
  leaves it to the next start, which runs it once the window is over, at once when it is over
  already: the owner has the confirmation and expects the card. A command that has begun to run is
  out of the database, so a restart in the middle runs nothing twice.
- **On a card with an agent, what the owner types or says goes straight to that agent**, which
  passes on to the Koordinator what asks Obeya for something (`to_obeya`, 2026-10-08). Typed and
  spoken words still take one way: the label under the mic names who listens, and both follow it.
  Before (from 2026-10-05), every word went through the Koordinator first, so that "gib frei" or
  "Merk dir" worked typed as well as spoken; but the owner waited for a Koordinator turn (about 2 s,
  longer for long text) before every word reached the agent or showed in the conversation. That
  reason holds either way now, since both paths are the same and the agent passes Obeya's commands
  on. The cost: "gib frei" typed to a worker wakes its session first, several seconds and tokens
  (the button „Freigeben“ stays the quick way), and a request can wait behind a long step of a
  working agent. Rejected: the Koordinator reading along in the background (two readers of the same
  words could both act, and every message would still cost a Koordinator turn), and keeping the
  Koordinator in front while showing the words at once (the agent would still get them late).
  Rejected in 2026-10-05 and still: two keys (the owner would choose who listens before every
  sentence), and dictating into the field for the owner to send (a step more). Until 2026-10-08
  every word to an agent also waited for the Koordinator's turn in the latency measured above; until
  2026-10-09 the line under a card's text field always named who listens.
- **The owner's words to the Koordinator show at once** (2026-10-12). Until then the words appeared
  only together with the confirmation, so typed words waited seconds as „„…“ · wird verstanden …“
  above the mic, which looked like speech recognition.
- **A new card lands where the owner looks** (2026-10-14). Until then every such card went into a
  column right of everything and the camera flew there.
- **Obeya does not speak** (2026-10-08): confirmations and answers are written. Spoken replies
  distracted the owner, who reads the line above the mic and the card's conversation anyway. Until
  then a voice on the server spoke the confirmations, the short form of looked-up answers and a
  summary of an idea's reply (a JXA sidecar with the macOS synthesizer, `say` as fallback, or
  Piper).

## Demos

### The demo skill

The demo skill's pipeline (scripted walkthrough, narrated video, report) is part of the repository:
`plugin/` is a Claude Code plugin named `obeya` whose skill `demo` (`plugin/skills/demo/`) holds the
instructions (`SKILL.md`, paths through `${CLAUDE_SKILL_DIR}`), the director (`lib/director.ts`,
Playwright on the local Chrome, else Edge, else Playwright's own Chromium, as on Linux on ARM where
there is no Chrome, launched by the plugin's `lib/chromium.ts`, which the browser skill shares; cut
with ffmpeg, run with plain `node`; on macOS, Linux and Windows, checked 2026-10-05), the overlay
(`lib/overlay.js`) and the narration (`lib/tts.py`), with Playwright
among Obeya's dependencies. Every page of the demo's browser, as of the browser skill's, gets
`plugin/lib/silent-speech.js` as an init script: Chrome's `--mute-audio` leaves the Web Speech API
alone, and a page's `speechSynthesis` spoke through the system's voice on the machine (an app's
speech fallback said a name every half minute while an agent tested it). The script keeps the API
and speaks nothing: utterances queue, fire `start` and, after about as long as saying them takes
(70 ms a character at rate 1), `end`; `pause`, `resume` and `cancel` fire the spec's events, and a
page without a user activation gets `not-allowed`, as in Chrome. So the page goes on as it would,
which leaving the API out (`--disable-speech-synthesis-api`) would not.

The report page (`index.html` beside the video, for the skill's use without Obeya) holds the title,
the summary (what the change does, then what the owner needs to know beyond the video: a behaviour
it leaves out and why, what is open or unverified, a defect found in someone else's change; a few
short paragraphs), the video with its chapters, the open question when there is one, and the
provenance (branch, commits, stack). Under Obeya the card shows the video and the handover summary
instead, and a problem outside the change is a proposal.

Obeya loads the plugin into every worker session (the Agent SDK's `plugins` option, a local plugin),
so the worker has the skill as `obeya:demo`, which its brief names, and `obeya:settings` (see Repository
settings). The skill also runs without Obeya: as the plugin, or as a user skill that points to
`plugin/skills/demo` (the owner's `~/.claude/skills/demo` is a link to it in the Obeya checkout).
Claude Code lists a skill file once: when the plugin Obeya loads is the very directory such a user
skill links to (Obeya run from that checkout), the session has the skill as `demo` and knows no
`obeya:demo` (Claude Code 2.1.299, 2026-10-14). The brief and the demand for a demo at
ready_for_review therefore name the skill as the session lists it (`demoSkillName`: the user skill
whose `SKILL.md` resolves to the plugin's, else `obeya:demo`) and give the path of its `SKILL.md` to
read for a session that does not know it (on a host, the plugin's copy there). At start, Obeya logs
a warning when the plugin's manifest or the demo skill is missing.

### The demo settings and voices

The demo settings (`lib/settings.ts`; `demo.json` in Obeya's home, `OBEYA_HOME` else `~/.obeya`)
give the narration language (German or English: narration, captions, the report page's words;
without one, the owner's conversation language) and the voice, a provider: text in, WAV out
(`lib/voices.ts` turns the settings into what `lib/tts.py` runs). They are the machine's, for every
canvas; a repository whose demos speak another language says so in its settings (`demo.language`,
see Repository settings), which goes before them for its demos: Obeya gives it to the repository's
workers as `DEMO_LANGUAGE`, and the skill (`repositoryLanguage`) reads that, else the
`.obeya/settings.json` of the repository it runs in. Obeya's own demos are in English (its
`.obeya/settings.json`, 2026-10-19). `node lib/settings.ts` names where the language came from; run in
a repository without Obeya, it says to render with `DEMO_LANGUAGE`, since the render runs in the
demo's directory, outside the repository.

Local voices run once per clip as a command with the text on stdin:

- Piper, the default (German `de_DE-thorsten-high`, English `en_US-ryan-high`; about twice real time
  on a laptop CPU, model loading included, and Whisper heard the test clips back word for word,
  measured 2026-10-02);
- Qwen3-TTS (1.7B, a stock speaker from the CustomVoice model or a clone of a clip with its
  transcript beside it from the Base model; MLX through mlx-audio on Apple Silicon, PyTorch through
  qwen-tts elsewhere, `lib/qwen3.py`; a clone continues its clip, so a German clip carries German
  accent and rhythm into English narration: the clip has to be in the narration language, so the
  settings hold one clip per language (`references: { de, en }`), and a demo clones the one of its
  language; a language without a clip is spoken by a stock speaker, which is nobody's own voice, so
  that narration is in the third person. Until 2026-10-19 the settings held one clip, since only
  one language was active at a time (decided 2026-10-12); with a language per repository two are
  (a `reference` of a file from before is read as the clip of its language). No open successor
  model as of 2026-10-07, Qwen-Audio-3.1-TTS of 2026-09 is hosted only);
- macOS `say` (offered on a Mac only);
- the owner's own command (through the shell; it writes the WAV to `$DEMO_WAV`).

Hosted ones are HTTP requests from templates in `tts.py`: Gemini, OpenAI (or another base URL with
the same API), ElevenLabs (`eleven_v4` unless `DEMO_ELEVENLABS_MODEL` names another), Azure, or
the owner's own endpoint (POST `{"text", "language"}` as JSON, audio back), each with its key
from its environment variable or a key file. Whatever comes back becomes a mono 16-bit WAV
through ffmpeg (a voice command gets its text as UTF-8, with `PYTHONUTF8`: on Windows Piper read
it in the code page otherwise).

Voices are not labelled as generated, a clone included: the whole demo is generated, and that is
clear from where it is shown. The person follows from "Das ist meine eigene Stimme" in the settings:
the first person only in the owner's own voice, otherwise the narration presents the work without
"I". `node lib/settings.ts` prints what applies, for the agent writing the narration; `DEMO_VOICE`
overrides the voice for one render (another provider, never the owner's own, or a `.wav` that
Qwen3-TTS clones). The owner's clone is Obeya's Qwen3
voice with the reference clip of the owner's voice project (Stimmzwilling,
`data/voice/derived/reference4_A.wav` with its transcript), so Obeya holds it across renders; it
never leaves the machine.

Each clip is synthesised once and kept as it comes: nothing listens back to it (see Decisions).

#### Installing voices

Obeya installs Piper and Qwen3-TTS on request from the configuration dialog, which shows what is
missing and about how large it is first: each in a Python environment of its own made by uv under
`voices/` in Obeya's home, Piper's voice files beside it, Qwen3's models in the Hugging Face cache,
where a model downloaded before counts as installed (`node lib/voices.ts install` does the same
without Obeya). A render refuses a voice that is not installed and says how to install it. The sheet
also plays a sentence in the voice being chosen ("Anhören"), in the narration language. For Qwen3-TTS
it has a field per language for the clip to clone, each with what keeps it from working (no such
file, no transcript beside it); its narration language says that a repository can name another.

#### A voice that stays loaded

A voice that can stay loaded says so in its spec (`serve`, so far only Qwen3-TTS: `qwen3.py
--serve`): `tts.py` starts it once per render (and once per "Anhören"), on the first clip that is
not cached, and asks it clip by clip over its stdin and stdout, one JSON line each way (text, WAV,
language; a ready line once the model is loaded, then `ok` or `error` per clip). Model, reference
and transcript load once instead of per clip: three clips with a clone, no cache, went from 25.8 s
to 15.8 s on an Apple Silicon Mac (a warm start with the model costs about 2 s, a cold one 17 s;
synthesis about 2–4 s per clip either way; measured 2026-10-05, when renders still listened back
with Whisper). The libraries print on stdout too, so the server
moves fd 1 to stderr and keeps a duplicate of it for the protocol alone; a line that is not the
protocol is shown and skipped. A voice that dies stops the render with the tail of its stderr
instead of hanging. Piper, `say` and the owner's command still run once per clip.

Under Obeya the Qwen3 voice lives longer than a render: Obeya holds it as a child process of its
server (`src/server/narration.ts`), since the server runs all along and on every platform. The spec
says which voice Obeya may hold (`host`: the reference clip or the stock speaker; the server builds
the command itself from that, never takes one from a request), and Obeya sets `OBEYA_URL` for its
workers and for the configuration dialog's sample: the address of its narration server
(`serveNarration`, `http://127.0.0.1:<port>`), which answers narration clips and nothing else, so a
worker holds no key to the rest of the API (Who may talk to it). `tts.py` then sends each clip to
`POST /api/narration/clip` (`{voice, text, inline: true, language}`, JSON only, so a page elsewhere
cannot send one without asking first) and gets `ok` with the seconds and the WAV, or `error`, back.
Obeya's own server answers the same route with the owner's key, and there may write the WAV to an
absolute `out` instead. The clips of all renders wait in one queue and are served one at a time;
each render asks for its next clip only once the last is done, so parallel renders take turns clip
by clip (throughput stays that of one GPU). The voice starts with the first clip and runs on for 5
minutes after the queue empties (`NARRATION_IDLE_MS`), then its stdin ends; a clip for another voice
(reference, speaker or language) ends it at once, and Obeya's shutdown kills it. Between server and
voice runs the line protocol above, unchanged. What it saves is a model load per render or "Anhören"
within those 5 minutes: about 2 s warm, 17 s cold, at the cost of 3–4 GB held meanwhile. Without
`OBEYA_URL`, or when Obeya does not answer (not running, restarting, an older Obeya without the
endpoint), `tts.py` loads the voice itself as before.

#### One large model at a time

One large model per render at a time on the machine (Qwen3-TTS, the owner's command; parallel
demos had swapped the machine to a halt): `tts.py --lock ~/.cache/demo-skill/tts.lock` takes the
file's lock before the process loads such a model itself and holds it to its end (`flock`, on
Windows a byte-range lock through `msvcrt`; it works beside an older `lockf -k` on the same file).
A voice Obeya holds takes no lock: parallel renders synthesise turn by turn through Obeya, with one
voice model in memory.

### What a render needs

What a render needs on the machine is checked by `lib/setup.ts`: Node 22.18 or newer (TypeScript
without flags), Playwright and a browser (found where Playwright looks), ffmpeg with libx264, uv
(which brings Python) and the voice. Each missing piece comes
with how to install it on this platform (Homebrew, winget, the Linux family's package manager from
`/etc/os-release`, else a page). The configuration dialog shows the check below the demo settings
("Was Demos auf diesem Rechner brauchen", the voice left out since it has its own lines), again
after an installation and on "Erneut prüfen"; the parts a voice still
lacks are named in the narration language ("Piper voice en_US-ryan-high" for an English one); a
render runs it before anything else and stops with the whole list (`--narration` leaves out the
browser); `node lib/setup.ts` prints it for an agent, which installs a voice itself but asks the
owner for system software. The guide for setting up a machine is `docs/demo-setup.md`. Not tried yet
(2026-10-05): Edge as the fallback, a voice command through `cmd.exe`, Qwen3-TTS through PyTorch (no
machine with a GPU).

### Recording a demo

How to run each project's app, for a demo too, is its settings' `app.run` (say, how to start it,
what to do after a change, where its address is, login, test data, migrations; Obeya: the scratch
instance); without Obeya, `bun lib/recipe.ts` in a repository prints it. The worker records once the change is committed and checked, as the recipe
says how to run the app (Obeya: a scratch instance from the worktree, staged by
`scripts/scratch-obeya.ts` from a stage file before every take, its workers idle unless the change
is about agents (`--real-workers`); elsewhere, say, the clone's own app), and hands over the
directory and chapter titles with `ready_for_review`. A scratch Obeya speaks the stage's `language`,
else the language of the demos where the script runs (`DEMO_LANGUAGE`, else the demo settings'), so
the screen matches the narration; the stage's card titles and conversations are written in it
(Obeya's `app.run` asks for English). What happens while an agent works (a line arriving in an open
conversation, an artifact handed over again) the script makes happen without one: `--say` and
`--artifact` act as a staged card's agent through the server, which runs that agent's own tools
for it (`Workers.standIn`, `POST …/cards/<id>/stand-in`, offered only with `--idle-workers`), so the
page gets the change as from a real agent. A card staged at work has no session; it gets a stand-in
for one, its tools working as a session's would, with no turn begun or ended. A staged HTML artifact
is a copy in the scratch directory, which `--artifact` rewrites, so a take never changes the stage's
own files.

Before the first render it runs `node demo.ts --dry`: `login`, `open` and the scenes against the
app, without narration, setup check, screencast or ffmpeg (`untilSpoken` does not wait), under the
same per-demo lock as a render, so a scene that waits for a state that never comes fails before
synthesis and the scenes before it. A failing step names the page's URL, the screenshot and
Playwright's message on lines of their own. A page that hangs fails the render too, instead of
leaving it waiting: a call into the page (the overlay's, `d.evaluate`) that gets no answer within 20
s fails its step, and so does a screencast that sends no frame for 20 s (the clock strip repaints
every frame, so a live page always sends them). A computer that sleeps mid-take fails the take at
once, named as such: the director's own timer ticking five seconds late means it stood still, and a
Mac's kernel says whether it slept meanwhile (`kern.sleeptime`). A step that fails after the
director stood still names that as its likely cause, a possible sleep where no kernel tells. On a
Mac the director holds `caffeinate -i` while it runs, against idle sleep; a laptop with its lid
closed on battery sleeps regardless. A demo started with `bun demo.ts` runs
again under Node (see the decisions).

#### Cutting waits

Waiting is cut out of the video. The scene wraps such a wait in `d.skip`; the page fades to white,
the cut falls while it is white, and it fades back in with how much later it is ("31 Sekunden
später"), about two seconds in all. The cuts come out of the frames, the narration offsets, the
chapters and the captions alike (`lib/timeline.ts`); a narration clip the cut falls into goes on
across it, so a skip belongs after the scene's narration, and the next scene says the jump ("Kurz
darauf"). A wait under five seconds stays in the video: `skip` fades only once the wait has run five
seconds; those first seconds are cut without a trace (the picture rarely changes in them), the rest
falls into the white. The review table flags a scene with more than 5 s without narration.
A wait that is only the app's latency (a reply that takes a few seconds), not time the viewer would
spend waiting, is cut whole without flash or label (`skip(fn, { quiet: true })`): the hero video's
"5 seconds later" over Obeya reading a command made its replies look slow (2026-10-14).

#### Pauses in every voice

Pause tags in the script (`[short pause]`, `[long pause]`) are silence in every voice: ElevenLabs v3
and v4 read them, any other voice speaks the parts between them one by one and `tts.py` joins them
with 0.5 s or 1.5 s of silence. Before (2026-10-14) other voices got the text without them, so a
render in Qwen3 ran sentences together that the ElevenLabs one kept apart.

#### Sharp for a public page

A demo is recorded at one pixel per point and compressed to CRF 30 (about 2.5 MB a minute), small
enough to share; text stays legible but flat colours go grainy on a large screen. A public video sets
`sharp` in its spec: the page at twice the pixels, as on a Retina screen, screencast frames at JPEG
quality 100 and CRF 18, so it looks as the app does live (the hero video, 2026-10-15).

#### Re-voicing

A demo that kept its frames (`.work/` with `frames/` and `frames.txt`) can be narrated anew in another
language without recording it again (`node demo.ts --revoice en`, or `node lib/revoice.ts <dir> en`
for a demo whose script no longer runs). When Obeya's demos went public in English (2026-10-19),
the latest demos of its 30 most recently approved cards that kept their frames went public too,
re-voiced while their screen stayed German; the older ones stay private, and the hero and release
videos have their own. It reads what the render left in the directory, not the
script, so it works on a demo of any director version: the narration from `.work/jobs.json`, the
chapter titles and scene starts from `chapters.vtt`, where each clip ran from `captions.vtt`, the
report from `index.html`, `sharp` from the encoder settings x264 notes in `demo.mp4` (CRF 18).

1. The first run writes the words (`.work/revoice/source.json`: title, per scene its chapter title
   and narration, the report) and asks the agent running the skill for them in the language
   (`.work/revoice/en.json`, same shape). The agent, not a script, translates: it reads the labels
   from the stills, since the screen keeps its language and the narration quotes each label as it
   appears with its meaning after it: „Teilen“ (Share), in the narration as an aside („Teilen“, share),
   which Qwen3 spoke more reliably than parentheses. A translation that drops a scene, an audio tag
   or a paragraph of the report's summary is refused with what is missing. A report page from before
   2026-10-19 also has lists of what was shown, not shown and noticed; they are left out.
2. The clips are synthesised in the voice for that language (the demo settings' clone of
   `references.en`, say).
3. Each scene's narrated stretch (its caption cue) plays as long as its new clip: the frames in it are
   held longer or shorter by the clip's ratio, so an action timed with `untilSpoken` lands on the same
   word; the lead before the words, the gap after them, what follows them and the cuts' flashes (a
   `skip` belongs after the words) keep their length and move along. A frame across a cue's edge
   takes a share of both. A scene whose words change length by more than a third is flagged for a
   look at its stills.
4. `demo.mp4` (encoded as recorded: CRF 30, or 18 when sharp), `captions.vtt`, `chapters.vtt`, the
   stills, the poster and `index.html` are rebuilt in place by the same code as a render
   (`assemble` in the director). The demo as recorded stays in `.work/revoice/original/`, which every
   later run reads from, so a corrected translation re-voices from the original again.

The card then shows it: `POST …/cards/<id>/demo-rebuilt` (`Sharing.rebuilt`) reads the chapters
again from `chapters.vtt` and drops the page text the worker wrote for the old words, so the share
writes it again in the language the report page names. A demo on a shared page is not changed under
the page: it is withdrawn first. `scripts/revoice-demos.ts list` names the latest demo videos of a
canvas's most recently approved cards that kept their frames and where each stands; `publish` has
Obeya re-read and share them through its queue.

#### Frames on time

Frames go on the video by the time they were painted, not by when the screencast handed them over:
`overlay.js` paints the time into a strip of 24 black and white cells at the page's bottom left, the
director reads it from every frame (one ffmpeg pass, `readClock` in `lib/timeline.ts`) and paints
the strip over in the video. The overlay runs in the top frame only: Playwright runs init scripts in
every frame, and until 2026-10-16 each iframe (an HTML artifact on a card, say) painted a strip of
its own at its bottom left, which stayed in the video.

#### Highlights

A highlight ring goes around what can be seen of its elements: each element's box is cut to every
ancestor that clips its overflow (a scrolling list, a card's conversation) and to the window, an
element out of sight does not count, and this holds while the ring follows scrolling.
One layer dims the rest of the page for all rings together, with a hole for each ring in its CSS
clip path. Until 2026-10-15 the holes were cut by an SVG mask over the whole page: each time the
mask's layer went, Chrome stalled for about 0.27 s, a jerk in the video wherever a ring was cleared
(a card being dragged, a new card appearing), on a quiet machine too.
A highlight on just the elements a ring of the scene has already stops the scene with an error
naming both labels: its locator has mostly matched another element than meant. A demo of
2026-10-20 ringed the interface language's row a second time for the conversation language, whose
locator also matched the first row's hint, and the video showed the label on the wrong row. To
relabel an element, a scene clears its highlights first.

### The demo on the card

Obeya takes the chapter times from the captions and serves the video, poster and captions of the
card's demo (range requests). The card shows it on the left, the conversation with the field for
feedback beside it and approve below both; feedback asks for a new render. A video without a
`poster.jpg` (one the demo skill did not render) shows its first frame instead (`noPoster`), and
the player takes the video's shape from its metadata: until a video first plays, Chrome sizes it by
its poster, and a poster that did not load left a flat strip of 300 × 150 at full width.

When the result is something to look at rather than something that happens, the worker makes an HTML
artifact instead (`kind: 'html'`): a directory with an `index.html` and the files it loads, handed
over the same way. The card shows the page in a frame where the video would be (no chapters); Obeya
serves any file of that directory, none outside it (by its real path: a link to a file elsewhere is
not served, published or exported, `demoFile` in `src/server/demo-page.ts`), with a CSP sandbox and the frame's `sandbox`, so
the page's scripts run in an origin of their own, away from Obeya's API. That origin is `null`, so
what the page loads in CORS mode (a module script, `fetch()` of a file beside it, a font) needs
`Access-Control-Allow-Origin: null`, which would let any sandboxed page on any site read the files
too. So the page's address is sent on to `<directory>/~<key>/index.html` (`keyed` in
`src/server/demo.ts`), the key an HMAC of the directory's address with a secret new at every start,
and only an address with the key gets the header; what the page loads relative to itself carries
it, and nobody learns it without Obeya's API.

Nor does the page send anything to the internet. An agent steered by text it read (a comment on a
pull request, a file) could write a page that sends what it read to another server the moment the
owner opens the card, and writing an HTML file passes the checks a `curl` to that server would not.
So the CSP of each of the worker's files (`pagePolicy` in `src/core/frame.ts`) lets it load the
files beside it, inline styles and scripts (`eval` too), `data:` and `blob:`, and nothing else: no
CDN, no font host, no other server, by `fetch`, an image, a font, a script, a form or a frame alike.
A page has to bring what it needs along. The files are named by `'self'` and by the address the
request was sent to (`ownOrigin` in `src/server/access.ts`, the one behind `tailscale serve` too):
in the sandbox Safari matches `'self'` against the page's own origin, `null`. What a CSP does not
reach, a connection opened ahead (`preconnect`, whose host name alone carries data to a DNS server)
and WebRTC, `Connection-Allowlist: (response-origin)` stops (Chrome 152 on); Firefox and Safari
know no such header, and there those two stay open. DNS prefetching is off as well
(`X-DNS-Prefetch-Control`).

A page could also leave by navigating its own frame elsewhere (`location`, a meta refresh), which
its own CSP cannot stop; Obeya's page allows its frames nothing but its own addresses (`frame-src`,
a meta tag in `src/ui/index.html`, `FRAMES_POLICY`), and that stops it. Opened in a window of its
own (an answer's page from its link), a file that may run scripts (HTML, SVG; an image comes as it
is) comes in a sandboxed frame of a page around it with the same rule (`Sec-Fetch-Dest: document`,
`framed` in `src/server/demo.ts`, which hands the frame the address's `#` part too; a browser that
sends no `Sec-Fetch-Dest`, older than about 2023, gets the file as it is). An idea's mock
has no response of its own to carry these headers, so it is written into one: the card's frame
loads an empty page Obeya serves with them (`/api/mock-frame`, connecting to nothing) and sends it
the mock's page, which it writes into itself; the policies stay with the document. The mock's page
starts with the same CSP as a meta tag, ahead of the mock's own HTML, so no comment or `<head>` of
the mock can push it out of the head (`mockPage`).

Its `index.html` comes with
the height report a shared artifact's page has (see Sharing a demo), so the frame grows to the page
and only the card's left column scrolls. The frame's height is the reported one, rounded up, plus
its border (and the report counts a scrollbar across the page's foot), and once the page has
reported, the frame does not scroll (up to its cap of 30,000 px).

A worker often renders a new handover's demo into the directory of the one before, so the addresses
the card loads its demo from carry the handover (`?v=<handover>`): a card left open while a new one
arrives loads the new video or page; until 2026-10-19 it kept showing the old one until it was
closed and opened again.

A handover without a demo is refused, unless the card has one from an earlier handover, which then
stands. Artifacts stay in `~/demos/`, never in git; a pull
request links a demo only once it is shared (see Sharing a demo).

### Sharing a demo

Every demo, video or HTML artifact, has "Teilen" above it, on waiting cards and on cards long done
(archived ones too); prototypes are not shared. The button sits at the right end of the demo's own
line, a compact button with a share icon, beside the hint where the demo is an earlier one; once
shared, the line holds the link, "Link kopieren" and "Nicht mehr teilen".

An artifact's page has the same title and text above the artifact, which sits in a sandboxed frame
(its scripts reach neither the page nor the site); the copy of its `index.html` beside the page
tells the page its height (`postMessage`), so the frame grows to it instead of scrolling inside the
page, at most 30 steps (an artifact as high as its window would grow on), and "In eigenem Fenster
öffnen" shows it alone: the same page with the frame filling the window (`?alone`). The artifact's
own file opened directly would run in the site's origin, as would a window the artifact opens if
the frame let it leave the sandbox (`allow-popups-to-escape-sandbox`, until 2026-10-16). It opens
no window at all now: a window may go to any server (`allow-popups`, until 2026-10-16).

The frame's origin is `null` there too, and a static site cannot answer the way Obeya does (a keyed
address, see The demo on the card): Cloudflare Pages sends `Access-Control-Allow-Origin: *`, other
hosts nothing; from a ZIP opened from disk no CORS request loads. Behind a login (Cloudflare Access)
no request of the frame for a file gets through at all, an image as much as a module script: the
browser sends it as cross-site, without the login's cookie (Firefox never sends it there, its Total
Cookie Protection keeps a sandboxed frame's requests apart; Chrome where the cookie is not
`SameSite=None`), and the login answers with its own page on another host, which the policy
blocks. The frame's own navigation (its page, a link to another page or an image) carries the
cookie. From disk Chrome loads nothing at all beside a sandboxed page, not even its stylesheets and
images, so the ZIP's page lets the frame keep the page's origin when it is opened from disk
(`file:`; there is no site to keep it from) and sandboxes it as the site does when served. So the
pages of the artifact's copy load no file beside them (`artifactCopy` in
`src/server/artifact-copy.ts`, for the site and the ZIP alike): its module scripts are bundled into
its `index.html` (`Bun.build`; imports from a CDN or a package stay imports, a script that does not
bundle stays as it is, and the comments naming the modules' paths on this machine go); the files
its pages name (an image and its `srcset`, a poster, media, a classic script, a stylesheet with
what it imports and names in turn, a font, an icon, a CSS `url()` in a `<style>`, a `style`
attribute or a script's text) go in as `data:` URLs; and the files its scripts may fetch (all but
images, media, scripts, stylesheets and fonts) go into the page, where `fetch` and `XMLHttpRequest`
get a GET for them answered without asking the site. A `<base>` of the page is heeded (one leading
out of the directory or to another server leaves the page as it is), a `#` part kept (a part of an
SVG), and a `srcset` read as browsers read it. A page with many large images gets large with them
(a third more than the files), and the host's limit for one file (25 MiB without `maxFile`) holds
for it; stylesheets that import each other many times over stop at 64 MiB of `data:` URLs a page
(`DATA_BUDGET`), past which the files left stay URLs. All of it comes from the artifact's directory: a file goes in only where its real
path lies there (`demoFile`), so a link to elsewhere stays out, and a module script stays as it is
where its bundle took in a module whose real path lies outside (a path out of it, a link, a path a
`tsconfig.json` maps a package to; the build's metafile names them); macros (`import … with
{ type: 'macro' }`, code of the artifact run at the build) are off. Otherwise a worker steered by
what it read could put a file of the owner's into a page that goes public with „Teilen“. What still
cannot load in the frame: a Web Worker's script, an `import()` of a path computed at run time, a
font set from a script, and behind a login a file a script names at run time (an image's `src` it
sets).

A shared page sends nothing to the internet either, under the rule a worker's page has inside Obeya
(see The demo on the card): until 2026-10-16 its artifact could still load from and send to any
server once a colleague opened the page. The copy of each of the artifact's HTML pages (its
`index.html`, and any other the artifact may open in its frame) starts with the CSP as a meta tag (`sealed` in `src/core/frame.ts`, `pagePolicy` there): its own files, inline
styles and scripts, `data:` and `blob:`, nothing else, so an import from a CDN stays an import but
does not load. Its files are named by `'self'` and by the site's address (for Safari, as inside
Obeya); in the ZIP by `file:`, since `'self'` need not match a page opened from disk, where the
frame keeps the page's origin. The artifact in the one HTML file has no files of its own and gets
the policy without any (`srcdoc`, which also keeps the policy of the page around it). The page
around the artifact has a policy of its own (`artifactPageHtml` in `src/server/demo-page.ts`): it
shows nothing in its frame but its own files, so the artifact cannot navigate the frame to another
server (a link, `location`); the copy turns DNS prefetching off. A host that reads a `_headers`
file (Cloudflare Pages, Netlify) gets one at the site's root (`artifactHeaders` in
`src/server/site.ts`): the artifact's files come with the same CSP, with the sandbox, so a file
opened directly does not run in the site's origin, and with `Connection-Allowlist:
(response-origin)`, which keeps a `preconnect` and WebRTC to the site (Chrome 152 on). Without
those headers, on another host or in an export, those two stay open, as they do in Firefox and
Safari (a meta tag cannot carry `Connection-Allowlist`, and `webrtc 'block'` is heeded by neither
Chrome nor WebKit), and so does a file that runs scripts without being an HTML page (an SVG the
artifact opens in its frame), which no meta tag reaches. Under `file:` the policy lets the artifact
load any file of the disk, not only its own; `'self'` matches them all as well, in Chrome and
WebKit alike.

#### Where a demo goes

Where it goes depends on the repository's demo site: the static site its settings name, once it is
complete (`demo.site`, see Static sites; `siteOf` in `src/server/canvas.ts`). With a site, the demo
is published on a page there. "Teilen" publishes right away, without a hold to take it back: "Nicht mehr
teilen" withdraws the page just as easily. Once the page is up, the card shows the link (open, copy)
and "Nicht mehr teilen". Nothing is replaced on its own, unless the site publishes on approval (see
Publishing on approval).

#### Several versions on one page

Sharing belongs to a demo version, not to the card: a card has one page under one link, and the
page holds the versions the owner shared, stacked in order of handover. The first one shared is on
top with the page's title and text; each later one is below it as „Ergänzung vom 16.10., 13:37“
(„Addendum of Oct 16 at 13:37“), the time of its handover (its parts joined by Obeya, not by the
platform's ICU, which joins them differently on macOS and Linux), with its own title, text, chapters and video or
artifact; with two or more, a list of them stands under the title. A page with one version looks as
it did before (until 2026-10-16 a page held one demo), so those pages are not outdated by it. A
later demo often only corrects or explains one detail, and standing below the one it corrects it
is read after it; a page newest first, one player with a version switcher (a colleague would see
one version and might never find the other) and a page per version (several links for one change)
were dropped.

The share box is about the version shown in the line above the demo (see Earlier demos). On a
version on the page it holds the link, "Link kopieren" and "Nicht mehr teilen" for that version:
the page goes out again without it, and the last one takes the page down. With earlier demos on
the card, a line says which versions the page holds („Auf der Seite: Demo 1 und 2“); a card with
one version shared and no earlier demos reads as before. On an earlier version not on the page,
"Teilen" adds it in its place by handover. On the latest, not on the page yet, the hint „Die
geteilte Seite zeigt Demo 1.“ offers „Auf der Seite ersetzen“ (it goes on the page, the shared
ones off) and „Zur Seite dazunehmen“ (it goes beside them); the buttons name the page, since the
choice is about what the page shows, not about the card's demos. Which comes first is the worker's word: `ready_for_review`
says of a later demo whether it was recorded afresh (`follows: replaces`) or only supplements the
one before (`supplements`), the demo skill asks for it, and a line under the buttons says what the
worker said, as a sentence about the video („Laut Agent ergänzt dieses Video Demo 1.“ / „… ist
neu aufgenommen und ersetzt Demo 1.“; until the owner's feedback on 2026-10-16 a label, „Der
Agent: ergänzt Demo 1“, which did not say what was supplemented). Without its word „Auf der Seite ersetzen“ comes
first, as the latest demo always replaced the page before. The worker only suggests: nothing goes
out without the owner's click.

The page has a title and two to five sentences for colleagues who have never seen Obeya: where the
repository has a site, `ready_for_review` takes them with every demo (`demo.page`), and for a demo
handed over without them a short read-only session writes them from the worker's last summary when
the owner shares, kept with the demo afterwards.

#### Publishing

Pages go out one change at a time, through one queue for all canvases (`src/server/share.ts`):
`publish` writes the card's page on its site (slug, kind `video` or `html`, title, text, chapters,
PR URL, the demo's language, demo directory, the later versions with the same and their handover's
time, and the slugs of the other pages shared there), and `withdraw` takes it down. A share keeps
each version on the page (`StoredShare.demos`: its handover, directory and what the page says of
it); a share from before (one `dir` and `shown`) reads as a list of one and is converted at startup. The slug comes from the card's title and id once and stays, so a link
keeps working across publishing again. What the deploy says goes into the card's log, a failure
with its output as an error, and the card stays as it was. A share publishing or withdrawing at a
restart goes on after it.

#### Outdated pages

Inside Obeya a card's pages go to its share target (`ShareTarget` in `src/server/share.ts`, its
site): pages whose targets have the same key (the site's URL's host and path) are on one site, so a
publish names the others. Keys are not stored.

What changes on the pages is written down as it changes: `PAGE_CHANGES` (`src/core/page-changes.ts`)
lists each change a viewer of the pages sees, oldest first, with the kinds of page it shows on
(video pages, artifact pages, or both), its words in the UI's strings (`pageChanges`, by id). A
share keeps the newest change when it was published (`version`, '' before any). The changes after
it that show on its kind of page are what sharing it again brings; a page that lacks one is
outdated and shows them on its card, each with its day ("Seit diese Seite geteilt wurde, haben sich
die Seiten geändert: …"), beside "Erneut teilen" and "Nicht mehr teilen": the same demo published
again under the same link, with all its versions. A page's changes are those of the kinds of page
its versions show (a video and an artifact on one page: both). The latest demo, not on the page,
brings them with „Auf der Seite ersetzen“ or „Zur Seite dazunehmen“.
Each page is brought up to date on its own card. A change that shows nowhere (a refactoring, a style
only the other kind of page uses) gets no entry and marks no page. That the list misses no change
is a test's: `PAGES_HASH` pins a hash of sample pages in both languages with everything a page can
have (`pagesHash` in `site.ts`: a video page, an artifact page and a page with several versions,
its addenda's times in UTC so the hash is the same on every machine), and the test fails once the pages come out different, saying to add
an entry where a viewer sees the difference and to take the new hash either way. The site's title
is not part of it: a new title shows on the overview with the next publish and on each page once it
is published again. Pages published before the list (until 2026-10-16) kept a hash instead; at
startup their change is read off the page in the site's directory, once. A page whose demo files
are gone (demos get deleted to free space) is neither offered nor counted: there is nothing to make
it from again, and it stays out as it is.

Many at once go from the Koordinator's sheet: while pages are outdated, a purple entry says how many
(„N geteilte Demos sind veraltet“, archived cards' included), lists what changed since, each change
with its day and how many of them lack it, and shares again the newest 20 of them
(or 10, 50, 100, all), newest by the video file of the newest version on the page. They go out one after the other through the
same queue as every share, each published as it shows (what the share kept, so a newer demo on the
card still waits for the owner), and a share the owner starts meanwhile goes out between two of
them. The entry shows how many are out, the one going now, and the failed ones with their cards (the
reason is in each card's log, the page stays outdated); "Anhalten" lets the page going out finish
and leaves the rest. "Ausblenden" puts the entry away, with the result of a finished run: the owner
has shared as many again as were worth it. It comes back for the pages a newer change leaves
outdated (setting `reshare_dismissed`, the newest change when it was put away); the cards go on
offering "Erneut teilen". The run is kept (setting `reshare`), so it
goes on after a restart; a page shared again on its own meanwhile, withdrawn or deleted drops out of
it. It is not counted on the Koordinator button: the cards offer "Erneut teilen" each, and nothing
is lost by leaving them.

A page published again with the same video keeps its date („Geteilt am“) on a site that shows it, so
the overview keeps its order when pages are brought up to date or get their PR's link; a new video
dates it anew.

#### The page and the pull request

The pull request and the page link each other. A demo shared before approval goes into the worker's
approval message with "link it in the description". Once a PR exists and the page is out (in either
order: `pr_opened` after sharing, or sharing a card whose PR is open or merged), Obeya reads the
description through the forge (`gh pr view --json body`) and, unless it contains the page's URL
already, adds a line `Demo-Video: <url> <!-- obeya:demo -->` (`Demo-Seite:` for an artifact; „Demo
video:“ and „Demo page:“ in English) (`gh pr edit --body-file`); a later line of its own is found by
the marker and replaced, not added again. A page shared before the PR existed is published again
with the PR's link: what it showed then (title, text, chapters and demo directory, kept with the
share, every version on the page), not a newer demo on the card, which still waits for the owner. The card goes on showing
the link meanwhile; a PR reported while the page is going out gets a second round after it. A
failure to read or edit the description goes into the card's log; the page stays shared. Withdrawing
the page leaves the line in the description.

#### Publishing on approval

A site may publish every approved demo by itself (`demo.site.publish: "approved"`; „Auf die Site
kommt eine Demo: beim Klick auf „Teilen“ / mit der Freigabe“ in Konfiguration): Obeya's own
repository does, so its feature demos are public on `demos.obeya.si` without anyone clicking
"Teilen" for each. Without it a demo goes out only on that click, as before.

The owner decides per card: until the card is approved, its latest demo not on the page has a
checkbox „Mit der Freigabe teilen“ ("Share on approval", ticked) beside the button, which reads
„Jetzt teilen“ ("Share now") there. Unticked, approving shares nothing, and the card's log says so
(„Mit der Freigabe nicht geteilt“); a demo the owner wants to discuss with colleagues or have them
review before approving goes out with „Jetzt teilen“. Both are needed: until 2026-10-20 such a card
had only "Teilen", and approving always shared. The choice stays with the card across handovers,
sharing and withdrawing (`notOnApproval` in its stored share, `onApproval` in `src/server/share.ts`,
the card action `shareOnApproval`); the repository says it publishes on approval in its
`shareOnApproval`. It takes effect at once, without an undo: a click ticks it again.

On approval, before the work lands (`Sharing.approved`, called by the workers through
`onApproval`), the card's latest demo goes on its page unless it is there already, as the owner's
click would put it: on a new page; on a page with versions, beside them where its worker said it
only supplements the one before (`follows: supplements`), else in their place, as „Auf der Seite
ersetzen“ comes first on the card; a share the owner started that is still going out goes first,
the latest demo after it. A line in the card's log says which („Mit der Freigabe geteilt“). It goes through the queue like any share, so the landing does not wait for the deploy;
a deploy that fails goes into the card's log as an error, the card lands all the same and keeps
"Teilen" to try again. The same happens for an approval of work that goes out as a pull request
(the page gets the PR's link once both are there, see The page and the pull request), for work that
changed nothing (closed as done), and for a held approval when the worker's next handover lands it
(a newer demo handed over meanwhile is the one that goes out). Prototypes are not shared.

Where a repository lands on `main` directly (`land: main`, or "Direkt auf main"), there is no pull
request to link the page from, so the commit that lands for a card with a page names it in a git
trailer: `Demo-Video: <url>` (`Demo-Page: <url>` for an artifact, by the page's first version), in
English as git trailers are, beside the trailers the message ends with (`Co-Authored-By`), else in
a paragraph of its own (`addTrailer` in `src/server/workspaces.ts`). A card with a page counts
whether the page went out on approval or by an earlier click. The URL of a page going out comes from its slug,
fixed when the card was first shared, so the trailer is written before the deploy is done
(`ShareTarget.pageUrl`); a page at rest gives the URL it was published at. Obeya amends the last commit of the rebased branch before it lands
(`--no-verify`: its hooks ran when the worker made it; the author stays), and leaves out what is
there already, since a landing that went back to the worker comes round again. A commit that
cannot be amended lands without the trailer. A page withdrawn later leaves the trailer pointing
nowhere, as it leaves the line in a PR's description. A publish that succeeds for a landing that
then fails leaves a public page for work not yet on `main`; that was accepted, since the next
handover lands it.

#### Export without a site

Without a site, "Teilen" exports the same page as a file to pass on (`Sharing.export`, `GET
…/cards/<id>/export?as=zip|html`): a ZIP with a folder named by the slug that holds `index.html`
with the video, poster and captions beside it, or one HTML file with the video in base64, played
from a blob so it seeks; only for videos up to 15 MiB (`EXPORT_HTML_MAX`, so the file still goes by
mail), the button says so for larger ones. An artifact goes into the ZIP in `artifact/` beside the
page; into one HTML file (as the frame's `srcdoc`) only when it is its `index.html` alone, which the
handover notes (`single`), else the button says it goes as a ZIP. Nothing leaves Obeya, so an export
is not held; the card's log names the file. It packs the version shown above the demo
(`?demo=<handover>` for an earlier one), one per file: an export keeps no state, so there is no page
to add to. Both pages carry their captions as cues in a script,
since Chrome does not load a `<track>` for a page opened from disk. The ZIP is written by Obeya
(`src/server/zip.ts`, stored without compression: the video is compressed already).

The page (`src/server/demo-page.ts`) is the one the site publishes, without its link to the
overview. Its own words
(the date line, the captions' name, the links, the play button) are in the demo's language: the one
the demo's `index.html` names (the director writes the report page in the narration language; an
artifact names its own), else the narration language of the demo settings. A page made without a
language is German. Its video waits with a big play button over it until
it first plays: a click anywhere on the video but its controls starts it, rather than the small
button in the corner. It does not start on its own: browsers play sound only after a click on the
page (in Obeya, the click that opens the card), so it could only start muted, which the owner did
not want.

Every page, exported or on a site, and every site's overview end in a small line saying what made
them, „Aufgenommen mit Obeya“ ("Recorded with Obeya") in the page's language, linking
https://obeya.si: a viewer who likes a demo finds where it came from. It has no setting to turn it
off: settings stay few, and a static credit line is common practice. An artifact shown alone
(`?alone`) leaves it out with the rest of the page.

#### Static sites

A static host takes the site as a directory, deployed whole with each change: Obeya keeps it in a
directory of its own under Obeya's home, writes the page and the overview, refuses files over the
host's limit and a site that lacks a page Obeya has as shared (a lost directory would take them
offline), and puts the directory back when a deployment fails. Such a host may serve no byte ranges (Cloudflare Pages
answers a range request with the whole file and 200), and a browser cannot seek in a video streamed
that way: the chapters and the progress bar jumped back to the start. The page therefore asks for a
range first and, getting the whole file, plays the video from memory.

It does that from a few values in the repository's settings (`src/server/site.ts`; a site from
`.obeya/settings.json` once the owner trusted it, see Trusting a repository's commands):
`demo.site` names the site's `title` (the overview's heading, the pages' tab titles), its `url` (a
page is at `url/<slug>/`), the `deploy` command line (`{dir}` stands for the site's directory), optionally an `env` file of
`KEY=value` lines relative to Obeya's home whose values go into the deploy's environment
(credentials, never in git; a path outside the home is refused, and `${KEY}` comes from that file
alone, not Obeya's environment, as settings from the repository could otherwise send any secret of
the machine to a URL of their choosing), `headers` for reading the live site behind a login (`${KEY}` from
`env`), the largest file the host takes (`maxFile`, 25 MiB without it) and whether each approved
demo goes on the site by itself (`publish`, see Publishing on approval). The overview is in the
repository's `demo.language`, else the demo settings' narration language: until 2026-10-19 the site
had a `language` of its own, which two settings for one need made redundant; a file that still has
it reads without it, the site kept, and the configuration names it as a problem of the repository's
settings. The Konfiguration dialog has a field for each under „Einstellungen“. A site counts once it has a title, an http(s) URL and a deploy command
(`siteIncomplete` in `src/server/share.ts`); until then demos are exported, and a site that cannot
be used (incomplete, or its deploy program not there: `siteProblem`) is the problem `demoSite` at
the repository.

The deploy runs in `share/` under Obeya's home, not in the checkout, which is often a workspace of
the pool too (a file it leaves there, as `wrangler pages deploy` leaves its cache, would keep the
workspace from being leased), with `OBEYA_HOME` set and the repository's checkout in `OBEYA_REPO`.
Its words are split at spaces outside quotes (`commandWords`), a program given as a path and any
script are found in the repository, and a script (`.ts`, `.js`) runs with Obeya's own Bun, so the
same line works on Windows. Any host that takes a directory fits: Cloudflare Pages, Netlify or
Vercel through their CLIs, `aws s3 sync`, `rsync`, a push to a Pages branch, or a script of the
repository's.

The site lives in `sites/<key>/` under Obeya's home, the key made of the URL's host and path, so
clones and repositories naming the same site share it: `site/` is deployed whole with each publish
or withdrawal, one directory per page with the demo's files, its `index.html` and a `meta.json`
(kind, title, text, chapters, PR, when first shared and when its video or artifact last changed, a
hash of the demo's own files, the page's language, who shared it; `more`, the later versions, each with the same
and its handover's time, its files in `2/`, `3/` … of the page's directory), plus the overview,
which dates a page by its newest version, and the site's Atom feed (`feed.xml`), written with the
overview from the same pages: one entry per page in the overview's order, with its title, its text
(the first sentence as summary, all of it as content), its address as link and id, and the
overview's date as updated, its language as the entry's, who shared it as its author. The overview links the feed under its
heading („Feed abonnieren“) and in its head (`<link rel="alternate">`), so feed readers find it.
Since every change writes both and deploys the whole directory, the feed is as current as the
overview, pages pulled from another machine included; a site behind a login has a feed only those
with the login can read. `backup/` holds a page set aside while a deploy runs, put
back when it fails. Pages are written
with Obeya's templates, each in its demo's language ("Geteilt am", "Alle Demos": the language its
report page names, else the repository's `demo.language`, else the demo settings'; the page's title
and text, where Obeya writes them, too), the overview in the repository's; a version keeps its date while its demo's own files stay the same (not the copies on the
site, which carry what Obeya adds to an artifact). The guard against a directory lacking pages
Obeya has as shared, and the file limit, refuse before anything is deployed. Which pages a change to
Obeya's templates leaves outdated says the list of page changes (see Outdated pages).

Each page names who shared it, under its title („Geteilt von Ada Lovelace am 20. Oktober 2026“,
"Shared by Ada Lovelace on October 20, 2026"), and the overview names them after the date („von Ada
Lovelace“): several colleagues publish to one site, each from their own Obeya. The name is git's
(`user.name` in the card's repository, which the setup asks for as the name for commits), read when
the page goes out (`by` in `meta.json`); a machine whose git has none leaves the name out. Pages
published before (until 2026-10-20) name nobody until they are shared again (change
`2026-10-20-by`). Rejected: a name of its own in Obeya's settings (one more thing to fill in for the
name the agents already commit under) and the machine's host name the manifest keeps (it names a
computer, not a person).

A machine without the site's `env` file has no target there: "Teilen" exports, with a line under the
buttons naming the file („Zum Veröffentlichen auf demos.example.dev braucht dieser Rechner
sites/demos/deploy.env.“); placed later, it counts when the owner next comes back to the page. A
site without `env` deploys with the machine's own login. A host that cannot take a whole directory
is not supported (see Decisions).

#### Several machines on one site

Several machines may publish to one site: each deploy is a full snapshot of one machine's directory,
so a machine deploying only its own pages would take the others' offline. Obeya therefore pulls
before it pushes. The site carries a manifest at its root, `obeya-site.json`: every page with its
`meta.json`, its files with size and hash, a revision and the machine (host name) that wrote it; a
withdrawn page stays listed as a tombstone with its date, so a machine that still has its files does
not bring it back. Only the machine whose card a page is changes it (slugs carry the card's id), so
its revision just counts up.

Before every publish or withdrawal Obeya reads the live manifest (with the site's `headers`, their
`${KEY}` values from the env file, since a site may sit behind a login), downloads the pages missing
here or newer there (checked against size and hash; the first share of a new machine downloads the
whole site, with a line in the card's log every 25 pages; a redirect within the site is followed,
since Cloudflare Pages answers `…/index.html` with a 308 to `…/`, while a redirect elsewhere is a
login), removes the pages withdrawn there, keeps the pages the live site lacks (its own, not
deployed yet or lost to a deploy in between), then writes its page, the overview and the manifest,
and deploys. Each manifest names its deployment. Right before the deploy Obeya reads the manifest
once more: another machine's deployment since the pull would be lost, so the round starts over.
After the deploy it reads the manifest again, for about 30 s while the site still serves the
deployment before (the deploy counts, with a line saying the site does not show it yet, if it never
does). Another machine's deployment that came in between without the change undoes it here and makes
it once more; a second one fails the share with a line in the card's log and leaves the card as it
was.

A deployment that lands after this machine's check, from a machine that pulled before it, still
takes its page offline (a static host has no compare-and-swap): the once-a-minute check when the
owner comes back also looks for the pages shared from here that the live site lacks or has older,
and deploys again (pull, then push), with a line on each of their cards; the next share from this
machine brings them back as well. Until then, or while this machine is off, the page is offline.

A manifest that cannot be read (network, a login, not a manifest) refuses the deploy, since
deploying blind could take pages offline; a site with no manifest at its URL (404) is the first
deploy. A host may answer every missing file with a page of its own and HTTP 200 (Cloudflare Pages
serves the overview for a site without a `404.html`): a manifest answered with the same page as a
file that cannot be there counts as missing, not as unreadable. A page another machine withdrew
costs its card here the link, with a line naming the machine: noticed with the next share to that
site or the once-a-minute check when the owner comes back. The guard against a directory lacking
pages Obeya has as shared stays as the last check after the pull.

### UI checks

Workers check web UIs with the plugin's skill `browser` (`plugin/skills/browser/`, `obeya:browser`):
`lib/browser.ts`, run with plain `node`, starts a headless browser and drives it over CDP from the
shell (open, nav, tabs, eval, text, screenshot, pdf, and `input` with trusted clicks, drags, wheel,
keys held across steps, typing, waits and `@selector` targets), with the names and syntax of the
owner's earlier private skill `chrome-headless`, so workers' habits and notes carried over.

Each Claude Code session has its own browser: the state file in the OS temp directory is named by
the session's process (`CLAUDE_PID`, which Claude Code gives every command), and `start` leaves a
detached Node process (`serve`) that launches the browser through Playwright
(`plugin/lib/chromium.ts`, the demo's Chromium) with a CDP port and `--mute-audio`, keeps a CDP
connection that gives every page and out-of-process frame the silent `speechSynthesis` (see The demo
skill; auto-attached with `waitForDebuggerOnStart`, so it is there before a page's first script,
and with `Page.enable`, without which it ran only in the target's first document), and closes it
once the session's process has ended (checked every second), at `stop` (CDP `Browser.close`, which
works on Windows, where killing the holder would leave the browser behind) or on a signal. Without
`CLAUDE_PID` (a terminal) there is one browser per user until `stop`. `--fake-mic` plays a WAV as
the microphone; Chrome launched by Playwright needs no audio service moved in-process for it
(checked 2026-10-14). Its tests run real browsers on macOS and Linux.

What headless Chromium can't reproduce (the on-screen keyboard and `visualViewport`, video
fullscreen, screen rotation) workers check in Obeya's repository with `scripts/android-phone.ts`:
Chrome in the Android emulator, driven from the shell (start, open, eval, tap, type, rotate,
screenshot, record, stop). Workers had built the same helpers in /tmp for each such card, which
took most of a run's tool calls, and their unbounded waits were blocked; so every wait in the
script is bounded and ends with an error naming what it waited for. It finds the SDK through
`ANDROID_HOME`/`ANDROID_SDK_ROOT` or Android Studio's default place. `start` boots the AVD with
`-read-only`, so several checkouts each run their own emulator of the same AVD at once (nothing
persists in it); the device, its DevTools port and the open page are kept in a state file in the
OS temp directory named by the checkout. A tap is a real touch (`adb shell input tap`), so the
keyboard opens (on a text field, `tap` returns once it is open and the page has settled) and
fullscreen counts as a user's gesture: the element's centre comes from the page
over CDP, the page's place on the screen from the WebView node of `uiautomator dump`. `open` turns
off what Chrome and Android lay over a page on their own (first-run screens, the notification
prompt, the offers to translate or install the page, the hint at the first fullscreen; Chrome as the debug app reads
`/data/local/tmp/chrome-command-line`), which would catch taps meant for the page; `rotate` turns the emulator's acceleration sensor, as a hand turns
the phone.

### Decisions

- **A demo is a video or an HTML artifact, chosen by the worker** (2026-10-01): drafts to choose
  from (a logo for Obeya) say more as a page side by side than as a recording of one. The summary,
  the open question and the follow-up cards are the same for both. Without any demo the owner would
  have to read to decide.
- **There is no handover without a demo** (owner, 2026-10-15). Until then a worker could hand over
  with `no_demo` and a reason where there was nothing to show (`waiting: review`), and a
  repository's settings could leave demos to the worker („Ein Agent übergibt nur mit Demo“, the
  demo's `required`, off for every repository without an adapter of its own, which then got no word
  about demos). A file that still has `required` shows it as a problem: `demo.required: no such
  field`.
- **The demo report has no lists of what was shown, what was not shown and what the worker noticed**
  (2026-10-05): the owner never read the first two, read the findings but rarely made a card of one,
  since most were not for them to act on. What the owner needs to know goes into the summary, kept
  to a few paragraphs; a problem worth a card is a proposal. The demo skill and its report page
  followed on 2026-10-19: until then they still asked for the lists and showed them.
- **A demo's scratch Obeya is staged by a script from a stage file** rather than by hand
  (2026-10-01): in the 14 card runs before, the demo took longer than the change itself, and every
  worker wrote its own staging (curl, sqlite, server start) with the same mistakes: the wrong API
  path, a server that restarted on the worker's commit, a staged "working" card that a real agent
  resumed, real agents the Koordinator started mid-take. The script writes the cards' fields
  straight into the database, so any state is a line in the stage file, and the workers are idle
  unless asked.
- **Every worker gets the plugin** (2026-10-08): until then only workers of a repository with demos
  got it, so a repository without an adapter had no way to the skill that writes one.
- **Demos do not listen back to their narration** (2026-10-15): until then each clip was transcribed
  back (Whisper, from 2026-10-14 Parakeet) and synthesised again below a 95 % match, up to three
  takes, with a setting to turn it off, a line in the setup check, a note in the report and a lock
  for Whisper. Of 1,034 clips heard back none had matched below 0.90 and 7 below 0.95, and none of
  the 3 logged retakes came out better; the owner found it overkill. The first take is the clip.
  Until 2026-10-07 the parts a voice lacked were named in German whatever the narration language.
- **A dry run before the first render, and clear failures**: twice a scene waited for a state that
  never came and showed it only in the full render, after synthesis and the scenes before it; a
  worker once took the screenshot's path, the only path in the message, for the page's address.
- **Demos run under Node, not Bun** (2026-10-09): Bun 1.3.12 closed a child's pipe when it
  garbage-collected the process object, after the descriptor had gone to the next child, so the
  recording browser lost its DevTools pipe a few seconds into the take, once the login browser was
  collected, and Playwright under Bun never noticed: every Obeya demo of a worker that ran its demo
  with `bun` hung after its first scene.
- **A render names a sleep of the computer, and keeps no display awake** (2026-10-17). Renders of
  a worker failed mid-take with "no frame for 20 s" while the owner was away, in whatever scene;
  the screencast stopped to the second when the Mac went to sleep (its lid closed, on battery,
  waking only for seconds now and then). A display that sleeps or a locked screen costs a render
  nothing: renders and a page's `requestAnimationFrame` ran through with both. Taken first for a
  hanging page, then for the sleeping display.
- **Waits are cut, but not short ones**: a demo of real agents had half a minute of a canvas where
  nothing happened; the flash for "2 Sekunden später" disturbed more than the wait.
- **Frames are timed by a clock painted into the page** (2026-10-08): on a busy machine (other
  renders, builds) the screencast handed frames over 1 to 5 s after they were painted, with stamps
  of the hand-over, more the longer the take ran: the picture trailed the narration (the hero
  video's microphone lit seconds after the spoken command).
- **A highlight ring takes only what can be seen** (2026-10-14). Until then the ring took the
  elements' whole boxes: around two comments in a card's conversation it took in the task message
  scrolled out above them and covered half the card.
- **An artifact's frame grows to its page** (2026-10-08). Before, the frame scrolled inside the
  card's column, two scrollbars side by side; then the page came out a few pixels higher than the
  frame, or a page whose images grow with its width fitted only beside a scrollbar, and the frame
  kept a bar of its own that scrolled by a few pixels.
- **Sharing belongs to a demo version** (owner, 2026-10-16). Until then a card shared one demo: a
  newer one offered "Neu teilen", which replaced the page, so a short demo that only corrected one
  detail could not stand beside the one it corrected. Now one page per card holds the versions the
  owner shares (see Several versions on one page); the worker says whether a later demo replaces or
  supplements, and the owner clicks.
- **"Teilen" sits on the demo's own line** (2026-10-14). Until then sharing came under the chapters
  and a dividing line, a button as wide as the column: with many chapters, or under a tall artifact,
  it was out of sight on opening, and it sat right on top of what followed.
- **An artifact's files are read under a key in their address** (2026-10-16). Until then a module
  script or a `fetch()` of a file beside the page was blocked (no `Access-Control-Allow-Origin` for
  the sandboxed frame's origin `null`); the header alone would let any sandboxed page on any site
  read the files of a card whose id it knows, and an answer's files sit under a thread's plain
  number. The frame's requests carry no `Referer` in Chrome, so only their address can tell them
  apart.
- **A shared artifact's pages load no file beside them** (2026-10-20). Until then images,
  stylesheets and classic scripts stayed files beside the page, which load without CORS: in Firefox
  a colleague saw only the images' alt texts on a page behind Cloudflare Access, as Firefox sent
  the frame's requests for them without the login's cookie and the login answered with its page.
  Giving the frame `allow-same-origin` would have let the artifact's scripts read every other page
  of the site with the viewer's cookie; having the page around it fetch the files and hand them to
  the frame would have left the artifact's markup without its images until a script of the copy
  put them in.
- **A shared artifact's copy loads nothing in CORS mode** (2026-10-16). Until then a shared page
  showed an artifact whose module script, fetched JSON or font did not load: the site, behind
  Cloudflare Access, answered the frame's cookieless requests with its login page, and a ZIP from
  disk loads none. Giving the frame `allow-same-origin` would have let the artifact's scripts read
  every other page of a site behind a login with the viewer's cookie; asking the page around it
  for the files works on a site but not from disk. Opened from disk, a ZIP's page showed not even
  the artifact's stylesheets and images (Chrome loads nothing beside a sandboxed page there); its
  frame keeps the page's origin now, since a file on disk has no site to keep it from.
- **HTML artifacts are shared too** (2026-10-05): an analysis with charts is background for a pull
  request as much as a video.
- **Sharing takes effect at once.** Until 2026-10-02 it held 8 s with "Doch nicht"; withdrawing is
  just as easy.
- **Deploys run in `share/` under Obeya's home** (2026-10-05). Until then a share command ran in
  the checkout, which is often a workspace of the pool too, and the cache `wrangler pages deploy`
  leaves in its working directory kept that workspace from being leased after every share ("jeder
  freie hat nicht committete Änderungen").
- **A page is outdated by a change written down for its viewers, not by any difference in its
  bytes** (2026-10-16). Until then the version was a hash of sample pages: every template change
  marked pages outdated without saying what changed, also where nothing showed (a style the security
  fix added for artifact pages alone marked every video page), so the owner could not tell whether
  sharing 70 pages again was worth it, nor put the notice away.
- **Each outdated page is brought up to date on its own card** (2026-10-05): the first share command
  wrote every page afresh with each call, which updated all of them unseen and would take long with
  hundreds of pages.
- **A shared page speaks the demo's language** (2026-10-07). Until then the page was German
  throughout, an English demo's too.
- **Static sites are built into Obeya from a few lines of settings** (2026-10-09; in the adapter
  until 2026-10-15, its `deploy` an argv rather than a command line). Two other ways were
  considered and dropped (2026-10-08): a kit library each repository's own share script calls, which
  still leaves a script to maintain in every repository, and hosting providers built into Obeya,
  which puts provider code in the core where one deploy line covers them all.
- **The demo site is the only place "Teilen" publishes to** (2026-10-15). Until then a share command
  could stand in for it on a machine: a program of the repository's that got each page as JSON
  (`publish`, `withdraw <slug>`, `version`) and imported Obeya's page templates through `OBEYA_KIT`.
  It came first (2026-10-02), and once the site was built in, the two sat one below the other in the
  repository's settings with no visible connection, the command going first. No canvas used it any
  more, and every host that takes a directory fits the site's `deploy` line; a host that cannot take
  a whole directory is not supported. Should one be needed, a `deploy` script can upload what
  changed in `{dir}`.
- **Several machines on one site pull before they push** (2026-10-09). Two other guards were
  dropped: only refusing a deploy while the live manifest lists pages missing here, which left the
  owner nothing to do but copy files by hand, and a shared storage directory (a synced folder or a
  bucket) as the site's source, which pushes the problem onto every user's setup. Until 2026-10-09
  the first share of a second machine failed on Cloudflare's redirect.
- **Each session has its own muted browser.** The private skill `chrome-headless` kept one browser
  per machine in a shared state file, so every session reused whatever instance ran, and a browser
  outlived its check: an unmuted one played demo narration through the speakers. On macOS it also
  moved the audio service in-process for a fake microphone.

## Repositories and configuration

### Canvases and repositories

Each repository on a canvas has its settings, workspaces, workers, project agents and PR watcher; the
canvas has one board and one Koordinator, whose collision checks stay within a repository. The first
repository is the canvas's home: its plan references and workspace directory are the ones a
single-repository canvas always had, so canvases keep their data. The others' plan docs are
referenced as `<repo>:<path>`; the owner's cards carry their repository, chosen in the panel before
work begins (home by default), and a proposal inherits it. The UI opens `?c=<canvas>`, the pill
after the logo switches, and on a canvas with several repositories every card names its own. Cards
on other canvases that need the owner show as a count at their entry in the switcher and, while it
is closed, as the sum on the pill; the server pushes every canvas's count to all of them when one
changes.

### Main branch

`defaultBranch` in `src/server/workspaces.ts` gives where cards start from, work lands and plan docs
and the repository's settings are read from; one function for all of them, the canvas's label and
the first setup. It is the one the owner set for the repository on this machine (`branch` in its settings, see
Repository settings), read whenever it is asked for; a clone's comes from the same setting. The
repository's `.obeya/settings.json` does not hold it, since it says where that file is read from.

Without one it is detected (`detectedBranch`):

1. `origin`'s HEAD where the checkout knows one;
2. else (a repository only on this machine, or a remote added without `origin/HEAD`) the
   repository's only branch that is not a card's (`obeya/…`);
3. else the one of them named as git's `init.defaultBranch`, `main` or `master`;
4. else the branch the checkout is on, unless that is a card's;
5. else `init.defaultBranch`, else `main`.

The usual names come before the checked-out branch so that a branch the owner checks out for a while
does not become the main branch: landing on the local main still refuses while the checkout is not
on it (`landCheckout`).

### Lesestand

A folder without git is its own Lesestand, read as it is (see Folders without git). Every git
repository of a canvas has a directory on its default branch that its plan docs are read from
(the canvas, „Plandokument lesen“, the last state kept on a project; unless they are in a folder
outside the repository, see Plan docs) and that the agents that answer
or judge rather than work on a card run in (`src/server/read-tree.ts`): project agents, ideas'
exploration agents, the Koordinator (and its look-ups, learner and Rückschau), the Arbeitsrückschau
and the voice commands' session.

Where work lands on the local main (`land: 'main'`, Obeya), it is the configured checkout itself,
which is always on its main branch, uncommitted plan docs included. Otherwise the configured
checkout is often one of the pool's clones and on the branch of the card that leased it last, so the
Lesestand is a detached worktree of it under Obeya's home (`read/<canvas>/<repo>`), on the commit
`.obeya/settings.json` is read at too (`defaultBranchCommit`: the local default branch where it has
everything `origin`'s has, else `origin`'s). Branch switches, `reset` and `clean` in the clone do not reach it,
and the clone's `git status` stays clean, so leasing is not affected; the clone's `.git/worktrees`
has one entry more. A worktree there at the start is used again; one missing, broken or of another
repository is made afresh (`git worktree prune` first), and where none can be made the checkout is
read, as also while its directory cannot be removed (on Windows, while an agent works in it); the
next refresh tries again. Hooks do not run for it.

It refreshes with every round of the PR watcher (2 minutes), so also when the owner comes back to
the page, and right after a merge: `git fetch` of the default branch in the checkout (only
`refs/remotes/origin/<branch>`, no `FETCH_HEAD`, so safe while a card leases the clone), and where
the chosen commit moved, a forced detached checkout and a fresh read of the plan docs. A fetch that
fails (offline, a lock held by a lease) goes to the log and is tried again next round; the Lesestand
keeps its commit. What counts is what is on `origin` (or the local default branch of the checkout,
where it has all of `origin`'s): a doc committed only in another clone, or only edited, does not
show in such a repository. Workers, leasing and landing stay in the checkout and
the clones; `repoInfo` and the configuration are unchanged.

### Plan docs

A doc in the repository's plan directory (`planDocs` in its settings) is a project when its
`## Workstreams` section has a checklist; each top-level item is a workstream
(`**W3:** Title. Details`). Checked means `live`, `(in review)` after the label means `in PR`,
anything else `planned`. The goal is the first paragraph under `## Goal` / `## Ziel`. Obeya reads plan docs and never writes them; workers tick off
their workstream in the doc as part of their change.

A plan card gets a stored row the first time it is seen, so the owner's placement persists; its
title, text and state always come from the doc. Each read also keeps the doc's last state on the
project (title, goal, workstreams with key, label, title, text and state).

#### A plan folder outside the repository

Some keep their plans out of the repository (gitignored, or in a folder of their own). The plan
directory is then an absolute path, or one from `~`, set on this machine in the configuration
(`outsidePlanDir` in `src/server/repo.ts`): Obeya reads and watches the docs there as they are, not
from the Lesestand, and refers to each by its absolute path with forward slashes (so a Windows drive
does not read as a repository's id), which is what the agents are given too. Workers on this machine
have the folder as a directory of their own (`dirs`): one ticks its workstream there, which takes
effect at once and goes into no commit; the card's work in progress still wins over the box until
it lands. A doc that „Als Projekt planen“ writes there cannot land, so Obeya names it at the start
(the card's title as a file name, beside the docs there, with `-2` where that one exists) and keeps
it on the card as the doc it adds (`plan_docs`); the doc shows as a project as soon as it is
written, and the project takes the card's place once the owner has approved it (the card is `done`
without a change). Workers on other machines do not reach the folder.

#### Docs that are no projects

The other `*.md` in the plan directory are not hidden: one quiet note above the projects
(`src/ui/planDirs.tsx`, top left, kept in view by the camera like the cards) names the directory and
lists each with its reason (no `## Workstreams` section, or one without a checklist) and "Als
Projekt aufbereiten". That starts a card, right of everything on the canvas, whose worker adds the
checklist (and `## Goal` if missing) in the doc's own style, turning tasks it keeps under another
heading into it; the change lands like any other and the doc becomes a project. While the card runs,
the doc's row shows "Wird aufbereitet" and opens it. A repository with no plan doc that never had a
project gets a dashed note in the same place: where Obeya looks and that "Als Projekt planen" on an
idea or task card writes the first doc there, with "Ordner ändern", which opens the configuration at
the repositories (the directory is the setting `planDocs`). Its × ("Ausblenden") hides it for that
repository and directory on the canvas, in this browser (localStorage): a canvas without projects is
a normal state, and the note has said what it has to say once read. Another directory in the
settings brings it back; the note on docs that are no projects has no ×, since each of its rows is
something to do.

#### A workstream's state

Work in progress (`working`, `waiting`, `inPr`, `approved`) wins over the doc, so a workstream
ticked off on its branch still waits for its merge; then a ticked-off workstream is `live`;
otherwise the stored state counts (`done`, `planned`), and without one the doc's. Stored `live`
means its work landed, and holds only until the Lesestand has what landed: a card keeps the commit
it landed with (`shipped`: the commit on main after a direct landing, the merge commit GitHub names
for a pull request, else the Lesestand's commit after the first fetch following the merge). When the
plan docs are read again and the Lesestand has that commit while the workstream is still unchecked,
only a part of it is done: the card is stored as `planned` again, with the line „Teil gelandet, im
Plan-Doc weiter offen.“ in its log, and shows „Teil gelandet · PR #821“ (or the commit). Its log and
handover stay; its pull request moves into `shipped`, and its branch goes, so a new run starts on a
fresh branch from main and hears what landed. Cards that landed before the commit was kept count as
landed in the Lesestand. A worker still finishing after the landing keeps its card live until it is
done. `done` (finished without a change) stays: without a commit the doc has nothing to say about
it.

#### Reading a plan doc

The owner reads a plan doc where the project is: "Plandokument lesen" in the project's sheet widens
it and shows the doc as written, rendered, kept current with the file; a workstream's card opens it
at the workstream's item. Esc goes back to the workstreams. The server hands out only docs it shows
as projects, by project card, never a path.

#### When a project ends

A plan doc with every workstream ticked ends its project as one that disappears does (see Projects
end). The docs as last read decide which projects stand (`openDocs` in `src/server/board.ts`),
checked again whenever a card changes, since a worker finishing after the landing holds its project.
A doc already done when Obeya first reads it gets its rows, placed after the new projects, and goes
straight into the archive; an unticked workstream added later brings the project back to its place.
In Obeya's own repository docs still go once done, usually shortly after their project has gone into
the archive.

A plan doc that disappears ends its project: the project goes into the archive with that last state,
and returns with its placement when the same file comes back. A workstream still at work holds it on
the canvas as the doc last stood (`openDocs` takes the stored doc), and the end of that worker's turn
reads the docs again, which archives it. Known edges: a renamed doc makes a new
project and leaves the old one archived.

#### Watching the plan directory

Obeya watches the plan directory and the nearest directory above it: git removes the plan directory
with its last doc, and the directory's own watch then reports nothing. Bun before 1.3.14 on Linux
delivers nothing to a watch on a directory that was watched before, then removed and created again
(oven-sh/bun#42570): such a directory is polled every half second instead. On macOS Bun has one
FSEvents stream for all watches of the process and starts it afresh, "since now", for each new
watch: until it is live (up to 200 ms on a busy machine, more when many open at once) the events of
every watch are lost. A watch there follows its path, so it stays open while it is wanted instead of
being opened again with each change. A saturated fseventsd (load 40–80) delivers events seconds late
or not at all, even to a live watch: it coalesces what it dropped into an event for a directory
above, and Bun passes on only events under the watched path. So on macOS the plan directory is also
polled every 2 s (names, mtimes, sizes of its docs) and compared with its state at the last read, as
a safety net behind the watches, which stay the primary way. The watch tests check the watches
alone: there a plain recursive watch on the test repository, in the same stream, and a marker
written after each change tell a change the system lost (most of them with fseventsd at full CPU,
2026-10-14; Bun, Node and fswatch alike) from one the watches missed, and a lost one is put back and
made again.

### Repository settings

What Obeya knows about a repository is in its settings: the recipe for running its app (how to
start it, what to do after a change, where it is, login and test data for a demo: `app.run`), how
Obeya stops it while a card waits, where plan docs live, which checks run and how approved work lands, the static site demos are shared on. They
are values, in two layers: `.obeya/settings.json` in the repository (`SharedSettings`), for everyone,
and `settings` of the repository's entry in `canvases.json` (`RepoSettings`), set for this machine
in the configuration dialog without a line of code, which holds the main branch too.

The fields: `land`, `direct`, `checks`, `setup`, `planDocs`, `softPaths`, `workspaces`, `prNoise`,
`language` (of what lands in the repository; see Language), `app` and `demo`. `app` has `run`, `stop` and `keep`. Only what Obeya itself acts on is a command:
`stop` and `keep` park a waiting card (see Parking). `run` is prose, for any kind of app (a web app
with or without hot reload, a frontend that needs a reload, a CLI, a desktop or mobile app, a URL
printed to the console): every worker's brief has it word for word, and its demo paragraph points
back to it. Obeya neither starts the app nor looks for its address; the agents do, from the recipe,
and a worker tells Obeya the address once the app runs, for the owner to open it from the card
(see Trying the app by hand).
`demo` has `language`, the language of the repository's demos and of its site's overview (see The
demo settings and voices), and `site` (see Static sites). The fields of `app` and `demo` are each a setting of their
own (`NESTED_SETTINGS`): this machine may set `app.stop` and leave `app.run` to the repository, and
each comes from where it is set. The reference for every
field is `docs/settings.md`, linked from the README.

One thing is this machine's alone and never in `.obeya/settings.json`: the canvas a repository is
on. A canvas
without a name in the configuration is named after its first repository (`repoName` in
`src/adapters/generic.ts`: the name in its `origin` URL, else its directory's), and its id follows.

Precedence, highest first: this machine's values, the repository's `.obeya/settings.json`,
detection (main branch, landing), Obeya's defaults (`src/adapters/generic.ts`, `defaultsFor` in
`src/adapters/index.ts`; they cover any repository with `docs/plan/`). `layerSettings` puts the two
layers of settings together, `withSettings` puts them in front of the defaults; in the code the
result is the type `RepoAdapter`. The dialog shows each value that applies with where it comes from
(„auf diesem Rechner“, „aus dem Repository“, „Klone eingetragen“, „erkannt“, „Standard“), and
„Zurücksetzen“ at one set here takes it back to that source (`RepoValues`, worked out with the
configuration's check). Changing a value sets it here; an empty list or command is a value of its
own (no checks), an empty main branch or plan directory none. A main branch the repository has
neither locally nor on `origin` is a problem (`noBranch`) that keeps the configuration from being
saved.

Read where they are used: what a canvas runs a repository on has the settings in front of the
defaults as getters (`withSettings`) that read the repository's entry from the file as it is now
(`Config.repoSettings`, the file read again once its time or size changed), and `defaultBranch`
asks the running canvas for the main branch it set (`useBranchSetting`). Saving them restarts
nothing (see Live configuration): the canvases follow what they set up by them (`settingsChanged`):
the Lesestand moves to the checkout or a worktree when work now lands elsewhere, the plan directory
is watched afresh, a repository whose work now goes out as pull requests gets its watcher (one that
has one keeps it for the pull requests still open), where demos are shared is worked out again
(`siteOf`: the site once it is complete), and the page shows
the main branch and how work lands. `workspaces` is the exception: clones or worktrees are set up
when a repository's agents start, so changing it restarts that repository's agents, as the dialog
says at the field; where the configuration names clones it shows that instead. The Koordinator's
`configure` keeps and changes them like the rest of the entry.

#### `.obeya/settings.json`

`.obeya/settings.json` (like `.vscode/settings.json`) is what a fresh clone brings with it: every
value field but the main branch, which says where the file is read from (a fresh clone has it from
`origin`'s HEAD). It is versioned and reviewed with the code it describes. It is read from the
default branch, not from the checkout: the clones a canvas works in are on cards' branches, and one
from before the file changed (or came) would have another one or none. The default branch is the
local one where it has all of `origin`'s, else `origin`'s as last fetched (`readShared`, at
`defaultBranchCommit`). It is read once when a canvas starts and again whenever the Lesestand moves
(a fetch after a merged pull request, a landing on the local main) and when settings are saved
(`CanvasRuntime.moved`); a new version takes effect without a restart, the canvas following as for
a save, but where it changes where the workers work (`workspaces`): then the repository's agents
restart once they paused (reason `repository`, see Live configuration), and a landing that brings
that tells its worker so.

„Für alle ins Repository übernehmen“ below the form (`Config.shareSettings`,
`src/server/shared-settings.ts`) takes this machine's saved values but the main branch into the
file, keeping what else it holds; the dialog first shows the file as it will be and where it goes,
and offers it only while the configuration is as saved. Where work lands on the main branch, Obeya
commits it there with a commit made beside the checkout (a temporary index, `commit-tree`,
`update-ref` against the commit it was made on), so the checkout's other changes, staged or not,
stay as they are; a checkout on that branch gets the file as committed, and one with changes of its
own to the file refuses the takeover (`settingsDirty`). Where it goes through pull requests, the
same commit on top of `origin`'s main branch is pushed to a branch of its own
(`obeya-settings-<time>`) and `Forge.open` opens the pull request, whose link the dialog shows;
where work may also go straight to main (`direct`), the dialog offers beside it to push that commit
onto `origin`'s main branch (`pushShared`, never forced, so a protected branch refuses it). Once the
file holds this machine's values (the commit at once; a pull request when the merge reaches the
Lesestand), those values go from this machine's settings (`Config.takenOver`: a value the file now
holds and did not hold before), so the dialog says they come from the repository. The
Arbeitsrückschau proposes values for some of them, which the owner takes on this machine or into
the file for everyone, one value at a time (see Setting proposals).

#### Problems in the settings

The file's fields are checked against a schema (`checkShared` in `src/adapters/schema.ts`, zod;
this machine's are checked with the rest of the configuration). A field that is unknown (with the
known one it probably meant: `check` → `checks`) or of the wrong type does not count, a mistake
inside one taking the whole field along: Obeya's default stands in its place, and the rest works.
Each is a problem at the repository (`repoSettings`), starting with `.obeya/settings.json`, and
Obeya's log names them at start and whenever a new version is read.

A demo site that cannot be used (no title, no http(s) URL or no deploy command: `siteIncomplete`;
or a deploy program that is not there: `siteProblem`, both in `src/server/share.ts`) is the problem
`demoSite` at the repository; until the site is complete, "Teilen" exports demos.

A repository whose default branch still has `.obeya/adapter/index.ts`, a module that said what its
settings say now, has the problem `adapterGone` (`hasAdapterModule` in `src/adapters/index.ts`):
Obeya does not read the module, and the setup button below offers to move what it says into the
settings.

Commands of the repository the owner has not trusted yet are the problem `untrusted` (see
Trusting a repository's commands).

These problems are fixed in the repository (or, for `untrusted`, trusted), so they keep nothing
from being saved (`blocksSaving` in `src/core/types.ts`). A canvas that does not start at all (a repository gone, its home
repository left out) is left out with the reason in the log and its problem in "Konfiguration"; the
other canvases run (`startCanvases`).

#### Trusting a repository's commands

Some of what a repository brings Obeya runs on this machine itself, outside Claude Code's
permission checks, or contacts without a click: `app.stop` and `app.keep` (run when a card is
parked), `demo.site`'s `deploy` with its `env` file, its `url` and `headers` (read whenever the
owner comes back to the page, `Sharing.checkVersions`), and its `publish` (which deploys with each
approval, without a click on "Teilen"). The agents' sessions read the repository's
own Claude Code configuration (everything under `.claude/` and `.mcp.json`, `CLAUDE_PATHS`: the
hooks, MCP servers and helpers of its settings, and the hooks and MCP servers its skills, commands
and subagents may declare) and run what it names without asking, read-only agents included: tried on
2026-10-16 with the SDK 0.3.285 and no `settingSources`, a `SessionStart` hook of the repository's
ran in a session with only Read, Grep and Glob, and so did an MCP server of its `.mcp.json` that
the repository's own `enableAllProjectMcpServers` approved. Turning off hooks (`disableAllHooks`)
and the repository's MCP servers (`strictMcpConfig`) is not enough: its `apiKeyHelper` still ran,
and an `ANTHROPIC_BASE_URL` in its `env` took the session's requests elsewhere. A repository cloned
from someone else, or a merged change of a collaborator's, changes any of these without the owner
noticing (VS Code puts the same kind of settings behind Workspace Trust).

So these count only as the owner last trusted them. Obeya keeps, per repository (by its path, the
table `trusted_commands`), the commands as the owner last trusted them (`RepoCommands`, in three
groups: `app` for stop and keep together, since a stop without its keep could stop what it keeps;
`site`; `claude`, the text of each file under `.claude/` and of `.mcp.json`). The values themselves, not a hash: the dialog shows what changed. A group that the default
branch has otherwise (`heldGroups` in `src/server/trust.ts`: new, or changed since) is held:
the canvas reads the repository's settings without it (`withoutHeld`), so no stop or keep runs and
no site is deployed to or read (demos are exported); an agent working in the repository (its
checkout, Lesestand or a workspace of it, the most specific of them, since the home repository's
workspace directory holds the other repositories'; `withRepoTrust` in `runtime.ts`, which reads
the configuration afresh from the default branch at each start, since a commit on the checkout's
main from outside Obeya moves nothing the canvas notices) starts with
`settingSources: ['user']`, none of the repository's Claude Code configuration, and since Claude Code
then reads its CLAUDE.md neither, the agent gets the CLAUDE.md of its directory in its
instructions instead (not in a workspace on another machine). What this machine sets needs no
trust: where its values stand in for all of a group (`app.stop` and `app.keep`, or `demo.site`),
the repository's are not held; and values taken over from this machine into the file („Für alle
ins Repository übernehmen“, a setting proposal) are the owner's own (`trustTakenOver`, in
`Config.takenOver`; a trusted `keep` that went beside them is not, since the stop would then stop
what it kept). A repository with commands on the canvas before this came in (2026-10-16)
was trusted with none, so its commands wait once.

Held commands are the problem `untrusted` at the repository in "Konfiguration", counted in the
bar's button like the others: what each group does and that it waits, its lines as last trusted
against those on the default branch now as a diff, and „Diesen Befehlen vertrauen“, which trusts
what the dialog showed, the held groups alone (`POST /api/config/trust` with them; ones that
changed on the default branch meanwhile are refused, `trustChanged`; a group this machine's values
stand in for was not shown and stays untrusted; a repository the dialog's draft adds, a new canvas's
say, can be trusted before it is saved) and has the canvases follow at once (`settingsChanged`). The
values held show „aus dem Repository, noch nicht vertraut“ as their source. Whenever the canvas
reads the settings again (`moved`), it works out what is held again; a change there counts in
`configRev`, so the page reads the problems again.

A worker's own workspace may hold Claude Code configuration the default branch does not (its own
edit, or a branch from before a change): it counts as long as the default branch's is trusted, as
the worker's other edits do; what it changed there waits for trust once it lands. Trust covers the
configuration, not the repository's code it calls: a trusted hook that runs `scripts/x.ts` runs
whatever that script says now, as the checks do.

#### Writing the settings

The plugin's skill `settings` (`plugin/skills/settings/`) is how a worker writes a repository's
`.obeya/settings.json`: read the repository (scripts, CI, README, compose files, a `.obeya/adapter/`
left from before, whose values it takes over before deleting it), ask the owner what it does not
tell (login, test data), write the file, check it with `lib/check.ts` (it reads the checkout's
`.obeya/settings.json` as Obeya would read it from the default branch, prints what Obeya makes of
it, the plan docs among it, and lists the problems: the field problems and the site's, from the
same functions the configuration dialog uses, and a `.obeya/adapter/` still there), run setup and
checks, and prove `app.run` by recording a demo with it. The compiled binary's resources
carry `docs/settings.md` where the skill finds it up the tree, and `check.ts` bundled like
`recipe.ts`.

### The Konfiguration dialog

The canvases with their repositories (path, clones, settings), seen and edited in the
"Konfiguration" dialog. It covers the page but for a margin of the dim (a press there or Esc closes
it; what was open behind it stays as it was, and a draft not saved yet stays, written down per tab
as it changes, so a reload, Obeya's restart included, brings it back) and lists its sections on the
left: Leinwände, Modelle und Effort, Spracheingabe (with the push-to-talk key), Demos (the narration
beside what demos need on this machine), Von anderen Geräten (see Other devices) and Allgemein
(the interface and conversation languages, light or dark, the server); under the list stand „Einrichtung prüfen“ and the link
„Wunsch oder Fehler melden“ (see Wishes for Obeya's makers). One
section shows at a time, the last one chosen per tab, so a save's restart or a new language comes
back to it; Leinwände marks a draft not saved yet and counts its problems in red.

Each section is a heading with what it is about and the file it is saved in, and below it settings
as rows of label and control, parts of a section under a rule: no boxes in boxes. Its fields sit a
shade darker than the sheet with a firmer edge, so its structure reads at a glance; the one being
typed in comes up to the sheet's colour. What to know about a field that is not written beside it
sits behind a small info icon at its label, shown only while the pointer is on the field or its
label (or the field has the focus), so the page stays calm; the text shows on the icon at once, not
as a browser tooltip with a wait on plain text.

#### Leinwände

Each canvas is a heading line (number, name, id, whether it runs) over a table of its repositories:
its path, one row each. Each repository shows its id and whether workers use clones or worktrees (a
repository added in the dialog whose settings say clones gets as many as the first canvas's, two,
filled in once its path is checked and changeable before saving). The command that shares its demos
is a row of its settings, for this machine only, since it often needs credentials, so „Für alle“
does not take it over (empty: the demo site of its settings, shown as „Site: <url>“, or an export;
see Where a demo goes). Each repository folds its settings under „Einstellungen“ below its row (see
Repository settings), with the main branch and how work lands in the folded line; the app's
recipe („So läuft die App“, a large text field), its stop command („Stoppen, solange eine Karte
wartet“) and, once there is one, its keep condition, the language of what lands in it („Sprache des
Repositorys“: Deutsch or Englisch, English by default), the language of its demos („Sprache der
Demos“: Deutsch or Englisch, neither chosen where the demo settings' language applies) and the demo site („Demo-Site“: title, URL, deploy command, env file, headers as `Name: value` lines, the largest
file in MiB) have their fields there like the other settings; „Für alle ins
Repository übernehmen“ below them takes the values saved for this machine into the repository's
`.obeya/settings.json`. What is taken over is what is saved: while the dialog has changes not saved
yet, the takeover saves them first, all of them like „Speichern“ (the confirmation says so), then
writes the file; only where saving restarts Obeya (a configuration from the command line) is the
button off, saying to save first. A setting's label starts level with the first line of its field
rather than centred beside the field and its hint. Renaming a running canvas keeps its id (`id` in
the file), so its cards stay.

Problems (no git repository, a repository the canvas has already under this or another path, two
canvases with one id, a canvas's home repository left out, a path still empty) show at the field while editing and keep it from being saved; where a path without a
repository is a folder, the problem offers to set up git there (see Setting up git in a folder),
after which it goes. An empty path is read nowhere (resolved, it would be the server's own working
directory, its repository and commands shown for the new canvas): it is only the problem `noPath`.
Problems in a repository's settings for everyone (`repoSettings`: a field of
its `.obeya/settings.json` unknown or of the wrong type; `demoSite`: a demo site that cannot be
used; `adapterGone`: a `.obeya/adapter/` left on its default branch; see Problems in the settings)
show at the repository with what is wrong, and keep nothing from being saved, since they are fixed
in the repository. A problem's technical detail (the field, why the site cannot be used) is folded
under "Details"; for the configuration
as saved each problem offers "Aufgabe zum Beheben anlegen", which hands the Koordinator of the
canvas with the problem (else of the page's) the problem with its detail as a typed request to
create a task that fixes it, answered above the microphone. The "Konfiguration" button in the bar
counts the problems of the saved configuration in red; the page reads them when it loads, after
each save in the dialog, and when a repository's `.obeya/settings.json` (a field that does not
count included) or a leftover `.obeya/adapter/` changes on its default branch while the page is
open (`configRev` of the snapshot's repositories counts that).

The dialog shows the configuration at once (`GET /api/config`, the file as saved) and what it
amounts to after it, once the check is done (`/api/config/check`; „Repositories werden geprüft …“
until then): the problems, each repository's id and settings with where they come from, and the
ids of the canvases, which a rename keeps. The check reads each repository with git once, however
often the configuration names it (a canvas's repository, a workspace, a host's remote), all of them
at once and without blocking the server (`gitSteps`, `readingRepo`): three canvases with four
repositories and eight workspaces take 41 git calls in about 60 ms.

A repository with no value from its own `.obeya/settings.json`, or with the problem `adapterGone`,
offers „Von einem Agenten ausfüllen lassen“ under the words that Obeya does not know yet how its app
starts, which checks run and how to run it for a demo, and that the owner can set that under
Einstellungen or have an agent do it, while its canvas runs as saved: it puts the card "Obeya für
<repo> einrichten" at the top right of that canvas (or finds the one still open) and opens it there;
its worker fills in `.obeya/settings.json` with the `obeya:settings` skill (and, where the
repository still has `.obeya/adapter/`, moves what it says into the settings and deletes it), which
settles where plan docs go too:
it looks for plans the repository already keeps (`docs/`, `rfcs/`, `adr/`, `PLAN*.md`, a `TODO.md`),
asks the owner in its one question whether that directory becomes the plan directory (its docs then
prepared on the canvas) or a new `docs/plan/`, and its check script lists which docs there are
projects and why the others are not.

#### Saving

Saving writes the file, and the running canvases take it over without a restart (see Live
configuration); the dialog says it applies at once, and where agents of a repository restart for it,
that they do once they paused. Started with repositories on the command line, Obeya shows those, and
saving ("Speichern und neu starten") makes the file the configuration it restarts with, once no
worker is in the middle of a turn, a tenth of a second after the answer went out; the page reloads.

The server's own settings (port, data directory, the agents' permission mode) come from the command
line and the environment (`OBEYA_PORT`, `OBEYA_HOME`) and show read-only. The Koordinator reads the
configuration (`config` tool) to answer questions about it and changes it on the owner's word
(`configure`, the whole new list, checked like the dialog's), with the usual confirmation and undo
window. The dialog says so under its title, with "Obeya fragen", which closes it and opens Obeya's
conversation ready to type into (Space for voice does not reach Obeya while the dialog is open).

The other sections are saved on their own: the demo settings (see The demo settings and voices) into
`demo.json` in Obeya's home, read by the next render, so saving them restarts nothing; the language
(see Language), light or dark (see Visual identity) and the model and effort of each group of agents
(see Models and effort) the same way into `settings.json`.

### Live configuration

A configuration saved from the file (the dialog, the Koordinator's `configure`, the setup
assistant's first canvas) applies while Obeya runs, and so does a new version of a repository's
`.obeya/settings.json`: Obeya does not restart for them, and the page does not reload.
`Config.save` hands the canvases with their ids to `Canvases.apply` (`src/server/canvas.ts`): a
canvas new in it starts at once (the setup assistant's gets its welcome card then), one that changed
takes the change (`CanvasRuntime.apply`), one no longer in it stops once its agents paused, its
cards kept. Within a canvas, a new name and a repository new on it apply at once, and so do settings
that leave the agents where they work.

What a repository's agents are set up by when they start (its entry but the settings, `repoShape`:
clones, existing workspaces, slots, other machines; and where its workers work,
by its settings: restart reason `config` where the owner saved them, `repository` where its
`.obeya/settings.json` changed) restarts that repository's agents alone, and a repository that left
the canvas stops: its workers hear of it as of a restart (`DueRestart.repo`) and pause at a safe
point, at most 15 minutes, and then the repository's set-up stops and starts again as the
configuration has it now (`restartRepos`), its workers resuming in their sessions; the other
repositories' agents work on, and a worker landing such a change waits for it through
`after_restart`. The bar shows the wait as for a restart ("Konfiguration wartet auf …", with the
repositories and the cards in the hover), and "Jetzt übernehmen" (`POST /api/c/<canvas>/restart`)
has it go ahead. A restart of all of Obeya that comes meanwhile is what the workers hear of. Pages
hear of canvases that start, stop or change their name or repositories (`canvases` over the
WebSocket), so the switcher follows; a page of a canvas that stopped is closed and goes to the first
canvas.

### Language

Obeya keeps three languages apart, each German or English: the interface's, the conversation's and
the repository's. The interface is the owner's to switch at will (to test both, say) without the
agents switching with it; the conversation follows the language the owner talks in; what lands in
git stays in the repository's language whatever the owner talks in. A card may so show English UI
around a German conversation about an English plan doc: that is intended.

**The interface language** covers Obeya's own words only. The owner chooses it in the Konfiguration
dialog ("Sprache der Oberfläche"); until then the system's applies: on a Mac the language of its
interface (`AppleLanguages`), elsewhere `LC_ALL`, `LC_MESSAGES`, `LANG` in that order, then what the
runtime reports; a language Obeya does not speak gives English. The choice lives in `settings.json`
in Obeya's home (`src/server/settings.ts`; the system's language is worked out in
`plugin/skills/demo/lib/language.ts`, which the demo skill shares), which the server reads whenever
it needs the language (`ownerLanguage`, the Board's `language`) and the UI asks for before its first
render (`/api/language`).

The UI strings are two tables of one shape in `src/ui/strings.ts`, so a missing English text is a
type error; both call the Koordinator „Obeya“; dates and numbers follow the language, in the
browser's own variant of it (`en-GB` writes the day first; a variant `Intl` refuses, such as
`en-US@posix` from a Linux browser with the POSIX locale, gives the usual one). Choosing another
language takes effect at once: the page loads again, keeping what was open, as after a restart.
What the server writes into a card's log itself, the fixed parts it adds to an agent's question
("(Mehrfachauswahl)"), push notifications and its own pages are two tables of one shape in
`src/core/messages.ts` (the Board's `t`, read when a line is written, which then stays in that
language; the UI recognises the few lines it treats specially in either).

**The conversation language** is what agents write the owner in: reports, questions, replies,
handovers, idea briefs and replies, card titles, Question-card answers and their files, proposals
and their revisions, Arbeitsrückschau notes and reasons, the Koordinator's replies and
confirmations. Each agent answers in the language of the owner's most recent words to it, typed or
spoken, also where what it works on is English; words that tell no language (an option's letter,
"ok") change nothing. Before the owner has said anything to it, it uses the owner's setting
"Sprache der Gespräche" (`conversationLanguage` in the same `settings.json`; the Board's
`conversation`), which follows the interface language until chosen. The rule is an instruction in
the prompts (`ownersLanguage` in `src/core/locale.ts`, whose tools then say "in the owner's
language"), not detection code. A task the owner wrote (`taskAuthor`: typed, or put in by the
Koordinator from their words) counts as their first words to its worker; one from a plan doc, a
proposal, an idea's brief or the Arbeitsrückschau tells nothing, and the docs a worker reads neither
(the owner, 2026-10-20: a task written in English and answered in German looked wrong). Agents with no words of the owner to go by (the
Koordinator's conflict reasons, the rules it proposes) write the conversation language; the card
namer writes the language of the task it names. The Koordinator knows the owner's words for its cards
in both languages, takes examples in the conversation language and names Obeya's own cards („CLAUDE.md
ergänzen“) as the interface does; its session starts afresh once either language changed. An
analysis on a card is owner-facing, so it is in the conversation language; one a worker commits is
repository content.

**The repository language** is that of everything that lands in git and lasts: code, comments,
commit messages, design and plan docs, the CLAUDE.md lines the Arbeitsrückschau proposes. It is
`language` in the repository's settings, English where left out (see Repository settings), shown as
„Sprache des Repositorys“ among its settings. Workers and idea agents are told both languages
explicitly (`repositoryLanguage`: "What you commit … is in English, whatever language the owner
talks to you in"), so a German conversation does not make German docs; and that a demo is in the
language the demo skill's settings name.

**Demos** keep their own language per repository (`demo.language`), else the narration language of
the demo settings, else the conversation language; their shared pages follow it (see The demo
settings and voices). Obeya's own repository says English, since its approved demos go public.

Prompts only agents read stay English with German examples of what the owner may say.

### Decisions

- **A canvas may span several repositories, and one Obeya serves several canvases** (at first it was
  one canvas per repository).
- **A canvas belongs to a repository, not a checkout**: without a name in the configuration it is
  named after the repository (`repoName`, the name in its `origin` URL), so the clones share one.
  Until 2026-10-15 the repository's adapter named it (`canvasId`, `canvasName`), and while that
  adapter did not load, the setting `own_adapter_of` kept the canvas's id and name.
- **What Obeya knows about a project lives in the project's own repository**
  (`.obeya/settings.json`, read from the default branch), not in Obeya's, which is open source.
  Until 2026-10-05 adapters for each project lived in Obeya's repository and were picked by the
  `origin` URL; then a repository carried its own in `.obeya/adapter/`, while Obeya's own
  (`src/adapters/obeya.ts`) stayed in `src/adapters/` until 2026-10-15. Until 2026-10-15 too the
  configuration could name an adapter (`adapter`: a built-in one's name, or the path of a module;
  `--adapter` on the command line), a column of the dialog let the owner pick one („automatisch“,
  „generic“ or „obeya“, which only Obeya's own repository could use), and one that did not exist or
  load was a problem that kept the configuration from being saved.
- **Settings replace the adapter module** (2026-10-15). Until then a repository could carry a
  TypeScript module beside its settings, `.obeya/adapter/index.ts`. Obeya loaded it from the default
  branch (a copy per version in `.git/obeya/adapter-<tree>/`), checked its export against a schema
  (problems `adapterField` and `adapterLoad`), ran the repository on the generic adapter while it
  did not load, and took a new version over in the running canvas (`Workers.useAdapter`, restart
  reason `adapter`). Once the settings held the values (2026-10-14), the module was left with
  `stack`, `demo.site` or `demo.share`, and the canvas's id and name: values too, only written as
  code. The setup card's task then read „Schreib den Adapter dieses Repositorys
  (`.obeya/settings.json`, für Code `.obeya/adapter/index.ts`)“, which read as if the settings lived
  in the adapter. The owner asked why the stack could not be a setting; with nothing left in
  adapters that was code, the module went. Now the stack and the demo site are settings with fields
  in the dialog, the share command was this machine's alone (`demo.share` for everyone went), and the
  canvas's name comes from the configuration or the repository: everything a repository says about
  itself is in one place, and the owner sets it without code. A module still on a default branch is
  not read (problem `adapterGone`), with no transition, since Obeya is not released yet and keeps no
  old form working before its release. The skill `obeya:adapter` became `obeya:settings`,
  `docs/adapter.md` became `docs/settings.md`, and Obeya's own repository lost its
  `.obeya/adapter/`, which only named the canvas „Obeya“.
- **„Von einem Agenten ausfüllen lassen“** (2026-10-15): until then the button read „Adapter
  einrichten lassen“, under a sentence that read as if only an adapter could say how the app starts.
  Until then too „Für alle ins Repository übernehmen“ was always off while the dialog had changes
  not saved, with „Erst speichern: übernommen wird, was gespeichert ist.“, which read as if saving
  were the takeover.
- **The main branch is the usual names before the checked-out branch** (2026-10-14). Until then it
  was `origin/HEAD` or `main`, so a repository on `master` without a remote got worktrees and
  landings on a branch that did not exist.
- **Plan docs come from the Lesestand, the default branch, not from the configured checkout**
  (2026-10-06). Until then they came from the checkout's working tree: in a repository whose work
  lands through PRs that checkout is often a pool clone on a card's branch, so a doc pushed to
  `origin` from another clone never showed, a card's branch without a doc sent its project to the
  archive and back at the next lease, and a workstream ticked off in a merged PR went live only by
  chance. The agents that only read moved with the docs, so a project agent finds its doc where it
  works. Rejected: reading only the docs with `git cat-file` (the agents would read another state),
  pulling the configured checkout (it is a pool clone on cards' branches), and merging the docs of
  all clones (which state counts would be chance). The fetch rides on the PR watcher's rounds and
  the merge, without a timer of its own. Until 2026-10-07 a Lesestand directory that could not be
  removed ended the server.
- **Plans outside the repository are a folder set by its path, not detected** (2026-10-19, the
  owner's decision, from GitHub issue #1: a repository whose `docs/plan` is gitignored showed no
  projects, since the Lesestand has only what is committed). An absolute plan directory is read
  where it is, and workers reach it by its path. Rejected: noticing that the plan directory is
  gitignored and linking it from the checkout into the Lesestand and every workspace (too much
  magic), and a line in the repository's CLAUDE.md alone (Obeya itself has to know the folder).
- **Plan docs as projects, by a checklist under `## Workstreams`.** Plan-doc sync stays open (see
  Open questions).
- **The other `*.md` in the plan directory are not hidden** (2026-10-12). Before, such a doc was
  skipped silently and a missing directory said nothing, so a repository with plans of its own
  showed an empty canvas without saying why. Deferred: a more lenient parser (`Tasks`, `Milestones`,
  `Phases` as synonyms), which would turn checklists in design notes into projects while a doc off
  the format is now converted in one click; and letting a repository read its own format
  (`planDocs.read`, several directories), until a repository needs its docs to stay in a format of
  their own. Rejected: an agent mapping any doc into workstreams kept in Obeya's database, against
  "plan docs are read, never written", with no box for workers to tick.
- **A stored `live` holds only until the Lesestand has what landed** (2026-10-06). Until then a
  stored `live` or `done` beat an empty box: that came from the time plan docs were read from a pool
  clone's working tree, where the doc was often behind; it hid a workstream the doc kept open on
  purpose (configuration landed, commissioning waiting for the plant) as `live`. Rejected: the
  worker reporting "only a part" at the handover (a second source beside the doc that can contradict
  it), and a "Wieder öffnen" button (the problem shows only when someone asks).
- **A plan doc with every workstream ticked ends its project** (2026-10-12, the owner's decision): a
  repository that keeps its finished plans would otherwise keep their projects on the canvas
  forever.
- **A plan doc that disappears ends its project** (2026-10-01). Ending is automatic rather than an
  explicit "abschließen", which can later sit on top. Watching the directory above came from M5,
  which stayed on the canvas until a restart; a watch that follows its path from a second change
  lost right after the first (2026-10-08); the macOS poll from fseventsd dropping events
  (2026-10-09). Reading old content from the git history instead was rejected as fragile (PRs and
  clones, renames).
- **One recipe for running the app, and only the commands Obeya runs** (2026-10-15). Until then
  `stack` had `start`, `refresh` ("after a backend change") and `urls` (a file of `KEY=value` lines
  and the key of the frontend's URL) beside `stop` and `keep`, shown as five „App-Stack“ fields,
  and `demo.howToRun` held a recipe in prose for the demo alone. Obeya ran only `stop` and `keep`;
  `start`, `refresh` and `urls` made up one sentence of the brief, so they guessed at categories
  (a backend, a frontend, a URL file) that many kinds of app lack, and the work repository's recipe
  already repeated them in prose. Now `app.run` is that prose for every worker, `stop` and `keep`
  stay commands, and `demo` keeps only `site`. A structured form (a start command, "after a change to
  X, run Y" rules, where the app is) was dropped: it still guesses at categories, and the agent reads
  it as prose anyway. Obeya managing the app (starting it, waiting for it, an „App öffnen“ on the
  card) was dropped by the owner: nothing in Obeya needs the address. No migration, since Obeya is
  not released: `stack` and `demo.howToRun` are unknown fields now.
- **Repository settings without TypeScript, read where they are used** (2026-10-14). Until then
  these values could only be set in `.obeya/adapter/index.ts`, and saving the dialog always
  restarted Obeya.
- **A repository's settings are checked** (2026-10-08, then the adapter's fields): until then a
  misspelt field was ignored without a word, and nothing read `stack`. Until 2026-10-09 `check.ts`
  missed the problems of `demo.site`.
- **A broken canvas leaves the rest running** (2026-10-09, as did a broken adapter while there were
  adapters): until then either took all of Obeya down at its next start. Until 2026-10-09 a merged
  adapter, or a change to it, took effect only when the owner quit and started Obeya again; until
  2026-10-14 it restarted all of Obeya.
- **Obeya's configuration is the file `canvases.json`**, edited in the UI or by the Koordinator
  (2026-10-01). Saving the configuration of a command-line start switches Obeya to the file, so what
  was edited is what runs.
- **Configuration changes apply in the running process, down to the repository whose agents they
  concern** (2026-10-14), rather than through a restart: a restart of all of Obeya waited for every
  worker on every canvas and reloaded the page for a clone added to one repository. A repository's
  set-up is the unit that restarts, since its workspaces and workers are made by what its entry and
  settings say when they start; everything else (names, settings that keep the workspaces) is read
  where it is used. Until then any change but a repository's settings restarted
  all of Obeya, once no worker on any canvas was in the middle of a turn: adding a canvas or a
  repository, a clone more, a renamed canvas, a new version of an adapter landed by a card.
- **The configuration shows before its check** (2026-10-15). Until then reading it checked it
  first, with 109 git calls one after the other on the server's thread (each repository resolved up
  to three times, its main branch and `.obeya/settings.json` read several times, each of eight
  workspaces resolved in full): the dialog said „Konfiguration wird geladen …“ for seconds, and the
  whole server stood still meanwhile, every page load included, which read the configuration for its
  problem count. What Obeya reads of a repository with git is written once as steps
  (`GitSteps`) that the check runs without blocking, its calls at once, and the running canvases
  run waiting, as they did.
- **The configuration is a dialog nearly as large as the window**, its sections listed on the left,
  not a sheet (2026-10-09, the owner's wish): as a sidebar it stacked eight framed blocks, each with
  a heading above its frame and frames inside frames for canvases and repositories, in one narrow
  column to scroll through. It is visited now and then, not worked beside, so it takes the space and
  the canvas stays where it was.
- **A locale `Intl` refuses gives the usual one** (2026-10-07): until then the page stayed blank on
  it.
- **Interface, conversation and repository each have a language** (2026-10-20, the owner's
  decision). Until then one owner setting decided the UI strings, the server's log lines and every
  prompt's language for the owner, and what workers committed followed only the repository's
  CLAUDE.md: switching the UI to English to test it turned every agent English. Now the interface
  language covers Obeya's own words, agents answer in the language of the owner's latest words
  (else the conversation language, which follows the interface until chosen), and git content
  follows the repository's `language`, English by default. Dropped: two machine-wide settings
  (interface, agents), which follow neither the language the owner speaks nor keep git content
  English in a German conversation; and a personal override per canvas, which mirroring the
  owner's words covers.

## Running Obeya

### Server

Bun, TypeScript. HTTP + WebSocket to the UI, one API per canvas (`/api/c/<canvas>/…`,
`/api/canvases` lists them); SQLite (`bun:sqlite`) under `~/.obeya/`. `obeya <repo>…` starts one
canvas with the given repositories (`--name` names it); `obeya` starts the canvases
`~/.obeya/canvases.json` lists, `obeya --config <file>` those of another file. Without that file
(the first start) it serves no canvas, and the page is the setup assistant (see Setup assistant).

One Obeya per home (`src/server/instance.ts`): a running one writes its port, its pid (the
supervisor's) and whether the app started it into `server.json` in its home, and a second start on
that home says where the first runs and ends, instead of serving the same database beside it. An
entry whose process is gone, or alive but silent for 5 s (another program that got the pid), counts
as stale. A supervisor whose server ends to start again marks its entry `restarting`, and a start
meanwhile waits for it up to 90 s (new dependencies are installed first), so the app started during
a checkout's self-update opens that Obeya instead of serving the home beside it.

The app and a checkout share the home (`~/.obeya`, `OBEYA_HOME` moves it for both): canvases,
settings, voices, models and worktrees carry over, and workers one of them paused the other resumes.
An Obeya older than the database (`PRAGMA user_version` above its migrations, written by a newer
checkout) leaves it alone and says to update instead of failing later. The database starts from the
schema Obeya was released with (`SCHEMA` in `src/server/db.ts`, `user_version` 40, the steps it took
before); later changes are migrations after it. The first converts what an Obeya before the release
kept in shapes that changed since, so no code reads those shapes. A database an Obeya before the
release left below that schema is left alone too, with the commit to start once to bring it up to
date (`OlderDatabase`).

#### Who may talk to it

Only the owner. The server listens on `127.0.0.1`, which every program and every account on the
machine reaches, and some routes run commands as the owner (a demo voice that is a command, the
configuration, approving work). So two checks come first for every request and every WebSocket
upgrade (`src/server/access.ts`): that it comes from Obeya and no other site, and that it names the
owner (`src/server/owner.ts`).

*Its own site.* Any page open in the owner's browser may send requests to `127.0.0.1` (a
`text/plain` POST needs no preflight, and `req.json()` parses it all the same), and a DNS name
rebound to `127.0.0.1` reaches it under that name. So a request's `Host` (and `X-Forwarded-Host`,
where a proxy set it) names one of Obeya's own names (`localhost`, `127.0.0.1`, `[::1]`, and while
other devices reach Obeya the tailnet name or the address it listens on; the port is not checked),
else 421; an `Origin`, where it has one, is Obeya's own (scheme, host and port of the address it was
sent to, as `X-Forwarded-Proto` and `-Host` say behind `tailscale serve`), and it carries no
`Sec-Fetch-Site: cross-site`, else 403. A link from another site that opens one of Obeya's pages in
the browser's window passes all the same (a GET outside `/api/` with `Sec-Fetch-Mode: navigate` and
`Sec-Fetch-Dest: document`): it only shows the page, as typing the address would, and a phone
scanning the QR code often arrives that way, from the scanner app's page. In another site's frame
the page still gets nothing. Requests with neither header (the app's shell, scripts) pass this
check. The page and the push-to-talk panel are checked too: Bun serves an HTML bundle past
any handler, so each moves to a path made up at every start and its own path fetches it from there
once the request passed.

*The owner's key.* A request from this machine names the owner's key: 32 random bytes in
`owner.key` in Obeya's home, made at the first start, readable by the owner's account alone (0600;
on Windows the profile's own permissions). The app's shell (`app/src`) and Obeya's scripts read it
from there and send it as `X-Obeya-Key`; the page and the panel carry it in an `HttpOnly;
SameSite=Strict` cookie `obeya-<port>` (a browser keeps cookies per host, not per port: a scratch
Obeya beside the owner's has a cookie of its own). Without it the API answers 401 `notOwner` (the
page then reloads), the page and the panel are „Dieser Browser ist nicht bei Obeya angemeldet“ with
how to sign in (401), and a WebSocket opens not at all. A page a link from another site opens comes
without the cookie, which is `SameSite=Strict`: it gets a page that opens the same address again,
now from Obeya's own page, with the cookie.

A browser gets the cookie from a link, as Jupyter's: `/login?token=…` (with `&next=` a path of
Obeya's to open, nothing else) sets it and goes on from a page of its own, not with a redirect: a
link opened from another app or site (the app's shell navigates its window from its own `tauri:`
page) starts a cross-site navigation, whose redirects carry no `SameSite=Strict` cookie. The token
is made at every start of the server and signs in any number of browsers (Chrome beside Safari)
until the server stops; a link from before a restart says that it no longer holds. Who holds the
key gets the link (`POST /api/login-link`, only on this machine):

- Obeya prints it when it starts („Obeya … on http://127.0.0.1:4417/login?token=…“), at every
  restart anew.
- A second start of Obeya while one runs says where it runs and prints the link to it.
- The app's window and its panel sign in through it at every start. „Im Browser öffnen“ (the File
  menu on a Mac, the configuration) opens the page in the default browser through a link with a
  token of its own (`once`), which signs in that one browser: it goes through the system's `open`,
  whose command line other accounts on the machine see in the process list.
- `scripts/scratch-obeya.ts` prints it as `url`, and `--login <port>` again.

Once signed in, the address alone (a bookmark, `http://127.0.0.1:4417/`) opens Obeya: the cookie
holds as long as the key (400 days at most, the longest a browser keeps one). Workers hold no key:
their narration goes to a server of its own that answers narration clips and nothing else
(`serveNarration`, their `OBEYA_URL`).

*The workers' files.* A GET of an HTML artifact's files or an answer's passes the site check from
another origin: their sandboxed frame has the origin `null`, so the browser sends what its page
loads (its stylesheet, its images, its scripts) as cross-site, and without the cookie. The frame's
own page comes with the cookie (the canvas loads it) and is sent on to an address with a key of its
directory (`…/demo/~<key>/index.html`, keyed with a secret made at every start), so what it loads
beside itself carries that key, which only a request with the owner's key (or a paired device's)
gets to see; an address with it needs nothing more. Then the gate of other devices (below) has its
say.

The cookie is sent to any server on `127.0.0.1` the browser opens, whatever its port: a page the
owner opens there from another account on the machine would see it.

#### Other devices

The owner's phone reaches Obeya over the owner's own private network (`src/server/remote.ts`,
`src/server/tailscale.ts`, `src/ui/access.tsx`); Obeya runs no service of its own for it and goes
onto no open internet. The setting „Von anderen Geräten erreichbar“ (`remote` in `settings.json`)
is off by default, and off Obeya answers only on this machine. On, it is one of two:

- *Über Tailscale*: Obeya keeps listening on `127.0.0.1` and runs `tailscale serve --bg
  --https=<port> http://127.0.0.1:<its port>`, which proxies HTTPS and WebSockets from
  `https://<machine>.<tailnet>.ts.net`, the name `tailscale status --json` gives. It takes 443,
  else 8443, else 10000, whichever no entry serves yet, and touches no other entry; the one it made
  it notes in `tailscale-serve.json` in its home, so it moves that entry to a new port of its own
  (the app may pick another) and turning the setting off removes it, and only it, after a restart
  too. Stopping, Obeya removes the entry, so a program that takes its port afterwards is not served
  to the tailnet; it serves again at its next start, at the same address while 443 is free. Bun's
  dev server (`--dev`) answers for the page's scripts and styles only under the name it listens on,
  so through `tailscale serve` an Obeya started with `--dev` shows a blank page.
- *Über eine Adresse*: Obeya also listens on an address of this machine the owner picks from its
  interfaces (another VPN's), with the same routes, in plain HTTP. The section says that a phone's
  browser allows the microphone and push only over HTTPS.

The section „Von anderen Geräten“ of the configuration and „Telefon verbinden“ show the setting the
same way, with what the network lacks, each with its one step: Tailscale missing (how to install it,
per platform), not running, logged out, HTTPS off in the tailnet (a link to the DNS page of the
admin console; `CertDomains` empty in its status), on Linux the operator right `tailscale serve`
needs (`sudo tailscale set --operator=$USER`, recognised by its "Access denied"), all three ports
taken. With Tailscale ready they name the account it is logged in as, which the phone logs in with
too, and while the tailnet has no other device (no `Peer` in its status) they say that the phone
is not in it yet and cannot find the address (it gets NXDOMAIN): install Tailscale on the phone and
log in as that account. They look at Tailscale again every few seconds while open, so logging in,
turning HTTPS on or the phone joining the tailnet shows (and serves Obeya) without a click. The section also says that other devices reach Obeya
only while it runs here.

A request is *local* when it comes from loopback under one of this machine's names and no proxy
forwarded it (no `X-Forwarded-For`, `-Host`, `Forwarded`); through `tailscale serve` requests come
from `127.0.0.1` too, but under the tailnet name and forwarded, and count as remote, as does
anything on the other address. A remote request needs a paired device; without one the page is
„Dieses Gerät ist nicht mit Obeya verbunden“ with how to connect and a field for the code (401),
the API answers 401 `notPaired`, and a WebSocket opens not at all.

*Pairing.* The section's button „Telefon verbinden“, below the paired devices (shown while other
devices reach Obeya), opens a dialog of that name: a QR code of `<address>/pair?code=<code>` beside the address and the code in large digits. The code
has six digits, holds five minutes (a new one comes when it ran out with the dialog open) and pairs
one device; five wrong tries spend it (only those from Obeya's own page or without `Sec-Fetch-Site:
cross-site`, so another site cannot spend them by sending a browser in the tailnet to `/pair`). The phone opens the address (the camera reads the code), and
the server sets the device cookie `obeya-device` (32 random bytes; the database keeps only its
SHA-256 with a name from the user agent, „iPhone · Safari“, and when it was paired and last seen)
and sends it to the canvas; the dialog then says „iPhone · Safari ist verbunden.“. The cookie is
`HttpOnly`; over HTTPS `Secure; SameSite=None`, and the origin check keeps other sites out as on
this machine; over HTTP `SameSite=Lax`. Either way an HTML artifact's own files load through the
keyed address (above).

*Devices.* The section lists them with when they were paired and last seen, each with „Entfernen“,
which takes effect at once and has no undo (pairing again is quick): its cookie lets nothing in,
and its open pages lose their WebSocket and reload to the page that says how to connect. A device
stays paired until it is removed or has gone unused for 90 days (a phone given away or lost and
forgotten); the cookie itself lives 400 days, the longest browsers keep one. Pairing, the devices
and the setting are managed only on this machine (`/api/access…` answers another device 403
`onlyHere`, and the section shows it only its heading and hint): a phone that is lost cannot pair others or keep
itself in.

*Keeping the machine awake* (`src/server/awake.ts`). While the setting is on, Obeya keeps the
machine it runs on from idle sleep, as the switch „Rechner wach halten“ beside it says: *Solange ein
Agent arbeitet* (the default), while a worker is in a turn (or its ended turn waits for its
background work, or its work is landing), letting go two minutes after the last one ended (the next
turn often follows soon); or *Immer*, the whole time Obeya runs, so the phone can give it a task
while no agent works (`awake: "always"` in `remote`). It looks every five seconds. Per platform:
`caffeinate -i -w <pid>` on macOS (`pmset -g assertions` shows it, "on behalf of" Obeya's process),
`systemd-inhibit --what=idle:sleep --who=Obeya` around `tail --pid=<pid>` on Linux
(`systemd-inhibit --list`), both ending by themselves when Obeya does;
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` through `bun:ffi` on Windows
(`powercfg /requests` as an admin; without admin rights `CallNtPowerInformation(SystemExecutionState)`
shows `ES_SYSTEM_REQUIRED`), which holds as long as the process. The display may still sleep.
Otherwise the machine sleeps as it is set to, and a phone no longer reaches Obeya until it wakes; a
closed laptop lid puts it to sleep either way, which the switch's hint says. Workers on SSH hosts
keep the machine Obeya runs on awake too (Obeya drives them from there), but their hosts keep their own power settings.

#### The phone view

On a phone the page shows the phone view instead of the canvas (`src/ui/phone.tsx`): at the same
address, from the same bundle. A phone is a device whose pointer is coarse and whose screen's
shorter side is under 600 px, whichever way it is held; a tablet and a narrow window at the desk
keep the canvas. `?view=phone` or `?view=canvas` in the address decides instead (to try the view at
the desk). The rule is settled when the page loads; turning the phone does not switch views.

It holds one WebSocket per canvas (the canvas's own `/ws`, so the server sends it what it sends a
canvas page, nothing new), and shows, under the sign and the word Obeya:

- **„Für dich“**: what waits for the owner across every canvas (`needsYou`), canvas by canvas in the
  switcher's order and within a canvas in Tab's order, then „Obeya hat geantwortet“ where an
  answer waits unread there. Each card says what it waits for (its state line: „Demo bereit“,
  „Frage an dich“, „Vorschlag eines Agenten“ …) and since when. Since when a card waits the server
  notes when `needsYou` turns true for it (`waiting_since` on the card, kept across restarts while it
  waits, `waitingSince` in the snapshot). Cards the owner snoozed while they waited stand at the
  end, until they come back (see Snoozing a card).
- **„Läuft“**: the cards an agent or Obeya is at and that wait for nobody (working, taking in the
  owner's words on its handover, finishing, landing or just approved, in the queue, in a PR, an
  idea's or a Question card's agent thinking; `runs` in `src/ui/talk.ts`), with their status line;
  snoozed ones at the end. Every card that leaves „Für dich“ without being done stands here: until
  2026-10-17 a handed-over card whose worker took in a note of the owner's stood in neither list
  until it handed over again.

Both lists show the cards as the canvas does, as wide as the screen (`CardFace` and `cardClass` in
`src/ui/parts.tsx`, shared with the canvas): the state's colour as a rule across the top and in the
state line at the bottom, an idea on its rose stock, the owner's turn framed in orange, the kind
line (with several canvases after the canvas's name), the title in the serif and the line of text
the canvas shows (the question, the status line). Only the pin is left out: everything in „Für
dich“ waits for the owner. Held upright the cards stand one below the other; where the screen is
wide enough for two of at least 340 px (the phone turned) they stand side by side, each row as high
as its taller card, the state lines at the bottom. Before (until 2026-10-17) a row was a white box with a thin coloured
strip at its left edge, and on the phone the idea's red and the owner's turn's orange could hardly be
told apart there.

Obeya's conversation is not on the list but a panel of its own over it: the button for it left of the
microphone, in reach of the thumb, opens it, and so does the card „Obeya hat geantwortet“. The button
is the canvas's (the speech bubble, with the number of answers waiting unread, across the canvases),
at a finger's size, and inverted while the panel is open. It comes up from below and fills the screen: the
conversation with the field under it, the sheet's own (`KoordinatorTalk`), and below the field the
room of the microphone, so the microphone never stands over the field. Whose Obeya it is (when there
are several canvases) a picker right of the microphone says, on the list as in the panel, since it
also decides whom the microphone speaks to with no card open: the canvas's name, which opens the
phone's own list of them; with one canvas there is none, and with a card open neither (the microphone
speaks to its agent then). The button opens the conversation an answer waits unread in when the
one picked has none, and the picker follows. The conversation is the only thing in it that scrolls: as a box in
the scrolling list (until 2026-10-16) it was a scroll area inside another, and the list scrolled on
past the field to make room for the microphone. The panel takes the part of the screen the keyboard
leaves, so the field stands right above the keyboard: the phone view asks the browser to make the
page shorter while the keyboard is up (`interactive-widget=resizes-content`, which Chrome on Android
heeds), and follows the visual viewport where it does not (Safari). Until 2026-10-17 the visual
viewport alone decided, and Chrome reports it wrong by its own bars: where it draws the page under
the gesture bar the field ended behind the keyboard by that bar's height, and with a toolbar at the
bottom it ended far above it. Its top is a grip the owner drags up and down to the height they want:
the panel follows the finger and stays where it is let go, the page under it scrolling on until all
of it can stand above the panel. Let go within 15 % of the screen's top it takes the full height,
within 15 % of its bottom it closes (`settle` in `src/ui/panelHeight.ts`). Let go while the finger
still moves, it is thrown: it glides on in that direction and slows down evenly until it stops
(`thrown`, `glide`), so a short swipe up gives the full height and one down closes it, and a gentle
push carries it a little further; a finger that stood still for 50 ms before lifting leaves it where
it is. Until 2026-10-17 it only
closed or sprang back: let go further than 110 px down (or flicked) it closed, so a full panel could
not be dragged to the middle. It opens at the full height (beside a demo video at half, below). The same button left of the microphone, Back and Esc close it
too, and its address is
`?talk`, as a card's is `?card=<id>`. Its unread answers count as read once it is open, not when the
page opens. A card opened from the conversation opens over it, and Back returns to it.

The lines above the microphone (Obeya's reply, a confirmation with „Rückgängig“, a command still
being read) are swiped aside, to either side, to be rid of them before they go by themselves, on the
list as on an open card: pulled past a third of their width or flicked, they fly out; less, they
spring back, and a drag up or down leaves them (`Aside` in `src/ui/aside.tsx`). A line swiped away
takes nothing back: a command's „Rückgängig“ goes with it unused, and a command still being read is
carried out, its confirmation not shown. Until the owner has swiped one away in this browser, each
line nudges aside and back once after it appears. The canvas has no such gesture: it was wanted on
the phone only.

A tap opens a card full screen: Back (the button, the browser's back, Esc) returns to the list where
it was scrolled. The card's address is `?card=<id>`, so a reload or a restart opens it again. It is
the canvas's detail view (`Detail`) with the same answer options, demo, approve buttons and undo;
a demo video plays full width, and full screen from Obeya's button on it (see below). The page holds what the card
is about (title, text or brief, demo) and the decisions, and is the only thing on it that scrolls.
The card's conversation is not on it but in the same panel as Obeya's, with the same grip, Back and
Esc, keyboard handling and confirmations above the field: the button left of the microphone opens
it, with a number for what waits there (the messages since the owner last had the conversation open
or last wrote there, plus the questions open). Only the messages the conversation shows count, not
the agent's words between its steps that fold under them (`unseen` in `src/ui/talk.ts`, over
`cardTalk`, the conversation as the card shows it); until 2026-10-17 those counted too, and a card
with two handovers showed 81, and its address is `?card=<id>&talk`. Every card kind
gets there the same way: the talk column of `Split` (and the Question card's conversation) goes into
the panel through a context the phone view provides (`TalkElsewhere` in `src/ui/detail.tsx`, a React
portal), so the canvas is untouched and no card kind has code of its own for it. A card at work
(`working`) and one that waits for answers to its questions (with options to pick or without) open
with the panel up (`opensWithTalk` in `src/ui/talk.ts`): what its agent says, or what it asks, is
what the owner opened it for; otherwise the page shows first. Until 2026-10-17 a working card opened
on its page too, and the owner missed its conversation there; until 2026-10-19 so did a card whose
question had no options, its „Frage an dich“ on the page and the question behind the button. On a working card the panel is a half sheet, as
beside a demo video (below), so the title, state line and buttons stay in view above what its agent
says. While the conversation shows an agent at work (`agentWorks`, or Obeya reading the owner's
words on the card; for Obeya's own conversation, Obeya reading or looking a question up,
`obeyaWorks`), the button carries the moving line of a working card along its foot, so the work is
seen with the panel closed too. The conversation opens at the first message the owner has not seen (as
the button counts them: after the last one they saw and after their own last words), at the top of
the panel as far as it scrolls, so with nothing new it opens at its end; the new messages carry the
orange edge they have on the desktop (The conversation). Until 2026-10-17 a half
panel opened scrolled near the conversation's start: the scroll to the end, made while the panel
still rose, was taken for the owner scrolling up (`useStickToEnd` now knows its own scrolls). Beside a demo video the panel is a half sheet and the page scrolls the video into the upper
half, so a comment at a place in the video („Hier kommentieren“ brings the panel up with the cursor
in the field) is written while the video stays in view, with the place's chip and the pause on typing
as on the canvas; its grip sets another height, as on Obeya's. Turned sideways the panel opens at
the full height there too. Until 2026-10-17 the conversation stood on the page below the card's columns, a box
capped at 62 % of the screen's height: a scroll area inside another, where the finger decided which
of the two scrolled, and the page scrolled on past the field to make room for the microphone. Plan docs are not read there and the configuration is not opened from there:
the links to them do not show. Every call goes to the API of the canvas in view (the open card's,
else Obeya's), and the list is not on the page while a card is open, so nothing in it loads from
another canvas's API. A call about a card, and words about it, go to the API of the card's canvas
(`cardAt`), whichever canvas is in view as they go out: closing a card puts Obeya's canvas in view
before the card's last calls go, and until 2026-10-18 the release of the comments held back on its
demo went to that canvas, which knew no such card, whenever it was another; they waited the ten
minutes then.

The microphone at the bottom is held by a finger (pointer events, no long-press menu, no text
selected; lifting the finger or the browser taking the gesture ends the recording) and speaks to the
open card's agent, else to Obeya. No line under it names whom it speaks to (until 2026-10-17 the
canvas's „→ Agent · …“ stood there): what is in view fills the screen, so that goes without saying,
and the 33 px it took go to the list and the conversation; the line still says when the microphone
hears only silence. Nor does „→ ins Feld“ show under it with the cursor in a field: the line lifted
the microphone onto the field above it. While the keyboard is up it hides, and so do the button for
Obeya's conversation and the canvas picker: the field has its own microphone. The keyboard counts as
up while a text field has the focus and the page's height is more than 150 px below the tallest it
had at that width (`ph-kb` on the page's root); the keyboard closed with the phone's own button
leaves the focus in the field, and until 2026-10-17, when the focus alone decided, the microphone
stayed hidden then. Shown again with the cursor still in the field, it dictates into the field. The
field's microphone is held by a finger as the one at the bottom is, and the touch on either is
nothing but the press (its `touchstart` is cancelled): held half a second, Chrome took it for a long
press on the field's frame and began selecting text, which closed the keyboard and cancelled the
touch, so the recording ended at once. A tap on the field's screenshot button leaves the cursor in
the field, so the keyboard stays up and the field does not move away under the finger (before, the
tap only closed the keyboard and the picker needed a second one), and back from the picker the field
takes the focus anew, which brings the keyboard up again. A tap on Send leaves the cursor in the
field the same way and sends at once, and the keyboard stays up for the next message (until
2026-10-17 the first tap only closed the keyboard and the second sent). A tap into a text field
while the keyboard is down only puts the cursor where the finger was and brings the keyboard up
(`tapOpensKeyboard` in `src/ui/phone.tsx`); with the keyboard up the tap is Chrome's again, and on a
word marked misspelled it opens the suggestions above the keyboard. Until 2026-10-18 Chrome took
that first tap too: on such a word its suggestions opened, and on the owner's phone they closed the
keyboard that had just begun to open. The texts that name the space bar name the microphone
there (`forTouch`). Enter breaks the line in a field there, and only Send sends
(`enterBreaksLines` in `src/ui/composer.tsx`): the keyboard's Enter key is where a phone types a
line break, and a message sent half written cannot be taken back; the line under a dictating field
leaves out „abschicken mit Enter“. A field's screenshot button offers the photo library and the camera
(`accept="image/*"`), and marking a screenshot works with a finger. Drafts are kept per tab under a
name of the phone view's own (`obeya-drafts-@phone`), with the field under Obeya's conversation one
per canvas (`obeya:<canvas>`).

Turned sideways (landscape, the screen under 600 px high) the phone has about 400 px of height, of
which the bar at the top, the microphone at the bottom and the fade under it took almost half, the
microphone standing over the middle of the two columns of cards. There the microphone stands at the
right edge, halfway up, where the thumb holds the phone, in a strip of its own beside
the content, so it covers no card; the line under it naming whom it speaks to wraps in that strip,
and the screenshot button stands above it. What stands beside the microphone held upright moves into
the strip too: the canvas picker to its top, the button for Obeya's conversation to its bottom. The
fade goes, the bar is slimmer, and on the list it scrolls away with the sign (on an open card it
stays, with Back; on the panel, as its grip). The panel leaves no room under its field, the
microphone standing beside it, and while the keyboard is up the field takes the strip's width too.
Confirmations stand at the bottom of the content, in the panel above the field. Held upright nothing
changes.

A demo video goes full screen from the button at its top right (`useFullscreen` in
`src/ui/fullscreen.ts`), not from its own controls: their full screen button is hidden
(`controlsList="nofullscreen"`). Full screen holds the screen in the video's orientation (landscape
for a demo), however the phone is held when it starts. Once the phone has been turned to match,
turning it back ends full screen (held the other way for 300 ms, read from the device's orientation
sensor, which goes on while the screen is held), as do the button and Back. Turning the phone into
landscape while the video plays and stands in view starts full screen too. Chrome on Android did all
this itself for a video in full screen from its own controls, but racily: once the phone matched the
video it released the screen, which right then could still report the orientation from before, so
turning the phone into landscape sometimes ended full screen and turning it back sometimes started
it. Obeya holds the screen until full screen ends instead, so the screen and full screen never
disagree. A browser that puts only the video itself into full screen (Safari on an iPhone) has no
such button and keeps the video's own controls, whose player turns with the phone.

Each time full screen starts, Chrome on Android shows its notice at the bottom („<origin> – zum
Beenden des Vollbildmodus: von oben ziehen …“). It is a security notice that no page can turn off.
Only skipping the browser's full screen would avoid it: the player would then cover the page, with
Chrome's address bar or the status bar still showing, and could no longer hold the screen in the
video's orientation, since Chrome locks the orientation only in full screen (or in a web app whose
manifest says `fullscreen`). The owner kept real full screen with the notice (2026-10-17).

When the server does not answer for 3 s (a phone back from its lock screen reconnects within that),
a line at the top says „Obeya antwortet nicht · seit 14:02“ and why that may be; the page connects
again by itself, at once when it comes back into view rather than after the pause it waits. The 3 s
count from that moment: a phone that was locked lost its connection meanwhile, which says nothing of
the server, so the line does not show while the page reconnects, and a connection still opening
from before is tried anew. A sleeping machine answers nothing at all, not even a refusal: a
connection that has not opened within 3 s counts as not answering, and one not open after 10 s is
tried anew.

#### Notifications on the phone

Obeya tells the owner's phone when something starts to wait for them (`src/server/push.ts`), by Web
Push to the browser's own push service (Apple's, Google's, Mozilla's): no account and no service of
Obeya's. A message is encrypted for the device (RFC 8291) and the request signed with Obeya's VAPID
key (RFC 8292), both with WebCrypto (`src/server/webpush.ts`); the push service sees neither title
nor text. The key is made at the first start and kept in `vapid.json` in Obeya's home (readable by
the owner alone), as every subscription holds its public half.

*Turning them on.* A paired device holds at most one subscription (`push` on its row in `devices`);
removing the device removes it, and one its push service answers with 404 or 410 goes. On an iPhone
a page gets pushes only from the home screen (iOS 16.4 and later): in Safari the phone view says how
(„Teilen“, „Zum Home-Bildschirm“, then open Obeya from there) until it runs that way. There, and in
a phone's Chrome without that step, a box at the top asks „Benachrichtigungen einschalten“; its
button asks for the permission (iOS asks only after a tap) and the box stays until the permission is
given or refused. With it given, the page subscribes with Obeya's key and hands the subscription to
the server (`PUT /api/push`) at every load, so a renewed subscription or a new key reaches it. Over
another VPN's address (plain HTTP) there are no pushes, and nothing says so on the phone: the section
„Von anderen Geräten“ does. The section's device list says which devices have them on.

*What is pushed:* a card whose `needsYou` turns true (a demo or a handover, a question, an agent's
proposal, a PR to merge, an idea's turn), with what it waits for as the text („Demo bereit“, „Frage
an dich“ …) and its title (and its canvas where there are several); a landing that failed (a card that
was landing and needs the owner again: „Landen fehlgeschlagen“); a worker that is stuck (its turn
failed or ended twice without a handover and Obeya made a question of it, `stuck` on the question:
„Agent kommt nicht weiter“). Obeya's answers in its conversation are not pushed: the owner asked from
where they are. Cards waiting already when Obeya starts are not pushed.

*Not while the owner uses Obeya:* nothing is pushed while a page on this machine was in use in the
last three minutes, or while a page on a paired device is in use. A page in use is one in view in
which the owner moved, typed or scrolled, or a video plays, within the last half minute: it says so
every 30 s then (`{ type: 'here' }`), and when it comes back into view. A canvas left in view with
nobody at it holds nothing off. The phone view counts as in use whenever it is in view, as a phone's
screen locks by itself; and a device holds pushes off only until its page goes out of view (locked,
another app in front: `{ type: 'away' }`), closes, or has said nothing for 45 s, without the three
minutes after: a phone put away is where the pushes should reach the owner. What starts waiting while
the owner is there is not pushed later either: it is in front of them.

Every push goes as urgent (`Urgency: high`), which lets the push service wake a sleeping phone. Whether
it does is up to the phone: on the owner's Pixel (2026-10-16) a push sent while it slept showed only
once it was unlocked, as Android held Chrome's messages back.

*Several at once:* the first goes out at once; what starts waiting within the minute after goes out as
one push at its end, without what no longer waits by then („3 Karten warten auf dich“, the titles as
the text), and a further minute starts; a minute without anything ends it.

*Tapping a push* opens its card in the phone view (`/?card=<id>`), one for several „Für dich“: in the
app that is open already (the service worker tells the page), else in a new one. A later push for the
same card replaces the earlier one in the phone's notifications.

*The web app.* The page names its manifest (`src/ui/manifest.webmanifest`, which the page's bundle
carries: standalone, the icons `/icons/180.png` and `/icons/512.png`), and the phone view registers a
service worker at `/sw.js` (`src/ui/sw.ts`, served as the source of its function, so the binary needs
no file for it). The manifest's icons and the worker need no pairing: nothing in them is the owner's.
The worker shows the pushes and keeps the page's shell: the page and its scripts come from the network
and are kept, and when the network fails or takes more than 3 s, from what was kept. So the app opened
from the home screen while the machine sleeps shows the phone view saying that Obeya does not answer,
within about 7 s, instead of the browser's error or a blank page that waits: the page waits 3 s for
its language and the canvases, then goes on with the browser's language and the canvases it last
had (their cards come once Obeya answers). The worker asks for the page anew, as a request of its
own: passed on, the request of the app opened from the home screen (a launch Android's Chrome marks
`Sec-Fetch-Site: cross-site`, as a link from elsewhere) keeps that mark but loses `Sec-Fetch-Mode:
navigate`, and *Its own site* would refuse it. The canvas page at the machine registers no worker.

### Setup assistant

One list of what Obeya needs on this machine (`src/server/machine.ts`, `src/ui/setup.tsx`), in four
parts:

- *Agenten* (needed: Claude Code, its login, git, and git's name and e-mail, without which an
  agent's commit fails);
- *Pull Requests* (gh and its login: work in a repository on GitHub lands through pull requests, so
  it is needed at its first approval, not before);
- *Sprachbefehle* and *Demos* (the checks the configuration dialog makes, voice-setup.ts and the
  demo skill's setup.ts, each with the size still to download; what both need shows once; uv stands
  above the speech recognition, whose "Installieren" waits until uv is there and says so; the
  recognition's line also says how fast it is here and offers a cloud service, see The Spracheingabe
  settings).

The checkout's agents run on the Agent SDK's own Claude Code, so there it is always there; the
compiled binary's run on the machine's, and the list says which version Obeya was checked with (the
SDK's) when the machine's differs. Logins are read from `claude auth status` and `gh auth status`.

"Installieren" installs what needs no admin rights: Claude Code and uv with their official
installers (`curl … | sh`, PowerShell's `irm … | iex` on Windows), the speech recognition through
the voice's installation, a demo's voice; system software (git, gh, ffmpeg, Node, a browser) comes
with the command for this platform and a copy button, and is installed at a click where that needs
no password (Homebrew where it is there, winget). A login opens a terminal with `claude auth login`
or `gh auth login` (Terminal through `osascript` on a Mac, `cmd` on Windows, the first terminal
found on Linux; none found: the command to run by hand); git's name and e-mail are typed into two
fields. The list checks again when the window gets the focus back.

Obeya puts `~/.local/bin` (the official installers') and on a Mac Homebrew's directories on its
`PATH` at start, so what was installed is found from a process the desktop started; on Windows every
check (the assistant's, the voice's and the demos' in the settings) first reads the user's and the
machine's `PATH` from the registry again (`src/server/path.ts`), so what was installed meanwhile, by
Obeya or by hand, turns "ok" once the window gets the focus back.

#### The first canvas

On the first start the page ends with the first canvas, under "Wo liegt dein Projekt?": two cards
with a radio button each, "Schon auf diesem Rechner" and "Auf GitHub / einem Server", with the
fields of the one chosen below: a repository's folder (a path, or the system's folder dialog where
there is one: `osascript`, PowerShell's, zenity or kdialog) or a clone (`owner/name` through `gh
repo clone` where gh is logged in, else from GitHub by its URL; any git URL; into the home directory
unless another is given). Below a folder's path it shows the main branch Obeya found there (`POST
/api/setup/folder`), and after a clone the clone's, beside "Gespeichert". A folder without git gets
the offer to set it up there instead (see Setting up git in a folder), whose confirmation also
creates the canvas.

Obeya writes `canvases.json` with it (worktrees, as Obeya's defaults have it; two clones when the
repository's settings say clones), starts the canvas at once (see Live
configuration) and the page opens it, on which a first card says what to try (the marker `welcome`
in Obeya's home, read once when the canvas runs). Later the Konfiguration dialog opens the same list
over the canvas ("Einrichtung prüfen"), without the first canvas. A scratch Obeya with `"setup":
true` in its stage file starts like a first start.

### Setting up git in a folder

Where the first canvas or "+ Repository" in the configuration is given a folder in which git finds
no repository, it offers two ways on, each with a line on what it means (one component, `GitSetup`
in `src/ui/setup.tsx`): „Ohne git verwenden“ (the folder stays without git, `"git": false` in its
entry; see Folders without git), and „Hier ein git-Repository einrichten“ (`src/server/git-setup.ts`). It first shows what the first commit would hold
(`POST /api/setup/git-preview`): the folder's own entries with their files counted and their sizes,
files from 1 MB on listed apart as large, what stays out, and the default `.gitignore` (build
output, dependencies, secrets: `node_modules/`, `dist/`, `.env*` but `.env.example`, keys) that
Obeya writes where the folder has none. The preview is computed against a git directory of its own
in the temp directory, so looking changes nothing; the owner keeps more out with a `.gitignore` of
their own and "Neu ansehen". Confirming (`POST /api/setup/git`) runs `git init` on git's
`init.defaultBranch`, else `main`, and commits every file not ignored, since workers only see
committed files, under the name and e-mail of the assistant's step for them (none: it says so and
does nothing). A step that fails undoes what came before, so the folder is as it was.

### Self-update

Obeya runs from a checkout that work lands on, so `live` must mean running (the compiled binary has
no checkout and never restarts for new code). Without `--dev` the `obeya` process supervises the
server: when the checkout its code comes from moves to commits that change code (not only docs:
`docs/`, any `.md`, the site for obeya.si in `site/`, or the workflows in `.github/`), the server
stops and starts again; when the commits since it started change `package.json` or `bun.lock`, it
runs `bun install --frozen-lockfile` in the checkout first (a failure goes to the log and the
restart goes ahead, the new code then fails where it imports what is missing); workers resume, and
an open page reloads when it reconnects to a new server process.

#### Waiting for the workers

The restart waits until no worker is in the middle of a turn or waiting for its background work,
even one that has asked or handed over meanwhile (at most 15 minutes), since it stops whatever a
worker runs. The workers it waits for are told it is due: they start nothing long, stop background
work they can start again, and pause at the next safe point by ending their turn (no nudge, no
question to the owner; the card's log says it paused).

A worker whose turn a message starts before the restart (a card started, an answer, an approval
whose work did not land for a conflict) hears that the turn keeps Obeya waiting: it takes the
message in, leaves the work it asks for until Obeya resumes it, and ends the turn at once (the
card's log says so). Background work a worker lets finish wakes it for a turn before the restart,
and so does a message; such a turn hears once that Obeya still waits and that it holds the restart
up (with its first tool step, or with the message; the card's log says so), and the worker ends it
again. A resumed worker hears that what ran was stopped (exit code 137) and goes on. A worker that
waits for the restart to finish its landed work is not in a turn and does not hold it up.

#### Waiting for the owner

The restart also waits while the owner watches a demo video or dictates in an open page (from the
press until the words are in the field or Obeya has read them), past the 15 minutes too: the page
tells the server over its WebSocket whenever that starts or stops, and a page that closes lets go.
The server also holds it off itself while it answers a recording (`/voice`), whether or not the page
still does. A command in its undo window holds the restart off on the server's own count, whether or
not the page that said it is still open, and until it has run.

While a restart waits, the bar shows it ("Neustart wartet auf N Agenten", "… auf dein Video", "… auf
dein Diktat"; until when at most, while only agents hold it); hovering names why and the cards it
waits for, on this canvas and under each other canvas's name (the server gives their titles, as the
page knows only its own cards), and "Jetzt neu starten" (`POST /api/restart`) has it go ahead at once, its hover text
saying what that cuts off.

#### Keeping the page

The page that reloads keeps what was open: just before the reload it writes down (per tab, in
`sessionStorage`) the open card, project (its plan doc read or not) and sheet, the scroll position
of every scrolled box in them, the drafts in their text fields and where the demo video stood (it
plays on only in a tab in sight); the new page opens them again without flights or unfold and puts
positions and drafts back while their content loads (`src/ui/keep.ts`). The camera is kept anyway.

#### Pulling from the upstream

Obeya from a clone of its repository (README: From source) moves only when its owner pulls. So the
supervised server fetches the upstream of the branch its checkout is on (`origin/main`, as a rule) at
the start and every hour (`src/server/source-update.ts`; only that branch into its remote-tracking
ref, no `FETCH_HEAD`, as the Lesestand does; a fetch that fails goes to the log and is tried again
next hour). While the upstream has commits the checkout lacks and they change code (the same test as
for the restart: docs alone do not count), the bar shows them beside where the app shows its
updates: "Update: 12 neue Commits", their subjects and dates on hover (the newest ten), and a
"git pull" button. The click fetches once more and fast-forwards the checkout to the upstream (`git
merge --ff-only`); the restart for new code follows as after a landing, waiting for the workers and
the owner, and the bar shows that wait instead. Where Obeya cannot fast-forward, there is no button
and the hover says why and what to do: the checkout has commits of its own (a contributor's), or
uncommitted changes to files the new commits change (named). Whatever else git refuses (an untracked
file in the way, say) stays on the hover with git's message until a pull goes through. When the
owner comes back to the page (from the terminal, where they committed what stood in the way), Obeya
looks again without fetching.

A branch without upstream (a card's, in a worktree) or a detached HEAD has nothing to pull, and
neither has an Obeya with `--dev` (it does not restart for new code) or the app and the compiled
binary (no checkout; the app has its own updates). The owner's Obeya here runs from the checkout work
lands on, which is ahead of `origin` rather than behind, and shows it only when `main` was pushed
from elsewhere.

### Stopping

Ctrl-C, SIGTERM or `POST /api/stop` (the app; Windows has no SIGTERM), with or without `--dev`,
stops Obeya the way a restart goes, only nothing starts again: the workers in the middle of a turn
are told Obeya is about to stop and pause at a safe point, and Obeya ends once none is (at most 15
minutes). The bar shows it ("Beenden wartet auf N Agenten", "Jetzt beenden"), and a second Ctrl-C
ends it at once (the terminal's Ctrl-C reaches supervisor and server, and the supervisor passes it
on: signals within a second count as one press). A stop does not wait for the owner's video or
dictation, since the owner asked for it; it turns a restart that waits into a stop. The next start
resumes the workers it stopped like a restart does.

The sidecars (transcription, speech, narration voice) run in a process group of their own, so the
terminal's Ctrl-C does not reach them: they keep working while Obeya waits, and Obeya ends them once
it stops by ending their stdin, which they finish as a normal end after the request they are on
(Obeya gone by the time they answer it, they end quietly); one still there after 30 s is killed. On
Windows, where a detached process would open a console window for every program it starts, the
Python sidecars ignore Ctrl-C instead.

### Decisions

- **The machine stays awake while a worker works, or always where the owner switches it so**
  (2026-10-16, the owner). Keeping it awake the whole time other devices may reach Obeya would be
  too much as a default (a laptop on battery), but the owner wants to give Obeya tasks from the
  phone while no agent works; a hint how to keep the machine awake by hand, per platform, was the
  other way, and a switch does it without leaving Obeya.
- **Other devices over the owner's private network, paired by a QR code** (2026-10-16, from the
  plan „Obeya from the phone“): a public tunnel puts agents with shell rights on the open internet,
  a relay of Obeya's own is a cloud service, and a messenger bot passes everything through a third
  party and holds only a chat. A paired device stays paired until removed or
  unused for 90 days, rather than for a fixed time: a phone in daily use should not have to pair
  again, and one forgotten drops by itself. Managing devices only on the machine itself, so a lost
  phone cannot keep itself in. The cookie is `SameSite=None` over HTTPS rather than `Strict`, which
  the plan said: with `Strict` a worker's HTML artifact on the phone could not load its own files.
- **Pushes by Web Push to the web app on the home screen** (2026-10-16, from the plan „Obeya from the
  phone“): ntfy or a messenger would put a third party between Obeya and the phone and do nothing Web
  Push does not; a native app nothing a home-screen web app cannot do here. Encrypted and signed with
  WebCrypto rather than a library: the two RFCs are a few dozen lines, checked against RFC 8291's own
  example. The owner counts as at the machine while a page there is in use, not merely in view, which
  the plan said: a canvas left in view would otherwise hold every push off until the screen locks.
- **Nor while the owner uses Obeya on the phone** (2026-10-17): the pushes added nothing while the
  owner was working through the cards on the phone anyway. Before, only a page at the machine held
  them off. The phone's hold ends the moment its page goes out of view rather than three minutes
  later, so a push for what starts waiting right after the phone is locked still comes.
- **„Telefon verbinden“ only in the configuration** (2026-10-16): a phone is connected once, and
  again only for a new phone or a closed tab, so it takes no place in the bar. Before, a phone icon
  stood in the bar beside „Konfiguration“.
- **The phone view is a view of its own in the same page, not the canvas made touch-capable**
  (2026-10-16, from the plan „Obeya from the phone“): readable card sizes on 390 px mean mostly
  panning. It shows at the same address on a coarse pointer with a short side under 600 px rather
  than on a narrow window, so a narrow window at the desk keeps its canvas. It reuses the canvas's
  detail view, conversation, drafts and confirmations rather than phone copies of them. One
  WebSocket per canvas rather than one stream for all: the server's canvas messages stay as they
  are, and an owner has a handful of canvases.
- **Obeya restarts itself for new code on its own checkout instead of hot reloading**: a restart is
  a path that already exists (workers resume by session id), hot reloading keeps old state alive
  next to new code. It also restarts for commits made outside Obeya.
- **A due restart is announced to the workers, which pause for it themselves**, rather than waiting
  for a moment in which none is busy (2026-10-01): with six workers in parallel such a moment rarely
  came, and the 15 minutes ran out in the middle of test runs and demo renders (four of the restarts
  after the waiting rule came in). An agent knows where its work can stop; a lock it sets before
  long commands would hold restarts off just as well but rests on every agent remembering it, and
  restarting each worker on its own between steps is impossible with one server process.
- **A turn started just before a restart is kept short** (2026-10-14). Until then such a turn heard
  the notice for a worker in the middle of a step ("finish the step you are in"): a worker sent back
  to resolve a conflict after an approval judged the rebase short, resolved it, handed over and had
  the work land before it paused. Until then too a turn woken by background work heard nothing: a
  worker woken by the render it had paused beside went on from there, checking frames and starting
  the next render, and kept the restart waiting all the while.
- **A restart waits for what the owner does in the page only where a restart would destroy it**
  (2026-10-02): a demo video that plays, a dictation until its command can no longer be taken back.
  Everything else (an open card, a sheet scrolled halfway, a draft) is kept across the reload
  instead of holding the restart off, so new code is not held back by a page that is merely open.
  Until 2026-10-14 a dictation into a field let go when the owner let go of the key: a restart that
  waited for it went ahead while Whisper wrote, and the words of a long dictation were lost. Until
  2026-10-12 the page held a command's undo window: a page that reloaded in the window (the language
  changed in the settings) let go, the restart went ahead, and the confirmed command was lost with
  the server's memory.
- **Sidecars end through their stdin.** Killed instead, Python left the semaphore of the model
  download's progress bar behind and its resource tracker warned about it on the terminal (until
  2026-10-12); until 2026-10-14 the Whisper sidecar left a BrokenPipeError traceback in the log when
  Obeya was gone before it answered.
- **Git is called directly, and test repositories are copied.** Obeya spawns git, a few thousand
  times in a test run: on macOS it calls the binary `xcrun --find git` names, not the `/usr/bin/git`
  shim, which looks it up again on every call (10 ms a call instead of 4). Test repositories are
  copies of a template committed once per set of files (`gitRepo` in `src/server/testing.ts`).
  Together they halved the test suite.
- **A repository's branches are read with one call of git** (2026-10-15): the main branch and its
  commit come from one `for-each-ref` over the local branches and `origin`'s (`readingBranches` in
  `workspaces.ts`), where they took four to seven calls (`symbolic-ref`, `for-each-ref`, `config`,
  two `rev-parse`), read again each time Obeya needs the main branch; a repository starting takes
  whether it has an adapter module from the read that resolved it. A test run spawned 12,600
  processes before, 8,400 now (each a few milliseconds of a run that waits for it).
- **Tests run a file per process** (`bun test --parallel`, the repository's check, 2026-10-15): run
  one after the other, the suite took 165 s on the owner's Mac, waiting most of that time for git;
  in parallel 27 s (Bun 1.4 or later; older Bun ignores the flag; the owner's Mac, CI and the
  builds moved to Bun 1.4.3 for it). The longest file sets how long
  the run takes, so the workers' tests are split by theme (`workers*.test.ts`), sharing their setup
  in `workers-fixture.ts`. That module's bindings are read live; a test replaces one through its
  setter (`setWorkers`), and each file calls `eachTest()`, as files run one after the other in one
  process share the module evaluated once.
- **Every request is checked for its `Host` and `Origin`, from this machine too** (2026-10-16):
  until then a page on any site in the owner's browser could create, start and approve cards with a
  `text/plain` POST to `127.0.0.1`, and a DNS name rebound to it could read and do everything. No
  token in the page is needed beside it: what a foreign page may send without a preflight carries
  its `Origin`, and a preflight gets no CORS headers from Obeya, so nothing follows it.
- **The first canvas is chosen with two cards and radio buttons**: pills read as buttons in a user
  test, not as a choice.

## Distribution

### One file

`bun run build` (`scripts/build.ts`) compiles the server with Bun (`bun build --compile`) into one
binary for this machine, or with `--all` (or named targets) one per platform (macOS arm64 and x64,
Linux x64 and arm64, Windows x64; Bun cross-compiles, about 15 s for all five), 66–120 MB with the
UI and SQLite in it, that needs neither Bun nor a checkout.

Its modules live in Bun's embedded file system, which no other process can read, so what other
processes run or import goes beside it as real files, in `resources/` (13 MB): the plugin with its
skills and the `playwright-core` the demo skill records with, the voice sidecars, the skills' scripts that read a repository's
settings (`recipe.ts`, `check.ts`) bundled with what they import, and `docs/settings.md` for the
settings skill. The server finds them
through one function (`resource()` in `src/server/resources.ts`): `OBEYA_RESOURCES` when set, else
`resources` beside the binary (or `Resources` of a macOS app bundle), else the checkout. The demo
skill's modules the server carries (the setup check, the voices) are told where their files are
(`useLib` in the skill's `lib/here.ts`). Nothing is written beside the code: the resources may be
read-only, what Obeya writes is in its home.

The binary is its own Bun for scripts: a site's deploy script runs as `obeya <script>` with
`BUN_BE_BUN=1`. It supervises itself as `bun start` does (restarting when canvases given on its
command line are saved) but has no checkout to follow, so it never restarts for new code. A macOS
binary is signed ad hoc after its build: as Bun writes it, macOS kills it at start. Bun 1.3.12
leaves a copy of its runtime in the working directory of every compile (`.<hex>.bun-build`); the
build compiles in the output directory and removes it. The UI the binary carries is bundled at build
time, with `NODE_ENV` defined as production, so it is React's production build, as `bun start`
serves it (without the define it was the development one).

`package.json` holds Obeya's version, which the settings show, with the checkout's commit beside it
when Obeya runs from one. `bun scripts/check-binary.ts <obeya> [--voice] [--demo] [--worker]` checks
a binary on the machine it runs on: a scratch repository with its own `.obeya/settings.json` and demo site,
then the voice installed and a spoken command heard, a demo rendered with the director from the
resources, and a real worker that commits and hands over an artifact, which is shared, once on the
machine's Claude Code and once on the SDK's. All of it passed on macOS arm64 and on GitHub's Windows
x64, Ubuntu x64 and Ubuntu arm64 runners (2026-10-07).

### App

A Tauri 2 shell (`app/`, Rust) around the compiled server, which is its sidecar (`obeya-server`
beside the shell's program; on Linux among the resources). `bun run build:app`
(`scripts/build-app.ts`) builds it for this machine: a DMG on macOS (signed ad hoc, or with a
Developer ID and notarised, see Builds; with the hardened runtime and the entitlements Bun's JIT
needs: without them the server fails at start for lack of `SharedArrayBuffer`), an NSIS installer on
Windows (per user, no admin rights), an AppImage and a .deb on Linux (`app/linux.Dockerfile` builds
and checks them in a container on a Mac).

The shell opens a window on the Obeya that runs on the home, or starts the server (on 4417, else a
free port) and shows "Obeya startet …" until it answers; one it started (or an earlier run of the
app did) it stops when the app quits, through `POST /api/stop` like Ctrl-C, and the window shows
what the stop waits for; quitting again goes ahead at once. The app ends when its server does; a
server that ends unasked shows its log's last lines in a dialog. One started from a terminal it
leaves running. A second start of the app brings the window to the front. On a Mac closing the
window keeps the app in the Dock, and the window has no title bar: the canvas's bar takes the
traffic lights and moves the window (`data-tauri-drag-region`; the page may call only that and the
zoom, `app/capabilities/window.json`). Links to anything but the canvas and new windows open in the
default browser, which is also how "Im Browser öffnen" in the settings (and the Mac's File menu)
works; the page finds `window.obeyaApp`. Downloads go into the Downloads folder.

The page gets the microphone without a prompt of the webview's (the system asks once for the app;
WebKitGTK has media streams turned on by the shell). WebKitGTK's MediaRecorder records nothing (2.50
and 2.52, 2026-10-08), so in the Linux window the page takes Web Audio's samples and sends a WAV
(`src/ui/recorder.ts`). With a PulseAudio sine source as microphone, the AppImage on Ubuntu 24.04
(in a container) recorded the tone that way; the other headless runs got silent samples, so a Linux
desktop with a real microphone is still to be tried.

The server's output goes to `app.log` in the home. linuxdeploy sets the library path of every
program in an AppDir, which breaks Bun's binary (its code sits after the ELF's end), so the AppImage
gets the server after linuxdeploy and is packed again. `bun scripts/check-app.ts <program>` checks
an installed app in its webview: the canvas in the window, a microphone recording as
`src/ui/recorder.ts` makes it (`MediaRecorder`; Web Audio's samples on Linux), an H.264/AAC video
playing, the browser button, a second start, the stop over HTTP, and the app beside an Obeya started
from a terminal.

### Builds

`.github/workflows/build.yml` builds the app on GitHub's runners, each platform on its own (macOS
arm64 and x64, Windows x64, Linux x64 and arm64, the AppImage on Ubuntu 22.04 for its glibc), with
`scripts/build-app.ts`, and checks the compiled server there with `scripts/check-binary.ts`; `bun
run typecheck` and `bun test` run beside it on Linux (with uv and ffmpeg, which the demo voice's
tests use).

Builds and tests use Bun 1.4.3 (since 2026-10-15, for tests a file per process, `bun test
--parallel`); Obeya needs 1.3.14 or later: in 1.3.12 on Linux, an `fs.watch` closed while Bun still
listed its directory deadlocked a thread of Bun's work pool, and every later bundle of a page (the
canvas, the panel), which waits for that whole pool, hung for good (found 2026-10-13 from the
panel's test, which hung on GitHub's runner after the plan-doc watch tests). `bun start` from a
checkout runs on whatever Bun the machine has: on Linux with a Bun before 1.3.14 Obeya still starts,
but warns at startup in the log (which stays readable once the deadlock keeps the canvas from
loading) and, for as long as it runs on that Bun, with a pill in the bar („Bun 1.3.12 ist zu alt“,
on hover what may happen and `bun upgrade`), which the server's `hello` brings to the page
(`oldLinuxBun` in `repo.ts`).

#### When the build runs

The build runs on a push to `main` that changes code (docs, design, the site, Markdown files and the
Pages workflow left out, as in `src/core/inert.ts`, which the self-update follows too, except that a change to the build
workflow itself builds), the installers kept a week as the run's artifacts, and on a tag
`v<version>`, which must be `package.json`'s: then a draft GitHub Release gets every installer, the
updater's archives with their signatures, `SHA256SUMS` and `latest.json` (`scripts/release.ts`), its
notes the subjects of the commits since the version tag before that change what runs (the first
twelve lines also in `latest.json`, for the bar; other tags such as `site-media` do not count, and
the first release says that it is one rather than listing the whole history), and the owner
publishes it. The installers carry fixed names without the version (`Obeya-macOS-arm64.dmg`,
`Obeya-Windows-x64-setup.exe`, `obeya_amd64.deb` …), which the README and the site link through
`releases/latest/download/`, so the release is made the latest (`site-media`, the site's video, is a
pre-release and never is). A run takes about ten minutes (2026-10-08).

The updater's archives are signed by `build-app.ts` itself when `TAURI_SIGNING_PRIVATE_KEY` is set
(a repository secret, read on tags only): `Obeya.app.tar.gz` packed from the app on macOS, the NSIS
installer, the AppImage after the server is in it. Tauri's own `createUpdaterArtifacts` needs the
updater plugin's configuration and would sign the AppImage without the server.

#### Signing and notarisation

On a tag (or run by hand with "sign") the Macs' app is signed with the Developer ID and notarised:
`build-app.ts` has Tauri sign shell, server and DMG with the certificate (from the repository secret
`APPLE_CERTIFICATE`, which Tauri imports into a keychain of its own; on a Mac the keychain's, named
by `APPLE_SIGNING_IDENTITY`), then submits the DMG to Apple's notary service with an App Store
Connect API key (`APPLE_NOTARY_KEY`, `APPLE_NOTARY_KEY_ID`, and `APPLE_NOTARY_ISSUER` for a team
key), staples the ticket to the DMG and to the app beside it (the updater's archive packs that one;
stapler fetches the ticket from Apple's CloudKit, which now and then drops the connection for
minutes, so each staple and validation is tried six times over about thirteen minutes) and fails
unless Gatekeeper calls both "Notarized Developer ID". One submission covers the app and the server
inside the DMG; Tauri's own notarisation is not used, since it notarises the app but not the DMG and
takes no individual key. A tag without the Apple secrets fails rather than releasing an app macOS
would not open. Notarised on the owner's Mac and on GitHub's runners for both Macs (2026-10-09):
Apple accepted Bun's binary with the JIT entitlements; Apple answered within 35–40 s.

Windows and Linux are not signed: the release notes say how to check a download against
`SHA256SUMS`, and the site and the README what SmartScreen shows. For Windows, Obeya has applied to
the SignPath Foundation (2026-10-19); its conditions bring a code signing policy, a page of the site
(`site/code-signing/`) that the site's download section and footer, the README and every release's
notes link (`docs/release.md` § The SignPath Foundation). The maintainer's steps (agreement,
certificate, API key, the updater's key, a release) are in `docs/release.md`.

#### Making a release

"Mach ein Release" is the project skill `.claude/skills/release/`, which every Claude session in
this repository has, on a card or in a terminal: it goes through the steps of `docs/release.md` § "A
release" in their order and holds only what to judge and where the owner comes in.
`scripts/release-status.ts` prints what that is decided from (the last version tag and the commits
since, the version to propose, how far GitHub's main is behind, the latest release and `site-media`,
the site's video against the last UI commit, the build's secrets) and, with `draft <tag>`, whether
the build's draft holds everything. `scripts/gh.ts` runs any other gh call on the checkout's origin
as the account that owns it (the repository as GH_REPO, the token of the owner's gh login as
GH_TOKEN), since the machine's active gh account may lack the admin rights a workflow run or a rerun
needs; the status script and the video's upload take their environment from it. Nothing names
sadilek/obeya: in a fork they act on the fork as its owner, and without a gh login for the owner (an
organisation) gh runs as it would anyway.

Every release renders the hero video again and takes the site's screenshots again from that render;
the card's demo is the new video, so the owner watches it and approves the release in one step.
After the landing the worker pushes `main`, tags, watches the build, checks the draft and uploads
the video; the owner publishes.

### App updates

The app updates itself from GitHub Releases through Tauri's updater (`app/src/update.rs`), with
Obeya's own key pair: the public key and the endpoint (`releases/latest/download/latest.json`, so
only a published release counts) are in `app/tauri.conf.json`, the private key signs in CI (see
Builds). At start and every six hours the shell asks; a newer version is downloaded and its
signature checked at once, so installing takes seconds. Every three seconds the shell reports it to
the server it started in this run (`POST /api/app-update`, gone 10 s after the shell stops
reporting), and the bar shows "Update 0.4.0" with the release's notes on hover and "Installieren".

The app never installs by itself: the owner's click (`POST /api/app-update/install`) asks the
restarter for an `update`, which waits as a restart for new code does (workers told and paused at a
safe point, at most 15 minutes; the owner's video or dictation holds it; "Jetzt aktualisieren" goes
ahead), covers a restart already waiting, and gives way to a stop. Then the server ends with exit
code 77 (`UPDATE`), which its supervisor passes on, and the shell, seeing its server end so, shows
"Obeya wird aktualisiert …", installs the update (the app bundle swapped on macOS, asking for an
administrator only where the app's folder is not writable; the NSIS installer in its passive mode on
Windows, which starts the app again itself, as the desktop's user and so without an environment set
for the app's process alone; the AppImage file replaced) and starts the app again, whose server
resumes the workers. An update that fails to install says why in a dialog, and the app starts again
in its old version.

A .deb is not replaced by the app (dpkg needs root): its bar offers the release to download instead.
No update is offered for an Obeya the app did not start in this run (it would not see it end), nor
from a checkout, which follows its git (its bar offers the upstream's new commits instead, see
Pulling from the upstream). `bun scripts/check-update.ts` checks it on the machine it
runs on: it builds the app as 0.0.1 and 0.0.2 with a key pair and a local release made for the
check, installs the first, and has it find, download and install the second and start again. It
passed on macOS arm64 and on GitHub's Windows x64 and Ubuntu x64 runners (2026-10-09).

### Site

The page on obeya.si (`site/`), in English whatever the interface speaks: plain HTML and CSS, no
framework and no build, and JavaScript only for the video's play button and its chapter list, so it
opens straight from the file too.

From the top:

- one sentence ("Direct coding agents like an engineering director": the picture of the one who
  decides and directs spoke to a test reader more than "like a team") and the hero video;
- five pillars with screenshots (the canvas, with a canvas per product that one Obeya runs side by
  side, which the phone's "across all your canvases" builds on; voice, the demo the owner watches instead of testing
  the change themselves, as in a launch review: the audience reads no code anyway, so the contrast
  is with testing, not with code review, with a line in small print below it pointing to
  `demos.obeya.si`, the demos of Obeya's own development; the order in which cards run: parallel where they can, one
  after the other where they must; the phone, two screens of the phone view side by side, what
  waits and the demo opened from there, with how the phone reaches Obeya: over the owner's own
  private network, through no service of Obeya's);
- "From idea to main" with a switch between the standard case, shown first, and the extended cases
  (two radios and CSS, no JavaScript): the standard case is the three steps most cards take, say the
  task, watch the demo, approve, each a card in its state, so that the page reads simple at first
  sight; the extended cases are a card's way along a wall as cards in their states, drawn as the
  canvas draws them: the detours of an idea and its prototypes, a task's work, its demo with the
  round back for changes, the merge and an agent's proposal hanging off it, dashed with ✦ (one
  column below 900 px). Only the demo carries the "!" pin of a card waiting for the owner: idea and
  prototype show states that need nothing of them (the agent thinking, a prototype being built), so
  that the way reads as task, demo, done;
- "The big room", what the name means, with 大部屋 set vertically, and the one wall as the way out of
  many parallel chats (no Toyota, which the README left out on purpose too);
- the dark band "Obeya is built with Obeya.";
- getting started with the downloads, `bun start` from the checkout and GitHub (not the design doc,
  which is written for the agents working on Obeya).

A second page, `site/code-signing/` ("Code signing policy"), linked under the downloads and in the
footer, is what the SignPath Foundation asks of a project it signs for: who signs what, the team's
roles and what Obeya sends where. It shares the stylesheet.

A third, `site/watch-the-demo/` ("Why demos" in the navigation and the footer), is an essay in the
owner's first person with the thesis "Stop testing your agents' work. Watch the demo.": the agents
outpace whoever tests their work by hand; a director has the work shown in a launch review; what a
demo is (the video and the worker's handover note, no report) and the rules that make it evidence
(the code under review, every behaviour in the video, backend through a view, a page where there is
something to look at); recording it is an end-to-end test the agent runs on its own work; what is
left for the owner; the demos as a record. It is what a launch post links when it argues rather than shows, and carries its
own Open Graph tags, with the demo screenshot as its picture (2026-10-19).

It has Obeya's palette and type (see Visual identity): Newsreader, IBM Plex Sans Condensed and the
three characters of 大部屋 (Noto Serif JP) are served from `site/fonts/` with their OFL licences, not
from Google Fonts; logo and wordmark are copies from `src/ui/logo/`. The screenshots show the
English interface on the Tipjar app of the hero video, the demo one a demo of a Tipjar change (so
that the picture is of a demo, not of Obeya), the phone's the same wall in the phone view at an
iPhone's size; `bun scripts/site-shots.ts` takes them all again from a scratch Obeya, the demo's
chapters from its `chapters.vtt`. Paths are relative, so the site works under sadilek.github.io/obeya as well.

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main` on GitHub
that touches `site/` or the workflow, and on demand from the Actions tab; Pages serves a branch only
from `/` or `/docs`, hence the workflow. The domain obeya.si is verified for the GitHub account and
set in the repository's Pages settings, with HTTPS enforced (a `CNAME` file would be ignored by a
workflow deployment); at the registrar the apex points at GitHub Pages' four A and four AAAA
addresses and `www` is a CNAME to `sadilek.github.io`, which Pages redirects to obeya.si.

### Hero video

The site's film is a real run (`scripts/hero-video/`), recorded with Obeya's own demo pipeline on a
scratch canvas over a small tip calculator (Tipjar, in `tipjar/` there with its own `.obeya/settings.json`
and plan doc): the wall arranged (a lasso into a group, a card dragged beside another group so their
territories meet), an idea by voice, a message typed, pasted and spoken in Obeya's sidebar (with a
preference Obeya proposes), a real worker building the idea and recording its demo, comments said
into the demo video at two places and sent together at its end, the worker's new demo, the approval
landing it on main, proposals from an agent and from Obeya's work retrospective, an idea discussed
with its agent; about four minutes, sharp as the app on a Retina screen, narrated in English in the
owner's ElevenLabs voice clone (see CLAUDE.md), tried out first in the Qwen3 clone (`render.ts --qwen`).
The directory holds the narration, the scenes, the stage and the render; its README says how to
change, re-render and publish it.

The video is not in git: it, its captions, its chapters and the README's loop are the assets
`hero.mp4`, `hero.vtt`, `hero.chapters.vtt` and `hero.loop.gif` of the GitHub release `site-media` (a pre-release, so that it never becomes the
latest release, whose installers the README and the site link), which the Pages workflow fetches
into `site/media/` before it publishes, so obeya.si serves them itself (no third party, no
tracking). `publish.ts` replaces them and runs the workflow again; the chapters come from the render
(the demo pipeline writes the scenes as `chapters.vtt` beside the captions), so they always match
the video that is out. The loop is cut from the video at each publish, by the titles of its scenes
("Your wall" to "The agent starts"), so a release's new render brings a new loop too: 1.5 times as
fast, its last frame held a moment, 1280 px wide at 12 frames a second, about 18 s and 3 MB.

On the page it is a `<video>` with English captions and a poster (`site/img/hero-poster.jpg`, the
first frame without a play button, in git, made by `poster.py`), loading nothing before a click (`preload="none"`); opened from the file, the site shows
the poster alone. A few lines of script put a big play button (a real `<button>`) over the poster
and show the browser's controls once it plays; without JavaScript the controls are there from the
start and the button stays hidden. Under the video its scenes are listed as on a card's demo (time
and title, four to a row, two on a phone): the list is built from the video's chapters track, a
click plays from that scene, and the scene that plays is lifted as a card. The mark follows the
time, not the track's active cues, which Chrome leaves stale after a seek. Without JavaScript or
without the chapters file there is no list.

### Decisions

- **Runtime: Bun; browser UI served locally. Installed, Obeya is an app**: a Tauri shell around the
  server compiled into one file, so that someone without Bun or a checkout can download and start
  it, and the shell can hear a key held anywhere on the machine (global push-to-talk). Tauri because
  it brings the installers, the updater and global keys, and its window is the system's webview, so
  the shell adds a few MB and the UI stays what the browser shows; the browser stays a way in, and
  the checkout (`bun start`, updating itself) stays how Obeya is developed. At first the decision
  was a shell only if global push-to-talk needed one; a download for people who do not develop Obeya
  made it needed anyway.
- **The app's formats** (2026-10-06): DMG, NSIS installer, AppImage and .deb, no Flatpak or Snap,
  whose sandboxes are in the way of git, agents and the repositories. Windows on ARM once there is a
  machine to try it on.
- **Signing** (2026-10-06): the Mac app signed with a Developer ID and notarised from the first
  release, since macOS will not open an unnotarised download without a detour through the system
  settings; Windows and Linux unsigned, with checksums. SmartScreen warns about a new installer
  signed or not until it has a reputation, so a Windows certificate comes after the first release
  (SignPath Foundation, free for open-source projects). Applied for after v0.5.0 (2026-10-19),
  disclosing that the server has Anthropic's proprietary Agent SDK compiled in, which SignPath's
  terms exclude: dropping the SDK would leave Obeya tracking Claude Code's undocumented control
  protocol itself, for no gain to users, so SignPath decides first; a certificate in the owner's
  name is the fallback.
- **A release is a project skill with a status script**, not a script alone and not left to each
  session (2026-10-13): the steps were spread over three documents, and v0.1.0 ran into three
  problems nobody had written down (GitHub's main 35 commits behind, `site-media` the latest
  release, the tag pushed by hand). Checking the narration against the UI, looking at the stills and
  judging the draft need an agent; what it decides from is the script's. Every release renders the
  video again, stale or not: almost every release changes the UI. Publishing stays the owner's
  click, since it reaches every installed app.
- **Obeya is made known through a static English site on obeya.si that starts with the film**
  (2026-10-06). Of three prototypes, B (film first, calm and editorial) became the page; C gave it
  the principles as cards on a wall, the four steps as one card moving along the wall and "The big
  room". A's canvas that the camera flew through while scrolling was built in and dropped again: the
  owner found the scrolling odd. The hero video is a release asset rather than in git or on a video
  host (2026-10-07): git holds no video, and the site loads nothing from a third party.

## Data

Persistent (SQLite):

- canvases;
- cards: kind, state, position, parent; agent session, workspace, branch, status line, open question
  or review summary (with the reason when there is no demo), the card it came from (a proposal's
  source, a follow-up's card), estimated scope, queue, when archived, the pull request (link,
  checks, the comments, failed checks and conflict already passed on), an idea's status, brief and
  open questions with its agent's picks and suggested next step, a prototype's idea, how it ended
  and its worker's proposal to build on it, the prototype an idea is built on, landed work whose
  worker still finishes; an approval held until the work can land; what landed work shipped with; a
  waiting card's stopped app; until when a card is snoozed, by whom and why; a worker's proposal waiting for the owner (why, its open
  questions); a project's plan doc as last read and the idea or task it came from; that a card
  becomes a project, and the plan docs its landed work added;
- the shared demo page: slug, link, the demo directory it shows, what the page shows (title, text,
  chapters, kind) and the pull request it links, the newest page change it was published after, and
  whether it is publishing or withdrawing; sharing many outdated pages again: the cards still to go,
  how many are out and which failed, and the newest change when the owner put the notice away;
- what each card changed in a folder without git, and the undo it has there (`folder_cards`);
- card events (the log, with an error code where the UI words it, the owner's screenshots, an idea
  agent's mocks, and on Obeya's reply what a draft for its makers starts from), a card's own screenshots, workspaces and their leases;
- decision log, preferences;
- the Koordinator's conversation with the owner (what was said, its reply, the screenshots that came
  with it, the open card, whether it was taken back; a looked-up question, the card it is about, its
  answer and who gave it, the session of the agent that looked it up, the thread it belongs to and
  the answer it follows up on, the files the answer came with, and the Question card the thread
  moved onto, and what a draft for Obeya's makers starts from when its reply says Obeya cannot do it
or the owner asked to tell them something), a Question card's thread (the exchange it started with, whether its agent reads, what
  the owner asked that it has not answered yet, its counts of answers and files), the answer a
  message of a card's log is (its thread, files, the question it continues);
- confirmed commands waiting for their undo window (`commands`);
- groups (name, colour) and the group of each card;
- per-canvas settings (the home repository; per repository the card collecting its CLAUDE.md rules; the Rückschau's count and when its history
  begins; per repository the Arbeitsrückschau's count and when it last ran);
- the devices paired to reach Obeya from elsewhere (`devices`: the hash of the cookie, name, when
  paired and last seen, its push subscription);
- the friction noted on each card's runs (per repository), and on a card the Arbeitsrückschau
  proposed what it rests on, and the settings' values it proposed (`setting_proposals`: repository,
  setting, value, basis, cards, and where the owner took it).

Files under `~/.obeya/` (the same for the app and a checkout): the database (`obeya.db`), the
owner's screenshots (`images/<canvas>/`), the configuration (`canvases.json`), the settings
(`settings.json`, `demo.json`, `voice.json`), where the running Obeya answers (`server.json`), the
`tailscale serve` entry Obeya made (`tailscale-serve.json`), the key it signs pushes with
(`vapid.json`), the app's server log (`app.log`), voices and models (`voices/`), the workers' clones and worktrees
(`workspaces/`), the Lesestand's worktrees (`read/`), the cards' undo in folders without git (`undo/`), the files of looked-up answers
(`answers/<canvas>/<thread>/`), the static sites Obeya keeps (`sites/<key>/`), the env files their
repositories' settings name (relative to the home, `sites/demos/deploy.env`, say), and `share/`,
the directory deploys run in.

Derived, not stored: git, PR and CI state (read from git and GitHub), plan-doc content (read from
the repository; the copy on the project is only for the archive).

## Open questions

- Plan-doc sync: Obeya reads plan docs and never writes them; workers tick off their workstream in
  the doc as part of their change. Should the project agent keep the doc's progress instead?
- Cloud hosts, left out for now (2026-10-10): a host type whose slots are cloud instances, one per
  card (an EC2 `m8g.xlarge`, say, in the using repository's cloud account), launched from a prepared
  image when the other machines are full, stopped some minutes after the card's last turn (only the
  disk kept), started again on the owner's next message and terminated once the work has landed,
  with a cap on concurrent instances. Image, network and IAM would be the using repository's
  infrastructure. Estimated from the measurement under Agents and workspaces, Decisions: about $25 a
  month with the Mac alone at that load, nearly nothing with a second machine, $190–290 a month on
  demand at 36 agents. Worth it only if parking and SSH hosts leave the owner short of slots.
  Reaching them, and the second MacBook away from home, would need more than plain SSH on the home
  network (Tailscale, say).
