import { afterEach, expect, test } from 'bun:test';
import { clock, setLanguage, t } from './strings';

afterEach(() => setLanguage('de', []));

test('the strings follow the language set, dates and numbers too', () => {
  const d = new Date(2026, 9, 6, 15, 4);
  setLanguage('de', []);
  expect(t.newCard).toBe('Neue Aufgabe');
  expect(clock(d)).toBe('15:04');
  expect(t.archive.when(d)).toContain('15:04');
  expect(t.share.tooLarge(12.34 * 1024 * 1024)).toContain('12,3 MB');

  setLanguage('en', []);
  expect(t.newCard).toBe('New task');
  expect(clock(d)).toMatch(/03:04\sPM/);
  expect(t.archive.day(d, new Date(2026, 9, 6))).toBe('Today');
  expect(t.archive.day(d, new Date(2026, 9, 9))).toBe('Tuesday, October 6');
  expect(t.share.tooLarge(12.34 * 1024 * 1024)).toContain('12.3 MB');
});

test('the browser\'s variant of the language writes dates its way', () => {
  setLanguage('en', ['de-DE', 'en-GB']);
  expect(t.archive.day(new Date(2026, 9, 6), new Date(2026, 9, 9))).toBe('Tuesday 6 October');
  expect(clock(new Date(2026, 9, 6, 15, 4))).toBe('15:04');
});
