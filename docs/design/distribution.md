## Distribution

A chapter of the [design doc](../design.md), whose header says how it is written.

### One file

`bun run build` compiles the server with `bun build --compile` into one binary (66–120 MB, UI and
SQLite included) that needs neither Bun nor a checkout: for this machine, or with `--all` for macOS
arm64 and x64, Linux x64 and arm64 and Windows x64 (Bun cross-compiles).

Bun's embedded file system is readable only by the binary itself, so whatever other processes run or
import goes beside it as real files in `resources/`: the plugin with its skills and the
`playwright-core` the demo skill records with, the voice sidecars, the skills' settings scripts
bundled with their imports, and `docs/settings.md` for the settings skill. The server looks for them
in `OBEYA_RESOURCES`, else `resources` beside the binary (`Resources` in a macOS app bundle), else
the checkout (`src/server/resources.ts`). The resources may be read-only; everything Obeya writes is
in its home.

The binary is its own Bun for scripts (a site's deploy script runs as `obeya <script>` with
`BUN_BE_BUN=1`). It supervises itself as `bun start` does, but has no checkout to follow, so it
never restarts for new code. Constraints of the build: a macOS binary must be signed (ad hoc at
least), or macOS kills it at start; Bun leaves a copy of its runtime (`.<hex>.bun-build`) in the
working directory of every compile, so the build compiles in the output directory and removes it;
the UI bundle needs `NODE_ENV` defined as production, or it ships React's development build.

`package.json` holds Obeya's version, which the settings show, with the commit beside it when Obeya
runs from a checkout. `bun scripts/check-binary.ts` checks a binary end to end on the machine it
runs on (voice, a demo render, a real worker on Claude Code and on the SDK); it passes on macOS
arm64, Windows x64 and Linux x64 and arm64 (2026-10-07).

### App

A Tauri 2 shell (`app/`, Rust) whose sidecar is the compiled server. `bun run build:app` builds it
for this machine: a DMG on macOS (with the hardened runtime and the entitlements Bun's JIT needs;
without them the server fails at start for lack of `SharedArrayBuffer`), a per-user NSIS installer
on Windows (no admin rights), an AppImage and a .deb on Linux (`app/linux.Dockerfile` builds and
checks them in a container on a Mac).

The shell opens a window on the Obeya already running on the home, or starts the server (on 4417,
else a free port) and shows „Obeya startet …“ until it answers. Quitting the app (Cmd+Q, the menu,
the Dock) stops that server as Ctrl-C would (`POST /api/stop`), whoever started it (the app, in this
run or an earlier one, or `bun start` in a terminal, which then ends too), and the window shows what
the stop waits for; quitting again goes ahead at once. The app ends when its server does; a server
it started in this run that ends unasked shows the last lines of its log in a dialog. The server's output goes to `app.log` in the home. A second start
brings the window to the front. On a Mac, closing the window keeps the app in the Dock, and the
window has no title bar: the canvas's bar holds the traffic lights and drags the window. Links
leaving the canvas and new windows open in the default browser, as does „Im Browser öffnen“ in the
settings (and the Mac's File menu). The shell itself opens them, a plain click on a link with
`target=_blank` included; Tauri's opener plugin stays unregistered, since its link script takes such
a click and hands it to the plugin over IPC, which the page may not call, so the click did nothing
(2026-10-29). Downloads go to the Downloads folder.

The page gets the microphone without a webview prompt (the system asks once for the app).

Tauri's webview hands files dropped from the desktop to the shell instead of the page (on Windows
the page's own drop would need Tauri's handler off, and with it the paths), so the page never hears
a file drop. The shell passes on where a drag is and, at the drop, the files' paths; the page plays
them to the element under the pointer as the browser's drag events: an image with its bytes (read
through the server, which hands out only images by path) to attach as a screenshot, any other file
or folder by its path (see Other files). Tried by playing the shell's calls in a browser; a real drag
from the Finder into a built app is untried (2026-10-26).
WebKitGTK's MediaRecorder records nothing (2.50 and 2.52, 2026-10-08), so the Linux window records
Web Audio samples and sends a WAV (tried only headless; a Linux desktop with a real microphone is
untried).

#### The app from a checkout

`bun run app` builds the shell alone and runs it from the terminal on the checkout's server (`bun
src/server/main.ts`, run in the checkout), which follows the checkout as `bun start` does. `bun run
app install` installs that shell as an app of its own, „Obeya (checkout)“: in `~/Applications` on a
Mac (a bundle, so Spotlight, Launchpad and the Dock know it and the system asks its permissions for
it), in the Start menu on Windows, in the applications menu on Linux, and opens it. Its identifier is
not the release's, so its permissions and its single instance stay apart from an installed release.
Started from the desktop it gets no environment, so the checkout, the bun that ran the install and
the version of `app/` on HEAD are compiled in, and the commit, which its settings show under „App“;
the server it starts adds the directory of its bun to the PATH, for the workers' `bun`. A checkout's
Obeya in a browser shows `bun run app install` in its settings.

Landed code reaches it as it reaches `bun start` (see Self-update); the shell itself offers no
release updates. Once `app/` on the checkout's HEAD is another than it was built from (looked at
every minute), the shell runs `bun run app install` itself in the background, which puts the new
build in its place. A server the shell started itself is told, and installs the new build without
asking, as it restarts for landed code: once the workers paused, the server ends for the update, and
the shell starts again, now the new build, whose server resumes the workers. A server the shell did
not start (`bun start` in a terminal) runs on, workers and all, and only the shell starts again. It
asks the server every few seconds (`POST /api/app-rebuilt`) and goes once the owner neither
dictates nor watches a demo video (what a restart waits for) and its window is either out of sight
(closed on a Mac, where the app stays in the Dock) or in front with the owner in it; minimized or
behind another app's window it waits, as the new window would come up over what the owner works
in. The new window opens where the old one stood, as large, on the page it showed, without coming
to the front if the old one was out of sight. What a reload keeps (the open card, drafts, scroll
positions, see Keeping the page) lives in the tab's session storage, which a new shell's webview starts
without: the shell first has the page hand it to the server, waits a few seconds at most for it to
arrive, and the page in the new window takes it back, once. On a Mac the new shell is started
through the system (`open`) once the old one has ended, as the Dock starts it: started by the old
process, it would count as that process's for the system's permissions, the microphone among them.
The bundle of the shell that still runs is moved aside on a Mac (`Obeya (checkout).app.old-…`
beside it), not removed: macOS decides on the microphone by the file the running program was
started from and denies it once that file is gone. A later install removes the asides nothing has
open any more. A build that fails is logged to `app-build.log` in the home and tried again with the next change
of `app/`.

linuxdeploy rewrites the library path of every program in an AppDir, which breaks Bun's binary (its
code sits after the ELF's end), so the server goes into the AppImage after linuxdeploy and the image
is packed again. `bun scripts/check-app.ts <program>` checks an installed app in its webview
(canvas, microphone, video playback, browser button, second start, stop).

### Builds

`.github/workflows/build.yml` builds the app on GitHub's runners, each platform on its own (the
AppImage on Ubuntu 22.04 for its glibc), checks the compiled server there with
`scripts/check-binary.ts`, and runs typecheck and tests on Linux (with uv and ffmpeg for the demo
voice's tests). A run takes about ten minutes.

Builds and tests use Bun 1.4.3. Obeya needs Bun 1.3.14 or later: in 1.3.12 on Linux, a closed
`fs.watch` can deadlock Bun's work pool, after which every page bundle hangs for good (2026-10-13).
`bun start` from a checkout runs on the machine's Bun; on Linux with a Bun before 1.3.14 Obeya still
starts, but warns in the log and with a pill in the bar („Bun 1.3.12 ist zu alt“, the hover saying
what may happen and to run `bun upgrade`).

The build runs on a push to `main` that changes code (the same paths the self-update ignores are
left out, except the build workflow itself), keeping the installers a week as artifacts, and on a
tag `v<version>` matching `package.json`. A tag makes a draft GitHub Release with every installer,
the updater's archives and signatures, `SHA256SUMS` and `latest.json`. Its notes are the subjects of
the commits since the previous version tag that change what runs (the first twelve lines also go
into `latest.json`, for the bar; the first release says it is the first instead of listing the
history). The owner publishes the draft. The installers have fixed names without the version
(`Obeya-macOS-arm64.dmg`, `Obeya-Windows-x64-setup.exe`, `obeya_amd64.deb` …), which the README and
the site link through `releases/latest/download/`, so every version release is made the latest.

The build script signs the updater's archives itself when `TAURI_SIGNING_PRIVATE_KEY` is set (a
repository secret, read on tags only): `Obeya.app.tar.gz` on macOS, the NSIS installer, the AppImage
once the server is in it. Tauri's own `createUpdaterArtifacts` is not used: it needs the updater
plugin's configuration and would sign the AppImage before the server is in it.

#### Signing and notarisation

On a tag (or a manual run with "sign") Tauri signs shell, server and DMG with the Developer ID; the
DMG goes to Apple's notary service with an App Store Connect API key, and the ticket is stapled to
the DMG and to the app the updater's archive packs. The build fails unless Gatekeeper calls both
"Notarized Developer ID". stapler fetches the ticket from Apple's CloudKit, which drops the
connection for minutes now and then, so each staple and validation is retried for about thirteen
minutes. One submission covers app and server inside the DMG; Tauri's own notarisation is not used,
since it skips the DMG and takes no individual key. A tag without the Apple secrets fails rather
than release an app macOS would not open. Apple accepts Bun's binary with the JIT entitlements
(2026-10-09).

Windows and Linux builds are unsigned: the release notes say how to check a download against
`SHA256SUMS`, and the site and README say what SmartScreen shows. The Windows certificate is applied
for with the SignPath Foundation, whose conditions bring the code signing policy page (see Site) and
links to it from the site, the README and every release's notes. The maintainer's steps (secrets,
certificates, keys, agreement) are in `docs/release.md`.

#### Making a release

„Mach ein Release“ is the project skill `.claude/skills/release/`, available to every Claude session
in this repository, on a card or in a terminal. It follows `docs/release.md` § "A release" and holds
only what to judge and where the owner comes in; `scripts/release-status.ts` prints what that is
decided from (the last version tag and the commits since, the version to propose, how far GitHub's
`main` is behind, the latest release, the site's video against the last UI commit, the build's
secrets) and, with `draft <tag>`, whether the draft holds everything. `scripts/gh.ts` runs gh on the
checkout's origin as the account that owns it, since the machine's active gh account may lack the
admin rights a workflow run needs; nothing names sadilek/obeya, so in a fork they act on the fork.

Every release renders the hero video again and retakes the site's screenshots from that render; the
card's demo is the new video, so the owner watches it and approves the release in one step. After
the landing the worker pushes `main`, tags, watches the build, checks the draft and uploads the
video; the owner publishes.

### App updates

The app updates itself from GitHub Releases through Tauri's updater, with Obeya's own key pair: the
public key and the endpoint (`releases/latest/download/latest.json`, so only a published release
counts) are in `app/tauri.conf.json`; the private key signs in CI (see Builds). At start and every
six hours the shell checks; a newer version is downloaded and its signature checked at once, so
installing takes seconds. The shell keeps reporting it to the server it started (`POST
/api/app-update`), and the bar shows "Update 0.4.0" with the release notes on hover and
„Installieren“.

The app never installs by itself. The owner's click (`POST /api/app-update/install`) asks for an
update restart, which waits as a restart for new code does (see Self-update; here „Jetzt
aktualisieren“ goes ahead at once), takes the place of a restart already waiting, and gives way to a
stop. The server then exits with code 77, which its supervisor passes on; the shell, seeing its
server end so, shows „Obeya wird aktualisiert …“, installs (the bundle swapped on macOS, asking for
an administrator only where the app's folder is not writable; the NSIS installer in passive mode on
Windows, which restarts the app itself as the desktop's user, so without an environment set for the
app's process alone; the AppImage file replaced) and starts the app again, whose server resumes the
workers. An install that fails says why in a dialog, and the old version starts again.

A .deb cannot be replaced by the app (dpkg needs root): its bar offers the release to download
instead. No update is offered for an Obeya the app did not start in this run (it would not see it
end), nor from a checkout, which follows its git (see Pulling from the upstream). `bun
scripts/check-update.ts` has a locally built 0.0.1 update itself to a 0.0.2 from a local release; it
passes on macOS arm64, Windows x64 and Linux x64 (2026-10-09).

### Site

The page on obeya.si (`site/`), in English whatever the interface speaks: plain HTML and CSS without
framework or build, JavaScript only for the video's play button and chapter list, so it opens from
the file too. Paths are relative, so it also works under sadilek.github.io/obeya. It opens with one
sentence, "Direct coding agents like an engineering director" (the one who decides and directs spoke
to a test reader more than "like a team"), and the hero video; then five pillars with screenshots;
"From idea to main"; "The big room", what the name means and the one wall as the way out of many
parallel chats (no Toyota, as in the README); "Obeya is built with Obeya."; and getting started
(downloads, `bun start`, GitHub; not the design doc, which is written for the agents working on
Obeya).

The pillars: the canvas, a canvas per product side by side in one Obeya; voice; the demo, set
against testing the change by hand, not against code review, since the audience reads no code
anyway, with a pointer to `demos.obeya.si`, the demos of Obeya's own development; the order cards
run in, parallel where they can, one after the other where they must; the phone, what waits across
all canvases and a demo opened from there, reaching Obeya over the owner's own private network,
through no service of Obeya's. "From idea to main" switches (radios and CSS) between the three steps
most cards take, shown first so the page reads simple at first sight (say the task, watch the demo,
approve), and a card's longer way along a wall (an idea and its prototypes, the work, the demo with
a round back for changes, the merge, an agent's proposal hanging off it), each step a card in its
state as the canvas draws it. Only the demo carries the pin of a card waiting for the owner, so the
way reads as task, demo, done.

`site/code-signing/` ("Code signing policy", linked under the downloads and in the footer) is what
the SignPath Foundation asks of a project it signs for: who signs what, the team's roles, what Obeya
sends where. `site/watch-the-demo/` ("Why demos" in the navigation and footer) is an essay in the
owner's first person, "Stop testing your agents' work. Watch the demo.": agents outpace whoever
tests their work by hand, so a director has the work shown, as in a launch review; a demo is the
video and the worker's handover note, no report; its rules make it evidence (the code under review,
every behaviour in the video, a backend through a view); recording it is an end-to-end test the
agent runs on its own work; then what is left for the owner, and the demos as a record. It is what a
launch post links when it argues rather than shows, with its own Open Graph tags (2026-10-19). Both
share the stylesheet.

The site has Obeya's palette and type (see Visual identity); its fonts, including the three
characters of 大部屋, are served from `site/fonts/` with their OFL licences, not from Google Fonts. The
screenshots show the English interface on the hero video's Tipjar app (the demo pillar a demo of a
Tipjar change, so the picture is of a demo, not of Obeya); `bun scripts/site-shots.ts` retakes them
from a scratch Obeya.

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main` touching
`site/` or the workflow, and on demand; Pages serves a branch only from `/` or `/docs`, hence the
workflow. obeya.si is verified for the GitHub account and set in the repository's Pages settings
with HTTPS enforced (a workflow deployment ignores a `CNAME` file); at the registrar the apex points
at GitHub Pages' four A and four AAAA addresses and `www` is a CNAME to `sadilek.github.io`.

### Hero video

The site's film is a real run recorded with Obeya's own demo pipeline (`scripts/hero-video/`, whose
README says how to change, re-render and publish it) on a scratch canvas over Tipjar, a small tip
calculator with its own settings and plan doc. It goes through the main features once, from
arranging the wall and an idea by voice through a real worker's demo, comments spoken into it and
the approval to proposals and an idea discussed with its agent. About four minutes, as sharp as the
app on a Retina screen, narrated in English in the owner's ElevenLabs voice clone after being
iterated in the Qwen3 clone (see CLAUDE.md). A release's render runs real agents and records them;
corrections after it play that recording back (Demos: Agents played back), so they take minutes and
change only what was corrected.

The video is not in git: it, its captions, its chapters and the README's loop are assets of the
GitHub release `site-media`, a pre-release so that it never becomes the latest release. The Pages
workflow fetches them into `site/media/`, so obeya.si serves them itself, with no third party and no
tracking. Publishing replaces them and reruns the workflow; the chapters come from the render's
scenes, so they always match the video that is out. The loop is cut from the video at each publish
by scene titles ("Your wall" to "The agent starts"), 1.5 times as fast, about 18 s and 3 MB.

On the page it is a `<video>` with English captions and a poster (the first frame, in git), loading
nothing before a click; opened from the file, the site shows the poster alone. A script puts a big
play button (a real `<button>`) over the poster and shows the browser's controls once it plays;
without JavaScript the controls are there from the start. Below, the scenes are listed as on a
card's demo (time and title), built from the chapters track: a click plays from that scene, and the
playing scene is lifted as a card. The mark follows the playback time, not the track's active cues,
which Chrome leaves stale after a seek. Without JavaScript or the chapters file there is no list.

### Decisions

- **Installed, Obeya is an app: a Tauri shell around the server compiled into one file; the UI is
  served locally to the browser too.** Someone without Bun or a checkout can download and start
  it. Tauri brings installers and updater, and its window is the system's webview, so the shell
  adds a few MB and the UI stays what the browser shows. The browser stays a way in; the checkout
  (`bun start`, updating itself) stays how Obeya is developed.
- **From a checkout, Obeya can be an installed app that follows the checkout** (2026-10-26): whoever
  develops Obeya on its checkout gets the app (a window of its own, in the Dock or the Start menu)
  without installing again after each landing. The server already follows the checkout; the shell
  changes rarely and rebuilds itself when `app/` does. It installs a rebuilt shell without asking, unlike a
  release (see App updates), since what lands on the checkout's `main` is already installed that way
  for the server. Rejected: an app of a release build from the checkout, whose compiled server never
  follows the checkout; a launcher that rebuilds the shell at every start, which would make every
  start wait for cargo.
- **A rebuilt shell leaves the running one's bundle on disk until it ends** (2026-10-29): the
  install removed it at once, and from then until the app started again (with an Obeya started
  from a terminal: until the owner quit it) the window got no sound from the microphone. The
  system's check failed on the missing file; tried with a bundle of its own, moved aside it
  passes, removed it denies. Rejected: installing the new build only once the shell ends, which
  leaves a hand-run `bun run app install` with the same fault and the Dock's copy old after a
  crash.
- **A rebuilt checkout shell starts again by itself also beside a server started from a terminal,
  keeping the server** (2026-10-29): otherwise the old shell ran on until the owner quit it, with a
  bundle the new build had replaced under it. It goes at the moments a restart for landed code
  would, or quieter, and the window comes back as it was, so it costs the owner no more than that
  restart's reload. Rejected: restarting the server along with it, which would pause every worker
  for a change to the window alone; asking the owner, for a change they cannot judge.
- **Quitting the app stops the Obeya it shows, also one started from a terminal** (owner,
  2026-10-29): to the owner, quitting the app means quitting Obeya, as Ctrl-C does in the terminal.
  Rejected: leaving a server started from a terminal running, which made Cmd+Q close only the window
  while the workers went on, with nothing to say so.
- **DMG, NSIS installer, AppImage and .deb** (2026-10-06). Rejected: Flatpak and Snap, whose
  sandboxes get in the way of git, agents and the repositories. Windows on ARM once there is a
  machine to try it on.
- **The Mac app is signed with a Developer ID and notarised from the first release; Windows and
  Linux ship unsigned with checksums** (2026-10-06). macOS will not open an unnotarised download
  without a detour through the system settings; SmartScreen warns about any new installer, signed
  or not, until it has a reputation, so a Windows certificate could wait. Applied for with the
  SignPath Foundation (free for open source) after v0.5.0 (2026-10-19), disclosing that the server
  has Anthropic's proprietary Agent SDK compiled in, which SignPath's terms exclude. Rejected:
  dropping the SDK to qualify, which would leave Obeya tracking Claude Code's undocumented control
  protocol itself for no gain to users. Fallback: a certificate in the owner's name.
- **A release is a project skill with a status script** (2026-10-13). Checking the narration
  against the UI, looking at the stills and judging the draft need an agent; what it decides from
  comes from the script. Rejected: a script alone, or leaving it to each session (v0.1.0 ran into
  problems nobody had written down: GitHub's `main` far behind, `site-media` the latest release).
  Every release re-renders the video, stale or not, since almost every release changes the UI.
  Publishing stays the owner's click, since it reaches every installed app.
- **Obeya is made known through a static English site on obeya.si that starts with the film**
  (2026-10-06): the calm, editorial film-first prototype, with the pillars as cards on a wall, a
  card's way along the wall and "The big room" from a second. Rejected: a canvas the camera flies
  through while scrolling (built, then dropped: the scrolling felt odd).
- **The hero video is a release asset** (2026-10-07). Rejected: git, which holds no video, and a
  video host, since the site loads nothing from a third party.
