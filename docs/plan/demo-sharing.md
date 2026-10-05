# Sharing demos, and demos for open source

> Plan doc for sharing demo videos with the Acme team, then making demos part of Obeya itself so
> anyone can record and share them on any platform. Deleted when it ships; durable content moves
> into [`docs/design.md`](../design.md).

## Goal

Acme colleagues can watch the demos of Daniel's Acme cards: one click on a card publishes its video
to a page behind the team's login, and the pull request links it. After that, Obeya brings its own
demo pipeline, so it can record and share demos as an open-source project on macOS, Windows and
Linux, with voices each user chooses. W1–W2 are the Acme part, W3–W7 the open-source part.

## Where it stands

- *Recording*: since W3 the pipeline is in the repository, as the skill `obeya:demo` of the
  plugin `plugin/` that Obeya loads into its workers; Daniel's `~/.claude/skills/demo` links to it.
  Language and voice come from the demo settings (design: Architecture, Demos), the recipes from
  the adapters. Since W5 it records and cuts on macOS, Linux and Windows, and listens back with
  mlx-whisper on Apple Silicon, faster-whisper elsewhere, or not at all (design: Architecture, Demos).
- *Voices*: since W4 every voice is a provider (design: Architecture, Demos): Piper, the default,
  and Qwen3-TTS, both installed by Obeya on request into `~/.obeya/voices/`; macOS `say`; an own
  command or HTTP endpoint; templates for Gemini, OpenAI, ElevenLabs and Azure. Daniel's clone is
  his own command, `scripts/demo_voice.py` in `~/dev/stimmzwilling` (Qwen3-TTS 1.7B on mlx-audio,
  model and reference from that project's `config.yaml`), marked as his own voice, so his demos
  speak in the first person as before; the clips cached before W4 are synthesised once more.
  Every clip is listened back with Whisper unless that is off. The video is a screencast of the
  local Chrome (else Edge, else Playwright's Chromium), cut with ffmpeg; the report page is
  `index.html`.
- *Obeya*: the worker's brief names the demo skill `obeya:demo` (`src/server/workers.ts`), the
  adapter adds `demo.required` and `demo.howToRun` with the project's recipe (`src/adapters/`). Obeya reads the handed-over
  directory under `~/demos/` (`demo.mp4`, `poster.jpg`, `captions.vtt`, `index.html`) and shows the
  demo on the card (`src/server/demo.ts`). Since W1 a video demo of an Acme card can be shared
  on `team-demos.pages.dev` (design: Architecture, Sharing a demo), and since W2 the page and
  the card's pull request link each other. Since W6 any repository can name its share command in
  the configuration, and without one "Teilen" exports a ZIP or one HTML file. Obeya's own voice in and
  out is macOS-bound too (mlx-whisper, a JXA sidecar: `src/server/voice.ts`).
- *Acme*: `docs.example.com` is the documentation on Cloudflare Pages behind Cloudflare Access,
  for `@example.com` only, on the free plan (up to 50 users; `the docs' hosting notes`).
  It is built from git, and videos never go into git.
- *Sizes*: the largest of the 93 demos under `~/demos/` so far is 11 MB (2026-10-02).

## Design

### Sharing in Acme (W1–W2)

- **Who.** Only Daniel's Obeya records and shares Acme demos; colleagues only watch them.
- **The voice.** The rendered video is shared as it is, in Daniel's cloned voice; it is not
  rendered again for sharing. The clone itself never leaves his machine.
- **"Teilen" on the card.** A video demo on a card of a repository whose adapter can share gets a
  "Teilen" button, on cards still waiting and on cards long done, so demos recorded before W1 can
  be shared at once. Publishing goes outside Obeya, so the button follows the pattern of starting a
  project's workstreams: a few seconds to take it back before anything is uploaded. Afterwards the
  card shows the link (open, copy) and "Nicht mehr teilen", which withdraws the page. A card that
  gets a new demo after sharing shows that the shared page has the earlier one, with "Neu teilen";
  nothing is replaced on its own. HTML artifacts are not shared: they may load anything beside
  them, and they are drafts for the owner to choose from.
- **The page.** Title, two to five sentences on what changes and why, the video with chapters and
  captions, a link to the pull request. Written for colleagues who have never seen Obeya, the card
  or the plan doc. Findings, the open question, shown / not shown and the review stills stay in
  Obeya. The worker writes the text at handover: `ready_for_review` gets a field for it beside the
  report. For a demo handed over before that, a short session writes it from the stored summary
  when the owner shares. An overview page lists every shared demo, newest first.
- **The hook.** The adapter names a command, `demo.share`. Obeya runs it with `publish` and the
  page as JSON on stdin (slug, title, text, chapters, PR URL if any, the demo directory); it prints
  the page's URL. `withdraw <slug>` takes a page down. The slug stays the same for a card, so a
  shared link keeps working when the page is published again. The command's output and errors go
  into the card's log. Obeya stores the URL with the card's demo.
- **Acme's command.** A script beside the Acme adapter (`src/adapters/`), since only Daniel's Obeya
  uses it. A Pages deployment is a full snapshot of a directory, so the script keeps the site in a
  directory of its own under `OBEYA_HOME` (one subdirectory per demo with its page, video, poster
  and captions, plus the overview), changes it, and deploys the whole of it with
  `wrangler pages deploy --branch main` to the Pages project `team-demos`. Files already uploaded
  are not uploaded again. Account ID and API token come from a file outside git. Pages takes at
  most 25 MiB per file: a larger video is refused with that reason in the log (R2 only if that
  happens; see Risks).
- **Cloudflare, once, by the owner** (done 2026-10-02), in this order: first the Pages project
  `team-demos` (under Pages; a plain "Create" makes a Worker on `workers.dev`), then an Access
  application for `team-demos.pages.dev` and `*.team-demos.pages.dev` with the same policy as the
  documentation (emails ending in `@example.com`): Access offers the domain to pick, not as
  free text, so the project must exist first. Then an API token with Pages edit rights. The
  colleagues are the documentation's users, so Access needs no extra seats.
- **The pull request.** When the demo is shared before the PR is opened, the worker's approval
  message carries the link and the worker puts it into the description. When it is shared after,
  Obeya adds a line to the PR's description (`gh pr edit`, once, found again by a marker). Once
  the PR exists, Obeya publishes the page again with its link.

### Demos for open source (W3–W7)

- **The pipeline in the repository.** The director, overlay and voice code and the skill's
  instructions move into the Obeya repository, without names or fixed paths. Narration language
  and person come from settings (first person only when the voice is the owner's own). Project
  recipes (Acme's login, QA customer and migrations; Obeya's scratch instance) move into the
  adapters, where `demo.howToRun` already is. Obeya gives its workers the skill itself; how (a
  local plugin through the Agent SDK, or the skill written into the workspace) is checked in W3.
  The skill also runs on its own, so a Claude Code session without Obeya can record a demo.
  Daniel's user skill then points to it, so there is one pipeline.
- **Voices as providers.** Text in, WAV out; each user picks one in Obeya's settings.
  - *Own service*: a command (text on stdin, WAV path out) or an HTTP endpoint, with templates
    for Gemini, OpenAI, ElevenLabs and Azure. Daniel's Stimmzwilling becomes his own command, so
    the clone stays on his machine.
  - *Local model, installed by Obeya*: Piper as the default, on all three platforms (German
    voices, real time on a CPU; to be measured in W4). Qwen3-TTS for better quality: mlx on a Mac,
    PyTorch elsewhere, in practice only with a GPU. Obeya downloads and installs the model on
    request, with its size shown first.
  - *macOS `say`*: an extra option on a Mac, free, clearly more synthetic. Never the only way to
    a feature.
  - Voices are not labelled as generated, a clone included: the whole demo is generated, and
    that is clear from where it is shown.
- **Windows and Linux.** Recording with Chrome through Playwright and cutting with ffmpeg on all
  three platforms; listening back with faster-whisper where mlx is missing, and optional when no
  Whisper is installed (the report says the clips were not checked). Whether Obeya itself runs on
  Windows is a separate, larger question and not part of this project; so is Obeya's own voice in
  and out outside macOS.
- **Sharing in general.** The share command becomes configuration (per repository, in Obeya's
  settings), not only part of a built-in adapter. Without a target, "Teilen" exports: a ZIP of the
  page with its files, or one self-contained HTML file for short videos.
- **Setup.** A check of what the demos need (Chrome, ffmpeg, Python, the chosen voice, Whisper)
  that says what is missing and how to install it on this platform, shown in Obeya's settings and
  run before a worker records; a guide in the repository.

Every package keeps `docs/design.md` current in the same change (Architecture: Demos, Repo adapter;
Open questions on demos in pull requests and cloned voices go when W2 and W4 land; the one on
demos in pull requests went with W2).

## Workstreams

- [x] **W1:** Share an Acme demo. "Teilen" on video demos (a few seconds to take it back, then the
  link on the card, "Nicht mehr teilen", "Neu teilen" after a new demo); the `demo.share` hook
  (`publish` with the page as JSON, `withdraw`); the page text at handover, or from the stored
  summary for older demos; the Acme script with its site directory, page, overview and
  `wrangler pages deploy`. Tests against a fake share command. Needs the owner's one-time setup
  in Cloudflare (project, Access, token) before it can be tried live. Comes first.
- [x] **W2:** The link in the pull request. Into the description when the worker opens the PR, or
  added by Obeya when the PR already exists; the page published again with the PR's link. After W1.
- [x] **W3:** The demo pipeline in the Obeya repository. Director, overlay, voice code and skill
  without names or fixed paths; narration language and person from settings; project recipes in
  the adapters; Obeya gives its workers the skill (how: checked here); the owner's user skill
  points to it. Demos sound as before. After W1, so the Acme part is not held up.
- [x] **W4:** Voices as providers. Own service (command or HTTP, templates for Gemini, OpenAI,
  ElevenLabs, Azure), Piper as the local default and Qwen3-TTS as an option, both installed by
  Obeya on request, `say` as an extra on a Mac; the choice in settings; no label for generated
  voices. Daniel's clone moves to a command provider. After W3.
- [x] **W5:** Demos on Windows and Linux. Recording and cutting on all three platforms,
  faster-whisper for listening back, listening back optional; checked on a Linux machine and a
  Windows one. After W3; independent of W4.
- [x] **W6:** Sharing in general. The share command as configuration per repository; without one,
  an export as ZIP or a self-contained page. After W1.
- [ ] **W7:** Setup. A check of the demo dependencies with install hints per platform, in settings
  and before recording; a guide in the repository. Last, once W4 and W5 say what is needed.

## Risks

- Pages takes at most 25 MiB per file. Demos so far are at most 11 MB; a longer project demo could
  pass it, and then the video would need R2 with a domain of its own behind Access.
- The Acme site lives only in its local directory: if it is lost, the next deployment would drop
  every page published before. The script refuses to deploy a site with fewer demos than Obeya has
  stored as shared.
- Measured in W4 (2026-10-02): Piper's German `thorsten-high` runs about twice real time on the
  laptop CPU and was heard back word for word; Qwen3-TTS's stock speaker needs retakes now and
  then (0.99 match). Qwen3-TTS through PyTorch (Windows, Linux) is untried: no machine with a GPU.
- Checked in W5 (2026-10-05): the same smoke demo recorded with Piper and heard back word for
  word on macOS (Apple Silicon, mlx-whisper), Linux on ARM in Docker (no Chrome: Playwright's
  Chromium; faster-whisper on the CPU), and on GitHub's runners on Windows Server 2025 and Ubuntu
  x64 (Chrome, faster-whisper); the lock and the render with listening back off on all of them,
  offline in Docker. Windows found one bug: Piper read its text in the code page ("öffnet" came
  out garbled, match 0.77), fixed by giving voice commands UTF-8. Not tried: Edge as the fallback
  (the runners have Chrome), a voice command through `cmd.exe`, Obeya itself on Windows.
- Checked in W3: Obeya hands the skill to its workers as a local plugin (`plugins` option of the
  Agent SDK); the session lists it as `obeya:demo`, beside the user's own skills.

## Open questions

None.
