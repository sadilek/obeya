import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endThreads, forTests, hidden, hideConsoleWindows, onStart, spawnOutput } from './spawn';
import { PATIENCE, removeDir } from './testing';

// first in the file: after other tests have run, Bun no longer shows the wait this test is about
test('what a thread answers settles for expect(…).rejects and .resolves too, not only for await', async () => {
  await spawnOutput([process.execPath, '--version']);
  await expect(spawnOutput([process.execPath, '-e', 'process.exit(4)']).then((r) => r.code)).resolves.toBe(4);
  await expect(spawnOutput([process.execPath, '--version']).then(() => Promise.reject(new Error('expected')))).rejects.toThrow('expected');
  await expect(spawnOutput(['obeya-no-such-program'])).rejects.toThrow();
}, 10_000);

test("processes start on threads of their own: the server's thread starts none of them", async () => {
  const spawn = Bun.spawn;
  let started = 0;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    started++;
    return spawn(...args);
  }) as typeof Bun.spawn;
  const told: string[][] = [];
  const stop = onStart((argv) => told.push(argv));
  try {
    const all = await Promise.all(Array.from({ length: 20 }, () => spawnOutput([process.execPath, '--version'])));
    expect(all.every((r) => r.code === 0 && r.stdout.trim() === Bun.version && r.signal === null)).toBe(true);
    expect(started).toBe(0);
    expect(told.length).toBe(20);
  } finally {
    stop();
    Bun.spawn = spawn;
  }
});

test('a process on a thread of its own gets what the server gives it: directory, environment, input, a timeout', async () => {
  const script = (code: string, o: Parameters<typeof spawnOutput>[1] = {}) => spawnOutput([process.execPath, '-e', code], o);
  const dir = (await script('console.log(process.cwd())', { cwd: import.meta.dir })).stdout.trim();
  expect(dir).toBe(import.meta.dir);
  expect((await script('console.log(process.env.OBEYA_SPAWN_TEST)', { env: { ...process.env, OBEYA_SPAWN_TEST: 'given' } })).stdout.trim()).toBe('given');
  // without an environment of its own, the server's as it is now
  process.env.OBEYA_SPAWN_TEST = 'now';
  try {
    expect((await script('console.log(process.env.OBEYA_SPAWN_TEST)')).stdout.trim()).toBe('now');
  } finally {
    delete process.env.OBEYA_SPAWN_TEST;
  }
  const echo = 'process.stdout.write(await Bun.stdin.text())';
  expect((await script(echo, { stdin: new Blob(['from a ', 'blob']) })).stdout).toBe('from a blob');
  expect((await script(echo, { stdin: Buffer.from('from a buffer') })).stdout).toBe('from a buffer');
  const failed = await script('console.error("wrong"); process.exit(3)');
  expect([failed.code, failed.stderr.trim()]).toEqual([3, 'wrong']);
  const slow = await script('await Bun.sleep(10_000)', { timeout: 200 });
  expect(slow.signal).not.toBeNull();
  expect(await spawnOutput(['obeya-no-such-program']).then(() => null, (e: unknown) => e)).toBeInstanceOf(Error);
}, 30_000);

// Windows alone: elsewhere no process inherits another's pipes, and there is no lock to test
test.skipIf(process.platform !== 'win32')('a process started next to slow ones, on a thread or the server’s, ends as quickly as it would alone', async () => {
  // a start takes turns with 24 others, each slow on a busy machine; the slow ones run twice as
  // long, and the test waits for them
  const quick = 3000 * PATIENCE;
  const slow: Promise<unknown>[] = [];
  const quicks: Promise<number>[] = [];
  const timed = async (p: () => Promise<unknown> | unknown) => {
    const t = performance.now();
    await p();
    return performance.now() - t;
  };
  for (let i = 0; i < 8; i++) {
    slow.push(spawnOutput([process.execPath, '-e', `await Bun.sleep(${2 * quick})`], { timeout: 2 * quick }));
    quicks.push(timed(() => spawnOutput([process.execPath, '--version'])));
    // while the threads start theirs: the slow ones would hold its output open until they end
    quicks.push(timed(() => Bun.spawnSync([process.execPath, '--version'], { stdout: 'pipe' })));
    await Bun.sleep(1);
  }
  expect(Math.max(...(await Promise.all(quicks)))).toBeLessThan(quick);
  await Promise.all(slow);
}, 4 * 3000 * PATIENCE + 10_000);

test('a start waiting for the lock takes it over from a holder that has kept it too long, and only then', () => {
  const { acquire, release } = forTests;
  const lock = new Int32Array(new SharedArrayBuffer(12));
  const holder = () => lock[0]! & 0xff;
  expect(acquire(lock, 2, 100)).toBe(0);
  // given back only by whoever holds it
  release(lock, 3);
  expect(holder()).toBe(2);
  let t = performance.now();
  expect(acquire(lock, 3, 100)).toBe(2);
  expect(performance.now() - t).toBeGreaterThanOrEqual(90);
  expect(holder()).toBe(3);
  // the server's thread too, and it lets the threads wait again afterwards
  expect(acquire(lock, 1, 50)).toBe(3);
  expect([holder(), lock[1]]).toEqual([1, 0]);
  release(lock, 1);
  expect(lock[0]).toBe(0);
  // a holder that gave it back and took it anew holds it afresh: the wait starts over
  acquire(lock, 2, 100);
  const first = lock[0];
  release(lock, 2);
  acquire(lock, 2, 100);
  expect(lock[0]).not.toBe(first);
  t = performance.now();
  expect(acquire(lock, 3, 100)).toBe(2);
  expect(performance.now() - t).toBeGreaterThanOrEqual(90);
});

test('a thread that dies while its process runs fails that call without starting it again; the next call gets a thread anew', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-spawn-'));
  try {
    const log = join(dir, 'started');
    // a thread of its own, for which this process is the first
    await endThreads();
    const running = spawnOutput([process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(log)}, 'x'); await Bun.sleep(5000)`]);
    const t0 = Date.now();
    while (!readFileSync(log, { flag: 'a+' }).length && Date.now() - t0 < 5000) await Bun.sleep(20);
    await endThreads();
    await expect(running).rejects.toThrow(/thread/);
    // started a second time, it would have written at once
    await Bun.sleep(500);
    expect(readFileSync(log, 'utf8')).toBe('x');
    // and the next one on a thread again, not on the server's
    const spawn = Bun.spawn;
    let here = 0;
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => (here++, spawn(...args))) as typeof Bun.spawn;
    try {
      expect((await spawnOutput([process.execPath, '--version'])).stdout.trim()).toBe(Bun.version);
    } finally {
      Bun.spawn = spawn;
    }
    expect(here).toBe(0);
  } finally {
    await removeDir(dir);
  }
}, 15_000);

test('programs started on Windows run without a window, unless the call asks for one', () => {
  expect(hidden([['git', 'status'], { cwd: '/repo' }])).toEqual([['git', 'status'], { cwd: '/repo', windowsHide: true }]);
  expect(hidden([['git', 'status']])).toEqual([['git', 'status'], { windowsHide: true }]);
  expect(hidden([{ cmd: ['git'], stdout: 'pipe' }])).toEqual([{ cmd: ['git'], stdout: 'pipe', windowsHide: true }]);
  // node's child_process says false itself where its caller gave nothing: Explorer, a terminal to log in
  expect(hidden([['explorer.exe'], { windowsHide: false }])).toEqual([['explorer.exe'], { windowsHide: false }]);

  const { spawn, spawnSync } = Bun;
  const seen: unknown[] = [];
  Bun.spawn = ((...args: unknown[]) => seen.push(args)) as unknown as typeof Bun.spawn;
  Bun.spawnSync = ((...args: unknown[]) => seen.push(args)) as unknown as typeof Bun.spawnSync;
  try {
    hideConsoleWindows('darwin');
    Bun.spawn(['git', 'status']);
    hideConsoleWindows('win32');
    Bun.spawn(['git', 'status'], { stdout: 'pipe' });
    Bun.spawnSync(['git', 'status']);
    expect(seen).toEqual([[['git', 'status']], [['git', 'status'], { stdout: 'pipe', windowsHide: true }], [['git', 'status'], { windowsHide: true }]]);
  } finally {
    Bun.spawn = spawn;
    Bun.spawnSync = spawnSync;
  }
});
