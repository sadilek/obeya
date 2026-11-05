import { expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { depsOf, holdsAmong, loopsAmong, nearestHandle, waitKinds, waitsAmong } from './deps';

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

test('the dot nearest the pointer shows, only within reach', () => {
  const cards = [
    { id: 'A', b: { x: 0, y: 0, w: 200, h: 100 } },
    { id: 'B', b: { x: 0, y: 130, w: 200, h: 100 } },
  ];
  expect(nearestHandle(cards, { x: 100, y: 108 }, 16)).toEqual({ id: 'A', side: 'bottom' });
  expect(nearestHandle(cards, { x: 100, y: 124 }, 16)).toEqual({ id: 'B', side: 'top' });
  expect(nearestHandle(cards, { x: 205, y: 50 }, 16)).toEqual({ id: 'A', side: 'right' });
  // in the middle of a card, and beside an edge but far from its middle, no dot
  expect(nearestHandle(cards, { x: 100, y: 50 }, 16)).toBeNull();
  expect(nearestHandle(cards, { x: 20, y: 100 }, 16)).toBeNull();
});

test('each wait under the pointer counts its steps from the hovered card, the fewest there are', () => {
  const d = depsOf('A', items)!;
  // B and D wait for A directly; C for B, and D also for B, one step further
  expect(d.steps.get('A B')).toBe(1);
  expect(d.steps.get('A D')).toBe(1);
  expect(d.steps.get('B C')).toBe(2);
  expect(d.steps.get('B D')).toBe(2);
  expect(depsOf('C', items)!.steps.get('A B')).toBe(2);
});

test('cards waiting for each other form a loop; the waits into and out of it are not part of it', () => {
  // X ← Y ← Z ← X, Z ← Q, R ← X
  const all = [card('X', 'Z'), card('Y', 'X'), card('Z', 'Y', 'Q'), card('Q'), card('R', 'X')];
  const loops = loopsAmong(waitsAmong(all));
  expect(loops.length).toBe(1);
  expect([...loops[0]!.cards].sort()).toEqual(['X', 'Y', 'Z']);
  expect(loops[0]!.edges.map((e) => e.join(' ')).sort()).toEqual(['X Y', 'Y Z', 'Z X']);
  expect(loopsAmong(waitsAmong(items))).toEqual([]);
});

test('a wait names what holds it', () => {
  const both = { ...card('B', 'A'), manualDependsOn: ['C'], queue: { behind: ['A', 'C'], reason: '', manualWait: ['C'] } } as Item;
  const all = [both, card('A'), card('C')];
  expect(waitKinds(both, 'A', all)).toEqual(['queue']);
  expect(waitKinds(both, 'C', all)).toEqual(['arrow']);
});

test('a card at work is held by no arrow and no plan doc, so a loop through one is none', () => {
  // A at work, though the owner drew an arrow from B to it and the plan doc has it build on B; B queued behind A
  const a = { ...card('A'), manualDependsOn: ['B'], buildsOn: ['B'] } as Item;
  const all = [a, card('B', 'A')];
  expect(waitsAmong(all).map((e) => e.join(' ')).sort()).toEqual(['A B', 'B A']);
  expect(waitKinds(a, 'B', all)).toEqual([]);
  expect(holdsAmong(all)).toEqual([['A', 'B']]);
  expect(loopsAmong(holdsAmong(all))).toEqual([]);
  // nor one waiting for a workspace to go on
  const begun = { ...card('A'), state: 'planned', buildsOn: ['B'], queue: { workspace: 'none', begun: true } } as Item;
  expect(loopsAmong(holdsAmong([begun, card('B', 'A')]))).toEqual([]);
  // snoozed until B gets there, A is held after all
  const snoozed = { ...a, snoozed: { on: { card: 'B', state: 'done' } } } as Item;
  expect(loopsAmong(holdsAmong([snoozed, card('B', 'A')])).length).toBe(1);
});
