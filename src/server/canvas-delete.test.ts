import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
    atWork: (id) => set.get(id)?.atWorkTitles() ?? [],
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
  expect(await refusal(() => config.save([both()[1]], { deletes: ['shop'] }))).toBe('canvasAtWork');
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
  expect(await config.deletion('shop')).toMatchObject({ id: 'shop', name: 'Shop', cards: 3, archived: 0, unlanded: 1, prs: 0, running: [], folder: false, last: false });

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

test("nothing another canvas lists goes, even inside the deleted canvas's folder; a link there is not followed; its apps are stopped first", async () => {
  const stopped = join(dir, 'stopped.txt');
  const outside = join(dir, 'outside');
  mkdirSync(join(outside, 'precious'), { recursive: true });
  writeFileSync(join(outside, 'precious', 'x'), 'x');
  // another canvas works in a clone that lies in the deleted canvas's folder; a link there leads elsewhere
  const inside = gitClone(blog, join(home, 'workspaces', 'shop', 'blog-clone'));
  await open([
    { name: 'Shop', repos: [{ path: shop, settings: { land: 'pr', app: { run: 'bun dev', stop: `echo stopped > ${stopped}` } } }] },
    { name: 'Blog', repos: [{ path: blog, workspaces: [inside], settings: { land: 'pr' } }] },
  ]);
  const { handOver } = await atWork('shop', 'Checkout');
  await handOver();
  symlinkSync(outside, join(home, 'workspaces', 'shop', 'link'));
  await config.deleteCanvas('shop');
  expect(existsSync(join(inside, '.git'))).toBe(true);
  expect(readFileSync(join(outside, 'precious', 'x'), 'utf8')).toBe('x');
  expect(existsSync(stopped)).toBe(true);
});

test('saving removes no canvas; the only canvas is not deleted', async () => {
  await open(both());
  expect(await refusal(() => config.save([both()[1]]))).toBe('canvasLeft');
  expect(saved().map((c) => c.name)).toEqual(['Shop', 'Blog']);
  await config.deleteCanvas('shop');
  expect(await refusal(() => config.deleteCanvas('blog'))).toBe('lastCanvas');
  expect((await config.deletion('blog')).last).toBe(true);
});

test("the Coordinator's configure deletes a canvas it names and leaves out, as the bin does; one left out it does not name stops the save", async () => {
  await open(both());
  set.get('shop')!.board.create({ title: 'Gone with it', x: 0, y: 0 });
  // renamed without its id: Shop counts as left out, but the command named nothing to delete
  expect(await refusal(() => config.save([{ ...both()[0]!, name: 'Store' }, both()[1]!], { deletes: [] }))).toBe('canvasLeft');
  expect(set.get('shop')!.board.items().map((i) => i.title)).toContain('Gone with it');
  expect(saved().map((c) => c.name)).toEqual(['Shop', 'Blog']);
  await config.save([both()[1]], { deletes: ['shop'] });
  expect(set.all().map((c) => c.id)).toEqual(['blog']);
  expect(store.everyCard('shop')).toEqual([]);
});

test('a configure recorded before a canvas was added deletes only what it named, never the canvas added meanwhile', async () => {
  await open(both());
  // recorded as Shop and Blog, then Wiki added before it runs
  const recorded = both();
  const wiki = gitRepo(join(dir, 'wiki'));
  await config.save([...both(), { name: 'Wiki', repos: [{ path: wiki, settings: { land: 'pr' } }] }]);
  await until(() => !!set.get('wiki'));
  expect(await refusal(() => config.save(recorded, { deletes: [] }))).toBe('canvasLeft');
  expect(set.get('wiki')).toBeDefined();
  expect(saved().map((c) => c.name)).toEqual(['Shop', 'Blog', 'Wiki']);
});

test('a canvas whose name names no folder of its own gets its id from its repository, and deleting it leaves the other canvases alone', async () => {
  await open([{ name: '商店', repos: [{ path: shop, settings: { land: 'pr' } }] }, both()[1]!]);
  expect(set.all().map((c) => c.id).sort()).toEqual(['blog', 'shop']);
  for (const d of ['workspaces', 'files']) {
    mkdirSync(join(home, d, 'blog'), { recursive: true });
    writeFileSync(join(home, d, 'blog', 'x'), 'x');
  }
  await config.deleteCanvas('shop');
  for (const d of ['workspaces', 'files']) expect(readFileSync(join(home, d, 'blog', 'x'), 'utf8')).toBe('x');
  expect(existsSync(home)).toBe(true);
});

test('work a card set aside in a clone, or left on its branch without a workspace, counts as lost', async () => {
  await open([{ name: 'Shop', repos: [{ path: shop, settings: { land: 'pr' } }] }, both()[1]!]);
  const c = set.get('shop')!;
  // its clone, one Obeya made for the canvas, holds its branch with a commit main lacks
  const parked = c.board.create({ title: 'Parked', x: 0, y: 0 });
  const clone = gitClone(shop, join(home, 'workspaces', 'shop', 'repo', '1'));
  git(clone, 'checkout', '-q', '-b', 'obeya/parked');
  commit(clone, 'parked.ts');
  store.update(parked.id, { kept_in: clone, branch: 'obeya/parked' });
  // one set aside without work of its own: nothing is lost
  const clean = c.board.create({ title: 'Clean', x: 0, y: 0 });
  const other = gitClone(shop, join(home, 'workspaces', 'shop', 'repo', '2'));
  git(other, 'checkout', '-q', '-b', 'obeya/clean');
  store.update(clean.id, { kept_in: other, branch: 'obeya/clean' });
  // a branch with a commit main does not have, its worktree gone
  const branched = c.board.create({ title: 'Branched', x: 0, y: 0 });
  git(shop, 'branch', 'obeya/branched');
  git(shop, 'worktree', 'add', join(dir, 'tmp-wt'), 'obeya/branched');
  commit(join(dir, 'tmp-wt'), 'more.ts');
  git(shop, 'worktree', 'remove', '--force', join(dir, 'tmp-wt'));
  store.update(branched.id, { branch: 'obeya/branched' });
  // a branch main already has
  const landed = c.board.create({ title: 'Landed', x: 0, y: 0 });
  git(shop, 'branch', 'obeya/landed');
  store.update(landed.id, { branch: 'obeya/landed' });
  expect((await config.deletion('shop')).unlanded).toBe(2);
});

test('a look-up in the sheet holds the canvas as an agent at work does, and ends with the delete', async () => {
  await open(both());
  const c = set.get('shop')!;
  const talk = c.board.sheet.add('What is in the plan?', '', { lookUp: { question: 'What is in the plan?', about: null } });
  (c.answers as unknown as { busy: Set<number> }).busy.add(talk);
  expect((await config.deletion('shop')).running.map((r) => [r.title, r.lookUp])).toEqual([['What is in the plan?', true]]);
  expect(await refusal(() => config.deleteCanvas('shop'))).toBe('canvasAtWork');
});

test("cards that moved to another canvas keep their decisions, friction and costs once the canvas they came from is deleted", async () => {
  await open(both());
  const project = set.get('shop')!.board.create({ title: 'Project', x: 0, y: 0 });
  const moved = set.get('shop')!.board.create({ title: 'Moves', x: 0, y: 0 });
  store.addDecision({ canvas_id: 'shop', project_id: project.id, card_id: moved.id, question: 'Q?', answer: 'A', by: 'owner' } as never);
  store.moveCard(moved.id, 'blog', { x: 0, y: 0 });
  await config.deleteCanvas('shop');
  expect(store.card(moved.id)).not.toBeNull();
  expect(store.cardDecisions('blog', moved.id).map((d) => d.answer)).toEqual(['A']);
});

test('a delete while another save changed the configuration meanwhile is refused, and nothing of the canvas goes', async () => {
  await open(both());
  await config.checkSaved();
  const deleting = refusal(() => config.deleteCanvas('shop'));
  // saved by hand (or another tab) between the dialog's read and the delete, while it checks what is saved
  await new Promise((r) => setTimeout(r, 0));
  writeFileSync(file(), `${JSON.stringify([...both(), { name: 'Wiki', repos: [{ path: blog }] }], null, 1)}\n`);
  expect(await deleting).toBe('config');
  expect(set.get('shop')).toBeDefined();
});

test('a canvas served under an id that names no folder before keeps it, with its cards, and deleting it leaves every folder alone', async () => {
  store.ensureCanvas('', '商店');
  store.insert([{ canvas_id: '', kind: 'task', title: 'From before', x: 0, y: 0 }]);
  await open([{ name: '商店', repos: [{ path: shop, settings: { land: 'pr' } }] }, both()[1]!]);
  expect(set.all().map((c) => c.id).sort()).toEqual(['', 'blog']);
  mkdirSync(join(home, 'workspaces', 'blog'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'blog', 'x'), 'x');
  await config.save([both()[1]!], { deletes: [''] });
  expect(set.all().map((c) => c.id)).toEqual(['blog']);
  expect(readFileSync(join(home, 'workspaces', 'blog', 'x'), 'utf8')).toBe('x');
});

test('saves and deletes run one after the other: a delete waits for the save before it, and keeps what that save added', async () => {
  await open(both());
  const wiki = gitRepo(join(dir, 'wiki'));
  const adding = config.save([...both(), { name: 'Wiki', repos: [{ path: wiki, settings: { land: 'pr' } }] }]);
  const deleting = config.deleteCanvas('shop');
  await Promise.all([adding, deleting]);
  expect(saved().map((c) => c.name)).toEqual(['Blog', 'Wiki']);
});
