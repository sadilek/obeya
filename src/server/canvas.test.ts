import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { FakeRuntime } from './testing';
import { git } from './workspaces';

let dir: string;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;

/** A repository with one plan doc (same path in both). */
function repo(name: string, title: string) {
  const path = join(dir, name);
  mkdirSync(join(path, 'docs/plan'), { recursive: true });
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', path]);
  git(path, 'config', 'user.email', 't@example.com');
  git(path, 'config', 'user.name', 'T');
  writeFileSync(join(path, 'docs/plan/plan.md'), `# ${title}\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** Erster Schritt.\n`);
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'init');
  return path;
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
    const scopeCall = (files: string[]) => {
      const s = runtime.sessions.filter((x) => x.spec.tools.some((t) => t.name === 'scope')).at(-1)!;
      s.call('scope', { files, collides_with: [], reason: '' });
      s.emit({ type: 'idle' });
    };
    scopeCall(['src/index.ts']);
    await settle();
    const b = canvas.board.create({ kind: 'feature', title: 'B', x: 0, y: 0, repo: 'api' });
    canvas.act(b.id, { action: 'start' });
    await settle();
    // nothing in progress in "api": B starts without an estimate first
    expect(item(b.id).state).toBe('working');
    // and a second card in "web" with A's file waits
    const c = canvas.board.create({ kind: 'feature', title: 'C', x: 0, y: 0 });
    canvas.act(c.id, { action: 'start' });
    await settle();
    scopeCall(['src/index.ts']);
    await settle();
    scopeCall(['src/index.ts']);
    await settle();
    expect(item(c.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('proposals keep the repository of the card they came from', () => {
    const b = canvas.board.create({ kind: 'feature', title: 'B', x: 0, y: 0, repo: 'api' });
    const p = canvas.board.propose(b.id, { kind: 'bugfix', title: 'Folgefehler', reason: 'R', suggestion: 'S' });
    expect(p.repo).toBe('api');
  });
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
