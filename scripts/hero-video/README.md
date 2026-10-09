# The hero video for obeya.si

A real run, recorded with Obeya's own demo pipeline (`plugin/skills/demo`): a scratch Obeya on a
small tip calculator, an idea said into the microphone, a real agent building it and recording its
demo, the approval landing it on main. About two minutes, in English, in the owner's ElevenLabs voice.

- `narration.ts`: what the video says, scene by scene. Review it as text before rendering.
- `demo.ts`: the scenes, what each shows while its narration plays.
- `stage.ts`: the canvas it starts on (cards, their states and places); the repository is `tipjar/`.
- `tipjar/`: the example app, with its own adapter (work lands on main, every change gets a demo)
  and a plan doc.
- `render.ts`: renders in the owner's ElevenLabs voice (`eleven_v4`, which reads the audio tags in
  square brackets), with the key from `.voice/elevenlabs.key` of the main checkout (gitignored).

## Render

```sh
node scripts/hero-video/render.ts --narration   # only the narration: costs ElevenLabs credits for changed sentences
HERO_SHORT=1 node scripts/hero-video/render.ts  # the first two scenes, without agents: the opening and the microphone, in a minute
node scripts/hero-video/render.ts               # the whole video, with a real agent: about ten minutes
```

The output goes to `~/demos/obeya-hero/` (`HERO_OUT` names another): `demo.mp4`, `captions.vtt`,
`review/` with a still from the middle and the end of each scene, and `index.html`. Clips are
cached by voice and text, so a re-render after a visual change costs no credits. The scratch
Obeya runs on port 4730; `bun scripts/scratch-obeya.ts --stop 4730` ends it, which the render
leaves running for a look.

Before it goes out, look at the stills and at three things that went wrong before: the microphone
lights with the spoken command, not seconds after it; a ring never dims the card it marks; no card
the narration names is outside the picture. The agent's run differs each time (how long it takes,
its status lines, whether it proposes a card of its own), so the narration says nothing that only
holds for one run.

## Publish

The video is not in git. It is an asset of the GitHub release `site-media`, which the Pages
workflow fetches into `site/media/` before it publishes. One call puts a render out:

```sh
node scripts/hero-video/publish.ts            # uploads demo.mp4 and captions.vtt as hero.mp4 and hero.vtt, then runs the Pages workflow
node scripts/hero-video/publish.ts --poster   # also takes the poster again from the new video
```

It reads the render from `~/demos/obeya-hero/` (or `HERO_OUT`), creates the release the first
time (a pre-release, so that it never becomes the latest release, whose installers the README
links) and replaces its assets after that, and acts as the GitHub account `sadilek` (with the
token of its gh login) without switching the account gh has active.

The poster (`site/img/hero-poster.jpg`) is the video's first frame, slightly dimmed, without a
play button: the big play button over it is a `<button>` in `site/index.html`, whose script
starts the video (without JavaScript the browser's controls do). The poster is in git: when the
opening changes, publish with `--poster`, then commit the new poster and push `main`, which
publishes it.
