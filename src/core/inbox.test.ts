import { expect, test } from 'bun:test';
import { inboxOf, inboxOrder } from './inbox';
import type { Item, Talk } from './types';

const card = (over: Partial<Item>): Item => ({ id: 'x', kind: 'task', state: 'waiting', title: 'T', body: '', x: 0, y: 0, source: 'manual', repo: 'r', waitingSince: '2026-10-29T09:00:00Z', ...over });
const canvas = { id: 'c1', name: 'Site' };

test('a question with few options is answered by its options, the agent’s pick named', () => {
  const [e] = inboxOf(canvas, {
    items: [card({ need: 'question', question: { text: 'Which?', options: ['A', 'B'], pick: { options: ['B'], why: 'x' } } })],
    talk: [],
  });
  expect(e).toMatchObject({ canvas: 'c1', canvasName: 'Site', card: 'x', title: 'T', kind: 'question', text: 'Which?', options: ['A', 'B'], pick: 'B' });
});

test('a multiple-choice question or one with many options is left to the card', () => {
  const q = { text: '?', options: ['1', '2', '3', '4', '5'] };
  expect(inboxOf(canvas, { items: [card({ need: 'question', question: q })], talk: [] })[0]!.options).toBeUndefined();
  expect(inboxOf(canvas, { items: [card({ need: 'question', question: { text: '?', options: ['a', 'b'], multiple: true } })], talk: [] })[0]!.options).toBeUndefined();
});

test('a handover is approved, a contribution merged, a change-free one closed', () => {
  const [a, b, c] = inboxOf(canvas, {
    items: [card({ id: 'a', need: 'demo', summary: 'Done' }), card({ id: 'b', need: 'review', contribution: { number: 7 } as Item['contribution'] }), card({ id: 'c', need: 'demo', noChange: true })],
    talk: [],
  });
  expect(a).toMatchObject({ kind: 'demo', text: 'Done' });
  expect(b).toMatchObject({ kind: 'review', contribution: 7 });
  expect(c).toMatchObject({ noChange: true });
});

test('cards that do not need the owner are not in it, an unread answer of Obeya is', () => {
  const talk: Talk[] = [{ id: 1, at: '2026-10-29T10:00:00Z', said: 'q', answer: 'It is so', unread: true }];
  const out = inboxOf(canvas, { items: [card({ state: 'working' }), card({ state: 'proposal', id: 'p', proposal: { questions: [{ text: 'Q', options: [] }] } })], talk });
  expect(out.map((e) => e.kind)).toEqual(['proposal', 'obeya']);
  expect(out[0]).toMatchObject({ asks: true });
  expect(out[1]).toMatchObject({ text: 'It is so', since: '2026-10-29T10:00:00Z' });
});

test('the entries that wait for the shortest time come first, across canvases', () => {
  const old = inboxOf(canvas, { items: [card({ id: 'old' })], talk: [] });
  const fresh = inboxOf({ id: 'c2', name: 'Other' }, { items: [card({ id: 'new', waitingSince: '2026-10-30T09:00:00Z' })], talk: [] });
  expect(inboxOrder([...old, ...fresh]).map((e) => e.card)).toEqual(['new', 'old']);
});
