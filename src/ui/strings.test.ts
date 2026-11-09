import { afterEach, expect, test } from 'bun:test';
import { clock, setLanguage, stateLabel, t } from './strings';

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

test('a language tag Intl refuses falls back to the usual variant', () => {
  setLanguage('en', ['en-US@posix']);
  expect(clock(new Date(2026, 9, 6, 15, 4))).toMatch(/03:04\sPM/);
});

test("a proposal of the work retrospective is labelled as Obeya's, a worker's proposal as an agent's", () => {
  setLanguage('en', []);
  expect(stateLabel({ state: 'proposal', retro: 'Two cards hit the same wall.' })).toBe('Proposed by Obeya');
  expect(stateLabel({ state: 'proposal' })).toBe('Proposed by an agent');
  setLanguage('de', []);
  expect(stateLabel({ state: 'proposal', retro: 'Zwei Karten scheiterten gleich.' })).toBe('Vorschlag von Obeya');
  expect(stateLabel({ state: 'planned', retro: 'Zwei Karten scheiterten gleich.' })).toBe('Geplant');
});

test('a card whose agent answered the owner without a new demo says so instead of "Demo ready"', () => {
  setLanguage('en', []);
  expect(stateLabel({ state: 'waiting', need: 'demo' })).toBe('Demo ready');
  expect(stateLabel({ state: 'waiting', need: 'demo', answered: true })).toBe('Agent answered, waiting for you');
  expect(stateLabel({ state: 'waiting', need: 'review', answered: true })).toBe('Agent answered, waiting for you');
});
