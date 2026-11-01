import { expect, test } from 'bun:test';
import type { InboxEntry } from '../core/inbox';
import { quickReplies } from './inbox';

const entry = (over: Partial<InboxEntry>): InboxEntry => ({ canvas: 'c', canvasName: 'C', card: 'x', title: 'T', kind: 'question', text: '', since: '2026-10-29T09:00:00Z', ...over });

test('a handover has approval as its one primary button', () => {
  const r = quickReplies(entry({ kind: 'demo' }));
  expect(r.map((x) => [x.action, !!x.primary])).toEqual([[{ action: 'approve' }, true]]);
});

test('options answer the question; only the agent’s pick is primary', () => {
  const r = quickReplies(entry({ options: ['A', 'B'], pick: 'B' }));
  expect(r.map((x) => [x.label, !!x.primary])).toEqual([['A', false], ['B', true]]);
  expect(r[0]!.action).toMatchObject({ action: 'answer', picks: ['A'] });
  expect(quickReplies(entry({ options: ['A', 'B'] })).some((x) => x.primary)).toBe(false);
});

test('a proposal is accepted or dismissed, but not accepted blind when it asks', () => {
  expect(quickReplies(entry({ kind: 'proposal' })).map((x) => x.action.action)).toEqual(['accept', 'dismiss']);
  expect(quickReplies(entry({ kind: 'proposal', asks: true })).map((x) => x.action.action)).toEqual(['dismiss']);
});

test('what only the card can settle has no quick reply', () => {
  for (const kind of ['idea', 'pr', 'obeya', 'question'] as const) expect(quickReplies(entry({ kind }))).toEqual([]);
});
