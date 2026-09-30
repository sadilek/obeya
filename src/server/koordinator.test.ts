import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { Board } from './board';
import { Store } from './db';
import { Koordinator, overlaps } from './koordinator';
import { FakeRuntime, type FakeSession } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let workspaces: Workspaces;
let k: Koordinator;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-k-'));
  const main = join(dir, 'main');
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', main]);
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repoPath: main, branch: 'main' }, () => []);
  const adapter = { ...generic, land: 'main' as const, workspaces: 'worktrees' as const, softPaths: ['docs/'] };
  workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') });
  runtime = new FakeRuntime();
  workers = new Workers({ board, runtime, workspaces, adapter });
  k = new Koordinator({ board, runtime, workers, workspaces, adapter, repoPath: main });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 5));
const card = (title: string) => board.create({ kind: 'feature', title, x: 0, y: 0 });
const item = (id: string) => board.item(id)!;
const estimates = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'scope'));
const workerOf = (id: string) => runtime.sessions.find((s) => s.spec.cwd === board.row(id).workspace)!;

/** Answers the latest open estimate. */
async function scope(files: string[], collides: string[] = [], reason = 'Grund.') {
  await settle();
  const s = estimates().at(-1) as FakeSession;
  s.call('scope', { files, collides_with: collides, reason });
  s.emit({ type: 'idle' });
  await settle();
}

describe('Koordinator', () => {
  test('a card with nothing in progress starts, with its estimated scope stored', async () => {
    const a = card('A');
    k.request(a.id);
    expect(item(a.id).queue).toEqual({ checking: true });
    await scope(['src/a.ts']);
    expect(item(a.id)).toMatchObject({ state: 'working', scope: ['src/a.ts'] });
    expect(item(a.id).queue).toBeUndefined();
    expect(estimates()[0]!.spec).toMatchObject({ readOnly: true });
  });

  test('an overlapping card waits and starts when the other one has landed', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await settle();
    expect(estimates().at(-1)!.inbox[0]).toContain('"A"');
    await scope(['src/a.ts', 'src/b.ts'], [], 'Beide ändern src/a.ts.');
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { behind: [a.id], reason: 'Beide ändern src/a.ts.' } });

    const wa = board.row(a.id).workspace!;
    writeFileSync(join(wa, 'a.ts'), 'a');
    git(wa, 'add', '.');
    git(wa, 'commit', '--quiet', '-m', 'A');
    workerOf(a.id).call('ready_for_review', { summary: 'S' });
    await workers.approve(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('actual changes of a card in progress count, soft paths do not', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['docs/plan.md']);
    writeFileSync(join(board.row(a.id).workspace!, 'x.ts'), 'x');
    const b = card('B');
    k.request(b.id);
    await scope(['docs/plan.md', 'src/b.ts']);
    expect(item(b.id).state).toBe('working');
    const c = card('C');
    k.request(c.id);
    await scope(['x.ts']);
    expect(item(c.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('the Koordinator may judge a collision without overlapping files', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts'], ['K1'], 'Gleicher Ablauf.');
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('two cards requested together are decided one after the other', async () => {
    const a = card('A');
    const b = card('B');
    k.request(a.id);
    k.request(b.id);
    await settle();
    expect(estimates()).toHaveLength(1);
    await scope(['src/shared.ts']);
    await scope(['src/shared.ts']);
    expect(item(a.id).state).toBe('working');
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('force starts a waiting card, dequeue takes it out, stop frees the queue', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts']);
    k.dequeue(b.id);
    expect(item(b.id).queue).toBeUndefined();

    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts']);
    k.force(c.id);
    expect(item(c.id).state).toBe('working');

    const d = card('D');
    k.request(d.id);
    await scope(['src/a.ts']);
    expect(item(d.id).queue).toMatchObject({ behind: [a.id, c.id] });
    workers.stop(a.id);
    await settle();
    expect(item(d.id).queue).toMatchObject({ behind: [c.id] });
    workers.stop(c.id);
    await settle();
    expect(item(d.id).state).toBe('working');
  });

  test('without an estimate the card still starts, and says why', async () => {
    const a = card('A');
    k.request(a.id);
    await settle();
    estimates()[0]!.emit({ type: 'idle' });
    await settle();
    expect(item(a.id).state).toBe('working');
    expect(board.events(a.id).some((e) => e.kind === 'error' && e.text.includes('nicht schätzen'))).toBe(true);
  });
});

test('overlaps', () => {
  expect(overlaps('src/a.ts', 'src/a.ts')).toBe(true);
  expect(overlaps('src/', 'src/a.ts')).toBe(true);
  expect(overlaps('src/ui/a.ts', 'src/')).toBe(true);
  expect(overlaps('src/a.ts', 'src/ab.ts')).toBe(false);
  expect(overlaps('src', 'src/a.ts')).toBe(false);
});
