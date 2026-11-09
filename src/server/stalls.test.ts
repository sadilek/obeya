import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describePageStall, describeStall, heldSoFar, pageStall, placeOf, Stalls, STALLS_FILE, type Trace } from './stalls';
import { until } from './testing';

const NONE = 4294967295;
const native = (name: string) => ({ name, line: NONE, column: NONE });
const at = (name: string, file: string, line: number) => ({ name, sourceURL: `/repo/src/server/${file}`, line, column: 3 });
const trace = (...frames: Trace['frames']): Trace => ({ timestamp: 0, frames });
const times = (n: number, t: Trace) => Array.from({ length: n }, () => t);

test('a sample is placed by the runtime function it was in and the code of Obeya that called it, a library’s frames left out', () => {
  expect(placeOf(trace(native('spawnSync'), at('git', 'workspaces.ts', 77), { name: 'x', sourceURL: '/repo/node_modules/lib/a.js', line: 1, column: 1 }, at('approve', 'workers.ts', 1285)))).toBe(
    'spawnSync ← git (workspaces.ts:77) ← approve (workers.ts:1285)',
  );
  expect(placeOf(trace(at('', 'board.ts', 12)))).toBe('(anonymous) (board.ts:12)');
  expect(placeOf(trace())).toBe('(no JavaScript: garbage collection or the runtime itself)');
});

test('a stall names where its samples were, by share, and the processes it waited for', () => {
  const git = trace(native('spawnSync'), at('git', 'workspaces.ts', 77), at('hasWork', 'workspaces.ts', 900));
  const json = trace(native('stringify'), at('snapshot', 'board.ts', 2401));
  expect(describeStall(2400, [...times(900, git), ...times(300, json)], [{ argv: ['/usr/bin/git', '-C', '/repo', 'status', '--porcelain'], ms: 1800 }], 2)).toEqual([
    'Obeya: the server stalled for 2.4 s; meanwhile it answered no page and heard no agent',
    '   75% spawnSync ← git (workspaces.ts:77) ← hasWork (workspaces.ts:900)',
    '   25% stringify ← snapshot (board.ts:2401)',
    '  waited 1.8 s for: git -C /repo status --porcelain',
  ]);
});

test('a pause the thread did not run in is no stall: the machine slept', () => {
  expect(describeStall(30_000, times(5, trace(native('spawnSync'))), [], 2)).toBeNull();
  // a few samples on either side of the pause: its gap is no interval they were taken at
  const around = [0, 0.002, 30].map((timestamp) => ({ ...trace(native('spawnSync')), timestamp }));
  expect(describeStall(30_000, around, [], 2)).toBeNull();
  // a process that ran while the machine slept: where the profiler samples meanwhile, its samples say whether the server ran
  const sleptThrough = [{ argv: ['git', 'fetch'], ms: 30_000 }];
  expect(describeStall(30_000, around, sleptThrough, 2, false)).toBeNull();
  // where it takes none while the thread waits (Windows), the wait is all there is to go by
  expect(describeStall(30_000, around, sleptThrough, 2, true)).not.toBeNull();
  // and samples only as often as Windows' timer allows still cover the time they were taken in
  const coarse = Array.from({ length: 60 }, (_, i) => ({ ...trace(native('stringify')), timestamp: i * 0.0156 }));
  expect(describeStall(900, coarse, [], 2)).not.toBeNull();
  // without a profiler to ask, the length is all there is
  expect(describeStall(800, null, [])).toEqual(['Obeya: the server stalled for 0.8 s; meanwhile it answered no page and heard no agent']);
});

test('a page’s stall is logged with where its time went and what it took in before; the server takes no more than it logs', () => {
  expect(pageStall({ type: 'stall', ms: 300, scripts: [], before: [] })).toBeNull();
  expect(pageStall({ ms: 'long' })).toBeNull();
  const s = pageStall({ type: 'stall', ms: 1300, scripts: [{ what: 'x'.repeat(500), ms: 900 }, { what: 3, ms: 1 }], before: ['snapshot (412 KB) 0.2 s before', 7], extra: true })!;
  expect(s).toEqual({ ms: 1300, scripts: [{ what: 'x'.repeat(200), ms: 900 }], before: ['snapshot (412 KB) 0.2 s before'] });
  // a line of its own, and nothing a terminal takes for a command, are not the page's to write
  expect(pageStall({ ms: 900, scripts: [{ what: 'a\nObeya: forged\u001b[2J', ms: -5 }, { what: 'b', ms: 1e309 }, { what: 'c\u2028d', ms: 600 }], before: ['x\ry'] })).toEqual({ ms: 900, scripts: [{ what: 'c d', ms: 600 }], before: ['x y'] });
  expect(pageStall({ ms: 1e309, scripts: [], before: [] })).toBeNull();
  // what it ran in, as far as it is what the page may say
  expect(pageStall({ ms: 900, scripts: [], before: [], browser: 'Safari 26\nObeya: forged', active: true, usedMs: 9 * 3600_000 })).toEqual({ ms: 900, scripts: [], before: [], browser: 'Safari 26 Obeya: forged', active: true, usedMs: 9 * 3600_000 });
  expect(pageStall({ ms: 900, scripts: [], before: [], browser: 7, active: 'yes', usedMs: -1 })).toEqual({ ms: 900, scripts: [], before: [] });
  expect(describePageStall({ ms: 1300, scripts: [{ what: 'WebSocket.onmessage: (anonymous) (index.js@1204)', ms: 1100 }], before: ['snapshot (412 KB) 0.2 s before'] }, 'this machine, canvas main')).toEqual([
    'Obeya: a page (this machine, canvas main) stalled for 1.3 s; meanwhile it took no click or key',
    '  1.1 s WebSocket.onmessage: (anonymous) (index.js@1204)',
    '  before it: snapshot (412 KB) 0.2 s before',
  ]);
  // and what it ran in: whether its window was in use, and when the owner last used it
  const ran = { ms: 700, scripts: [], before: [], browser: 'Obeya app on macOS' };
  expect(describePageStall({ ...ran, active: true, usedMs: 2400 }, 'this machine, canvas main')[0]).toBe(
    'Obeya: a page (this machine, canvas main; Obeya app on macOS, its window active, last used 2 s before) stalled for 0.7 s; meanwhile it took no click or key',
  );
  expect(describePageStall({ ...ran, browser: 'Chrome 142', active: false, usedMs: 25 * 60_000 }, 'Pixel, canvas main')[0]).toBe(
    'Obeya: a page (Pixel, canvas main; Chrome 142, its window in the background, last used 25 min before) stalled for 0.7 s; meanwhile it took no click or key',
  );
  expect(describePageStall({ ...ran, active: true }, 'this machine, canvas main')[0]).toContain('(this machine, canvas main; Obeya app on macOS, its window active, not used since it loaded)');
});

let home: string | undefined;
let stalls: Stalls | undefined;
afterEach(() => {
  stalls?.stop();
  if (home) rmSync(home, { recursive: true, force: true });
});

test('a stall the ticks see short is as long as its samples span', () => {
  const lines: string[] = [];
  home = mkdtempSync(join(tmpdir(), 'obeya-stalls-'));
  const stalls = new Stalls({ home, log: (l) => lines.push(l) });
  const samples = (spanS: number) => ({ traces: Array.from({ length: 280 }, (_, i) => ({ timestamp: (i * spanS) / 279, frames: [at('render', 'board.ts', 9)] })), intervalMs: 2 });
  // late by 560 ms: up to 100 ms of it may have come before the stall began
  stalls.tick(0, 560, samples(0.45));
  expect(lines).toEqual([]);
  stalls.tick(0, 560, samples(0.54));
  expect(lines[0]).toBe('Obeya: the server stalled for 0.5 s; meanwhile it answered no page and heard no agent');
});

test('a stall the machine paged the server back in for says so in its first line, with the counts beneath', () => {
  const lines: string[] = [];
  home = mkdtempSync(join(tmpdir(), 'obeya-stalls-'));
  stalls = new Stalls({ home, log: (l) => lines.push(l) });
  const read = trace(native('all'), at('shares', 'share.ts', 140));
  const samples = { traces: Array.from({ length: 450 }, (_, i) => ({ ...read, timestamp: i * 0.002 })), intervalMs: 2 };
  stalls.tick(0, 1000, samples, { pageIns: 4200, preempted: 35 });
  expect(lines).toEqual([
    'Obeya: the server stalled for 0.9 s; meanwhile it answered no page and heard no agent; the machine paged the server back in: 4,200 pages',
    '  100% all ← shares (share.ts:140)',
    '  meanwhile: 4,200 pages read back from disk or swap, 35 involuntary context switches',
  ]);
  // a few pages are counted, not called the cause
  lines.length = 0;
  stalls.tick(0, 1000, samples, { pageIns: 12 });
  expect(lines).toEqual(['Obeya: the server stalled for 0.9 s; meanwhile it answered no page and heard no agent', '  100% all ← shares (share.ts:140)', '  meanwhile: 12 pages read back from disk or swap']);
  // without page-ins, and where the platform counts no context switches as such, the entry reads as before
  lines.length = 0;
  stalls.tick(0, 1000, samples, { pageIns: 0 });
  stalls.tick(0, 1000, samples, {});
  expect(lines).toEqual(Array.from({ length: 2 }, () => ['Obeya: the server stalled for 0.9 s; meanwhile it answered no page and heard no agent', '  100% all ← shares (share.ts:140)']).flat());
  expect(readFileSync(join(home, STALLS_FILE), 'utf8')).toContain('the machine paged the server back in: 4,200 pages\n');
});

test('the counts are taken where the platform counts them as such', () => {
  const usage = () => ({ majorPageFault: 40, involuntaryContextSwitches: 900 }) as NodeJS.ResourceUsage;
  expect(heldSoFar('linux', usage)).toEqual({ pageIns: 40, preempted: 900 });
  // macOS counts every context switch as involuntary
  expect(heldSoFar('darwin', usage)).toEqual({ pageIns: 40 });
  // Windows counts soft page faults with the hard ones, and no context switches
  expect(heldSoFar('win32', usage)).toEqual({});
});

test('a page that stalls again and again the same way gets one entry, and the stalls like it are counted in one line', () => {
  const lines: string[] = [];
  home = mkdtempSync(join(tmpdir(), 'obeya-stalls-'));
  stalls = new Stalls({ home, log: (l) => lines.push(l) });
  const t = 1_000_000;
  const where = 'this machine, canvas main';
  // one a second, as a page whose length is all the browser tells
  for (let i = 0; i < 120; i++) stalls.page({ ms: 700 + (i % 5) * 100, scripts: [], before: [] }, where, 'p1', t + i * 1000);
  // another page, and a stall of this one that went elsewhere, are logged on their own
  stalls.page({ ms: 900, scripts: [], before: [] }, 'Pixel, canvas main', 'p2', t + 30_000);
  // as another window on the same canvas
  stalls.page({ ms: 900, scripts: [], before: [] }, where, 'p3', t + 35_000);
  stalls.page({ ms: 1300, scripts: [{ what: 'WebSocket.onmessage: (anonymous) (index.js@1204)', ms: 1100 }], before: [] }, where, 'p1', t + 40_000);
  expect(lines).toEqual([
    'Obeya: a page (this machine, canvas main) stalled for 0.7 s; meanwhile it took no click or key',
    'Obeya: a page (Pixel, canvas main) stalled for 0.9 s; meanwhile it took no click or key',
    'Obeya: a page (this machine, canvas main) stalled for 0.9 s; meanwhile it took no click or key',
    'Obeya: a page (this machine, canvas main) stalled for 1.3 s; meanwhile it took no click or key',
    '  1.1 s WebSocket.onmessage: (anonymous) (index.js@1204)',
  ]);
  // a minute without one like them ends the run
  stalls.flush(t + 178_000);
  expect(lines.length).toBe(5);
  stalls.flush(t + 179_000);
  expect(lines.slice(5)).toEqual([expect.stringMatching(/^Obeya: a page \(this machine, canvas main\) stalled 119 more times in 119 s like the one logged at \d{4}-\d\d-\d\dT[\d:.]+Z, for 0\.7–1\.1 s each$/)]);
  // the next one starts a run of its own
  stalls.page({ ms: 800, scripts: [], before: [] }, where, 'p1', t + 200_000);
  expect(lines.length).toBe(7);
  const file = readFileSync(join(home, STALLS_FILE), 'utf8');
  expect(file).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\nObeya: a page \(this machine, canvas main\) stalled for 0\.7 s/);
  expect(file).toContain('stalled 119 more times');
});

test('a run that goes on all night is logged once an hour', () => {
  const lines: string[] = [];
  home = mkdtempSync(join(tmpdir(), 'obeya-stalls-'));
  stalls = new Stalls({ home, log: (l) => lines.push(l) });
  const t = 1_000_000;
  for (let i = 0; i < 3 * 3600; i++) stalls.page({ ms: 900, scripts: [], before: [] }, 'this machine, canvas main', 'p1', t + i * 1000);
  const first = readFileSync(join(home, STALLS_FILE), 'utf8').split('\n')[0];
  const run = (n: number) => `Obeya: a page (this machine, canvas main) stalled ${n} more times in 60 min like the one logged at ${first}, for 0.9 s each`;
  expect(lines.slice(1)).toEqual([run(3599), run(3600)]);
  // stopped, the server logs what it counted so far
  stalls.stop();
  expect(lines.at(-1)).toBe(run(3600));
});

test('a synchronous process that holds the server up goes into the log and stalls.log, by its command and the code that ran it', async () => {
  home = mkdtempSync(join(tmpdir(), 'obeya-stalls-'));
  const lines: string[] = [];
  const found = Bun.spawnSync;
  stalls = new Stalls({ home, log: (line) => lines.push(line) }).start();
  await Bun.sleep(150);
  function landOnMain() {
    return Bun.spawnSync(['sleep', '0.7']).exitCode;
  }
  expect(landOnMain()).toBe(0);
  await until(() => lines.length > 0);
  expect(lines[0]).toMatch(/^Obeya: the server stalled for 0\.\d s/);
  expect(lines.some((l) => /% spawnSync ← .*stalls\.test\.ts:\d+/.test(l))).toBe(true);
  expect(lines.some((l) => /^  waited 0\.\d s for: sleep 0\.7$/.test(l))).toBe(true);
  const file = readFileSync(join(home, STALLS_FILE), 'utf8');
  expect(file).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\nObeya: the server stalled/);
  expect(file).toContain('for: sleep 0.7');
  // stopped, it leaves the spawnSync it found behind (Bun's own, or one that starts one process at a time on Windows)
  stalls.stop();
  expect(Bun.spawnSync).toBe(found);
  // the profiler runs on, and a watcher started anew gets the samples of its own stalls
  lines.length = 0;
  stalls = new Stalls({ home, log: (line) => lines.push(line) }).start();
  await Bun.sleep(150);
  const t = performance.now();
  while (performance.now() - t < 700);
  await until(() => lines.length > 0);
  expect(lines.some((l) => /% \(anonymous\) \(stalls\.test\.ts:\d+\)/.test(l))).toBe(true);
});
