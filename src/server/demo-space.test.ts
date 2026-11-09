import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEEP_DAYS, DemoSpace, keepDays, sweep, usage, workDirs } from './demo-space';
import { STALL_MS } from './stalls';
import { PATIENCE } from './testing';

const DAY = 24 * 3600;
let demos: string;
beforeEach(() => (demos = mkdtempSync(join(tmpdir(), 'obeya-demo-space-'))));
// the hundreds of demos of the last test take seconds to delete on a busy machine
afterEach(() => rmSync(demos, { recursive: true, force: true }), 30_000);

/** A rendered demo: video, a clip and its frames in `.work`, everything last written `days` ago. */
function render(dir: string, days: number) {
  const work = join(dir, '.work');
  mkdirSync(join(work, 'frames'), { recursive: true });
  writeFileSync(join(dir, 'demo.mp4'), 'v'.repeat(1000));
  writeFileSync(join(work, 'abc.wav'), 'w'.repeat(2000));
  writeFileSync(join(work, 'frames.txt'), 'ffconcat version 1.0\n');
  for (let i = 0; i < 3; i++) writeFileSync(join(work, 'frames', `${i}.jpg`), 'f'.repeat(10_000));
  const at = Date.now() / 1000 - days * DAY;
  for (const p of [join(work, 'frames'), join(work, 'abc.wav'), join(work, 'frames.txt'), work]) utimesSync(p, at, at);
  return work;
}

describe('the frames of old demos', () => {
  test('go once a demo was last rendered longer ago than the days kept; video and clips stay', async () => {
    const old = render(join(demos, 'old'), 20);
    const fresh = render(join(demos, 'fresh'), 3);
    const freed = await sweep(demos, 14);
    expect(freed.demos).toBe(1);
    expect(freed.bytes).toBeGreaterThanOrEqual(30_000);
    expect(readdirSync(old).sort()).toEqual(['abc.wav']);
    expect(existsSync(join(demos, 'old', 'demo.mp4'))).toBe(true);
    expect(readdirSync(join(fresh, 'frames'))).toHaveLength(3);
    // nothing left to delete the next time
    expect(await sweep(demos, 14)).toEqual({ demos: 0, bytes: 0 });
  });

  test('of a render in another voice, in its own subdirectory, go too', async () => {
    const other = render(join(demos, 'export', 'qwen'), 30);
    expect(await workDirs(demos)).toEqual([other]);
    await sweep(demos, 14);
    expect(existsSync(join(other, 'frames'))).toBe(false);
  });

  test('stay while a render of the demo runs', async () => {
    const work = render(join(demos, 'busy'), 30);
    writeFileSync(join(work, 'render.pid'), String(process.pid));
    utimesSync(join(work, 'render.pid'), Date.now() / 1000 - 30 * DAY, Date.now() / 1000 - 30 * DAY);
    utimesSync(work, Date.now() / 1000 - 30 * DAY, Date.now() / 1000 - 30 * DAY);
    expect(await sweep(demos, 14)).toEqual({ demos: 0, bytes: 0 });
    expect(existsSync(join(work, 'frames'))).toBe(true);
  });

  test('behind a link are not touched', async () => {
    // a work directory that is a link, and frames that are one, both to a render outside the demo directory
    const outside = mkdtempSync(join(tmpdir(), 'obeya-demo-space-outside-'));
    try {
      const kept = render(join(outside, 'kept'), 30);
      mkdirSync(join(demos, 'linked'));
      symlinkSync(kept, join(demos, 'linked', '.work'), 'dir');
      const real = render(join(demos, 'real'), 30);
      rmSync(join(real, 'frames'), { recursive: true });
      symlinkSync(join(kept, 'frames'), join(real, 'frames'), 'dir');
      expect(await workDirs(demos)).toEqual([real]);
      await sweep(demos, 14);
      expect(readdirSync(join(kept, 'frames'))).toHaveLength(3);
      expect(existsSync(join(kept, 'frames.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a recent file in the work directory counts as a recent render', async () => {
    const work = render(join(demos, 'revoiced'), 30);
    writeFileSync(join(work, 'state.json'), '{}');
    expect(await sweep(demos, 14)).toEqual({ demos: 0, bytes: 0 });
  });
});

test("what demos take, and their work directories' share of it", async () => {
  render(join(demos, 'a'), 1);
  render(join(demos, 'b', 'qwen'), 1);
  writeFileSync(join(demos, 'notes.txt'), 'n'.repeat(500));
  const used = await usage(demos);
  expect(used.work).toBeGreaterThanOrEqual(2 * 32_000);
  expect(used.bytes).toBeGreaterThanOrEqual(used.work + 2 * 1000 + 500);
  expect(await usage(join(demos, 'none'))).toEqual({ bytes: 0, work: 0 });
});

test("the days kept: the settings', else the default, which only the Obeya in the default home applies", () => {
  const own = join(homedir(), '.obeya');
  expect(keepDays({}, own)).toBe(DEFAULT_KEEP_DAYS);
  expect(keepDays({ keepFrames: 'always' }, own)).toBeNull();
  expect(keepDays({ keepFrames: 3 }, own)).toBe(3);
  expect(keepDays({}, demos)).toBeNull();
  expect(keepDays({ keepFrames: 30 }, demos)).toBe(30);
});

test('the view counts in the background, and a sweep deletes per the settings', async () => {
  const work = render(join(demos, 'old'), 20);
  const home = join(demos, 'home');
  const space = new DemoSpace({ home, settings: () => ({ language: 'en', voice: 'piper', directory: demos, keepFrames: 7 }) });
  expect(space.view()).toMatchObject({ keepDays: 7, defaultDays: null, busy: true });
  await space.sweepSoon();
  expect(existsSync(join(work, 'frames'))).toBe(false);
  const view = space.view();
  expect(view.busy).toBe(false);
  expect(view.freed).toMatchObject({ demos: 1 });
  expect(view.used!.bytes).toBeGreaterThan(0);
});

test('a settings file that does not read deletes nothing', async () => {
  const work = render(join(demos, 'old'), 20);
  const file = join(demos, 'demo.json');
  writeFileSync(file, '{ not json');
  const space = new DemoSpace({ home: join(homedir(), '.obeya'), settings: () => ({ language: 'en', voice: 'piper', directory: demos }), file });
  await space.sweepSoon();
  expect(existsSync(join(work, 'frames'))).toBe(true);
});

test('a settings file that is there and cannot be read deletes nothing; one that is not there deletes by the defaults', async () => {
  const work = render(join(demos, 'old'), 20);
  const settings = () => ({ language: 'en' as const, voice: 'piper' as const, directory: demos });
  const file = join(demos, 'demo.json');
  // a directory where the file belongs: it is there, and does not read
  mkdirSync(file);
  await new DemoSpace({ home: join(homedir(), '.obeya'), settings, file }).sweepSoon();
  expect(existsSync(join(work, 'frames'))).toBe(true);
  await new DemoSpace({ home: join(homedir(), '.obeya'), settings, file: join(demos, 'none', 'demo.json') }).sweepSoon();
  expect(existsSync(join(work, 'frames'))).toBe(false);
});

test('what was counted in another directory is not shown', async () => {
  render(join(demos, 'a'), 1);
  let directory = demos;
  const space = new DemoSpace({ home: join(demos, 'home'), settings: () => ({ language: 'en', voice: 'piper', directory, keepFrames: 'always' }) });
  await space.sweepSoon();
  expect(space.view().used!.bytes).toBeGreaterThan(0);
  directory = join(demos, 'none');
  expect(space.view().used).toBeUndefined();
  // a sweep that deletes nothing still counts a directory it has no count of
  await space.sweepSoon();
  expect(space.view().used).toMatchObject({ bytes: 0, work: 0 });
});

test('looking through a large demo directory holds the server up for no noticeable time', async () => {
  // a few hundred demos, as in a demo directory used for months, each with its frames, rendered
  // recently enough that they are kept: the sweep every few hours has nothing to delete. Work that
  // blocks shows with these as with thousands (the loop does not turn); more only take long to
  // make and delete where files are slow to make (Windows, its virus scanner looking at each)
  for (let i = 0; i < 300; i++) {
    const work = join(demos, `demo-${i}`, '.work');
    mkdirSync(join(work, 'frames'), { recursive: true });
    for (const f of ['frames.txt', 'clip.wav']) writeFileSync(join(work, f), '');
  }
  // how often the event loop turned meanwhile, and the longest it went without a turn, which the
  // server would log as a stall
  let turns = 0;
  let longest = 0;
  let last = performance.now();
  let looking = true;
  const turn = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    turns++;
    if (looking) setImmediate(turn);
  };
  setImmediate(turn);
  try {
    expect(await sweep(demos, 14)).toEqual({ demos: 0, bytes: 0 });
    // work that never lets the loop turn ends before it turns once
    turn();
    expect(turns).toBeGreaterThan(100);
    await usage(demos);
  } finally {
    looking = false;
  }
  turn();
  // a Windows machine running the test files side by side holds up any process a while (`PATIENCE`);
  // the turns counted above show that the looking itself does not
  expect(longest).toBeLessThan(STALL_MS * PATIENCE);
}, 60_000);
