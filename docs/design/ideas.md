## Ideas

A chapter of the [design doc](../design.md), whose header says how it is written.

An idea is thought through on its card before anything is planned; no worker runs.

### Starting an idea

"Ich will über Export für Vermieter nachdenken" (voice or typed), or "Discuss as an idea" on a
planned card of the owner's that nobody has worked on, makes a card in state `idea`. Its exploration
agent opens the discussion at once, with what the owner said or what the card says; that stays at
the top of the conversation as its starting point ("Starting point").

A planned task offers its ways on in one row, each with a tooltip saying what follows: "Start
agent", "Later …" (see Snoozing a card), "Discuss as an idea", "Plan as a project", and "Delete" set
apart at the right end.
"Plan as a project" does on the task what it does on an idea (see Deciding): a worker on the task's
card ("Task → Project") writes a plan doc from its title, text and screenshots, and once the doc
has landed the project takes the task's place and the task goes to the archive (by voice:
`plan_doc`, „plane das als Projekt“).

### The discussion

The unfolded idea is a conversation with its exploration agent: a session on the repository's
Lesestand (code, plan docs, decision log, preferences), resumed for every message, days later too.
If the session is gone (Claude prunes old ones), a new one starts with where the idea stands
(brief, mocks, prototypes, the part marked to split off, the latest messages) and goes on from there.
It has a worker's tools and permission mode, so it checks what the discussion depends on (git
history, a CI run, the web) instead of guessing; nothing it does starts work. It asks back, shows
variants with their trade-offs and says what they would cost. It passes on with `to_obeya` whatever
asks Obeya for something (build, plan, a prototype, park, drop, anything about another card).

Its questions come with answer options, radio buttons or checkboxes when several fit together; the
owner picks, may add words, and both go out as one message naming each question (how answered and
passed-over questions show: see The conversation). The owner types in the panel or holds Space with
the idea open; both go straight to the agent (see Who hears the words). Its reply stands in the
panel, what it read and thought on the way folded under it ("History"). A turn that ends while its
background work runs does not hand the idea to the owner: it shows the agent at work until the work
wakes it, the owner's words reach it at once, and the limits are a worker's (see Turns that end
without a handover).

With every reply the agent says what it would do in the owner's place: the option it would pick for
each question ("I would take this", with why) and the next step (answer first, build, split off a
task, plan, prototype, park or drop, with why). The card marks the suggested button and options, the
canvas card says it short ("Tip: prototype"), and the suggestion goes with the owner's next
message. Every suggested step is a button that exists: answering needs open questions, splitting off
a task needs one marked, a prototype one still to start (a planned variant with none being built, or
with none planned, none being built at all). Starting prototypes takes the suggestion off the idea:
it was made for the idea before they ran. The agent's instructions say what each step does to the rest of the idea
(building ends the conversation and drops its prototypes, planned and running; splitting off keeps
the idea, conversation and prototypes; planning hands the prototype the plan builds on to its
workstream and drops the others), so it never recommends a click for what the click does not do. „Mach, was du
vorschlägst“, to the Coordinator or the agent, takes that step.

Once the agent has replied, the open idea needs the owner like a waiting card ("Idea · your
turn", counted in the navigation) until they answer, park, drop or decide it.

### The brief

The agent keeps the brief ("Where the idea stands") on top of the card: goal, open and dropped
variants, decisions, open questions, effort. The brief is the result whoever opens the card later
reads; the conversation never repeats it: a reply only carries the turn (what changed in the brief,
which question is next).

A variant that is something to look at (a layout, a dialog) comes with a mock: a few lines of HTML
passed with the brief (`update_brief`'s `mocks`, one per variant with its title; left out, the
mocks stay) or, for something the brief has no place for, with the reply. The card shows each
sandboxed like a worker's HTML artifact (see The demo on the card), sized to its content, the
brief's side by side under it. A worker who builds the idea or a prototype of it gets the mocks as
HTML after the brief.

### Prototypes

"Have a prototype built", when talking is not enough: a worker builds a throwaway prototype in its
own workspace, on a card of its own below the idea, and records a demo. Several may run side by
side, one per approach, each titled with it ("Prototype: Logo – wordmark").

When the brief plans prototypes of several variants, the agent passes them to Obeya
(`plan_prototypes`: per variant a few words and what its prototype shows). The button then offers
them as checkboxes, each ticked unless its prototype runs already, beside a field for an approach of
the owner's own, and starts one worker per variant, its task that variant only. Spoken without
words, it starts the planned variants that have none running; without planned variants, an empty
field means the idea as it stands.

The idea shows the demos of all its prototypes, and its agent hears what each found. While one is
built the idea does not need the owner; the agent's reply to the last result makes it their turn
again, and a reply meanwhile does so only when it asks them something. A prototype's worker asks on
its own card; the questions with the owner's answers also go to the exploration agent, which takes
them into the brief without replying, so the idea does not ask them again. A prototype's worker
makes no cards: instead of `propose_card` it has `propose_build`, a proposal to build the idea on
it.

A prototype never lands and does not count for collisions. It ends in the archive with log, demo and
summary ("Prototype · discarded" or "Prototype · built"), never to come back; a new attempt is a new
prototype. "Discard" (also approving or deleting it) throws its workspace and branch away;
"Build this prototype" (or accepting its worker's proposal) builds the idea on it (see Deciding),
until the idea becomes a project: then its plan doc decides.

### Deciding

"Build it like this" makes the brief the card's task and starts it through the Coordinator like
"Start agent" (see Scheduling).

Beside it stands the repository picker of a card before work begins (see Canvases and repositories),
with "New repository …": an idea to be built in a repository that does not exist yet. Its agent
picks that target from the conversation („bau es in ~/dev/super59, eigene Leinwand“) with
`plan_repo` (a folder and whether it gets a canvas of its own; the whole value each time, an empty
folder for none); the picker shows it, and what the owner picks there instead stands, the agent does
not change it. On a canvas with one repository the picker shows only once a new repository is
picked. The button then names the target ("Build it like this in super59 (new)"), with a line under
it on what the click does, and the click builds the idea there (see Building in a new repository).

"Build this prototype" does the same on that prototype's branch: its workspace and branch become
the idea's, and the worker hears that the branch holds a throwaway prototype, to take over what
carries and bring it to production quality (tests, checks, docs, shortcuts removed), with the
prototype's handover and the owner's answers. The decision log says "Build it, on the prototype “…”".
Either way the idea's other prototypes are discarded, so one card remains.

"Plan as a project" starts a worker on the idea's card, shown as "Idea → Project": it writes a plan
doc with workstreams, which lands like any change. Its project (the doc the landed work added to the
plan directory) then takes the idea's place on the canvas (cards in its way move aside), links back
to it and takes over its decisions, showing those of both; the idea goes to the archive once its
worker is done (put back, it stays). A task planned as a project is linked the same way.

An idea's prototypes stay on the canvas while its plan doc is written, without "Build this
prototype": the doc decides. Its worker hears what each showed and the name each goes by (its
variant, else the approach in its title), so the doc builds on them instead of planning them again;
the workstream that builds on the chosen prototype names it by that name in quotes (a word that
happens to be a name names nothing), and no other workstream names or mentions one. A handover
whose doc leaves it unclear (several workstreams name or mention prototypes, one names several, or
one mentions a prototype without naming which, among several) is refused, so the worker fixes the
doc or asks the owner. The moment the project stands, that
workstream takes over the prototype's workspace and branch, without starting: it stays planned (not
"Stopped", though it has a branch) and starts like any other workstream ("Start agent", "Start
all", once what it needs has landed), its worker hearing that the branch holds a throwaway
prototype, as after "Build this prototype". The workstream says "Builds on the prototype “…”", the
decision log says which workstream builds on which prototype, and the other prototypes are
discarded. Where the doc builds on none, or the workstream has been started meanwhile, all are
discarded. Nothing of the idea is left on the canvas.

"Split off a task", when part of the idea is settled and part still open (an app's game logic
settled, its pictures still to be prototyped): the agent marks the settled part (`plan_split`: a
title and a brief that stands alone as a worker's task; the whole value each time, empty when there
is none any more). Only then does the button show, next to "Build it like this", with that task
folded under the brief. The click makes it a task of its own beside the idea, in its group and
linked to it, with the discussion's screenshots and a line saying the open part is not its, and
starts it like "Build it like this" (by voice: `split_off`); the decision log records it. The idea
stays open with its conversation and prototypes; the agent trims the brief to what is open and
replies. It is not a second way to break work up beside the plan doc: always one task and the
remaining idea.

"Park" and "Drop" leave the card with its brief; talking to it opens it again. A parked or
dropped idea can be archived (in it, or its archive button on the canvas; not while a prototype of
it is on the canvas, and then the button is not shown): in the archive it shows its brief and
conversation read-only and can go back to its place. Decisions from the conversation go into the
decision log; lasting preferences are learned by the Coordinator (see Learning the owner's rules).

### Building in a new repository

"Build it like this" or "Start agent" on a card whose target is a new repository (or the Coordinator,
„bau das in einem neuen Repo unter ~/dev/super59“) waits a few seconds in which "Undo", in
the button's place ("Creating super59 …"), leaves everything as it was; the window does not outlive
a restart of Obeya. What can be told at once is refused at once: no folder, a relative one, one that
is a repository of a canvas already, canvases from the command line (nothing could start live). Then
Obeya, one step after the other:

1. creates the folder where there is none and sets git up in it as "Set up a git repository here"
   does (see Setting up git in a folder): local only, no remote, nothing published. A folder that is
   a repository already is taken as it is; one inside another repository is refused.
2. adds it to the configuration: a canvas of its own, unnamed, so named after the folder, which
   starts at once (see Live configuration); without "own canvas" the repository joins the
   card's canvas instead and the card stays there, in it.
3. decides an idea as "Build it like this" does (its agent's session ends, its prototypes are
   discarded, the decision log records the new repository), then moves the card to the new canvas
   whole: its task, conversation, mocks, screenshots and decisions, into the canvas's repository,
   out of its group (groups belong to a canvas). Nothing of it stays on the old canvas, whose sheet
   says where it went with a link there; a card that follows from it, or it from one, names the
   other with its canvas and "Open it there". A page that has the card open follows it to the new
   canvas.
4. starts it there through the Coordinator. Its worker hears that the repository is new and sets it
   up beside the task: a CLAUDE.md with what the task says about working in it, and its settings with
   the `settings` skill (see Writing the settings).

A step that fails takes back those before it (the configuration, the folder or the git it made),
and the card says why.

### While the agent replies

While the agent works on a reply, "Plan as a project", "Split off a task" and "Build this
prototype" wait: the buttons are disabled (their tooltip: "The reply is coming …") and the server
refuses them.
The reply almost always rewrites the brief, so a plan taken before it would start from a brief the
owner never read.

"Build it like this" does not wait: clicked during a reply, the idea is built once the agent has
answered all it was told, with the brief it leaves, unless the reply asks questions; then nothing is
built, the conversation says why, and the owner decides again. Meanwhile the panel stays open, the
button reads "Builds after the reply …" with "Don't build after all" beside it, and the canvas card
says "builds after the reply". The agent hears of the click, as its brief becomes the task. A turn
that ends without a reply (an error, a restart), parking or dropping call the building off.

Asked meanwhile to plan or split off, the Coordinator says that goes by a click after the reply;
asked to build („nimm noch X auf und bau es dann“), it builds after the reply, like the click.

Parking and dropping act at once and end the turn but lose nothing: the messages the agent has not
answered stay with the idea, across restarts, and go to it first, with why its turn ended, when the
conversation goes on. The same holds after a turn that ended with an error and for messages queued
when Obeya stopped.

### Decisions

- **A discussion lives on a card, not in the conversation with the Coordinator** (2026-10-09): an
  exploration parked on the canvas is found there again with its brief, and the Coordinator only
  passes the owner's words on. A question to Obeya asking for an opinion or a way forward becomes an
  idea card when no agent on the open card takes it (see Commands to the Coordinator); a wrong
  guess costs one card, undone with "Undo". Questions of fact stay in the conversation.
- **A big idea becomes a project through a worker writing its plan doc on the idea's own card**
  (2026-10-02), not through the exploration agent, which discusses and does not build. Rejected: a
  separate planned "Plan doc" card in between, which had to be started by hand and left the idea
  standing beside its project.
- **One way to break work up: the plan doc** (2026-10-12). Rejected: "Split", the Coordinator
  cutting a card into packages that replaced it, a second way beside the plan doc; "Start all" on
  a project already plans which workstreams run in parallel.
- **Prototypes are cards of their own, several per idea** (2026-10-02), so parallel approaches are
  seen side by side. The one that convinces is not rebuilt from `main`: the idea is built on its
  branch, its commits stay in the history, and the worker's brief keeps prototype quality from
  landing as it is. A discarded prototype keeps demo, log and summary in the archive, not its code.
- **Planned variants become one prototype each** (2026-10-05). Rejected: the field alone, where
  three empty clicks started three prototypes of the same brief.
- **Planning an idea takes its prototypes along** (2026-10-06). Rejected: leaving them unmentioned,
  where the plan doc planned them again and building on one failed once the idea was archived.
- **The plan doc settles the prototypes, the moment its project stands** (2026-11-06): the chosen
  one goes to its workstream, the others to the archive. Rejected: "Build this prototype" on the
  prototype once the project stood, beside starting the workstream itself. Two ways led to the same
  start, it was not clear whether they differed (starting the workstream directly left the
  prototype's branch unused), and the prototypes stayed on the canvas, the one not chosen too.
- **"Split off a task" builds the settled part and keeps the idea** (2026-10-18), and every step the
  agent suggests is a button whose effect on the rest of the idea its instructions spell out. An
  agent had recommended "Build it like this" plus starting two prototypes, which no button did:
  building dropped the planned prototypes. Rejected: restricting the agent to the existing steps (a
  correct but clumsy route, the settled part waiting), and one button to build and start the
  prototypes (building ends the idea they belong to).
- **"Build it like this" does not wait for the agent's reply** (2026-10-06): the last answer of a
  session is often clear and simple, and the owner knows that building comes next.
- **Mocks in a field of their own** (2026-10-05), beside the brief and the reply. Rejected: HTML in
  their Markdown; this way the agent writes no artifact files, the Markdown renderer stays without
  HTML, and the owner sees simple options without a prototype.
- **A project links the idea it came from** by what the idea's landed work added to the plan
  directory, not by title or time.
- **An idea to be built in a repository that does not exist yet gets it, and a canvas, from one
  click, and moves there whole** (2026-10-28). Its agent picks the target from the conversation;
  the card's repository picker shows and changes it, and the button names it. Obeya sets up git
  itself (as for a folder without git) and moves the card with its brief, conversation and
  decisions, since its exploration agent's session ends with the building anyway. Rejected: a task
  whose worker sets up the repository and copies the brief (it searched other repositories for how,
  waited for an approval, carried the context only as a copy, and the new canvas came without the
  card); only instructing the agents better (the detour would stay).
