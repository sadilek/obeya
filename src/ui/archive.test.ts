import { expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { searchText, searchWords } from '../core/search';
import { matches } from './archive';
import { offsets, visible } from './windowed';
import { testItem } from './testing';

const card = (title: string, more: Partial<Item> = {}) => testItem({ id: title, state: 'done', title, ...more });

test('a search finds a card holding every word, in any case and without accents', () => {
  const i = card('Über den Klon warten', { body: 'Nachfrage an fertige Karte' });
  expect(matches(i, searchWords('uber'))).toBe(true);
  expect(matches(i, searchWords('  KLON  karte '))).toBe(true);
  expect(matches(i, searchWords('klon demo'))).toBe(false);
});

test("a project is found by its workstreams' titles", () => {
  const p = card('Voice', { kind: 'project' });
  expect(searchText(p, [card('Local Whisper model', { parent: 'Voice' })])).toContain('whisper');
  expect(searchText(p)).not.toContain('whisper');
});

test('of a long list, only the rows reaching into the stretch in view are on the page', () => {
  const starts = offsets([25, 60, 60, 80, 25, 60]);
  expect(starts).toEqual([0, 25, 85, 145, 225, 250, 310]);
  expect(visible(starts, 0, 100)).toEqual([0, 3]);
  expect(visible(starts, 90, 150)).toEqual([2, 4]);
  expect(visible(starts, 145, 146)).toEqual([3, 4]);
  // beyond either end: at least the row there, for the list to measure
  expect(visible(starts, -500, -100)).toEqual([0, 1]);
  expect(visible(starts, 900, 1000)).toEqual([5, 6]);
  expect(visible(offsets([]), 0, 100)).toEqual([0, 0]);
});
