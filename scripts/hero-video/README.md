# The hero video for obeya.si

A real run, recorded with Obeya's own demo pipeline (`plugin/skills/demo`): a scratch Obeya on a
small tip calculator, the wall arranged (a lasso into a group, a card dragged beside another
group), an idea said into the microphone, a bug report typed, pasted and spoken in Obeya's sidebar,
a real agent building the idea and recording its demo, two comments said into that video and the
agent's new demo on them, the approval landing it on main, proposals from an agent and from Obeya's
work retrospective, an idea discussed with its agent, and the phone view of the same wall in a
phone's frame. About four and a half minutes, in English, in the owner's ElevenLabs voice,
recorded at twice the pixels (2880×1800, as the app looks on a Retina screen) with gentle
compression (`sharp` in the spec).

- `narration.ts`: what the video says, scene by scene. Review it as text before rendering.
- `demo.ts`: the scenes, what each shows while its narration plays.
- `stage.ts`: the canvas it starts on (cards, their states and places); the repository is `tipjar/`.
- `tipjar/`: the example app, with its own settings (work lands on main, how its app runs) and a
  plan doc.
- `render.ts`: renders in the owner's ElevenLabs voice (`eleven_v4`, which reads the audio tags in
  square brackets), with the key from `.voice/elevenlabs.key` of the main checkout (gitignored);
  with `--qwen` in the owner's voice cloned by Qwen3-TTS, which costs no credits.

Every release renders it again and puts it out with the release (`docs/release.md` § "A release",
which the project skill `.claude/skills/release/` goes through).

## Render

```sh
node scripts/hero-video/render.ts --narration   # only the narration: costs ElevenLabs credits for changed sentences
HERO_SHORT=1 node scripts/hero-video/render.ts  # the scenes up to Obeya’s sidebar and its preferences, without agents, in a few minutes
node scripts/hero-video/render.ts               # the whole video, with real agents: about ten minutes
node scripts/hero-video/render.ts --record      # the same, with the agents recorded into ~/demos/obeya-hero-recording/ (or the directory after it)
node scripts/hero-video/render.ts --replay      # the whole video with that recording's agents played back: the same run, in minutes
node scripts/hero-video/render.ts --qwen        # any of these in Qwen3-TTS, into ~/demos/obeya-hero-qwen/: to try a change out first
```

Before a take starts, the render measures the machine for five seconds and does not start when it
is short of memory (macOS reports memory pressure, or it swaps more than 10 MB a second) or when
more than 90% of its cores are in use; it says why, names the processes using the most memory or
CPU, and exits with 3. `--ignore-load` renders anyway; `--check-load` only measures. A take
recorded beside local language models stuttered. Measured on an M4 Pro (48 GB): the screencast
kept its frame rate with every core busy and with the GPU at 99%, so it is memory short enough to
swap that stalls the take, and a busy CPU counts only near saturation. The narration alone
(`--narration`) and a dry run are not measured. A second render while one runs is refused too: both
use the scratch Obeya on port 4730, and the second would stop the first's.

A change is tried out with `--qwen` (with `HERO_SHORT=1` for the first scenes) and rendered in
ElevenLabs once it stands.

The render that goes out with a release is a real run, recorded (`--record`). Corrections after it
(a scene, the layout, the narration's timing) play that recording back (`--replay`): every agent,
the Coordinator's included, does what it did in the recorded run, through the Obeya of the checkout,
whose cards, layout, held comments and landing are live. The playback takes a few minutes, costs no
Claude usage and comes out the same each time, so a recorded run can also be chosen for how its
agents did (one whose first demo leaves the bold line to the comment, say). It refuses, and the
render stops with why, once the agents' instructions or Obeya's tools have changed since the
recording; a changed sentence the agents hear (the spoken command, the dictation, the comments) needs
a recorded run too, since the recorded agents act on the old words. Then record anew.

The output goes to `obeya-hero/` in the demo directory (`~/demos` unless the demo settings name
another; `HERO_OUT` names another output): `demo.mp4`, `captions.vtt`, `chapters.vtt` (the scenes,
which the site lists under the video), `review/` with a still from the middle and the end of each scene, and `index.html`. Clips are
cached by voice and text, so a re-render after a visual change costs no credits. The scratch
Obeya runs on port 4730; `bun scripts/scratch-obeya.ts --stop 4730` ends it, which the render
leaves running for a look.

Before it goes out, look at the stills and at three things that went wrong before: the microphone
lights with the spoken command, not seconds after it; a ring never dims the card it marks; no card
the narration names is outside the picture. The agent's run differs each time it is recorded (how
long it takes, its status lines, whether it proposes a card of its own), so the narration says
nothing that only holds for one run.

## Publish

The video is not in git. It is an asset of the GitHub release `site-media`, which the Pages
workflow fetches into `site/media/` before it publishes. One call puts a render out:

```sh
node scripts/hero-video/publish.ts            # uploads demo.mp4, captions.vtt and chapters.vtt as hero.mp4, hero.vtt and hero.chapters.vtt, with the README's loop hero.loop.gif cut from the video, then runs the Pages workflow
node scripts/hero-video/publish.ts --poster   # also takes the poster again from the new video
node scripts/hero-video/publish.ts --poster-only  # only takes the poster; uploads nothing (a release, before its approval)
```

It reads the render from `~/demos/obeya-hero/` (or `HERO_OUT`), creates the release the first
time (a pre-release, so that it never becomes the latest release, whose installers the README
links) and replaces its assets after that, and acts as the GitHub account `sadilek` (with the
token of its gh login) without switching the account gh has active.

The poster (`site/img/hero-poster.jpg`) is the video's first frame, slightly dimmed, without a
play button: the big play button over it is a `<button>` in `site/index.html`, whose script
starts the video (without JavaScript the browser's controls do). The poster is in git: when the
opening changes, publish with `--poster`, then commit it and push `main`, which publishes it.

GitHub plays no video in a README, so the repository's README plays a GIF of the canvas at work,
`hero.loop.gif`, linked to the video on obeya.si. `publish.ts` cuts it from the video by the titles
of two scenes (`LOOP` there: rename them when the scenes are renamed).
