// Records a narrated feature demo: a scripted walk through the running app, spoken in the voice the
// demo settings name (`settings.ts`), rendered as an MP4 with chapters and a caption track per
// subtitle language the settings list (`subtitles.ts`), plus a one-page report beside it. Without a voice (`none`)
// the video is silent and its captions tell the narration, each scene as long as it takes to read.
//
// A demo file default-exports nothing; it calls `runDemo(spec, import.meta.dirname)` and is run
// with plain `node demo.ts`. Everything lands in the demo file's directory. `node demo.ts --dry`
// only plays the scenes against the app, to find a scene that fails before a render does;
// `node demo.ts --revoice en` narrates the rendered demo anew in another language (`revoice.ts`).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright-core';
import { assemble, frameList, GAP_SECONDS, type Mark, type Report, run } from './assemble.ts';
import { type Clip, heardNotes, printHeard, synthesize, writeJobs } from './narration.ts';
import { answered, frameWidth, now, prioritize, startScreencast, stayAwake, stillCause, tick, watchedSince, watchStillness } from './screencast.ts';
import { demoSettingsHere, type NarrationLanguage, silent, subtitleLanguages, withVoice } from './settings.ts';
import { checkSetup, describeSetup } from './setup.ts';
import { narrationTrack, readingTimes, sentencesOf, spokenTimes, subtitleTracks } from './subtitles.ts';
import { type Cut, laterLabel, videoTime } from './timeline.ts';

export type { Report } from './assemble.ts';

export interface Scene {
  /** Chapter title in the player. */
  title: string;
  /** Spoken while `run` executes, in the narration language, written as it should sound; its sentences are the captions. */
  say: string;
  run?: (d: Director) => Promise<void>;
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
/** A wait shorter than this stays in the video rather than being cut (`Director.skip`). */
const MIN_CUT_SECONDS = 5;
const SAVED = demoSettingsHere();
/** The settings of this render: `DEMO_VOICE` names another provider, or a `.wav` to clone. */
const SETTINGS = withVoice(SAVED, process.env.DEMO_VOICE);
const LANGUAGE: NarrationLanguage = SETTINGS.language;
/** No voice: a silent video, its scenes timed by how long their captions take to read. */
const SILENT = silent(SETTINGS);
const LIB = import.meta.dirname;
/**
 * The plugin's Chromium, imported only once a browser is needed: importing it resolves Playwright,
 * so without Playwright a render gets as far as `checkSetup`, which lists it with what else is missing.
 */
const chromium = () => import('../../../lib/chromium.ts');

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
  return (await chromium()).launchChromium({ args });
}

/** A context of the demo's browser, whose pages speak nothing out loud (`SILENT_SPEECH`). */
async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript({ path: (await chromium()).SILENT_SPEECH });
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
  const says = spec.scenes.map((s) => s.say);
  if (process.argv.includes('--narration')) {
    if (SILENT) return console.log('narration only: no voice, so nothing to synthesise');
    const clips = synthesize(says, work, SETTINGS);
    console.log(`narration only: ${clips.length} clips cached, ${clips.reduce((t, c) => t + c.seconds, 0).toFixed(0)} s spoken`);
    const heard = heardNotes(clips);
    heard.stumbled.forEach((lines, i) => lines.forEach((line) => console.log(`  ${String(i + 1).padStart(2)}  ${line}`)));
    printHeard(heard);
    return;
  }
  // the subtitles' translations before anything is recorded: a silent scene lasts as long as its slowest language takes to read
  const source = { language: LANGUAGE, scenes: spec.scenes.map((s) => ({ title: s.title, sentences: sentencesOf(s.say, LANGUAGE) })) };
  const subtitles = subtitleTracks(work, source, subtitleLanguages(SETTINGS));
  if ('brief' in subtitles) {
    console.log(subtitles.brief);
    process.exitCode = 2;
    return;
  }
  // the frames of the take before go only now: a render that stops before recording keeps them for re-voicing
  const framesDir = path.join(work, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const { tracks } = subtitles;
  const narration = narrationTrack(source);
  let clips: Clip[] | undefined;
  writeJobs(says, work);
  if (!SILENT) clips = synthesize(says, work, SETTINGS);
  // each sentence's time: from its first word as the clip was heard back, or as long as it takes to read in the slowest of the subtitles' languages
  const timings = spec.scenes.map((_, i) => (clips ? spokenTimes(clips[i]!.seconds, narration.scenes[i]!, clips[i]!.timed) : { sentences: readingTimes(tracks.map((t) => t.scenes[i]!)) }));
  const speech = timings.map((t) => t.sentences.reduce((a, b) => a + b, 0));

  const { browser, ctx, page, d } = await openPage(spec, viewport, work, true);
  // this take's cuts, none so far (`Director.#cut`): after the login, which may stage a playback of the take before
  fs.writeFileSync(path.join(work, 'cuts.json'), '[]');
  const cast = await startScreencast(ctx, page, framesDir, viewport, spec.sharp ? 2 : 1);
  // The take starts once a frame has come: at twice the pixels the first one took seconds, and what
  // the page showed until then was missing from the video.
  try {
    await Promise.race([cast.first, cast.stalled]);
  } catch (error) {
    throw await failure('the start of the take', page, work, error);
  }
  await d.wait(500);
  const t0 = now();
  const marks: Mark[] = [];
  for (const [i, scene] of spec.scenes.entries()) {
    let start = 0;
    console.log(sceneName(i, spec));
    try {
      // A scene can wait without touching the page (`untilSpoken`, `wait`): a page that hangs then
      // shows as a screencast without frames.
      const played = (async () => {
        await d.clearHighlights();
        start = d.beginScene(speech[i]!);
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
    marks.push({ title: scene.title, start: at, speechStart: at + LEAD_SECONDS, speechEnd: at + LEAD_SECONDS + speech[i]!, ...timings[i]! });
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
    title: spec.title, narration, tracks, report: spec.report, language: LANGUAGE,
  });
  if (d.cuts.length) console.log(`cut ${d.cuts.length / 2}× (${Math.round(d.cuts.reduce((s, c) => s + c.to - c.from, 0))} s of waiting)`);
}
