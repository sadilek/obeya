# D: canvas, commands, coordinator (`canvas.ts`, `commands.ts`, `coordinator.ts`, `to-obeya.ts`, `wish.ts`, `narration.ts`, `walkthrough.ts`, `push.ts`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice has no dead code worth naming (every public method has a production caller or is a test
seam) and almost no literal copy-paste. Its cost is size. `canvas.ts` is four modules in one file
with a 2,680-line class, `coordinator.ts` holds three unrelated jobs and a generic helper that four
other modules import from it, and `Commander.command()` is a 240-line chain. The duplication that
exists is structural: the same closing sequence at several call sites, and helpers from `core/text`
spelt out inline. `to-obeya.ts`, `wish.ts`, `narration.ts`, `walkthrough.ts` and `push.ts` are
clean apart from two small items (D13, D15).

## Findings

### D1. `canvas.ts` is four modules in one file, and `CanvasRuntime` alone runs 2,680 lines
- Principle: KISS
- Size: major
- Where: `src/server/canvas.ts:216-2893` (the class), `:2929-3074` (`Canvases`), `:3076-3385`
  (resolution functions)
- Now: one file holds four things. (a) Resolving a configuration: `readingRepo`, `readRepos`,
  `resolveCanvas`, `repoAdapter`, `listedClones`, `namesClones`, `uniqueRefs`, `settled`, `siteOf`,
  `shareRef`, `setShare`, `ConfigError`, `slug`. These are about 310 lines of module-level
  functions that never touch the class. (b) The set of canvases: `Canvases` and `startCanvases`,
  180 lines. (c) The life of a canvas's repositories inside `CanvasRuntime`: `startRepo` (165
  lines), `apply`, `due`, `restartRepos`, `restartAs`, `moved`, `movedTo`, `reread`, `follow`, the
  themes, `heldOf`, `claudeHeld`. They sit mostly in lines 598-1529 and keep their state in
  `shared`, `held`, `adapterModules`, `themes`, `themeReads`, `defaultRead`, `pending`, `failed`
  and `branchSettings`. (d) What the owner does to cards: `act`, `tell`, `forward`, `run`, and the
  proposal, idea, prototype and new-repository flows, in lines 1701-2839, with their state in
  `said`, `writing`, `newRepos`, `settling` and `settleTries`. A tally of `this.` uses in lines
  1701-2839 shows that (d) reaches (c) only through `repoOf` (28 uses), `runs`, `repos` (6),
  `watchPrs` (1) and the two proposal helpers `proposeSetup` and `proposeTheme`, which belong to
  (c) but sit at `:2049-2065`.
- Why it matters: a reader of one concern scrolls past the other three, and about 30 private fields
  are
  in scope in every method. The class is too long to keep its fields at the top, so their
  declarations sit between methods (`:517-526`, `:666-668`, `:721`, `:1037`, `:1184`, `:2158`).
- Change: three steps, each keeping `CanvasRuntime`'s public methods, because the tests call
  `canvas.act` about 280 times and `canvas.apply`, `canvas.settingsChanged` and `canvas.tell`
  dozens of times each. Step 1: move (a) to `src/server/canvas-config.ts` and (b) to
  `src/server/canvases.ts`, as pure moves. Step 2: move the proposal, idea, prototype and
  new-repository flows (`:2086-2657`, about 570 lines, with `newRepos`, `settling`, `settleTries`
  and `settleSoon`) into a class of their own in `src/server/idea-actions.ts`. `CanvasRuntime`
  constructs it with `board`, `explorers`, `coordinator`, `commander`, `images`, `repoOf` and the
  config, and `act`'s switch calls into it. Step 3, only if step 2 reads well: the same for what
  the canvas reads of a repository's settings (`:621-728` and `:1387-1513`, with `shared`, `held`,
  `themes`, `themeReads`, `defaultRead`).
- Win: `canvas.ts` goes from 3,385 lines to about 2,300 after steps 1 and 2, and to about 2,050
  after step 3. No concept changes.
- Risk: medium. Step 1 changes imports only. Step 2 includes `moveTo`, which writes to another
  canvas's board, and `makeNewRepo`, which saves the configuration. `canvas.test.ts`,
  `ideas.test.ts`, `revisions.test.ts` and `answers.test.ts` drive these paths through
  `CanvasRuntime.start`.
- Confidence: medium. I read the whole file and tallied the `this.` uses of lines 1701-2839 and
  2086-2657 with grep. I did not try the split.
- Done by W14, in all three steps: `canvas-config.ts` (the configuration's resolution) and
  `canvases.ts` (the set of canvases) by moves only; `IdeaActions` in `idea-actions.ts` (proposals,
  ideas, prototypes and the new repository, with their state), which `CanvasRuntime` constructs
  right after the explorers, since their resume may report a reply; and `SettingsReads` in
  `settings-reads.ts` (what the canvas last read of each default branch: settings, held commands,
  adapter module, themes), the canvas keeping `moved`, `movedTo` and `follow`. `canvas.ts` went
  from 3,387 lines to about 2,240. The rest of the repositories' life (`startRepo`, `apply`,
  `due`, the restart) stays in the class: it works on the canvas's own state throughout.

### D2. `coordinator.ts` holds the queue, the learner and card naming, and exports the generic `readSession`
- Principle: KISS
- Size: moderate
- Where: `src/server/coordinator.ts:391-600` (learner and retrospective), `:1315-1411` (their
  prompts and tables), `:1419-1465` (`readSession`). Importers of `readSession`:
  `src/server/revisions.ts:14`, `src/server/tag-proposal.ts:13`, `src/server/work-retro.ts:13`,
  `src/server/share.ts:32`.
- Now: the file's header says "The Coordinator decides when a card may start". The class also
  holds `learn`, `noticed`, `review`, `history`, `rules`, `targets`, `around` and `distill`, which
  propose rules from the owner's words. These eight methods share no state with the queue. They
  use `o.board`, `o.runtime`, `o.home()`, `o.repoFor(card).path`, `language`, `o.reviewEvery` and
  their own `learning` chain. `readSession` is a general helper for a read-only session that
  answers through a tool, and four modules unrelated to the queue import it from here.
- Why it matters: either job costs 1,487 lines to read, and `share.ts` depends on the queue's
  module for a runtime helper.
- Change: move the learner to `src/server/learner.ts` as a class `Learner` with the options
  `{ board, runtime, home, pathFor, reviewEvery }`. `CanvasRuntime` constructs it, and the seven
  call sites of `coordinator.learn` and `coordinator.noticed` (`canvas.ts:385`, `:425`, `:892`,
  `:1637`, `:1721`, `:1773`, `server.ts:408`) call the learner. Move `readSession` beside
  `AgentRuntime` in `src/server/runtime.ts`.
- Win: `coordinator.ts` loses about 350 lines and holds the queue and naming only.
- Risk: low to medium. `coordinator.test.ts` has 19 calls of `learn` or `noticed` on a
  `Coordinator`, which move to a `Learner`.
- Confidence: high. I read every learner method for the fields it uses and grepped the importers
  and callers.
- Done by W14: `Learner` in `learner.ts`, constructed by the canvas; `readSession` is in
  `runtime.ts`. `coordinator.ts` went from 1,487 lines to about 1,100.

### D3. `Commander.command()` is one 240-line chain for 35 actions
- Principle: KISS
- Size: moderate
- Where: `src/server/commands.ts:969-1208`
- Now: eleven `if (a.do === ...)` blocks handle the actions that take no single card (`wish`,
  `wait_for`, `stop_waiting`, `remember`, `work_retro`, `group` and `ungroup`, `rename_group`,
  `merge` and `delete`, `review_pr`, `new_idea`, `new_card`), and each returns. Then comes a
  shared preamble for card actions (resolve the card, a superseded card, a prototype, the idea
  check, a new repository), then a switch over the rest. Inside the chain the same steps recur.
  Tags become cards with "no card X on this canvas" at `:1019-1026` and `:1045-1054`. A name is
  collapsed to one line, required and capped at 60 characters at `:1029-1031` and `:1038-1040`.
  `board.canvas.repos.some((r) => r.id === ...)` appears at `:960`, `:1005` and `:1014`.
- Why it matters: changing one action means reading the whole function, and the early blocks and
  the late switch are two conventions for the same job.
- Change: one private method per card-less action (`waitForCommand`, `rememberCommand`,
  `groupCommand`, `renameGroupCommand`, `mergeCommand`, `reviewPrCommand`, `newCardCommand`),
  dispatched from a switch on `a.do`. `command()` keeps the card preamble and the card switch.
  Add `cardsOf(tags)`, which returns the cards or the problem, and `groupName(text)` for the two
  repeated steps, and `hasRepo(id)` for the third. The strings returned to the agent stay as they
  are.
- Win: no function over about 80 lines, and about 15 repeated lines go.
- Risk: low. `commands.test.ts` checks each action's refusals by their text.
- Confidence: high. I read the function end to end.

### D4. The notice for a late reply is written four times, and the open-card check six times
- Principle: DRY
- Size: moderate
- Where: `src/server/commands.ts:477-479`, `:689-691`, `:729-731`, `src/server/canvas.ts:1749-1750`
  (the notice); `src/server/commands.ts:354`, `:371`, `:445`, `:478`, `:659`, `:715` (the open card)
- Now: `drain`, `follow` and `takeUp` each end with the same three steps: hold the words if the
  usage limit kept them unread, `this.arm(heard.token)` if there is a token, then `board.notify`
  with the confirmation, the card or the exchange, the token with `undoMs`, and the wish.
  `CanvasRuntime.forward` repeats the arm and the notify. `follow` (`:658-692`) and `takeUp`
  (`:714-732`) also share their middle: `addTalk('', '', card, ...)`, a `Held` with empty words,
  `await this.drain()`, then `this.held.size ? undefined : await this.answer(talk, h)`. They
  differ in what they consume: `follow` takes the wait off its exchange and undoes the decision
  if the owner dropped the wait meanwhile, and `takeUp` calls `thenTalk(x.id, null)`. The
  expression `focus.card && board.item(focus.card) ? focus.card : undefined` appears six times,
  twice with `x.cardId`.
- Why it matters: a new field on the notice, as `wish` was, has to be added in four places, and
  a change to how held words are read has to be made in `hear`, `follow` and `takeUp`.
- Change: in `Commander`, add `private openCard(id?: string): string | undefined`,
  `private async readStep(talk, h): Promise<Heard | undefined>` (drain, then answer unless words
  are held) and `announce(heard, where)` (arm and notify). `announce` is public so that
  `CanvasRuntime.forward` calls it instead of `arm` and `board.notify`.
- Win: about 25 lines, and one definition of what a notice for a reply carries.
- Risk: low. `commands.test.ts` covers held words, waits and looked-up steps.
- Confidence: high. I read the four places side by side.

### D5. `CanvasRuntime.run` spells the same mapping out case by case, and `followUp` repeats its `newCard` case
- Principle: DRY
- Size: minor
- Where: `src/server/canvas.ts:2660-2757`, `:2644-2650`
- Now: `run` turns a `Command` into a `CardAction`. Four cases build the same object, differing
  only in the action name: `{ action, text: c.text, spoken: c.spoken ?? true, ...(c.images ? {
  images: c.images } : {}) }`
  at `:2699`, `:2719`, `:2721` and `:2723`. Six statements are `this.act(c.card, { action: c.do })`
  or its literal equivalent (`:2703`, `:2705`, `:2711`, `:2716`, `:2734`, `:2738`), spread over
  six case groups. The function has two switches over `c.do` in a row (`:2661` and `:2673`).
  `followUp` repeats the tail of the `newCard` case (`:2683-2687`): log "created", snooze when
  `until` lies ahead, else request the start.
- Why it matters: a new field on the words (as `images` was) is added four times, and the two
  ways a new card starts can drift apart.
- Change: one case group `discuss | note | feedback | answer | revise` that maps `note` and
  `feedback` to `message`. One case group for all commands that are `{ action: c.do }`, with
  `start` and `force` adding their images first. One switch. A private `created(card, c)` that
  both `followUp` and the `newCard` case call for the tail.
- Win: about 25 lines.
- Risk: low. `canvas.test.ts` and `commands.test.ts` run commands through `canvas.run`.
- Confidence: high.
- Done by W14: one switch, and `created(cardId, c)` for the tail `followUp` shares.

### D6. The learner and the retrospective each define the `propose` tool
- Principle: DRY
- Size: minor
- Where: `src/server/coordinator.ts:433-451`, `:566-585`
- Now: both tools trim the rule to 500 characters, resolve `repos` through `targets`, drop the
  targets already proposed, look up `rules[replaces - 1]` and call `board.proposePreference` once
  per target. They differ in the cap (three per retrospective, one per input), in the quote
  (`why`, or the owner's text), in the log line on the card, and in whether a refusal ends the
  turn.
- Why it matters: the test for "already proposed" and the 500-character cap exist twice.
- Change: `private proposeRule(rule, replaces, repos, quote): 'empty' | 'known' | 'proposed' |
  string`
  holds the shared steps (a string is the problem with `repos`). Each tool keeps its cap and its
  wording.
- Win: about 12 lines.
- Risk: low. `coordinator.test.ts` covers both tools.
- Confidence: high.
- Done by W14 in `learner.ts`: `proposeRule` (targets, what is proposed already, the rule it
  replaces) and `ruleText` (the cap). Each tool keeps its order of checks, its cap, its words, and
  the open proposals it checks against: the retrospective the live list, the learner the list as
  its turn began, since the work retrospective may propose meanwhile.

### D7. `tagOf` scans a map backwards for a tag the call site can compute
- Principle: KISS
- Size: minor
- Where: `src/server/coordinator.ts:1477`, its nine call sites (`:309`, `:319`, `:1086`, `:1098`,
  `:1106`, `:1121`, `:1132`, `:1153`, `:1170`), and the `tags` parameter of `brief` (`:1119`) and
  `others` (`:1141`)
- Now: `tags` maps `cardTag(a.number)` to the card's id, so the agent's answer can be read. To
  print a card, `tagOf(tags, id)` searches the map's entries for the id. Every call site has the
  `Item` in hand, so the tag is `cardTag(item.number)`.
- Why it matters: `brief` and `others` take a `tags` parameter that they use for nothing else.
- Change: replace the nine calls with `cardTag(x.number)`, delete `tagOf`, and drop `tags` from
  `brief` and `others`.
- Win: one helper and two parameters.
- Risk: low. The strings are identical.
- Confidence: high. I checked that each call site has the item.

### D8. A card's line for the assistant is one 2,108-character template literal inside a 180-line `brief`
- Principle: KISS
- Size: minor
- Where: `src/server/commands.ts:1265-1447`, in it `describe` at `:1274-1311`, the return at
  `:1310` and the `paused` expression at `:1294` (787 characters)
- Now: `brief` builds the whole message for one command. Its inner `describe` returns one
  template literal with twelve optional suffixes (review card, project, group, prototype,
  proposal, superseded, status, questions, next step, variants, split, new repository), several
  with ternaries nested inside `${}`. The state before it is a chain of seven ternaries
  (`:1276-1292`).
- Why it matters: finding which suffix a field produces means counting braces on one line, and a
  diff of that line shows 2,108 characters as changed.
- Change: move `describe` out of `brief` to a module-level `cardLine(i, context)` that pushes
  each suffix onto an array and joins it, with the state and the pause as two small functions
  (`stateOf(i, items)`, `pauseOf(i)`). The text the agent reads stays the same character for
  character.
- Win: no line over about 200 characters outside the prompts, and `brief` drops to about 140 lines.
- Risk: low to medium. The text is a prompt, so it must come out identical. `commands.test.ts`
  matches parts of it, not all of it. Compare the old and new output on a canvas with every kind
  of card before landing.
- Confidence: high that it is hard to read, medium on the tests' coverage of every suffix.

### D9. Eleven hand-written lookups of a repository by its id
- Principle: DRY
- Size: minor
- Where: `src/server/canvas.ts:317`, `:328`, `:330`, `:334`, `:470`, `:475`, `:609`, `:1539`,
  `:1675`, `:2037`, `:2781`, and as `.some` at `:1578` and `:2389`. Related: `:706` beside
  `settingsOf` (`:616`).
- Now: `this.repos.find((r) => r.ref.id === id)` is written eleven times, twice with
  `?? this.repos[0]!` behind it. `repoOf` (`:1536`) and `runs` (`:1576`) do the same lookup from a
  card. At `:706`, `this.deps.settings ? this.deps.settings(path) : best.r.config.settings`
  restates `this.settingsOf(best.r.config)()`.
- Why it matters: small, but it is the most repeated expression in the file.
- Change: `private repo(id: string): Repo | undefined`. `repoOf` and `runs` use it, and `:706`
  calls `settingsOf`.
- Win: thirteen call sites shorter.
- Risk: low.
- Confidence: high. `info.path` equals `resolve(config.path)` because `readRepos` reads each
  repository under that path, so `:706` and `settingsOf` agree.
- Done by W14: `private repo(id)`; `claudeHeld` reads this machine's settings through
  `settingsOf`.

### D10. Three sequences of the repository restart written twice each
- Principle: DRY
- Size: minor
- Where: `src/server/canvas.ts:946-950` and `:1248-1255`; `:944` and `:1257`; `:1146` and `:1199`
- Now: when the home repository fails, both `clonesFailed` and `restartAs` set `this.stopped`,
  call `this.shutdown()` and then `this.deps.stopped?.(this, messageOf(e))`. Both rewrite the
  board's list with `this.board.canvas.repos.splice(0, this.board.canvas.repos.length,
  ...this.repos.map((r) => r.ref))`.
  `cancelPending` and `restartAs` both run
  `for (const r of this.repos) if (p.paths.has(r.info.path)) r.workers.restartDue(this.obeyaDue)`.
- Why it matters: stopping a canvas is a sequence with an order, and it should exist once.
- Change: `private homeDown(e)`, `private showRepos()` and `private undue(p: RepoRestart)`.
- Win: about 8 lines, three named steps.
- Risk: low. The two callers of the home-down sequence log and emit around it in different
  order, which stays with the callers.
- Confidence: high.
- Done by W14: `homeDown(e)` (stopped, shut down, left out), `showRepos()`, `undue(p)`. In the
  restart, the log line and `emitPending` now come before the canvas shuts down rather than
  between that and its leaving the list: neither reads what the shutdown changes.

### D11. `act` reads the card it already holds five more times
- Principle: KISS
- Size: minor
- Where: `src/server/canvas.ts:1801-1944`, the re-reads at `:1821`, `:1857`, `:1863`, `:1889`,
  `:1896`
- Now: `act` reads `const card = this.board.item(cardId)` at `:1804`. Nothing changes the board
  between that line and the switch, yet five cases call `this.board.item(cardId)` again, one of
  them into a second `const card` that shadows the first (`:1863`). That `unsay` case also walks
  the same question, idea, else-worker ladder that `agentOf` (`:1328`) holds, with one more
  branch for a proposal.
- Why it matters: a reader has to check whether the card changed in between, and it did not.
- Change: use `card` in the five cases. Write `unsay` as
  `(card?.state === 'proposal' ? this.revisions : this.agentOf(cardId)).unsay(cardId, a.id)`.
- Win: about 8 lines and one shadowed name.
- Risk: low. `written(cardId)` runs before `:1804` and is the only call ahead of the switch that
  could touch the card.
- Confidence: high.
- Done by W14.

### D12. The rule for a time to wait until is checked in three places, one of them incomplete
- Principle: DRY
- Size: minor
- Where: `src/server/commands.ts:1085-1088` (`new_card`), `:1198-1200` (`snooze`),
  `src/server/canvas.ts:574-578` (`until`)
- Now: `new_card` refuses a time that does not parse, has passed or lies more than
  `SNOOZE_LIMIT` ahead. `snooze` refuses the first two only. `CanvasRuntime.until` checks all
  three again when the command runs. A snooze two years ahead therefore passes the assistant's
  check, the owner hears a confirmation, and after the undo window the card logs an error.
- Why it matters: the same rule in three wordings, and the gap in the second.
- Change: in `commands.ts`, `const futureTime = (s?: string): number | string` returns the time
  or the reason, and both `new_card` and `snooze` call it. `CanvasRuntime.until` stays as the
  guard for the HTTP route. Closing the gap in `snooze` changes what the assistant is told for a
  time over a year ahead, so decide that with the owner or keep the two messages as they are.
- Win: about 6 lines and one rule.
- Risk: low. `commands.test.ts` covers the refusals of both actions.
- Confidence: high. `SNOOZE_LIMIT` appears in `commands.ts` only at `:1088`.
- Bug fixed (W1 of the bug plan): `snooze` refuses a time more than `SNOOZE_LIMIT` ahead with
  `new_card`'s message, so `futureTime` changes nothing the assistant is told.
- Done by W6 with A15: `laterTime` serves `new_card` and `snooze` alike, each with its words.

### D13. `oneLine` and `clip` from `core/text` spelt out inline
- Principle: DRY
- Size: minor
- Where: `src/server/push.ts:68` (`clipped`); `.replace(/\s+/g, ' ').trim()` at
  `src/server/commands.ts:1029`, `:1038`, `:1058`, `:1471`, `src/server/coordinator.ts:990`,
  `src/server/wish.ts:83`, `src/server/canvas.ts:2897`
- Now: `clipped` in `push.ts` is `clip` from `src/core/text.ts:4` under another name, the same
  expression. Seven places write `oneLine`'s regular expression out, four of them in
  `commands.ts`, which imports `oneLine`.
- Change: use `oneLine` at the seven places and `clip` in `push.ts`.
- Win: one local helper and seven regular expressions.
- Risk: low.
- Confidence: high. I compared `clipped` with `clip` and each site with `oneLine`.
- Done by W6 with J5.

### D14. Phrases and filters of the waits restated in `commands.ts`
- Principle: DRY
- Size: minor
- Where: `'is done' : 'waits for the owner'` at `src/server/commands.ts:990`, `:1294`, `:1492`,
  `:1495` and `src/server/canvas.ts:1746`; the filter `i.parent === p.id && i.state === 'planned' &&
  !i.queue`
  at `src/server/coordinator.ts:227`, `src/server/commands.ts:1144`, `:1386`
- Now: `until(state)` at `commands.ts:1495` is the phrase for an awaited state, and four other
  places write the same ternary. "A project's planned workstreams that are not with Obeya yet" is
  filtered in three places with the same three conditions.
- Why it matters: `requestAll` decides what "start the project" starts, and the assistant is told
  what it would start by a copy of the filter.
- Change: export `until` (under a clearer name such as `reaches`) and use it at the five places.
  Add `startable(project: Item, items: Item[]): Item[]` to `src/core/queue.ts` for the filter.
- Win: about 6 lines, and one definition of what a project's start covers.
- Risk: low.
- Confidence: high.

### D15. A promise raced against a timer, written by hand in seven places
- Principle: DRY
- Size: minor
- Where: `src/server/walkthrough.ts:208-221`, `src/server/narration.ts:127-140` (this slice);
  `src/server/usage.ts:221-229`, `src/server/codex.ts:438-440`, `:545-549`,
  `src/server/runtime.ts:638-640`, `src/server/skills.ts:83-90` (other slices)
- Now: each place builds a `late` promise around `setTimeout`, races it against the work and
  clears the timer in `finally`. Four resolve to a sentinel when time is up and three reject.
  `usage.ts` already has a private `withTimeout` for the rejecting form. The two in this slice
  are twins: `Voicing.listen` and `NarrationHost.hear` both hear a WAV back with a limit, and
  `HEAR_MS` (`walkthrough.ts:28`) and `HEAR_CLIP_MS` (`narration.ts:55`) carry the same comment
  with 60 and 120 seconds.
- Why it matters: seven chances to forget `clearTimeout`, and each reader decodes the construct
  again.
- Change: one helper beside `messageOf`, for example `src/server/late.ts` with
  `within<T>(work: Promise<T>, ms: number): Promise<T | undefined>` (undefined when time is up),
  and `usage.ts`'s `withTimeout` exported from the same file for the rejecting form.
  `NarrationHost.reply` keeps its injectable `Deadline`, which tests expire by hand.
- Win: about 30 lines over the seven places.
- Risk: low. Each place keeps its own message for the late case.
- Confidence: high. I read all seven.
- Done by W6 with B9.

### D16. The Coordinator's briefs format a card's line six times
- Principle: DRY
- Size: minor
- Where: `src/server/coordinator.ts:319`, `:1098`, `:1106`, `:1132` (a workstream's line),
  `:1156-1157` and `:1170-1171` (a card in progress or ahead), `:316-317` and `:1095-1096` (the
  project's two header lines)
- Now: four places write `- <tag>: <label> "<title>" — <body on one line, cut>` with a cut of
  600, 600, 1,500 and 300 characters and one extra piece each (delivered, the kind and project,
  the state). `others` writes the tag, title, first body line and "expected to change" twice.
  The project header (`The project: "…"; plan doc …` and `Goal: …`) is the same two lines in
  `dependencies` and `schedule`.
- Why it matters: the turns should describe a card the same way, and today a change to the line
  is made six times.
- Change: module-level `workstreamLine(w, cut, extra = '')`, `runningLine(a, hard)` and
  `projectHeader(project)`. With D7 they take the item and need no `tags`.
- Win: about 12 lines.
- Risk: low to medium. These are prompts, so the output must stay identical.
  `coordinator.test.ts` matches parts of the briefs.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/commands.ts:21` `Command` beside `CardAction` (`src/core/types.ts:1553`): two
  vocabularies for overlapping actions, but `Command` is stored in the database during the undo
  window (`board.holdCommand`) and has actions no card has (`configure`, `remember`, `group`).
- `src/server/commands.ts:1121-1206` the checks in `command()` that `canvas.ts` and the workers
  make again when the command runs: the first tells the assistant why before the owner hears a
  confirmation, the second guards the state after the undo window.
- `src/server/coordinator.ts:1218`, `:1233`, `:1275`, `:1295` the git and folder variants of the
  prompts, written out in full: agents read them, and one template with a dozen switches would
  be harder to read than two texts.
- `src/server/to-obeya.ts:15`, `:21` and `src/server/commands.ts:1557` the list of what an agent
  passes on to Obeya, in three wordings: each is a prompt for a different reader, and sharing one
  text would change what at least two agents read.
- `src/server/canvas.ts:3374` `slug`, with `src/server/site-setup.ts:256`,
  `src/server/workspaces.ts:2427`, `src/server/walkthrough.ts:449`, `src/core/plan-doc.ts:212`:
  five slug functions, but each makes a stored name (canvas and repository ids, Cloudflare
  project names, branch names, file names, workstream keys) with its own character set and its
  own handling of "ß". Unifying them risks changing a stored id.
- `src/server/walkthrough.ts:46` `SLIDE` and `:525` `KEPT`: the clone detector's pair. The first
  is what the agent hands over (narration, limits), the second what the file holds after Obeya
  read the code, so they differ by design.
- `src/server/canvas.ts:2094-2133` accept after revision and `:2141-2153`, `:2335-2353` build
  after reply: parallel flows of eight lines each over different stored data, and a shared helper
  would need five parameters.
- `src/server/commands.ts:200`, `:210`, `src/server/coordinator.ts:76-78`,
  `src/server/canvas.ts:101-106` options only tests set (`sessionCommands`, `limitMargin`,
  `holdMs`, `reviewEvery`, `restartIntervalMs`): test seams.

## Bugs noticed in passing
None left: the ones found here were fixed (2026-11-10).
