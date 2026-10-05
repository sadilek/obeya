import { expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { depsOf } from './deps';

const card = (id: string, ...behind: string[]) =>
  ({ id, kind: 'task', state: behind.length ? 'planned' : 'working', title: id, body: '', x: 0, y: 0, source: 'manual', repo: 'r', ...(behind.length && { queue: { behind, reason: '' } }) }) as Item;

// A ← B ← C, A ← D (D also waits for B), E on its own
const items = [card('A'), card('B', 'A'), card('C', 'B'), card('D', 'A', 'B'), card('E')];

test('a waiting card shows what it waits for, over every step', () => {
  const d = depsOf('C', items)!;
  expect([...d.before].sort()).toEqual(['A', 'B']);
  expect(d.after.size).toBe(0);
  expect(d.edges.sort()).toEqual([['A', 'B'], ['B', 'C']]);
});

test('a working card shows everything that waits for it, each wait once', () => {
  const d = depsOf('A', items)!;
  expect([...d.after].sort()).toEqual(['B', 'C', 'D']);
  expect(d.before.size).toBe(0);
  expect(d.edges.sort()).toEqual([['A', 'B'], ['A', 'D'], ['B', 'C'], ['B', 'D']]);
});

test('a card in the middle shows both ways', () => {
  const d = depsOf('B', items)!;
  expect([...d.before]).toEqual(['A']);
  expect([...d.after].sort()).toEqual(['C', 'D']);
});

test('a card without waits has none, and cards gone from the canvas are left out', () => {
  expect(depsOf('E', items)).toBeUndefined();
  expect(depsOf('F', [card('F', 'gone')])).toBeUndefined();
});

test('a hovered card gone from the canvas, archived under the pointer, has none', () => {
  expect(depsOf('C', items.filter((i) => i.id !== 'C'))).toBeUndefined();
});

test('a loop ends', () => {
  const d = depsOf('X', [card('X', 'Y'), card('Y', 'X')])!;
  expect([...d.before]).toEqual(['Y']);
  expect([...d.after]).toEqual(['Y']);
});
