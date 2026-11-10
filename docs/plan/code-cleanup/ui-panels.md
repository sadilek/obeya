# H: UI, panels and the phone (`config.tsx`, `phone.tsx`, `coordinator.tsx`, `setup.tsx`, `walkthrough.tsx`, `voice.tsx`, `talk.ts`, `shots.tsx` and the smaller panels)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice is in decent shape at the leaves (`walkthrough.tsx`, `voice.tsx`, `groups.tsx`,
`snooze.tsx`, `wish.tsx` and `queue.tsx` are tight, and literal copy-paste is rare), but two files
carry most of the debt. `config.tsx` writes one form pattern out by hand about twenty times (load on
open, call, show the error, poll a job, a segmented radio control), although `coordinator.tsx`
already has the hook that would hold it. `phone.tsx` is one 616-line component, and it repeats the
desktop page's plumbing for the open card (`App.tsx`) instead of sharing it. No file of the slice
has a component test except through `talk.test.ts`, `archive.test.ts`, `search.test.ts`,
`voice.test.ts` and `wish.test.ts`, so most changes below are protected only by a check in the
browser.

## Findings

### H1. The phone and the desktop page each carry the open card's plumbing
- Principle: DRY
- Size: moderate
- Where: `src/ui/phone.tsx:368-386` and `src/ui/App.tsx:521-530,546-557` (debounced edits);
  `src/ui/phone.tsx:447-461` and `src/ui/App.tsx:653-669` (`onDone`); `src/ui/phone.tsx:462-474` and
  `src/ui/App.tsx:756-769` (`deleteOpen`); `src/ui/phone.tsx:427-434` and `src/ui/App.tsx:1179-1196`
  (`onNotice` → `told.show`); `src/ui/phone.tsx:395-399` and `src/ui/App.tsx:1199-1204`
  (`draftFor`/`fieldFor`)
- Now: Both pages keep `edit = useRef<{ id; patch; timer }>`, `flushEdit()` and `onEdit(p)` with the
  same 400 ms debounce, word for word but for where the open card's id comes from (`openRef.current`
  on the phone, `focusRef.current?.id` on the desktop) and the desktop's extra `openDraft.current`
  bookkeeping. Both have `onDone(d, p)` with the same sequence (close, `showAck`, mark the card
  under way, `showWait` with the capitalised `d.pending`, then `showAck(d.ackFor?.(r) ?? d.ack,
  d.undo)` or `showAck(t.cardError(...))`); they differ in how the card closes and in the shape of
  `underway` (`string[]` on the phone, `Record<card, what>` on the desktop). Both turn a `Notice`
  into the same `Heard` literal with five conditional spreads (`token`, `undoMs`, `talk`, `inCard`;
  the desktop adds `project`). Both have `fieldFor` as "the target's draft if its field is on the
  page, else `MIC_DRAFT`".
- Why it matters: CLAUDE.md says the phone follows the desktop. Today a change to how edits are
  saved, to what a notice carries or to the confirmation after an action has to be made twice, and
  nothing fails when one side is forgotten.
- Change: (1) `useCardEdits(openId: () => string | undefined)` in a new `src/ui/cardEdits.ts`
  returning `{ onEdit, flush, drop }` (`drop` is what both `deleteOpen`s do by hand: clear the
  timer, forget the patch); the desktop wraps `onEdit` to keep `openDraft`. (2) `heardOf(n: Notice):
  Heard` beside `noticeLine` in `src/ui/tell.tsx`, used by both `onNotice` handlers. (3)
  `followDone(d, p, { close, showAck, showWait, underway: { add, remove } })` in `tell.tsx` for the
  shared tail of `onDone`. Leave `draftFor` where it is (the two differ in substance) and share only
  `fieldFor = (key) => (key && fieldOn(key) ? key : MIC_DRAFT)`.
- Win: about 60 lines, and one definition of "an edit of the open card" and "a notice as a line".
- Risk: medium. No test renders `App` or `Phone`; `tell.test.ts` covers `noticeLine` only. `heardOf`
  gives the phone the `project` field too, which its `inView` does not read (the phone has no
  project sheet).
- Confidence: high. Read both sides of every pair listed.
- Bug fixed ([bugs noticed in passing](../bugs-noticed-in-passing.md) W2): the phone's address
  follows an open card that moved to another canvas, by an effect of its own (`followOpen`), not
  through the notice handler.

### H2. The settings sheets write "load, call, show the error" out by hand about twenty times
- Principle: DRY
- Size: moderate
- Where: `src/ui/config.tsx:730-759` (LanguageBlock), `789-809` (ThemeBlock), `828-843`
  (UsageBlock), `859-874` (CostsBlock), `894-912` (AgentsBlock), `1020-1040` (DemoBlock `save`,
  `install`), `1328-1337` (PersonalSiteBlock `act`), `1584-1591` (VoiceBlock `install`), `2281-2288`
  (SiteSetupRow), `2381-2389` (TagProposal), `2463-2480` (ShareSettings `go`), `2613-2624` (Problem
  `retry`), `2666-2677` (TrustCommands `go`), `2717-2730` (AdapterSetup `go`);
  `src/ui/setup.tsx:133-141`, `259-272`, `387-395`, `467-478`, `575-595`; `src/ui/access.tsx:50-60`,
  `186-194`; the hook that exists: `src/ui/coordinator.tsx:421-433` (`useAct`)
- Now: Each block declares `const [status, setStatus] = useState('')` (often with `busy`), loads its
  view with `useEffect(() => { if (on) api.x().then(setView, console.error); }, [on])` (6 times in
  `config.tsx`), and wraps every call in `setStatus(''); try { setView(await api.y(...)); } catch
  (e) { setStatus(failText(e)); }` with `setBusy(true/false)` around it (`config.tsx` has 17
  `failText(e` and 17 `setStatus('')`/`setError('')`). `coordinator.tsx` has exactly this as
  `useAct(fail?) → [error, act]`, used by five rows there; `PersonalSiteBlock` and
  `RecognitionDetail` each re-invent it locally as `act`. `UsageBlock` and `CostsBlock` are the same
  component twice: they differ only in the two API calls and the string table (`t.usage.setting` /
  `t.costs.setting`).
- Why it matters: the pattern is the bulk of every small block, so each new setting copies 25 lines;
  the copies already drift (some reset the status before the call, some not; some disable while
  busy, some not; `finally` versus a trailing `setBusy(false)`).
- Change: move `useAct` to `src/ui/act.ts` and let it also report `busy` (`{ error, busy, act }`,
  `act` resolving to whether the call succeeded, which `PersonalSiteBlock` needs). Add
  `useLoaded(on, load)` → `[view, setView]` for the load on open. Use both in the blocks above.
  Replace `UsageBlock` and `CostsBlock` by one `ToggleSetting({ on, load, save, text })` rendered
  twice.
- Win: roughly 150 lines in `config.tsx`, `setup.tsx` and `access.tsx`; one twin component gone.
- Risk: low to medium. No tests on these components; the behaviour to keep per block is small (which
  message class shows the error: `hint c-status` or `p-error`; `failText`'s `detail` list).
- Confidence: high. Read every block; grepped `useAct`, `failText(e`, `const act = async`.

### H3. `Phone()` is one 616-line component that does six jobs
- Principle: KISS
- Size: major
- Where: `src/ui/phone.tsx:165-781`
- Now: One function holds the history steps of card and conversation (`steps`, `step`, `stepBack`,
  `openId`, `back`, `openTalk`, `closeTalk`, `home`, the `popstate` handler, `leavesCard`, `looked`;
  185-297, 316-322), the set-aside store (325-338), the open card's edits (368-386, see H1),
  push-to-talk and confirmations (389-444), the "machine not answering" banner (477-509), the
  half-sheet layout (553-568) and the five lists with their swipe hints (633-676), with 11
  `useState`s, 16 refs and 20 effects, six of the refs mirrors of a state for use in callbacks
  (`snapsRef`, `openRef`, `talkRef`, `allRef`, `obeyaRef`, `pttRef`). The two renders (a card open,
  the lists) share only `banner` and `voice`.
- Why it matters: to change the lists a reader has to get past 450 lines of history, keyboard and
  voice; the history logic, the one part that is a real state machine, cannot be read or tested on
  its own.
- Change: keep `Phone` as the shell and pull out, in the same file or `src/ui/phone/`:
  `usePhoneSteps({ addressWith, resolve, beforeLeave: flushEdit })` → `{ open, talk, openId, back,
  home, openTalk, closeTalk }` (the history state machine; its pure part, "which history call for
  which stack of steps", becomes testable); `useQuiet(quietSince)` → the banner node; `<PhoneHome>`
  for 633-780 (the five lists, taking `all`, `snaps`, `aside`, `underway` and the open/talk
  callbacks) and `<PhoneCardPage>` for 570-631. With H1's `useCardEdits` the edits leave too.
- Win: no line count to speak of; `Phone` drops to about 150 lines and the history steps become one
  unit.
- Risk: high. No test renders the phone view; the refs are shared across the parts (`allRef` and
  `obeyaRef` feed `addressWith`). Needs the checks with `bun scripts/android-phone.ts` (Back,
  Forward, reload on a card and on its conversation, a tapped push).
- Confidence: medium. Read the whole function; did not trace every caller of the refs.

### H4. `ConfigDialog` keeps the canvases in three parallel arrays
- Principle: KISS
- Size: moderate
- Where: `src/ui/config.tsx:138`, `151`, `205-212` (`draft`, `origin`, `keys`), `158-164` (`load`),
  `299-319` (`addCanvas`, `setCanvas`, `moveCanvas`), `97-118` (`KeptCanvases`, `pinned`), `127-134`
  (`checkedMoved`)
- Now: a canvas of the draft is three things at the same index: its `CanvasConfig` in `draft`
  (state), the id it had when loaded in `origin` (state) and its React key in `keys.current` (a ref,
  re-made in render when `loads` or the length changed, 208-212). Adding, removing and moving a
  canvas each update all three by hand (`moveCanvas` also re-indexes `checked`), `load` and the
  kept-draft branch (239-243) set two of them, and `pinned` zips and unzips `draft`/`origin`.
- Why it matters: every operation on the list has to remember all arrays; the render-time re-keying
  (`keyed.current !== loads || keys.current.length !== draft.length`) exists only to repair them
  getting out of step. `ConfigDialog` has 23 pieces of state and refs, and these account for the
  tangle.
- Change: one state `rows: { key: number; origin: string | null; canvas: CanvasConfig }[]`; `draft`
  is derived (`rows.map((r) => r.canvas)`) for the API calls and the `changed` comparison.
  `addCanvas`/`setCanvas`/`moveCanvas` become one array operation each, `pinned` maps rows, the
  `keys`/`nextKey`/`keyed` refs go. What is written to sessionStorage stays `{ draft, origin }`
  (convert at `keepConfigDraft`/`keptConfigDraft`), so a draft kept across a restart still reads.
- Win: about 30 lines and three refs; the "kept in step by hand" rule goes.
- Risk: medium. `configDraft.test.ts` covers the storage only; the dialog itself has no test. Check:
  add, remove, reorder canvases with a repository's settings folded open, reload mid-edit.
- Confidence: high. Read every use of `draft`, `origin`, `keys`.

### H5. The segmented radio control is written out ten times
- Principle: DRY
- Size: moderate
- Where: `src/ui/config.tsx:814-820`, `1351-1357`, `1889-1895`, `2071-2077`, `2126-2132`,
  `2141-2147`, `2196-2205`, `2268-2274`; `src/ui/access.tsx:71-85`, `138-156`
- Now: each is `<div className="seg" role="radiogroup" aria-label={label}>{options.map((x) =>
  <button key type="button" role="radio" aria-checked={value === x} className={value === x ? 'on' :
  undefined} onClick={() => set(x)}>{name(x)}</button>)}</div>`. They differ in the option list, the
  label of an option, and whether the buttons are `disabled`.
- Why it matters: seven lines of ARIA wiring per control, easy to get subtly different
  (`aria-checked` and the `on` class must agree); a new choice copies them again.
- Change: `Seg<T>({ label, options, value, name, onChange, disabled? })` beside `Field` in
  `config.tsx` (exported, as `Field` and `Head` are for `access.tsx`). The `tablist` at
  `config.tsx:1717` and `repoPick.tsx:88` are other roles and stay.
- Win: about 60 lines.
- Risk: low. Pure markup; a screenshot of each section shows a slip.
- Confidence: high. Grepped `role="radiogroup"` and `className="seg"` in `src/ui`.

### H6. "Follow a job until it ends" is seven copies of one interval
- Principle: DRY
- Size: minor
- Where: `src/ui/config.tsx:1006-1010`, `1317-1321`, `1576-1580`, `2252-2256`, `2368-2372`;
  `src/ui/setup.tsx:246-250`; `src/ui/agentPick.tsx:166-170` (and the same idea with a `live` flag
  in `src/ui/access.tsx:25-35`, with a chained timeout in `src/ui/setup.tsx:117-131`)
- Now: `useEffect(() => { if (!on || !running) return; const timer = setInterval(() =>
  api.x().then(setView, console.error), 1500); return () => clearInterval(timer); }, [on,
  running])`, with 1000, 1500 or 2000 ms.
- Why it matters: the copies differ in whether an answer that arrives after the effect ended is
  dropped (`access.tsx` guards, the others do not) and in whether polls may overlap (`setup.tsx:117`
  chains them "one check at a time", the others do not).
- Change: `usePoll(active: boolean, poll: () => Promise<unknown>, ms: number)` in `src/ui/act.ts`
  (H2), chaining the next poll after the last one answered; the seven effects become one line each.
- Win: about 25 lines, one answer to "may polls overlap".
- Risk: low. Chaining instead of a fixed interval changes the rhythm only when the server is slower
  than the interval.
- Confidence: high. Grepped `setInterval(` in `src/ui` and read each.

### H7. `MILESTONE` restates three dozen message starts by hand
- Principle: DRY
- Size: moderate
- Where: `src/ui/talk.ts:59-60`; its siblings `src/ui/talk.ts:273-297`; `src/core/types.ts:1114`
  (`started`); the texts in `src/core/messages.ts` (e.g. 77-79, 112, 128, 152, 163, 299-301, 347 and
  their English twins)
- Now: which of Obeya's state lines stand in a conversation is decided by a regex literal of 36
  German and English sentence starts (`Agent gestartet|Agent started|Pull Request gemergt|…|Conflict
  resolved\. Obeya merges`). The six matchers below it (`pauseLine`, `snoozeLine`, `wokeLine`,
  `unansweredLine`, `waitLine`, `limitLine`) recognise their lines from `MESSAGES[l]` itself, four
  of them with the same `says('\0').split('\0')[0]` trick written out each time.
- Why it matters: rewording one of those messages in `messages.ts` silently folds its line away in
  every conversation; nothing ties the regex to the table, and `talk.test.ts` pins only two of the
  texts ("Agent gestartet auf …", "Nicht gebaut: …").
- Change: a helper in `talk.ts`, `starts(text, pick: (m: Messages) => string | ((...a: string[]) =>
  string))`, that tests a text against the start of a message in every language (the `'\0'` trick
  once), used by the six matchers; and `MILESTONES`, a list of such picks into `MESSAGES`, in place
  of the literal. Wordings that old events in existing databases carry and `MESSAGES` no longer has
  stay as explicit strings in that list, each marked as legacy.
- Win: the hand-kept copy of the texts goes; four repeated template matches become one helper.
- Risk: medium. Events in existing SQLite databases are recognised by text, so every alternative of
  today's regex must still match: write a test first that runs today's `MILESTONE` over every
  message `MESSAGES` can produce and compare.
- Confidence: medium. Checked ten of the alternatives against `messages.ts` (all found there); did
  not map every one to its key.

### H8. A repository's settings rows repeat their control per setting
- Principle: DRY
- Size: moderate
- Where: `src/ui/config.tsx:2067`, `2105`, `2108`, `2110` (text inputs), `2099`, `2100`, `2106`
  (lists as lines), `2084-2087`, `2093-2096` (checkboxes), `2161-2164` (the site's text fields)
- Now: `RepoSettingsBlock` has `row(k, label, control, hint)` but builds each control inline:
  `row('branch', c.branch, <input className="c-path" aria-label={c.branch} spellCheck={false}
  value={value<string>('branch')} onChange={(e) => set('branch', e.target.value)} />,
  c.branchHint)`, the key and the label each named three times per line; the list settings repeat
  `<textarea rows={Math.max(2, value<string[]>(k).length + 1)} … value={lines(k)} onChange={(e) =>
  set(k, e.target.value.split('\n'))} />`.
- Why it matters: the lines run to 250 characters and hide the few that differ (a placeholder,
  `keep` shown only with `stop`); a new setting copies one.
- Change: three local helpers beside `row`: `text(k, label, hint, placeholder?)`, `list(k, label,
  hint)`, `check(k, label, boxLabel, hint?)`, and with H5 `choice(k, label, options, names, hint)`;
  the site's `sub(label, <input …>)` gets the same treatment (`siteText(field, label, placeholder,
  wide?)`).
- Win: about 40 lines; the settings read as a table.
- Risk: low. Same markup; no tests.
- Confidence: high.

### H9. One upload loop twice, and the split of files into screenshots and others twice
- Principle: DRY
- Size: minor
- Where: `src/ui/shots.tsx:57-76` (`attachTo`), `84-101` (`fileTo`), `104-108` (`filesTo`),
  `135-140` (`attach` in `useShotInput`)
- Now: `attachTo` and `fileTo` are the same loop (raise `uploading` by the number of files, per file
  try the upload, on failure set the draft's `error`, in `finally` lower `uploading`, count the
  arrivals); they differ in what one file does and in that `attachTo` pins the drafts' home
  (`draftsHome()`, `updateDraftAt`) while `fileTo` writes with `updateDraft` to whatever canvas the
  page shows by then. `filesTo` and `attach` both split `files` by `isImage` and call the two.
- Why it matters: the guard against a switch of canvas exists in one copy only (see "Bugs noticed").
- Change: `eachFile(key, files, one: (f: File) => Promise<void>)` holding the loop with the pinned
  home, used by both; `attach` calls `filesTo(key, files, { added, put })` instead of repeating the
  split.
- Win: about 20 lines, and `fileTo` gets the guard.
- Risk: low; `draft.test.ts` covers `updateDraftAt`. Giving `fileTo` the pinned home changes
  behaviour only in the case that is wrong today.
- Confidence: high. Callers grepped: `filesTo` from `App.tsx:1251`, the others only inside
  `shots.tsx`.
- Bug fixed ([bugs noticed in passing](../bugs-noticed-in-passing.md) W2): `fileTo` pins the drafts'
  home as `attachTo` does (`updateDraftAt`, and `insertFilesAt` for the path), and both compare the
  home by store and canvas, so a switch away and back lands in the draft shown.

### H10. A menu over the page is placed and closed by hand in three places
- Principle: DRY
- Size: minor
- Where: `src/ui/snooze.tsx:211-228` (`usePlaced`), `src/ui/agentPick.tsx:47-60`,
  `src/ui/parts.tsx:890-897`; `src/ui/queue.tsx:16-30` (`useMenuClose`)
- Now: `snooze.tsx` has `usePlaced(on, menu, anchor)` (place with `placeOnScreen`, again on scroll,
  resize and when the menu grows) but does not export it; `AgentPick` writes the same effect out
  without the `ResizeObserver`, `HeadMenu` places once. Both build a fake ref, `useRef({ contains:
  (n) => box.contains(n) || menu.contains(n) })`, and pass it `as unknown as RefObject<HTMLElement>`
  to `useMenuClose`, because that takes one element and their menu is a portal outside the button.
- Why it matters: two type casts that lie about a ref, and three variants of "keep the menu on the
  screen".
- Change: export `usePlaced` and use it in `AgentPick` (its `[open, view]` dependency becomes the
  `ResizeObserver`, which already re-places when the content changes); let `useMenuClose` take
  `RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[]` and test `some((r) =>
  r.current?.contains(target))`. `useMenuClose` and `placeOnScreen`/`usePlaced` then belong in one
  `src/ui/menu.ts` rather than in `queue.tsx` and `snooze.tsx`, which seven other files import them
  from.
- Win: about 15 lines, two casts.
- Risk: low. No tests; check the agent menu and a project's "…" menu open, scroll, close.
- Confidence: high. Grepped `useMenuClose(`, `placeOnScreen`, `usePlaced`.

### H11. How a model is named is written in four places
- Principle: DRY
- Size: minor
- Where: `src/ui/config.tsx:914`, `928`; `src/ui/agentPick.tsx:20-25`, `72`, `84`, `132-133`, `220`
- Now: "Claude's models by `t.config.agents.models[id]`, Codex's by the name Codex gives, else the
  id" is `modelName` local to `AgentsBlock`, the body of a menu entry in `AgentPick`, the tail of
  `agentLabel`, and (for a running session) `RunsOn`. "The efforts a model takes, else
  `AGENT_EFFORTS`" (`listed.find((m) => m.value === model)?.efforts ?? AGENT_EFFORTS`) is in three.
  In `AgentPick`/`RunsOn` "the card's own choice, if it names harness and model" (`own.harness &&
  own.model ? … : group…`) is spelled five times (67, 68, 87, 89, 231).
- Why it matters: the Configuration and a card's menu must show the same names (the comment at
  `agentPick.tsx:69` says so); today that holds by copying.
- Change: in `agentPick.tsx` export `modelLabel(h: Harness, m: ModelChoice)` and `effortsOf(choices,
  model)`; `AgentsBlock`, the menu and `agentLabel` use them. In `AgentPick`, `const mine =
  own.harness && own.model ? { harness: own.harness, model: own.model } : null` once.
- Win: about 10 lines; one rule.
- Risk: low.
- Confidence: high.

### H12. Archive and search share a search field, written twice
- Principle: DRY
- Size: minor
- Where: `src/ui/archive.tsx:143-145`, `280-296`, `323`; `src/ui/search.tsx:111-113`, `199-216`,
  `237`
- Now: both have the field ref, `useEffect(() => void (on && field.current?.select()), [on])`, the
  `<div className="a-search">` with the input (`autoFocus`, `spellCheck={false}`, placeholder as
  `aria-label`) and the `×` that clears and refocuses (the clone detector's pair), `useMenuClose(on,
  box, () => held || onClose())`, and the row ref `(el) => void (el ? els.set(i.id, el) :
  els.delete(i.id))`.
- Why it matters: the search already borrows the archive's CSS class and its
  `t.archive.clearSearch`; the two fields are meant to be one thing.
- Change: `SearchField({ on, value, onChange, label, onKeyDown? })` in `archive.tsx` (or a small
  `searchField.tsx`), holding the ref, the select-on-open and the clear button; both lists render
  it.
- Win: about 25 lines.
- Risk: low.
- Confidence: high.

### H13. `archive.tsx` keeps pieces of the client-side archive filter it no longer has
- Principle: YAGNI
- Size: minor
- Where: `src/ui/archive.tsx:17`, `392-396`; `src/ui/archive.test.ts:16-17`; `src/ui/search.tsx:13`
- Now: the server searches the archive (`api.archivePage({ q })`), but `matches(i, words,
  workstreams = [])` still takes a project's workstreams; its only caller outside tests, `findCards`
  in `search.tsx:32`, never passes them. `archive.tsx` re-exports `fold` and `searchWords` from
  `core/search` so that `search.tsx` and the test can import them from `./archive`.
- Why it matters: a parameter and a test for a path the page no longer has; an import detour that
  suggests the archive owns the search.
- Change: drop the `workstreams` parameter and the two test lines for it (`searchText`'s own
  parameter stays: the server uses it); delete the re-export and import `fold`/`searchWords` from
  `../core/search` in `search.tsx` and `archive.test.ts`. `matches` then fits better in
  `search.tsx`, its one user.
- Win: a parameter, a re-export, two test lines.
- Risk: low.
- Confidence: high. Grepped `matches(` and `from './archive'` over `src`.

### H14. The dictated text field is wired twice, with a parameter that is always `true`
- Principle: DRY
- Size: minor
- Where: `src/ui/coordinator.tsx:453-485` (`RuleEdit`), `815-851` (`NewPreference`);
  `src/ui/dictation.tsx:131-137` (`useDictatedField`)
- Now: `useDictatedField(field, sends)` has two callers, both in `coordinator.tsx`, both passing
  `true` (which is also `useDraftField`'s default). Each then wires the same five things on its
  textarea: `className={talk.dictating ? 'dictating' : undefined}`, `onBlur={talk.blur}`,
  `onKeyUp={talk.keyUp}`, `onKeyDown` starting with `if (talk.keyDown(e)) return;` then Enter
  without Shift, and `<DictationLine draft={talk.key} />` after it (the clone detector's pair
  838-844 / 469-475).
- Why it matters: the header of `dictation.tsx` promises "the same in every field that takes it"; a
  third field would copy the wiring again.
- Change: `DictatedArea({ value, onChange, onEnter, onEscape?, onBlur?, ...textareaProps })` in
  `dictation.tsx` that owns the ref, the hook, the handlers and the line (`useFitHeight` stays with
  the caller through a forwarded ref, or moves in); `RuleEdit` and `NewPreference` render it. Drop
  `sends`.
- Win: about 25 lines, one parameter.
- Risk: low. `NewPreference` puts the line after its button; keep that order with a render slot or
  CSS order.
- Confidence: high. Grepped `useDictatedField`.

### H15. `when` is defined twice, and the phone keeps the comment of a third
- Principle: DRY
- Size: minor
- Where: `src/ui/access.tsx:42-43`, `src/ui/forYou.tsx:16-17`, `src/ui/phone.tsx:163`
- Now: `const when = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ?
  clock(iso) : shortDay(iso))` is in `access.tsx` and, exported, in `forYou.tsx` (the same body; the
  latter also takes a number). `phone.tsx:163` still has the doc comment of the copy that moved to
  `forYou.tsx` ("When something began: the time today, else the day."), above nothing.
- Change: one `when` in `strings.ts` beside `clock`, `shortDay` and `snoozeWhen`; both files import
  it; delete the orphan comment.
- Win: a duplicate and a stale comment.
- Risk: low.
- Confidence: high. Grepped `when\b` definitions in `src/ui` and `src/core`.

### H16. The phone's three folded lists are written out three times
- Principle: DRY
- Size: minor
- Where: `src/ui/phone.tsx:53-55`, `299-301`, `674-676`, `723-744`, `841-853`
- Now: "Set aside", "Planned" and "Done" each have a storage key constant, a `useFolded(key)` call,
  a `cardsOf(...)` and a `{list.length > 0 && <Folded …><ByCanvas list=…
  count=…>{cards}</ByCanvas></Folded>}` block; they differ in label, entries, the swipe and one hint
  line. The local `useFolded` (a boolean per tab) shares its name with `fold.tsx`'s `useFolded` (the
  folded ids per browser), which the file therefore imports as `useFoldedCanvases`.
- Change: a small `FoldedList({ list, label, entries, swipe?, hint? })` component that owns its
  `useFolded` call (key `obeya-phone-${list}-open`… keep the three existing key strings in a map so
  what a tab has open survives the change) and renders the block; rename the local hook
  `useOpenInTab` so the import alias can go.
- Win: about 20 lines.
- Risk: low.
- Confidence: high.

### H17. The panel's way out is state in two components
- Principle: KISS
- Size: minor
- Where: `src/ui/phone.tsx:202-211` (`talk`, `leaveTalk`, `closing` and the effect that resets it),
  `627`, `643`, `747`, `763`; `src/ui/phone.tsx:955`, `963-971` (`leaving`, `gone`, `leave`,
  `leaveRef.current = leave`)
- Now: the conversation panel is closed, open or sliding out. `Phone` holds `talk` and `closing`
  (set by the panel's `onLeave`, reset by an effect once `talk` is false) and a ref `leaveTalk` that
  the panel fills with its own `leave` during render, so the button beside the microphone can start
  the slide; `TalkPanel` holds the same fact again as `leaving` plus `gone`.
- Why it matters: five variables and a ref written during render for a three-state value; `shown =
  talk && !closing` has to be recomputed at each use.
- Change: `Phone` holds `panel: 'closed' | 'open' | 'leaving'` and `leaveTalk(ms = 200)` (set
  `'leaving'`, then `closeTalk` after `ms`); `TalkPanel` gets `leaving` as a prop and calls
  `onLeave(ms)` from its drag. `closing`, its effect, the `leaveTalk` ref, `leaving` and `gone` go.
- Win: about 12 lines, one ref handed up through render.
- Risk: medium. Animation timing, no tests; check with the emulator (button, drag down, throw, Back
  while sliding).
- Confidence: medium.

### H18. `ArchivePill` contains a windowed list
- Principle: KISS
- Size: moderate
- Where: `src/ui/archive.tsx:173-269` (and `64-105` for the paging)
- Now: the component fetches pages, groups rows by day, and in the same body keeps "only the rows in
  view are on the page": `sizes`, `rowEls`, `measured`, `view`, `starts`, `from`/`to`, `anchor`,
  `revealed`, `placeOf`, `remember`, `look`, `watch`, `row` and four effects, about 100 lines
  between the data and the markup. In `useArchiveList`, the first read (76-91) and `next` (92-105)
  repeat the request bookkeeping (`++asked`, `busy`, drop a stale answer, the error branch).
- Why it matters: the windowing is generic (it knows rows only by key and a guessed height) but can
  be neither read nor reused apart from the archive; the anchor logic is the subtle part and sits
  between unrelated lines.
- Change: `useWindowedRows<R>({ rows, keyOf, guess, scroller, list, keep })` → `{ from, to, starts,
  rowRef, onScroll }` in `src/ui/windowed.ts`, taking `offsets` and `visible` with it; `ArchivePill`
  keeps data and markup. In `useArchiveList`, one `ask(q, count, after, apply)` for both requests.
- Win: about 10 lines; `ArchivePill` shrinks from about 200 lines to about 90.
- Risk: medium. `archive.test.ts` covers `offsets` and `visible` only; the scroll anchoring needs a
  check with a long archive.
- Confidence: medium. One user of the windowing today (grepped `offsets(`, `visible(`), so the gain
  is separation, not reuse.

### H19. Setting up a demo site has its form twice
- Principle: DRY
- Size: minor
- Where: `src/ui/config.tsx:1339`, `1351-1373` (PersonalSiteBlock) and `2250`, `2268-2299`
  (SiteSetupRow); the progress lines also `1172-1186`, `1611`, `src/ui/setup.tsx:276-282`, `526-537`
- Now: both show a host switch, the host's note, `<CloudflareAccount>` for Cloudflare with the same
  default (`way ?? { account: accounts[0] ?? '', token: '', accountId: '' }`), a button that reads
  "setting up" while the job runs, the job's last line (`job.lines.at(-1)`) and its failure. They
  differ in the hosts offered (three or two) and the API called. Across the sheets, "installing:
  `<code>{job.line}</code>`" is written three times (`config.tsx:1173`, `setup.tsx:278`, `527`) and
  `job.error.split('\n').at(-1) ?? ''` three times.
- Change: `SiteHostForm({ hosts, notes, accounts, running, job, onGo })` used by both; `JobLine({
  step, line })` and `lastLine(error)` in `setup.tsx` for the progress and failure lines.
- Win: about 30 lines.
- Risk: low.
- Confidence: medium. The two forms differ in small ways (the personal site keeps the chosen host in
  sessionStorage and offers "try Cloudflare" after a failure) that the shared form must leave to the
  callers.

### H20. `talk.ts` also holds what a card's layout and the phone's lists go by
- Principle: KISS
- Size: minor
- Where: `src/ui/talk.ts:461-581`
- Now: the file's header says "A card's conversation, from its events", and lines 1-460 are that.
  The last 120 lines are predicates over an `Item` that read no events: `ownerField`, `runs` ("the
  phone's Running"), `opensWithTalk`, `agentWorks`, `obeyaWorks`, `worked`, `result`, `split`,
  `waitsFirstStart`, `talkAlone`, and the mutable set `beingWritten`.
- Why it matters: `phone.tsx`, `App.tsx` and `detail.tsx` import card-state rules from the
  conversation's module; a reader looking for "when is a card laid out split" does not look there.
- Change: move those to `src/ui/cardState.ts` (or beside `needsYou` in `core/types.ts` for the ones
  without UI state); `talk.ts` keeps `talkTurns`, `cardTalk`, `talkState`, `parseQuestion`,
  `unseen`, `unseenTurns`, `demoHandover`, `snoozeLine`, `coordinatorReads`.
- Win: no lines; a module with one subject.
- Risk: low. Imports only; `talk.test.ts` follows.
- Confidence: medium. A move, so borderline taste; listed because the brief names grab-bag modules.

### H21. "Save first, then go" is spelled out by each user of `Takeover`
- Principle: DRY
- Size: minor
- Where: `src/ui/config.tsx:2462-2468`, `2499-2502`, `2716-2721`, `2735-2737`
- Now: `ShareSettings` and `AdapterSetup` each destructure `{ saved, prepare }` and write `if
  (!saved && !(await prepare?.())) return setBusy(false);`, and each computes "can go" as `saved ||
  prepare` for the button's `disabled` and the hint.
- Change: build `Takeover` once in `CanvasBlock` with `ready: () => Promise<boolean>` (`saved ? true
  : (await prepare?.()) ?? false`) and `can: boolean`; the two users call those.
- Win: a few lines; the rule in one place.
- Risk: low.
- Confidence: high.

### H22. The held microphone and its "into the field" line twice
- Principle: DRY
- Size: minor
- Where: `src/ui/voice.tsx:486-498`, `515-519`; `src/ui/dictation.tsx:82-89`, `108-120`
- Now: the big microphone and a field's `DictateButton` both take `useHeldByTouch()` as `ref`, call
  `e.preventDefault()` in `onPointerDown` before starting, and add `onContextMenu={(e) =>
  e.preventDefault()}`. "→ **into the field** · Enter sends" is built in `PushToTalk` and again in
  `dictationLine`.
- Change: `useHeldByTouch` returns the props to spread (`{ ref, onContextMenu }`); one `IntoField({
  draft })` in `dictation.tsx` for the line, used by both.
- Win: about 10 lines.
- Risk: low.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/ui/talk.ts:120` `talkTurns` runs 120 lines over eight closure variables: it is one pass over
  the log whose rules are each documented above it, the later passes are already separate functions
  (`named`, `answered`, `marked`, `askedLast`, `ended`, `afterAsking`, `settle`), and `talk.test.ts`
  (67 tests) pins it.
- `src/ui/talk.ts:273-297` the line matchers read Obeya's lines by their text: events in existing
  databases carry only text (see H7 for the one hand-kept copy).
- `src/ui/config.tsx:724` `DEFAULT_DEMO_DIRECTORY` restates the demo skill's constant: the page
  cannot import `plugin/skills/demo/lib/settings.ts` (it uses `node:path`), and the comment says so.
- `src/ui/walkthrough.tsx:215-498` `Playback` lives outside React with its own listeners: a player
  must go on while its message is drawn anew (file header), which component state cannot do.
- `src/ui/walkthrough.tsx:168-191` one `Audio` element for every player and the silent WAV played on
  the first tap: Safari on the iPhone plays an element's sound only once a tap started it.
- `src/ui/voice.tsx:97` `micHolder` is generic over the microphone and takes `keptMs`: the seam
  `voice.test.ts` tests it through.
- `src/ui/phone.tsx:76-161` `keyboardResizes`, `watchKeyboard`, `tapOpensKeyboard`: three
  workarounds for Chrome on Android and Safari, each with its cause recorded.
- `src/ui/wish.tsx:43-93` a module-level store instead of React state: the draft outlives the
  dialog, is opened from outside React (`openWish` from `App`'s notice handler) and is kept per
  canvas.
- `src/ui/coordinator.tsx:262`, `src/ui/phone.tsx:859`, `src/ui/phone.tsx:790` three foldable heads:
  different markup, classes and storage (per canvas in localStorage, per tab, per list and canvas);
  not one component.
- `src/ui/config.tsx:322`, `src/ui/wish.tsx:210`, `src/ui/access.tsx:311`, `src/ui/setup.tsx:329`
  four dialog shells: six lines each, and they differ in how a press beside the box closes (pointer
  down on the dim versus a click), on purpose in `config.tsx:321`.
- `src/ui/archive.tsx:20`, `345`; `src/ui/search.tsx:29`, `40`; `src/ui/voice.tsx:81`, `97`;
  `src/ui/talk.ts:120`; `src/ui/wish.tsx:105` exports only tests use: test seams.

## Bugs noticed in passing
- `src/ui/phone.tsx:163` a doc comment above nothing (see H15).
