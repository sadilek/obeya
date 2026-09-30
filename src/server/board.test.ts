import { beforeEach, describe, expect, test } from 'bun:test';
import { boundsOf } from '../core/layout';
import type { PlanDoc } from '../core/plan-doc';
import { BadRequest, Board } from './board';
import { Store } from './db';

const ws = (key: string, done = false) => ({ key, label: key, title: `Title ${key}`, body: `Body ${key}`, done, inReview: false });
const docA: PlanDoc = { file: 'docs/plan/a.md', title: 'A', goal: 'Goal A', workstreams: [ws('W1', true), ws('W2'), ws('W3')] };
const docB: PlanDoc = { file: 'docs/plan/b.md', title: 'B', goal: 'Goal B', workstreams: [ws('W1')] };

let store: Store;
let docs: PlanDoc[];
let board: Board;

beforeEach(() => {
  store = new Store(':memory:');
  docs = [docA];
  board = new Board(store, { id: 'acme', name: 'Acme', repoPath: '/r', branch: 'main' }, () => docs);
});

describe('plan docs', () => {
  test('a project and its workstreams appear with state and text from the doc', () => {
    const { items } = board.snapshot();
    const [p, w1, w2, w3] = items;
    expect(p).toMatchObject({ kind: 'project', title: 'A', source: 'plan', plan: { file: 'docs/plan/a.md', goal: 'Goal A' } });
    expect([w1, w2, w3].map((w) => [w!.label, w!.state, w!.parent])).toEqual([
      ['W1', 'live', p!.id],
      ['W2', 'planned', p!.id],
      ['W3', 'planned', p!.id],
    ]);
  });

  test('placement is kept across reads and survives an edit of the doc', () => {
    const w2 = board.snapshot().items.find((i) => i.label === 'W2')!;
    board.patch(w2.id, { x: 700, y: 400 });
    docs = [{ ...docA, workstreams: [ws('W1', true), { ...ws('W2', true), title: 'Renamed' }, ws('W3')] }];
    expect(board.snapshot().items.find((i) => i.id === w2.id)).toMatchObject({ x: 700, y: 400, title: 'Renamed', state: 'live' });
  });

  test('a new workstream is placed below the existing ones', () => {
    const before = board.snapshot().items;
    const lowest = Math.max(...before.filter((i) => i.parent).map((i) => i.y));
    docs = [{ ...docA, workstreams: [...docA.workstreams, ws('W4')] }];
    const w4 = board.snapshot().items.find((i) => i.label === 'W4')!;
    expect(w4.y).toBeGreaterThan(lowest);
  });

  test('a new project is placed clear of everything on the canvas', () => {
    const first = board.snapshot().items;
    docs = [docA, docB];
    const items = board.snapshot().items;
    const a = boundsOf(items.find((i) => i.title === 'A')!, items);
    const b = boundsOf(items.find((i) => i.title === 'B')!, items);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
    expect(first.length + 2).toBe(items.length);
  });

  test('a removed doc hides its cards; its return brings back their placement', () => {
    const p = board.snapshot().items[0]!;
    board.patch(p.id, { x: -500, y: 42 });
    docs = [];
    expect(board.snapshot().items).toEqual([]);
    docs = [docA];
    expect(board.snapshot().items[0]).toMatchObject({ id: p.id, x: -500, y: 42 });
  });

  test('plan cards are read-only apart from placement and state', () => {
    const [p, w1] = board.snapshot().items;
    expect(() => board.patch(w1!.id, { title: 'x' })).toThrow(BadRequest);
    expect(() => board.patch(p!.id, { state: 'working' })).toThrow(BadRequest);
    expect(() => board.remove(w1!.id)).toThrow(BadRequest);
  });
});

describe('manual cards', () => {
  test('create, edit, delete and restore', () => {
    let changes = 0;
    board.onChange(() => changes++);
    const c = board.create({ kind: 'bugfix', title: 'Fix it', x: 10, y: 20 });
    expect(c).toMatchObject({ kind: 'bugfix', state: 'planned', title: 'Fix it', body: '', source: 'manual' });
    board.patch(c.id, { title: 'Fix it now', kind: 'feature', body: 'Details' });
    expect(board.snapshot().items.find((i) => i.id === c.id)).toMatchObject({ title: 'Fix it now', kind: 'feature', body: 'Details' });
    board.remove(c.id);
    expect(board.snapshot().items.some((i) => i.id === c.id)).toBe(false);
    board.restore(c.id);
    expect(board.snapshot().items.some((i) => i.id === c.id)).toBe(true);
    expect(changes).toBe(4);
  });

  test('rejects invalid input', () => {
    expect(() => board.create({ kind: 'project' as never, title: 'x', x: 0, y: 0 })).toThrow(BadRequest);
    expect(() => board.create({ kind: 'feature', title: 'x', x: Number.NaN, y: 0 })).toThrow(BadRequest);
    const c = board.create({ kind: 'feature', title: 'x', x: 0, y: 0 });
    expect(() => board.patch(c.id, { state: 'done' as never })).toThrow(BadRequest);
    expect(() => board.patch('nope', { x: 1 })).toThrow(BadRequest);
  });

  test('cards are persisted per canvas', () => {
    board.create({ kind: 'feature', title: 'mine', x: 0, y: 0 });
    const other = new Board(store, { id: 'other', name: 'Other', repoPath: '/o', branch: 'main' }, () => []);
    expect(other.snapshot().items).toEqual([]);
  });
});
