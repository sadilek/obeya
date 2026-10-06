# Obeya as an installable app

> Plan doc for an Obeya that a stranger downloads, installs and starts, on macOS, Windows and
> Linux, without Bun or a checkout. Written as W8 of
> [`open-source.md`](open-source.md). Deleted when it ships; durable content moves into
> [`docs/design.md`](../design.md).

## Goal

Someone who finds Obeya on obeya.si downloads it, opens it and has a canvas on one of their
repositories within minutes: an app for macOS (DMG), Windows (installer) and Linux (AppImage,
.deb), signed where the platform warns about unsigned code, that keeps itself up to date from
GitHub Releases. Push-to-talk works in the app's window as it does in the browser, and beyond
it: a key held anywhere on the machine, while another app is in front, gives Obeya a command. On
first start a setup assistant checks what Obeya needs on the machine (Claude Code with its login,
git, gh, voice, the demo tools), installs what it can and creates the first canvas. The data stays in `~/.obeya` as today, and starting from the checkout with `bun start`
stays as it is: Obeya is developed that way and keeps updating itself from its checkout.

## Where it stands

- *Starting*: only from the checkout, `bun start` (`src/server/main.ts`), which needs Bun. Without
  `--dev` the process supervises the server and restarts it when its checkout moves to new code
  (design: Self-update). There is no version number (`package.json` has none) and no CI workflow
  in the repository.
- *Checking the machine*: the settings sheet already checks voice (`src/server/voice-setup.ts`:
  Whisper, ffmpeg, uv, the voice) and demos (`plugin/skills/demo/lib/setup.ts`: Node, Playwright
  and a browser, ffmpeg, uv, the voice, Whisper), each missing piece with how to install it on
  this platform, and installs Piper, Whisper's model and Qwen3-TTS itself. Claude Code, its login,
  git and gh are not checked; a missing login shows only when an agent fails ("Claude ist auf
  diesem Rechner nicht angemeldet").
- *Claude Code*: the Agent SDK brings its own Claude Code binary per platform as an optional
  package (`@anthropic-ai/claude-agent-sdk-darwin-arm64` and so on, 224 MB on macOS arm64), and
  Obeya runs that one (`src/server/runtime.ts` sets no `pathToClaudeCodeExecutable`), on the
  machine's login.
- *A single file* (measured 2026-10-06, Bun 1.3.12, macOS arm64): `bun build --compile
  src/server/main.ts` builds in 0.3 s a 66 MB binary that holds the server, the UI (the HTML
  import) and `bun:sqlite`, without the Claude binary. As built, macOS killed it at start
  (exit 137): it is not signed and `codesign` rejected its format until `codesign
  --remove-signature` and an ad-hoc signature. Then it served a scratch canvas with its plan doc
  on `--idle-workers`. What it hands to other processes resolved into Bun's embedded file system
  and is missing there: Playwright (`bun install --cwd "/"`) and `voices.ts` (`/$bunfs/root/…`);
  the same goes for `voice/*.py`, the plugin a worker loads and `OBEYA_KIT` for adapters.

## Design

### Shape of the app

- **Tauri shell around the compiled server**, as `open-source.md` decided: the server is
  `bun build --compile` per platform, a Tauri sidecar (`externalBin`); the shell starts it, opens
  a window on `http://127.0.0.1:<port>/` and brings installer formats, the updater, a native
  folder picker and global push-to-talk. The UI stays what the browser shows today; "Im
  Browser öffnen" opens the same canvas in the default browser, which also stays the way where a
  webview cannot do what the page needs (see Risks).
- **The supervisor stays in the server.** The compiled binary supervises itself as `obeya` does
  today (it restarts the server for a saved configuration); only watching its own checkout is off
  when there is none (`ownCheckout()` null). The shell stops Obeya through HTTP, the way Ctrl-C
  does (workers pause at a safe point, at most 15 minutes, "Jetzt beenden"), not through a signal:
  Windows has no SIGTERM, and killing the sidecar there would cut workers off mid-turn.
- **Resources beside the binary.** Everything another process runs or imports is a real file in
  the app's resources directory, read-only: `plugin/` (the demo skill, with `playwright-core`
  beside it for the director), `voice/` (the sidecars), the adapter kit (`OBEYA_KIT`) and the
  built-in adapters. The server finds them through one function (resources directory in the app,
  the checkout otherwise) instead of `import.meta.dir`. What is written today beside the code goes
  into Obeya's home: a signed app bundle must not change.
- **Repositories' own adapters** (`.obeya/adapter/index.ts`) are imported at runtime from disk,
  which the compiled binary has to do as `bun` does (it carries Bun's transpiler). Checked in W1
  with a real one.
- **Formats**: DMG for macOS (arm64 and x64), NSIS installer for Windows (x64; arm64 once there is
  a machine to try it on), AppImage and .deb for Linux (x64, arm64). The updater replaces DMG,
  NSIS and AppImage installations; a .deb is updated by downloading the next one, which the app
  says. No Flatpak or Snap: their sandboxes are in the way of git, agents and the repositories.
- **Version**: `package.json` gets one (0.x), a tag `v0.x.y` on `main` makes a release, and the
  settings and the logo's hover show it. The checkout shows its commit instead.

### Push-to-talk

- **In the window** nothing changes: the page holds Space or the mic button and records as in the
  browser (design: Voice in). The window is a webview with the page in it, so it gets the same
  keys; W2 checks that recording works there (microphone permission per webview, see Risks).
- **Anywhere on the machine** ("global") is what the app adds. Space alone cannot be that key:
  held anywhere, it would be taken from every other app, and no one could type a space while
  Obeya runs. The key is one the owner does not type with, held alone, as dictation tools do it:
  by default the right Option key on a Mac and the right Ctrl key on Linux and Windows, chosen in
  the settings (any single key, or a combination such as Ctrl+Shift+Space). A tap of it does
  nothing, so the key keeps its use in shortcuts; only holding it past 0.3 s records.
- **How the shell hears the key**, per platform: on macOS a listen-only event tap (Quartz
  `CGEventTap`, which sees modifier keys on their own), which needs the "Input Monitoring"
  permission that the setup assistant asks for; on Windows a low-level keyboard hook
  (`WH_KEYBOARD_LL`), no permission; on Linux with X11 XInput2's raw key events. Wayland gives an
  app no keys of others: there it goes through the desktop's "Global Shortcuts" portal
  (`org.freedesktop.portal.GlobalShortcuts`, KDE Plasma and GNOME 48 or newer), which reports
  press and release of a shortcut the owner binds in the desktop's dialog; on a desktop without
  the portal there is only the window's Space. Tauri's own global-shortcut plugin reports press
  and release too, but only for combinations; it serves the combination case.
- **The shell records**, not the page: a webview in the background or a closed window cannot be
  relied on to record, so the shell opens the microphone itself (`cpal`), and posts the audio to
  the canvas's `/voice` endpoint as the page does, with the focus the page last reported (open
  card, project in view; none with the window closed). The microphone permission is the app's,
  asked once.
- **What the owner sees and hears**: while the key is held, a small floating panel at the edge
  of the screen shows that Obeya listens, then what it heard and the confirmation, and the
  confirmation is spoken as today (played by the shell when the window is not open). The
  command's undo window shows in the panel.
- **The browser** keeps Space in its tab; a browser cannot hear keys outside it. The checkout
  can start the shell too (`bun run app`) to get the global key, so it is not only the
  installed app that has it.

### Claude Code

- The app runs the **user's own installation** of Claude Code (`pathToClaudeCodeExecutable`, found
  on the `PATH` and where the official installer puts it), not the SDK's binary, which would add
  224 MB per platform to every download, ship Anthropic's proprietary binary inside an MIT app,
  and freeze its version until the next app release. The setup assistant installs it if missing.
  Whether that holds is open question 3: the SDK and the binary it brings are of one release; a
  user's Claude Code that is newer or older may not speak the SDK's protocol. The checkout keeps
  the SDK's binary unless W1 finds the user's works as well.

### Builds in CI

- GitHub Actions with `tauri-action`, a matrix of macOS arm64 and x64, Windows x64, Linux x64 and
  arm64 (GitHub's ARM runners), each compiling the server for its own platform (no cross
  compilation, so signing and a smoke test run where it was built). A tag `v*` builds, signs and
  uploads everything into a draft GitHub Release with `latest.json` for the updater; the owner
  publishes it. A push to `main` that changes code builds unsigned and runs a smoke test (the
  binary starts a scratch canvas and answers `/api/canvases`), so a broken build shows before a
  tag. `bun test` and `bun run typecheck` run in the same workflow on Linux.

### Signing and notarisation

- **macOS**: a Developer ID Application certificate (the owner is enrolled in the Apple Developer
  Program, 99 USD a year),
  `notarytool` with an App Store Connect API key, the ticket stapled to the DMG. The Bun binary is
  signed with the hardened runtime and the entitlements a JIT needs (`allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`), after `--remove-signature`
  (see Where it stands); the microphone needs `NSMicrophoneUsageDescription` and the
  `audio-input` entitlement. The global key needs the "Input Monitoring" permission, which the
  app asks for at run time (`CGRequestListenEventAccess`), not an entitlement.
- **Windows**: unsigned for now (decided 2026-10-06); the site says what SmartScreen shows and how
  to go on ("Weitere Informationen" → "Trotzdem ausführen"). A certificate later is open
  question 1.
- **Linux**: unsigned, with SHA-256 checksums in the release.
- **The updater's own key pair** (Tauri signs update artefacts, free) lives in the repository's
  secrets like the certificates. Enrolment, certificates and secrets are the owner's steps; the
  worker writes them down in `docs/release.md`.

### Auto-update through GitHub Releases

- The app asks `latest.json` of the newest release at start and every six hours. A newer version
  shows in the bar ("Update 0.4.0"), with what changed (the release notes) on hover.
- Installing goes the way a restart for new code goes today: the workers are told, pause at a safe
  point (at most 15 minutes), the owner's video or dictation holds it, "Jetzt aktualisieren" has
  it go ahead; then the shell replaces the app and starts it again, and the workers resume. The
  owner decides when; the app does not update by itself while agents run.
- An app never opens a database whose schema is newer than it knows (`PRAGMA user_version` above
  its migrations): it says to update instead of failing later. That case comes from a checkout on
  the same home, or a version installed by hand.

### Setup assistant on first start

- Shown when there is no `canvases.json` in Obeya's home, in the app and in the checkout alike
  (the UI is the same), and later from the settings ("Einrichtung prüfen"). One list, built from
  the checks that exist (voice, demos) plus Claude Code (installed, version, logged in), git and
  gh (installed, logged in):
  - **needed**: Claude Code with a login, git. Without them nothing starts.
  - **for pull requests**: gh with a login. Skippable; repositories that land locally need none.
  - **for voice** and **for demos**: as in the settings today. Skippable, with how large each is.
- "Installieren" installs what installs without admin rights: Claude Code (the official
  installer), uv, Piper, Whisper's model, Qwen3-TTS. For system software (git, gh, ffmpeg, Node, a
  browser) it shows the command for this platform (Homebrew, winget, the Linux family's package
  manager, as the hints do today) with a copy button, and runs it on a click where it needs no
  password (winget, Homebrew already there). Logins open a terminal with `claude` (for `/login`)
  or `gh auth login`; the list checks again when the window gets the focus back.
- **The first canvas**: pick a repository folder (the native dialog in the app, a path field in
  the browser) or clone one (`gh repo clone`, or a git URL) into a folder; Obeya writes
  `canvases.json` with it and its adapter (the repository's own, else generic) and opens the
  canvas, with a first card that says what to try.

### Data and the checkout

- **`~/.obeya` as today**, for app and checkout alike (`OBEYA_HOME` still moves it). Settings,
  voices, models and canvases carry over from one to the other.
- **One Obeya per home.** A running Obeya writes its port and pid into its home; a second start on
  the same home opens the running one (the app) or says where it runs (the checkout), instead of
  both serving one database on one port.
- **The checkout stays** for developing Obeya and for anyone who wants it: `bun start` with
  self-update from its checkout, as today. The README offers the download first and the checkout
  under "From source"; the site's "Getting started" links the release.

### Order

W1 first: it says whether the compiled server carries everything. W2 and W6 then in parallel (the
assistant is UI and server, and works in the checkout without the shell). W3 after W2, W4 and W5
after W3. W7 beside W2. W8 (global push-to-talk) after W2, beside W3.

## Workstreams

- [ ] **W1:** Obeya as one file. `bun build --compile` of the server for the five targets; one
  function for the resources directory (beside the binary, else the checkout) used for `plugin/`,
  `voice/`, the adapter kit and the built-in adapters; what is written beside the code moves into
  Obeya's home; self-update off without a checkout; a version in `package.json`, shown in the
  settings. Checked with the binary on macOS and on a Windows and a Linux runner: a scratch canvas,
  a real worker with the SDK's binary and with the user's Claude Code (open question 3), a demo
  render, a voice command, a repository's own adapter.
- [ ] **W2:** The Tauri shell. The compiled server as sidecar, a window on the canvas, one Obeya
  per home (port and pid in the home), stop through HTTP like Ctrl-C, single instance, "Im Browser
  öffnen". Microphone and demo video checked in WKWebView, WebView2 and WebKitGTK. Unsigned DMG,
  NSIS installer, AppImage and .deb built locally.
- [ ] **W3:** Builds in CI: a GitHub Actions workflow with the platform matrix. On a push to `main`
  that changes code, unsigned builds with a smoke test plus `bun test` and `bun run typecheck`; on
  a tag `v*`, a draft release with all installers, checksums and `latest.json`.
- [ ] **W4:** Signing and notarisation. macOS: Developer ID, hardened runtime with the Bun
  entitlements, notarised and stapled in CI. Windows and Linux unsigned, with checksums. The
  owner's steps (certificate, API key, secrets) in `docs/release.md`.
- [ ] **W5:** Auto-update through GitHub Releases. Tauri's updater with its own key pair; the bar
  shows a newer version; installing waits for the workers like a restart, then replaces and
  restarts the app; the app refuses a database newer than it knows.
- [ ] **W6:** Setup assistant on first start. One list of what Obeya needs (Claude Code and its
  login, git, gh and its login, voice, demos), needed and skippable parts apart, installs without
  admin rights at a click, commands for the rest, logins in a terminal; then the first canvas from
  a folder or a clone. In the app and in the checkout, and from the settings later.
- [ ] **W7:** Data and the checkout. `~/.obeya` shared by app and checkout, the second start on one
  home opening the first; README with the download first and "From source" after it; the site's
  "Getting started" with the release; `docs/design.md` gets the app (its Decision on Tauri, which
  says "only if global push-to-talk needs it", changes with it).
- [ ] **W8:** Global push-to-talk. A key held anywhere on the machine records a command while
  another app is in front: right Option on a Mac, right Ctrl elsewhere by default, any key or
  combination in the settings, a tap passing through. The shell hears it (macOS event tap with
  the Input Monitoring permission, which the setup assistant asks for; Windows keyboard hook; X11
  XInput2; Wayland's Global Shortcuts portal) and records itself, posting to `/voice` with the
  page's last focus; a floating panel shows listening, what was heard, the confirmation and its
  undo window. Space in the window stays as in the browser. `bun run app` starts the shell from
  the checkout too.

## Risks

- **Bun's compiled binary on macOS** was killed at start as built (measured, Bun 1.3.12) and
  signs only after its signature is removed. Whether notarisation accepts it with the JIT
  entitlements is not known until W4; a Bun update can change it either way.
- **Webviews**: WKWebView asks the app for the microphone, WebKitGTK has media streams off unless
  the app turns them on and plays H.264 only with GStreamer's plugins installed. Where the window
  cannot record or play a demo, the app opens the canvas in the browser instead.
- **Obeya itself on Windows** has run the voice check and a voice command on a runner (W7 of
  `open-source.md`), but not workers, worktrees and landings: design.md calls it "a separate,
  larger question". The Windows app depends on it; W1 checks it with a real worker.
- **SmartScreen** warns about a new download until it has a reputation, signed or not (an EV
  certificate no longer skips that). The first Windows users see a warning either way.
- **Global keys**: macOS asks the owner to allow Input Monitoring in the system settings, and
  until that is done the global key does nothing (the assistant and the settings say so). On
  Wayland it depends on the desktop having the Global Shortcuts portal; without it, only the
  window's Space works. A webview recording in a background window is not relied on, which is
  why the shell records.
- **Claude Code versions**: running the user's installation (open question 3) can break when
  Claude Code and the SDK drift apart; the setup assistant would then say which version Obeya
  needs.
- **Size**: about 66 MB server, a few MB shell, resources around 20 MB; voice and demo models
  (Whisper 1.6–1.9 GB, a Piper voice) are fetched on first use either way.

## Open questions

1. **A Windows certificate, later.** Decided (2026-10-06): Apple from the start (the owner is
   enrolled), Windows unsigned for now. The routes for later, as of 2026-10-06:
   - **SignPath Foundation**, free for open-source projects; the signature names "SignPath
     Foundation" as publisher and the project in its details. Conditions: an OSI licence, no
     proprietary component in what is signed (one more reason not to bundle the Claude binary),
     and an existing release with some reputation, so it comes after the first unsigned release.
   - **Azure Artifact Signing**, 9.99 USD a month; individuals only in the USA and Canada, in the
     EU only organisations (a company with a verifiable history).
   - An **OV certificate** from a CA, a few hundred euros a year, the key on a hardware token or
     in a cloud HSM (required since 2023), so signing in CI goes through the CA's cloud signing.
   - Recommendation: SignPath once the first release is out.
2. **Python sidecars bundled or fetched through uv**: recommendation, through uv on first use as
   today; only the scripts ship, and uv itself ships with the app (one binary, about 40 MB, no
   install step for voice and demos). Bundling Python with mlx-whisper or faster-whisper would add
   hundreds of MB per platform for everyone, including those who never speak, differs by GPU
   (MLX, CUDA, CPU), and every native library in it would have to be signed and notarised; the
   models (the large part) are downloaded on first use anyway.
3. **Which Claude Code the app runs**: the user's installation (recommended, see Claude Code) or
   the SDK's own binary. W1 tries both; if the user's does not work with the SDK reliably, the
   app ships the SDK's binary after all and SignPath (question 1) is out.
4. **The default key for global push-to-talk**: right Option on a Mac, right Ctrl elsewhere
   (right Alt is AltGr on many European layouts). Fn on a Mac would be nearer to hand, but macOS
   gives it to dictation and the emoji picker, and an external keyboard often has none.
