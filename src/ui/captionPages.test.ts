import { expect, test } from 'bun:test';
import { captionPages, pageBudget, pageOf } from './captionPages';

const words = (s: string) => s.split(' ');

test('a sentence that fits the caption is one page', () => {
  expect(captionPages(words('At that moment Obeya reads the setting.'), 80)).toEqual([0]);
});

test('a long sentence comes in pages that each fit, as even as the words allow', () => {
  const w = words("There are two routes, straight onto main or through a pull request, and the repository's settings choose between them.");
  const starts = captionPages(w, 50);
  expect(starts.length).toBe(3);
  const lengths = starts.map((s, k) => w.slice(s, starts[k + 1]).join(' ').length);
  for (const n of lengths) expect(n).toBeLessThanOrEqual(50);
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(25);
});

test('a page ends after a comma rather than just before the end of its phrase', () => {
  const w = words('First it rebases onto main, then the checks run and main moves on.');
  const starts = captionPages(w, 50);
  expect(w[starts[1]! - 1]).toBe('main,');
});

test('the page shown is the one with the word being spoken, the first before any', () => {
  expect(pageOf([0, 6, 12], -1)).toBe(0);
  expect(pageOf([0, 6, 12], 5)).toBe(0);
  expect(pageOf([0, 6, 12], 6)).toBe(1);
  expect(pageOf([0, 6, 12], 20)).toBe(2);
});

test('a page holds two lines of the caption, less a margin for breaking at words', () => {
  expect(pageBudget(400, 15)).toBe(88);
  expect(pageBudget(10, 30)).toBe(12);
});
