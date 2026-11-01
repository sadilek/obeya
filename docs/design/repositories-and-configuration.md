## Repositories and configuration

A chapter of the [design doc](../design.md), whose header says how it is written.

### Canvases and repositories

Each repository on a canvas has its own settings, workspaces, workers, project agents and PR watcher;
the canvas has one board and one Koordinator, whose collision checks stay within a repository. The
first repository is the canvas's home; the others' plan docs are referenced as `<repo>:<path>`. The
owner's cards carry their repository, chosen in the panel before work begins (home by default); on a
canvas with several repositories every card names its own. The picker (on a planned task, and on an
idea beside „So bauen“; built once for both) lists the canvas's repositories and „Neues Repository
…“: a folder (it starts beside the home repository) and „eigene Leinwand“ (on by default; off, the
repository joins this canvas). Picked, it reads „super59 (neu)“, and starting or building the card
creates that repository first (see Building in a new repository); it is saved as it is picked,
like anything entered on a card. It shows on a canvas with several repositories, and on a card
whose new repository is picked already (by the idea's agent from the conversation, or by the
Koordinator from the owner's words); on a canvas with one repository a card without one shows no
picker. A proposal's picker
offers only the canvas's repositories. A card leaves its canvas only built in a new repository with
a canvas of its own; it then refers across canvases to the cards it came from or that come from it.
A proposal goes to the repository its agent names, the one where the change is to be made, and
otherwise inherits its card's: a worker in one repository often notices what needs changing in
another (one drafting posts about the app sees what the app lacks), and a proposal filed under the
wrong repository would start its worker in the wrong place unless the owner noticed and switched it.
That repository may be on another canvas: the proposal is then made there, at a free spot, and waits
for the owner on that canvas (its count in the switcher), with „Vorgeschlagen vom Agenten der Aufgabe
„…“ auf der Leinwand „…““ and a link to that card; the proposing card's conversation names the canvas.
Its agent can take it back or replace it there as on its own canvas, and the worker that takes it on
reads the card it came from as with any follow-up.

The UI opens `/c/<canvas>` (see Addresses in The canvas); the pill after the logo switches canvases. Cards on other canvases that
need the owner show as a count at their entry in the switcher and, while it is closed, as the sum on
the pill, kept current on every page. Wherever canvases are listed (the switcher, the phone) they
stand in the configuration's order, so the owner sets it by moving them in the Konfiguration dialog;
the first is also where a page of a stopped canvas goes. A canvas without a name in the configuration is named after
its first repository (the name in its `origin` URL, else its directory's), and its id follows, so all
clones of a repository share one canvas. Which canvas a repository is on is this machine's alone.

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

### Lesestand

Every git repository of a canvas has a directory on its main branch, the Lesestand. Plan docs are
read from it (unless outside the repository, see A plan folder outside the repository), and the
agents that answer or judge rather than work on a card run in it: project agents, ideas' exploration
agents, the Koordinator (with its look-ups, learner and Rückschau), the Arbeitsrückschau and the
voice commands' session. A folder without git is its own Lesestand (see Folders without git).

Where work lands on the local main, the Lesestand is the configured checkout itself, which is always
on main, uncommitted plan docs included. Otherwise the configured checkout is often a pool clone on a
card's branch, so the Lesestand is a detached worktree of it under Obeya's home
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
Lesestand to the worktree when work now lands elsewhere runs the same way, the checkout read until
the worktree is there. Only making it when the canvas starts waits for git: the checkout, the only
thing to read meanwhile, may be on a card's branch.

### Plan docs

A doc in the repository's plan directory (`planDocs`) is a project when its `## Workstreams` section
has a checklist; each top-level item is a workstream (`**W3:** Title. Details`). A pull request's
number before the text (`**W3:** #27. Title. Details`, as a worker may tick it off) stays part of the
title instead of becoming all of it, so the tile and the sheet still say what the workstream is
(issue #12, 2026-10-26). Checked means
`live`, `(in review)` after the label `in PR`, anything else `planned`. The goal is the first
paragraph under `## Goal` / `## Ziel`. Obeya reads plan docs and never writes them; workers tick off
their workstream in the doc as part of their change. A plan card is stored when first seen, so the
owner's placement persists; its title, text and state always come from the doc. Each read keeps the
doc's last state on the project.

#### A plan folder outside the repository

For plans kept out of the repository (gitignored, or a folder of their own), the plan directory may
be an absolute path or one from `~`, set on this machine. Obeya reads and watches the docs there as
they are, and names each by its absolute path with forward slashes (so a Windows drive does not read
as a repository id), as the agents do. Workers on this machine get the folder as an extra directory:
ticking a workstream there takes effect at once and goes into no commit, though the card's work in
progress still wins until it lands. A doc „Als Projekt planen“ writes there cannot land, so Obeya
names it at the start (the card's title, `-2` on a clash) and keeps it on the card; it shows as a
project once written, and the project takes the card's place once approved (the card is done without
a change). Workers on other machines do not reach the folder.

#### Docs that are no projects

The other `*.md` in the plan directory are not hidden: a quiet note at the top left of the projects
names the directory and lists each doc with its reason (no `## Workstreams`, or one without a
checklist) and „Als Projekt aufbereiten“. That starts a card whose worker adds the checklist (and
`## Goal` if missing) in the doc's own style, turning tasks kept under another heading into it; once
landed, the doc is a project. Meanwhile the doc's row shows „Wird aufbereitet“ and opens the card.

A repository with no plan doc that never had a project gets a dashed note there instead: where Obeya
looks, that „Als Projekt planen“ on an idea or task card writes the first doc there, and „Ordner
ändern“, which opens the configuration at the repositories. Its × („Ausblenden“) hides it for that
repository and directory in this browser, since a canvas without projects is a normal state; another
plan directory brings it back. The note on docs that are no projects has no ×: each row is something
to do. The owner drags either note like a card; from then on it stays there (stored with the canvas,
the same in every browser) and new cards go clear of it. Until dragged, it follows the projects.

#### A workstream's state

Work in progress (working, waiting, in PR, approved) wins over the doc, so a workstream ticked off on
its branch still waits for its merge. Then a ticked workstream is `live`; otherwise the stored state
counts (`done`, `planned`), and without one the doc's. `done` (finished without a change) stays: the
doc has nothing to say about it.

A stored `live` holds only until the Lesestand has what landed. A card keeps the commit it landed
with (on main after a direct landing, the merge commit for a pull request, else the Lesestand's
commit after the next fetch). When the Lesestand has it and the workstream is still unchecked, only
part is done: the card goes back to `planned`, logs „Teil gelandet, im Plan-Doc weiter offen.“ and
shows „Teil gelandet · PR #821“ (or the commit) until the rest lands. Its log and handover stay, its
branch goes, so a new run starts fresh from main and hears what landed. Unfolded, it shows what the
doc still holds open, what landed (with its pull request and last demo) beside the conversation, and
„Rest starten“.

A worker still finishing after the landing keeps its card live until done. A workstream in a pull
request whose box the main branch ticks off counts as merged even where the PR watcher missed the
merge: its worker hears so and finishes, and its clone returns to the pool.

#### Reading a plan doc

The project's sheet lists each workstream with label, title and, below in smaller type, the rest of
its item (text and sub-items), then its state, since a title alone is often too short to tell what
a workstream is (2026-10-21); details the doc keeps in sections of their own stay in the doc. A workstream's card names its doc at the top (the
path and „Im Plandokument lesen“) and shows the item's text in every state: alone while planned,
beside the conversation while queued, and once an agent works on it on the left under „Plan-Doc“,
above what came of the work, in full, or its first three lines with „mehr“ above a demo or files.

„Plandokument lesen“ in the project's sheet widens it and shows the doc rendered, kept current with
the file; from a workstream's card it opens at that item. Esc goes back to the workstreams. The
server hands out only docs it shows as projects, by project card, never by path.

#### When a project ends

A plan doc with every workstream ticked, or one that disappears, ends its project (see Projects end).
The docs as last read decide, checked again whenever a card changes, since a worker finishing after
the landing holds its project (for a doc that is gone, as it last stood; that worker's turn end reads
the docs again). A doc already done when first read goes straight into the archive. A renamed doc
makes a new project and leaves the old one archived.

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

The fields: `land`, `direct`, `autoMerge`, `checks`, `setup`, `planDocs`, `softPaths`, `workspaces`,
`prNoise`, `language` (see Language), `app` (`run`, `stop`, `keep`) and `demo` (`language`, `site`:
see Static sites). Only what Obeya itself acts on is a command: `stop` and `keep` park a waiting card
(see Parking). `run` is prose, for any kind of app (a web app, a CLI, a desktop or mobile app):
every worker's brief has it word for word. Obeya neither starts the app nor looks for its address;
the agents do, and a worker reports the address once the app runs (see Trying the app by hand). Each
field of `app` and `demo` is a setting of its own, so this machine may set `app.stop` and leave
`app.run` to the repository.

Precedence, highest first: this machine's values, `.obeya/settings.json`, detection (main branch,
landing), Obeya's defaults (which cover any repository with `docs/plan/`). The dialog shows each value
with its source („auf diesem Rechner“, „aus dem Repository“, „Klone eingetragen“, „erkannt“,
„Standard“), and „Zurücksetzen“ takes a value set here back to it. An empty list or command is a
value of its own (no checks); an empty main branch or plan directory is none. A main branch the
repository has neither locally nor on `origin` keeps the configuration from being saved.

Settings are read where they are used, so saving them restarts nothing (see Live configuration); the
canvases follow: the Lesestand moves when work now lands elsewhere, the plan directory is watched
afresh, a repository now landing through pull requests gets its PR watcher (one leaving them keeps it for the
pull requests still open), and the page shows the
main branch and how work lands. `workspaces` is the exception: changing it restarts that repository's
agents, as the dialog says at the field, which sits in the repository's row (see Leinwände).

#### `.obeya/settings.json`

`.obeya/settings.json` (like `.vscode/settings.json`) is what a fresh clone brings: every value but
the main branch, versioned and reviewed with the code it describes. It is read from the main branch,
not the checkout, since clones are on cards' branches, perhaps from before the file changed: when a
canvas starts, whenever the Lesestand moves, and on save, by git without the server waiting for it;
a save while the branches have not moved keeps the last read. A new version takes effect without a
restart; one that changes `workspaces` restarts the repository's agents once they paused (see
Restarts for landed code).

„Für alle ins Repository übernehmen“ below the form takes this machine's saved values (but the main
branch and the share command) into the file, keeping what else it holds, after showing the file as
it will be. Unsaved changes are saved first, as the confirmation says; only where saving restarts
Obeya (a command-line configuration) is the button off. Where work lands on main, Obeya commits the
file there without touching the checkout's other changes, staged or not (a commit made beside the
checkout: temporary index, `commit-tree`, `update-ref`); a checkout on main gets the file as committed, and one with its own
changes to the file refuses. Where work goes through pull requests, the commit goes to a branch `obeya-settings-<time>`
and a pull request, linked in the dialog; with `direct`, the dialog also offers to push it onto
`origin`'s main (never forced, so a protected branch refuses). Once the file holds the values (at
once, or when the merge reaches the Lesestand), they go from this machine's settings and show as from
the repository. The Arbeitsrückschau proposes single values too (see Setting proposals).

#### Problems in the settings

The file's fields are checked against a schema. An unknown field (named with the one it probably
meant: `check` → `checks`) or one of the wrong type does not count, a mistake inside it taking the
whole field: the default stands in, the rest works. Each is the problem `repoSettings`, also in the
log at start and on each new version. A demo site without title, http(s) URL or deploy command, or
whose deploy program is missing, is `demoSite`; until fixed, „Teilen“ exports demos. A main branch
still holding `.obeya/adapter/index.ts` is `adapterGone`: the module is not read, and the setup
button (see Leinwände) offers to move it into the settings. Untrusted commands are `untrusted` (see
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

Held groups are the problem `untrusted` in „Konfiguration“: what each group does, a diff of the
lines as last trusted against the main branch's now, and „Diesen Befehlen vertrauen“, which trusts
exactly what was shown (refused where it changed meanwhile; also for a repository not saved yet), and
the canvases follow at once. Held values show „aus dem Repository, noch nicht vertraut“. A worker's
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

### The Konfiguration dialog

The „Konfiguration“ dialog covers the page but for a margin (a press there or Esc closes it,
leaving what was open behind it as it was). Its close button stays at the top right however far
the section scrolls, so a click meant to close never lands on what scrolled under it. What removes
an entry (a canvas, a repository, a machine) is a waste bin, not a cross that passes for a close
button, and shows only while the pointer or the focus is on its entry (a canvas: its title line; a repository: its path),
always where nothing hovers (touch). An unsaved draft survives per tab, also a reload or
restart. Its sections, listed on the left and shown one at a time (the last one chosen per tab):
Leinwände, a heading with each canvas indented under it as a section of its own and „+ Leinwand“
last (see Leinwände), Modelle und Effort, Spracheingabe, Demos, Von anderen Geräten (see Other devices) and Allgemein
(languages, light or dark, the usage limits in the bar, the server); below them „Einrichtung prüfen“ and „Wunsch oder Fehler
melden“ (see Wishes for Obeya's makers). Each canvas in the list marks its unsaved changes and
counts its problems in red; the heading counts the problems of no one canvas (none at all, say). Each section names the file it is saved in; settings are rows of label and control, no boxes in
boxes. What to know about a field sits behind an info icon at its label, shown only while the pointer
or focus is on the field, its text appearing at once.

The dialog shows the saved configuration at once and what it amounts to once checked („Repositories
werden geprüft …“ until then): problems, each repository's id and settings with their sources. The
check reads each repository with git once however often it is named, all in parallel, without
blocking the server.

#### Leinwände

A canvas chosen in the list fills the right side; first the one the page shows, then the last one
chosen per tab, or the one a jump into the dialog names (a card waiting for a free clone, a proposal
for a setting), scrolled to the field. Its page has a title line (name, id, whether it runs, and with
several canvases ↑ and ↓ that move it one place, as in the queue), its name, and its repositories
as tabs (the home repository first, each counting its problems), with „+ Repository“ beside them;
one repository shows at a time. A move is a change of the draft like any other. All canvases are
saved together with „Speichern“ at the bottom of every canvas's page, which says so while several
have changes. Renaming a canvas keeps its id and cards.

A repository's page is its path, its problems, then its settings in groups under a small heading
each, always shown: where its agents work („Agenten arbeiten in“: Worktrees or Klonen, with its
source, the clones, slots and other machines), branch and landing (main branch, landing, direct,
auto-merge, accounts without review, soft paths), app and checks (setup, checks, „So läuft die
App“ in a large text field, „Stoppen, solange eine Karte wartet“, the keep condition once there is
one), plans and language (plan docs, „Sprache des Repositorys“), demos („Sprache der Demos“,
„Demo-Site“ with title, URL, deploy command, env file, headers, largest file, tags and when a demo
goes on it, all behind „Anderer Hoster, von Hand eingetragen …“ beside „Demo-Seite einrichten …“ while it has
no site), then „Für alle ins Repository übernehmen“. A folder without git has no workspace or
branch group.

Klonen shows the existing clones („Vorhandene Klone, einer pro Zeile“), then the ones Obeya makes on top of them („Dazu neue Klone
anlegen“), the slots, the sum („Zusammen 4 Klone auf diesem Rechner (2 vorhandene, 2 neue)“) and the
other machines; Worktrees only the slots. With no clone the line warns that no card would start. For
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
settings) show at it and block nothing. Technical detail folds under „Details“; each saved problem
offers „Aufgabe zum Beheben anlegen“, which asks the Koordinator of its canvas to create a task fixing
it. The „Konfiguration“ button in the bar counts the saved configuration's problems in red, kept
current also when a repository's settings change on its main branch.

A repository with nothing in its own `.obeya/settings.json`, or with `adapterGone`, says that Obeya
does not yet know how its app starts, which checks run and how to demo it, and offers „Von einem
Agenten ausfüllen lassen“ as soon as its path is checked, before the canvas is saved: the card
„Obeya für <repo> einrichten“ (or the one still open) at the top right of that canvas, opened there.
Unsaved changes are saved first, as the hint says; only where saving restarts Obeya is the button
off. Its worker uses `obeya:settings` and settles the plan directory: it looks for plans the
repository already keeps (`docs/`, `rfcs/`, `adr/`, `PLAN*.md`, `TODO.md`) and asks the owner in its
one question whether that directory or a new `docs/plan/` holds them.

The canvas proposes the same card by itself: once a repository without settings of its own (a git
repository, not a folder) runs on it, the card waits there as „Vorschlag von Obeya“, with the same
title and text and the dialog's reason beside it. Accepted, it is the owner's card as the button
makes it (no mark of an agent's proposal); the button, pressed while the proposal is open, accepts it
as planned and opens it. Obeya proposes it once per repository and canvas: dismissed, accepted or made
from the dialog, it does not come back. A proposal still open goes by itself once the settings are on
the main branch, withdrawn rather than dismissed.

#### Saving

Saving writes the file and applies it at once without a restart (see Live configuration); the dialog
says so, and where a repository's agents restart for it, that they do once paused. Started with
repositories on the command line, Obeya saves with „Speichern und neu starten“: the file becomes the
configuration it restarts with once no worker is mid-turn, and the page reloads.

The server's own settings (port, data directory, the agents' permission mode) come from the command
line and environment (`OBEYA_PORT`, `OBEYA_HOME`) and show read-only. The Koordinator reads the
configuration (`config`) and changes it on the owner's word (`configure`, checked like the dialog's,
see Confirmation and undo). `configure` takes the whole list in the shape of the file, every field of
it, so what the owner did not ask to change passes through as it was: a field it left out would
fail every change while one entry has it (a folder's `git: false` dropped, that folder is checked as
a git repository). The dialog says so under its title, with „Obeya fragen“, which closes it
and opens Obeya's conversation (Space for voice does not reach Obeya while the dialog is open).
The other sections save on their own, restarting nothing: the demo settings into `demo.json` (see
The demo settings and voices), the personal demo site below them into `personal-site.json` (see The
personal site in Sharing demos), languages, theme, models and whether the bar shows the usage limits
(`usageMeter: false` when not) into `settings.json` in Obeya's home.

### Live configuration

A saved configuration, and a new version of a repository's `.obeya/settings.json`, apply while Obeya
runs, without a restart or reload. A new canvas starts at once (the setup assistant's with its welcome
card), a changed one takes the change, a moved one moves in every list at once, a removed one stops once its agents paused, its cards kept. A
new name, a new repository and settings that leave the agents where they work apply at once.

What a repository's agents are set up by (its clones, existing workspaces, slots, other machines,
`workspaces`) restarts that repository's agents alone; a repository that left the canvas stops. Its
workers pause at a safe point (at most 15 minutes), the set-up starts again as configured, and they
resume in their sessions; the other repositories work on. A worker landing such a change waits for
it (see Restarts for landed code). The bar shows the wait like a restart's („Konfiguration wartet auf …“) with
„Jetzt übernehmen“ (see Self-update). Switchers follow canvases that start, stop or change; a page of
a stopped canvas goes to the first canvas.

A repository that does not start (a refused or unmakeable clone, a git error) never leaves a canvas
half stopped: it starts again as it was before, with the problem shown at it, and failing that leaves
the canvas, its cards kept. A canvas without its home repository does not run; the others do. These
are problems of the running canvases: they block no save, count on the Konfiguration button, and
„Erneut versuchen“ applies the saved configuration again. Where no canvas started, the page says so
with the problems and that button instead of the setup assistant.

The kept cards of a repository not running on its canvas (it left the configuration, or did not
start) stay on the canvas marked „Repository läuft nicht“, with why in their panel. Nothing reaches
their agents meanwhile: starting, messages, approving and the like are refused with that reason, a
card set to start later or snoozed waits past its time, and a card the Koordinator was deciding on
goes back to planned. Only what changes the board alone (moving it in the queue, dismissing,
parking) still goes. Once the repository runs again, the cards work as before, in its workspaces.
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
lines, fixed parts it adds to an agent's question such as „(Mehrfachauswahl)“, push notifications,
its own pages; a log line stays in the language it was written in). The owner chooses it in the
dialog („Sprache der Oberfläche“); until then the system's applies (on a Mac `AppleLanguages`,
elsewhere `LC_ALL`, `LC_MESSAGES`, `LANG`, then the runtime's), English for any other. A change takes
effect at once: the page reloads, keeping what was open. The strings are two tables of one shape, so
a missing English text is a type error; both call the Koordinator „Obeya“. Dates and numbers use the
browser's variant of the language; a variant `Intl` refuses (`en-US@posix`) gives the usual one.

**The conversation language** is what agents write the owner in: reports, questions, replies,
handovers, idea briefs, card titles, Question-card answers, proposals, Arbeitsrückschau notes, the
Koordinator's replies and confirmations. Each agent answers in the language of the owner's most
recent words to it, typed or spoken, even where its work is in English; words that tell no language
(an option's letter, "ok") change nothing. Before that it uses „Sprache der Gespräche“, which follows
the interface language until chosen. It is an instruction in the prompts, not detection code. A task
the owner wrote (or the Koordinator put in from their words) counts as their first words; one from a
plan doc, a proposal, an idea's brief or the Arbeitsrückschau does not, nor do the docs a worker reads
or the owner's standing preferences (the owner, 2026-10-20: an English task answered in German looked
wrong; 2026-10-21: a worker took German from German preferences). Agents without the owner's words (conflict reasons, proposed rules) use the
conversation language; the card namer uses the task's. The Koordinator knows the owner's words for
its cards in both languages, takes examples in the conversation language, names Obeya's own cards
(„CLAUDE.md ergänzen“) in the interface language, and starts its session afresh when either language changes. An analysis
on a card is in the conversation language; a committed one is repository content.

**The repository language** is that of everything that lands in git: code, comments, commit
messages, design and plan docs, proposed CLAUDE.md lines. It is `language` in the repository's
settings („Sprache des Repositorys“), English by default. Workers and idea agents are told both
languages explicitly, so a German conversation does not make German docs.

**Demos** have their own language per repository (`demo.language`), else the demo settings' narration
language, else the conversation language; their shared pages follow it (see The demo settings and
voices). Obeya's own repository says English, since its demos go public. A worker's instructions name
that language outright, not where to look it up (2026-10-21: a worker writing an HTML artifact, which
needs no skill, read the demo settings' German and missed the repository's English).

Prompts only agents read stay English, with German examples of what the owner may say.

### Decisions

- **A canvas may span several repositories, and one Obeya serves several canvases.** Rejected: one
  canvas per repository.
- **A canvas belongs to a repository, not a checkout**, named after its `origin`, so clones share one.
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
  finding its address), since nothing in Obeya needs the address (the owner); the card's „App
  öffnen“ takes the address the worker reports (see Trying the app by hand).
- **A repository's settings are checked against a schema** (2026-10-08): a misspelt field was
  otherwise ignored silently.
- **A repository's commands and Claude Code configuration count only as last trusted** (2026-10-16),
  since the SDK runs them even in read-only sessions and switching hooks and MCP off is not enough.
  Values are kept, not hashes, to show a diff.
- **The main branch prefers the usual names to the checked-out branch** (2026-10-14). Rejected:
  `origin/HEAD` else `main`, which on a `master` repository without a remote landed on a branch that
  did not exist.
- **Plan docs come from the Lesestand on the main branch** (2026-10-06), and the read-only agents run
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
- **A stored `live` holds only until the Lesestand has what landed** (2026-10-06), so a workstream the
  doc keeps open on purpose reopens. Rejected: the worker reporting "only a part" (a second source
  against the doc); a „Wieder öffnen“ button (the problem shows only when someone asks).
- **A partly landed workstream lays out as worked on, and its doc text stays in view on its card**
  (2026-10-21): done and remaining could not be told apart, nor what a running workstream was meant
  to do. Rejected: the text only as the conversation's first message.
- **A plan doc with every workstream ticked ends its project** (2026-10-12, the owner), or finished
  plans kept in a repository stay on the canvas forever.
- **A plan doc that disappears ends its project automatically** (2026-10-01); an explicit
  „abschließen“ may sit on top later. Rejected: reading old content from git history (fragile).
- **The configuration is the file `canvases.json`**, edited in the UI or by the Koordinator
  (2026-10-01); saving a command-line configuration switches Obeya to the file. Building a card in a
  new repository adds to it as well (2026-10-28), with the repository's canvas named after its
  folder.
- **„Neues Repository …“ is an entry of the card's repository picker, which shows only where there
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
- **One canvas at a time, listed under Leinwände on the left; one repository at a time, as tabs;
  settings always shown, in groups** (2026-10-28, the owner): all canvases one below the other, each
  repository's settings folded behind a line, made a long page in which the owner lost track of which
  canvas a field belonged to, and a fold hid what was set. Saving stays one for all canvases, as the
  file is one. Rejected: repositories as a third level of the list (the list stays the canvases).
- **Existing clones first, new ones on top, with the sum** (2026-10-21): with „Klone anlegen“ first, a
  colleague typed 2 beside 2 existing ones and got 4. Clone origins match across URL forms (https and
  ssh clones of one repository otherwise kept a canvas from starting).
- **The takeover into `.obeya/settings.json` saves pending changes itself** (2026-10-15), rather than
  being off with „Erst speichern“, which read as if saving were the takeover; the setup button says
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
