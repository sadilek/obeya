import { expect, test } from 'bun:test';
import { type Item, type Talk, waitingIn } from '../core/types';
import { forYouOf } from './forYou';

const card = (id: string, more: Partial<Item> = {}) => ({ id, kind: 'task', state: 'working', title: id, body: '', x: 0, y: 0, source: 'manual', ...more }) as Item;
const talk = (id: number, unread = false): Talk => ({ id, at: '2026-11-02T09:00:00Z', said: `q${id}`, reply: '', ...(unread ? { unread: true as const } : {}) });

test('a canvas lists what needs the owner in its order, those snoozed while they waited last, and not what does not wait', () => {
  const items = [
    card('snoozed', { state: 'waiting', need: 'review', snoozed: { by: 'owner', waiting: true, until: '2026-11-03T08:00:00Z' } }),
    card('review', { state: 'waiting', need: 'review' }),
    card('working'),
    card('proposal', { state: 'proposal' }),
  ];
  const w = waitingIn({ items, talk: [] });
  expect(w.items.map((i) => i.id)).toEqual(['snoozed', 'review', 'proposal']);
  expect(forYouOf(w, () => false).cards.map((i) => i.id)).toEqual(['review', 'proposal', 'snoozed']);
});

test('a card the owner just acted on leaves the list before the server says so', () => {
  const w = waitingIn({ items: [card('a', { state: 'waiting', need: 'review' }), card('b', { state: 'proposal' })], talk: [] });
  expect(forYouOf(w, (id) => id === 'a').cards.map((i) => i.id)).toEqual(['b']);
});

test("Obeya's answers waiting unread stand as one entry, the latest", () => {
  const w = waitingIn({ items: [], talk: [talk(1, true), talk(2), talk(3, true)] });
  expect(w.talk.map((x) => x.id)).toEqual([1, 3]);
  expect(forYouOf(w, () => false).obeya?.id).toBe(3);
  expect(forYouOf(waitingIn({ items: [], talk: [talk(1)] }), () => false).obeya).toBeUndefined();
});
