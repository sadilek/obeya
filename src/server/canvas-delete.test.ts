import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasConfig } from '../core/config';
import { Canvases } from './canvases';
import { Config } from './config';
import { Store } from './db';
import { git } from './git';
import { BadRequest } from './board';
import { artifact, commit, FakeRuntime, gitClone, gitRepo, noForge, removeDir, until } from './testing';

let dir: string;
let home: string;
let store: Store;
let workers: FakeRuntime;
let set: Canvases;
let config: Config;
let shop: string;
let blog: string;

const file = () => join(dir, 'canvases.json');
/** The code a call is refused with, once it settles; none where it goes through. */
async function refusal(act: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await act();
  } catch (e) {
    if (e instanceof BadRequest) return e.code;
    throw e;
  }
}
const saved = () => JSON.parse(readFileSync(file(), 'utf8')) as CanvasConfig[];

/** Obeya with the canvases Shop and Blog, as `configs` has them, from its file; `remove` as main.ts wires it. */
async function open(configs: CanvasConfig[]) {
  writeFileSync(file(), JSON.stringify(configs));
  config = new Config({
    file: file(),
    source: 'file',
    started: configs,
    store,
    running: () => set.all().map((c) => c.id),
    server: { port: 4417, home, permissionMode: 'auto' },
    apply: (c, ids) => set.apply(c, ids),
    deleteCanvases: (ids, s) => set.delete(ids, s),
    atWork: (id) => set.get(id)?.atWork().map((i) => i.title) ?? [],
    deletion: (id) => set.get(id)?.deletion(),
  });
  set = await Canvases.start(configs, { store, home, runtime: new FakeRuntime(), workerRuntime: workers, forge: noForge, restartIntervalMs: 5 });
}

/** A card of the canvas whose worker is in the middle of a turn, in a workspace git made ready. */
async function atWork(canvas: string, title: string) {
  const c = set.get(canvas)!;
  const card = c.board.create({ title, x: 0, y: 0 });
  await c.repos[0]!.workers.start(card.id);
  await c.repos[0]!.workers.prepared();
  const session = workers.last;
  const workspace = () => c.board.row(card.id).workspace!;
  /** The worker commits `file` and hands its work over: the card waits for the owner. */
  const handOver = async (file = 'work.ts') => {
    commit(workspace(), file);
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    session.emit({ type: 'idle' });
    await until(() => c.atWork().length === 0);
  };
  return { card, session, workspace, handOver };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-delete-'));
  home = join(dir, 'home');
  store = new Store(':memory:');
  workers = new FakeRuntime();
  shop = gitRepo(join(dir, 'shop'), { 'docs/plan/plan.md': '# Shop\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** First.\n' });
  blog = gitRepo(join(dir, 'blog'));
});
afterEach(async () => {
  set?.shutdown();
  await Promise.all(set?.all().flatMap((c) => c.repos.map((r) => r.workers.freed())) ?? []);
  await removeDir(dir);
});

const both = (): CanvasConfig[] => [
  { name: 'Shop', repos: [{ path: shop, settings: { land: 'pr' } }] },
  { name: 'Blog', repos: [{ path: blog, settings: { land: 'pr' } }] },
];

test('a canvas is not deleted while an agent works on it, also one that started after the panel counted', async () => {
  await open(both());
  expect((await config.deletion('shop')).running).toEqual([]);
  // the panel counted none at work; then a card starts, before the owner presses Delete
  const { card, handOver } = await atWork('shop', 'Checkout');
  expect((await config.deletion('shop')).running.map((r) => r.title)).toEqual(['Checkout']);
  expect(await refusal(() => config.deleteCanvas('shop'))).toBe('canvasAtWork');
  expect(set.get('shop')).toBeDefined();
  expect(saved().map((c) => c.name)).toEqual(['Shop', 'Blog']);
  expect(store.card(card.id)).not.toBeNull();
  // so is the Coordinator's configure that leaves it out
  expect((await config.leftOut((await config.check([both()[1]])).resolved)).map((l) => [l.id, l.atWork])).toEqual([['shop', ['Checkout']]]);
  expect(await refusal(() => config.save([both()[1]], { deletes: true }))).toBe('canvasAtWork');
  // once it waits for the owner it no longer holds the canvas
  await handOver();
  await config.deleteCanvas('shop');
  expect(set.get('shop')).toBeUndefined();
});

test('deleting a canvas takes its cards, workspaces, branches and files, and leaves its repository, the other canvas and pushed work alone', async () => {
  git(shop, 'remote', 'add', 'origin', gitClone(shop, join(dir, 'origin.git'), { bare: true }));
  await open(both());
  const kept = set.get('blog')!.board.create({ title: 'Stays', x: 0, y: 0 });
  // a card with work that never landed, its branch pushed too
  const { card, workspace, handOver } = await atWork('shop', 'Checkout');
  const ws = workspace();
  const branch = git(ws, 'rev-parse', '--abbrev-ref', 'HEAD');
  await handOver('pay.ts');
  git(ws, 'push', '--quiet', 'origin', branch);
  for (const d of ['images', 'files', 'answers', 'undo']) {
    mkdirSync(join(home, d, 'shop'), { recursive: true });
    writeFileSync(join(home, d, 'shop', 'x'), 'x');
  }
  expect(await config.deletion('shop')).toMatchObject({ id: 'shop', name: 'Shop', unlanded: 1, prs: 0, running: [], folder: false, last: false });

  await config.deleteCanvas('shop');
  expect(set.all().map((c) => c.id)).toEqual(['blog']);
  expect(saved().map((c) => c.name)).toEqual(['Blog']);
  expect(store.canvasName('shop')).toBeNull();
  expect(store.everyCard('shop')).toEqual([]);
  expect(store.card(card.id)).toBeNull();
  // its worktree and branch went; the repository, its main and the branch on origin stay
  expect(existsSync(ws)).toBe(false);
  expect(git(shop, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toEqual([`worktree ${git(shop, 'rev-parse', '--show-toplevel')}`]);
  expect(git(shop, 'branch', '--list', branch)).toBe('');
  expect(git(join(dir, 'origin.git'), 'branch', '--list', branch)).toContain(branch);
  expect(readFileSync(join(shop, 'docs/plan/plan.md'), 'utf8')).toContain('# Shop');
  // its folders under Obeya's home are gone, once the background removal is through
  for (const d of ['workspaces', 'read', 'images', 'files', 'answers', 'undo']) expect(existsSync(join(home, d, 'shop'))).toBe(false);
  await until(() => ['workspaces', 'images', 'files', 'answers', 'undo'].every((d) => !existsSync(join(home, d)) || !readdirSync(join(home, d)).some((n) => n.startsWith('shop'))));
  // the other canvas is as it was
  expect(set.get('blog')!.board.item(kept.id)?.title).toBe('Stays');

  // added again, the canvas starts empty: its plan doc's project, none of the cards it had
  await config.save(both());
  await until(() => !!set.get('shop'));
  expect(set.get('shop')!.board.items().map((i) => i.title)).not.toContain('Checkout');
  expect(store.everyCard('shop').map((c) => c.id)).not.toContain(card.id);
});

test("a clone the owner listed stays as it is; the clones Obeya made go", async () => {
  const listed = gitClone(shop, join(dir, 'shop-listed'));
  await open([{ name: 'Shop', repos: [{ path: shop, clones: 1, workspaces: [listed], settings: { land: 'pr' } }] }, both()[1]!]);
  await until(() => set.get('shop')!.repos[0]!.workspaces.list().length === 2);
  const made = set.get('shop')!.repos[0]!.workspaces.list().map((w) => w.path).find((p) => p !== listed)!;
  writeFileSync(join(listed, 'mine.txt'), 'the owner’s\n');
  await config.deleteCanvas('shop');
  expect(existsSync(made)).toBe(false);
  expect(readFileSync(join(listed, 'mine.txt'), 'utf8')).toBe('the owner’s\n');
});

test('saving removes no canvas; the only canvas is not deleted', async () => {
  await open(both());
  expect(await refusal(() => config.save([both()[1]]))).toBe('canvasLeft');
  expect(saved().map((c) => c.name)).toEqual(['Shop', 'Blog']);
  await config.deleteCanvas('shop');
  expect(await refusal(() => config.deleteCanvas('blog'))).toBe('lastCanvas');
  expect((await config.deletion('blog')).last).toBe(true);
});

test("the Coordinator's configure deletes a canvas it leaves out, as the bin does", async () => {
  await open(both());
  set.get('shop')!.board.create({ title: 'Gone with it', x: 0, y: 0 });
  await config.save([both()[1]], { deletes: true });
  expect(set.all().map((c) => c.id)).toEqual(['blog']);
  expect(store.everyCard('shop')).toEqual([]);
});

test('a delete while another save changed the configuration meanwhile is refused, and nothing of the canvas goes', async () => {
  await open(both());
  await config.checkSaved();
  const deleting = refusal(() => config.deleteCanvas('shop'));
  // saved by hand (or another tab) between the dialog's read and the delete
  writeFileSync(file(), `${JSON.stringify([...both(), { name: 'Wiki', repos: [{ path: blog }] }], null, 1)}\n`);
  expect(await deleting).toBe('config');
  expect(set.get('shop')).toBeDefined();
});
