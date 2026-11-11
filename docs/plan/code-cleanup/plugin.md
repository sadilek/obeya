# P: the plugin, skills for agents (`plugin/`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The plugin is in good shape where it matters most: the languages, the demo settings, the setup
check, the voices and the caption helpers are each written once in `plugin/skills/demo/lib/` and
imported by `src/core`, `src/server` and `src/ui` (`src/core/locale.ts` re-exports `locale.ts`;
nothing is restated on the server side), and the browser launch is one function
(`plugin/lib/chromium.ts`). The two themes worth a cleanup are `director.ts`, which grew into five
modules in one file and drags Playwright and the settings into everything that imports it, and
knowledge stated twice across a boundary: the demo `SKILL.md` against what the scripts print
themselves, a WebVTT parser and an ffconcat writer on both sides of
`director.ts`/`revoice.ts`/`src/server/demo.ts`, and three hand-written CDP clients in `browser.ts`.

## Findings

### P1. `director.ts` is five modules in one file
- Principle: KISS
- Size: major
- Where: `plugin/skills/demo/lib/director.ts:1-1079`; its importers
  `plugin/skills/demo/lib/revoice.ts:22`, `plugin/skills/demo/lib/overlay.test.ts:7`,
  `plugin/skills/demo/example/demo.ts:4`, `scripts/hero-video/demo.ts:13`
- Now: one file holds (a) the scene API, class `Director` (134-353); (b) the watch for a sleeping
  computer,
  `stillSpells`/`tick`/`watchStillness`/`sleepCause`/`stillCause`/`macSleptSince`/`stayAwake`
  (373-441), kept in module-level variables; (c) process plumbing, `underNode`, `holdRenderLock`,
  `alive`, `run` (452-495); (d) the narration call, `writeJobs`/`synthesize` (497-517),
  `heardNotes`/`printHeard` (106-132); (e) the browser and the take,
  `launch`/`newContext`/`explore`/`login`/`failure`/`openPage`/`dryRun` (519-648); (f) the
  screencast, `prioritize`/`startScreencast`/`paintTimes`/`frameWidth`/`frameList` (650-769); (g)
  `runDemo` (771-878); (h) the encoding, `Mark`/`Take`/`assemble` (880-987); (i) the report page,
  `esc`/`PAGE_WORDS`/`reportPage` (989-1079). At import it reads the settings and the environment
  into module constants `SAVED`, `SETTINGS`, `LANGUAGE`, `SILENT` (78-83) and statically imports
  `plugin/lib/chromium.ts`, which imports `playwright-core`.
- Why it matters: `revoice.ts` needs only (c), (d), (h) and (i) (`assemble`, `Clip`,
  `holdRenderLock`, `Mark`, `Report`, `synthesize`) but gets all of it: importing it reads the demo
  settings of the working directory a second time (it then builds its own with `readDemoSettings`, 244)
  and needs Playwright resolved although re-voicing records nothing and asks the setup check for
  `narrationOnly`. `director.ts` imports `revoice.ts` back, dynamically (775), to avoid the cycle.
  `synthesize`'s default argument (`settings = SETTINGS`, 505) and `Director.skip`'s `LANGUAGE`
  (208) hide which settings a call uses. The file has no test of its own; only `paintTimes` is
  reached, through `overlay.test.ts`.
- Change: split along the seams that already exist, without changing any function body.
  `assemble.ts`: `Clip`, `Mark`, `Take`, `assemble`, `heardNotes`, `printHeard`, `reportPage`,
  `PAGE_WORDS`, `esc`, `run`, and the frame list (see P5). `narration.ts` (or into `voices.ts`,
  beside `speak`, which does the same for one clip): `writeJobs`, `synthesize`, with `settings` a
  required parameter. `screencast.ts`: `startScreencast`, `paintTimes`, `prioritize`, `frameWidth`
  and the stillness watch as one small object instead of five module variables. `director.ts` keeps
  `Scene`/`Report`/`DemoSpec`, `Director`, `explore`, `login`, `openPage`, `failure`, `dryRun`,
  `runDemo`, `underNode`, `holdRenderLock`, and re-exports nothing but what demo scripts use
  (`runDemo`, `explore`, the types): demo scripts import it by path, so its exports for them must
  stay. The settings constants become a value `runDemo` computes and passes down (`Director` gets
  the language in its constructor). `revoice.ts` then imports `assemble.ts` and `narration.ts` only;
  `runDemo`'s `--revoice` branch can import it statically.
- Win: no line goes, but the 1,079-line file becomes four of 150 to 450 lines, the import cycle and
  the module-level settings go. (That re-voicing and `--narration` no longer load Playwright is
  done already, see "Fixed" below.)
- Risk: medium. No test covers `runDemo`, `assemble` or `startScreencast`; `overlay.test.ts` covers
  `paintTimes`, `revoice.test.ts` the pure parts of re-voicing. The check after the split is a real
  render and a `--revoice` of it (`scripts/check-binary.ts:189` also names `director.ts` by path,
  and `setup.ts:149` resolves Playwright from `lib('director.ts')`).
- Confidence: high. Read the whole file; importers found with `rg "director\.ts'"` over `src`,
  `scripts`, `plugin`.
- Fixed: the static import of Playwright: `director.ts` imports `chromium.ts` only once a browser is
  needed, so without Playwright a render gets to `checkSetup`'s list (`director.test.ts`).

### P2. The demo `SKILL.md` says again what the scripts print when it applies, and says some things three times
- Principle: DRY
- Size: moderate
- Where: `plugin/skills/demo/SKILL.md:124-128, 151-158, 168-172, 193-199, 211-231, 238-251, 276-285`
  against `plugin/skills/demo/lib/settings.ts:213-234`, `subtitles.ts:267-279`,
  `revoice.ts:293-304`, `director.ts:106-132, 289-294, 471-476, 577-596, 867, 981-986`
- Now: restated from a script's own output, which the agent reads at the moment it matters:
  - 124-128 (person, and what `voice: none` means): `describeDemoSettings` prints both lines with
    their reason ("person: third — the voice is not the owner's, so …", "voice: none — a silent
    video with subtitles; each scene lasts as long as its text takes to read").
  - 193-199 (subtitle translations: where the files go, the shape, one sentence per sentence, the
    stale file): `subtitleBrief` prints exactly this when the render stops with exit 2.
  - 276-285 (re-voicing: `say` as it should sound, same person, tags stay, as many sentences, how to
    quote a label, read the labels from `review/`): `translationBrief` prints each of these.
  - 170-172 (a hidden element or a second ring on the same element fails the scene, "the locator
    mostly matched another element than meant"): the two errors in `Director.highlight` say so and
    what to do.
  - 211-212 (a second run is refused with the PID of the first): `holdRenderLock`'s error.
  - 229-231 (a failing scene stops with `URL:`, `Screenshot:`, `Cause:`): `failure`'s output.
  - 238-240 and 250-251 (a scene "without narration": wrap the wait in `d.skip`; smaller frames mean
    part of the page is missing): the review table's own hint (`director.ts:981`) and the warning's
    own text (`director.ts:867`).
  - 241-245 ("stumbled in every take", "heard differently", "narration not heard back"):
    `heardNotes`/`printHeard` print them with the lexicon to use.
  Said more than once inside the file: Qwen3 hearing its clips back and what to do with a misheard
  word (153-158, 217-218, 241-245); a missing voice or tool stops the render with how to install it
  (69-75, 219-220); run `lib/settings.ts` first (107-108, 124-126, 193-194); the list of voices and
  where the settings live (214-219), which `settings.ts` prints for the one voice that applies.
- Why it matters: the brief and the skill have to be kept in step by hand, and they already differ
  in detail (the skill's re-voicing paragraph quotes a label as `"Teilen"`, the brief as `„Teilen“`;
  the skill says "a translation with another number is refused", the brief gives the reason). An
  agent reads 298 lines for every demo; about a fifth of them it is told again by the tool.
  CLAUDE.md asks for prompts without what an agent does not need.
- Change: keep in `SKILL.md` what the agent must know before it runs anything (what a scene is, how
  to pace it, the marks and tags it writes, the commands), and for each of the points above one
  clause that the script says the rest ("the render stops and says what to translate and where",
  "the review table flags what to look at"). Say the Qwen3 hearing once, in section 6, and drop it
  from sections 4 and 5; say the setup check once, in section 3. Where the skill has a detail the
  script's text lacks, move it into the script's text.
- Win: about 45 to 55 of 298 lines; one place for each instruction.
- Risk: medium. A prompt is behaviour agents see, and nothing tests it: the information must stay
  reachable (in the script's output), only its second copy goes. Check with one real demo render
  that stops for subtitles and one re-voicing.
- Confidence: high for the overlaps (each pair read side by side); medium for how much an agent
  benefits from being told in advance.

### P3. `browser.ts` has three hand-written CDP clients
- Principle: KISS
- Size: moderate
- Where: `plugin/skills/browser/lib/browser.ts:175-196` (`cdp`), `198-209` (`evalInTab`), `252-271`
  (the connection, `send` and `evaluate` inside `runInput`), `425-449` (`silenceSpeech`)
- Now: `cdp()` opens a WebSocket, sends one command with id 1, waits 30 s, closes. `runInput` opens
  its own, with an id counter and a `pending` map, and no timeout. `silenceSpeech` opens a third,
  with its own id counter, sends without waiting for replies and listens for events. `evalInTab` and
  `runInput`'s `evaluate` send the same `Runtime.evaluate` parameters and treat `exceptionDetails`
  the same way. The line `await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new
  Error('WebSocket failed')))))` stands twice (254, 428).
- Why it matters: three places to change for anything about the connection, and they have drifted: a
  command in `input` never times out, one sent with `cdp()` does; an error in `cdp()` rejects, one
  in `runInput` exits the process from inside a callback.
- Change: one `connect(wsUrl)` that returns `{ send(method, params?, sessionId?): Promise<result>,
  on(event handler), close() }` with the id counter, the pending map and the 30 s timeout. `cdp()`
  becomes connect, send, close; `runInput` and `silenceSpeech` use the connection; one
  `evaluate(connection, expression)` serves `evalInTab` and the `eval:` step.
- Win: about 30 lines and two of three protocol implementations; `input` gets the timeout.
- Risk: low to medium. `browser.test.ts` (223 lines) drives the commands against a real browser,
  `silent-speech.test.ts` the silencing.
- Confidence: high. Read the whole file.
- Fixed: `input`'s missing timeout: `send` in `runInput` gives up after 30 s, as `cdp()` does
  (`browser.test.ts`).

### P4. The WebVTT cue parser is written in the plugin and again in the server
- Principle: DRY
- Size: moderate
- Where: `plugin/skills/demo/lib/revoice.ts:38-61` (`Cue`, `cuesOf`), `src/server/demo.ts:148-163`
  (`cues`); weaker copies for chapters alone in `scripts/hero-video/publish.ts:31-37`
  (`chapterStarts`) and `scripts/site-shots.ts:63-67` (`chaptersOf`); the writer is
  `plugin/skills/demo/lib/subtitles.ts:127-134, 142-170`
- Now: `cuesOf` and `cues` have the same `time(h, m, s, ms)` helper and the same regular expression
  for `hh:mm:ss.mmm --> hh:mm:ss.mmm`, and both strip the word timestamps (`cueText` in the plugin,
  `.replace(/<[^>]*>/g, '')` in the server). They differ in how a cue ends (the plugin splits the
  file at blank lines first, the server matches lazily up to one) and in that the server collapses
  whitespace in the text. The clone detector lists the pair (`revoice.ts:59` and `demo.ts:157-161`).
- Why it matters: the format is written in `subtitles.ts` and read in two other files; a change to
  what a cue carries (the word timestamps came this way) has to reach both readers. The server
  already imports `subtitles.ts` (`demo-page.ts:13`, `walkthrough.ts:23`).
- Change: move `Cue` and `cuesOf` into `subtitles.ts`, beside `vttTime`, `cueText` and `trackVtt`;
  `src/server/demo.ts` imports it and keeps only reading the file and collapsing whitespace; the two
  scripts take their chapters from it (`cuesOf(vtt).map((c) => [c.start, c.text])`).
- Win: about 25 lines and three parsers; the format's reader sits beside its writer.
- Risk: low. `revoice.test.ts` tests `cuesOf`; `src/server/demo.test.ts` tests `placeIn`, which goes
  through `cues`. Keep the server's whitespace collapsing at its call.
- Confidence: high. Both functions read side by side.
- Done by W17: `Cue` and `cuesOf` in `subtitles.ts`, read by `revoice.ts` and `demo.ts`, whose cue
  of several lines is now read whole, as the skill's was. `site-shots.ts` takes its chapters from
  `rereadChapters` (R12); `hero-video/publish.ts` keeps its reader, since its test runs it alone.

### P5. The ffconcat frame list is written twice
- Principle: DRY
- Size: minor
- Where: `plugin/skills/demo/lib/director.ts:759-769` (`frameList`),
  `plugin/skills/demo/lib/revoice.ts:63-78, 111-120` (`Held`, `framesOf`, `frameListText`)
- Now: both write `ffconcat version 1.0`, then per frame `file '<relative path with forward
  slashes>'` and `duration <seconds to 4 places>`, and the last frame once more without a duration.
  `frameList` takes absolute paths and names them relative to the list's directory; `frameListText`
  re-bases relative ones (`path.resolve(from, f)`, which leaves an absolute path as it is).
  `framesOf` parses what both write.
- Why it matters: the comment on why paths are relative with forward slashes (a Windows drive path)
  stands at one copy only; a change to the list's shape has to reach the writer in `director.ts`,
  the writer in `revoice.ts` and its parser.
- Change: keep `Held`, `framesOf` and `frameListText` together in one module with no browser in it
  (`assemble.ts` of P1; not `timeline.ts`, which `src/ui/detail.tsx` imports and so must stay free
  of `node:path`). `frameList` becomes `fs.writeFileSync(file, frameListText([...held, { file:
  held.at(-1)!.file }], dir, dir))`.
- Win: about 8 lines and one of two writers.
- Risk: low. `revoice.test.ts` tests `frameListText` and `framesOf`; the director's use has no test.
- Confidence: high.

### P6. `tts.py`: every voice repeats the raw-file dance, two repeat the reply handling
- Principle: DRY
- Size: minor
- Where: `plugin/skills/demo/lib/tts.py:197-216` (`CommandVoice.synthesize`), `319-336`
  (`ServedVoice.synthesize`), `380-394` (`HeldVoice.synthesize`), `447-495` (`HttpVoice.synthesize`)
- Now: four times `raw = target.with_name(f"{target.stem}.raw.wav")` (`.raw` in `HttpVoice`),
  `raw.unlink(missing_ok=True)`, produce the audio, `to_wav(raw, target)`,
  `raw.unlink(missing_ok=True)`. `ServedVoice` and `HeldVoice` also both do `if "error" in reply or
  <no WAV>: sys.exit(f"the voice failed: …")`, print "synthesised … in N s" and `return
  hearing(reply)`.
- Why it matters: the rule "whatever a voice produces becomes a mono 16-bit WAV, and the raw file
  goes" is one sentence of the header and four copies in the code.
- Change: a context manager or helper beside `to_wav`, say `raw_of(target)` that yields the raw path
  and converts and removes it on exit, used by all four; a `served(reply, raw, target, by)` for the
  shared tail of the two served voices.
- Win: about 15 lines.
- Risk: low to medium. `tts.test.ts` (611 lines) runs `tts.py` with a fake served voice and a voice
  Obeya holds; the command voices (Piper, `say`, the owner's command) and the hosted ones have no
  test, so those two branches are checked by a real sample.
- Confidence: high. All four `synthesize` read side by side.

### P7. `tts.py`'s voices share no shape, so the callers ask what kind each is
- Principle: KISS
- Size: minor
- Where: `plugin/skills/demo/lib/tts.py:498-503` (`make_voice`), `556-559` (`close`), `622`
  (`getattr(voice, "reads_tags", False)`), `664-702` (`main`)
- Now: `close` exists on two of the four voice classes, `reads_tags` on one, so a module function
  `close(voice)` tests `isinstance(voice, (ServedVoice, HeldVoice))`, `narrate` reads the flag with
  `getattr`, and `main` asks `isinstance(voice, CommandVoice)` to decide whether to take the lock,
  twice: its `--sample` branch (670-681) and its jobs branch (682-702) each load the spec, make the
  voice, take the lock for a command voice and close in a `finally`. `QuotaExhausted` is raised in
  one place (435) and caught in one (641), only to `sys.exit` with a longer message, while every
  other failure exits where it happens.
- Why it matters: a fifth voice has to be added to two `isinstance` tests by hand; the lock rule
  lives in `main` instead of with the voice that needs it.
- Change: a small base class `Voice` with `reads_tags = False`, `close()` that does nothing and
  `locks = False` (true on `CommandVoice`); `make_voice` takes the lock for a voice that asks
  (`ServedVoice` already takes it in `_start`). `main` loads spec and voice once and then branches
  on `--sample`. `HttpVoice._post` exits with the full quota message itself, as its other errors do.
- Win: about 15 lines, the `close` function, two `isinstance` tests and the exception class.
- Risk: low. `tts.test.ts` covers render and `--sample` with served and held voices (starts once,
  ends, dies, stops answering); the lock and the quota message have no test.
- Confidence: high.
- Fixed: the sample ended by a spent quota: `HttpVoice._post` exits with the full quota message
  itself and `QuotaExhausted` is gone, so that part of the change is done (`tts.test.ts`, "a hosted
  voice").

### P8. The Qwen3 command is built by two functions, and its one-shot mode is never run by a render
- Principle: YAGNI
- Size: minor
- Where: `plugin/skills/demo/lib/voices.ts:308-326` (`qwen3Command`, `qwen3Serve`), `351-365` (the
  `qwen3` case of `voiceSpec`); `plugin/skills/demo/lib/qwen3.py:476-502` (`main`);
  `plugin/skills/demo/lib/tts.py:498-503`
- Now: `voiceSpec` gives a Qwen3 voice `argv` (`… --out {out}`) and `serve` (`… --serve`), both from
  `qwen3Command`, which names the language and the reference clip. `tts.py`'s `make_voice` takes
  `serve` whenever a spec has it, so `argv` and with it `qwen3.py`'s `--out` branch (`main`,
  490-502) are never run by a render or a sample. The only thing that can run it is
  `scripts/check-voice.ts:73-78` when asked for `qwen3:<language>` by hand (its default is Kokoro
  and Piper). `qwen3Serve` builds the same command a second time for the voice Obeya holds, without
  language and reference, which each request brings.
- Why it matters: two builders of one command line to keep in step (`voices.test.ts:100-103` pins
  that they agree), and a mode of `qwen3.py` whose behaviour (no `script`, the hearing printed to
  stderr) differs from the one every clip actually takes.
- Change: one builder. `ServedVoice` sends the reference with each request as Obeya does
  (`"reference": spec["host"].get("reference")`), so `spec.serve` is `qwen3Serve(voice, home)` and
  `qwen3Command` goes. Then decide on `--out`: either drop `argv` from the Qwen3 spec and the
  `--out` branch from `qwen3.py` and let `check-voice.ts` speak through `tts.py --sample`, or keep
  it and say in `qwen3.py`'s header that only the check uses it. I would drop it.
- Win: `qwen3Command` (5 lines), about 15 lines of `qwen3.py`, one of two modes.
- Risk: medium. `voices.test.ts:69-104` and `tts.test.ts` pin the current shape of the spec; the
  real voice is only checked by hand (4 GB model).
- Confidence: medium. Checked `make_voice`, every use of `spec.argv` (`rg "\bargv\b"` over `src`,
  `scripts`, `plugin`), `check-voice.ts`, and that Obeya's host sends the reference per request
  (`src/server/narration.ts:195-196`); `tts.test.ts:75` itself gives a served voice `argv:
  ['false']` to show it is not run. Not run here.

### P9. `browser.ts`: every command repeats flag, state and tab
- Principle: DRY
- Size: minor
- Where: `plugin/skills/browser/lib/browser.ts:545-664` (`main`), `347-356` (the `shot:` and `eval:`
  steps)
- Now: nine cases each do `takeFlag(args, '--tab')`, `await loadState()`, `await pickTab(state.port,
  tabId)`. `status` and `tabs` print the tab list with the same line (560, 566); `open` and `nav`
  share navigate, wait, print (577-579, 589-591; both pairs are in the clone list). `screenshot`,
  `pdf` and the `shot:` step each decode base64, write the file and print "… saved to"; `eval` and
  the `eval:` step each print a string as it is and anything else as JSON.
- Why it matters: 120 lines for 14 commands, most of them the same three statements.
- Change: before the switch, `const tabId = takeFlag(args, '--tab')` and `const tab = async () =>
  pickTab((await loadState()).port, tabId)`; helpers `listTabs(port)`, `navigate(port, tab, url,
  noWait)`, `save(file, data, what)`, `print(value)`. `status` prints its line and falls into
  `tabs`.
- Win: about 35 lines.
- Risk: low. `browser.test.ts` runs the commands.
- Confidence: high.

### P10. The browser skill's usage is written three times and has drifted
- Principle: DRY
- Size: minor
- Where: `plugin/skills/browser/lib/browser.ts:4-29` (header), `652, 662` (usage errors that say
  "see header comment"), `plugin/skills/browser/SKILL.md:25-41, 68-73`
- Now: the header lists commands and input steps; `SKILL.md` lists them again. The header is behind
  the code: its key names lack `Shift`, `Control`, `Alt`, `Meta` (`KEYS`, 235-238), and its `drag`
  lacks the further points and the `@selector` start (300-302), all of which `SKILL.md` has. The
  usage errors send the reader to the stale header, which an agent sees only by opening the source.
- Why it matters: a comment that contradicts the code, and the error that should help points at it.
- Change: `SKILL.md` is the list (it is what agents read). The header keeps what the list does not
  say (one browser per session, the state file, `serve`) and names `SKILL.md` for the commands; the
  two usage errors name it too.
- Win: about 22 lines of header, and one list instead of two.
- Risk: low.
- Confidence: high. Compared header, `KEYS`, the `drag` case and `SKILL.md`.

### P11. `runDemo` finds its mode by asking `process.argv` in five places
- Principle: KISS
- Size: minor
- Where: `plugin/skills/demo/lib/director.ts:771-878`, in particular `774-775, 785, 787, 790`
- Now: a 108-line function that is at once the command line (`--revoice`, `--dry`, `--narration`,
  `DEMO_VOICE` to an output directory), the preparation (setup check, subtitles, synthesis, timings)
  and the take (the scene loop, the stop, the warnings) before it calls `assemble`.
  `process.argv.includes('--narration')` is asked twice, the others once each, between other work.
- Why it matters: which steps a mode runs can only be read by following the early returns;
  `--narration` and `--dry` each skip a different half.
- Change: read the mode once at the top (`const mode = revoice | dry | narration | render`), then
  three functions the size of a screen: `prepare` (setup, subtitles, clips, timings), `take` (the
  loop, returning marks, frames and cuts) and the existing `assemble`. Goes together with P1.
- Win: no lines; three named steps instead of one long function.
- Risk: medium. No test runs `runDemo`.
- Confidence: high.

### P12. Process helpers are written per skill
- Principle: DRY
- Size: minor
- Where: `plugin/skills/browser/lib/browser.ts:51-59` and
  `plugin/skills/demo/lib/director.ts:482-489` (`alive`);
  `plugin/skills/browser/lib/browser.ts:666-667` and `plugin/skills/demo/lib/here.ts:24-28` (is this
  module the script that runs); `plugin/skills/demo/lib/director.ts:471-480` and
  `scripts/hero-video/render.ts:66-80` (a PID file as a lock), read by
  `src/server/demo-space.ts:78-88`
- Now: `alive` in `browser.ts` counts `EPERM` as alive, the one in `director.ts` does not (six more
  copies stand in `src/server/instance.ts:68`, `src/server/testing.ts:347`,
  `src/server/test-setup.ts:17`, `src/server/demo-space.ts:82`, `scripts/scratch-obeya.ts:992`,
  `scripts/android-phone.ts:316`). `browser.ts` compares the script's real path with
  `import.meta.filename`, without case on Windows; `isMain` in `here.ts` compares them as they are
  and knows Obeya's binary. `holdRenderLock` and the hero render's lock are the same dozen lines
  (read the PID, refuse if alive and not this process, write, remove on exit if still ours).
- Why it matters: the two `alive` already differ in a way that matters for a lock (a render of
  another user reads as dead in `director.ts`, as alive in `demo-space.ts`, which reads the same
  `render.pid`).
- Change: a `plugin/lib/process.ts` with `alive` (the `EPERM` variant), `isMain` (from `here.ts`,
  with `browser.ts`'s Windows comparison) and `holdPidLock(file, refused: (pid) => string)`;
  `browser.ts`, `director.ts`, `here.ts` and `scripts/hero-video/render.ts` use it. The copies in
  `src/server` and `scripts` belong to those slices; `plugin/lib` is a place they can import from,
  as they import the demo library today.
- Win: about 25 lines in the plugin, one rule for "this process still runs".
- Risk: low. `browser.test.ts` tests `alive`.
- Confidence: high for the copies (`rg "process\.kill\(\w+, 0\)"`); medium for whether `isMain`
  needs the Windows case folding (not tested here).

### P13. Small rules of the demo library stated more than once
- Principle: DRY
- Size: minor
- Where: `plugin/skills/demo/lib/subtitles.ts:173` (`trackFile`), `revoice.ts:48` (`TRACK_FILE`),
  `director.ts:952` (the same pattern inline), `src/ui/detail.tsx:2025` (`captions.${l}.vtt`);
  `director.ts:957, 967, 979` (where a scene ends); `timeline.ts:34` and `revoice.ts:150` (the audio
  tag pattern); `director.ts:1006-1009` and `revoice.ts:125` (a summary's paragraphs);
  `director.ts:611, 823, 923` (twice the pixels for `sharp`); `director.ts:544, 781` (the default
  viewport); `director.ts:407-422` (`sleepCause`, `stillCause`)
- Now: the name of a caption track's file is built in one place and matched by two regular
  expressions and a template string; `i + 1 < marks.length ? marks[i + 1]!.start : total` stands
  three times in `assemble`; `spec.sharp ? 2 : 1` three times; `{ width: 1440, height: 900 }` twice;
  `/\[[^\]]*\]/` twice on the TypeScript side; `sleepCause` and `stillCause` filter and sum
  `stillSpells` the same way and differ in one condition and their sentence.
- Why it matters: each is a rule a later change has to find in every copy; none is checked by a test
  that the copies agree.
- Change: `TRACK_FILE` and a `trackLanguage(file)` beside `trackFile` in `subtitles.ts`, used by
  `director.ts`, `revoice.ts` and the UI; a local `sceneEnd(i)` in `assemble`; `AUDIO_TAG` exported
  from `timeline.ts`; `paragraphs` exported from where the report page is written; `const scale =
  sharp ? 2 : 1` once per take, passed on; `DEFAULT_VIEWPORT`; one `stoodStill(since, sleptOnly)`
  that returns the seconds, with the two sentences at its callers.
- Win: about 15 lines; seven rules with one home each.
- Risk: low.
- Confidence: high. Each place read.

### P14. `voices.ts`: a local voice's directory, Python and model are put together anew at each use
- Principle: DRY
- Size: minor
- Where: `plugin/skills/demo/lib/voices.ts:141-144, 246, 260, 277, 311, 320, 335` (the voice's
  directory and its Python), `153-155, 169-171` (the model's snapshots in the Hugging Face cache),
  `255, 286` (the `snapshot_download` one-liner)
- Now: `path.join(voicesHome(home), '<voice>')` stands seven times and `envPython(…)` of it five
  times, across `piperFiles`, `components`, `qwen3Command`, `qwen3Serve` and `voiceSpec`;
  `hfFilesPresent` and `hfModelPresent` start with the same two lines; the Python line that
  downloads a model is written twice, once with `allow_patterns`.
- Why it matters: what one voice is (where it lives, what it needs, how it is run) has to be
  collected from `components`, `voiceSpec` and the helpers between them.
- Change: `const voiceDir = (voice, home) => path.join(voicesHome(home), voice)` and
  `voicePython(voice, home)`; `snapshots(repo)` shared by the two cache checks; `hfDownload(python,
  repo, files?)` returning the `Component['install']`.
- Win: about 12 lines.
- Risk: low. `voices.test.ts` pins the paths.
- Confidence: high.

### P15. Leftovers nothing uses
- Principle: YAGNI
- Size: minor
- Where: `plugin/skills/demo/lib/overlay.js:120`; `plugin/skills/demo/lib/setup.ts:216`;
  `plugin/skills/demo/lib/tts.py:460`; `plugin/skills/theme/lib/preview.ts:105`
- Now: `const SVG = 'http://www.w3.org/2000/svg'` is defined and never used (the dimming layer
  became a clip path, as the comment above it says). `describeSetup`'s `mark` has a key `off: '–'`
  that no `SetupItem['state']` (`ok`, `missing`, `later`) can select. `import base64` stands inside
  the Gemini branch although the module imports it at its top (line 60).
  `demoSettingsHere().language === 'en' ? 'en' : 'de'` turns a `'de' | 'en'` into the same `'de' |
  'en'` (`PageLanguage` in `src/server/demo-page.ts:19` restates `Language`).
- Why it matters: each makes a reader look for the use that is not there.
- Change: delete the constant, the key and the inner import; assign the language directly.
- Win: 4 lines.
- Risk: low.
- Confidence: high. `rg "\bSVG\b" overlay.js` finds the definition only; `state` is typed at
  `setup.ts:32`.

## Justified (looks redundant or complex, but has a reason; leave it)
- `plugin/skills/demo/lib/locale.ts`, `language.ts`, `settings.ts` the languages and the demo
  settings live in the plugin, not in `src`: a render runs where only the plugin is;
  `src/core/locale.ts:2-4` re-exports them, and `src/server` imports `settings.ts`, `setup.ts` and
  `voices.ts` rather than restating them. Clean.
- `plugin/skills/demo/lib/setup.ts:117-145` `browserPaths` and `browser` restate Playwright's
  registry paths and the order `launchChromium` tries (`plugin/lib/chromium.ts:24-34`): the check
  runs in Obeya's server on every "Check setup" and must not launch a browser, and Playwright has no
  public call for where a channel would be found. `setup.ts` cannot import `chromium.ts` either: it
  has to load without Playwright.
- `plugin/skills/demo/lib/revoice.ts:122-147` `reportOf` reads title and report back out of
  `index.html` with regular expressions, and knows two older shapes of it (also `cuesByScene`'s one
  cue per scene, `keptTracks`' demo without a track list): design, Demos, "Re-voicing": it reads
  only what the render left, so it works on a demo of any director version.
- `plugin/skills/demo/lib/tts.py:255-346` `ServedVoice` and `src/server/narration.ts`
  `NarrationHost` are two clients of `qwen3.py`'s line protocol with the same two silence limits
  (`ANSWER_LIMITS`, `NARRATION_LOAD_MS`/`NARRATION_SENTENCE_MS`): a render without Obeya, or with
  one that cannot be reached, serves the voice itself; each names the other in its comment.
- `plugin/skills/demo/lib/overlay.js:14` `CLOCK` restates `timeline.ts:40`: the overlay is injected
  into the page as a file and cannot import; `overlay.test.ts:36-96` loads the real `overlay.js` in
  a browser and reads its strip with `paintTimes`, so the two cannot drift unnoticed.
- `plugin/skills/demo/lib/settings.ts:148-163` `repositoryLanguage` parses `.obeya/settings.json`
  itself instead of using `src/adapters`: `settings.ts` runs under plain Node without `src`.
- `plugin/skills/browser/lib/browser.ts:425-449` `silenceSpeech` over raw CDP beside
  `plugin/lib/playwright.mjs:27-32` and `director.ts:533-537`, which add the same script through
  Playwright: the browser skill's tabs are opened over CDP's HTTP endpoint by other processes, not
  through a Playwright context.
- `plugin/skills/demo/lib/tts.py:624-627` the `"\npauses"` suffix in the clip cache key: keeps a
  clip cached before pauses became silence from being taken for one with them.
- `plugin/skills/demo/lib/director.ts:459-465` `underNode` re-runs a demo started with Bun under
  Node: the Bun pipe bug its comment dates.
- `plugin/skills/demo/lib/qwen3.py:88-133` `german_number` and `english_number` look alike but
  differ in every rule (order of ones and tens, "ein"/"eins").
- `plugin/skills/demo/lib/recipe.ts`, `plugin/skills/settings/lib/check.ts`,
  `plugin/skills/theme/lib/preview.ts` import from `src/`: `scripts/build.ts:55` bundles the three
  with their imports for a release.

## Bugs noticed in passing
- `plugin/skills/browser/lib/browser.ts:21-23` the header's list of keys and of `drag`'s arguments
  is behind the code (see P10).
