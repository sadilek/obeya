import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { FakeRuntime, gitRepo } from './testing';
import { git } from './workspaces';

let dir: string;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;

/** A repository with one plan doc (same path in both). */
function repo(name: string, title: string) {
  return gitRepo(join(dir, name), { 'docs/plan/plan.md': `# ${title}\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** Erster Schritt.\n` });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const web = repo('web', 'Web');
  const api = repo('api', 'API');
  runtime = new FakeRuntime();
  canvas = new CanvasRuntime(
    { name: 'Produkt', repos: [{ path: web, clones: 1 }, { path: api, clones: 1 }] },
    { store: new Store(':memory:'), home: dir, runtime, forge: { status: () => ({}) as never } },
  );
});
afterEach(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 5));
const item = (id: string) => canvas.board.item(id)!;

describe('a canvas with several repositories', () => {
  test('names itself, lists its repositories, and shows the plan docs of all of them', () => {
    expect(canvas.board.canvas).toMatchObject({ id: 'produkt', name: 'Produkt', repos: [{ id: 'web' }, { id: 'api' }] });
    const projects = canvas.board.snapshot().items.filter((i) => i.kind === 'project');
    expect(projects.map((p) => [p.title, p.repo, p.plan!.file]).sort()).toEqual([
      ['API', 'api', 'api:docs/plan/plan.md'],
      ['Web', 'web', 'docs/plan/plan.md'],
    ]);
    const ws = canvas.board.snapshot().items.filter((i) => i.label === 'W1');
    expect(ws.map((w) => w.repo).sort()).toEqual(['api', 'web']);
  });

  test('a repository whose adapter shares no demos offers no sharing', () => {
    expect(canvas.board.canvas.repos.map((r) => r.share)).toEqual([undefined, undefined]);
    const c = canvas.board.create({ kind: 'feature', title: 'Home', x: 0, y: 0 });
    canvas.board.work(c.id, { state: 'live', demo: JSON.stringify({ kind: 'video', dir, chapters: [], shown: [], notShown: [], findings: [] }) });
    expect(() => canvas.act(c.id, { action: 'share' })).toThrow('shares none');
    expect(() => canvas.act(c.id, { action: 'unshare' })).toThrow('not shared');
  });

  test("a card works in its repository's clone", () => {
    const home = canvas.board.create({ kind: 'feature', title: 'Home', x: 0, y: 0 });
    const other = canvas.board.create({ kind: 'feature', title: 'Andere', x: 0, y: 0, repo: 'api' });
    expect([home.repo, other.repo]).toEqual(['web', 'api']);
    canvas.repoOf(other.id).workers.start(other.id);
    canvas.repoOf(home.id).workers.start(home.id);
    expect(canvas.board.row(other.id).workspace).toBe(join(dir, 'workspaces/produkt/api/1'));
    expect(canvas.board.row(home.id).workspace).toBe(join(dir, 'workspaces/produkt/1'));
    expect(() => canvas.board.create({ kind: 'feature', title: 'X', x: 0, y: 0, repo: 'nope' })).toThrow();
  });

  test('cards of different repositories never wait for each other', async () => {
    const a = canvas.board.create({ kind: 'feature', title: 'A', x: 0, y: 0 });
    canvas.act(a.id, { action: 'start' });
    await settle();
    expect(item(a.id).state).toBe('working');
    // A's estimate, and B in the other repository with the same file
    const estimate = () => runtime.sessions.filter((x) => x.spec.tools.some((t) => t.name === 'scope')).at(-1)!;
    const scopeCall = (files: string[], conflicts: string[] = []) => {
      const s = estimate();
      s.call('scope', { files, conflicts_with: conflicts, reason: '' });
      s.emit({ type: 'idle' });
    };
    scopeCall(['src/index.ts']);
    await settle();
    const b = canvas.board.create({ kind: 'feature', title: 'B', x: 0, y: 0, repo: 'api' });
    canvas.act(b.id, { action: 'start' });
    await settle();
    // nothing in progress in "api": B starts without an estimate first
    expect(item(b.id).state).toBe('working');
    // and a second card in "web" is judged against A only, and waits for it
    const c = canvas.board.create({ kind: 'feature', title: 'C', x: 0, y: 0 });
    canvas.act(c.id, { action: 'start' });
    await settle();
    scopeCall(['src/index.ts']);
    await settle();
    expect(estimate().inbox[0]).toContain('K1: "A"');
    expect(estimate().inbox[0]).not.toContain('"B"');
    scopeCall(['src/index.ts'], ['K1']);
    await settle();
    expect(item(c.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('accepting a proposal starts it', async () => {
    const b = canvas.board.create({ kind: 'feature', title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { kind: 'bugfix', title: 'Folgefehler', reason: 'R', suggestion: 'S' });
    canvas.act(p.id, { action: 'accept' });
    expect(item(p.id)).toMatchObject({ state: 'planned', queue: { checking: true } });
    await settle();
    expect(item(p.id).state).toBe('working');
    expect(() => canvas.act(p.id, { action: 'accept' })).toThrow();
  });

  test('a proposal can be edited, and accepted without starting', async () => {
    const b = canvas.board.create({ kind: 'feature', title: 'B', x: 0, y: 0 });
    const p = canvas.board.propose(b.id, { kind: 'bugfix', title: 'Folgefehler', reason: 'R', suggestion: 'S' });
    canvas.board.patch(p.id, { title: 'Folgefehler im Export', body: 'Nur den Export.', kind: 'feature' });
    canvas.act(p.id, { action: 'accept', start: false });
    await settle();
    expect(item(p.id)).toMatchObject({ state: 'planned', title: 'Folgefehler im Export', body: 'Nur den Export.', kind: 'feature' });
    expect(item(p.id).queue).toBeFalsy();
  });

  test('proposals keep the repository of the card they came from', () => {
    const b = canvas.board.create({ kind: 'feature', title: 'B', x: 0, y: 0, repo: 'api' });
    const p = canvas.board.propose(b.id, { kind: 'bugfix', title: 'Folgefehler', reason: 'R', suggestion: 'S' });
    expect(p.repo).toBe('api');
  });
});

test('the home repository stays home when the configuration lists the repositories in another order', () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const store = new Store(':memory:');
  const web = repo('web', 'Web');
  const api = repo('api', 'API');
  const deps = { store, home: dir, runtime: new FakeRuntime(), forge: { status: () => ({}) as never } };
  const first = new CanvasRuntime({ name: 'P', repos: [{ path: web }, { path: api }] }, deps);
  const card = first.board.create({ kind: 'feature', title: 'Home-Karte', x: 0, y: 0 });
  first.shutdown();
  const again = new CanvasRuntime({ name: 'P', repos: [{ path: api }, { path: web }] }, deps);
  expect(again.board.canvas.repos.map((r) => r.id)).toEqual(['web', 'api']);
  expect(again.board.item(card.id)!.repo).toBe('web');
  again.shutdown();
  expect(() => new CanvasRuntime({ name: 'P', repos: [{ path: api }] }, deps)).toThrow('home repository "web" is not configured');
  canvas = new CanvasRuntime({ name: 'Q', repos: [{ path: web }] }, deps);
});

test("the cards' workers run on their own runtime when one is given (a scratch Obeya's idle workers)", async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const web = repo('web', 'Web');
  const workers = new FakeRuntime();
  canvas.shutdown();
  canvas = new CanvasRuntime({ repos: [{ path: web, clones: 1 }] }, { store: new Store(':memory:'), home: dir, runtime, workerRuntime: workers, forge: { status: () => ({}) as never } });
  const a = canvas.board.create({ kind: 'feature', title: 'A', x: 0, y: 0 });
  canvas.act(a.id, { action: 'start' });
  await settle();
  expect(item(a.id).state).toBe('working');
  expect(workers.sessions.map((s) => s.spec.cwd)).toEqual([canvas.board.row(a.id).workspace!]);
  expect(runtime.sessions.some((s) => s.spec.cwd === canvas.board.row(a.id).workspace)).toBe(false);
});

test('a clone registered for a repository must be one of it', () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const web = repo('web', 'Web');
  const api = repo('api', 'API');
  git(dir, 'clone', '--quiet', api, join(dir, 'api-clone'));
  const deps = { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: { status: () => ({}) as never } };
  expect(() => new CanvasRuntime({ repos: [{ path: web, workspaces: [join(dir, 'api-clone')] }] }, deps)).toThrow('is not a clone of');
  canvas = new CanvasRuntime({ repos: [{ path: api, workspaces: [join(dir, 'api-clone')] }] }, deps);
  expect(canvas.repos[0]!.workspaces.list()).toHaveLength(1);
});

test('canvas ids read well', () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const c = new CanvasRuntime({ name: 'Grüße & Maße', repos: [{ path: repo('g', 'G') }] }, { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: { status: () => ({}) as never } });
  expect(c.id).toBe('grusse-masse');
  canvas = c;
});

test('a single repository keeps its canvas id and bare plan references', () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const only = repo('solo', 'Solo');
  const c = new CanvasRuntime({ repos: [{ path: only }] }, { store: new Store(':memory:'), home: dir, runtime: new FakeRuntime(), forge: { status: () => ({}) as never } });
  expect(c.board.canvas.id).toBe('solo');
  expect(c.board.snapshot().items.find((i) => i.kind === 'project')!.plan!.file).toBe('docs/plan/plan.md');
  canvas = c;
});

test('what the owner writes in a card, or says to the Koordinator without one, reaches the learner', async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-canvas-'));
  const web = repo('web', 'Web');
  canvas.shutdown();
  canvas = new CanvasRuntime({ repos: [{ path: web }] }, { store: new Store(':memory:'), home: dir, runtime, forge: { status: () => ({}) as never }, writingPauseMs: 30 });
  const learners = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'propose'));
  const done = async () => {
    learners().at(-1)!.emit({ type: 'idle' });
    await settle();
  };

  // a new card: what the owner typed, once they pause
  const a = canvas.board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
  canvas.patch(a.id, { body: 'CSV' });
  canvas.patch(a.id, { body: 'CSV, Spalten immer mit Einheit.' });
  await settle();
  expect(learners()).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 50));
  expect(learners()).toHaveLength(1);
  expect(learners()[0]!.inbox[0]).toContain("The owner's text of a card they wrote, the task for an agent: CSV, Spalten immer mit Einheit.");
  expect(learners()[0]!.inbox[0]).not.toContain('Before the owner wrote');
  await done();

  // a follow-up with a finding in it: at once when the owner acts on it, with the text it had before
  const b = canvas.board.create({ kind: 'bugfix', title: 'Datum', body: 'Befund: Datum fehlt.', from: a.id });
  canvas.patch(b.id, { body: 'Befund: Datum fehlt.\n\nImmer ISO-Datum.' });
  canvas.act(b.id, { action: 'split' });
  await settle();
  expect(learners()).toHaveLength(2);
  expect(learners()[1]!.inbox[0]).toContain("Before the owner wrote in it, the card's text read:\nBefund: Datum fehlt.");
  await done();

  // typed back to what it was, or deleted while being written: nothing
  const c = canvas.board.create({ kind: 'feature', title: 'C', body: 'Alt.', x: 0, y: 0 });
  canvas.patch(c.id, { body: 'Neu.' });
  canvas.patch(c.id, { body: 'Alt.' });
  const d = canvas.board.create({ kind: 'feature', title: 'D', x: 0, y: 0 });
  canvas.patch(d.id, { body: 'Weg damit.' });
  canvas.remove(d.id);
  await new Promise((r) => setTimeout(r, 50));
  expect(learners()).toHaveLength(2);

  // the conversation with the Koordinator, without a card open
  const heard = canvas.commander.hear('Warum fragen die Agenten so viel?', {});
  await settle();
  runtime.last.call('reply', { confirm: 'Weil die Karten offen lassen, wie weit sie gehen sollen.' });
  runtime.last.emit({ type: 'idle' });
  await heard;
  await settle();
  expect(learners()).toHaveLength(3);
  expect(learners()[2]!.spec.cwd).toBe(web);
  expect(learners()[2]!.inbox[0]).toContain('The Koordinator replied: Weil die Karten offen lassen');
});
