## Repositories and configuration

A chapter of the [design doc](../design.md), whose header says how it is written.

### Canvases and repositories

Each repository on a canvas has its own settings, workspaces, workers, project agents and PR watcher;
the canvas has one board and one Coordinator, whose collision checks stay within a repository. The
first repository is the canvas's home; the others' plan docs are referenced as `<repo>:<path>`. The
owner's cards carry their repository, chosen in the panel before work begins (home by default); on a
canvas with several repositories every card names its own. The picker (on a planned task, and on an
idea beside "Build it like this"; built once for both) lists the canvas's repositories and "New repository
…": a folder (it starts beside the home repository) and "own canvas" (on by default; off, the
repository joins this canvas). Picked, it reads "super59 (new)", and starting or building the card
creates that repository first (see Building in a new repository); it is saved as it is picked,
like anything entered on a card. It shows on a canvas with several repositories, and on a card
whose new repository is picked already (by the idea's agent from the conversation, or by the
Coordinator from the owner's words); on a canvas with one repository a card without one shows no
picker. A proposal's picker
offers only the canvas's repositories. A card leaves its canvas only built in a new repository with
a canvas of its own; it then refers across canvases to the cards it came from or that come from it.
A proposal goes to the repository its agent names, the one where the change is to be made, and
otherwise inherits its card's: a worker in one repository often notices what needs changing in
another (one drafting posts about the app sees what the app lacks), and a proposal filed under the
wrong repository would start its worker in the wrong place unless the owner noticed and switched it.
That repository may be on another canvas: the proposal is then made there, at a free spot, and waits
for the owner on that canvas (in the navigation's "Needs you"), with "Proposed by the agent of the task
“…” on the canvas “…”" and a link to that card; the proposing card's conversation names the canvas.
Its agent can take it back or replace it there as on its own canvas, and the worker that takes it on
reads the card it came from as with any follow-up.

The UI opens `/c/<canvas>` (with `/card/<code>` a card on it, see Addresses in The canvas; with
`?talk` Obeya's sheet); the navigation after the logo switches canvases and lists what waits for the
owner on each, kept current on every page (see The navigation). Wherever canvases are listed (the
navigation, the phone) they
stand in the configuration's order, so the owner sets it by moving them in the Configuration dialog;
the first is also where a page of a stopped canvas goes. A canvas without a name in the configuration is named after
its first repository (the name in its `origin` URL, else its directory's), and its id follows, so all
clones of a repository share one canvas. That id is given once, when the canvas first runs, and then
stays with its first repository's path, whatever that repository's `origin` becomes later; only the
name shown follows the `origin`. A canvas that came back under a new id before ids were kept (its
first repository given an `origin` that names it otherwise) gets its directory's name back where the
database still has cards under it, unless that canvas's home is another repository or the canvas
under the new id has cards already. Which canvas a repository is on is this machine's alone.

A repository's id on its canvas (what its cards, its plan-doc references `<repo>:<path>` and the
canvas's home go by) is given once, when the repository first runs there: its name (the name in its
`origin` URL, else its directory's), with a number where another repository of the canvas has that
id already. It then stays with the repository's path, whatever its `origin` becomes later; only the
name shown (on cards, in the panel, the picker and the navigation) follows the `origin`. A repository at a path new on the canvas whose name a repository no
longer configured had takes that id over with its cards, so a checkout moved to another folder keeps
them. A repository first given an id when ids were not yet kept, whose cards still go by its
directory's name while its `origin` names it otherwise, gets the directory's name back.

### Main branch

One main branch per repository is where cards start from, where work lands, and where plan docs and
the repository's settings are read from. It is the one the owner set on this machine (`branch`),
never in `.obeya/settings.json`, since that file is read from it. Without one it is detected:

1. `origin`'s HEAD where the checkout knows one;
2. else the repository's only branch that is not a card's (`obeya/…`);
3. else the one of them named as git's `init.defaultBranch`, `main` or `master`;
4. else the branch the checkout is on, unless that is a card's;
5. else `init.defaultBranch`, else `main`.

The usual names come before the checked-out branch so that a branch the owner checks out for a while
does not become the main branch; landing on the local main refuses while the checkout is not on it.

### Read tree

Every git repository of a canvas has a directory on its main branch, the read tree. Plan docs are
read from it (unless outside the repository, see A plan folder outside the repository), and the
agents that answer or judge rather than work on a card run in it: project agents, ideas' exploration
agents, the Coordinator (with its look-ups, learner and retrospective), the work retrospective and the
voice commands' session. A folder without git is its own read tree (see Folders without git).

Where work lands on the local main, the read tree is the configured checkout itself, which is always
on main, uncommitted plan docs included. Otherwise the configured checkout is often a pool clone on a
card's branch, so the read tree is a detached worktree of it under Obeya's home
(`read/<canvas>/<repo>`), at the local main where that has everything `origin`'s has, else at
`origin`'s; the clone's `git status` stays clean, so leasing is unaffected. Where no worktree can be
made, or an old one cannot be removed (on Windows, while an agent works in it), the checkout is read
and the next refresh tries again. Hooks do not run for it.

It refreshes with every round of the PR watcher (2 minutes, and when the owner comes back to the
page) and right after a merge: a fetch of the main branch into `refs/remotes/origin/<branch>` only,
without `FETCH_HEAD`, so it is safe while a card leases the clone, then, where the commit moved, a
forced detached checkout and a fresh read of the plan docs. A failed fetch is logged and retried next
round. So a doc committed only in another clone, or only edited, does not show. Fetch and checkout
run without blocking the server (in a repository of thousands of files a checkout takes a while);
while git writes the files, the canvas keeps the plan docs it read before, since a doc missing for a
moment would take its project off the canvas and give back its workstreams' workspaces. Moving the
read tree to the worktree when work now lands elsewhere runs the same way, the checkout read until
the worktree is there; so does a repository's restart. When a canvas starts, its read trees are made
or moved before it reads from them, since the checkout, the only thing to read meanwhile, may be on a
card's branch; the server answers meanwhile.

The same holds wherever git is at work in the read tree, the checkout included, by Obeya (pulling a
merged pull request, landing) or by hand: while git holds the index's lock or stands in a rebase,
merge, cherry-pick, revert or bisect, the files are no finished state of main. A rebase shows
`origin`'s files until the local commits are back on top, so a doc deleted only on the local main is
back for that moment, and a doc added there is gone. Plan docs are read only from a finished state:
meanwhile the ones read before stand, and they are read again once git is done (looked at every
100 ms; git still at work after a minute, a rebase stopped on a conflict or a lock left behind, is
logged).

### Plan docs

A doc in the repository's plan directory (`planDocs`) is a project when its `## Workstreams` (or
`## Arbeitspakete`) section has a checklist; each top-level item is a workstream
(`**W3:** Title. Details`). A short code at the start of the bold text is its label: `W3`, `WP`,
and the codes other docs use, before a colon, dash or full stop (`S1:`, `A1 —`, `1G.`). A code
before a space (`4A Title`) is a label where at least two of the doc's items start with one; alone,
it is part of a title (`K8s Cluster`, `2FA einführen`). A pull request's number before the text
(`**W3:** #27. Title. Details`, as a worker may tick it off) stays part of the title instead of
becoming all of it, so the tile and the sheet still say what the workstream is (issue #12,
2026-10-26). Checked means `live`, `(in review)` after the label `in PR`, anything else `planned`.
The goal is the first paragraph under `## Goal` / `## Ziel`. Obeya reads plan docs and never writes
them; workers tick off their workstream in the doc as part of their change. A plan card is stored
when first seen, so the owner's placement persists; its title, text and state always come from the
doc. Each read keeps the doc's last state on the project.

#### A workstream's identity

A card belongs to its workstream by the workstream's label, or, for an item without one, by its title
(lower-case words; a pull request's number a worker puts before it does not count). Reordering the
doc, adding or dropping other workstreams, or rewording a labelled one leaves every card on its own
workstream; rewording an unlabelled title makes it another workstream, with a card of its own. Two
items with the same label are told apart by their titles; two with the same title too, by their
order. Titles in any script count (`Вход`, `登录`); only an item whose title has no letter or digit
is known by its place. Where dropping or adding a sibling changes how an item reads (a code before a
space left alone in the doc is a title again; a label the doc no longer gives twice needs no title
after it), its card follows it onto its new key: where it is known what the workstream was (the doc
as last read, or what the card remembered of it), by its label and title together, since a label
alone may be another item's now. A card nobody worked on that holds such a key gives way to the card
with the workstream's log.

A card whose workstream the doc no longer lists, while the doc is there, leaves the project once an
agent worked on it: as a task of its own, with its log, under the workstream's label and title and
its text as the doc last had them, its log saying why. Finished (live or done, or planned again
after a part landed), it goes into the archive; at work or stopped, it stands beside the project. A
stopped card holding a workspace gives the workspace back first. A doc in a plan folder outside the
repository is written in place, an item moved in two edits, so its card leaves only once the
workstream stayed away for five minutes; back before that, it keeps its card. A card nobody worked
on just goes.

Cards stored by an older Obeya may carry a workstream's place in the doc as its key (`#3`), which
gave their logs and states to other workstreams once the doc dropped or added some. A doc last read
with such keys moves its cards onto the keys above once: a card an agent worked on goes by the title its
branch was named after (`obeya/<title>-<id>`, from the card or its log), any other by its place in
the doc as last read. A title the doc reworded since still finds its workstream by the label the
doc as last read or its history gave it, and a pull request's number before it does not count. A
card whose workstream the doc no longer has leaves the project as above, its title and text from the
doc's history in git (the doc as each of its recent commits left it); the project then lays out afresh in the doc's order,
with fresh cards for the workstreams left without one. Where a card needs the doc's history, it
stays where it is until git has read it (a project being repaired shows its doc as last read).

#### A plan folder outside the repository

For plans kept out of the repository (gitignored, or a folder of their own), the plan directory may
be an absolute path or one from `~`, set on this machine. Obeya reads and watches the docs there as
they are, and names each by its absolute path with forward slashes (so a Windows drive does not read
as a repository id), as the agents do. Workers on this machine get the folder as an extra directory:
ticking a workstream there takes effect at once and goes into no commit, so the box says nothing of
a landing: the card's work in progress still wins until it lands, and so does a stopped card with
its branch, which stays stopped, keeps its workspace and holds its project on the canvas (see A
workstream's state). A doc "Plan as a project" writes there cannot land, so Obeya names it at the
start (the card's title, `-2` on a clash) and keeps it on the card; it shows as a project once
written, and the project takes the card's place once approved (the card is done without a change).
Workers on other machines do not reach the folder.

#### Docs that are no projects

The other `*.md` in the plan directory are not hidden: a quiet note at the top left of the projects
names the directory and lists each doc with its reason (no `## Workstreams`, or one without a
checklist) and "Prepare as a project". That starts a card whose worker adds the checklist (and
`## Goal` if missing) in the doc's own style, turning tasks kept under another heading into it; once
landed, the doc is a project. Meanwhile the doc's row shows "Being prepared" and opens the card.

A repository with no plan doc that never had a project gets a dashed note there instead: where Obeya
looks, that "Plan as a project" on an idea or task card writes the first doc there, and "Change
directory", which opens the configuration at the repositories. Its × ("Hide") hides it for that
repository and directory in this browser, since a canvas without projects is a normal state; another
plan directory brings it back. The note on docs that are no projects has no ×: each row is something
to do. The owner drags either note like a card; from then on it stays there (stored with the canvas,
the same in every browser) and new cards go clear of it. Until dragged, it follows the projects.

#### A workstream's state

Work in progress (working, waiting, in PR, approved) wins over the doc, so a workstream ticked off
on its branch still waits for its merge. In a plan folder outside the repository so does a stopped
card (planned with its branch): its worker ticked the box there before the work landed. Then a
ticked workstream is `live`; otherwise the stored state counts (`done`, `planned`), and without one
the doc's. `done` (finished without a change) stays: the doc has nothing to say about it.

A stored `live` holds only until the read tree has what landed. A card keeps the commit it landed
with (on main after a direct landing, the merge commit for a pull request, else the read tree's
commit after the next fetch). When the read tree has it and the workstream is still unchecked, only
part is done: the card goes back to `planned`, logs "Part landed; the plan doc keeps it open." and
shows "Part landed · PR #821" (or the commit) until the rest lands. Its log and handover stay, its
branch goes, so a new run starts fresh from main and hears what landed. Unfolded, it shows what the
doc still holds open, what landed (with its pull request and last demo) beside the conversation, and
"Start the rest".

A worker still finishing after the landing keeps its card live until done. A workstream in a pull
request whose box the main branch ticks off counts as merged even where the PR watcher missed the
merge (by hand, say, or before the worker reported it): its worker hears so and finishes, and its
clone returns to the pool. That needs the box in the repository: a box in a plan folder outside it
is ticked by the worker before the merge, often before the pull request is open, so there only the
watcher sees the merge (GitHub issue #41, 2026-11-02: approved cards read as merged at once and
their PRs were never merged). Likewise a stopped workstream whose box the main branch ticks off is
done elsewhere: it shows `live`, its clone returns to the pool ("Ticked off in the plan doc: workspace
freed.") and its branch stays there. A box in a plan folder outside the repository leaves a
stopped card as it is (2026-11-02: such cards read as live and lost their workspace with nothing
landed).

#### Reading a plan doc

The project's sheet lists each workstream with label, title and, below in smaller type, the rest of
its item (text and sub-items), then its state, since a title alone is often too short to tell what
a workstream is (2026-10-21); details the doc keeps in sections of their own stay in the doc. A workstream's card names its doc at the top (the
path and "Read in the plan doc") and shows the item's text in every state: alone while planned,
beside the conversation while queued, and once an agent works on it on the left under "Plan doc",
above what came of the work, in full, or its first three lines with "more" above a demo or files.

"Read the plan doc" in the project's sheet widens it and shows the doc rendered, kept current with
the file; from a workstream's card it opens at that item. Esc goes back to the workstreams. The
server hands out only docs it shows as projects, by project card, never by path.

#### When a project ends

A plan doc with every workstream ticked, or one that disappears, ends its project (see Projects end):
done, it waits on the canvas for the owner to archive it; gone before its work was done, it goes
into the archive. The docs as last read decide, checked again whenever a card changes, since a
worker finishing after the landing holds its project (for a doc that is gone, as it last stood; that
worker's turn end reads the docs again). A doc already done when first read goes straight into the
archive. A renamed doc makes a new project and leaves the old one archived.

#### Watching the plan directory

Obeya watches the plan directory and the directory above it, since git removes the plan directory
with its last doc and its own watch then reports nothing. Bun before 1.3.14 on Linux delivers nothing
to a watch on a directory that was removed and created again (oven-sh/bun#42570), so such a
directory is polled every half second. On macOS Bun shares one FSEvents stream per process and
restarts it "since now" for each new watch, losing every watch's events until it is live (up to
200 ms), so watches stay open rather than being reopened per change; and a saturated fseventsd
delivers events late or not at all (2026-10-14: Bun, Node and fswatch alike), so the plan directory
is also polled every 2 s against its state at the last read.

### Repository settings

What Obeya knows about a repository is in its settings, in two layers: `.obeya/settings.json` in the
repository, for everyone, and the `settings` of its entry in `canvases.json`, set for this machine in
the configuration dialog, which also holds the main branch. The reference for every field is
`docs/settings.md`, linked from the README.

The fields: `land`, `push`, `upstream` (see Pull requests to the original), `direct`, `autoMerge`, `checks`, `setup`, `planDocs`, `softPaths`, `workspaces`,
`prNoise`, `language` (see Language), `app` (`run`, `stop`, `keep`) and `demo` (`language`, `site`:
see Static sites). Only what Obeya itself acts on is a command: `stop` and `keep` park a waiting card
(see Parking). `run` is prose, for any kind of app (a web app, a CLI, a desktop or mobile app):
every worker's brief has it word for word. Obeya neither starts the app nor looks for its address;
the agents do, and a worker reports the address once the app runs (see Trying the app by hand). Each
field of `app` and `demo` is a setting of its own, so this machine may set `app.stop` and leave
`app.run` to the repository.

Precedence, highest first: this machine's values, `.obeya/settings.json`, detection (main branch,
landing), Obeya's defaults (which cover any repository with `docs/plan/`). The dialog shows each value
with its source ("on this machine", "from the repository", "clones listed", "detected",
"default"), and "Reset" takes a value set here back to it. An empty list or command is a
value of its own (no checks); an empty main branch or plan directory is none. A main branch the
repository has neither locally nor on `origin` keeps the configuration from being saved.

Settings are read where they are used, so saving them restarts nothing (see Live configuration); the
canvases follow: the read tree moves when work now lands elsewhere, the plan directory is watched
afresh, a repository now landing through pull requests gets its PR watcher (one leaving them keeps it for the
pull requests still open), and the page shows the
main branch and how work lands. `workspaces` is the exception: changing it restarts that repository's
agents, as the dialog says at the field, the first of the repository's page (see Canvases).

#### `.obeya/settings.json`

`.obeya/settings.json` (like `.vscode/settings.json`) is what a fresh clone brings: every value but
the main branch, versioned and reviewed with the code it describes. It is read from the main branch,
not the checkout, since clones are on cards' branches, perhaps from before the file changed: when a
canvas starts, whenever the read tree moves, and on save, by git without the server waiting for it;
a save while the branches have not moved keeps the last read. A new version takes effect without a
restart; one that changes `workspaces` restarts the repository's agents once they paused (see
Restarts for landed code).

"Take over into the repository for everyone" below the form takes this machine's saved values (but
the main branch) into the file, keeping what else it holds, after showing the file as it will be.
Unsaved changes are saved first, as the confirmation says; only where saving restarts Obeya (a
command-line configuration) is the button off. Where work lands on main, Obeya commits the file
there without touching the checkout's other changes, staged or not (a commit made beside the
checkout: temporary index, `commit-tree`, `update-ref`); a checkout on main gets the file as
committed, and one with its own changes to the file refuses. Where work goes through pull requests,
the commit goes to a branch `obeya-settings-<time>` and a pull request, linked in the dialog; with
`direct`, the dialog also offers to push it onto `origin`'s main (never forced, so a protected
branch refuses). Where the file there holds every value already (in whatever order of fields),
nothing is committed, pushed or opened, and the dialog says so: an empty commit would only clutter
the history. Once the file holds the values (at once, or when the merge reaches the read tree), they
go from this machine's settings and show as from the repository. The work retrospective proposes
single values too (see Setting proposals).

#### Problems in the settings

The file's fields are checked against a schema. An unknown field (named with the one it probably
meant: `check` → `checks`) or one of the wrong type does not count, a mistake inside it taking the
whole field: the default stands in, the rest works. Each is the problem `repoSettings`, also in the
log at start and on each new version. A demo site without title, http(s) URL or deploy command, or
whose deploy program is missing, is `demoSite`; until fixed, "Share" exports demos. A main branch
still holding `.obeya/adapter/index.ts` is `adapterGone`: the module is not read, and the setup
button (see Canvases) offers to move it into the settings. Untrusted commands are `untrusted` (see
Trusting a repository's commands). All of them are fixed in the repository (or trusted), so they
block no save.

#### Trusting a repository's commands

Some of what a repository brings runs on this machine outside Claude Code's permission checks, or is
contacted without a click: `app.stop` and `app.keep`, and `demo.site` (`deploy` with its `env` file,
`url` and `headers` read when the owner comes back to the page, `publish` deploying with each
approval). And agent sessions run what the repository's own Claude Code configuration names
(everything under `.claude/` and `.mcp.json`) without asking, read-only agents included: tried on
2026-10-16 (SDK 0.3.285, no `settingSources`), a repository's `SessionStart` hook ran in a session
with only Read, Grep and Glob, as did an MCP server its own `enableAllProjectMcpServers` approved;
with `disableAllHooks` and `strictMcpConfig` its `apiKeyHelper` still ran and an `ANTHROPIC_BASE_URL`
in its `env` redirected the requests. A cloned repository or a collaborator's merge changes these
unnoticed (VS Code has Workspace Trust for the same reason).

So they count only as the owner last trusted them. Obeya keeps per repository path the trusted
values themselves (not a hash, so the dialog shows a diff) in three groups: `app` (stop and keep
together, since a stop without its keep could stop what it keeps), `site`, and `claude` (each file
under `.claude/` and `.mcp.json`). A group the main branch has otherwise is held: the settings are
read without it (no stop or keep, no site; demos are exported), and an agent working in the
repository starts with `settingSources: ['user']` and gets its directory's CLAUDE.md in its
instructions instead (not on another machine), trust being worked out afresh at each agent start
from the main branch as it is then, a commit made there outside Obeya included. What was read there
last stands while the repository's own branches, `origin`'s, its packed refs and the branch its
checkout is on are as they were (a few `stat`s; the cards' branches do not count, and a branch that
follows a card's means no reuse); otherwise git reads it again, once more if the refs moved
meanwhile, and the agent starts once it has, without the server waiting.
What this machine sets needs no trust: its values standing in for a whole group, and values it took
over into the file (but not a trusted `keep` that went beside them).

Held groups are the problem `untrusted` in "Configuration": what each group does, a diff of the
lines as last trusted against the main branch's now, and "Trust these commands", which trusts
exactly what was shown (refused where it changed meanwhile; also for a repository not saved yet), and
the canvases follow at once. Held values show "from the repository, not trusted yet". A worker's
own workspace may change Claude Code configuration: that counts while the main branch's is trusted
and waits for trust once it lands. Trust covers the configuration, not the code it calls: a trusted
hook runs whatever its script says now, as the checks do.

#### Writing the settings

The plugin's skill `obeya:settings` is how a worker writes `.obeya/settings.json`: read the
repository (scripts, CI, README, compose files, a leftover `.obeya/adapter/`, taken over and
deleted), ask the owner what it does not tell (login, test data), write the file, check it with the
skill's check script (which shows what Obeya makes of it, plan docs included, and its problems, from
the dialog's own checks), run setup and checks, and prove `app.run` by recording a demo with it. The
compiled binary carries `docs/settings.md` where the skill finds it.

### The Configuration dialog

The "Configuration" dialog covers the page but for a margin (a press there or Esc closes it,
leaving what was open behind it as it was). Its close button stays at the top right however far
the section scrolls, so a click meant to close never lands on what scrolled under it. What removes
an entry (a canvas, a repository, a machine) is a waste bin, not a cross that passes for a close
button, and shows only while the pointer or the focus is on its entry (a canvas: its title line; a repository: its path),
always where nothing hovers (touch). An unsaved draft survives per tab, also a reload or
restart. Its sections, listed on the left and shown one at a time (the last one chosen per tab):
Canvases, a heading with each canvas indented under it as a section of its own and "+ Canvas"
last (see Canvases), Agents and models (also the usage limits in the bar and the costs), Voice input, Demos,
Other devices (see Other devices) and General (languages, light or dark, the server); below them "Check setup" and "Report a wish or
a bug" (see Wishes for Obeya's makers). Each canvas in the list marks its unsaved changes and
counts its problems in red; the heading counts the problems of no one canvas (none at all, say). The file a
section or block is saved in sits behind an info icon at its heading ("Saved in" and the path), shown
while the pointer or focus is on the heading and always where nothing hovers (touch), where a tap
opens it; only a notice that matters stays visible (Obeya running with repositories from the command
line, where saving creates the file). Settings are rows of label and control, no boxes in
boxes. What to know about a field sits behind an info icon at its label, shown only while the pointer
or focus is on the field, its text appearing at once.

The dialog shows the saved configuration at once and what it amounts to once checked ("Checking the
repositories …" until then): problems, each repository's id and settings with their sources. The
check reads each repository with git once however often it is named, all in parallel, without
blocking the server.

#### Canvases

A canvas chosen in the list fills the right side; first the one the page shows, then the last one
chosen per tab, or the one a jump into the dialog names (a card waiting for a free clone, a proposal
for a setting), scrolled to the field. Its page has a title line (name, id, whether it runs, and with
several canvases ↑ and ↓ that move it one place, as in the queue), its name, and its repositories
as tabs (the home repository first, each counting its problems), with "+ Repository" beside them;
one repository shows at a time. A move is a change of the draft like any other. All canvases are
saved together with "Save" at the bottom of every canvas's page, which says so while several
have changes. Renaming a canvas keeps its id and cards.

A repository's page is its path, its problems, then its settings in groups under a small heading
each, always shown: where its agents work ("Agents work in": worktrees or clones, with its
source, the clones, slots and other machines), GitHub (its "GitHub account", only where `origin`
is on GitHub, see GitHub account), branch and landing (main branch, landing, direct,
auto-merge, accounts without review, soft paths), app and checks (setup, checks, "How to run the
app" in a large text field, "Stop while a card waits", the keep condition once there is
one), plans and language (plan docs, "Repository language"), demos ("Demo language",
"Demo site" with title, URL, deploy command, env file, headers, largest file, tags (with "Have an agent propose the tags", see Tags in Sharing demos) and when a demo
goes on it, all behind "Another host, entered by hand …" beside "Set up a demo site …" while it has
no site), then "Take over into the repository for everyone". A folder without git has no workspace or
branch group.

The path can be typed, or picked with "Choose …" beside it in the system's folder dialog (macOS
`choose folder`, Windows' folder browser, zenity or kdialog on Linux), the same control as in the
first canvas of the setup assistant. A picked folder fills the field and is checked as a typed one
(its choice of going without git starts afresh); cancelling changes nothing, and what went wrong
shows under the field until the next attempt. The dialog opens on the
screen of the machine Obeya runs on, so the button shows only to a browser on that machine, and only
where it has such a dialog; the server opens it for no request from another device (2026-11-06: a
browser never hands a page a folder's absolute path, and repositories are added at the machine
itself, so other devices keep the text field rather than getting a folder browser of Obeya's own).

With clones, it shows the existing clones ("Existing clones, one per line"), then the ones Obeya makes on top of them ("Also create
new clones"), the slots, the sum ("4 clones on this machine in all (2 existing, 2 new)") and the
other machines; with worktrees, only the slots. With no clone the line warns that no card would start. For
a running canvas it says which registered clones saving drops, which only once their card is done,
and that their folders go where nothing unlanded lies in them (an existing clone's folder stays).

An existing clone belongs to the repository when it is the repository or its `origin` is the same
repository, whatever the URL form (https, `ssh://`, `user@host:path`; user, port, `.git`, case
aside); a clone of another repository blocks saving. Switching to worktrees takes listed clones out
of the entry; switching back while the dialog is open restores them. A repository added in clones
gets two new clones, a number that goes when an existing clone is listed and returns when the list is
emptied, unless the owner touched it.

Problems (no git repository, a repository twice, two canvases with one id, a canvas's home repository
left out, an empty path) show at the field and block saving (an empty path is never resolved, which
would show the server's own working directory and its commands for a new canvas); a folder without git offers to set it
up (see Setting up git in a folder). A repository's own settings problems (see Problems in the
settings) show at it and block nothing. Technical detail folds under "Details"; each saved problem
offers "Create a task to fix this", which asks the Coordinator of its canvas to create a task fixing
it. The "Configuration" button in the bar counts the saved configuration's problems in red, kept
current also when a repository's settings change on its main branch.

A repository with nothing in its own `.obeya/settings.json`, or with `adapterGone`, says that Obeya
does not yet know how its app starts, which checks run and how to demo it, and offers "Have an agent
fill them in" as soon as its path is checked, before the canvas is saved: the card
"Set up Obeya for <repo>" (or the one still open) at the top right of that canvas, opened there.
Unsaved changes are saved first, as the hint says; only where saving restarts Obeya is the button
off. Its worker uses `obeya:settings` and settles the plan directory: it looks for plans the
repository already keeps (`docs/`, `rfcs/`, `adr/`, `PLAN*.md`, `TODO.md`) and asks the owner in its
one question whether that directory or a new `docs/plan/` holds them.

The canvas proposes the same card by itself: once a repository without settings of its own (a git
repository, not a folder) runs on it, the card waits there as "Proposed by Obeya", with the same
title and text and the dialog's reason beside it. Accepted, it is the owner's card as the button
makes it (no mark of an agent's proposal); the button, pressed while the proposal is open, accepts it
as planned and opens it. Obeya proposes it once per repository and canvas: dismissed, accepted or made
from the dialog, it does not come back. A proposal still open goes by itself once the settings are on
the main branch, withdrawn rather than dismissed.

#### Saving

Saving writes the file and applies it at once without a restart (see Live configuration); the dialog
says so, and where a repository's agents restart for it, that they do once paused. Started with
repositories on the command line, Obeya saves with "Save and restart": the file becomes the
configuration it restarts with once no worker is mid-turn, and the page reloads.

The server's own settings (port, data directory, the agents' permission mode) come from the command
line and environment (`OBEYA_PORT`, `OBEYA_HOME`) and show read-only. The Coordinator reads the
configuration (`config`) and changes it on the owner's word (`configure`, checked like the dialog's,
see Confirmation and undo). `configure` takes the whole list in the shape of the file, every field of
it, so what the owner did not ask to change passes through as it was: a field it left out would
fail every change while one entry has it (a folder's `git: false` dropped, that folder is checked as
a git repository). The dialog says so under its title, with "Ask Obeya", which closes it
and opens Obeya's conversation (Space for voice does not reach Obeya while the dialog is open).
The other sections save on their own, restarting nothing: the demo settings into `demo.json` (see
The demo settings and voices), the personal demo site below them into `personal-site.json` (see The
personal site in Sharing demos), languages, theme, models, whether the bar shows the usage limits
(`usageMeter: false` when not) and whether the page shows what agents cost (`costs: true` when it
does) into `settings.json` in Obeya's home.

#### GitHub account

On a machine where the GitHub CLI is logged into several accounts (a personal one and a work one,
say), each repository on GitHub can name the one Obeya and its agents work as there: `githubAccount`
in the repository's entry of `canvases.json`, chosen in the dialog from the accounts gh is logged
into on `origin`'s host (read from gh's `hosts.yml`, never over the network), or "Automatic". Set,
Obeya's own gh calls on the repository and its pull requests run with that account's token (`gh
auth token --user`), its agents get the token in their environment (`GH_TOKEN`, on an Enterprise
server `GH_ENTERPRISE_TOKEN`; a session starts once it is read), so their gh, and git where its
credential helper is gh's, work as that account, and its clones on other machines get it as their
GitHub login. Automatic is the account that owns the repository where gh has a login for it, else
the account gh has active. An account gh is not logged into (any more) is a problem at the
repository that blocks nothing, and gh works as automatic meanwhile. Changing it restarts the
repository's agents once they paused, as any change to the repository's entry does.

### Live configuration

A saved configuration, and a new version of a repository's `.obeya/settings.json`, apply while Obeya
runs, without a restart or reload. A new canvas starts at once (the setup assistant's with its welcome
card), a changed one takes the change, a moved one moves in every list at once, a removed one stops once its agents paused, its cards kept. A
new name, a new repository and settings that leave the agents where they work apply at once.

What a repository's agents are set up by (its clones, existing workspaces, slots, other machines,
`workspaces`) restarts that repository's agents alone; a repository that left the canvas stops. Its
workers pause at a safe point (at most 15 minutes), the set-up starts again as configured, and they
resume in their sessions; the other repositories work on. A worker landing such a change waits for
it (see Restarts for landed code). The bar shows the wait like a restart's ("Configuration waits for …") with
"Apply now" (see Self-update). Switchers follow canvases that start, stop or change; a page of
a stopped canvas goes to the first canvas.

What this takes of git (the repositories, their listed clones, the clones still to be made) runs
without the server waiting: a restarting repository starts once git has read it, and clones it is
to make join its pool as git has made them, cards waiting for a free one meanwhile. One whose clones
cannot be made does not run, as below.

A repository that does not start (a refused or unmakeable clone, a git error) never leaves a canvas
half stopped: it starts again as it was before, with the problem shown at it, and failing that leaves
the canvas, its cards kept. A canvas without its home repository does not run; the others do. These
are problems of the running canvases: they block no save, count on the Configuration button, and
"Try again" applies the saved configuration again. Where no canvas started, the page says so
with the problems and that button instead of the setup assistant.

The kept cards of a repository not running on its canvas (it left the configuration, or did not
start) stay on the canvas marked "Repository not running", with why in their panel. Nothing reaches
their agents meanwhile: starting, messages, approving and the like are refused with that reason, a
card set to start later or snoozed waits past its time, and a card the Coordinator was deciding on
goes back to planned. Only what changes the board alone (moving it in the queue, dismissing,
parking) still goes, and so does "Stop" on a card at work or waiting for the owner: it plans the
card again as any stop does (finishing after a landing, it is done), and the owner's stopped task
can be archived or deleted; the panel suggests that for a repository that is not coming back, on
the cards where it leads there (not on a workstream or a prototype). Its workspace stays recorded
for the repository's return, but no longer keeps it out of the archive, since nothing could show
the work in it while the repository does not run (decided 2026-11-08: a repository removed, renamed
or moved to another owner left cards nobody could get rid of; rejected: having the owner add the
repository back to stop them). Once the repository runs again, the cards work as before, in its
workspaces; an archived one gives its workspace back to the pool, where it would otherwise stay
taken unseen: a clone as when the owner takes it for another card (the card's branch stays there,
its uncommitted work in a commit on it, back at its next start; a clone git cannot reach stays the
card's, so no work is lost), a worktree where it holds no work, while one with work stays the card's,
since it takes nothing from the pool.
Decided 2026-10-21: no other repository's agents take such a card, the home repository's included,
since its worker would work in the wrong repository's workspace. Question cards are exempt: their
agent only reads, and looks a question about such a card up in the home repository.

### Language

Obeya keeps three languages apart, each German or English: the interface's, the conversation's and
the repository's. The owner switches the interface at will (to test both, say) without the agents
switching; the conversation follows the language the owner talks in; what lands in git stays in the
repository's language. A card may so show English UI around a German conversation about an English
plan doc: that is intended.

**The interface language** covers Obeya's own words: the UI, and what the server writes itself (log
lines, fixed parts it adds to an agent's question such as "(multiple choice)", push notifications,
its own pages; a log line stays in the language it was written in). The owner chooses it in the
dialog ("Interface language"); until then the system's applies (on a Mac `AppleLanguages`,
elsewhere `LC_ALL`, `LC_MESSAGES`, `LANG`, then the runtime's), English for any other. A change takes
effect at once: the page reloads, keeping what was open. The strings are two tables of one shape, so
a missing English text is a type error; both call the Coordinator "Obeya". Dates and numbers use the
browser's variant of the language; a variant `Intl` refuses (`en-US@posix`) gives the usual one.

**The conversation language** is what agents write the owner in: reports, questions, replies,
handovers, idea briefs, card titles, Question-card answers, proposals, work retrospective notes, the
Coordinator's replies and confirmations. Each agent answers in the language of the owner's most
recent words to it, typed or spoken, even where its work is in English; words that tell no language
(an option's letter, "ok") change nothing. Before that it uses "Conversation language", which follows
the interface language until chosen. It is an instruction in the prompts, not detection code. A task
the owner wrote (or the Coordinator put in from their words) counts as their first words; one from a
plan doc, a proposal, an idea's brief or the work retrospective does not, nor do the docs a worker reads
or the owner's standing preferences (the owner, 2026-10-20: an English task answered in German looked
wrong; 2026-10-21: a worker took German from German preferences). Agents without the owner's words (conflict reasons, proposed rules) use the
conversation language; the card namer uses the task's. The Coordinator knows the owner's words for
its cards in both languages, takes examples in the conversation language, names Obeya's own cards
("Add to CLAUDE.md") in the interface language, and starts its session afresh when either language changes. An analysis
on a card is in the conversation language; a committed one is repository content.

**The repository language** is that of everything that lands in git: code, comments, commit
messages, design and plan docs, proposed CLAUDE.md lines. It is `language` in the repository's
settings ("Repository language"), English by default. Workers and idea agents are told both
languages explicitly, so a German conversation does not make German docs.

**Demos** have their own language per repository (`demo.language`), else the demo settings' narration
language, else the conversation language; their shared pages follow it (see The demo settings and
voices). Obeya's own repository says English, since its demos go public. A worker's instructions name
that language outright, not where to look it up (2026-10-21: a worker writing an HTML artifact, which
needs no skill, read the demo settings' German and missed the repository's English).

Prompts only agents read stay English. Only the Coordinator's carry German examples of what the
owner may say, since it has to understand German commands. The prompts of agents that write to the
owner (workers, idea agents, the proposal reviser) carry no German at all, neither examples, labels
nor German quotation marks: taken together, they outweighed the one sentence naming the owner's
language (2026-11-08: a worker on an English task, with English interface and conversation, wrote
its status lines in German).

### Decisions

- **The GitHub account is this machine's, set per repository** (owner, 2026-11-12): with gh on the
  wrong account, a pull request in an organisation's repository was unreadable for Obeya ("Could
  not resolve to a Repository", 404) until the owner switched gh by hand, which then broke the
  other repositories. It lives in the configuration, beside the clones and hosts, not in
  `.obeya/settings.json`: logins differ from one person and machine to the next, and "Take over
  into the repository for everyone" never takes it. Rejected: a setting in the repository (one
  person's account names would be everyone's); switching gh's active account for the repository
  (`gh auth switch` changes it for every terminal and every other repository at once); trying each
  logged-in account until one sees the repository (a round trip per account, and it silently picks
  whichever answers first where several can see it).

- **A canvas may span several repositories, and one Obeya serves several canvases.** Rejected: one
  canvas per repository.
- **A canvas belongs to a repository, not a checkout**, named after its `origin`, so clones share one.
- **A canvas without a name keeps the id it first ran under** (2026-11-13), by its first repository's
  path, in the database: derived anew at every start, it changed with that repository's `origin`, and
  the canvas came back without its cards, settings and home. Rejected: writing the id into the
  canvas's entry of the configuration when it first runs (a configuration given on the command line
  has no file to write it to, and the owner's file would change by itself at a canvas's first start).
- **A repository's id is kept from when it first runs on the canvas** (2026-11-12): derived anew at
  every start from the name in `origin`, it changed once an `origin` was set or pointed elsewhere (a
  checkout given a fork as `origin`), and the cards on it no longer found their repository. Rejected:
  moving the cards to the new id at the start (they are only one of many places holding it: plan-doc
  references, the canvas's home, workspaces, read trees), and naming repositories by their directory
  alone (clones in folders of their own would no longer share a name).
- **A worker's proposal may go to a repository of another canvas** (2026-10-30): a worker in a home
  automation repository found the cause of its bug in Obeya, on another canvas; offered only its
  own canvas's repositories, it filed the fix in its own, where it would have started in the wrong
  repository. Rejected: keeping proposals on their own canvas, where the owner had to notice and
  make the card anew on the right one.
- **What a repository says about itself is values in its own `.obeya/settings.json`**, read from the
  main branch (2026-10-15): set without code, in one place, outside Obeya's open-source repository.
  Rejected: adapters per project in Obeya's repository; a TypeScript module per repository
  (`.obeya/adapter/`), once nothing in it was code; a configuration naming an adapter. A module left
  over is not read, with no migration before release.
- **Settings are read where used, and configuration changes apply in the running process, restarting
  only the repository whose agents they concern** (2026-10-14). Rejected: restarting all of Obeya,
  which waited for every worker on every canvas and reloaded the page for one added clone.
- **One recipe for running the app, in prose; only what Obeya runs is a command** (2026-10-15).
  Rejected: structured fields (start, refresh after a backend change, a URL file), which guessed at
  categories many apps lack and were read as prose anyway; Obeya managing the app (starting it,
  finding its address), since nothing in Obeya needs the address (the owner); the card's "Open
  app" takes the address the worker reports (see Trying the app by hand).
- **Where a section is saved shows only behind an info icon at its heading** (2026-11-08): a visible
  "Saved in" line under every block named the same `settings.json` four times in a row under General,
  cluttering the dialog with what the owner rarely needs; behind the icon it stays findable.
  Rejected: dropping the path altogether.
- **A repository's settings are checked against a schema** (2026-10-08): a misspelt field was
  otherwise ignored silently.
- **A repository's commands and Claude Code configuration count only as last trusted** (2026-10-16),
  since the SDK runs them even in read-only sessions and switching hooks and MCP off is not enough.
  Values are kept, not hashes, to show a diff.
- **The main branch prefers the usual names to the checked-out branch** (2026-10-14). Rejected:
  `origin/HEAD` else `main`, which on a `master` repository without a remote landed on a branch that
  did not exist.
- **Plan docs come from the read tree on the main branch** (2026-10-06), and the read-only agents run
  there too: the configured checkout is often a pool clone on a card's branch, where docs pushed from
  elsewhere never showed and projects went to the archive and back. The fetch rides on the PR
  watcher, without its own timer. Rejected: `git cat-file` for the docs alone (agents would read
  another state), pulling the checkout (a clone on cards' branches), merging all clones' docs.
- **Plans outside the repository are a folder set by path, not detected** (2026-10-19, the owner,
  GitHub issue #1). Rejected: detecting a gitignored plan directory and linking it everywhere (too
  much magic); a CLAUDE.md line alone (Obeya itself must know the folder).
- **Plan docs are projects by a checklist under `## Workstreams`.** Plan-doc sync stays open (see Open
  questions).
- **The other `*.md` in the plan directory are not hidden** (2026-10-12): a repository with plans of
  its own showed an empty canvas without a reason. Deferred: a lenient parser (`Tasks`, `Milestones`,
  `Phases`), which would turn design notes into projects; a repository's own format
  (`planDocs.read`). Rejected: an agent mapping any doc into workstreams in Obeya's database, against
  "plan docs are read, never written", with no box for workers to tick.
- **The plan-directory note moves freely, its place stored on the server** (2026-10-21, a colleague):
  pinned above the projects, it jumped with each new one. Rejected: localStorage (a place is layout,
  not a reading state like hiding).
- **A workstream is known by its label, else its title, never by its place** (2026-11-02, a
  colleague): keyed by place, a doc that dropped finished workstreams and added new ones gave a new
  workstream the log and the done state of an old one. A card whose workstream leaves the doc keeps
  its log as a task of its own instead of disappearing with it. Rejected: treating a single item
  swapped at the same place as a rename (the very mix-up, once more); asking the owner for each
  card the repair moves (they would have to know every card's history); a button to take a card
  out of its project by hand (not wanted, and it read as a copy of the card); for a plan folder
  outside the repository, leaving at once (a doc saved in two edits would take a card out for good).
- **A stored `live` holds only until the read tree has what landed** (2026-10-06), so a workstream the
  doc keeps open on purpose reopens. Rejected: the worker reporting "only a part" (a second source
  against the doc); a "Reopen" button (the problem shows only when someone asks).
- **A partly landed workstream lays out as worked on, and its doc text stays in view on its card**
  (2026-10-21): done and remaining could not be told apart, nor what a running workstream was meant
  to do. Rejected: the text only as the conversation's first message.
- **A plan doc with every workstream ticked ends its project** (2026-10-12, the owner), or finished
  plans kept in a repository stay on the canvas forever; the owner archives it (see Projects end).
- **Plan docs are not read while git is at work in the read tree** (2026-11-11): a pull with rebase
  in the checkout showed `origin`'s files for a moment, where a doc deleted only locally was back,
  and its archived project came back to the canvas for good. Told by what git keeps in its directory
  meanwhile (the index's lock, a rebase's or merge's state), without git. Rejected: marking only
  Obeya's own git calls (a pull by hand does the same).
- **A plan doc that disappears ends its project automatically** (2026-10-01); an explicit
  "Finish" may sit on top later. Rejected: reading old content from git history (fragile).
- **The configuration is the file `canvases.json`**, edited in the UI or by the Coordinator
  (2026-10-01); saving a command-line configuration switches Obeya to the file. Building a card in a
  new repository adds to it as well (2026-10-28), with the repository's canvas named after its
  folder.
- **"New repository …" is an entry of the card's repository picker, which shows only where there
  is a choice or a new repository is picked** (2026-10-28, the owner): a picker on every card of a
  canvas with one repository made each card harder to use for a rare step. The owner says it (to the
  idea's agent or to Obeya), and the picker then shows the target. Rejected: the picker always
  visible; a button of its own.
- **A broken canvas or repository leaves the rest running** (2026-10-09).
- **The configuration shows before its check, whose git calls run in parallel off the server's
  thread** (2026-10-15): run one after another (109 calls for three canvases), they froze the server,
  every page load included, for seconds; now 41 calls take about 60 ms.
- **The configuration is a dialog nearly the window's size, sections on the left** (2026-10-09, the
  owner): visited now and then, not worked beside. Rejected: a narrow sidebar of nested frames.
- **One canvas at a time, listed under Canvases on the left; one repository at a time, as tabs;
  settings always shown, in groups** (2026-10-28, the owner): all canvases one below the other, each
  repository's settings folded behind a line, made a long page in which the owner lost track of which
  canvas a field belonged to, and a fold hid what was set. Saving stays one for all canvases, as the
  file is one. Rejected: repositories as a third level of the list (the list stays the canvases).
- **Existing clones first, new ones on top, with the sum** (2026-10-21): with "Create clones" first, a
  colleague typed 2 beside 2 existing ones and got 4. Clone origins match across URL forms (https and
  ssh clones of one repository otherwise kept a canvas from starting).
- **The takeover into `.obeya/settings.json` saves pending changes itself** (2026-10-15), rather than
  being off with "Save first", which read as if saving were the takeover; the setup button says
  an agent fills in the settings.
- **A repository without settings gets the setup card offered before saving and proposed on its
  canvas** (2026-10-28, the owner): shown only once the canvas was saved and only in the dialog, the
  button went unnoticed, and canvases ran with guessed settings. Once per repository, since a
  proposal that comes back after a dismissal would nag. Rejected: a banner on the canvas (a second
  form of the same offer beside the proposal, which already has accept and dismiss).
- **Interface, conversation and repository each have a language** (2026-10-20, the owner): with one
  setting, switching the UI to English turned every agent English. Rejected: two machine-wide
  settings (they follow neither the owner's spoken language nor keep git English); a per-canvas
  override, which mirroring the owner's words covers.
