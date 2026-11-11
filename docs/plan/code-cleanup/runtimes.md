# B: agent runtimes (`runtime.ts`, `codex.ts`, `harnesses.ts`, `spawn.ts`, `replay.ts`, `transcript.ts`, `usage.ts`, `explorers.ts` and the small modules around them)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice is in good shape where it matters most: the `AgentRuntime`/`AgentSpec`/`AgentEvent`
interface is small and both harnesses fill almost all of it (only `permissionMode`, the `background`
event and `error.token` are Claude-only, each for a reason), the decorators (`withRest`,
`withLimitWait`, …) are one idea each, and transcripts are parsed in one module. The two themes
worth a cleanup are (1) `runtime.ts` having grown into three modules in one file (the interface, the
Claude Code runtime, a shell-command reader), and (2) small protocols and helpers written out again
beside the place that already has them: the idle Claude Code session (3×), the pause protocol (3
modules), the background-work wait (workers beside `BackgroundWait`), the "value with listeners"
class (8×), the refresh-after-a-while cache (4×).

## Findings

### B1. `runtime.ts` is the interface, the Claude Code runtime and a shell reader in one 1,167-line file
- Principle: KISS
- Size: major
- Where: `src/server/runtime.ts:1-1167`; mirror `src/server/codex.ts`; `src/server/shell.ts:1-67`
- Now: The file's header says "Agent sessions behind a small interface". The interface and its
  decorators are lines 35-477 (`AgentSpec`, `AgentEvent`, `withAgentSetting`, `withSpend`,
  `byHarness`, `withRepoTrust`, `startingLater`, `withLimitWait`, `withRest`). The rest is three
  other things:
  (a) the Claude Code runtime, about 440 lines: `READ_ONLY_TOOLS`, `runClaudeHere`,
  `claudeExecutable`, `machineClaude`, `chromeAvailable` (217-266), `sdkRuntime`, `mcpSettled`
  (479-646), `spawnHere` (657-672), `resultFailure`, `usageLimit`, `resetIn`, `wallClock`,
  `fromWallClock` (698-766), `deniedBy`, `askOwner` (779-812), `refuseForegroundWait`, `toolCall`,
  `ownToolAllowed`, `withContext` (895-919), `backgroundWork` (1060-1067), `carryImages`
  (1085-1092), `Inbox` (1115-1167);
  (b) a shell-command reader, about 135 lines: `foregroundSleep`, `TIMEOUT`, `COMMAND_BEFORE`,
  `boundTimeouts`, `commandEnd`, `seconds`, `iterations` (921-1042), which already imports
  `withoutHeredocs` from `shell.ts`, whose header is "Reading a shell command line without running
  it";
  (c) what both runtimes share: `trackHere`, `endAgentsHere`, `withStderr`, `limitLifts`,
  `failureReason`, `BackgroundWait`, `idleRuntime`, `cleanEnv`, `carryTo`, `FOREGROUND_SLEEP_LIMIT`,
  `BOUNDED_WAITS`.
  Codex has a file of its own that imports twelve names from this one; Claude Code has none.
- Why it matters: A reader looking for "what is a runtime" scrolls past a timezone converter, a
  `for`-loop iteration counter and an MCP wait. `codex.ts` imports from "runtime" both the contract
  and Claude-flavoured leftovers, so the dependency direction is unclear (which of these is shared
  on purpose?). The shell reader sits apart from the two other shell scanners in `shell.ts` it is
  closest to.
- Change: Moves only, no logic change. (1) New `src/server/claude.ts` with group (a), exporting
  `sdkRuntime` and what tests and
  `machine.ts`/`usage.ts`/`skills.ts`/`harnesses.ts`/`main.ts`/`scripts/build.ts` import today
  (`claudeExecutable`, `machineClaude`, `runClaudeHere`, `spawnHere`, `chromeAvailable`,
  `mcpSettled`, `Inbox`, `resultFailure`, `usageLimit`, `resetIn`, `deniedBy`, `askOwner`,
  `refuseForegroundWait`, `backgroundWork`). (2) Move group (b) with `FOREGROUND_SLEEP_LIMIT` and
  `BOUNDED_WAITS` into `shell.ts` (its tests from `runtime.test.ts` into `shell.test.ts`). (3)
  `runtime.ts` keeps the interface, the decorators and group (c). Split `runtime.test.ts` (418
  lines) the same way. Importers by name are few: `sdkRuntime` (main.ts, hosts.test.ts,
  commands.live.test.ts, scripts/measure-resume-cache.ts), `claudeExecutable` (usage.ts, main.ts,
  machine.ts, skills.ts, harnesses.ts, scripts/build.ts),
  `foregroundSleep`/`FOREGROUND_SLEEP_LIMIT`/`BOUNDED_WAITS` (codex.ts); `askOwner`, `deniedBy`,
  `resultFailure`, `usageLimit`, `resetIn`, `Inbox`, `mcpSettled`, `backgroundWork`,
  `chromeAvailable` are imported by `runtime.test.ts` alone.
- Win: `runtime.ts` shrinks to about 590 lines that are all the contract; the concept "the Claude
  runtime lives in the interface's file" goes; Claude and Codex become two parallel files.
- Risk: low; pure moves, `bun run typecheck` finds every import,
  `runtime.test.ts`/`codex.test.ts`/`shell.test.ts` cover the moved code.
- Confidence: high; read the whole file, grepped every exported name for its importers.

### B2. Three copies of the idle Claude Code session
- Principle: DRY
- Size: moderate
- Where: `src/server/usage.ts:235-258`, `src/server/harnesses.ts:245-260`,
  `src/server/skills.ts:63-81`
- Now: `claudeUsage`, `claudeModels` and `sdkSkills` each build the same thing: an
  `AbortController`, an async generator as `prompt` that waits for the abort and never yields,
  `query({ prompt, options: { cwd, abortController, env: cleanEnv(), pathToClaudeCodeExecutable
  (when `claudeExecutable()` names one), spawnClaudeCodeProcess: spawnHere(() => {}) } })`, then a
  control request on `q`. Same in `claudeUsage` and `claudeModels` down to the comment "the session
  waits for a prompt that never comes" and the drain loop `for await (const _ of q);`. Differences:
  `settingSources: []` in usage and models, `['user']` only when untrusted plus `plugins` in skills;
  skills does not drain `q`; models and skills abort in a `finally` after one answer, usage keeps
  the session until `close()`.
- Why it matters: How Obeya starts Claude Code without a prompt (which executable, which env, out of
  the terminal's process group via `spawnHere`) is a rule of `sdkRuntime` restated three times; a
  change to it (a new env variable to strip, a new SDK option) has to reach four `query()` calls.
- Change: One helper beside the Claude runtime (in `claude.ts` after B1, else `runtime.ts`):
  `idleClaude(cwd, options?: Partial<Options>): { q: Query; close(): void }` that builds abort, the
  never-yielding prompt, the common options, and drains `q`. `claudeUsage` becomes `const { q, close
  } = idleClaude(cwd, { settingSources: [] }); return { fetch: …, close }`; `claudeModels` and
  `sdkSkills` call it and `close()` in their `finally`. Draining `q` in `sdkSkills` too is harmless
  (it reads only control answers).
- Win: about 35 lines, and one place that says how a prompt-less Claude Code session is started.
- Risk: low, but unprotected: the tests of `Skills`, `Harnesses` and `UsageMeter` inject fakes in
  place of these three functions, so no test runs them. Check once in a scratch Obeya (`bun
  scripts/scratch-obeya.ts`) that the usage meter, the model versions in the menus and the `/` skill
  menu fill.
- Confidence: high; read all three and the only other `query(` call (`runtime.ts:510`).

### B3. The pause protocol (state write plus log line) is written out in three modules
- Principle: DRY
- Size: moderate
- Where: `src/server/explorers.ts:95-127, 181-182, 208-212, 255-262, 377-381`;
  `src/server/answers.ts:203-252`; `src/server/workers.ts:3020-3021, 3045-3046, 3080-3081,
  3233-3234, 3669`
- Now: Four transitions exist for every kind of agent card, each a `board.work(…)` and a
  `board.log(id, 'state', 'owner', …)` kept in step by hand: about to pause (`{ pausing: <now> }` +
  `t.worker.pausing`), paused (`{ paused: '{}' or held, pausing: null }` +
  `t.worker.pausedByOwner`), pause taken back (`{ pausing: null }` + `t.worker.resumedByOwner`),
  resumed (`{ paused: null }` + `t.worker.resumedByOwner`). `Explorers` and `Answers` each have
  their own `pause`, `pauseAtSafePoint`, `resume`, `pauseTakenBack` with the same
  `BadRequest('noAgent', … 'the agent is paused already' : 'the agent is not working on anything')`
  and `BadRequest('notPaused', …)` (the clone detector's pairs `answers.ts:218-224 <->
  explorers.ts:108-114` and `answers.ts:240-249 <-> explorers.ts:120-133`); `Workers` has a third.
  Inside `Explorers` alone "paused + its log line" is written three times (99 via `interrupt`,
  210-211, 379-380) because `close(cardId, paused)` writes the state and each caller adds the line.
- Why it matters: CLAUDE.md asks that an interaction several card kinds share is built once. A
  change to what a pause records (a new field, another wording) must be made in three files and up
  to eleven places, and a missed one shows as a card that is paused without the log saying so.
- Change: Four small methods on `Board` (it already owns `work` and `log`): `pauseLater(id)`,
  `paused(id, state: PausedState = {})`, `pauseTakenBack(id)`, `resumedByOwner(id)`, each the state
  write plus its line. `Explorers.close(cardId, paused)` then calls `board.paused` and the three
  callers drop their own line;
  `Explorers.pauseTakenBack`/`Answers.pauseTakenBack`/`Answers.halt`/`Answers.goOn` and the worker's
  sites become one call. What each module does around them (ending the session, keeping unread
  words) stays where it is.
- Win: about 30 lines and the hand-kept pairing of state and log line.
- Risk: medium; order of the write and the line must stay (listeners hear both in one
  `Board.changed`). Covered by `ideas.test.ts`, the answers tests and the workers' pause tests.
- Confidence: high for the duplication (grepped `pausedByOwner|resumedByOwner|t.worker.pausing` and
  `pausing:` across `src/server`); medium for `Board` as the home (slice C may prefer a small
  `pause.ts`).

### B4. Workers keep their own copy of `BackgroundWait`
- Principle: DRY
- Size: moderate
- Where: `src/server/runtime.ts:822-880` (`BackgroundWait`, `BACKGROUND_GRACE`, `BACKGROUND_LIMIT`);
  `src/server/workers.ts:4184-4217` (`waitForWorker`, `stopWaiting`, `backgroundChanged`), fields
  `live.waiting`, `live.background`; users of the class: `src/server/advisor.ts:98-143`,
  `src/server/explorers.ts:280-285, 323-359`
- Now: `BackgroundWait` is "a turn that ended waits for the agent's background work": `start()` arms
  a timer of `running > 0 ? limit : grace`, `changed(running)` re-arms it while waiting, `stop()`
  clears it, `onChange(waiting)` tells when the turn starts or stops waiting.
  `Workers.waitForWorker` arms the same timer with the same rule (`live.background > 0 ?
  (o.backgroundLimit ?? BACKGROUND_LIMIT) : (o.backgroundGrace ?? BACKGROUND_GRACE)`),
  `backgroundChanged` re-arms it `if (live.waiting)`, `stopWaiting` clears it. What differs: the
  worker also calls `setBusy(live, true)` on start and `board.changed()` when the waiting began or
  stopped, which is what the class's `onChange` hook is for; on expiry it runs `turnEnded(…, 0,
  true)` and `parkLater`, the `over` callback.
- Why it matters: The class's doc comment says it is for "an agent that answers the owner (an
  idea's, a look-up's)", so the worker, the main user of background work, is the one agent not on
  it; the rule "how long an ended turn waits" is in two places with two sets of option names.
- Change: `Live.work = new BackgroundWait(over, { grace: o.backgroundGrace, limit: o.backgroundLimit
  }, onChange)` in workers, with `over` = today's timer body and `onChange` = the two
  `board.changed()` conditions; `live.waiting` becomes `live.work.waiting`, `live.background`
  becomes `live.work.running`, `waitForWorker`/`stopWaiting` shrink to `setBusy` + `work.start()` /
  `work.stop()`. Update the class comment to name the worker.
- Win: about 25 lines in workers.ts and one statement of the wait rule;
  `BACKGROUND_GRACE`/`BACKGROUND_LIMIT` no longer need exporting.
- Risk: medium; `live.waiting` is read in several worker conditions (workers.ts:3719, 4338) and the
  `board.changed()` conditions differ slightly between start and stop. The workers' background-wait
  tests cover it.
- Confidence: medium; read both implementations and every use of `live.waiting`/`live.background` by
  grep, did not trace each worker caller.

### B5. The "value with listeners" class is hand-written eight times
- Principle: DRY
- Size: moderate
- Where: `src/server/usage.ts:48-49, 96-104, 156-160` (`UsageMeter`) and `169, 206-214`
  (`UsageMeters`); `src/server/harnesses.ts:50, 88, 102-105, 155, 175`;
  `src/server/app-update.ts:15-17, 38-52`; `src/server/source-update.ts:25-26, 55-63, 141-145`;
  `src/server/self-update.ts:84, 95-98`; also `src/server/board.ts:612`, `src/server/canvas.ts:2985`
- Now: This is what the clone list's pairs around `usage.ts:98-107` point at (not a version fetch).
  Each class declares `private listeners = new Set<() => void>()`, an `onChange(fn) {
  this.listeners.add(fn); return () => this.listeners.delete(fn); }`, and loops `for (const fn of
  this.listeners) fn()`. Three of them (`UsageMeter`, `AppUpdates`, `SourceUpdates`) are in addition
  the same three members: `private last: T | null`, `current(): T | null { return this.last; }` and
  `private set(v) { if (JSON.stringify(v) === JSON.stringify(this.last)) return; this.last = v;
  notify }`. `server.ts:322-324` subscribes to all three the same way (`x.onChange(() => everyone(…
  x.current() …))`).
- Why it matters: Small, but it is the repository's most-copied block, and the three "last value"
  classes hide their actual job (expiry, fetching, polling) behind the same ten lines of plumbing.
- Change: A tiny shared class, e.g. `src/core/watched.ts`: `class Listeners { onChange(fn): () =>
  void; protected emit(): void }` and `class Watched<T> extends Listeners { current(): T | null;
  protected set(v: T | null): void }` (JSON equality as today). `AppUpdates`, `SourceUpdates`,
  `UsageMeter` extend `Watched<…>`; `UsageMeters`, `Harnesses`, `Restarter` extend `Listeners` (or
  hold one). Leave `Board`/`Canvas` to their slices.
- Win: about 50 lines across the six classes; one definition of "changed" (JSON equality).
- Risk: low; behaviour is identical member for member. `usage.test.ts`, `harnesses.test.ts`,
  `app-update`/`source-update` tests subscribe through `onChange`.
- Confidence: high; grepped `onChange(fn: () => void): () => void` and `JSON.stringify(…) ===
  JSON.stringify(this.last)` over `src`, read each class.
- Done by W6 with F6: `Listeners` and `Watched<T>` in `src/core/watched.ts` (core, so the UI's
  stores of W20 can take them too). `AppUpdates`, `SourceUpdates` and `UsageMeter` extend
  `Watched`; `UsageMeters`, `Harnesses`, `Restarter` and `Canvases` extend `Listeners`. `Board`
  keeps its own: it tells its listeners after the change, once for many, and catches what each
  throws.

### B6. Four hand-rolled "kept a while, asked again behind it" caches
- Principle: KISS
- Size: moderate
- Where: `src/server/harnesses.ts:41-47, 180-192` (`newest`), `203-217` (`listed`), `219-229`
  (`models`); `src/server/skills.ts:98-128` (`Skills`)
- Now: `Harnesses.claudeListed()` and the first half of `Harnesses.claudeUpdate()` are the same
  algorithm on two fields of slightly different shape (`{ at, models, asking?: Promise<void> }` and
  `{ at, version?, asking?: true }`): if nothing is being asked and the value is older than a TTL,
  start asking, mark it as asking while keeping the old value and `at`, on success store value and
  `at = now`, on failure `console.warn` and store the old value with `at = now`; return the old
  value at once. `Skills.of()` is the same per key (returns the kept list, asks behind it when older
  than `FRESH_MS`, one ask at a time) except that the very first call waits and a failure forgets
  the value. `Harnesses.codexModels()` is the blocking variant (keeps the promise, forgets it on
  failure). `Harnesses.set()` invalidates by `this.listed.at = 0`, `updateClaude()` reaches into
  `this.listed?.asking` to wait.
- Why it matters: `Harnesses` is 190 lines of which about 60 are this bookkeeping in three dialects;
  the reader has to check for each that "asking" is cleared on both paths and that a failure does
  not retry in a loop. `claudeUpdate()` does two jobs (refresh npm's newest in the background, then
  compute what the view says), which the cache hides.
- Change: One small class in the server, e.g. `Kept<T>`: `constructor(ask: () => Promise<T>, forMs:
  number, o?: { onFail?: (e) => void; keepOnFail?: boolean })`, `get(): T | undefined` (the last
  value; starts a refresh when stale), `fresh(): Promise<T | undefined>` (waits for the refresh
  under way), `expire()`. `Harnesses` holds `listed = new Kept(() => ask(cwd), MODELS_FOR_MS, …)`
  and `newest = new Kept(ask, NEWEST_FOR_MS, …)`; `claudeListed()` and the fetch half of
  `claudeUpdate()` become `this.listed.get() ?? []` and `this.newest.get()`; `set()` calls
  `listed.expire()`; `updateClaude()` awaits `listed.fresh()`. `Skills` keeps a `Map<string,
  Kept<Skill[]>>` and awaits `fresh()` when `get()` is undefined. `codexModels()` can stay (it
  blocks on purpose: the view waits for Codex's list) or use `fresh()`.
- Win: about 40 lines, and `Harnesses` reads as what it knows rather than how it remembers.
- Risk: medium; the failure paths differ on purpose (Harnesses keeps the old value, Skills forgets
  it), so the helper needs that one switch. `harnesses.test.ts` and `skills.test.ts` (injected
  `now`) cover TTL, single flight and failure.
- Confidence: medium; read all four, the shape of the helper is a proposal.
- Done by W6: `Kept<T>` in `src/core/kept.ts` (`get`, `last`, `fresh`, `expire`; `forget` for a
  failure that drops the value). The class `Install` in `harnesses.ts` holds its models and npm's
  newest as `Kept`; `Skills` keeps a `Kept` per place. `Harnesses.codexModels` stays: the view
  waits for Codex's list on purpose.

### B7. How a Codex step is named as a Claude Code tool call is stated three times, the shell wrapper three times
- Principle: DRY
- Size: minor
- Where: `src/server/codex.ts:242-268` (`bareCommand`, `itemCalls`), `324-348` (`patchCalls`,
  `hookCalls`); `src/server/transcript.ts:195-238` (`codexRun`); `src/server/shell.ts:4` (`SHELL`)
- Now: The mapping "command → `Bash` with the bare command; a file added → `Write`, changed →
  `Edit`, one call per file with id `<item>:<i>`; Obeya's tool → `mcp__<namespace or
  obeya>__<tool>`; an MCP tool → `mcp__<server>__<tool>`" is written in `itemCalls` (live app-server
  items, camelCase, `changes` an array, `command` a string), in `patchCalls` (from an `apply_patch`
  text) and in `transcript.ts` `codexRun` (the rollout file: PascalCase types, `changes` an object
  by path, `command` an argv). The shell's own wrapper is stripped by `bareCommand`'s regex
  `(?:ba|z|da)?sh\s+-l?c` on a string and again at `transcript.ts:218` on an argv
  (`/(?:^|\/)(?:ba|z|da)?sh$/` and `/^-l?c$/`); `shell.ts` `SHELL` is a third list of shell names
  (`ba|z|da|k|mk` + `ssh`).
- Why it matters: The comment at `transcript.ts:190` says the names are "as the card's log names
  them"; that holds only while both files are edited together (`itemCalls` names `webSearch` and
  `collabAgentToolCall` items, `codexRun` has no case for them; whether the rollout file records
  them was not checked).
- Change: Keep the two readers (the inputs really differ) but share the naming: export from
  `codex.ts` `fileChangeCall(itemId, index, path, kind)` (the `Write`/`Edit` rule and the id),
  `obeyaToolName(namespace, tool)`/`mcpToolName(server, tool)`, and `bareArgv(argv)` beside
  `bareCommand`, both built on one `SHELL_WRAPPER` name list; `itemCalls`, `patchCalls` and
  `codexRun` call them.
- Win: one statement of the naming; about 10 lines.
- Risk: low; `codex.test.ts` (`itemCalls`, `patchCalls`, `bareCommand`) and `transcript.test.ts` pin
  the names.
- Confidence: medium; read all three, the two inputs differ enough that a full merge is not worth
  it.

### B8. The refusal of a long foreground wait is assembled twice
- Principle: DRY
- Size: minor
- Where: `src/server/runtime.ts:546-556, 895-906` (`refuseForegroundWait` and the hook that emits
  `denied`); `src/server/codex.ts:351` (`WAIT_REFUSED`), `667-672`
- Now: Both runtimes do: `foregroundSleep(command) > FOREGROUND_SLEEP_LIMIT` → emit `{ type:
  'denied', name: 'Bash', input, by: 'obeya' }` → answer the hook with `{ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }`. The
  reason's first sentence ("Not run: this command sleeps in the foreground for more than N seconds
  (or in a loop with no bound), and a note from the owner reaches you only once a command is done.")
  is typed out in both; the advice after it differs on purpose (Claude Code:
  `run_in_background`/Monitor; Codex: snooze).
- Why it matters: The limit's wording and the hook answer's shape are one rule; changing the limit's
  explanation means editing two prompts for agents.
- Change: In the module that holds `foregroundSleep` (shell.ts after B1): `waitRefused(command:
  string, advice: string): HookJSONOutput | undefined` returning the deny answer with the shared
  first sentence + `advice`, or nothing when the command may run; `WAIT_ADVICE.claude`/`.codex` hold
  the two tails. Both hooks become `const out = waitRefused(command, …); if (out) emit denied;
  return out ?? {}`. The texts the agents read stay byte for byte.
- Win: about 10 lines; one place for the rule's wording.
- Risk: low; `runtime.test.ts` (`refuseForegroundWait`, `BOUNDED_WAITS`) and `codex.test.ts`
  (`WAIT_REFUSED`) pin both texts.
- Confidence: high.

### B9. "Give up after N ms" is hand-rolled five times beside a `withTimeout` helper
- Principle: DRY
- Size: minor
- Where: `src/server/usage.ts:221-229` (`withTimeout`, private); `src/server/codex.ts:437-441`
  (`pluginsListed`), `545-556` (`model`); `src/server/skills.ts:82-90`;
  `src/server/runtime.ts:638-640` (`mcpSettled`); outside the slice the same shape at
  `src/server/narration.ts:133`, `src/server/walkthrough.ts:214`
- Now: Each site writes `let timer; const late = new Promise((_, reject) => (timer = setTimeout(…,
  ms))); await Promise.race([p, late])` with a `finally { clearTimeout(timer) }`. `usage.ts` already
  has this as `withTimeout(p, ms)`. Two sites reject with a message of their own (codex `model`: "no
  answer in 30 seconds"; skills: "Claude Code did not list its skills"), two resolve instead of
  rejecting (`pluginsListed`, `mcpSettled`).
- Why it matters: Five places to forget the `clearTimeout` (a pending timer keeps a test process
  alive), and the intent ("at most 30 s") is buried in four lines each.
- Change: Export `withTimeout<T>(p, ms, message?)` from a shared server module (it rejects), plus
  `within<T>(p, ms): Promise<T | undefined>` for the two that give up quietly; use them in the five
  sites, keeping each message.
- Win: about 20 lines.
- Risk: low; error texts stay when passed as `message`. Covered by `codex.test.ts` (model catalog
  timeout), `skills.test.ts`, `runtime.test.ts` (`mcpSettled`).
- Confidence: high; grepped `Promise.race(` over `src`.
- Done by W6 with D15: `within` (undefined when time is up) and `withTimeout` (rejects, with a
  message of its own) in `src/core/late.ts`. Besides the seven sites, the four races against
  `Bun.sleep` (`narration.ts` twice, the eviction in `workers.ts`, the harness look in `main.ts`)
  use `within` too.

### B10. `Explorers.send` takes six positional arguments, three of them flags or lists
- Principle: KISS
- Size: minor
- Where: `src/server/explorers.ts:238` and its callers at `87, 120, 155, 156, 166, 215`; `launch` at
  `274`
- Now: `private send(card, message, images = [], quiet = false, said = [], owner = false)`. Call
  sites read `this.send(card, unanswered ? 'Answer them now.' : RESUMED, [], !unanswered, [], true)`
  and `this.send(card, …, images, false, [said.id], true)`; `launch(card, current, message, resume,
  images, quiet)` continues the row.
- Why it matters: At a call site nobody can tell `quiet` from `owner` without opening the signature;
  the empty `[]` fillers exist only to reach the last flag.
- Change: `send(card, message, o: { images?: string[]; quiet?: boolean; said?: number[]; owner?:
  boolean } = {})`, same for `launch`'s tail. Call sites become `this.send(card, RESUMED, { quiet:
  true, owner: true })`.
- Win: no lines, but six call sites that say what they mean.
- Risk: low; private methods, `ideas.test.ts` drives them through the public ones.
- Confidence: high.

### B11. `OWN_TOOLS` in the explorer can never match
- Principle: YAGNI
- Size: minor
- Where: `src/server/explorers.ts:337, 621`
- Now: `if (!e.name.startsWith('mcp__') && !OWN_TOOLS.includes(e.name))` with `OWN_TOOLS = ['reply',
  'update_brief', 'plan_prototypes', 'plan_split', 'plan_repo', 'record_decision', 'to_obeya']`. A
  `tool` event names Obeya's tools as `mcp__obeya__<name>` on both harnesses (Claude Code's own
  name; `codex.ts:258` builds `mcp__${namespace ?? 'obeya'}__${tool}`), so the first condition
  already drops them; the bare names never arrive. `workers.ts:3917` and `answers.ts:109, 459` make
  do with the prefix check. No test emits a bare name (`ideas.test.ts:105` emits
  `mcp__obeya__update_brief`).
- Why it matters: A parallel list of the tool names that would have to follow `tools()` by hand (it
  already needs `to_obeya` added by hand), for a case that cannot occur.
- Change: Delete `OWN_TOOLS` and the second condition.
- Win: 2 lines and a list to keep in step.
- Risk: low.
- Confidence: high; grepped every `type: 'tool'` emitter and the tests.

### B12. `Harnesses`' `updateClaude` option takes a `log` nobody reads
- Principle: YAGNI
- Size: minor
- Where: `src/server/harnesses.ts:64-65, 160`; `src/server/main.ts:322`; `src/server/machine.ts:174`
- Now: The option is `updateClaude?: (log: (line: string) => void) => Promise<void>`, documented
  "the last line of its output to `log`". Its only call is `await update(() => {})`; `main.ts` wires
  `(log) => updateClaude(log)`, and `machine.ts` `updateClaude(log = () => {}, …)` defaults it
  anyway.
- Why it matters: A parameter and a doc line that suggest progress is shown somewhere.
- Change: `updateClaude?: () => Promise<void>`, `await update()`, `main.ts`: `updateClaude: () =>
  updateClaude()`.
- Win: a parameter and a misleading comment.
- Risk: low; `harnesses.test.ts` passes its own fake.
- Confidence: high; grepped `updateClaude`.

### B13. `runCodex` is a fourth "run a program and collect its output", and its `{ ok, out }` answer is never used as such
- Principle: DRY
- Size: minor
- Where: `src/server/codex.ts:67-98` (`runCodex`, `codexVersion`, `codexLogin`); the others:
  `src/server/spawn.ts:298` (`spawnOutput`), `plugin/skills/demo/lib/setup.ts:106` (`output`, used
  by `machine.ts`), `src/server/machine.ts:153` (`runLogged`)
- Now: `runCodex` spawns through `child_process`, concatenates stdout and stderr, kills after 15 s,
  and answers `{ ok, out } | null`. Both callers only take the `ok` case (`r?.ok ? … : null`, `if
  (!r?.ok) return { loggedIn: false }`), which is exactly `output()`'s contract ("`null` when it is
  not there or fails") plus `startArgv`'s cmd wrapper for npm's `codex.cmd`. It is exported and used
  only in this file.
- Why it matters: A hand-written spawn/timeout/collect (it settles twice on a timeout, `done(null)`
  then `close`, harmlessly), next to `spawnOutput`, which already takes `timeout` and
  `windowsVerbatimArguments` and runs off the server's thread.
- Change: `const runCodex = async (bin, args, env, ms = 15_000) => { const argv = startArgv(bin,
  args); const r = await spawnOutput(argv, { env, stdin: 'ignore', timeout: ms,
  ...spawnOptions(argv) }).catch(() => null); return r && r.code === 0 ?
  `${r.stdout}${r.stderr}`.trim() : null; }`; callers match on the string.
- Win: about 12 lines, one spawn path fewer.
- Risk: low to medium; Windows' `codex.cmd` path goes through `spawnOutput`'s thread with verbatim
  arguments (in its `THREADED` set). `codex.test.ts` and `harnesses.test.ts` (`findCodex`) cover
  version and login.
- Confidence: medium; read all four helpers, did not run the Windows path.

### B14. `messageOf` restated inline
- Principle: DRY
- Size: minor
- Where: `src/server/harnesses.ts:162, 188, 210, 222`; `src/server/usage.ts:118`;
  `src/server/skills.ts:116`; `src/server/runtime.ts:1110`; `src/server/spawn.ts:227`
- Now: `e instanceof Error ? e.message : e` (or `: String(e)`) is written out where `messageOf(e)`
  from `src/core/text.ts:20` says the same; `runtime.ts`, `codex.ts` and `replay.ts` already import
  it.
- Why it matters: Noise in log lines that are already long.
- Change: Use `messageOf(e)` at the eight sites.
- Win: readability.
- Risk: low.
- Confidence: high.
- Done by W6 with J5.

### B15. Replay's stub sessions and its refusal text are written twice
- Principle: DRY
- Size: minor
- Where: `src/server/replay.ts:501, 510-547, 611-612, 663, 676-677, 686-687`
- Now: `idleSession` and `refusedSession` are the same 15 lines (a deferred `done`, a `closed` flag,
  a microtask per message) differing only in what a turn emits (`idle`, or `error` + `idle`). `play`
  then writes a third "turn ends at once" (`turnEnds`, 663) and repeats the log line "gets a message
  the recording has no turn for; the turn ends at once" at 676 and 686. The message `Replay refused:
  ${why}. Record this demo anew with real agents.` is built at 501 and 611.
- Why it matters: Three spellings of "a session whose every turn ends at once".
- Change: `function stubSession(turn: () => void): AgentSession` (deferred + closed + microtask);
  `idleSession = stubSession(() => spec.onEvent({ type: 'idle' }))`, `refusedSession` passes error +
  idle; `const refusedText = (why) => …` used at both sites; one `noTurnFor()` in `play` for the log
  line + `turnEnds()`.
- Win: about 20 lines.
- Risk: low; `replay.test.ts` covers both stubs and the refusal.
- Confidence: high.

### B16. Runtime literals repeated between and inside the two runtimes
- Principle: DRY
- Size: minor
- Where: `src/server/runtime.ts:523, 611, 658`; `src/server/codex.ts:114, 155, 159, 171, 505, 551,
  572, 596, 646, 655, 788, 883, 946, 990, 1006`
- Now: `STDERR_TAIL = 2000` is declared in both files and the expression `(x +
  text).slice(-STDERR_TAIL)` appears at `runtime.ts:523`, `codex.ts:159` and `codex.ts:596`. The
  `lost` event's text `` `the connection to ${host.name} was lost` `` is built at `runtime.ts:611`,
  `codex.ts:505` and `codex.ts:655`. Inside codex.ts: `'the Codex app server ended'` three times
  (155, 171, 1006), "Codex is not installed on this machine" four times in two wordings (572, 883,
  946, 990), and the mapping `codexLoginFailed(…) → notLoggedIn(host, message)` three times (551,
  646, 788).
- Why it matters: `core/login.ts` matches some of these texts (`codexLoginLost`); texts built in
  several places drift.
- Change: In `runtime.ts`: `export const stderrTail = (kept: string, more: string) => (kept +
  more).slice(-2000)` and `export const lostEvent = (host: string): AgentEvent => ({ type: 'lost',
  message: … })`. In `codex.ts`: `const ENDED = 'the Codex app server ended'`, one `codexBin(env)`
  that throws the "not installed" error (used by `run`, `once`, `codexUsage`, `CodexLogins.start`),
  one `loginError(e, host)` for the three mappings.
- Win: about 10 lines, texts with one source.
- Risk: low; `core/login.ts` `codexLoginLost` matches only `notLoggedIn`'s text, which stays. Keep
  both "not installed" wordings as they are unless `codex.test.ts` shows nothing matches them.
- Confidence: high for the repeats (grepped each literal).

### B17. `carryImages` guards and catches what `carryTo` already guards and catches
- Principle: YAGNI
- Size: minor
- Where: `src/server/runtime.ts:1085-1113`, caller `491`; `src/server/codex.ts:587`
- Now: `carryImages` returns early when there are no images and no dropped files, then wraps
  `carryTo` in a `try/catch` that returns the text. `carryTo` starts with the same early return and
  has the same `try/catch` (it logs and returns the message unchanged). The only thing `carryImages`
  adds is awaiting `dir` (the host's `prepare`) and taking `.text`; Codex calls `carryTo` directly.
- Why it matters: Two functions with nearly the same doc comment; a reader has to diff them to see
  that one is a thin adapter.
- Change: Drop `carryImages`; at 491: `inbox.carry = async (text, images) => (await
  carryTo(there.host, await dir.catch(() => ''), …)).text` or, cleaner, let `carryTo` take `dir:
  string | Promise<string>` and await it inside its `try`.
- Win: about 10 lines.
- Risk: low; `hosts.test.ts` covers carrying images to a host for both harnesses.
- Confidence: high.

### B18. Four copies of "does this pid run"
- Principle: DRY
- Size: minor
- Where: `src/server/testing.ts:347-354`, `src/server/test-setup.ts:17-24`,
  `src/server/instance.ts:68-76`, `src/server/demo-space.ts:78-88`
- Now: Each wraps `process.kill(pid, 0)` in a try/catch. `instance.ts` and `test-setup.ts` are
  identical (they count `EPERM` as alive; the clone list's pair), `demo-space.ts` `rendering` has
  the same rule inline after reading the pid from a file; `testing.ts` exports an `alive` that does
  not count `EPERM`.
- Why it matters: The `EPERM` rule (a process of another user is still a process) is the kind of
  detail that one copy gets and another misses, as `testing.ts` shows.
- Change: Export one `alive(pid)` (with the `EPERM` rule) from `spawn.ts` ("a program run on this
  machine") and import it in the four files (`rendering` keeps reading its pid file and calls it);
  `testing.ts` re-exports it for tests.
- Win: about 20 lines.
- Risk: low; `test-setup.ts` is preloaded by `bun test`, so it must import nothing heavy: `spawn.ts`
  is already imported there.
- Confidence: high.
- Done by W6: `alive(pid)` in `spawn.ts`, imported by `instance.ts`, `demo-space.ts` and
  re-exported by `testing.ts` (which `test-setup.ts` already took it from).

### B19. `ProjectAgents.inform` unpacks its options only to pack them again
- Principle: KISS
- Size: minor
- Where: `src/server/project-agents.ts:51-67, 76-78`
- Now: `const { onTool, dir, signal, onWaiting, images, toObeya, rules = '' } = more;` followed by
  seven `...(x ? { x } : {})` spreads into `inform({...})`. `Briefing` declares all of them optional
  and `advisor.ts` `inform` reads each by truthiness (`b.dir ? …`, `b.signal?.…`,
  `b.onWaiting?.(…)`, `b.tools ?? []`, `b.permissionMode ? …`), and `tsconfig.json` has no
  `exactOptionalPropertyTypes`, so passing `undefined` is the same. `queued()` is a one-line wrapper
  around `oneAtATime` with one caller.
- Why it matters: Fifteen lines to forward seven values; the same idiom is needed elsewhere in the
  slice (objects that are serialized or compared, SDK options), which makes it hard to see where it
  matters.
- Change: `inform({ ...this.fixed(project), onLimit, onTool, dir, signal, onWaiting, images, tools,
  permissionMode: this.permissionMode, system, message, language })`, or simply spread `more` minus
  `toObeya`/`rules`; inline `queued`. Keep the conditional spreads in `runtime.ts`/`codex.ts` where
  the object goes to the SDK, into JSON or into an event.
- Win: about 10 lines.
- Risk: low; no test under `src/server` uses `toStrictEqual`, and `toEqual` ignores `undefined`
  properties.
- Confidence: high; read `advisor.ts` `inform` for how each field is read, grepped the tests'
  matchers.

### B20. The limit-lift timer and its margin are restated in workers
- Principle: DRY
- Size: minor
- Where: `src/server/runtime.ts:339, 358-365` (`withLimitWait`); `src/server/workers.ts:3927,
  4428-4433`
- Now: `withLimitWait(runtime, margin = 10_000)` and `Workers` (`this.o.limitMargin ?? 10_000`) each
  default the margin, and each arms `setTimeout(…, Math.min(Math.max(0, at - Date.now()), 2 ** 31 -
  1))` with the comment "a timer runs at most about 24 days" before sending `LIMIT_LIFTED`. The two
  waits differ on purpose in when the agent goes on (the worker only while it is at work on the
  card, `goesOnAfterLimit`, and it shows a status line), so they stay two.
- Why it matters: One constant and one clamp in two places.
- Change: Export `LIMIT_MARGIN = 10_000` and `atTime(at: number, fn: () => void): Timer` (the
  clamped timeout) from `runtime.ts`; use both in the two sites.
- Win: a constant with one source; 4 lines.
- Risk: low.
- Confidence: high.

### B21. Two doc comments stand apart from what they describe
- Principle: KISS
- Size: minor
- Where: `src/server/runtime.ts:908`; `src/server/testing.ts:275-279`
- Now: `/** Obeya's own tools run without asking anyone. */` stands directly above the doc comment
  of `toolCall`; it belongs to `ownToolAllowed` seven lines below. In `testing.ts` the comment
  "Waits until `done` holds. …" stands above the doc comment of `asOwner`; the function it
  describes, `until`, is at line 356 without a comment.
- Why it matters: Each reads as a second, contradicting description of the function below it.
- Change: Move each comment to its function.
- Win: two comments that describe their code again.
- Risk: low.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/runtime.ts:117` `AgentSpec.permissionMode` is read by the Claude runtime only: Codex
  runs in its own sandbox with its automatic reviewer (`codex.ts:7-11`,
  `docs/design/agents-and-workspaces.md`).
- `src/server/codex.ts:455-486` `CodexSession`'s flags (`turn`, `starting`, `ended`, `steering`,
  `finishing`): each answers a race of the app-server protocol that its comment names (a turn that
  ends before its start is answered, a steer still under way at the turn's end); a single phase
  field would not hold the overlaps.
- `src/server/codex.ts:831-836` `execCommandApproval`/`applyPatchApproval` beside the
  `item/…/requestApproval` requests: the app server's older request names; whether a Codex that
  Obeya supports still sends them cannot be told from the repository, and a host runs its own Codex
  version.
- `src/server/usage.ts:296-307` the five-hour/weekly/per-model fallback in `usageOf`: the compiled
  binary and SSH-less installs run the machine's own Claude Code, which may be older than the one
  that passes the endpoint's `limits` on (`docs/design/the-canvas.md:59-64`).
- `src/server/transcript.ts:165-238` two readers (`claudeRun`, `codexRun`) into one `Run` and one
  `analyse`: two file formats, one analysis; only the naming is shared knowledge (B7).
- `src/server/hosts.ts:306-307` restates the transcript's path rule in shell: it runs on the host,
  where Obeya's code is not.
- `src/server/replay.ts:88-94` `schemaOf` beside `codex.ts:318` `jsonSchema`: the recording's
  fingerprint must stay as recorded (`unrepresentable: 'any'`, the key-list fallback), Codex's must
  be a plain JSON Schema.
- `src/server/workers.ts:4418-4433` the worker's own usage-limit wait beside `withLimitWait`: it
  goes on only while at work on the card and shows a status line (B20 shares the timer only).
- `src/server/spawn.ts:37-181` the lock on process starts and the thread code as a string: Windows'
  inheritable pipes, and the compiled binary has no file to start a thread from (both explained in
  place).
- `src/server/explorers.ts:644-672` the four `OPENING…` texts and five `UNREAD_NOTE` texts share
  sentences: they are prompts, and each stands whole so it can be read and changed as one.
- `src/server/runtime.ts:712-766` `usageLimit`/`resetIn` (Claude Code: the SDK's rate-limit info,
  else the CLI's words) beside `src/server/codex.ts:285` `limitResets` (Codex: its rate-limit
  snapshot): two sources for one `error.limit`, which `withLimitWait` and the worker then treat
  alike.
- `src/server/testing.ts` fakes (`FakeRuntime`, `fakeSsh`, `fakeGh`, `fakeTailscale`): intended test
  doubles.

## Bugs noticed in passing
None left: the ones found here were fixed (2026-11-10).
