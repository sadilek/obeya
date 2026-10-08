// The hero video for obeya.si, recorded with Obeya's own demo pipeline (`plugin/skills/demo`): a
// scratch Obeya with Tipjar, a small tip calculator, and a real worker. An idea said into the
// microphone becomes a task, the agent builds it and records its demo, the owner approves. Run it
// through `render.ts`, which sets the voice; the README says how. The microphone is a WAV played
// into a fake stream: the narration clip of the scene that speaks the command, so what the viewer
// hears is what Obeya hears.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDemo, type Director, type Scene } from '../../plugin/skills/demo/lib/director.ts';
import { narration } from './narration.ts';
import { PORT, writeStage } from './stage.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
/** Where the video, its stills and the work files go: outside the repository. */
const OUT = process.env.HERO_OUT ?? path.join(os.homedir(), 'demos', 'obeya-hero');
const base = `http://127.0.0.1:${PORT}`;

function stage() {
  const file = path.join(OUT, 'stage.json');
  writeStage(file);
  // HERO_SHORT: the first two scenes only, without agents, to check the opening and the microphone
  execFileSync('bun', [path.join(ROOT, 'scripts/scratch-obeya.ts'), file, ...(process.env.HERO_SHORT ? [] : ['--real-workers'])], {
    env: { ...process.env, OBEYA_HOME: undefined },
  });
  // the worker's own demo: English, a quick voice (the hero video has no page audio)
  fs.writeFileSync(`/tmp/obeya-scratch-${PORT}/home/demo.json`, JSON.stringify({ language: 'en', voice: 'say', voiceName: 'Samantha', listenBack: false }));
  execFileSync('curl', ['-s', '-X', 'PUT', `${base}/api/language`, '-d', '{"language":"en"}']);
  // Whisper and the Koordinator loaded before the take, so the spoken command is heard at once
  execFileSync('curl', ['-s', '-X', 'POST', `${base}/api/c/tipjar/voice/warm`]);
  execFileSync('sleep', ['20']);
}

/** The spoken command: the narration clip of the scene that says it, else (a dry run) one from `say`. */
function commandWav() {
  try {
    const tts = JSON.parse(fs.readFileSync(path.join(OUT, '.work', 'tts.json'), 'utf8')) as { clips: { id: string; file: string }[] };
    const clip = tts.clips.find((c) => c.id === 's2');
    if (clip && fs.existsSync(clip.file)) return clip.file;
  } catch {}
  const wav = path.join(OUT, 'command-say.wav');
  if (!fs.existsSync(wav)) execFileSync('say', ['-v', 'Samantha', '-o', wav, '--data-format=LEI16@22050', narration.command]);
  return wav;
}

const card = (d: Director, title: RegExp | string) => d.page.locator('.card', { hasText: title }).first();
const split = (d: Director) => card(d, 'Split the bill');

/** The card of the task the video creates, as the API has it. */
async function created() {
  const snap = (await (await fetch(`${base}/api/c/tipjar/canvas`)).json()) as { items: { title: string; state: string; statusLine?: string }[] };
  return snap.items.find((x) => /split the bill/i.test(x.title));
}

/** Until the agent hands over: the card waits for the owner (25 min at most). */
async function waitForHandover() {
  const until = Date.now() + 25 * 60_000;
  while (Date.now() < until) {
    if ((await created())?.state === 'waiting') return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('the agent did not hand over within 25 minutes');
}

/** Until the agent has reported a status line, or a minute has passed: it does not always report one. */
async function statusLine() {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if ((await created())?.statusLine) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Holds Space while the command plays into the microphone, exactly when the narration track plays it. */
async function speak(d: Director) {
  await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await d.page.keyboard.down('Space');
  await d.untilSpoken(0);
  const seconds = await d.page.evaluate(() => (window as unknown as { __play: () => Promise<number> }).__play());
  await d.wait(seconds * 1000 + 250);
  await d.page.keyboard.up('Space');
}

/** Pans the canvas by (dx, dy) screen pixels in small steps, as a trackpad would. */
async function pan(d: Director, dx: number, dy: number, steps = 30) {
  for (let i = 0; i < steps; i++) {
    await d.page.mouse.wheel(-dx / steps, -dy / steps);
    await d.wait(16);
  }
}

const scenes: Scene[] = [
  {
    title: 'One canvas',
    say: narration.canvas,
    run: async (d) => {
      await d.untilSpoken(0.28);
      await d.highlight(d.page.locator('.item.project').first(), 'project');
      await d.untilSpoken(0.56);
      await d.clearHighlights();
      await d.highlight(card(d, 'Run the tests'), 'working');
      await d.untilSpoken(0.7);
      await d.clearHighlights();
      // one ring at a time: the pipeline dims around the first ring only
      await d.highlight(card(d, 'App icon'), 'needs you');
      await d.untilSpoken(0.85);
      await d.clearHighlights();
    },
  },
  {
    title: 'An idea, by voice',
    say: narration.command,
    run: async (d) => {
      await speak(d);
      await d.untilSpoken(1);
      // Whisper and the Koordinator take some seconds: the wait is cut when it is long
      await d.skip(() => d.page.locator('#acks').getByText(/New task/).first().waitFor({ timeout: 90_000 }));
    },
  },
  {
    title: 'The agent starts',
    say: narration.starts,
    run: async (d) => {
      const ack = d.page.locator('#acks');
      await ack.getByText(/New task/).first().waitFor({ timeout: 60_000 });
      await d.highlight(ack, 'confirmation');
      await d.untilSpoken(0.22);
      // cleared before the camera flies to the new card, marked once it stands: a ring cleared
      // during the flight flashed the page
      await d.clearHighlights();
      await split(d).waitFor({ timeout: 60_000 });
      await d.wait(1200);
      await d.highlight(split(d), 'new task');
      // the Koordinator mostly starts a new task by itself; a planned one is started by a click
      await d.wait(1500);
      if (await split(d).getByText(/^Planned$/).isVisible()) {
        // the play button shows while the pointer is on the card
        await split(d).hover();
        await d.wait(500);
        await d.click(split(d).getByRole('button', { name: 'Start agent' }));
      }
      await d.untilSpoken(1);
      await d.skip(() => split(d).getByText(/Agent at work/i).first().waitFor({ timeout: 90_000 }));
      await d.clearHighlights();
      // until the agent has a few steps behind it to show
      await d.skip(async () => {
        await statusLine();
        await d.wait(1000);
      });
    },
  },
  {
    title: 'The agent at work',
    say: narration.working,
    run: async (d) => {
      await d.click(split(d));
      await d.wait(1500);
      await d.untilSpoken(1);
      await d.page.keyboard.press('Escape');
      await d.skip(async () => {
        await waitForHandover();
        await d.wait(1500);
      });
    },
  },
  {
    title: 'Its demo',
    say: narration.demo,
    run: async (d) => {
      await d.click(split(d));
      await d.untilSpoken(0.5);
      await d.highlight(d.page.locator('.talk.conv').first(), 'report');
      await d.untilSpoken(0.7);
      await d.clearHighlights();
      await d.untilSpoken(1);
    },
  },
  {
    title: 'Approval',
    say: narration.approval,
    run: async (d) => {
      await d.click(d.page.getByRole('button', { name: /^Approve/ }).first());
      await d.wait(2500);
      await d.untilSpoken(1);
    },
  },
  {
    title: 'Proposals and ideas',
    say: narration.proposals,
    run: async (d) => {
      // the camera stands on the new card at the right; the proposal is off to the left
      await d.page.mouse.move(900, 450);
      await pan(d, 380, -60);
      await d.page.mouse.move(1380, 600);
      await d.highlight(card(d, 'Remember the last tip'), 'proposal');
      await d.untilSpoken(0.36);
      await d.clearHighlights();
      await d.highlight(card(d, 'Settle up after a trip'), 'idea');
      await d.untilSpoken(0.74);
      await d.clearHighlights();
      await d.highlight(card(d, 'Settle up after a trip').getByText(/as a project/), 'suggested next step');
      await d.untilSpoken(1);
      await d.clearHighlights();
    },
  },
  {
    title: 'The big room',
    say: narration.room,
    run: async (d) => {
      await d.highlight(split(d), 'on main');
      await d.untilSpoken(0.25);
      await d.clearHighlights();
      await d.untilSpoken(1);
    },
  },
];

await runDemo(
  {
    title: 'Obeya',
    baseUrl: `${base}/`,
    login: async () => {
      stage();
    },
    open: async (d) => {
      const wav = commandWav();
      await d.page.route('**/__demo/command.wav', (r) => r.fulfill({ path: wav }));
      await d.page.addInitScript(() => {
        let ctx: AudioContext | undefined;
        let dest: MediaStreamAudioDestinationNode | undefined;
        navigator.mediaDevices.getUserMedia = async () => {
          ctx ??= new AudioContext();
          dest ??= ctx.createMediaStreamDestination();
          return dest.stream;
        };
        // decoded before the take, so the command starts the moment the narration does
        let buf: AudioBuffer | undefined;
        (window as unknown as { __load: (u: string) => Promise<void> }).__load = async (url: string) => {
          ctx ??= new AudioContext();
          dest ??= ctx.createMediaStreamDestination();
          buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        };
        (window as unknown as { __play: () => Promise<number> }).__play = async () => {
          await ctx!.resume();
          const src = ctx!.createBufferSource();
          src.buffer = buf!;
          src.connect(dest!);
          src.start();
          return buf!.duration;
        };
      });
      await d.goto('/?c=tipjar');
      await d.page.addStyleTag({ content: 'bun-hmr { display: none !important; }' });
      await d.page.evaluate(() => (window as unknown as { __load: (u: string) => Promise<void> }).__load('/__demo/command.wav'));
      await card(d, 'App icon').waitFor();
      await d.wait(1200);
    },
    scenes: scenes.slice(0, process.env.HERO_SHORT ? 2 : undefined),
    report: {
      summary:
        'The hero video for obeya.si: on a scratch canvas with the example app Tipjar, an idea said into the microphone becomes a task, a real agent builds it and records its demo, and the approval lands the change on main.',
      shown: ['Canvas with a project and tasks', 'An idea by voice', 'The agent at work', 'Its demo on the card', 'Approval', 'Proposals and ideas'],
      notShown: [],
      findings: [],
      meta: { Stack: `Scratch Obeya on port ${PORT} from this checkout, a real worker, the Koordinator and Whisper real` },
    },
  },
  OUT,
);
