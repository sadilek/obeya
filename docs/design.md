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

*Obeya* is Japanese for "big room": in lean management, the room where every project hangs
visibly on the walls and decisions are made in front of the wall.

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
  stays in the conversation of the open card, or in the Koordinator's sheet.
- **Repo-agnostic core.** Project specifics live in a per-repo adapter, which a repository can
  carry itself (`.obeya/adapter/`).

## Concepts

- **Canvas** — a canvas spans one or more repositories; one Obeya serves several canvases.
- **Cards** — everything on the canvas is a card: a task (`task`; in the UI an *Aufgabe*), an idea,
  a prototype, or a `project`, a container backed by a plan doc whose workstreams are its child
  cards. Tasks have no further kind: whether one fixes a bug or adds something makes no difference
  to how it is worked on, so the owner does not pick one. A task's card names no kind either (that
  it is one shows); the others say what they are (idea, prototype, workstream number, project).
  The UI and the Koordinator say *Aufgabe* and *Folgeaufgabe*, never *Karte*.
- **Groups** — besides by place, the owner sorts the canvas by group: a group has a name and a
  colour, and a card belongs to none or one. A project belongs to one as a whole, with its
  workstreams. A proposal, a follow-up, a package cut from a card and a prototype come into the group
  of the card they come from, a project written from an idea into the idea's; after that the group
  is the card's own. Moving a card never changes its group: a card in another group's territory
  stands there as an island. A group exists while a card belongs to it, on the canvas or in the
  archive; the last card leaving it ends it, and so does deleting it, which takes all its cards out.
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
   panel or holds Space with the idea open; both go through the Koordinator, which passes the
   words on as talk to the idea at once (picked options go straight to the agent, with the words
   beside them). The reply stands in the panel, and only its short
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
   turn (what changed in the brief, which open question is next). A variant that is something to
   look at (a layout, a dialog) comes with a mock: a few lines of HTML the agent passes with the
   brief (`update_brief`'s `mocks`, one per variant, with its title; left out, the mocks stay) or,
   for something the brief has no place for, with its reply. The card shows each in the frame of a
   worker's HTML artifact (sandboxed, scripts in an origin of their own), sized to its content, the
   brief's side by side under it. A worker who builds the idea or a prototype of it gets the
   brief's mocks as HTML after the brief.
4. A prototype ("Prototyp bauen lassen"), when talking is not enough: a worker builds a throwaway one in its own workspace,
   on a card of its own below the idea, and records a demo. Several may run side by side, one per
   approach; each carries its approach in its title ("Prototyp: Logo – Wortmarke", the first words of
   what the owner asked it to show). When the brief plans prototypes of several variants, the
   agent also passes them to Obeya (`plan_prototypes`: per variant a few words and what its
   prototype shows); "Prototyp bauen lassen" then offers them as checkboxes, each chosen unless its
   prototype runs already, beside a field for an approach of the owner's own, and starts one worker
   per variant at once, its title the variant's words and its task that variant only (2026-10-05:
   three clicks with an empty field had started three prototypes of the same brief, which planned
   three variants). Spoken without words, it starts the planned variants that have none running;
   without planned variants, an empty field is the idea as it stands. The idea shows the demos of all its prototypes, each under its
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
   writes a plan doc with workstreams, which lands like any change (a PR, say). The project then
   takes the idea's place on the canvas (cards it would cover move aside, by as much as it outgrows
   the idea) and links back to it; the idea goes to the archive once its
   worker is done (put back, it stays). The idea's prototypes stay on the canvas, each still naming
   its idea, and the plan doc's worker hears what each showed (its handover, or that it is still
   being built), so the doc builds on them instead of planning them again; only the workstream that
   builds on the chosen prototype mentions prototypes. While the doc is written, "Diesen Prototyp
   bauen" waits for the project; once it stands, the button builds that workstream (the one nobody
   has started that mentions prototypes; the owner picks another, or picks one where the doc names
   none or several), and it is built on the prototype's branch as an idea would be ("Auf Prototyp „…“" in the project's decisions), its worker told to take
   the workstream from the plan doc; the idea's other prototypes are discarded. Before
   (2026-10-06), planning left the prototypes behind unmentioned: the plan doc planned them again
   as workstreams, and once the idea was archived, building on one failed with a 400. "Parken" and "Verwerfen" leave the card with its brief; talking
   to it opens it again. A dropped idea can be archived ("Archivieren" in it or its archive button on the canvas, as on
   a finished card; not while a prototype of it is on the canvas, and then the button is not shown): in the archive it shows its brief and conversation read-only and can go back to its
   place, where talking to it opens it again. Decisions from the conversation go into the decision log; lasting
   preferences are learned by the Koordinator as before.
   While the agent works on a reply, planning waits (so does "Diesen Prototyp bauen"): the buttons
   are disabled with "Antwort kommt gleich", and the server refuses them (`ideaThinking`). The
   reply almost always rewrites the brief, so a plan taken before it would start from a brief the
   owner never read. "So bauen" does not wait (2026-10-06: the last answer of a session is often
   clear and simple, and the owner knows that building comes next): clicked during a reply, the
   idea is built once the agent has answered all it was told, with the brief it leaves, unless
   its reply asks questions; then nothing is built, the conversation says why, and the owner
   decides again. The panel stays open while it waits: the button reads "Baut nach der Antwort …"
   with "Doch nicht bauen" beside it, and the canvas card says "baut nach der Antwort". The agent
   hears of the click with its next step, as the brief it leaves becomes the task. A turn that ends
   without a reply (an error, a restart), parking or dropping call the building off too. A voice
   command that plans such an idea, or one that also discusses it, only passes what was said to
   the agent, and the Koordinator says that planning goes by a click once the reply is there; one
   that builds it ("nimm noch X auf und bau es dann") passes it on and builds after the reply,
   like the click. Parking and dropping
   act at once and end the turn, but lose nothing: the messages the agent has not answered (the
   one it worked on and those queued behind it) stay with the idea (`unread`, across restarts)
   and go to it first, with why its turn ended, when the conversation goes on. The same holds for
   a turn that ended with an error, and for messages queued when Obeya stopped.

## Card lifecycle

1. A card is created by the owner (voice or canvas) or proposed by an agent; the owner can
   edit a proposal, and accepting it starts it (it goes to the Koordinator like a started
   `planned` card) unless they only accept it as `planned`. A worker writes a proposal's text for
   the agent that will take the card on, as the owner would write a card: no "I" or "my question"
   of its own, other cards named by their title. Apart from the text it says why, for the owner
   only (beside "Vorgeschlagen vom Agenten der Aufgabe …"), and what the owner has to decide, as
   questions with options. The owner may pick options on the proposal before taking it; accepting
   writes the questions into the text, those with a pick under "Entschieden:", the others under
   "Offene Fragen:", so the new worker reads what is settled and asks the rest. A worker may also
   propose an idea, for something to think through first: it shows as "✦ Vorschlag · Idee", and
   "Übernehmen und besprechen" makes it an open idea whose exploration agent opens the discussion
   with the text and its questions; "Als Aufgabe übernehmen" plans it as a task instead. Instead
   of editing a proposal by hand, the owner may say (or type into its field „Was soll anders
   werden?“) what should change: the Koordinator reads it as `revise`, and after the undo window a
   read-only agent (`revisions.ts`, a Koordinator turn, in the card's repository) rewrites title, text,
   reason and questions by those words, keeping what they did not touch; a question the words
   settle goes, and its decision into the text. As with an idea, the conversation about it stands
   beside the proposal, its questions at the end of it and the field under it; the proposal's text
   and reason are on the left, its buttons below both. The text box is as tall as the text and
   the panel grows with it up to the screen's height; only beyond that does the box scroll. Options picked there and sent („Antworten“,
   with words or without) go to the reviser at once, without the Koordinator or an undo window, and
   stand in the conversation as the owner's words; accepting instead takes the picks into the text
   as above. Meanwhile the proposal shows „wird überarbeitet“ (in the
   conversation, where the field was), cannot be edited or only accepted („Übernehmen“), and takes
   no second revision; it is not among the cards that need the owner. The owner's words stand in
   its conversation, then „Vorschlag überarbeitet.“; an agent
   that ends without a text leaves the proposal as it was, with the error. A revision still running
   at a restart starts again. „Übernehmen und starten“ (on a proposed idea „Übernehmen und
   besprechen“) does not wait, as "So bauen" on an idea does not (2026-10-06: the owner who
   answered the last question knows that starting comes next): clicked during a revision, the
   proposal is accepted and started once the new text is there, unless it still has questions;
   then it stays a proposal, and the conversation says why, as it does when the reviser ends
   without a text. The panel stays open while it waits: the button reads „Startet nach der
   Überarbeitung …“ with „Doch nicht übernehmen“ beside it, and the canvas card says „danach
   übernommen“. The waiting button and its take-back are one component with an idea's. Said by
   voice, accepting during a revision is still refused, see below. Before (2026-10-06), the button
   was disabled until the new text was there. Before,
   a proposal was the worker's reason and suggestion as one text, in the first person, with open
   questions buried in it; taken as it was, it went to the next worker as if the owner had
   written it.
2. `working`: the worker leases a workspace, implements, runs the local reviews the repo adapter
   names, and records the demo.
3. `waiting: demo`: the card carries the demo. The owner approves or gives feedback; feedback
   sends the card back to `working`. The demo plays on its own the first time the card is opened
   (per browser; a new render counts as new), later it waits to be played, with a big play button
   over it like a shared page's (also when the browser blocks the first play). The worker's
   summary is its handover in the card's conversation below, not repeated under the demo: the
   whole report, what changed for the user and what the owner needs to know, in a few short
   paragraphs at most. A problem the worker noticed beyond the task is a proposal
   (`propose_card`), not a line in the report. A follow-up's worker hears which card it comes from
   and that card's summary. A question in the demo report is an
   open question like a worker's: the owner answers it on the card or by voice, the worker hears
   the answer, and the demo keeps waiting for approval. While the worker takes in the answer (it
   may rework the demo and hand over anew), the card is at work: „Agent arbeitet an deiner
   Antwort“, no badge, not counted as needing the owner. Once its turn ends, a demo still waiting
   is the owner's again; a restart resumes that turn like a working card's, also when the worker
   ended it to pause for the restart. Before (2026-10-07), the card kept its badge while the
   worker reworked the demo the answer asked for, and a worker that paused for a restart there
   was never resumed: the card waited with a demo its worker had not finished.
   A card has one field for the owner's words with one Send (`ownerField` in `src/ui/talk.ts`):
   under such a demo it takes the answer and feedback together, and the Koordinator sorts them out
   as it does spoken words: words that only answer are the answer, words that ask for a change are
   feedback, the answer among them.
4. Where work lands through pull requests, approval puts the card `in PR`: its worker opens
   the PR and Obeya carries it through the merge, which it does itself. Review comments, failed checks and conflicts go to the
   worker; only what needs judgement — a review comment that questions a decision, a conflict with
   product meaning — comes back to the owner as a question on the card, and the answer returns it
   to the PR. A PR closed without a merge asks the owner whether to open it again or drop the work.
   Where the adapter allows it (`direct`), the owner may instead approve with "Direkt auf main"
   beside "Freigeben (PR)", or by voice ("gib frei ohne PR"): Obeya pushes the work onto the
   default branch itself, without a pull request, review or the PR's CI, and the card is `live`.
   Where work lands on `main` (Obeya), approval lands it at once.
   A click on an approve button folds the card at once, without waiting for the server (a push
   onto main takes seconds): until the answer, the card on the canvas says what is under way
   („wird direkt auf main gepusht …“) and a message with a spinner stands above the microphone.
   The answer turns the message into the confirmation, or, when the landing is refused, into the
   card's title and why, with the card waiting for review again. Before, the card stayed open
   with nothing to show the click had registered until the push was through.
5. Merged (or landed on `main`) → `live`. The demo stays on the card. The worker hears that its
   work is on main and may finish what was waiting for that (a data migration, say) before its
   session ends. Work that changed nothing in the repository (the task wanted a demo, an analysis,
   an answer) has nothing to land: approving it makes the card `done` ("Erledigt") without a pull
   request or a landing, and its worker finishes the same way. The owner sees that before
   approving: when the handover finds nothing on the branch (no commits, nothing uncommitted), the
   button reads "Beenden" instead of "Freigeben", with a line that no pull request follows: there is
   nothing to release, only the card to close. A worker whose approved work turns
   out to change nothing (its branch emptied after the approval) closes the card itself with
   `close_unchanged`, which Obeya refuses while the workspace holds commits or uncommitted
   changes. Before, such a card waited in `in PR` for a pull request that could never come
   (a demo card on 2026-10-02).
6. Archived, when the owner takes the finished card off the canvas ("Archivieren" on the card or
   its archive button on the canvas, shown while the pointer is on it, or all finished ones at
   once in the archive), or when a prototype ends (discarded or built; Ideas, 4). The archive
   (button or `A`) lists archived cards
   by day, the most recently archived first, as small cards on a timeline with the time they were
   archived; one unfolds from its card as on the canvas and can go back to the place it had. An
   ended prototype cannot: it shows, read-only, how it ended, its demo and conversation.
7. A project ends when its plan doc goes (done, deleted): it moves into the
   archive with its workstreams, which are not listed on their own. Its sheet then shows, read-only,
   the goal and the workstreams as the doc last stood; each workstream unfolds with its conversation and demo.
   When the same file comes back, the project returns to its place. Every project's sheet, live or
   archived, lists its decisions and links the idea its plan doc was written from: when an idea's
   "Plan-Doc" card lands and its diff adds a doc in the plan directory, the project from that doc
   remembers the idea, whose card keeps its brief and conversation, and the idea's decisions join
   the project's. The project takes the idea's place, and the idea, once its worker is done, goes to
   the archive.

## Communication

Agents never talk to each other directly; the Obeya server is the mailbox, so every exchange is
visible on a card. A worker has five tools, served in-process: `report(status)`, a status line
on the card; `reply(text)`, its answer to a note or feedback in the card's conversation, which
does not end its turn; `ask(question, options, multiple, pick, pick_why)`, which returns at once — the worker ends its turn
and the answer arrives as its next message (the owner picks one option, several when `multiple`,
or writes their own answer; `pick` and `pick_why` are the options the worker would choose if it
had to decide, and why, which the card marks "Würde ich nehmen" the way an idea's questions show
its agent's pick); `propose_card(title, task, reason, idea?, questions?)` (Card lifecycle, 1); and
`ready_for_review(summary, demo | no_demo)`, whose summary is the report the owner reads. A turn that ends without `ask` or `ready_for_review` gets one nudge,
then its last words become a question to the owner; when that turn failed in the session (the
SDK reports an error result, e.g. Claude not logged in on the machine), the question is the error
in words for the owner instead. A turn the account's usage limit stopped (the five-hour session
limit, a weekly one: the SDK's `rate_limit_event` says `rejected` and when it resets, the API error
is `rate_limit`) is neither nudged nor a question: the card's log says when the worker goes on, its
status line reads „Nutzungslimit · weiter um 14:40“, and ten seconds after the reset Obeya tells
the worker to go on where it stopped (a limit that holds past its reset time is tried again after
a minute, one without a reset time every 15 minutes). Meanwhile
the worker is not busy, so a restart need not wait for it (the resumed session runs into the limit
again and waits anew), and a note from the owner reaches it at once. Once it works again its
status line from before is back. A turn that ends while the worker's own
background work runs (a demo render, a test suite, a watcher it started) is no such turn: the work
wakes the worker when it finishes or fires, so Obeya waits, and only after ten minutes without a
sign of life does it nudge. So does a turn in which the worker said and did nothing: a session
resumed after a restart first ends a turn of its own over what the previous one left (a
background command the restart stopped), and counting that would use up the nudge before the
worker's own turn, whose status line would then reach the owner as a question. A
worker that went to the owner for having stopped and then works on by itself takes that question
back. The owner can send a note at any time; it reaches the worker without stopping it. The SDK
hands a waiting message to the agent only after its running tool call, so a note never cuts a
command off (tests and renders included), and workers keep their tool calls short instead: they
wait for anything external (a deploy, a CI run, a point in time) in the background
(`run_in_background`, Monitor) and end their turn, which a note starts again at once. A Bash
command in the foreground that sleeps longer than 30 seconds (`sleep N`, a polling loop without a
bound, counted from the command line by `foregroundSleep` in `src/server/runtime.ts`) is refused
with that reason. `timeout N` (or `gtimeout`) bounds the command it starts, wherever that stands
in the line (`cd app && timeout 28 bash -c 'until …; do sleep 2; done'`). The text of a heredoc
is data (a script written with `cat > f <<'EOF'`, a commit message) and counts only when a shell
runs it (`bash <<EOF`, `cat <<EOF | sh`, `ssh host <<EOF`). The refusal names two
bounded waits that pass it, one without `timeout`, which macOS lacks. A worker answers a note or
feedback with `reply`, saying what it changes or why nothing, and asks when the note is unclear.
A note while the card waits on the worker's question takes that question back: the card goes back
to work (in its pull request, or finishing after the landing, where it was), and the worker hears
that its question („…“) is withdrawn, goes on if the note settled it and asks anew if not. The
note is no answer, so nothing goes into the decision log. Feedback on a demo whose report asks a
question leaves that question as it is.

Every card shows its exchanges as a conversation („Gespräch“), the way an idea does (`talkTurns`
in `src/ui/talk.ts`). Messages are what the owner says (notes, answers, feedback, spoken or typed,
with screenshots; a spoken command that became a note stands once, as the note), the worker's
questions with their options and the pick, its replies, its handovers (the last one with its demo
report's question), and what the Koordinator looked up for the owner; small lines between them are
the state changes (started, pull request opened, approved, landed, stopped, errors). Everything
else folds away under the agent's next message as „Verlauf“: tool calls, thoughts, status lines,
the Koordinator's confirmations, Obeya's notes (restarts, sessions, what happens on the pull
request). A note the worker answered without `reply` (a card from before it, a worker that forgot)
is answered by the first words the worker said after it. Once no agent works on the card and no
question is open, no message is coming for the steps after the last one: they go where they
happened, before the lines that came later. The agent's last words among them stand as its message
(the closing words after a landing, say), a turn it ended without words as its steps, and what only
Obeya or the Koordinator noted there goes. While the worker works, its latest step shows; the question the card waits on (its own, or the one in its demo report) stands at the end with its options,
and the card's one field under it; a question a note took back stays, without options, „Durch deinen Hinweis erledigt“.
A card that was an idea continues the idea's conversation in the same list.

Every card with a conversation is laid out the same way (`Split` and `Talk` in
`src/ui/detail.tsx`): idea, proposal, and a task an agent worked on. What the card is about stands
on the left (an idea's brief, a proposal's text, a task's demo with its chapters and sharing, its
pull request, its text and branch), the conversation on the right with the questions it waits on
at its end and the owner's one field with one Send under it, and the decisions (build, accept,
approve, stop, archive) in a row below both. Before (2026-10-07) a task stacked demo, buttons,
feedback field and conversation in one column, and a demo with a question had a field and a Send
of its own inside the question, with „Freigeben“ between it and the feedback field.

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

A worker's question goes straight to the owner, with the worker's own pick: no other agent
answers it on the owner's behalf (Decisions, 2026-10-07). The worker asks only what it should not
decide itself (product behaviour, trade-offs, anything irreversible or external) and settles the
rest alone. What a project has decided reaches its workstreams' workers instead: a worker's task
holds its project's decision log ("Decisions taken in this project so far") beside the pointer to
the plan doc, and a decision recorded while it runs reaches it once at its next tool call, the way
a learned preference does. Answers given in the owner's name before then stay in the decision
logs, marked "(an agent)", and show on their cards as before. Owner-facing text from agents is in
the owner's language (`src/core/locale.ts`).

## Architecture

- **Server** — Bun, TypeScript. HTTP + WebSocket to the UI, one API per canvas
  (`/api/c/<canvas>/…`, `/api/canvases` lists them); SQLite (`bun:sqlite`) under `~/.obeya/`.
  `obeya <repo>…` starts one canvas with the given repositories (`--name` names it);
  `obeya` starts the canvases `~/.obeya/canvases.json` lists, `obeya --config <file>` those of
  another file. Without that file (the first start) it serves no canvas, and the page is the
  setup assistant (see Setup assistant).
- **Setup assistant** (`src/server/machine.ts`, `src/ui/setup.tsx`) — one list of what Obeya
  needs on this machine, in four parts: *Agenten* (needed: Claude Code, its login, git, and git's
  name and e-mail, without which an agent's commit fails), *Pull Requests* (gh and its login:
  the generic adapter lands through pull requests, so it is needed at the first approval, not
  before), *Sprachbefehle* and *Demos* (the checks the settings sheet makes, voice-setup.ts and
  the demo skill's setup.ts, each with the size still to download; what both need shows once).
  The checkout's agents run on the Agent SDK's own Claude Code, so there it is always there; the
  compiled binary's run on the machine's, and the list says which version Obeya was checked with
  (the SDK's) when the machine's differs. Logins are read from `claude auth status` and `gh auth
  status`. "Installieren" installs what needs no admin rights: Claude Code and uv with their
  official installers (`curl … | sh`, PowerShell's `irm … | iex` on Windows), Piper and Whisper
  through the voice's installation, a demo's voice; system software (git, gh, ffmpeg, Node, a
  browser) comes with the command for this platform and a copy button, and is installed at a click
  where that needs no password (Homebrew where it is there, winget). A login opens a terminal with
  `claude auth login` or `gh auth login` (Terminal through `osascript` on a Mac, `cmd` on Windows,
  the first terminal found on Linux; none found: the command to run by hand); git's name and
  e-mail are typed into two fields. The list checks again when the window gets the focus back.
  Obeya puts `~/.local/bin` (the official installers') and on a Mac Homebrew's directories on its
  `PATH` at start, so what was installed is found from a process the desktop started; on Windows
  it reads the `PATH` from the registry again after an installation. On the first start the page
  ends with the first canvas: a repository's folder (a path, or the system's folder dialog where
  there is one: `osascript`, PowerShell's, zenity or kdialog) or a clone (`owner/name` through `gh
  repo clone` where gh is logged in, else from GitHub by its URL; any git URL; into the home
  directory unless another is given). Obeya writes `canvases.json` with it (its own adapter, else
  the generic one, with two clones when the adapter works in clones), restarts and the page opens
  the canvas, on which a first card says what to try (the marker `welcome` in Obeya's home, read
  once when the canvas runs). Later the Konfiguration sheet opens the same list over the canvas
  ("Einrichtung prüfen"), without the first canvas. A scratch Obeya with `"setup": true` in its
  stage file starts like a first start.
- **One file** — `bun run build` (`scripts/build.ts`) compiles the server with Bun
  (`bun build --compile`) into one binary per platform (macOS arm64 and x64, Linux x64 and arm64,
  Windows x64; Bun cross-compiles, about 15 s for all five), 66–120 MB with the UI and SQLite in
  it, that needs neither Bun nor a checkout. Its modules live in Bun's embedded file system, which
  no other process can read, so what other processes run or import goes beside it as real files,
  in `resources/` (13 MB): the plugin with the demo skill and the `playwright-core` it records
  with, the voice sidecars, the adapter kit bundled into one module (`kit.js`), and the skill's
  `recipe.ts` bundled with Obeya's built-in adapters. The server finds them through one function
  (`resource()` in `src/server/resources.ts`): `OBEYA_RESOURCES` when set, else `resources`
  beside the binary (or `Resources` of a macOS app bundle), else the checkout. The demo skill's
  modules the server carries (the setup check, the voices) are told where their files are
  (`useLib` in the skill's `lib/here.ts`). Nothing is written beside the code: the resources may
  be read-only, what Obeya writes is in its home. The binary is its own Bun for scripts: a share
  command's script runs as `obeya <script>` with `BUN_BE_BUN=1`. It supervises itself as `bun
  start` does (restarting for a saved configuration) but has no checkout to follow, so it never
  restarts for new code. A macOS binary is signed ad hoc after its build: as Bun writes it, macOS
  kills it at start. Bun 1.3.12 leaves a copy of its runtime in the working directory of every
  compile (`.<hex>.bun-build`); the build compiles in the output directory and removes it. The
  UI the binary carries is bundled at build time, with `NODE_ENV` defined as production, so it is
  React's production build, as `bun start` serves it (without the define it was the development
  one).
  `package.json` holds Obeya's version, which the settings show, with the checkout's commit
  beside it when Obeya runs from one. `bun scripts/check-binary.ts <obeya> [--voice] [--demo]
  [--worker]` checks a binary on the machine it runs on: a scratch repository with its own adapter
  and share command, then the voice installed and a spoken command heard, a demo rendered with the
  director from the resources, and a real worker that commits and hands over an artifact, which is
  shared, once on the machine's Claude Code and once on the SDK's. All of it passed on macOS
  arm64 and on GitHub's Windows x64, Ubuntu x64 and Ubuntu arm64 runners (2026-10-07). The
  installable app around it is planned in `docs/plan/app.md`.
- **Configuration** — the canvases with their repositories (path, adapter, clones), seen and edited
  in the "Konfiguration" sheet: each canvas shows its id and whether it runs, each repository its id,
  adapter, whether workers use clones or worktrees, and the command that shares its demos (empty:
  the adapter's, or an export; see Sharing a demo); problems (no git repository, an unknown
  adapter, two canvases with one id, a canvas's home repository left out, a share command whose program is not there) show at the field while
  editing and keep it from being saved. Saving writes the file and restarts Obeya once no worker is
  in the middle of a turn (as for new code), a tenth of a second after the answer went out; the page reloads. Started with repositories on the
  command line, Obeya shows those, and saving makes the file the configuration it restarts with.
  Renaming a running canvas keeps its id (`id` in the file), so its cards stay. The server's own
  settings (port, data directory, the agents' permission mode) come from the command line and show
  read-only. The Koordinator reads the configuration (`config` tool) to answer questions about it
  and changes it on the owner's word (`configure`, the whole new list, checked like the sheet's),
  with the usual confirmation and undo window. Below the canvases the sheet has the demo settings
  (see Demos), saved on their own into `demo.json` in Obeya's home and read by the next render, so
  saving them restarts nothing. Above them is the language, saved the same way into
  `settings.json` (see Language), and the model and effort of each group of agents (see Models
  and effort).
- **Models and effort** — every agent belongs to one of four groups, each with its model and
  effort: the Koordinator (voice commands, estimates, cuts and schedules, look-ups, project
  agents, learner, Rückschau, proposal rewrites), the workers on cards, the exploration agents of
  ideas, and small jobs (the Arbeitsrückschau's notes and proposals, the text of a shared demo's
  page). The owner chooses both in the Konfiguration sheet: the model is Claude Code's default or
  one of its aliases (Fable, Opus, Sonnet, Haiku, each the newest of its family), the effort always
  a fixed level (low to max). Preset (`AGENT_DEFAULTS`) are Claude Code's default model, Sonnet
  for small jobs, and high effort, medium for the Koordinator; the sheet marks the presets. The
  choices live in `settings.json` under `agents`, only where they differ from the presets
  (`src/server/settings.ts`); every session names its group (`AgentSpec.role`), and
  `withAgentSetting` (`runtime.ts`), which wraps the canvas's runtimes, asks for the group's
  setting at each start. Saving restarts nothing and takes effect for every agent that starts
  afterwards; a session at work keeps what it started with, except the voice commands' session,
  which is opened anew once the Koordinator's setting changed, as it is for another language.
- **Language** — Obeya speaks German or English to the owner. The owner chooses it in the
  Konfiguration sheet; until then the system's applies: on a Mac the language of its interface
  (`AppleLanguages`), elsewhere `LC_ALL`, `LC_MESSAGES`, `LANG` in that order, then what the
  runtime reports; a language Obeya does not speak gives English. The choice lives in
  `settings.json` in Obeya's home (`src/server/settings.ts`; the system's language is worked out
  in `plugin/skills/demo/lib/language.ts`, which the demo skill shares), which the server reads
  whenever it needs the language (`ownerLanguage`) and the UI asks for before its first render
  (`/api/language`). The UI strings are two tables of one shape in `src/ui/strings.ts`, so a
  missing English text is a type error; the English one calls the Koordinator the Coordinator; dates and numbers follow the language, in the browser's
  own variant of it (`en-GB` writes the day first; a variant `Intl` refuses, such as
  `en-US@posix` from a Linux browser with the POSIX locale, gives the usual one: until
  2026-10-07 the page stayed blank on it). Choosing another language takes effect at
  once: the page loads again, keeping what was open, as after a restart. Behind the interface the
  same setting decides: what the server writes into a card's log, the questions it puts to the
  owner and what it speaks are two tables of one shape in `src/core/messages.ts` (the Board's `t`,
  read when a line is written, which then stays in that language; the UI recognises the few lines
  it treats specially in either); the Koordinator's replies and spoken confirmations (its session
  starts afresh once the language changed), the voice that
  speaks (on a Mac a system voice of that language, `say`'s Anna or Samantha where the default
  voice speaks another; Piper's voice of that language elsewhere), and the language every prompt
  asks agents to write the owner in (`LANGUAGE_NAMES`), with examples in it where they shape the
  owner's text. A demo is narrated in it until the demo settings name a language. Prompts only
  agents read stay English with German examples of what the owner may say.
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
- **Lesestand** (`src/server/read-tree.ts`) — every repository of a canvas has a directory on its
  default branch that its plan docs are read from (the canvas, „Plandokument lesen“, the last state
  kept on a project) and that the agents that only read work in: project agents, ideas'
  exploration agents, the Koordinator (and its look-ups, learner and Rückschau), the Arbeitsrückschau
  and the voice commands' session. Where work lands on the local main (`land: 'main'`, Obeya), it
  is the configured checkout itself, which is always on `main`, uncommitted plan docs included.
  Otherwise the configured checkout is often one of the pool's clones and on the branch of the card
  that leased it last, so the Lesestand is a detached worktree of it under Obeya's home
  (`read/<canvas>/<repo>`), on the commit `repoAdapterFile` reads too (`defaultBranchCommit`: the
  local default branch where it has everything `origin`'s has, else `origin`'s). Branch switches,
  `reset` and `clean` in the clone do not reach it, and the clone's `git status` stays clean, so
  leasing is not affected; the clone's `.git/worktrees` has one entry more. A worktree there at
  the start is used again; one missing, broken or of another repository is made afresh (`git
  worktree prune` first), and where none can be made the checkout is read, as also while its
  directory cannot be removed (on Windows, while an agent works in it; until 2026-10-07 that
  ended the server); the next refresh tries again. Hooks do not run for
  it. It refreshes with every round of the PR watcher (2 minutes), so also when the owner comes
  back to the page, and right after a merge: `git fetch` of the default branch in the checkout
  (only `refs/remotes/origin/<branch>`, no `FETCH_HEAD`, so safe while a card leases the clone),
  and where the chosen commit moved, a forced detached checkout and a fresh read of the plan docs.
  A fetch that fails (offline, a lock held by a lease) goes to the log and is tried again next
  round; the Lesestand keeps its commit. What counts is what is on `origin` (or the local default
  branch of the checkout, where it has all of `origin`'s): a doc committed only in another clone,
  or only edited, does not show in such a repository. Workers, leasing, landing and the share
  commands stay in the checkout and the clones; `repoInfo` and the configuration are unchanged.
- **UI** — browser app, React + TypeScript. Custom canvas: camera with
  fly-to, unfold-in-place, semantic zoom, edge indicators, minimap, and a frosted top bar the
  canvas slides under. The bar keeps no hint line: `?` (or the round `?` button beside "Neue
  Aufgabe") shows the legend of mouse and keys as a box over the greyed page (`src/ui/help.tsx`),
  and Esc, `?` or a click beside it closes it. The logo (`src/ui/logo.tsx`: three cards in the colours of working, waiting
  and approved, "obeya" in Inter Bold as outlines) opens the bar, stands alone in the middle while
  the page loads, above "offline" when the server is gone, and is the favicon; `bun
  scripts/logo.tsx` writes it as the files in `src/ui/logo/`.
- **Groups on the canvas** (`src/ui/groups.tsx`, `src/ui/territory.ts`) — each group shows as a
  territory behind its cards: a soft, slightly glowing outline over a faint area in the group's
  colour, with a dotted line inside along the cards. Group colours appear only there and in the
  minimap, never on a card, so they do not compete with the states' colours. Zoomed far out, the
  groups' names stand pale over their territories. A territory is the contour of an energy field
  (Bubble Sets): the group's cards pull, near cards are linked so they share one territory (not
  across another card), and every other card pushes back; where two groups meet, the stronger
  holds the ground, which makes a card amid another group an island. Of the cards' pull only the
  strongest counts at each point, not their sum, and the narrow gap between two cards facing each
  other pulls like a card: summed, the edge bulged out over every gap. A card's pull is squeezed
  on a side that faces another card across a narrow gap, so the edge runs along the gap's middle
  the whole side long and turns round there: pushed back only near the other card, it hung down
  beside it as a tip at the corner. The browser computes it with
  `d3-contour`, each group on its own grid around its cards on one 16 px lattice, resamples each
  contour evenly and smooths it with a Gaussian (σ 20 px), so corners come out round and even
  rather than with the grid's facets and the kinks where territories meet, and computes a
  group's field again only when something within its reach moved, its contour only when its own
  or a neighbour's field changed; one that took longer than 8 ms makes the next wait, so a dragged
  card keeps the frame rate and its territory follows a little later. At rest nothing is computed
  and nothing moves. When cards change group, wherever the change comes from (the colour ring, the
  Koordinator, another page), a wave runs out from where it was assigned (else from the cards'
  middle), reaches the cards one after the other, and their territory springs out a little too far
  and settles; a light runs once along the new edge. Measured in headless Chrome on 100 cards in
  four groups that all overlap (2026-10-05): the first computation 21 ms, a move that changes all
  four 5 ms (median; 14 ms at most), dragging at 60 fps, nothing at rest.
  Assigning: Shift + drag on the canvas draws a lasso (without Shift it pans as before), a right
  click on a card takes that card (a workstream: its project); either opens a ring of colour balls
  at the pointer with the groups, "+" (a new group, named in place) and "∅" (none). Each group's
  name stands outside its ball, so all show at once, with how many of its cards are still to be done
  (not finished, archived or a dropped idea; a project counts by its workstreams): a group at 0 goes
  pale, a candidate for deleting. Behind the ring and the names the canvas steps back under a
  frosted halo that fades out at its edge, so they read on a busy canvas. Moving towards a ball or onto its name picks
  it, a click takes it, Escape closes the ring. The picked group's name carries a ×: it deletes the
  group (its cards, archived ones too, belong to none), and "Rückgängig" brings it back in its
  colour with the same cards. By voice, the Koordinator's `group`
  (cards into a group by name, a new name creates it), `ungroup` and `rename_group`; it sees each
  card's group and the canvas's groups. The API: `POST /api/c/<canvas>/groups` (name and first
  cards, a colour when one comes back; a name a group has already takes that group), `PATCH
  …/groups/<id>` (name), `DELETE …/groups/<id>` (returns the group and its cards), `POST
  …/assign` (cards and a group, `null` for none); the snapshot carries the groups, every card its
  group.
- **Agents** — Claude on the owner's subscription, no API billing, through the Agent SDK: it runs
  on the Claude Code login of the machine (tested without an API key: `apiKeySource: none`).
  From the checkout it runs the Claude Code binary the SDK brings for the platform (its optional
  package, 224 MB); the compiled binary carries none and runs the machine's own installation
  (`claude` on the `PATH`, else `~/.local/bin`, where the official installer puts it);
  `OBEYA_CLAUDE` names another. Both ran workers and the Koordinator in the binary on macOS,
  Windows and Linux on 2026-10-07 (the SDK 0.3.285 with its Claude Code 2.1.285, and the
  installed 2.1.292). Agents get
  Obeya's environment without the marks of a Claude Code session that may have started it
  (`CLAUDE_CODE_*`), but with `CLAUDE_CODE_OAUTH_TOKEN`, the login of a machine without a keychain.
  A worker is one SDK session per card with streaming input, the repo's own settings and
  CLAUDE.md, and permission mode `auto` (`--permission-mode`); after a restart it resumes by
  session id. A project agent is one read-only session per project (Read, Grep, Glob on the
  repository's Lesestand), resumed for each question, answering the owner's questions about the
  project and its workstreams one at a time. The SDK sits behind a
  small runtime interface, so the orchestration is tested against a fake. Two SDK hooks ride on
  every session: before a Bash call, the refusal of long foreground sleeps; after every tool call,
  what changed since the session's instructions were built (`AgentSpec.contextUpdate`) goes to the
  agent with that call's result. Workers and idea agents use it for the owner's preferences: a
  preference learned or changed while one runs reaches it once, at its next tool call, without a
  message or a new turn. A workstream's worker hears its project's new decisions the same way
  (those on its own card it heard as answers).
- **Workspaces** — per adapter. A pool of full clones leased by a card while it is worked on
  (for a repository whose tools break inside a worktree, or that runs its own app stack per clone),
  or a worktree per card (Obeya itself: any number in parallel), kept across stop and restart
  until the card's work has landed. Clones come from `--workspace <path>` or `--clones <n>`.
  For each repository that uses clones, the top bar shows the pool ("Workspaces", a dot per clone,
  filled while a card holds it, and "2 frei" or "alle belegt"); over it, the cards that hold one and
  how many wait for one. The snapshot carries the pools (`workspaces`): leases change only with a
  card, so they ride on its updates. Worktrees are never short, so a canvas of only those shows none.
- **Landing** — per adapter. `pr`: approval leaves the branch for the PR loop. `main`
  (Obeya): approval rebases the branch onto `main` and fast-forwards the Obeya checkout; the card
  is `live`. Commits that conflict one by one but not as a whole land squashed into one commit.
  Uncommitted work or a real conflict sends the card back to its worker with the approval kept:
  its next handover (no new demo needed) lands on its own. `pr` with `direct`: an approval "Direkt
  auf main" (`approve(card, { direct })`, refused with `noDirect` where the adapter lacks `direct`)
  lands in the card's clone or worktree instead of a PR (`pushToMain`): fetch, rebase onto
  `origin/<default>` (squash as above), `git push origin HEAD:<default>`, never forced. A push
  turned away because the default branch moved meanwhile is fetched, rebased and pushed once
  more; any other refusal (a protected branch, missing rights) stays with the owner (`landPush`),
  the card back in review. Conflicts and uncommitted work go back to the worker with the approval
  kept as above; since only a direct approval is held where work goes out as a PR, its next
  handover is pushed directly too. The Obeya checkout is left alone; the read tree is refreshed
  and plan docs the card adds are registered, as after a merge. The worker hears that its work is
  on main, as after a landing. The adapter's checks run before the handover as always; Obeya does
  not watch the CI on the default branch.
  Landing runs git without blocking the server (`gitAsync`): fetch, rebase and push take seconds
  over the network, in which the page, the workers and the other canvases go on being served
  (before, the whole server stood still until the push was through). Landings of one repository
  run one after the other, so two approvals at once do not race on its main; a card whose work is
  landing refuses another approval (`notReady`), and a restart of Obeya waits for it like for a
  worker in the middle of a turn. The approval's answer still waits for the
  landing, and its refusals (`landPush`, say) come back as before.
- **PR loop** — on approval (unless "Direkt auf main", see Landing) the worker hears that its work goes out as a pull request, opened the
  way the repository does it (its own skills and conventions, a description for readers who have
  not seen Obeya), and reports it with the tool `pr_opened(url)`. From then on it may push its
  branch, never merges, and ends its turn after each round instead of handing over again. Per
  repository a watcher polls every open PR through `gh` every two minutes (state, mergeability,
  checks, conversation and review comments, inline comments), and right away when the owner comes
  back to an Obeya page (it becomes visible or gets the focus; at most once in 15 seconds): the
  owner merges on GitHub and returns, and before, the card stood "in PR" for up to two minutes
  after the merge (a PR on 2026-10-02: merged 12:12:40, seen 12:14:12). The watcher sits behind a small forge interface
  (`src/server/forge.ts`) so the loop is tested against a fake. New comments, failed checks (once
  per check and commit) and a conflict (once per commit) go to the worker as a message, which says
  what happened and leaves the how to the repository's ways (say, a skill of its own
  that merges `main` instead of rebasing, replies on and resolves threads, and asks Greptile for a
  re-review after each push). Whatever the way, each review comment gets a reply in its own
  thread (what changed, or why not) and the thread is resolved unless the worker still wants the
  reviewer's answer; one summary comment for all is not enough. The owner's log gets a line for
  each event. Checked on a real PR (2026-10-02): all five Greptile threads got their own reply
  and were resolved before the re-review ping; a page opened earlier showed the ping but neither
  the replies nor the resolutions until reloaded. Comments by the PR's author
  (the worker replying in the owner's name) and by accounts the adapter names as noise (a deploy
  preview bot, say) are skipped; an app's inline comments come as `<name>[bot]`, its
  conversation comments as `<name>`, and the watcher reads both as `<name>`. While the owner is
  asked, news waits. Once nothing is left for the worker, the card needs the owner: "Bereit zum
  Mergen" (once in the log, on the card and folded) when GitHub sees nothing in the way
  (`mergeStateStatus` clean), every check has passed, every review thread is resolved, the worker
  is not in a turn, a reviewer who wrote has written since the PR's own changes last changed (the
  committer date of its newest commit that is not a merge: merging the base in brings changes
  reviewed there, mostly elsewhere in the code), and whoever the PR's author last asked for another look has answered since. A
  review bot often answers a re-review only by rewriting its summary (Greptile's new score, on a
  PR on 2026-10-02, with no new comment), so a rewrite counts as an answer; before, the watcher
  waited for new comments only and the card stood "in PR" with nothing left to do. A review older
  than the changes is about an older state: a PR (2026-10-02) went in on Greptile's 3/5 of its first
  commit, since the worker pushed its fixes, replied in the threads and resolved them, but asked for
  no new review, and a PR nobody asked about counted as reviewed. Now the worker hears, once per
  commit and when it is not in a turn, that its reviewers have not seen its latest push, and asks
  them the repository's way (its own skill, or a comment mentioning the bot); the message on new
  review comments already says to ask once pushed. A PR no reviewer wrote on waits for nobody. A
  ready PR whose reviewer's latest confidence is below 4/5 ("Confidence Score: 3/5" in Greptile's
  summary) Obeya does not merge: the card needs the owner ("Bereit zum Mergen · Review nur 3/5"),
  who merges on GitHub or tells the worker what is missing; a new review at 4/5 or better lets Obeya
  merge again. Once ready,
  Obeya merges the PR itself (`gh pr merge` with the method the repository allows, squash first, and
  `--match-head-commit`, so a push since is never merged unchecked) and the card is `live` (After
  landing, below) in the same round. Before, Obeya left the merge to the owner on GitHub, and a
  ready PR stood for days with the card saying only "Bereit zum Mergen" (one PR ready
  2026-10-03 was still open 2026-10-05). When GitHub refuses the merge (branch protection wanting a
  human approval, say), the card says why ("Obeya konnte nicht mergen: …") and needs the owner, who
  merges on GitHub; Obeya tries again each round, so it goes through once the reason is gone.
  Anything new for the worker takes the readiness back. The card shows the PR
  with its link, its checks (each linked to its run), a conflict and a ready PR Obeya could not merge;
  folded, it reads "PR #42 · 1 Check rot · Konflikt" or "PR #42 · Bereit zum Mergen". Below the checks it shows the review as last polled, oldest
  first: each round a reviewer left comments on the code in ("Runde 2 · greptile-apps · 3
  Anmerkungen, 1 offen"), each comment folded to its first line with whether its thread is
  resolved and how many replies it has, unfolded with the file, the comment and the replies (the
  PR author's as "Agent"); between the rounds the conversation (a reviewer's summary, the
  worker's requests for another round; a comment rewritten since, like Greptile's summary each
  round, stands where it was last changed). Review bots write HTML into their Markdown: badges keep
  their name (Greptile's "P1"), folded parts, code and diagrams go. Whether a thread is resolved
  and when a comment was last changed only GraphQL says, so the watcher asks that too. Checked against real pull requests (2026-10-01): `gh`
  reads their state, checks and comments.
- **After landing** — the worker is told its work is on main (or that its PR was merged) and may
  finish what remains, in its workspace, which stays at what landed until then (the card is `live`,
  "Agent erledigt den Rest"; notes reach it, "Anhalten" ends it). Ending a turn with nothing to wait
  for ends its session and removes worktree and branch (a clone is free again). When the landing
  changed Obeya's own running code, the worker is told Obeya restarts with it; what needs the new
  code waits through `after_restart`: the worker ends its turn, the restart goes ahead, and the
  resumed worker hears that Obeya now runs its change. A turn there that an error cut off (the API
  overloaded, say) does not count as done: like a turn that ends without a handover while the
  worker works, it is tried once more, and if that fails too the owner gets the reason as a question
  ("Nochmal versuchen", or "Anhalten" to end the card without the rest); the card's conversation
  shows a question asked while finishing like any other, not the worker at work. Before (until 2026-10),
  such a turn ended the card, and what remained after the landing was silently left undone. While a
  restart is due, the failed turn instead pauses for it, which resumes the worker, so that a second
  try does not hold up the restart. A turn there that the usage limit stopped is not done either: it
  waits for the limit as while the worker works (status line, not busy, told to go on after the
  reset), then the worker finishes what remained. Before, it too ended the card. On the canvas, a
  card finishing shows its status line as one at work does; before (until 2026-10), only the
  detail view showed it.
- **Self-update** — Obeya runs from a checkout that work lands on, so `live` must mean running
  (the compiled binary has no checkout and never restarts for new code).
  Without `--dev` the `obeya` process supervises the server: when the checkout its code comes from
  moves to commits that change code (not only docs, or the site for obeya.si in `site/` and its workflow in `.github/`), the server stops and starts again; when the
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
- **Stopping** — Ctrl-C or SIGTERM (with or without `--dev`) stops Obeya the way a restart goes,
  only nothing starts again: the workers in the middle of a turn are told Obeya is about to stop
  and pause at a safe point, and Obeya ends once none is (at most 15 minutes). The bar shows it
  ("Beenden wartet auf N Agenten", "Jetzt beenden"), and a second Ctrl-C ends it at once (the
  terminal's Ctrl-C reaches supervisor and server, and the supervisor passes it on: signals within
  a second count as one press). The sidecars (transcription, speech, narration voice) run in a
  process group of their own, so the terminal's Ctrl-C does not reach them: they keep working while
  Obeya waits, and Obeya ends them once it stops (on Windows, where a detached process would open
  a console window for every program it starts, the Python sidecars ignore Ctrl-C instead). A stop does not wait for the owner's video or dictation, since the
  owner asked for it; it turns a restart that waits into a stop. The next start resumes the
  workers it stopped like a restart does.
- **Koordinator** — read-only SDK turns on the Lesestand of the card's repository (the home
  repository's without a card), one decision at a time. Before a
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
  again — the owner can start it anyway. A card the Koordinator lets start while no workspace is
  free (all clones leased, or every free one with uncommitted changes) waits for one in its place in
  the queue, shown as "Wartet auf Workspace" with the reason, and starts by itself once one is
  free; cards queued after it count it as ahead of them. Clones only free up with a change of the
  board (stop, landing, a discarded prototype), so the Koordinator looks then; free clones found
  dirty are looked at again after a minute at the latest. Cards whose turn comes together go in the order they came
  to the Koordinator, the one waiting longest first. The owner sets the order where the waits leave
  it open (`src/core/queue.ts`): a waiting card moves one place earlier or later ("Früher",
  "Später" on the card, which says its place, and on its row in the Koordinator's queue) and swaps
  its place (`since`) with the card it passes. It does not pass a card it waits for or one waiting
  for it, nor one the Koordinator is judging, since that one's waits come from the cards ahead of
  it; nor does a card being judged move. Such a button stays grey and says why when clicked; at
  the head or the end of the queue it is off. The new order counts like the old one: who goes first
  once free, who gets a free workspace, and which cards count as ahead when one is judged again. On the canvas, a planned card and one waiting in the queue show a play button
  while the pointer is on them; it starts the card (the queued one anyway) without unfolding it. While the pointer is on a card,
  the waits around it show over every step, both ways (`src/ui/deps.ts`): the cards it waits for
  ("kommt zuerst"), those waiting for it ("wartet darauf"), each with a ring and an arrow from the
  card waited for to the card waiting. A project starts all its
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
  into 2–6 packages with disjoint files, or keeps it and says why. After whatever the owner says it decides whether a lasting preference
  was stated and proposes it as a rule (the card's log says „Schlägt vor: …“), for the preference
  memory or, when it is about a repository, for that repository's CLAUDE.md (for each repository
  of the canvas when it holds in all of them; one proposal each); "Merk dir: …" by
  voice records a rule outright, sorted the same way. What it learns from: answers, notes and feedback to
  workers; an idea's discussion; the conversation with it (a reply or look-up at once, with its
  reply; a command once its undo window has passed, unless its words reach the learner another
  way, as a note or an idea's discussion do); and the text the owner writes in a card, once they
  pause typing for a minute or act on the card, with the text it had before (a proposal's, a
  follow-up's). The learner reads an input with
  the card's text, what the owner said in the last three days (notes, feedback and answers to
  agents, ideas' discussions, the conversation with the Koordinator; at most 30), the agent's last
  message before it (taken when the input arrives, not when the learner's turn comes), the canvas's
  repositories, the active rules, the rules accepted for a CLAUDE.md, and the open and rejected
  proposals. Its prompt names the signals for a proposal: phrased
  generally ("immer", "nie", "ab jetzt"), a correction of how an agent works, a repetition of
  something said before; it makes at most one proposal per input. The
  Rückschau counts the owner's inputs: what the learner reads, and clicks without words in a card
  (start, approve, accept or dismiss a proposal, park, start anyway, …), a deleted card, a command
  taken back, a rule proposal decided on; a spoken command counts once, as what was said. The
  count and when the history begins are settings of the canvas, so they survive a restart. At
  20, after the learner has read the input that completed the count, one read-only session in the
  home repository's Lesestand reads what happened since the last Rückschau (at most the latest 300 lines): the
  cards' milestones (the owner's notes, answers and clicks, the agents' questions and hand-overs,
  answers given in the owner's name), the owner's words in ideas and to the Koordinator, taken back
  or not, the cards they deleted or dismissed, and the rule proposals they accepted or rejected.
  It looks for patterns seen at least twice on different cards and proposes up to three rules,
  each with a sentence on what it rests on and, like the learner, for the preferences or a
  repository's CLAUDE.md; the sheet shows that as their occasion („Aus der
  Rückschau: …“). Its
  sheet (button or `K`) gives the conversation with the Koordinator the height it has, with the
  field to write in under it; below that come sections that open and close, each a head with its
  count: the open proposals („Vorschläge (2)“, shown while there are any, open whenever a proposal
  came after the owner closed them), the queue (shown while a card waits, closed by default) and
  the preferences (always there, closed by default). Whether a section is open is kept per canvas
  in the browser, so a reload keeps it. What runs is not listed there: the canvas shows it. Open
  proposals come with their occasion (the card and the owner's words, or the
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
  to theirs, so several rules go in together. The card lands like any other (through a pull
  request where work lands that way); until then the rule applies to no agent, and afterwards through the CLAUDE.md alone. The Koordinator
  button counts open proposals (violet, beside the grey count of queued cards); they do not
  count among the cards that need the owner and do not show on cards.
- **Arbeitsrückschau** (`src/server/work-retro.ts`, `src/server/transcript.ts`) — Obeya looks back
  at how the workers worked, to make future runs cheaper: where a worker went wrong and corrected
  itself (a command with wrong flags, a script that failed and was rewritten, a long search for how
  to start something), above all the same detour on several cards. A feature of its own beside the
  Rückschau, with its parts (a read-only reading session, a count in the canvas's settings,
  proposals on the usual way), but a different source (the workers' transcripts, not the owner's
  words), beat (finished cards, not the owner's inputs), place (the repository of the friction, not
  the home repository) and result (feature cards, not rules). Two stages:
  - When a card's work ends (landed, closed without a change, a prototype discarded or built, or a
    card deleted with work not finished), Obeya draws an excerpt from the transcripts of its runs
    without a model. The Agent SDK keeps a session's transcript at
    `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, non-alphanumerics as „-“>/<session id>.jsonl`,
    after the workspace has gone too; Obeya looks there first and then in every directory, as the
    naming may change. A card's runs are its `session_id` and the earlier ones in its log: a start
    from scratch (and a session that replaces another) logs the session before as „Der frühere
    Lauf (Sitzung …) bleibt für die Arbeitsrückschau erhalten.“ The excerpt holds the failed tool
    calls with their error (start and end, about 800 characters), similar calls in a row (a failed
    one and its correction; a command three times or more), files written whole more than once,
    the worker's words before and after each, and how many tool calls the run took and after how
    many it first changed a file. Calls cut off by a restart (exit code 137) or stopped by the
    owner do not count; subagents' lines are left out. A missing file or a format it cannot read
    gives no excerpt and no error. A short read-only session in the repository's Lesestand (a small job, see Models
    and effort) makes 0–3 friction notes of a non-empty excerpt (what went wrong, what it cost,
    what would have prevented it), stored per repository and card in `friction`; an empty excerpt
    gets no session.
  - Every 10 finished cards of a repository (counted when work ends, whether or not they had
    friction; a card that never ran does not count; the setting `work_retro_cards:<repo>`), after
    the notes of the card that completed the count, the retrospective runs: one read-only session
    in that repository's Lesestand, so it sees its CLAUDE.md, scripts and skills, reads the notes
    since the last one (`work_retro_since:<repo>`) card by card, with the proposals of earlier
    retrospectives: those the owner dismissed, so it does not repeat them, and those waiting or
    taken. It proposes at most three things, each resting on friction on at least two cards (tags
    the tool checks): a feature card (a script, a skill, a fix to a tool) that waits as a proposal
    in a free spot, with a sentence on the cards it rests on (`retro` on the card, shown under the
    title as „Aus der Arbeitsrückschau: …“ and in its body), or a line for the repository's
    CLAUDE.md, which goes the way of the Rückschau's rules (a proposal for „CLAUDE.md von <repo>“,
    then the card „CLAUDE.md ergänzen“). Nothing is created silently and nothing starts by itself;
    skills of the user (`~/.claude/skills`) are out of scope. The owner can ask the Koordinator
    for it at once („Mach eine Arbeitsrückschau für den Shop“, the action `work_retro`): it reads the
    notes since the last one, the count starts again, and the owner hears what came of it.
- **Voice in** — push-to-talk (hold Space or the mic button); the browser records and posts the
  audio with the focus (open card, project in view). A Whisper sidecar keeps the model
  loaded and transcribes with the canvas's titles as vocabulary, in the language it hears spoken in
  the first 30 seconds of the ones Obeya speaks (German or English), not the interface's: the owner
  may run the interface in English and speak German, and Whisper told to expect English then
  translated into broken English, unsure of its words, so long dictations (more windows that can
  fail) ended in „not understood“ (6–8 Oct 2026). It runs mlx-whisper on Apple
  Silicon, faster-whisper elsewhere (CUDA when there is a GPU, falling back to the CPU when its
  libraries are missing; int8 on the CPU), large-v3-turbo on both, the recording decoded by ffmpeg
  (`OBEYA_WHISPER_PYTHON`, a Python with the package, else `uv` with the same kit the demos listen
  back with; `OBEYA_WHISPER_BACKEND` chooses the other backend). On a CPU large-v3-turbo in int8
  takes about 4 s for a spoken command on GitHub's 4-core Ubuntu runner and 12 s on its 4-core
  Windows Server runner (float32 took twice as long; `small` 1–2.5 s, but on Windows it heard
  „rechnen“ for „Rechnungen“), so it stays turbo for what it hears, and `OBEYA_WHISPER_MODEL` picks
  a smaller model where that is too slow (measured 2026-10-06). Checked on macOS, Ubuntu on ARM in
  Docker, and GitHub's Ubuntu x64 and Windows Server 2025 runners: the settings check, installing
  from it, a spoken command through `POST /voice` heard word for word, and the confirmation
  spoken by Piper (`src/server/voice.live.test.ts` with `OBEYA_LIVE_VOICE=<home>`). A recording without audible speech gives
  „Ich habe nichts gehört.“, one Whisper cannot make sense of „Das habe ich nicht verstanden.“; the
  Koordinator gets neither to guess from. How Whisper fails on such recordings (the titles talk it
  into loops, guesses or its words for silence) and how they are told apart is in
  `voice/whisper_sidecar.py` and `src/server/voice.ts`. The log has each recording's length and
  level next to the transcript. While the owner holds the key, a level that stays flat for 1.5 s
  shows „Das Mikrofon liefert keinen Ton.“ under the mic. The first press after a page load opens
  the microphone (about 0.2–0.3 s); let go before it is open, nothing is recorded (rather than a
  recording that runs on unheld) and the owner hears „Das Mikrofon war noch nicht bereit“. The
  microphone is not opened on page load: in the log of 1–5 Oct 2026 (22 page loads with a recording
  after them) the first recording after a load failed no more often than later ones, and opening it
  early would keep the browser's microphone indicator on all the time. A Koordinator turn reads
  the transcript as speech that may be misheard (typed words as written) and either acts or replies. Acting takes one or
  more actions from one sentence, up to 20 (new card, new idea, start, taking a card out of the queue, note, answer, feedback,
  approve, accept, dismiss, revise, cut, stop, remember, Arbeitsrückschau, putting cards into a group or out of it, renaming a group; on ideas: discuss, build, plan doc, prototype,
  park, drop; on prototypes: build on it, discard),
  checked against the cards' states in the turn, so an action that does not fit (a note to a card no agent
  works on) goes back to the Koordinator, which may reply instead. A new card, a follow-up too,
  starts at once, through the Koordinator like "Agent starten" (checked for conflicts, queued if
  need be), unless the owner says it should wait („nur notieren“, „für später“, „noch nicht
  starten“): then it stays planned. Left to its own judgement, the Koordinator kept about one in
  five plainly asked-for tasks planned („Tipjar should split the bill …“), so the `start` field of
  `new_card` says this outright, and left out it counts as starting. Start on a card queued behind
  others starts it now despite the likely conflict, like "Trotzdem starten"; it sees which cards a queued
  one waits for, so "starte alle wartenden Aufgaben" works; "nimm sie aus der Warteschlange" takes a
  queued card back to planned, like "Aus der Warteschlange nehmen". A reply answers questions too
  ("Was ist seit gestern passiert?"), as far as the cards and their history answer them.
  "Merk dir: …" ("ab jetzt immer …") is remember, with the open card as its occasion, once the undo
  window has passed. A rule on how agents work with the owner through Obeya becomes one of the
  owner's, active at once; one about a repository („Merk dir: im Shop immer …“) goes, like a learned
  one, into the card „CLAUDE.md ergänzen“ of the repositories it names (`repos`), without a
  proposal, since the owner said it. The confirmation says which of the two it went to. It may name
  the rule it changes, which then takes the new text, or, moved into a CLAUDE.md, goes. The
  Koordinator always sees the canvas's repositories, one included. The Koordinator gets the owner's rules, numbered, with every command,
  and follows them itself too.
  With a card open, the Koordinator gets its worker's whole summary, so "lege eine Folgeaufgabe
  für den ambient-Ton an" makes a follow-up of that card with what the summary says about it. One confirmation covers all actions; they run in order a few
  seconds after it reached the owner, so "Rückgängig" takes back anything, even an approval. Only
  talking to an idea goes on at once: it changes nothing, and said to the open idea it needs no
  confirmation, since the conversation shows it. With a proposal open, what the owner says about it is,
  in doubt, a revision (`revise`, with their words and the undo window); accepting in the same
  breath is refused, since the owner should see what they take. The same holds for a note or an answer to the
  agent of the open card, alone in what the owner said: it goes out at once and quietly, and the
  card's conversation shows it under „Du“. Feedback on work waiting for review keeps the confirmation and
  the undo window, as does every command to Obeya. With an agent on the open card (working, in a
  pull request, waiting, waiting for review, or finishing what remains), what the owner says is, in doubt, for that
  agent: note, answer or feedback, in the owner's own words (a single such action carries the
  whole transcript, whatever the Koordinator wrote), and spoken words reach it with the remark
  that speech recognition may have misheard them. Only what clearly asks Obeya for something
  (approve, stop, start, a follow-up, remember, grouping cards, an action on another card, a question about the
  canvas) goes elsewhere; `commands.live.test.ts` checks this against the real model
  (`OBEYA_LIVE=1`). Typing goes the same way as speaking: the Koordinator's sheet, and the fields
  on a card (note, answer, feedback, an idea's conversation, a proposal's revision) post to the Koordinator, which learns
  that the words are typed and in which field; only clicks on answer options go straight to the
  agent. What the owner said and the Koordinator's confirmation go into the conversation of
  the card that was open (the confirmation folded away, and the words once when they became a note or an answer), and "Zurückgenommen." when taken back; with no card open, the sheet
  shows the conversation, newest last, in all the height the sheet has; an open section below
  takes from it down to 200px, and below that the sheet scrolls. Talk to an open idea is the exception: its conversation already holds it.
- **Looked-up questions** — a question that needs reading ("Was würde der Agent hier machen, wenn
  ich starte?", what the plan says, how something works) the quick turn does not answer: it
  acknowledges it ("Ich schaue im Plan nach.") and passes it on. A question about a project or one
  of its workstreams goes to the project agent, in the project's session; any other to a thorough
  read-only Koordinator turn on the card's repository. A question about the work of
  an agent on a card (also one waiting for review: „Ist sichergestellt, dass …?“) is not looked up
  but goes to that agent, as a note or as feedback: its work is on its branch, not in the Lesestand
  the look-up reads, and the card shows the agent at work while it answers. `look_up` on such a
  card is refused with that hint. Both get the question, the
  card's state and log, and the task its worker gets at the start (`Workers.startBrief`), from
  which, the plan doc and the repository's instructions they derive the worker's steps. The answer
  comes 10–30 s later: spoken in short wherever the owner is, in full in the log of the card that
  was open, else in the Koordinator's sheet; what the agent reads shows on the open card meanwhile.
  The Koordinator hears the answer with the next command, and it is part of its stored memory. A
  question still open at a restart is looked up again.
- **Commands on their way** — after letting go of Space the microphone is free at once, and the
  owner may navigate or speak again: the target is fixed when the key goes down. Each recording,
  and each typed command while the Koordinator reads it, has its own small line above the
  microphone („„Export“ · wird verstanden …“), which becomes its confirmation with „Rückgängig“,
  or disappears when it went out quietly. Several stack, oldest first, and the server reads them
  one after the other. A confirmation that arrives while another card is open starts with the card
  it is about.
- **Voice latency** — pressing Space (or focusing a typed command's field) gets everything ready while
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
  approval. Under the mic, and under a card's text field, the UI names who listens: the agent when
  one works on the open card ("Agent · Aufgabe: …"), else the Koordinator and the card, idea or
  project in focus ("Koordinator · Aufgabe: …"). Card tags
  (`K1`, …) stay fixed for the session. Each command brings the cards as they are now and what
  happened since the previous one (state changes, questions, answers, hand-overs, the owner's
  notes, errors, new cards; not the workers' steps); a command the owner took back is told with the
  next. Every exchange is stored (`talk`). A session that fails while reading a command (an error
result, which the SDK also reports as a `success` with `is_error`) is replaced by a fresh one for
the same command; should that fail too, the owner hears the reason („Ich konnte das nicht lesen.
Claude ist auf diesem Rechner nicht angemeldet: …“), not „nicht verstanden“. A session is not resumed: after a restart, and after 30
  commands so the context stays short, a fresh one starts from memory: the last 20 exchanges and
  the canvas's last 14 days (at most 60 steps), with times.
- **Voice out** — a voice on the server speaks the confirmation, which the browser plays. On a Mac
  the default system voice, or one of the owner's language where it speaks another: a JXA sidecar
  keeps the macOS synthesizer loaded (about half a second a sentence), with `say` as the fallback.
  Elsewhere Piper (the demos' default voice of the owner's language, `de_DE-thorsten-high` or
  `en_US-ryan-high`, and the same installation under `voices/` in Obeya's home): a sidecar in Piper's
  environment keeps the voice loaded (`voice/piper_sidecar.py`); without Piper nothing is spoken.
  `OBEYA_SPEECH=piper` takes Piper on a Mac too. The settings sheet's section "Spracheingabe und -ausgabe" ("Voice") checks
  what voice in and out need on this machine (`src/server/voice-setup.ts`): Whisper (the package
  in uv's cache or the given Python, the model in the Hugging Face cache), ffmpeg, uv, and the
  voice, each missing piece with how to install it here, as for demos. "Installieren" installs
  Piper and loads Whisper, which fetches it the first time (about 1.9 GB), so the first command
  does not wait for the download. The server lets a request run 120 s idle instead of Bun's 10 s:
  a command answers once it is transcribed and read, which on a busy CPU took longer. While a demo video plays nothing is said (the owner often gives a command and
  turns to the next demo), nor while the owner holds the microphone; a video that starts or a press
  of the microphone cuts off what is being said. The written confirmation still shows.
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
  narration language (German or English: narration, captions, Whisper, the report page's words;
  without one, the language Obeya speaks to the owner)
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
  install it. The sheet also plays a sentence in the voice being chosen ("Anhören"). A voice that
  can stay loaded says so in its spec (`serve`, so far only Qwen3-TTS: `qwen3.py --serve`): `tts.py`
  starts it once per render (and once per "Anhören"), on the first clip that is not cached, and
  asks it clip by clip and take by take over its stdin and stdout, one JSON line each way (text,
  WAV, language; a ready line once the model is loaded, then `ok` or `error` per clip). Model,
  reference and transcript load once instead of per clip and take: three clips with a clone, no
  cache, listening back with Whisper, went from 25.8 s to 15.8 s on an Apple Silicon Mac (a warm
  start with the model costs about 2 s, about 4 s beside a loaded Whisper, a cold one 17 s;
  synthesis about 2–4 s per clip either way; measured 2026-10-05). The libraries print on stdout too, so
  the server moves fd 1 to stderr and keeps a duplicate of it for the protocol alone; a line that
  is not the protocol is shown and skipped. A voice that dies stops the render with the tail of
  its stderr instead of hanging. Piper, `say` and the owner's command still run once per clip.
  Under Obeya the Qwen3 voice lives longer than a render: Obeya holds it as a child process of
  its server (`src/server/narration.ts`), since the server runs all along and on every platform.
  The spec says which voice Obeya may hold (`host`: the reference clip or the stock speaker; the
  server builds the command itself from that, never takes one from a request), and Obeya sets
  `OBEYA_URL` (`http://127.0.0.1:<port>`) for its workers and for the settings sheet's sample.
  `tts.py` then sends each clip to `POST /api/narration/clip` (`{voice, text, out, language}`,
  JSON only, so a page elsewhere cannot send one without asking first; `out` an absolute
  `.wav`) and gets `ok` with the seconds or `error` back. The clips of all renders wait in one
  queue and are served one at a time; each render asks for its next clip only once the last is
  done, so parallel renders take turns clip by clip (throughput stays that of one GPU). The
  voice starts with the first clip and runs on for 5 minutes after the queue empties
  (`NARRATION_IDLE_MS`), then its stdin ends; a clip for another voice (reference, speaker or
  language) ends it at once, and Obeya's shutdown kills it. Between server and voice runs the
  line protocol above, unchanged. What it saves is a model load per render or "Anhören" within
  those 5 minutes: about 2 s warm, 17 s cold, at the cost of 3–4 GB held meanwhile. Without
  `OBEYA_URL`, or when Obeya does not answer (not running, restarting, an older Obeya without the
  endpoint), `tts.py` loads the voice itself as before. One large model per render at a time on
  the machine (Qwen3-TTS, the owner's command; with Whisper 7–12 GB each, and parallel demos had
  swapped the machine to a halt): `tts.py --lock ~/.cache/demo-skill/tts.lock` takes the file's
  lock before the process loads such a model itself and holds it to its end (`flock`, on Windows
  a byte-range lock through `msvcrt`; it works beside an older `lockf -k` on the same file). A
  voice it runs itself takes it at once. A voice Obeya holds takes it only to load Whisper, and
  `tts.py` synthesises the first take of every clip before it hears any: parallel renders
  synthesise turn by turn through Obeya, then listen back one after the other, with one voice
  model and one Whisper in memory; retakes go through Obeya while the lock is held. Without
  listening back such a render takes no lock at all. The owner's clone is Obeya's Qwen3 voice
  with the reference clip of the owner's voice project (Stimmzwilling,
  `data/voice/derived/reference4_A.wav` with its transcript), so Obeya holds it across renders;
  it never leaves the machine. Voices are not labelled as generated, a clone included: the whole demo is generated,
  and that is clear from where it is shown. The person follows from "Das ist meine eigene
  Stimme" in the settings: the first person only in the owner's own voice, otherwise the
  narration presents the work without "I". `node lib/settings.ts` prints what applies, for the
  agent writing the narration; `DEMO_VOICE` overrides the voice for one render (another provider,
  never the owner's own, or a `.wav` that Qwen3-TTS clones). Settings from before the providers
  carry over: `gemini` keeps its key file, `clone` becomes the owner's own command, still to be
  written. What a render needs on the machine is checked by `lib/setup.ts`: Node 22.18 or newer
  (TypeScript without flags), Playwright and a browser (found where Playwright looks), ffmpeg
  with libx264, uv (which brings Python), the voice, and Whisper (in uv's cache and the Hugging
  Face cache, else fetched by the first render, about 1.6 GB: not missing, only later). Each
  missing piece comes with how to install it on this platform (Homebrew, winget, the Linux
  family's package manager from `/etc/os-release`, else a page). The settings sheet shows the
  check below the demo settings ("Was Demos auf diesem Rechner brauchen", the voice left out
  since it has its own lines), again when listening back is switched, after an installation and
  on "Erneut prüfen"; the parts a voice still lacks are named in the narration language ("Piper
  voice en_US-ryan-high" for an English one, German until 2026-10-07); a render runs it before anything else and stops with the whole list
  (`--narration` leaves out the browser); `node lib/setup.ts` prints it for an agent, which
  installs a voice itself but asks the owner for system software. The guide for setting up a
  machine is `docs/demo-setup.md`. Not tried yet (2026-10-05): Edge as the fallback, a voice
  command through `cmd.exe`, Qwen3-TTS through PyTorch (no machine with a GPU); Obeya itself on
  Windows is a separate, larger question. How to run each project's app
  for a demo is the adapter's `demo.howToRun` (say, the app stack, login, test data, migrations;
  Obeya: the scratch instance); without Obeya, `bun lib/recipe.ts` in a repository prints it. The
  worker records once the change is committed and checked, as the adapter says how to run the
  app (Obeya: a scratch instance from the worktree, staged by `scripts/scratch-obeya.ts` from a
  stage file before every take, its workers idle (`--idle-workers`) unless the change is about
  agents; elsewhere, say, the clone's own app stack), and hands over the directory and chapter titles with `ready_for_review`.
  Before the first render it runs `node demo.ts --dry`: `login`, `open` and the scenes against the
  app, without narration, setup check, screencast or ffmpeg (`untilSpoken` does not wait), under
  the same per-demo lock as a render. Twice a scene waited for a state that never came and showed
  it only in the full render, after synthesis and the scenes before it. A failing step names the
  page's URL, the screenshot and Playwright's message on lines of their own: a worker once took
  the screenshot's path, the only path in the message, for the page's address.
  Waiting is cut out of the video: a demo of real agents had half a minute of a canvas where
  nothing happened. The scene wraps such a wait in `d.skip`; the page fades to white, the cut falls
  while it is white, and it fades back in with how much later it is ("31 Sekunden später"), about
  two seconds in all. The cuts come out of the frames, the narration offsets, the chapters and
  the captions alike (`lib/timeline.ts`); a narration clip the cut falls into goes on across it,
  so a skip belongs after the scene's narration, and the next scene says the jump ("Kurz darauf").
  A wait under five seconds stays in the video: the flash for "2 Sekunden später" disturbed more
  than the wait. `skip` therefore fades only once the wait has run five seconds; those first
  seconds are cut without a trace (the picture rarely changes in them), the rest falls into the white.
  The review table flags a scene with more than 5 s without narration.
  Obeya takes the chapter times from the captions and serves the video, poster and captions of
  the card's demo (range requests). The card shows it on the left, the
  conversation with the field for feedback beside it and approve below both; feedback asks for a new render. When the result is something to look at
  rather than something that happens, the worker makes an HTML artifact instead (`kind: 'html'`):
  a directory with an `index.html` and the files it loads, handed over the same way. The
  card shows the page in a frame where the video would be (no chapters); Obeya serves any file of
  that directory, none outside it, with a CSP sandbox and the frame's `sandbox`, so the page's
  scripts run in an origin of their own, away from Obeya's API. Its `index.html` comes with the
  height report a shared artifact's page has (below), so the frame grows to the page and only the
  card's left column scrolls; before (2026-10-08) the frame scrolled inside that column, two
  scrollbars side by side. The frame's height is the reported one, rounded up, plus its border (and
  the report counts a scrollbar across the page's foot), and once the page has reported, the frame
  does not scroll (up to its cap of 30,000 px): before, the page came out a few pixels higher than
  the frame, or a page whose images grow with its width fitted only beside a scrollbar, and the
  frame kept a bar of its own that scrolled by a few pixels. A handover with `no_demo` (the
  reason) instead is the exception the worker's brief names as such: the card waits for review
  with the buttons on top and the summary and the reason as the handover in its conversation, and a demo from an earlier handover leaves the card, since it
  showed other work. Artifacts stay in `~/demos/`, never in git; a pull request links a demo
  only once it is shared (below).
- **Sharing a demo** — every demo, video or HTML artifact, has "Teilen" beside it, on waiting cards
  and on cards long done (archived ones too); prototypes are not shared. HTML artifacts are shared
  since 2026-10-05: an analysis with charts is background for a pull request as much as a video.
  Their page has the same title and text above the artifact, which sits in a sandboxed frame (its
  scripts reach neither the page nor the site); the copy of its `index.html` beside the page tells
  the page its height (`postMessage`), so the frame grows to it instead of scrolling inside the
  page, at most 30 steps (an artifact as high as its window would grow on), and "In eigenem
  Fenster öffnen" shows it alone. Where it goes depends on
  the repository's share target: the command line in its configuration (`share`, see
  Configuration), else the command its adapter names (`demo.share`). With a target, the
  demo is published on a page. "Teilen" publishes right away, without a hold to take it back:
  "Nicht mehr teilen" withdraws the page just as easily (until 2026-10-02 it held 8 s with "Doch
  nicht"). Once the page is up, the card shows the link (open, copy) and "Nicht mehr teilen". A
  card that gets a new demo after sharing says the page still shows the earlier one and offers "Neu teilen"; nothing is replaced on its own. The page has a title and two to five
  sentences for colleagues who have never seen Obeya: where the repository has a target, `ready_for_review`
  takes them with every demo (`demo.page`), and for a demo handed over before that a short
  read-only session writes them from the worker's last summary when the owner shares, kept with
  the demo afterwards. Obeya runs the command (`src/server/share.ts`) with `OBEYA_HOME` set and
  the repository's checkout in `OBEYA_REPO`, one call at a time, in `share/` under Obeya's home:
  until 2026-10-05 it ran in the checkout, which is often a workspace of the pool too, and the
  cache `wrangler pages deploy` leaves in its working directory kept that workspace from being
  leased after every share ("jeder freie hat nicht committete Änderungen"). The calls are
  `publish` with the page as JSON on stdin (slug, kind
  `video` or `html`, title, text, chapters, PR URL, the demo's language, demo directory, and the
  slugs of the other pages it has shared), which prints the page's URL; `withdraw <slug>`; and `version`, which prints
  the version of the pages the command writes (a command that does not know it fails or prints
  nothing): the video pages' first, then `html:<version>` for artifact pages, so a change to one
  kind of page marks only those (a command that says one version marks both). The slug comes from the card's title and id once and
  stays, so a link keeps working across publishing again. The command's stderr goes into the
  card's log, a failure with its output as an error, and the card stays as it was. A share held,
  publishing or withdrawing at a restart goes on after it.
  Obeya keeps with each share the version the command said right after publishing it, and asks
  each command with pages out for its version at startup (Obeya restarts when its own code changes),
  after each of its calls, and when the owner comes back to a page of
  the canvas (at most once a minute: a command from another repository changes without a restart). A page published with another version, or
  before commands said theirs (until 2026-10-05), shows that pages are made differently now and
  offers "Erneut teilen" beside "Nicht mehr teilen": the same demo published again under the same
  link. A card with a newer demo offers only "Neu teilen", which brings both. Each page is brought
  up to date on its own card: the first share command wrote every page afresh with each call until
  2026-10-05, which updated all of them unseen and would take long with hundreds of pages. A
  command may print a hash of a sample page as its code writes it: only a change that shows on the
  pages counts. Many at once go from the Koordinator's sheet: while pages are outdated, a purple
  entry says how many („N geteilte Demos sind veraltet“, archived cards' included) and shares
  again the newest 20 of them (or 10, 50, 100, all), newest by the demo's video file. They go out
  one after the other through the same queue as every share, each published as it shows (what
  the share kept, so a newer demo on the card still waits for "Neu teilen"), and a share the owner
  starts meanwhile goes out between two of them. The entry shows how many are out, the one going
  now, and the failed ones with their cards (the reason is in each card's log, the page stays
  outdated); "Anhalten" lets the page going out finish and leaves the rest. The result stays until
  "Ausblenden". The run is kept (setting `reshare`), so it goes on after a restart; a page shared
  again on its own meanwhile, withdrawn or deleted drops out of it. It is not counted on the
  Koordinator button: the cards offer "Erneut teilen" each, and nothing is lost by leaving them.
  A page published again with the same video keeps its date („Geteilt am“) on a site that shows it, so the
  overview keeps its order when pages are brought up to date or get their PR's link; a new video
  dates it anew.
  The pull request and the page link each other. A demo shared before approval goes into the
  worker's approval message with "link it in the description". Once a PR exists and the page is
  out (in either order: `pr_opened` after sharing, or sharing a card whose PR is open or merged),
  Obeya reads the description through the forge (`gh pr view --json body`) and, unless it
  contains the page's URL already, adds a line `Demo-Video: <url> <!-- obeya:demo -->`
  (`Demo-Seite:` for an artifact)
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
  file still goes by mail), the button says so for larger ones. An artifact goes into the ZIP in
  `artifact/` beside the page; into one HTML file (as the frame's `srcdoc`) only when it is its
  `index.html` alone, which the handover notes (`single`), else the button says it goes as a ZIP. Nothing leaves Obeya, so an export
  is not held; the card's log names the file. Both pages carry their captions as cues in a script,
  since Chrome does not load a `<track>` for a page opened from disk. The page (`src/server/demo-page.ts`)
  is the one a share command publishes (the adapter kit, `src/adapters/kit.ts`, hands it to
  the command), without its link to the overview. Its own words (the date line, the captions' name, the
  links, the play button) are in the demo's language: the one the demo's `index.html` names (the
  director writes the report page in the narration language; an artifact names its own), else the
  narration language of the demo settings. Until 2026-10-07 the page was German throughout, an
  English demo's too; a share command that passes no language still gets the German page. Its video waits with a big play
  button over it until it first plays: a click anywhere on the video but its controls starts it,
  rather than the small button in the corner. It does not start on its own: browsers play sound
  only after a click on the page (in Obeya, the click that opens the card), so it could only start
  muted, which the owner did not want. A share command from the
  configuration runs like the adapter's; its words are split at spaces outside quotes, a program
  given as a path and any script are found in the repository (what the command itself needs from
  there it finds through `OBEYA_REPO`), and a script (`.ts`, `.js`) runs
  with Obeya's own Bun, so the same line works on Windows. The ZIP is written by Obeya
  (`src/server/zip.ts`, stored without compression: the video is compressed already).
  A repository's own share command (in its `.obeya/adapter/`, see Repo adapter) cannot import
  Obeya's files by a relative path: Obeya runs it with `OBEYA_KIT` beside `OBEYA_HOME`, the path
  of `src/adapters/kit.ts` (in the compiled binary, `kit.js` among its resources), from which it
  imports the page templates, so its pages are the export's.
  A command that publishes to a static host keeps its site in a directory of its own under Obeya's
  home and deploys all of it with each call; the first one (2026-10-02, moved into its repository
  on 2026-10-05) writes its own page and the overview, refuses files over the host's limit and a
  site that lacks a page Obeya has as shared (a lost directory would take them offline), and puts
  the directory back when a deployment fails. Such a host may serve no byte ranges (Cloudflare
  Pages answers a range request with the whole file and 200), and a browser cannot seek in a video
  streamed that way: the chapters and the progress bar jumped back to the start. The page
  therefore asks for a range first and, getting the whole file, plays the video from memory.
- **Repo adapter** — how to start and refresh the stack, where the frontend URL comes from, the
  recipe for running the app in a demo (login, test data, migrations: `demo.howToRun`), where plan
  docs live, which reviews run, the command that shares demos (the
  configuration's takes its place). A repository carries its own adapter in `.obeya/adapter/`
  (`index.ts` and what it needs beside it), like `.vscode/` or `.claude/`: whoever runs Obeya on a
  clone gets it, and it is versioned and reviewed with the code it describes. Obeya picks a
  repository's adapter in this order (`src/adapters/index.ts`): the one the configuration names
  (`adapter`: a built-in one's name, or the path of a module, relative to the repository), the
  repository's own, the first built-in one that matches (`obeya` by its `origin`, else
  `generic`). The repository's own comes from its default branch, not the checkout: the clones a
  canvas works in are on cards' branches, and one from before the adapter changed (or came) would
  have another one or none. The default branch is the local one where it has all of `origin`'s,
  else `origin`'s as last fetched. Its files are written once per version (the git tree's id)
  into the repository's git directory, `.git/obeya/adapter-<tree>/`, out of reach of checkouts and
  `git clean`, and an earlier version's go; a change to the adapter takes effect when Obeya next
  resolves the canvas (a start, a saved configuration). The module's default export is the adapter
  or a function that makes it from Obeya's helpers (`kit`: the generic adapter, the demo page
  templates, `esc`, `day`), so it imports nothing of Obeya's; Obeya loads it with `require` and
  fills what it leaves out from the generic adapter. An adapter that does not load is a
  configuration problem at the repository ("Diesen Adapter gibt es nicht, oder sein Modul lädt
  nicht."). Until 2026-10-05 every adapter lived in this repository, a project's included.

## Data

Persistent (SQLite): canvases, cards (kind, state, position, parent; agent session, workspace,
branch, status line, open question or review summary (with the reason when there is no demo), the card it came from (a proposal's
source, a follow-up's card), estimated scope, queue,
when archived, the pull request (link, checks, the comments, failed checks and conflict already
passed on), an idea's status, brief and open questions with its agent's picks and suggested next step, a prototype's idea, how it ended and its worker's proposal to build on it, the prototype an idea is built on, landed work whose worker still
finishes; a project's plan doc as last read and the idea it came from; the plan docs an idea's landed
work added; the shared demo page: slug, link, the demo directory it shows, the version of the
share command it was published with and whether that is behind, and whether it is publishing or
withdrawing; sharing many outdated pages again: the cards still to go, how many are out and which failed),
card events (the log, with an error code where the UI words it and the owner's screenshots), a card's own
screenshots, workspaces and their leases,
decision log, preferences, the Koordinator's conversation with the owner (what was said, its
reply, the screenshots that came with it, the open card, whether it was taken back; a looked-up
question, the card it is about, its answer and who gave it), groups (name, colour) and the group of each card, per-canvas settings (the home repository; the Rückschau's count and when its history begins; per repository the Arbeitsrückschau's count and when it last ran), the friction noted on each card's runs (per repository), and on a card the Arbeitsrückschau proposed what it rests on.

Files under `~/.obeya/`: the owner's screenshots (`images/<canvas>/`), the configuration
(`canvases.json`), and what a repository's share command keeps there (a demo site, its
credentials), with `share/`, the directory share commands run in.

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
- Approval covers the PR, its monitoring and the merge (2026-10-05): the owner approves the demo,
  not the code, so a second click on GitHub once checks and review are through added nothing but
  waiting. At first Obeya left the merge to the owner.
- The worker opens and tends its PR the way the repository does it, rather than Obeya scripting
  the steps (2026-10-01): Obeya's first version told it to rebase and push with
  `--force-with-lease`, while the first repository it opened PRs in merges `main` into a PR branch,
  never force-pushes, and has its own skill for review comments. Obeya says what happened on the
  PR, the repository says how to answer it.
- Spoken output uses the macOS default voice (synthesizer sidecar, `say` as fallback).
- Obeya itself is developed without branches or PRs: approved work lands directly on `main`.
- A repository whose work goes out as pull requests may let the owner push a card's work straight
  onto its default branch instead, chosen per card at the approval, by button or voice
  (2026-10-06): an approval "mit direktem Commit auf main ohne Pull Request" had opened a PR
  anyway, since approval took no parameter and the spoken "ohne PR" was lost. Whether a repository
  allows it is its adapter's `direct`, off by default; there is no rule by path. Obeya pushes, not
  the worker, and only fast-forwards. A card already in its PR does not switch.
- Work without a change to the code ends in a state of its own, `done` ("Erledigt"), not `live`
  (2026-10-02): nothing went live. Whether there is anything to land Obeya reads from the
  workspace on approval, rather than from the worker's word; the worker's `close_unchanged` only
  covers work whose branch emptied after the approval. The owner still approves such work: its
  demo or summary is the result.
- Learned rules are proposals the owner accepts first, rather than stored silently as at first
  (2026-10-02): the owner wants to see every learned rule before it applies. Open proposals count
  on the Koordinator button only, not among the cards that need the owner nor on the cards. The
  Rückschau runs after about 20 inputs, neither daily nor only on request.
- The Arbeitsrückschau learns from the workers' transcripts, in two stages (2026-10-05): an excerpt
  drawn without a model when a card's work ends, made into a few friction notes, and a
  retrospective over the notes of about ten cards in the repository's checkout. Rejected: building
  it into the Rückschau (the card log's tool lines have no results, and source, beat, place and
  result all differ), the worker reporting its own detours at the hand-over (patchy, and it makes
  every hand-over longer), and raw transcripts in the retrospective (far too much context). It
  runs on its beat and on the owner's word; its results are proposals in the repository of the
  friction, never cards created or started silently.
- Preferences hold only how agents work with the owner through Obeya; rules about a repository,
  taste in code that holds in every repository included, go into its CLAUDE.md (2026-10-02). At
  first the learner drew no line, and repository facts landed among the preferences, unversioned
  and unseen by colleagues and by Claude Code outside Obeya. Rejected: not learning repository
  rules (what the owner says would be lost), preferences scoped to a repository in the database
  (unversioned, invisible outside Obeya), the Koordinator committing to the CLAUDE.md on accept (it
  only reads, and where work lands through PRs nothing goes to `main` directly). Accepted ones collect in one card per
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
- A workstream card's state: work in progress (`working`, `waiting`, `inPr`, `approved`) wins over
  the doc, so a workstream ticked off on its branch still waits for its merge; then a ticked-off
  workstream is `live`; otherwise the stored state counts (`done`, `planned`), and without one the
  doc's. Stored `live` means its work landed, and holds only until the Lesestand has what landed
  (2026-10-06): a card keeps the commit it landed with (`shipped`: the commit on main after a
  direct landing, the merge commit GitHub names for a pull request, else the Lesestand's commit
  after the first fetch following the merge). When the plan docs are read again and the Lesestand
  has that commit while the workstream is still unchecked, only a part of it is done: the card is
  stored as `planned` again, with the line „Teil gelandet, im Plan-Doc weiter offen.“ in its log,
  and shows „Teil gelandet · PR #821“ (or the commit). Its log and handover stay; its pull request
  moves into `shipped`, and its branch goes, so a new run starts on a fresh branch from main and
  hears what landed. Cards that landed before the commit was kept count as landed in the Lesestand.
  A worker still finishing after the landing keeps its card live until it is done. `done` (finished
  without a change) stays: without a commit the doc has nothing to say about it. Until then a
  stored `live` or `done` beat an empty box: that came from the time plan docs were read from a
  pool clone's working tree, where the doc was often behind; it hid a workstream the doc kept open
  on purpose (configuration landed, commissioning waiting for the plant) as `live`. Rejected: the
  worker reporting "only a part" at the handover (a second source beside the doc that can
  contradict it), and a "Wieder öffnen" button (the problem shows only when someone asks).
- The owner reads a plan doc where the project is: "Plandokument lesen" in the project's sheet
  widens it and shows the doc as written, rendered, kept current with the file; a workstream's
  card opens it at the workstream's item. Esc goes back to the workstreams. The server hands out
  only docs it shows as projects, by project card, never a path.
- The sheets on the right (Koordinator, archive, configuration, a project's) are as wide as the
  owner drags their left edge: one width for all of them, and one for reading a plan doc, which
  follows the window until dragged. The browser remembers both; the canvas keeps 240 px beside the
  sheet, and the camera keeps a project beside it; a double-click on the edge goes back to the
  default (2026-10-02).
- The minimap sits in the bottom left corner, as in tldraw, so the sheets coming in from the right
  reach down to the window's edge; a sheet wide enough to reach the microphone in the middle ends
  above it (2026-10-06).
- A plan card gets a stored row the first time it is seen, so the owner's placement persists; its
  title, text and state always come from the doc. Each read also keeps the doc's last state on the
  project (title, goal, workstreams with key, label, title, text and state).
- A plan doc that disappears ends its project: the project goes into the archive with that last
  state, and returns with its placement when the same file comes back (2026-10-01). Ending is
  automatic rather than an explicit "abschließen", which can later sit on top. Obeya watches the
  plan directory and the nearest directory above it: git removes the plan directory with its last
  doc, and the directory's own watch then reports nothing (M5 stayed on the canvas until a
  restart). Reading old content
  from the git history instead was rejected as fragile (PRs and clones, renames); it served
  only once, to backfill Obeya's own projects from before
  (`scripts/backfill-archived-projects.ts`, run 2026-10-01 for M2, M3, M4, M6 and M7). Known edges: a renamed doc makes a new
  project and leaves the old one archived. A project from before the doc was kept has nothing to
  show and stays hidden.
- Plan docs come from the Lesestand, the default branch, not from the configured checkout
  (2026-10-06). Until then they came from the checkout's working tree: in a repository whose work
  lands through PRs that checkout is often a pool clone on a card's branch, so a doc pushed to
  `origin` from another clone never showed, a card's branch without a doc sent its project to the
  archive and back at the next lease, and a workstream ticked off in a merged PR went live only by
  chance. The agents that only read moved with the docs, so a project agent finds its doc where it
  works. Rejected: reading only the docs with `git cat-file` (the agents would read another state),
  pulling the configured checkout (it is a pool clone on cards' branches), and merging the docs of
  all clones (which state counts would be chance). The fetch rides on the PR watcher's rounds and
  the merge, without a timer of its own.
- A canvas belongs to a repository, not a checkout: the adapter names it, so the clones share
  one. A project's adapter lives in its own repository (`.obeya/adapter/`, read from the default
  branch; see Repo adapter), not in Obeya's, which is open source: until 2026-10-05 adapters lived
  here and were picked by the `origin` URL. The generic one covers any repo with `docs/plan/`.
- A card has one fixed size; a delivered workstream shrinks to a chip, a project wraps its
  children, and a workstream cannot be dragged out of its project. New projects are placed in a
  grid below the existing ones. A proposal or follow-up goes below the card it came from, or, when
  something is in the way there (for a workstream: its own project), to the nearest spot clear of
  every card and project (2026-10-05).
- Groups show as contours behind the cards, drawn in SVG, rather than a WebGL shader (2026-10-05).
  Three prototypes were built: a shader with waving "plasma" areas, one with territories and a
  drifting honeycomb, and contours. All ran smoothly at about 30 cards; the owner chose the
  contours, which are calm, need no WebGL and cost nothing at rest, over the shaders' livelier
  look, which costs frames all the time. The territories animate only when something changes.
- A group ends with its last card: it is made by putting cards into it, so there is never an empty
  group to clean up. Deleting one ends it at once by taking its cards out, for a group whose last
  cards sit in the archive, out of reach of the ring (2026-10-06).
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
- A click on the minimap flies there; a press that moves lets the view follow the pointer on the
  minimap until it is let go, gliding after it so a press far from the view does not jump
  (2026-10-06).
- An unfolded card is as tall as its content, up to a limit per state beyond which it scrolls, and
  follows its content while open. Where its bottom lies under the microphone, the content gets
  that much room below it, so the last row (an idea's „Parken“, „Verwerfen“) scrolls up past the
  microphone instead of staying under it (2026-10-05). A card with a conversation (an idea, a task
  an agent worked on) is up to 1600 px wide instead, the conversation a third of the width
  (400–560 px), and as tall as its taller column, at least 320 px, up to the room from the top bar
  down to the microphone; it stands in the middle of the window, above the microphone. Beyond that
  room what the card is about and the conversation scroll inside their columns, the panel not at
  all. Before (2026-10-08) it always filled that room, with empty space below a short conversation
  and a short brief on a large screen. The panel shows no scrollbar of its
  own, which before (2026-10-08) stood at its right edge whenever the content came out a few pixels
  higher than the panel. Only a window too low for a split of 320 px lets the panel reach under the
  microphone and scroll. Before it filled the room (2026-10-08) it stayed at
  1120 × 880 px with the columns 600 px high, small on a large screen. A proposal keeps growing
  with its text.
- Opening a card takes 300 ms: a 130 ms flight brings it to the middle, then it unfolds in 170 ms;
  closing runs the same in reverse. Fast enough not to wait on, long enough to keep the context.
- Manual cards are created by double-click, the button or `n`, and edited in the unfolded card;
  a new card closed without a title is dropped. Deleting offers undo.
- The server words no UI text for refusals: it answers `{ code, error }` with a stable code
  (`ErrorCode` in `src/core/types.ts`) and an English detail, and log entries of a failed start
  carry the code too. The UI shows its text for the code from `strings.ts`, a generic one for
  anything else.
- A start that fails after the Koordinator took it drops the card back to planned; the unfolded
  planned card then shows the last log entry, when it is an error, as the reason. A start that
  finds no workspace is no failure but a wait (2026-10-05): before, such a card stood as "Geplant"
  with "Kein Workspace frei" as its last failure and never started by itself, though the owner had
  started it. Cards left that way are picked up as waiting when Obeya starts.
- A card waits rather than risking a collision; the Koordinator's estimate is taken once, before
  the start, and a waiting card is checked again against what runs when its blockers finish.
- A new card does not overtake a queued one it likely conflicts with: it queues behind it, also
  when that one waits for something far from done. Fairness over parallelism; the owner can still
  start it anyway.
- The owner reorders the queue with buttons that move a card one place, not by dragging
  (2026-10-08): the waits fix part of the order, and a button can say at the card where they
  stop it, where a drag would only fail on dropping. Only cards with a decision move, and none
  passes one being judged: its turn reads the cards ahead of it, and a card moved behind it could
  otherwise end up waiting for a card that waits for it.
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
  to an idea is the exception: it only adds to a conversation. So are a note and an answer to the
  agent of the open card (2026-10-05): they only add to what the agent knows, the card's conversation shows
  them, and waiting for a confirmation would keep the owner from going on. Feedback on waiting
  work keeps the undo window, since it sends the work back.
- A card shows a conversation instead of its log (2026-10-05): the owner reads what was said and
  decided, not every tool call, which stays a click away under each message. Rejected: the
  conversation beside the log (every message twice). A worker answers notes with a tool of its
  own (`reply`); its last words before the owner's next message would often be "Ich committe
  jetzt", and a small model summing up each turn costs on every turn for nothing `reply` does not
  do. A note withdraws an open question rather than counting as its answer, which would put a
  remark into the decision log as a decision.
- Typed and spoken words take one way, through the Koordinator (2026-10-05). Two ways with almost
  the same behaviour (the card's field straight to the agent, speech through the Koordinator)
  meant "gib frei" or "Merk dir" worked spoken but not typed. Rejected: everything straight to the
  agent (Obeya's commands would stop working, and planned or finished cards have no agent), two
  keys (the owner would choose who listens before every sentence), and dictating into the field
  for the owner to send (a step more). Typed words cost the Koordinator's two seconds too, but
  nobody waits for them.
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
  (a logo for Obeya) say more as a page side by side than as a recording of one. The summary, the
  open question and the follow-up cards are the same for both. Without any demo the owner would
  have to read to decide, so handing over without one needs a reason and stays the exception.
- The demo report has no lists of what was shown, what was not shown and what the worker noticed
  (2026-10-05): the owner never read the first two, read the findings but rarely made a card of
  one, since most were not for them to act on. What the owner needs to know goes into the
  summary, kept to a few paragraphs; a problem worth a card is a proposal.
- An idea's agent shows how a variant looks as a mock in a field of its own beside the brief and
  the reply, not as HTML in their Markdown (2026-10-05): the agent stays read-only and writes no
  artifact files, the Markdown renderer stays without HTML, and the owner sees simple options
  without having a prototype built.
- A demo's scratch Obeya is staged by a script from a stage file rather than by hand (2026-10-01):
  in the 14 card runs before, the demo took longer than the change itself, and every worker wrote
  its own staging (curl, sqlite, server start) with the same mistakes: the wrong API path, a
  server that restarted on the worker's commit, a staged "working" card that a real agent resumed,
  real agents the Koordinator started mid-take. The script writes the cards' fields straight into
  the database, so any state is a line in the stage file, and the workers are idle unless asked.
- A proposal the owner talks about is rewritten by an agent of its own, not by its proposing worker
  or in the Koordinator's quick turn (2026-10-06): the worker may be gone or busy with its own card,
  and writing a whole card text would slow every confirmation down. Before, the owner could only
  type the changes into the proposal's text themselves.
- A worker's question goes straight to the owner, with the worker's own pick (2026-10-07). Before,
  a project agent answered a workstream's questions and the Koordinator those of a card without a
  project, escalating only what they could not settle; they were allowed technical judgement calls
  "a senior engineer would make without asking". The Koordinator then decided against building a
  feature, weighing the work against what it would save, which was the owner's call. An advisor
  knew barely more than the worker: the Koordinator saw no other cards, and a project agent's only
  edge was the project's decision log, which now goes to the worker. Narrowing the advisor's rules
  or having it only suggest were dropped: the worker's own pick gives the owner what a suggestion
  would.

## Open questions

- Plan-doc sync: Obeya reads plan docs and never writes them; workers tick off their workstream
  in the doc as part of their change. Should the project agent keep the doc's progress instead?
- A plan doc without a `## Workstreams` checklist is not shown (its tasks under other headings,
  say). Fix such docs, or show them as projects without cards?
- Making Obeya known as open source (MIT licence, a public repository, English behind the interface, voice
  on Windows and Linux, an installable app, the site on obeya.si): planned in
  [`docs/plan/open-source.md`](plan/open-source.md).
