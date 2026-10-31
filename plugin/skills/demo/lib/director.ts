// Records a narrated feature demo: a scripted walk through the running app, spoken in the voice the
// demo settings name (`settings.ts`), rendered as an MP4 with chapters and captions, plus a
// one-page report beside it.
//
// A demo file default-exports nothing; it calls `runDemo(spec, import.meta.dirname)` and is run
// with plain `node demo.ts`. Everything lands in the demo file's directory. `node demo.ts --dry`
// only plays the scenes against the app, to find a scene that fails before a render does;
// `node demo.ts --revoice en` narrates the rendered demo anew in another language (`revoice.ts`).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { launchChromium, SILENT_SPEECH } from '../../../lib/chromium.ts';
import { type DemoSettings, demoSettingsHere, type NarrationLanguage, withVoice } from './settings.ts';
import { checkSetup, describeSetup } from './setup.ts';
import { CLOCK, type Cut, type Frame, frameDurations, laterLabel, mmss, onPaintTime, readClock, untagged, videoTime } from './timeline.ts';
import { ttsArgs, voiceSpec } from './voices.ts';

export interface Scene {
  /** Chapter title in the player. */
  title: string;
  /** Spoken while `run` executes, in the narration language, written as it should sound. */
  say: string;
  run?: (d: Director) => Promise<void>;
}

export interface Report {
  /**
   * What the change does, for someone who has not seen it, then what the owner needs to know beyond
   * the video (what it leaves out and why, what is open or unverified, a defect in someone else's
   * change): a few short paragraphs, separated by a blank line.
   */
  summary: string;
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
  /**
   * A video for a public page rather than one to share: the page at twice its pixels, as on a
   * Retina screen, nearly lossless frames, and gentle compression. About ten times the file size.
   */
  sharp?: boolean;
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
/** A scene this much longer than its narration and gap has a stretch worth cutting (`Director.skip`). */
const SILENCE_WARN = 5;
/** A wait shorter than this stays in the video rather than being cut (`Director.skip`). */
const MIN_CUT_SECONDS = 5;
/** A call into the recording page that takes longer has hung: the page answers never, and the render would wait forever. */
const PAGE_TIMEOUT_SECONDS = 20;
/** The clock strip repaints the page every frame: a screencast without a frame this long has stopped. */
const STALL_SECONDS = 20;
/** The director's own once-a-second timer this late: the director stood still, as through a sleep of this computer. */
const STILL_SECONDS = 5;
const SAVED = demoSettingsHere();
/** The settings of this render: `DEMO_VOICE` names another provider, or a `.wav` to clone. */
const SETTINGS = withVoice(SAVED, process.env.DEMO_VOICE);
const LANGUAGE: NarrationLanguage = SETTINGS.language;
const LIB = import.meta.dirname;

export interface Clip {
  id: string;
  file: string;
  seconds: number;
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

  /** `page.evaluate`, failing once the page has not answered for `PAGE_TIMEOUT_SECONDS`. */
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    // Playwright hands an element handle to `fn` as the element; the overlay takes either untyped.
    return answered(this.page.evaluate(fn as never, arg) as Promise<R>, 'a call into the page');
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
   * the wait. The narration goes on across the cut, so call it after `untilSpoken(1)`. `quiet`: a
   * latency of the app rather than time passing (a reply that takes a few seconds), cut whole and
   * without the flash, as a cut in a film; telling the viewer how much later it is would make it
   * look like a wait they will have.
   */
  async skip(fn: () => Promise<void>, o: { quiet?: boolean } = {}) {
    if (!this.#paced) return fn();
    const from = now();
    if (o.quiet) {
      await fn();
      const to = now();
      this.#cut({ from, to });
      this.#skippedInScene += to - from;
      return;
    }
    const done = fn().then(() => true);
    if (await Promise.race([done, this.wait(MIN_CUT_SECONDS * 1000).then(() => false)])) return;
    // Long enough: what was waited so far goes without a trace, the rest falls into the white.
    const fadeFrom = now();
    await this.evaluate(() => window.__demo.whiteOut());
    await this.wait(300);
    const cutFrom = now();
    await done;
    const to = now();
    this.#cut({ from, to: fadeFrom }, { from: cutFrom, to });
    this.#skippedInScene += fadeFrom - from + to - cutFrom;
    await this.evaluate((l) => window.__demo.timeJump(l), laterLabel(to - from, LANGUAGE));
    await this.wait(1100);
    await this.evaluate(() => window.__demo.whiteIn());
    await this.wait(450);
  }

  /**
   * Keeps `cuts`, also in `cuts.json` of the work directory (wall clock, s), for a scratch Obeya
   * that plays this take's agents back (`--replay`): what was cut goes by in a moment there.
   */
  #cut(...cuts: Cut[]) {
    this.cuts.push(...cuts);
    fs.writeFileSync(path.join(this.workDir, 'cuts.json'), JSON.stringify(this.cuts));
  }

  async pointAt(target: Locator) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`cannot point at an invisible element: ${target}`);
    await this.evaluate(
      ([x, y]) => window.__demo.moveTo(x, y),
      [box.x + Math.min(box.width / 2, 60), box.y + box.height / 2],
    );
    await this.wait(750);
  }

  async click(target: Locator) {
    await this.pointAt(target);
    await this.evaluate(() => window.__demo.ripple());
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
      await this.evaluate(([px, py]) => window.__demo.moveTo(px, py, true), [x, y]);
      await this.wait(ms / steps);
    }
    await mouse.up();
    await this.wait(350);
  }

  async scrollTo(target: Locator, block: 'start' | 'center' | 'end' = 'center') {
    await answered(
      target.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block),
      'a call into the page',
    );
    await this.wait(900);
  }

  /**
   * Rings one or more elements; the rings follow scrolling and last until the next scene. An element
   * hidden behind another part of the page fails the scene: its ring would stand around something
   * else, mostly another match of the same locator that the page shows.
   */
  async highlight(targets: Locator | Locator[], label?: string) {
    const handles = [];
    for (const t of [targets].flat()) handles.push(await t.elementHandle());
    const hidden: boolean[] = await this.evaluate((els) => window.__demo.hidden(els), handles);
    const behind = [targets].flat().filter((_, i) => hidden[i]);
    if (behind.length) throw new Error(`cannot highlight what lies hidden behind another part of the page (another match of the locator?): ${behind.join(', ')}`);
    const ringed = await this.evaluate(([els, l]) => window.__demo.highlight(els, l), [handles, label] as const);
    if (ringed?.same !== undefined)
      throw new Error(
        `highlight${label ? ` "${label}"` : ''} rings what the highlight${ringed.same ? ` "${ringed.same}"` : ''} of this scene rings already: its locator probably matched another element than meant (a text that also stands inside a longer one, say). To give the same element another label, clearHighlights() first.`,
      );
    await this.wait(400);
  }

  clearHighlights() {
    return this.evaluate(() => window.__demo.clearHighlights());
  }

  /** Shows an image over the page, scrolled so that `top` (0..1 of its height) is at the top. */
  async showImage(file: string, top = 0, caption?: string) {
    const src = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    await this.evaluate(([s, t, c]) => window.__demo.showImage(s, t, c), [src, top, caption] as const);
    await this.wait(600);
  }

  async panImage(top: number) {
    await this.evaluate((t) => window.__demo.panImage(t), top);
    await this.wait(1300);
  }

  hideImage() {
    return this.evaluate(() => window.__demo.hideImage());
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
 * The spells the director stood still, each from when (wall clock) and how long, and whether this
 * computer slept meanwhile (known on a Mac). A laptop with its lid closed sleeps on battery
 * whatever keeps it awake otherwise, and wakes for a few seconds now and then: renders failed
 * mid-take with "no frame for 20 s", which looked like a hanging page (2026-10-17). The display
 * sleeping costs a render nothing.
 */
const stillSpells: { at: number; seconds: number; slept: boolean }[] = [];
let lastTick = now();
/** Since when (wall clock, s) the director watches whether it stands still; a failure names the spells since. */
let watchedSince = now();
let watching: ReturnType<typeof setInterval> | undefined;

/** Notes a spell when the director has not ticked for `STILL_SECONDS`; called every second. */
function tick() {
  const t = now();
  if (t - lastTick > STILL_SECONDS) stillSpells.push({ at: lastTick, seconds: t - lastTick, slept: macSleptSince(lastTick) });
  lastTick = t;
}

/**
 * Watches from now on, once the app is staged: the synthesis, the setup check and a demo's `login`
 * before it may block the director in child processes, which is no sleep.
 */
function watchStillness() {
  lastTick = watchedSince = now();
  stillSpells.length = 0;
  watching ??= setInterval(tick, 1000);
  watching.unref();
}

const AWAKE_ADVICE = 'render again once it stays awake (a laptop with its lid closed sleeps on battery whatever keeps it awake otherwise)';

/** Why the take fails when this computer slept since `since` (wall clock, s); else undefined. */
function sleepCause(since: number) {
  const spells = stillSpells.filter((s) => s.slept && s.at >= since - 1);
  if (!spells.length) return undefined;
  const seconds = Math.round(spells.reduce((sum, s) => sum + s.seconds, 0));
  return `this computer slept for ${seconds} s during the render, and nothing can be recorded meanwhile: ${AWAKE_ADVICE}`;
}

/** What a failure since `since` likely comes from when the director stood still meanwhile; else undefined. */
function stillCause(since: number) {
  const slept = sleepCause(since);
  if (slept) return slept;
  const spells = stillSpells.filter((s) => s.at >= since - 1);
  if (!spells.length) return undefined;
  const seconds = Math.round(spells.reduce((sum, s) => sum + s.seconds, 0));
  return `the director stood still for ${seconds} s during the render: this computer may have slept; if so, ${AWAKE_ADVICE}`;
}

/** Whether this Mac went to sleep at `t` (wall clock, s) or later, from the kernel's last sleep; false elsewhere. */
function macSleptSince(t: number) {
  if (process.platform !== 'darwin') return false;
  const r = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.sleeptime'], { encoding: 'utf8' });
  const sec = Number(/sec = (\d+)/.exec(r.stdout ?? '')?.[1]);
  return sec >= Math.floor(t);
}

/**
 * On a Mac, no idle sleep while the director runs (`caffeinate -i`, ending with it): Obeya holds
 * that only while other devices may reach it. A closed lid on battery sleeps regardless.
 */
function stayAwake() {
  if (process.platform !== 'darwin') return;
  spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

/** `call`, or an error once it has not settled for `PAGE_TIMEOUT_SECONDS`. */
function answered<T>(call: Promise<T>, what: string, seconds = PAGE_TIMEOUT_SECONDS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} got no answer within ${seconds} s: the recording page hangs`)), seconds * 1000);
  });
  return Promise.race([call, hung]).finally(() => clearTimeout(timer));
}

/**
 * Bun closes a pipe of a child process when the process object is garbage collected, after the
 * descriptor has gone to the next child: the recording browser lost its DevTools pipe a few
 * seconds into the take (once the login browser was collected), and Playwright under Bun never
 * noticed, so the render waited forever (Bun 1.3.12, 2026-10-09). A demo started with `bun` runs
 * again under Node and ends with its exit code.
 */
function underNode() {
  if (!process.versions.bun) return;
  console.warn('the director runs under Node, not Bun: running this demo again with `node`');
  const r = spawnSync('node', process.argv.slice(1), { stdio: 'inherit' });
  if (r.error) throw new Error(`the director needs Node, which could not be started (${r.error.message}); run the demo with \`node demo.ts\``);
  process.exit(r.status ?? 1);
}

/**
 * One render per demo at a time: two renders of the same demo (one left running in the background)
 * write the same frames and, through the demo's `login`, reset each other's app.
 */
export function holdRenderLock(work: string) {
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

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}):\n${r.stderr?.slice(-3000)}`);
  return r.stdout;
}

/** The scenes' narration (`says`), one clip each, in the voice and language of `settings`; cached in `dir` by voice and text. */
export function synthesize(says: string[], dir: string, settings: DemoSettings = SETTINGS): Clip[] {
  const jobs = says.map((say, i) => ({ id: `s${i + 1}`, text: say }));
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const spec = voiceSpec(settings);
  const specFile = path.join(dir, 'voice.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  console.log(`narration: ${jobs.length} clips, voice ${settings.voice}, language ${settings.language}`);
  const args = [...ttsArgs(spec), specFile, settings.language, jobsFile, dir];
  // tts.py's progress (the voice loading, waiting for the lock) shows as it happens.
  const r = spawnSync('uv', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`tts.py failed (${r.error?.message ?? r.status}); its output is above`);
  return (JSON.parse(fs.readFileSync(path.join(dir, 'tts.json'), 'utf8')) as { clips: Clip[] }).clips;
}

/**
 * Headless Chrome with its window the size of the viewport: in a window of another size the
 * screencast captured only the top 813 of 900 pixels. It asks for the stronger of two graphics
 * chips (Windows and macOS; Linux ignores it), which hands the screencast more frames on a busy machine.
 * At `scale` above 1 the whole browser runs at that device scale: Chrome's screencast sent frames at
 * one pixel per point whatever the page's own scale (`deviceScaleFactor`), so `sharp` was not.
 */
async function launch(viewport: { width: number; height: number }, scale = 1) {
  const args = [`--window-size=${viewport.width},${viewport.height}`, '--force_high_performance_gpu'];
  if (scale > 1) args.push(`--force-device-scale-factor=${scale}`);
  return launchChromium({ args });
}

/** A context of the demo's browser, whose pages speak nothing out loud (`SILENT_SPEECH`). */
async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript({ path: SILENT_SPEECH });
  return ctx;
}

/**
 * For looking at the app before writing the scenes: opens `url` in the demo's browser and viewport,
 * runs `fn` and closes. Run it from a file in the demo directory (`node explore.ts`); importing this
 * module is what resolves Playwright.
 */
export async function explore(url: string, fn: (page: Page) => Promise<void>, viewport = { width: 1440, height: 900 }) {
  underNode();
  const browser = await launch(viewport);
  try {
    const page = await (await newContext(browser, { viewport, deviceScaleFactor: 1 })).newPage();
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
  const ctx = await newContext(browser, { viewport: spec.viewport });
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
  const captured = await page.screenshot({ path: shot, timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  await closeBrowser(page.context().browser());
  // Playwright's message names the call and the locator it waited for; its colours are noise here.
  const cause = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, '').trim();
  tick();
  const still = stillCause(watchedSince);
  const lines = [
    `${step} failed`,
    `  URL: ${page.url()}`,
    `  Screenshot: ${captured ? shot : 'none (the page could not be captured)'}`,
    `  Cause: ${cause.split('\n').join('\n    ')}`,
    ...(still && still !== cause ? [`  Likely cause: ${still}`] : []),
  ];
  return new Error(lines.join('\n'), { cause: error });
}

/** Closes the browser, and gives up on one whose page hangs after a while instead of waiting with it. */
async function closeBrowser(browser: Browser | null) {
  if (browser) await answered(browser.close(), 'closing the browser', 10).catch(() => {});
}

function sceneName(i: number, spec: DemoSpec) {
  return `scene ${i + 1}/${spec.scenes.length} "${spec.scenes[i]!.title}"`;
}

/** The recording browser, with the overlay, on the opening shot. */
async function openPage(spec: DemoSpec, viewport: { width: number; height: number }, work: string, paced: boolean) {
  const storageState = await login({ ...spec, viewport }, work);
  watchStillness();
  const scale = spec.sharp ? 2 : 1;
  const browser = await launch(viewport, scale);
  const ctx = await newContext(browser, { viewport, storageState, deviceScaleFactor: scale });
  await ctx.addInitScript({ path: path.join(LIB, 'overlay.js') });
  const page = await ctx.newPage();
  const d = new Director(page, spec.baseUrl, work, paced);
  try {
    await spec.open(d);
  } catch (error) {
    throw await failure('open', page, work, error);
  }
  await d.evaluate(() => window.__demo.moveTo(window.innerWidth * 0.6, window.innerHeight * 0.55));
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

/**
 * The recording browser's processes (its own, the GPU's, the renderers') and the director above the
 * rest of the machine for the take, back to normal after it (`level`). On a busy machine
 * the page still painted 60 frames a second, but the screencast delivered as few as 8 of them: its
 * copying, encoding and handing over waited for the CPU (2026-10-30). Where raising needs rights
 * (Linux, macOS), the processes stay as they are.
 */
async function prioritize(browser: Browser | null, level: number) {
  const pids = [process.pid];
  if (browser) {
    const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
    const info = await cdp?.send('SystemInfo.getProcessInfo').catch(() => undefined);
    pids.push(...(info?.processInfo ?? []).map((p) => p.id));
    await cdp?.detach().catch(() => {});
  }
  for (const pid of pids) {
    try {
      os.setPriority(pid, level);
    } catch {}
  }
}

async function startScreencast(ctx: BrowserContext, page: Page, dir: string, size: { width: number; height: number }, scale: number) {
  const frames: Frame[] = [];
  const cdp = await ctx.newCDPSession(page);
  let lastFrame = now();
  let stall: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => (stall = reject));
  stalled.catch(() => {});
  const since = now();
  const watch = setInterval(() => {
    tick();
    // the frames from before the sleep and after it no longer fit the narration
    const slept = sleepCause(since);
    if (slept) stall(new Error(slept));
    else if (now() - lastFrame > STALL_SECONDS) stall(new Error(`the recording page sent no frame for ${STALL_SECONDS} s: it hangs`));
  }, 1000);
  watch.unref();
  // a renderer that starts later (another site in the page) is raised too
  const raise = () => prioritize(ctx.browser(), os.constants.priority.PRIORITY_ABOVE_NORMAL);
  await raise();
  const raising = setInterval(raise, 5000);
  raising.unref();
  cdp.on('Page.screencastFrame', (f) => {
    lastFrame = now();
    const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp ?? now(), width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const start = cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: scale > 1 ? 100 : 92,
    maxWidth: size.width * scale,
    maxHeight: size.height * scale,
  });
  await answered(start, 'starting the screencast');
  return {
    /** On the time they were painted once the screencast stops (`paintTimes`). */
    frames,
    /** Rejects once the screencast has stopped sending frames. */
    stalled,
    stop: async () => {
      clearInterval(watch);
      clearInterval(raising);
      tick();
      const slept = sleepCause(since);
      if (slept) throw new Error(slept);
      await answered(cdp.send('Page.stopScreencast'), 'stopping the screencast');
      frames.splice(0, frames.length, ...onPaintTime(frames, paintTimes(frames, dir, size)));
    },
  };
}

/**
 * The time each frame was painted, read from the clock strip `overlay.js` puts into the page: one
 * gray row through the strip of every frame, cut out by ffmpeg in one pass. Null for a frame
 * whose strip cannot be read, and for all of them when ffmpeg fails. `size` is the page in points;
 * where the strip sits in a frame follows from the frame's own pixels, as many per point as the
 * screencast sent (asked for twice as many, it sent one per point).
 */
export function paintTimes(frames: Frame[], dir: string, size: { width: number; height: number }): (number | null)[] {
  const width = CLOCK.bits * CLOCK.cell;
  const y = size.height - CLOCK.bottom - Math.ceil(CLOCK.cell / 2);
  // in the frame's pixels (iw/ih), read back at one pixel per point
  const [sx, sy] = [`iw/${size.width}`, `ih/${size.height}`];
  const crop = `crop=w=${width}*${sx}:h=1:x=${CLOCK.left}*${sx}:y=${y}*${sy},scale=${width}:1:flags=neighbor`;
  // gray before the crop: ffmpeg 6 crops a 4:2:0 JPEG to even heights only, so a row of one pixel
  // failed every frame there and no frame was put on its paint time
  const r = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-f', 'image2', '-start_number', '0', '-i', path.join(dir, '%06d.jpg'), '-vf', `format=gray,${crop}`, '-f', 'rawvideo', 'pipe:1'],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0 || r.stdout.length !== frames.length * width) return frames.map(() => null);
  return frames.map((f, i) => readClock(r.stdout.subarray(i * width, (i + 1) * width), f.t));
}

/** A frame's width in pixels, undefined where ffprobe cannot tell. */
function frameWidth(file: string) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number.parseInt(r.stdout, 10) || undefined;
}

/** Writes an ffconcat list that holds each frame until the next one, from t0 to tEnd, less the cuts. */
function frameList(frames: Frame[], t0: number, tEnd: number, cuts: Cut[], file: string) {
  const held = frameDurations(frames, t0, tEnd, cuts);
  if (!held.length) throw new Error(`none of the screencast's ${frames.length} frames falls into the take`);
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
  underNode();
  stayAwake();
  const revoicing = process.argv.indexOf('--revoice');
  if (revoicing >= 0) return (await import('./revoice.ts')).revoice(demoDir, process.argv[revoicing + 1]);
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

  const clips = synthesize(spec.scenes.map((s) => s.say), work);
  if (process.argv.includes('--narration')) {
    console.log(`narration only: ${clips.length} clips cached, ${clips.reduce((t, c) => t + c.seconds, 0).toFixed(0)} s spoken`);
    return;
  }

  const { browser, ctx, page, d } = await openPage(spec, viewport, work, true);
  // this take's cuts, none so far (`Director.#cut`): after the login, which may stage a playback of the take before
  fs.writeFileSync(path.join(work, 'cuts.json'), '[]');
  const cast = await startScreencast(ctx, page, framesDir, viewport, spec.sharp ? 2 : 1);
  await d.wait(500);
  const t0 = now();
  const marks: Mark[] = [];
  for (const [i, scene] of spec.scenes.entries()) {
    const clip = clips[i]!;
    let start = 0;
    console.log(sceneName(i, spec));
    try {
      // A scene can wait without touching the page (`untilSpoken`, `wait`): a page that hangs then
      // shows as a screencast without frames.
      const played = (async () => {
        await d.clearHighlights();
        start = d.beginScene(clip.seconds);
        await scene.run?.(d);
        await d.untilSpoken(1);
        await d.wait(GAP_SECONDS * 1000);
      })();
      await Promise.race([played, cast.stalled]);
    } catch (error) {
      throw await failure(sceneName(i, spec), page, work, error);
    }
    // In video time: what `skip` cut out is gone from the scenes after it.
    const at = videoTime(start, t0, d.cuts);
    marks.push({ title: scene.title, start: at, speechStart: at + LEAD_SECONDS, speechEnd: at + LEAD_SECONDS + clip.seconds });
  }
  const tEnd = now() + 0.8;
  try {
    await Promise.race([d.wait(800), cast.stalled]);
    await cast.stop();
  } catch (error) {
    throw await failure('the end of the take', page, work, error);
  }
  await closeBrowser(browser);
  // the encoding at normal priority: below it, a busy machine starved it for minutes
  await prioritize(null, os.constants.priority.PRIORITY_NORMAL);
  const total = videoTime(tEnd, t0, d.cuts);
  const cut = cast.frames.find((f) => Math.round(f.width) !== viewport.width || Math.round(f.height) !== viewport.height);
  if (cut) console.warn(`screencast frames are ${Math.round(cut.width)}×${Math.round(cut.height)}, not ${viewport.width}×${viewport.height}: part of the page is missing`);
  const pixels = spec.sharp && cast.frames[0] ? frameWidth(cast.frames[0].file) : undefined;
  if (pixels && pixels < viewport.width * 2) console.warn(`screencast frames are ${pixels} pixels wide, not ${viewport.width * 2}: the sharp video is scaled up from them`);

  const list = path.join(work, 'frames.txt');
  frameList(cast.frames, t0, tEnd, d.cuts, list);
  assemble({
    outDir, work, list, clips, marks, total, viewport, sharp: !!spec.sharp,
    title: spec.title, says: spec.scenes.map((s) => s.say), report: spec.report, language: LANGUAGE,
  });
  if (d.cuts.length) console.log(`cut ${d.cuts.length / 2}× (${Math.round(d.cuts.reduce((s, c) => s + c.to - c.from, 0))} s of waiting)`);
}

/** A scene's place in the video: where it starts, and where its narration does and ends. */
export interface Mark {
  title: string;
  start: number;
  speechStart: number;
  speechEnd: number;
}

/** What a take is made into: its frames (`list`, an ffconcat list), its clips and where each scene and clip sits. */
export interface Take {
  /** Where `demo.mp4`, the captions, chapters, stills and the report page go. */
  outDir: string;
  /** Where the narration track is mixed. */
  work: string;
  list: string;
  clips: Clip[];
  marks: Mark[];
  /** The video's length, in seconds. */
  total: number;
  viewport: { width: number; height: number };
  /** Twice the pixels and gentle compression (`DemoSpec.sharp`). */
  sharp: boolean;
  title: string;
  /** Each scene's narration, for the captions. */
  says: string[];
  report: Report;
  language: NarrationLanguage;
}

/**
 * Makes the take into `demo.mp4` with its narration, `captions.vtt`, `chapters.vtt`, a still from
 * the middle and the end of each scene, the poster and the report page; prints the review table.
 */
export function assemble({ outDir, work, list, clips, marks, total, viewport, sharp, title, says, report, language }: Take) {
  const scale = sharp ? 2 : 1;
  // Narration track: every clip at its scene's offset, levelled once as a whole.
  const narration = path.join(work, 'narration.wav');
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const delays = clips.map((_, i) => {
    const ms = Math.round(marks[i]!.speechStart * 1000);
    return `[${i}:a]adelay=${ms}:all=1[a${i}]`;
  });
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5[out]`;
  run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...delays, mix].join(';'), '-map', '[out]', '-ar', '48000', narration]);

  const video = path.join(outDir, 'demo.mp4');
  run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-i', narration,
    // the clock strip, painted over from the pixels around it
    '-vf', `fps=30,scale=${viewport.width * scale}:${viewport.height * scale},delogo=x=${scale}:y=${(viewport.height - CLOCK.bottom - CLOCK.cell - 2) * scale}:w=${(CLOCK.bits * CLOCK.cell + 2) * scale}:h=${(CLOCK.cell + 4) * scale},format=yuv420p`,
    // Screen content: CRF 30 keeps text sharp at about 2.5 MB per minute; a public video (`sharp`)
    // gets CRF 18, where no compression shows on the page's flat colours and fine type.
    '-c:v', 'libx264', '-preset', 'slow', '-crf', sharp ? '18' : '30', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', sharp ? '160k' : '96k',
    '-movflags', '+faststart', '-shortest',
    video,
  ]);

  const vtt = ['WEBVTT', ''];
  marks.forEach((m, i) => vtt.push(`${vttTime(m.speechStart)} --> ${vttTime(m.speechEnd)}`, untagged(says[i]!), ''));
  fs.writeFileSync(path.join(outDir, 'captions.vtt'), vtt.join('\n'));
  // The scenes as chapters, for a player outside Obeya (the hero video on obeya.si reads them).
  const chapters = ['WEBVTT', ''];
  marks.forEach((m, i) => chapters.push(`${vttTime(m.start)} --> ${vttTime(i + 1 < marks.length ? marks[i + 1]!.start : total)}`, m.title, ''));
  fs.writeFileSync(path.join(outDir, 'chapters.vtt'), chapters.join('\n'));

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

  fs.writeFileSync(path.join(outDir, 'index.html'), reportPage(title, report, marks, language));
  console.log(`\n${Math.round(total)} s video → ${path.join(outDir, 'index.html')}`);
  console.log('\nreview:');
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : total;
    const silent = end - m.speechEnd - GAP_SECONDS;
    const idle = silent > SILENCE_WARN ? `  ← ${Math.round(silent)} s without narration: cut it with d.skip where it only waits` : '';
    console.log(`  ${String(i + 1).padStart(2)}  ${mmss(m.start)}  ${m.title.padEnd(32).slice(0, 32)}${idle}`.trimEnd());
  });
  console.log(`stills → ${reviewDir}: NN-mid.jpg (middle of each scene), NN.jpg (its end)`);
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** The report page's own words, in the narration language. */
const PAGE_WORDS: Record<
  NarrationLanguage,
  { captions: string; question: string }
> = {
  de: { captions: 'Deutsch', question: 'Offene Frage' },
  en: { captions: 'English', question: 'Open question' },
};

function reportPage(title: string, r: Report, marks: { title: string; start: number }[], language: NarrationLanguage) {
  const w = PAGE_WORDS[language];
  const summary = r.summary
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p class="summary">${esc(p)}</p>`)
    .join('\n');
  const chapters = marks
    .map((m) => `<li><button data-t="${m.start.toFixed(2)}"><span class="t">${mmss(m.start)}</span>${esc(m.title)}</button></li>`)
    .join('');
  // a demo script is not type-checked: `meta` given as one line stays one line
  const rows: [string, string][] = typeof r.meta === 'string' ? [['', r.meta]] : Object.entries(r.meta);
  const meta = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg:#f7f6f3; --card:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e4e1da; --accent:#f5a524; --accent-ink:#1c1b19; --warn-bg:#fff6e5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161513; --card:#201f1c; --ink:#eeebe5; --muted:#a19d95; --line:#34322e; --warn-bg:#2e2616; } }
:root[data-theme="dark"] { --bg:#161513; --card:#201f1c; --ink:#eeebe5; --muted:#a19d95; --line:#34322e; --warn-bg:#2e2616; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width:1180px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:28px; line-height:1.2; margin:0 0 8px; letter-spacing:-.01em; }
.summary { font-size:18px; color:var(--ink); max-width:70ch; margin:0 0 12px; }
.player { margin-top:24px; display:grid; grid-template-columns: minmax(0,1fr) 280px; gap:16px; align-items:start; }
video { width:100%; border-radius:12px; background:#000; display:block; box-shadow:0 10px 30px rgba(0,0,0,.12); }
.chapters { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px; margin:0; list-style:none; }
.chapters button { all:unset; cursor:pointer; display:flex; gap:10px; width:100%; padding:8px 10px; border-radius:8px; font-size:14px; }
.chapters button:hover, .chapters button.on { background:var(--bg); }
.chapters .t { color:var(--muted); font-variant-numeric:tabular-nums; min-width:34px; }
.decision { margin:28px 0; padding:16px 20px; border-radius:12px; background:var(--warn-bg); border:1px solid var(--accent); }
.decision h2 { margin:0 0 4px; font-size:15px; text-transform:uppercase; letter-spacing:.06em; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; font-size:13px; color:var(--muted); margin:28px 0 0; }
dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; }
@media (max-width: 860px) { .player { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${summary}
<div class="player">
  <video id="v" controls preload="metadata" poster="poster.jpg">
    <source src="demo.mp4" type="video/mp4">
    <track kind="captions" src="captions.vtt" srclang="${language}" label="${w.captions}">
  </video>
  <ol class="chapters">${chapters}</ol>
</div>
${r.question ? `<div class="decision"><h2>${w.question}</h2>${esc(r.question)}</div>` : ''}
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
