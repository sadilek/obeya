## Data

A chapter of the [design doc](../design.md), whose header says how it is written.

Everything that has to survive a restart of Obeya lives in one SQLite database; what git, GitHub
and the repositories already know is read from them, not stored.

Persistent (SQLite):

- canvases, their per-canvas settings (home repository, whether the owner paused its agents, the card collecting each repository's
  CLAUDE.md rules, the Rückschau's and Arbeitsrückschau's counts and when they last ran), groups
  and each card's group;
- cards with everything shown on them or needed to resume them: kind, state, position, parent, the
  card they came from; the agent session, workspace, branch and status line; the open question or
  handover (with the reason when there is no demo); queue, scope, snooze (until when, by whom,
  why); the pull request and what of it was already passed on to the worker; on a review card, the
  contributor's pull request (author, whether maintainers may push, the head handed over, the
  checks and merge probe, the findings with what came of each, the change request waiting for the
  contributor); an approval held until the work can land; landed work whose worker still finishes;
  a waiting card's stopped app; the clone that keeps a card's branch since its workspace was taken
  from it;
  proposals waiting for the owner; the new repository a card is to be built in, and that Obeya made
  it; an idea's brief, open questions and picks; a prototype's idea
  and outcome; a project's plan doc as last read and the plan docs its landed work added; its short
  code for addresses (see Addresses in The canvas), unique across the database;
- card events (the conversation log, with the owner's screenshots and agents' mocks), workspaces
  and their leases, what a card changed in a folder without git and its undo there;
- the Koordinator's conversation with the owner and the threads of looked-up questions (the
  question, its answer and files, the card it moved onto, the step to take once the answer is in),
  and the cards that left the canvas for another;
- confirmed commands waiting out their undo window;
- shared demo pages (slug, link, what the page shows, the change it was published after, whether it
  is publishing or withdrawing) and a running re-share of outdated pages;
- paired devices (a hash of the cookie, never the cookie itself; name; push subscription);
- the decision log, preferences, the friction noted on each card's runs and the settings changes
  the Arbeitsrückschau proposed from it.

Files under `~/.obeya/` (the same for the app and a checkout): the database (`obeya.db`), the
owner's screenshots (`images/<canvas>/`), other files the owner dropped into a field
(`files/<canvas>/<uuid>/<name>`), the configuration (`canvases.json`), the settings
(`settings.json`, `demo.json`, `voice.json`), where the running Obeya answers (`server.json`), the
`tailscale serve` entry Obeya made (`tailscale-serve.json`), the key it signs pushes with
(`vapid.json`), the app's server log (`app.log`), the stalls of the server and its pages (`stalls.log`, see Running Obeya), voices and models (`voices/`), the workers'
clones and worktrees (`workspaces/`), the Lesestand's worktrees (`read/`), the cards' undo in
folders without git (`undo/`), the files of looked-up answers (`answers/<canvas>/<thread>/`), the
static sites Obeya keeps (`sites/<key>/`), the env files their repositories' settings name
(relative to the home, `sites/demos/deploy.env`, say), and `share/`, the directory deploys run in.

Derived, not stored: git, PR and CI state (read from git and GitHub), plan-doc content (read from
the repository; the copy on the project is only for the archive).
