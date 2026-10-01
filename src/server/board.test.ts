import { beforeEach, describe, expect, test } from 'bun:test';
import { boundsOf } from '../core/layout';
import type { PlanDoc } from '../core/plan-doc';
import { BadRequest, Board } from './board';
import { Store } from './db';

const ws = (key: string, done = false) => ({ key, label: key, title: `Title ${key}`, body: `Body ${key}`, done, inReview: false });
const docA: PlanDoc = { file: 'docs/plan/a.md', title: 'A', goal: 'Goal A', workstreams: [ws('W1', true), ws('W2'), ws('W3')], markdown: '# A\n\n## Goal\n\nGoal A\n' };
const docB: PlanDoc = { file: 'docs/plan/b.md', title: 'B', goal: 'Goal B', workstreams: [ws('W1')], markdown: '' };

let store: Store;
let docs: PlanDoc[];
let board: Board;

beforeEach(() => {
  store = new Store(':memory:');
  docs = [docA];
  board = new Board(store, { id: 'acme', name: 'Acme', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => docs);
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

  test('a project gives its plan doc as written; a workstream or manual card has none', () => {
    const [p, w1] = board.snapshot().items;
    expect(board.planDoc(p!.id)).toEqual({ file: 'docs/plan/a.md', markdown: docA.markdown });
    docs = [{ ...docA, markdown: '# A\n\nEdited\n' }];
    board.docsChanged();
    expect(board.planDoc(p!.id).markdown).toBe('# A\n\nEdited\n');
    expect(() => board.planDoc(w1!.id)).toThrow(BadRequest);
    const c = board.create({ kind: 'feature', title: 'Own', x: 0, y: 0 });
    expect(() => board.planDoc(c.id)).toThrow(BadRequest);
  });

  test('placement is kept across reads and survives an edit of the doc', () => {
    const w2 = board.snapshot().items.find((i) => i.label === 'W2')!;
    board.patch(w2.id, { x: 700, y: 400 });
    docs = [{ ...docA, workstreams: [ws('W1', true), { ...ws('W2', true), title: 'Renamed' }, ws('W3')] }];
    board.docsChanged();
    expect(board.snapshot().items.find((i) => i.id === w2.id)).toMatchObject({ x: 700, y: 400, title: 'Renamed', state: 'live' });
  });

  test('a new workstream is placed below the existing ones', () => {
    const before = board.snapshot().items;
    const lowest = Math.max(...before.filter((i) => i.parent).map((i) => i.y));
    docs = [{ ...docA, workstreams: [...docA.workstreams, ws('W4')] }];
    board.docsChanged();
    const w4 = board.snapshot().items.find((i) => i.label === 'W4')!;
    expect(w4.y).toBeGreaterThan(lowest);
  });

  test('a new project is placed clear of everything on the canvas', () => {
    const first = board.snapshot().items;
    docs = [docA, docB];
    board.docsChanged();
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
    board.docsChanged();
    expect(board.snapshot().items).toEqual([]);
    docs = [docA];
    board.docsChanged();
    expect(board.snapshot().items[0]).toMatchObject({ id: p.id, x: -500, y: 42 });
  });

  test('work in progress wins over a ticked-off workstream until it has landed', () => {
    const w2 = board.snapshot().items.find((i) => i.label === 'W2')!;
    board.work(w2.id, { state: 'inPr' });
    docs = [{ ...docA, workstreams: [ws('W1', true), { ...ws('W2'), done: true }, ws('W3')] }];
    board.docsChanged();
    expect(board.item(w2.id)!.state).toBe('inPr');
    board.work(w2.id, { state: 'live' });
    expect(board.item(w2.id)!.state).toBe('live');
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

  test('a follow-up goes below the card it comes from, in its repository, and names it', () => {
    const src = board.create({ kind: 'feature', title: 'Export', x: 100, y: 100 });
    const a = board.create({ kind: 'bugfix', title: 'Ton bleibt an', body: 'Der ambient-Ton läuft nach dem Stopp weiter.', from: src.id });
    expect(a).toMatchObject({ state: 'planned', from: src.id, repo: src.repo, body: 'Der ambient-Ton läuft nach dem Stopp weiter.' });
    expect(a.x).toBe(135);
    expect(a.y).toBeGreaterThan(100);
    // the next one goes beside it
    const b = board.create({ kind: 'bugfix', title: 'Noch eine', from: src.id });
    expect(b.y).toBe(a.y);
    expect(b.x - a.x).toBeGreaterThan(boundsOf(a, board.snapshot().items).w);
    expect(() => board.create({ kind: 'bugfix', title: 'x', from: 'nope' })).toThrow(BadRequest);
    expect(() => board.create({ kind: 'feature', title: 'x', from: src.id, idea: true })).toThrow(BadRequest);
    expect(() => board.create({ kind: 'feature', title: 'x' })).toThrow(BadRequest);
  });

  test('rejects invalid input', () => {
    expect(() => board.create({ kind: 'project' as never, title: 'x', x: 0, y: 0 })).toThrow(BadRequest);
    expect(() => board.create({ kind: 'feature', title: 'x', x: Number.NaN, y: 0 })).toThrow(BadRequest);
    const c = board.create({ kind: 'feature', title: 'x', x: 0, y: 0 });
    expect(() => board.patch(c.id, { state: 'done' as never })).toThrow(BadRequest);
    expect(() => board.patch('nope', { x: 1 })).toThrow(BadRequest);
  });

  test('untitled cards left over from a closed page are dropped on start', () => {
    const fresh = board.create({ kind: 'feature', title: '', x: 0, y: 0 });
    const old = board.create({ kind: 'feature', title: ' ', x: 0, y: 0 });
    const kept = board.create({ kind: 'feature', title: 'Echt', x: 0, y: 0 });
    store.db.query("UPDATE cards SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN ($a, $b)").run({ a: old.id, b: kept.id });
    const again = new Board(store, { id: 'acme', name: 'Acme', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => docs);
    const ids = again.snapshot().items.map((i) => i.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(old.id);
  });

  test('cards are persisted per canvas', () => {
    board.create({ kind: 'feature', title: 'mine', x: 0, y: 0 });
    const other = new Board(store, { id: 'other', name: 'Other', repos: [{ id: 'home', name: 'Home', path: '/o', branch: 'main' }] }, () => []);
    expect(other.snapshot().items).toEqual([]);
  });
});

describe('archive', () => {
  const done = (title: string) => {
    const c = board.create({ kind: 'feature', title, x: 10, y: 20 });
    board.patch(c.id, { state: 'live' });
    return c;
  };

  test('an archived card leaves the canvas and heads the archive until it goes back', async () => {
    const a = done('A');
    const b = done('B');
    board.archive([a.id]);
    await Bun.sleep(2);
    board.archive([b.id]);
    expect(board.snapshot().items.some((i) => i.id === a.id || i.id === b.id)).toBe(false);
    expect(board.archived().map((i) => [i.title, i.state, typeof i.archivedAt])).toEqual([
      ['B', 'live', 'string'],
      ['A', 'live', 'string'],
    ]);
    board.unarchive(b.id);
    expect(board.snapshot().items.find((i) => i.id === b.id)).toMatchObject({ x: 10, y: 20, state: 'live' });
    expect(board.archived().map((i) => i.title)).toEqual(['A']);
  });

  test('only finished cards of the owner go into the archive', () => {
    const open = board.create({ kind: 'feature', title: 'Open', x: 0, y: 0 });
    const w1 = board.snapshot().items.find((i) => i.label === 'W1')!;
    expect(() => board.archive([open.id])).toThrow(expect.objectContaining({ code: 'notDone' }));
    expect(() => board.archive([w1.id])).toThrow(expect.objectContaining({ code: 'planCard' }));
    expect(() => board.unarchive(open.id)).toThrow(expect.objectContaining({ code: 'notArchived' }));
    expect(board.archived()).toEqual([]);
  });

  test('archiving everything finished leaves the rest on the canvas', () => {
    const a = done('A');
    const b = done('B');
    const open = board.create({ kind: 'bugfix', title: 'Open', x: 0, y: 0 });
    expect(board.archiveDone().sort()).toEqual([a.id, b.id].sort());
    expect(board.snapshot().items.some((i) => i.id === open.id)).toBe(true);
    expect(board.archived()).toHaveLength(2);
    expect(board.archiveDone()).toEqual([]);
  });
});
