// Records a narrated feature demo: a scripted walk through the running app, spoken in the voice the
// demo settings name (`settings.ts`), rendered as an MP4 with chapters and captions, plus a
// one-page report beside it.
//
// A demo file default-exports nothing; it calls `runDemo(spec, import.meta.dirname)` and is run
// with plain `node demo.ts`. Everything lands in the demo file's directory. `node demo.ts --dry`
// only plays the scenes against the app, to find a scene that fails before a render does.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { type NarrationLanguage, readDemoSettings, withVoice } from './settings.ts';
import { checkSetup, describeSetup, whisperKit } from './setup.ts';
import { CLOCK, type Cut, type Frame, frameDurations, laterLabel, onPaintTime, readClock, videoTime } from './timeline.ts';
import { TTS_LOCK, voiceSpec } from './voices.ts';

export interface Scene {
  /** Chapter title in the player. */
  title: string;
  /** Spoken while `run` executes, in the narration language, written as it should sound. */
  say: string;
  run?: (d: Director) => Promise<void>;
}

export interface Report {
  /** What the change does, for someone who has not seen it: two to four sentences. */
  summary: string;
  /** Behaviours the video shows. */
  shown: string[];
  /** Behaviours the change has that the video does not show, each with why. */
  notShown: string[];
  /** Anything the demo surfaced that the director should know: oddities, rough edges. */
  findings: string[];
  /**
   * A question only the director can answer — a trade-off, a wording choice, what to do about a
   * finding. Omitted when the only ask is the usual "release or give feedback".
   */
  question?: string;
  /** Provenance lines: commit, stack, data. */
  meta: Record<string, string>;
}

export interface DemoSpec {
  title: string;
  baseUrl: string;
  viewport?: { width: number; height: number };
  /** Runs once in an unrecorded context; its cookies and storage carry into the recording. */
  login?: (page: Page) => Promise<void>;
  /** Brings the recorded page to the opening shot. Not part of the video. */
  open: (d: Director) => Promise<void>;
  scenes: Scene[];
  report: Report;
}

/** Narration starts this long after its scene, so the eye lands before the voice does. */
const LEAD_SECONDS = 0.35;
/** Silence after a scene's narration before the next one starts. */
const GAP_SECONDS = 0.6;
/** Below this word-level match, the spoken clip likely dropped or invented something. */
const TTS_MATCH_WARN = 0.85;
/** Below this, the sentence is worth rephrasing: the voice or Whisper stumbled over it. */
const NARRATION_OK = 0.93;
/** A scene this much longer than its narration and gap has a stretch worth cutting (`Director.skip`). */
const SILENCE_WARN = 5;
/** A wait shorter than this stays in the video rather than being cut (`Director.skip`). */
const MIN_CUT_SECONDS = 5;
const SAVED = readDemoSettings();
/** The settings of this render: `DEMO_VOICE` names another provider, or a `.wav` to clone. */
const SETTINGS = withVoice(SAVED, process.env.DEMO_VOICE);
const LANGUAGE: NarrationLanguage = SETTINGS.language;
const LIB = import.meta.dirname;

interface Clip {
  id: string;
  file: string;
  seconds: number;
  /** `null` when the clip was not heard back. */
  heard: string | null;
  match: number | null;
}

interface Narration {
  clips: Clip[];
  /** Why some clips went unheard: Whisper off in the settings, or not loadable. */
  unchecked: string | null;
  /** How the clips were heard back, for the report. */
  heardWith: string;
  /** Listening back is off in the settings, so `unchecked` is no failure. */
  turnedOff: boolean;
}

export class Director {
  readonly page: Page;
  readonly baseUrl: string;
  readonly workDir: string;
  /** A dry run (`--dry`) has no narration, so `untilSpoken` does not wait. */
  readonly #paced: boolean;
  #sceneStart = 0;
  #sceneSpeech = 0;
  /** Stretches `skip` cut out (two per jump: before and after its fade), and how much of them fell into the current scene. */
  readonly cuts: Cut[] = [];
  #skippedInScene = 0;

  // No parameter properties: Node runs this file by type stripping, which does not transform them.
  constructor(page: Page, baseUrl: string, workDir: string, paced = true) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.workDir = workDir;
    this.#paced = paced;
  }

  async goto(url: string) {
    await this.page.goto(new URL(url, this.baseUrl).toString());
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  wait(ms: number) {
    return this.page.waitForTimeout(ms);
  }

  /** Waits until `fraction` of this scene's narration has been spoken. */
  async untilSpoken(fraction = 1) {
    if (!this.#paced) return;
    // A cut stops the clock of the video, not of the narration: what was cut is added on.
    const due = this.#sceneStart + LEAD_SECONDS + this.#sceneSpeech * fraction + this.#skippedInScene;
    const left = due - now();
    if (left > 0) await this.wait(left * 1000);
  }

  /**
   * Runs `fn`, a wait in which nothing worth watching happens (an agent at work, a build), and
   * cuts it from the video: the picture fades to white, says how much later it is, and fades back.
   * A wait shorter than `MIN_CUT_SECONDS` stays in the video: the flash would disturb more than
   * the wait. The narration goes on across the cut, so call it after `untilSpoken(1)`.
   */
  async skip(fn: () => Promise<void>) {
    if (!this.#paced) return fn();
    const from = now();
    const done = fn().then(() => true);
    if (await Promise.race([done, this.wait(MIN_CUT_SECONDS * 1000).then(() => false)])) return;
    // Long enough: what was waited so far goes without a trace, the rest falls into the white.
    const fadeFrom = now();
    await this.page.evaluate(() => window.__demo.whiteOut());
    await this.wait(300);
    const cutFrom = now();
    await done;
    const to = now();
    this.cuts.push({ from, to: fadeFrom }, { from: cutFrom, to });
    this.#skippedInScene += fadeFrom - from + to - cutFrom;
    await this.page.evaluate((l) => window.__demo.timeJump(l), laterLabel(to - from, LANGUAGE));
    await this.wait(1100);
    await this.page.evaluate(() => window.__demo.whiteIn());
    await this.wait(450);
  }

  async pointAt(target: Locator) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`cannot point at an invisible element: ${target}`);
    await this.page.evaluate(
      ([x, y]) => window.__demo.moveTo(x, y),
      [box.x + Math.min(box.width / 2, 60), box.y + box.height / 2],
    );
    await this.wait(750);
  }

  async click(target: Locator) {
    await this.pointAt(target);
    await this.page.evaluate(() => window.__demo.ripple());
    await target.click();
    await this.wait(350);
  }

  /** Clears the field and types `text` at a readable pace. */
  async type(target: Locator, text: string) {
    await this.click(target);
    await target.press('ControlOrMeta+a');
    await target.press('Backspace');
    await target.pressSequentially(text, { delay: 110 });
  }

  /** Drags `from` onto `to` (an element's centre or a point), the pointer moving with the mouse. */
  async drag(from: Locator, to: Locator | { x: number; y: number }, ms = 1200) {
    await this.pointAt(from);
    const a = await center(from);
    const b = 'x' in to ? to : await center(to);
    const mouse = this.page.mouse;
    await mouse.move(a.x, a.y);
    await mouse.down();
    const steps = Math.max(10, Math.round(ms / 40));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const x = a.x + (b.x - a.x) * e;
      const y = a.y + (b.y - a.y) * e;
      await mouse.move(x, y);
      await this.page.evaluate(([px, py]) => window.__demo.moveTo(px, py, true), [x, y]);
      await this.wait(ms / steps);
    }
    await mouse.up();
    await this.wait(350);
  }

  async scrollTo(target: Locator, block: 'start' | 'center' | 'end' = 'center') {
    await target.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block);
    await this.wait(900);
  }

  /** Rings one or more elements; the rings follow scrolling and last until the next scene. */
  async highlight(targets: Locator | Locator[], label?: string) {
    const handles = [];
    for (const t of [targets].flat()) handles.push(await t.elementHandle());
    await this.page.evaluate(([els, l]) => window.__demo.highlight(els, l), [handles, label] as const);
    await this.wait(400);
  }

  clearHighlights() {
    return this.page.evaluate(() => window.__demo.clearHighlights());
  }

  /** Shows an image over the page, scrolled so that `top` (0..1 of its height) is at the top. */
  async showImage(file: string, top = 0, caption?: string) {
    const src = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    await this.page.evaluate(([s, t, c]) => window.__demo.showImage(s, t, c), [src, top, caption] as const);
    await this.wait(600);
  }

  async panImage(top: number) {
    await this.page.evaluate((t) => window.__demo.panImage(t), top);
    await this.wait(1300);
  }

  hideImage() {
    return this.page.evaluate(() => window.__demo.hideImage());
  }

  /**
   * Clicks a control that produces a PDF and returns its pages as PNG files. The PDF is taken from
   * the network response, not from the tab it opens in: apps often open an empty tab first and
   * point it at the PDF only once the request is done.
   */
  async pdfFrom(target: Locator, name: string): Promise<string[]> {
    const responsePromise = this.page.context().waitForEvent('response', {
      predicate: (r) => (r.headers()['content-type'] ?? '').includes('application/pdf'),
      timeout: 60_000,
    });
    const popups: Page[] = [];
    const onPopup = (p: Page) => popups.push(p);
    this.page.on('popup', onPopup);
    await this.click(target);
    const response = await responsePromise;
    const bytes = await response.body();
    this.page.off('popup', onPopup);
    for (const p of popups) await p.close().catch(() => {});
    await this.page.bringToFront();
    const pdf = path.join(this.workDir, `${name}.pdf`);
    fs.writeFileSync(pdf, bytes);
    run('pdftoppm', ['-r', '130', '-png', pdf, path.join(this.workDir, name)]);
    return fs
      .readdirSync(this.workDir)
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.png'))
      .sort()
      .map((f) => path.join(this.workDir, f));
  }

  beginScene(speechSeconds: number) {
    this.#sceneStart = now();
    this.#sceneSpeech = speechSeconds;
    this.#skippedInScene = 0;
    return this.#sceneStart;
  }
}

declare global {
  interface Window {
    // Defined by overlay.js.
    // biome-ignore lint: the overlay is untyped browser script
    __demo: any;
  }
}

async function center(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error(`cannot drag an invisible element: ${target}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function now() {
  return Date.now() / 1000;
}

/**
 * One render per demo at a time: two renders of the same demo (one left running in the background)
 * write the same frames and, through the demo's `login`, reset each other's app.
 */
function holdRenderLock(work: string) {
  const file = path.join(work, 'render.pid');
  const other = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  if (other && other !== process.pid && alive(other))
    throw new Error(`another render of this demo is running (pid ${other}); wait for it, or end it with \`kill ${other}\``);
  fs.writeFileSync(file, String(process.pid));
  process.on('exit', () => {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file);
  });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}):\n${r.stderr?.slice(-3000)}`);
  return r.stdout;
}

/**
 * Whisper for listening back, in a throwaway environment uv makes: mlx-whisper on Apple Silicon,
 * faster-whisper elsewhere (CUDA when there is a GPU, else the CPU). Off in the settings, or when
 * uv cannot get it (offline, no wheel for this machine), the clips go unheard and the report says so.
 */
function whisper(): { backend: 'mlx' | 'faster' | 'off'; uvArgs: string[]; unchecked?: string } {
  if (SETTINGS.listenBack === false) return { backend: 'off', uvArgs: [] };
  const { backend, uvArgs, module: probe } = whisperKit();
  const r = spawnSync('uv', ['run', '--quiet', '--no-project', ...uvArgs, 'python', '-c', `import ${probe}`], { encoding: 'utf8' });
  if (r.status === 0) return { backend, uvArgs };
  const why = (r.error?.message ?? r.stderr ?? '').trim().split('\n').at(-1);
  return { backend: 'off', uvArgs: [], unchecked: `${probe.replace('_', '-')} could not be loaded: ${why}` };
}

function synthesize(scenes: Scene[], dir: string): Narration {
  const jobs = scenes.map((s, i) => ({ id: `s${i + 1}`, text: s.say }));
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const spec = voiceSpec(SETTINGS);
  const specFile = path.join(dir, 'voice.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const ear = whisper();
  if (ear.unchecked) console.warn(`narration: not listening back, ${ear.unchecked}`);
  console.log(`narration: ${jobs.length} clips, voice ${SETTINGS.voice}, language ${LANGUAGE}, listening back ${ear.backend === 'off' ? 'off' : `with ${ear.backend === 'mlx' ? 'mlx-whisper' : 'faster-whisper'}`}`);
  // A voice that loads a large model takes the machine's turn (TTS_LOCK); a hosted or light one
  // does not, so rate-limit waits never hold up a clone.
  const lock = spec.kind === 'command' && spec.heavy ? ['--lock', TTS_LOCK] : [];
  const args = ['run', '--quiet', '--no-project', ...ear.uvArgs, 'python', path.join(LIB, 'tts.py'), '--listen', ear.backend, ...lock, specFile, LANGUAGE, jobsFile, dir];
  // tts.py's progress (takes, matches, waiting for the lock) shows as it happens.
  const r = spawnSync('uv', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`tts.py failed (${r.error?.message ?? r.status}); its output is above`);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'tts.json'), 'utf8')) as Pick<Narration, 'clips' | 'unchecked'>;
  // tts.py only knows it got `--listen off`; why (settings, or Whisper not loadable) is known here.
  const unheard = out.clips.some((c) => c.heard === null);
  const unchecked = unheard ? (ear.unchecked ?? out.unchecked ?? 'not heard back') : null;
  const heardWith = ear.backend === 'mlx' ? 'mlx-whisper' : 'faster-whisper';
  return { clips: out.clips, unchecked, heardWith, turnedOff: SETTINGS.listenBack === false };
}

/**
 * Headless Chrome with its window the size of the viewport: in a window of another size the
 * screencast captured only the top 813 of 900 pixels.
 */
async function launch(viewport: { width: number; height: number }) {
  const args = [`--window-size=${viewport.width},${viewport.height}`];
  if (process.env.DEMO_CHROME) return chromium.launch({ executablePath: process.env.DEMO_CHROME, args });
  // Chrome where it is installed, else Edge (on every Windows), else Playwright's own Chromium
  // (on Linux on ARM, where there is no Chrome).
  const missing: string[] = [];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch({ channel, args });
    } catch (error) {
      const message = String((error as Error).message);
      if (!/is not found at|Executable doesn't exist|not supported on/i.test(message)) throw error;
      missing.push(channel ?? 'chromium');
    }
  }
  throw new Error(
    `no browser to record with (tried ${missing.join(', ')}): install Google Chrome, or run \`npx playwright-core install chromium\` in ${LIB}, or set DEMO_CHROME to a Chromium-based browser`,
  );
}

/**
 * For looking at the app before writing the scenes: opens `url` in the demo's browser and viewport,
 * runs `fn` and closes. Run it from a file in the demo directory (`node explore.ts`); importing this
 * module is what resolves Playwright.
 */
export async function explore(url: string, fn: (page: Page) => Promise<void>, viewport = { width: 1440, height: 900 }) {
  const browser = await launch(viewport);
  try {
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1 })).newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle').catch(() => {});
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function login(spec: DemoSpec, dir: string) {
  const stateFile = path.join(dir, 'state.json');
  if (!spec.login) return undefined;
  const browser = await launch(spec.viewport!);
  const ctx = await browser.newContext({ viewport: spec.viewport });
  const page = await ctx.newPage();
  try {
    await spec.login(page);
  } catch (error) {
    throw await failure('login', page, dir, error);
  }
  await ctx.storageState({ path: stateFile });
  await browser.close();
  return stateFile;
}

/**
 * The error for a step of the demo that failed: which step, the page's URL, a screenshot of it and
 * the cause, each on its own line, so the screenshot's path is not taken for the page's address.
 */
async function failure(step: string, page: Page, dir: string, error: unknown) {
  const shot = path.join(dir, 'failure.png');
  const captured = await page.screenshot({ path: shot }).then(
    () => true,
    () => false,
  );
  await page.context().browser()?.close().catch(() => {});
  // Playwright's message names the call and the locator it waited for; its colours are noise here.
  const cause = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, '').trim();
  const lines = [
    `${step} failed`,
    `  URL: ${page.url()}`,
    `  Screenshot: ${captured ? shot : 'none (the page could not be captured)'}`,
    `  Cause: ${cause.split('\n').join('\n    ')}`,
  ];
  return new Error(lines.join('\n'), { cause: error });
}

function sceneName(i: number, spec: DemoSpec) {
  return `scene ${i + 1}/${spec.scenes.length} "${spec.scenes[i]!.title}"`;
}

/** The recording browser, with the overlay, on the opening shot. */
async function openPage(spec: DemoSpec, viewport: { width: number; height: number }, work: string, paced: boolean) {
  const storageState = await login({ ...spec, viewport }, work);
  const browser = await launch(viewport);
  const ctx = await browser.newContext({ viewport, storageState, deviceScaleFactor: 1 });
  await ctx.addInitScript({ path: path.join(LIB, 'overlay.js') });
  const page = await ctx.newPage();
  const d = new Director(page, spec.baseUrl, work, paced);
  try {
    await spec.open(d);
  } catch (error) {
    throw await failure('open', page, work, error);
  }
  await page.evaluate(() => window.__demo.moveTo(window.innerWidth * 0.6, window.innerHeight * 0.55));
  return { browser, ctx, page, d };
}

/**
 * `--dry`: login, open and every scene in the order of a render, against the running app, with no
 * narration, setup check, screencast or ffmpeg; `untilSpoken` does not wait. Ends with a line per
 * scene, or with the first one that failed.
 */
async function dryRun(spec: DemoSpec, viewport: { width: number; height: number }, work: string) {
  const { browser, d } = await openPage(spec, viewport, work, false);
  const took: number[] = [];
  for (const [i, scene] of spec.scenes.entries()) {
    await d.clearHighlights();
    console.log(sceneName(i, spec));
    const start = now();
    try {
      await scene.run?.(d);
    } catch (error) {
      throw await failure(sceneName(i, spec), d.page, work, error);
    }
    took.push(now() - start);
  }
  await browser.close();
  console.log(`\ndry run: all ${spec.scenes.length} scenes ran through`);
  spec.scenes.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}  ok  ${took[i]!.toFixed(1).padStart(5)} s  ${s.title}`));
}

async function startScreencast(ctx: BrowserContext, page: Page, dir: string, size: { width: number; height: number }) {
  const frames: Frame[] = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp ?? now(), width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: size.width,
    maxHeight: size.height,
  });
  return {
    /** On the time they were painted once the screencast stops (`paintTimes`). */
    frames,
    stop: async () => {
      await cdp.send('Page.stopScreencast');
      frames.splice(0, frames.length, ...onPaintTime(frames, paintTimes(frames, dir, size)));
    },
  };
}

/**
 * The time each frame was painted, read from the clock strip `overlay.js` puts into the page: one
 * gray row through the strip of every frame, cut out by ffmpeg in one pass. Null for a frame
 * whose strip cannot be read, and for all of them when ffmpeg fails.
 */
function paintTimes(frames: Frame[], dir: string, size: { width: number; height: number }): (number | null)[] {
  const width = CLOCK.bits * CLOCK.cell;
  const y = size.height - CLOCK.bottom - Math.ceil(CLOCK.cell / 2);
  const r = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-f', 'image2', '-start_number', '0', '-i', path.join(dir, '%06d.jpg'), '-vf', `crop=${width}:1:${CLOCK.left}:${y},format=gray`, '-f', 'rawvideo', 'pipe:1'],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0 || r.stdout.length !== frames.length * width) return frames.map(() => null);
  return frames.map((f, i) => readClock(r.stdout.subarray(i * width, (i + 1) * width), f.t));
}

/** Writes an ffconcat list that holds each frame until the next one, from t0 to tEnd, less the cuts. */
function frameList(frames: Frame[], t0: number, tEnd: number, cuts: Cut[], file: string) {
  const held = frameDurations(frames, t0, tEnd, cuts);
  // Relative, with forward slashes: ffmpeg reads them on every platform, a Windows drive path not always.
  const entry = (f: string) => `file '${path.relative(path.dirname(file), f).split(path.sep).join('/')}'`;
  const lines = ['ffconcat version 1.0'];
  for (const h of held) lines.push(entry(h.file), `duration ${h.seconds.toFixed(4)}`);
  lines.push(entry(held[held.length - 1]!.file));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function vttTime(s: number) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
}

export async function runDemo(spec: DemoSpec, demoDir: string) {
  const override = process.env.DEMO_VOICE;
  const voiceName = override?.endsWith('.wav') ? path.basename(override, '.wav') : override;
  // The voice of the settings renders next to the script; another one gets its own subdirectory,
  // so two renders of one demo can be compared side by side.
  const outDir = !voiceName || override === SAVED.voice ? demoDir : path.join(demoDir, voiceName);
  const viewport = spec.viewport ?? { width: 1440, height: 900 };
  const work = path.join(outDir, '.work');
  fs.mkdirSync(work, { recursive: true });
  holdRenderLock(work);
  if (process.argv.includes('--dry')) return dryRun(spec, viewport, work);
  // Everything the render needs is there before it starts, or it stops with the whole list.
  const setup = await checkSetup(SETTINGS, { narrationOnly: process.argv.includes('--narration') });
  if (setup.items.some((i) => i.state === 'missing')) throw new Error(`cannot render yet:\n${describeSetup(setup)}`);
  const framesDir = path.join(work, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const narrated = synthesize(spec.scenes, work);
  const clips = narrated.clips;
  for (const c of clips) {
    if (c.match !== null && c.match < TTS_MATCH_WARN) console.warn(`narration ${c.id} may be off (match ${c.match.toFixed(2)}): heard "${c.heard}"`);
  }
  if (narrated.unchecked) console.warn(`narration not heard back: ${narrated.unchecked}`);
  if (process.argv.includes('--narration')) {
    console.log(`narration only: ${clips.length} clips cached, ${clips.reduce((t, c) => t + c.seconds, 0).toFixed(0)} s spoken`);
    return;
  }

  const { browser, ctx, page, d } = await openPage(spec, viewport, work, true);
  const cast = await startScreencast(ctx, page, framesDir, viewport);
  await d.wait(500);
  const t0 = now();
  const marks: { title: string; start: number; speechStart: number; speechEnd: number }[] = [];
  for (const [i, scene] of spec.scenes.entries()) {
    const clip = clips[i]!;
    await d.clearHighlights();
    const start = d.beginScene(clip.seconds);
    console.log(sceneName(i, spec));
    try {
      await scene.run?.(d);
    } catch (error) {
      throw await failure(sceneName(i, spec), page, work, error);
    }
    await d.untilSpoken(1);
    await d.wait(GAP_SECONDS * 1000);
    // In video time: what `skip` cut out is gone from the scenes after it.
    const at = videoTime(start, t0, d.cuts);
    marks.push({ title: scene.title, start: at, speechStart: at + LEAD_SECONDS, speechEnd: at + LEAD_SECONDS + clip.seconds });
  }
  const tEnd = now() + 0.8;
  await d.wait(800);
  await cast.stop();
  await browser.close();
  const total = videoTime(tEnd, t0, d.cuts);
  const cut = cast.frames.find((f) => Math.round(f.width) !== viewport.width || Math.round(f.height) !== viewport.height);
  if (cut) console.warn(`screencast frames are ${Math.round(cut.width)}×${Math.round(cut.height)}, not ${viewport.width}×${viewport.height}: part of the page is missing`);

  // Narration track: every clip at its scene's offset, levelled once as a whole.
  const narration = path.join(work, 'narration.wav');
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const delays = clips.map((_, i) => {
    const ms = Math.round(marks[i]!.speechStart * 1000);
    return `[${i}:a]adelay=${ms}:all=1[a${i}]`;
  });
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5[out]`;
  run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...delays, mix].join(';'), '-map', '[out]', '-ar', '48000', narration]);

  const list = path.join(work, 'frames.txt');
  frameList(cast.frames, t0, tEnd, d.cuts, list);
  const video = path.join(outDir, 'demo.mp4');
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-i', narration,
    // the clock strip, painted over from the pixels around it
    '-vf', `fps=30,scale=${viewport.width}:${viewport.height},delogo=x=1:y=${viewport.height - CLOCK.bottom - CLOCK.cell - 2}:w=${CLOCK.bits * CLOCK.cell + 2}:h=${CLOCK.cell + 4},format=yuv420p`,
    // Screen content: CRF 30 keeps text sharp at about 2.5 MB per minute.
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-shortest',
    video,
  ]);

  const vtt = ['WEBVTT', ''];
  marks.forEach((m, i) => vtt.push(`${vttTime(m.speechStart)} --> ${vttTime(m.speechEnd)}`, spec.scenes[i]!.say, ''));
  fs.writeFileSync(path.join(outDir, 'captions.vtt'), vtt.join('\n'));

  // One still per scene, taken just before it ends: what the agent checks against the narration.
  const reviewDir = path.join(outDir, 'review');
  fs.rmSync(reviewDir, { recursive: true, force: true });
  fs.mkdirSync(reviewDir);
  const still = (at: number, name: string) =>
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', path.join(reviewDir, `${name}.jpg`)]);
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : total;
    const nn = String(i + 1).padStart(2, '0');
    still((m.start + end) / 2, `${nn}-mid`);
    still(Math.max(m.start, end - 0.4), nn);
  });
  fs.copyFileSync(path.join(reviewDir, '01.jpg'), path.join(outDir, 'poster.jpg'));

  fs.writeFileSync(path.join(outDir, 'index.html'), reportPage(spec, marks, narrated));
  fs.writeFileSync(
    path.join(work, 'narration-check.json'),
    JSON.stringify(clips.map((c, i) => ({ scene: i + 1, said: spec.scenes[i]!.say, heard: c.heard, match: c.match })), null, 2),
  );
  console.log(`\n${Math.round(total)} s video → ${path.join(outDir, 'index.html')}`);
  console.log('\nreview (narration said vs. heard: .work/narration-check.json):');
  marks.forEach((m, i) => {
    const clip = clips[i]!;
    const flag = clip.match !== null && clip.match < NARRATION_OK ? `  ← heard: "${clip.heard}"` : '';
    const match = clip.match === null ? 'not heard back' : `match ${clip.match.toFixed(2)}`;
    const end = i + 1 < marks.length ? marks[i + 1]!.start : total;
    const silent = end - m.speechEnd - GAP_SECONDS;
    const idle = silent > SILENCE_WARN ? `  ← ${Math.round(silent)} s without narration: cut it with d.skip where it only waits` : '';
    console.log(`  ${String(i + 1).padStart(2)}  ${mmss(m.start)}  ${m.title.padEnd(32).slice(0, 32)}  ${match}${flag}${idle}`);
  });
  if (d.cuts.length) console.log(`cut ${d.cuts.length / 2}× (${Math.round(d.cuts.reduce((s, c) => s + c.to - c.from, 0))} s of waiting)`);
  if (narrated.unchecked) console.log(`narration NOT heard back (${narrated.unchecked}): name that in the report's findings`);
  console.log(`stills → ${reviewDir}: NN-mid.jpg (middle of each scene), NN.jpg (its end)`);
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function mmss(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** The report page's own words, in the narration language. */
const PAGE_WORDS: Record<
  NarrationLanguage,
  { captions: string; question: string; shown: string; notShown: string; findings: string; narration: string; heard: (w: string) => string; unheard: string; off: string }
> = {
  de: {
    captions: 'Deutsch',
    question: 'Offene Frage',
    shown: 'Gezeigt',
    notShown: 'Nicht gezeigt',
    findings: 'Auffälligkeiten',
    narration: 'Erzählung',
    heard: (w) => `mit ${w} gegengehört`,
    unheard: 'nicht gegengehört',
    off: 'in den Demo-Einstellungen abgeschaltet',
  },
  en: {
    captions: 'English',
    question: 'Open question',
    shown: 'Shown',
    notShown: 'Not shown',
    findings: 'Findings',
    narration: 'Narration',
    heard: (w) => `heard back with ${w}`,
    unheard: 'not heard back',
    off: 'turned off in the demo settings',
  },
};

function reportPage(spec: DemoSpec, marks: { title: string; start: number }[], narrated: Narration) {
  const r = { ...spec.report, meta: { ...spec.report.meta } };
  const w = PAGE_WORDS[LANGUAGE];
  // Whether the voice was checked is part of the provenance, and the owner sees it when it was not.
  r.meta[w.narration] = narrated.unchecked ? `${w.unheard} (${narrated.turnedOff ? w.off : narrated.unchecked})` : w.heard(narrated.heardWith);
  const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="none">—</p>');
  const chapters = marks
    .map((m) => `<li><button data-t="${m.start.toFixed(2)}"><span class="t">${mmss(m.start)}</span>${esc(m.title)}</button></li>`)
    .join('');
  const meta = Object.entries(r.meta)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="${LANGUAGE}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<style>
:root { --bg:#f7f6f3; --card:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e4e1da; --accent:#f5a524; --accent-ink:#1c1b19; --warn-bg:#fff6e5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161513; --card:#201f1c; --ink:#eeebe5; --muted:#a19d95; --line:#34322e; --warn-bg:#2e2616; } }
:root[data-theme="dark"] { --bg:#161513; --card:#201f1c; --ink:#eeebe5; --muted:#a19d95; --line:#34322e; --warn-bg:#2e2616; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width:1180px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:28px; line-height:1.2; margin:0 0 8px; letter-spacing:-.01em; }
.summary { font-size:18px; color:var(--ink); max-width:70ch; margin:0 0 24px; }
.player { display:grid; grid-template-columns: minmax(0,1fr) 280px; gap:16px; align-items:start; }
video { width:100%; border-radius:12px; background:#000; display:block; box-shadow:0 10px 30px rgba(0,0,0,.12); }
.chapters { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px; margin:0; list-style:none; }
.chapters button { all:unset; cursor:pointer; display:flex; gap:10px; width:100%; padding:8px 10px; border-radius:8px; font-size:14px; }
.chapters button:hover, .chapters button.on { background:var(--bg); }
.chapters .t { color:var(--muted); font-variant-numeric:tabular-nums; min-width:34px; }
.decision { margin:28px 0; padding:16px 20px; border-radius:12px; background:var(--warn-bg); border:1px solid var(--accent); }
.decision h2 { margin:0 0 4px; font-size:15px; text-transform:uppercase; letter-spacing:.06em; }
.grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:16px; }
section.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 20px; }
section.card h2 { font-size:15px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
ul { margin:0; padding-left:20px; } li { margin:4px 0; }
.none { color:var(--muted); margin:0; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; font-size:13px; color:var(--muted); margin:28px 0 0; }
dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; }
@media (max-width: 860px) { .player, .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
<h1>${esc(spec.title)}</h1>
<p class="summary">${esc(r.summary)}</p>
<div class="player">
  <video id="v" controls preload="metadata" poster="poster.jpg">
    <source src="demo.mp4" type="video/mp4">
    <track kind="captions" src="captions.vtt" srclang="${LANGUAGE}" label="${w.captions}">
  </video>
  <ol class="chapters">${chapters}</ol>
</div>
${r.question ? `<div class="decision"><h2>${w.question}</h2>${esc(r.question)}</div>` : ''}
<div class="grid">
  <section class="card"><h2>${w.shown}</h2>${list(r.shown)}</section>
  <section class="card"><h2>${w.notShown}</h2>${list(r.notShown)}</section>
  <section class="card"><h2>${w.findings}</h2>${list(r.findings)}</section>
</div>
<dl>${meta}</dl>
</main>
<script>
const v = document.getElementById('v');
const buttons = [...document.querySelectorAll('.chapters button')];
buttons.forEach(b => b.onclick = () => { v.currentTime = +b.dataset.t; v.play(); });
v.ontimeupdate = () => {
  let cur = buttons[0];
  for (const b of buttons) if (+b.dataset.t <= v.currentTime + 0.05) cur = b;
  buttons.forEach(b => b.classList.toggle('on', b === cur));
};
</script>
</body>
</html>
`;
}
