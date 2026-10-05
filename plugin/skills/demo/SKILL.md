---
name: demo
description: Present finished work to the owner as a narrated screen recording with a one-page report (what it does, shown / not shown, findings, an open question when there is one), so they can approve or give feedback without reading code or clicking through the app. Typically at the end of an implementation session, for the uncommitted and/or unpushed changes; also for any named commit or branch. Use when they ask for a demo, a walkthrough, "führ mir das vor", or /demo.
---

# /demo — present a change like a team lead presents to a director

The owner works at the level of a director with a large team: they do not define acceptance
criteria, read diffs, or click through the app. They want to *see* the change, in the shortest
complete way, and then approve it or give feedback. The output is a local page with a narrated
video (30 s to 3 min, by the size of the change) and a short report.

## 1. Scope — what is "the change"

Two kinds of scope, and they differ in what you may do (sections 2 and 3):

- **Own work** — without an argument: everything this checkout has that its upstream does not,
  unpushed commits plus uncommitted changes (`git log @{upstream}..HEAD`, `git diff @{upstream}`;
  fall back to `origin/main`). A larger feature often spans several commits; demo them as one
  feature, not per commit. If that is empty (a fresh session with nothing unpushed), ask which
  change to demo instead of guessing.
- **Existing change** — with an argument (commit, range, branch, PR): that change, typically
  already pushed and possibly written by someone else.

Derive the behaviours from the diff, the commit messages and the touched docs — even when you
built the change yourself in this session, so nothing you did early on is forgotten. Build your
own list of **every user-visible behaviour** the change introduces or alters: the main flow, each
rule, each guard and edge case (limits, blocked states, what it deliberately does *not* do), and
where it surfaces (other pages, PDFs, dialogs, e-mails). This list is your working tool, not a
question for the owner. Each behaviour ends up either shown in the video or listed under "not
shown" with a reason. Do not show refactors, tests or code.

Every change gets a video, backend changes included. Backend behaviour is shown where the app
makes it visible — its explorers and inspection views, the API responses behind a page, the
resulting documents. If no view exposes the behaviour, that is itself a finding: for own work,
add a minimal inspection view as part of the change; for an existing change, propose one.
"Covered by tests" is never a reason to leave a behaviour out of the video.

## 2. The stack must serve exactly this code

The recording is only evidence if the running app contains the code in scope:
- Own work: the stack must run from the checkout that holds the changes (a worktree session needs
  its own stack or has to hand over to the checkout that runs one).
- Existing change: demo it on the checkout's current code as long as that contains the change
  (`git merge-base --is-ancestor <commit> HEAD`). Do not check out an old commit or switch
  branches in a checkout that may hold someone's work. If later commits changed the behaviour,
  show the current behaviour and say so in the report; if uncommitted changes in the checkout
  touch the demoed area, say that too. If the change is not in this checkout (an unmerged branch
  or PR), ask before switching anything.
- A running stack can be older than the code on disk, in either scope. Compare the migrations the
  database has applied with those in the code, and apply missing ones *before* restarting the API
  (startup work may need the new tables). Then restart the API. Frontend usually hot-reloads.
- Confirm that the served app has the change (the new field, button or response property is
  there, and the data behind it works) before scripting against it — a served endpoint alone
  proves nothing if its table is missing.

The local dev stack is yours without restriction: issue, cancel, delete, reset the database,
create data through the API or SQL, restart services — whatever shows the behaviour best. If a
behaviour only becomes visible after an irreversible step (an issued document, a Storno), perform
the step. The only boundary is outside the local stack: production, and anything that reaches
real external systems — and other agents' work on the same machine: they render their own demos
and run their own stacks in parallel, so end only processes you started (by PID), never by
pattern. Restrictions aside, prefer adding data over resetting: a database may hold
a restored prod dump or simulator history that takes minutes to rebuild (check the project's
notes and its recipe), and a restart of the whole stack
costs more than a restart of one service.

## 3. Explore before scripting

Look at the real UI first: find the pages, the stable locators (ids, roles, exact texts) and what
each state looks like. For a look through Playwright, put `explore.ts` in the demo directory and
run `node explore.ts`:

```ts
import { explore } from '${CLAUDE_SKILL_DIR}/lib/director.ts';
await explore('http://127.0.0.1:4480/', async (page) => {
  await page.screenshot({ path: 'explore.png' });
});
```

Importing the director is what resolves Playwright; a script that imports `playwright` or
`playwright-core` itself fails with `ERR_MODULE_NOT_FOUND`. Never put files into the skill
directory. Scope text lookups to the content area — navigation entries share names with content.
Locators are strict: a text or role that matches two elements fails the scene, so scope it or
take `.first()`. Pick seeded data that makes each behaviour visible; create what is missing.

Defects the demo uncovers:
- In own work, they are part of the session's work: fix the change (with its test), demo the
  fixed state, and say in the chat report what the demo caught.
- In an existing change, do not touch the code: record the defect in `findings`, with how to
  reproduce it, and let the owner decide.

Either way, what needs the owner's judgement — a product or wording question, a trade-off, a
pre-existing issue outside the change — goes into `findings`.

## 4. Write the demo script

Create `~/demos/<repo-dir>-<slug>/demo.ts` (model: the newest demo of the same repository under
`~/demos/`, else `${CLAUDE_SKILL_DIR}/example/demo.ts`). It imports `runDemo` from
`${CLAUDE_SKILL_DIR}/lib/director.ts` and defines:

- `login` (unrecorded) and `open` (the opening shot, unrecorded),
- `scenes`: each has a chapter `title`, the narration `say`, and `run(d)` with the actions shown
  while it is spoken,
- `report`: `summary`, `shown`, `notShown`, `findings`, `question` only when something needs
  the owner's call beyond "release or feedback" (a trade-off, what to do about a finding), `meta` (branch and commits,
  "+ uncommitted changes" when there are any, stack, data; reviews only where some ran — the
  session's own, or the ones on the PR).

Narration — in the language and person of the demo settings, matter-of-fact. Read them first:
`node ${CLAUDE_SKILL_DIR}/lib/settings.ts` prints the language (narration, chapter titles, report)
and the person: the first person only when the voice is the owner's own, otherwise the work
is presented without "I" or "we".
- One scene per behaviour, 1–3 sentences each. Say what the viewer sees and why it matters,
  never the implementation. Length follows the size of the change, never padded: a small one
  30–60 s (for a fix: the broken behaviour, then the fixed one), a larger one 1½–3 min,
  a multi-commit project one demo per shipped workstream.
- Open with the situation and what was missing; end with a one-sentence recap and a release
  recommendation (or what blocks it).
- Behaviour that varies between runs (timings, a model's output, a bug that shows only
  sometimes) is measured before the narration is written, and narrated so it holds in any take
  ("several seconds", "mostly"), not with the value of one run. Other agents load the same
  machine: compare CPU time or counts rather than wall-clock time.
- Write large numbers as words ("about fifteen thousand two hundred euros"); small ones as digits
  are fine. Avoid abbreviations the voice would spell out.

Director helpers (`d`): `goto`, `click`, `type` (clears, then types at reading pace; `''`
clears), `drag(from, to, ms?)` (onto an element or a point, the pointer moving along),
`scrollTo`, `highlight(locator | locator[], label?)` (ring that follows scrolling; cleared at each
scene and by `clearHighlights()`; not inside iframes), `untilSpoken(fraction)` to time an action
to the narration, `pdfFrom(button, name)` (PDF from a new-tab button → PNG pages),
`showImage(png, top, caption)`, `panImage(top)`, `hideImage`, `wait`, and `d.page` for raw
Playwright. Keep the recording on the app's own pages: other material (a results page, a report)
goes on screen with `showImage`, since a `goto` to another origin and back broke the timeline.

## 5. Render

```bash
cd ~/demos/<repo-dir>-<slug> && node demo.ts --narration       # only the narration, cached
cd ~/demos/<repo-dir>-<slug> && node demo.ts                    # the voice of the settings
cd ~/demos/<repo-dir>-<slug> && DEMO_VOICE=piper node demo.ts   # another voice, into piper/
```

Start the narration as soon as the `say` texts are written, while you still script the scenes
(`run` may be empty then): `--narration` synthesises and caches the clips and exits, so the
render later starts recording at once. Run both with the Bash tool's `run_in_background`; you are
notified when they end (a render takes one to three minutes). Not with `&`, and do not wait with
`sleep` or `pgrep` loops (sleep is blocked; `pgrep -f "node demo.ts"` matches its own command
line). A second render of the same demo while one runs is refused with the PID of the first.

Narration is synthesised first by `lib/tts.py`, in the voice of the demo settings: Piper (the
default) or Qwen3-TTS on this machine, macOS `say`, the owner's own command, or a hosted service
(Gemini, OpenAI, ElevenLabs, Azure, an own endpoint) with its key from its environment variable or
a key file. The settings live in `demo.json` in Obeya's home (`OBEYA_HOME`, else `~/.obeya`);
Obeya's settings sheet edits them, installs Piper and Qwen3-TTS, and plays a sample. A voice that
is not installed stops the render with how to install it: from the settings sheet, or
`node ${CLAUDE_SKILL_DIR}/lib/voices.ts install`. `DEMO_VOICE=<provider>` renders in another
voice; `DEMO_VOICE=<path>.wav` clones that clip with Qwen3-TTS (its exact transcript beside it as
`.txt`). Clips are cached by voice and text, so re-runs after a
visual fix skip synthesis. Each clip is transcribed back with Whisper (mlx-whisper on Apple
Silicon, faster-whisper elsewhere) and synthesised again (up to three takes) when it does not
match. Listening back can be off in the settings ("Erzählung mit Whisper gegenhören"), and a
Whisper that cannot be loaded turns it off for that render; then the review table says "not heard
back" and the report page "nicht gegengehört": name that in the report's `findings`. A voice that
loads a large model (Qwen3-TTS, the owner's command) takes 7–12 GB with Whisper, so only one such
demo synthesises at a time (lock `~/.cache/demo-skill/tts.lock`); the others log "waiting for it"
and wait, which is expected, not a hang. Recording uses the local Chrome, else Edge, else
Playwright's own Chromium (`DEMO_CHROME` names another; headless screencast, 1440×900); it runs
on macOS, Linux and Windows. A failing scene leaves `.work/failure.png`.

## 6. Review your own video — before the owner sees it

- The render ends with a review table: per scene its chapter time and how well the heard
  narration matched what was said (`match`, flagged below 0.93 with what was heard; all of it in
  `.work/narration-check.json`). Rephrase a flagged sentence and render again.
- `review/NN-mid.jpg` and `review/NN.jpg`: a still from the middle and from the end of each
  scene. Look at all of them: is the thing being talked about on screen, ringed, legible? Pull
  further frames only for fast transitions (`ffmpeg -ss <t> -i demo.mp4 -frames:v 1 x.png`).
- A warning that the screencast frames are smaller than the viewport means part of the page is
  missing from the video.

Iterate until it is clean. Then `open` the page, send a push notification (the `PushNotification`
tool; load it via ToolSearch if it is deferred), and reply in the chat
with the page path, the length, the open question if any, what the demo caught and fixed, and
the findings — one line each.

## 7. Feedback

The owner answers in the chat. Apply the feedback to the change or the demo, re-render, and point
to the same page. Do not publish the page or video anywhere (Artifact, Slack) without asking when
it carries the owner's cloned voice.

## How to run the app

Under Obeya, the worker's brief says how to run the app of its repository for a demo (Obeya's repo
adapters hold these recipes). Without Obeya, ask it: `bun ${CLAUDE_SKILL_DIR}/lib/recipe.ts`, run
in the repository, prints the recipe when an adapter knows the repository. Otherwise the
repository's own docs (CLAUDE.md, README) say how to start it.
