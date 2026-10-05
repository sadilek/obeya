import { expect, test } from 'bun:test';
import { keep, type Kept, takeKept } from './keep';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const kept = (at: number): Kept => ({ at, card: 'c1', sheet: 'koordinator', scroll: [['["panel"]', 400]], drafts: [], video: { time: 23.5, playing: false } });

test('what a reload kept comes back once, on its canvas', () => {
  const s = store();
  keep(s, 'obeya', kept(1000));
  expect(takeKept(s, 'shop', 2000)).toBeNull();
  expect(takeKept(s, 'obeya', 2000)).toEqual(kept(1000));
  expect(takeKept(s, 'obeya', 2000)).toBeNull();
});

test('a page loaded long after starts afresh', () => {
  const s = store();
  keep(s, 'obeya', kept(1000));
  expect(takeKept(s, 'obeya', 1000 + 10 * 60_000)).toBeNull();
});
