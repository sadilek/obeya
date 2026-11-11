# J: core, shared by server and UI (`src/core`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The small modules of `src/core` are in good shape: each pairs an area's types with its functions
(`queue.ts`, `search.ts`, `page-tags.ts`, `diff.ts`, `files.ts`, `caption-pages.ts`,
`walkthrough.ts`, `wish.ts`), the card predicates are used instead of being rewritten inline (three
inline copies of `finished` in all of `src`), and the unions are honest (every `CardAction` is sent
and handled, every `ErrorCode` but one is produced). The two themes are `types.ts`, which became the
home of everything without a module of its own (89 functions and constants beside 169 types, 3,135
lines), and knowledge the two sides share only by typing it twice: log lines recognised by copies of
their words, UI labels restated for the server, core's text helpers written out again at their call
sites.

## Findings

### J1. `types.ts` is a grab bag: 89 functions and constants in a file called "shapes", several of them used by one side only
- Principle: KISS
- Size: major
- Where: `src/core/types.ts:29-319` (card predicates: `finished` … `taskAuthor`, `prototypeName`,
  `prototypeBuild`, `titleFrom`, `openQuestions`, `needsYou`, `awaited`), `:1011-1018`
  (`withSupplemented`, `chapterAt`), `:1114-1123` (`started`, `pickedAnswer`, `ownWords`), `:1433`
  (`isTalkRef`), `:1487-1490` (`settingPatch`), `:1526` (`newRepoName`), `:1883-2394` (configuration
  and repository settings, with `layerSettings`, `commandLines`, `repoShape`, `restartsAgents`,
  `withClones`, `blocksSaving`), `:2618-2823` (agents and models: `codexFamily`, `newestOfFamilies`,
  `resolveCodexModel`, `nearestEffort`, `storedModel`, `cardAgentOf`, `modelFits`, `agentDefault`,
  `modelName`, `modelVersion`, `modelChoices`, `codexFamilyName`); `src/core/types.test.ts` (229
  lines, tests of ten unrelated areas)
- Now: the header says "Shapes shared by the server and the UI". The file holds 169 types and 89
  value exports; 138 files import it (104 outside tests). Its sections have nothing to do with each
  other: a card and its predicates (lines 1-1143, 1492-1700), the canvas snapshot and the
  Coordinator's sheet (1144-1490), error codes (1702-1881), configuration and repository settings
  (1883-2394, about 510 lines), settings views (2396-2616), agents and models (2618-2823, about 205
  lines and 20 functions), voice and machine setup (2825-2976), restart and WebSocket messages
  (2978-3126). Several functions are not shared at all: `withClones` with `FilledClones` and
  `restartsAgents` are the Configuration dialog's (only `src/ui/config.tsx` uses them);
  `prototypeBuild` and `prototypeName` (only `src/server/canvas.ts`, `workers.ts`),
  `resolveCodexModel` and `nearestEffort` (only `src/server/codex.ts`), `settingPatch` (only
  `src/server/config.ts`), `repoShape` (only `src/server/canvas.ts` and `restartsAgents` beside it),
  `pickedAnswer` (only `workers.ts`), `isTalkRef` (only `server.ts`, `board.ts`), `storedModel`,
  `modelFits`, `agentDefault`, `cardAgentOf` (server only). `formatQuestion` (`:182`) makes the
  types file import the whole message table at run time (`import { MESSAGES } from './messages'`,
  `:7`), while `messages.ts` imports types from `types.ts`.
- Why it matters: nobody finds "how a Codex family resolves to a model" or "what the dialog fills in
  for clones" in a file of shapes; a reader of `Item` scrolls past 290 lines of predicates first;
  the test file mirrors the mix. The other core modules show the house's own pattern (an area's
  types with its functions), which `types.ts` stopped following.
- Change: continue that pattern, without a barrel. (1) `src/core/agents.ts`: lines 2618-2823 as they
  are (roles, harnesses, models, Codex families, `HarnessView`, `AgentsView`, `ModelChoice`). (2)
  `src/core/repo-settings.ts` (or `config.ts`): lines 1883-2394 (`RepoConfig` … `ConfigSaved`,
  `DemoSite`, `RepoSettings`, `SHARED_FIELDS`, `NESTED_SETTINGS`, `layerSettings`, trust,
  `RepoValues`, `ResolvedCanvas`, `ConfigProblem`) plus `PROPOSED_SETTINGS`/`settingPatch`. (3)
  `src/core/card.ts`: the predicates of lines 29-319 with `started`, `pickedAnswer`, `ownWords`,
  `withSupplemented`, `chapterAt`, `titleFrom`; `formatQuestion` goes beside its parser (J3). (4)
  What one side alone uses goes to that side: `withClones`, `FilledClones`, `restartsAgents` to
  `src/ui/configDraft.ts` (it already holds the dialog's draft logic);
  `prototypeBuild`/`prototypeName` to the server beside their two callers. `types.ts` keeps the
  shapes (`Item` and its parts, snapshot, `Talk`, `CardAction`, `ErrorCode`, views, messages) and
  the `as const` tuples that define them. Importers change their import lines only; `types.test.ts`
  splits the same way. If touching 100 import lines at once is too much, steps (1) and (2) alone
  remove 700 self-contained lines and touch about 20 importers.
- Win: `types.ts` shrinks from 3,135 to roughly 2,100 lines of shapes; three modules a reader can
  name; the run-time import of `messages.ts` from the types file goes.
- Risk: low; code moves unchanged, `bun run typecheck` finds every import, `src/core/types.test.ts`
  covers `withClones`, `prototypeBuild`, the model functions, `openPerGroup`, `stoppedArchivable`.
- Confidence: high for the inventory (every export classified by grep over `src/server`,
  `src/adapters`, `src/ui`, `src/core`; the one-sided ones checked by name); the cut itself is a
  judgement.

### J2. The archive's rule is written three times: core predicates for the button, an inline clause for ideas, and `Board.archive` for the request
- Principle: DRY
- Size: moderate
- Where: `src/core/types.ts:35-51` (`stopped`, `stoppedArchivable`, `finishedArchivable`,
  `archivedWithDone`), `src/ui/parts.tsx:257` (`finishedArchivable(item) || stoppedArchivable(item)
  || (!!item.idea && item.idea.status !== 'open' && !prototyped)`), `src/ui/detail.tsx:326`,
  `:2884`, `src/server/board.ts:1832-1853` (`archive`)
- Now: whether the archive takes a card is decided in core for the UI (`stoppedArchivable`: stopped,
  the owner's, a task, no prototype, not queued, no workspace nor `keptIn` unless `repoDown`;
  `finishedArchivable`: finished, the owner's, not `finishing`), in `parts.tsx` for ideas (not open,
  no prototype), and again in `Board.archive` over the stored row (`row.state === 'planned' &&
  row.branch && row.kind === 'task' && !row.prototype_of`, then `row.queue`, then `(row.workspace ||
  row.kept_in) && !repoDown`; `finished(row.state)`; `row.landed && row.workspace` for "still
  finishing"; ideas by `status === 'open'` and a running prototype). Same rule, other words, and
  already not quite the same: core's `stopped` excludes a card that is `unstarted` (built on a
  prototype's branch, no session yet), the server's branch test does not; core asks `finishing`, the
  server `landed && workspace`. Only `archivedWithDone` is shared (`board.ts:1863`).
- Why it matters: the server's `archive` is the only place that says why not (`notDone`,
  `holdsWork`, `prototypeRunning`, `planCard`), the UI's the only one that decides whether the
  button shows; a change to one (as `repoDown` was) has to be made in three places, or the button
  offers what the request refuses.
- Change: one function in core, `archiveRefusal(i: Item, items: Item[]): 'notDone' | 'holdsWork' |
  'prototypeRunning' | 'planCard' | undefined`, holding the rule once with its reasons.
  `Board.archive` throws `BadRequest(reason, …)` from it over `this.item(id)` (it reads the item
  already for `repoDown`); the UI's button shows where it returns nothing;
  `stoppedArchivable`/`finishedArchivable` become thin readings of it or go. Decide the `unstarted`
  case consciously while merging (keep the server's behaviour for the request).
- Win: one rule instead of three; about 20 lines; the idea clause leaves `parts.tsx`.
- Risk: medium: the server reads the row, the UI the item; the mapping (`finishing` from
  `landed`/`workspace`, `unstarted` from `built_on`/`session_id`, `board.ts:3671`) has to be checked
  case by case. `src/core/types.test.ts:92` and the archive tests of `board.test.ts` cover the main
  cases.
- Confidence: medium (both sides read; the row-to-item equivalences not traced to the end).
- Bug fixed (W1 of the bug plan): `Board.archive` refuses a planned task built on a prototype that
  no agent has worked on since (`built_on` without `session_id`) as `notDone`, as core's `stopped`
  does; a direct request reached it where the card's repository did not run on the canvas. Merging
  into `archiveRefusal` keeps that.

### J3. Log lines are recognised by hand-typed copies of their words, beside a mechanism that derives them from the table
- Principle: DRY
- Size: moderate
- Where: `src/core/types.ts:1114` (`started`: `/^(Agent gestartet|Agent started)/`) against
  `src/core/messages.ts:77,79,152` and `:627,628,681`; `src/ui/talk.ts:448-459` (`parseQuestion`: `/
  \((Mehrfachauswahl|multiple choice)\)$/`) against `src/core/types.ts:182-183` (`formatQuestion`)
  and `messages.ts:29,586` (`multiple`); `src/ui/talk.ts:59-60` (`MILESTONE`, one regex of 38
  alternatives and 928 characters restating the first words of about twenty messages in both
  languages); the derived kind for comparison: `src/ui/talk.ts:274-293`, `src/server/workers.ts:469`
- Now: a line of the log carries its meaning in its text, in the language it was written in, so the
  UI tells lines apart by text. Six matchers in `talk.ts` and one in `workers.ts` do that from the
  table (`MESSAGES[l].worker.snoozed('\0').split('\0')[0]`, in every language). `started`,
  `parseQuestion` and `MILESTONE` type the words again. `formatQuestion` and its inverse
  `parseQuestion` live in different files of different layers.
- Why it matters: rewording "Agent gestartet" in `messages.ts` silently breaks where a card's
  conversation starts (`src/ui/detail.tsx:1382`) and whether an earlier handover still counts
  (`src/ui/talk.ts:162`); nothing fails, no test names the coupling. The table is in core for
  exactly this purpose.
- Change: in `messages.ts`, name each recognised lead once and build the messages from it (`const
  started = 'Agent gestartet'` used by `worker.started`, `reviewStarted`, `startedInFolder`);
  `started()` tests `LANGUAGES.some((l) => e.text.startsWith(MESSAGES[l].worker.startedLead))`. Move
  `parseQuestion` beside `formatQuestion` (in core, with the messages) and build its marker from
  `MESSAGES[l].multiple`. For `MILESTONE` (the UI slice's, reported here because the table is this
  slice's): export the list of milestone leads from `messages.ts`, built from the same named leads,
  and let `talk.ts` test against it. Wordings older logs hold and the table no longer has (the
  comment at `messages.ts:197` names one) stay as explicit extra alternatives, each with its date.
- Win: three hand-kept copies go; rewording a message can no longer break recognition unnoticed.
- Risk: medium for `MILESTONE` (some alternatives are older wordings; each must be kept or shown
  gone), low for `started` and `parseQuestion`; `src/ui/talk.test.ts` covers the folding of the log.
- Confidence: high for `started` and `parseQuestion` (texts compared in both languages); medium for
  `MILESTONE` (not every alternative matched to its message).

### J4. UI button labels are typed a second time in `messages.ts`, though two already come from one place
- Principle: DRY
- Size: moderate
- Where: `src/core/messages.ts:60,610` (`answer.walkthroughAsked`) = `src/ui/strings.ts:1063,3246`;
  `messages.ts:352-354,855-857` (`idea.briefName`, `prototypeButton`, `splitOffButton`) =
  `strings.ts:2190,2199,2204` and `:4308` ff.; `messages.ts:377-378,875` (the three labels inside
  `proposal.acceptAfterRevision`) = `strings.ts:359,361,363`; `messages.ts:444,938`
  (`retro.settings`: `checks`, `setup`, `softPaths`, `run`) = `strings.ts:1500,1502,1508,1515` and
  `:3672`; the lead words of `messages.ts:450-456,944-949` (`share.share`, `again`, `newDemo`,
  `added`, `unshare`) = `strings.ts:998,1000,1011,1021`; the precedent:
  `strings.ts:355,744,2601,2950` (`approveDirect: MESSAGES.de.approveDirect`, `quote:
  MESSAGES.de.quote`)
- Now: the server names the UI's buttons and fields in log lines ("Auf der Seite ersetzen: …"), in
  the Coordinator's notices (`src/server/canvas.ts:1680`) and in agent prompts
  (`src/server/explorers.ts:458,591`, `canvas.ts:2330`: `The owner clicked "${t.splitOffButton}"`).
  Each such label exists once in `strings.ts` for the button and once in `messages.ts` for the
  server, in both languages, about 16 labels. For `approveDirect` and `quote` the UI's table takes
  the value from `MESSAGES`, with a comment saying why (`messages.ts:430`).
- Why it matters: renaming a button in `strings.ts` leaves the agents' prompts and the log naming a
  button that no longer exists; the two tables agree today only because someone kept them so.
- Change: do for these what `approveDirect` does: the label stays in `messages.ts` (the server
  cannot import the UI's table), `strings.ts` takes it from `MESSAGES.de`/`MESSAGES.en`; where the
  message embeds the label (`share.*`, `acceptAfterRevision`), name the label as its own key and
  build the sentence from it.
- Win: 16 labels times two languages typed once.
- Risk: low; strings are equal today (compared literal by literal in both languages), so nothing the
  owner sees changes.
- Confidence: high.

### J5. Core's text helpers are written out again at their call sites
- Principle: DRY
- Size: moderate
- Where: `src/core/text.ts:4,14,20` (`clip`, `oneLine`, `messageOf`); `oneLine` again:
  `src/ui/answer.ts:48` (a local `oneLine`, identical), and `.replace(/\s+/g, ' ').trim()` inline at
  `src/server/commands.ts:1029,1038,1058,1471`, `board.ts:430,2901`, `workers.ts:2567`,
  `advisor.ts:175`, `explorers.ts:679,691,701`, `wish.ts:83`, `coordinator.ts:990`,
  `src/ui/wish.tsx:273`, `cite.tsx:17`, `reply.ts:26`; `clip` again: `src/server/push.ts:68`
  (`clipped`, identical), `stalls.ts:77`, `src/ui/detail.tsx:1804`; `messageOf` again:
  `src/server/site-hosts.ts:29`, `skills.ts:116`, `harnesses.ts:162`; a fourth helper that is
  missing from core: `plainText` identical at `src/server/share.ts:1419` and `tag-proposal.ts:146`,
  inline at `canvas.ts:2897`
- Now: `oneLine` is imported by 3 files and written out in 17 places; `clip` by 15 and rewritten in
  3; `messageOf` by 24 and rewritten in 3. `plainText` (`s.replace(/[*_\`#>]/g, '').replace(/\s+/g,
  ' ').trim()`) exists twice word for word and once inline. `src/server/tag-proposal.ts:148` defines
  another `clip` that cuts differently (at `n`, then " …"), under the same name.
- Why it matters: the pattern `clip(String(x ?? '').replace(/\s+/g, ' ').trim(), 200)` appears five
  times for "a caption an agent gave"; a reader checks each time whether it is the same thing.
- Change: use `oneLine`, `clip`, `messageOf` at those sites; delete `answer.ts`'s `oneLine` and
  `push.ts`'s `clipped`; add `plainText` to `core/text.ts` (or use `plain` of `core/plain.ts` where
  the fuller reading is right) and use it in the three places; rename `tag-proposal.ts`'s different
  `clip`.
- Win: about 25 call sites read as what they do; three local helpers go.
- Risk: low; pure functions, same expressions.
- Confidence: high (every listed site read in the grep output; `tag-proposal.ts:148` differs and is
  named as such).
- Done by W6: `oneLine`, `clip` and `messageOf` at the sites (and at a few more the grep found:
  `board.ts`'s quote, `demo.ts`'s chapter text, `reply.ts`); `answer.ts`'s `oneLine` and
  `push.ts`'s `clipped` went; `plainText` is in `core/text.ts`; `tag-proposal.ts`'s different
  cut is `cutAt`. `caption-pages.ts` keeps its expression: a shared demo page carries its
  functions as source, so each holds all it needs.

### J6. The fields of a repository's settings are listed by hand in parallel, one list unchecked
- Principle: DRY
- Size: minor
- Where: `src/core/types.ts:2013-2063` (`RepoSettings`), `:2076` (`SHARED_FIELDS`), `:2079`
  (`NESTED_SETTINGS`), `:2148-2162` (`RepoValues`); `src/adapters/schema.ts:38-54` (`settingsShape`)
- Now: a setting is named in the interface, in the zod shape, in `SHARED_FIELDS` and in
  `RepoValues`. The zod shape is checked against the interface (`tidySettings`,
  `src/server/config.ts:68`); `NESTED_SETTINGS` by `satisfies`. `SHARED_FIELDS` is only checked for
  membership (`satisfies readonly (keyof SharedSettings)[]`), not for completeness, and it drives
  what "Take over into the repository for everyone" writes (`src/server/shared-settings.ts:51`),
  what layers (`src/server/config.ts:360`) and what counts as live (`src/adapters/index.ts:25`).
  `RepoValues` restates every field's type (`'main' | 'pr'`, `'clones' | 'worktrees'`, `{ dir:
  string; exclude: string[] }`) wrapped in `SettingValue`.
- Why it matters: a setting added to `RepoSettings` and the schema but forgotten in `SHARED_FIELDS`
  is silently never taken over nor layered; nothing fails.
- Change: make `RepoValues` a mapped type over `RepoSettings` (`{ [K in …]-?:
  SettingValue<NonNullable<RepoSettings[K]>> }` for the flat fields, the two nested ones spelled as
  now, since `demo`'s values allow `null`), and add a one-line completeness check for
  `SHARED_FIELDS` (`Exclude<keyof SharedSettings, (typeof SHARED_FIELDS)[number]> extends never`).
  The order of `SHARED_FIELDS` is the dialog's, so the list itself stays.
- Win: 13 restated lines; a forgotten field becomes a type error.
- Risk: low (types only).
- Confidence: high (all uses of the three lists read).
- Done by W16 with F5: `RepoValues` is mapped from `RepoSettings`, `SHARED_FIELDS` is checked
  complete in `core/types.ts`, and the zod shape is checked to name the same fields as the interface
  (`adapters/schema.ts`), whose unknown-field guesses read `SHARED_FIELDS`.

### J7. The player's storage keys stand twice in one file and its icon paths twice across files, though `lib` exists to hand such things in
- Principle: DRY
- Size: minor
- Where: `src/core/video-player.ts:62-68` and `:79-82` (`CAPTIONS_OFF`, `CAPTIONS_KEY_KNOWN`,
  `SEEK_KEYS_KNOWN`, `CAPTIONS_CHANGED`), `:88-94` (`PATHS`) and `src/ui/walkthrough.tsx:594-604`
  (the same `previous`, `play`, `pause`, `next` paths); `src/server/demo-page.ts:428` and `:444`
  (the `lib` literal, twice)
- Now: a shared page carries `videoPlayer` as source, so the function may reference nothing outside
  itself; what it needs from elsewhere comes in `lib` (`PlayerLib`, `:47-53`). The four storage keys
  are nevertheless exported at the top and typed again inside ("the function carries its own copy"),
  and the four icon paths are typed again in the walkthroughs' React player, which shares the look.
- Why it matters: the keys are shared state between the two players (`walkthrough.tsx:16` imports
  them): a renamed key at one of the two places splits "captions off" between the card and the page.
- Change: pass them the way the caption functions are passed: `PlayerLib` gets `keys` and `icons`
  (plain data), `detail.tsx` hands in the exported constants, `demo-page.ts` serialises them with
  `JSON.stringify` into the one `lib` literal (written once, used at both places); `walkthrough.tsx`
  draws from the same `icons`.
- Win: one copy of four keys and four paths.
- Risk: medium-low: the pages' source changes, so `PAGES_HASH` (`src/core/page-changes.ts:54`) has
  to be renewed as `site.test.ts` says, without an entry in `PAGE_CHANGES` (nothing shows);
  `src/core/video-player.test.ts` covers the player.
- Confidence: high for the duplicates; medium for the cost of the change on the page side
  (`demo-page.ts` read only at the two lines).

### J8. Doc comments detached from what they describe
- Principle: KISS
- Size: minor
- Where: `src/core/types.ts:54-59` (the comment on "whether the card's agent is working … so that
  the owner can pause it" stands above `BackgroundTask`; `pausableNow` and `pausable`, which it
  describes, are at `:77-82` with comments of their own), `:310` ("One item on the canvas as the UI
  sees it" above the comment of `TaskAuthor`; `Item` begins at `:321` without one), `:1054` ("One
  line in a card's log" above `IMAGE_TYPES`; `CardEvent` at `:1062`), `:1925-1929` (the description
  of a demo site above `SiteSetupJob`; `DemoSite` at `:1980` has none), `:2300` ("Whether a problem
  keeps the configuration from being saved" above `START_FAILED`; `blocksSaving` at `:2304`),
  `:1050` (two fields on one line, the second's comment in the middle); `src/core/messages.ts:514`
  ("The line in a pull request's description that links its demo" above `rebuilt`; it describes
  `prLine` at `:517`)
- Now: in six places a declaration was inserted between a doc comment and its subject; the comment
  now documents the wrong thing (editors show it on hover for `BackgroundTask`, `TaskAuthor`,
  `IMAGE_TYPES`, `SiteSetupJob`, `START_FAILED`, `rebuilt`) and the real subject has none.
- Change: move each comment back to its subject; delete `:54-59` (its subjects are documented).
- Win: six correct hovers; `Item`, `CardEvent`, `DemoSite`, `blocksSaving` documented again.
- Risk: none.
- Confidence: high.

### J9. Four constants for one rule: the 8-second undo window
- Principle: DRY
- Size: minor
- Where: `src/core/types.ts:918` (`START_ALL_HOLD_MS`), `:921` (`EVICT_HOLD_MS`), `:924`
  (`PUSH_HOLD_MS`), `:1523` (`NEW_REPO_HOLD_MS`); used at `src/server/coordinator.ts:176,234`,
  `workers.ts:2684`, `canvas.ts:2174`, `src/ui/App.tsx:1026,1048`
- Now: four exported constants, all `8000`, each "how long … waits for the owner to take it back".
  The Coordinator already treats two of them as one (`this.o.holdMs ?? EVICT_HOLD_MS` and
  `this.o.holdMs ?? START_ALL_HOLD_MS`, one option for both). The design chapters name no separate
  lengths.
- Change: one `UNDO_HOLD_MS = 8000` with one comment ("a heavy click waits this long for the owner's
  Undo"), used at the six sites.
- Win: three constants and their comments.
- Risk: low.
- Confidence: high (all uses listed by grep); whether the four are meant to diverge one day is the
  owner's call, nothing in the docs says so.

### J10. Dead: `ErrorCode` `noPr`, `DemoSpaceView.keepDays`, `nonEmpty`, `isWish`
- Principle: YAGNI
- Size: minor
- Where: `src/core/types.ts:1760-1761` with `src/ui/strings.ts:671,2878`;
  `src/core/types.ts:2452-2453` with `src/server/demo-space.ts:187` and
  `src/server/demo-space.test.ts:107`; `src/core/text.ts:16-17`; `src/core/wish.ts:18-19`
- Now: `noPr` ("Review PR #5: no such pull request") is in the union and has a text in both
  languages, and nothing sends it: the failure is told through `MESSAGES.review.failed`
  (`src/server/canvas.ts:2783`); it came with a83523b9 and never had a producer (grep `noPr` over
  `src`, `scripts`, `plugin`, `app`: the type and the two strings). `DemoSpaceView.keepDays` is
  computed and sent, and the page reads only `defaultDays`, `used`, `freed`, `busy`
  (`src/ui/config.tsx:1489-1516`; it shows the chosen value from the settings); one test asserts the
  field. `nonEmpty` and `isWish` are exported and referenced nowhere, not even in tests.
- Change: remove the union member and its two strings; drop `keepDays` from the view and from that
  assertion (the function `keepDays` stays, the sweep uses it); delete `nonEmpty` and `isWish`.
- Win: about 12 lines, one error text per language.
- Risk: low.
- Confidence: high.

### J11. Two small repeated pieces: the frame scripts' insertion and the pull-request reference pattern
- Principle: DRY
- Size: minor
- Where: `src/core/frame.ts:70-73` (`withHeightReport`) and `:109-112` (`withMarkReport`);
  `src/core/plan-doc.ts:200-201` (`isReference`) and `:204-205` (`withoutReference`)
- Now: `withHeightReport` and `withMarkReport` are the same four lines (find the last `</body>`,
  insert a script before it, else append) with another constant. `isReference` and
  `withoutReference` each hold the same 90-character pattern for "`#12`, `PR #12`, `(#12)`, `!12`, a
  link on one", once anchored at both ends, once followed by punctuation.
- Why it matters: the reference pattern decides a workstream's key (`titleKey`), which existing
  cards are matched by; widening one copy and not the other would change keys for some titles only.
- Change: `const beforeBodyEnd = (html: string, script: string) => …` used by both `with…Report`;
  `const REFERENCE = String.raw\`…\`` used by both regexes, as `CODE` and `AFTER_LABEL` already are
  in the same file (`plan-doc.ts:36-41`).
- Win: about 6 lines; one pattern.
- Risk: low; `src/core/plan-doc.test.ts` and `frame.test.ts` cover both.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/core/messages.ts` beside `src/ui/strings.ts`: two tables of one shape for two-language texts,
  on purpose. The server's lines are written into the log in the language that applies then and stay
  so, the server cannot import the UI's table, and the UI recognises some lines by them; the file is
  in core for that. No text is dead: every one of its 396 keys is referenced (checked by leaf name
  over `src`, colliding names group by group).
- `src/core/video-player.ts:77-446` one function of 370 lines, with its own `chapterAt` (`:165`, the
  same rule as `src/core/types.ts:1018`): a shared demo page carries the function as its source
  (`(${videoPlayer})(…)`), so it can reference nothing outside itself (header, `:4-6`).
- `src/core/caption-pages.ts` its functions define their constants inside (`LINES`): carried as
  source by shared pages too.
- `src/core/locale.ts`, `src/core/walkthrough.ts:68`, `src/core/types.ts:12-14` re-export from
  `plugin/skills/demo/lib`: the demo skill runs without Obeya and so owns these.
- `src/core/types.ts:961-965` `Demo.question`, `options`, `multiple`, `pick` restate `Question`
  flat: a card's demo is stored as JSON in existing databases (`db.ts:253`), so its shape stays.
- `src/core/types.ts:2643` `CardAgent`, `:1407` `TalkWait`, `:1399` `TalkMoved` nearly restate
  `Partial<AgentSetting>`, `Snooze['on']`, `Elsewhere`: three-field shapes with their own meaning
  and comments; merging them buys nothing.
- `src/core/login.ts:16-19` `codexLoginLost` matches the server's English failure text: the text is
  Obeya's own and the comment names its source.
- `src/core/page-changes.ts:25-39,54` the hand-kept list and hashes: `site.test.ts` fails when the
  pages change without an entry, by design.
- Exports only their own file or tests use (`PATCH_LIMIT`, `diffFiles`, `FRAMES_POLICY`,
  `collapsedSize`, `dependencyColumns`, `cutTitle`, `MAX_ISSUE_URL`, `ReviewResults`,
  `PoolWorkspace`, `SettingSource`, `CODEX_MODEL`, `VoiceRecognitionParts`, `PlayerOptions`,
  `PlayerLib`): test seams, or named parts of exported types.

## Bugs noticed in passing
None left: the ones found here were fixed (2026-11-10).
