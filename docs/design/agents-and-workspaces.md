## Agents and workspaces

A chapter of the [design doc](../design.md), whose header says how it is written.

### Agents

Agents run on one of two harnesses, each the machine's own installation on its own login (the
owner's subscription, no API key): Claude Code through the Agent SDK, or Codex through
`codex app-server` (see Codex). Each group of agents runs on the harness the owner chose for it (see
Harnesses, models and effort). The rest of this section describes Claude Code. The compiled app
runs the machine's own (`claude` on the `PATH`, else `~/.local/bin`, or `OBEYA_CLAUDE`); the
checkout runs the Claude Code binary the SDK brings, unless the machine's own on the `PATH` is
newer, which it then runs from the next look at Claude Code on (as Obeya starts, in the setup
assistant, ten minutes after the last when a menu of models asks, after an update; see Updating
Claude Code). Agents get
Obeya's environment without the marks of a Claude Code session that may have started Obeya
(`CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_PID`) or of what started it (`OBEYA_SUPERVISED`, `OBEYA_FROM_APP`,
`BUN_BE_BUN`), but with `CLAUDE_CODE_OAUTH_TOKEN`, the login of a machine without a keychain. On
such a machine `claude-token` in Obeya's home, once there, takes the variable's place: it holds the
newest token the owner gave Obeya, which the variable Obeya was started with may not.

On Windows, program lookup and additions to the search path preserve the environment's
case-insensitive variable names even in copies of the environment: `Path` and `PATH` name the
same search path. Where a copy holds several spellings, the one that sorts first counts (`PATH`
before `Path`), the one a started program gets. Unix environment names remain case sensitive.

A worker is one session per card with streaming input, permission mode `auto`, and the repository's
Claude Code settings and CLAUDE.md (only once the owner trusted them, see Trusting a repository's
commands); after a restart it resumes by session id. A project agent is one session per project in
the read tree, resumed for each of the owner's questions about the project, one at a time. Project agents, ideas'
exploration agents and the Coordinator's look-ups have a worker's tools and mode (see Looked-up
questions); agents that only judge from text (reading commands, estimates, the learner) are
read-only: Read, Grep, Glob, mode `dontAsk`.

Every session on this machine that is not read-only works in the owner's own Chrome, signed in, with
Claude in Chrome (`--chrome`), when Claude Code's global config (`.claude.json`) shows the extension,
found in a browser profile or paired, and neither it (`claudeInChromeDefaultEnabled: false`) nor
`CLAUDE_CODE_ENABLE_CFC` turns the integration off. There is no setting for it. Elsewhere the session
starts as without it; where the extension does not answer (Chrome closed), its tools report that and
the agent goes on without them.

Every session refuses long foreground sleeps in Bash (see Waiting without blocking). What changed
since a session's instructions were built reaches the agent once, with its next tool call's result
(not a subagent's), without a message or turn: a preference of the owner learned meanwhile; for a
workstream's worker also its project's new decisions and the owner's notes that came during its turn
(see Reading order). A call the settings want confirmed becomes the question the card waits on (see
Refused and confirmed tool calls); Obeya's own tools are allowed by a `PreToolUse` hook.

#### Codex

A Codex session is one `codex app-server` process (JSON-RPC over stdio, its experimental API on),
with one thread: started with the instructions as developer instructions and Obeya's tools as
dynamic tools of the namespace `obeya` (the model sees them as `obeya__<name>`), or resumed by the
thread's id after a restart, since Codex keeps a thread's tools with it. Either way it gets an
explicit model: right before starting or resuming, the session asks its own app server for the
catalog (`model/list`, on the machine it runs on, a host included) and takes the newest model of
the family it is to run on (see Harnesses, models and effort), else the one the catalog marks as
its default; a resumed thread may so move to a newer version. Where the catalog cannot be had
(no answer within half a minute; a Codex too old to list its models, which the card says needs
updating) or has neither, the agent does not start and its card says why:
the model is never left to Codex's own configuration. An effort the model does not take becomes
the nearest one it takes, the higher of two as near. A message to an idle session starts a turn
with the effort of its group; one during a turn steers it (`turn/steer`); one that comes
as the turn ends starts the next. Codex's items reach the card as Claude Code's tool calls would: a
command as `Bash`, a file added as `Write` and changed as `Edit`, Obeya's tools as `mcp__obeya__…`.
What changed since the instructions were built goes with the result of Obeya's next tool, or after
any other step as a message that steers the turn. A repository with a CLAUDE.md and no AGENTS.md is
read as Claude Code reads it (Codex's fallback file names); where its settings wait for the owner's
trust, Codex reads none of its instructions and they come with the system prompt, as for Claude
Code. Obeya's plugin's skills are an extra skill root. The thread starts or resumes once Codex has
fetched its remote plugins' catalog (`plugin/list` answers, about a second after the start; at most
15 s): their skills join Codex's list only then, and a turn begun before has the next one add the
whole list again, some 2,500 tokens the cache does not hold, once per process, so at every resume.

Codex works in its own sandbox: writable are the workspace, the git directory a worktree commits
into, the agent's extra directories and the temporary directory, with the network open; what goes
beyond, Codex's automatic reviewer allows or refuses (a refusal shows on the card as auto mode's
does), and a request it leaves to a person becomes the question the card waits on. Codex's own
question tool gets no answer: the agent asks through Obeya's. Read-only agents run in the read-only
sandbox and are never asked. A turn that fails for Codex's usage limit waits for its reset as Claude
Code's does (the reset of the window used up, from the rate limits Codex reports during the turn); a
missing login offers to log in again on the card (see Conversation on the card).

Codex's hooks tell Obeya of each command and patch before it runs, and after it in a folder without
git, as Claude Code's hooks do: a foreground wait too long is refused (see Waiting without blocking),
a folder's watch reads the folder before the change (see Folders without git). Each session gives
its hooks on Codex's command line (`-c hooks.PreToolUse=…`, `hooks.PostToolUse=…`, for `Bash` and
`apply_patch`), as curl posting what Codex passes to a server on the loopback that only this session's
token opens, and prints the answer. Codex runs no hook it has no trust for, and keeps none for hooks
given that way: the session asks the app server for their hashes (`hooks/list`) and starts its thread
with them trusted (`hooks.state`). A hook that fails (no curl) lets the call run; a folder then hears
of the change as Codex reports it, which may be after it began.

### Harnesses, models and effort

Every agent belongs to one of four groups: the Coordinator (voice commands, estimates and schedules,
look-ups, project agents, learner, retrospective, proposal rewrites), workers, ideas' exploration agents,
and small jobs (the work retrospective's notes and proposals, a shared demo page's text, a card's
title). The Configuration dialog's "Agents and models" sets for each group, in this order, the
harness (column "Runs on": Claude Code or Codex; one not installed or not logged in is shown, not offered), the model
(for Claude Code an alias: Fable, Opus, Sonnet, Haiku; for Codex a model family, Sol, Terra, Luna
and whatever else its catalog for the login on this machine lists) and the effort (low to max, for a
Codex family those its newest model here takes), and marks the presets: Claude Code with Opus
throughout, high effort for workers and exploration agents, medium otherwise. A Codex family shows
by its name (Sol, Terra; Codex Max for `gpt-#-codex-max`; one named only by its version, as `o#`,
by its newest model here, o3) and stands for whatever is newest of it where an agent runs (see
Codex), as Opus does for Claude Code; a version cannot be pinned. Both menus (this dialog's and the
one beside a card's start button) show after each name the version it stands for on this machine,
in the card's menu greyed (Opus 5.5, Sol 6.1): for Codex its newest model's, for an alias the model
Claude Code says it stands for (the one it lists under the alias, else the newest of the family it
lists): the newest of its family Claude Code lists, by its id or under the alias, since a new model
(Fable 5.2) comes listed by its id while the alias still names the one before. An agent on this
machine is then given that model's id instead of the alias where the two differ, so Fable runs on
Fable 5.2; one on a host likewise by what that host's Claude Code lists (see Updating Claude Code and Codex),
the alias as it is until it has said. Claude Code is asked by an idle session of its own
as Obeya starts, again after ten minutes or once its version changed, in the background: until it
has answered, the aliases show without a version and go to Claude Code as they are, and no menu
waits for it. Which version runs shows on a started card's conversation heading, as Claude Code's
does (Codex · GPT-6.1-Sol).
A family is the model id with its version number taken out (`gpt-6.1-sol` and `gpt-5.6-sol` are both `gpt-#-sol`;
an id without a number is a family of its own), so families with other names (`gpt-#-codex`, `o#`)
work alike. Claude Code's default is no entry of its own; Codex's needs none. A family the catalog no
longer lists stays shown as chosen. Another harness starts from its own preset model (for Codex the
Sol family) and keeps the effort. A group the owner chose no harness for runs on Claude Code, unless only Codex is ready on this
machine; there the presets are Codex with Sol, and the dialog's hint says so. Stored in `settings.json` under `agents` (`{ "worker": { "harness": "codex", "model":
"gpt-#-terra" } }`), only where it differs from the preset; a model belongs to the harness stored
beside it, Claude Code's where none is. A Codex model id stored there (or with a card) reads as its
family and `default` as Sol; the next save writes the family. The API takes a model id as well and
stores its family. Saving restarts nothing; agents starting afterwards take it, a
running session keeps its own, except the voice commands' session, which reopens when the
Coordinator's setting changes (as for another language).

A card may run on another harness, model or effort than its group. Joined to each button that
starts a card (and "Accept and start" on a proposed task, "Start anyway" in the queue) is a narrow
part with a triangle that opens a menu: each ready harness's models, as "Agents and models" lists
them, and the efforts the model takes, with what applies checked (the workers' setting until the
card has one of its own). Picking what the workers have is no choice of the card's: it follows
their setting. What the card chose of its own stands small beside the button ("Codex · Sol ·
effort very high"); without a choice nothing does. The choice is the card's, stored with it, and
goes with every session of its next run, the ones resumed after a restart included, and with the
instructions that differ by harness (how a worker waits); what it leaves out is the workers'. It
changes only while the card waits to start (planned, proposed, in the queue); once it is at work the
choice stays as it began.

#### Updating Claude Code and Codex

Which Claude Code is the newest, npm's registry says (the dist-tag of the channel Claude Code's own
settings update from, `autoUpdatesChannel`: `latest`, or `stable`), asked in the background as Obeya
first looks at Claude Code and again after an hour. Where it is newer than the one the agents run
on, the Claude Code part of a card's menu of models and the Configuration's "Agents and models" say
"Claude Code 2.1.322 is out" with an "Update" button (on hover: the version the agents run on now).
The click runs `claude update` on the machine's own installation (it updates one of a package
manager through that manager), or, where there is none (the checkout on the SDK's binary), the
official installer; then Obeya looks at Claude Code again and asks it for its models before the
line goes: meanwhile it says "Updating Claude Code…", after a failure why, with "Try again".
Agents that start afterwards run on the new version, one at work keeps its own.

Codex alike: the newest is npm's `latest` of `@openai/codex` (Codex has no channels), asked once
Codex is found installed, and a Codex behind it gets the same line in the Codex part of the menu
and in "Agents and models" ("Codex 0.167.0 is out"). The click runs `codex update`, which updates
Codex through whatever installed it (npm, bun, pnpm, Homebrew, the standalone installer); a Codex
older than that command (its `update --help` is the general help) is updated by the package manager
it lives in, by its real path: npm's or bun's global packages, Homebrew's cask; any other says it
cannot update itself. Then Obeya looks at Codex again and asks it for its models before the line
goes, so a model that came with the new version is in the menus (and a family's agents run on it,
see Codex). Obeya looks at both again ten minutes after the last look when a menu of models asks,
so one updated on the command line shows its version and models then.

Sessions on a host run that host's own `claude` and `codex`, which Obeya looks at over the
connection, each host the configuration names: as Obeya starts, again ten minutes after the last
when a menu of models asks, on a host that did not answer once it does. The look asks for each
one's version, for Claude Code also for the channel its settings there update from, whose newest
npm says (asked from this machine); an idle Claude Code session started there, as here, lists its
models, which an agent there then runs on (an alias as the newest of its family; a Codex agent
there picks its family's newest from that host's catalog as it starts). A host whose Claude Code or
Codex is behind gets a line of its own under this machine's, in both places: "Claude Code 2.1.322
is out, build-box has 2.1.300" with an "Update" button that runs `claude update` (or Codex's update
as here) there, then looks again and asks for the models, with "Updating Claude Code on build-box…"
meanwhile and why it failed after a failure. A host without the harness, or one that has not
answered yet, shows no line for it.

### What agents cost

Obeya counts what every agent on a canvas costs, whether or not the owner has costs shown: after
each turn its harness reports the session's estimated cost in US dollars so far, a running total
(Claude Code's `total_cost_usd` on each result, its own estimate at API list prices; for Codex the
thread's tokens from `thread/tokenUsage/updated`, priced at OpenAI's list prices in a table Obeya
keeps, `src/server/prices.ts`). A session's cost is its latest total; a total below the one before
means the harness started counting afresh (a resume without the earlier total, a cleared context),
and what it had counted stays. The cost of an agent working for a card (its worker, an idea's
exploration agent, a project's agent, the rewrite of its proposal) counts to that card, any other
agent's (the Coordinator's, the small jobs') to the canvas alone. Kept per session, by canvas and
card, in Obeya's database, with each card's sum on its row.

Codex prices input uncached, cached or written to the cache, and output with its reasoning, at the
standard tier for prompts up to 272K tokens; the surcharge for longer prompts, which applies per
request, is left out (the thread's total does not tell the requests apart). A model the table lacks
takes the price of the newest of its family the table has, else of the Sol family's, as Claude Code
prices a model it does not know at its default's. A thread priced at the model it runs on now, all of
its tokens are, also those of a resume on an older version of its family.

"Costs" under Configuration → General shows them (off until then; `costs: true` in `settings.json`
in Obeya's home), on every open page at once: a card's beside its conversation heading, after what
it runs on ("≈ $2.47"; below a cent "< $0.01"), a project's in its sheet under the plan doc (its
project agent's and its workstreams', archived ones included) with each workstream's in its line,
and the canvas's in the bar (see The bar). Each says on hover that it is an estimate at API list
prices, which on a subscription is what the same work would have cost through the API, not what is
billed. The phone view shows a card's figure as the desktop does; its bar has none.

### Workspaces

A card works in a worktree of its own, unless the repository's settings say clones or its
configuration names some (`clones`, `workspaces` or `hosts`). Worktrees: any number in parallel
unless the repository has `slots`. Clones (for tools that break in a worktree, or an app stack per
clone): a pool, each clone leased by one card. `clones` is how many Obeya makes in its own directory
(`workspaces/<canvas>/<repo>/1..n`), on top of the existing ones `workspaces` lists (on the command
line `--clones <n>`, `--workspace <path>`); the Configuration dialog shows the sum. Where work lands
on the local main, the checkout itself is never one of them, even where `workspaces` lists it (see
Decisions). The dialog does not count it and says why; listed alone, the cards work in worktrees, as
without the list. A card keeps its workspace across stop and restart until its work has landed and
its worker finished what remains.

Starting a card does not block the server: the workspace is taken at once (so slots and the queue
see it taken), and git makes it ready in the background: `git worktree add` (a minute in a large
repository on Windows), or a clone's fetch and checkout of the card's branch (over SSH on a host;
no fetch where the clone's `origin` is a repository on this machine whose branches and tags the clone
has already),
the temporary worktree of a finished card's question likewise. Meanwhile the card is at work, its
status line "Preparing the workspace …"; it holds a slot, a restart waits for it, and the
owner's words wait unread until the worker starts with its task. A card stopped meanwhile gives
the workspace back once git is done. Where git fails, the workspace goes back, the card returns to
where it was (planned, its snooze gone, the words kept for its next start) and its conversation
says why; a clone git failed on is passed over for a while, like a dirty one, so a fetch that keeps
failing does not take it again and again.

Choosing a clone does not block the server either: `git status` in each free clone takes a while in
a large repository, and over SSH on a host. Obeya chooses by its last look at each free clone (clean,
uncommitted changes, or not there, its host unreachable), which git takes in the background (writing
no index, see below): when a clone is given back, and again when a look is older than a minute (half
a minute where it found the clone not clean, so a waiting card takes a clone within a minute of it being put right) as Obeya
looks for a free clone (at every change of the board while cards wait for one, and every minute). A clean clone goes first, then one not
looked at yet; a look that changes the answer changes the board, so a waiting card takes a clone
turned clean. The clone a card takes is looked at again before it works there (a look that began as
it was chosen is that look): one no longer clean
is given back and the next one taken, and where none is left the card goes back to planned and waits
in the queue as when none is free at once. What else Obeya asks git about a card's workspace runs in
the background as well: whether it holds work (uncommitted changes, commits beyond the main branch),
where its branch left the main branch, and the plan docs its branch adds.

Where Obeya only looks at a repository (a free clone, a card's workspace while its agent works there,
the owner's checkout before a landing or before taking over settings, Obeya's own checkout for its
update), git writes no index. A plain `git status` or `git diff` refreshes the index and writes it
under git's index lock, and a git command another process needs the lock for meanwhile fails: a
card's checkout of the clone it took (the card would go back to planned), an agent's commit, the
owner's own, Obeya's landing. `git diff` against the working tree, its refresh turned off, names a
file whose timestamps alone changed (one a formatter wrote back as it was) as well; such a file
counts as changed only where its content differs. Where Obeya changes the repository itself
(committing a taken card's uncommitted work, a landing's rebase), git refreshes the index as part of
that.

A stopped card is planned at once and gives its workspace back once git has said that it holds nothing (not if it started
again meanwhile); an approval ends the owner's turn at once, the card landing, and
lands the work, opens the pull request or closes the card once git has told which; a handover is
recorded once git has told whether it changes anything.

The pool is what the configuration names. A clone no longer named leaves it: a free one at once, a
leased one when its card gives it back (no card moves mid-work). A clone Obeya made is then deleted
from disk, after its app stopped (see Parking), if nothing would be lost: no uncommitted or untracked files
(ignored ones aside), no stash, no submodules, no worktree from it in use, and no branch, tag or
detached HEAD with commits on no branch of `origin` (fetched with pruning), unless its changes are on
`origin`'s main branch already or it is a tag `origin` has too (a release tagged on a branch since
deleted). Changes count as on the main branch where merging the branch into the main branch's head
changes nothing, or, where that merge conflicts, merging it into one of the main branch's last 50
commits that changed the branch's files does (with a git before 2.38: where each file it changed is
there as the branch has it): a branch squashed or rebased in its pull request counts as landed, also
once the main branch changed the same files again. A merge into the head that is clean but changes
something ends the search, so work not landed costs a handful of git calls, not one per commit (over
SSH each is a round trip). Where work lands on the local main, `origin` is the Obeya checkout. The folder is moved aside first, so a
clone named again meanwhile (here or by another canvas) is never removed under a card. Otherwise it
stays: the log says once what lies in it, the pool's list shows "stays, as work not landed lies
there:" with what (a branch or tag by name with how many commits, uncommitted changes, a stash) and
the path, and a later start looks again; raising the number takes it back as it is. Clones the owner listed, and folders on a host no longer configured, are never touched. A
workspace on this machine whose folder is gone (moved or deleted by hand) and that the configuration
no longer names leaves at once, clone or worktree, held or not: its card names no workspace any
more, one at work is planned again, its log says so, and its next start takes another. Only a
card's own worktree, where the repository makes them, stays the card's.

A card gives its workspace back once it will not work there again, checked at every board change and
at start: deleted; a workstream no worker is on once the plan doc on the default branch ticks it off
or no longer has it; or a lease that outlived its card's work (finished and its worker done, or the
card names another workspace). A clone keeps the card's branch and the rest and is free for others
once clean; a worktree goes once nothing in it is uncommitted, its branch kept. A deleted card
brought back with the undo takes its clone back if still free, and git puts it back on the card's
own branch, since another card may have worked there meanwhile. Where git cannot (that card left
uncommitted changes there, say), or the clone is taken, the card holds none and its next start
takes a clone as after a taken workspace (below), with its branch from that one where it still
holds it; it never works on another card's branch.

#### Taking a card's workspace

While every clone of a repository is taken (or blocked) and a card waits for one (or a finished
card's question for a clone), the pool's list has a faint "⋯" beside each card that holds a clone
and is at work, waits for the owner, or was stopped with work in it (not a card whose work landed,
nor a prototype). It opens "Give to the waiting card" with a sentence on what that does. A click
there gives that clone to the card waiting longest: after eight seconds in which "Undo" (in
the confirmation, and in the row, which says "giving it up") takes it back, the card's worker stops
as with "Stop", the app in the clone stops (`app.stop`, whatever `app.keep` says, since another
card works there next), and what is uncommitted there (untracked files too, ignored ones aside)
goes into a commit of Obeya's on the branch, marked by the trailer `Obeya-Kept: uncommitted work`.
The clone is then free and clean; the card is planned without a workspace and remembers the clone
that keeps its branch. A card whose worker was on it waits in the queue for a workspace, behind the
cards that waited already, and starts again once one is free; a card stopped before stays planned.
Its next start takes that clone if it is free, else another on the same machine (git takes the
branch from one clone to another only there, so the card waits for one of that machine's): the
clone fetches the branch from the one that kept it, which then drops its copy, and the commit of
Obeya's is taken apart again, its work uncommitted as before. The worker is a new session, as with
"Start again", told that the branch holds earlier work, perhaps uncommitted. The undo window is not
kept across a restart of Obeya: the card then keeps its workspace. Repositories in worktrees have
no such button: a worktree is the card's own, and a card waiting for a slot gets one when a busy
worker is paused or stopped.

Giving a workspace back does not block the server either: in a large repository (a checkout of
thousands of files) or over SSH, git takes a while to look into a worktree and remove it, to remove
a landed card's worktree and branch, to put a discarded prototype's clone back on the main branch
(its changes and branch thrown away), or to rename the branch of a prototype an idea is built on.
Git does all of it in the background, one step after the other on the same workspace, and the
workspace stays taken until git is done with it: no other card takes a clone half cleaned, and a
card's worktree made again meanwhile is added once the old one is gone. The card itself moves at
once (a discarded prototype into the archive, a deleted card off the canvas), and the pool shows the
workspace free once git is through; a restart waits for git as for a landing. Landing finds the
main branch the same way, without blocking.

#### Slots

Workers in clones are capped by slots, not clones: a slot is room for one busy worker (in a turn or
waiting for background work), counted per machine and repository (`slots` here, per host for the
others; as many as clones when left out). A new card takes a clean free clone on the first machine
(this one, then the hosts in order) with a slot left; with none, it waits ("Waiting for a free slot")
until a turn ends somewhere. A card holds its clone until its work lands, a slot only while its
worker is at work. A message to a waiting card is never held back for a slot, so a machine may go
over its slots for a while. A repository in worktrees can have slots too (in the Configuration
dialog under its row), which cap its busy workers the same way; left out, there is no cap.

#### A finished card's question

The owner's question to a finished card waits for neither slot nor clone. It takes a clean free
clone if there is one, else a temporary worktree (hooks off) detached at the head of the card's
branch, from the clone here that holds the branch or else the configured checkout (at `origin`'s
copy of the branch, else the default branch), under
`follow-up/<card>` in the repository's workspaces directory, removed when the follow-up ends. Its
worker is told the app stack may not run there; if it needs it, it calls `need_clone`, tells the
owner with `reply` and ends its turn, and the card waits for the next clean free clone ("Waiting for a
workspace"), ahead of queued cards, where its session resumes by itself; what the owner says
meanwhile waits for it.

#### The pool in the bar

For each repository in clones the top bar shows the pool ("Workspaces"): per machine (named once
there is more than one) a dot per clone, solid while its card's worker is at work, pale while merely
held, orange while free but blocked, and how many new cards could start ("2 free", "all taken",
"none free · 1 blocked"). A click (a tap) drops down a list, closed again by a click beside it,
Escape or another click on the pill: per machine its slots at work and clones taken, then each workspace on a line of its own, free ones included, with its path
(cut at the front where too long, so its end stays readable), the dot the pill shows for it, and
the card in it, "free" or "blocked"; then how many cards wait for a workspace or a slot. While
none is free and a card waits, "⋯" beside the cards whose clone may go to it (see Taking a card's
workspace). The card
is a link: a click closes the list, flies to the card and opens it; for a card on another canvas
the page switches to that canvas at the card's address (see Addresses in The canvas), which opens
it once the canvas has loaded. A card not on any canvas (archived, say) shows by its title without a link. A
repository in worktrees shows a dot per slot, and none without slots (no pill if all are so); its
list names the cards' worktrees.

A free clone is blocked when the last look at it (see Workspaces) says no new card gets it: it has
uncommitted or untracked changes (the list names the first five files), git fails in it, its
folder is missing, its machine does not answer over SSH (one line per machine), or git failed making
it ready for a card in the last minute. Blocked clones do not count as free, and the list says in
orange, per clone, why and what puts it right: for uncommitted changes, the card whose branch the
clone is on (a link, as in the rows) and whether its work has landed, and "Commit to a new branch
and free the clone" (see Leftovers in a free clone); repair it, or delete a clone Obeya made, which its next start
makes again; clone it again or take the path out of the configuration; check the network and SSH
access. Showing the pool looks again, in the background, at free clones whose look is old by the
same measure or that were never looked at, so the pill tells before a card waits what a waiting card
would find. A card queued for want of a workspace points to the pill for the reason.

#### Leftovers in a free clone

What a card leaves uncommitted in its clone (files of a landed task, a generated file a tool wrote
back with other line endings) would keep every other card out of it. "Commit to a new branch and
free the clone" on such a clone's line in the pool's list, with a line beside it saying where the
changes go, puts it all (untracked files too, ignored ones aside) into a commit of Obeya's, marked by
the trailer `Obeya-Kept: leftovers`, on a branch of its own in that clone, `obeya-leftovers/<branch
it was on>-<date>-<time>` in the machine's local time, made from the commit checked out (a file
staged otherwise than the working tree has it first gets a commit of its own as staged, so neither
is lost); nothing is pushed. The clone is then clean on the branch it was on (submodules' working
trees untouched), and a confirmation names the branch. Changes of line endings alone, none of them
staged, are dropped without a branch. A clone with files marked assume-unchanged stays as it is,
with a message: `add` leaves those out and the reset would overwrite them. It takes effect at once,
without an undo window: the work is on the branch. A clone Obeya made is freed so by itself once a
card would take it but for the leftovers (a card starting or waiting finds no clean free clone),
once for the changes as it found them, the first such clone not tried already, so one that could not
be freed does not keep a card from the next; the line beside the button says so. A clone the owner
listed is freed only by the button, since it may be one they also work in by hand. The button acts on
the clone of the machine its line is under, never on one with the same path elsewhere. The leftovers' branch is
work not on `origin`: a clone holding one stays on disk when it leaves the pool (see above).

### Folders without git

A repository may be a folder that is to stay without git: a family archive in a cloud drive, where a
`.git` would mean sync conflicts and copies of every scan. Its configuration entry says `"git":
false`; the first canvas and "+ Repository" offer it beside setting up git (see Setting up git in a
folder). It has no branch, landing, pull requests, prototypes, hosts or clones, and the UI offers
none of them (nor "Take over into the repository for everyone": `.obeya/settings.json` is written
into the folder like any file). The folder is its own read tree, its plan docs, settings and Claude
Code configuration read as they are; a plan doc "Plan as a project" writes is named at the start, as
in a plan folder outside the repository, since nothing of it lands.

Every card works in the folder itself, any number at once. Nothing lands: approving makes the card
`done` ("Approved. The changes stay in the folder: done."). The worker is told others work
in the folder at the same time and that the card lists what it changed; a demo is needed only where
something can be seen (an HTML artifact for a draft).

**Each card's changes.** Obeya keeps a manifest of the folder (path, size, mtime, ctime, inode),
skipping what Finder, Drive and office suites keep for themselves. A tool call that may write (not
Read, Grep, Glob and the like) opens a window from its `PreToolUse` to its `PostToolUse` hook; the
folder is read before and after, and each change goes to the cards whose windows were open at its
ctime, which no tool sets (a deleted file by its directory's). So a change is a card's own even while
others, a scanner or the sync client change the folder; one outside every window is no card's, and
one during two cards' calls is listed by both and undone by neither. A shell command whose line
writes no file (each of its commands only reads, prints or waits, such as `sleep 30; wc -l
out/export.csv`, and no output goes into a file) opens a window too, but what changes in it alone may
come from another program (a nightly export landing while the agent waits for it): the card keeps it
apart as uncertain, below its own changes under "Changed meanwhile, perhaps by another
program", never as its result, its size or what discarding puts back. A writing call open at the
same time, of any card, takes the change instead; the card's own later change of such a file makes
it the card's, from as it was then; an uncertain change of a file the card changed leaves its entry
as it was, so undo finds it changed since. A command that may write keeps all it changes, whoever
else wrote meanwhile. The window opens at a time read
off the ctime of a file Obeya writes then, since Linux stamps ctime from a coarse clock up to 10 ms
behind the system clock. An editing tool's call reads only its file; a script's call reads the whole
folder (0.3 s for 4,615 files). Background work keeps a window open; the end of a turn closes any
left open. A file only in the cloud (dataless) is never read, hashed or copied, which would download
it. Per path, a card's change runs from before its first change to after its last (added, changed,
moved, deleted; a moved directory is one move), with a hash of what it wrote, kept after the card is
done. Agents that only read (the Coordinator, project agents) are not followed. A Codex worker's calls are
followed through its hooks the same way (see Codex).

The card shows the list in the place of its branch ("Changed in the folder: 4 files +12 −1 ·
Undo: full"), whose size shows it over the page with diffs of the text files whose
earlier version Obeya kept, and in full as the change list at the top of its left column (see The
files beside the demo), with what discarding would leave. Where the card shows no files beside its
conversation (before its first handover), the same list stands above the conversation, a click on a
file's name or line counts opening its diff, with "See the whole diff" beside it.

**Undo.** "Discard changes" on a card waiting for approval puts back what the card changed after
eight seconds in which the button counts down and a hint beside it says a second click calls it
off, since this undo cannot
itself be undone. Before a card's first write, Obeya prepares it under `undo/<canvas>/<repo>/<card>`
in its home: where the file system clones (APFS `clonefile`, reflink on btrfs and XFS; probed with
`COPYFILE_FICLONE_FORCE`), a clone of the whole folder, sharing bytes until a file changes (8.1 GB in
0.86 s, no space taken): full undo. Elsewhere (another volume, NTFS, ext4, Windows' ReFS and Dev
Drive, which Bun reaches no clone call for), copies of the text files: partial undo. An editing
tool's file is also copied just before its first write. Undo deletes added files, puts back changed
and deleted ones from the copy matching their state before the card (size and mtime), then reverses
moves. It leaves alone a file changed after the card (ctime, inode and hash or size and mtime differ
from what the card left), one with no copy, and a change two cards shared: the log names them, the
list keeps them, and the worker hears of them with its next message. Before the owner decides, the
card says which undo it has and what discarding does with each entry. The undo goes when the card is
done or discarded, and is made afresh if its worker goes on.

### Parking

A card waiting for the owner (handed over, asked, pull request open), its worker idle, has the app in
its workspace stopped after five minutes, so a quick reply does not pay for a restart
(`OBEYA_PARK_GRACE`, in seconds, for demos and live checks). Obeya runs the settings' `app.stop`
there (once the owner trusted it, see Trusting a repository's commands), unless `app.keep` exits 0
(the app holds data that must stay; the card says it keeps running). An app the owner opened from the
card runs at least 30 minutes (see Trying the app by hand). The card's log says the app was stopped,
and the next message to the worker tells it to start the app again as the recipe says; a message
arriving during the stop waits for it. A failed stop is an error on the card; the worker hears
nothing of it. After a restart,
waiting cards are parked the same way. Only processes go; the workspace stays the card's.

A stop command whose script the workspace lacks (`node .obeya/app.mjs stop` on a branch older than
the script) does not run: nothing of it can run there, so there is nothing to stop, no error and no
"stopped" on the card. The script is the program itself, given by a relative path, or the file a
runtime or shell runs (`node`, `python`, `sh`); the command's other words are not looked at, since a
missing one says nothing (a file of process IDs it reads, an address like `localhost:3000/stop`, a
log it writes). The same holds for `keep`.

Before a workspace's folder goes from disk (a worktree once its card has landed, was discarded or is
done with it, a follow-up's temporary worktree, a clone left the pool), `app.stop` runs in it, and
then Obeya ends every process still running from the folder, with what each started, wherever that
works: one whose program lies in the folder, whose working directory does, or whose command line
runs something there (its program, or what a runtime is given: `node /ws/node_modules/vite/bin/vite.js`).
A command line that only names a file there is not enough (an editor with one of the folder's files
open, an `ssh` session naming the path), nor is a working directory there for a shell that waits for
input (a terminal opened in the folder): those are someone's, not the app's. The folder is matched by
its path and by the one its links lead to (macOS reports `/var/…` as `/private/var/…`). Obeya's own
process, those that started it and those it started itself are spared (on another machine, the
shell that lists the processes there); a card's agent has ended before its folder goes. A clone
that left the pool is looked at for files that would be lost once its app has been stopped and its
processes ended (an app may save its state as it ends), and stays where there are any. Decided
2026-11-06, after a card's app ran on for days: the stop command finds only what its own
bookkeeping names (a file of process IDs written at the start, which an app started otherwise
lacks, or which went first), and on Windows the files a running process holds keep the folder from
going, so the removal stopped halfway with the bookkeeping gone and the app still running. The
working directory is part of the match since a dev server often names its folder nowhere else
(`node index.mjs` started there). Windows tells another process's working directory through no
command, so Obeya reads it from the process's own memory, in a thread of its own (on a machine
short of memory each read may wait for the disk): first for the processes started since the folder
was made, then for older ones (which can only have moved into it later) while 25 seconds have not
passed; a listing that does not answer within 30 leaves the folder to go without it. Rejected:
matching command lines alone (misses such a server), and asking each repository's stop command to
be thorough (a fault in one leaves its apps running).

### Resting agents

Every agent session (a card's worker, an idea's exploration agent, a project's agent, the
Koordinator's) gives up its process once it has waited with nothing running (its turn over, no
other turn to follow, no background work of its own) for 65 minutes, past the hour Claude Code keeps
the prompt cached, on Codex alike (`OBEYA_REST_AFTER`, in seconds, sets it, for demos and live
checks). The next message resumes the session by its id, as after a restart, in
a process on the same instructions, tools and model; the card and the agent see one conversation
throughout, and nothing on the card says the process was gone. A resumed Claude Code session takes
its first message once its MCP servers are all listed (Obeya's own among them) and none is still
connecting, at most after 15 s; claude.ai's connectors take one to two and a half seconds. What the
agent started outside its background tasks (a server sent off with `&`) runs on, as after a
snooze.

Resuming costs no more tokens than the process kept would have. Claude Code on a subscription
writes every prompt to the one-hour cache (an API key's five minutes are shorter still): past the
hour, the kept process too writes its whole conversation to the cache again with its next request,
and the resumed one writes the same amount (measured: 81,315 and 81,278 tokens for a conversation
of 81,000, and alike after it). Within the hour a resume reads the whole conversation from the
cache: 666 of 669 sessions Obeya's restarts resumed over a week did (the other three resumed on
instructions Obeya had built anew; a resting session keeps its own), as did every controlled
resume of `scripts/measure-resume-cache.ts`, which runs a session kept against one rested, with
the same messages after the same pause. Codex's cache has no fixed lifetime: after four hours one
session read its whole conversation from it and another nothing, and earlier sessions on the same
machine read it all after ten hours and nothing after two (measured 2026-11-09). A resumed Codex
session reads it as well as the process kept: all of its 42,000 to 80,000 tokens after pauses of
2, 30, 65 and 120 minutes and four hours, where the kept one missed once. Waiting for the MCP
servers is what makes a resume cost the same: one that takes its message before claude.ai's
connectors are listed and connected has Claude Code tell the agent their tools are gone and, once
they connect, back again, about 2,300 tokens a kept process never pays; the status Claude Code
reports lists those connectors only after a moment, before Obeya's own server. On Codex, waiting
for its remote plugins' skills does the same (see Codex).

### Hosts

Other machines a repository's workers run on, over SSH. The configuration lists them per repository
(`hosts`: name, SSH target, directory for the clones, number of clones and of slots); the
Configuration dialog edits them as table rows under the clones, as the Coordinator's `configure` does
by voice. Only a repository in clones that lands through its remote can have them; a name means one
machine across the configuration. Obeya clones the repository there in the background (retrying an
unreachable host every two minutes, logging a failure once until it changes) and registers each clone
as `ssh://<host>/<path>`; a new card goes there when the machines before it have no slot (see Slots).

#### Running there

Every git call, stack command and worker session (Claude Code, or Codex's app server, whichever its
group runs on) in such a workspace runs there through `ssh`,
unseen by its callers: `ssh <target> exec sh -c '…'` with the installers' directories on the `PATH`;
`exec`, so a shell that forks for a command (dash) does not stay as the session's parent under
another pid. One shared connection where `ControlMaster` exists (not Windows), its sockets in
`/tmp/obeya-ssh-<uid>` for the owner alone, since whoever reaches a socket uses its connection;
`BatchMode`; keep-alives that notice a dropped link within 45 s. The server never waits on a call
there: each runs beside its other work. A host whose connection failed counts as unreachable until a
call there answers again (the pool's next look at its free clones, a minute on, say); then waiting cards look
again.

#### Logins and files

Nothing secret is stored there: the repository's GitHub login (from `git credential fill` here, read
in the background, see Stalls) and
the Claude login (`claude-token` in Obeya's home, from `claude setup-token`, else
`CLAUDE_CODE_OAUTH_TOKEN`) travel as the first line
of stdin of each command and session (a Codex session gets no Claude login); the clones' credential helper reads `GH_TOKEN` (after an empty
helper, so macOS's keychain does not keep it). The clones are marked trusted in the host's
`~/.claude.json`, since nobody answers the folder dialog there and the repository's own permission
rules would not apply.

The session runs through the SDK's `spawnClaudeCodeProcess`: Claude Code started over `ssh`, with
Obeya's tools and hooks over its stdin and stdout. Before a host's first session, the plugin and the
`playwright-core` its demo skill needs go to `~/.obeya/remote` there (again when changed), with the
owner's demo settings without a key file (no API key goes to a host) and without the demo directory
(a path of this machine: demos there go into the host's `~/demos`, which the brief names), and that is the session's
`OBEYA_HOME`. Its `OBEYA_URL` is a port forwarded
(`-R`) to a server of Obeya's that answers only narration clips, inline as base64, and hearing such
a clip back for its captions' times, so demos rendered there get the owner's voice, which only this
machine runs. A Codex session's hooks reach their
session's server here through a port of their own forwarded the same way.

Codex there runs on the host's own Codex login: none travels, since Codex keeps its login as a file
whose refresh token it renews, and one login used on two machines would end the other's. When it
lost it, the card's "Log in to Codex" renews it there (see Conversation on the card).

Screenshots in the owner's message are copied to `~/.obeya/remote/images` there and named by those
paths, as are the copies of dropped files whose paths the message holds (to `~/.obeya/remote/files`;
a file named by its own path stays on this machine, out of the worker's reach); a demo named in a handover is copied here (`<home>/hosts/<host>/<path>`) afresh at each
handover and served and shared from that copy (a path with `.` or `..` is refused, since the copy
replaces what lies at its place); the work retrospective reads
transcripts from there; gh runs here, on the pull request's URL.

#### A dropped connection

A dropped connection (ssh's exit code 255), or a host unreachable before the session starts, ends the
session as a restart does: the card says so, Obeya asks every 30 s whether the host answers, then
resumes the session by id with the message not yet taken, or word of the drop if it was at work (a
session that never started there starts anew with its first message); a
card waiting for the owner needs no session until their next message. The resumed session first ends
the one the drop may have left running there, by the pid it wrote, never itself (a restarted host,
a container say, reuses pids). A host needs git, Claude Code or Codex (with its own login and curl
for its hooks), and what the repository's work needs.

### Decisions

- **An idle agent's process goes once its prompt cache has expired, not sooner** (owner, 2026-11-09):
  waiting sessions held memory for nothing (15 sessions 3.9 GB on one day, five of them older than
  a day 661 MB), and resuming must not cost more tokens than keeping the process. Ending it before
  the cache expires would have the resumed session write its whole conversation to the cache again,
  where the process kept would have read it. Measured first, against a process kept (see Resting
  agents). Rejected: a shorter idle time (pays the cache again); resuming without waiting for the
  MCP servers (about 2,300 tokens more per resume); a setting (the time follows from the harness,
  not from taste). Codex goes after the same 65 minutes (owner, 2026-11-09): its cache has no fixed
  lifetime to wait for, and a resumed session reads it as a kept one does, once Codex has listed its
  remote plugins' skills before the first turn. Rejected for Codex: 24 hours, OpenAI's longest
  retention (memory held a day for nothing).
- **Costs are opt-in, and counted while hidden** (owner, 2026-11-08, GitHub issue #66): the figures
  make the interface busier for something most owners never need, so a setting shows them; counting
  them all along means turning it on later shows what the cards cost from the start.
- **Codex's costs from a price table Obeya keeps** (owner, 2026-11-08): Codex reports tokens only.
  Rejected: showing token counts for Codex (no figure to add to Claude Code's dollars), and showing
  nothing for Codex. The table needs keeping up as OpenAI changes its prices.
- **A session's cost is its harness's running total, not a sum of turns** (2026-11-08): Claude Code
  reports the total so far after each turn, and a resumed session goes on from it, so adding the
  turns would count the earlier ones again.
- **Claude in Chrome for every session here that may act, without a setting** (2026-11-05): a card
  can then read what only the owner's login shows (a dashboard, a console). Claude Code turns it on
  in a session started from a program only with `--chrome`, whatever its own settings say. The flag
  goes only where Claude Code knows the extension: on a machine without it the flag would still
  have Claude Code write its native-host manifests for all seven browsers it knows (creating their
  folders, on Windows their registry keys), and it would override an owner's "off". Rejected: the
  flag always (those side effects); a setting or a choice per card (nothing to decide for whoever
  has the extension); finding the extension in the browsers' profiles (macOS refuses reading
  Chrome's folder to most processes, and Claude Code records what it found in its config anyway).
  Checked with the extension unreachable (its socket and bridge blocked): the session started as
  fast as without the flag, and its Chrome tools said the extension was not connected.
- **Codex through its app server** (2026-11-03, GitHub issue #52): one `codex app-server` per
  session, Obeya's tools as dynamic tools. Rejected: `codex exec` per turn (no tool calls back into
  Obeya, no steering, a process per message); the Codex SDK, which wraps `codex exec`; Obeya's tools
  as an MCP server over HTTP that Codex connects to, which needs a port, a token per session and
  resuming the connection after a restart, where dynamic tools come with the thread.
- **Codex's hooks come on its command line and post to the session over the loopback**
  (2026-11-04): they run before a command or patch and Codex waits for them, so a refusal and a
  folder's copy come before the change. Their trust comes from `hooks/list` at each start, since the
  hash of a hook naming its session's port and token changes every time. Rejected: interrupting the
  turn when Codex reports a command started (part of it may have run by then); Obeya's own binary
  as the hook (a host has none, and Bun starts slower than curl); trust written into the owner's
  Codex configuration, or `bypass_hook_trust`, which would also run hooks the owner never trusted.
- **Codex on a host runs on that host's own login** (2026-11-04). Rejected: carrying this machine's
  `auth.json` along as the Claude token travels, since Codex renews its refresh token and the copy
  there would end the login here (or the other way round).
- **Codex logs in again from the card in the browser** (2026-11-04), through the app server's
  ChatGPT sign-in, whose page returns to a port on the machine Obeya runs on (forwarded for a host).
  Rejected: a terminal with `codex login` (the UI sends the owner to no command line, and on a host
  it would not reach the sign-in's return); the device-code sign-in, which works from a phone but
  has to be switched on in ChatGPT's settings first.
- **A card's own harness, model and effort are chosen in a narrow menu part of its start button and
  kept with the card** (2026-11-04): starting stays one click on the group's setting, and a card
  picked for another (a hard one for a bigger model or more effort, one for Codex to compare) keeps
  it for every session of its run. Rejected: a part of the button naming the group's setting on
  every card (owner, 2026-11-04: too prominent for what is rarely wanted); the choice in a menu that
  starts the card at once; changing it while the card works (a session cannot move to another
  harness, and a model changed between turns would not be what the owner saw it start with).
- **Harness, model and effort are set per group and per card, nowhere else** (owner, 2026-11-05):
  the two levels cover what the owner picks in use, and each further level makes it harder to tell
  what a card will run on. Rejected: defaults per canvas and per project over the machine-wide
  ones; a recommended model per card, from a size estimate, shown beside the default.
- **Claude Code and Codex are the only harnesses** (owner, 2026-11-05): there is no clear need for a
  third one, nor for local models where no harness brings them. Should one be wanted, GitHub
  Copilot comes first, through its CLI's ACP (`copilot --acp`), with the models the plan and the
  organization's admin allow: it reaches developers whose company allows only Copilot, where
  opencode's and pi's users overlap with Claude Code's and Codex's, and ACP would open the door to
  other agents that speak it (opencode, Gemini CLI). Against it then: the CLI is off in an
  organization until an admin enables it, usage-based billing (since June 2026, $19 of credit a
  month on Business) is used up by a few long parallel cards, and whether ACP resumes a session
  after a restart and reports the usage for the bar is unchecked.
- **Codex models are chosen by family, and every Codex start passes an explicit model** (owner,
  2026-11-06): the owner picks a family by name (Sol, Terra), as Claude Code's aliases, and an
  agent runs on its newest version. What an agent runs on must not depend on the local Codex
  `config.toml`, which may name a model the login's catalog lacks (`model_not_found`), so without a
  catalog to resolve the family against the agent does not start. The family resolves in the
  session, against the catalog of the machine the agent runs on, since a host's login and Codex
  version may list other models than this machine's. Rejected: a "Use Codex settings" entry
  deferring to Codex's own configuration (nobody needed it); starting without a model where the
  catalog cannot be had (the same `model_not_found`); resolving the family from this machine's
  cached catalog before the start (wrong for a host); storing model ids, which pin a version the
  catalog later drops; Codex's whole list, or its versions side by side (only noise); "Claude Code
  default" and "Codex default (GPT-6.1-Sol)" as entries beside the models (the default named twice).
- **The harness column is called "Runs on"** (owner, 2026-11-03), under the title "Agents and
  models", which names the rows. Rejected: "Harness", jargon beside that title; "Tool",
  which agents' commands are called already, and which undersells a coding agent.
- **Codex in its sandbox with its automatic reviewer** (2026-11-03): the counterpart of Claude Code's
  auto mode, and what Codex's own users get by default. Rejected: full access without approvals,
  which drops every check; the owner answering every escalation, which would ask about each
  `bun install`.
- **The checkout runs the machine's own Claude Code once it is newer than the SDK's** (2026-11-10):
  a new model comes with a new Claude Code, which the SDK's binary got only with a new SDK in
  `package.json`, so a model released that day stayed out of the menus however current the
  machine's installation was. Rejected: following the SDK's releases with dependency updates alone,
  which lag behind the installation the owner updates anyway; the SDK's binary for good, which the
  app gave up for the same reason.
- **An update of Claude Code at the owner's click** (owner, 2026-11-10), shown where models are
  chosen. Rejected: updating by itself, which Claude Code does in interactive use and may be turned
  off there; a pill in the bar, which Claude Code's near-daily releases would keep there.
- **Codex's update runs `codex update`** (2026-11-10), which knows each way Codex is installed and
  updates it the same way, with a package manager's own command only for a Codex older than it.
  Rejected: Obeya choosing the package manager itself every time, which would guess wrong for the
  standalone installer and for any manager Codex adds later.
- **Each host's Claude Code and Codex are checked and updated there, over the connection** (owner, 2026-11-10),
  with `claude update` (`codex update`) on the host, so its own kind of installation (npm, the installer) updates as
  it would by hand. Rejected: copying this machine's Claude Code there, which may be built for
  another platform and would leave the host's own installation behind on its `PATH`.
- **An alias stands for the newest of its family Claude Code lists** (owner, 2026-11-10), and an
  agent gets that model's id where the alias names an older one. Rejected: the alias as Claude Code
  resolves it, which kept Fable on 5.1 for as long as Claude Code listed 5.2 only by its id;
  offering every listed id as a model of its own, which pins versions the menus otherwise leave out.
- **The installed app runs the machine's own Claude Code**, not the SDK's binary (2026-10-07): that
  would add 224 MB to every download, put Anthropic's proprietary binary into an MIT app and pin its
  version to Obeya's releases. Their protocols may drift; it held with every version tried, on macOS,
  Windows and Linux, and the setup assistant names the version Obeya was checked with.
- **Exploration agents and look-ups have a worker's tools** (2026-10-12). Rejected: read-only tools,
  with which they answered from the text, or said they could not see, what they could have checked.
- **Obeya's tools are allowed by a hook** (2026-10-10). Rejected: `allowedTools`, which makes the SDK
  log a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning with a stack trace at every worker start.
- **Workers run on more than one machine, capped by busy workers rather than workspaces**
  (2026-10-10). Measured on the owner's Mac (M4 Pro, 48 GB), 1–8 Oct 2026: workers were in a turn for
  74 of the 963 worker-hours they held a workspace (8 %), at most 8 at once, busy beyond 3 at once for
  17.6 worker-hours in 5 working days; the 5–9 held clones' app stacks filled the 48 GB and 20 GB of
  swap, while Claude Code took 2.3 GB. So waiting cards park, machines count slots for busy workers,
  and a card finding none goes to another machine, where it stays until its work lands. Rejected:
  clones as the only cap; stacks running until stopped by hand.
- **Worktrees by default** (2026-10-14); a canvas whose configuration names clones keeps them.
- **The checkout where work lands is never a workspace** (2026-10-30, a tester's report): work lands
  there and the read tree is read there, and a card's branch checked out in it stopped every
  landing.
- **A host's forwarded port reaches a server that answers only narration clips** (2026-10-16).
  Rejected: forwarding to Obeya itself, which let anyone on that machine run commands here.
- **A finished card's question takes a temporary worktree when no clone is free** (2026-10-15).
  Rejected: failing; queuing it (clones are often held for days by cards in review); the read tree
  (other agents read there at the same time).
- **A folder may stay without git** (2026-10-20): a cloud-drive archive (8.1 GB, 4,615 files, mostly
  PDFs) cannot take a `.git` without sync conflicts and copies of every scan. Cards work in place, in
  parallel with the Coordinator's overlap check on files; changes are told apart by ctime; undo is
  full where the file system clones. Rejected: a shadow git outside the folder (copies every file
  into git and the folder into each worktree); a copy per card applied on approval (cheap only where
  cloning works).
- **A change during a command that writes nothing is uncertain, not the card's** (2026-11-04): a
  Codex worker counting the rows of an export that a background process wrote while it waited in
  `sleep 30` steps got the export as its result, and "Discard changes" would have deleted it.
  The command line tells which commands cannot write (a fixed list of readers, options that write
  excluded, no output redirected into a file); anything not known may write. Rejected: telling the
  writing process apart (macOS `fs_usage`, Endpoint Security and Linux fanotify need root or an
  entitlement, Windows has no counterpart reachable from Bun); hiding such a change entirely, since a
  command misread as writing nothing would then lose the card's own change from its list.
- **The pool follows the configuration; a clone leaving it is deleted** (2026-10-21), so a lowered
  number gives disk space and app stacks back. Rejected: clones staying once registered; leaving the
  folder; asking when saving (a step more, and a leased clone is freed only later).
- **A workspace whose folder is gone leaves the pool at once, even from its card** (2026-10-23):
  waiting for the card to give it back never ends, since nothing (git, `app.stop`) runs in a missing
  folder, and the canvas showed every moved repository twice. Rejected: keeping it until the folder
  comes back (a moved home never does).
- **Each step asks git as few times as it can** (2026-11-07): on Windows every process start costs
  50 ms to over 2 s (the virus scanner looks at each, other workers add load), and the machine starts
  only 20 to 40 a second. One answer of git serves every question it holds (a clone's branches tell
  its main branch and whether the card's branch exists), and the same question asked side by side
  is asked once. A fetch from a path on this machine runs `git-upload-pack` through a shell (msys on
  Windows, seconds under load), so a start skips it where the other repository has nothing the
  clone lacks, told by that repository's own branches and tags. Whether a fetch goes there, and
  what it would write or delete, is git's configuration as git reads it (includes, the global one,
  rewritten URLs, pruning); where it may write more than the remote's branches, the card's branch
  is looked for after it. Rejected: reading the clone's configuration file without git, which
  missed what git takes from elsewhere; keeping git's answers between steps (the main branch per
  clone), since an agent working in the clone can change them unseen.
- **A lease is given back from the card's state** (2026-10-21), whatever brought it there. Rejected:
  freeing only on a card's normal path, which left stopped, ticked-off workstreams holding clones.
- **An unreachable host fails fast** (2026-10-12): asking it on every look for a free clone (almost a
  minute with five clones there) left Obeya unresponsive while a card waited.
- **Git frees workspaces in the background, the workspace taken until it is done** (2026-10-21):
  removing a worktree, or a checkout back to the main branch in a discarded prototype's clone, held
  the server on every canvas in a large repository or over SSH. Rejected: freeing the workspace first
  and cleaning it afterwards (another card could take it half cleaned).
- **The pool shows why a free clone goes to no card** (2026-10-26, GitHub issue #9): a clone with
  uncommitted changes counted as free in the pill while cards waited for one, with nothing saying
  why; the card's own line ("The free workspaces have uncommitted changes") named
  neither the clone nor the files.
- **The pool lists each workspace with its path and card** (2026-10-26, GitHub issue #10): a summary
  of counts and titles did not say which folder a card works in, nor which clone is free, and gave
  no way to the card. It opens on a click, so its links can be reached and it works by touch (and
  only on a click, see The bar's lists open on a click in The canvas). Rejected: a path cut at its
  end (the clone's number and the repository are at the end); the list on the phone (owner, 2026-10-27: the phone view stays simple).
- **The owner can take a card's clone for a card waiting for one** (2026-10-27, GitHub issue #11):
  a card in review, or stopped with work, held its clone for days while a more urgent card waited.
  Its uncommitted work goes into a commit on its branch, taken apart again when the card goes on,
  so the override loses nothing and needs no question first. Rejected: asking what to do with
  uncommitted work at each click; refusing while the clone holds uncommitted work (a worker at work
  nearly always has some). It shows only while no clone is free and a card waits (the card it was
  taken from queues again and would otherwise take the clone straight back), and behind a faint
  "⋯" rather than a button per row (owner, 2026-10-27: a rare action whose label alone did not
  say what it is for, and buttons in every row crowded the list).
- **Obeya's looks at a repository write no index** (2026-11-09): a look still running as a card took
  a free clone held git's index lock as the card's checkout needed it, and the card went back to
  planned. `git status --no-optional-locks`; `git diff` has no such switch, so its refresh is off and
  the files it then names only by their timestamps are compared by content. Rejected: a copy of the
  index for each look (one more file to copy per look, and over SSH a shell on the host); retrying
  the command that found the lock held (each of Obeya's, the agents' and the owner's own would need it).
- **Leftovers in a free clone go onto a branch of their own, by themselves in a clone Obeya made**
  (2026-11-11): files a landed card left uncommitted, or a generated file with other line endings,
  blocked a clone for every card until the owner cleaned it up by hand, while cards waited. Kept on a
  branch, nothing is lost and the clone is free; Obeya does it once a card needs the clone, not at
  every look, so a tool still writing there does not leave a branch a minute. Rejected: discarding
  them (they may be work); a stash (shared by the clone's branches and found by no one); committing
  them onto the card's own branch (a landed card's branch would hold work again); doing it in a clone
  the owner listed without being asked; a button "Save leftovers and free it" with the rest in a
  tooltip (it left the owner guessing what happens and where the changes go).
- **A tag `origin` has, and a branch whose changes the main branch had at some point, count as
  landed** (2026-11-11): two clones stayed on disk for good as "work not landed", held by a release
  tag that origin has but no branch of origin holds; and a squashed pull request's branch counted
  only while each of its files was still as on the main branch's head. Older commits are tried only
  where merging into the head conflicts: a clean merge that changes something is work not landed,
  and trying all 50 for each such branch took thousands of round trips on a host over SSH (counting
  a branch whose changes main took and later removed as landed is what that gives up, on the safe
  side). Rejected: comparing patch-ids of the main branch's commits (git needs them piped in, which a
  run over SSH does not offer).
- **Free clones are chosen by their last look, the one taken looked at again** (2026-10-21): in a
  large repository (GitHub issue #2: 9,188 files, on Windows) or over SSH, `git status` in every free
  clone at each look held the server, on every canvas. Rejected: asking git while choosing; a start
  that waits for the look before taking a clone (slots and the queue would not see it taken meanwhile).
