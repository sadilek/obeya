import { expect, test } from 'bun:test';
import type { UsageLimit } from '../core/types';
import { headline, stacked } from './usage';

const limit = (kind: string, group: string, percent: number): UsageLimit => ({ kind, group, percent, severity: 'normal' });

test('the bar shows one limit per group: the one most used', () => {
  const session = limit('session', 'session', 12);
  const all = limit('weekly_all', 'weekly', 30);
  const fable = limit('weekly_scoped', 'weekly', 64);
  expect(headline([session, all, fable])).toEqual([session, fable]);
  // on a tie the first
  expect(headline([all, { ...fable, percent: 30 }])).toEqual([all]);
});

test('the bar stacks the session above the week, leaving the place of a missing one empty', () => {
  const session = limit('session', 'session', 12);
  const all = limit('weekly_all', 'weekly', 30);
  expect(stacked([all, session])).toEqual([session, all]);
  expect(stacked([all])).toEqual([null, all]);
  const other = limit('monthly', 'monthly', 5);
  expect(stacked([session, other])).toEqual([session, null, other]);
});
