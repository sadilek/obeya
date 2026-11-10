# Bugs noticed in passing during the code review

> Plan doc for fixing the 41 bugs the YAGNI, DRY and KISS review found on the side. They are listed
> under "Bugs noticed in passing" at the end of each findings file of the
> [code cleanup](code-cleanup.md) (in [`code-cleanup/`](code-cleanup/)), which leaves them out
> because its rule 3 forbids any change of behaviour. Deleted when its last workstream ships. A fix
> that changes what a design chapter describes updates that chapter in the same change; nothing
> else moves into the design.

## Goal

Each of the 41 bugs is fixed, or found not to be one, or left as it is on purpose, and the
handovers of the three workstreams together say which for every one of them. A fix comes with a
test that fails without it.

## Where it stands

W1 is done: each of its bugs was reproduced in a test that failed before its fix, except the
comment points, the test hygiene (measured instead: the server's test files leave no canvas and no
workers running) and `replay.ts`'s reading of a failing `merge-base`, which kept its outcome (a
rewritten head) and now says so. The bare `git` in `forge.ts` and `site.ts` stays for code cleanup
W5 (E2). The fixed ones are gone from the findings files' lists, and the findings that name them say
so. W2 and W3 are open; their bugs were read from the code alone, at commit `acfa0484` (2026-11-10),
and some may turn out to be none; their line numbers still hold or are off by a few (`api.ts` and
`scratch-obeya.ts` changed by a few lines at commit `3321cd6e`).

The 41 lie in 14 findings files. 31 change behaviour; 10 concern only a comment or style (a doc
comment above the wrong declaration, a constant between the imports, a bare `git`).

## How to work from this

For the agent that takes a workstream:

1. Read each bug in its findings file, and the finding it refers to ("see D12") where it names one.
   Find the code by the names given; line numbers may have moved.
2. Test first. Write a test that fails on the code as it is, then fix the code until it passes.
   What cannot be reproduced in a test (or turns out to work) stays as it is and is named in the
   handover as "not confirmed", with what was tried.
3. Comment and style points need no test. Fix them in one commit of their own, unless a workstream
   of the code cleanup reworks that place anyway: then leave them and name them in the handover as
   "left on purpose, done by code cleanup Wx".
4. The handover sorts every bug of the workstream into fixed, not confirmed, or left on purpose,
   with a sentence each.
5. When the workstream lands, remove each fixed bug from its "Bugs noticed in passing" list, and
   where a finding of the code cleanup names that bug (the table below), add a line to the finding
   that the bug is fixed, so the cleanup does not plan around it any more.
6. Codex reviews the workstream's code as a second reviewer (`codex exec`) before the handover.

The three workstreams share no files. They can run at the same time, and each lands on its own.

## Order with the code cleanup

Several bugs sit in code that a workstream of the code cleanup reworks. Since that plan may not
change behaviour, its workstream would either have to keep the bug or would fix it without a test.
So the cleanup workstreams named here start only once the workstream of this plan that fixes the
bug has landed; [code-cleanup.md](code-cleanup.md) says so as well.

| Bug | Finding | Cleanup workstream | Fixed in |
| --- | --- | --- | --- |
| `shutdown` leaves `holding` and `pushingMain`; `generation`, `tried`, `granted` never shrink | A9, A10 | W12 | W1 |
| A failing `merge-base --is-ancestor` counts as "not an ancestor" | E6 | W5 | W1 |
| `unlanded`'s unbatched pathspecs | E8 | W5 | W1 |
| `snooze` accepts a time more than a year ahead | D12 | W6 | W1 |
| `rebuilt` without the 100 ms delay | F11 | W6 | W1 |
| A `null` body gives 500 | F9 | W16 | W1 |
| `changesCode` reads git's quoted file names | F16 | W16 | W1 |
| Rows of `shared_changes`/`archive_changes` never dropped | C9 | W7 | W1 |
| `commandWords` splits a quote inside a word | S9 | W17 | W1 |
| Archiving a planned task with a branch | J2 | W9 | W1 |
| The test teardowns (canvases, workers, `freed()`) | T2, T3, T4, T7 | W2, W3 | W1 |
| `useCopy` only through `navigator.clipboard` | G17 | W20 | W2 |
| The minimap's colour | G8 (moves the minimap) | W20 | W2 |
| `showAck` hides before the undo window ends | I8 | W19 | W2 |
| `openAddress` opens the archive beside the search | G21 | W21 | W2 |
| The phone ignores `movedTo` | G3, H1 | W21 | W2 |
| `fileTo` writes to the canvas shown after the upload | H9 | W23 | W2 |
| `build.ts`, `check-app.ts`, `--say`/`--artifact` read their arguments wrong | R2 | W25 | W3 |
| `director.ts` imports Playwright statically | P1 | W24 | W3 |
| `runInput` has no timeout | P3 | W24 | W3 |
| `tts.py --sample` does not catch `QuotaExhausted` | P7 | W24 | W3 |

Cleanup workstreams not in the table (W1, W4, W8, W10, W11, W13, W14, W15, W18, W22) need not
wait. Those that move code in a file a workstream here changes (W11 in `workers.ts`, W14 in
`canvas.ts`) only meet merge conflicts, no conflict of behaviour.

## Workstreams

- [x] **W1:** The server, with test hygiene. The bugs in `src/server`, in
  [workers](code-cleanup/workers.md), [workspaces-git-hosts](code-cleanup/workspaces-git-hosts.md),
  [runtimes](code-cleanup/runtimes.md), [canvas-coordinator](code-cleanup/canvas-coordinator.md),
  [http-config](code-cleanup/http-config.md), [board-db](code-cleanup/board-db.md),
  [share-site-demo](code-cleanup/share-site-demo.md), [core](code-cleanup/core.md) and
  [tests](code-cleanup/tests.md), 23 in all:
  - `workers.ts` `shutdown` clears neither `holding` nor `pushingMain`, so after `stopRepo` the old
    instance can still start a session or push main; `generation`, `tried` and `granted` are never
    deleted.
  - `workers.ts` and `replay.ts` read any failure of `git merge-base --is-ancestor` (an unknown
    commit, a broken repository) as "not an ancestor". Each caller decides what "cannot tell"
    means for it; the test makes git fail.
  - `replay.ts` leaves the temp directory for `change.patch` behind on its failure paths.
  - `commands.ts` `snooze` accepts a time more than a year ahead, which `canvas.ts` refuses only
    after the owner heard the confirmation.
  - `push.ts` stamps a message with `Date.now()` instead of the class's clock.
  - `server.ts`: a body that is the JSON literal `null` gives 500 where the neighbouring routes
    answer 400; `/api/app-update` with `rebuilt: true` goes without the 100 ms delay that lets its
    answer out first.
  - `self-update.ts` `changesCode` reads file names in git's quoting, so a docs-only commit that
    touches a non-ASCII file name restarts Obeya.
  - `revisions.ts` throws a German literal that reaches the owner whatever the interface language;
    it becomes a message of the two tables in `src/core/messages.ts`.
  - `db.ts`: rows of `shared_changes` and `archive_changes` of a canvas never opened again are
    never dropped.
  - `share.ts`: `commandWords` splits `--message="a b"` at the space and keeps the quotes. A page of
    a tagging batch that the owner tagged while the session ran gets "not shared: no tags"; fixed
    only if a test can reproduce it.
  - `workspaces.ts` `unlanded` puts up to 1,000 pathspecs on one command line, longer than Windows
    takes, and reads the failure as "not landed". The test checks that each command line stays
    under 24,000 characters; it cannot run on Windows itself.
  - `board.ts`: archiving takes a planned task with a branch but no session (`unstarted`) as a
    stopped one, which the UI's `stopped` excludes. First check whether a direct request can reach
    that case past the other checks; if so, the server refuses it as the UI does.
  - Test hygiene, the three points of [tests](code-cleanup/tests.md): the canvas `canvas.test.ts`
    starts in `beforeEach` and then overwrites, the fixture's `afterEach` without
    `workers.shutdown()`, and the harnesses that remove the directory without awaiting `freed()`.
    No test fails before; the evidence is that the suite leaves no timers or canvases running
    afterwards.
  - Comments, in one commit: the doc comments of `press` (`canvas.ts`), `tagOf` (`coordinator.ts`)
    and `redeem` (`remote.ts`) above their declarations, and the constant between the imports of
    `pr-watcher.ts`. The bare `git` in `forge.ts` and `site.ts` stays for code cleanup W5 (E2).
- [x] **W2:** The interface. The bugs in `src/ui`, in [ui-card](code-cleanup/ui-card.md),
  [ui-panels](code-cleanup/ui-panels.md) and [ui-small-modules](code-cleanup/ui-small-modules.md),
  8 in all. No test renders `Canvas`, `Detail` or the phone view, so each fix is also checked in a
  browser against a scratch Obeya:
  - `shots.tsx` `fileTo` writes the path and the upload count to whatever canvas is shown once the
    upload is done; it pins the draft's canvas as `attachTo` does.
  - `copy.ts` `useCopy` writes only through `navigator.clipboard`, so "Copy path", the share
    link's "Copy" and the setup's copy buttons do nothing on an insecure origin; they copy as
    `copyOrSelect` does.
  - `tell.tsx` `showAck` hides the line after 7 s even when the undo window is 8 s.
  - `App.tsx` `openAddress` opens the archive list without closing an open search.
  - `parts.tsx`: the minimap colours a card by `shownState`, like the card's sheet and the marks
    of a collapsed project.
  - `phone.tsx` follows an open card that moves to another canvas (`movedTo`), as the desktop
    does; `wish` stays ignored there, since the phone has no wish dialog.
  - Comments, in one commit: the orphaned and the stale doc comment in `api.ts` (above
    `standalone`, and the first of the two on `readTalk`); no finding of the code cleanup covers
    them. The one in `phone.tsx` stays for code cleanup W21 (H15).
- [ ] **W3:** Scripts, plugin and CI workflows. The bugs in `scripts/`, `plugin/` and `.github/`, in
  [scripts-app](code-cleanup/scripts-app.md) and [plugin](code-cleanup/plugin.md), 10 in all:
  - `scripts/build.ts` without `--out` drops its first argument, so `bun scripts/build.ts
    linux-x64` builds this machine's target.
  - `scripts/check-app.ts` takes the first argument without `--` as the program, so
    `--screenshot out.png <program>` starts `out.png`.
  - `scripts/scratch-obeya.ts` `--say` and `--artifact` drop every word that starts with `--`.
  - `.github/workflows/pages.yml` publishes the site's player again only when its own files
    change, not when `src/server/demo-page.ts` or `plugin/skills/demo/lib/locale.ts`, which
    `site/player.js` is built from, do.
  - `director.ts` imports Playwright statically, so without Playwright `node demo.ts` and `node
    revoice.ts` fail at import before `checkSetup` can list what is missing.
  - `tts.py --sample` does not catch `QuotaExhausted`: a spent daily quota ends a sample in the
    settings with a traceback instead of the message.
  - `browser.ts` `runInput` has no timeout: an `input` step against a page that does not answer
    waits forever, where every other command gives up after 30 s.
  - Comments, in one commit: the doc comment of `initRepo` in `scratch-obeya.ts`. The header of
    `browser.ts` stays for code cleanup W24 (P10), that of `build.yml` for W25 (R14).

## Decisions

- One plan with three workstreams (server, interface, scripts with plugin and CI) that share no
  files and land one by one (owner, 2026-11-10). Rejected: a single card, where everything lands
  at once, a hard case holds up the rest and the handover becomes a long table; and the bugs as a
  workstream W0 of the code cleanup, whose goal is that no workstream changes behaviour.
- A comment point that no workstream of the code cleanup touches is fixed here, in a commit
  without a test; one that a cleanup workstream reworks is left to it (2026-11-10).
- The minimap colours by `shownState`, as the card's sheet and a collapsed project's marks do
  (2026-11-10).
- The phone follows an open card that moves canvas, as the desktop does; it keeps ignoring `wish`,
  having no wish dialog (2026-11-10).
- Archiving a planned task with a branch but no session is refused by the server only if a direct
  request can get past the other checks; the tagging batch in `share.ts` is fixed only if it can be
  reproduced (2026-11-10).
