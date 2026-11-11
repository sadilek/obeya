# R: scripts and the desktop app (`scripts/`, `app/src`, `.github/workflows`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice is in good shape where it has tests (`release.ts`, `release-status.ts`, `gh.ts`,
`android-phone.ts`, `app-replace.ts`, `hero-video/load.ts`) and in the Rust shell, which is small
and holds little the server also holds. The weak spots are two. `scratch-obeya.ts` has grown into
1,208 lines whose staging runs as 580 lines of top-level statements. And the scripts share almost
nothing: `common.ts` has 34 lines and `check-harness.ts` 50, while each script brings its own
argument reader, `fail`, `run`, `git`, scratch repository, owner-key API client and table of release
targets. One of the hand-written argument readers has a real bug (`build.ts` ignores its target).

## Findings

### R1. `scratch-obeya.ts` stages in 580 lines of top-level statements
- Principle: KISS
- Size: major
- Where: `scripts/scratch-obeya.ts:317-893` (top level), `:335-377` (the sub-commands `--stop`,
  `--login`, `--say`, `--sweep`, `--artifact`), `:680-800` (the loop body per card), `:709-748` (its
  workspace branch), `:912-1159` (process and port helpers)
- Now: The file does three jobs. (1) Five sub-commands, each an `if (opt(...)) { … process.exit(0)
  }` block at the top. (2) Staging, written as one run of top-level statements that share about
  forty module-level constants (`stage`, `port`, `dir`, `home`, `repo`, `files`, `folder`,
  `forgeRepo`, `prHeads`, `others`, `further`, `code`, `commit`, `binary`, `record`, `replay`,
  `idle`, `canIdle`, `supervised`, `endsItself`, `env`, `configured`, `server`, `allCanvases`,
  `canvas`, `api`, `snapshot`, `ids`, `db`, `columns`, `prefIds`, `talkIds`, `threadOf`, …). The
  loop that writes a card's row is 120 lines, with the workspace case (folder, worktree, clone,
  branch commit) nested three levels deep inside it. (3) Process and port handling (`pickPort`,
  `claim`, `serverIn`, `startOf`, `free`, `freed`, `stop`, `stopServer`, `signalGroup`, `stopTree`,
  `sweep`, `endPid`), 250 lines that know nothing of stage files. The helpers stand after
  `process.exit(0)` at line 893 and read top-level constants through hoisting (`initRepo` reads
  `mainBranch`, `pickPort` reads `from`), so which helper may be called when depends on the order of
  the top-level statements.
- Why it matters: To find where one stage field takes effect, a reader scans 580 lines and tracks
  which of forty names are set by then. Every new stage field (the header lists about sixty)
  lengthens the same run.
- Change: Keep the path `scripts/scratch-obeya.ts` and its command line and output (docs, CLAUDE.md,
  the demo skill and other scripts call it). Split into three files. `scripts/scratch/process.ts`
  takes the process and port helpers, with `from` passed to `pickPort`. `scripts/scratch/stage.ts`
  takes the `Stage` types and the staging as functions over one context object:
  `makeRepositories(stage, dir)` returning `{ repo, others, further, prHeads }`, `chooseCode`,
  `startServer`, `createCards` returning `ids`, `writeCard(db, ctx, card, id)` with `holdWorkspace`
  taken out of it, `writePreferences`, `writeTalk`, `writeRetrospective` (friction and setting
  proposals), `refresh`. `scripts/scratch-obeya.ts` keeps the dispatch: stop, login, say, artifact,
  sweep, stage.
- Win: No lines. The top level shrinks to a `main` of about thirty lines, and each phase names what
  it needs.
- Risk: medium. `scripts/scratch-obeya.test.ts` (six tests that stage real instances) and
  `scripts/check-scratch.ts` cover staging, `--say`, `--artifact`, `--stop` and port picking. No
  test reaches `--code`, `--binary`, `--record`, `--replay`, `hosts`, `pulls` or `forgeClone` (grep
  of the test file), so those paths need a staging by hand after the move.
- Confidence: high on the description (read the whole file), medium on the exact cut.

### R2. Ten hand-written argument readers, one of them wrong
- Principle: DRY
- Size: moderate
- Where: `scripts/common.ts:8-12` (`opt`); `scripts/site-shots.ts:36-39` and
  `scripts/measure-resume-cache.ts:27-30` (`arg`, the same four lines);
  `scripts/revoice-demos.ts:26-29` (`option`); `scripts/hero-video/render.ts:40-45,52,94`;
  `scripts/build.ts:25-27`; `scripts/build-app.ts:52`; `scripts/check-binary.ts:31-32`;
  `scripts/check-app.ts:30-31,236-237`; `scripts/scratch-obeya.ts:353,366,379`;
  `scripts/android-phone.ts:89-108`
- Now: Five functions read "the value after `--name`" (`opt`, `arg` twice, `option`, `recording`),
  and `build.ts` and `check-app.ts` do it inline with `indexOf`. Every script that also takes
  positional arguments finds them with its own filter that lists by hand which options take a value:
  `build-app.ts:52` skips what follows `--bundles` and `--config`; `check-binary.ts:32` skips what
  follows `--port`; `scratch-obeya.ts:379` lists `port|code|dir|binary|record|replay`;
  `check-app.ts:31` skips nothing, so `--screenshot out.png <program>` takes `out.png` for the
  program; `build.ts:27` filters with `i !== outIndex + 1`, which without `--out` is `i !== 0` and
  drops the first argument, so `bun scripts/build.ts linux-x64` builds this machine's target
  (checked: the filter returns `[]` for `['linux-x64']`). Unknown options are ignored everywhere, so
  a typo (`--prot 4500`) stages on a picked port without a word. The server itself parses with
  `parseArgs` from `node:util` (`src/server/main.ts:96`).
- Why it matters: A new valued option must be added to the positional filter of its script or it is
  taken for a positional. Two of the filters are already wrong.
- Change: Use `parseArgs({ options, allowPositionals: true })` from `node:util` in each script (Bun
  and Node both have it, and the hero-video scripts run under Node). `opt` in `common.ts` goes, with
  `arg`, `option` and the positional filters. `render.ts` passes unknown arguments on to the demo,
  so it parses with `strict: false`. Leave `android-phone.ts` as it is: its parser checks options
  per sub-command and `android-phone.test.ts` pins its messages.
- Win: About 40 lines, and typos reported.
- Fixed: the `build.ts` and `check-app.ts` bugs and the words `--say` and `--artifact` dropped:
  `build.ts` and `check-app.ts` read their arguments with `parseArgs` and refuse an unknown option
  already, and `scratch-obeya.ts` takes a text's words with `wordsOf`, which leaves out only `--dir`
  and its value.
- Risk: medium. Strict parsing turns an ignored typo into an error, which changes behaviour only for
  wrong input. Only the scratch commands have tests of their command line (`scratch-obeya.test.ts`,
  `check-scratch.ts`).
- Confidence: high. Read every reader; ran the `build.ts` filter on `['linux-x64']`.

### R3. The release targets and their update artifacts are listed in four scripts
- Principle: DRY
- Size: moderate
- Where: `scripts/build.ts:20-21,28`; `scripts/build-app.ts:39-46,51,151,205-214`;
  `scripts/release.ts:23-59`; `scripts/check-update.ts:32,63-69,85-91,98`
- Now: `build.ts` lists the five targets (`TARGETS`). `build-app.ts` lists them again as the keys of
  `TRIPLES`. `release.ts` lists them a third time as the keys of `RELEASE`, with `platform`
  (`darwin-aarch64`, which is the OS and the first word of the triple) and, per target, where Tauri
  leaves the installers and the update (`{ from: 'nsis', ends: '-setup.exe' }`). Which bundle is the
  update on each OS (`macos/Obeya.app.tar.gz`, `nsis/*-setup.exe`, `appimage/*.AppImage`) is then
  written again in `build-app.ts:208-213` to sign it and in `check-update.ts:64-69,85-91` to copy
  it. `check-update.ts:98` builds the platform string by hand, through an identity map (`{ darwin:
  'darwin', windows: 'windows', linux: 'linux' }[os]`). This machine's target (`here`) is the same
  expression in `build.ts:28` and `build-app.ts:51`. The words `aarch64`/`x86_64` are derived in
  three ways (`TRIPLES`, `build-app.ts:151`, `check-update.ts:98`).
- Why it matters: A sixth target, or a change of what the updater installs on one OS, must be made
  in four files, and only `release.ts` has tests.
- Change: `scripts/targets.ts` exports one table, `TARGETS: Record<Target, { triple, platform,
  installers, update }>` (the content of `RELEASE` plus the triple), the type `Target` and `here()`.
  `build.ts` validates against its keys. `build-app.ts` takes the triple from it and signs
  `endingIn(join(out, update.from), update.ends)`. `release.ts` keeps `collect`, `latest` and `sums`
  and imports the table (`release-status.ts` goes on importing it from there or from `targets.ts`).
  `check-update.ts` takes platform and update from `TARGETS[here()]`.
- Win: About 40 lines and three of four lists.
- Risk: low to medium. `release.test.ts` and `release-status.test.ts` cover the table's use in
  `collect`, `latest`, `expectedAssets`. `build-app.ts` is exercised by the build workflow on all
  five targets; `check-update.ts` runs by hand only.
- Confidence: high. Read all four; compared the three statements of the update artifact.

### R4. What the check scripts still repeat around `check-harness.ts`
- Principle: DRY
- Size: moderate
- Where: `scripts/check-binary.ts:45-55,74-101,123-127,284-286`;
  `scripts/check-app.ts:43-56,161-169,278-286`; `scripts/check-update.ts:150-162,214-222`;
  `scripts/check-scratch.ts:65-66`; `scripts/check-voice.ts:93-95`; `scripts/wait-up.ts:8-35`;
  `src/server/instance.ts:59-66`; also `scripts/scratch-obeya.ts:620-629`,
  `scripts/revoice-demos.ts:94-101`, `scripts/hero-video/demo.ts:130,565,690`,
  `scripts/site-shots.ts:148,155`
- Now: `check-harness.ts` shares `check`, `expect`, `until`, `exited` and the failure count. The
  rest of the skeleton is written per script.
  - The scratch repository and home: `check-binary.ts:74-101` and `check-app.ts:46-56` each write a
    plan doc, run `git init -b main`, add and commit as `Check <check@example.com>`, and write
    `canvases.json` into a fresh home. `check-binary` adds repository settings and a deploy script.
  - The home's entry: `entry()` in `check-app.ts:161-167` and `serverEntry()` in
    `check-update.ts:150-156` parse `<home>/server.json` by hand. `recorded(home)` in
    `src/server/instance.ts:59` does exactly that and returns the typed `Instance` (`pid`, `port`,
    `url`, `app`); `revoice-demos.ts:92` already uses it.
  - "Does it answer": `answers` in `check-app.ts:169` is `answers` of `wait-up.ts:29` with a 2 s
    timeout instead of 1 s.
  - Waiting for a started server: `check-binary.ts:125` polls with `until` for 60 s and does not
    notice when the binary exits at once. `waitUp` in `wait-up.ts` was written for that (ends when
    the process ends) and has one caller, `scratch-obeya.ts:600`.
  - The owner-key API client: `api`/`json` in `check-binary.ts:45-55`, `api` in
    `check-update.ts:157-162`, `api` in `scratch-obeya.ts:620-629`, `post` in
    `revoice-demos.ts:94-101`, and inline `fetch(..., { headers: ownerHeaders(join(dir, 'home')) })`
    in `hero-video/demo.ts` and `site-shots.ts`. Each fetches base plus path with
    `ownerHeaders(home)`, sends JSON, and fails on a status that is not ok (`check-update`'s returns
    null instead).
  - The end: `console.log(failed ? … : 'all checks passed'); process.exit(failed ? 1 : 0)` closes
    `check-binary`, `check-app` and `check-update`; `check-scratch` and `check-voice` exit without
    the summary line. `--keep` and the cleanup are written four ways.
- Why it matters: The scripts drift (two of five print no summary, one notices a dead server and one
  does not), and a change of the instance file or the owner header has six places to reach.
- Change: `check-harness.ts` gains `scratchRepo(dir, files)` (writes the files, inits and commits
  with the Check identity), `finish(note?)` (summary line and exit code) and a `started(process,
  url, headers, limit)` over `waitUp`. `check-app` and `check-update` read `recorded(home)`.
  `check-app` imports `answers` from `wait-up.ts`. `scripts/common.ts` gains `ownerApi(base, home)`,
  returning `(path, init?) => Promise<Response>` that throws on a status that is not ok, for the
  checks, `scratch-obeya.ts`, `revoice-demos.ts`, `site-shots.ts` and `hero-video/demo.ts` (which
  imports `ownerHeaders` from `src/server/owner.ts` already).
- Win: 60 to 80 lines; one reader of `server.json` on the TypeScript side.
- Risk: low. These scripts are checks themselves; the build workflow runs `check-binary`,
  `check-scratch` and `check-voice` on three systems. `check-app` and `check-update` run by hand.
- Confidence: high. Read all five checks, `wait-up.ts` and `instance.ts`.

### R5. Each script brings its own `fail`, `run`, `git` and `alive`
- Principle: DRY
- Size: moderate
- Where: `fail`: `scripts/app.ts:38-41`, `build.ts:32-35`, `build-app.ts:58-61`,
  `hero-video/publish.ts:49-52`, `scratch-obeya.ts:319-322`. `run`: `build.ts:37-40`,
  `build-app.ts:63-67`, `check-update.ts:37-41`, `hero-video/publish.ts:54-57`,
  `scratch-obeya.ts:907-910`, `check-scratch.ts:23-27`. Retry: `build-app.ts:72-81` and `:121-131`.
  `git`: `release.ts:94-97`, `release-status.ts:61-64`, `app.ts:47-50`, `check-binary.ts:89-93`,
  `check-app.ts:48-51`. `alive`: `scratch-obeya.ts:992-1000`, `android-phone.ts:316-323`,
  `hero-video/render.ts:69-72`, `check-scratch.ts:54-59`. `endingIn`: `common.ts:21-24`, again as
  `find` in `release.ts:67-71`; "that file or fail" as `one` in `build-app.ts:207` and
  `check-update.ts:64-68`. The checkout root: `app.ts:28`, `build.ts:23`, `build-app.ts:48`,
  `check-update.ts:30`, `scratch-obeya.ts:317`, `site-shots.ts:34`, `measure-resume-cache.ts:38`,
  `android-phone.ts:349`, `hero-video/demo.ts:18`, and exported as `CHECKOUT` by `gh.ts:20`. Obeya's
  home: `scratch-obeya.ts:405`, `revoice-demos.ts:30`, `hero-video/render.ts:91`, beside
  `obeyaHome()` in `plugin/skills/demo/lib/settings.ts:79`.
- Now: `fail` is five times "print `<script>: <message>`, exit 1". `run` is six times "spawn, fail
  on a non-zero exit"; `build-app.ts`'s and `check-update.ts`'s are the same lines (echo `$ cmd`,
  inherit the output, an `env` to add), one failing through `fail` and one throwing. `build-app.ts`
  has two retry loops of one shape (run, warn, pause, again, the last try through `run`): `persist`
  for the stapler and the loop inside `tauri` for the DMG. `git(cwd, ...args)` returning the trimmed
  output or null is in `release.ts` and `release-status.ts` word for word but for `Bun.spawnSync`
  against `spawnSync`. `release.ts` writes `endingIn` again as `find` although `build-app.ts` beside
  it imports it. `obeyaHome()` exists, and two of the three scripts that restate it import from its
  file already.
- Why it matters: About 100 lines of helpers nobody reads twice, in versions that differ by accident
  (one `run` echoes, one hides the output, one shortens long arguments).
- Change: `scripts/common.ts` gains `ROOT`, `failer(name)` (returns `fail`), `run(cmd, { cwd, env,
  quiet })`, `retry(cmd, pauses, { cwd, env, between })`, `git(cwd, ...args)` and `alive(pid)`,
  written with `node:child_process` so that the Node-run hero-video scripts can import them as
  `hero-video/stage.ts` imports `scratchDir` today. `release.ts` uses `endingIn`. The three scripts
  use `obeyaHome()`. Leave `hero-video/publish.ts` out: its test copies only `gh.ts` and
  `publish.ts` into a fake checkout.
- Win: About 80 lines.
- Risk: low. `release.test.ts` and `release-status.test.ts` cover the two `git` callers; the build
  workflow covers `build.ts` and `build-app.ts`.
- Confidence: high. Read each copy and noted how they differ.

### R6. The shell has three HTTP helpers, one of them a hand-written HTTP client
- Principle: KISS
- Size: minor
- Where: `app/src/main.rs:147-160` (`http`), `:163-171` (`post`), `:174-181` (`get`), `:183-185`
  (`answers`), `:481-486` (`watch`), `:194-196` (`entry`)
- Now: `http` opens a `TcpStream`, writes an HTTP/1.1 request by `write!`, reads exactly twelve
  bytes and parses bytes 9 to 12 as the status. `answers` and the three `POST /api/stop` calls use
  it. `post` and `get` do the same job with `ureq`, each setting the owner's key header with its own
  `match key()`. In `watch`, `server.json` is read as text and searched for `"takenOver"` and
  `"restarting"` although `entry(home)` a few lines above parses the same file for `running` and
  `orphaned`.
- Why it matters: Two HTTP stacks in 850 lines, and the key header set in three places. The text
  search would also match `"restarting": false`, which the server does not write today.
- Change: One `request(port, method, path, body: Option<&Value>, patience) -> Option<(u16, Value)>`
  on a `ureq` agent with a 500 ms connect timeout, the key header set once; `ureq` 2 reports a
  status from 400 up as `Err(Error::Status(code, _))`, which maps to `Some((code, Null))`. `answers`
  becomes "status 200", the stops become `.is_some()`, `post` and `get` become two-line wrappers.
  `watch` reads `entry(home)` and tests `e["takenOver"] == true` and `e["restarting"] == true`.
- Win: About 25 lines and the hand-written client.
- Risk: medium. The shell's HTTP has no unit test; `scripts/check-app.ts` checks start, second
  start, stop and the attach to a running Obeya on each system, by hand.
- Confidence: medium. Read all three files and `Cargo.toml` (`ureq` 2 without default features); did
  not build.

### R7. `scratch-obeya.ts` repeats small things within itself
- Principle: DRY
- Size: minor
- Where: `scripts/scratch-obeya.ts:418-421,438-441,469-472,740-744` (and `check-binary.ts:85-88`);
  `:337,343,368,1180,1193,1201`; `:344,940-946,1182`; `:435,544`; `:1074-1093,1147-1159`;
  `:936,1122` with `common.ts:34` and `check-scratch.ts:40`
- Now: (a) "For each path and text of a file map: make its directory, write it" is written four
  times (the repository's files, a pull request's, a further repository's, a branch's). (b)
  `opt('dir') ?? scratchDir(port)` appears six times. (c) `staged.json` is read and parsed in three
  places (`--login`, `stagedIn`, `scratchAt`). (d) The forge's repository name `stage.forgeRepo ??
  \`acme/${basename(repo)}\`` is computed three times, twice inside one expression at line 544,
  though line 435 names it `slug`. (e) `signalGroup` and `endPid` are one procedure (SIGTERM, again
  after 1.5 s, SIGKILL after 4 s) on `-pid` and on `pid`. (f) The name `obeya-scratch-<port>` is
  built in `common.ts:34`, built again in `check-scratch.ts:40`, and matched by two regular
  expressions (`:936`, `:1122`).
- Why it matters: Each is small; together they are about 50 lines, and (d) and (f) are rules stated
  more than once.
- Change: `writeFiles(dir, files)` (in `common.ts`, for `check-binary.ts` too, taking `string | {
  from }` values so the branch case fits); `dirOf(port)`; one `staged(d)` returning the typed
  content or undefined; `slug` at the top level; `end(target, pid)` called with `-pid` or `pid`;
  `check-scratch.ts` uses `scratchDir(port)`, and `common.ts` exports the pattern beside
  `scratchDir`.
- Win: About 50 lines.
- Risk: low. `scratch-obeya.test.ts` and `check-scratch.ts` cover staging and stopping.
- Confidence: high.

### R8. `scratch-obeya.ts` still caters for code from the project's first two days
- Principle: YAGNI
- Size: minor
- Where: `scripts/scratch-obeya.ts:523-524,586` (`canIdle`), `:657-658` (`kind: 'feature'`)
- Now: With `--code <commit>` the script reads that commit's `src/server/main.ts` for
  `'idle-workers'` and warns when it is missing. It also sends `kind: 'feature'` with every new card
  for "code before cards lost their kind".
- Why it matters: `--idle-workers` came with commit `00588103` (2026-10-01), the commit that added
  `scratch-obeya.ts` itself; cards lost their kind in `4ed3ec6b` (2026-10-02). `--code` exists for a
  before and after of a change. A "before" from the first two days, 1,400 commits and twelve release
  tags back, predates the owner key, plan-doc labels, the recorded runtimes and most columns the
  script writes, so it could not be staged from a current stage file anyway.
- Change: Drop `canIdle` (pass `--idle-workers` whenever `idle`) and the `kind` field. Keep the
  newer cases, which a before and after can still reach: plan-doc labels (`:650`, 2026-11-03),
  `changed_at` (`:753`, 2026-11-04), `OBEYA_SCRATCH` (`:533`, 2026-11-09), `replayRuntime` (`:515`,
  2026-10-22).
- Win: 6 lines and one variable.
- Risk: low.
- Confidence: medium. Dated each case with `git log -S`; where the cut-off lies is a judgement.

### R9. The stage file is documented in two halves
- Principle: DRY
- Size: minor
- Where: `scripts/scratch-obeya.ts:76-174` (the header's prose), `:194-315` (`StageCard` and `Stage`
  with JSDoc)
- Now: The header describes the fields in prose paragraphs (several lines run to 1,000 characters),
  and the interfaces describe many of the same fields again in JSDoc, in other words. Neither is
  complete: `forgeViewer`, `prPoll`, `queue.checking` and `friction[].repo` are only in the types;
  what `row`, `archivedAgo`, `changedAgo` and the time format mean is only in the header; `pulls`,
  `forgeClone`, `spent`, `voice`, `copy`, `git`, `setup`, `repoName`, `repos`, `canvases`,
  `poolCheckout`, `settings`, `slots`, `hosts`, `snoozed`, `branchFiles` and `prototypeOf` are in
  both.
- Why it matters: An agent told to read the header (CLAUDE.md does) misses the fields that only the
  types name, and a new field has two places to be described in.
- Change: The header keeps the command lines, the output line and the example JSON, and says that
  every field is described at `Stage` and `StageCard`. Each field's description moves to the JSDoc
  of that field, which sits where `tsc` checks the name.
- Win: About 60 lines of prose, and one place per field.
- Risk: none for the code.
- Confidence: high. Compared both for the fields named.

### R10. Two scripts set the language through the API after staging, though the stage file has `language`
- Principle: YAGNI
- Size: minor
- Where: `scripts/hero-video/demo.ts:50-54`; `scripts/site-shots.ts:147-148`;
  `scripts/hero-video/stage.ts:23-26`; `scripts/scratch-obeya.ts:403`
- Now: After staging, `demo.ts` runs `curl -X PUT /api/language -d '{"language":"en"}'` through
  `execFileSync`, and `site-shots.ts` sends the same request with `fetch` to both of its scratch
  Obeyas. `PUT /api/language` saves `language` in the home's `settings.json` (`saveLanguage`,
  `src/server/settings.ts:63`), which is the file `scratch-obeya.ts:403` writes from the stage's
  `language` before the server starts. Both calls are older (2026-10-08 and 10-12) than the stage's
  `language` (2026-10-19). In the same function `demo.ts` posts `voice/warm` through `curl` and
  waits through `execFileSync('sleep', ['20'])`, although the file uses `fetch` with `owner()`
  elsewhere and the caller (`login`) is async.
- Why it matters: Three requests and two child processes for what one field does, and `curl` and
  `sleep` are not on every system.
- Change: `writeStage` in `stage.ts` sets `language: 'en'` (the stages of `site-shots.ts` are made
  from it and inherit it). Remove `demo.ts:51` and `site-shots.ts:147-148`. Make `stage()` in
  `demo.ts` async, with `await fetch(.../voice/warm, { method: 'POST', headers: owner() })` and a 20
  s `setTimeout` promise; the import of `KEY_HEADER` goes.
- Win: About 8 lines and three requests.
- Risk: low. A short render (`HERO_SHORT=1 … --qwen`) and `site-shots.ts --stage-only` show the
  language.
- Confidence: high. Read `saveLanguage` and the staging of `settings.json`.

### R11. `hero-video/demo.ts` polls the created card with five hand-written loops
- Principle: DRY
- Size: minor
- Where: `scripts/hero-video/demo.ts:137-144` (`until`), `:147-153` (`statusLine`), `:521-522`,
  `:537-544`, `:562-563`; also `:700-703` and `:715-718`; `:178` and `:194`
- Now: Five loops of one shape: a deadline, `await created()`, a test of the card, a sleep of 1 to 3
  s. They differ in the test (state in a list, a status line, held comments gone, answering begun
  and ended, no longer finishing), the deadline and whether running out throws. The four lines after
  a page load (go there, hide `bun-hmr`, load the three microphone clips, wait for "App icon") stand
  twice, around the reload (the clone list has this pair). The cast `(window as unknown as { __demo:
  … })` is written out twice beside the `Mic` type that does the same for the microphone.
- Why it matters: 30 lines that hide what each scene waits for.
- Change: `untilCard(done: (card) => boolean, ms, every = 2000): Promise<boolean>`; `until(states,
  what)` and `statusLine()` become one-liners over it, and the three inline loops calls. A local
  `loaded()` for the four lines; a `Demo` type beside `Mic`.
- Win: About 25 lines.
- Risk: low to medium. Nothing tests the scenes but a render; a `--replay` render plays the whole
  video in minutes without agents.
- Confidence: high.

### R12. `site-shots.ts` parses `chapters.vtt` itself and writes one formula twice
- Principle: DRY
- Size: minor
- Where: `scripts/site-shots.ts:64-67` with `src/server/demo.ts:143-146`; `:199` and `:286`;
  `:167-169,209-211,276-278`
- Now: `chaptersOf(dir)` reads `chapters.vtt` into `[seconds, title][]` with its own regular
  expression, to give the staged card the chapters a card would have. `rereadChapters(dir)` in
  `src/server/demo.ts` returns exactly those marks, from the same file, for the server (it rounds to
  0.01 s instead of 0.1 s, wants `captions.vtt` beside the video, and returns a message instead when
  something is missing). The moment a picture shows, "into the second chapter by a share of its
  length, else 3 s", is one long expression at `:199` (share 0.8) and again at `:286` (share 0.6).
  "Go to the staged page, wait for the first `.card`, wait a second" stands three times.
- Why it matters: The screenshots should show what a card shows, which only the server's reader
  guarantees.
- Change: Import `rereadChapters` and fail with its message. `inSecondChapter(chapters, share)` for
  the moment. `opened(page, url)` for the three waits. (`hero-video/publish.ts:31-37` has a third
  chapter reader; it stays, since its test runs the script without `src/`.)
- Win: About 12 lines and one of three chapter readers.
- Risk: low. The script's result is looked at before it is committed.
- Confidence: high. Read both readers.
- Done by W17: `chaptersOf` through `rereadChapters`, `inSecondChapter` and `cardsShown`.

### R13. `hero-video/qwen.py` answers a question that was decided, and has to be kept in step
- Principle: YAGNI
- Size: minor
- Where: `scripts/hero-video/qwen.py:1-119`; `scripts/hero-video/README.md:72-84`; `CLAUDE.md` (the
  line on the site's voice); `scripts/hero-video/render.ts:25,87-89`
- Now: `qwen.py` (2026-10-12) speaks a rendered hero video's narration again in Qwen3 to compare it
  with ElevenLabs. CLAUDE.md records the outcome ("the site stays with ElevenLabs (owner,
  2026-10-12)"). Three days later `render.ts --qwen` arrived, which renders the whole video in Qwen3
  through the demo pipeline. Since then three commits had to touch `qwen.py` to keep it working
  (2026-10-26 the demo directory, 2026-11-01 Qwen3's hearing back, 2026-11-04 `tts-jobs.json`). It
  restates `demoDirectory()` (`:39-47`) and the lookup of the main checkout (`:50-52`, also
  `render.ts:29-30`) in Python, and reads `jobs.json` for renders "from before tts-jobs.json".
- Why it matters: 119 lines kept in step with the demo pipeline for a comparison nobody is waiting
  for.
- Change: Ask the owner. If the comparison is done, remove `qwen.py`, its README section and the
  half sentence in CLAUDE.md; a later comparison renders with `--qwen` beside the ElevenLabs render.
  If it stays, nothing needs to change.
- Win: 119 lines and a README section.
- Risk: low. Nothing imports it.
- Confidence: medium. The script is named in CLAUDE.md and the README, so it is not dead by
  reference; that its job is done is my reading of the dated decision.

### R14. The workflows pin Bun in six places, and a header comment describes an older check
- Principle: DRY
- Size: minor
- Where: `.github/workflows/build.yml:61,95,112,139,189`, `.github/workflows/pages.yml:36`;
  `.github/workflows/build.yml:3-5`
- Now: `bun-version: 1.4.3` is written six times. The header of `build.yml` says `check-binary.ts`
  checks "a repository's own adapter, Playwright and the adapter kit from the resources";
  `check-binary.ts` checks the repository's own settings, Playwright among the resources and a
  script run on the binary's Bun, and "adapter kit" occurs nowhere else in the repository.
- Why it matters: A Bun update has six lines to change, and one missed leaves a job on another Bun
  than the tests ran on.
- Change: A workflow-level `env: BUN_VERSION: 1.4.3` in each workflow and `bun-version: ${{
  env.BUN_VERSION }}`, or a `.bun-version` file with `bun-version-file` if the `setup-bun` version
  in use reads one (check its README first). Rewrite the comment from `check-binary.ts`'s header.
- Win: Five of six pins.
- Risk: low.
- Confidence: high on the count and the comment; medium on `bun-version-file`.

## Justified (looks redundant or complex, but has a reason; leave it)
- `scripts/scratch-obeya.ts:674-873` writes rows into SQLite itself instead of calling the server's
  functions: with `--code` or `--binary` the server is another build than the script's, so it writes
  columns and checks that they exist (`:679,760`); the header says so and
  `docs/design/running-obeya.md` ("Scratch Obeyas") describes it.
- `scripts/scratch-obeya.ts:1117-1144` `sweep` and its 12 hours: a recorded decision
  (running-obeya.md, 2026-11-09).
- `scripts/scratch-obeya.ts:515,533,650,753` cases for older code from the last weeks: a before and
  after with `--code` reaches them.
- `scripts/android-phone.ts:326-334` its own `until`: it lets a `Fail` thrown by the check end the
  wait (`start` relies on it), where `check-harness`'s swallows errors. Its own argument parser is
  tested per sub-command.
- `scripts/hero-video/publish.ts:31-57` its own `chapterStarts`, `fail` and `run`: `publish.test.ts`
  runs the script in a fake checkout that holds only `gh.ts` and `publish.ts`.
- `scripts/wait-up.ts`: one caller, but a tested piece (`wait-up.test.ts`); R4 gives it more
  callers.
- `scripts/check-binary.ts:44`, `scripts/check-app.ts:40` rebind `until` with another interval:
  minutes against moments.
- `app/src/main.rs:67,70,187-196`, `app/src/update.rs:41`: `DEFAULT_PORT`, `KEY_HEADER`, `home()`,
  `entry()` and `EXIT` restate the server's port, header, home, instance file and exit code in Rust;
  each names its TypeScript source, and the two cannot share code.
- `app/src/update.rs:132-139` `tree()` and `scripts/app.ts:58` both run `git rev-parse HEAD:app`:
  the shell compares the checkout's tree with the one compiled in.
- `app/src/main.rs:563-591` `Placed` writes and reads its JSON field by field: `serde`'s derive is
  not a dependency of the shell.
- `app/src/badge.rs:60-86` four `cfg_attr(not(windows), allow(dead_code))`: the overlay is
  Windows-only but its tests run everywhere.
- `scripts/build-app.ts:156-214` notarises and signs itself instead of through Tauri: the header
  gives the reasons (Tauri notarises the app but not the DMG, and would sign the AppImage without
  the server).
- `.github/workflows/build.yml:26` `paths-ignore` beside `INERT` in `src/core/inert.ts`: YAML cannot
  import it, and the two differ on purpose (a change to `build.yml` must build).
- `scripts/release-status.ts:26` `SECRETS` beside the workflow's check at `build.yml:155`: the same,
  YAML cannot import it.
- `scripts/measure-resume-cache.ts`, `scripts/revoice-demos.ts`, `scripts/social-preview.ts`,
  `scripts/slide-font-widths.ts`, `scripts/logo.tsx`: they look like one-off scripts, but the design
  chapters name each as the tool for its job (`docs/design/agents-and-workspaces.md:480`,
  `docs/design/demos.md:461`, `docs/design.md:190`, `src/server/slide-checks.ts`,
  `docs/design/the-canvas.md`).
- `scripts/hero-video/load.ts`, `scripts/app-replace.ts`, `scripts/gh.ts`, `scripts/release.ts`,
  `scripts/release-status.ts`, `scripts/site-sitemap.ts`, `scripts/test.ts`: clean; nothing to
  report beyond the shared helpers in R5.

## Bugs noticed in passing
- `.github/workflows/build.yml:3-5` the comment on what `check-binary.ts` checks is out of date (see
  R14).
