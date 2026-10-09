# Setting up a repository: its adapter

Obeya runs on any git repository as it is. What it cannot know by itself is how *this* project
works: how its app starts, which checks a change must pass, how approved work lands, how a worker
records a demo. A repository says that in its adapter, a small TypeScript module at
`.obeya/adapter/index.ts`, versioned with the code it describes (like `.vscode/` or `.claude/`).

The quickest way to get one: in "Konfiguration", a repository that runs on the generic adapter has
"Adapter einrichten lassen" ("Have the adapter set up"). It puts a card on the repository's
canvas whose worker writes the adapter with the `obeya:adapter` skill: it reads the repository,
starts the app, records a demo with it to prove the recipe, and asks you what it cannot find out
(a login, test data). This page is the reference for what it writes, and for writing or changing
one yourself.

## A complete example

A typical web app: a Node API and a Vite frontend, PostgreSQL in Docker Compose, tests and lint
in `package.json`, work landing through pull requests on GitHub.

```ts
// .obeya/adapter/index.ts
export default (kit) => ({
  name: 'shop',
  canvasId: () => 'shop',
  canvasName: () => 'Shop',
  planDocs: { dir: 'docs/plan', exclude: ['TEMPLATE.md'] },

  setup: 'pnpm install',
  checks: ['pnpm lint', 'pnpm typecheck', 'pnpm test'],

  land: 'pr',
  direct: false,
  softPaths: ['docs/'],
  workspaces: 'clones',
  prNoise: ['vercel[bot]', 'codecov[bot]'],

  stack: {
    start: 'docker compose up -d db && pnpm dev',
    refresh: 'pnpm --filter api restart',
    urls: { file: '.dev-urls', frontendKey: 'WEB_URL' },
    stop: 'docker compose down && pkill -F .dev.pid',
  },

  demo: {
    required: true,
    howToRun: [
      'Start the stack in your clone: `docker compose up -d db`, then `pnpm db:migrate && pnpm db:seed`, then `pnpm dev` in the background.',
      'The frontend runs on the port in `.dev-urls` (WEB_URL), the API on API_URL.',
      'Log in as demo@shop.test with the password `demo` (created by the seed); the seed also makes three orders to show.',
      'Stop the stack with `docker compose down` and the dev server by its PID when the demo is rendered.',
    ].join(' '),
    share: ['bun', `${import.meta.dir}/share.ts`],
  },
});
```

The default export is the adapter, or (as here) a function that gets Obeya's helpers (`kit`) and
returns it. The module imports nothing of Obeya's: it lives in your repository, not in Obeya's,
so Obeya hands it what it may need. Files next to `index.ts` in `.obeya/adapter/` come along
(a share script, say), and `import.meta.dir` finds them.

Everything but `name` is optional. What an adapter leaves out comes from the generic adapter,
whose values are given with each field below.

## The fields

### `name` (required)

A name for the adapter, shown in "Konfiguration" and Obeya's log. Usually the project's.

### `canvasId`, `canvasName` — functions of the repository

`(repo) => string`, where `repo` is `{ path, remote, branch }` (`remote` is the `origin` URL or
`null`). The id is the canvas's address (`?c=shop`) and the key its cards are stored under; the
name is its title. Clones of one repository share a canvas, so neither may depend on `path`.
Generic: the repository's name from its `origin` URL, else its directory's (`kit.repoName(repo)`).
A canvas named in the configuration keeps that name and id; these only fill in what it leaves out.

### `planDocs` — `{ dir, exclude }`

Where plan docs live (relative to the repository root), and file names in that directory that are
none (a template). Each Markdown file there becomes a project on the canvas. Generic:
`{ dir: 'docs/plan', exclude: ['TEMPLATE.md'] }`.

### `setup` — a command

What a worker runs first in a fresh workspace, typically installing dependencies. Generic: none.

### `checks` — commands

What a worker runs before it hands its work over (lint, types, tests). Each must pass; the worker
fixes what fails. Keep them to what runs in minutes on one machine, without services the clone
does not have. Generic: none.

### `land` — `'pr'` or `'main'`

How approved work lands. `pr`: the card's branch is pushed and goes out as a pull request; Obeya
watches it, brings review comments and failing CI back to the worker and marks the card live once
it is merged (this needs the GitHub CLI, `gh`, logged in). `main`: Obeya rebases the branch onto
the local `main` and fast-forwards the checkout Obeya runs on, no pull request, nothing pushed.
Generic: `pr`.

### `direct` — boolean

With `land: 'pr'`: the owner may approve a card "Direkt auf main" instead, without a pull request.
Obeya rebases onto `origin`'s default branch and pushes there (never forced); a protected branch
refuses it and the card stays in review. Generic: `false`.

### `softPaths` — paths

Paths whose edits never count as a conflict between two cards' branches (a trailing `/` covers a
directory): Obeya resolves them itself when it rebases. Use it for docs that many cards touch.
Generic: `['docs/plan/']`.

### `workspaces` — `'clones'` or `'worktrees'`

Where workers work. `clones`: a pool of full clones per canvas, leased by one card at a time; the
number comes from "Konfiguration" (clones to create, or existing ones to use). Use it when every
workspace runs its own app stack (ports, a database, Docker) or the tools break in a git worktree.
`worktrees`: a git worktree of the configured checkout per card, as many in parallel as there are
cards. Generic: `clones`.

### `prNoise` — account names

Accounts whose pull request comments are not review feedback (deploy previews, coverage bots):
their comments do not go to the worker. Generic: none.

### `stack` — `{ start, refresh, urls: { file, frontendKey }, stop?, keep? }`

How a worker brings the app up in its workspace: `start` starts it all, `refresh` picks up a
backend change without starting everything again, and once it runs, the `KEY=value` file `file`
holds the frontend's URL under `frontendKey`. Every worker's brief says so. Generic: none.

- `stop`: stops the stack in a workspace, and does nothing where none runs. With it, Obeya parks a
  card that waits for the owner (handed over, asked, its pull request open) once its worker has
  nothing running and five minutes have passed: it runs `stop` in the workspace (through `sh -c`,
  `cmd /c` on Windows), so a waiting card costs disk, not memory. The worker's next message tells
  it the stack was stopped; it starts it again with `start` when it needs it. A stop that fails is
  an error on the card.
- `keep`: run before `stop`; exiting 0 means the stack holds what must not be lost (a restored
  database, say), and Obeya leaves it running and says so on the card. The owner who wants it
  stopped anyway tells the worker.

### `demo` — `{ required, howToRun, share? }`

Demos: with `demo`, a worker shows its result as a narrated video (or an HTML page for something
to look at), recorded with Obeya's demo skill. Without it, a written summary is enough.

- `required`: whether a handover needs a demo. `false` leaves it to the worker where it helps.
- `howToRun`: the recipe for running the app for a recording, written for the worker, in a few
  sentences: what to start and how (or "the stack above"), migrations and test data, how to log in
  and as whom, which URL, and what to stop afterwards. Everything a newcomer to the project would
  have to ask about. The worker gets it in its brief word for word; `bun lib/recipe.ts` of the demo
  skill prints it.
- `share`: the command (argv) that publishes a demo for colleagues on a page outside Obeya. Obeya
  runs it in a directory under its home with `OBEYA_HOME`, `OBEYA_REPO` (the repository's
  checkout) and `OBEYA_KIT` (the module with Obeya's page templates) set: `publish` with the page as
  JSON on stdin (`SharePage` in `src/server/share.ts`) prints the page's URL; `withdraw <slug>`
  takes it down; `version` may print the version of the pages it writes. Its program must exist
  (an absolute path, or one on the PATH). A share command in "Konfiguration" takes its place.
  Without either, "Teilen" exports a demo as a file.

Generic: none.

### `matches` — a function of the repository

Only for Obeya's built-in adapters, which are picked by it (`(repo) => boolean`). A repository's
own adapter is picked because it is there; this field changes nothing.

## How Obeya picks a repository's adapter

In this order:

1. The one "Konfiguration" names for the repository (`adapter` in `canvases.json`): a built-in
   one's name (`generic`), or the path of a module, relative to the repository.
2. The repository's own, `.obeya/adapter/index.ts`, **as the default branch has it**.
3. The first built-in one that matches; for any repository but Obeya's own, `generic`.

Obeya reads the repository's own adapter from the default branch (the local one when it has all
of `origin`'s commits, else `origin`'s as last fetched), not from the checkout: the clones a canvas
works in are on cards' branches most of the time, and one from before the adapter changed would
have another one, or none. So **an adapter committed on a branch does nothing yet**; it counts
once it is merged. Its files are copied per version into the repository's git directory
(`.git/obeya/adapter-<tree>/`), out of reach of checkouts and `git clean`.

**A change takes effect once it is on the default branch:** when a merged pull request or a card's
landing brings a new adapter, or a change to it, to the default branch Obeya reads, Obeya restarts
by itself, as for a configuration saved in "Konfiguration": once no agent is in the middle of a
step, and the page reloads. Commits that leave `.obeya/adapter/` as it is restart nothing. Where
the configuration names an adapter, the repository's own is not read, and a change to it restarts
nothing either. Obeya started by hand without its supervisor (`--dev`) cannot restart itself: its
log says so, and the change takes effect at the next start.

## Mistakes

When Obeya loads an adapter, it checks every field. A field it does not know (`check:` for
`checks:`), of the wrong type (`checks: 'pnpm test'` instead of a list), or incomplete (a `demo`
without `howToRun`) does not count: the generic adapter's value stands in its place, and the rest
of the adapter works. Each one shows as a problem at the repository in "Konfiguration", with the
field and, for a misspelt one, what it probably meant:

> Ein Feld im Adapter des Repositorys gilt nicht, an seiner Stelle steht das des allgemeinen
> Adapters: `check: no such field (did you mean checks?)`

A share command whose program is not there shows the same way. These problems keep nothing from
being saved, since they are fixed in the repository. Obeya's log names them when it starts. An
adapter that does not load at all (a syntax error, no default export with a `name`) is worse: it
shows as "Diesen Adapter gibt es nicht, oder sein Modul lädt nicht." with the error, keeps the
configuration from being saved, and keeps Obeya from starting. Run the check below before merging.

## Testing an adapter

1. **It loads and every field counts.** In the repository, with the adapter in the checkout
   (committed or not), run the adapter skill's check from an Obeya checkout:

   ```bash
   bun ~/dev/obeya/plugin/skills/adapter/lib/check.ts
   ```

   It prints what Obeya makes of the adapter (canvas, setup, checks, landing, workspaces, the demo
   recipe) and every problem, and exits with 1 when there is one. A worker runs it as
   `bun ${CLAUDE_SKILL_DIR}/lib/check.ts`.
2. **The commands work.** Run `setup` and each of `checks` in a fresh clone; start the stack as
   `stack` and `howToRun` say, and open the frontend.
3. **A demo comes out of `howToRun`.** Record one with the demo skill, following the recipe and
   nothing else. This is what the setup skill does before it hands over.
4. **Before it is merged, on a canvas.** Name the module in the checkout as the repository's
   adapter: `"adapter": ".obeya/adapter/index.ts"` (relative to the repository) in
   `canvases.json`, or tell the Koordinator. Once Obeya restarts with it, a card started gets its
   brief from it. Remove the entry again once the adapter is merged, so the default branch's
   version counts.
