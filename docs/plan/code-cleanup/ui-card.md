# G: UI, the app shell and the card (`App.tsx`, `detail.tsx`, `parts.tsx`, `message.tsx`, `composer.tsx`, `markdown.tsx`, `diff.tsx`, `files.tsx`, `cite.tsx`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The small files of this slice (message.tsx, composer.tsx, markdown.tsx, cite.tsx, diff.tsx,
files.tsx) are in good shape: one job each, little state, no dead code worth naming. The weight is
in two functions: `Canvas` in App.tsx (2,045 lines, about 120 hooks) and `Detail` in detail.tsx (600
lines, four card kinds through early returns), which hold most of what a reader has to keep in their
head. Around them the same small things are written out again and again (the host side of an open
card in App.tsx and phone.tsx, reading a card's diff, first-use flags, click-away menus), and
parts.tsx has become five unrelated modules in one file.

## Findings

### G1. `Canvas` is one 2,045-line component with about 120 hooks
- Principle: KISS
- Size: major
- Where: `src/ui/App.tsx:229-2273` (sections by its own banner comments: items 252-337, camera
  339-374, focus and panels 376-519, edits 521-557, open/close 559-782, kept across a restart
  784-862, the address 864-959, acknowledged actions 961-1099, voice 1101-1274, pointer 1276-1721,
  keys 1723-1869, render 1871-2272)
- Now: one function holds 40 `useState`, 9 `useLive`, 43 `useRef`, 31 `useEffect`, 14 `useMemo`, 12
  `useCallback` and about 60 inner functions. Everything closes over everything: `closeCard` (672)
  reads `focusRef`, `panelRef`, `openDraft`, `edit`, `unfolded`, the address chain and the camera;
  the keys handler (1768-1864) reads 15 pieces of state. Because effects and callbacks must see
  current values, most state is doubled by a ref (`useLive` nine times, plus 14 hand-rolled
  latest-refs, G13). Sub-machines that have nothing to do with each other sit side by side as loose
  variables: optimistic positions (`moved`, `folded`, `pending`, `underway`, `notesMoved` and two
  reconciling effects, 254-318), the archived cards the page holds (`archivedById`, `archivedKids`,
  `archivedCame`, `learnArchived`, `forgetArchived`, the refresh effect, 457-496), the address chain
  (869-959), drawing waits (G9), marking and the colour ring (1339-1381, 1424-1442), the sheet grip
  (1464-1488), six first-use flags (G11).
- Why it matters: no part can be read, changed or tested alone; a change to opening a card means
  checking the address, the restart memory, voice and the keys handler in the same closure. Nothing
  in `src/ui/*.test.ts` covers `Canvas`; only the pure modules it calls (camera, keep, address,
  selection, deps) have tests, so every edit is verified by hand in the browser.
- Change: keep `Canvas` as the place where camera, focus and the open panel meet, and move each
  self-contained machine into a hook or component in a file of its own, in this order (each step
  alone is behaviour-preserving and leaves the file working):
  1. `useOptimisticItems(snapshot, dragRef)` → `{ items, itemsRef, setMoved, setFolded, setPending,
     underway, setUnderway, planDirs, setNotesMoved }` (254-323).
  2. `useArchivedCards(snapshot.archive, openIds)` → `{ byId, kidsOf, learn, namedBy }` (457-496,
     908-914).
  3. `useCardEdits` shared with the phone (G3).
  4. `useAddress({ canvasId, openNow, open, close… })` holding `addressChain`, `stepBack`,
     `addressSet`, `addressOpens`, `addressCloses`, `followAddress` and the popstate effect
     (869-959).
  5. the acknowledged actions (`startCard`, `archiveCard`, `archiveProject`, `startAll`, `arrange`,
     `collapse`, `keepWorkspace`, `takeWorkspace`, `preparePlanDoc`, 965-1099) into
     `useCanvasActions(showAck, fail, …)` (with G12).
  6. waits drawn by hand into a component (G9); marking, lasso and ring into `useMarking(placed)`;
     the grip into `useSheetGrip`.
  What remains is camera, focus, open/close, pointer and keys: about 900 lines.
- Win: `Canvas` falls to under half its size; six concepts get a name, a file and the chance of a
  test; about 15 mirror refs go because the hooks own their state.
- Risk: high in total, low to medium per step. Nothing tests `Canvas`; each step needs a pass in the
  headless browser (open/close a card, Back/Forward, restart memory, drag, lasso, draw and remove a
  wait). `hooks.test.ts` guards hook order.
- Confidence: high that the split is possible along these lines (the sections already carry banners
  and touch each other through a handful of names: `focusRef`, `camRef`, `itemsRef`, `open`,
  `closeCard`, `showAck`, `fail`); I read the whole function, I did not try the extraction.

### G2. `Detail` renders four kinds of card through early returns and some twenty booleans
- Principle: KISS
- Size: major
- Where: `src/ui/detail.tsx:124-728`
- Now: `Detail` computes everything any kind might need (124-193), then returns early for a Question
  card (194-204), an idea (205-215) and an ended prototype (216-238), and for everything else
  (proposal, planned, queued, working, review, done, stopped, prototype, review card) goes on to
  derive `worked`, `fresh`, `waits`, `shares`, `sharing`, `project`, `ideaCard`, `builtOn`,
  `ideaThinking`, `planning`, `buildable`, `pr`, `direct`, `review`, `running`, `archivable`,
  `halted`, `onPrototype`, `rest`, `readPlan` and the JSX fragments `shareBox`, `buildOn`,
  `prototypeActions`, `approveButton`, `where`, `queueBox`, `brief` (239-424), which the 300-line
  return (426-727) combines in conditions such as `review ? prototypeActions || approveButton :
  (running || (halted && !item.archivedAt)) && prototypeActions` (707). The task's layout is one of
  three (`waits ? … : worked ? … : …`, 503-628), and the action row exists twice, for a card nobody
  worked on (633-681) and one somebody did (684-721), each with its own Start, Later, prototype
  actions and Delete.
- Why it matters: which buttons a card shows in a given state can only be found by evaluating a
  dozen flags by hand; the two action rows have to be kept in step (Start appears four times, Delete
  three, G18). `hooks.test.ts` exists because the early returns make hook order fragile here.
- Change: make `Detail` what `IdeaView`, `QuestionView` and `ProposalView` already suggest: a
  dispatcher that owns `error`, `run`, `act` and the repository lookup, renders the shared head (G5)
  and hands over to one view per kind. Add `EndedPrototypeView` (216-238) and `TaskView` (239-727);
  inside `TaskView` lift three components out of the body: `QueueBox` (361-411), `TaskResult` (the
  left column of the worked split, 526-606, which takes `shareBox`, the demo flags and the PR boxes
  with it) and `TaskActions` (633-724, one row built from a list of the actions that apply, in place
  of two parallel rows). The prototype flags (267-292) go into a `usePrototype(item, all, from)` or
  a `PrototypeActions` component; the approve button already is one for review cards
  (`ApproveReview`) and becomes `ApproveButton` for all three variants (300-320).
- Win: `Detail` shrinks to about 60 lines; no view computes what it does not show; one action row
  instead of two; the early returns below hooks go.
- Risk: medium. Pure restructuring of JSX, but the conditions are subtle (which row a stopped
  prototype gets, say); nothing renders `Detail` in a test. Check each card state in a scratch Obeya
  (`scripts/scratch-obeya.ts` stages them).
- Confidence: high; read completely. Not tried.

### G3. The host side of an open card is written twice, for the canvas and for the phone
- Principle: DRY
- Size: moderate
- Where: `src/ui/App.tsx:522-557` and `src/ui/phone.tsx:368-386` (edit buffer);
  `src/ui/App.tsx:653-669` and `src/ui/phone.tsx:447-461` (`onDone`); `src/ui/App.tsx:756-769` and
  `src/ui/phone.tsx:462-474` (`deleteOpen`)
- Now: `Detail` asks its host for `onEdit`, `flush`, `onDone`, `onDelete`. Both hosts implement them
  by hand. The edit buffer is the same code line for line: `edit` ref of `{ id, patch, timer }`,
  `flushEdit()`, `onEdit` merging the patch and saving 400 ms after typing stops, a flush before a
  reload. `onDone` is the same sequence (close, `showAck` or mark under way, `showWait` with the
  capitalised `pending`, then `showAck(d.ackFor?.(r) ?? d.ack, d.undo)` or `t.cardError`); it
  differs only in how "under way" is kept (a record in App, an array in the phone) and in App
  logging a non-`ApiError`. `deleteOpen` clears the buffer, closes, removes and acknowledges with
  restore in both.
- Why it matters: CLAUDE.md's rule that an interaction several views share is built once applies
  here; the debounce, the "actions wait for the save" promise and the pending-approval protocol must
  behave the same on both, and today a fix to one (the console.error, say) misses the other.
- Change: `src/ui/cardHost.ts` with `useCardEdits(openId: () => string | undefined)` → `{ onEdit,
  flush, drop }` (the buffer, the 400 ms timer, the flush on `beforeReload`) and `settleAction(d, p,
  { close, showAck, showWait, underway: (card, what | null) => void })` for `onDone`. App keeps what
  is its own (`openDraft`, naming an untitled card on close); the phone keeps `back()`.
- Win: about 45 duplicated lines go; one definition of how a card's edits are saved and how a
  pending approval is confirmed.
- Risk: low; `flush` ordering is what matters (actions await it), and both copies already agree.
- Confidence: high; both places read side by side. phone.tsx belongs to slice H, which may report
  the same pair.
- Bug fixed: the phone's address follows an open card that moved to another canvas (an effect on the
  snapshots and on Back/Forward, not the notice's `movedTo`); `wish` stays the desktop's only.

### G4. A card's diff is read in five places, with three different lists of when to read it again
- Principle: DRY
- Size: moderate
- Where: `src/ui/diff.tsx:22-31` (`Branch`), `src/ui/files.tsx:32-44` (`useChange`),
  `src/ui/folder.tsx:22-37` (`useFolderDiff`), `src/ui/diff.tsx:116-131` (`DiffView`),
  `src/ui/files.tsx:474-485` (`Changes`); wired in `src/ui/detail.tsx:167, 346, 562-566`
- Now: three hooks read the light diff "again as the work moves on": `Branch` on `[id, state, need,
  statusLine, workspace, summary]`, `useChange` on `[id, state, need, summary, workspace, files]`,
  `useFolderDiff` on `[id, state, need, statusLine, summary, noChange, asked]` plus a 5 s poll while
  working. For a folder card `Detail` reads once (`useFolderDiff`) and hands the result to
  `FolderLine`, `FolderBox` and `ResultFiles`; for a git card `Branch` and `ResultFiles` each read
  for themselves, so the same `GET …/diff` goes out twice on every change of state, and `Branch`
  alone again on every status line. The full diff (`api.diff(id, true)`) is read by `DiffView` and
  by `Changes`, each with its own `null | 'failed'` state; `Changes` reads the whole patch again for
  every file switched to "Changes" (its `FileView` is keyed by path and revision).
- Why it matters: when the diff is stale is one piece of knowledge kept in three dependency arrays
  that already disagree; the clone detector's pair `diff.tsx:26-31 <-> files.tsx:37-42` is the
  visible tip.
- Change: one `useCardDiff(item, { on, poll })` in `diff.tsx` (the union of the dependencies, the
  poll for folders) called once in `Detail` for git and folder cards alike, its result passed to
  `Branch` (which keeps only `open`), `FolderLine`, `FolderBox` and `ResultFiles` (whose `diff` prop
  becomes required; `useChange` goes). One `useFullDiff(id)` → `CardDiff | null | 'failed'` for
  `DiffView` and `Changes`. `folder.tsx`'s copy button becomes `diff.tsx`'s `CopyPath` (G17).
- Win: two hooks and about 30 lines go; one request instead of two per change on a git card; one
  rule for when the change is read again.
- Risk: medium. `Branch` takes the full diff from `DiffView` through `onRead` to correct its size;
  that setter has to move with the state. No tests; check a git card and a folder card while a
  worker runs.
- Confidence: high for the duplication (all five read); medium that the union of dependencies is
  harmless (it re-reads slightly more often for `ResultFiles`).

### G5. Head, state line and text block of a card are written out per kind
- Principle: DRY
- Size: moderate
- Where: head (kind, title): `src/ui/detail.tsx:197-200, 208-209, 219-222, 428-429`; state line:
  `223-226, 430-445, 882-888, 1019-1023`; the card's text: `453-460, 490-497, 508-515, 617-618`; the
  repository lookup: `166, 173, 245, 297`
- Now: each of the four returns of `Detail` renders `p-kind` and `p-title` itself, and four places
  render `<div className="p-state">● {stateLabel(item)} … <Limited/> {archivedOn(item)}</div>` with
  small differences in between (the snooze, the status line, "thinking", the answer count). The
  task's text is `editable ? <ManualFields item repos choice onEdit …/> : <><Body
  md={item.body}/><Shots ids={item.images}/></>` three times, differing only in `fresh` and `grow`,
  plus a fourth read-only copy. `p.repos.find((r) => r.id === item.repo)` is evaluated four times
  under three names (`inFolder`, `shares`, `repoRef`, and inline for `repo`).
- Why it matters: this is the case CLAUDE.md names ("no card kind gets its own variant"): a change
  to the state line (a new marker such as `limitedUntil`) must be made in four places, and the lines
  already differ without saying why (the task's wears `paused` for `item.paused ||
  item.restartPaused || item.snoozed`, the idea's for a snooze only, the question's never).
- Change: `CardHead({ item, kind, editable, onEdit })` and `StateLine({ item, label?, children })`
  (class names and the `Limited`/`archivedOn` tail inside, the kind's own status as children), used
  by all views; `const text = (o: { fresh?: boolean; grow?: boolean }) => editable ? <ManualFields
  …{...o}/> : <CardText item={item}/>` once in the task view; `const repoRef = …` once at the top of
  `Detail`.
- Win: about 50 lines; one state line.
- Risk: low; markup stays identical if the differences are passed as children. `styles.test.ts` does
  not cover it; compare screenshots of the four kinds.
- Confidence: high; all sites read.

### G6. An open card loads and follows its log two or three times
- Principle: KISS
- Size: moderate
- Where: `src/ui/detail.tsx:3249-3295` (`useEvents`), callers `src/ui/detail.tsx:1338`
  (`Conversation`), `src/ui/detail.tsx:3311` (`LastFailure`), `src/ui/phone.tsx:909`
  (`CardTalkButton`)
- Now: `useEvents(cardId)` fetches `GET …/events` (`api.ts:327`, no cache), merges what is pushed
  while it loads, subscribes to three feeds and reloads on reconnect. `LastFailure` is rendered for
  every task (`detail.tsx:486`) and calls it unconditionally, although `explainedFailure` only looks
  at the last event of a planned, unqueued card; `Conversation` calls it again, and on the phone the
  talk button a third time. Each instance keeps its own copy of the list and its own race handling.
- Why it matters: 50 lines of careful merge logic run two or three times per open card for one list;
  the copies can momentarily disagree (the failure box and the conversation's `explained` flag at
  1389 are meant to name the same event).
- Change: `Detail` calls `useEvents(item.id)` once and provides it through a small context
  (`CardLog`) that `Conversation` and `LastFailure` read; the phone's `CardTalkButton` takes the
  list from the same provider, lifted to where the phone renders `Detail` and the button.
  `useEvents` itself stays as it is.
- Win: one fetch and one subscription per open card instead of two or three; `explainedFailure`
  reads one list.
- Risk: low; `Conversation` is always rendered inside `Detail`. The phone's button sits outside
  `Detail`, so the provider goes one level up there.
- Confidence: high; grep for `useEvents` over `src`, `scripts`, `plugin` finds these three callers
  only.

### G7. `DemoView` mixes versions, the player, zoom, full screen, comments and autoplay in 300 lines
- Principle: KISS
- Size: moderate
- Where: `src/ui/detail.tsx:1827-2125` (with `useWatching` 2155-2188, `useSeekKeys` 2203-2217)
- Now: one component with 6 `useState` (`now`, `shape`, `shownN`, `autostart`, `started`, `slot`), 5
  refs (`video`, `artifact`, `playFrom`, `shownLatest`, `firstShown`), 6 effects and four custom
  hooks. It decides which of the card's demos shows (`shownN`, `show`, `showsVersions`, 1856-1866,
  1916-1929), runs the "start by itself once" rule (1869-1884), builds the player (1899-1913),
  handles the jump to a commented place (1931-1951), and renders the versions bar, the HTML
  artifact, the video with its start and comment buttons, the portal of zoom and full-screen
  buttons, and the chapters. Two refs (`shownLatest`, `firstShown`) exist only to tell "first
  render" from "changed".
- Why it matters: the HTML-artifact case uses a fraction of this (no video, no zoom, no chapters
  playing) but runs all of it behind `demo.kind === 'html'` checks (1869, 1902, 1914, 1985); the
  autoplay rule is spread over three effects and two refs.
- Change: split along what already separates: `DemoView` keeps which demo shows (`useShownDemo(item,
  latest)` → `{ demo, shownAt, all, show, playFrom }`) and renders `DemoVersions` (1956-1984), then
  either `<iframe>` for an artifact or `DemoPlayer({ cardId, demo, src, autoplay, comments, playFrom
  })`, which owns `video`, `started`, `shape`, `now`, `slot`, zoom, full screen, seek keys, watching
  and the chapters. Keyed by the demo shown, `DemoPlayer` mounts afresh on a version change, which
  replaces the `firstShown` effect (1931-1951) by its mount.
- Win: the artifact path loses all video machinery; two refs and one effect go; each half fits on a
  screen.
- Risk: medium; the autoplay and "new handover waits behind the play button" behaviour (demoSeen.ts
  has tests, the component has none) must be checked in the browser with a visible page (CLAUDE.md:
  a hidden tab never autoplays).
- Confidence: medium; read completely, the keyed-remount simplification is untested.

### G8. parts.tsx is five modules in one file
- Principle: KISS
- Size: moderate
- Where: `src/ui/parts.tsx:1-1664`; also `src/ui/message.tsx:124-230, 354`
- Now: the header says "Presentational pieces of the canvas", and the file holds: the card's face
  and `CardView` (56-309); `CanvasAgents`, used only by the navigation (317-357); the top bar's
  pills for restart, update, source, old Bun and workspaces (359-840, 480 lines, `WorkspacesPill`
  alone 230); `ProjectView` with its head-fit hook and menu (842-1095); the geometry and drawing of
  links and waits (1097-1313, pure functions with their own tests in `parts.test.ts`); the project
  sheet (1315-1531), which loads history and plan docs through `api` and so is not presentational;
  `Edges` and `Minimap` (1533-1664). In the same way message.tsx carries `Body` (the markdown
  renderer nine files import), `useReportedHeight` (an iframe helper used by detail.tsx and
  files.tsx) and the `Cards` context beside the message frame.
- Why it matters: the file's name says nothing about where a thing is; `detail.tsx` imports
  `landedRef`, `PauseMark`, `PlayMark`, `shownTitle` from "parts" and the navigation its
  `CanvasAgents`; every change to a pill rebuilds the reader's map of 1,600 lines.
- Change: move, without changing code: `links.tsx` (linkPath, linkCurve, linkShifts, linkSpot,
  Links, DepLinks, depWidth, depHead; `parts.test.ts`'s link tests follow), `pills.tsx`
  (Restart/Update/Source/OldBun/Workspaces pills), `project.tsx` (ProjectView, HeadMenu, useHeadFit,
  Sheet, startableIn, arrangeable), `CanvasAgents` to `nav.tsx`; `parts.tsx` keeps the card face,
  `CardView`, `Edges`, `Minimap` and the small marks. `Body` moves to `markdown.tsx` beside `Doc`,
  `useReportedHeight` to a `frame.ts` in `src/ui`.
- Win: no line less, but five files of 200-500 lines with names that say what is in them.
- Risk: low; moves and import updates, the type checker finds every miss.
- Confidence: high.
- Bug fixed: the minimap colours a card by `shownState`, as the card and the collapsed project's
  marks do.
- Done by W20 as moves: `links.tsx` (with `links.test.ts`), `pills.tsx`, `project.tsx`,
  `CanvasAgents` in `nav.tsx`, `Body` in `markdown.tsx`, `useReportedHeight` in `frame.ts`.

### G9. Drawing waits by hand lives inside `Canvas` as loose state and 60 lines of one-line JSX
- Principle: KISS
- Size: moderate
- Where: `src/ui/App.tsx:1290-1336, 1386-1422, 1504-1519, 1597-1602, 1946-1978, 2002-2004,
  2046-2050`; markers also in `src/ui/parts.tsx:1295-1299`
- Now: the owner's arrows between cards are six pieces of state in `Canvas` (`connection`, `handle` +
  `handleRef`, `depKnown`, `removing`, `pendingRemovals`), five functions (`showHandle`,
  `connectable`, `keepDependency`, `removeDependency`, `resolveLoop`), two effects, branches at the
  top of `onPointerDown` and `onPointerMove`, and JSX written as single lines up to 600 characters
  long: the trash button per arrow (1949-1958), the loop button (1960-1972), an IIFE for the ghost
  arrow (1977), the four dots per card (2002-2004). The arrow-head marker (`viewBox="0 0 9 8"`,
  `M0,0 L9,4 L0,8 z`, width 6, height 6·8/9) is defined in `DepLinks` and twice more here.
  `!removing.some((x) => x.key === …)` is written three times (1880, 1882, 1949), and bounds are
  looked up with `placed.find` (1950, 1961, 1977) although `at` (1886) is the map for it.
- Why it matters: this is the least readable stretch of the file and it sits in the middle of the
  pointer handlers every other gesture shares.
- Change: `src/ui/depDraw.tsx` beside `deps.ts`: `useDepDrawing({ placed, items, camRef, showAck,
  fail })` → `{ connection, handle, removing, onDown, onMove, cancel, remove, hint }`, and
  components `ManualEdges` (trash buttons, loop buttons, ghost; children of `DepLinks`) and
  `ConnectionDots`; one `ArrowMarker({ id, className, refX })` in `links.tsx` used by all three.
  `Canvas` calls `dep.onDown(e)`/`dep.onMove(e)` first in its handlers.
- Win: about 150 lines leave `Canvas`; the feature can be read in one file.
- Risk: medium; the removal with a held "Undo" (1394-1417, pagehide flush 1315-1328) is delicate;
  `deps.test.ts` covers the pure part only.
- Confidence: high.

### G10. The click-away closer is written out three times beside `useMenuClose`
- Principle: DRY
- Size: minor
- Where: `src/ui/parts.tsx:619-631` (`WorkspacesPill`), `src/ui/costs.tsx:61-73` (`CostsPill`),
  `src/ui/usage.tsx:28-40` (`UsagePill`); the hook: `src/ui/queue.tsx:16-30`
- Now: each pill has the same 11-line effect: while open, a `pointerdown` (capture) outside its box
  or Escape closes it. `useMenuClose(open, ref, () => setOpen(false), true)` does exactly that and
  nine other menus use it.
- Why it matters: three copies of a listener pair that must change together (touch handling, say).
- Change: replace each effect by the one call; move `useMenuClose` out of `queue.tsx` (a queue file
  is an odd home for it) to a `menu.ts`.
- Win: about 30 lines.
- Risk: low; identical behaviour (the hook reads `close` through a ref, the copies close over
  `setOpen`).
- Confidence: high; compared line by line.
- Done by W20 with I3 and H10: `menu.ts`.

### G11. Eleven hand-rolled first-use flags
- Principle: DRY
- Size: minor
- Where: `src/ui/App.tsx:439, 442, 445, 1308, 1344-1345` with their setters at `1349-1350,
  1514-1515, 1681-1682, 1701-1702, 1811-1812, 1859-1860`; `src/ui/cite.tsx:118, 203-204`;
  `src/ui/zoom.ts:82`; `src/ui/shots.tsx:406`; `src/ui/coordinator.tsx:136`;
  `src/ui/walkthrough.tsx:858`
- Now: every hint that shows until used once is `const [xKnown, setXKnown] = useState(() =>
  known(KEY))` and, where it is used, `if (!xKnown) { know(KEY); setXKnown(true); }`. `known.ts`
  offers only the two storage functions.
- Why it matters: CLAUDE.md requires such a hint for every new feature, so the pattern keeps being
  copied; six of the eleven sit in `Canvas`.
- Change: `useKnown(key): [boolean, () => void]` in `known.ts` (state from `known(key)`, the setter
  calls `know` and sets it); each site becomes `const [depKnown, knowDep] = useKnown(DEP_KNOWN)` and
  `knowDep()`.
- Win: about 25 lines and six `useState` in `Canvas`.
- Risk: low.
- Confidence: high; all eleven read.
- Done by W20: `useKnown` in `stored.ts` (`known.ts` went with I1).

### G12. Ten "try, act, acknowledge, else fail" wrappers in `Canvas`
- Principle: DRY
- Size: minor
- Where: `src/ui/App.tsx:965-972, 975-982, 985-993, 999-1007, 1013-1031, 1045-1052, 1059-1074,
  1092-1099, 1369-1381, 1424-1432`; archive with undo also `src/ui/detail.tsx:2890`
- Now: `startCard`, `archiveCard`, `archiveProjectNow`, `unarchiveProject`, `startAll`,
  `takeWorkspace`, `arrange`, `preparePlanDoc`, `assignGroup`, `deleteGroup` are each `try { await
  api…; showAck(…) } catch (e) { fail(e) }`. "Archive, acknowledge with the title, undo unarchives"
  is spelled three times (977-978, 987-989, detail 2890).
- Why it matters: seven lines of ceremony around one or two lines of meaning, ten times.
- Change: `const attempt = (fn: () => Promise<unknown>) => fn().catch(fail)` beside `useAck`'s
  `fail`; each becomes `attempt(async () => { await api.archive(i.id); showAck(…); })`. An
  `archiveWithUndo(i)` in one place for the three.
- Win: about 40 lines.
- Risk: low; `keepWorkspace` (1037-1044) and `collapse` (1077-1085) have their own catch and stay.
- Confidence: high.

### G13. Fourteen latest-value refs by hand beside `useLive`
- Principle: DRY
- Size: minor
- Where: `src/ui/App.tsx:77-78, 261-262, 296-297, 328-329, 387-388, 786-787, 945-946, 994-996,
  1087-1089, 1206-1207, 1232-1236, 1725-1726, 1767-1768`; the same pair in
  `src/ui/composer.tsx:116-117`, `src/ui/parts.tsx:865-866`, `src/ui/queue.tsx:17-18`; `useLive` at
  `src/ui/App.tsx:2363-2371`
- Now: `const xRef = useRef(x); xRef.current = x;` appears 14 times in App.tsx, four of them only to
  build a stable callback for a memoised child (`archiveProjectRef` → `archiveProject`, `openRef` →
  `openCard`, `pressRef` → `holdToTalk`, `letGoRef`). Across `src/ui` the pair occurs about 35
  times.
- Why it matters: two lines and a second name per value, and the reader has to check each time that
  the ref really is assigned on every render.
- Change: two three-line hooks in a `src/ui/latest.ts`: `useLatest(value)` → ref, and
  `useStable(fn)` → a callback with a fixed identity that calls the latest `fn`. `const openCard =
  useStable((i: Item) => void open(i).catch(console.error))`.
- Win: about 20 lines in App.tsx, more elsewhere; goes mostly away on its own where G1 moves state
  into hooks.
- Risk: low.
- Confidence: high.

### G14. What kind a card is, is derived twice with different tests
- Principle: DRY
- Size: minor
- Where: `src/ui/detail.tsx:175-190, 197`; `src/ui/parts.tsx:183-185`
- Now: both walk the same chain to a label: workstream, idea, `becomesLabel(item)`, prototype,
  project, question. `CardFace` tests an idea with `item.idea || item.proposal?.idea`, `Detail` with
  `item.state === 'idea' || item.proposal?.idea`; `CardFace` puts a review card's `t.review.kind(…)`
  first and lets `item.label` replace everything, `Detail` prefixes a workstream with its project's
  title and label and handles the question in its early return.
- Why it matters: a new kind of card needs both chains, and the differing idea test means a card
  with `item.idea` in another state is "Idea" on its face and nothing in its sheet (drift or intent,
  the code does not say).
- Change: `kindLabel(item): string` in `strings.ts` beside `becomesLabel` for the common chain
  (question, idea, becomes-project, prototype, project); `CardFace` and `Detail` add their own
  prefix (label, review kind, project title) around it. Decide the idea test once.
- Win: one chain instead of two.
- Risk: low to medium: the two idea tests must be reconciled, which is a visible (if tiny) decision;
  keep both behaviours behind a parameter if in doubt.
- Confidence: medium; I did not establish whether a card can have `item.idea` outside state `idea`.

### G15. The field under a conversation is configured per card kind in three near-identical literals
- Principle: DRY
- Size: minor
- Where: `src/ui/detail.tsx:910-926` (idea), `1027-1041` (question), `1124-1136` (proposal),
  `3005-3015` (task); `TalkField` at `3060-3079`
- Now: `Talk` is the shared conversation-plus-field, as CLAUDE.md asks. Its `field` object is
  spelled out per kind: each has `onWords: (words, images, replyTo) => onTell(words, images,
  <field>, replyTo)` and `onPicked: (text, _, images, replyTo) => act({ action: <action>, text,
  images, ...(replyTo ? { replyTo } : {}) }, { close: false })`, differing only in the pair
  (`'discuss'`/`discuss`, `'note'`/`ask`, `'revise'`/`revise`) and the placeholder. Idea and
  question both fork on `item.archivedAt ? <Talk item past /> : <Talk item field=… />`.
- Why it matters: the rule "words alone go through `onTell`, words with picks go as the kind's
  action" is one rule written three times.
- Change: `wordsField(placeholder, field: Field, action: 'discuss' | 'ask' | 'revise', listener?)`
  beside `TalkField`, building the object from `onTell` and `act`; `Talk` takes `readOnly` (or the
  views pass `field={item.archivedAt ? undefined : …}`, since `Talk` without a field already renders
  the conversation alone, with `past` derived).
- Win: about 25 lines; one place for the rule.
- Risk: low.
- Confidence: high.

### G16. A review card's four decisions and the "unsent" filter are each written several times
- Principle: DRY
- Size: minor
- Where: `src/ui/detail.tsx:2278-2296` (four buttons), `2394` (route → label), `2370-2374`
  (`useUnsentDecisions`), `2385` (same filter again), `162-164` and `761` (`heldUp`)
- Now: `Findings` writes the buttons for `contributor`, `self`, `later`, `drop` one by one, each
  with `className={\`choice${picks[f.id] === r ? ' on' : ''}\`} aria-pressed=… onMouseDown=…
  onClick={() => pick(f, r)}`; `DecidedChip` maps the same four routes to the same four labels in a
  ternary. `DecidedChip` filters `decided` by "finding still open and undecided" although its only
  caller (`Talk`, 3097-3098, 3133) passes the result of `useUnsentDecisions`, which applied that
  filter. "A decision that holds the merge up" (`route === 'contributor' || route === 'self'`) is
  computed in `Detail` (as ids) and again in `ApproveReview` (as a boolean).
- Why it matters: a fifth route, or a change to what holds a merge up, has four places.
- Change: `const ROUTES: { route: ChangeRoute; label: string; hint?: string }[]` (labels from
  `t.review`) mapped in `Findings` and looked up in `DecidedChip`; drop the filter at 2385; `const
  holdsUp = (r: ChangeRoute) => r === 'contributor' || r === 'self'` used by both.
- Win: about 20 lines.
- Risk: low; `self` keeps its `disabled`/`selfOff` special case.
- Confidence: high; `DecidedChip` has one caller (grep).

### G17. "Copied, for a moment" exists three times, and the path button twice
- Principle: DRY
- Size: minor
- Where: `src/ui/copy.ts:6-14` (`useCopy`), `src/ui/message.tsx:177-188` (`Code`),
  `src/ui/cardNumber.tsx:26-36` (`CardNumber`); `src/ui/diff.tsx:101-108` (`CopyPath`) and
  `src/ui/folder.tsx:54, 84-90`
- Now: `Code` and `CardNumber` each keep `done: 'copied' | 'selected' | null`, a timer ref cleared
  on unmount and an async `copy` around `copyOrSelect` (the clone detector's pair
  `cardNumber.tsx:26-31 <-> message.tsx:178-183`). `useCopy` is a third variant that uses the
  clipboard API only (so it does nothing on an insecure origin, where `copyOrSelect` still works)
  and never clears its timer. `FolderLine` re-implements `CopyPath` inline with the same hook, class
  names and strings.
- Why it matters: three behaviours for one gesture; the weakest one is used for workspace paths,
  share links and the setup's commands.
- Change: `useCopied(ms)` in `copy.ts` → `[done, copy(text, el)]` on top of `copyOrSelect` with the
  timer handled once; `Code` and `CardNumber` use it; export `CopyPath` and use it in `FolderLine`.
  Moving `useCopy`'s five callers onto `copyOrSelect` changes behaviour on insecure origins (for the
  better) and is a separate decision.
- Win: about 20 lines.
- Risk: low.
- Confidence: high.
- Bug fixed: `useCopy` copies through `copyText`, which runs `copyOrSelect` on an element of its own
  out of sight, so its callers copy on an insecure origin too.
- Done by W20: `useCopied` in `copy.ts`, `CopyPath` shared. `useCopy` stays for texts that are not
  on the page (it copies from an element of its own).

### G18. Start, Dequeue and Delete are written out once per situation in `Detail`
- Principle: DRY
- Size: minor
- Where: `src/ui/detail.tsx:361-411` (queue box), `640-649, 686-706` (Start), `675-677, 715-719,
  998-1000` (Delete)
- Now: the queue box has three branches (paused, workspace, behind) that each end in the same
  `<QueuePlace item items/>` and the same Dequeue button inside `div.actions`. A start button
  wrapped in `<StartOn item act>` appears four times, differing in label and hint
  (`t.start`/`t.startHint`, `t.landedPart.start`, `t.startAgain`, the new-repository variant). The
  danger Delete button appears three times.
- Why it matters: local, but it is what makes G2's action rows long.
- Change: in the queue box compute the text per branch and render `QueuePlace` and the buttons once;
  `StartButton({ item, act, label, hint, disabled? })` for the four; one `DeleteButton`.
- Win: about 35 lines.
- Risk: low.
- Confidence: high.

### G19. A project's actions are decided twice, on its card and in its sheet
- Principle: DRY
- Size: minor
- Where: `src/ui/parts.tsx:958-964` (`ProjectView`), `src/ui/parts.tsx:1447-1481` (`Sheet`)
- Now: `ProjectView` builds `acts` (arrange when `state !== 'done' && (arranging ||
  arrangeable(kids))`, start all when `startableIn(kids) > 0`, archive when done). `Sheet` shows the
  same three with the same conditions restated in JSX, with long labels and a hint line each.
- Why it matters: a fourth project action or a changed condition has two places.
- Change: `projectActs(item, kids, on)` returning `{ key, icon, short, long, hint, disabled, run
  }[]`; the head renders `short`, the sheet `long` + `hint`.
- Win: one list of conditions; about 15 lines.
- Risk: low; the sheet's extra conditions (`!project.archivedAt`, the "done" paragraph, Unarchive)
  stay in the sheet.
- Confidence: high.

### G20. Leftovers in detail.tsx, App.tsx and parts.tsx
- Principle: YAGNI
- Size: minor
- Where and now:
  - `src/ui/detail.tsx:3066, 3127`: `TalkField.noImages` — no field literal sets it (grep: the only
    `noImages` given anywhere is `PrototypeStart`'s own `Composer`, 1267).
  - `src/ui/detail.tsx:3009`: the placeholder table's `discuss: ''` and `revise: t.compose.revise`
    can never be read: `ownerField` (`talk.ts:467-471`) returns only `note | answer | feedback |
    demo`; they exist because its return type is the wider `Field`.
  - `src/ui/detail.tsx:2411, 2426-2432, 2480, 599`: `PrBox`/`HeldText` take `card` and `save`, and
    the one caller passes `save: (body) => api.act(item.id, { action: 'editHeld', body })`, the call
    `saveHeld` (2467-2471) makes itself from the card id.
  - `src/ui/detail.tsx:2191`: `const forTheVideo = plainKey`, an alias with one use (2208).
  - `src/ui/parts.tsx:1232`: `stepOpacity` is exported and used only in the file.
  - Doc comments left behind by code that moved or went: `src/ui/detail.tsx:791-794` (IdeaView's,
    stranded above `SupersededBox`'s), `1281` ("A workstream as the owner picks it", nothing
    follows; its function went in 2c3e1719), `1535` ("Who wrote the task…", now `taskAuthor` in
    `core/types.ts:318`); `src/ui/App.tsx:170` (Splash's, stranded above `KEPT_CANVASES`);
    `src/ui/parts.tsx:28-30` (three comments stacked on `shownState`: the first belongs to
    `landedRef` at 43, the second repeats the third).
- Why it matters: each is a question a reader stops at.
- Change: drop the field and the prop; narrow `ownerField`'s return type to `'note' | 'answer' |
  'feedback' | 'demo'` and delete the two entries; `HeldText` calls `api.act(card, { action:
  'editHeld', body })`; use `plainKey` directly; un-export `stepOpacity`; delete or re-home the
  comments.
- Win: about 20 lines, six stale comments.
- Risk: low.
- Confidence: high; each grepped over `src`, `scripts`, `plugin`.

### G21. Archive list and search are two booleans kept exclusive by hand
- Principle: KISS
- Size: minor
- Where: `src/ui/App.tsx:390-391, 424-426, 739, 751, 791, 841, 925, 1832-1833, 2079-2103`
- Now: `aOn` and `sOn` (each a `useLive`) "drop down from the bar one at a time" (424) and "never
  show at once" (750). `toggleArchive`/`toggleSearch` close the other; `closeProject` checks
  `!sOnRef.current` before `setAOn(true)`; `openAddress` (925) sets `aOn` without looking at the
  search.
- Why it matters: an invariant of one variable spread over two, with one path that does not keep it.
- Change: `const [drop, setDrop, dropRef] = useLive<'archive' | 'search' | null>(null)`; `aOn`/`sOn`
  become `drop === 'archive'`/`'search'`.
- Win: one `useLive` and the cross-checks go.
- Risk: low to medium: `openAddress` on Back/Forward to an archived card while the search is open
  would now close the search; confirm that is wanted.
- Confidence: medium; the mutual exclusion is stated in the comments, the `openAddress` path I only
  read, not ran.
- Bug fixed: `openAddress` closes the search before it opens the archive's list.

### G22. A folder's change row is laid out twice
- Principle: DRY
- Size: minor
- Where: `src/ui/diff.tsx:316-347` (`ChangeTable`), `src/ui/files.tsx:265-307` (`Line`)
- Now: both build the same row from a `FolderChange`: `name = (p) => (dir ? p + '/' : p)`, `from →
  path` for a move, the `MARK` sign, `ChangeNote`, and `+added`/`−removed` when `added !== undefined
  && (added > 0 || removed > 0)`. They differ in what a click does (scroll to the file inside the
  open diff; pick a tab or open the diff) and in `Line`'s caption.
- Why it matters: small; the path format and the "has lines" rule are stated twice.
- Change: `changePath(c)` and `hasLines(c)` in `core/diff.ts` (or `diff.tsx`), used by both.
- Win: about 6 lines; one format.
- Risk: low.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/ui/message.tsx:124-169` and `src/ui/markdown.tsx:246-288` `Body` and `Doc` both switch over
  the eight block types: two looks (a chat message keeps line breaks and blank lines, shows headings
  as bold lines and code with a copy button; a document uses real headings and marks a workstream).
  Every case differs, a shared renderer would be a flag per case.
- `src/ui/detail.tsx:1608-1618` `Linked` links addresses in plain state lines without reading them
  as markdown; it shares only the scheme-stripping with `markdown.tsx:57`.
- `src/ui/detail.tsx:2898-2908, 2930` `ManualTitle`/`ManualFields` keep local state beside the prop:
  the server's echo must not overwrite what is being typed (commented).
- `src/ui/parts.tsx:307-308, 1083-1094` hand-written `memo` comparators: `els` and `kids` change
  identity every render; the stable callbacks in App.tsx exist for them.
- `src/ui/parts.tsx:1368-1369` `Sheet` sets `opening` during render: the documented React pattern
  for state derived from a prop change, and the count must be right in the same render.
- `src/ui/App.tsx:1901-1915, 2139-2143, 2246-2248` the talk button rendered twice: a hidden copy
  keeps its room in the bar (commented).
- `src/ui/composer.tsx:42-61` `fitField` measures by mutating styles: the layout cannot be had from
  CSS (buttons stack by the text's height).
- `src/ui/cite.tsx:67-109` module-level `framed` and one global listener: one marking at a time
  across all `CiteButton`s.
- `src/ui/detail.tsx:3190-3192` `useOpenQuestions` round-trips the questions through JSON: a stable
  identity for `useMemo` when the snapshot brings equal questions as new objects.
