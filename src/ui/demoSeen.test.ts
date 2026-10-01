import { expect, test } from 'bun:test';
import type { Demo } from '../core/types';
import { firstOpening } from './demoSeen';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const demo = (at: number): Demo => ({ chapters: [[0, 'Start'], [at, 'Ende']], shown: [], notShown: [], findings: [] });

test("a card's demo plays on its own only the first time the card is opened", () => {
  const s = store();
  expect(firstOpening(s, 'a', demo(12))).toBe(true);
  expect(firstOpening(s, 'a', demo(12))).toBe(false);
  expect(firstOpening(s, 'b', demo(12))).toBe(true);
});

test('a new render of the demo plays on its own again', () => {
  const s = store();
  firstOpening(s, 'a', demo(12));
  expect(firstOpening(s, 'a', demo(15.4))).toBe(true);
  expect(firstOpening(s, 'a', demo(15.4))).toBe(false);
});
