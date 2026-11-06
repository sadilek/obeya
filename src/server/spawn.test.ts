import { expect, test } from 'bun:test';
import { hidden, hideConsoleWindows, onStart, spawnOutput } from './spawn';

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
