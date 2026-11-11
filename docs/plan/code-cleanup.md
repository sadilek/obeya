# Code cleanup: YAGNI, DRY, KISS

> Plan doc for honing the code after a review of the whole repository for code nothing needs
> (YAGNI), knowledge written in more than one place (DRY) and more machinery than the job needs
> (KISS). The review changed no code. Its 246 findings are in the files under
> [`code-cleanup/`](code-cleanup/), one per area; this doc orders them into workstreams. Deleted
> when its last workstream ships, together with the findings files. It leaves nothing for the design
> chapters, because a cleanup changes no behaviour.

## Goal

The code reads as if an exceptional engineering team had written and honed it: simple, not
over-engineered, each piece of knowledge in one place, redundancy only where it has a reason. No
workstream changes what the owner, the agents or a repository see of Obeya.

## Where it stands

W1 to W9, W13 to W18, W20 to W22, W24 and W25 are done; the other workstreams are open. The review, made on
2026-11-10 at commit `acfa0484`, found the code in better shape than its size suggests, and found
its debt in a few recurring forms.

What is already good, and stays out of the workstreams:

- Literal copy-paste is rare. A clone detector finds 0.45 % duplicated lines in 104,000 lines of
  source.
- Dead code is rare. Of some 2,100 exports, two are used nowhere; 21 of the 246 findings are YAGNI.
- The interfaces that matter are small and honest. Both harnesses fill almost all of the runtime
  interface, every forge member is called and implemented, every `CardAction` is sent and handled,
  and the two string tables cannot differ in shape.
- No database migration is dead. Each can still meet a user's database.
- Each findings file lists, under "Justified", what looks redundant or complex and has a reason
  (149 entries). Those were checked and are not to be "cleaned up".

Where the debt is (156 findings are DRY, 69 KISS):

- **Files and functions that hold several subjects.** `workers.ts` (one class of 4,860 lines),
  `board.ts`, `canvas.ts`, `workspaces.ts`, `runtime.ts`, `server.ts` (`serve()` is one function of
  1,120 lines with 17 positional parameters), `types.ts` (89 functions and constants beside the
  types), `App.tsx` (`Canvas` is one component of 2,045 lines with about 120 hooks), `detail.tsx`,
  `phone.tsx`, `director.ts`, `scratch-obeya.ts`. 12 of the 19 major findings are of this kind, and
  most of them are solved by moving code along seams the findings name, without touching control
  flow.
- **One small mechanism written out by hand at each use.** A value with listeners (eight classes on
  the server, twelve stores and listener sets in the UI), a value the browser remembers (about
  twenty times), running git (seven modules built their own runner), a card row's JSON columns
  (about ninety casts), "load, call, show the error" in the settings sheets (about twenty times), a
  promise raced against a timer (seven times), stores "kept a while, asked once" (seven times).
- **One rule stated on both sides of a boundary.** The pause protocol in three kinds of agent, the
  open card's plumbing on the desktop page and on the phone, the archive's rule in core, UI and
  board, log lines recognised by typed copies of their words, a repository's settings listed field
  by field in seven places, the WebVTT cue parser in the plugin and in the server.
- **Tests that rebuild their setup.** There is a fixture for workers and none for a canvas, so
  `CanvasRuntime.start` is written out at 72 sites in 16 files, and about 85 tests build repository,
  clone, board and workers twice because the fixture cannot be told its adapter.

## How the review was made, and its limits

- Fourteen reviewers each read one area completely (the areas are the findings files below), with
  a clone detector's list and a list of unused exports as leads. Each verified its claims by
  grepping the whole repository for callers and by reading both sides of a duplicate.
- For this doc, about forty claims were checked a second time against the code: the sizes, counts
  and callers the 19 major findings rest on, and the removals a grep can check. All held, apart
  from two counts that differ by one or two. The other findings stand on their reviewer's own
  checks, which each finding names under "Confidence".
- The tests were not read completely. Their reviewer read the shared infrastructure, every setup
  block and helper of the twelve largest test files and about 2,600 of their 17,000 lines of test
  bodies, and compared the rest mechanically. Scenarios restated inside unread test bodies may be
  missing.
- The second review by Codex that this repository asks for was stopped, at the owner's request,
  before it produced results. The findings are therefore one model's reading.
- Nothing was run. No proposed change was tried, compiled or tested.

## How to work from this

For the agent that takes a workstream:

1. Read the findings named in the workstream in their file. Each gives where the code is, what it
   does now, why that costs, the proposed change, the win, the risk with the tests that protect it,
   and how sure the reviewer was and what they checked.
2. A finding is a lead, not an order. Line numbers are those of commit `acfa0484` and will have
   moved; find the code by the names the finding gives. Read the code again, confirm the claim
   (grep for callers before removing anything, read both sides of a duplicate), and drop or reshape
   a finding the code no longer supports or whose change would not make the code simpler. Say in
   the handover which findings were done, changed or dropped, and why.
3. Behaviour stays as it is: what the owner sees, what agents are told and can call, the settings
   format, the files Obeya writes, the data in existing databases and in the browser's storage
   (keys and formats). A cleanup that needs a behaviour change is a separate card.
4. Move code before changing it. Where a finding splits a file, land the pure move first (no
   function body changed) and the reshaping after it, so each diff can be checked by eye.
5. The tests stay green without being weakened. Some tests pin internals and have to move with the
   code; [`code-cleanup/tests.md`](code-cleanup/tests.md) T13 lists them (`sync-calls.test.ts`
   keeps a per-file table of synchronous calls, `long-history.test.ts` calls private methods,
   about 550 assertions pin prompt sentences).
6. UI workstreams have little test cover (no test renders `Canvas`, `Detail` or the phone view).
   Check them in a browser against a scratch Obeya: each card kind, the phone view, and a reload
   with unsent input on a card.
7. Do not turn a finding into new machinery. The shared piece a finding proposes is usually a
   function of a few lines. If the helper would be more complex than the copies it replaces, leave
   the copies.
8. Tick the workstream in this doc when it has landed, and delete a findings file when every
   finding in it is done or dropped. The bugs the review noticed in passing are fixed; a finding
   whose code held one says so, and a "Bugs noticed in passing" list keeps only what a finding
   here takes care of.

Workstreams that touch the same files should not run at the same time. W7, W8, W9 and W10 share
`board.ts`; W10, W11 and W12 share `workers.ts`; W14 and W15 share `canvas.ts` and `commands.ts`;
W20 to W23 share the UI's large files. W2 and W3 make the later server workstreams cheaper, since
they put most direct constructions of `Board`, `Workers` and `CanvasRuntime` in tests behind
helpers.

## The same finding in more than one file

Reviewers of neighbouring areas met the same thing from both sides. Each row is one piece of work;
the workstream named does it for all of them.

| What | Findings | Workstream |
| --- | --- | --- |
| The open card's plumbing on the desktop page and on the phone | G3, H1 | W21 |
| The pause protocol, written per kind of agent | B3, C5 | W10 |
| A value with listeners, hand-written per holder | B5, F6 (server), I2 (UI) | W6, W20 |
| A card row's JSON columns cast by hand | C2, A7 | W7 |
| Running git, wrapped locally per module | E2, F19 | W5 |
| The click-away closer beside `useMenuClose` | G10, I3, H10 | W20 |
| Log lines recognised by typed copies of their words | J3, H7 | W19 |
| The WebVTT cue parser, and chapter parsers | S11, P4, R12 | W17 |
| Core's text helpers written out at call sites | J5, D13, B14 | W6 |
| "A time within the coming year" | A15, D12 | W6 |
| A promise raced against a timer | B9, D15 | W6 |
| A repository's settings listed field by field | F5, J6 | W16 |
| How long a confirmation and its "Undo" show | I8, J9 | W19 |
| "Does this process run" | B18, P12, R5 | W6, W24, W25 |
| Doc comments above the wrong declaration | A17, B21, C18, F13, J8, S22 | W1 |

## Workstreams

- [x] **W1:** Dead code and stray comments. Remove what nothing uses and move doc comments back to
  what they describe: [workers](code-cleanup/workers.md) A17; [runtimes](code-cleanup/runtimes.md)
  B11, B12, B17, B21; [board-db](code-cleanup/board-db.md) C10, C11, C16, C17, C18;
  workspaces-git-hosts E13;
  http-config F13, F14, F15;
  share-site-demo S16, S17, S22; [ui-card](code-cleanup/ui-card.md)
  G20; [ui-panels](code-cleanup/ui-panels.md) H13; [ui-small-modules](code-cleanup/ui-small-modules.md)
  I11; [core](code-cleanup/core.md) J8, J10; plugin P15;
  scripts-app R8, R10; [tests](code-cleanup/tests.md) T16. C11 and
  F15 have medium confidence: trace them before removing.
- [x] **W2:** A workers test fixture that covers the common setups. [tests](code-cleanup/tests.md)
  T1 (one `handedOver()`), T2 (the fixture takes its adapter, so no test builds everything twice),
  T5 (one "write a file and commit it"), T7 (changing one option of `Workers`), T14 (finding a
  session by its tool).
- [x] **W3:** A canvas test fixture. [tests](code-cleanup/tests.md) T3 (one harness for a
  one-repository canvas instead of 72 hand-written starts), T4 (`canvas.test.ts` starts only the
  canvas a test uses), T6 (the test canvas literal and `new Board(…)` behind a helper), and what is
  left of T1: the handover helpers of the canvas-level tests.
- [x] **W4:** The rest of the test infrastructure. [tests](code-cleanup/tests.md) T8 (old databases
  for migration tests), T9 (one harness for a long-used canvas), T10 (one `settle` and one `until`),
  T11 (`workspaces.test.ts` setup), T12 (one stand-in for a demo site's host), T15.
- [x] **W5:** One git module. workspaces-git-hosts E2 with
  http-config F19 (a `git.ts` every module runs git through), E1 (the
  synchronous twins go, then the generator protocol), E4 (synchronous git over SSH; rewrite the
  sentence in `docs/design/agents-and-workspaces.md` in the same change), E5 (`workspaces.ts` as
  three modules), E3 (one parser for a remote URL), E6 ("is A an ancestor of B"), E8, E14. Update
  `sync-calls.test.ts` with it.
- [x] **W6:** Small shared server helpers, each written once. A value with listeners
  ([runtimes](code-cleanup/runtimes.md) B5, http-config F6); kept a
  while and asked once (B6, workspaces-git-hosts E9, E10); a
  promise against a timer (B9, canvas-coordinator D15); "does
  this pid run" (B18); core's text helpers at their call sites ([core](code-cleanup/core.md) J5,
  D13, B14); a time within the coming year ([workers](code-cleanup/workers.md) A15, D12); text
  limits and two small registries ([board-db](code-cleanup/board-db.md) C15, C19); "answer first,
  then go" (F11).
- [x] **W7:** A card's row and its events typed in one place. [board-db](code-cleanup/board-db.md)
  C2 with [workers](code-cleanup/workers.md) A7 (one typed reader per JSON column), C4 (an event's
  optional fields), C6 (a proposal's stored JSON), C7 (optional arguments by name), C8, C9, C12,
  C13, C14.
- [x] **W8:** The sheet as an object of its own. [board-db](code-cleanup/board-db.md) C1: `Board`
  stops repeating 36 `Store` methods; a canvas-scoped `Sheet` holds the talk and history API once.
- [x] **W9:** `board.ts` holds the board. [board-db](code-cleanup/board-db.md) C3 (the notice of
  outdated pages, the archive's paging and search index and the plan-doc follower move to modules
  of their own) and [core](code-cleanup/core.md) J2 (the archive's rule stated once). After W7 and
  W8. `board.ts` keeps the cards and their transitions (2,397 lines); `items.ts`, `shared-pages.ts`
  (`PageNotice`), `archive.ts` (`Archive`), `plan-follow.ts` (`PlanFollower`) and `plan-ref.ts` hold
  the rest; what came of each finding stands under it.
- [ ] **W10:** The pause protocol once for every kind of agent. [runtimes](code-cleanup/runtimes.md)
  B3 with [board-db](code-cleanup/board-db.md) C5: the four transitions and their log lines are
  written in `workers.ts`, `answers.ts` and `explorers.ts`, against the house rule on interactions
  that card kinds share.
- [ ] **W11:** `workers.ts` split along its seams, by moves only. [workers](code-cleanup/workers.md)
  A1 (texts, briefings, the card's app, review cards and the tools leave the `Workers` class behind
  its unchanged public API), with [runtimes](code-cleanup/runtimes.md) B4 and B20 (workers' own
  copies of `BackgroundWait` and of the limit-lift timer). After W2 and W7.
- [ ] **W12:** The long functions of the workers. [workers](code-cleanup/workers.md) A2
  (`ready_for_review` as one linear method, with A19), A3 (`turnEnded` with its conditions named once), A4
  (the three endings of a card's work), A5 and A6 (the owner's words as one value), A8, A9 (the
  per-card timer maps), A10, A11, A12, A13, A14, A16, A18. After W11.
- [x] **W13:** The runtimes. [runtimes](code-cleanup/runtimes.md) B1 (`runtime.ts` keeps the
  contract; the Claude Code runtime moves to a `claude.ts` beside `codex.ts`, the shell reader to
  `shell.ts`), B2 (one idle Claude Code session), B7, B8, B10, B13, B15, B16, B19.
- [x] **W14:** `canvas.ts` and `coordinator.ts` by subject.
  canvas-coordinator D1 (configuration, the set of canvases,
  the repository lifecycle and the owner's card actions as modules), D2 (the learner out of the
  coordinator, `readSession` to the runtime), D5, D6, D9, D10, D11. After W3.
- [x] **W15:** The commands. canvas-coordinator D3
  (`Commander.command()` with a method per action instead of one chain of 240 lines), D4 (the notice
  for a late reply and the open-card check once), D7, D8, D14, D16. Its findings file is gone, every
  finding in it done.
- [x] **W16:** The HTTP server and the configuration. http-config F1
  (`serve()` split into the pages' fan-out, the voice pipeline and route groups), F2 (`serve(served,
  port, deps)` instead of 17 positional parameters), F3 (the demo-settings dialog out of `Config`),
  F4 (`Restarter` tracks its reason once), F5 with [core](code-cleanup/core.md) J6 (a repository's
  settings listed once), F7, F8, F9, F10, F12, F16, F17, F18.
- [x] **W17:** Sharing, demo sites and demo pages. share-site-demo S1 (the page templates share
  their fragments and scripts), S2 (`share.ts` and `site.ts` no longer import each other), S3, S4,
  S5 (module seams), S6 to S10, S12 to S15, S18 to S21, and one WebVTT cue parser beside the writer
  (S11, plugin P4, scripts-app R12). Its
  findings file is gone: the second step of S13 (the demo's facts read asynchronously at the
  handover) went to [workers](code-cleanup/workers.md) A19, for W12; of S21, the two `exists`
  one-liners (`site.ts`, `demo-space.ts`) stayed, as a shared home for them would be a module of its
  own.
- [x] **W18:** Forges, the PR watcher, hosts and folders.
  workspaces-git-hosts E7 (`PrWatcher.react` by job), E11
  (rules about PR comments above the forge interface), E12, E15, E16, E17. After W5.
- [ ] **W19:** `src/core`. [core](code-cleanup/core.md) J1 (`types.ts` keeps the shapes; the
  agents-and-models block, the configuration block and the card predicates become modules, and
  functions one side alone uses move to that side), J3 with [ui-panels](code-cleanup/ui-panels.md)
  H7 (log lines recognised from the message table), J4 (button labels single-sourced), J7, J9 with
  [ui-small-modules](code-cleanup/ui-small-modules.md) I8, J11. It changes imports across the
  repository, so run it while few other workstreams are open.
- [x] **W20:** The UI's shared mechanisms. [ui-small-modules](code-cleanup/ui-small-modules.md) I1 (a
  value the browser remembers), I2 (a module store with listeners), I4, I5, I6, I7, I9, I10, I12,
  I13, I14; [ui-card](code-cleanup/ui-card.md) G8 (`parts.tsx` by subject), G10 with I3 and
  [ui-panels](code-cleanup/ui-panels.md) H10 (one click-away closer), G11 (first-use flags), G17.
  Storage keys and formats stay as they are.
- [x] **W21:** The app shell and the phone. [ui-card](code-cleanup/ui-card.md) G1 (`Canvas` in the
  six extraction steps the finding names), G9, G12, G13, G21; G3 with
  [ui-panels](code-cleanup/ui-panels.md) H1 (the open card's plumbing shared by desktop and phone);
  H3 (`Phone()` by job), H15, H16, H17. After W20.
- [x] **W22:** The card. [ui-card](code-cleanup/ui-card.md) G2 (`Detail` as a dispatcher with a view
  per card kind), G4 (the card's diff read once), G5 (head, state line and text block shared by the
  kinds), G6 (the log followed once), G7 (`DemoView`), G14, G15, G16, G18, G19, G22. After W20.
  `detail.tsx` went by subject first, as moves (`cardSheet.tsx`, `conversation.tsx`, `demo.tsx`,
  `share.tsx`, `pr.tsx`, `review.tsx`, `idea.tsx`); what came of each finding stands under it.
- [ ] **W23:** The settings sheets and panels. [ui-panels](code-cleanup/ui-panels.md) H2 (`useAct`
  promoted and a `useLoaded` for "load, call, show the error"), H4 (the canvases as one array of
  rows), H5 (one segmented control), H6, H8, H9, H11, H12, H14, H18, H19, H20, H21, H22. After W20.
- [x] **W24:** The plugin. plugin P1 (`director.ts` as scene API, screencast, encoding and
  report, so `revoice.ts` no longer loads Playwright), P2 (the demo `SKILL.md` without what the
  scripts print when it applies), P3 (one CDP client in `browser.ts`), P5 to P14. Its findings file
  is gone. `director.ts` became four modules (`director.ts`, `assemble.ts`, `narration.ts`,
  `screencast.ts`), with the settings computed by `runDemo` and the stillness watch an object
  created once the app is staged; a failing `login` therefore names no "likely cause" any more,
  where it used to report the time since the module loaded as standing still. `plugin/lib/process.ts`
  holds `alive`, `isMain` and `holdPidLock`, for W25's copies in `scripts` and `src/server` too.
  Of P9, the shared `print` stayed two one-liners (the command indents, the step does not); of
  P13, the UI keeps its own `captions.<language>.vtt`, since `subtitles.ts` reads files and the
  UI cannot import it. P8 dropped `qwen3.py`'s `--out`; `scripts/check-voice.ts` speaks every voice
  through `tts.py --sample`.
- [x] **W25:** The scripts and the desktop app. scripts-app R1 (`scratch-obeya.ts` keeps the
  command line; `scripts/scratch/process.ts` the processes and ports, `scripts/scratch/stage.ts` the
  staging in named steps, with every stage field described at its declaration), R2 (`parseArgs`
  through `script(name).args` in `common.ts`), R3 (`scripts/targets.ts`), R4, R5 (`script(name)`
  gives `fail`, `args`, `run` and `retry`; `git`, `writeFiles`, `alive` beside them), R6, R7, R9,
  R11, R13 (the owner agreed: `qwen.py` went, `render.ts --qwen` stays for iterating), R14 (Bun
  pinned in `.bun-version`). Its findings file is gone. Staged from one stage file, the old and the
  new scratch script wrote the same database. Kept apart: `render.ts` reads its own arguments (a
  value after `--record` or `--replay` is optional, which `parseArgs` cannot say), `check-app.ts`
  its own `parseArgs` (it exits 2 with its usage); `ownerApi` went beside `ownerHeaders` in
  `src/server/owner.ts`, since `common.ts` must load under Node; `check-update.ts` keeps its fetch
  (a refusal is null there), and the hero video and `site-shots.ts` their single requests. R4's
  `started()` was not needed: `check-binary.ts` calls `waitUp` itself. The shell's `request()`
  follows no redirect and sends an empty POST with `Content-Length: 0`, as the hand-written client
  did; it was compiled, not run, since the app opens windows.

## Findings by area

| File | Area | Findings | Major | Moderate | Minor |
| --- | --- | ---: | ---: | ---: | ---: |
| [workers.md](code-cleanup/workers.md) | A: `workers.ts` and its small neighbours | 18 | 1 | 7 | 10 |
| [runtimes.md](code-cleanup/runtimes.md) | B: the agent runtimes | 21 | 1 | 5 | 15 |
| [board-db.md](code-cleanup/board-db.md) | C: board and database | 19 | 3 | 4 | 12 |
| canvas-coordinator.md (done, deleted) | D: canvas, commands, coordinator | 16 | 1 | 3 | 12 |
| workspaces-git-hosts.md (all done, deleted) | E: workspaces, git, forges, hosts | 17 | 3 | 5 | 9 |
| http-config.md (all done, deleted) | F: HTTP server, startup, configuration | 19 | 1 | 4 | 14 |
| share-site-demo.md (done, deleted) | S: sharing, demo sites, demo pages | 22 | 0 | 5 | 17 |
| [ui-card.md](code-cleanup/ui-card.md) | G: the app shell and the card | 22 | 2 | 7 | 13 |
| [ui-panels.md](code-cleanup/ui-panels.md) | H: panels and the phone | 22 | 1 | 7 | 14 |
| [ui-small-modules.md](code-cleanup/ui-small-modules.md) | I: small UI modules, API client, strings, styles | 14 | 0 | 2 | 12 |
| [core.md](code-cleanup/core.md) | J: `src/core` | 11 | 1 | 4 | 6 |
| plugin.md (done, deleted) | P: the plugin | 15 | 1 | 3 | 11 |
| scripts-app.md (done, deleted) | R: scripts and the desktop app | 14 | 1 | 4 | 9 |
| [tests.md](code-cleanup/tests.md) | T: the tests | 16 | 3 | 10 | 3 |
| | | 246 | 19 | 70 | 157 |

A major finding reshapes a module or removes a concept; a minor one is a local tidy-up. By
principle: 156 DRY, 69 KISS, 21 YAGNI. By the reviewers' own rating, the proposed change is low
risk for about 200 findings and medium or high for about 45, mostly the module splits and the UI
components without test cover.
