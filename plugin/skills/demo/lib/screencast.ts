// The take's picture: the screencast of the recording page, each frame put on the time it was
// painted, the browser raised above the rest of the machine meanwhile, and a watch on whether this
// computer slept, which no recording survives.
//
// Plain Node with type stripping, like the director.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { CLOCK, type Frame, onPaintTime, readClock } from './timeline.ts';

/** A call into the recording page that takes longer has hung: the page answers never, and the render would wait forever. */
const PAGE_TIMEOUT_SECONDS = 20;
/** The clock strip repaints the page every frame: a screencast without a frame this long has stopped. */
const STALL_SECONDS = 20;
/** The director's own once-a-second timer this late: the director stood still, as through a sleep of this computer. */
const STILL_SECONDS = 5;

export function now() {
  return Date.now() / 1000;
}

const AWAKE_ADVICE = 'render again once it stays awake (a laptop with its lid closed sleeps on battery whatever keeps it awake otherwise)';

/**
 * A watch on the spells the director stood still, each from when (wall clock) and how long, and
 * whether this computer slept meanwhile (known on a Mac). A laptop with its lid closed sleeps on
 * battery whatever keeps it awake otherwise, and wakes for a few seconds now and then: renders
 * failed mid-take with "no frame for 20 s", which looked like a hanging page (2026-10-17). The
 * display sleeping costs a render nothing. Started once the app is staged: the synthesis, the setup
 * check and a demo's `login` before it may block the director in child processes, which is no sleep.
 */
export class Stillness {
  /** Since when (wall clock, s) it watches; a failure names the spells since. */
  readonly since = now();
  #last = this.since;
  readonly #spells: { at: number; seconds: number; slept: boolean }[] = [];

  constructor() {
    setInterval(() => this.tick(), 1000).unref();
  }

  /** Notes a spell when the director has not ticked for `STILL_SECONDS`; called every second. */
  tick() {
    const t = now();
    if (t - this.#last > STILL_SECONDS) this.#spells.push({ at: this.#last, seconds: t - this.#last, slept: macSleptSince(this.#last) });
    this.#last = t;
  }

  /** How many seconds the director stood still since `since` (wall clock, s); with `sleptOnly`, only while this computer slept. */
  #stoodStill(since: number, sleptOnly: boolean) {
    const spells = this.#spells.filter((s) => (s.slept || !sleptOnly) && s.at >= since - 1);
    return Math.round(spells.reduce((sum, s) => sum + s.seconds, 0));
  }

  /** Why the take fails when this computer slept since `since` (wall clock, s); else undefined. */
  sleepCause(since: number) {
    const seconds = this.#stoodStill(since, true);
    return seconds ? `this computer slept for ${seconds} s during the render, and nothing can be recorded meanwhile: ${AWAKE_ADVICE}` : undefined;
  }

  /** What a failure likely comes from when the director stood still since the watch began; else undefined. */
  stillCause() {
    this.tick();
    const slept = this.sleepCause(this.since);
    if (slept) return slept;
    const seconds = this.#stoodStill(this.since, false);
    return seconds ? `the director stood still for ${seconds} s during the render: this computer may have slept; if so, ${AWAKE_ADVICE}` : undefined;
  }
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
export function stayAwake() {
  if (process.platform !== 'darwin') return;
  spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

/** `call`, or an error once it has not settled for `PAGE_TIMEOUT_SECONDS`. */
export function answered<T>(call: Promise<T>, what: string, seconds = PAGE_TIMEOUT_SECONDS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} got no answer within ${seconds} s: the recording page hangs`)), seconds * 1000);
  });
  return Promise.race([call, hung]).finally(() => clearTimeout(timer));
}

/**
 * The recording browser's processes (its own, the GPU's, the renderers') and the director above the
 * rest of the machine for the take, back to normal after it (`level`). On a busy machine
 * the page still painted 60 frames a second, but the screencast delivered as few as 8 of them: its
 * copying, encoding and handing over waited for the CPU (2026-10-30). Where raising needs rights
 * (Linux, macOS), the processes stay as they are.
 */
export async function prioritize(browser: Browser | null, level: number) {
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

export async function startScreencast(ctx: BrowserContext, page: Page, dir: string, size: { width: number; height: number }, scale: number, stillness: Stillness) {
  const frames: Frame[] = [];
  const cdp = await ctx.newCDPSession(page);
  let lastFrame = now();
  let stall: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => (stall = reject));
  stalled.catch(() => {});
  let arrived: () => void = () => {};
  const first = new Promise<void>((resolve) => (arrived = resolve));
  const since = now();
  const watch = setInterval(() => {
    stillness.tick();
    // the frames from before the sleep and after it no longer fit the narration
    const slept = stillness.sleepCause(since);
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
    arrived();
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
    /** Resolves once the screencast has sent its first frame. */
    first,
    /** Rejects once the screencast has stopped sending frames. */
    stalled,
    stop: async () => {
      clearInterval(watch);
      clearInterval(raising);
      stillness.tick();
      const slept = stillness.sleepCause(since);
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
export function frameWidth(file: string) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number.parseInt(r.stdout, 10) || undefined;
}
