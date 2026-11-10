# I: UI, the small modules, API client, strings and styles (`api.ts`, `draft.ts`, the small hooks and stores, `strings.ts`, `styles.css`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice is in good shape: the small modules each have one job, their pure logic is kept apart
from the DOM and tested, `api.ts` already funnels almost every endpoint through one `call`, and
the two string tables cannot drift in shape (the compiler checks it) and hold only 2 dead keys of
1,810. What redundancy there is, is structural: three small mechanisms (a value kept in browser
storage, a module-level store with listeners, a menu or dialog that closes on a click beside it)
are written out again in file after file instead of once. Nothing here is over-engineered; no
finding is major.

## Findings

### I1. "A value this browser remembers" is written out about twenty times
- Principle: DRY
- Size: moderate
- Where: flags stored as `'1'`: `src/ui/known.ts:4-17`, `src/ui/aside.tsx:27-33` and `:84-86`,
  `src/ui/nav.tsx:21-33`, `src/ui/keep.ts:131-154`. JSON values: `src/ui/stored.ts:6-25`,
  `src/ui/sheetWidth.ts:29-45`, `src/ui/fold.tsx:15-37`, `src/ui/setAside.ts:18-45`,
  `src/ui/seen.ts:10-27`, `src/ui/draft.ts:116-125`, `:142-150`, `:155-166`, `:189-197`,
  `src/ui/configDraft.ts:14-30`, `src/ui/keep.ts:34-50`, `src/ui/demoSeen.ts:15-54`,
  `src/ui/pasteHint.ts:14-37`, `src/ui/reach.ts:42-59`. Outside the slice the same shape in
  `src/ui/App.tsx:177-182`, `:342`, `:364`, `src/ui/phone.tsx:842-851`, `src/ui/wish.tsx:51-55`,
  `src/ui/coordinator.tsx:562-569`, `src/ui/walkthrough.tsx:206-207`, `:510`,
  `src/ui/config.tsx:1293-1326`.
- Now: each module wraps `getItem`/`setItem`/`removeItem` in its own `try { … } catch {}` and its
  own `JSON.parse(… ?? 'null')`. Three sub-patterns recur verbatim. (a) A flag: `getItem(key) ===
  '1'`
  in a try with `false` on failure, and `setItem(key, '1')`: `known`/`know`; `swipedOnce` and the
  inline write in `Aside` (word for word `known`/`know`, although `pasteHint.ts`, `skills.ts` and
  `zoom.ts` import those); `loadPinned`/`savePinned`; `leaveSheet`/`takeSheetLeft`; `useFolded` in
  `phone.tsx`. (b) Read JSON, with a fallback when missing or broken: `useStoredState`,
  `loadWidths`, `storeOf`, `loadAside`, `all` in `seen.ts`, three reads in `draft.ts`,
  `keptConfigDraft`, `takeKept`. (c) "Write the map if it has entries, else remove the key":
  `draft.ts:122-123`, `:163-164`, `:195-196`, `fold.tsx:33-34`, `setAside.ts:38-39`,
  `wish.tsx:53-54`.
  What differs between the modules is only the key, the store (local or session) and what is done
  with the value.
- Why it matters: every new remembered thing copies a try/catch pair, and the rule "a full or
  refused storage never breaks the page" holds only by convention at each site: several sites
  outside the slice call storage unguarded (`config.tsx:1293-1296`, `coordinator.tsx:562`).
- Change: one module for the plumbing. `stored.ts` already claims the job in its header ("State
  this browser keeps across reloads"); give it three plain functions that take the store:
  `readJson<T>(store, key): T | null` (null when missing or unparsable), `writeJson(store, key,
  value)`
  (removes the key for `null`, an empty array or an empty object) and `takeJson(store, key)` (read
  and remove, for `takeKept`, `takeSheetLeft`, the walkthrough's kept places). Move `known`/`know`
  there as two-liners on top (`known.ts` goes; its nine importers change one import) and use them
  in `aside.tsx`, `nav.tsx`, `keep.ts`. Storage keys and stored formats stay exactly as they are,
  since existing browsers hold them (`'1'` flags, `String(bool)` in `reach.ts`, the keys with a dot
  in `aside.tsx`). The modules keep their files: each owns a rule (what counts as seen, when a card
  stays aside); only the storage plumbing moves.
- Win: roughly 80-100 lines of try/catch and parse plumbing, one file (`known.ts`), and one place
  that knows storage can fail.
- Risk: low to medium: mechanical, but many sites. `keep.test.ts`, `demoSeen.test.ts`,
  `configDraft.test.ts`, `sheetWidth.test.ts`, `setAside.test.ts`, `seen.test.ts`, `draft.test.ts`
  pass fake stores and cover the rewritten modules.
- Confidence: high; read every module named, listed every `localStorage`/`sessionStorage` access
  in `src/ui` by grep (81 lines in 17 files).

### I2. Seven hand-rolled "module state with listeners" stores, and five listener sets in `api.ts`
- Principle: DRY
- Size: moderate
- Where: `src/ui/draft.ts:81-88`, `src/ui/pasteHint.ts:23-28`, `src/ui/skills.ts:19-24`,
  `src/ui/costs.tsx:10-25`, `src/ui/spot.ts:28-33` and `:74-83`, `src/ui/fold.tsx:8-49`,
  `src/ui/wish.tsx:44` (outside the slice); `src/ui/api.ts:409-413`, `:417-421`, `:424-428`,
  `:432-446`, `:518-522`
- Now: each module declares `const listeners = new Set<() => void>()`, a `changed`/`bump` that
  calls them, and a `subscribe` that adds one and returns its remover, to feed
  `useSyncExternalStore`. `pasteHint.ts:23-28` and `skills.ts:19-24` are the same lines (the clone
  detector lists them); `costs.tsx` and `spot.ts` write the subscribe inline in the hook;
  `fold.tsx` keeps one such store per storage key. `api.ts` has the typed variant five times
  (`onCardEvent`, `onReconnect`, `onCardEventGone`, `onNotice`, `beforeReload`): a Set, and an
  `onX(fn)` that adds and returns the remover.
- Why it matters: the same lines are re-read and re-checked in every module, with accidental
  differences (the cleanup returns `delete`'s boolean in `spot.ts:78`, `fold.tsx:45` and
  `api.ts:412`, `void` elsewhere), and every new shared state starts by copying them.
- Change: a tiny `src/ui/signal.ts`: `signal<A extends unknown[] = []>()` returning
  `{ emit(...a: A): void; on(fn: (...a: A) => void): () => void }`. The stores keep their own state
  and call `changed.emit()`; the hooks become `useSyncExternalStore(changed.on, snapshot)`. In
  `api.ts` the five sets become five signals (`export const onCardEvent = cardEvents.on`);
  `onNotice` keeps its held-notices logic around one.
- Win: about 50 lines, and one concept instead of twelve look-alikes.
- Risk: low; `draft.test.ts`, `pasteHint.test.ts`, `skills.test.ts`, `wish.test.ts` exercise the
  stores.
- Confidence: high for the duplication (all read; grepped `new Set<() => void>()` and
  `useSyncExternalStore(` across `src/ui`); medium that a helper is wanted for something this
  small, since each copy is short.

### I3. "Close on a click elsewhere or Esc" written out three more times beside `useMenuClose`
- Principle: DRY
- Size: minor
- Where: `src/ui/queue.tsx:15-30` (the hook), `src/ui/costs.tsx:61-73`, `src/ui/usage.tsx:27-40`,
  `src/ui/parts.tsx:618-631`
- Now: `useMenuClose(on, box, close, esc)` in `queue.tsx` adds a capturing `pointerdown` listener
  that closes unless the press is inside `box`, and a `keydown` one for Escape. `CostsPill`,
  `UsagePill` and the workspaces pill in `parts.tsx` each carry the same 11-line `useEffect`
  (`away`/`esc`, the same two listeners, the same cleanup) inline; the clone detector lists the
  costs/usage pair. The only difference: the inline copies call `setOpen(false)` directly, the hook
  goes through a `latest` ref. Ten call sites already use the hook (`nav.tsx:59`, `detail.tsx:2645`,
  …).
- Why it matters: four places decide how a bar menu closes; a change to that has to find the three
  that do not look like the hook.
- Change: replace each inline effect with `useMenuClose(open, ref, () => setOpen(false), true)`.
  Move `useMenuClose` out of `queue.tsx` (a feature file that `nav.tsx` imports only for this) into
  a module of its own, e.g. `src/ui/menuClose.ts`.
- Win: about 33 lines, and one definition of the behaviour.
- Risk: low; behaviour is identical (capture phase, same events). No test covers the pills' closing.
- Confidence: high; read all four, grepped `addEventListener('pointerdown'` across `src/ui`.

### I4. Three dialogs over the greyed page each restate the overlay, the box and the ✕, in CSS and in TSX
- Principle: DRY
- Size: minor
- Where: `src/ui/styles.css:529-532`, `:551-555`, `:2210-2213`; `src/ui/help.tsx:23-28` and
  `:82-83`,
  `src/ui/wish.tsx:210-215`, `src/ui/access.tsx:311-316`. Smaller blocks of the same kind:
  `src/ui/styles.css:1412-1413` = `:1941-1942` (`.c-shot .remove`, `.c-file .remove`, 12
  declarations),
  `:439` = `:486` = `:502` (`.from`), `:1328` = `:1540` = `:1600` (`.dot`)
- Now: `#help`, `#wish` and `#phone` carry the same rule for the overlay (9 declarations; `#wish`
  differs in `z-index: 61`), the same rule for `.close` (9 declarations, identical) and the same
  rule for `.box` except width and bottom padding. The four components write the same markup: a
  `div` that closes on a click on itself, a `.box` with `role="dialog"` that stops the click, a
  `button.close` with `t.close` and ✕ (the clone detector lists `help.tsx`/`wish.tsx`).
  `HowToHint` reuses `id="help"` to get the look. Of 1,946 rules only 19 groups repeat four or
  more declarations, so beyond these the stylesheet is clean in this respect.
- Why it matters: a fourth dialog copies three rules and six lines of markup; a change to how a
  dialog looks or closes (Esc, focus) is made three times.
- Change: classes `.over`, `.over > .box`, `.over .close` hold the shared rules, each dialog keeps
  its id for what is its own (width, columns, `z-index`); a small `Over` component
  (`{ id, label, onClose, boxClass?, children }`) in `help.tsx` or a file of its own renders
  overlay, box and ✕, and `Help`, `HowToHint`, `Wish`, the phone dialog use it. Merge the
  selectors of the `.remove`, `.from` and `.dot` twins into one rule each.
- Win: about 10 CSS rules and 20 lines of markup; one dialog shell.
- Risk: low to medium: `#phone` closes on `pointerdown` on the overlay itself, the others on
  `click` with `stopPropagation` in the box; the shell has to keep one of the two for all (both
  behave the same for the owner) or take it as a prop. No tests; check by screenshot.
- Confidence: high; compared the rules mechanically (identical declaration sets) and read the four
  components.

### I5. The dark palette is written twice, and nothing keeps the copies in step
- Principle: DRY
- Size: minor
- Where: `src/ui/styles.css:40-49` and `:50-59`; `:2045` and `:2046`
- Now: the dark values of all 30-odd custom properties stand once under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` (the system's choice)
  and once more, identical, under `:root[data-theme="dark"]` (the owner's choice); the territories'
  six values likewise on two lines. `styles.test.ts` checks only `user-select` prefixes.
- Why it matters: a colour changed in one block and not the other shows only to owners who chose
  "dark" explicitly, or only to those who follow the system: easy to miss, since the developer
  sees one of the two.
- Change: two reasonable shapes. (a) `theme.ts` always sets `data-theme` to the look in effect
  (the owner's choice, else `matchMedia('(prefers-color-scheme: dark)')`, following its `change`),
  with one inline line in `index.html` setting it before the stylesheet paints; then the media
  block goes and `:root[data-theme="dark"]` is the single definition. (b) `light-dark()` per
  colour with `color-scheme` switched by `data-theme`; it folds only the colours, not the shadows
  (they differ in structure) nor the territories' numbers. I would take (a): one block, all values.
  If neither is wanted, a test in `styles.test.ts` that the two blocks are equal removes the risk
  at no cost.
- Win: 11 lines, and the possibility of the two looks drifting apart.
- Risk: medium for (a): the page's first paint and the pages shown in frames must still follow the
  system before the script runs; no test covers it. Low for the test alone.
- Confidence: high that the blocks are identical (compared mechanically); medium on the best fix.

### I6. `api.ts`: the canvas prefix, the raw fetches and the socket sends are each spelled out many times
- Principle: DRY
- Size: minor
- Where: `src/ui/api.ts:73`, `:86`, `:90`, `:146`, `:242`, `:244`, `:253`, `:256`, `:379` (prefix);
  `:49-51`, `:307-310`, `:313-316`, `:321-323`, `:367-369` (fetch + `refused`); `:456`, `:472`,
  `:491`,
  `:498`, `:511`, `:653` (socket sends); `:93-98` (path encoding)
- Now: (a) `` `/api/c/${encodeURIComponent(canvas)}` `` is written nine times: `at`, `cardAt` and
  `whereAt` each build it, and six endpoints that address another canvas build it again.
  (b) `send` only takes JSON bodies, so the five calls with another body (`download`, `uploadImage`,
  `uploadFile`, `localImage`, `voice`) each repeat `const res = await fetch(…); await refused(res);`
  and the cast of `res.json()`. (c) `ws.send(JSON.stringify({ … } satisfies ClientMessage))` behind
  a
  `readyState === WebSocket.OPEN` check appears six times, and "the page's socket" is chosen three
  ways (`sockets.get(canvasId) ?? sockets.get(EVERY)` twice, `?? [...sockets.values()][0]` once).
  (d) `answerFile` and `cardFile` both encode a path segment by segment and append `?download`.
- Why it matters: small, but this is the file every endpoint is added to, and the copies are where
  variants creep in (the third way of picking the socket).
- Change: `const on = (canvas: string, path = '') => …` as the one place that builds the prefix,
  `at = (p) => on(canvasId, p)` and `cardAt`/`whereAt` on top; a `raw(path, init)` (= fetch +
  `refused`) that `send` and the five others use; `tell(ws, m: ClientMessage): boolean` (sends when
  open) and `mainSocket()`; one `filePath(path, download)` for the two file addresses.
- Win: about 25 lines; one way to address a canvas, to throw a refusal, to send a client message.
- Risk: low; `api.test.ts` covers `everyCanvasHeard` only, the transport helpers have no tests.
- Confidence: high; read the file completely. For the record: `api.ts` restates no type of
  `src/core/types.ts` (its own `Heard`, `Where`, `Field`, `SiteHow`, `CanvasFeed`, `EveryCanvas`
  have no twin there), and every method of `api` has a caller (each checked by grep).

### I7. `stateLabel` is one conditional expression of 67 lines, nested five deep
- Principle: KISS
- Size: minor
- Where: `src/ui/strings.ts:4481-4548`
- Now: the label of a card's state is a single chain of `? :` over snoozed, pausing, question,
  prototype end, paused, restart-paused, finishing, idea, queue, waiting, in PR, proposal, stopped.
  The top-level alternatives sit at one indentation and their nested ones at three others, and the
  indentation does not follow the nesting throughout (`:4520-4529` against `:4530-4548`), so which
  `:` closes which `?` has to be counted.
- Why it matters: this is the table every card's label comes from and it grows with each new state
  (snooze, restart pause, review cards were added to it); a condition put at the wrong depth still
  compiles and reads plausibly.
- Change: a function with early returns in the same order (`if (i.snoozed) return …; if (i.pausing)
  return t.pause.pausing; if (i.kind === 'question') return …`), the three inner groups (paused,
  restart-paused, queue) as small local functions. Behaviour and order stay.
- Win: no lines, but the order of precedence becomes readable top to bottom.
- Risk: low to medium; `strings.test.ts` checks two of the branches only, so the rewrite needs a
  table test of the labels first.
- Confidence: high.

### I8. How long a confirmation and its "Undo" show is defined twice, and the copies differ
- Principle: DRY
- Size: minor
- Where: `src/ui/api.ts:126-129` (`undoShownMs`, `confirmShownMs`), `src/ui/tell.tsx:18` (`ACK_MS =
  7000`), `:36-37`
- Now: `voice.tsx:348-349` times a command's line with `undoShownMs(undoMs)` (`undoMs - 400`) and
  `confirmShownMs(undoMs)` (`max(7000, undoMs + 1500)`), both defined in `api.ts`. `useAck` in
  `tell.tsx` times the other line above the microphone with its own `Math.max(0, undoMs - 400)` and
  a fixed `ACK_MS` of 7000.
- Why it matters: the 7 s and the 400 ms are one rule in two places, and they have drifted:
  `useAck` hides its line after 7 s even when the undo window is longer (see Bugs).
- Change: `useAck` uses `undoShownMs(undoMs)` and `confirmShownMs(undo ? undoMs : 0)`;
  `confirmShownMs` takes its 7000 from `ACK_MS`. Move the two helpers from `api.ts` (they are
  presentation timing, not transport) to `tell.tsx` beside `ACK_MS`.
- Win: one rule; the drift goes.
- Risk: low; it lengthens one line's stay from 7 s to 9.5 s in the one case with a longer window
  (taking a workspace, `App.tsx:1048`), which is what `voice.tsx` does already.
- Confidence: high; grepped `undoShownMs|confirmShownMs|ACK_MS|7000` across `src/ui`.
- Bug fixed: `useAck` keeps its line for `ackLasts(undo, undoMs)` = the longer of `ACK_MS` and the
  undo window; the drift from `confirmShownMs` (1.5 s after the window) remains for this finding.

### I9. The fields of a kept draft are listed three times in `draft.ts`
- Principle: DRY
- Size: minor
- Where: `src/ui/draft.ts:46` (`type Kept`), `:47-55` (`keptOf`), `:143-145` (`keepDrafts`); `:191`
  (`updateDraftAt`)
- Now: `Kept` picks `text | images | picks | reply | files | pasted | findings`; `keptOf`
  destructures
  the same seven and rebuilds the object with a conditional spread per field; `keepDrafts`
  destructures the same seven from what was stored and rebuilds a `Draft` with another conditional
  spread per field, while `updateDraftAt` does that same job as `{ ...EMPTY, ...saved[key] }`. The
  same file also repeats `el.setRangeText(…); el.dispatchEvent(new Event('input', { bubbles: true
  }))`
  at `:344-345`, `:389-390`, `:483-484`, and `toObeya` (`:211`) restates a clause of `lasting`
  (`:92`).
- Why it matters: a new kept field (the list grew to seven one at a time) must be added in three
  places, and forgetting the one in `keepDrafts` drops it silently on reload.
- Change: in `keepDrafts` write `drafts.set(key, { ...EMPTY, ...saved })`, as `updateDraftAt` does
  (what was stored is the pruned `Kept` already); `keptOf` stays the one place that prunes. A local
  `setText(el, piece, start, end)` for the three range edits; `lasting` calls `toObeya(key)`.
- Win: one of three lists, and about 6 lines.
- Risk: low; `draft.test.ts` covers keeping and taking back drafts.
- Confidence: high; read the file completely.

### I10. The string tables import the API client, in a cycle
- Principle: KISS
- Size: minor
- Where: `src/ui/strings.ts:5` and `:4561-4562`, `src/ui/api.ts:5`, `src/ui/costs.tsx:8`
- Now: `strings.ts` imports `ApiError` from `api.ts` for the one `instanceof` in `failText`;
  `api.ts` imports `setCostsShown` from `costs.tsx`, a component file, to pass on the server's
  `costs` message; `costs.tsx` imports `money` and `t` from `strings.ts`. So strings → api → costs →
  strings, and whoever imports the tables loads the WebSocket client with its top-level timers and
  listeners (`api.ts:493-515`, behind a `typeof document` guard).
- Why it matters: the load order works only because each use is inside a function; the tables are
  the module everything imports and should depend on nothing that runs.
- Change: move `failText` (2 lines) from `strings.ts` to `api.ts`, beside `ApiError`, whose text it
  is; `api.ts` then imports `errorText`/`t` from `strings.ts`, and `strings.ts` no longer imports
  `api.ts`. The 14 files that use `failText` change an import.
- Win: the cycle, and the tables' only dependency on running code.
- Risk: low; type check and `strings.test.ts`.
- Confidence: high; read the three import lists.

### I11. Dead entries in the tables and the stylesheet
- Principle: YAGNI
- Size: minor
- Where: `src/ui/strings.ts:421` and `:2659` (`repoPick.label`), `:529` and `:2752`
  (`folder.discarded`);
  `src/ui/styles.css:724-727` (`.build-on`), `:1752` (`.cfg-add-repo`), `:32`, `:45`, `:55`
  (`--waiting-rgb`);
  `src/ui/usage.tsx:41-46`
- Now: no code reads `t.repoPick.label` or `t.folder.discarded` (discarding an idea says
  `t.idea.discarded`); no TSX, TS or HTML names the classes `build-on` or `cfg-add-repo`; no rule
  and no script reads `--waiting-rgb`. In `UsagePill`, `const faced = plans` aliases the list under
  a comment about a distinction that no longer exists; the face maps `faced`, the list `plans`.
- Why it matters: little, but dead texts get translated and kept in step with the other table.
- Change: delete the two keys in both tables, the four CSS rules with their comment, the variable
  in its three blocks, and `faced` (use `plans`).
- Win: about 14 lines.
- Risk: low.
- Confidence: high. Method: listed all 1,810 leaf keys of the table by importing it, searched
  `src`, `scripts`, `plugin`, `app` for each path, resolved aliases (`const c = t.config.demo`), and
  for tables read by computed key checked that they are `satisfies Record<Union, …>` (the compiler
  rejects extra keys) or read each access; listed all 881 classes of the stylesheet, searched
  `src/ui` and `src/core` for each as a token, and checked every class built by concatenation
  (`s-`, `by-`, `q-by-`, `step-`, `ev-`, `d-`, `dep-`, `idea-`) against the values its code can
  produce.

### I12. Generic button texts repeated under several keys
- Principle: DRY
- Size: minor
- Where: `src/ui/strings.ts`, both tables: "Abbrechen"/"Cancel" under `folder.cancel`,
  `coordinator.cancel`, `config.settings.share.cancel`, `setup.git.cancel`; "Entfernen" under
  `superseded.remove`, `coordinator.remove`, `access.remove`, `shots.remove`; "Kopiert" under
  `cardNumber.copied`, `talk.copied`, `config.personal.copied`, `setup.copied`; "Herunterladen"
  under `answer.download`, `files.download`, `update.download`; "Schließen (Esc)" under `close`,
  `diff.close`, `shots.close`; the host labels in `config.settings.siteSetupHosts`/`siteSetupNotes`
  and again in `config.personal.hosts`/`notes`
- Now: 62 German texts stand under more than one key (92 extra entries). Most are short words
  that mean different things in their places ("Obeya" as author, button and title; "Idee" as kind
  and state) and are rightly separate. The ones named above are the same button or the same label
  in several places, while the tables already have shared top-level entries for exactly this
  (`t.close`, `t.undo`, `t.gotIt`, `t.dismiss`).
- Why it matters: a wording change to "Cancel" is made in eight lines; small.
- Change: top-level `cancel`, `remove`, `copied`, `download` beside `close` and `undo`, used at
  those sites; `diff.close` and `shots.close` use `t.close`; the personal site's and the repository
  site's host pickers read one `hosts`/`hostNotes` table. Leave the rest.
- Win: about 30 lines over both tables.
- Risk: low; the type check finds every reader of a removed key.
- Confidence: medium: the duplicates are exact (compared mechanically), but whether two places
  should share a text is a wording decision; the owner may prefer contextual keys.

### I13. "Does this browser run on Obeya's machine" asked and held three times
- Principle: DRY
- Size: minor
- Where: `src/ui/reauthenticate.tsx:6-8`, `:23-28`, `:88-94`; `src/ui/folderPick.tsx:9-11`, `:19-26`
- Now: `Reauthenticate` and `CodexLogin` each hold `here` (`useState(() => !phoneView())`) and the
  same effect that awaits the page-wide `onThisMachine()` promise behind a `live` flag (the clone
  detector lists the pair). `FolderPick` has the same construction around `pickerHere()`.
- Why it matters: three copies of "a promise asked once per page, read into state unless unmounted".
- Change: `useAsked(ask: () => Promise<boolean>, start: boolean): boolean` in one of the two files
  (or beside the storage helpers), used by all three.
- Win: about 12 lines.
- Risk: low; no tests on these components.
- Confidence: high.

### I14. `useRepoChoice` spells the card's new repository out three times
- Principle: DRY
- Size: minor
- Where: `src/ui/repoPick.tsx:33`, `:37`, `:42`
- Now: `item.newRepo ? { path: item.newRepo.path, canvas: item.newRepo.canvas } : null` appears as
  the state's start, inside `stored`, and in the effect that takes the server's pick.
- Why it matters: a third field of a new repository would have to be added three times in one hook.
- Change: `const saved: FreshRepo | null = item.newRepo ? { … } : null;` once at the top.
- Win: two long expressions.
- Risk: low.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/ui/strings.ts:2305-2307` two tables of 2,100 lines each: the English one is typed `Strings =
  typeof de`, so they cannot differ in shape, and the enum-keyed sub-tables are `satisfies
  Record<Union, …>`.
- `src/ui/seen.ts:7-8,12,25` reads the phone's former key `obeya-phone-seen`: a browser that last
  opened Obeya before 2026-10-17 still holds it.
- `src/ui/address.ts:14-22,42-48` reads `?c=<canvas>&card=<id>`: bookmarks and links from before
  path addresses.
- `src/ui/draft.ts:399-436` `withoutPasted` and `withoutWords` look alike but treat whitespace
  differently on purpose (a pasted text is a paragraph, a path a word on a line).
- `src/ui/territory.ts:54`, `:267-272` its own `len` and `r1`: both commented as measured hot paths;
  the file is dense but one algorithm.
- `src/ui/recorder.ts:29-45` the deprecated ScriptProcessor path: WebKitGTK's MediaRecorder delivers
  empty recordings (header comment, checked 2026-10-08).
- `src/ui/sw.ts:9-17` the service worker types its own global by hand and repeats `obeya-pushed`
  from `reach.ts`: the server serves the function's source as `/sw.js`, so it can import nothing.
- `src/ui/zoomBox.ts`, `src/ui/panelHeight.ts`, `src/ui/barFit.ts`, `src/ui/sheetWidth.ts`,
  `src/ui/fitHeight.ts`: the size modules share no mechanism (a zoom box, a thrown panel, a bar that
  hides steps, a clamped width, a text box's height); each is pure arithmetic with its own tests.
- `src/ui/switch.ts`, `src/ui/selection.ts`, `src/ui/answer.ts`, `src/ui/configDraft.ts`: tiny, but
  each is one tested concept with several importers or a test file; they earn their files
  (`known.ts` is the exception, see I1).
- `src/ui/api.ts:705-737` `useCanvas` holds eight `useState`s for one feed: each message sets one,
  and a switch of canvas seeds each from `start`; one reducer would not be shorter.
