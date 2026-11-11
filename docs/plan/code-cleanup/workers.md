# A: workers (`src/server/workers.ts`, `stalls.ts`, `workers-fixture.ts`, `patience.ts`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

`src/server/workers.ts` (5,586 lines) is one class, `Workers`, with about 200 methods and 18 state
maps: careful, well-commented code with almost no literal copy-paste, but it has become the place
where everything about a card's agent lives (prompts, tools, review cards, landing, the app, leases,
restarts). Its two themes are shape (one module and a few very long functions doing many jobs) and
small sequences restated at many call sites (row JSON columns, the "unheard" queue, row transitions,
prompt sentences). `stalls.ts`, `workers-fixture.ts` and `patience.ts` are clean.

## Findings

### A1. `workers.ts` is a grab bag: one 4,860-line class behind five banners
- Principle: KISS
- Size: major
- Where: `src/server/workers.ts:139-642` (module-level texts and helpers), `:644-5507` (`class
  Workers`), `:5509-5586` (trailing helpers); banners at `:719` ("owner actions", runs to `:3533`),
  `:3535` ("sessions"), `:4219` ("parking"), `:4463` ("the worker's tools"), `:5272` ("prompts")
- Now: The class holds at least six jobs that share little state: (a) pure texts and text builders
  that never touch `this` (`spotNote`, `retractedText`, `TASK_BY`, `proposalTask`, `heldEdited`,
  `DUE_WHY`…`stillDue`, `pauseNotice`, `snoozedUntil`/`metNote`/`wokeNote`, `AFTER_*`, `FOLLOW_UP*`,
  `describeTool`, `permissionWhat`, `code`, `mocksText`: about 450 lines); (b) prompts that only
  read options (`system`, `briefing`, `reviewBriefing`, `folderBriefing`, `builtOnPrototype`,
  `demoSkill`, `demosDir`: `:5279-5500`); (c) review cards, i.e. everything that starts with
  `contributionOf(...)` (`decide`, `followUpTask`, `owedTasks`, `setFindings` `:893-1045`;
  `mergeContribution`, `pushContribution`, `editHeld`, `conflicted`, `moved`, `pushHeld`,
  `postHeld`, `contributionClosed`, `contributorAnswered`, `requestChanges`, `ownCommits`, `heldAt`
  `:1621-2079`; `pulls`, `pullAfterMerge`, `probeClash`, `pushMainFor`, `keepMainFor`,
  `pushMainNow`, `reprobeClashes`, `landedBy`, `resolvePull`, `resolveMessage`, `reshipped`,
  `landResolved` `:2612-2869`; `mergeApproved` `:3965`: about 1,500 lines); (d) the card's app
  (`parking`, `tried`, `forwards`, `stopping` with `waitsForOwner`, `parkLater`, `appAt`,
  `unforward`, `appUp`, `openApp`, `unpark`, `park`, `parkedNote` `:4221-4409`); (e) leases
  (`settleLater`, `settleLeases`, `archivedLease`, `whileFreeing`, `freed`, `restored` with `kept`,
  `freeing`, `settling` `:3293-3429`); (f) the session loop and the tools. The banners no longer
  describe their contents: "owner actions" spans 2,800 lines and holds `mainNotes`, landing, diffs,
  leases and restarts; "parking" holds `lost` (`:4334`), `demoHere` (`:4369`) and
  `waitForLimit`/`goesOnAfterLimit`/`unlimited`/`resumed` (`:4411-4461`). Other modules import text
  helpers from here: `answers.ts:23` and `explorers.ts:16` take `describeTool` and `SPOKEN`,
  `revisions.ts:17` takes `PROPOSAL_QUESTIONS`, `proposalQuestions`, `proposalTask`.
- Why it matters: Nobody can hold the file in their head; a change to review cards means scrolling
  past landing, parking and prompts; the idea and question agents depend on the workers module for a
  log-line formatter; every private method can reach every map, so nothing says which state belongs
  to which job.
- Change: Split in steps, each behaviour-preserving, all behind the unchanged public `Workers` API
  (the tests only use that, plus `probeClash` once in `review.test.ts:161`): (1) `worker-texts.ts`:
  the pure texts and builders of (a); `describeTool`/`permissionWhat`/`SPOKEN` and the `PROPOSAL_*`
  helpers go to a neutral module (`tool-lines.ts`, `proposals.ts`) that workers, answers, explorers
  and revisions import. (2) `worker-briefing.ts`: (b) as functions over a small context `{ board,
  adapter, folder, repoPath, shares, demoLanguage, imageFiles, toObeya, proposalBoards }`. (3)
  `CardApps` in `card-app.ts`: (d) with its four maps, given `waitsForOwner`, the generation getter
  and the board. (4) `ReviewCards` in `review-cards.ts`: (c), given a narrow host interface
  (`deliver`, `bump`/generation, `approving`, `takeHeld`/`approvalComments`, `merged`,
  `resumeFinished`, `toOwner`). (5) `worker-tools.ts`: `tools()` with each handler a named function
  (see A2). I would do (1), (2), (3) first: they move code without touching control flow.
- Win: `workers.ts` shrinks to roughly 2,000 lines (session loop, owner's words, approval and
  landing); three modules stop importing from it; each map lives beside the code that uses it.
- Risk: medium for (4) and (5) (shared private state must become an explicit interface), low for
  (1)–(3). Protected by `workers.test.ts`, `workers-landing.test.ts`, `workers-demo.test.ts`,
  `workers-worktrees.test.ts`, `review.test.ts`, `pr-watcher.test.ts`, `coordinator.test.ts`,
  `hosts.test.ts`, all through the public API.
- Confidence: high on the diagnosis (whole file read; imports of `./workers` grepped across `src`,
  `scripts`); medium on the exact cut of (4), whose host interface I listed from reading, not from
  compiling.

### A2. `ready_for_review` is 165 lines of nested continuations inside a 670-line `tools()`
- Principle: KISS
- Size: moderate
- Where: `src/server/workers.ts:4465-5132` (`tools`), `:4851-5017` (the handler), `:4862-4876`
  (`handOverWork`, `handOverNow` with seven positional parameters), `:4995-5016` (`handOverWith`,
  `withFiles`, `unclear`)
- Now: The handler is written bottom-up in continuation style: `run` calls `prototypesUnclear` →
  `withFiles` → `namedFiles` → `handOverWith` (copies a remote demo, or asks `showsFiles`) →
  `handOverWork` (`ownCommits` for a review card, else `hasWork` + `landingOf` + `changedFiles`) →
  `handOverNow(d, named, shows, work, own, mine, changed)`, which is 125 lines of validation, demo
  assembly, the contribution update, two `board.work` calls and four different results. The reader
  meets the last step first and the first step last. Two comments are detached from their lines:
  `:4852` describes `:4855-4856`, and `:4859-4861` stacks three comments for two branches.
- Why it matters: This is the most important tool an agent has, and its order of checks (which
  refusal wins) can only be found by tracing closures backwards. Each new input added one more
  positional parameter to `handOverNow`.
- Change: Make it a private `async handOver(cardId, live, args, ctx)` (in `worker-tools.ts` after
  A1) that reads top to bottom with `await`: summary length → `resolving` → `prototypesUnclear` →
  `namedFiles` → demo copy / `showsFiles` → git facts into one object `{ work, own, mine, changed }`
  → the session-still-current check → then three named steps: `refusal(row, …): string | undefined`
  (the `Not handed over:` checks `:4881-4900`), `demoOf(d, row): string | StoredDemo`
  (`:4902-4928`), `record(...)` (`:4929-4968`), and the result text (`:4971-4992`). The handler
  already always returns a promise (both arms of `handOverWork` are promises), so `async` changes no
  timing an agent can see.
- Win: No lines saved to speak of; the seven-parameter closure and four levels of nesting go, and
  the order of refusals becomes readable.
- Risk: medium. `workers-demo.test.ts`, `workers.test.ts`, `review.test.ts` and
  `workers-landing.test.ts` exercise the handover through the fake runtime; keep the order of the
  checks exactly (the `Not …:` texts are what the tests and agents see).
- Confidence: high (read in full; both arms of `handOverWork` checked to be promises).

### A3. `turnEnded` is a state machine written as 115 lines of early returns
- Principle: KISS
- Size: moderate
- Where: `src/server/workers.ts:3989-4105` (`turnEnded`), `:4112-4127` (`unresolved`), `:4134-4150`
  (`failedAfterLanding`), per-turn flags in `Live` `:377-399`
- Now: `turnEnded` first snapshots and resets six per-turn fields one by one (`handedOver`,
  `answered`, `spoke`, `snoozed`, `held`, `acted`, `:3992-4005`), then decides among about fifteen
  outcomes. The condition "the worker heard of the due restart" (`this.restart && live.toldRestart`)
  is written five times (`:4007`, `:4047`, `:4070`, `:4072`, `:4079`), and the pair "paused for the
  restart, else waits for the limit" three times, once per kind of card (`:4047-4049` while
  answering, `:4072-4073` after landing, `:4079-4080` at work; the landed one adds `!live.failed`).
  The landed tail (`:4061-4077`) and the nudge-then-stall tail (`:4081-4104`) are separate jobs
  inlined. `failedAfterLanding` repeats the nudge-then-stall shape with its own text.
- Why it matters: Every new way a turn can end (snooze, pause at a safe point, usage limit,
  resolving a pull) was added as more conditions in front of the others; whether a case is handled
  depends on the order of fifteen returns.
- Change: (1) Put the per-turn flags in one object, `live.turn = { handedOver, answered, spoke,
  snoozed, held, acted }`, taken and replaced at the top (`snoozed` carried over when `more`). (2)
  Name the conditions once: `const dueTold = !!this.restart && !!live.toldRestart`. (3) A helper
  `standsBy(cardId, live): boolean` for "paused for the restart, or waits for the limit" used by the
  three places (the landed one keeps its `!live.failed` guard in front). (4) Move the landed tail to
  `afterLandedTurn(cardId, live, card, landed)` and the last block to `nudgeOrStall(cardId, live,
  card)`. The order of the checks stays exactly as it is.
- Win: `turnEnded` drops to about 50 lines that read as the list of cases; about 15 lines go.
- Risk: medium; turn endings are the most-tested part (`workers.test.ts`,
  `workers-landing.test.ts`), which protects it.
- Confidence: high on what is repeated (lines read); medium that `standsBy` fits all three without a
  flag.

### A4. Three endings of a card's work assemble the same row and message; the approval transitions are restated
- Principle: DRY
- Size: moderate
- Where: `src/server/workers.ts:2192-2238` (`landNow`), `:2246-2273` (`close`), `:2579-2610`
  (`merged`); approval kept: `:1797-1804` (`conflicted`), `:2175` (`landNow`); back to the owner:
  `:1793`, `:3954`, `:3974`
- Now: Landing on main or by direct push, closing unchanged (also the folder's approval) and a
  merged pull request each do: `bump` → `pageNote` → `board.work({ state: 'live' | 'done', need:
  null, detail: null, status_line: null, approved_at: null, landed: JSON.stringify({ …,
  ...(page.waits ? { page: true } : {}) }), shipped? })` → log → `afterLanding(cardId, [headline…,
  page.text, comments?.text ?? '', AFTER_LANDING].filter(Boolean).join('\n\n'), comments?.images,
  owner)`. They differ in the headline, in what `landed`/`shipped` hold, and in the hooks between
  (`onLanded`, `onMerged`, `planDocsLanded`). Likewise "the approval holds while the worker fixes
  what is in the way" is the row `{ state: 'working', need: null, detail: null, approved_at:
  row.approved_at ?? new Date().toISOString() }` plus "The approval holds …" in two places, and "the
  card is the owner's to approve again" is `{ state: 'waiting', need: row.demo ? 'demo' : 'review',
  status_line: null[, approved_at: null] }` in three.
- Why it matters: The card's lifecycle (design: card-lifecycle, landing) is encoded as row literals
  at each site; a new column that must be reset when work ends (as `approved_at`, `status_line`
  were) has to be found in each of them.
- Change: Three small private methods: `workOver(cardId, state, landed: LandedState, more?:
  RowUpdate): { text: string }` (bump is left to the callers, where its position differs; it does
  `pageNote` + the row), `tellLanded(cardId, lines: string[], comments, owner, after =
  AFTER_LANDING)`, and the two transitions `keepApproval(cardId, row)` / `backToOwner(cardId, row)`.
  `landNow`, `close`, `merged` keep their headlines and hooks.
- Win: about 30 lines; the "work is over" row exists once.
- Risk: low to medium (`workers-landing.test.ts`, `review.test.ts` cover all three endings).
- Confidence: high (the three bodies compared line by line); note `landNow`'s row at `:2175` has no
  `status_line: null` while `conflicted`'s has, so `keepApproval` needs that as an argument or the
  difference checked first.

### A5. The owner's words reach the worker through seven hand-built variants of one message
- Principle: DRY
- Size: moderate
- Where: `src/server/workers.ts:1053-1133` (`message`), `:1272-1296` (`answer`), `:1338-1351`
  (`answerDemo`), `:1485-1505` (`release`)
- Now: `message` has five branches (handover, open question, planned card, waiting for a clone, at
  work). Three of them and `answer`/`answerDemo` repeat the same assembly: `takeHeld` → log →
  `onOwnerInput` → `deliver(cardId, header + (held ? `${held.text}\n\nThen they wrote:\n\n` : '') +
  words, [...(held?.images ?? []), ...images], true, said)` (`:1085-1086`, `:1108-1109`, `:1130`,
  `:1292-1293`, `:1347-1348`; "wrote" is "answered" in the last two). The planned-card and clone
  branches (`:1113-1117`, `:1118-1122`) are the same four lines with another header. The sentence
  "The card still waits for their approval of what you handed over; a change their words call for
  goes into a new handover" stands at `:1085`, `:1347`, `:1501`; the `how` text ("with which they
  let you go on" / "it does not stop you; …") at `:1129` and `:1493`.
- Why it matters: The rule "held comments go first, with their images first" is restated five times;
  a sixth kind of word from the owner would copy it again.
- Change: Let `takeHeld` hand back a small combiner, or add `private afterHeld(cardId, words:
  string, images: string[], verb: 'wrote' | 'answered'): { text: string; images: string[]; held:
  boolean }`; give the two "no agent now" branches one `leaveNote(cardId, header, …)`; make the two
  repeated sentences constants beside `SPOKEN`. `message` then reads as: pick the header and the
  state change per branch, then one shared send.
- Win: about 25 lines; one place for the order of held comments and words.
- Risk: low (`workers-demo.test.ts` covers held comments with words and answers; `workers.test.ts`
  the notes).
- Confidence: high (all seven sites read and compared).

### A6. The owner's words travel as five loose parameters; `deliver` takes seven positional ones
- Principle: KISS
- Size: moderate
- Where: `src/server/workers.ts:1053` (`message(cardId, text, images, spoken, replyTo, spot,
  findings)`), `:1272` (`answer(cardId, words, images, spoken, replyTo, picks, spot)`), `:1139`
  (`followUp`), `:1303` (`answerPermission`), `:1338` (`answerDemo`), `:1357` (`words`), `:1412`
  (`hold`), `:5255` (`recordAnswer`), `:3644` (`deliver(cardId, text, images, owner, said, timeUp,
  met)`), call sites such as `:3073`, `:3176`; callers `src/server/canvas.ts:1858`, `:1870`
- Now: Text, images, `spoken`, `replyTo` and the place in the video are passed side by side through
  eight functions, in an order that differs between `message` (…, `spot`, `findings`) and `answer`
  (…, `picks`, `spot`). `deliver` has 30 call sites; its flags are positional (`this.deliver(cardId,
  '', [], true, [], timeUp, met)`), and `timeUp`/`met` exist for the one caller `wake`.
- Why it matters: A call such as `deliver(cardId, text, images, true, said)` does not say what
  `true` is; adding one more property of the owner's words (as `spot` was) touches eight signatures.
- Change: An `OwnerWords` object `{ text, images, spoken, replyTo?, place? }` built once in
  `message`/`answer` and passed on; `deliver(cardId, text, images = [], o: { owner?: boolean; said?:
  number[]; woke?: { timeUp?: boolean; met?: Awaited } } = {})`. The two public entry points may
  keep their positional signatures for `canvas.ts`, or take the object too (two call sites).
- Win: eight signatures shrink to `(card, words)`; the 30 `deliver` calls name their flags.
- Risk: low (mechanical; the type checker finds every site).
- Confidence: high (all signatures and the `deliver` call sites grepped).

### A7. JSON columns of the card's row are parsed and written by hand at each use
- Principle: DRY
- Size: moderate
- Where: `row.shipped`: `src/server/workers.ts:735`, `:1141`, `:1185`, `:2498`, `:2514`, `:2531`,
  `:2747`, `:2832`, `:5386`, also `src/server/board.ts:717`, `:740`, `:3715`,
  `src/server/share.ts:1164`; `contribution: JSON.stringify({ … } satisfies StoredContribution)`: 14
  sites in `workers.ts` (e.g. `:922`, `:987`, `:1043`, `:1706`, `:1798`, `:1943`, `:2662`); `landed:
  JSON.stringify(… satisfies LandedState)`: 17 sites; `row.detail`: `:1280`, `:2101`, `:4159`,
  `:4172`, `:4894`, each with its own ad-hoc type; `row.pr`: `:2589`, `:4751`, `:5029`; `row.demo`:
  `:1341`, `:1369`, `:1387`, `:4896`
- Now: `contributionOf` (`board.ts:170`) and `landedOf` (`workers.ts:198`) exist for reading, but
  `shipped` has no reader (the line `row.shipped ? (JSON.parse(row.shipped) as Shipped) : null` is
  written 12 times across three files), and no column has a writer: every update spells
  `this.o.board.work(cardId, { contribution: JSON.stringify({ ...c, … } satisfies
  StoredContribution) })`. `detail` is read as five different shapes (`{ question?, permission? }`,
  `Record<string, unknown>`, `{ answering? }`), so nothing states what the column holds. The test
  "landed and still at its commit" (`row.state === 'live' && shipped?.commit && shipped.base`) is
  repeated at `:2500`, `:2515`, `:2532`.
- Why it matters: The stored formats are compatibility surfaces (existing databases), yet their
  shape is implied by a dozen casts; the `satisfies` guards the literal but has to be remembered
  each time.
- Change: In `board.ts` beside `contributionOf`: `shippedOf(row)`, `prOf(row)`, `demoOf(row)`, and
  one `Detail` interface with `detailOf(row)`. In `Workers`: `setContribution(cardId, c, more?:
  RowUpdate)` and `setLanded(cardId, l, more?)`, which stringify. A `landedAt(row): { base, commit }
  | undefined` for the three diff readers.
- Win: about 40 shorter lines; four stored shapes get one typed reader and writer each.
- Risk: low (pure helpers; types check every site).
- Confidence: high (counts by grep, each `shipped` site read).
- Done by W7 with C2: reads go through `fromJson`, writes through `toJson`, both typed by the
  column (`Json<T>` on `CardRow`), so no per-column writer was needed (`setContribution`,
  `setLanded`); `detail` has one type, `Detail`. `landedAt(row)` serves `diff` and `changedFiles`;
  `file` needs only the commit and keeps its own test.

### A8. "Tell the worker with its next step" is rebuilt at eleven places
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:1063`, `:1117`, `:1122`, `:1757`, `:2111`, `:2171`, `:3197`, `:3686`
  (append), `:1917`, `:2071`, `:2190` (remove by prefix); helpers `:3728-3744`
- Now: Queuing news for the worker is always `this.o.board.work(cardId, { unheard:
  JSON.stringify([...this.unheard(cardId), { said: [], text, images: [] }] satisfies Unheard[]) })`,
  twice with `unheardBut(cardId, PREFIX)` in place of `unheard` to replace earlier news of the same
  kind, and three times only the removal. `unheard`, `unheardBut`, `takeUnheard` exist; an "add"
  does not.
- Why it matters: The replace-by-prefix convention (`HELD_EDITED`, `NOT_LANDED`, `FINDINGS_IGNORED`
  are matched with `startsWith`) is invisible at the sites that rely on it.
- Change: `private tellLater(cardId, text, o: { said?: number[]; images?: string[]; replaces?:
  string } = {})` and `private forget(cardId, prefix)`; where a site sets other columns in the same
  `work` call (`:1757`, `:2111`, `:2171`), a variant returning the column value
  (`unheardWith(...)`).
- Win: about 15 lines; the queue's two operations get names.
- Risk: low.
- Confidence: high (all sites listed by grep and read).

### A9. Four timer maps with the same idiom, among 18 parallel per-card maps; `shutdown` clears three of them
- Principle: KISS
- Size: moderate
- Where: `src/server/workers.ts:645-691` (the maps), timers `holding` `:1425-1438`, `:1474`,
  `:1509`, `:1570`, `:1663`; `pausing` `:3023-3030`, `:3043`, `:3078`, `:3164`; `reconnecting`
  `:3041`, `:3162`, `:4346-4362`; `parking` `:4237-4246`, `:4322`; `shutdown` `:3521-3533`
- Now: `holding`, `parking`, `pausing` and `reconnecting` are each a `Map<string, Timeout>` used the
  same way: `clearTimeout(this.x.get(id)); this.x.delete(id);` (13 such pairs) and `this.x.set(id,
  setTimeout(() => { this.x.delete(id); … }, ms))`. `shutdown` loops over three of them by hand and
  leaves `holding` and `pushingMain` (see Bugs). Next to them stand `live`, `landing`, `approving`,
  `pushingMain`, `reading`, `preparing`, `generation`, `tried`, `forwards`, `stopping`, `granted`,
  `evicting`, `kept`, `freeing`.
- Why it matters: What must be cleaned when a card's work ends or the workers shut down is spread
  over 18 fields; forgetting one is how `holding` was left out of `shutdown`.
- Change: A ten-line `CardTimers` (`set(id, ms, fn)` which clears the one before and deletes itself
  on firing, `clear(id)`, `has(id)`, `clearAll()`) for the four maps; `shutdown` calls `clearAll` on
  each. With A1 the app's maps (`parking`, `tried`, `forwards`, `stopping`) and the leases' (`kept`,
  `freeing`, `settling`) move to their own classes, which leaves `Workers` with the session and
  approval state. I would not fold all maps into one per-card record: the in-flight sets (`landing`,
  `approving`, `evicting`, `freeing`) are read as sets by `busyCards`.
- Win: about 30 lines, one idiom instead of 13 pairs.
- Risk: low; clearing `holding` on shutdown is a behaviour change (a fix), to be decided with the
  bug below.
- Confidence: high (every use of the four maps grepped).
- Bug fixed (W1 of the bug plan): `shutdown` now clears `holding` and the pending timers of
  `pushingMain`, so `CardTimers.clearAll` keeps that behaviour rather than introducing it.

### A10. "Is this still the same run?" is written inline 15 times and as three local closures
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts`: inline `this.generation.get(cardId) !== generation` at 15 places,
  five of them in `mergeContribution` as `this.generation.get(cardId) !== generation ||
  !this.o.board.item(cardId)` (`:1676`, `:1686`, `:1696`, `:1715`, `:1721`); local closures `still`
  (`:835`), `current` (`:4347`), `still` (`:3354`); the session variant `this.live.get(cardId) !==
  live && !live.standIn` with the text 'This session has ended. Stop working and end your turn.' at
  `:4505`, `:4590`, `:4878` (and `:5162`)
- Now: After each `await`, code compares a generation captured before with the current one,
  sometimes with "and the card still exists", sometimes with `!this.shut`.
- Why it matters: The variants differ by accident as much as by intent (some check the card, some do
  not), and a reader has to work out at each site which was meant.
- Change: `private sameRun(cardId): () => boolean` capturing the generation (and checking the card
  exists and `!this.shut`), used as `const still = this.sameRun(cardId); … if (!still()) return;`.
  For tools: `const ended = () => this.live.get(cardId) !== live && !live.standIn` and a
  `SESSION_ENDED` constant, defined once in `tools()`.
- Win: about 10 lines; one definition of "stale".
- Risk: low to medium: sites that today do not check the card's existence would start to; go site by
  site.
- Confidence: high on the counts (grep), medium that one predicate fits all 15.
- Bug fixed (W1 of the bug plan): `generation`, `tried` and `granted` lose a card's entry once the
  card is deleted or archived (`forget`), and `bump` hands out runs counted across cards (`runs`), so a
  forgotten generation is never equal to a later one; `sameRun` keeps that.

### A11. `halt` and `snooze` are the same suspension written twice
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:3037-3048` (`halt`), `:3154-3169` (`snooze`)
- Now: Both take `live.pending`, call `end`, `bump`, clear `reconnecting` and `pausing`, write
  `paused: JSON.stringify({ held: … })` with `pausing: null`, and call `parkLater`. `snooze`
  additionally keeps what an earlier pause held and calls `board.snooze` instead of logging
  `pausedByOwner`.
- Why it matters: A new timer or flag that a suspended session must drop has to be added to both.
- Change: `private suspend(cardId): void` doing the shared eight lines (held = what was held before
  plus the pending message); `halt` adds the log, `snooze` the `board.snooze`. `halt` is only
  reached for a card that is not paused (`pausableNow`/`pausable` in `src/core/types.ts:78-82`
  require `!paused`; `pausing` is only set on such a card), so its earlier list is always empty.
- Win: about 8 lines.
- Risk: low (`workers.test.ts` covers pause and snooze). `halt` stores `{}` where nothing was
  pending and the shared form would store `{"held":[]}`; readers use `paused.held ?? []`, so keep
  `{}` only if a test compares the stored text.
- Confidence: high (both bodies compared; `halt`'s callers `pause`, `pauseAtSafePoint`,
  `pausedAtSafePoint`, the pause timer and their guards read).

### A12. `resumeAll` forks a snoozed card into two identical arms
- Principle: KISS
- Size: minor
- Where: `src/server/workers.ts:3217-3229`, `:3432-3437` (`pausedOverRestart`), `:3440-3447`
  (`resumeLanded`)
- Now: For a snoozed card, `if (row.paused) this.pausedOverRestart(i.id, landed); else {
  this.parkLater(i.id); if (landed?.restarts) { work(landed: settled(landed)); deliver('Obeya has
  started again and runs main with your change now.'); } }`. The `else` arm is `pausedOverRestart`'s
  body word for word. The sentence stands a third time in `resumeLanded` (`:3446`).
- Why it matters: A reader looks for the difference between the arms and there is none.
- Change: `if (row.snoozed && !waiting) { this.pausedOverRestart(i.id, landed); continue; }`, the
  two comments kept above it; the sentence a constant.
- Win: 8 lines and a false distinction.
- Risk: low.
- Confidence: high (both arms compared line by line).

### A13. Sentences for the agent restated word for word
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:497-501` (`RESTARTED`, `REPO_RESTARTED`: identical from "Whatever
  you had running then …" to the end), `:573-574` (`RESUMED`) and `:614` (`wokeNote`'s owner arm:
  identical after "Pausing"/"Snoozing"), `:2285`/`:2316` ("Before you point anyone to your demo (an
  issue you close, say), ask the owner for a link."), `:2294`, `:2315`, `:2343` ("Link it wherever
  you point people at this work (an issue you close, say)."), `:3225`, `:3436`, `:3446` ("Obeya has
  started again and runs main with your change now."), `:3615-3616` and `:4148-4149`
  (`failureReason(clip(live.failed, 1200), t)` plus the closing full stop; `:4103` without it)
- Now: The same sentence is typed out in two to four prompts.
- Why it matters: A reworded instruction (the house rule is to fix agent behaviour by changing the
  instruction that causes it) has to be found in each copy, or the agent hears two versions.
- Change: Named constants or one-line builders beside the other texts (`STOPPED_WITH_SESSION`,
  `restartedNote(repo)`, `LINK_DEMO`, `ASK_FOR_LINK`, `RUNS_YOUR_CHANGE`, `failureText(live, t)`).
  The texts the agent reads stay byte for byte.
- Win: about 10 lines; each sentence once.
- Risk: low (string identity; tests assert several of these texts).
- Confidence: high (compared character by character for the pairs named).

### A14. A demo directory is checked twice, in `ask` and in `ready_for_review`
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:4587-4600` (`ask`), `:4917-4927` and `:4995-5001`
  (`ready_for_review`)
- Now: Both copy a remote demo here (`demoHere`), then for `kind === 'html'` run `checkArtifact` and
  set `single` when `artifactFiles(dir).length === 1`, else run `readChapters`. `ready_for_review`
  adds `videoFacts`, the report and the page, and guards `demoHere` with `hostName(workspace)`
  although `demoHere` already returns the directory unchanged for a local workspace (`:4371-4372`).
  The refusals differ only in "Not asked: … ask again" against "Not handed over: … call
  ready_for_review again".
- Why it matters: A third demo kind, or a new check on a demo, has to be added in both.
- Change: `private checkedDemo(dir, kind, chapters): { kind; dir; chapters; single? } | { wrong:
  string; what: 'artifact' | 'demo' }` used by both; each caller wraps the refusal in its own words
  and adds its own fields.
- Win: about 10 lines.
- Risk: low (`workers-demo.test.ts`).
- Confidence: high (both read).

### A15. "A time within the coming year" is validated in four places
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:4647-4651` (`propose_card`'s `start_at`), `:5065-5069` (`snooze`'s
  `until`), `src/server/canvas.ts:574-578` (`until`), `src/server/commands.ts:1085-1088`
- Now: Each parses a time and refuses "not a time", "has passed", "more than `SNOOZE_LIMIT` ahead",
  with its own wording for its reader.
- Why it matters: The rule (future, at most a year) is one fact; the constant is shared but the
  three comparisons are not.
- Change: Beside `SNOOZE_LIMIT` in `src/core/types.ts`: `laterTime(ms: number, now = Date.now()):
  'none' | 'past' | 'far' | 'ok'`; the four callers keep their words.
- Win: about 8 lines; the rule once.
- Risk: low.
- Confidence: high (all four read).
- Done by W6: `laterTime(at, now?)` beside `SNOOZE_LIMIT` in `core/types.ts` (which no longer
  needs exporting); `propose_card`, `snooze`, `new_card`, the assistant's `snooze` and
  `CanvasRuntime.until` call it.

### A16. A turn is started on a live session in three places
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:3552-3554` (`launch`), `:3696-3706` (`deliver`), `:3776-3781`
  (`unheardStarts`); also `stopWaiting(live); clearTimeout(live.lifts); live.lifts = undefined;` at
  `:3698-3700` and `:3882-3884`
- Now: Each takes the unheard words (`withUnheard`), adds the page news (`withPageNews`) and, in two
  of them, the restart note (`withRestart`), sets `live.pending` and sends. `unheardStarts` omits
  `withRestart` because it returns early while a restart is due.
- Why it matters: What every message that starts a turn carries (unheard words, page news, restart)
  is a rule; a fourth carrier would be added in three places.
- Change: `private opening(cardId, live, text, images): { text, images }` (the three `with…` in
  order; `withRestart` is a no-op where no restart is due) used by all three, and `private
  wakes(live)` for the stop-waiting triple.
- Win: about 8 lines.
- Risk: low.
- Confidence: medium-high (`withRestart` read: with `this.restart` null it returns the text
  unchanged, so adding it to `unheardStarts` changes nothing).

### A17. Leftovers: orphaned doc comments, split imports, exports nothing uses
- Principle: KISS
- Size: minor
- Where: `src/server/workers.ts:229` (doc of `asBadRequest` above `realpathOr`), `:264` (doc of
  `proposalTask`, which is at `:294`, above `retractedText`), `:307` (doc of `NOT_LANDED` above
  `CONFLICT`), `:5189` (doc of `retract`, which is at `:5216`, above `proposalBoards`); imports from
  `./board` at `:16` and `:31`, from `./workspaces` at `:29` and `:34`, from `../core/types` at
  `:15` and `:32`; `export` on `WorkerOptions` (`:41`), `spotNote` (`:156`), `answerNote` (`:474`),
  `permissionWhat` (`:5565`); `landingOf` (`:2123`) public; `src/server/stalls.ts:49`, `:227`,
  `:255` (`Waited`, `describeRun`, `StallOptions` exported)
- Now: Four doc comments sit above a declaration that was inserted between them and the one they
  describe, so each of these has two stacked `/** */` blocks, the first describing something else.
  Three modules are imported in two statements each. Four exports of `workers.ts` and three of
  `stalls.ts` have no user outside their file, tests included; `landingOf` has no caller outside the
  class.
- Why it matters: A comment that describes the wrong declaration misleads; the rest is noise.
- Change: Move the four comments to their declarations, merge the import pairs, drop the seven
  `export`s, make `landingOf` private.
- Win: tidiness; no lines.
- Risk: low.
- Confidence: high (each export grepped across `src`, `scripts`, `plugin`; comments read against the
  declarations).

### A18. Small repeats inside the file-reading and forge code
- Principle: DRY
- Size: minor
- Where: `src/server/workers.ts:2429` and `:2445` (plan docs filter `f.endsWith('.md') &&
  !exclude.some((x) => f.endsWith(`/${x}`))`), `:2433` and `:2541` (`'path' in at ?
  Bun.file(at.path).text() : new TextDecoder().decode(at.data)`), `:1869-1872` and `:1879-1882`
  (`forge.status(...).then((s) => s.head, () => '')`), `:3109-3122` and `:3547` (the initial `Live`
  literal)
- Now: Each pair is the same expression twice.
- Why it matters: Small, but each is a rule (which files are plan docs, how a `FileAt` becomes text)
  that has a natural single home.
- Change: `isPlanDoc(file, exclude)` beside the adapter's plan-doc settings, `textOf(at: FileAt)` in
  `workspaces.ts`, `private prHead(cardId, c)`, `newLive(over: Partial<Live>)`.
- Win: about 12 lines.
- Risk: low.
- Confidence: high.

### A19. A demo's facts and its kept copy are read synchronously at the handover
- Principle: DRY
- Size: minor
- Where: `src/server/demo-files.ts` (`captionTracks` beside `captionTracksAsync`, `silentVideo` beside
  `silentVideoAsync`, `mp4Head`, `videoSize`, and their callers `demoFiles`, `videoFacts`,
  `keepDemo`); callers `Workers.keep` and the `ready_for_review` and `ask` tools in `workers.ts`,
  `Sharing.rebuilt` in `share.ts`, `site.ts` (`demoFiles` in a publish), `scripts/scratch-obeya.ts`
- Now: the caption tracks and the silence of a video are read by two twins each, one with
  `node:fs`'s synchronous calls, one with `fs/promises`. The site and the export read the async
  ones; the handover reads the synchronous ones through `videoFacts` and `keepDemo`, inside
  `handOverNow`, which checks that the session is still live and writes the card's row without
  waiting in between.
- Why it matters: each change to how tracks are named or a video is read is made twice, and the
  synchronous calls stay in `sync-calls.test.ts`.
- Change: `demoFiles`, `videoFacts` and `keepDemo` become async, `videoSize` reads through the async
  head, and the synchronous twins with `mp4Head` go. The handover reads the facts and keeps the copy
  before its synchronous section (in `handOverWork`, say), and `Sharing.rebuilt` becomes async.
- Win: about 30 lines and five synchronous calls.
- Risk: medium: the handover's order of checks and writes changes. With A2.
- Confidence: high for the duplication; this is the second step of S13 of the sharing review, which
  W17 left here because it takes the handover apart.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/workers.ts:3094` `standIn`: a scripted stand-in for the agent;
  `scripts/scratch-obeya.ts --say` drives it (CLAUDE.md, "idle workers").
- `src/server/workers.ts:239-256` `asBadRequest` / `asBadRequestAsync`: sync and async twins of four
  lines; `lease` must throw synchronously.
- `src/server/workers.ts:3272` `listFiles`: a backfill for folder cards handed over before `files`
  existed, added 2026-10-21 (f15f7da4) for existing databases; it does re-diff, at every start, the
  cards whose change has nothing to show, which a later cleanup could mark as looked at.
- `src/server/workers.ts:41-137` `WorkerOptions`' many optional graces and limits
  (`backgroundGrace`, `holdGrace`, `pushSettle`, …): each is set by production (`canvas.ts:882`) or
  is a test seam set by a test file.
- `src/server/workers.ts:865-885` `mainNotes` with its seal cache: keeps git off the server's thread
  for review cards (design: running-obeya, stalls).
- `src/server/workers.ts:4501-4514` `current(tools)`: the wrapper that refuses calls of an ended
  session and records refusals for the nudge (Codex's code mode drops results).
- `src/server/workers.ts:4556`, `:4775` the demo schema of `ask` and of `ready_for_review` overlap
  in three fields: agent-facing descriptions that differ on purpose.
- `src/server/workers-fixture.ts:22-43` exported `let` bindings with setters: one fixture module
  shared by the split `workers-*.test.ts` files, as its header says.
- `src/server/stalls.ts:274-289` module-level `watching`/`ticking`: the profiler runs for the
  process's life, as the comment says.
- `src/server/patience.ts`: a nine-line module of its own so that `scripts/test.ts` can import it
  without the test helpers.

## Bugs noticed in passing
None left: the ones found here were fixed (2026-11-10).
