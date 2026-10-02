import { beforeEach, describe, expect, test } from 'bun:test';
import { boundsOf, sizeOf } from '../core/layout';
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

  test('a removed doc takes its project into the archive; its return brings it back to its place', () => {
    const p = board.snapshot().items[0]!;
    board.patch(p.id, { x: -500, y: 42 });
    docs = [];
    board.docsChanged();
    expect(board.snapshot().items).toEqual([]);
    expect(board.archived().map((i) => [i.title, i.parent ?? null])).toEqual([
      ['A', null],
      ['Title W1', p.id],
      ['Title W2', p.id],
      ['Title W3', p.id],
    ]);
    docs = [docA];
    board.docsChanged();
    expect(board.snapshot().items[0]).toMatchObject({ id: p.id, x: -500, y: 42 });
    expect(board.archived()).toEqual([]);
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

describe('the archive of projects', () => {
  test('an archived project shows its doc as last read: goal, workstreams with text and state', () => {
    const w2 = board.snapshot().items.find((i) => i.label === 'W2')!;
    board.work(w2.id, { state: 'live', branch: 'obeya/w2' });
    docs = [{ ...docA, goal: 'Neues Ziel', workstreams: [ws('W1', true), { ...ws('W2', true), body: 'Zuletzt so' }, ws('W3')] }];
    board.docsChanged();
    board.snapshot();
    docs = [];
    board.docsChanged();
    board.snapshot();
    const [p, ...kids] = board.archived();
    expect(p).toMatchObject({ kind: 'project', title: 'A', plan: { file: 'docs/plan/a.md', goal: 'Neues Ziel' }, archivedAt: expect.any(String) });
    expect(kids.map((k) => [k.label, k.state, k.body, k.archivedAt])).toEqual([
      ['W1', 'live', 'Body W1', p!.archivedAt],
      ['W2', 'live', 'Zuletzt so', p!.archivedAt],
      ['W3', 'planned', 'Body W3', p!.archivedAt],
    ]);
    // a workstream of an archived project still opens, with its log
    expect(board.card(w2.id)).toMatchObject({ id: w2.id, branch: 'obeya/w2', parent: p!.id });
    expect(board.events(w2.id)).toEqual([]);
    expect(() => board.unarchive(p!.id)).toThrow(expect.objectContaining({ code: 'planCard' }));
  });

  test('a project from before Obeya kept the doc stays hidden when its doc goes', () => {
    const p = board.snapshot().items[0]!;
    store.db.query('UPDATE cards SET plan = NULL WHERE id = $id').run({ id: p.id });
    docs = [];
    board.docsChanged();
    expect(board.snapshot().items).toEqual([]);
    expect(board.archived()).toEqual([]);
  });

  test('a project lists its decisions and those of the idea its doc was written from', () => {
    const idea = board.create({ kind: 'feature', idea: true, title: 'Idee B', x: 0, y: 0 });
    board.decide({ project_id: null, card_id: idea.id, question: 'Idee „Idee B“: wie weiter?', answer: 'Als Projekt.', by: 'owner' });
    board.work(idea.id, { state: 'live' });
    board.planDocsLanded(idea.id, ['docs/plan/b.md']);
    docs = [docA, docB];
    board.docsChanged();
    const b = board.snapshot().items.find((i) => i.title === 'B')!;
    expect(b.origin).toBe(idea.id);
    const w1 = board.snapshot().items.find((i) => i.parent === b.id)!;
    board.decide({ project_id: b.id, card_id: w1.id, question: 'Welche Spalten?', answer: 'Alle.', by: 'project' });
    // the idea's card leaves the canvas; the project still finds it
    board.archive([idea.id]);
    const h = board.projectHistory(b.id);
    expect(h.decisions.map((d) => [d.cardId, d.answer, d.by])).toEqual([
      [idea.id, 'Als Projekt.', 'owner'],
      [w1.id, 'Alle.', 'project'],
    ]);
    expect(h.origin).toMatchObject({ id: idea.id, title: 'Idee B', archivedAt: expect.any(String), brief: '' });
    // and so does the archived project
    docs = [docA];
    board.docsChanged();
    expect(board.archived().find((i) => i.id === b.id)!.origin).toBe(idea.id);
    expect(board.projectHistory(b.id).decisions).toHaveLength(2);
    expect(board.projectHistory(board.snapshot().items[0]!.id)).toEqual({ decisions: [], origin: null });
  });

  test('a project takes the place of the idea it was written from; the idea goes once its worker is done', () => {
    const idea = board.create({ kind: 'feature', idea: true, title: 'Idee B', x: 900, y: 40 });
    const below = board.create({ kind: 'feature', title: 'Darunter', x: 900, y: 240 });
    const beside = board.create({ kind: 'feature', title: 'Daneben', x: 1240, y: 40 });
    const away = board.create({ kind: 'feature', title: 'Weit weg', x: 3000, y: 900 });
    board.work(idea.id, { state: 'live', landed: '{}', workspace: '/ws/1' });
    board.planDocsLanded(idea.id, ['docs/plan/b.md']);
    docs = [docA, docB];
    board.docsChanged();
    const items = board.snapshot().items;
    const b = items.find((i) => i.title === 'B')!;
    expect(b).toMatchObject({ origin: idea.id, x: 900, y: 40 });
    // what the larger project would cover moves aside by as much as it outgrows the idea
    const [iw, ih] = sizeOf(board.item(idea.id)!, items);
    const [pw, ph] = sizeOf(b, items);
    expect(board.item(below.id)).toMatchObject({ x: 900, y: 240 + ph - ih });
    expect(board.item(beside.id)).toMatchObject({ x: 1240 + pw - iw, y: 40 });
    expect(board.item(away.id)).toMatchObject({ x: 3000, y: 900 });
    for (const i of [below, beside]) {
      const [p, c] = [boundsOf(b, items), boundsOf(board.item(i.id)!, items)];
      expect(c.x >= p.x + p.w || c.y >= p.y + p.h).toBe(true);
    }
    // its worker still finishes after the landing
    expect(board.item(idea.id)).toBeDefined();
    board.work(idea.id, { landed: null, workspace: null });
    board.workDone(idea.id);
    expect(board.item(idea.id)).toBeUndefined();
    expect(board.archived().find((i) => i.id === idea.id)).toMatchObject({ title: 'Idee B' });
    expect(board.events(idea.id).at(-1)!.text).toContain('an der Stelle der Idee');
    // put back on the canvas, it stays
    board.unarchive(idea.id);
    board.docsChanged();
    expect(board.item(idea.id)).toBeDefined();
  });

  test('only a card that was an idea becomes the origin of a project', () => {
    const plain = board.create({ kind: 'feature', title: 'Kein Idee', x: 0, y: 0 });
    board.planDocsLanded(plain.id, ['docs/plan/b.md']);
    docs = [docA, docB];
    board.docsChanged();
    expect(board.snapshot().items.find((i) => i.title === 'B')!.origin).toBeUndefined();
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

  test('a dropped idea goes into the archive with its brief, an open or parked one does not', () => {
    const idea = board.create({ kind: 'feature', idea: true, title: 'Idee', x: 30, y: 40 });
    expect(() => board.archive([idea.id])).toThrow(expect.objectContaining({ code: 'notDone' }));
    board.setIdea(idea.id, { status: 'parked' });
    expect(() => board.archive([idea.id])).toThrow(expect.objectContaining({ code: 'notDone' }));
    board.setIdea(idea.id, { status: 'dropped', brief: '**Ziel:** nichts' });
    board.addPrototype(idea.id, 'Prototyp: Idee', 'zeigen');
    expect(() => board.archive([idea.id])).toThrow(expect.objectContaining({ code: 'prototypeRunning' }));
    board.remove(board.snapshot().items.find((i) => i.prototypeOf === idea.id)!.id);
    board.archive([idea.id]);
    expect(board.snapshot().items.some((i) => i.id === idea.id)).toBe(false);
    expect(board.archived()).toMatchObject([{ id: idea.id, state: 'idea', idea: { status: 'dropped', brief: '**Ziel:** nichts' } }]);
    // archiving everything finished leaves ideas alone
    expect(board.archiveDone()).toEqual([]);
    board.unarchive(idea.id);
    expect(board.snapshot().items.find((i) => i.id === idea.id)).toMatchObject({ x: 30, y: 40, idea: { status: 'dropped' } });
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
