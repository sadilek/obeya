# T: the tests (all `*.test.ts*`, `src/server/testing.ts`, `workers-fixture.ts`, fixtures)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The tests read well one by one: behaviour-titled, almost no literal copy-paste, and every helper
exported from `src/server/testing.ts` has users (no dead test helpers). The redundancy is
structural: the same setup mechanics (a card walked to "handed over", a commit in a repository, a
board or a canvas staged, a wait) are written again in file after file instead of living in
`testing.ts` or a fixture; and the one fixture there is (`workers-fixture.ts`) cannot be told which
adapter to set up, so about 85 tests build their repository and workers twice, as `canvas.test.ts`
does with its canvas in 51 of its 89 tests. Coverage: the shared infrastructure was read completely;
of the twelve largest files, every setup block and helper and about 2,600 of their 17,000 lines of
test bodies were read, the rest compared mechanically (top-level helpers, setup blocks, multiline
`rg` counts), so "restated scenario" findings inside those bodies may be missing.

## Findings

### T1. "A card started, a commit in its workspace, handed over" is written about a dozen times
- Principle: DRY
- Size: major
- Where: `src/server/workers-landing.test.ts:227-232`, `:363-377`, `:439-451`, `:569-575`,
  `:663-673`; `src/server/workers-demo.test.ts:30-36`; `src/server/pr-watcher.test.ts:89-96`;
  `src/server/server.test.ts:1347-1358`; `src/server/review.test.ts:131-136`, `:1066-1073`;
  `src/server/ideas.test.ts:947-948`; `src/server/folder-canvas.test.ts:196-205`; plus the sequence
  inline (`rg -c "call\('ready_for_review', \{ summary: '[^']*', demo: artifact\(\) \}\)"`:
  workers-worktrees 34, workers-landing 22, workers 17, workers-demo 5, coordinator 4, pr-watcher 2,
  canvas 2).
- Now: each helper does `board.create` / `manual()`, `await workers.start(id)`, optionally writes a
  file and commits it in `board.row(id).workspace`, `await runtime.last.call('ready_for_review', {
  summary: 'S', demo: artifact() })`, `runtime.last.emit({ type: 'idle' })`, and returns the card.
  They differ only in the title, whether a commit is made (a `commit = true` flag in two of them),
  the demo (plain `artifact()` or with a `page`), and whether the idle event is sent.
- Why it matters: this is the worker protocol's handover; a change to it (another required field of
  `ready_for_review`, another end-of-turn event) is made in about 100 places, and the copies hide
  which tests differ on purpose.
- Change: one `handedOver(opts?: { title?, commit?: boolean, demo?, idle?: boolean })` in
  `src/server/workers-fixture.ts`, returning `{ card, session, workspace }` and built on the
  `commit` helper of T5. The local helpers go; the two that add something (the trailer commit of
  `workers-landing.test.ts:363`, the `page` of `:439` and `:569`) become one-line wrappers that pass
  the difference. The canvas-level variants (`server.test.ts`, `review.test.ts:1066`,
  `folder-canvas.test.ts`) take the `workers` and `runtime` to use as parameters, or move with the
  canvas fixture of T3.
- Win: about a dozen helper definitions and roughly 80 inline sequences become calls; about 250
  lines.
- Risk: low; test code only, each test's own assertions protect it.
- Confidence: high; all listed definitions read side by side, inline counts by rg.
- Done by W2 for the workers tests: `handedOver({ card?, title?, commit?, summary?, demo?, idle? })`
  in `workers-fixture.ts` returns `{ card, session, workspace }`; the local helpers of
  `workers-landing.test.ts` and `workers-demo.test.ts` and the contiguous inline sequences of the
  workers tests use it; the helper with two commits and a trailer stays, as `trailered`. Inline
  sequences that do something between start, commit and handover (most in
  `workers-worktrees.test.ts`) stay as they are. Left for W3, since they drive other `Workers` than
  the fixture's: the helpers of `pr-watcher.test.ts`, `review.test.ts`, `ideas.test.ts`,
  `server.test.ts` and `folder-canvas.test.ts`.
- Done by W3: the handover moved to `handedOverOn({ board, workers, runtime }, opts)` in `testing.ts`
  (it identifies the workspace before it commits), and `handedOver` of either fixture is that on
  the fixture's own board and workers; `pr-watcher.test.ts` and the pushed canvas of
  `server.test.ts` call it. Left as they are: the review card's helpers in `review.test.ts` (they
  record findings and pass review results, another protocol), the prototype's one-line `handOver`
  in `ideas.test.ts`, and the folder canvas's `handed` (no git, it writes through the agent's
  tools).

### T2. The workers fixture cannot be told its adapter: 27 "remove it and set it up again" calls, about 85 tests build everything twice
- Principle: KISS (and plain waste)
- Size: major
- Where: `src/server/workers-fixture.ts:46-101` (`setup`, `eachTest`); the re-setups `await
  removeDir(dir); await setup(…)` at `src/server/workers-worktrees.test.ts:14-18` (a `beforeEach`
  over all 39 tests of the file), `:337`, `:573`, `:670`;
  `src/server/workers-landing.test.ts:16-19`, `:154`, `:173`, `:184-188`, `:209-212`, `:328`,
  `:353-355`, `:432-434`, `:564-567`, `:791-794`, `:1158`, `:1197`, `:1209`;
  `src/server/workers-demo.test.ts:238`, `:251`, `:261`, `:265`, `:275`, `:602`, `:703`, `:743`,
  `:767`, `:793`.
- Now: `eachTest()` registers a file-level `beforeEach` that always sets up `{ ...generic, land:
  'main', workspaces: 'clones', setup, checks, app }`: a copy of the template repository, a copy of
  its clone, `ensureClones`, a store, a board, workers. A describe or test that needs another
  adapter (`worktrees`, `land: 'pr'`, an origin) removes that directory and calls `setup` again. In
  `workers-worktrees.test.ts` every test does so; a few do it a third time (`:573`,
  `workers-demo.test.ts:261-276`).
- Why it matters: the first setup is thrown away in about 85 tests (git calls and repository copies
  are what make the suite slow, as CLAUDE.md says), each call site carries a `removeDir` line the
  reader has to understand, and the first `Workers` is dropped without `shutdown()`.
- Change: `eachTest(adapter = defaultAdapter, withOrigin = false)` registers its hooks in the scope
  it is called from, so a file calls it inside each `describe` (or once at the top where all tests
  share an adapter) instead of once per file plus overrides. For single tests with an adapter of
  their own, `setup()` itself removes a previous `dir` (after `await workers?.freed()`), so the call
  site is `await setup(adapter)` alone.
- Win: 27 `removeDir` lines, one wasted fixture build in about 85 tests, and
  `workers-worktrees.test.ts` no longer begins by undoing its fixture.
- Risk: low to medium: the order of hooks in nested describes must stay (the cleanup `afterEach`
  last); the workers tests themselves are the check.
- Confidence: high for the pattern (all 27 sites listed by rg, their context read); the 85 is the
  sum of the affected describes' test counts, approximate.
- Bug fixed (W1 of the bug plan): the fixture's `afterEach` shuts down every `Workers` a test made
  (`setWorkers`, `tracked`) before awaiting their `freed()`, and `setup` tears the setup before it
  down the same way (`tearDown`), so the 27 call sites lost their `removeDir` line; what is left of
  this finding is the adapter for `eachTest`.
- Done by W2: `eachTest(adapter?, withOrigin?)` registers its hooks in the scope it is called
  from; `workers-landing.test.ts` calls it per describe, `workers-worktrees.test.ts` once with the
  worktrees adapter. Single tests with an adapter of their own still `await setup(adapter)`.

### T3. The one-repository canvas harness is rebuilt in file after file: there is a workers fixture but no canvas fixture
- Principle: DRY
- Size: major
- Where: `src/server/ideas.test.ts:11-60`, `src/server/revisions.test.ts:10-34`,
  `src/server/answers.test.ts:16-59`, `src/server/snooze.test.ts:10-35` (near-identical); the same
  shape with a server in front in `src/server/server.test.ts:23-78` and
  `src/server/tag-proposal.test.ts:12-61`, and with small differences in
  `src/server/folder-canvas.test.ts:10-34`, `src/server/read-tree.test.ts`,
  `src/server/remote.test.ts`, `src/server/config.test.ts`.
- Now: each declares `dir`, `main`, `store`, `runtime`, `canvas`; `open = () =>
  CanvasRuntime.start({ repos: [{ path: main, clones: 1 }] }, { store, home: dir, runtime, forge:
  noForge, commandDelayMs: 10, … })`; a `beforeEach` of `mkdtempSync` + `gitRepo(main)` + `new
  Store(':memory:')` + `new FakeRuntime()` + `open()`; an `afterEach` of `canvas.shutdown()` +
  `removeDir(dir)`; then `board = () => canvas.board`, `item = (id) => board().item(id)!`, a
  `settle`, a session finder. The four differ in the options given to `start` (`settings: { land }`,
  `permissionMode`, `limitMargin`, `voicing`) and in the repository's files. With it come
  `isCoordinator` (`answers.test.ts:48`, `revisions.test.ts:33`, identical) and the three steps "say
  it, let the Coordinator's session call a tool, end its turn" (`say` in `commands.test.ts:21-28`,
  `answers.test.ts:52-59`, `revisions.test.ts:41-50`).
- Why it matters: `CanvasRuntime.start`'s dependency object is written at 72 call sites in 16 test
  files; a change to how a canvas starts or stops is made file by file, and already differs (the
  `afterEach` of `ideas.test.ts:29-34` awaits `workers.freed()` before the directory goes, the other
  three do not).
- Change: `src/server/canvas-fixture.ts` beside `workers-fixture.ts`, in its style: `eachTest({
  files?, repo?: Partial<RepoConfig>, deps?: Partial<…> })` sets up `dir`, `main`, `store`,
  `runtime`, `canvas` and exports `open()` (for tests that restart), `board()`, `item(id)`,
  `settle()` (T10) and `say(…)`; its teardown awaits `freed()`, shuts down and removes. ideas,
  revisions, answers and snooze move first; the server-fronted files use it for the canvas and keep
  their `serve`.
- Win: about 25 lines of harness in each of four files at once, more as others follow; one place
  that knows how a canvas for tests starts and stops.
- Risk: low.
- Confidence: high for the four files (headers read side by side); medium for the wider list (setup
  blocks read, bodies sampled).
- Bug fixed (W1 of the bug plan): `revisions.test.ts`, `answers.test.ts` and `snooze.test.ts`
  await `freed()` of the canvas's workers before removing the directory, as `ideas.test.ts` does.
- Done by W3: `src/server/canvas-fixture.ts` with `eachTest({ files?, repo?, deps? })`, `open`,
  `restart` (Obeya started anew), `start` (another canvas beside it, shut down after the test too),
  `board()`, `item(id)`, `workers()`, `settle()`, `say(…)` and `handedOver`. ideas, revisions,
  answers, snooze, `server.test.ts`, `remote.test.ts` and `tag-proposal.test.ts` use it.
  `isCoordinator` was gone already (`withTool('look_up')`). Left as they are: `folder-canvas.test.ts`
  (a folder without git), `read-tree.test.ts` (a checkout cloned from an origin, started per test),
  `config.test.ts` (one describe with a canvas among tests of the configuration) and `commands.test.ts`
  (a `Commander` on a bare board, no canvas).

### T4. `canvas.test.ts` starts a two-repository canvas before every test, and 51 of its 89 tests start their own instead
- Principle: KISS (and plain waste)
- Size: moderate
- Where: `src/server/canvas.test.ts:34-47` (file-level `beforeEach`/`afterEach`); tests that begin
  with `fresh(); … canvas.shutdown(); canvas = await CanvasRuntime.start(…)`: `:348-363`,
  `:365-409`, `:431-456`, `:458-478`, `:480-492`, `:494-527`, `:529-583`, `:585-916` (the settings
  describes), `:918-…` (its `open` at `:922-930`), `:1320-1553`, `:1757-1905`. Counted with awk over
  the test bodies: 51 tests call `CanvasRuntime.start`, `Canvases.start`, `startCanvases` or the
  describe's `open`; 41 call `canvas.shutdown()` on the default canvas.
- Now: the file-level `beforeEach` makes two repositories with a plan doc each and starts the canvas
  "Produkt" with one clone per repository. Tests of other subjects (how settings apply, which
  canvases start, how work lands) call `fresh()` for an empty directory, shut the default canvas
  down, start their own and assign it to `canvas` so that the `afterEach` shuts that one down. Four
  tests that work with a `Canvases` set end by starting one more canvas only so the hook has
  something to shut down (`:362`, `:408`, `:455`, `:477`).
- Why it matters: two repository copies, two clones and a canvas start are thrown away in more than
  half the tests; each of them opens with two or three lines of undoing the setup; the throwaway
  canvas at the end of a test is machinery for the hook, not for the test.
- Change: the default canvas moves into a `beforeEach` of the describes that use it ("a canvas with
  several repositories" and the voice and queue describes from `:1555` on); the file-level setup
  makes `dir` and `runtime` only. The `afterEach` shuts down whatever a test started through a small
  `start(config, deps)` wrapper that records it, so no test hands a canvas to the hook.
- Win: about 50 wasted canvas starts, about 100 lines of preamble, the four throwaway starts.
- Risk: low; test code only.
- Confidence: high; lines 1-610 read completely, the rest by the listing of `fresh()`,
  `canvas.shutdown()` and the start calls with their lines, and the awk count.
- Bug fixed (W1 of the bug plan): every test of `canvas.test.ts` that starts a canvas of its own
  shuts down the default one first; the file leaves no canvas or workers running.

### T5. No shared "write a file and commit it": about 70 inline triples and a dozen local helpers
- Principle: DRY
- Size: moderate
- Where: inline `writeFileSync(join(x, f), …); git(x, 'add', '.'); git(x, 'commit', '--quiet', '-m',
  …)` (multiline rg): workers-landing 19, canvas 10, workers 9, review 6, workspaces 4,
  workers-worktrees 4, read-tree 4, server 3, coordinator 3, workers-files 2, workers-evict 2, ideas
  2, config 2, self-update 1, pr-watcher 1, testing.test 1. Local helpers:
  `workers-landing.test.ts:214-218` and `workers-worktrees.test.ts:20-24` (`commitIn`, identical),
  `pr-watcher.test.ts:81-86`, `review.test.ts:121-128` (`commitOwn`), `ideas.test.ts:940-946`,
  `self-update.test.ts:13-19`, `source-update.test.ts:14-20`, `workspaces.test.ts:540-544`,
  `:627-631`, `:678-682`, `:729-733` (four identical copies, T11), and by rg only
  `workspaces.test.ts:865`, `replay.test.ts:221`.
- Now: the helpers differ in whether they `identify()` first, whether they return the new HEAD, and
  the commit message (the file's name, its text, a fixed word).
- Why it matters: `gitRepo`, `gitClone` and `identify` are in `testing.ts`; the fourth everyday git
  step is not, so every file grows its own.
- Change: `export function commit(repo: string, file: string, text = `${file}\n`, message = file):
  string` in `src/server/testing.ts` beside `gitRepo`: makes the file's directory, writes it, `git
  add -A`, commits, returns the trimmed `rev-parse HEAD`. Call sites that need an identity call
  `identify` once in their setup, as most do.
- Win: about 150 lines and a dozen helper definitions.
- Risk: low.
- Confidence: high; counts by multiline rg, eleven of the thirteen helpers read.
- Done by W2: `commit(repo, file, text?, message?)` in `testing.ts` replaces the inline triples
  that commit one file and the local helpers; commits of several files at once stay inline.

### T6. The test canvas literal and the positional `new Board(…)` are spelled out about 50 times
- Principle: DRY
- Size: moderate
- Where: `{ id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: …, branch: 'main' }] }`
  (rg: 38 hits in 15 files): workspaces.test 10, commands.test 5, commands.live.test 5, hosts.test
  4, coordinator.test 3, workers-landing.test 2, and one each in workers-fixture, work-retro, site,
  share, review, project-agents, pr-watcher, plan-identity, personal-site tests; the same with other
  ids at `src/server/board.test.ts:25`, `:483`, `:493`, `:825`, `:843`. Where clones are used, three
  more lines go with it: `new Workspaces(store, 'c', { mode: 'clones', repoPath: main, dir:
  join(dir, 'ws') }); gitClone(main, join(dir, 'ws', '1')); await workspaces.ensureClones(main, 1)`
  (`workers-fixture.ts:60-66`, `review.test.ts:92-94`, `pr-watcher.test.ts:45-47`).
- Now: every file that needs a bare board writes `new Board(store, <that literal>, () => ({ docs,
  dirs: [] }))`; those that need a language append `undefined, undefined, () => language, () =>
  conversation` (`workers-fixture.ts:59`, `commands.test.ts:41`, `pr-watcher.test.ts:44`).
- Why it matters: `Board`'s constructor takes seven positional parameters; reshaping it, which a
  cleanup of `board.ts` is likely to want, edits about 50 test lines unless the tests go through one
  helper first. Worth doing before the production cleanup starts.
- Change: in `src/server/testing.ts`: `testBoard({ store = new Store(':memory:'), path = '/r', docs
  = () => [], language?, conversation?, holds? })` with the canvas literal inside, and
  `primedClones(store, main, dir, n = 1)` for the three clone lines. `board.test.ts` keeps its
  constructor calls where the canvas id is the subject.
- Win: about 50 long lines shortened; the constructor's shape known in one place.
- Risk: low.
- Confidence: high; rg counts, the setup blocks of twelve of the files read.
- Done by W3: `testBoard` and `primedClones(store, repo, dir, { n?, source? })` in `testing.ts`;
  every board on the test canvas literal goes through `testBoard`, the clone triple through
  `primedClones` where it is that triple (the workers fixture, `review.test.ts`,
  `pr-watcher.test.ts`). Boards on other canvases (`board.test.ts`, several repositories, other
  ids) and clones set up another way (from an origin, a second clone, `coordinator.test.ts`'s pool)
  keep their own lines.

### T7. `setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: … }))` 35 times to change one option
- Principle: DRY
- Size: moderate
- Where: `src/server/workers.test.ts` (18 sites, e.g. `:48`, `:57`, `:85`, `:720`, `:749`, `:775`,
  `:795`, `:810`), `src/server/workers-demo.test.ts` (8: `:20`, `:267`, `:277`, `:649`, `:728`,
  `:819`, `:905`, `:929`), `src/server/workers-landing.test.ts` (6: `:175`, `:319`, `:360`, `:437`,
  `:567`, `:637`), `src/server/workers-worktrees.test.ts` (3: `:506`, `:848`, `:901`).
- Now: a test that needs one constructor option (`limitMargin: 30`, `backgroundLimit: 10`,
  `holdGrace: 10`, `toObeya`, `imageFiles`, `shares`, `onApproval`) builds `Workers` again from the
  fixture's parts and repeats `board, runtime, workspaces: spaces, adapter: { ...generic, land:
  'main', workspaces: 'clones' }`. The adapter it passes is not the fixture's (which also has
  `setup`, `checks`, `app`), mostly without the test meaning anything by that; several pass plain
  `generic` (`workers.test.ts:85`, `workers-demo.test.ts:649`, `:819`, `:905`, `:929`).
- Why it matters: 35 places name what a `Workers` needs; a change to its dependencies edits all of
  them, and the silently different adapter makes these tests differ from the fixture in a way no
  reader sees.
- Change: the fixture keeps the adapter it was set up with and exports `rebuild(options)`, which
  builds `Workers` from the fixture's own parts plus the overrides (an `adapter` among them where a
  test wants another) and replaces `workers`.
- Win: 35 long lines become `rebuild({ limitMargin: 30 })`; one place knows what a `Workers` needs.
- Risk: low to medium: a test that today gets the reduced adapter would get the fixture's (with
  `checks` and `app.run`), which changes briefing text some tests assert on; keep the adapter
  explicit where assertions depend on it.
- Confidence: medium; the count is by rg, about a third of the sites read.
- Bug fixed (W1 of the bug plan): the `Workers` these sites replace are shut down after the test,
  through `setWorkers` in the fixture.
- Done by W2: `rebuild(options)` replaces `workers` with workers built from the setup's own
  options (its adapter, `onMerged`, `env`, `keptDemos`) and the overrides, and `newWorkers(options)`
  builds further ones (another board, an Obeya started anew). The tests pass with the fixture's
  adapter except where they name another; one test that needs workers without `keptDemos` says so.

### T8. `db.test.ts` builds old databases by undoing later migrations by hand, and addresses migrations by their distance from the end
- Principle: DRY (parallel lists kept in step by hand)
- Size: moderate
- Where: `src/server/db.test.ts:10-22` (`beforeHistory`, `beforeArchivePages`), `:80-131`,
  `:171-196`, `:225-245`, `:367-368`; against `src/server/db.ts:215` (`SCHEMA`), `:392-395`
  (`RELEASED`, `MIGRATIONS`), `:716-730`.
- Now: a migration test opens a current `Store`, inserts rows through today's API, then drops by
  hand every column, index, trigger and table the migrations after the one under test added (three
  lists of `DROP …` statements, 50, 20 and 20 lines, sharing most lines; the clone detector's hit
  `:178-196` / `:227-245` is this), and sets `PRAGMA user_version = RELEASED + MIGRATIONS.length -
  18` (`- 16`, `- 2`) before it reopens the file.
- Why it matters: every new migration that adds a schema object has to be undone in each of these
  lists and in `beforeHistory`, and every new migration of any kind shifts the three "from the end"
  offsets by one. Forgetting either fails with a "duplicate column" in an unrelated test. `db.ts`
  needs none of it: a database at `RELEASED + n` is `SCHEMA` plus `MIGRATIONS.slice(0, n)`.
- Change: a helper in `db.test.ts`, `storeBefore(path, n)`: a raw `Database`, `SCHEMA` (exported
  from `db.ts` as a tests-only seam), `MIGRATIONS.slice(0, n)`, `user_version = RELEASED + n`. Tests
  name the migration under test by its index from the start (a constant beside the test) and insert
  their old-shape rows by SQL, as the tests at `:166` and `:222` already do for their cards. The
  drop lists and the two `before…` helpers go.
- Win: about 100 lines, and a new migration no longer edits other migrations' tests.
- Risk: medium: the first test (`:60-146`) stages its data through today's `Store` API and must be
  rewritten to insert rows in the released shape; its assertions stay and are the check.
- Confidence: high that the lists and offsets must be kept in step by hand (read `db.ts:716-730` and
  all four call sites); medium on the effort for the first test.

### T9. Two harnesses stage "a long-used canvas" and measure rounds against a rebuild of the canvas view
- Principle: DRY
- Size: moderate
- Where: `src/server/board-size.test.ts:16-73` (staging), `:80-89` (`rebuildTime`), `:140-153`;
  `src/server/long-history.test.ts:25-58` (`setup`), `:78-99` (`rebuild`, `inUnits`), `:117-124`;
  `src/server/fixtures/history.ts:32-119` (`writeHistory`).
- Now: both files make the same repository (same plan doc, same `demo.site` settings,
  `store.trustCommands`), start the same canvas (`{ name: 'App', repos: [{ path: repo, clones: 2 }]
  }`), attach the same listener (`board.onChange(() => JSON.stringify(board.snapshot()))`), and fill
  it with archived, shared and open cards: `board-size.test.ts` through `store.insert` and
  `store.update` with a demo directory per card (about 1,200 directories; its `beforeAll` has a 30 s
  timeout for it), `long-history.test.ts` through `writeHistory`'s SQL with eight shared demo
  directories. Both then express a round's cost in rebuilds of the canvas view, with two
  conventions: `rebuildTime` (median of five, on the big canvas) and `inUnits` (fastest of five,
  against a canvas without history). "Asking the site which shared pages are gone" is measured in
  both (`board-size.test.ts:140-153`, budget 8; `long-history.test.ts:117-124`, budget 10). What
  only `board-size.test.ts` has: ideas with prototypes, and its exact-read tests (`:155-228`).
- Why it matters: two stand-ins for the same subject pin the JSON of the `demo` and `share` columns
  twice and drift in what "a unit" means; a reader cannot tell which budget is the binding one.
- Change: `writeHistory` gains ideas with prototypes (an option), `board-size.test.ts` stages
  through it and takes `inUnits` (moved to `fixtures/history.ts` or `testing.ts` beside `cpuTime`);
  the duplicated "sites gone" measurement stays in one file. If the two files stay apart, at least
  the repository and canvas setup become one function in `fixtures/history.ts`.
- Win: about 60 lines of staging, one unit convention, 1,200 fewer directories written per run.
- Risk: medium: the budgets were tuned per harness and need re-measuring on the owner's machine and
  CI.
- Confidence: high for the overlap (both setups and helpers read); medium for the merge's effort.

### T10. Nine `settle`s, five local `until`s, six hand-written polling loops, and `flush`/`tick` beside `heard` and `until` in `testing.ts`
- Principle: DRY
- Size: moderate
- Where: `settle`: `work-retro.test.ts:38`, `wish.test.ts:6`, `usage.test.ts:73`,
  `commands.test.ts:14`, `answers.test.ts:45`, `revisions.test.ts:31` (all `setTimeout(r, 5)`),
  `canvas.test.ts:50-53` and `ideas.test.ts:37-41` (5 ms, then `workers.prepared()` of each
  repository; ideas also `freed()`), `coordinator.test.ts:45-52` (5 ms, then waits while the
  Coordinator judges, then `prepared()`); 378 `await settle()` calls. `until`:
  `share.test.ts:173-176` (112 calls), `self-update.test.ts:22-24`, `narration.test.ts:61-63`,
  `workers-evict.test.ts:12-15`, `plugin/skills/browser/lib/browser.test.ts:44-50`, against
  `testing.ts:356-359`. Inline loops: `awake.test.ts:84`, `folder-processes.test.ts:122`, `:128`,
  `commands.live.test.ts:317`, `:374`, `scripts/scratch-obeya.test.ts:186`. Zero-delay waits:
  `workers-fixture.ts:108` `flush` (34 calls) and `project-agents.test.ts:19` `tick`, against
  `testing.ts:303` `heard` (the same `sleep(0)`).
- Now: the local `until`s differ from the shared one in their timeout (10 s, 5 s, 100 x 50 ms, 400 x
  10 ms x PATIENCE, against 3 s x PATIENCE) and in that three of them (`self-update`, `narration`,
  `workers-evict`) return silently on timeout, so a failure shows later as a wrong assertion instead
  of "timed out after … ms: <condition>". Some positive expectations wait a fixed pause instead
  (`commands.test.ts:160`, `:210`: arm a command with `delayMs: 20`, sleep 40 ms, expect it
  executed; `workers.test.ts:735`, `:766`, `:788`: `limitMargin: 30`, sleep 60 ms, expect the worker
  woken).
- Why it matters: the comment at `testing.ts:275-279` says why fixed pauses fail on a loaded
  machine, and the suite runs a process per core. The speed cost is small (all fixed sleeps in
  `src/server` tests sum to about 16 s if each ran once, plus 378 x 5 ms, spread over parallel
  processes), so this is about one way of waiting and readable timeouts, not about time.
- Change: the local `until`s and inline loops use `until` from `testing.ts` (with a timeout where 3
  s x PATIENCE is too short). `flush` and `tick` go for `heard`. One bare `settle` in `testing.ts`
  for the six one-liners, one in the canvas fixture of T3 (pause, then `prepared()`),
  `coordinator.test.ts` keeps its own. A positive expectation after a fixed pause becomes `await
  until(() => …)`; a pause that shows nothing happens stays.
- Win: about 20 helper definitions and loops; uniform timeout messages.
- Risk: low; `share.test.ts`'s `until` asserts with `expect`, the shared one throws, both fail the
  test.
- Confidence: high; every definition read, the fixed-pause examples read in context.

### T11. `workspaces.test.ts`: four describes repeat the same 20-line setup and `commit` helper; the global git configuration is saved and restored in seven places
- Principle: DRY
- Size: moderate
- Where: `src/server/workspaces.test.ts:520-544`, `:606-631`, `:651-682`, `:706-733`; the
  `GIT_CONFIG_GLOBAL` save, set and restore also in `src/server/new-repo.test.ts:24-27,47-50`,
  `src/server/git-setup.test.ts` (its `globalGit`, restore at `:38`), `src/server/machine.test.ts`
  (around `:284`).
- Now: each of the four describes declares `globalConfig`, `origin`, `checkout`, `spaces`; a
  `beforeEach` that points `GIT_CONFIG_GLOBAL` at an empty file, makes `origin` with the same two
  files, clones it to `checkout`, identifies it and builds the same `Workspaces`; an `afterEach`
  that restores the variable; and the same three-line `commit`. They differ by one to five extra
  lines each (`receive.denyCurrentBranch`, a `contrib` branch, a second clone).
- Why it matters: about 80 duplicated lines in one file; the reason for the empty global
  configuration is given once (`:521`) and silently repeated three times.
- Change: one file-level `originAndCheckout()` (returns `{ origin, checkout, spaces }`) and the
  `commit` of T5 for the four describes (W2 did this part: one file-level `edit`), each adding its
  extra lines; and `ownGlobalGitConfig(text =
  '')` in `testing.ts`, which registers its own `beforeEach`/`afterEach`, for all seven places.
- Win: about 90 lines.
- Risk: low.
- Confidence: high for the four blocks (read side by side); the other three files' save and restore
  seen by rg only.

### T12. Three test files each bring their own static host and deploy stand-in for a demo site
- Principle: DRY
- Size: moderate
- Where: `src/server/share.test.ts:47-76`, `src/server/site.test.ts:24-71`,
  `src/server/personal-site.test.ts:23-44`; with them `siteDir`/`deployed`/`page`
  (`site.test.ts:85-86,115-129`, `personal-site.test.ts:50-52`) and "a video demo's directory"
  (`share.test.ts:161-166`, `site.test.ts:97-101`, `personal-site.test.ts:61-64`,
  `ideas.test.ts:923-929`, `tag-proposal.test.ts:45-47`).
- Now: each file has a `DEPLOY` script text whose core is "remove `<out>/deployed`, copy the site's
  directory there" and a `Bun.serve` that serves `<dir>/deployed` (decode the path, append
  `index.html`, refuse `..`, 404 otherwise). `site.test.ts` adds switches (`down`, `token`, `lag`,
  `race`, `fallback`, `pretty`), `share.test.ts` a call log and a `hold` file,
  `personal-site.test.ts` the `404.html`.
- Why it matters: the fake host is the tests' model of what Cloudflare and GitHub Pages do; three
  models drift (two of three answer a missing file with `404.html`).
- Change: `fakeSiteHost()` in `testing.ts`: starts the server once per file and returns `{ url, host
  /* the switches, off by default */, deployScript(extra?), deployed }`, with `site.test.ts`'s
  server as the one implementation; and `videoDemo(dir)` beside `artifact()` for the demo directory.
- Win: about 60 lines and two of three host models.
- Risk: low to medium: `share.test.ts`'s deploy records calls and waits on `hold`; the shared script
  has to take such extras as text.
- Confidence: medium; the three headers read, the files' bodies sampled.

### T13. Tests that will have to move with a cleanup of the production code
- Principle: KISS (a list for the cleanup agent; one change proposed)
- Size: moderate
- Where and what:
  - `src/server/sync-calls.test.ts:17-…` (`ALLOWED`): counts every `…Sync(` call per file of
    `src/server/` against a table keyed by file name, in both directions (more than allowed, fewer
    than listed). Moving a function with a synchronous call to another module, or merging two
    modules, fails it until the table is edited in the same change. Deliberate (see Justified).
  - `src/server/long-history.test.ts:131`, `:142`: call the private `commander['brief'](…)` and
    `coordinator['around'](…)`, the only bracket access to privates in the suite. A rename or a
    changed signature breaks them without the compiler's help.
  - `src/server/commands.test.ts:183`: `store.db.query("UPDATE commands SET due = …")`, the one test
    outside `db.test.ts`, `board.test.ts` and the two size tests that writes a table by name.
  - `src/ui/hooks.test.ts`: reads the `.tsx` sources as formatted (top-level `function`, two-space
    indentation); declaring components another way makes it blind without failing.
  - Staging through raw rows: `board.work(id, { state: 'live', demo: JSON.stringify({…}), share:
    JSON.stringify({…}), queue: …, shipped: …, session_id: … })` about 250 times (board.test 38,
    commands.test 37, share.test 22, snooze.test 18, server.test 17, canvas.test 15,
    commands.live.test 15, workers-landing.test 12) and `board.row(id).<column>` about 310 times
    (workers-worktrees.test 81, workers-landing.test 59, share.test 24, canvas.test 22). The
    columns' formats are stored data and stay anyway, but `Board.work` and `Board.row` are the two
    seams the tests lean on hardest: keep both names and shapes.
  - Direct construction: `new Workers({…})` 56 times, `new Workspaces(store, 'c', {…})` 35,
    `CanvasRuntime.start(…)` 72, `new Board(…)` about 50 (T2, T3, T6, T7 bring most of these behind
    helpers; do those first).
  - Prompt wording: about 550 assertions of the form `expect(session.inbox[0]).toContain('…')` or
    `spec.system).toContain('…')` (workers.test 88, ideas.test 69, answers.test 60,
    workers-demo.test 46, commands.test 45). They pin sentences of the prompts on purpose (prompts
    are behaviour for agents); a cleanup that merges or rewords prompt builders keeps the text byte
    for byte or edits these.
- Change: `long-history.test.ts` measures through what the commander and coordinator offer publicly,
  or the two methods become tests-only seams by name; `commands.test.ts:183` sets the due time
  through a seam of `Board`/`Store`. The rest: nothing to change, plan for it.
- Win: none in lines; no surprises during the cleanup.
- Risk: low.
- Confidence: high for the first four (read); counts by rg for the rest.

### T14. Finding a session by one of its tools is spelled out 65 times
- Principle: DRY
- Size: minor
- Where: `runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === '…')).at(-1)` and its
  `find` form: ideas.test 16, canvas.test 12, server.test 7, coordinator.test 7, commands.test 6,
  workers.test 5, revisions.test 3, config.test 3, work-retro.test 2, answers.test 2,
  tag-proposal.test 1, folder-canvas.test 1; named locally `explorer`, `answerer`, `reviser`,
  `estimates`, `schedules`, `noteSessions`, `retroSessions`, `proposer`, `isCoordinator`, `worker`.
- Now: tests tell the kinds of agent apart by a tool only that kind has (`act` 12 times, `scope` 9,
  `ready_for_review` 7, `update_brief` 6).
- Why it matters: which tool marks which kind of agent is knowledge about the production code,
  repeated per file; renaming a tool breaks the finders, not behaviour.
- Change: `FakeRuntime.withTool(name): FakeSession[]` in `testing.ts`; the local names stay as
  one-liners on it (`const explorer = () => runtime.withTool('update_brief').at(-1)!`).
- Win: 65 long expressions shortened.
- Risk: low.
- Confidence: high; rg counts.
- Done by W2: `FakeRuntime.withTool(name)`; `isCoordinator` in `answers.test.ts` and
  `revisions.test.ts` went with it.

### T15. Small helpers defined in several test files
- Principle: DRY
- Size: minor
- Where and what:
  - A silent WAV's 44-byte header: `src/server/testing.ts:540-556` (`silentWav`),
    `src/server/voice.live.test.ts:67-…` (the same function, under the same name),
    `src/server/config.test.ts:868-…` (`wav`, with a sample rate),
    `plugin/lib/playwright.test.ts:7-…`.
  - A `Map`-backed `Storage`: `src/ui/draft.test.ts:4-7`, `src/ui/keep.test.ts:4-7`,
    `src/ui/demoSeen.test.ts:5-8`, `src/ui/configDraft.test.ts:4-7`,
    `src/ui/sheetWidth.test.ts:4-7`, `src/ui/api.test.ts:48-…`, and inline in
    `src/ui/wish.test.ts:5`, `src/ui/setAside.test.ts:41`.
  - An `Item` for a test: `src/ui/archive.test.ts:5` and `src/ui/search.test.ts:5` (identical),
    `src/ui/forYou.test.ts:5`, `src/ui/deps.test.ts:5`, `src/ui/setAside.test.ts:5`,
    `src/core/types.test.ts:4`.
  - The code of a refused action: `src/server/canvas.test.ts:63-69`,
    `src/server/new-repo.test.ts:55-61`, `src/server/board.test.ts:889-896`.
  - `tag = (c) => cardTag(c.number)`: `commands.test.ts:16`, `coordinator.test.ts:56`,
    `work-retro.test.ts:40`. `ws(key)`: `board.test.ts:12`, `workers-fixture.ts:19`. `bytes(n,
    seed)`: `folder.test.ts:13`, `folder-canvas.test.ts:15`. `state(id)`:
    `pr-watcher.test.ts:75-78`, `workers-fixture.ts:104-107` (identical).
  - In one file: `sharing.share(c.id); await until(() => share(c.id)?.state === 'shared');` 30 times
    in `src/server/share.test.ts`, which has a `shared(id, …)` helper for it in one describe only;
    and `console.error` captured by hand at `src/server/canvas.test.ts:463-475`, though the file has
    `quiet()` (`:55-60`) for it and uses it in the test before (`:438-446`).
  - `src/server/work-retro.test.ts:25-35` builds a repository, `Workspaces` and `Workers` for nine
    tests; only the last (`:238-257`) uses them.
- Change: `silentWav(seconds, rate = 16000)` in `testing.ts` for the three server and plugin users;
  a `src/ui/testing.ts` with `memoryStorage()` and `testItem(over)`; `refusal(act)` in `testing.ts`;
  `tag` beside `cardTag`'s tests or in `testing.ts`; the workers of `work-retro.test.ts` into the
  one test.
- Win: about 20 small definitions.
- Risk: low.
- Confidence: high; each pair read (the UI storages and item builders by their first lines).

### T16. Leftovers in the shared test infrastructure
- Principle: KISS
- Size: minor
- Where: `src/server/testing.ts:275-279`; `src/server/test-setup.ts:17-24` against
  `src/server/testing.ts:347-354`; `src/server/fixtures/fake-codex.ts:7-17` against `:131`;
  `src/server/workers-landing.test.ts:227-232`.
- Now: (a) the doc comment "Waits until `done` holds. A request reaches the server only after a
  round trip …" stands above `asOwner`'s own doc comment, 80 lines from `until` (`:356`), which has
  none. (b) `alive(pid)` exists twice with different answers for `EPERM` (test-setup: alive;
  testing.ts: not). (c) the fake Codex's header lists the words it plays, but not `costly`, which it
  plays at `:131`. (d) a helper named `handedOver` only starts the card; the tests that use it hand
  over themselves.
- Change: the comment moves to `until`; `test-setup.ts` imports the one `alive`, with one answer for
  `EPERM` (a process one may not signal runs); `costly` goes into the header; the helper is renamed
  or goes with T1 (W2 renamed it `started`).
- Win: four small inconsistencies.
- Risk: low.
- Confidence: high; all read.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/sync-calls.test.ts:17` the per-file table of allowed synchronous calls: a recorded
  decision (`docs/design/running-obeya.md:900-912`, "counted against a list with reasons", a lint
  rule rejected).
- `src/server/long-history.test.ts:21` a history of 1.6 million events written in `beforeAll`
  (timeout 300 s): the measured case of `docs/design/running-obeya.md:779`; `fixtures/history.ts`
  writes it by SQL in a few statements.
- `src/server/workers-fixture.ts:22-43` mutable exported bindings with setters: the workers tests
  were split so `bun test --parallel` runs them side by side and still share one setup (its header
  says so).
- `src/server/testing.ts:86-160` template repositories and `gitClone`'s copy of a clone: what keeps
  git calls out of the tests' setup; `src/server/testing.test.ts` covers it.
- `src/server/testing.ts:207-268` `bunProgram`/`fakeProgram` with a compiled launcher on Windows:
  needed there, where only an `.exe` starts that way.
- `src/ui/hooks.test.ts`, `src/ui/styles.test.ts` tests that scan sources: the repository has no
  linter (same reasoning as the synchronous calls).
- `plugin/skills/browser/lib/browser.test.ts:44` its own `until`, and `plugin/lib/chromium.test.ts`
  its own `alive`: the plugin's tests take little from the server's `testing.ts`; fine either way.
- `scripts/gh.test.ts:19`, `scripts/hero-video/publish.test.ts:26-42` hand-written `#!/bin/sh`
  stand-ins with `skipIf(win32)` instead of `fakeProgram`: scripts only the owner runs.
- Fixed pauses that show nothing happens (`workers.test.ts:818`, `commands.test.ts` after an undo):
  a negative has no condition to wait for.

## Bugs noticed in passing
None left: the ones found here were fixed (2026-11-10).
