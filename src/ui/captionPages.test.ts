import { expect, test } from 'bun:test';
import { captionPages, pageOf } from './captionPages';

const words = (s: string) => s.split(' ');
/** A monospaced measure: 10 px a character. */
const mono = (text: string) => text.length * 10;
/** Lines the page from `from` to `to` takes at 10 px a character in a line `line` wide. */
const lines = (w: string[], from: number, to: number, line: number) => {
  let n = 1;
  let at = 0;
  for (const x of w.slice(from, to)) {
    if (at > 0 && at + 10 + mono(x) > line) {
      n++;
      at = mono(x);
    } else at += (at > 0 ? 10 : 0) + mono(x);
  }
  return n;
};

test('a sentence that fits two lines of the caption is one page', () => {
  expect(captionPages(words('At that moment Obeya reads the setting.'), mono, 250)).toEqual([0]);
});

test('a long sentence comes in pages of two lines at most, as even as the words allow', () => {
  const w = words("There are two routes, straight onto main or through a pull request, and the repository's settings choose between them.");
  const starts = captionPages(w, mono, 250);
  expect(starts.length).toBe(3);
  for (const [k, s] of starts.entries()) expect(lines(w, s, starts[k + 1] ?? w.length, 250)).toBeLessThanOrEqual(2);
  const lengths = starts.map((s, k) => w.slice(s, starts[k + 1]).join(' ').length);
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(25);
});

test('wide letters take more room: pages follow the measured widths, not a count of characters', () => {
  const w = words('Common commands manage memory when more workers commence.');
  const wide = (text: string) => [...text].reduce((s, c) => s + ('mwMW'.includes(c) ? 18 : 10), 0);
  const starts = captionPages(w, wide, 300);
  expect(starts.length).toBe(2);
});

test('a page ends after a comma rather than just before the end of its phrase', () => {
  const w = words('First it rebases onto main, then the checks run and main moves on.');
  const starts = captionPages(w, mono, 250);
  expect(w[starts[1]! - 1]).toBe('main,');
});

test('the page shown is the one with the word being spoken, the first before any', () => {
  expect(pageOf([0, 6, 12], -1)).toBe(0);
  expect(pageOf([0, 6, 12], 5)).toBe(0);
  expect(pageOf([0, 6, 12], 6)).toBe(1);
  expect(pageOf([0, 6, 12], 20)).toBe(2);
});
