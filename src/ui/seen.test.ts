import { expect, test } from 'bun:test';
import { cameInView, follow, seenOf, type Spans } from './seen';
import { memoryStorage } from './testing';

test('what comes while the conversation is in view counts as seen, what came while the page was hidden not', () => {
  // opened with 7 as its last event: what came before stays as it was
  let came: Spans = follow([], undefined, 7, true);
  expect(came).toEqual([]);
  came = follow(came, 7, 9, true);
  expect([8, 9].map((id) => cameInView(came, id))).toEqual([true, true]);
  expect(cameInView(came, 7)).toBe(false);
  // the page hidden: 10 and 11 come unseen, and stay so once it is in view again
  came = follow(came, 9, 11, false);
  came = follow(came, 11, 12, true);
  expect([10, 11, 12].map((id) => cameInView(came, id))).toEqual([false, false, true]);
  // the events loading after the conversation opened are not new arrivals
  expect(follow([], undefined, 12, true)).toEqual([]);
});

test("the phone's former key counts only while the current one is missing, not where it is broken", () => {
  const store = memoryStorage();
  Object.assign(globalThis, { localStorage: store });
  try {
    store.setItem('obeya-phone-seen', JSON.stringify({ card: 42 }));
    expect(seenOf('card')).toBe(42);
    store.setItem('obeya-seen', '{');
    expect(seenOf('card')).toBe(-1);
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});
