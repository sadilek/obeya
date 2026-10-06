# Obeya as open source: obeya.si and what it takes

> Plan doc for making Obeya known as an open-source tool: a site on obeya.si and the groundwork
> without which publicising it achieves nothing. Deleted when it ships; durable content moves into
> [`docs/design.md`](../design.md).

## Goal

Obeya becomes known as an open-source tool. The first step is an English site on **obeya.si**
(the domain is registered) that shows within seconds what Obeya does differently and leads to
the GitHub repository and to getting started. Before it goes out, Obeya gets what a stranger
needs to try it: a licence, a public repository with a README for newcomers, an English
interface, voice on Windows and Linux, and a plan for an installable app. Earning money and cloud
services are off the table for now (see Background).

## Where it stands

- *README*: English, for strangers: the idea, a screenshot of a scratch canvas
  (`docs/images/canvas.png`), the status, requirements, a quick start, a link to obeya.si (W2).
  `CONTRIBUTING.md` says how Obeya is built with Obeya: design doc, plan docs, cards, demos, and
  what a pull request from outside brings.
- *Licence*: MIT, in `LICENSE`, the README and `package.json` (W1). Code, tests and docs name no
  other work projects.
- *Logo*: three cards in the colours for working, waiting and approved, beside "obeya" in Inter
  Bold (`src/ui/logo.tsx`); as SVG in `src/ui/logo/`, also as a wordmark for light and dark. The
  UI loads Inter from Google Fonts (`src/ui/index.html`).
- *Language*: the interface speaks German or English (`src/ui/strings.ts`), chosen in the
  settings and following the system language until chosen; dates and numbers follow. The choice
  is in `settings.json` in Obeya's home, which the server reads (`ownerLanguage` in
  `src/server/settings.ts`) (W5). The Koordinator, spoken confirmations, worker prompts and
  server messages are still German.
  Demo narration can already be German or English (design: Architecture, Demos).
- *Platforms*: voice in and out run on all three platforms (W7): Whisper on MLX and the macOS
  voice on a Mac, faster-whisper and Piper elsewhere, with a section "Voice" in the settings
  that checks and installs them. Checked on GitHub's Windows Server and Ubuntu runners and Linux
  on ARM in Docker; on a CPU without a GPU a command takes 4–12 s to transcribe. Demo narration
  runs on all three platforms too.
- *Starting*: only from the checkout with `bun start`. Needs Bun, Claude Code with a login, git
  and gh; demos also need Node, a browser, ffmpeg and uv, which the settings check.
- *Pictures*: `bun scripts/scratch-obeya.ts <stage.json>` stages a canvas with cards in about a
  second, which is enough for screenshots. Demo videos never go into git.
- *Site*: `site/` holds the page for obeya.si, built from prototype B (film first): plain HTML
  and CSS, opened straight from the file, no build. From C it takes the six principles as cards
  on a wall, the four steps as the same card moving along the wall, "The big room" with 大部屋
  set vertically, the dark band "Obeya is built with Obeya." and the getting-started block.
  Prototype A's canvas the camera flew through while scrolling is gone again: the owner found
  the scrolling odd. Inter and the three characters of 大部屋 (Noto Serif JP) are served from
  `site/fonts/` with their OFL licences; logo and wordmark are copies from `src/ui/logo/`. The
  screenshots are B's, of the German interface, and the film is a still until W9. The prototype
  cards A, B and C can go.
- *Publishing*: the workflow `.github/workflows/pages.yml` publishes `site/` to GitHub Pages on
  every push to `main` on GitHub that touches `site/` (or the workflow), and on demand from the
  Actions tab. Pages serves a branch only from `/` or `/docs`, hence the workflow. The repository
  is public, so the free plan has Pages. Not live yet: GitHub's `main` lags the local one until it
  is pushed, and the owner's steps below are open. Today obeya.si and www.obeya.si point to the
  registrar's parking page (2.57.91.91; registrar OpusDNS, nameservers `aurora` and
  `nebula.dns-parking.com`).

### Publishing: the owner's steps

1. **Pages source.** github.com/sadilek/obeya → Settings → Pages → Build and deployment →
   Source: *GitHub Actions*.
2. **Verify the domain** (keeps others from claiming obeya.si on GitHub): github.com → your
   profile's Settings → Pages → Add a domain → `obeya.si`. GitHub shows a TXT record
   (`_github-pages-challenge-sadilek.obeya.si` with a code); add it at the registrar, then Verify.
3. **DNS at the registrar.** Remove the parking record (`A 2.57.91.91`) for `obeya.si` and the
   one for `www`, then add:

   | Name  | Type  | Value                  |
   | ----- | ----- | ---------------------- |
   | `@`   | A     | `185.199.108.153`      |
   | `@`   | A     | `185.199.109.153`      |
   | `@`   | A     | `185.199.110.153`      |
   | `@`   | A     | `185.199.111.153`      |
   | `@`   | AAAA  | `2606:50c0:8000::153`  |
   | `@`   | AAAA  | `2606:50c0:8001::153`  |
   | `@`   | AAAA  | `2606:50c0:8002::153`  |
   | `@`   | AAAA  | `2606:50c0:8003::153`  |
   | `www` | CNAME | `sadilek.github.io.`   |

4. **Push `main`** to GitHub. The workflow runs and publishes to sadilek.github.io/obeya until the
   domain is set (the site uses relative paths, so it works there too).
5. **Custom domain.** Settings → Pages → Custom domain: `obeya.si` → Save. GitHub checks the DNS
   (minutes to an hour after step 3) and then issues the certificate; once it has, tick
   *Enforce HTTPS*. www.obeya.si then redirects to obeya.si. The domain lives in this setting,
   not in a `CNAME` file, which workflow deployments ignore.
6. **Check:** `dig +short obeya.si` shows the four addresses above, https://obeya.si shows the
   site, http://obeya.si redirects to it.

## Design

### The site

- **Static, in `site/`** of this repository, served by GitHub Pages under obeya.si. Plain HTML,
  CSS, no JavaScript, no framework and no build step. The real logo from `src/ui/logo/`
  and Inter, served from `site/` rather than Google Fonts. Videos are placeholders until W9.
- **English.** The site speaks English from the start, whatever the interface does.
- **Content:**
  1. One sentence and one picture (the canvas, or a video).
  2. Three pillars: canvas, voice, demos. The owner approves the demo, not the code.
  3. The flow in four steps: idea → agent in its own clone → demo → approval and merge.
  4. Where the name comes from: the big room at Toyota, and why agents need one.
  5. Obeya is built with Obeya.
  6. Getting started: requirements, commands (later a download), GitHub, the design.
  7. Later: the hero video is a real demo out of Obeya.
- **Variant B, film first.** Calm and editorial: the video on top, below it the pillars with
  screenshots. The site (W3) starts from prototype B's page and takes over ideas from the
  prototype C (the principles as cards on a wall, the big room, the four steps as one card
  moving along the wall), so that it does not look interchangeable. A canvas the camera flew
  through while scrolling (from prototype A) was tried and dropped: scrolling felt odd.

### Groundwork

- **Licence: MIT**, copyright Daniel Sadilek.
- **Language is one setting.** English or German, chosen in the settings; without a choice it
  follows the system language. The same setting decides the spoken confirmations, the
  Koordinator's replies, the Whisper language, the language workers write to the owner in, and
  the narration language a demo is offered with.
- **Voice off the Mac** works like the demo pipeline already does: faster-whisper for input (CUDA
  if there is a GPU, else int8 on the CPU), Piper for output, which Obeya can already install for
  narration. The settings show what is missing, as they do for demos. MLX and the macOS voice stay
  the choice on a Mac.
- **The installable app gets its own plan doc** (W8), since it is a project of several weeks:
  a Tauri shell around `bun build --compile` for macOS (DMG), Windows and Linux, with auto-update.
  Tauri brings the updater and global push-to-talk, which is what the Decisions in the design doc
  keep it for.

### Order

W1 and W2 at once, then the site W3 and its publishing W4. W5–W7 (English, voice off the Mac) in
parallel with the site. W8 after W7, since the app's setup assistant checks voice too. W9 last: it
needs the English interface (W5, W6) and the site (W3).

## Workstreams

- [x] **W1:** MIT licence. A `LICENSE` file (MIT, copyright Daniel Sadilek), a "License" section
  in the README, `"license": "MIT"` in `package.json`. Search the repository for references to
  other work projects; code, tests and docs carry none.
- [x] **W2:** README and CONTRIBUTING for strangers. The README gets a screenshot (from a scratch
  canvas), the requirements, a quick start and a link to obeya.si; a short `CONTRIBUTING.md`
  says how Obeya itself is built (with Obeya, plan docs, cards, demos). Making the repository
  public with a cleaned history is decided already and is the owner's step on GitHub; a task
  already cleaning the history gets this added rather than a second one.
- [x] **W3:** The site. Built from prototype B (film first) as `site/index.html` with its assets,
  with the ideas from prototypes A and C the owner names; Inter served from `site/`, works on a
  phone, readable without JavaScript. Once it has landed, the prototype cards A, B and C can go.
- [x] **W4:** Publishing on GitHub Pages under obeya.si. A GitHub Actions workflow publishes `site/` to Pages (Pages
  serves only `/` or `/docs` from a branch), the custom domain with HTTPS. The DNS records at the
  registrar and the Pages setting are the owner's steps; the worker writes them down. Needs the
  public repository (W2) unless the account's plan has Pages for private ones.
- [x] **W5:** English interface. `src/ui/strings.ts` gets English beside German, chosen in the
  settings and following the system language until chosen; dates and numbers follow too. The
  setting is stored where the other settings are and read by the server.
- [ ] **W6:** English behind the interface. The language setting from W5 decides the Koordinator's
  replies and its spoken confirmations, the Whisper language, server messages the owner sees, the
  language worker and idea-agent prompts ask for in owner-facing text, and the narration language
  a demo is offered with. Prompts stay as they are where only agents read them.
- [x] **W7:** Voice on Windows and Linux. Input with faster-whisper (CUDA, else int8 on the CPU),
  output with Piper; the settings show what is missing with install hints per platform, as for
  demos. Checked on Linux (machine or VM) and at least one run on Windows.
- [ ] **W8:** Plan doc for the installable app. `docs/plan/app.md`, with its own workstreams:
  packaging and builds in CI; signing and notarisation (Apple Developer ID, a Windows
  certificate); auto-update through GitHub Releases; a setup assistant on first start that checks
  Claude Code with its login, git, gh, voice and the demo tools, offers to install them and creates
  the first canvas; data in `~/.obeya` as today, starting from the checkout stays. Open there: what
  the certificates cost, and whether the Python sidecars are bundled or fetched through uv on first
  use. Written after W7.
- [ ] **W9:** Hero video for obeya.si. In English, 1½–2 minutes, on a scratch canvas: an idea by
  voice, the agent at work, its demo, the approval. Rendered with Obeya's own demo pipeline, not in
  git: hosted where the site can embed it (see Open questions). Replaces the placeholder in the
  site.

## Risks

- **Ideas from A on phones.** Camera flights and unfolding cards taken over from A fight touch
  scrolling and screen readers; on a phone and with reduced motion the site stays plain B.
- **B depends on the video.** Until the hero video (W9) exists, the site shows a still with a
  placeholder.
- **English behind the interface (W6) is larger than it looks.** German sits in prompts, server
  messages and tests. If it does not fit one card, it is cut along those lines.
- **Voice on Windows** has no machine here; one run in a VM or on a colleague's machine is the
  minimum before the site says it works there.

## Open questions

- Where the hero video lives (W9): a GitHub release asset is served as a download, not reliably
  as an embeddable video; Pages takes files up to 100 MB but they would be in git. Decided with
  W9, once the video exists.

## Background: Obeya as a business (parked)

- Considered: hosting demos for sharing, remote access from the phone through a relay, voice as a
  service, a team canvas, and a subscription covering the costs. Hosted agents were ruled out.
  All of it is parked: being known comes first.
- Agents run locally, through the user's own installation of Claude Code and its login. Obeya
  starts that installation and never uses the subscription's token itself. Tools that used it
  against the API themselves were blocked; tools that start the official installation appear to be
  tolerated (T3 Code, Conductor, Obeya).
