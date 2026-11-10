# F: HTTP server, startup, configuration (`server.ts`, `main.ts`, `config.ts`, `settings.ts`, `shared-settings.ts`, `src/adapters`, the update modules and the small modules around them)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The small modules of this slice (access.ts, webpush.ts, zip.ts, images.ts, files.ts, instance.ts,
resources.ts, pdfjs.ts, app-command.ts, voice-cloud.ts, voice-setup.ts, shared-settings.ts) each do
one job and have little to remove. Three things are worth changing. `serve()` in server.ts is one
1,120-line function with 17 positional parameters that holds the websocket fan-out, the voice
pipeline and a 650-line route literal in one closure scope. `Config` also carries the demo-settings
dialog, which shares nothing with it. A repository's settings are listed field by field in seven
places that are kept in step by hand. The three update modules do three different jobs and are not
duplicates of each other. They share only a small "last value plus listeners" holder (F6) and the
test for "these commits change code" (F16).

## Findings

### F1. `serve()` is one 1,120-line function
- Principle: KISS
- Size: major
- Where: `src/server/server.ts:146-1265`
- Now: `serve()` declares about forty closures in one scope and then one object literal. Three
  unrelated parts share that scope. (a) The pages' websocket fan-out, lines 220-404 and 1185-1249:
  `sockets`, `byId`, `waiting`, `waitingSent`, `countWatchers`, `put`, `everyone`, `named`,
  `deliver`, `toward`, `sendTo`, `greet`, `attach`, `detach`, `relist`, `pending`, and the
  `websocket` handlers. (b) The owner's words, lines 438-522: `unheard`, `holdingRestart`,
  `arrived`/`arrive`, `focusOf`, `transcribe`, `listens`, `heard`. Of these, `transcribe` (477-498)
  holds the transcription policy (once more without the card titles when Whisper loops or doubts),
  although `looping` and `silence`, which it calls, live in voice.ts. (c) The route table, lines
  530-1183, with 127 paths in one literal.
- Why it matters: to know what a name in a route refers to, a reader needs the whole scope.
  `started` (222) is shadowed at 341, the parameter `sources` at 206, `device` at 1238, and `c` is a
  canvas or a `Config` depending on the line. The fan-out's rules (what a connection to every canvas
  gets, when a snapshot is owed) cannot be read or tested apart from HTTP.
- Change: three cuts, each behaviour-preserving. (1) A `Pages` class in `src/server/pages.ts` owns
  the sockets and what goes to them. Its constructor takes `{ canvases, restarter, updates, sources,
  usage, push, access, config }`. Its methods are the websocket handlers (`open`, `drain`, `close`,
  `message`), `everyone(msg)`, `waitingCount()`, `onCount(fn)` and `canvas(id)`. `serve()` keeps
  `websocket: pages.handlers`. (2) `hear(transcriber, file, vocabulary)` in voice.ts returns the
  text, `''` or `null` (the body of `transcribe` without the temp file). A small
  `src/server/said.ts` takes `heard`, `listens`, `unheard` and `arrived`. (3) The route literal is
  split by area into functions that return route objects, spread into `guarded({...})`:
  `accessRoutes`, `ownerSettingsRoutes`, `setupRoutes`, `demoSettingsRoutes`, `appRoutes` (update,
  takeover, rebuilt), `canvasRoutes`, `voiceRoutes`. I would do (1) first. The routes touch the
  fan-out through `everyone`, `waitingCount`, `countWatchers` and `byId` only, so it comes out with
  the fewest changes elsewhere.
- Win: no function over about 250 lines in the file. The fan-out can be tested without a server.
  server.ts shrinks to the wiring and the tables.
- Risk: medium. `server.test.ts` (19 servers), `remote.test.ts`, `answers.test.ts` and
  `workers-files.test.ts` exercise routes and sockets end to end. The order of the first messages on
  a socket (`hello`, `update`, `source`, `usage`, `costs`, `canvases`, then `greet`) is behaviour
  and must stay.
- Confidence: high that the three parts are separable (read the whole function and listed what
  crosses between them). Medium on the module names.

### F2. `serve()` takes 17 positional parameters
- Principle: KISS
- Size: moderate
- Where: `src/server/server.ts:146-173`; `src/server/main.ts:444`; about 33 calls in
  `server.test.ts`, `remote.test.ts`, `narration.test.ts`, `config.test.ts`, `answers.test.ts`,
  `tag-proposal.test.ts`, `workers-files.test.ts`
- Now: `serve(served, voice, port, development, config, restarter, narration, machine, stop,
  updates, access, push, sources, usage, stalls, harnesses, used)`. Fourteen are optional. Callers
  count commas, as in `serve([canvas], {...}, 0, false, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, new Stalls(...))`
  (server.test.ts:1153). main.ts:444 passes all 17 in a row. `VoiceIn(home, local, fetch, lazy)`
  (voice.ts:226, main.ts:371) has the same habit on a small scale. main.ts passes `fetch` only to
  reach the fourth parameter.
- Why it matters: `undefined` fits every optional parameter, so a parameter added in the middle
  shifts the tests' arguments without a compile error. Nobody can read a call without the signature
  beside it.
- Change: `serve(served, port, deps: ServeDeps)` with `interface ServeDeps { transcriber;
  voiceSetup?; development?; config?; restarter?; narration?; machine?; stop?; updates?; access?;
  push?; sources?; usage?; stalls?; harnesses?; used? }`. The defaults (`new AppUpdates()`, the
  in-memory `Access`, `Push`) apply inside. Tests get a local `serveTest(canvases, deps = {})` that
  fills in the silent transcriber they all repeat.
- Win: every call names what it passes. About 33 test lines lose their runs of `undefined` and the
  repeated `{ transcriber: { transcribe: async () => ({ text: '', doubtful: false }) } }`.
- Risk: low. The change is mechanical and the compiler checks it.
- Confidence: high (grepped every caller of `serve(` in src, plugin and scripts).

### F3. `Config` carries the demo-settings dialog, which shares nothing with it
- Principle: KISS
- Size: moderate
- Where: `src/server/config.ts:246-262` (`demoShape`), `283-318` (`parseDemo`,
  `demoSettingsProblems`, `clipProblems`), `667-757` (`demo`, `home`, `saveDemo`, `voiceCheck`,
  `checkDemo`, `demoSetup`, `voiceJob`, `installDemoVoice`, `sampleDemoVoice`),
  `ConfigOptions.narrationUrl`, `ttsLock`, `space` (216-219, 236-237); routes
  `src/server/server.ts:733-751`
- Now: `Config` is the canvases' configuration (`canvases.json`: read, check, save, apply, share
  settings, trust). About 170 of its 795 lines are the demo settings (`demo.json`). They read only
  `o.server.home`, `o.space`, `o.narrationUrl` and `o.ttsLock`, touch none of the canvases' state,
  and only the six `/api/demo-settings*` routes call them. `Config` also hands Obeya's home to the
  owner-settings routes through `get home()`, used as `needs(config, (c) => themeView(c.home))` for
  language, theme, usage meter, costs, agents and tag proposals.
- Why it matters: the module's header describes one subject and the class has two. Three of
  `ConfigOptions`' fields exist only for the part that does not belong. A test of the demo settings
  must build a whole `Config` with a store.
- Change: move those members into `class DemoSettingsDialog` in a new `src/server/demo-settings.ts`
  with options `{ home, space?, narrationUrl?, ttsLock? }`, built in main.ts beside `demoSpace`.
  `serve()` takes it as `demoSettings?` and the six routes become `needs(demoSettings, ...)`.
  `Config` loses `narrationUrl`, `ttsLock` and `space`. `get home()` stays, or `serve()` takes
  `home` once F2 makes that cheap.
- Win: config.ts drops to about 620 lines with one subject. Three options go from `ConfigOptions`.
- Risk: low. `config.test.ts` and `server.test.ts` cover the demo-settings methods and routes, and
  the methods move unchanged.
- Confidence: high (grepped `saveDemo|checkDemo|demoSetup|installDemoVoice|sampleDemoVoice|\.demo\(`
  and found the server.ts routes and tests only).

### F4. `Restarter` tracks the winning reason twice
- Principle: KISS
- Size: moderate
- Where: `src/server/self-update.ts:78-82, 116-130, 164-176, 184`
- Now: two mechanisms decide which reason a waiting restart ends as. `request()` raises
  `current.reason` by `OUTRANKS` (`code`, `config`, `repository` 0, `takeover` 1, `update` 2, `stop`
  3). The same call also sets the booleans `stopping`, `updating`, `taking`, and `go()` picks
  `this.stopping ? 'stop' : this.updating ? 'update' : this.taking ? 'takeover' : reason`. `owner()`
  reads `this.stopping`. I walked every order of requests: stop after update, update after stop,
  takeover after update, update after takeover, equal ranks, and the immediate `go` with nothing
  waiting. The flags and `current.reason` never disagree. A flag is only set while `current` exists
  or in the call that goes at once, and `gone` ends everything after.
- Why it matters: the rule "the reason that ends more of this server wins" is written as a table and
  again as a chain of ternaries plus the `!this.stopping` guard at line 119. Whoever adds a reason
  must extend both.
- Change: drop `stopping`, `updating` and `taking`. `go(asked)` reads `const reason =
  this.current?.reason ?? asked` before it clears `current`. The `whenIdle` callback and `now()`
  call `this.go()` without a reason. `owner()` returns `[]` when the reason is `'stop'`, and
  `request()` computes `const owner = reason === 'stop' ? [] : this.owner()` for a new stop.
- Win: three fields and one ternary chain go. The ranking is stated once.
- Risk: low to medium. `self-update.test.ts:396-470` covers these turns (stop over restart, update
  over restart, update or stop over takeover, stop over update, stop at once while a video plays).
- Confidence: high on the equivalence (traced by hand as listed). Not run.

### F5. A repository's settings are listed field by field in seven places
- Principle: DRY
- Size: moderate
- Where: `src/core/types.ts:2013-2063` (`RepoSettings`), `:2076` (`SHARED_FIELDS`), `:2079`
  (`NESTED_SETTINGS`), `:2148-2162` (`RepoValues`); `src/adapters/schema.ts:13-54` (`settingsShape`,
  `site`, `app`, `demo`, `planDocs`) and `:63-69` (`KNOWN`); `src/server/config.ts:68-118`
  (`tidySettings`, `tidyApp`, `tidySite`); `src/adapters/index.ts:61-75` (`repoValues`);
  `src/adapters/generic.ts:11-17` (`generic`)
- Now: a new setting means edits to the interface, the zod shape, the ordered field list,
  `tidySettings`, `repoValues` with `RepoValues`, and the dialog. The compiler ties only some of
  these together. `SHARED_FIELDS` is checked to hold only valid keys (`satisfies readonly (keyof
  SharedSettings)[]`), not all of them. `tidySettings` maps `z.infer<typeof settingsShape>` to
  `RepoSettings` field by field. Every field is optional, so a field missing from it type-checks and
  is dropped on every save of the configuration without a message. Five of its thirteen lines pass a
  value through unchanged (`land`, `direct`, `autoMerge`, `workspaces`, `language`). The defaults
  are split too. `generic` holds five, and `repoValues` holds the rest inline (`autoMerge ?? true`,
  `checks ?? []`, `setup ?? ''`, `prNoise ?? []`).
- Why it matters: `shared-settings.ts:51`, `config.ts:360`, `canvas.ts:2052` and
  `adapters/index.ts:25` all iterate `SHARED_FIELDS`. A setting left out of it is never taken over
  into the repository and never read live, and nothing fails.
- Change: keep the documented interface in core, since the UI reads it, and make drift a compile
  error. (1) In schema.ts, a type-level assertion that `z.infer<typeof settingsShape>` and
  `RepoSettings` are assignable to each other. (2) In core/types.ts, an assertion that
  `Exclude<keyof SharedSettings, (typeof SHARED_FIELDS)[number]>` is `never`, and `KNOWN['']`
  becomes `SHARED_FIELDS`. (3) `tidySettings` starts from `{ ...s }`, overrides only the fields it
  normalises (`branch`, `checks`, `setup`, `planDocs`, `softPaths`, `prNoise`, `app`, `demo`) and
  drops the `undefined` ones, so a new plain field passes through. (4) The four inline defaults of
  `repoValues` move into `generic`. The other shape, `RepoSettings` derived from the zod shape,
  would move the field documentation into schema.ts and bring a zod type into core. I would not take
  it.
- Win: five pass-through lines go, a forgotten field no longer disappears on save, and the defaults
  stand in one place.
- Risk: low for (1), (2) and (4). Medium for (3). `config.test.ts` covers what a saved configuration
  looks like, and `tidySettings` must keep dropping empty values as now (an empty `checks` list
  stays, an empty `branch` goes).
- Confidence: high on the places (grepped `SHARED_FIELDS|settingsShape|sharedShape`). Medium that no
  test already pins the lists against each other (found none).

### F6. "Last value plus listeners" written out in each holder
- Principle: DRY
- Size: minor
- Where: `src/server/app-update.ts:15-17, 39-52`; `src/server/source-update.ts:25-26, 56-63,
  141-145`; `src/server/self-update.ts:84, 95-98, 178-180`; outside the slice
  `src/server/usage.ts:97-107, 206`, `src/server/harnesses.ts:102`, `src/server/canvas.ts:2985`,
  `src/server/board.ts:612` (the clone list has the first four pairs)
- Now: `AppUpdates` and `SourceUpdates` each hold `last`, a `Set<() => void>`, `current()`, an
  `onChange(fn)` that returns the unsubscribe, and a `private set(x)` that compares by
  `JSON.stringify` and calls the listeners. The two are the same but for the type. `Restarter` has
  the listener half (`listeners`, `onChange`, `emit`).
- Why it matters: eight classes carry the same six to twelve lines. The compare-by-JSON rule in
  `set` should exist once.
- Change: `src/core/watched.ts` with `class Listeners { on(fn): () => void; emit(): void }` and
  `class Watched<T> extends Listeners { current(): T; set(next: T): void }`, where `set` emits when
  the JSON differs. `AppUpdates` and `SourceUpdates` hold a `Watched<… | null>` and delegate
  `current` and `onChange`. `Restarter`, `UsageMeter`, `UsageMeters`, `Harnesses`, `Canvases` and
  `Board` use `Listeners`.
- Win: about 10 lines in each of two classes of this slice, about 5 in each of the others.
- Risk: low. `server.test.ts:978-1136` covers the update, source and usage messages.
- Confidence: high (read all three in the slice, found the others by grep of `onChange(fn: () =>
  void)`).

### F7. "Only on this machine" is written inline in eight routes
- Principle: DRY
- Size: minor
- Where: `src/server/server.ts:539, 548, 549, 551, 552, 726, 931-940, 969-977`
- Now: each local-only route writes the check itself. Five use `access.isLocal(req, srv) ? handle(()
  => …) : onlyHere()`, two wrap `on(async (c, req) => {…})(req)` inside that ternary (931-940,
  969-977), and two return early. The other two preconditions have wrappers (`needs` for a
  dependency that may be absent, `on` for a known canvas). This one has none.
- Why it matters: the two card routes at 931 and 969 are hard to read with the guard written around
  `on(...)`. A new local-only route copies whichever variant is nearest.
- Change: `const here = (route) => (req, srv) => (access.isLocal(req, srv) ? route(req, srv) :
  onlyHere())`. Then `POST: here(on(async (c, req) => {…}))` and `'/api/access/pair': { POST:
  here(() => handle(() => access.pair())) }`.
- Win: eight inline checks become one wrapper that composes with `needs` and `on`.
- Risk: low. `remote.test.ts` covers the refusal from another device.
- Confidence: high.

### F8. The four routes for workers' files are stated three times, and their path tail is cut out four times
- Principle: DRY
- Size: minor
- Where: `src/server/server.ts:892-929, 956-967`; `src/server/access.ts:75` (`FILES`) and `:92` (the
  pattern in `keyedFiles`)
- Now: each of the four wildcard routes computes `decodeURIComponent(new
  URL(req.url).pathname.split('/x/').slice(1).join('/x/'))` inside its own `try { … } catch { return
  notFound(); }`. access.ts names the same four routes twice more. `FILES` lists them as path
  suffixes (the routes that skip the cross-site check), and `keyedFiles` matches them with a regular
  expression (`cards/[^/]+/(?:demo|demos/\d+|files)|threads/[^/]+/files`).
- Why it matters: a fifth file route has to go into the table, into `FILES` and into the pattern.
  Where one is forgotten, the frame's own requests are refused with no message that says why.
- Change: in server.ts, a helper `tail(req, marker)` returns the decoded rest of the path or `null`,
  and one wrapper `files((req, file) => …)` answers 404 for `null` or a throw. In access.ts, build
  the pattern from `FILES` (`:name` becomes `[^/]+`, the trailing `*` goes), so the list is the one
  statement there.
- Win: about 20 lines in server.ts and one list in access.ts.
- Risk: low. `workers-files.test.ts` covers the keyed addresses and the 404s. The built pattern
  accepts `demos/<anything>` where the written one wants digits, and the route itself refuses what
  is no number (server.ts:907-908).
- Confidence: high.

### F9. Four spellings of "the request's JSON body"
- Principle: KISS
- Size: minor
- Where: `src/server/server.ts`, 64 uses of `req.json()`: plain `await req.json()` (805, 1097, 1123,
  1127 and the routes that pass it on whole), `((await req.json()) ?? {})` (774, 790, 795, 800,
  1111), `await req.json().catch(() => ({}))` (8 times, among them 935, 1137, 1145, 1153), `((await
  req.json().catch(() => null)) ?? {})` (540, 1006)
- Now: a route that destructures the body picks one of four forms and follows it with an `as { … }`
  cast. The forms differ in what a missing body, invalid JSON and a literal `null` do. The plain
  form answers 400 for invalid JSON and throws a `TypeError` on `null`, which becomes a 500 (see
  Bugs). The others treat some or all of these as an empty object.
- Why it matters: the form a route uses looks like a decision and mostly is none. The casts hide
  that every field is unchecked.
- Change: two helpers beside `handle`. `input(req)` is for routes that pass the body on whole
  (`c.save(await input(req))`, today's plain form). `fields(req, strict = false):
  Promise<Record<string, unknown>>` is for routes that destructure. It returns the object, else
  `{}`, and with `strict` invalid JSON still throws for the routes that answer 400 today. Each
  destructuring route then reads `const { cards, group } = await fields(req)` and checks types where
  it uses them.
- Win: one place says what an empty body means, and about 20 casts go.
- Risk: medium. A route moved from the plain form to the forgiving one answers a malformed request
  differently, so each route keeps its current strictness. `server.test.ts` checks several 400s.
- Confidence: high on the count (grep). The strictness of each route needs care in the change.

### F10. `usageMeter` and `costs` are the same setting twice
- Principle: DRY
- Size: minor
- Where: `src/server/settings.ts:84-102`; routes `src/server/server.ts:638-654`
- Now: `usageMeterView` with `saveUsageMeter` and `costsView` with `saveCosts` are the same pair of
  functions for an on/off value in `settings.json`. Each reads `{ file, on }`, checks `typeof on ===
  'boolean'` with the same message, saves and returns the view. They differ in the key, the log text
  and the default. The meter is on unless `false` is stored, and the costs are off unless `true` is.
- Why it matters: a third switch would be a third copy. The defaults are the only content and are
  written as `!== false` and `=== true`.
- Change: `const SWITCHES = { usageMeter: { byDefault: true, what: … }, costs: { byDefault: false,
  what: … } }` with `switchView(home, key)` and `saveSwitch(home, key, input)`. The file keeps
  storing only what differs from the default, as now. The four exports stay as one-line aliases or
  go.
- Win: about 12 lines, and each switch's default becomes data.
- Risk: low. `settings.test.ts:220-240` covers both.
- Confidence: high.

### F11. "Answer first, then go" is a 100 ms timer in five places
- Principle: DRY
- Size: minor
- Where: `src/server/server.ts:613, 623, 1022`; `src/server/main.ts:240, 308`
- Now: a request that ends the server delays the end by `setTimeout(…, 100)` so that its own answer
  gets out. `/api/restart`, `/api/stop` and `/api/app-update/install` do it in the route.
  `/api/app-takeover` does not, because main.ts's `go` does it for `takeover` alone. The
  configuration's `restart` does it in main.ts. `/api/app-update` with `rebuilt` (server.ts:985)
  requests the update with no delay.
- Why it matters: whether a route must delay depends on a special case two modules away. The one
  route without a delay may lose its answer when no worker is busy.
- Change: the delay lives once, in the `go` callback main.ts gives the `Restarter` (`setTimeout(()
  => leave(reason), 100)` for every reason, as it does for `takeover` today). The three routes and
  the configuration's `restart` call `request`, `now` or `stop` directly.
- Win: four timers and their comments go, and one rule remains.
- Risk: medium. The process ends 100 ms later for restarts nobody asked for over HTTP (new code, a
  signal), which changes nothing the owner sees. `server.test.ts` builds its own `Restarter` and may
  rely on the route's delay.
- Confidence: medium. I read all five places, not the tests' timing.

### F12. `Config` repeats lookups and calls inside itself
- Principle: DRY
- Size: minor
- Where: `src/server/config.ts:420` and `451-452`; `771` and `785`; `608` and `616`; `456, 478-481,
  487`
- Now: (a) `takeSetting` and `shareSettings` each run a full `check` of the whole configuration to
  read one repository's `shareTo`, with the same expression `(await
  this.check(canvases)).resolved[at.canvas]?.repos[at.repo]?.shareTo ?? 'main'`. (b) `retry` and
  `save` both end in `this.o.apply(expandConfig(canvases), resolved.map((r) => r?.id ?? null))`. (c)
  `check` calls `trustOf(got.info.path, got.shared, r.settings, this.o.store)` twice for every
  repository, in the loop that collects problems and again in the `map` that builds the result a few
  lines later. (d) The log line "settings of … for everyone, …" is built three times with nested
  `'branch' in done ? done.branch : ''`.
- Why it matters: `check` is 110 lines, and these repeats make it and its neighbours longer than
  their content.
- Change: (a) `private async landing(canvases, at)` returns the resolved repository. (b) `private
  applyNow(canvases, resolved)`. (c) `check` builds each repository's entry with its trust once and
  derives the `untrusted` problem from it. (d) One `sharedHow(done)` words the three outcomes.
- Win: about 15 lines, and `check` reads the store once per repository instead of twice.
- Risk: low. `config.test.ts` covers all four paths.
- Confidence: high.

### F13. Doc comments that sit on the wrong declaration
- Principle: KISS
- Size: minor
- Where: `src/server/config.ts:759-767`; `src/server/server.ts:760-762`, `1082-1085`;
  `src/server/main.ts:220`
- Now: config.ts has two doc comments stacked above `retry()`. The first ("Saves a configuration
  that works, and the running canvases take it over …") describes `save()` at 775, which has none.
  server.ts:760 ("what the configuration amounts to and what is wrong with it …") describes
  `/api/config/check` and stands above `/api/config/retry`. server.ts:1082 ("the owner started
  speaking: transcription and the Coordinator get ready meanwhile") describes `/voice/warm` and
  stands above `/voice/arrived/:id`. main.ts:220 ("Starts the server again once no worker is in the
  middle of a turn …") describes the `Restarter` at 234 and is the doc comment of `busy`.
- Why it matters: the house style relies on comments to say why. These four say it about the
  neighbour.
- Change: move each to its declaration.
- Win: four comments that describe what they stand on.
- Risk: none.
- Confidence: high.

### F14. Leftovers in `src/adapters`
- Principle: YAGNI
- Size: minor
- Where: `src/adapters/index.ts:186-193` (`hasAdapterModule`); `src/adapters/types.ts:5-7`
- Now: only its own test calls `hasAdapterModule`, the synchronous form (`index.test.ts:138-149`).
  The server uses `readingAdapterModule` (canvas.ts:3113, 3177). `types.ts` re-exports `AppSettings`
  and `DemoSite` from core. Nobody imports `AppSettings` from there. Six server files import
  `DemoSite` from `adapters/types`, the rest from `core/types`.
- Why it matters: the same check and the same type each have two ways in.
- Change: delete `hasAdapterModule` and have its three tests run `gitStepsSync(repo,
  readingAdapterModule(commit))`. Drop the re-export and import `DemoSite` from `core/types`
  everywhere. Fix the two comments that name `hasAdapterModule` (`adapters/index.ts:12`,
  `canvas.ts:3090`).
- Win: one function and one re-export go.
- Risk: low.
- Confidence: high (grepped `hasAdapterModule`, `AppSettings`, `adapters/types`).

### F15. `OBEYA_NARRATION_URL` always equals `OBEYA_URL`
- Principle: YAGNI
- Size: minor
- Where: `src/server/main.ts:339`; `src/server/hosts.ts:413-445`
- Now: main.ts gives every worker `{ OBEYA_URL: narrationUrl, OBEYA_NARRATION_URL: narrationUrl }`,
  and nothing else sets either. hosts.ts reads the port to forward from `OBEYA_NARRATION_URL` and
  strips both names before it sets the remote worker's `OBEYA_URL`. Since the narration got a server
  of its own, `OBEYA_URL` is that server (docs/design/demos.md:294, running-obeya.md:69), so the
  second name tells hosts.ts nothing the first does not. No design chapter mentions
  `OBEYA_NARRATION_URL`.
- Why it matters: two names suggest two addresses, and a reader looks for the difference.
- Change: hosts.ts reads the port from `OBEYA_URL`, main.ts passes `OBEYA_URL` alone, and
  `hosts.test.ts:141`, which gives the two different values, follows.
- Win: one environment name.
- Risk: low to medium. hosts.ts belongs to another slice, and its test tells the two apart on
  purpose, which may record an intent I did not find.
- Confidence: medium.

### F16. Two tests for "do these commits change code"
- Principle: DRY
- Size: minor
- Where: `src/server/self-update.ts:189-192` (`changesCode`); `src/server/source-update.ts:101-102`
- Now: both list changed files with `git diff --name-only` and ask whether some file is not `inert`.
  `changesCode` reads the names with git's default quoting, source-update with `-c
  core.quotePath=false`. Git quotes a path with non-ASCII characters (`"docs/\303\244.md"`), and
  `inert` (core/inert.ts) tests `startsWith('docs/')` and `endsWith('.md')`, which a quoted name
  fails. Such a docs file counts as code for the self-update and as docs for the bar.
- Why it matters: the header of source-update.ts says docs alone do not count "as for the
  self-update", and the two can disagree.
- Change: `changesCode(checkout, range: string[])` with `core.quotePath=false`, used by both
  (`[from, to]` and `['HEAD...@{upstream}']`). "Unknown counts as code" stays for the self-update's
  caller.
- Win: one rule, and the bar and the restart agree.
- Risk: low. The one change in behaviour is that a docs-only commit with a non-ASCII file name no
  longer restarts Obeya.
- Confidence: medium to high (read both and `inert`; did not run git).

### F17. Server messages for the bar are built in two places each
- Principle: DRY
- Size: minor
- Where: `src/server/server.ts:322-324` and `1196-1198`; `383`, `596` and `1201`; `96-123`
- Now: the `update`, `source` and `usage` messages are written in the `onChange` subscriptions and
  again in the socket's `open`. The list of canvases (`canvases.all().map((c) => c.board.canvas)`)
  is written three times. `clipRoute` and `hearRoute` open with the same three lines (JSON only or
  415, parse or 400).
- Why it matters: a field added to one of these messages has to be added twice.
- Change: `const bar = { update: () => msg({ type: 'update', update: updates.current() }), source:
  …, usage: … }` used by both, `const listed = () => canvases.all().map((c) => c.board.canvas)`, and
  `jsonRoute(parse, run)` for the two narration routes. F1's `Pages` class brings the first two with
  it.
- Win: about 12 lines.
- Risk: low.
- Confidence: high.

### F18. `main.ts` declares what it wires after the closures that use it
- Principle: KISS
- Size: minor
- Where: `src/server/main.ts:259-284` (use `transcriber`, declared at 371), `222-233` (`leave` uses
  `shutdown`, declared at 388), `388-402` (`shutdown` uses `awake`, `stalls`, `access`, declared at
  422-428)
- Now: the script runs top to bottom, and closures refer to five constants above their declaration.
  It works because nothing calls those closures before line 444. A reader has to establish that for
  each of them, across two `await`s (325, 326).
- Why it matters: a moved line, or a restart requested earlier than today, becomes a
  `ReferenceError` at run time that the compiler does not see.
- Change: move `scratchFrom`, `transcriber` and `voiceSetup` above `narration` (they need only
  `home`), and `access`, `push`, `awake` and `stalls` above `shutdown` (they need `store`, `home`
  and `busy`). Make `shutdown` a function declaration, so `leave` may stand before it. `canvases`
  and `server` stay `let`, as the cycle with `Config` requires.
- Win: the file reads in the order it runs.
- Risk: low. Only the order of declarations changes.
- Confidence: medium. I checked what each moved line depends on by reading, not by running.

### F19. Git "that asks no one for a password" is wrapped locally in each module
- Principle: DRY
- Size: minor
- Where: `src/server/shared-settings.ts:25-38`; `src/server/source-update.ts:36-44`; outside the
  slice `src/server/read-tree.ts:295-298`
- Now: shared-settings.ts has its own `gitRun` and `must`, source-update.ts its own `this.git`,
  read-tree.ts an inline call. Each is `spawnOutput([GIT, '-C', path, ...args], { stdin: 'ignore',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })` with a different result shape (`{ code, out,
  err }`, `{ ok, out }`, the raw result). workspaces.ts's `gitRun` (156-160) takes no options, so
  none of them can use it.
- Why it matters: the rule that a fetch or push started by the server never waits at a prompt is
  restated wherever one is added.
- Change: export one `gitQuiet(cwd, args, o?: { env?, stdin?, timeout? })` from workspaces.ts beside
  `gitRun`, which returns `{ code, stdout, stderr }` and sets `GIT_TERMINAL_PROMPT=0`.
  shared-settings.ts keeps `must` on top of it, source-update.ts keeps its timeout as an option, and
  read-tree.ts calls it.
- Win: three local wrappers become one, about 15 lines.
- Risk: low. `config.test.ts` (the `shareSettings` tests, shared-settings.ts has no test file of its
  own) and `source-update.test.ts` run real git.
- Confidence: high on the three places (read each). `hosts.ts:669` and `forgejo.ts:330` set the same
  variable for `git credential fill`, a different call that I would leave.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/self-update.ts`, `source-update.ts`, `app-update.ts`: three modules, three jobs
  (restart when the own checkout's HEAD moves, fetch the upstream and pull at a click, relay what
  the app's shell downloaded). They share only F6 and F16.
- `src/server/self-update.ts:234-324` `watchOwnCode` with `headSeal`: asking git every two seconds
  held the server up on Windows, as its comment says, and `sync-calls.test.ts` pins it.
- `src/server/server.ts:753-755` narration routes on the main server beside `serveNarration`:
  recorded in docs/design/demos.md ("Obeya's own server answers the route too, with the owner's key,
  and there may write to an absolute `out`").
- `src/server/config.ts:193-202` and `src/adapters/schema.ts:87-92` `withoutGone` (a repository's
  `share`, `demo.site.language`), `config.ts:256` `reference`, `settings.ts:129` `koordinator`,
  `adapters/index.ts:195-199` the `adapterGone` check: fields that files on colleagues' disks may
  still hold from October and November 2026. docs/design/repositories-and-configuration.md records
  `adapterGone`.
- `src/server/settings.ts` checks by hand while config.ts uses zod: `settings.json` is read
  leniently (a wrong value is ignored, the rest counts) and written one field at a time, which a
  strict shape would not allow.
- `plugin/skills/demo/lib/language.ts` reads `settings.json` beside `settings.ts`: the plugin runs
  without Obeya ("plain Node"), so it cannot import the server's reader.
- `src/server/config.ts:246-262` `demoShape` before `tidyDemoSettings`: the shape refuses a wrong
  field from the dialog with a 400, and the tidy function reads a file leniently.
- `src/server/pdfjs.ts:6-50` 21 imports and a table: `with { type: 'file' }` needs static imports
  for the compiled binary to carry the files.
- `src/server/server.ts:147` `served: Served | CanvasRuntime[]`: the tests pass the array.
- `src/server/main.ts:349` and `387` `welcome` twice: one call for a canvas created while Obeya
  runs, one for a canvas that needed a restart.
- `src/server/access.ts:101-120` `guarded` moves HTML pages to a hidden path: Bun serves a page's
  bundle past any handler.
- `src/server/instance.ts:39-48` `restarting` and `takenOver` differ in one flag: two three-line
  functions, each named for what main.ts does with it.

## Bugs noticed in passing
- `src/server/server.ts:805-806, 1097, 1123, 1127, 1132`: a body that is the JSON literal `null`
  makes the destructuring throw a `TypeError`, which `handle` rethrows as a 500 where the neighbours
  answer 400. Only a hand-written request reaches it.
- `src/server/server.ts:985`: `/api/app-update` with `rebuilt: true` requests the update without the
  100 ms delay its neighbours use. With no worker busy the server may stop before the shell has its
  answer (see F11).
- `src/server/self-update.ts:190`: `changesCode` reads file names with git's default quoting, so a
  docs-only commit that touches a file with a non-ASCII name counts as code and restarts Obeya (see
  F16).
