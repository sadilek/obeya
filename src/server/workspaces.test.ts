import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from './board';
import { Store } from './db';
import { gitRepo, identify, until } from './testing';
import { addTrailer, defaultBranch, git, Workspaces } from './workspaces';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'obeya-branch-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the main branch', () => {
  test("is origin's HEAD where the checkout knows one, whatever branch it is on", () => {
    const origin = gitRepo(join(dir, 'origin'));
    git(origin, 'branch', '-m', 'trunk');
    git(dir, 'clone', '--quiet', origin, join(dir, 'clone'));
    git(join(dir, 'clone'), 'checkout', '--quiet', '-b', 'feature');
    expect(defaultBranch(join(dir, 'clone'))).toBe('trunk');
  });

  test("is the only branch of a repository without a remote, cards' branches aside", () => {
    const repo = gitRepo(join(dir, 'repo'));
    git(repo, 'branch', '-m', 'develop');
    expect(defaultBranch(repo)).toBe('develop');
    git(repo, 'checkout', '--quiet', '-b', 'obeya/export-abc123');
    expect(defaultBranch(repo)).toBe('develop');
    git(repo, 'checkout', '--quiet', '--detach');
    expect(defaultBranch(repo)).toBe('develop');
  });

  test('stays master or main while the owner has another branch checked out', () => {
    const repo = gitRepo(join(dir, 'repo'));
    git(repo, 'branch', '-m', 'master');
    git(repo, 'checkout', '--quiet', '-b', 'experiment');
    expect(defaultBranch(repo)).toBe('master');
    git(repo, 'config', 'init.defaultBranch', 'experiment');
    expect(defaultBranch(repo)).toBe('experiment');
  });

  test("is the branch the checkout is on where none of its branches is the usual one, else git's init.defaultBranch", () => {
    const repo = gitRepo(join(dir, 'repo'));
    git(repo, 'branch', '-m', 'develop');
    git(repo, 'checkout', '--quiet', '-b', 'release');
    expect(defaultBranch(repo)).toBe('release');
    git(repo, 'checkout', '--quiet', '--detach');
    git(repo, 'config', 'init.defaultBranch', 'trunk');
    expect(defaultBranch(repo)).toBe('trunk');
  });
});

describe('a leased clone', () => {
  test('git fails to make ready is given back, and not taken again at once', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: repo, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws') });
    const [clone] = spaces.ensureClones(repo, 1);
    // its origin is gone: the fetch fails
    git(clone!, 'remote', 'set-url', 'origin', join(dir, 'gone'));
    const [a, b] = [board.create({ title: 'A', x: 0, y: 0 }).id, board.create({ title: 'B', x: 0, y: 0 }).id];
    const lease = spaces.lease(a, 'obeya/a');
    // taken at once, while git fetches
    expect(spaces.leasedBy(a)).toBe(clone!);
    expect(spaces.leasable()).toBe(false);
    await expect(lease.ready!).rejects.toThrow('fetch');
    expect(spaces.leasedBy(a)).toBeNull();
    expect(spaces.leasable()).toBe(false);
    expect(() => spaces.lease(b, 'obeya/b')).toThrow(expect.objectContaining({ code: 'noWorkspace' }));
    // the pool says why the free clone goes to no card
    expect(spaces.pool([])[0]!.blocked).toEqual([{ path: clone!, why: 'failed', error: expect.stringContaining('fetch'), made: true }]);
  });
});

describe('free clones', () => {
  const setup = () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: repo, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    let changed = 0;
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws'), changed: () => changed++ });
    const clones = spaces.ensureClones(repo, 2);
    return { board, spaces, clones, changed: () => changed };
  };

  test('are chosen by their last look, taken in the background; one dirty now gives way to the next', async () => {
    const { board, spaces, clones, changed } = setup();
    const [one, two] = clones as [string, string];
    // not looked at yet: either may be taken; the looks run in the background and change the board once they find them
    expect(spaces.leasable()).toBe(true);
    await until(() => changed() === 2);
    writeFileSync(join(one, 'stray.txt'), 'x');
    // the first was clean when looked at: a card takes it at once, and git, looking again, finds it dirty
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const lease = spaces.lease(a, 'obeya/a');
    expect(lease.path).toBe(one);
    expect(await lease.ready!).toBe(two);
    expect(spaces.leasedBy(a)).toBe(two);
    expect(git(two, 'branch', '--show-current')).toBe('obeya/a');
    // the dirty one is free, and known as dirty: no card takes it until it is clean
    expect(spaces.list().find((w) => w.path === one)!.card_id).toBeNull();
    expect(spaces.leasable()).toBe(false);
    const b = board.create({ title: 'B', x: 0, y: 0 }).id;
    expect(() => spaces.lease(b, 'obeya/b')).toThrow(expect.objectContaining({ code: 'dirtyWorkspaces' }));
  });

  test('no card gets are named in the pool, with why: the files changed, git failing, the folder gone', async () => {
    const { spaces, clones, changed } = setup();
    const [one, two] = clones as [string, string];
    for (let i = 1; i <= 7; i++) writeFileSync(join(one, `stray ${i}.txt`), 'x');
    writeFileSync(join(one, 'README.md'), 'changed');
    rmSync(two, { recursive: true });
    // not looked at yet: the pool shows them free, and looks at them in the background
    expect(spaces.pool([])[0]!.blocked).toBeUndefined();
    await until(() => changed() === 2);
    expect(spaces.pool([])[0]).toMatchObject({
      total: 2,
      cards: [],
      blocked: [
        { path: one, why: 'dirty', files: ['README.md', 'stray 1.txt', 'stray 2.txt', 'stray 3.txt', 'stray 4.txt'], more: 3, made: true },
        { path: two, why: 'missing', made: true },
      ],
    });
    expect(spaces.leasable()).toBe(false);
  });

  test('a clone git fails in is blocked with its error, and counts as dirty', async () => {
    const { board, spaces, clones, changed } = setup();
    for (const c of clones) writeFileSync(join(c, '.git', 'index'), 'garbage');
    spaces.pool([]);
    await until(() => changed() === 2);
    expect(spaces.pool([])[0]!.blocked).toEqual(clones.map((path) => ({ path, why: 'broken', error: expect.stringContaining('index'), made: true })));
    expect(() => spaces.lease(board.create({ title: 'A', x: 0, y: 0 }).id, 'obeya/a')).toThrow(expect.objectContaining({ code: 'dirtyWorkspaces' }));
  });

  test('where the one taken is dirty now and no other is left, the lease fails with that shortage', async () => {
    const { board, spaces, clones } = setup();
    for (const c of clones) writeFileSync(join(c, 'stray.txt'), 'x');
    const lease = spaces.lease(board.create({ title: 'A', x: 0, y: 0 }).id, 'obeya/a');
    await expect(lease.ready!).rejects.toMatchObject({ code: 'dirtyWorkspaces' });
    expect(spaces.list().every((w) => !w.card_id)).toBe(true);
    expect(spaces.leasable()).toBe(false);
  });
});

describe('a workspace git frees', () => {
  const setup = (mode: 'clones' | 'worktrees') => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: repo, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const spaces = new Workspaces(store, 'c', { mode, repoPath: repo, dir: join(dir, 'ws') });
    if (mode === 'clones') spaces.ensureClones(repo, 1);
    return { repo, spaces, card: (title: string) => board.create({ title, x: 0, y: 0 }).id };
  };

  test('a discarded clone is no other card’s until git has cleaned it; freeing it meanwhile waits for git', async () => {
    const { spaces, card } = setup('clones');
    const a = card('A');
    const { path, ready } = spaces.lease(a, 'obeya/a');
    await ready;
    writeFileSync(join(path, 'draft.txt'), 'x');
    const discarded = spaces.discard(a, 'obeya/a');
    const abandoned = spaces.abandon(path);
    expect(spaces.leasedBy(a)).toBe(path);
    expect(() => spaces.lease(card('B'), 'obeya/b')).toThrow(expect.objectContaining({ code: 'noWorkspace' }));
    await discarded;
    expect(await abandoned).toBe(true);
    expect(spaces.list()).toEqual([{ path, card_id: null }]);
    expect(existsSync(join(path, 'draft.txt'))).toBe(false);
    expect(git(path, 'branch', '--list', 'obeya/a')).toBe('');
  });

  test("a card's worktree made again while git removes the one it had is added once git is done", async () => {
    const { repo, spaces, card } = setup('worktrees');
    const a = card('A');
    const first = spaces.lease(a, 'obeya/a');
    await first.ready;
    const removed = spaces.removeLanded(a, 'obeya/a');
    const again = spaces.lease(a, 'obeya/a');
    expect(again.path).toBe(first.path);
    expect(again.ready).not.toBeNull();
    await removed;
    expect(await again.ready!).toBe(first.path);
    expect(git(again.path, 'branch', '--show-current')).toBe('obeya/a');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(2);
  });

  test('a worktree given back and taken again by its card while git removes it (the card deleted and brought back) is made again once git is done', async () => {
    const { spaces, card } = setup('worktrees');
    const a = card('A');
    const { path, ready } = spaces.lease(a, 'obeya/a');
    await ready;
    const abandoned = spaces.abandon(path);
    const again = spaces.lease(a, 'obeya/a');
    expect(again.ready).not.toBeNull();
    expect(await abandoned).toBe(true);
    expect(await again.ready!).toBe(path);
    expect(spaces.leasedBy(a)).toBe(path);
    expect(git(path, 'branch', '--show-current')).toBe('obeya/a');
  });

  test('a workspace handed over is not, where the card it comes from gave it up while git renamed the branch', async () => {
    const { repo, spaces, card } = setup('worktrees');
    const [a, b] = [card('A'), card('B')];
    const { path, ready } = spaces.lease(a, 'obeya/a');
    await ready;
    const handed = spaces.transfer(a, b, 'obeya/a', 'obeya/b');
    const discarded = spaces.discard(a, 'obeya/a');
    await expect(handed).rejects.toMatchObject({ message: expect.stringContaining('gave its workspace up meanwhile') });
    await discarded;
    expect(spaces.leasedBy(b)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'obeya/*')).toBe('');
  });
});

describe("a follow-up's temporary worktree", () => {
  test("is at origin's copy of the card's branch where no clone here holds it, else at the default branch, and goes without a trace", async () => {
    const origin = gitRepo(join(dir, 'origin'));
    git(origin, 'checkout', '--quiet', '-b', 'obeya/pushed-abc123');
    git(origin, 'commit', '--quiet', '--allow-empty', '-m', 'pushed');
    const pushed = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '--quiet', 'main');
    const checkout = join(dir, 'checkout');
    git(dir, 'clone', '--quiet', origin, checkout);
    const spaces = new Workspaces(new Store(':memory:'), 'c', { mode: 'clones', repoPath: checkout, dir: join(dir, 'ws') });
    const { path: tree, ready } = spaces.followUpTree('card-1234567', 'obeya/pushed-abc123');
    await ready;
    expect(tree).toBe(join(dir, 'ws', 'follow-up', 'card-123'));
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(pushed);
    // the checkout stays as it was: clean, on its branch
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    expect(git(checkout, 'branch', '--show-current')).toBe('main');
    await spaces.removeFollowUpTree(tree);
    expect(existsSync(tree)).toBe(false);
    expect(git(checkout, 'worktree', 'list').split('\n')).toHaveLength(1);
    const { path: fresh, ready: again } = spaces.followUpTree('card-1234567', 'obeya/gone-def456');
    await again;
    expect(git(fresh, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'origin/main'));
  });
});

describe('the pull after a merge', () => {
  // the machine's own git configuration may set a way of pulling: none is set unless a test sets one
  let globalConfig: string | undefined;
  let origin: string;
  let checkout: string;
  let spaces: Workspaces;
  beforeEach(() => {
    globalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    origin = gitRepo(join(dir, 'origin'), { 'README.md': 'hello\n', 'notes.md': 'notes\n' });
    checkout = join(dir, 'checkout');
    git(dir, 'clone', '--quiet', origin, checkout);
    identify(checkout);
    spaces = new Workspaces(new Store(':memory:'), 'c', { mode: 'clones', repoPath: checkout, dir: join(dir, 'ws') });
  });
  afterEach(() => {
    if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });
  const commit = (repo: string, file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, 'commit', '--quiet', '-am', `${file}: ${text.trim()}`);
    return git(repo, 'rev-parse', 'HEAD');
  };

  test('rebases a main with commits of its own where git sets no way of pulling', async () => {
    const own = commit(checkout, 'notes.md', 'mine\n');
    const merged = commit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    expect(r).toEqual({ from: own, to: git(checkout, 'rev-parse', 'HEAD') });
    // the owner's commit on top of the merge, no merge commit
    expect(git(checkout, 'rev-parse', 'HEAD~1')).toBe(merged);
    expect(git(checkout, 'log', '-1', '--format=%s')).toBe('notes.md: mine');
    expect(git(checkout, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
  });

  test("keeps the repository's own way of pulling", async () => {
    git(checkout, 'config', 'pull.rebase', 'false');
    const own = commit(checkout, 'notes.md', 'mine\n');
    const merged = commit(origin, 'README.md', 'merged\n');
    expect(await spaces.pullMain()).not.toHaveProperty('problem');
    expect(git(checkout, 'rev-parse', 'HEAD^1')).toBe(own);
    expect(git(checkout, 'rev-parse', 'HEAD^2')).toBe(merged);
  });

  test("fast-forwards a main without commits of its own, the owner's uncommitted changes kept", async () => {
    writeFileSync(join(checkout, 'notes.md'), 'draft\n');
    const merged = commit(origin, 'README.md', 'merged\n');
    expect(await spaces.pullMain()).not.toHaveProperty('problem');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(merged);
    expect(readFileSync(join(checkout, 'notes.md'), 'utf8')).toBe('draft\n');
  });

  test('a pull that would stop on a conflict is not made: it names the unpushed commit it would stop at', async () => {
    commit(checkout, 'notes.md', 'mine\n');
    const own = commit(checkout, 'README.md', 'mine\n');
    const merged = commit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    expect(r).toEqual({ stopped: { commit: own, subject: 'README.md: mine', files: ['README.md'], unpushed: 2, main: own, upstream: merged } });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(own);
    expect(git(checkout, 'branch', '--show-current')).toBe('main');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
  });

  test('an unpushed commit the remote has cherry-picked is skipped, as the rebase skips it', async () => {
    const own = commit(checkout, 'README.md', 'mine\n');
    git(origin, 'fetch', '--quiet', checkout, own);
    git(origin, 'cherry-pick', own);
    commit(origin, 'README.md', 'then theirs\n');
    const r = await spaces.pullMain();
    expect(r).not.toHaveProperty('stopped');
    expect(r).not.toHaveProperty('problem');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('then theirs\n');
  });

  test('where the owner pulls by a merge, the conflict is the merge’s as a whole', async () => {
    git(checkout, 'config', 'pull.rebase', 'false');
    const own = commit(checkout, 'README.md', 'mine\n');
    commit(checkout, 'notes.md', 'mine\n');
    commit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    expect(r).toMatchObject({ stopped: { commit: own, files: ['README.md'], unpushed: 2 } });
  });
});

describe('pushing main', () => {
  let globalConfig: string | undefined;
  let origin: string;
  let checkout: string;
  let spaces: Workspaces;
  beforeEach(() => {
    globalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    origin = gitRepo(join(dir, 'origin'), { 'README.md': 'hello\n', 'notes.md': 'notes\n' });
    // a remote one can push to
    git(origin, 'config', 'receive.denyCurrentBranch', 'updateInstead');
    checkout = join(dir, 'checkout');
    git(dir, 'clone', '--quiet', origin, checkout);
    identify(checkout);
    spaces = new Workspaces(new Store(':memory:'), 'c', { mode: 'clones', repoPath: checkout, dir: join(dir, 'ws') });
  });
  afterEach(() => {
    if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });
  const commit = (repo: string, file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, 'commit', '--quiet', '-am', `${file}: ${text.trim()}`);
    return git(repo, 'rev-parse', 'HEAD');
  };

  test('puts the unpushed commits on the remote, after what the remote has of its own', async () => {
    commit(checkout, 'notes.md', 'mine\n');
    const theirs = commit(origin, 'README.md', 'theirs\n');
    const r = await spaces.pushMain();
    expect(r).toEqual({ from: theirs, to: git(checkout, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(git(origin, 'rev-parse', 'HEAD~1')).toBe(theirs);
  });

  test('pushes nothing where what the remote has conflicts with them', async () => {
    const own = commit(checkout, 'README.md', 'mine\n');
    const theirs = commit(origin, 'README.md', 'theirs\n');
    expect(await spaces.pushMain()).toEqual({ problem: expect.stringContaining('README.md') });
    expect(git(origin, 'rev-parse', 'HEAD')).toBe(theirs);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(own);
  });
});

describe('before a merge, the clash with unpushed commits', () => {
  let globalConfig: string | undefined;
  let origin: string;
  let checkout: string;
  let spaces: Workspaces;
  let pr: string;
  beforeEach(() => {
    globalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    origin = gitRepo(join(dir, 'origin'), { 'README.md': 'hello\n', 'notes.md': 'notes\n' });
    // the contributor's pull request, on the remote's main as it is
    git(origin, 'checkout', '--quiet', '-b', 'contrib');
    writeFileSync(join(origin, 'README.md'), 'theirs\n');
    git(origin, 'commit', '--quiet', '-am', 'theirs');
    pr = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '--quiet', 'main');
    checkout = join(dir, 'checkout');
    git(dir, 'clone', '--quiet', origin, checkout);
    identify(checkout);
    git(checkout, 'fetch', '--quiet', 'origin', 'contrib');
    spaces = new Workspaces(new Store(':memory:'), 'c', { mode: 'clones', repoPath: checkout, dir: join(dir, 'ws') });
  });
  afterEach(() => {
    if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });
  const commit = (repo: string, file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, 'commit', '--quiet', '-am', `${file}: ${text.trim()}`);
    return git(repo, 'rev-parse', 'HEAD');
  };

  test('names the unpushed commit the pull would stop at, and touches nothing', async () => {
    commit(checkout, 'notes.md', 'mine\n');
    const own = commit(checkout, 'README.md', 'mine\n');
    writeFileSync(join(checkout, 'notes.md'), 'draft\n');
    expect(await spaces.clashBeforeMerge('card', pr)).toEqual({ commit: own, subject: 'README.md: mine', files: ['README.md'], unpushed: 2 });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(own);
    expect(git(checkout, 'status', '--porcelain')).toBe('M notes.md');
  });

  test('none without unpushed commits, nor where they touch other lines', async () => {
    expect(await spaces.clashBeforeMerge('card', pr)).toBeNull();
    commit(checkout, 'notes.md', 'mine\n');
    expect(await spaces.clashBeforeMerge('card', pr)).toBeNull();
  });

  test('none where the PR conflicts with the remote’s main itself: the forge shows that', async () => {
    commit(origin, 'README.md', 'moved\n');
    commit(checkout, 'README.md', 'mine\n');
    expect(await spaces.clashBeforeMerge('card', pr)).toBeNull();
  });
});

describe('a resolved pull lands', () => {
  let globalConfig: string | undefined;
  let origin: string;
  let checkout: string;
  let ws: string;
  let spaces: Workspaces;
  beforeEach(() => {
    globalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    origin = gitRepo(join(dir, 'origin'), { 'README.md': 'hello\n', 'notes.md': 'notes\n' });
    checkout = join(dir, 'checkout');
    git(dir, 'clone', '--quiet', origin, checkout);
    identify(checkout);
    ws = join(dir, 'ws', 'clone');
    git(dir, 'clone', '--quiet', origin, ws);
    identify(ws);
    spaces = new Workspaces(new Store(':memory:'), 'c', { mode: 'clones', repoPath: checkout, dir: join(dir, 'ws') });
  });
  afterEach(() => {
    if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });
  const commit = (repo: string, file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, 'commit', '--quiet', '-am', `${file}: ${text.trim()}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  /** The local main stopped at the merge; the worker rebases it in its workspace, the conflict resolved. */
  async function resolved() {
    commit(checkout, 'README.md', 'mine\n');
    commit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    if (!('stopped' in r)) throw new Error('the pull did not stop');
    const { main, upstream } = r.stopped;
    git(ws, 'fetch', '--quiet', checkout, main, upstream);
    git(ws, 'checkout', '--quiet', '-B', 'resolve', main);
    expect(() => git(ws, 'rebase', '--quiet', upstream)).toThrow();
    writeFileSync(join(ws, 'README.md'), 'merged and mine\n');
    git(ws, 'add', 'README.md');
    git(ws, '-c', 'core.editor=true', 'rebase', '--continue');
    return { main, upstream };
  }

  test("the local main goes to the worker's HEAD, on the merge", async () => {
    const at = await resolved();
    const head = git(ws, 'rev-parse', 'HEAD');
    // the unpushed commit is found again by its new one
    const base = git(checkout, 'merge-base', at.main, at.upstream);
    expect(await spaces.landResolution(ws, at)).toEqual({ from: at.main, to: head, rewritten: { [base]: at.upstream, [at.main]: head } });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(checkout, 'rev-parse', 'HEAD~1')).toBe(at.upstream);
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('merged and mine\n');
  });

  test('what landed on the local main meanwhile goes on top', async () => {
    const at = await resolved();
    const later = commit(checkout, 'notes.md', 'later\n');
    const r = await spaces.landResolution(ws, at);
    expect(r).toMatchObject({ from: later });
    expect(git(checkout, 'log', '-1', '--format=%s')).toBe('notes.md: later');
    expect(git(checkout, 'rev-parse', 'HEAD~2')).toBe(at.upstream);
  });

  test('a HEAD that does not build on the merge is the worker’s to fix', async () => {
    const at = await resolved();
    git(ws, 'checkout', '--quiet', '-B', 'resolve', at.main);
    expect(await spaces.landResolution(ws, at)).toMatchObject({ code: 'landConflict', worker: true });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(at.main);
  });

  test('a main pulled meanwhile by hand needs nothing', async () => {
    const at = await resolved();
    git(checkout, 'reset', '--quiet', '--hard', at.upstream);
    expect(await spaces.landResolution(ws, at)).toEqual({ already: at.upstream });
  });
});

describe('clones the configuration no longer names', () => {
  let origin: string;
  let store: Store;
  let board: Board;
  let ws: string;
  const make = (n: number) => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'echo "$PWD" >> ../stopped' });
    const paths = spaces.ensureClones(origin, n);
    for (const p of paths) identify(p);
    return { spaces, paths };
  };
  // what the stop command ran in, as the path names it (macOS's temporary directory is behind a link)
  const stopped = () => (existsSync(join(ws, 'stopped')) ? readFileSync(join(ws, 'stopped'), 'utf8').trim().split('\n').map((p) => p.replace(/^\/private\//, '/')) : []);

  beforeEach(() => {
    gitRepo(join(dir, 'main'));
    origin = join(dir, 'origin.git');
    git(dir, 'clone', '--quiet', '--bare', join(dir, 'main'), origin);
    store = new Store(':memory:');
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: join(dir, 'main'), branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    ws = join(dir, 'ws');
  });

  test('a free clone Obeya made leaves the pool at once, and its folder goes once its app is stopped', async () => {
    const { spaces, paths } = make(3);
    spaces.keepOnly(null, paths.slice(0, 2));
    expect(spaces.list().map((w) => w.path)).toEqual(paths.slice(0, 2));
    await until(() => !existsSync(paths[2]!));
    expect(stopped()).toEqual([paths[2]!]);
    await until(() => !spaces.pool([])[0]!.kept);
  });

  test('its folder stays while something in it would be lost, and goes once nothing would', async () => {
    const { paths } = make(4);
    const [changed, untracked, stashed, unpushed] = paths as [string, string, string, string];
    writeFileSync(join(changed, 'README.md'), 'changed\n');
    writeFileSync(join(untracked, 'notes.txt'), 'mine\n');
    writeFileSync(join(stashed, 'README.md'), 'stashed\n');
    git(stashed, 'stash', '--quiet');
    git(unpushed, 'checkout', '--quiet', '-b', 'obeya/card-abc123');
    writeFileSync(join(unpushed, 'work.txt'), 'work\n');
    git(unpushed, 'add', '.');
    git(unpushed, 'commit', '--quiet', '-m', 'not pushed');
    let changes = 0;
    const watched = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'echo "$PWD" >> ../stopped', changed: () => changes++ });
    watched.keepOnly(null, []);
    expect(watched.list()).toEqual([]);
    await until(() => watched.pool([])[0]!.kept?.length === 4);
    expect(watched.pool([])[0]!.kept!.toSorted()).toEqual(paths);
    expect(changes).toBe(4);
    for (const p of paths) expect(existsSync(join(p, '.git'))).toBe(true);
    // nothing was stopped: the folder stays as it is
    expect(stopped()).toEqual([]);
    // the work landed or was thrown away: the next start finds nothing left, and the folders go
    git(changed, 'checkout', '--quiet', '.');
    rmSync(join(untracked, 'notes.txt'));
    git(stashed, 'stash', 'drop', '--quiet');
    git(unpushed, 'push', '--quiet', 'origin', 'obeya/card-abc123');
    const next = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'echo "$PWD" >> ../stopped' });
    next.sweep();
    await until(() => paths.every((p) => !existsSync(p)) && !next.pool([])[0]!.kept);
    expect(stopped().toSorted()).toEqual(paths);
  });

  test('commits a tag holds, a branch deleted on origin, or files with odd names stay; a branch squashed onto main counts as landed', async () => {
    const { spaces, paths } = make(4);
    const [tagged, deleted, squashed, odd] = paths as [string, string, string, string];
    const commit = (clone: string, file: string) => {
      writeFileSync(join(clone, file), `${file}\n`);
      git(clone, 'add', '.');
      git(clone, 'commit', '--quiet', '-m', file);
    };
    git(tagged, 'checkout', '--quiet', '-b', 'try');
    commit(tagged, 'try.txt');
    git(tagged, 'tag', 'tried');
    git(tagged, 'checkout', '--quiet', 'main');
    git(tagged, 'branch', '--quiet', '-D', 'try');
    git(deleted, 'checkout', '--quiet', '-b', 'obeya/gone');
    commit(deleted, 'gone.txt');
    git(deleted, 'push', '--quiet', 'origin', 'obeya/gone');
    git(origin, 'branch', '--quiet', '-D', 'obeya/gone');
    // a name with a tab or a leading space is its own file, not one main has
    git(odd, 'checkout', '--quiet', '-b', 'odd');
    commit(odd, 'notes\tsecret.txt');
    commit(odd, ' leading.txt');
    git(squashed, 'checkout', '--quiet', '-b', 'obeya/squashed');
    commit(squashed, 'a.txt');
    commit(squashed, 'b.txt');
    // the pull request was squashed onto main, and its branch deleted
    const other = join(dir, 'other');
    git(dir, 'clone', '--quiet', origin, other);
    identify(other);
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(other, f), `${f}\n`);
    git(other, 'add', '.');
    git(other, 'commit', '--quiet', '-m', 'Squashed');
    git(other, 'push', '--quiet', 'origin', 'main');
    spaces.keepOnly(null, []);
    await until(() => !existsSync(squashed) && spaces.pool([])[0]!.kept?.length === 3);
    expect(spaces.pool([])[0]!.kept!.toSorted()).toEqual([tagged, deleted, odd]);
  });

  test('a clone named again while its folder is looked at stays, with what a card does in it', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'sleep 0.3' });
    const [path] = spaces.ensureClones(origin, 1) as [string];
    spaces.keepOnly(null, []);
    await Bun.sleep(150);
    expect(spaces.ensureClones(origin, 1)).toEqual([path]);
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const lease = spaces.lease(a, 'obeya/a');
    expect(lease.path).toBe(path);
    await lease.ready;
    writeFileSync(join(path, 'new.txt'), 'work\n');
    await Bun.sleep(600);
    expect(readFileSync(join(path, 'new.txt'), 'utf8')).toBe('work\n');
    expect(spaces.leasedBy(a)).toBe(path);
  });

  test('what the stop command leaves behind keeps the folder', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'echo snapshot > saved.txt' });
    const [path] = spaces.ensureClones(origin, 1) as [string];
    spaces.keepOnly(null, []);
    await until(() => spaces.pool([])[0]!.kept?.length === 1);
    expect(readFileSync(join(path, 'saved.txt'), 'utf8')).toBe('snapshot\n');
  });

  test('a clone of another repository in its directory is not its to remove', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, origins: [origin] });
    const stranger = gitRepo(join(dir, 'stranger'));
    git(dir, 'clone', '--quiet', stranger, join(ws, '7'));
    const [mine] = spaces.ensureClones(origin, 1) as [string];
    spaces.keepOnly(null, []);
    spaces.sweep();
    await until(() => !existsSync(mine));
    await Bun.sleep(100);
    expect(existsSync(join(ws, '7', '.git'))).toBe(true);
  });

  test('a folder that stayed is back in the pool once the number is raised again', async () => {
    const { spaces, paths } = make(2);
    writeFileSync(join(paths[1]!, 'notes.txt'), 'mine\n');
    spaces.keepOnly(null, paths.slice(0, 1));
    await until(() => spaces.pool([])[0]!.kept?.length === 1);
    expect(spaces.ensureClones(origin, 2)).toEqual(paths);
    expect(spaces.list().map((w) => w.path)).toEqual(paths);
    expect(spaces.pool([])[0]!.kept).toBeUndefined();
    expect(readFileSync(join(paths[1]!, 'notes.txt'), 'utf8')).toBe('mine\n');
  });

  test('a clone a card holds stays with it until the card gives it back, then goes', async () => {
    const { spaces, paths } = make(2);
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const lease = spaces.lease(a, 'obeya/a');
    expect(lease.path).toBe(paths[0]!);
    await lease.ready;
    spaces.keepOnly(null, []);
    expect(spaces.list().map((w) => w.path)).toEqual([paths[0]!]);
    expect(spaces.leasedBy(a)).toBe(paths[0]!);
    await until(() => !existsSync(paths[1]!));
    expect(existsSync(paths[0]!)).toBe(true);
    spaces.release(a);
    expect(spaces.list()).toEqual([]);
    // the card's branch holds nothing that is not on origin
    await until(() => !existsSync(paths[0]!));
    // a deleted card brought back does not take it back
    expect(spaces.retake(a, paths[0]!)).toBe(false);
  });

  test('a clone the owner listed only leaves the pool: Obeya never touches its folder', async () => {
    const own = join(dir, 'own');
    git(dir, 'clone', '--quiet', origin, own);
    const { spaces, paths } = make(1);
    spaces.register(own, [origin]);
    spaces.keepOnly(null, []);
    expect(spaces.list()).toEqual([]);
    await until(() => !existsSync(paths[0]!));
    spaces.sweep();
    await Bun.sleep(50);
    expect(existsSync(join(own, '.git'))).toBe(true);
    expect(stopped()).toEqual([paths[0]!]);
  });

  test('one whose folder is gone leaves at once, held or not, and its card takes another at its next start', async () => {
    const own = join(dir, 'own');
    git(dir, 'clone', '--quiet', origin, own);
    const { spaces, paths } = make(3);
    const [a, b, c] = ['A', 'B', 'C'].map((title) => board.create({ title, x: 0, y: 0 }).id) as [string, string, string];
    const held = spaces.lease(a, 'obeya/a');
    expect(held.path).toBe(paths[0]!);
    await held.ready;
    spaces.register(own, [origin]);
    // a worktree from before the repository went over to clones, under the home Obeya had then
    const old = join(dir, 'old-home', 'a7d7c689');
    store.addWorkspace('c', old);
    store.setLease(old, b);
    board.work(a, { state: 'working', workspace: held.path, branch: 'obeya/a' });
    board.work(b, { state: 'planned', workspace: old, branch: 'obeya/b' });
    // the owner moved the listed clone and the held one away; the old home is gone with its worktree
    rmSync(own, { recursive: true });
    rmSync(held.path, { recursive: true });
    const lost = spaces.keepOnly(null, paths.slice(1));
    expect(lost).toEqual([
      { card: b, path: old },
      { card: a, path: held.path },
    ]);
    expect(spaces.list().map((w) => w.path)).toEqual(paths.slice(1));
    for (const l of lost) board.workspaceGone(l.card, l.path);
    expect(board.row(a)).toMatchObject({ state: 'planned', workspace: null, branch: 'obeya/a' });
    expect(board.row(b)).toMatchObject({ state: 'planned', workspace: null });
    expect(board.events(a).at(-1)!.text).toContain(held.path);
    // the next start takes a clone that is there
    const again = spaces.lease(a, 'obeya/a');
    expect(paths.slice(1)).toContain(again.path);
    await again.ready;
    expect(existsSync(again.path)).toBe(true);
    expect(spaces.lease(c, 'obeya/c').path).not.toBe(again.path);
  });

  test("a card's own worktree whose folder is gone stays the card's", () => {
    const spaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: join(dir, 'main'), dir: ws });
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const path = join(ws, a.slice(0, 8));
    store.addWorkspace('c', path);
    store.setLease(path, a);
    expect(spaces.keepOnly(null, [])).toEqual([]);
    expect(spaces.leasedBy(a)).toBe(path);
  });
});

test('a trailer goes beside the trailers a commit message ends with, else into a paragraph of its own', () => {
  const t = 'Demo-Video: https://demos.example.dev/a-1/';
  expect(addTrailer('Fix\n\nBody.\n\nCo-Authored-By: C <c@x>\n', t)).toBe(`Fix\n\nBody.\n\nCo-Authored-By: C <c@x>\n${t}\n`);
  expect(addTrailer('Fix\n\nBody: not a trailer, a sentence.\nIt goes on.', t)).toBe(`Fix\n\nBody: not a trailer, a sentence.\nIt goes on.\n\n${t}\n`);
  // a trailer needs no space after its colon
  expect(addTrailer('Fix\n\nCo-Authored-By:C <c@x>', t)).toBe(`Fix\n\nCo-Authored-By:C <c@x>\n${t}\n`);
  // a subject alone is no trailer block, even with a colon
  expect(addTrailer('Docs: typo', t)).toBe(`Docs: typo\n\n${t}\n`);
});
