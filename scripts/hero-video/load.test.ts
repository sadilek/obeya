import { expect, test } from 'bun:test';
import { BUSY, busiest, busyShare, type Load, reasons, swappedOf, warning } from './load.ts';

const times = (busy: number, idle: number) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });
const quietMachine: Load = { cpu: 0.2, cores: 14, swap: 0, pressure: 1 };

test('the busy share counts every core between two readings', () => {
  // one core fully busy, one idle, over the same span
  expect(busyShare([times(100, 100), times(100, 100)], [times(200, 100), times(100, 200)])).toBe(0.5);
  expect(busyShare([times(0, 0)], [times(0, 0)])).toBe(0);
});

test('swap traffic is read from macOS’s and Linux’s counters', () => {
  const vmStat = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPageouts:     38174.\nSwapins:      10.\nSwapouts:     30.\n';
  expect(swappedOf(vmStat, 16384, /^Swap(?:ins|outs):\s+(\d+)/gm)).toBe(40 * 16384);
  expect(swappedOf('pswpin 3\npswpout 5\n', 4096, /^pswp(?:in|out) (\d+)/gm)).toBe(8 * 4096);
  expect(swappedOf('nothing here', 4096, /^pswp(?:in|out) (\d+)/gm)).toBeUndefined();
});

test('the busiest processes are summed by name, the small ones left out', () => {
  const ps = ['  60.0 /usr/bin/claude', '  45.5 /opt/claude', ' 100.0 /System/fseventsd', '   3.0 /bin/zsh', '  12.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ''].join('\n');
  expect(busiest(ps, 10)).toEqual([
    { name: 'claude', value: 105.5 },
    { name: 'fseventsd', value: 100 },
    { name: 'Google Chrome', value: 12 },
  ]);
});

test('a quiet machine has no reason against a take, one short of memory or cores has', () => {
  expect(reasons(quietMachine)).toEqual([]);
  // nothing measured where the system doesn't tell
  expect(reasons({ cpu: 0.2, cores: 8 })).toEqual([]);
  expect(reasons({ ...quietMachine, pressure: 2 }).map((r) => r.kind)).toEqual(['memory']);
  expect(reasons({ ...quietMachine, swap: 200 * 2 ** 20 }).map((r) => r.text)).toEqual(['it swaps 200 MB a second (more than 10 MB)']);
  expect(reasons({ ...quietMachine, cpu: BUSY + 0.05 }).map((r) => r.kind)).toEqual(['cpu']);
});

test('the warning names why, what uses the memory or the cores, and how to go on', () => {
  const load: Load = { ...quietMachine, pressure: 4, ps: { cpu: ' 640.0 /bin/bun\n', memory: ' 18874368 /opt/python3.12\n 2097152 /bin/bun\n 1000 /bin/zsh\n' } };
  const text = warning(load, reasons(load));
  expect(text).toContain('memory pressure is critical');
  expect(text).toContain('Using the most memory: python3.12 18.0 GB, bun 2.0 GB');
  // the cores were not the reason: no CPU list
  expect(text).not.toContain('CPU');
  expect(text).toContain('--ignore-load');
});
