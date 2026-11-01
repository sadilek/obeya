# CLAUDE.md

Obeya: a spatial canvas for directing AI coding agents. Goal, behaviour and the decisions behind
them are in `docs/design.md`, an index, and its chapters under `docs/design/`: read the index, then
the chapters the change touches, and keep those current in the same change by the rebuild test the
index's header states. The permanent docs (`docs/*.md` and the chapters under `docs/design/`) hold
only what an experienced engineer would need to rebuild the software with the same features,
however different the reimplementation would look: behaviour seen from outside, formats a rebuild
must stay compatible with, non-obvious constraints, and decisions (chosen, why, rejected, date).
Not what the code shows (names, modules, pixel values), and not history: a change rewrites the
description instead of adding the old behaviour to it. Work in progress is planned in plan docs
under `docs/plan/` (Obeya shows them as projects); when one is done, what passes the same test moves
into the chapters under `docs/design/` (or the index) and the doc goes.

- Bun + TypeScript throughout; tests with `bun test --parallel` (a file per process, from Bun 1.4 on;
  older Bun ignores the flag and runs them one after the other), types with `bun run typecheck`.
- `src/core/` is shared by server and UI (types, plan-doc parser, layout); `src/server/` is the
  Bun server with SQLite; `src/ui/` the React canvas; `src/adapters/` what Obeya knows of a repository (its defaults, its settings).
- Code that drives agents is tested against the fake runtime in `src/server/testing.ts` and real
  git repositories in a temp directory (`gitRepo` there; git calls are what makes tests slow).
  Live runs go against a scratch git repository with a plan doc and a scratch `OBEYA_HOME` (never
  `~/.obeya` of a running Obeya): `bun scripts/scratch-obeya.ts <stage.json>` stages one with its
  cards in about a second (its header describes the stage file; `--stop <port>` ends it). Its
  workers are idle; with `--real-workers` they are real agents on the machine's Claude login.
- UI checks run in a headless browser through the `browser` skill of Obeya's plugin
  (`obeya:browser`; a session without the plugin reads `plugin/skills/browser/SKILL.md`): `input`
  for trusted clicks, drags, keys held for push-to-talk; `start --fake-mic <wav>` for voice. A
  claude-in-chrome tab is often hidden, which freezes `requestAnimationFrame`: camera flights and
  the unfold never finish there. For what headless Chromium can't reproduce (on-screen keyboard,
  fullscreen, rotation), use `bun scripts/android-phone.ts`: Chrome in the Android emulator, with
  real taps (its header describes the commands).
- Reviews of the code (security, code quality and the like) always bring in Codex (`codex exec`)
  as a second reviewer.
- Voice on this machine: Parakeet through uv, the default, needs nothing set. For Whisper instead:
  `OBEYA_WHISPER_BACKEND=mlx OBEYA_WHISPER_PYTHON=/Users/sadilek/dev/stimmzwilling/.venv/bin/python`
  (has `mlx_whisper`; the model is cached). That Python alone, without the backend, fails: it has no
  `onnx_asr` for Parakeet.
- The Obeya instance for this repo runs on port 4417 with `~/.obeya`. It restarts itself once
  `main` moves to commits that change code, a commit of yours included (workers resume, the page
  reloads); docs-only commits leave it running. Keep tests off it.
- No project-specific logic in the core: what a project needs goes into its settings
  (`.obeya/settings.json` in that repository), not into this repo. Those settings stay few and
  generic: each describes something that holds for any kind of app, not one kind of web stack, and
  no two cover the same need; where two overlap, merge them.
- The owner works in Obeya at the level of requirements, feature and bug descriptions and specs,
  and checks results in demos and result artifacts. Source code and diffs stay in the background:
  on a card with a demo or artifact, its changed files are optional and stay collapsed until
  opened, never shown up front.
- UI strings live in one place, `src/ui/strings.ts`, in German and English (two tables of one shape).
  German UI texts and docs call a button "Button" or "Schaltfläche", never "Knopf".
- An interaction that several kinds of card share (answering questions with comments and one Send
  button, the conversation history, starting („So bauen“, „Übernehmen und starten“) while the agent
  is still working) is built once in shared code and works the same on each of them; no card kind
  gets its own variant.
- The phone view stays as simple as possible: not every desktop view belongs on it (the workspaces
  list, say, stays desktop-only). What it does show follows the desktop version: same controls,
  icons, button states and card layout, departing from it only where the small screen requires.
  A tap on a button while the keyboard is open does what the button does on the first tap; it
  never just closes the keyboard first.
- Whatever the owner has entered on a card but not sent yet (text, pasted screenshots, picked answer
  options, comments) survives closing the card, switching canvases and a page reload, for every
  input on the card, not only the text field.
- What the owner is looking at right now is not flagged to them: a message that arrives in a
  conversation they have open gets neither a notification nor an unread marker, and an answered
  question no longer shows as open.
- Dialogs and text fields use the space the screen offers (the owner works on a tall monitor)
  instead of staying small with a scrollbar of their own; never two scrollbars side by side.
- A button that is easy to click by accident and sets a lot in motion gets an undo. What is easy
  to reverse afterwards gets no undo window with a wait: it takes effect at once.
- Every new feature and every shortcut gets a way for first-time users to discover it: a visible
  icon, say, or a hint that shows until it has been used once. A button that appears on hover over
  the thing it acts on is found that way and needs no more. A tooltip or a key that is only
  documented is not enough.
- Rarely used actions stay out of the way: shown only where they apply, behind hover or an overflow
  menu, so everyday use isn't cluttered with buttons. A button's label makes clear what it does to
  someone who doesn't yet know the use case.
- Prompts and skills for agents: fix unwanted behaviour by removing the instruction that causes
  it, not by adding a prohibition. Forbid nothing an agent would not do without being told to.
- The colleagues use Windows or Linux: features must work there; macOS-only tools (e.g. `say`)
  only as an additional option.
- Demo videos and voice recordings never go into git.
- Before UI work goes to the owner, look closely at screenshots of it for visual polish and fix
  what is off: text vertically centred with neighbouring buttons, enough padding to the edges of
  its block, controls (a remove ×, say) where the eye expects them.
- Before a demo video goes to the owner, watch it for faults of the demo itself and fix them first:
  every dictated text it shows is transcribed completely and correctly (no missing words or
  numbers, no misrecognitions), and what the agents in it say points out no fault (a comment cut
  off, input missing).
- Videos on the site (the hero video, anything for obeya.si) are narrated in the owner's ElevenLabs
  voice clone (voice ID `IErGHDQU4vPqicCi8dwR`), not the voice of the demo settings; demo videos
  published elsewhere (in a PR or issue comment, say) keep the voice of the demo settings. Its API
  key is in `.voice/elevenlabs.key` of the main checkout (`/Users/sadilek/dev/obeya`, gitignored);
  render with an `OBEYA_HOME` whose `demo.json` names both (`voice: elevenlabs`, `voiceName`,
  `keyFile`), as `scripts/hero-video/render.ts` sets up for the hero video (its README says how to
  change and re-render it). Credits are limited: only for the site's videos, never as Obeya's own
  demo voice, and even there only once: a video for the site is iterated in local renders in the
  owner's Qwen3 voice, and the ElevenLabs render happens after the owner has approved the video.
  Qwen3-TTS references of the owner's voice lie beside the key, each with its transcript (`.txt`):
  `.voice/qwen-reference-de.wav` (a recording) and `qwen-reference-en.wav` (cut from the ElevenLabs
  voice); the demo settings' `reference` names the one of the narration language. Qwen3 is good
  enough for demos, ElevenLabs marginally better for the site, so the site stays with ElevenLabs
  (owner, 2026-10-12); `scripts/hero-video/qwen.py` renders the hero narration in Qwen3 to compare.
- Every release also brings the README's text up to date: like the site, it names what the release
  adds that a newcomer should know (phone remote control, say).
- A release contains everything on `main` at the moment it is tagged: right before tagging, rebase
  onto the current `main` (moving the tag if it is already set), so commits that landed while the
  release was being prepared go into it too.
- gh calls against this repository's GitHub repository go through `bun scripts/gh.ts <gh args…>`:
  it runs gh on the checkout's origin as the account that owns it (`sadilek` for sadilek/obeya),
  since the machine's active gh account may be another without admin rights.
- A recurring step that needs a longer CLI call (an upload, say) goes into a script in the repo,
  not into the docs as a command to copy.
- Finished work never lands directly on `main`: it goes as a branch to the fork Amerlander/obeya
  (remote `fork`), with a pull request against `main` of https://github.com/sadilek/obeya. An Obeya
  worker commits on its card's branch, and that branch is the one pushed to the fork.
- When a task handles a GitHub issue, its worker closes the issue once the work has landed, with a
  comment linking the demo video and the commit on `main`.
- Once the owner approves the demo of an external contributor's pull request: comment on the PR
  with the demo link, squash-merge it, then `git pull` on `main` so the local checkout is current.
- Pull requests Obeya opens in other people's repositories carry no Obeya attribution: no
  `Co-authored-by` Obeya, no mention of Obeya in the PR text. They may link the demo page, and the
  page itself may say "created with Obeya" at the bottom.
