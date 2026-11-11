import { describe, expect, test } from 'bun:test';
import { Awake, type Held, platformHold } from './awake';
import { until } from './testing';

/** A fake assertion and a clock: what was taken, what was let go. */
function fake() {
  const o = { now: 0, wanted: false, taken: 0, released: 0, alive: true, lines: [] as string[] };
  const awake = new Awake({
    wanted: () => o.wanted,
    hold: (): Held => {
      o.taken++;
      o.alive = true;
      return { release: () => o.released++, alive: () => o.alive, why: () => 'it ended' };
    },
    lingerMs: 120_000,
    now: () => o.now,
    log: (line) => o.lines.push(line),
  });
  return { o, awake };
}

describe('Awake', () => {
  test('holds while wanted, and lets go a while after the last turn ended', () => {
    const { o, awake } = fake();
    awake.check();
    expect(o.taken).toBe(0);
    o.wanted = true;
    awake.check();
    awake.check();
    expect(o.taken).toBe(1);
    expect(awake.holding()).toBe(true);
    o.wanted = false;
    o.now = 119_000;
    awake.check();
    expect(o.released).toBe(0);
    // a turn that starts within the while keeps the one assertion
    o.wanted = true;
    awake.check();
    o.wanted = false;
    o.now = 200_000;
    awake.check();
    expect(o.released).toBe(0);
    o.now = 239_000;
    awake.check();
    expect([o.taken, o.released]).toEqual([1, 1]);
    expect(awake.holding()).toBe(false);
  });

  test('an assertion that stopped holding is logged and tried again only after a while', () => {
    const { o, awake } = fake();
    o.wanted = true;
    awake.check();
    o.alive = false;
    o.now = 5_000;
    awake.check();
    expect(o.taken).toBe(1);
    expect(o.lines.at(-1)).toContain('could not keep this machine awake: it ended');
    o.now = 5_000 + 5 * 60_000;
    awake.check();
    expect(o.taken).toBe(2);
  });

  test('stop lets go at once', () => {
    const { o, awake } = fake();
    o.wanted = true;
    awake.start();
    awake.stop();
    expect([o.taken, o.released]).toEqual([1, 1]);
  });

  test('without a way to hold, nothing happens', () => {
    const awake = new Awake({ wanted: () => true, hold: null, log: () => {} });
    awake.check();
    expect(awake.holding()).toBe(false);
  });

  test('no platform but the three knows how', () => {
    expect(platformHold('freebsd')).toBeNull();
  });
});

describe.if(process.platform === 'darwin')('on macOS', () => {
  const assertions = () => Bun.spawnSync(['pmset', '-g', 'assertions']).stdout.toString();

  test('pmset shows the assertion while it holds, and not after', async () => {
    const held = platformHold('darwin')!();
    const pid = Bun.spawnSync(['pgrep', '-P', String(process.pid), 'caffeinate']).stdout.toString().trim();
    expect(pid).not.toBe('');
    await until(() => new RegExp(`pid ${pid}\\(caffeinate\\).*PreventUserIdleSystemSleep`).test(assertions()), 5000);
    held.release();
    await until(() => !held.alive(), 5000);
    await until(() => !assertions().includes(`pid ${pid}(caffeinate)`), 5000);
  });
});
