import { expect, test } from 'bun:test';
import { addAll, inGroup, markable, movesWith, shifted, toggle, toggleAll } from './selection';

test('a workstream is marked as its project', () => {
  expect(markable({ id: 'w1', parent: 'p' })).toBe('p');
  expect(markable({ id: 'c' })).toBe('c');
});

test('Shift + click takes a card in and out; a lasso adds what it caught once', () => {
  expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
  expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  expect(addAll(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
});

test("a click on a group's name marks its cards, a project once as a whole; Shift adds them, or takes them out when all were in", () => {
  const placed = [{ item: { id: 'a', group: 'g' } }, { item: { id: 'b', group: 'h' } }, { item: { id: 'p', group: 'g' } }, { item: { id: 'w1', parent: 'p', group: 'g' } }, { item: { id: 'w2', parent: 'p', group: 'g' } }, { item: { id: 'c' } }];
  expect(inGroup(placed, 'g')).toEqual(['a', 'p']);
  expect(inGroup(placed, 'x')).toEqual([]);
  expect(toggleAll(['b'], ['a', 'p'])).toEqual(['b', 'a', 'p']);
  expect(toggleAll(['b', 'a'], ['a', 'p'])).toEqual(['b', 'a', 'p']);
  expect(toggleAll(['b', 'a', 'p'], ['a', 'p'])).toEqual(['b']);
  expect(toggleAll(['b'], [])).toEqual(['b']);
});

test('dragging a marked card moves the others with it, an unmarked one moves alone', () => {
  expect(movesWith(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  expect(movesWith(['a', 'b'], 'x')).toEqual([]);
  expect(
    shifted(
      [
        { id: 'a', start: { x: 10, y: 20 } },
        { id: 'b', start: { x: -5, y: 0 } },
      ],
      { x: 3.4, y: -7.6 },
    ),
  ).toEqual({ a: { x: 13, y: 12 }, b: { x: -2, y: -8 } });
});
