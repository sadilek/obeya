# Setting up a repository: its settings

Obeya runs on any git repository as it is. What it cannot know by itself is how *this* project
works: how its app starts and stops, which checks a change must pass, how approved work lands, how
a worker records a demo and where demos are shared. A repository says that in its settings,
`.obeya/settings.json`, versioned with the code it describes (like `.vscode/settings.json`).
"Konfiguration" shows them with the repository on its canvas's page and changes them without a line of
code, for one machine or, with „Für alle ins Repository übernehmen“, for everyone.

The quickest way to get them: in "Konfiguration", a repository without settings of its own has
„Von einem Agenten ausfüllen lassen“ ("Have an agent fill them in"). It puts a card on the
repository's canvas whose worker writes them with the `obeya:settings` skill: it reads the
repository, starts the app, records a demo with it to prove the recipe, and asks you what it
cannot find out (a login, test data). This page is the reference for what it writes, and for
writing or changing them yourself.

## A complete example

A typical web app: a Node API and a Vite frontend, PostgreSQL in Docker Compose, tests and lint
in `package.json`, work landing through pull requests on GitHub, demos shared on Cloudflare Pages.

```json
{
  "land": "pr",
  "direct": false,
  "autoMerge": true,
  "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
  "setup": "pnpm install",
  "planDocs": { "dir": "docs/plan", "exclude": ["TEMPLATE.md"] },
  "softPaths": ["docs/"],
  "workspaces": "clones",
  "prNoise": ["vercel[bot]", "codecov[bot]"],
  "language": "en",
  "app": {
    "run": "Start it in your clone with `docker compose up -d db && pnpm dev`, then `pnpm db:migrate && pnpm db:seed`. The page reloads by itself after a frontend change; after an API change, `pnpm --filter api restart`. Once it runs, `.dev-urls` holds the frontend's URL (WEB_URL) and the API's (API_URL). Log in as demo@shop.test with the password `demo` (created by the seed); the seed also makes three orders to show.",
    "stop": "docker compose down && pkill -F .dev.pid"
  },
  "demo": {
    "site": {
      "title": "Team demos",
      "url": "https://demos.example.dev",
      "deploy": "bunx wrangler@4 pages deploy {dir} --project-name demos --branch main --commit-dirty=true",
      "env": "sites/demos/deploy.env"
    }
  }
}
```

Every field is optional. What the file leaves out comes from Obeya's defaults, given with each
field below (`land` is the one Obeya tells from the repository).

## The fields

### `planDocs` — `{ dir, exclude }`

Where plan docs live (relative to the repository root), and file names in that directory that are
none (a template). Obeya reads the `*.md` directly in that directory (not below it) from the
default branch. Plans kept out of the repository (gitignored, say) are a folder on one machine: set
its absolute path (or one from `~/`) in that machine's configuration, not in this file. Obeya reads
them there, and the agents on that machine tick their workstreams off there, outside any commit. One with a checklist under `## Workstreams` (or `## Arbeitspakete`) is a project:
each top-level item is a workstream (`- [ ] **W1:** Title. Details`), a ticked one has landed,
and once every one is ticked the project goes into the archive. Its goal is the first paragraph
under `## Goal` (or `## Ziel`). Any other file there shows on the canvas in a note, with the
reason it is not a project and "Als Projekt aufbereiten", which has an agent add the checklist; a
file that is meant to stay as it is (a template, an index) goes into `exclude`. Default:
`{ "dir": "docs/plan", "exclude": ["TEMPLATE.md"] }`. The skill's check script
(`plugin/skills/settings/lib/check.ts`) lists which docs in the directory are projects and why the
others are not.

### `setup` — a command

What a worker runs first in a fresh workspace, typically installing dependencies. Default: none.

### `checks` — commands

What a worker runs before it hands its work over (lint, types, tests). Each must pass; the worker
fixes what fails. Keep them to what runs in minutes on one machine, without services the clone
does not have. Default: none.

### `land` — `"pr"` or `"main"`

How approved work lands. `pr`: the card's branch is pushed and goes out as a pull request; Obeya
watches it, brings review comments and failing CI back to the worker and marks the card live once
it is merged (this needs the GitHub CLI, `gh`, logged in). `main`: Obeya rebases the branch onto
the local `main` and fast-forwards the checkout Obeya runs on, no pull request, nothing pushed.
Default: `pr` where `origin` is on GitHub (github.com, or a host the GitHub CLI is logged into),
else `main`, since a pull request needs somewhere to go.

### `direct` — boolean

With `land: "pr"`: the owner may approve a card with its button "Direkt auf main" instead, without a
pull request (never by word to the Koordinator).
Obeya rebases onto `origin`'s default branch and pushes there (never forced); a protected branch
refuses it and the card stays in review. Default: `false`.

### `autoMerge` — boolean

With `land: "pr"`: whether Obeya merges a pull request itself once nothing is left for the worker
(checks green, review threads resolved, reviewers answered on the latest commit). `false` leaves
the merge to the people on the forge, for a team that reviews and merges pull requests itself: the
card then waits for the owner, ready to merge, and turns live once someone merges it there.
Review comments and failing checks still go to the worker either way. Default: `true`.

### `softPaths` — paths

Paths whose edits never count as a conflict between two cards' branches (a trailing `/` covers a
directory): Obeya resolves them itself when it rebases. Use it for docs that many cards touch.
Default: `["docs/plan/"]`.

### `workspaces` — `"clones"` or `"worktrees"`

Where workers work. `clones`: a pool of full clones per repository, leased by one card at a time;
the number comes from "Konfiguration" (clones to create, or existing ones to use). Use it when
every workspace runs its own app (ports, a database, Docker) or the tools break in a git
worktree. `worktrees`: a git worktree of the configured checkout per card, any number in parallel
unless "Konfiguration" gives the repository slots. Default: `worktrees`. A repository whose
configuration names clones (clones to create, existing ones, or other machines) works in clones
whatever the settings say.

### `prNoise` — account names

Accounts whose pull request comments are not review feedback (deploy previews, coverage bots):
their comments do not go to the worker. Default: none.

### `language` — `"en"` or `"de"`

The language of what lands in the repository and lasts: code, comments, commit messages, docs,
plan docs, the CLAUDE.md lines the Arbeitsrückschau proposes. Workers and idea agents are told it
beside the language they talk to the owner in, so a German conversation does not make German docs.
What agents write to the owner follows the owner instead (their latest words, else the conversation
language of the Konfiguration), and demos follow `demo.language`. Default: `en`.

### `app` — `{ run?, stop?, keep? }`

How the app runs, for any kind of app (a web app with or without hot reload, a frontend that needs
a reload, a CLI, a desktop or mobile app). Only `stop` and `keep` are commands, since Obeya runs
them itself; how the app starts and where it is, the workers find from the recipe.

- `run`: the recipe, in prose, written for a new colleague: how to start the app (in the
  background, which ports), what to do after which kind of change (restart the API, reload the
  page, rebuild; nothing where it reloads by itself), where the app gives its address (a file it
  writes, the console), migrations and test data, how to log in and as whom for a demo, and what
  to stop afterwards. Every worker gets it in its brief word for word, not only for its demo;
  `bun lib/recipe.ts` of the demo skill prints it. Without one, each worker finds out from the
  repository how to run the app.
- `stop`: stops the app in a workspace, and does nothing where none runs. With it, Obeya parks a
  card that waits for the owner (handed over, asked, its pull request open) once its worker has
  nothing running and five minutes have passed: it runs `stop` in the workspace (through `sh -c`,
  `cmd /c` on Windows), so a waiting card costs disk, not memory. The worker's next message tells
  it the app was stopped; it starts it again as the recipe says when it needs it. A stop that
  fails is an error on the card. An app the owner opened from the card to try it by hand („App
  öffnen“, offered while it runs) is stopped no sooner than 30 minutes after.
- `keep`: run before `stop`; exiting 0 means the app holds what must not be lost (a restored
  database, say), and Obeya leaves it running and says so on the card. The owner who wants it
  stopped anyway tells the worker.

Each of the three is a setting of its own: this machine may set one and leave the others to the
repository. `stop` and `keep` from the file run only once you trusted them (see Commands you trust).
Default: none.

### `demo` — `{ language?, site? }`

Demos: every handover brings one, a narrated video recorded with Obeya's demo skill or an HTML
page for something to look at; the worker picks which, and runs the app for it as `app.run` says.

- `language`: `"de"` or `"en"`, the language of the repository's demos: their narration, chapters
  and report, the pages they are shared on and the site's overview. It goes before the narration
  language of the demo settings (each machine's, in "Konfiguration"), which applies without it. Obeya
  gives it to its workers as `DEMO_LANGUAGE`, which the demo skill reads; a session without Obeya
  finds it in the repository's `.obeya/settings.json`. A voice that clones a clip uses the clip of
  this language, so each machine's demo settings name one per language.

- `site`: a static site Obeya keeps and deploys itself, so that "Teilen" puts a demo on a page for
  colleagues, for a host that takes a directory (Cloudflare Pages, Netlify, an S3 bucket, a
  directory a web server serves, GitHub Pages). Without a site (or without its credentials on this
  machine), "Teilen" puts the demo on your personal demo site (Konfiguration → Demos), unlisted,
  and without that exports it as a file. „Demo-Seite einrichten …“ in the repository's settings
  creates a site at Cloudflare Pages or GitHub Pages and fills this in:

  ```json
  "site": {
    "title": "Team demos",
    "url": "https://demos.example.dev",
    "deploy": "bunx wrangler@4 pages deploy {dir} --project-name demos --branch main --commit-dirty=true",
    "env": "sites/demos/deploy.env",
    "headers": { "CF-Access-Client-Id": "${CF_ID}", "CF-Access-Client-Secret": "${CF_SECRET}" },
    "maxFile": 26214400,
    "publish": "approved"
  }
  ```

  `title` is the overview's heading and the pages' tab titles; a page is at `url/<slug>/`.
  `deploy` is a command line with `{dir}` for the site's directory, run in a directory under
  Obeya's home with `OBEYA_REPO` set to the repository's checkout (a program given as a path is
  found in the repository; a script runs with Obeya's Bun). `obeya:github-pages <owner>/<repository>`
  is the deploy Obeya builds in for GitHub Pages: the directory as one commit without history,
  force-pushed to the repository's `main` with gh's login. Optional: `env`, a file of
  `KEY=value` lines relative to Obeya's home; `headers`, for reading the live site behind a login,
  `${KEY}` from `env`; `maxFile`, the largest file the host takes in bytes (25 MiB without it);
  `publish`, when a demo goes on the site: `"approved"` puts a card's latest demo there as you
  approve its work, without it a demo goes there only when you click "Teilen". The overview is
  in `demo.language`. A `language` of the site, which named the overview's language
  until 2026-10-19, is no longer read: `demo.language` names it now.

  With `publish: "approved"`, approving a card shares its latest demo before its work lands: on a
  page of its own, or, where the card has a page already, in place of the versions there, or
  beside them where its worker said the demo only supplements the one before. It goes out like
  any share; the landing does not wait for it, and a deploy that fails goes into the card's log
  without holding up the landing. Where work lands on the main branch itself (`land: "main"`, or
  approved "Direkt auf main"), the commit that lands for a card with a page names it in a trailer,
  `Demo-Video: <url>` (`Demo-Page: <url>` for an HTML artifact); a pull request gets a line in its
  description instead.

  Obeya keeps the site in `sites/<host and path of url>/site/` under its home, writes each page
  (in its demo's language) and the overview with its own templates, and after each share or
  withdrawal runs `deploy` with the `env` file's values in its environment. Credentials go into
  the `env` file on each publishing machine, never into git; a machine without it exports demos
  instead, and "Teilen" names the file it lacks. Without `env`, the deploy uses the machine's own
  login.

  Several machines may publish to one site. Before each change Obeya reads the live site's
  manifest (`obeya-site.json`), takes over the pages other machines published or withdrew, and
  only then deploys; a manifest it cannot read (a login without `headers`, the host down) refuses
  the deploy, since deploying blind could take other machines' pages offline. Pages shared from
  here that a later deploy from elsewhere took offline are deployed again.

  The pages get a look of the repository's own from `.obeya/theme.css` beside this file, a
  stylesheet put into every page after Obeya's own (as the default branch has it): its colour
  variables, fonts, a logo as a `data:`-embedded file of `.obeya/`. It is a file, not a setting;
  which parts of the pages it can style is in the design doc's chapter „Sharing demos“ (A
  repository's theme). A changed theme leaves the pages shared before it outdated, to share again.

A site from the file is deployed to and read only once you trusted it (see Commands you trust).

Each of the two is a setting of its own. Default: the demo settings' language, no site.

### Not in the file: the canvas

The canvas a repository is on, its name and id, are in "Konfiguration" too. Without a name, a
canvas is named after its first repository (the name in its `origin` URL, else its directory's).

## Which value applies

Every machine that runs Obeya on the repository reads `.obeya/settings.json`, a fresh clone
included. Which value applies, highest first:

1. The one set for this machine in "Konfiguration" (a repository's settings on its canvas's page; kept in
   `canvases.json` in Obeya's home, never in the repository).
2. `.obeya/settings.json` **as the default branch has it**.
3. What Obeya detects (`land`, the main branch).
4. Obeya's default.

"Konfiguration" shows each value with where it comes from („aus dem Repository“ for the file).
The file is read from the default branch (the local one when it has all of `origin`'s commits,
else `origin`'s as last fetched), not from the checkout: the clones a canvas works in are on
cards' branches most of the time. So **a change committed on a branch does nothing yet**; it
counts once it is on the default branch, and then without a restart (Obeya reads it again whenever
it reads the default branch anew: a landing, a merged pull request, a fetch). The one exception is
`workspaces`: clones or worktrees are set up when a repository's agents start, so a change to it
restarts that repository's agents once they paused; Obeya and the other repositories work on.

The main branch is not in the file, since it says where the file is read from: a fresh clone has
it from `origin`'s HEAD, and a machine that needs another sets it in "Konfiguration".

**From "Konfiguration".** Below a repository's settings, „Für alle ins Repository
übernehmen“ takes the values set for this machine (all but the main branch) into the file. It
shows the file as it will be and where it goes; where work lands on the main branch, Obeya commits
it there (beside the checkout, which keeps everything else as it is; a change of its own to the
file is refused), and the values then come from the repository on this machine too. Where work
goes out as pull requests, Obeya pushes the commit to a branch of its own (`obeya-settings-…`) and
opens a pull request against the main branch; this machine keeps its values until the pull
request is merged, then they come from the repository. Where work may also go straight to main
(`direct`), it offers to push the commit straight onto `origin`'s main branch instead (never
forced; a protected branch refuses it). What the file holds beside them stays.

## Mistakes

Obeya checks every field of the file. A field it does not know (`check:` for `checks:`) or of the
wrong type (`"checks": "pnpm test"` instead of a list) does not count, and a mistake inside one
(`app.stp` for `stop`) takes the whole field along: Obeya's default stands in
its place, and the rest of the settings work. Each one shows as a problem at the repository in
"Konfiguration", starting with `.obeya/settings.json`, with the field and, for a misspelt one,
what it probably meant (`check: no such field (did you mean checks?)` under "Details").

A demo site without a title, an http(s) URL or a deploy command, or whose deploy program is not
there, shows the same way; until it is complete, "Teilen" exports demos. A `.obeya/adapter/` on the
main branch, from before Obeya read everything from the settings, shows as a problem with „Von
einem Agenten ausfüllen lassen“ beside it, whose worker moves what it says into the settings and
deletes it. These problems keep nothing from being saved, since they are fixed in the repository;
Obeya's log names them when it starts. "Aufgabe zum Beheben anlegen" beside a problem has Obeya
create a task that fixes it.

## Commands you trust

Some fields are commands Obeya runs on your machine itself, or addresses it contacts without a
click: `app.stop` and `app.keep`, and the demo site's `deploy`, `env`, `url`, `headers` and
`publish` (which deploys without a click on "Teilen"). Beside
them, the agents' sessions run what the repository's own Claude Code configuration names
(everything under `.claude/` and `.mcp.json`: hooks, MCP servers, helpers) without asking. A repository cloned from someone else, or a change a colleague merged, can change
them without you noticing, so Obeya holds each of them that is new on the default branch, or
changed there, until you trust it:

- a held `stop` or `keep` does not run: a waiting card's app keeps running;
- a held demo site is neither deployed to nor read: "Teilen" exports demos;
- a held Claude Code configuration is not read: the agents work in the repository without it (and
  get its CLAUDE.md in their instructions, since Claude Code reads that with the configuration).

"Konfiguration" shows them as a problem at the repository, counted on its button in the bar: what
each does, a diff against what you trusted last, and „Diesen Befehlen vertrauen“ („Trust these
commands“), which lets them run from then on, as long as the default branch has them so. What you
set for this machine needs no trust, and neither do values you take into the file with „Für alle
ins Repository übernehmen“.

## Testing the settings

1. **Every field counts.** In the repository, with the settings in the checkout (committed or
   not), run the settings skill's check from an Obeya checkout:

   ```bash
   bun ~/dev/obeya/plugin/skills/settings/lib/check.ts
   ```

   It prints what Obeya makes of them (setup, checks, landing, workspaces, the plan docs, the
   app's recipe and commands, the demo site) and every problem "Konfiguration" would report for them, and
   exits with 1 when there is one. A worker runs it as `bun ${CLAUDE_SKILL_DIR}/lib/check.ts`.
2. **The commands work.** Run `setup` and each of `checks` in a fresh clone; start the app as
   `app.run` says and open it; run `app.stop` and see it stop.
3. **A demo comes out of `app.run`.** Record one with the demo skill, following the recipe and
   nothing else. This is what the settings skill does before it hands over.
4. **On a canvas, once it is merged.** A canvas reads the settings from the default branch only,
   so steps 1–3 are what can be tried before the merge. Once they are on the default branch, the
   next card started gets its brief from them; new or changed commands wait in "Konfiguration"
   until you trust them.
