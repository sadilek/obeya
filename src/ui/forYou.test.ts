import { expect, test } from 'bun:test';
import { type CanvasInfo, type Item, runningIn, type Talk, waitingIn } from '../core/types';
import { forYouCount, forYouOf, forYouTotal } from './forYou';

const card = (id: string, more: Partial<Item> = {}) => ({ id, kind: 'task', state: 'working', title: id, body: '', x: 0, y: 0, source: 'manual', ...more }) as Item;
const talk = (id: number, unread = false): Talk => ({ id, at: '2026-11-02T09:00:00Z', said: `q${id}`, reply: '', ...(unread ? { unread: true as const } : {}) });

test('a canvas lists what needs the owner in its order, and not what does not wait, nor what the owner snoozed while it waited', () => {
  const items = [
    card('snoozed', { state: 'waiting', need: 'review', snoozed: { by: 'owner', waiting: true, until: '2026-11-03T08:00:00Z' } }),
    card('review', { state: 'waiting', need: 'review' }),
    card('working'),
    card('proposal', { state: 'proposal' }),
  ];
  const w = waitingIn({ items, talk: [] });
  expect(w.items.map((i) => i.id)).toEqual(['review', 'proposal']);
  expect(forYouOf(w, () => false).cards.map((i) => i.id)).toEqual(['review', 'proposal']);
  // the phone hands it its whole snapshot
  expect(forYouOf({ items, talk: [] }, () => false).cards.map((i) => i.id)).toEqual(['review', 'proposal']);
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

test('the count leaves out snoozed cards and those underway, and counts unread answers once, on every canvas', () => {
  const a = waitingIn({
    items: [card('review', { state: 'waiting', need: 'review' }), card('proposal', { state: 'proposal' }), card('snoozed', { state: 'waiting', need: 'review', snoozed: { by: 'owner', waiting: true, until: '2026-11-03T08:00:00Z' } })],
    talk: [talk(1, true), talk(2, true)],
  });
  const b = waitingIn({ items: [card('question', { state: 'waiting', need: 'question' })], talk: [] });
  expect(forYouCount(a, () => false)).toBe(3);
  expect(forYouCount(a, (id) => id === 'review')).toBe(2);
  const canvases = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as CanvasInfo[];
  expect(forYouTotal(canvases, { a, b }, () => false)).toBe(4);
});

test('"Running" holds what is in flight and waits for nobody, a snoozed card last, and counts for nothing that waits', () => {
  const items = [
    card('snoozedByAgent', { snoozed: { by: 'agent', until: '2026-11-03T08:00:00Z' } }),
    card('working', { statusLine: 'Writing tests', body: 'a long task text' }),
    card('review', { state: 'waiting', need: 'review' }),
    card('snoozedWhileWaiting', { state: 'waiting', need: 'review', snoozed: { by: 'owner', waiting: true, until: '2026-11-03T08:00:00Z' } }),
    card('landing', { state: 'waiting', need: 'review', landing: true }),
    card('queued', { state: 'planned', queue: { checking: true, since: '2026-11-02T09:00:00Z' } }),
    card('planned', { state: 'planned' }),
    card('live', { state: 'live' }),
  ];
  const w = waitingIn({ items, talk: [] });
  expect(w.running!.map((i) => i.id)).toEqual(['working', 'landing', 'queued', 'snoozedByAgent', 'snoozedWhileWaiting']);
  // only what its row shows goes to the other canvases' pages: a line its agent says changes nothing there
  expect(w.running![0]).toEqual({ id: 'working', title: 'working', kind: 'task', state: 'working' });
  expect(forYouCount(w, () => false)).toBe(1);
  // a card the owner just acted on runs until the server says what became of it
  expect(runningIn(items, (id) => id === 'review').map((i) => i.id)).toEqual(['working', 'review', 'landing', 'queued', 'snoozedByAgent', 'snoozedWhileWaiting']);
});
