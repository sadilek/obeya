import { expect, test } from 'bun:test';
import type { Demo } from '../core/types';
import { arrivedOnOpenCard, held, markSeen, openedWith, unseen } from './demoSeen';
import { memoryStorage } from './testing';

const demo = (at: number, handover = 1): Demo => ({ kind: 'video', chapters: [[0, 'Start'], [at, 'End']], handover });

test('a demo counts as seen only once it has played, not when the card shows it', () => {
  const s = memoryStorage();
  // the card opened and the video mounted, but it never played: the next opening still starts it
  expect(unseen(s, 'a', demo(12))).toBe(true);
  expect(unseen(s, 'a', demo(12))).toBe(true);
  markSeen(s, 'a', demo(12));
  expect(unseen(s, 'a', demo(12))).toBe(false);
  expect(unseen(s, 'b', demo(12))).toBe(true);
});

test('a new render of the demo is unseen again', () => {
  const s = memoryStorage();
  markSeen(s, 'a', demo(12));
  expect(unseen(s, 'a', demo(15.4))).toBe(true);
});

test('a demo that arrives on the open card does not start by itself', () => {
  const s = memoryStorage();
  // the card was opened while the agent was still at work: no demo yet
  const opened = openedWith(s, 'a', undefined);
  expect(arrivedOnOpenCard(opened, demo(12))).toBe(true);
  // opened to the demo: it starts
  expect(arrivedOnOpenCard(openedWith(s, 'a', demo(12)), demo(12))).toBe(false);
  // a later handover on the open card waits too
  expect(arrivedOnOpenCard(openedWith(s, 'a', demo(12, 1)), demo(14, 2))).toBe(true);
});

test("a reload keeps a demo that arrived on the open card waiting; closing the card ends that", () => {
  const s = memoryStorage();
  held.set(s, 'a', demo(12));
  // the page a restart reloads reopens the card to the same demo, without the owner opening it
  expect(arrivedOnOpenCard(openedWith(s, 'a', demo(12)), demo(12))).toBe(true);
  // a new render is not the one that waited
  expect(arrivedOnOpenCard(openedWith(s, 'a', demo(13)), demo(13))).toBe(false);
  held.clear(s, 'a');
  expect(arrivedOnOpenCard(openedWith(s, 'a', demo(12)), demo(12))).toBe(false);
});

test("a later handover's demo is unseen even where its chapters fall at the same times", () => {
  const s = memoryStorage();
  markSeen(s, 'a', demo(12, 1));
  expect(unseen(s, 'a', demo(12, 1))).toBe(false);
  expect(unseen(s, 'a', demo(12, 2))).toBe(true);
});
