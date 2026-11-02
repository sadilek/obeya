import { expect, test } from 'bun:test';
import { hidden, hideConsoleWindows, spawnOutput } from './spawn';

test('dozens of processes asked for at once start a few at a time, with turns of the event loop between', async () => {
  const spawn = Bun.spawn;
  let started = 0;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    started++;
    return spawn(...args);
  }) as typeof Bun.spawn;
  try {
    const all = Array.from({ length: 20 }, () => spawnOutput([process.execPath, '--version']));
    // the first ones at once, as a caller expects of a process it started
    expect(started).toBe(4);
    await new Promise((go) => setImmediate(go));
    expect(started).toBeLessThanOrEqual(8);
    const done = await Promise.all(all);
    expect(started).toBe(20);
    expect(done.every((r) => r.code === 0 && r.stdout.trim() === Bun.version)).toBe(true);
  } finally {
    Bun.spawn = spawn;
  }
});

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
