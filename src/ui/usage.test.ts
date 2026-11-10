import { expect, test } from 'bun:test';
import type { UsageLimit } from '../core/types';
import { countdown } from './strings';
import { elapsed } from './usage';

const HOUR = 3600_000;
const now = Date.parse('2026-11-10T12:00:00Z');
const limit = (group: string, resetsIn?: number): UsageLimit => ({
  kind: group,
  group,
  percent: 10,
  severity: 'normal',
  ...(resetsIn === undefined ? {} : { resetsAt: new Date(now + resetsIn).toISOString() }),
});

test("how much of a limit's window has gone by", () => {
  // an hour of the five-hour session gone: 20 %
  expect(elapsed(limit('session', 4 * HOUR), now)).toBeCloseTo(20);
  // a day and a half of the week left
  expect(elapsed(limit('weekly', 42 * HOUR), now)).toBeCloseTo(75);
  // a reset already past, or further off than a window: held to the meter's ends
  expect(elapsed(limit('session', -HOUR), now)).toBe(100);
  expect(elapsed(limit('session', 6 * HOUR), now)).toBe(0);
  // no reset, or a window of unknown length: no mark
  expect(elapsed(limit('session'), now)).toBeUndefined();
  expect(elapsed(limit('monthly', HOUR), now)).toBeUndefined();
});

test('the time until a reset, in its two largest units', () => {
  expect(countdown(6 * 24 * HOUR + 14 * HOUR + 5 * 60_000)).toBe('6 Tage 14 Std.');
  expect(countdown(24 * HOUR)).toBe('1 Tag');
  expect(countdown(3 * HOUR + 12 * 60_000)).toBe('3 Std. 12 Min.');
  expect(countdown(41 * 60_000 + 10_000)).toBe('42 Min.');
  expect(countdown(5_000)).toBe('1 Min.');
});
