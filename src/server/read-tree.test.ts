import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { ReadTree, refsSeal } from './read-tree';
import { artifact, FakeRuntime, gitRepo, identify, noForge, syncGitCalls, until } from './testing';
import { git } from './workspaces';

const doc = (title: string, ticked = '') =>
  `# ${title}\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [${ticked.includes('W1') ? 'x' : ' '}] **W1:** Eins.\n- [${ticked.includes('W2') ? 'x' : ' '}] **W2:** Zwei.\n`;

let dir: string;
let origin: string;
/** The configured checkout: a pool clone, which cards lease. */
let checkout: string;
/** Another clone, from which work reaches `origin`. */
let other: string;
let canvas: CanvasRuntime | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-read-'));
  origin = gitRepo(join(dir, 'origin'), { 'docs/plan/export.md': doc('Export') });
  git(origin, 'config', 'receive.denyCurrentBranch', 'ignore');
  checkout = join(dir, 'checkout');
  other = join(dir, 'other');
  for (const c of [checkout, other]) {
    git(dir, 'clone', '--quiet', origin, c);
    identify(c);
  }
});
afterEach(() => {
  canvas?.shutdown();
  canvas = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A commit pushed to `origin`'s main from the other clone. */
function push(files: Record<string, string | null>) {
  git(other, 'pull', '--quiet', '--ff-only');
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(other, f));
    else {
      mkdirSync(join(other, f, '..'), { recursive: true });
      writeFileSync(join(other, f), text);
    }
  }
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', 'change');
  git(other, 'push', '--quiet', 'origin', 'main');
}

// its `origin` stands in for one on GitHub, where work goes out as pull requests
async function open(land: 'main' | 'pr' = 'pr') {
  canvas = await CanvasRuntime.start({ name: 'Shop', repos: [{ path: checkout, settings: { land } }] }, { store: new Store(':memory:'), home: join(dir, 'home'), runtime: new FakeRuntime(), forge: noForge });
  return canvas;
}

const projects = (c: CanvasRuntime) =>
  c.board
    .snapshot()
    .items.filter((i) => i.kind === 'project')
    .map((p) => p.title)
    .sort();

describe('the Lesestand', () => {
  test("is a worktree on the default branch: a card's branch in the checkout without the plan doc leaves the project on the canvas", async () => {
    git(checkout, 'checkout', '--quiet', '-b', 'obeya/card');
    git(checkout, 'rm', '--quiet', 'docs/plan/export.md');
    git(checkout, 'commit', '--quiet', '-m', 'card');
    const c = await open();
    // named after the repository, which is named after its remote
    expect(c.repos[0]!.read.path).toBe(join(dir, 'home', 'read', 'shop', 'origin'));
    expect(projects(c)).toEqual(['Export']);
    // the checkout's working tree is the card's, untouched; leasing finds it clean
    expect(existsSync(join(checkout, 'docs/plan/export.md'))).toBe(false);
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    git(checkout, 'checkout', '--quiet', 'main');
    git(checkout, 'checkout', '--quiet', 'obeya/card');
    c.board.docsChanged();
    expect(projects(c)).toEqual(['Export']);
  });

  test('of a repository on master without a remote is on master, while the checkout is on a card\'s branch', async () => {
    checkout = origin;
    git(checkout, 'branch', '-m', 'master');
    git(checkout, 'checkout', '--quiet', '-b', 'obeya/card');
    git(checkout, 'rm', '--quiet', 'docs/plan/export.md');
    git(checkout, 'commit', '--quiet', '-m', 'card');
    const c = await open();
    expect(c.repos[0]!.read.path).toBe(join(dir, 'home', 'read', 'shop', 'origin'));
    expect(projects(c)).toEqual(['Export']);
    expect(c.board.snapshot().canvas.repos[0]!.branch).toBe('master');
  });

  test('shows a doc that reached origin once it refreshes, and lets a deleted one go', async () => {
    const c = await open();
    push({ 'docs/plan/import.md': doc('Import') });
    expect(projects(c)).toEqual(['Export']);
    await c.repos[0]!.read.refresh();
    expect(projects(c)).toEqual(['Export', 'Import']);
    push({ 'docs/plan/export.md': null });
    await c.repos[0]!.read.refresh();
    expect(projects(c)).toEqual(['Import']);
  });

  test('a workstream ticked off in a merged pull request goes live with the merge', async () => {
    const c = await open();
    const ws = (label: string) => c.board.snapshot().items.find((i) => i.label === label)!;
    expect([ws('W1').state, ws('W2').state]).toEqual(['planned', 'planned']);
    c.board.work(ws('W1').id, { state: 'inPr', pr: JSON.stringify({ url: 'https://example.com/pr/1' }) });
    push({ 'docs/plan/export.md': doc('Export', 'W1') });
    c.repos[0]!.workers.merged(ws('W1').id);
    // the merge started the refresh; a second call waits for the same one
    await c.repos[0]!.read.refresh();
    expect([ws('W1').state, ws('W2').state]).toEqual(['live', 'planned']);
  });

  test('is the checkout itself where work lands on the local main, uncommitted docs included', async () => {
    writeFileSync(join(checkout, 'docs/plan/draft.md'), doc('Entwurf'));
    const c = await open('main');
    expect(c.repos[0]!.read.path).toBe(checkout);
    expect(projects(c)).toEqual(['Entwurf', 'Export']);
    expect(existsSync(join(dir, 'home', 'read'))).toBe(false);
  });

  test('takes the local main where it has everything of origin, else origin', async () => {
    const read = join(dir, 'read');
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
    await tree.ready;
    writeFileSync(join(checkout, 'local.md'), 'x\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '--quiet', '-m', 'local');
    await tree.refresh();
    expect(existsSync(join(read, 'local.md'))).toBe(true);
    // origin moves on without it: the local main no longer has everything, so origin counts
    push({ 'remote.md': 'y\n' });
    await tree.refresh();
    expect([existsSync(join(read, 'local.md')), existsSync(join(read, 'remote.md'))]).toEqual([false, true]);
  });

  test('makes a missing, broken or foreign worktree afresh', async () => {
    const read = join(dir, 'read');
    const make = async () => {
      const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
      await tree.ready;
      return tree;
    };
    const head = git(checkout, 'rev-parse', 'main');
    const on = () => git(read, 'rev-parse', 'HEAD');
    await make();
    expect(on()).toBe(head);
    // reused as it is
    writeFileSync(join(read, 'marker'), '');
    await make();
    expect(existsSync(join(read, 'marker'))).toBe(true);
    // gone
    rmSync(read, { recursive: true, force: true });
    expect((await make()).path).toBe(read);
    expect(on()).toBe(head);
    // broken: its link to the repository points nowhere
    writeFileSync(join(read, '.git'), 'gitdir: /nowhere\n');
    await make();
    expect(on()).toBe(head);
    expect(git(checkout, 'worktree', 'list').split('\n')).toHaveLength(2);
    // another repository's
    rmSync(read, { recursive: true, force: true });
    git(origin, 'worktree', 'add', '--quiet', '--detach', read);
    await make();
    expect(git(read, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads the checkout while its directory cannot be made afresh', async () => {
    // a directory that is no worktree and whose files cannot go, as one an agent works in on Windows
    const read = join(dir, 'read');
    mkdirSync(read);
    writeFileSync(join(read, 'kept'), '');
    chmodSync(read, 0o555);
    try {
      const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
      await tree.ready;
      expect(tree.path).toBe(checkout);
    } finally {
      chmodSync(read, 0o755);
    }
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
    await tree.ready;
    expect(tree.path).toBe(read);
  });

  test('is read where it was at once, without the server waiting for git, and brought up to date', async () => {
    const read = join(dir, 'read');
    await new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} }).ready;
    const before = git(read, 'rev-parse', 'HEAD');
    git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'moved on');
    let changes = 0;
    const synced = syncGitCalls();
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => void changes++ });
    expect(synced.stop()).toEqual([]);
    expect([tree.path, git(read, 'rev-parse', 'HEAD')]).toEqual([read, before]);
    await tree.ready;
    // no fetch moved it: cards waiting for one are not told it came (`onChange`)
    expect([changes, git(read, 'rev-parse', 'HEAD')]).toEqual([0, git(checkout, 'rev-parse', 'HEAD')]);
    // where there was none, the checkout is read until it is made
    rmSync(read, { recursive: true, force: true });
    const fresh = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
    expect(fresh.path).toBe(checkout);
    await fresh.ready;
    expect(fresh.path).toBe(read);
  });

  test('tells whether it holds a commit without the server waiting for git, and asks again once it moved', async () => {
    const read = join(dir, 'read');
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
    await tree.ready;
    const held = git(read, 'rev-parse', 'HEAD');
    push({ 'docs/plan/import.md': doc('Import') });
    const ahead = git(origin, 'rev-parse', 'HEAD');
    let told = 0;
    const tell = () => void told++;
    const synced = syncGitCalls();
    // not known yet: not held, until git says it is
    expect([tree.holds(held, tell), tree.holds(ahead, tell)]).toEqual([false, false]);
    await until(() => told === 1);
    // known while it stands where it was
    expect([tree.holds(held, tell), tree.holds(ahead, tell)]).toEqual([true, false]);
    await tree.refresh();
    expect([tree.holds(held, tell), tree.holds(ahead, tell)]).toEqual([false, false]);
    await until(() => told === 3);
    expect([tree.holds(held), tree.holds(ahead)]).toEqual([true, true]);
    expect(synced.stop()).toEqual([]);
  });

  test('where the checkout is read and its HEAD cannot be sealed, a commit it lacks is asked again', async () => {
    const tree = new ReadTree({ repoPath: checkout, dir: null, remote: false, onChange: () => {} });
    // HEAD follows a branch that follows main: `stat`s cannot tell where it moved
    git(checkout, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    git(checkout, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    git(checkout, 'checkout', '--quiet', '-b', 'side');
    git(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'side');
    const side = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    git(checkout, 'reset', '--quiet', '--hard', 'main');
    let told = 0;
    const tell = () => void told++;
    expect(tree.holds(side, tell)).toBe(false);
    await Bun.sleep(100);
    expect([tree.holds(side, tell), told]).toEqual([false, 0]);
    git(checkout, 'merge', '--quiet', '--ff-only', 'side');
    await until(() => tree.holds(side, tell));
    expect(told).toBe(1);
  });

  test('keeps its commit when the fetch fails, and catches up once it works again', async () => {
    let changes = 0;
    const read = join(dir, 'read');
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => void changes++ });
    await tree.ready;
    push({ 'docs/plan/import.md': doc('Import') });
    renameSync(origin, `${origin}-away`);
    await tree.refresh();
    expect([changes, existsSync(join(read, 'docs/plan/import.md'))]).toEqual([0, false]);
    renameSync(`${origin}-away`, origin);
    await tree.refresh();
    expect([changes, existsSync(join(read, 'docs/plan/import.md'))]).toEqual([1, true]);
  });
});

describe("the seal of a repository's refs", () => {
  test("stays while only the cards' branches move, and breaks once main or origin's main moves, or the refs are packed", () => {
    const seal = () => refsSeal(checkout);
    // the checkout on a card's branch, as a lease leaves it
    git(checkout, 'checkout', '--quiet', '-b', 'obeya/export-a1');
    const first = seal();
    expect(first).not.toBeNull();
    writeFileSync(join(checkout, 'a.md'), 'a\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '--quiet', '-m', 'A');
    git(checkout, 'worktree', 'add', '--quiet', '-b', 'obeya/import-b2', join(dir, 'tree'));
    git(checkout, 'checkout', '--quiet', '--detach');
    expect(seal()).toBe(first);
    // a worktree on a card's branch tells the same seal as its checkout
    expect(refsSeal(join(dir, 'tree'))).toBe(first);

    git(checkout, 'checkout', '--quiet', 'main');
    git(checkout, 'merge', '--quiet', '--ff-only', 'obeya/export-a1');
    const merged = seal();
    expect(merged).not.toBe(first);
    push({ 'b.md': 'b\n' });
    git(checkout, 'fetch', '--quiet', 'origin');
    const fetched = seal();
    expect(fetched).not.toBe(merged);
    git(checkout, 'pack-refs', '--all');
    const packed = seal();
    expect(packed).not.toBe(fetched);
    // the branch the checkout is on may tell the main branch, unless it is a card's
    git(checkout, 'checkout', '--quiet', '-b', 'release');
    expect(seal()).not.toBe(packed);
  });

  test("is none where a branch names a card's, which it moves with; a branch of its own with the cards' prefix inside its name counts", () => {
    git(checkout, 'branch', 'release/obeya/stable');
    const before = refsSeal(checkout);
    git(checkout, 'checkout', '--quiet', 'release/obeya/stable');
    writeFileSync(join(checkout, 'r.md'), 'r\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '--quiet', '-m', 'R');
    git(checkout, 'checkout', '--quiet', '--detach');
    expect(refsSeal(checkout)).not.toBe(before);

    // `ref: refs/heads/obeya/` and a name that makes the file as long as a commit's hash
    git(checkout, 'branch', 'obeya/source-c3xxxxxxxxx');
    git(checkout, 'symbolic-ref', 'refs/heads/trunk', 'refs/heads/obeya/source-c3xxxxxxxxx');
    expect(refsSeal(checkout)).toBeNull();
  });

  test('is none where there is no git repository', () => {
    expect(refsSeal(dir)).toBeNull();
  });
});

describe("a repository's settings for everyone", () => {
  const settings = (o: object) => `${JSON.stringify(o)}\n`;
  const openWatched = async (repo: string, runtime = new FakeRuntime(), clones?: number) => {
    canvas = await CanvasRuntime.start(
      { name: 'Shop', repos: [{ path: repo, ...(clones ? { clones } : {}) }] },
      { store: new Store(':memory:'), home: join(dir, 'home'), runtime, forge: noForge, restartIntervalMs: 10 },
    );
    return canvas;
  };

  test("a new version on the default branch applies without a restart; one that moves where the workers work restarts them", async () => {
    // its `origin` stands in for one on GitHub: the settings say that work goes out as pull requests
    push({ '.obeya/settings.json': settings({ land: 'pr' }) });
    git(checkout, 'pull', '--quiet');
    const c = await openWatched(checkout);
    const repo = c.repos[0]!;
    expect(repo.adapter.land).toBe('pr');
    push({ 'docs/plan/import.md': doc('Import') });
    await repo.read.refresh();
    expect(c.repos[0]).toBe(repo);
    push({ '.obeya/settings.json': settings({ land: 'pr', setup: 'bun install' }) });
    await repo.read.refresh();
    // the same repository, its workers on, with the new version
    expect(c.repos[0]).toBe(repo);
    expect(repo.adapter.setup).toBe('bun install');
    expect(c.pendingRestart()).toBeNull();

    // where its workers work changes: with none of them at work, they restart at once, in clones
    push({ '.obeya/settings.json': settings({ land: 'pr', workspaces: 'clones' }) });
    await repo.read.refresh();
    await until(() => c.repos[0] !== repo);
    expect(c.repos[0]!.workspaces.mode).toBe('clones');
  });

  test('changed by work that lands on the local main applies at once; where it moves the workers, its worker hears that they restart', async () => {
    // a repository without a remote whose settings land work on its main
    const repo = gitRepo(join(dir, 'local'), { '.obeya/settings.json': settings({ land: 'main', workspaces: 'worktrees' }) });
    const runtime = new FakeRuntime();
    const c = await openWatched(repo, runtime);
    const land = async (title: string, files: Record<string, string>) => {
      const card = c.board.create({ title, x: 0, y: 0 });
      await c.repos[0]!.workers.start(card.id);
      runtime.last.emit({ type: 'session', id: `session-${title}` });
      const ws = c.board.row(card.id).workspace!;
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(ws, f, '..'), { recursive: true });
        writeFileSync(join(ws, f), text);
      }
      git(ws, 'add', '-A');
      git(ws, 'commit', '--quiet', '-m', title);
      await runtime.last.call('ready_for_review', { summary: title, demo: artifact() });
      runtime.last.emit({ type: 'idle' });
      await c.repos[0]!.workers.approve(card.id);
      expect(c.board.item(card.id)!.state).toBe('live');
      return { card, told: runtime.last.inbox.at(-1)! };
    };
    expect((await land('Readme', { 'README.md': 'Local\n' })).told).not.toContain('after_restart');
    runtime.last.emit({ type: 'idle' });
    const { told } = await land('Checks', { '.obeya/settings.json': settings({ land: 'main', workspaces: 'worktrees', checks: ['bun test'] }) });
    expect(told).not.toContain('after_restart');
    expect(c.repos[0]!.adapter.checks).toEqual(['bun test']);
    runtime.last.emit({ type: 'idle' });

    // to clones: the worker in its turn hears of the restart and holds it up until it pauses
    const before = c.repos[0];
    const clones = await land('Clones', { '.obeya/settings.json': settings({ land: 'main', workspaces: 'clones' }) });
    expect(clones.told).toContain('call after_restart');
    expect(clones.told).toContain("restart this repository's agents");
    expect(c.pendingRestart()).toMatchObject({ reason: 'repository', repos: ['local'], cards: [clones.card.id] });
    const landed = runtime.last;
    expect(landed.call('after_restart', {})).toContain('Recorded');
    landed.emit({ type: 'idle' });
    await until(() => c.repos[0] !== before);
    expect(c.pendingRestart()).toBeNull();
    expect(c.repos[0]!.workspaces.mode).toBe('clones');
    expect(landed.closed).toBe(true);
    expect(runtime.last).not.toBe(landed);
    expect(runtime.last.spec.resume).toBe('session-Clones');
    expect(runtime.last.inbox[0]).toContain('Obeya runs main with your change now');
  });

  test('changed by work pushed straight onto the remote main applies once Obeya fetches it, without a restart', async () => {
    push({ '.obeya/settings.json': settings({ land: 'pr', direct: true, workspaces: 'clones' }) });
    git(checkout, 'pull', '--quiet');
    const runtime = new FakeRuntime();
    const c = await openWatched(checkout, runtime, 1);
    for (const w of c.repos[0]!.workspaces.list()) identify(w.path);
    const workers = c.repos[0]!.workers;
    const pushed = async (title: string, file: string, text: string) => {
      const card = c.board.create({ title, x: 0, y: 0 });
      const started = runtime.sessions.length;
      await workers.start(card.id);
      // the lease fetched main as the remote has it: its agent starts once git has read it there
      await until(() => runtime.sessions.length > started);
      const ws = c.board.row(card.id).workspace!;
      mkdirSync(join(ws, file, '..'), { recursive: true });
      writeFileSync(join(ws, file), text);
      git(ws, 'add', '-A');
      git(ws, 'commit', '--quiet', '-m', title);
      await runtime.last.call('ready_for_review', { summary: title, demo: artifact() });
      runtime.last.emit({ type: 'idle' });
      await workers.approve(card.id, { direct: true });
      expect(c.board.item(card.id)!.state).toBe('live');
      const told = runtime.last.inbox.at(-1)!;
      runtime.last.emit({ type: 'idle' });
      return told;
    };
    expect(await pushed('Readme', 'README.md', 'Shop\n')).not.toContain('after_restart');
    expect(await pushed('Checks', '.obeya/settings.json', settings({ land: 'pr', direct: true, workspaces: 'clones', checks: ['bun test'] }))).not.toContain('after_restart');
    await c.repos[0]!.read.refresh();
    expect(c.repos[0]!.workers).toBe(workers);
    expect(c.repos[0]!.adapter.checks).toEqual(['bun test']);
  });
});
