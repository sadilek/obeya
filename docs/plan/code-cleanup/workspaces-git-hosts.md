# E: workspaces, git, forges, hosts (`workspaces.ts`, `forge.ts`, `forgejo.ts`, `pr-watcher.ts`, `repo.ts`, `folder.ts`, `read-tree.ts`, `machine.ts`, `hosts.ts`, `remote.ts` and the small modules around them)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice is in good shape where it matters: the landing algorithms, the folder manifest, the
process listing and the SSH host are each written once and commented with their reasons, and the
forge interface has no dead members. The two themes worth a cleanup are both about git plumbing:
`workspaces.ts` (2,437 lines) holds the only git runner, privately, so seven other modules rolled
their own; and the generator-based "git steps" exist to share code with a synchronous runner that
only two plugin scripts and tests still use. Below that, a tail of small idioms repeated in place
(ancestor checks, remote-URL parsing, login caches).

## Findings

### E1. "Git steps" generators serve a synchronous runner that only two scripts and tests use
- Principle: KISS (with YAGNI for the sync twins)
- Size: major
- Where: `src/server/workspaces.ts:2209-2219` (`defaultBranch`, `defaultBranchAsync`), `:2244-2258`
  (`detectedBranch`, `detectingBranch`), `:2277-2291` (`readingBranches`), `:2383-2420` (`GitSteps`,
  `gitStepsSync`, `gitSteps`, `together`, `gitCalls`); `src/server/read-tree.ts:18-29`
  (`defaultBranchCommit`, `readingDefaultBranch`), `:146-154` (`branchCommit`), `:383-410`
  (`checking`, `making`); `src/server/repo.ts:9-19` (`repoInfo`, `repoInfoAsync`);
  `src/adapters/index.ts:52` (`repoValues`' default), `:119-129` (`readShared`, `readSharedAsync`),
  `:155-199` (`readingShared`, `readingSettings`, `hasAdapterModule`, `readingAdapterModule`);
  `src/server/canvas.ts:3105`, `:3175`; `src/server/workers.ts:5582`; callers
  `plugin/skills/demo/lib/recipe.ts:9`, `plugin/skills/settings/lib/check.ts:15`;
  `src/server/sync-calls.test.ts:85`, `:134`.
- Now: whatever Obeya reads of a repository through git is written as a generator
  (`GitSteps<T> = Generator<string[][], T, (string | null)[]>`) that yields batches of git argument
  lists and is resumed with their outputs, "written once for both ways it runs": `gitSteps` runs the
  batches with `Promise.all`, `gitStepsSync` one call after the other. There are 14 such generators
  and 20 `gitSteps(` call sites, plus the combinators `together` and `gitCalls`. The synchronous
  runner has three uses: `detectedBranch`, `defaultBranchCommit`, and `readShared` /
  `hasAdapterModule`. Outside tests those are reached only from `repoInfo()` and `readShared()` in
  the two plugin scripts named above (both are Bun scripts whose top level can `await`);
  `hasAdapterModule` (sync), `repoValues`' default `detected = detectedBranch(...)` and the default
  `commit = defaultBranchCommit(...)` are used by tests only (the server passes `x.read.detected`,
  `canvas.ts:3244`, and reads through `gitSteps`). `sync-calls.test.ts` says the same in its
  budget: "left for scripts".
- Why it matters: every reader of branch detection, settings or the read tree has to learn a
  private protocol (`const [a, b] = yield [[...], [...]]`, `yield*` for composition, `together` to
  run two readers side by side, replies typed as `(string | null)[]` with positional
  destructuring) that plain `async` functions would not need, and each reader exists twice by name
  (`repoInfo`/`repoInfoAsync`, `defaultBranch`/`defaultBranchAsync`, `readShared`/
  `readSharedAsync`, `detectedBranch`/`detectingBranch`, `hasAdapterModule`/`readingAdapterModule`,
  `defaultBranchCommit`/`readingDefaultBranch`). `read-tree.ts`'s `checking` and `making` are
  generators although nothing ever runs them synchronously.
- Change: two steps, the first worth doing alone.
  1. Drop the synchronous twins: the two scripts call `await repoInfoAsync(...)` and
     `await readSharedAsync(...)`; `repoInfo`, `defaultBranch`, `detectedBranch`,
     `defaultBranchCommit`, `readShared`, sync `hasAdapterModule` and `gitStepsSync` go;
     `repoValues`
     takes `detected` as a required argument; tests call the async ones. Then rename the `…Async`
     survivors to the plain names.
  2. With one runner left, turn the generators into `async` functions that take `cwd` and call an
     async "output or null" git helper (E2's `gitTry`): `yield [[a], [b]]` becomes
     `await Promise.all([gitTry(cwd, ...a), gitTry(cwd, ...b)])`, `yield* readingBranches()` becomes
     `await readBranches(cwd)`, `together(x, y)` becomes `Promise.all([x, y])`. `GitSteps`,
     `gitSteps`, `together`, `gitCalls` go. Parallelism stays the same (`gitSteps` already runs each
     batch with `Promise.all`).
- Win: a concept (the generator protocol and its two runners) and about six twin functions; roughly
  60-80 lines, and 14 functions read as ordinary code.
- Risk: step 1 low (two scripts, tests of `defaultBranch`/`readShared`/`hasAdapterModule`/
  `repoInfo`: 28 calls in tests; `sync-calls.test.ts` budgets drop `gitStepsSync`). Step 2
  medium: mechanical but touches `canvas.ts`, `workers.ts`, `adapters/index.ts`, `read-tree.ts`,
  `config.ts`; `read-tree.test.ts`, `workspaces.test.ts`, `adapters/index.test.ts`, `canvas.test.ts`
  cover the readers against real repositories.
- Confidence: high for the facts (grepped `gitStepsSync`, `detectedBranch(`, `defaultBranch(`,
  `defaultBranchCommit(`, `readShared(`, `hasAdapterModule(`, `repoInfo(`, `repoValues(` over `src`,
  `scripts`, `plugin`, `app`; no test drives a generator with a fake runner; `docs/design` records
  no
  decision about it). Medium for step 2 being wanted: it is a judgement that async functions read
  better than the generators.

### E2. The git runner is private to workspaces.ts, so seven modules wrote their own
- Principle: DRY
- Size: major
- Where: `src/server/workspaces.ts:106-116` (`git`), `:119-125` (`gitOrNull`), `:149-160`
  (`gitAsync`, private `gitRun`), `:215-220` (`names` in `worktreeNames`), `:378-382` (`get` in
  `pullSet`), `:1729-1733` (`names` in `changedFiles`), `:2038-2041` (`run` in `unlanded`),
  `:2397-2400` (`one` in `gitSteps`); `src/server/shared-settings.ts:25-38` (`gitRun`, `must`);
  `src/server/source-update.ts:36-44` (`this.git`); `src/server/read-tree.ts:295-299`;
  `src/server/forgejo.ts:390-393` (`originOf`); `src/server/forge.ts:275-278` (`originRepo`);
  `src/server/site.ts:230`, `:258`; `src/server/git-setup.ts:45-48` (`run`);
  `src/server/new-repo.ts:46-49` (`git`); error text also at `src/server/workspaces.ts:110`, `:151`,
  `:218`, `:843`, `:2134`, `src/server/hosts.ts:235`, `src/server/shared-settings.ts:36`.
- Now: `gitRun(cwd, args)` (exit code, stdout, stderr; local or over SSH) is the one real runner,
  but it is not exported and takes no options. `gitAsync` wraps it (throws, trims). Everything
  that needs an exit code, untrimmed output, an environment (`GIT_TERMINAL_PROMPT=0`), stdin or a
  timeout builds its own on `spawnOutput([GIT, '-C', cwd, ...])`: `shared-settings.ts` has a second
  `gitRun` plus `must`, `source-update.ts` a closure, `read-tree.ts`'s fetch, `forgejo.ts`'s
  `originOf`. `forge.ts:276` and `site.ts:230/258` spawn bare `'git'`, so they skip `GIT` (the
  binary found once to avoid macOS's xcrun shim and Windows' launcher, `workspaces.ts:75-94`).
  Inside `workspaces.ts` the "trimmed output, or null where git failed" wrapper is written three
  times word for word (`unlanded`'s `run`, `gitSteps`' `one`, `pullSet`'s `get`), and
  `gitAsync(...).catch(() => null)` stands in for it at `:249`, `:1236`, `:1238`, `:1909`, `:2146`.
  The message `` `${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}` `` is spelled out at
  seven places. `git-setup.ts`'s `run` and `new-repo.ts`'s `git` are the same synchronous
  `Bun.spawnSync([GIT, ...args], { cwd, env: process.env })`, one returning `{ ok, out, err }`, the
  other `string | null`.
- Why it matters: a rule about how Obeya calls git (which binary, no prompts, hidden window, how a
  failure reads) has to be applied in ten places; two already missed `GIT`. A reader meets five
  names for "run git" and has to check each for what it trims and throws.
- Change: a module `src/server/git.ts` that owns `GIT`, `LOOK`, and three async functions on one
  runner: `gitRun(cwd, args, o?: { env?, stdin?, timeout? })` (exported; raw result),
  `gitAsync(cwd, ...args)` (throws, trimmed; as today) and `gitTry(cwd, ...args)` (trimmed or null).
  One `failureText(r)` for the message. Then: `shared-settings.ts` uses `gitRun` with its env and
  keeps only `must` (its own error type); `source-update.ts`, `read-tree.ts:295`, `forgejo.ts`
  `originOf`, `forge.ts` `originRepo`, `site.ts` call `gitRun`/`gitTry`; `unlanded`, `pullSet`,
  `gitSteps` (if it survives E1) use `gitTry`; `worktreeNames` and `changedFiles` share one
  "NUL-separated names" helper on `gitRun`. `new-repo.ts` imports `git-setup.ts`'s `run` (or both
  use the sync `gitOrNull`, if the `env: process.env` they pass is not needed: Bun's default is the
  process environment; the comment at `git-setup.ts:44` says it is, so check on Windows before
  dropping it). `workspaces.ts` re-exports nothing: its importers that only want git (15 of 23,
  see E5) import from `git.ts`.
- Win: about seven hand-rolled runners and seven copies of the failure text; ~60 lines; one place
  that decides how git is called.
- Risk: medium. Behaviour to keep: `shared-settings.ts` and `source-update.ts` set
  `GIT_TERMINAL_PROMPT=0` and `stdin: 'ignore'`, `source-update.ts` a timeout; the SSH branch of
  `gitRun` must keep ignoring `env`/`stdin` or pass them deliberately. Covered by
  `workspaces.test.ts`, `hosts.test.ts`, `source-update.test.ts`, `read-tree.test.ts`,
  `forgejo.test.ts`; `shared-settings` has its own tests. `sync-calls.test.ts` lists per-file
  budgets that move with the code.
- Confidence: high (grepped every `spawnOutput(`/`Bun.spawn(`/`spawnSync(` with `GIT` or `'git'`
  under `src`; read each runner).

### E3. A git remote URL is taken apart in seven places, each with its own regex
- Principle: DRY
- Size: moderate
- Where: `src/server/repo.ts:25-28` (`remoteHost`), `:35-43` (`sameRemote`);
  `src/server/forge.ts:130-138` (`sameRepo`), `:146-155` (`landedUrl`), `:202-210` (`githubRepo`);
  `src/server/forgejo.ts:97-110` (`remoteRepo`); `src/server/machine.ts:284-293` (`cloneName`);
  `src/adapters/generic.ts:5-8` (`repoName`); `src/server/hosts.ts:662` (`githubToken`'s host);
  `scripts/gh.ts:23-26` (`githubRepo`, a second function of that name).
- Now: each takes a remote in the forms git accepts (`https://host/owner/repo.git`,
  `ssh://git@host:22/owner/repo`, `git@host:owner/repo`, a local path) and extracts some of host,
  path, owner, repository name. The pieces recur: strip the scheme and authority
  (`/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i` in `sameRemote`, `landedUrl`, `githubRepo`), strip the
  scp-like prefix (`/^[^/\\:]*:\/?/` in the same three), strip trailing slashes and `.git` (five
  places), split on `[/\\:]` and take the last one or two segments (`sameRepo`, `cloneName`,
  `repoName`). `remoteRepo` (Forgejo) parses the same forms a fourth way with `new URL` and its own
  scp regex. What differs is only what each returns: a comparison key, `owner/repo`, host and
  owner, an API base, a web URL, the last segment.
- Why it matters: a form one parser handles and another does not (a port, a user, a trailing
  slash, a server below a path, Windows backslashes) shows up as two features disagreeing about the
  same repository; each fix has to be found and repeated per regex.
- Change: one `parseRemote(url)` in `repo.ts` returning
  `{ host: string | null; path: string; web: string | null }`: `host` as `remoteHost` gives it,
  `path` without leading slash, trailing slashes and `.git` (`owner/repo`, or `sub/owner/repo` for
  a server below a path; the path as written for a local repository), `web` the `https://host/path`
  address without credentials (for an http(s) remote its own scheme and prefix). Then `remoteHost`
  = `.host`; `sameRemote` compares `host|path` lower-cased; `sameRepo` compares the last two
  segments of `path`; `githubRepo` takes `host` and the first of exactly two segments;
  `landedUrl` builds on `web`; Forgejo's `remoteRepo` derives base and `repos/<owner>/<repo>` from
  `web`; `cloneName` and `repoName` take the last segment. `scripts/gh.ts` may keep its regex (a
  standalone script) or import it.
- Win: six regex pipelines become one; about 40 lines.
- Risk: medium: edge cases are the point. `repo.test.ts`, `forge.test.ts` (`githubRepo`,
  `landedUrl`, `parsePrUrl`), `forgejo.test.ts` (`remoteRepo`), `machine.test.ts` (`cloneName`)
  pin the current answers; run them unchanged against the new parser.
- Confidence: high that they parse the same input (read all); medium that one shape serves all
  without a special case or two (Forgejo's base keeps `http:` and a path prefix, `githubRepo`
  maps `ssh.github.com` to `github.com`).

### E4. Synchronous git over SSH has no caller outside one test
- Principle: YAGNI
- Size: moderate
- Where: `src/server/workspaces.ts:107-112` (the remote branch of `git`);
  `src/server/hosts.ts:45-49`
  (`RECHECK_DOWN_MS`), `:105` (`down.asking`), `:193-212` (`SshHost.runSync`);
  `src/server/hosts.test.ts:58-60`; `src/server/sync-calls.test.ts:134-135`;
  `docs/design/agents-and-workspaces.md:510-512`.
- Now: `git(cwd, ...)` runs `there.host.runSync(...)` when `cwd` is `ssh://<host>/…`, and `runSync`
  carries its own policy for a server thread that blocks on SSH: while the host is down it fails at
  once and asks the host again in the background every `RECHECK_DOWN_MS`. No production code calls
  synchronous git with a workspace path: `git` is imported only by `testing.ts` (local fixtures);
  `gitOrNull` is called by `repo.ts:10-11` (scripts), `self-update.ts:196/210/223` (Obeya's own
  checkout) and `gitStepsSync`, whose callers pass the configured checkout, never a host's clone
  (hosts hold only clones, `ssh://<host>/<root>/<i>`). Everything that touches a workspace goes
  through `gitAsync`/`gitRun` and `host.run`. The only caller with an `ssh://` path is
  `hosts.test.ts:58-60`.
- Why it matters: a second way to run a command on a host, with a second down-host policy, that a
  reader must assume is live; `spawn.ts` and the design chapter both explain how the server copes
  with blocking SSH calls that no longer happen.
- Change: `git()` runs locally only (its remote branch and the `remoteWorkspace` lookup go);
  `SshHost.runSync`, `RECHECK_DOWN_MS` and `down.asking` go (`down` stays: `run` sets it through
  `heard`, and `unreachable`/`onBack` read it). `hosts.test.ts:58-60` keeps its `gitAsync` line.
  The design sentence "Calls the server still blocks on fail at once … asked again in the
  background 30 s on" is rewritten to what remains (when a host answers again, waiting cards look
  again). The `unreachable` getter (`hosts.ts:170-173`) is read by `hosts.test.ts` only and stays
  as its seam.
- Win: ~30 lines and the concept "the server blocks on SSH".
- Risk: low; one consequence to check: without `runSync` nothing re-asks a down host on a timer
  from this path, so confirm that the pool's looks (`cloneState` every `RECHECK_MS`, through
  `host.run` → `heard`) are what brings a host back today. They are the only callers left either
  way.
- Confidence: high on "no production caller" (grepped `runSync(`, imports of `git` and `gitOrNull`
  from `workspaces`, callers of `gitStepsSync`); medium on the design sentence being stale rather
  than a decision to keep the door open.

### E5. workspaces.ts is three modules; most importers want only the smallest one
- Principle: KISS
- Size: major
- Where: `src/server/workspaces.ts:75-170` and `:2383-2420` (git plumbing), `:2191-2291` and
  `:2422-2437` (the main-branch registry, folder registry, branch detection, `Branches`,
  `CARD_BRANCH`, `branchName`), the rest (landing helpers `:242-481`, `Workspaces` `:483-1990`,
  `leavingClones`/`unlanded`/`cloneState` `:1993-2149`, `parseChanges` `:2157-2189`, `originFetch`
  `:2293-2381`).
- Now: one file holds (a) how git is run, (b) what a repository's main branch is (the owner's
  setting per path, folders without git, detection from refs), and (c) the pool of clones and
  worktrees with landing. Of the 23 modules that import from it, 15 take nothing of (c):
  `forgejo.ts`, `git-setup.ts`, `new-repo.ts`, `theme.ts`, `source-update.ts`, `file-forge.ts`,
  `replay.ts`, `self-update.ts`, `share.ts`, `shared-settings.ts`, `repo.ts`, `read-tree.ts`,
  `adapters/index.ts`, `site.ts`, `board.ts` import `GIT`, `gitAsync`, `gitOrNull`, `isFolder`,
  `branchName`, `CARD_BRANCH` or the branch readers.
- Why it matters: `src/adapters/index.ts` and `board.ts` depend on the 2,400-line pool module to
  learn a branch prefix or run `git cat-file`; the file's header describes only (c); finding the
  git runner means knowing it lives under "Where a card's worker works".
- Change: move (a) to `src/server/git.ts` (with E2) and (b) to `src/server/branches.ts`
  (`useBranchSetting`, `branchSetting`, `markFolder`, `isFolder`, default-branch detection,
  `Branches`/`readBranches`, `CARD_BRANCH`, `branchName`); `read-tree.ts`'s `branchCommit` and
  `readingDefaultBranch` belong with (b) too. `workspaces.ts` keeps (c) and imports both. Pure
  moves plus import edits; no re-exports.
- Win: `workspaces.ts` drops ~350 lines and its header is true again; 15 modules stop importing
  the pool.
- Risk: low (moves; typecheck finds every import). `sync-calls.test.ts` keys its budgets by file
  and needs the new files entered.
- Confidence: high (import list taken with grep over `src`, `scripts`, `plugin`, `app`).

### E6. "Is A an ancestor of B" is defined eight times
- Principle: DRY
- Size: moderate
- Where: `src/server/workspaces.ts:391` (`contains` in `diverged`), `:1369`, `:1429`, `:1490`
  (`contains`), `:1537` (`contains`), `:1794` (`before`); `src/server/workers.ts:2035-2038`;
  `src/server/replay.ts:202-207` (`descends`); also through other runners at
  `src/server/read-tree.ts:152`, `:261` and `src/server/source-update.ts:121`.
- Now: each site runs `git merge-base --is-ancestor a b` and reads the exit code: four local
  closures named `contains`/`before` (`code === 0`), two inline (`code === 1` at `:1369`, where
  only a certain "no" counts; `code !== 0` at `:1429`), and two in other files that go through
  `gitAsync(...).then(() => true, () => false)`, which also answers "no" when git failed for any
  other reason (an unknown commit).
- Why it matters: the same one-liner is re-declared inside five functions of one file, under
  three names, and the two outside read an error as "not an ancestor".
- Change: `export const isAncestor = async (cwd, a, b) => (await gitRun(cwd, ['merge-base',
  '--is-ancestor', a, b])).code === 0`
  in the git module; the six sites in `workspaces.ts`, `workers.ts:2035` and `replay.ts:202` use
  it; `diverged` becomes two calls of it. `:1369` keeps its explicit `code === 1` (it must tell
  "no" from "cannot tell").
- Win: five closures and two ad-hoc wrappers; ~12 lines and one name.
- Risk: low; for `workers.ts`/`replay.ts` the answer on a git error stays `false`. Landing and pull
  tests in `workspaces.test.ts` and the workers' landing tests cover the callers.
- Confidence: high (grepped `is-ancestor`, read each site).
- Bug fixed (W1 of the bug plan): `isAncestor(cwd, a, b)` exists in `workspaces.ts` and throws
  where git cannot tell; `workers.ts` (`ownCommits`) and `replay.ts` (`descends`) use it and decide
  themselves what that means. The six sites in `workspaces.ts` can move to it, keeping `:1369`'s
  explicit "no".

### E7. PrWatcher.react does five jobs in 130 lines and resets four "ready" fields by hand per branch
- Principle: KISS
- Size: moderate
- Where: `src/server/pr-watcher.ts:181-313` (`react`), in it `:253-306`; duplicates at `:86-91` vs
  `:173-176`, and `:208` vs `:356`.
- Now: for a worker's own PR, `react` handles merged/closed, passes new comments to the worker,
  passes failed checks, passes conflict/behind/stale-review, then decides readiness and merges.
  The readiness part is a four-way `if`/`else if` (held by a low confidence, left to the people on
  the forge, merge now, not ready) in which each branch sets some of `next.readyHead`, `next.held`,
  `next.manual`, `next.mergeError` and deletes the others, 11 `delete next.…` lines in all, with the
  merge call and its three exits nested in the third branch. Two smaller repeats: "all merged, so
  tell the workers with the first PR's merge commit" (`typeof first.merged === 'string' ? … :
  undefined`) is written at `:89-90` and `:174-175`; the line that renders a comment for the worker
  (`- author (requests changes) on path:line (url):\nbody`) at `:208` and `:356`.
- Why it matters: the four fields are one state ("why the PR is or is not ready at this head"),
  and which of them survive each branch has to be read off the deletes; adding a fifth reason means
  editing every branch. The function is too long to see that telling the worker and deciding
  readiness are independent but for `told`.
- Change: split `react` into `tell(cardId, pr, s, next, which, noise): boolean` (comments, checks,
  conflict, behind, stale; returns `told`) and `settle(...)` (waits, readiness, merge). In `settle`
  compute the outcome first (`'held' | 'manual' | 'merge' | null`) and apply it in one place: clear
  `readyHead`/`held`/`manual`, then set what the outcome needs; keep `mergeError` exactly as today
  (cleared in every outcome but `'merge'`, where it is kept until the merge succeeds, set on
  failure, and left untouched on the "worker busy" exit at `:286-290`). Extract
  `private allMergedDone(cardId)` for the two "tell the workers" sites and a module function
  `commentLine(c, verdict: boolean)` for the two renderers (they differ only in that the worker's
  own PR adds " (requests changes)" after the author, `:208`; the contributor's at `:356` does not,
  so the flag keeps both texts as they are).
- Win: one 130-line function becomes two of about 60, 11 deletes become about 4, two small
  duplicates go.
- Risk: medium: the log lines fire on comparisons with the stored `pr` (`pr.readyHead !== s.head ||
  pr.held || pr.manual`), so the order of reads and writes matters. `pr-watcher.test.ts` covers
  held, manual, merge failure and the busy exit.
- Confidence: high on the description; medium that the outcome-first shape keeps every log
  condition without a special case (the `mergeError` handling is the one to watch).

### E8. Small git idioms repeated inside workspaces.ts
- Principle: DRY
- Size: moderate
- Where and now, each with what differs:
  - Untracked files: `gitAsync(ws, 'ls-files', '-z', '--others', '--exclude-standard')` then split
    on NUL, at `src/server/workspaces.ts:1679`+`:1682`, `:1699`, `:1739` (the third through
    `changedFiles`' own `names` with `core.quotePath=false`, which `-z` makes moot).
  - Pathspec batches for a command line: `` `:(literal)${f}` ``, 12 characters of overhead per file,
    cut at 24,000, in `listed` (`:184-193`, first batch of the first 200 only) and in
    `worktreeNames` (`:226-231`, all batches); `unlanded` builds the same pathspecs unbatched
    (`:2086`).
  - "Fetch `origin`'s main and name its commit": `gitAsync(repo, 'fetch', '--quiet', 'origin',
    base)`
    then `rev-parse FETCH_HEAD`, at `:1397-1398`, `:1427-1428`, `:1459-1460`.
  - "Put the checkout back on the main branch if it is elsewhere": `branch --show-current`, compare,
    `backOnBase`, at `:1346-1351` and `:1484-1488`.
  - Remove a card's worktree: `existsSync` → `quiet` → `worktree remove --force`, then delete the
    branch if it is listed, at `:1591-1601` (`removeLanded`: `-d`, failure logged) and `:1614-1620`
    (`discard`: `-D`); "delete the branch if listed" a third time at `:1629`.
  - Obeya's commit identity `'-c', 'user.name=Obeya', '-c', 'user.email=obeya@localhost'` at `:414`,
    `:1180` and `src/server/site-hosts.ts:245`.
  - Wait out a restored card's clone: `if (making && this.retaking.has(cardId)) return
    making.then(retry, retry)` at `:1126` and `:1170`.
- Why it matters: none is large, but together they are why the file's long methods read as git
  transcripts; each rule (the command-line limit, Obeya's identity) is stated where it is used
  rather than once.
- Change: private helpers next to their users: `untracked(ws): Promise<string[]>`;
  `pathspecBatches(files): string[][]` (with `listed` taking the first batch); `fetchedMain(repo,
  base): Promise<string>`; `ensureOnBase(repo, base)` returning `backOnBase`'s result or null;
  `removeWorktree(ws)` and `deleteBranch(repo, branch, flag)`; a constant `AS_OBEYA` for the
  identity arguments.
- Win: ~35 lines; the landing methods get shorter and name their steps.
- Risk: low; `workspaces.test.ts` and the workers' worktree/clone tests exercise each path.
- Confidence: high (read every site; differences listed above).
- Bug fixed (W1 of the bug plan): `unlanded`'s `landedOn` now asks in batches under 24,000
  characters, a third copy of the batching loop for `pathspecBatches` to take over.

### E9. Three caches of a login, each "ten minutes, asked once for calls side by side"
- Principle: DRY
- Size: minor
- Where: `src/server/forge.ts:213-248` (`tokens`, `ghEnv`: `gh auth token`);
  `src/server/forgejo.ts:290-347` (`logins`, `loginFor`, `credential`: `git credential fill`);
  `src/server/hosts.ts:643-680` (`githubToken`: `git credential fill`).
- Now: each keeps a login for 10 minutes (`TOKEN_TTL` declared in `forge.ts` and `hosts.ts`, the
  literal `10 * 60_000` in `forgejo.ts`) and shares one read among concurrent callers. The two
  `git credential fill` calls spawn the same command with `GIT_TERMINAL_PROMPT=0` and parse
  `key=value` lines for `password`; they differ in the input (`url=…` vs `protocol`/`host`), in
  extra environment and timeout (Forgejo also silences askpass and Git Credential Manager, 15 s),
  and in what they return (a Basic header vs the token). The caches differ on purpose: gh's keeps
  the promise, Forgejo's forgets on failure and on a 401, the host's serves the old token while it
  reads anew.
- Why it matters: "never prompt when asking git for a login" is a rule with two implementations,
  one stricter than the other (the host's read sets `GIT_TERMINAL_PROMPT=0` only, Forgejo's also
  `GIT_ASKPASS=''` and `GCM_INTERACTIVE=never`).
- Change: one `gitCredential(cwd, input: string, timeout?): Promise<Map<string, string> | null>`
  (in the git module) with Forgejo's full no-prompt environment, used by `credential` and
  `githubToken`; one exported `LOGIN_TTL`. Leave the three cache policies as they are.
- Win: ~12 lines and one rule in one place.
- Risk: low; `forgejo.test.ts` and `hosts.test.ts` use stand-ins for git. Giving `githubToken` the
  stricter environment changes nothing where no dialog would have opened.
- Confidence: medium (read all three; not checked whether a prompt can in fact open in the host
  path today).

### E10. `onPath` is `oneAtATime`; "share the call in flight" is written out at six places
- Principle: DRY
- Size: minor
- Where: `src/server/workspaces.ts:520-531` (`busyPaths`, `onPath`) vs
  `src/core/one-at-a-time.ts:8-15`; in-flight sharing at `src/server/workspaces.ts:1041-1055`
  (`looking`), `:1817-1822` (`mains`), `src/server/folder.ts:806-813` (`ready`), `:893-900`
  (`undoing`), `src/server/path.ts:44-52` (`reading`), `src/server/read-tree.ts:204-206`
  (`refreshing`).
- Now: `onPath(path, fn)` chains `fn` after what runs under `path` in the module map `busyPaths`,
  ignores the earlier failure, and deletes the entry when it is the last: that is
  `oneAtATime(busyPaths, path, fn)`, which the same file already uses for `clears` and `landings`.
  The only difference is that `onPath` starts `fn` a microtask later when nothing is running;
  neither caller (`ensureClones`, `retire`, `ensureHostClones`) reads state in between. Separately,
  "if a call under this key is in flight return it, else start one and forget it when it settles"
  is spelled out with a `Map` and a `finally`/identity check at the six places listed.
- Why it matters: two names for one queue in one file; the in-flight idiom is five lines each
  time, with the identity check before deleting present in some copies (`mains`) and absent in
  others.
- Change: delete `onPath`, call `oneAtATime(busyPaths, path, fn)`. Add
  `shared<K, T>(running: Map<K, Promise<T>>, key: K, fn: () => Promise<T>): Promise<T>` beside
  `oneAtATime` and use it for `looking`, `mains`, `undoing`, `reading` (the single-slot ones,
  `refreshing` and `ready`, can stay).
- Win: `onPath` (8 lines) and ~15 lines of map bookkeeping.
- Risk: low; `workspaces.test.ts` covers clones made and removed concurrently, `folder.test.ts`
  the double undo.
- Confidence: high for `onPath` (compared line by line); medium for `shared` (the copies differ in
  when they delete: `looking` deletes inside its `then`, before notifying).

### E11. Rules about PR comments are stated once per forge instead of above the interface
- Principle: DRY
- Size: minor
- Where: `src/server/forge.ts:455-459` and `src/server/forgejo.ts:192-193` (an edit within a minute
  of writing is none); `src/server/forge.ts:490-492` and `src/server/forgejo.ts:196-198` (a review
  with neither text nor verdict is dropped); `src/server/forgejo.ts:173` and `:266` (state
  mapping), `:166` and `:265` (`ghost`); `src/server/forge.ts:645` and `:681` (the
  `Confidence Score: n/m` regex in `passing` and `confidence`).
- Now: both forges build `PrStatus.comments` from three lists (conversation, reviews, inline) with
  the id prefixes `c`/`r`/`i`, and both apply the same two rules while doing so: `edited` is set
  only when the update is more than 60,000 ms after creation, and a review is kept only if
  `body.trim() || verdict`. Within `forgejo.ts`, `pr.merged ? 'MERGED' : pr.state === 'closed' ?
  'CLOSED' : 'OPEN'` and the `'ghost'` fallback are each written in `status` and `contribution`.
  In `forge.ts`, `passing` and `confidence` each carry the confidence regex.
- Why it matters: the 60 s rule and the empty-review rule are Obeya's, not a forge's; a third
  forge would have to copy them, and changing one means finding the other.
- Change: in `forge.ts`, export `editedAt(created?: string, updated?: string): { edited?: string }`
  and `reviewComment(r: { id, author, body, at?, state? })` (applies `verdictOf`, returns null for
  an empty one), used by both forges; in `forgejo.ts` a local `stateOf(pr)` and the existing
  `login` hoisted out of `status`; in `forge.ts` one `confidenceIn(body): { score, of } | null` used
  by `passing` and `confidence`.
- Win: ~15 lines; the two rules live where `reviewOf`/`waitsOf` (which rely on them) live.
- Risk: low; `forge.test.ts` and `forgejo.test.ts` pin both forges' statuses with canned answers.
- Confidence: high (read both `status` implementations side by side).

### E12. Repeated lookups inside each forge
- Principle: DRY
- Size: minor
- Where: `src/server/forge.ts:169-184` (`routedForge`: forge by origin, three times), `:361`,
  `:367`, `:371` (`{ cwd, ...(await repoOf(cwd)) }`); `src/server/forgejo.ts:248-250`, `:255-257`,
  `:282-284` (origin → `remoteRepo`), `:122-130` vs `:149-154` (paging loop).
- Now: `routedForge` computes `const remote = await origin(cwd); (remote && !onGitHub(remote) ?
  forgejo : github)` in `urlOf`, `open` and (inverted, with a null case) `visibility`. The gh forge
  builds `const at: GhAt = { cwd, ...(await repoOf(cwd)) }` in `open`, `urlOf`, `visibility`. The
  Forgejo forge resolves `origin(cwd)` to `remoteRepo` in `visibility`, `urlOf`, `open` (two of
  them throwing the same message), and pages the commit statuses with a hand-written copy of its
  own `all` helper because that answer wraps the list in `{ statuses }`.
- Change: `const byOrigin = async (cwd) => …` in `routedForge`; `const atOrigin = async (cwd):
  Promise<GhAt>` in `makeGhForge`; `const repoAt = async (cwd)` (null or `{ base, repo }`) and
  `mustRepoAt` in `makeForgejoForge`; give `all` an optional `pick: (answer) => T[] | undefined`
  and use it for the statuses.
- Win: ~15 lines.
- Risk: low (`forge.test.ts`, `forgejo.test.ts`).
- Confidence: high.

### E13. `readyToMerge` is used by tests only
- Principle: YAGNI
- Size: minor
- Where: `src/server/forge.ts:594-597`; `src/server/forge.test.ts` (9 calls).
- Now: `readyToMerge(s, skip)` is `s.state === 'OPEN' && !waitsOf(s, skip).length`. Production
  code decides readiness from `waitsOf` directly (`pr-watcher.ts:253-255`, which also adds the
  `'agent'` wait); nothing but `forge.test.ts` calls `readyToMerge`.
- Why it matters: it reads as the rule Obeya merges by, and is not: the watcher's rule has one
  more condition.
- Change: delete it; the tests assert on `waitsOf(s, skip)` (`toEqual([])` / the wait they expect,
  which also says why a PR is not ready). The one test on a closed PR (`forge.test.ts:472`) checks
  `waitsOf` returns `[]` for it and needs rewording or dropping.
- Win: one export and a misleading name.
- Risk: low (test-only edits).
- Confidence: high (grepped `readyToMerge` over `src`, `scripts`, `plugin`, `app`).

### E14. "Real path, or the path as given" has three copies
- Principle: DRY
- Size: minor
- Where: `src/server/new-repo.ts:38-44` (`realPath`, exported), `src/server/read-tree.ts:370-376`
  (`real`), `src/server/workers.ts:230-236` (`realpathOr`).
- Now: three identical `try { return realpathSync(path) } catch { return path }`.
- Change: keep the exported `realPath` (move it to `path.ts`, where the other path helpers are)
  and import it in `read-tree.ts` and `workers.ts`.
- Win: two functions.
- Risk: low.
- Confidence: high (read all three; `demo.ts:34` returns `undefined` instead and is another
  function).

### E15. forge.ts holds two subjects: the forges, and what a PR's review means
- Principle: KISS
- Size: minor
- Where: `src/server/forge.ts:509-513` (`verdictOf`) and `:517-730` (`reviewOf`, `waitsOf`,
  `reviewStale`, `requestOf`, `lastAsked`, `MIN_CONFIDENCE`, `passing`, `changesRequested`,
  `mentions`, `confidence`, `reviewers`, `readable`).
- Now: the first 515 lines are the `Forge` interface, URL parsing, the router and the gh
  implementation; the last 215 are pure functions over `PrStatus` that decide what a pull request
  waits for and render review comments. Only `pr-watcher.ts` (and tests) import the second half;
  `forgejo.ts`, `file-forge.ts`, `canvas.ts`, `share.ts` import only the first.
- Change: move `:517-730` to `src/server/pr-review.ts` (importing `PrStatus` from `forge.ts`);
  `verdictOf` stays with the forges that call it. A move, no edits.
- Win: `forge.ts` at ~515 lines about forges; the merge policy findable by name.
- Risk: low.
- Confidence: high.

### E16. Smaller repeats in the remote-access and Tailscale code
- Principle: DRY
- Size: minor
- Where: `src/server/remote.ts:146-149`, `:176-179`, `:187-188` (stop listening);
  `src/server/remote.ts:344-349` vs `src/server/owner.ts:81-85` (cookie by name, the clone
  detector's pair); `src/server/remote.ts:390` and `:408` (a pairing made at another address is
  gone); `src/server/tailscale.ts:128-133` vs `:195-198` (parse `serve status --json`), `:187` vs
  `:199` vs `:65` (is the entry still Obeya's).
- Now: `if (this.listening) this.listen(null); this.listening = null;` is `stop()` and is written
  out twice more in `applyNow`. `owner.ts` has a private `cookie(req, name)` helper (`:79-85`);
  `Access.device` spells the same chain out for `DEVICE_COOKIE`. `unserve` and `unserveSync` each
  parse the serve configuration from the first `{` and
  test `config.Web?.[key]?.Handlers?.['/']?.Proxy === entry.target`, which `without` tests again.
- Change: `applyNow` calls `this.stop()`; export `owner.ts`'s `cookie` (or move it to `access.ts`)
  and use it in `Access.device`; in `tailscale.ts` a module function `parseServe(out): ServeConfig`
  and `serves(config,
  entry): boolean` used by `unserve`, `unserveSync` and `without`.
- Win: ~15 lines.
- Risk: low (`remote.test.ts`; Tailscale's CLI is faked there).
- Confidence: high.

### E17. Smaller repeats in folder.ts
- Principle: DRY
- Size: minor
- Where: `src/server/folder.ts:144`, `:174`, `:346` (contents changed: size or mtime differ);
  `:366` and `:863` (same size, mtime within 1 ms); `:1030-1033` vs `:1042-1043` (a `FolderChange`
  from a `Tracked`, and whether the file is gone); `:938-942`, `:948-952`, `:973-977` (ask
  `undoable`, keep with the reason, continue).
- Now: the comparisons are spelled out at each use; `diff` builds the view of a change twice (for
  the card's changes and for the uncertain ones) with the same spread and the same `lstat` probe.
- Change: `const differs = (a: Entry, b: Entry) => a.size !== b.size || a.mtime !== b.mtime` and
  `const sameStamp = (a, b) => a.size === b.size && Math.abs(a.mtime - b.mtime) < 1`; in `diff` a
  local `view(t)` returning the `FolderChange` with `gone` set, used for both lists; in `putBack` a
  local `const refused = async (t) => { const why = await this.undoable(cardId, t); if (why ===
  'yes') return false; keep(t, why!); return true; }`.
- Win: ~15 lines; the manifest rules get names.
- Risk: low (`folder.test.ts` is thorough).
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/folder.ts:502-607` `FolderWorkspaces` implements 14 members of `CardWorkspaces` as
  stubs: a null object, so workers, canvas and Coordinator call one interface without asking the
  mode (the one cast is `workers.ts:711`).
- `src/server/forge.ts:84` `visibility?` is optional: the file forge and the test fake have no
  repository to ask; the two callers check for it.
- `src/server/file-forge.ts:89-91` `open` throws: the scratch forge only plays existing PRs.
- `src/server/forge.ts:482-505`, `src/server/forgejo.ts:186-212` comment ids carry their kind as a
  prefix (`c`, `r`, `i`) instead of a field: the ids are stored in each card's `seen` list in
  existing databases.
- `src/server/workspaces.ts:695-706` vs `:860-896` `ensureClones` and `ensureHostClones`: the
  host's variant sets the credential helper, trusts the folder for Claude Code and prunes by
  listing over SSH; little is shared beyond the loop.
- `src/server/workspaces.ts:839-848` `clearAway` moves a folder aside and removes it in two
  variants (local `renameSync`+`rm`, remote `mv && rm -rf`): one line each.
- `src/server/folder-processes.ts:166-194` `endProcessesIn` has a local and a remote arm, but both
  share `toEnd`, `ownLine`, `parsePosix` and `POSIX_LIST`; only listing and killing differ.
- `src/server/tailscale.ts:191-201` `unserveSync` beside `unserve`: Obeya stopping, the process
  ends right after.
- `src/server/workspaces.ts:410-438` `mergesTreesAsCommits`/`asCommit`: git before 2.45.
- `src/server/workspaces.ts:82-94` `GIT`: macOS's xcrun shim and Windows' launcher, explained there.
- `src/server/repo.ts:221-304` polling beside the watches: fseventsd under load, and Bun before
  1.3.14 on Linux; both explained and dated by version.
- `src/server/git-setup.ts:45-48` passes `env: process.env`: PATH is refreshed in place on Windows
  (`path.ts`).
- `src/server/read-tree.ts:42-110` `refsSeal`/`headSeal` read git's files without git: a few stats
  instead of a process per look, by design (`sync-calls.test.ts:85`).

## Bugs noticed in passing
- `src/server/forge.ts:276`, `src/server/site.ts:230`, `:258` run bare `'git'` instead of `GIT`
  (slower on macOS and Windows, see `workspaces.ts:75-81`); fixed by E2.
