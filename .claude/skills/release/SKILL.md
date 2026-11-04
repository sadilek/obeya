---
name: release
description: Take a version of Obeya out from start to finish, with the hero video and the screenshots on obeya.si rendered again from the Obeya being released. Use when the owner says "Mach ein Release", "make a release", "release a new version", or names this skill.
---

# Release

The steps, their commands and the facts behind them are in `docs/release.md` § "A release". Read
it first and go through its steps in its order. This skill adds where the owner comes in and what
to judge on the way.

The owner approves once, on the new hero video, before anything leaves the machine. After that
the agent pushes, tags, watches the build and uploads the video. Publishing the release (step 9)
reaches every installed app through the updater, so that click is the owner's.

## On an Obeya card

### Before the handover: steps 1–4

**Step 1, where things stand.** Of what the status script puts in the way, GitHub's `main` lagging
is what step 5 fixes. Everything else is the owner's call (`ask`, with what you would do):
`site-media` as the latest release, a missing secret, GitHub's `main` with commits of its own, a
tag already taken, a draft left over. Take the version it proposes. Sum the release up in a few
lines, by what the owner and the users notice, grouped, not commit by commit.

**Step 2, the narration.** Read `narration.ts` scene by scene with `demo.ts` beside it, against
today's UI: `src/ui/strings.ts`, the parts of the UI the scenes show, and the UI commits since the
video went up (`git log --since=<its date> -- src/ui`). `HERO_SHORT=1 node
scripts/hero-video/render.ts` shows the scenes up to Obeya's sidebar in a few minutes; an unchanged
narration costs no credits there. A sentence that names a button, a label or a gesture the UI no
longer has, or tells a step the way it no longer goes, gets reworded, as close to the old wording
as it can stay.
- Sentences changed: one `ask` with the version, the summary and each changed sentence old and
  new. Render after the answer; credits go only on the wording the owner OKed.
- None changed: no question. Version and summary go into the handover.

**Step 3, the video.** If port 4730 is taken, another render is running: wait for it in the
background. The render records its agents (`--record`) and takes about ten minutes; run it in the
background too. Then look at every still in `review/`. Besides the README's three failures, check
that each card the narration names is in the picture and that the UI looks as it does today,
without a stray dialog or an error. A fault in the scenes is fixed in `demo.ts` or `stage.ts`
(committed with the release) and rendered again with the recording played back (`--replay`), in a
few minutes; the clips are cached, so that costs no credits. The agent's run differs each time it
is recorded: a run that went wrong (the Tipjar agent stuck, a demo that shows nothing) is recorded
again as it is, as is one whose playback refuses. If the same fault comes back after two renders,
ask. Then the screenshots, the poster and the copy; look at the new screenshots (`git diff --stat
site/img`, then the pictures themselves, the two phone screens `phone.png` and `phone-demo.png`
among them) before committing them.

**Step 4, the handover.** Commit the version, README, poster and screenshots, run the checks, and
hand over with `ready_for_review`. The demo is the new hero video: the directory
`<demos>/obeya-v<version>/` (`<demos>`: the demo directory, `~/demos` unless the demo settings name
another), its chapters the titles in `chapters.vtt`, in order. The summary holds the version, what
is in it, the sentences the narration changed, what the README now names, and what follows the
approval: push, tag, build, draft, video on the site, and the owner publishing.

### After the landing: steps 5–9

Landing the version restarts Obeya. Call `after_restart` and end the turn; go on once Obeya says
it runs your change.

**Steps 5 and 6.** Push `main`, then tag its tip, not your workspace's `HEAD`, so what landed
since goes out too; check first that `package.json` there has the version. Then push the tag.

**Step 7, the build.** Watch the run in the background and end the turn. When it fails, read the
failed steps (`bun scripts/gh.ts run view <id> --log-failed`); a job that failed on something
flaky runs again with `bun scripts/gh.ts run rerun <id> --failed`. An HTTP 403 from Apple
needs the owner's acceptance of Apple's agreement: `ask`. A fault in the code goes to
`propose_card`; the release waits for it. Once the draft check passes, read the notes as a user
of the app will: a line that makes no sense to them is worth mentioning in step 9.

**Step 8, the video.** Upload the copy in `<demos>/obeya-v<version>/`.

**Step 9, the owner publishes.** `ask` with the link to the draft
(`https://github.com/sadilek/obeya/releases`), a line on the notes, and the options "Published"
and "Not now". After "Published", run the status script again: the new version is the latest
release, and `https://github.com/sadilek/obeya/releases/latest/download/latest.json` names it.
Then end.

## In a terminal

The same steps, with the owner in the chat instead of on a card. The version commit goes onto
`main` directly. Instead of the handover, give the owner the path of the video
(`<demos>/obeya-v<version>/demo.mp4`) with the summary, and go on to step 5 when they say so.
