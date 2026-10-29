import { expect, test } from 'bun:test';
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { Usage } from '../core/types';
import { UsageMeter, type UsageSource, usageOf } from './usage';

const AT = new Date('2026-10-28T08:00:00Z');
const answer = (rateLimits: Record<string, unknown> | null, available = true) =>
  ({ session: {}, subscription_type: available ? 'max' : null, rate_limits_available: available, rate_limits: rateLimits, behaviors: null }) as unknown as SDKControlGetUsageResponse;

test('the endpoint’s meters as it sends them, a scoped one with what it is for', () => {
  const usage = usageOf(
    answer({
      five_hour: { utilization: 3, resets_at: '2026-10-28T10:40:00Z' },
      limits: [
        { kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: '2026-10-28T10:40:00Z', scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 81, severity: 'warning', resets_at: '2026-11-02T19:00:00Z', scope: null, is_active: true },
        { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: null, scope: { model: { display_name: 'Fable', id: null }, surface: null } },
        { kind: 'broken' },
      ],
    }),
    AT,
  );
  expect(usage).toEqual({
    at: AT.toISOString(),
    limits: [
      { kind: 'session', group: 'session', percent: 3, resetsAt: '2026-10-28T10:40:00Z', severity: 'normal' },
      { kind: 'weekly_all', group: 'weekly', percent: 81, resetsAt: '2026-11-02T19:00:00Z', severity: 'warning' },
      { kind: 'weekly_scoped', group: 'weekly', scope: 'Fable', percent: 0, severity: 'normal' },
    ],
  });
});

test('from a Claude Code that passes no meters on: its five-hour, weekly and per-model windows', () => {
  const usage = usageOf(
    answer({
      five_hour: { utilization: 12, resets_at: '2026-10-28T10:40:00Z' },
      seven_day: { utilization: 40, resets_at: null },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: '2026-11-02T19:00:00Z' }],
    }),
    AT,
  );
  expect(usage!.limits).toEqual([
    { kind: 'session', group: 'session', percent: 12, resetsAt: '2026-10-28T10:40:00Z', severity: 'normal' },
    { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal' },
    { kind: 'weekly_scoped', group: 'weekly', scope: 'Fable', percent: 5, resetsAt: '2026-11-02T19:00:00Z', severity: 'normal' },
  ]);
});

test('a login without plan limits has none to show', () => {
  expect(usageOf(answer(null, false))).toBeNull();
  expect(usageOf(answer({ limits: [] }, false))).toBeNull();
});

/** A source that answers what it is given, counting how often it was opened and closed. */
function fakeSource() {
  const answers: (Usage | null | Error)[] = [];
  const counts = { opened: 0, closed: 0, fetched: 0 };
  const open = (): UsageSource => {
    counts.opened++;
    return {
      fetch: async () => {
        counts.fetched++;
        const a = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (a instanceof Error) throw a;
        return a;
      },
      close: () => void counts.closed++,
    };
  };
  return { answers, counts, open };
}
const usage = (percent: number, at = new Date().toISOString()): Usage => ({ at, limits: [{ kind: 'session', group: 'session', percent, severity: 'normal' }] });
const settle = () => new Promise((r) => setTimeout(r, 5));

test('fetched only while the bar shows them and a page is open; closed and forgotten once neither holds', async () => {
  const f = fakeSource();
  f.answers.push(usage(4));
  const meter = new UsageMeter(f.open, { on: true, everyMs: 60_000, lingerMs: 0 });
  let changes = 0;
  meter.onChange(() => changes++);
  await settle();
  expect(f.counts.opened).toBe(0);
  const page = meter.watch();
  await settle();
  expect(meter.current()!.limits[0]!.percent).toBe(4);
  expect(changes).toBe(1);
  // a second page asks the same session, not a new one
  const other = meter.watch();
  await meter.refresh();
  expect(f.counts.opened).toBe(1);
  page();
  page();
  other();
  await settle();
  expect(f.counts.closed).toBe(1);
  expect(meter.current()).toBeNull();
  // turned off, an open page fetches nothing
  meter.setOn(false);
  const again = meter.watch();
  await settle();
  expect(f.counts.opened).toBe(1);
  expect(meter.current()).toBeNull();
  meter.setOn(true);
  await settle();
  expect(meter.current()!.limits[0]!.percent).toBe(4);
  again();
  meter.stop();
});

test('a page that reloads or goes to another canvas finds the session and its numbers still there', async () => {
  const f = fakeSource();
  f.answers.push(usage(4));
  const meter = new UsageMeter(f.open, { on: true, everyMs: 60_000, lingerMs: 30 });
  const page = meter.watch();
  await settle();
  page();
  await settle();
  expect(meter.current()!.limits[0]!.percent).toBe(4);
  const next = meter.watch();
  await new Promise((r) => setTimeout(r, 50));
  expect(meter.current()!.limits[0]!.percent).toBe(4);
  expect(f.counts.opened).toBe(1);
  expect(f.counts.closed).toBe(0);
  // with no page left after the while, the session closes and the numbers are forgotten
  next();
  await new Promise((r) => setTimeout(r, 50));
  expect(f.counts.closed).toBe(1);
  expect(meter.current()).toBeNull();
  meter.stop();
});

test('a source that fails is closed and a new one asked next round; what it fetched stands a few minutes', async () => {
  const f = fakeSource();
  f.answers.push(usage(4), new Error('gone'), usage(6, new Date(Date.now() - 10 * 60_000).toISOString()), new Error('gone again'));
  const meter = new UsageMeter(f.open, { on: true, everyMs: 60_000 });
  const page = meter.watch();
  await settle();
  await meter.refresh();
  expect(f.counts.closed).toBe(1);
  expect(meter.current()!.limits[0]!.percent).toBe(4);
  await meter.refresh();
  expect(f.counts.opened).toBe(2);
  expect(meter.current()!.limits[0]!.percent).toBe(6);
  // a failure after numbers this old takes them away
  await meter.refresh();
  expect(meter.current()).toBeNull();
  page();
  meter.stop();
});

test('a source that keeps failing is tried after more and more rounds', async () => {
  const f = fakeSource();
  f.answers.push(new Error('unknown control request'));
  const meter = new UsageMeter(f.open, { on: true, everyMs: 5 });
  const page = meter.watch();
  await new Promise((r) => setTimeout(r, 120));
  page();
  meter.stop();
  // about two dozen rounds: tried in the first two, the fourth, the eighth, the sixteenth
  expect(f.counts.fetched).toBeGreaterThanOrEqual(2);
  expect(f.counts.fetched).toBeLessThanOrEqual(6);
});
