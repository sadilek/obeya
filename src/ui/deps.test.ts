import { expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { depsOf, waitsAmong } from './deps';

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

test('a workstream waits for the open ones it builds on, started or not; a delivered one is no wait', () => {
  const ws = (id: string, state: Item['state'], buildsOn: string[] = []) => ({ ...card(id), state, parent: 'p', buildsOn }) as Item;
  const all = [ws('W1', 'live'), ws('W2', 'planned', ['W1']), ws('W3', 'planned', ['W2', 'W1']), ws('W4', 'working')];
  const d = depsOf('W2', all)!;
  expect([...d.after]).toEqual(['W3']);
  expect(d.before.size).toBe(0);
  expect(d.edges).toEqual([['W2', 'W3']]);
  expect(depsOf('W1', all)).toBeUndefined();
});

test('a card snoozed until another card gets somewhere waits for that card', () => {
  const snoozed = { ...card('R'), snoozed: { on: { card: 'F', title: 'F', state: 'done' }, by: 'agent' } } as Item;
  const all = [card('F'), snoozed, card('S', 'R')];
  const d = depsOf('R', all)!;
  expect([...d.before]).toEqual(['F']);
  expect([...d.after]).toEqual(['S']);
  expect(depsOf('F', all)!.edges.sort()).toEqual([['F', 'R'], ['R', 'S']]);
  expect(depsOf('R', [snoozed])).toBeUndefined();
});

test('every direct wait on the canvas, of all kinds, not the chain; a finished card is waited for no longer', () => {
  const snoozed = { ...card('R'), snoozed: { on: { card: 'A', title: 'A', state: 'done' }, by: 'agent' } } as Item;
  const drawn = { ...card('M'), manualDependsOn: ['B'] } as Item;
  const done = { ...card('F'), state: 'done' } as Item;
  const all = [...items, snoozed, drawn, done, card('G', 'F'), { ...card('H'), state: 'live', manualDependsOn: ['A'] } as Item];
  expect(waitsAmong(all).sort()).toEqual([['A', 'B'], ['A', 'D'], ['A', 'R'], ['B', 'C'], ['B', 'D'], ['B', 'M']]);
});
