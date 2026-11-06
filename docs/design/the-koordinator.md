## The Koordinator

A chapter of the [design doc](../design.md), whose header says how it is written.

The Koordinator is read-only agent turns on the Lesestand of the card's repository (the home
repository's without a card), one decision at a time (look-ups excepted, see Looked-up questions).
It schedules the cards, reads the owner's commands (see Commands to the Koordinator), looks things
up, and learns the owner's rules.

### Scheduling

Before a card starts, the Koordinator estimates the files it will change and judges whether running
it beside the cards in progress likely ends in merge conflicts. For each card in progress it sees
the estimated files and what the branch has changed so far (each file with its changed line ranges
and git's function context). Sharing a file is fine (additions in different places merge cleanly);
touching the same lines or function, or code one card moves, renames or reformats while the other
edits it, is not. Soft paths (`softPaths`, docs) do not count. In doubt the card runs: a conflict
that happens anyway goes back to its worker on landing. The estimated files stay internal: a card does not show
them (they read as a guess beside the files the card actually changed, and the owner has nothing to
do with them; 2026-11-02).

A branch's change is measured from where it left the nearest branch that is not a card's
(`obeya/…`): the main branch, or a long-lived branch the card was built on; from the main branch if
it was merged into the card's branch since. So a card built on another card's branch keeps that work
as its own. Commits the branch starts with whose change the main branch holds as other commits are not
the card's: a pull after a merge on the forge rebases the local main's unpushed commits onto
`origin`, and the branches cards made before it keep those commits as they were; counted, they would
show a card that changed nothing with their files and "Approve" (2026-11-02). git reads the changes
of all cards in progress at once, without blocking the server.

In a folder without git (see Folders without git) the judgement is whether the card gets in the way
of one in progress: the same files changed, moved or deleted, or a directory reorganised that the
other works in; working side by side in one directory is fine. No paths are soft there.

Cards queued before it count too: a card likely to conflict with one waits behind it rather than
overtaking it, and once that one has started, until it has landed. A card judged again sees only the
cards queued before it, and a card waiting for another (directly or through others, an arrow the
owner drew counting as a wait) is never among
the cards that one sees as ahead or to build on, so no two cards wait for each other.

A waiting card shows the reason (one that starts says which files it shares and why that is fine).
Once what it waits for has landed or stopped it starts, or, if other work may have started
meanwhile, it is judged again. Cards whose waits end at once (the follow-up tasks of a merged PR,
say) are judged together, in one turn as a project's start is (see Starting a whole project): it
sees them in their order in the queue, keeps that order unless a dependency or a likely conflict
asks for another, and says which start now and which wait for which, so the first in the queue
does not start blind to one after it that it should build on or would collide with; a card alone
starts at once where nothing runs. "Start anyway" starts it at the owner's own risk. While it waits
it keeps its full card and takes notes for its worker (see Card layout); spoken words there go to
the Koordinator.

A workstream started on its own also waits for the workstreams of its project it builds on (code, an
API, data or a decision one of them introduces, or the plan says it comes after), judged from the
plan doc, including those not started or stopped, since the owner may start workstreams one by one.
Such a wait holds until that workstream has landed; stopping it or taking it out of the queue does
not free the card. The card says so ("Waits for “W2 …” (not started yet)", in its log, the
queue's list and the project's sheet), so the owner sees which to start first. Even with nothing in
progress or queued, it skips this judgement only when no workstream of its project is left unlanded.

A dependency drawn by the owner (see Cards on the canvas) holds the card until the prerequisite has
finished, including while that prerequisite is not started or stopped: a card started afterwards
queues behind it once judged, and one in the queue when the arrow is drawn waits for it from then on,
also one waiting only for a workspace or for the canvas's agents to resume. An arrow counts as a
wait wherever the queue reads waits: a card held by one is never ahead of its prerequisite or
among the cards that one may build on, a card does not pass it in the queue, and the arrows that
would close a cycle with other arrows or waits are refused. An arrow holds a card only until it
starts: one running or stopped by the owner afterwards (planned again, held anew once started
again), one the owner started anyway ("Start anyway") and one whose workspace was taken from it
go on once a workspace is free, whatever arrows are drawn. An arrow is kept apart from the waits the
Koordinator inferred: removing it leaves exactly those (a likely conflict still holds only while
the other card is in progress), and where both name the same card, the arrow holds on once the
inferred wait has ended. The card says that it waits because the owner connected the cards, in its
waiting box, on its face and with a line in its conversation once the arrow holds it, with the
inferred waits' own reason beside that where both hold it; an arrow is never given the reason of an
inferred wait.

#### Follow-up tasks of a review

A follow-up task a review card's worker makes of findings (see Review cards) builds on the pull
request by definition, so Obeya queues it behind the review card as it is made, without an estimate:
"Waits for “PR #34 …”. A follow-up task from the review of PR #34; starts once the PR is
merged." The wait holds like a workstream's on one it builds on: stopping the review card does not free
it, only the merge (the card `live`); then it starts, or is judged again, together with the other
follow-up tasks of the PR, where it is not alone or other work runs. A PR
closed without a merge (the review card closed as done) leaves nothing to build on: its follow-up
tasks go back to planned, saying why, for the owner to start or delete. One made when the review
card is finished already is judged as any card. While it waits it is a task nobody has worked on:
the Koordinator may merge it with others (the merged task waits for what any of them waited for, in
the place of the first queued) or delete it.

#### Waiting for a workspace

A card let start while no workspace is free (all clones leased, or every free one dirty) waits in
its place in the queue ("Waiting for a workspace"), counting as ahead of the cards after it, and starts
by itself once one is free (looked for at every change of the board, and for dirty clones at least
once a minute, since they can turn clean without one; see Workspaces for how free clones are looked at). Its reason ends in a link ("Change the number
of clones", or "… of slots") that opens the configuration at that setting, since the owner may
not know the pool is the limit nor where it is set. A start that fails for another reason drops the
card back to planned, showing the error as the reason. Waiting cards are picked up again when Obeya
starts.

#### The queue's order

Cards whose turn comes together go longest-waiting first. The owner sets the order where the waits
leave it open: in the queue's list a row is dragged to any place, by the grip at its left with a
mouse or a finger (a finger elsewhere on the list scrolls it), or with a mouse by the row itself;
the rows it passes make room, and the list scrolls at its edges. On a waiting card (which says its
place), "Earlier" and "Later" swap it with its neighbour, and "Show the queue" unfolds the
queue there with the card marked in it: there the card alone is dragged, the same way, while the
other rows only show where it stands (they neither move, open their card nor take it out), and the
two buttons give way to the drag until the queue is folded again. A card does not pass a card it waits for,
one waiting for it, or one being judged, and a card being judged does not move; a dragged row stops
at the last place it may take and, pulled farther, says why, and such a button stays grey and says
why when clicked. A drop moves it there in one step: it passes each
card between, which each move up one place. The order decides who goes first once free, who gets a
free workspace, and which cards count as ahead when one is judged again.

Each wait shows on the canvas, under the pointer over every step (see Cards on the canvas).

#### Starting a whole project

"Start all N workstreams" (the project card's head, its sheet, or by voice) queues all planned
workstreams in the plan's order, with 8 seconds for "Undo" (the button is easily hit). Then one
Koordinator turn sees them with the plan doc, the cards in progress and those queued ahead, puts
them in an order and says for each what it waits for: a workstream it builds on (until that has
landed) or one it would likely conflict with; the rest start at once. A workstream waits only for
what comes before it, and that order becomes the queue's. The project's sheet names what each waits
for. If the turn fails, each is judged alone, seeing the others as queued after it; after a restart
the joint turn runs again.

### Learning the owner's rules

After whatever the owner says, the Koordinator decides whether a lasting preference was stated and
proposes it as a rule (the card's log says "Proposes: …"): for the preferences, which hold only
how agents work with the owner through Obeya, or, when it is about a repository (taste in code
included), for that repository's CLAUDE.md, one proposal per repository when it holds in all of
them. A rule said outright („Merk dir: …“, the open card as its occasion) or written in the sheet's
field for a new rule (with the same "Belongs in") is sorted the same way and recorded at once (a
command after its undo window), without a proposal: one on how agents work with the owner through
Obeya is active at once; one about a repository („Merk dir: im Shop immer …“) goes into the card
"Add to CLAUDE.md" of the repositories it names (see Rules for a CLAUDE.md). The confirmation says
which. It may name a rule it changes, which takes the new text or, moved into a CLAUDE.md, goes.

The learner reads answers, notes and feedback to workers, an idea's discussion, the conversation
with the Koordinator (a command once its undo window has passed), and text the owner writes in a
card once they pause for a minute or act on it. It sees each input with the card's text, the owner's
words of the last three days, the agent's last message before the input, the canvas's repositories,
the active rules and the open and rejected proposals. Its signals: general phrasing („immer“, „nie“,
„ab jetzt“), a correction of how an agent works, a repetition. At most one proposal per input.

#### The retrospective

The retrospective counts the owner's inputs (what the learner reads, wordless clicks on a card, a
deleted card, a command taken back, a proposal decided on); the count survives a restart. At 20, one
read-only session in the home repository reads what happened since the last retrospective (the cards'
milestones, the owner's words in ideas and to the Koordinator, taken back or not, deleted or
dismissed cards, decided proposals), looks for patterns seen at least twice on different cards, and
proposes up to three rules, each with what it rests on ("From the retrospective: …").

#### Proposals and rules in the sheet

Open proposals stand in the Koordinator's sheet with their occasion, the rule a change would
replace, and where it goes ("Belongs in": the preferences or a repository's CLAUDE.md), which the
owner may switch. The owner accepts, edits before accepting, or rejects; rejected ones are kept so
the learner sees them. Obeya's button counts open proposals apart from what needs the owner; they do
not show on cards. The Koordinator gets the rules, numbered, with every command, and follows them
itself too.

#### Rules for a CLAUDE.md

A rule for a CLAUDE.md goes into that repository's open card "Add to CLAUDE.md", or a new one; its
worker writes the rules in the style of what is there. The card starts by itself once no proposal
waits any more (a waiting one might yet be switched to its repository), so several go in together.
It lands like any card; until then the rule applies to no agent, afterwards through the CLAUDE.md
alone.

### The Koordinator's sheet

The sheet (Obeya's button or `C`) gives the conversation with the Koordinator all its height, with
the field every card has under it (see Card layout).

Opened with its button or `C`, the sheet focuses the field (the owner, 2026-10-19); opened with Tab,
going through what needs the owner, it does not, so the next Tab goes on.

Below the conversation, collapsible sections with counts: the open proposals ("Proposals (2)",
shown while there are any, opening again when a new one comes) and the preferences (closed by
default); their state is kept per canvas in the browser. What runs is not listed: the canvas shows
it.

Messages look like a card's: the owner's on the right, who and when above, markdown (each line a
paragraph, each blank line an empty line as typed, lists, tables, code, nested quotes; the plan
docs' parser), a taken-back reply struck through, bare web addresses as links without `https://`
and without the sentence's punctuation after them.

### Work retrospective

Obeya looks back at how the workers worked, to make future runs cheaper: detours where a worker went
wrong and corrected itself (wrong flags, a script rewritten after failing, a long search for how to
start something), above all the same detour on several cards. It is built like the retrospective but
differs in source (the workers' transcripts), beat (finished cards), place (the repository of the
friction) and result (feature cards and setting values, not only rules). It runs in two stages.

#### Friction notes

When a card's work ends (landed, closed without a change, a prototype discarded or built, or deleted
unfinished), Obeya draws an excerpt from its runs' transcripts without a model. The Agent SDK keeps
them at `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, non-alphanumerics as „-“>/<session
id>.jsonl`, also after the workspace is gone; Obeya looks there first, then in every directory, as
the naming may change. Codex keeps a thread at `<CODEX_HOME or ~/.codex>/sessions/<yyyy>/<mm>/<dd>/
rollout-<time>-<thread id>.jsonl` (or under `archived_sessions`); its day is in the thread id (a
UUIDv7), and Obeya looks there and on the days beside it first, then everywhere. Of a thread the
excerpt reads the items Codex completed, named as Claude Code's tool calls are: a command as `Bash`,
failed when it ended with another exit code than 0, a file added as `Write`, changed as `Edit`. A
worker on a host left its transcripts there; they are copied here to be read. Earlier runs are found through the log, where a start from scratch notes the
session before ("The earlier run (session …) is kept for the work retrospective.").

The excerpt holds failed tool calls with their error, runs of similar calls (a failure and its
correction, a command three times or more), files written whole more than once, the worker's words
around each, and how many calls the run took before it first changed a file. Calls cut off by a
restart or stopped by the owner, and subagents, are left out; an unreadable transcript gives no
excerpt and no error. A short read-only small job (see Harnesses, models and effort) makes 0–3 friction notes
of it (what went wrong, what it cost, what would have prevented it). It is told the settings the
work retrospective may propose as they apply now, so a worker working out what one would have said
becomes a note naming that setting and the value that worked.

#### Reviewing the notes

Every 10 finished cards of a repository (a card that never ran does not count), the work
retrospective reviews the notes; a new repository's first reviews come after 1, then 2 more and 4
more cards, so the first improvements come soon. It is one read-only session in that repository's Lesestand (so it sees its
CLAUDE.md, scripts and skills). It reads the notes since the last review, with earlier reviews'
proposals (dismissed ones so it does not repeat them), and proposes at most three things, each
resting on friction on at least two cards:

- a feature card (a script, a skill, a fix to a tool), waiting as a proposal ("From the work
  retrospective: …"; its state "Proposed by Obeya", not "Proposed by an agent");
- a line for the repository's CLAUDE.md, which goes the way of the retrospective's rules (see
  Rules for a CLAUDE.md);
- a value for one of the repository's settings (`checks`, `setup`, `softPaths`, the app's `run`),
  for knowledge the workers each worked out themselves; it sees them as they apply now. Since every
  handover brings a demo, an empty "How to run the app" is the usual case: the work retrospective
  proposes the recipe the workers arrived at.

Nothing is created or started silently; the user's own skills (`~/.claude/skills`) are out of scope.
The owner can ask for one at once („Mach eine Arbeitsrückschau für den Shop“); the count starts
again.

#### Setting proposals

A setting proposal (one per setting and repository) stands in Obeya's sheet under "Proposals",
marked as a change to the configuration: a cog and "Configuration change · <repo>" over the
setting's name, "Now" above "New", the reason and the cards as links, and "To the setting ↗",
which opens the configuration dialog at that setting. Obeya's button counts it.

The new value stands in a field the owner may edit in place ("As proposed" restores it; the
edit survives a reload). Two buttons, neither preselected, take it: "On this machine" sets it in
this machine's settings at once; "For everyone, into the repository" puts this one value into
`.obeya/settings.json` the way "Take over into the repository for everyone" does (see
`.obeya/settings.json`), the value set on this machine until the file holds it. A notice says where
it went. "Dismiss" keeps it as rejected, and the next review hears what became of each.

### Looked-up questions

A question that needs reading (what the agent would do, what the plan says, how something works) the
quick turn acknowledges ("Let me look at the plan.") and passes on: about a project or its
workstreams to the project agent, in the project's session; else to a thorough Koordinator turn on
the card's repository. Both have a worker's tools and permission mode (shell, gh, the web, files
outside the repository), so they check what the text alone does not say (which render is newest, a
CI run) instead of saying they cannot see it. A call the settings want confirmed is refused, as
there is no card to ask on. The quick turn stays read-only, so it answers in seconds.

A question about the work of an agent on a card („Ist sichergestellt, dass …?“) goes to that agent
as a note or feedback instead: its work is on its branch, not in the Lesestand, and the card shows
the agent at work while it answers. A look-up about a card gets its state, log and the worker's
start task, from which it derives the worker's steps.

The answer comes 10–30 s later: its start above the microphone (as plain text on one line, its
Markdown stripped), in full in the open card's log, else
in the Koordinator's sheet; meanwhile the open card shows what the agent reads. An answer told as a
walkthrough shows its first slide there before its words (see Walkthroughs). An answer in the
sheet stays unread until the owner has the sheet in view (open, the page not hidden): until then
Obeya's button counts it in orange, it counts once in the navigation and stands in its "Needs you" as one entry, and Tab
goes there after the cards that need the owner; such answers keep an orange edge until the sheet
closes. An answer that arrives while the sheet is in view, or in a card's log, is read where it
arrives. The quick turn's own reply waits the same way when it only answers, since a long one takes
20 s and more and the owner may have moved on (2026-10-19). A confirmation of actions does not wait:
the canvas shows what it did, with "Undo" above the microphone.

The Koordinator hears each answer in full with the next command (so „ja“ to a card it offered
works), and it is part of its memory. A question still open at a restart is looked up again. A
look-up for an action the owner asked for brings its answer to the Koordinator at once instead,
which takes the action then (see A step once something is looked up).

### Looked-up threads

A look-up starts a thread. The Koordinator knows each answer by a tag (`A12`); when the owner's
words follow up on one („und im Oktober?“, „mach mir ein Excel daraus“), the follow-up resumes the
session that found it (in doubt the newest), which still has all it read and computed. Turns of one
thread queue. A session that cannot be resumed is replaced by a fresh agent given the thread so far.
The follow-up shows "↳ continues “…”" (and "reading …" while it runs) under the owner's words, so
the owner sees which answer Obeya took it for.

A look-up whose turn ends while its background work runs (a download, a long query) keeps reading
until that work wakes the agent, within a worker's limits (see Turns that end without a handover);
should it never wake it, its last words are the answer.

#### Files with an answer

Every thread has an output directory outside every repository, `~/.obeya/answers/<canvas>/<thread>/`
(never in git), given to the agent as a directory of its own: files the owner asks for or that help
(a spreadsheet, a chart, the scripts behind them, a draft) go there, and the answer names them with
a caption; a path outside it is refused. Under the answer they show: a page in the sandboxed frame
of an HTML artifact, an image inline, any other file as a chip that opens it with the system's app
(only from a page on the machine Obeya runs on; elsewhere, or where that fails, it downloads). A
file that would run when opened (a `.command`, a `.bat`) is shown selected in its folder instead.
Each has ↓ to download, and "Show in folder" opens the directory. Follow-ups build on the files
already there.

#### Walkthroughs

Where an answer explains how something works or what happens when (a flow through the code, one
thing after another, what a change does, how two variants differ), the look-up agent tells it as a
short walkthrough with slides and narration instead of a block of text, and it plays while the
agent still writes it. The agent judges which questions need one; the Koordinator's look-ups and
the project agents alike can tell one. A text answer in Obeya's sheet has "Show as walkthrough" in
its head, on hover (always on a screen without hover): it asks the same thread, as the owner's
words "Show as walkthrough" following up on the answer with Obeya's reply "I'll tell the answer as a
walkthrough.", to tell that answer as a walkthrough, which comes as the next answer.

A walkthrough has 4 to 8 slides: a title slide first, then points (up to five), flows (three to six
steps in a row joined by arrows, each with an optional note) and, only when the owner asks to see
code, code slides: real lines of a file of the repository, at most 30, which Obeya reads from the
file by the line numbers the agent gives, with ranges highlighted one after the other. Otherwise
the rule that the owner does not read code holds. Each slide's narration is in the owner's
language, spoken prose that explains rather than reads the slide out: one text, or one part per
item (point, step, range), each spoken while its item shows.

The agent hands the slides over one at a time with a tool, the title slide as soon as it knows what
the walkthrough answers, each further one once it has checked what it says; then it answers with a
sentence or two on what the walkthrough shows. What is wrong with a slide goes back in the tool's
reply and the slide is not shown: a first slide that is no title slide, a second title slide (an
answer has one walkthrough), a ninth slide, a narration in parts that do not match the items, a code
slide's file outside the repository, lines it lacks, more than 30 lines, or a range outside them.

With its first slide the walkthrough shows under the question, before the answer's words: in the
sheet, in the log of the card it was asked on, on a Question card in its conversation, as a message
without words that cannot be replied to yet. The answer's words then come in above it without
interrupting it, and the walkthrough is the first of the answer's files. It is a file of the
thread's directory, `<name>.walkthrough.json` named after its title (a later answer gets a name of
its own), holding the slides as shown (a code slide with its lines), each slide's narration as the
sentences it is voiced in (and for a narration in parts, the item of each), whether every slide is
there, each sentence's clip once voiced (its file and seconds) and why voicing failed; the clips
are WAVs in `<name>.clips/` beside it. The player reads it from `GET
/api/c/<canvas>/threads/<thread>/walkthroughs/<name>` while it grows, and its clips as the answer's
files; both come through Obeya's server, as every answer file does, so a walkthrough plays wherever
the page plays: on the phone and on other machines too. A look-up that runs again after a restart
drops the walkthrough it had begun, for the one it tells anew.

Obeya voices each slide as it comes, sentence by sentence, in the voice of the demo settings for
the owner's conversation language (see The demo settings and voices in Demos), through the voice it
holds loaded where it can (see A voice that stays loaded): one sentence at a time for all
walkthroughs, in the queue the renders' clips wait in. A title slide says its title first, a short
sentence voiced quickly. A player that plays says which slide it is on: the voice speaks next the
first sentence it still needs from there; with none playing, the newest walkthrough goes first.
"Show as walkthrough" loads the voice at the click, while the agent writes the first slide. A
sentence the voice cannot speak ends the voicing of its walkthrough, and the player says why;
sentences still waiting when the server stopped are not voiced afterwards, and the player says that
the voicing stopped with the restart.

The player plays slides and sound in step: the items of a slide light up as the narration reaches
them (before the first play, a slide shows them all), a code slide scrolls its highlighted range
into view, and the sentence being spoken stands under the slide as a caption, which "CC" switches
on and off. Its progress bar has a segment per slide, which jumps there on a click; ◀ and ▶▶ go a
slide back and on. Where the next sentence is not voiced yet it waits, showing "Voicing … 8/43";
where the agent is still writing the next slide, "The next slide is being written …". A walkthrough
asked for with the button starts by itself in the page that clicked (the click allows the sound),
as soon as its first sentence is voiced; one the agent chose shows its first slide and "Play
walkthrough". One walkthrough plays at a time: starting one pauses the others. A player goes on
while its message is drawn anew (the answer's words arriving) and pauses once no view shows it.

#### Question cards

"Make it a card" in a looked-up answer's head moves its thread onto a **Question card** beside the
card whose log held it: its question as title, its exchanges as conversation, the same session going on.
While the card exists, the sheet shows "On the card “…”" in place of its answers; once it is
archived or deleted they return, and "Make it a card" again opens the card, back from the archive if
need be. Follow-ups asked in the sheet go to the card.

On the card the owner talks straight to that agent through the shared conversation (see Conversation
on the card); words sent while it reads join its next turn (unread until then, and the owner can
take them back), except while its turn waits for background work: then they reach it at once, so
"take 2023 instead" arrives while the download runs (a session that fails after hearing them hands
them to the fresh one). Its agent passes on with `to_obeya` what asks Obeya; a note the Koordinator
passes to the card goes to it too.

It holds answers, not work: a look of its own ("QUESTION"), the number of answers and files, not
archived with all finished cards at once (see Archive), no build, plan, prototype or park buttons.
It has two: "Discuss as idea" (not while its agent reads) makes it an idea whose agent starts from
the thread and its directory, and "Done" archives it. The Koordinator lists Question cards among
the cards it sees.

#### Asking in a project's sheet

A project's sheet has a section "Project agent": the conversation with its project agent and the
shared field. Words there go straight to the project agent, not through the quick turn, in its one
session; a reply to a message follows up on that thread, other words start a new one. The agent has
`to_obeya` for what asks Obeya („starte W4“). The section shows every thread the project agent
answers, also those asked of Obeya about the project, each with "Make it a card". Obeya's sheet shows
them too, marked "in the sheet of “…”", so an answer that comes after the owner left the project
waits there unread; with the project's sheet in view (not its plan doc) its answers count as read
and get no line above the microphone. While an answer to words written in the sheet waits unread,
the project's card shows it at its corner, collapsed or not: a pulsing speech bubble in the project
agent's colour (with the number from two answers on), beside the count of workstreams that need the
owner and unlike it; a click opens the sheet. The sheet then opens at the first of them, marked as
answers that waited are in Obeya's sheet. The conversation grows in the sheet, without a scrollbar
of its own.

### Koordinator memory

The owner's commands go to one ongoing session per canvas, so it understands „die andere auch“. It
sees a card's open question, also one in a demo report, so „ja“ is an answer, not an approval. An
approval by word ("deploy it", „raus damit“) lands the way the repository sets; words that ask to
bypass the pull request („ohne PR“, „direkt auf main“) approve nothing in a repository whose work
goes out as one, and the Koordinator replies that only the card's button "Straight to main" does that,
where the settings allow it. It
knows each card by its number (see Card numbers in The canvas), in its actions too; a card the
owner's words name by number that is not on the canvas (finished, archived, on another canvas,
deleted) comes with the command, so it can say what became of it, though it acts only on cards of
its canvas that are not archived. Its memory of exchanges from before cards had numbers says that a
K-number said then was a tag of that session and names another card now. Each command brings the cards as they are and what
happened since the previous one (state changes, questions, answers, hand-overs, notes, errors, new
cards; not the workers' steps), including a command the owner took back. Every exchange is stored.

A session that fails (an error result, which the SDK may report as `success` with `is_error`) is
replaced by a fresh one for the same command; if that fails too, the owner hears the reason ("Claude
is not logged in on this machine: …"), not "I did not understand that". Sessions are never resumed:
after a restart, and after 30 commands, a fresh one starts from memory (the last 20 exchanges, the
canvas's last 14 days, the newest five looked-up answers in full).

### Wishes for Obeya's makers

The owner reports what is missing or broken as a GitHub issue on sadilek/obeya (fixed, since the app
runs without a checkout), submitted under their own account. Four ways open the draft dialog: the
link "Report a wish or a bug" in the Configuration dialog and in the legend (with "draft open"
while a draft waits), words to Obeya („Obeya, Feedback: …“, at once without undo, since it sends
nothing), and "↗ Report as a wish" under a reply that says Obeya cannot do what was asked.

In the dialog's shared field the owner writes or speaks; a small read-only job writes it up as an
English title and body (reworking a body that stands with the new words), adding nothing they did
not say, and ending with one line on this Obeya's version, system and kind of install. Nothing from
cards, repositories or the conversation goes in unless the owner wrote it or it is the unmet request
and its answer. Without a model (not logged in) the owner's words stand as they are; at the usage
limit the line says when, and the page writes the draft once the limit lifts, after a reload too,
unless the owner edited it meanwhile. Title and body are editable, above the line that the issue is
public under the owner's name.

"Open on GitHub ↗" opens GitHub's prefilled new-issue page (`issues/new?title=…&body=…`) in the
system's browser. Screenshots cannot travel in the link: the click puts the first on the clipboard
and the dialog says to paste it. The link stays under 8000 characters: a longer body is cut, and
without a screenshot the whole body goes on the clipboard. Then the draft is gone, and the dialog
says what is on the clipboard. Until sent, the draft is kept like every input. A new wish does not
replace a draft with content: the dialog offers to discard it for the new one, and opening the old
draft on GitHub writes the new one too; a draft with only a title gives way at once. The draft
remembers the wish it came from, so that reply's link reopens it as it stands.

The Koordinator flags a reply when Obeya lacks the feature, not when the request is unclear,
something just failed, it does not fit a card's state, or for questions of fact. What an agent can
work out or make on the machine (a chart of each task's tokens from the agents' session logs, say)
is a look-up or a task, also where Obeya itself shows nothing of it. On a card such a
reply stays in the conversation rather than folding away with the confirmations. An agent that
passed the words on through `to_obeya` hears that the owner finds the link under the answer; a
`wish` passed on that way opens the draft on the page.

### Decisions

- **Wishes go out as a prefilled GitHub issue the owner submits** (2026-10-16), so Obeya holds no
  token. Rejected: posting through gh (publishes with only Obeya's preview as the check), a hosted
  endpoint (a service to run, spam, privacy), mail (manual attachments, exposes an address). Obeya
  offers it under a reply that it cannot do something; rejected: never (nobody learns where it falls
  short) or collecting them under "Proposals" (late, without context). No icon in the bar (always
  there for something rare) and no line in Obeya's sheet (the owner, 2026-10-17). The action is
  `wish`, since `feedback` is feedback on a card's work.
- **The Koordinator waits on a card for a step it announced** (2026-10-18, see A step once a card
  gets somewhere), since no turn of its runs without the owner's words and promised steps never
  came. Rejected: promising nothing it cannot take itself (the owner asks for both in one breath); a
  follow-up card whose worker does it (configuration is the Koordinator's, with check and undo);
  conditions beyond the two a worker waits for on another card.
- **A card waits rather than risking a collision**; the estimate is taken once, before the start,
  and a waiting card is checked again when its blockers finish.
- **A new card does not overtake a queued one it likely conflicts with**, even one far from done:
  fairness over parallelism; "Start anyway" remains.
- **A card waiting to start stays full size and takes notes** (2026-10-16; every planned card
  since 2026-10-30, see Card layout). Rejected: shrinking it to a planned card's panel while Obeya
  checks it, which left the owner's thoughts waiting until the agent ran. Spoken words still go to
  the Koordinator, since no agent is there to pass on „trotzdem starten“.
- **A card's change list is its own work, read without blocking** (2026-10-21, GitHub issue #2).
  Rejected: diffing each card in full against the main branch, one after the other on the server's
  thread: cards on a feature branch 766 commits ahead each counted the whole branch (30–70 s per
  card on Windows), and every canvas lost its server connection for minutes.
- **A start that finds no workspace is a wait, not a failure** (2026-10-05), so a card the owner
  started starts by itself once a workspace frees up.
- **The queue's list is reordered by dragging, not by one-place buttons** (2026-10-26): with more
  than a few cards waiting, a card going from last to first took a click per place, and buttons
  beside the drag were redundant (owner). The drag knows the waits: the row stops where they stop it
  and says why when pulled farther, so the drag never just fails. The card's own view keeps the
  buttons while its queue is folded, as moving one place is the common case there; unfolded, the
  card is dragged by the same means as in the queue's list (GitHub issue #14), and only the card
  itself, since the owner opened it to place that card, not to rearrange others. Touch drags by a grip so that the list still scrolls under
  a finger. Nothing passes a card being
  judged, which could otherwise end up waiting for a card that waits for it.
- **A project's workstreams started together are scheduled in one turn** (2026-10-02): they often
  build on each other, which a conflict check does not see; only a turn seeing all of them and the
  plan doc can choose the order.
- **Cards freed at once are scheduled in one turn too** (2026-11-02, the owner on the follow-up
  tasks of a review: the first in the queue started unchecked, and only the second was checked
  against it, so nothing asked whether the first should build on the second). Rejected: starting
  them one by one in the queue's order.
- **Learned rules are proposals the owner accepts first** (2026-10-02), as the owner wants to see
  every rule before it applies. Rejected: storing them silently. The retrospective runs after about 20
  inputs, neither daily nor only on request.
- **Preferences hold only how agents work with the owner through Obeya**; repository rules, taste in
  code included, go into its CLAUDE.md (2026-10-02), versioned and seen by colleagues and by Claude
  Code outside Obeya. Rejected: not learning repository rules (lost), preferences scoped to a
  repository in the database (unversioned, invisible outside Obeya), committing to the CLAUDE.md on
  accept (the Koordinator only reads, and PR-landing repositories take nothing on `main` directly).
- **The work retrospective learns from transcripts in two stages** (2026-10-05): a model-free excerpt
  per card made into friction notes, and a review of about ten cards' notes. Rejected: building it
  into the retrospective of the owner's inputs (the log's tool lines lack results, and source, beat,
  place and result differ), workers reporting their own detours at hand-over (patchy, longer hand-overs), raw
  transcripts in the review (far too much context).
- **The work retrospective proposes setting values too** (2026-10-15), since with demos required
  workers kept working out how to start the app. They wait in the sheet, not as cards: taking one is
  a click, no agent work. The owner chooses machine or repository each time, neither preselected,
  and for the repository it is that one value only; the proposal shows plainly that it changes the
  configuration (the owner), hence its head, the link into the dialog and the value edited in place.
  Rejected: a "Change" button opening it (the owner could not tell what it did), hand-over
  summaries saying how the app ran (longer, and the notes carry it), and proposing landing, main
  branch or workspace mode (choices, not knowledge friction reveals). The ramp for new repositories
  exists because 10 cards made the first improvements late.
- **The sheet's conversation looks like a card's** (2026-10-09): one look and one field for every
  conversation.
- **A look-up is a thread with files** (2026-10-14). Rejected: one-shot look-ups whose follow-ups
  started over, and markdown-only answers written in the Lesestand, where files would be left as
  uncommitted changes.
- **Obeya's own walkthrough, played live** (owner, 2026-11-06). Rejected: showntell's Claude Code
  plugin as it is (English only, a dependency on a young project with one author, its player loaded
  from a local service on its own port, which Obeya's page policy had to be opened for and which
  does not play from the phone or another machine); showntell with Obeya's voice (changing it to do
  what Obeya's own already does); rendered explainer videos (the whole render passes before the
  first frame). Looked-up answers and Question cards came first; idea agents and workers do not
  tell walkthroughs.
- **The agent decides, the owner can ask** (owner, 2026-11-06): the agent judges where a walkthrough
  explains more than text, and "Show as walkthrough" covers where it judged otherwise. A sharp hint
  is what moves it: told only how to make one, an agent answered three of three questions as text;
  told "how something works or what happens when → walkthrough", it chose a walkthrough for two of
  three.
- **Code slides only when the owner asks for code** (owner, 2026-11-06); otherwise points and flows.
  Told only that the owner does not read code, the agent never chose one.
- **Handed over slide by slide and voiced sentence by sentence** (owner, 2026-11-06): a walkthrough
  handed over whole took about two minutes from the click to the first sound. Slide by slide, with
  the title said first, the voice loaded at the click and a playing player's sentences first, the
  first sound came 7–12 s after a click on "Show as walkthrough" and 2–5 s after the first slide of
  a new question (Qwen3 with the owner's clone, its first slide 20–30 s after the question); with
  three walkthroughs voiced at once the player still waited 2–5 s now and then.
- **The player is Obeya's page, the walkthrough a file of data** (2026-11-06). Rejected: a player
  page written into the thread's directory with the slides (as an HTML artifact, sandboxed): every
  walkthrough would keep the player of its day, and its words and look would live apart from the
  interface's strings and its light and dark.
- **A look-up waits for its background work** (2026-10-19). Rejected: taking its words so far
  ("still downloading …") as the answer, which closed the session and stopped the work.
- **The project agent can be asked from the project's sheet** (2026-10-21, a colleague's feedback),
  since asking only through Obeya was not found from the project.
- **The project's card shows its agent's unread answers** (2026-10-29, issue #21): a reply to what
  the owner asked in the sheet is looked for where it was asked, not only on Obeya's button. A
  speech bubble rather than a second number, so it is not taken for workstreams that need the owner.
  Answers asked of Obeya about the project stay on Obeya's button alone: they were asked there.
- **The Koordinator's memory lives in the store, not the session**: a session is never resumed, and
  a new one starts from the stored conversation and the cards' history. That keeps the context short
  over weeks and makes restart and renewal one path; the history is in it because the owner asks
  about progress over time („was ist seit gestern passiert?“) and refers to cards by what happened.
