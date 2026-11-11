# C: board and database (`board.ts`, `db.ts`, `answers.ts`, `owner.ts`, `tag-proposal.ts`, `revisions.ts`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

`owner.ts`, `tag-proposal.ts` and `revisions.ts` are clean; `answers.ts` is dense but coherent;
`db.ts` is plain and consistent, with no dead migration (every compatibility step can still meet a
database in the wild). The weight is in `board.ts` (4,101 lines): it holds three subsystems besides
the board plus a method-by-method copy of the Store's sheet API, and the knowledge of what each JSON
column of a card row holds is spread over about ninety hand-written `JSON.parse(row.x) as T` casts
across the server.

## Findings

### C1. Board repeats the Store's sheet and history API method by method
- Principle: DRY
- Size: major
- Where: `src/server/board.ts:1539-1709` (the Coordinator's memory), `:850-862`, `:1241-1301`,
  `:2705-2707`; the originals in `src/server/db.ts:1192-1212`, `:1307-1585`, `:1589-1661`, with
  `TalkRow`/`toTalk`/`withContinues`/`quotedTalk` at `:1756-1832`
- Now: 36 `Board` methods do nothing but call the `Store` method of the same name with
  `this.canvas.id` put in front, half of them followed by `this.changed()`: `addTalk`, `replyTalk`,
  `holdTalk`, `heldTalk`, `waitTalk`, `waitingTalk`, `thenTalk`, `answeredSteps`, `undoTalk`,
  `dropCommand`, `talk`, `answerTalk`, `talkFiles`, `talkSession`, `threadTalk`, `moveThread`,
  `readTalk`, `exchange`, `cardReply`, `event`, `lookingUp`, `timeline`, `mark`, `utterances`,
  `decidedProposals`, `removed`, `friction`, `addFriction`, `decide`, `decisions`, `decisionsOn`,
  `setting`, `setSetting`, `retroProposals`, `settingProposals`, `preferences`. Each carries a
  paraphrase of the Store method's doc comment, and `addTalk` (nine positional parameters) and
  `replyTalk` (six) repeat the whole signature.
- Why it matters: eleven columns were added to `talk` since the release (`db.ts:419-561`); each
  meant the Store method, its Board twin, two doc comments, then the callers. A reader of `board.ts`
  passes 170 lines that say nothing about the board.
- Change: give the sheet a canvas-scoped object written once: `class Sheet` in a new
  `src/server/sheet.ts`, constructed with `(db, canvasId, changed)`, holding what are today the
  Store's talk methods and row mapping and calling `changed()` after its writes. `Board` exposes
  `readonly sheet`; callers write `board.sheet.add(…)`, `board.sheet.exchange(id)`. The read-only
  history queries (`timeline`, `mark`, `utterances`, `decidedProposals`, `removed`) go the same way
  (the same class, or a `history` object). Methods with logic of their own stay on Board and call it
  (`interruptTalk`, `followTalk`, `heldCommands`, `moved`). The second shape, keeping the Store
  whole and adding `store.sheet(canvasId)`, saves the Board half only; I would take the first, since
  it also gives `db.ts` one subject less.
- Win: about 200 lines of `board.ts`; `db.ts` loses about 330 lines to a file with one subject; one
  signature and one doc comment per operation.
- Risk: medium. Mechanical but wide: `commands.ts`, `answers.ts`, `canvas.ts`, `coordinator.ts` call
  these; covered by `db.test.ts`, `board.test.ts`, `commands.test.ts`, `answers.test.ts`.
- Confidence: high. Every listed method read on both sides; none does anything but delegate. Callers
  counted by grep.
- Done by W8, in the first shape: `Sheet` in `sheet.ts` holds the talk table's operations, its row
  mapping and the commands waiting for "Undo", calling `changed()` after the writes the Board's twins
  did; `History` in `history.ts` holds the read-only queries (`timeline`, `mark`, `utterances`,
  `decidedProposals`, `removed`) with `Mark`, `Moment` and `Utterance`. `Board` exposes both as
  `sheet` and `history` and keeps `interruptTalk`, `followTalk` and `moved`, which add logic of their
  own. Of the 36, eleven stay on `Board`: `event` reads the card's log; `friction`, `addFriction`,
  `decide`, `decisions`, `decisionsOn`, `setting`, `setSetting`, `retroProposals`,
  `settingProposals` and `preferences` belong to other subjects of the board (the retrospective,
  decisions, settings, rules), and four of them add logic (`repoColumn`, the empty-notes guard,
  `toDecision`, the states as rest arguments). Putting them into the `Sheet` would make it a grab-bag;
  an object per subject would be more machinery than the two-line pass-throughs it replaces.

### C2. What a card row's JSON columns hold is cast by hand at about ninety places
- Principle: DRY
- Size: major
- Where: `src/server/board.ts` (57 sites, e.g. `:717`, `:740`, `:742`, `:878`, `:985`, `:1061`,
  `:1465`, `:1476`, `:2354`, `:2367`, `:2628`, `:3123`, `:3138`, `:3247`, `:3387`, `:3645`, `:3715`,
  `:3845-3856`, `:3900`, `:3905`, `:3950`); `src/server/workers.ts` (19, e.g. `:735`, `:1141`,
  `:1185`, `:1369`, `:1387`, `:2498`, `:2514`, `:2531`, `:2747`, `:2832`, `:4896`);
  `src/server/share.ts:1013`, `:1164`; `src/server/canvas.ts` (2); `src/server/pr-watcher.ts` (1);
  the columns in `src/server/db.ts:15-153`
- Now: `CardRow` has 30 JSON columns, each typed `string | null`, its real type named only in a doc
  comment ("JSON: `PrState`"). Every reader writes `r.shipped ? (JSON.parse(r.shipped) as Shipped) :
  null` anew: `shipped` 12 times, `plan` 10, `demo` 9, `share` 6, `detail` 6, `pr` 5, `deps` 5,
  `images` 4. A few accessors exist and are used beside the hand-written form: `waitOf`,
  `contributionOf`, `storedDemos`, `storedProposal`, `storedPrototype` (board.ts), `landedOf`
  (workers.ts:198). `detail` has no type: it is cast to `{ summary?: string }` at `board.ts:1061`
  and `:3950` and to a six-field inline type at `:3845`; `landed` is cast to a three-field inline
  type at `board.ts:3856` while workers.ts has `LandedState`.
- Why it matters: the column-to-type mapping is one piece of knowledge kept in 90 casts. Nothing
  stops two sites from casting one column to different shapes (they do for `detail` and `landed`),
  and the empty default differs by site (`null`, `{}`, `undefined`).
- Change: one module beside `CardRow` (`src/server/row.ts`) with a typed reader per column built
  from one helper: `const json = <T>(k: JsonColumn) => (r: Pick<CardRow, typeof k>): T | null =>
  (r[k] ? (JSON.parse(r[k]!) as T) : null)`, then `export const shippedOf =
  json<Shipped>('shipped')`, `prOf`, `demoOf`, `storedShareOf`, `planOf`, `depsOf`, `detailOf` (with
  a named `Detail` type), `snoozeOf`, `storedIdeaOf`, `storedThreadOf`, `landedOf`,
  `storedNewRepoOf`. The existing accessors move there. Call sites become `shippedOf(r)`; writes
  keep `JSON.stringify(x satisfies T)`.
- Win: about 90 casts become calls, two inline types get a name, and `CardRow`'s comments point at
  one place.
- Risk: low. Type-checked and mechanical; `board.test.ts` and `workers.test.ts` exercise every
  column.
- Confidence: high. Counted per column with grep over `src` (non-test); existing accessors read.
- Done by W7, in another form than proposed: rather than a named reader per column, each JSON
  column of `CardRow` is typed `Json<T>` (in `row.ts`), a string that carries what it holds, and
  one `fromJson` reads any of them as that type; `toJson` writes them, its type taken from the
  column, so writes are checked as reads are and the `satisfies` at about forty writes went (the
  seventy without one are checked now too). The column types moved to `row.ts` first, unchanged;
  `detail` and `scope` got named types (`Detail`, `Scope`). `contributionOf`, `landedOf`,
  `storedProposal`, `storedDemos` and `storedPrototype` went, each being `fromJson` on its column;
  `waitOf` stays, as it picks a kind of queue. The legacy share shape in
  `convertSingleDemoShares` keeps its own cast.

### C3. board.ts holds three subsystems that are not the board
- Principle: KISS
- Size: major
- Where: `src/server/board.ts`. The notice of outdated and untagged shared pages: `:207-372`,
  `:928-1012`, `:1303-1459`, `:2564-2647`. The archive's paging and search index: `:451-507`,
  `:1829-2104`. The plan-doc follower: `:3183-3475`, `:3754-3796`. (The sheet pass-throughs are C1.)
- Now: `class Board` has about 40 private fields. Thirteen belong to the notice of outdated pages
  alone (`shared`, `shares`, `tagsOf`, `outdatedOf`, `looked`, `notice`, `lookedFiles`, `looking`,
  `lookAgain`, `lookDue`, `pageNotes`, `themeOf`, `vocabularyOf`), three to the archive's search
  index (`archiveIndex`, `indexing`, `indexDrop`), six to following workstreams through plan-doc
  edits (`planHistory`, `histories`, `lesestandAt`, `heldBack`, `missing`, `waking`). Each group has
  its own caching protocol and meets the rest of the class through two or three calls (`sharedRows`,
  `items`, `changed`/`tell`).
- Why it matters: to change how a card moves between states one opens a file in which that logic is
  the minority. The three caches interleave in the field list, so which invalidation belongs to
  which is read from comments.
- Change: split along those seams, behaviour unchanged, `Board` keeping thin delegates where callers
  use them. `board-pages.ts`: a `PageNotice` class owning the thirteen fields and `sharedRows`,
  `outdatedRows`, `untaggedRows`, `reshare`, `lookAtDemos`, `dismissOutdated`, with the free
  functions `missedBy`, `reshareable`, `sharedDemos`, `cardDemos`, `pageTagsOf` and the
  `StoredShare`/`SharedDemo`/`StoredReshare` types. `board-archive.ts`: `archivePage`,
  `archiveSearch`, `indexed`, `indexArchive`, `indexEntries`, `archiveOf`, the cursors.
  `plan-follow.ts`: `follow`, `rekey`, `startedOn`, `startedAs`, `identity`, `leave`, `remember`,
  `past`. `toItems`/`work`/`shareOf`/`pullRequest` (`:3639-3920`) are free functions already and can
  go to `items.ts`.
- Win: `board.ts` falls to about 2,000 lines about cards and their transitions; each cache lives
  with the code that reads it.
- Risk: medium. Pure moves, but the parts share private state (`worked`, `docs`, `themeNow`,
  `store`, `log`); `board.test.ts`, `share.test.ts` and `workers.test.ts` are broad.
- Confidence: medium-high. Field use per group read; the cut of `follow` (it calls `this.store`,
  `this.log`, `this.besideProject`, `this.t`) needs an explicit interface.

### C4. An event's optional fields are listed in seven places
- Principle: DRY
- Size: moderate
- Where: `src/server/board.ts:758-789` (`log`: the `Pick` list, the destructuring, thirteen
  conditional spreads); `src/server/db.ts:640` (`EVENT_COLUMNS`), `:641-655` (`EventRow`),
  `:656-671` (`eventOf`), `:1097-1121` (`addEvent`: column list, value list, bindings)
- Now: `code, images, mocks, replyTo, spot, answer, picks, unread, readAfter, wish, reply,
  forwarded, token` are written out in each of those. `Board.log` normalises each field (`...(wish ?
  { wish } : {})`), `Store.addEvent` normalises each again (`wish: e.wish ? JSON.stringify(e.wish) :
  null`), `eventOf` does the reverse. All `log` adds of its own is `basename` on the images.
- Why it matters: four of these fields came after the release (`wish`, `reply`, `forwarded`,
  `token`), each touching all seven lists; one missed in `EVENT_COLUMNS` is silently never read
  back.
- Change: one table in `db.ts`, `EVENT_FIELDS: Record<field, { column: string; kind: 'text' | 'int'
  | 'flag' | 'json' | 'list' }>`, from which `EVENT_COLUMNS`, `eventOf` and the INSERT with its
  bindings are derived. `addEvent` returns the event as `eventOf` reads it, so `Board.log` passes
  `extra` through (`{ cardId, kind, author, text, ...extra, images: extra.images?.map((f) =>
  basename(f)) }`) and drops its spreads.
- Win: about 45 lines; a new event field is one table entry plus its migration.
- Risk: low to medium. The event `log` returns and broadcasts must stay normalised (no `images: []`,
  no `unread: false`); `db.test.ts` and `board.test.ts` compare events.
- Confidence: high. All seven places read side by side.
- Done by W7: `EVENT_FIELDS` in `db.ts` names each optional field with how it is stored (the
  column is the field's name in snake case); `EVENT_COLUMNS`, the INSERT, `EventRow` and
  `eventOf` derive from it, and `addEvent` returns the line as `eventOf` reads it back, so
  `Board.log` passes its fields through (`NewEvent`) and keeps only the `basename` of images.

### C5. The pause protocol is written three times, once per kind of agent
- Principle: DRY
- Size: moderate
- Where: `src/server/answers.ts:203-253`; `src/server/explorers.ts:95-127`, `:181-182`, `:210-211`;
  `src/server/workers.ts:3001-3021`, `:3045-3046`, `:3076-3081`, `:3233-3234`
- Now: "pause at a safe point" is `board.work(id, { pausing: new Date().toISOString() });
  board.log(id, 'state', 'owner', t.worker.pausing)` in all three files. "Taken back" is
  `board.work(id, { pausing: null }); board.log(id, 'state', 'owner', t.worker.resumedByOwner)` in
  all three (`pauseTakenBack` is the same two lines in answers.ts and explorers.ts; workers.ts adds
  its timer). "Paused" is `work(id, { paused: <state>, pausing: null })` plus
  `t.worker.pausedByOwner`. The guard `throw new BadRequest('noAgent', card.paused ? 'the agent is
  paused already' : 'the agent is not working on anything')` is written six times. What differs is
  what `paused` stores (`'{}'` for a Question card and an idea, `PausedState` for a worker) and how
  each agent's turn is ended.
- Why it matters: CLAUDE.md asks that an interaction several kinds of card share be built once. A
  change to the pause line, or to what `pausing` holds, has three places.
- Change: `Board` already pairs a row write with its log line for snoozing (`snooze`/`unsnooze`,
  `board.ts:2371-2388`). Add the same for pausing: `board.pausing(id)`, `board.paused(id, state =
  {})`, `board.pauseTakenBack(id)`, `board.resumed(id)`, and one `checkPausable(card, now: boolean)`
  beside `pausable`/`pausableNow` for the guard. The three agents keep their own part (ending the
  turn, what waits meanwhile).
- Win: about 40 lines over three files; one definition of each pause step.
- Risk: low. Pause and resume are covered in `answers.test.ts`, `ideas.test.ts`, `workers.test.ts`,
  `canvas.test.ts`.
- Confidence: high for answers.ts and explorers.ts (read in full); the workers.ts sites were read in
  context at the lines named, not the whole file.

### C6. A proposal's stored JSON is read, changed and written back nine times
- Principle: DRY
- Size: moderate
- Where: `src/server/board.ts:1100-1118` (`retract`), `:1121-1127` (`keep`), `:1233-1238`
  (`withdrawOwn`), `:1715-1724` (`accept`), `:1757-1771` (`revising`), `:1774-1784` (`unrevise`),
  `:1787-1793` (`startAt`), `:1796-1804` (`acceptAfterRevision`), `:1812-1827` (`revised`)
- Now: each does `const row = this.own(id); if (row.state !== 'proposal') throw new
  BadRequest('notProposal', 'not a proposal'); const p = storedProposal(row) ?? { questions: [] }; …
  this.store.update(id, { proposal: JSON.stringify({ … } satisfies Proposal) }); this.changed();`.
  The guard is spelled out four times, the default `{ questions: [] }` five times, the
  stringify-with-`satisfies` nine times.
- Why it matters: the rule "what a proposal is and when it may change" is nine copies of boilerplate
  around one changed field each.
- Change: two private helpers: `proposalOn(id): { row: CardRow; proposal: Proposal }` (the guard and
  the default) and `setProposal(id, p: Proposal, fields: RowUpdate = {})` (stringify, update,
  `changed()`). Each method keeps only what it changes; `retract`, `keep`, `withdrawOwn`, which
  accept other states, use `setProposal` alone.
- Win: about 30 lines; the guard and the default exist once.
- Risk: low; `board.test.ts`, `revisions.test.ts`.
- Confidence: high. All nine read.
- Done by W7: `proposalOn` (the guard and the default) and `setProposal` (the write and
  `changed()`), as proposed. `accept` takes the guard from `proposalOn` but reads the stored
  proposal without the default, since a card proposed without one keeps none once accepted;
  `unrevise` stays without the guard and answers false, as before.

### C7. Optional arguments passed by position
- Principle: KISS
- Size: moderate
- Where: `src/server/db.ts:1312` and `src/server/board.ts:1545` (`addTalk`), `db.ts:1340` and
  `board.ts:1556` (`replyTalk`), `src/server/answers.ts:177` (`ask`); call sites
  `src/server/commands.ts:360`, `:670`, `:716`, `answers.ts:98`, `:164`, `:304`, `:347`
- Now: `addTalk(said, reply, cardId, lookUp?, images = [], replyTo?, after?, askedIn?, answered?)`
  is called as `addTalk('', '', card ?? null, undefined, x.images ?? [], undefined, undefined,
  undefined, x.id)` (`commands.ts:716`) and `addTalk(text, '', null, { question: text, about:
  projectId }, images, quoted, undefined, projectId)` (`answers.ts:164`). `replyTalk(id, reply,
  lookUp?, wish?, waits = false, answers = waits)` ends in two booleans. `Answers.ask(cardId, text,
  images, spoken, replyTo?, talk?, walkthrough?)` is called as `ask(card.id, t.said, files, true,
  undefined, talkId)`.
- Why it matters: a reader counts commas to know which argument is which, and each new kind of
  exchange added another trailing parameter (`after`, `askedIn`, `answered` each arrived that way).
- Change: an options object for what is optional: `addTalk(said, reply, { card?, lookUp?, images?,
  replyTo?, after?, askedIn?, answered? })`, `replyTalk(id, reply, { lookUp?, wish?, waits?,
  answers? })`, `ask(cardId, text, { images, spoken, replyTo?, talk?, walkthrough? })`. Do it
  together with C1, which touches the same signatures.
- Win: seven call sites that read without counting; no `undefined` placeholders.
- Risk: low; type-checked. Tests call `addTalk` 14 times.
- Confidence: high. All call sites read.
- Done by W7 on its own, ahead of C1 (W8): `NewTalk` and `TalkReply` (now in `sheet.ts`), and `ask`'s options; the question looked up is a named `TalkLookUp`. The
  Commander's local `reply` takes `TalkReply` too.

### C8. State predicates are restated inline beside their helpers
- Principle: KISS
- Size: minor
- Where: `src/server/board.ts:2963`, `:2983`, `:3807` (and the variant at `:2958`); `:2424` against
  `:3792`; `:1853`, `:3579`; `row.state ?? 'planned'` at 13 places (`:1104`, `:1106`, `:2145`,
  `:2450`, `:2958`, `:2963`, `:2983`, `:3379`, `:3452`, `:3657`, `:3807`, `:3859`, `:4014`)
- Now: "work on the card has begun" is `(row.state !== 'idea' && (row.state ?? 'planned') !==
  'planned') || row.workspace`, written three times word for word (changing the repository, setting
  a new repository, showing the new repository) and once more in a variant. `atWork(r)` is defined
  at `:3792`; its body is written out again inside the filter at `:2424`. `r.landed && r.workspace`
  ("its agent finishes what remains after the landing") stands alone at `:1853` and `:3579`. A plan
  card's null state is defaulted with `?? 'planned'` thirteen times.
- Why it matters: these are the card's life-cycle conditions; scattered as boolean expressions, one
  that changes (a new state that counts as "not begun") has to be found by search.
- Change: named predicates beside `worked`/`atWork` (`:3788-3792`): `begun(row)`, `finishing(row)`
  (used by `atWork`, `:1853`, `:3579`), `stateOf(row)`; use `atWork` at `:2424`.
- Win: about ten boolean expressions become four names.
- Risk: low; `board.test.ts`.
- Confidence: high. Each expression compared character by character.
- Done by W7: `stateOf`, `begun` and `finishing` beside `worked` and `atWork`; the filter that
  restated `atWork` uses it.

### C9. Two change logs with the same three methods each
- Principle: DRY
- Size: minor
- Where: `src/server/db.ts:778-791` (`sharedChanges`, `sharedLog`, `dropSharedChanges`) and
  `:829-842` (`archiveChanges`, `archiveLog`, `dropArchiveChanges`); their consumers
  `src/server/board.ts:933-952` and `:1997-2023`
- Now: both tables are `(id AUTOINCREMENT, canvas_id, card_id)` logs filled by triggers; both are
  read as "ids changed since my cursor, the new cursor, then drop what I read". The two readers
  differ without need: `sharedChanges` selects every canvas's rows and filters in JavaScript, taking
  the cursor from the rows read; `archiveChanges` filters in SQL and takes the cursor from
  `archiveLog()`.
- Why it matters: one protocol, two spellings; a fix to one (say, how the cursor is taken) does not
  reach the other.
- Change: one private helper in `Store`, `changeLog(table: 'shared_changes' | 'archive_changes')`,
  returning `{ changes(canvasId, after), at(), drop(canvasId, upTo) }` in the SQL-filtered form;
  `readonly sharedLog = changeLog('shared_changes')`, `readonly archiveLog =
  changeLog('archive_changes')`. The triggers and tables stay as they are (no migration).
- Win: about 15 lines and one cursor rule.
- Risk: low. No test names these methods; `board.test.ts` and `share.test.ts` cover them through the
  archive search and the outdated-pages notice.
- Confidence: high. Both readers and both consumers read.
- Bug fixed (W1 of the bug plan): the `Store` empties `shared_changes` and `archive_changes` as it
  opens the database (a canvas reads both afresh when it opens), so a canvas never opened again
  leaves no rows for good; the readers stay as they were.
- Done by W7: `changeLog(table)` gives `Store.sharedLog` and `Store.archiveLog`, each
  `{ changes, at, drop }`, in the SQL-filtered form with the cursor from the log's sequence.

### C10. `changed_at` cannot be null, but is read as if it could
- Principle: YAGNI
- Size: minor
- Where: `src/server/db.ts:31-36` (type and comment), `:1119` (`coalesce(changed_at, updated_at)`);
  `src/server/board.ts:3665`, `:3696`, `:3733` (`r.changed_at ?? r.updated_at`)
- Now: `CardRow.changed_at` is `string | null`, commented "Null only on rows from before it was
  kept", with a fallback at each read.
- Why it matters: the type and comment tell a reader of a state that does not exist. It cannot occur
  because the migration that adds the column fills it in the same transaction (`db.ts:513`: `ALTER
  TABLE cards ADD COLUMN changed_at TEXT; UPDATE cards SET changed_at = updated_at;`), the only
  INSERT into `cards` (`Store.insert`, `db.ts:972`) sets it, and a database below that step is
  migrated in the constructor before any read.
- Change: type it `string`, drop the three `?? r.updated_at` and the `coalesce`, correct the
  comment.
- Win: four fallbacks and a misleading comment.
- Risk: low. The tests that insert rows by hand (`db.test.ts:174`, `:221`) do so on a schema taken
  back before that migration.
- Confidence: high. Grepped every `INSERT INTO cards` and every use of `changed_at` in `src` and
  `scripts`.

### C11. The single-demo share of before 2026-10-16 is converted twice
- Principle: YAGNI
- Size: minor
- Where: `src/server/board.ts:234-236` (`StoredShare.dir`, `.shown`), `:275` (`sharedDemos`'
  fallback); `src/server/share.ts:420-427` (second loop of `Sharing.convert`, run from `resume()` at
  every start, `canvas.ts:467`)
- Now: a page shared by v0.1.0 to v0.3.0 stored one demo as `dir` + `shown`. `sharedDemos` reads
  that shape as a list of one on every call (15 call sites), and `convert()` rewrites every such
  share into `demos: [one]`, removing `dir` and `shown`. After the first start nothing stored has
  the old shape; the fallback only serves reads between `new Board` and `sharing.resume()`
  (`board.items()` at `canvas.ts:378` and `:433`).
- Why it matters: `StoredShare` documents two fields as part of the shape that exist for the first
  seconds of the first start after an upgrade; every reader of a share goes through a fallback for
  them.
- Change: do the conversion before the first read: move the second loop of `convert` into `Board`'s
  constructor (beside `sweepUntitled`; it needs only `store.shared`, `cardDemos` and an update, all
  in board.ts), with the legacy shape as a local type there. Then `sharedDemos` is `s.demos ?? []`
  and `StoredShare` loses `dir` and `shown`.
- Win: two fields off a central type and one legacy branch off a hot path.
- Risk: medium. The conversion names the demo's handover from `cardDemos`, which looks at the disk;
  `share.test.ts:672` tests the conversion and the read before it, and must move with it.
- Confidence: medium. Start order read in `canvas.ts:312-474`; I did not trace every reader of
  shares in that window beyond `board.items()`.

### C12. The plan reference `<file>#<key>` is composed and split by hand
- Principle: DRY
- Size: minor
- Where: `src/server/board.ts` split at `:737-738`, `:2148-2155`, `:2425`, `:3147`, `:3680-3706`,
  `:1008`, beside the helper `keyOfRef` (`:3786`); composed by template literal at `:3111`, `:3157`,
  `:3273`, `:3355`, `:3490`, `:3495`, `:3520`, `:3616`, `:3618`, `:3716`; "is a project's reference"
  as `!ref.includes('#')` at `:878`, `:1000`
- Now: a workstream's reference is the doc's file, `#`, the workstream's key. `keyOfRef` extracts
  the key and is used in `follow`/`rekey`; six other places do `ref.indexOf('#')` and slice, ten
  build the string with a template literal.
- Why it matters: the format is a stored one (`cards.plan_ref`); its one rule is spelled about
  twenty times in one file.
- Change: beside `repoOfRef`/`pathOfRef` (`:3592-3603`): `docOfRef(ref)` (the file part), `keyOfRef`
  (as is), `workstreamRef(file, key)`. `workstreamKeys` (`:3147`) becomes `keyOfRef(k.plan_ref)`.
- Win: the format in three functions; about 15 expressions shorter.
- Risk: low.
- Confidence: high. Grepped `indexOf('#')`, `includes('#')` and `}#${` over `src`: only board.ts
  does this.
- Done by W7: `workstreamRef`, `docOfRef` and `keyOfRef` beside `repoOfRef`; "a project's
  reference" reads `keyOfRef(ref) === null`.

### C13. "An earlier demo still at hand" is computed twice
- Principle: DRY
- Size: minor
- Where: `src/server/board.ts:343-347` (`earlierDemos`), `:366-372` (`cardDemos`)
- Now: both take `storedDemos(r)`, build the same closure `later(i)` (the directories of the demos
  after the `i`th, with the latest one's) and keep a demo whose directory no later one reuses and
  whose file exists. `cardDemos` tests the file with `demoThere(d)`; `earlierDemos` spells the same
  test out (`existsSync(join(d.dir, d.kind === 'html' ? 'index.html' : 'demo.mp4'))`, which is
  `demoFile`, `:278`). They differ in what they return: `earlierDemos` the shown form with its index
  `n`, `cardDemos` the stored form plus the latest, without drafts.
- Why it matters: the rule for when an earlier demo can still be gone back to (a recorded behaviour)
  has two copies that must agree.
- Change: one `atHand(r): { d: StoredDemo; n: number }[]`; `earlierDemos` maps it to `{
  ...shownDemo(d), n }`, `cardDemos` to `d` plus the latest.
- Win: about 6 lines and one rule.
- Risk: low; `board.test.ts`, `share.test.ts`.
- Confidence: high.
- Done by W7: `atHand(r)`; `earlierDemos` maps it to the shown form, `cardDemos` to the stored
  one plus the latest.

### C14. "Which archived row brings this card" is written twice
- Principle: DRY
- Size: minor
- Where: `src/server/board.ts:972-1012` (`shownCards`), `:2068-2104` (`cards`)
- Now: both take rows, look each up among the items on the canvas, and for the rest decide whether
  the card is in the archive by itself or through its project. Both define the same `mine` predicate
  (`!!r && r.canvas_id === this.canvas.id && !r.deleted_at`) and the same per-call cache of parent
  rows; both re-read a row that "is neither on the canvas nor archived as read". They differ in what
  they make: `cards` builds full items through `archiveOf`, `shownCards` only `{ id, repo, title }`
  from the rows and the stored doc, to avoid building the archived cards.
- Why it matters: the rule for where a card not on the canvas is found has two copies; the cheap one
  exists for speed and has to follow every change of the full one by hand.
- Change: one private `bringers(rows): { shown: Map<id, Item>; archived: Map<id, { row: CardRow; by:
  CardRow }> }` holding `mine`, the parent cache and the re-read; `cards` and `shownCards` each make
  their result from it.
- Win: about 20 lines; one rule.
- Risk: low to medium; `share.test.ts` covers `shownCards`, `board.test.ts` covers `cards`.
- Confidence: medium-high. Both read; the two differ slightly in when they re-read the row, which
  the shared helper must keep.
- Done by W7: `bringers(rows)` returns the cards shown and, for the rest, `{ row, by }`; it
  holds `mine`, the parent cache and the re-read. `shownCards` re-reads a row with the same rule
  as `cards` now (also where its archived project is not the canvas's), which reaches the same
  result; the map it returns lists the shown cards before the archived ones.

### C15. Text limits are literals at fourteen places
- Principle: DRY
- Size: minor
- Where: `src/server/board.ts:1080-1081`, `:1139-1140`, `:1143`, `:1248`, `:1507-1508`, `:1762`,
  `:1821`, `:2731`, `:2911-2912`, `:2950-2951`, `:3024`, `:4035`; also `src/server/canvas.ts:2816`
- Now: a card's title is at most 200 characters, its text 20,000, a reason, basis or quote 2,000.
  Cards the owner writes are refused beyond that (`checkText(n.title, 'title', 200)`), cards agents
  write are cut (`p.title.slice(0, 200)`), each with the number written out.
- Why it matters: raising a limit means finding every `200` that means "title".
- Change: `TITLE_MAX`, `BODY_MAX`, `NOTE_MAX` at the top of board.ts (exported for canvas.ts), used
  at all of them.
- Win: three named limits.
- Risk: low.
- Confidence: high.
- Done by W6: `TITLE_MAX`, `BODY_MAX` and `NOTE_MAX` in `board.ts`, also used for the PR card's
  title in `canvas.ts`, the merge in `commands.ts` and the Coordinator's card title. The excerpt of
  a quoted reply (2,000) and the wish's issue title (200) are other limits and keep their numbers.

### C16. `Store.folderCards` has no caller
- Principle: YAGNI
- Size: minor
- Where: `src/server/db.ts:1685-1688`
- Now: `folderCards(folder)` returns the cards with a record in a folder; `folder.ts` uses
  `folderCard` and `setFolderCard` only.
- Why it matters: dead code on the Store's surface.
- Change: remove it.
- Win: 4 lines.
- Risk: low.
- Confidence: high. `grep -rn folderCards src scripts plugin` finds the definition alone, no test
  either.

### C17. `lesestandAt`: a German identifier, and a comment naming a method that does not exist
- Principle: KISS
- Size: minor
- Where: `src/server/board.ts:723`, `:3186-3190`, `:3198`, `:3205`, `:3209`, `:3214`
- Now: the counter of read-tree moves is `lesestandAt`, its comments say "Lesestand", and the one at
  `:3187` refers to `lesestandMoved`, which is `readTreeMoved` (`:715`).
- Why it matters: CLAUDE.md asks for English names so that English-speaking contributors can follow;
  the comment points at nothing.
- Change: rename to `readTreeAt`; "the read tree" in the comments; `readTreeMoved` at `:3187`.
- Win: one house rule kept, one dangling reference gone.
- Risk: low.
- Confidence: high. Grepped `lesestand` over `src`.

### C18. Five doubled or stranded doc comments
- Principle: KISS
- Size: minor
- Where: `src/server/board.ts:1064-1068`, `:1661-1662`, `:2967-2968`, `:3609-3613`;
  `src/server/db.ts:844-848`
- Now: `propose` and `readTalk` each carry two doc comments, an older one left above the newer. The
  inline comment at `:2967` is repeated, extended, on `:2968`. The doc comment of `tickedAhead`
  stands above `workDone`'s, while `tickedAhead` itself (`:3623`) has none. In db.ts the doc comment
  of `archiveRev` stands above `spend`'s, while `archiveRev` (`:882`) has none.
- Why it matters: in a codebase that leans on its comments, a comment on the wrong function
  misleads.
- Change: drop the older of each pair; move the two stranded ones onto `tickedAhead` and
  `archiveRev`.
- Win: five comments right.
- Risk: low.
- Confidence: high.

### C19. A background-job registry and a cookie reader, each written twice
- Principle: DRY
- Size: minor
- Where: `src/server/tag-proposal.ts:151-176` against `src/server/site-setup.ts:201-215` (clone
  list); `src/server/owner.ts:80-86` against `src/server/remote.ts:344-348` (clone list)
- Now: `TagProposals` and `SiteSetup` each keep `jobs = new Map<string, Job>()` by repository path
  with the same three steps: refuse or reuse while one runs, replace the entry when the promise
  settles, `doneWith(path)` deleting a finished one, `job(path)` returning it or null. They differ
  in the job's payload and in that a second start is returned (tags) or refused (setup). `owner.ts`
  has `cookie(req, name)`; `remote.ts` spells the same chain out for the device cookie.
- Why it matters: small, but the dialog protocol "start, poll, take in" is one idea the next such
  dialog would copy a third time.
- Change: a `Jobs<T extends { running: boolean }>` class (`start(key, initial, run)`, `get`,
  `doneWith`) in `src/server/jobs.ts`, used by both; export `cookie` from `owner.ts` and use it in
  `remote.ts`.
- Win: about 20 lines.
- Risk: low; `tag-proposal.test.ts`, `personal-site.test.ts` (the site setup), `remote.test.ts`.
- Confidence: medium-high. Both pairs read. (`tag-proposal.ts:148` also has a local `clip` beside
  `core/text.ts:4`; they cut differently, `n` characters plus ` …` against `n-1` plus `…`, and the
  text goes to an agent, so it stays.)
- Done by W6 in part: `remote.ts` imports `cookie` from `owner.ts`. The job registry was dropped:
  what the two share is `job` and `doneWith`, two one-line methods; their starts differ (a second
  start is returned or refused, the job is replaced or logs into itself while it runs), so a
  `Jobs` class would carry a switch for each and be larger than the copies.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/db.ts:395-417` the first migration (shapes of an Obeya before the release) and
  `:606-608` (`koordinator`): databases at those steps exist with users; migrations are append-only
  and each runs once.
- `src/server/board.ts:3325` `rekey` (cards keyed by a workstream's place in the doc, `#n`):
  databases written before v0.11.0 (2026-11-03) hold such keys; recorded in
  `docs/design/repositories-and-configuration.md:125`. The keys come from the plan-doc parser, so no
  SQL migration can replace it.
- `src/server/db.ts:520-559` and `:612-637` two trigger sets on the same condition (`archive_revs`
  and `archive_changes`; likewise `share_revs` and `shared_changes`): the rev is a per-canvas mark
  sent to the page, the log is consumed and dropped; neither derives from the other.
- `src/server/board.ts:1916` `Board.archived()` repeats the paging loop of `archivedPages` (`:1905`)
  and has no caller outside tests: a test seam with 53 uses.
- `src/server/board.ts:2524-2547`, `:1408`, `:1446`, `:3193` the
  `showTurns`/`showPools`/`showSettings`/`showThemes`/`showVocabulary`/`readPlanHistory` setters:
  their providers (workers, repositories, sharing) are built after the board and hold it.
- `src/server/board.ts:928-966`, `:1344-1403`, `:2600-2617` the layered caches of the outdated-pages
  notice (per-row `WeakMap`s, `pageNotes`, the look at files off the request path): each answers a
  measured cost named in its comment (hundreds of shared cards, a landing that writes dozens of
  times).
- `src/server/board.ts:2236-2306` `items()` as a chain of `withX` passes over all items: each pass
  is one concern and skips when it has nothing to add.
- `src/server/revisions.ts:230` a local `TO_OBEYA` beside the exported one in `to-obeya.ts:14`: a
  different instruction (it names `revise_proposal` and what a proposal's owner may ask), not a
  copy.
- `src/server/db.ts:921-926` `children` builds `$p0, $p1…` placeholders where newer queries use
  `json_each($ids)`: same result, not worth a change on its own.

## Bugs noticed in passing
None left: the ones found here were fixed (2026-11-10).
