import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KeptClone } from '../core/types';
import type { Board } from './board';
import { Store } from './db';
import { runAppCommand, scriptOf } from './app-command';
import { onStart } from './spawn';
import { alive, commit, gitClone, gitRepo, identify, leftBehind, ownGlobalGitConfig, PATIENCE, removeDir, testBoard, until } from './testing';
import { addTrailer, originFetch, pushRefusal, statusEntries, unlanded, Workspaces } from './workspaces';
import { defaultBranch } from './branches';
import { git, hasCommit, isAncestor } from './git';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'obeya-branch-'))));
afterEach(() => removeDir(dir));

/** Stop commands go to the platform's shell (`runAppCommand`): cmd.exe on Windows, sh elsewhere. */
const WINDOWS = process.platform === 'win32';

/**
 * What `p` rejects with, through a handler `p` has from the start. `expect(p).rejects` waits for `p`
 * without one: the rejection of a lease whose git ran on `spawnOutput`'s threads counted as unhandled
 * on the CI runner once the file's tests were through (Bun 1.4.3), failing the run though every test passed.
 */
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('resolved, not rejected');
    },
    (e: unknown) => e,
  );

/** A commit in `repo` that writes `text` into `file`, named after both ("notes.md: mine"). */
const edit = (repo: string, file: string, text: string) => commit(repo, file, text, `${file}: ${text.trim()}`);

/** A remote with `README.md` and `notes.md` on main, the checkout cloned from it, and the workspaces of its cards. */
function originAndCheckout() {
  const origin = gitRepo(join(dir, 'origin'), { 'README.md': 'hello\n', 'notes.md': 'notes\n' });
  const checkout = gitClone(origin, join(dir, 'checkout'));
  identify(checkout);
  return { origin, checkout, spaces: new Workspaces(new Store(':memory:'), 'c', { mode: 'clones', repoPath: checkout, dir: join(dir, 'ws') }) };
}

describe('the main branch', async () => {
  test("is origin's HEAD where the checkout knows one, whatever branch it is on", async () => {
    const origin = gitRepo(join(dir, 'origin'));
    git(origin, 'branch', '-m', 'trunk');
    gitClone(origin, join(dir, 'clone'));
    git(join(dir, 'clone'), 'checkout', '--quiet', '-b', 'feature');
    expect(await defaultBranch(join(dir, 'clone'))).toBe('trunk');
  });

  test("is the only branch of a repository without a remote, cards' branches aside", async () => {
    const repo = gitRepo(join(dir, 'repo'));
    git(repo, 'branch', '-m', 'develop');
    expect(await defaultBranch(repo)).toBe('develop');
    git(repo, 'checkout', '--quiet', '-b', 'obeya/export-abc123');
    expect(await defaultBranch(repo)).toBe('develop');
    git(repo, 'checkout', '--quiet', '--detach');
    expect(await defaultBranch(repo)).toBe('develop');
  });

  test('stays master or main while the owner has another branch checked out', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    git(repo, 'branch', '-m', 'master');
    git(repo, 'checkout', '--quiet', '-b', 'experiment');
    expect(await defaultBranch(repo)).toBe('master');
    git(repo, 'config', 'init.defaultBranch', 'experiment');
    expect(await defaultBranch(repo)).toBe('experiment');
  });

  test("is the branch the checkout is on where none of its branches is the usual one, else git's init.defaultBranch", async () => {
    const repo = gitRepo(join(dir, 'repo'));
    git(repo, 'branch', '-m', 'develop');
    git(repo, 'checkout', '--quiet', '-b', 'release');
    expect(await defaultBranch(repo)).toBe('release');
    git(repo, 'checkout', '--quiet', '--detach');
    git(repo, 'config', 'init.defaultBranch', 'trunk');
    expect(await defaultBranch(repo)).toBe('trunk');
  });
});

describe('why a remote refused a push', () => {
  test('the remote’s own words and git’s reason, without the command and paths', () => {
    const github = [
      'remote: error: GH006: Protected branch update failed for refs/heads/main.',
      'remote: error: Changes must be made through a pull request.',
      'To github.com:acme/station.git',
      ' ! [remote rejected] main -> main (protected branch hook declined)',
      "error: failed to push some refs to 'github.com:acme/station.git'",
    ].join('\n');
    expect(pushRefusal(github)).toEqual({ problem: 'error: GH006: Protected branch update failed for refs/heads/main. error: Changes must be made through a pull request. (protected branch hook declined)' });
    expect(pushRefusal("remote: Permission to acme/station.git denied to mira.\nfatal: unable to access 'https://github.com/acme/station.git/': The requested URL returned error: 403")).toEqual({
      problem: 'Permission to acme/station.git denied to mira.',
    });
    expect(pushRefusal("fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.")).toEqual({ problem: 'fatal: Could not read from remote repository.' });
  });

  test('a branch that moved on the remote says so, whatever git calls it', () => {
    expect(pushRefusal("To /srv/station.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/srv/station.git'")).toEqual({ problem: "error: failed to push some refs to '/srv/station.git'", moved: true });
    expect(pushRefusal(' ! [rejected]        main -> main (non-fast-forward)').moved).toBe(true);
  });
});

describe('what git can tell of commits', () => {
  test('a commit the repository lacks is no ancestor and not there; a repository git cannot read tells neither', async () => {
    const repo = gitRepo(join(dir, 'tell'));
    const head = git(repo, 'rev-parse', 'HEAD');
    const unknown = '0123456789abcdef0123456789abcdef01234567';
    expect(await hasCommit(repo, head)).toBe(true);
    expect(await hasCommit(repo, unknown)).toBe(false);
    expect(await isAncestor(repo, head, head)).toBe(true);
    expect(await rejection(isAncestor(repo, unknown, head))).toBeInstanceOf(Error);
    writeFileSync(join(repo, '.git', 'config'), '[core\n');
    expect(await rejection(hasCommit(repo, head))).toBeInstanceOf(Error);
    expect(await rejection(isAncestor(repo, head, head))).toBeInstanceOf(Error);
  });
});

describe('a leased clone', () => {
  test('git fails to make ready is given back, and not taken again at once', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws') });
    const [clone] = await spaces.ensureClones(repo, 1);
    // its origin is gone: the fetch fails
    git(clone!, 'remote', 'set-url', 'origin', join(dir, 'gone'));
    const [a, b] = [board.create({ title: 'A', x: 0, y: 0 }).id, board.create({ title: 'B', x: 0, y: 0 }).id];
    const lease = spaces.lease(a, 'obeya/a');
    // taken at once, while git fetches
    expect(spaces.leasedBy(a)).toBe(clone!);
    expect(spaces.leasable()).toBe(false);
    expect(await rejection(lease.ready!)).toMatchObject({ message: expect.stringContaining('fetch') });
    expect(spaces.leasedBy(a)).toBeNull();
    expect(spaces.leasable()).toBe(false);
    expect(() => spaces.lease(b, 'obeya/b')).toThrow(expect.objectContaining({ code: 'noWorkspace' }));
    // the pool says why the free clone goes to no card
    expect(spaces.pool([])[0]!.blocked).toEqual([{ path: clone!, why: 'failed', error: expect.stringContaining('fetch'), made: true }]);
  });

  test('is looked at while free without git writing its index, which a card taking it meanwhile needs to write', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    testBoard({ store, path: repo });
    let looked = 0;
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws'), changed: () => looked++ });
    const [clone] = (await spaces.ensureClones(repo, 1)) as [string];
    // a file touched since git last looked: `git status` would note that in the index, under git's index lock
    const index = join(clone, '.git', 'index');
    const before = readFileSync(index);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(clone, 'README.md'), later, later);
    expect(spaces.leasable()).toBe(true);
    await until(() => looked);
    expect(spaces.pool([])[0]!.blocked).toBeUndefined();
    expect(readFileSync(index).equals(before)).toBe(true);
  });
});

/** The index of the repository at `repo`, as git has written it. */
const indexOf = (repo: string) => readFileSync(join(repo, '.git', 'index'));

/** Gives `files` in `repo` new timestamps, their content as it was: what `git status` would note in the index, under git's index lock. */
function touch(repo: string, ...files: string[]) {
  const later = new Date(Date.now() + 5000);
  for (const f of files) utimesSync(join(repo, f), later, later);
}

describe("a card's workspace looked at while its agent works there", () => {
  test('is read without git writing its index, and a file whose timestamps alone changed is no change', async () => {
    const repo = gitRepo(join(dir, 'repo'), { 'README.md': 'hello\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws') });
    await spaces.ensureClones(repo, 1);
    const card = board.create({ title: 'A', x: 0, y: 0 }).id;
    const { path: ws, ready } = spaces.lease(card, 'obeya/a');
    await ready;
    // committed, staged, changed and new, and one only touched
    writeFileSync(join(ws, 'a.txt'), 'a, committed\n');
    git(ws, 'commit', '--quiet', '-am', 'a');
    writeFileSync(join(ws, 'b.txt'), 'b, staged\n');
    git(ws, 'add', 'b.txt');
    writeFileSync(join(ws, 'c.txt'), 'c, changed\n');
    writeFileSync(join(ws, 'd.txt'), 'd, new\n');
    git(ws, 'status', '--porcelain');
    touch(ws, 'README.md', 'a.txt');
    const index = indexOf(ws);

    expect(await spaces.hasWork(card)).toBe(true);
    expect((await spaces.changedFiles(card)).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    expect((await spaces.changes(card)).map((c) => c.file).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    const diff = await spaces.diff(card, true);
    expect(diff?.files.map((f) => f.file).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    expect(indexOf(ws).equals(index)).toBe(true);
  });
});

describe('a clone made ready for a card', () => {
  test('starts from main as its origin has it now, fetching only where the origin has branches or tags it lacks', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws') });
    const [clone] = (await spaces.ensureClones(repo, 1)) as [string];
    const fetchHead = join(clone, '.git', 'FETCH_HEAD');
    let card: string | undefined;
    const start = async (title: string) => {
      if (card) spaces.release(card);
      rmSync(fetchHead, { force: true });
      card = board.create({ title, x: 0, y: 0 }).id;
      await spaces.lease(card, `obeya/${title}`).ready;
      return existsSync(fetchHead);
    };
    // as cloned: nothing to fetch
    expect(await start('a')).toBe(false);
    // main moved on
    commit(repo, 'b.txt', 'b', 'b');
    expect(await start('b')).toBe(true);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    // a tag on a commit the clone has, and a branch of its own
    git(repo, 'tag', 'v1', 'HEAD~1');
    expect(await start('c')).toBe(true);
    expect(git(clone, 'tag', '--list')).toBe('v1');
    git(repo, 'branch', 'feature');
    expect(await start('d')).toBe(true);
    expect(git(clone, 'rev-parse', 'origin/feature')).toBe(git(repo, 'rev-parse', 'main'));
    expect(await start('e')).toBe(false);
  }, 30_000);

  test('a fetch rule that also writes branches of its own, and pruning, count as git has them', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws') });
    const [clone] = (await spaces.ensureClones(repo, 1)) as [string];
    // a branch deleted in the origin goes from the clone where its fetch prunes
    git(repo, 'branch', 'old');
    const a = board.create({ title: 'a', x: 0, y: 0 }).id;
    await spaces.lease(a, 'obeya/a').ready;
    expect(git(clone, 'branch', '--remotes', '--list', 'origin/old')).not.toBe('');
    spaces.release(a);
    git(clone, 'checkout', '--quiet', 'main');
    git(repo, 'branch', '-D', 'old');
    git(clone, 'config', 'fetch.prune', 'true');
    const b = board.create({ title: 'b', x: 0, y: 0 }).id;
    await spaces.lease(b, 'obeya/b').ready;
    expect(git(clone, 'branch', '--remotes', '--list', 'origin/old')).toBe('');
    spaces.release(b);
    git(clone, 'checkout', '--quiet', 'main');
    // the card's branch the fetch itself makes in the clone is checked out, not made anew
    git(clone, 'config', '--add', 'remote.origin.fetch', '+refs/heads/obeya/*:refs/heads/obeya/*');
    git(repo, 'branch', 'obeya/c');
    const c = board.create({ title: 'c', x: 0, y: 0 }).id;
    expect(await spaces.lease(c, 'obeya/c').ready).toBe(clone);
    expect(git(clone, 'branch', '--show-current')).toBe('obeya/c');
  }, 30_000);

  test("its origin is the repository on this machine git fetches from, as git's configuration has it", async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const clone = join(dir, 'clone');
    git(dir, 'clone', '--quiet', repo, clone);
    expect(await originFetch(clone)).toEqual({ local: repo, plain: true, prune: false, pruneTags: false, tagOpt: false });
    git(clone, 'remote', 'set-url', 'origin', pathToFileURL(repo).href);
    expect((await originFetch(clone))?.local).toBe(repo);
    // a rewrite for other URLs changes nothing; one for this path, from a file the configuration includes, sends the fetch elsewhere
    git(clone, 'remote', 'set-url', 'origin', repo);
    git(clone, 'config', 'url.git@github.com:.insteadOf', 'https://github.com/');
    expect((await originFetch(clone))?.local).toBe(repo);
    writeFileSync(join(dir, 'more.config'), `[url "${join(dir, 'other').replaceAll('\\', '\\\\')}"]\n\tinsteadOf = ${repo.replaceAll('\\', '\\\\')}\n`);
    git(clone, 'config', 'include.path', join(dir, 'more.config'));
    expect((await originFetch(clone))?.local).toBeNull();
    git(clone, 'config', '--unset', 'include.path');
    for (const url of ['git@github.com:a/b.git', join(dir, 'gone')]) {
      git(clone, 'remote', 'set-url', 'origin', url);
      expect((await originFetch(clone))?.local).toBeNull();
    }
    git(clone, 'remote', 'set-url', 'origin', repo);
    git(clone, 'config', '--add', 'remote.origin.url', repo);
    expect((await originFetch(clone))?.local).toBeNull();
    git(clone, 'config', '--unset-all', 'remote.origin.url');
    git(clone, 'config', 'remote.origin.url', repo);
    git(clone, 'config', '--add', 'remote.origin.fetch', '+refs/heads/obeya/*:refs/heads/obeya/*');
    git(clone, 'config', 'fetch.prune', 'true');
    git(clone, 'config', 'fetch.pruneTags', 'true');
    git(clone, 'config', 'remote.origin.tagOpt', '--tags');
    expect(await originFetch(clone)).toEqual({ local: repo, plain: false, prune: true, pruneTags: true, tagOpt: true });
    // the remote's own setting over the one for all
    git(clone, 'config', 'remote.origin.prune', 'false');
    expect((await originFetch(clone))?.prune).toBe(false);
    // another remote's setting, whatever its case, is not origin's; a value git reads as true is true
    git(clone, 'config', '--unset', 'remote.origin.prune');
    git(clone, 'config', 'remote.Origin.prune', 'false');
    git(clone, 'config', 'fetch.prune', '2');
    expect((await originFetch(clone))?.prune).toBe(true);
    // git reads `#` in a file URL as part of the path
    mkdirSync(`${repo}#copy`);
    git(clone, 'config', 'remote.origin.url', `file://${repo}#copy`);
    expect((await originFetch(clone))?.local).toBeNull();
  });
});

describe('free clones', () => {
  const setup = async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    let changed = 0;
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: repo, dir: join(dir, 'ws'), changed: () => changed++ });
    const clones = await spaces.ensureClones(repo, 2);
    return { board, spaces, clones, changed: () => changed };
  };

  test('are chosen by their last look, taken in the background; one dirty now gives way to the next', async () => {
    const { board, spaces, clones, changed } = await setup();
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
    // the dirty one is free, and known as dirty: no card takes it while it is
    expect(spaces.list().find((w) => w.path === one)!.card_id).toBeNull();
    expect(spaces.leasable()).toBe(false);
    const b = board.create({ title: 'B', x: 0, y: 0 }).id;
    expect(() => spaces.lease(b, 'obeya/b')).toThrow(expect.objectContaining({ code: 'dirtyWorkspaces' }));
    // a card wanted it: Obeya keeps what was left there on a branch of its own, and the clone is free
    await until(() => spaces.leasable());
    expect(existsSync(join(one, 'stray.txt'))).toBe(false);
    const [kept] = git(one, 'branch', '--list', '--format=%(refname:short)', 'obeya-leftovers/*').split('\n') as [string];
    expect(kept).toMatch(/^obeya-leftovers\/main-\d{8}-\d{6}$/);
    expect(git(one, 'show', `${kept}:stray.txt`)).toBe('x');
    expect(git(one, 'log', '-1', '--format=%B', kept)).toContain('Obeya-Kept: leftovers');
    expect(git(one, 'branch', '--show-current')).toBe('main');
    const taken = spaces.lease(b, 'obeya/b');
    expect(taken.path).toBe(one);
    expect(await taken.ready).toBe(one);
  }, 20_000);

  test('"Commit to a new branch and free the clone" keeps changed and new files on a branch; line endings alone it drops', async () => {
    const { board, spaces } = await setup();
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const lease = spaces.lease(a, 'obeya/a');
    await lease.ready;
    const path = spaces.leasedBy(a)!;
    // a held clone is the card's own
    expect(await spaces.keepLeftovers(path)).toBeNull();
    spaces.release(a);
    expect(await spaces.keepLeftovers(path)).toBe('');
    writeFileSync(join(path, 'README.md'), 'changed\n');
    writeFileSync(join(path, 'notes.txt'), 'mine\n');
    // as the pool names it: its path there and the machine
    const branch = (await spaces.keepLeftovers(path, spaces.pool([])[0]!.name))!;
    expect(branch).toMatch(/^obeya-leftovers\/obeya\/a-/);
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(path, 'branch', '--show-current')).toBe('obeya/a');
    expect(git(path, 'show', `${branch}:notes.txt`)).toBe('mine');
    expect(git(path, 'show', `${branch}:README.md`)).toBe('changed');
    // the same file with other line endings, as a tool may write it back: nothing to keep
    git(path, 'config', 'core.autocrlf', 'false');
    git(path, 'reset', '--quiet', '--hard');
    writeFileSync(join(path, 'README.md'), 'hello\r\n');
    expect(git(path, 'status', '--porcelain')).not.toBe('');
    expect(await spaces.keepLeftovers(path)).toBe('');
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(path, 'branch', '--list', 'obeya-leftovers/*').split('\n')).toHaveLength(1);
    // named with another machine, the clone of the same path here is not the one meant
    writeFileSync(join(path, 'notes.txt'), 'mine\n');
    expect(await spaces.keepLeftovers(path, 'elsewhere')).toBeNull();
    expect(existsSync(join(path, 'notes.txt'))).toBe(true);
    // a file staged otherwise than the working tree has it: both are kept, the staged one in a commit of its own
    writeFileSync(join(path, 'README.md'), 'staged\n');
    git(path, 'add', 'README.md');
    writeFileSync(join(path, 'README.md'), 'worked on\n');
    const both = (await spaces.keepLeftovers(path))!;
    expect(git(path, 'show', `${both}:README.md`)).toBe('worked on');
    expect(git(path, 'show', `${both}:notes.txt`)).toBe('mine');
    expect(git(path, 'show', `${both}~1:README.md`)).toBe('staged');
    expect(git(path, 'rev-parse', `${both}~2`)).toBe(git(path, 'rev-parse', 'HEAD'));
    expect(git(path, 'status', '--porcelain')).toBe('');
    // git failing on the way (no branch obeya-leftovers/… beside one named obeya-leftovers): the index is put back as it was
    for (const b of git(path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/obeya-leftovers/').split('\n')) git(path, 'branch', '--quiet', '-D', b);
    git(path, 'branch', 'obeya-leftovers');
    writeFileSync(join(path, 'README.md'), 'staged again\n');
    git(path, 'add', 'README.md');
    writeFileSync(join(path, 'README.md'), 'worked on again\n');
    writeFileSync(join(path, 'more.txt'), 'new\n');
    expect(await spaces.keepLeftovers(path)).toBeNull();
    expect(git(path, 'show', ':README.md')).toBe('staged again');
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('worked on again\n');
    expect(git(path, 'status', '--porcelain', '--', 'more.txt')).toBe('?? more.txt');
  }, 20_000);

  test('status entries skip the source of a rename in either column', () => {
    expect(statusEntries(' R a-new.txt\0old.txt\0MM z.txt\0').map((e) => e.xy)).toEqual([' R', 'MM']);
    expect(statusEntries('R  b.txt\0a.txt\0?? c.txt\0').map((e) => `${e.xy}|${e.path}`)).toEqual(['R |b.txt', '??|c.txt']);
  });

  test('a clone with files assumed unchanged stays as it is; the next blocked one is freed for the card instead', async () => {
    const { board, spaces, clones, changed } = await setup();
    const [one, two] = clones as [string, string];
    // `add` would leave the hidden change out, and the reset overwrite it
    git(one, 'update-index', '--assume-unchanged', 'README.md');
    writeFileSync(join(one, 'README.md'), 'hidden\n');
    writeFileSync(join(one, 'stray.txt'), 'x');
    writeFileSync(join(two, 'stray.txt'), 'y');
    // not looked at yet: the looks find both dirty
    spaces.leasable();
    await until(() => changed() === 2);
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    expect(() => spaces.lease(a, 'obeya/a')).toThrow(expect.objectContaining({ code: 'dirtyWorkspaces' }));
    // the first could not be freed: the next one is, and the card takes it
    // a waiting card asks again on every change of the board
    await until(() => (spaces.leasable(), !existsSync(join(two, 'stray.txt'))));
    await until(() => spaces.leasable());
    expect(readFileSync(join(one, 'README.md'), 'utf8')).toBe('hidden\n');
    expect(existsSync(join(one, 'stray.txt'))).toBe(true);
    expect(git(one, 'branch', '--list', 'obeya-leftovers/*')).toBe('');
    expect(existsSync(join(two, 'stray.txt'))).toBe(false);
    expect(await spaces.lease(a, 'obeya/a').ready).toBe(two);
  }, 20_000);

  test('no card gets are named in the pool, with why: the files changed, git failing, the folder gone', async () => {
    const { spaces, clones, changed } = await setup();
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
    const { board, spaces, clones, changed } = await setup();
    for (const c of clones) writeFileSync(join(c, '.git', 'index'), 'garbage');
    spaces.pool([]);
    await until(() => changed() === 2);
    expect(spaces.pool([])[0]!.blocked).toEqual(clones.map((path) => ({ path, why: 'broken', error: expect.stringContaining('index'), made: true })));
    expect(() => spaces.lease(board.create({ title: 'A', x: 0, y: 0 }).id, 'obeya/a')).toThrow(expect.objectContaining({ code: 'dirtyWorkspaces' }));
  });

  test('where the one taken is dirty now and no other is left, the lease fails with that shortage', async () => {
    const { board, spaces, clones } = await setup();
    for (const c of clones) writeFileSync(join(c, 'stray.txt'), 'x');
    const lease = spaces.lease(board.create({ title: 'A', x: 0, y: 0 }).id, 'obeya/a');
    expect(await rejection(lease.ready!)).toMatchObject({ code: 'dirtyWorkspaces' });
    expect(spaces.list().every((w) => !w.card_id)).toBe(true);
    expect(spaces.leasable()).toBe(false);
  });
});

describe('a workspace git frees', () => {
  const setup = async (mode: 'clones' | 'worktrees') => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const spaces = new Workspaces(store, 'c', { mode, repoPath: repo, dir: join(dir, 'ws') });
    if (mode === 'clones') await spaces.ensureClones(repo, 1);
    return { repo, spaces, card: (title: string) => board.create({ title, x: 0, y: 0 }).id };
  };

  test('a discarded clone is no other card’s until git has cleaned it; freeing it meanwhile waits for git', async () => {
    const { spaces, card } = await setup('clones');
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
    const { repo, spaces, card } = await setup('worktrees');
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

  test("a landed card's worktree goes with what still runs from it, which its stop command did not know of", async () => {
    const repo = gitRepo(join(dir, 'repo'));
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const log = join(dir, 'stopped.log');
    const spaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: repo, dir: join(dir, 'ws'), stop: `echo stopped>> ${log}` });
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const { path, ready } = spaces.lease(a, 'obeya/a');
    await ready;
    const app = await leftBehind(path);
    try {
      await spaces.removeLanded(a, 'obeya/a');
      expect(readFileSync(log, 'utf8')).toContain('stopped');
      await until(() => !alive(app), 5000);
      expect(existsSync(path)).toBe(false);
    } finally {
      if (alive(app)) process.kill(app, 'SIGKILL');
    }
  }, 30_000);

  test('a stop command whose script the branch lacks does not run, and counts as nothing to stop', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    expect(await runAppCommand(repo, 'node .obeya/app.mjs stop')).toEqual({ ok: true, output: '', missing: '.obeya/app.mjs' });
    expect(await runAppCommand(repo, './scripts/stop.sh')).toEqual({ ok: true, output: '', missing: './scripts/stop.sh' });
    expect(scriptOf('node "scripts/stop app.mjs" stop')).toBe('scripts/stop app.mjs');
    expect(scriptOf('bash scripts/stop.sh')).toBe('scripts/stop.sh');
    expect(scriptOf('/usr/bin/node .obeya/app.mjs stop')).toBe('.obeya/app.mjs');
    expect(scriptOf('"C:\\Program Files\\nodejs\\node.exe" .obeya\\app.mjs stop')).toBe('.obeya\\app.mjs');
    expect(scriptOf('node --require ./setup.cjs stop.mjs')).toBe('stop.mjs');
    expect(scriptOf("node --eval='console.log(42)' absent.mjs")).toBeNull();
    expect(scriptOf('node stop.mjs')).toBe('stop.mjs');
    expect(scriptOf('cd server && node ../x/stop.mjs')).toBeNull();
    expect(scriptOf('make stop')).toBeNull();
    expect(scriptOf('bun run stop')).toBeNull();
    expect(scriptOf('python -m myapp.stop')).toBeNull();
    expect(scriptOf('docker compose -f deploy/compose.yml down --remove-orphans')).toBeNull();
    writeFileSync(join(repo, 'stop.mjs'), '');
    expect(await runAppCommand(repo, 'echo ok ./stop.mjs')).toMatchObject({ ok: true, output: expect.stringContaining('ok') });
  });

  test('a stop command runs whatever else it names that is not there: a pid file it reads, an address, a log it writes', async () => {
    const repo = gitRepo(join(dir, 'repo'));
    if (WINDOWS) {
      expect(await runAppCommand(repo, 'type .run\\app.pid 2>nul & echo ran')).toMatchObject({ ok: true, output: 'ran' });
      expect(await runAppCommand(repo, 'echo ran localhost:3000/stop')).toMatchObject({ ok: true, output: 'ran localhost:3000/stop' });
      expect(await runAppCommand(repo, 'mkdir logs && echo ran> logs\\stop.log && type logs\\stop.log')).toMatchObject({ ok: true, output: 'ran' });
    } else {
      expect(await runAppCommand(repo, 'cat .run/app.pid 2>/dev/null; echo ran')).toMatchObject({ ok: true, output: 'ran' });
      expect(await runAppCommand(repo, 'echo ran $(cat .run/app.pid 2>/dev/null)')).toMatchObject({ ok: true, output: 'ran' });
      expect(await runAppCommand(repo, 'echo ran localhost:3000/stop')).toMatchObject({ ok: true, output: 'ran localhost:3000/stop' });
      expect(await runAppCommand(repo, 'mkdir -p logs && echo ran > logs/stop.log && cat logs/stop.log')).toMatchObject({ ok: true, output: 'ran' });
    }
    expect(scriptOf('kill $(cat .run/app.pid)')).toBeNull();
    expect(scriptOf('curl -s localhost:3000/stop')).toBeNull();
    expect(scriptOf('./scripts/stop.sh --log logs/stop.log')).toBe('./scripts/stop.sh');
  });

  test('a worktree given back and taken again by its card while git removes it (the card deleted and brought back) is made again once git is done', async () => {
    const { spaces, card } = await setup('worktrees');
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
    const { repo, spaces, card } = await setup('worktrees');
    const [a, b] = [card('A'), card('B')];
    const { path, ready } = spaces.lease(a, 'obeya/a');
    await ready;
    const handed = spaces.transfer(a, b, 'obeya/a', 'obeya/b');
    const discarded = spaces.discard(a, 'obeya/a');
    expect(await rejection(handed)).toMatchObject({ message: expect.stringContaining('gave its workspace up meanwhile') });
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
    gitClone(origin, checkout);
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

describe("a card's fork point", () => {
  test('tells a change of the branch to a file against the commit it names, where criss-cross merges left several where it parted', async () => {
    const SETTINGS = '.obeya/settings.json';
    const repo = gitRepo(join(dir, 'repo'), { 'README.md': 'hello\n', [SETTINGS]: '{"land":"main"}\n' });
    const store = new Store(':memory:');
    const board = testBoard({ store, path: repo });
    const spaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: repo, dir: join(dir, 'ws') });
    const card = board.create({ title: 'A', x: 0, y: 0 }).id;
    const { path: ws, ready } = spaces.lease(card, 'obeya/a');
    await ready;
    expect(await spaces.forkPoint(card, SETTINGS)).toBeNull();
    // at the same second, so git ranks the two places they parted at by the merges' parents alone
    const commitTree = (tree: string, parents: string[], message: string) =>
      Bun.spawnSync(['git', '-C', repo, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
        env: { ...process.env, GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' },
      }).stdout.toString().trim();
    const root = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(ws, SETTINGS), '{"land":"pr"}\n');
    git(ws, 'commit', '--quiet', '-am', 'land by pull request');
    const card1 = commitTree(git(ws, 'rev-parse', 'HEAD^{tree}'), [root], 'land by pull request');
    writeFileSync(join(repo, 'README.md'), 'hello again\n');
    git(repo, 'commit', '--quiet', '-am', 'readme');
    const main1 = commitTree(git(repo, 'rev-parse', 'HEAD^{tree}'), [root], 'readme');
    // each merges the other: the branch from main's side, main keeping its own settings
    const both = git(repo, 'merge-tree', '--write-tree', card1, main1);
    git(ws, 'reset', '--quiet', '--hard', commitTree(both, [main1, card1], 'merge'));
    git(repo, 'reset', '--quiet', '--hard', commitTree(git(repo, 'rev-parse', `${main1}^{tree}`), [card1, main1], 'merge'));
    expect(git(ws, 'merge-base', '--all', 'HEAD', 'main').split('\n').sort()).toEqual([card1, main1].sort());
    // the settings differ at one of the two and not at the other, the README the other way round: a
    // check against another of them than the one named answers wrongly for one of the files
    const base = git(ws, 'merge-base', 'HEAD', 'main');
    for (const file of [SETTINGS, 'README.md']) {
      const changed = git(ws, 'show', `${base}:${file}`) !== git(ws, 'show', `HEAD:${file}`);
      expect(await spaces.forkPoint(card, file)).toEqual(changed ? { ws, base } : null);
    }
  });
});

describe('the pull after a merge', () => {
  // the machine's own git configuration may set a way of pulling: none is set unless a test sets one
  ownGlobalGitConfig();
  let origin: string;
  let checkout: string;
  let spaces: Workspaces;
  beforeEach(() => ({ origin, checkout, spaces } = originAndCheckout()));

  test('rebases a main with commits of its own where git sets no way of pulling', async () => {
    const own = edit(checkout, 'notes.md', 'mine\n');
    const merged = edit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    expect(r).toEqual({ from: own, to: git(checkout, 'rev-parse', 'HEAD') });
    // the owner's commit on top of the merge, no merge commit
    expect(git(checkout, 'rev-parse', 'HEAD~1')).toBe(merged);
    expect(git(checkout, 'log', '-1', '--format=%s')).toBe('notes.md: mine');
    expect(git(checkout, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
  });

  test("keeps the repository's own way of pulling", async () => {
    git(checkout, 'config', 'pull.rebase', 'false');
    const own = edit(checkout, 'notes.md', 'mine\n');
    const merged = edit(origin, 'README.md', 'merged\n');
    expect(await spaces.pullMain()).not.toHaveProperty('problem');
    expect(git(checkout, 'rev-parse', 'HEAD^1')).toBe(own);
    expect(git(checkout, 'rev-parse', 'HEAD^2')).toBe(merged);
  });

  test("fast-forwards a main without commits of its own, the owner's uncommitted changes kept", async () => {
    writeFileSync(join(checkout, 'notes.md'), 'draft\n');
    const merged = edit(origin, 'README.md', 'merged\n');
    expect(await spaces.pullMain()).not.toHaveProperty('problem');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(merged);
    expect(readFileSync(join(checkout, 'notes.md'), 'utf8')).toBe('draft\n');
  });

  test('a pull that would stop on a conflict is not made: it names the unpushed commit it would stop at', async () => {
    edit(checkout, 'notes.md', 'mine\n');
    const own = edit(checkout, 'README.md', 'mine\n');
    const merged = edit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    expect(r).toEqual({ stopped: { commit: own, subject: 'README.md: mine', files: ['README.md'], unpushed: 2, main: own, upstream: merged } });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(own);
    expect(git(checkout, 'branch', '--show-current')).toBe('main');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
  });

  test('an unpushed commit the remote has cherry-picked is skipped, as the rebase skips it', async () => {
    const own = edit(checkout, 'README.md', 'mine\n');
    git(origin, 'fetch', '--quiet', checkout, own);
    git(origin, 'cherry-pick', own);
    edit(origin, 'README.md', 'then theirs\n');
    const r = await spaces.pullMain();
    expect(r).not.toHaveProperty('stopped');
    expect(r).not.toHaveProperty('problem');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('then theirs\n');
  });

  test('where the owner pulls by a merge, the conflict is the merge’s as a whole', async () => {
    git(checkout, 'config', 'pull.rebase', 'false');
    const own = edit(checkout, 'README.md', 'mine\n');
    edit(checkout, 'notes.md', 'mine\n');
    edit(origin, 'README.md', 'merged\n');
    const r = await spaces.pullMain();
    expect(r).toMatchObject({ stopped: { commit: own, files: ['README.md'], unpushed: 2 } });
  });
});

describe('pushing main', () => {
  ownGlobalGitConfig();
  let origin: string;
  let checkout: string;
  let spaces: Workspaces;
  beforeEach(() => {
    ({ origin, checkout, spaces } = originAndCheckout());
    // a remote one can push to
    git(origin, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  });

  test('puts the unpushed commits on the remote, after what the remote has of its own', async () => {
    edit(checkout, 'notes.md', 'mine\n');
    const theirs = edit(origin, 'README.md', 'theirs\n');
    const r = await spaces.pushMain();
    expect(r).toEqual({ from: theirs, to: git(checkout, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'HEAD'));
    expect(git(origin, 'rev-parse', 'HEAD~1')).toBe(theirs);
  });

  test('pushes nothing where what the remote has conflicts with them', async () => {
    const own = edit(checkout, 'README.md', 'mine\n');
    const theirs = edit(origin, 'README.md', 'theirs\n');
    expect(await spaces.pushMain()).toEqual({ problem: expect.stringContaining('README.md') });
    expect(git(origin, 'rev-parse', 'HEAD')).toBe(theirs);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(own);
  });
});

describe('before a merge, the clash with unpushed commits', () => {
  ownGlobalGitConfig();
  let origin: string;
  let checkout: string;
  let spaces: Workspaces;
  let pr: string;
  beforeEach(() => {
    ({ origin, checkout, spaces } = originAndCheckout());
    // the contributor's pull request, on the remote's main as it is
    git(origin, 'checkout', '--quiet', '-b', 'contrib');
    pr = commit(origin, 'README.md', 'theirs\n', 'theirs');
    git(origin, 'checkout', '--quiet', 'main');
    git(checkout, 'fetch', '--quiet', 'origin', 'contrib');
  });

  test('names the unpushed commit the pull would stop at, and touches nothing', async () => {
    edit(checkout, 'notes.md', 'mine\n');
    const own = edit(checkout, 'README.md', 'mine\n');
    writeFileSync(join(checkout, 'notes.md'), 'draft\n');
    expect(await spaces.clashBeforeMerge('card', pr)).toEqual({ commit: own, subject: 'README.md: mine', files: ['README.md'], unpushed: 2 });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(own);
    expect(git(checkout, 'status', '--porcelain')).toBe('M notes.md');
  });

  test('none without unpushed commits, nor where they touch other lines', async () => {
    expect(await spaces.clashBeforeMerge('card', pr)).toBeNull();
    edit(checkout, 'notes.md', 'mine\n');
    expect(await spaces.clashBeforeMerge('card', pr)).toBeNull();
  });

  test('none where the PR conflicts with the remote’s main itself: the forge shows that', async () => {
    edit(origin, 'README.md', 'moved\n');
    edit(checkout, 'README.md', 'mine\n');
    expect(await spaces.clashBeforeMerge('card', pr)).toBeNull();
  });
});

describe('a resolved pull lands', () => {
  ownGlobalGitConfig();
  let origin: string;
  let checkout: string;
  let ws: string;
  let spaces: Workspaces;
  beforeEach(() => {
    ({ origin, checkout, spaces } = originAndCheckout());
    ws = gitClone(origin, join(dir, 'ws', 'clone'));
    identify(ws);
  });
  /** The local main stopped at the merge; the worker rebases it in its workspace, the conflict resolved. */
  async function resolved() {
    edit(checkout, 'README.md', 'mine\n');
    edit(origin, 'README.md', 'merged\n');
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
    const later = edit(checkout, 'notes.md', 'later\n');
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

  test("the owner's checkout found on another branch is looked at without git writing its index, nor the workspace's", async () => {
    const at = await resolved();
    git(checkout, 'checkout', '--quiet', '-b', 'other');
    writeFileSync(join(checkout, 'notes.md'), 'notes of the owner\n');
    touch(checkout, 'README.md');
    touch(ws, 'notes.md');
    const [mine, theirs] = [indexOf(checkout), indexOf(ws)];
    expect(await spaces.landResolution(ws, at)).toMatchObject({ code: 'landCheckout', files: ['notes.md'] });
    expect(indexOf(checkout).equals(mine)).toBe(true);
    expect(indexOf(ws).equals(theirs)).toBe(true);
  });

  test('a main pulled meanwhile by hand needs nothing', async () => {
    const at = await resolved();
    git(checkout, 'reset', '--quiet', '--hard', at.upstream);
    expect(await spaces.landResolution(ws, at)).toEqual({ already: at.upstream });
  });
});

describe('clones the configuration no longer names', () => {
  /**
   * Writes the folder it runs in to a file of its own beside it (`1.stopped` for `1`): on Windows,
   * stops that appended to one file at once lost a line.
   */
  const STOP = WINDOWS ? 'echo %CD%> "%CD%.stopped"' : 'echo "$PWD" > "$PWD.stopped"';
  let origin: string;
  let store: Store;
  let board: Board;
  let ws: string;
  const make = async (n: number) => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: STOP });
    const paths = await spaces.ensureClones(origin, n);
    for (const p of paths) identify(p);
    return { spaces, paths };
  };
  // what the stop command ran in, as the path names it (macOS's temporary directory is behind a link)
  const stopped = () =>
    (existsSync(ws) ? readdirSync(ws).filter((f) => f.endsWith('.stopped')) : [])
      .toSorted()
      .map((f) => readFileSync(join(ws, f), 'utf8').trim().replace(/^\/private\//, '/'));

  beforeEach(() => {
    gitRepo(join(dir, 'main'));
    origin = join(dir, 'origin.git');
    gitClone(join(dir, 'main'), origin, { bare: true });
    store = new Store(':memory:');
    board = testBoard({ store, path: join(dir, 'main') });
    ws = join(dir, 'ws');
  });

  test('a free clone Obeya made leaves the pool at once, and its folder goes once its app is stopped', async () => {
    const { spaces, paths } = await make(3);
    spaces.keepOnly(null, paths.slice(0, 2));
    expect(spaces.list().map((w) => w.path)).toEqual(paths.slice(0, 2));
    await until(() => !existsSync(paths[2]!));
    expect(stopped()).toEqual([paths[2]!]);
    await until(() => !spaces.pool([])[0]!.kept);
  });

  test('its folder stays while something in it would be lost, and goes once nothing would', async () => {
    const { paths } = await make(4);
    const [changed, untracked, stashed, unpushed] = paths as [string, string, string, string];
    writeFileSync(join(changed, 'README.md'), 'changed\n');
    writeFileSync(join(untracked, 'notes.txt'), 'mine\n');
    writeFileSync(join(stashed, 'README.md'), 'stashed\n');
    git(stashed, 'stash', '--quiet');
    git(unpushed, 'checkout', '--quiet', '-b', 'obeya/card-abc123');
    commit(unpushed, 'work.txt', 'work\n', 'not pushed');
    let changes = 0;
    const watched = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: STOP, changed: () => changes++ });
    watched.keepOnly(null, []);
    expect(watched.list()).toEqual([]);
    await until(() => watched.pool([])[0]!.kept?.length === 4);
    expect(watched.pool([])[0]!.kept!.map((k) => k.path).toSorted()).toEqual(paths);
    expect(changes).toBe(4);
    for (const p of paths) expect(existsSync(join(p, '.git'))).toBe(true);
    // nothing was stopped: the folder stays as it is
    expect(stopped()).toEqual([]);
    // the work landed or was thrown away: the next start finds nothing left, and the folders go
    git(changed, 'checkout', '--quiet', '.');
    rmSync(join(untracked, 'notes.txt'));
    git(stashed, 'stash', 'drop', '--quiet');
    git(unpushed, 'push', '--quiet', 'origin', 'obeya/card-abc123');
    const next = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: STOP });
    next.sweep();
    await until(() => paths.every((p) => !existsSync(p)) && !next.pool([])[0]!.kept);
    expect(stopped().toSorted()).toEqual(paths);
  });

  test('commits a tag holds, a branch deleted on origin, or files with odd names stay; a branch squashed onto main, or a tag origin has, count as landed', async () => {
    const { spaces, paths } = await make(5);
    const [tagged, deleted, squashed, odd, released] = paths as [string, string, string, string, string];
    git(tagged, 'checkout', '--quiet', '-b', 'try');
    commit(tagged, 'try.txt');
    git(tagged, 'tag', 'tried');
    git(tagged, 'checkout', '--quiet', 'main');
    git(tagged, 'branch', '--quiet', '-D', 'try');
    git(deleted, 'checkout', '--quiet', '-b', 'obeya/gone');
    commit(deleted, 'gone.txt');
    git(deleted, 'push', '--quiet', 'origin', 'obeya/gone');
    git(origin, 'branch', '--quiet', '-D', 'obeya/gone');
    // a name with a tab (none on Windows) or a leading space is its own file, not one main has
    git(odd, 'checkout', '--quiet', '-b', 'odd');
    if (!WINDOWS) commit(odd, 'notes\tsecret.txt');
    commit(odd, ' leading.txt');
    git(squashed, 'checkout', '--quiet', '-b', 'obeya/squashed');
    commit(squashed, 'a.txt');
    commit(squashed, 'b.txt');
    // the pull request was squashed onto main, and its branch deleted
    const other = join(dir, 'other');
    gitClone(origin, other);
    identify(other);
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(other, f), `${f}\n`);
    git(other, 'add', '.');
    git(other, 'commit', '--quiet', '-m', 'Squashed');
    // and main changed one of its files since
    writeFileSync(join(other, 'a.txt'), 'a.txt\nmore\n');
    git(other, 'commit', '--quiet', '-am', 'More');
    git(other, 'push', '--quiet', 'origin', 'main');
    // a release tagged on a branch that is gone from origin, its tag pushed
    git(released, 'checkout', '--quiet', '-b', 'hotfix');
    commit(released, 'fix.txt');
    git(released, 'tag', '-a', '-m', 'Release', 'v1.0.1');
    git(released, 'push', '--quiet', 'origin', 'hotfix', 'v1.0.1');
    git(released, 'checkout', '--quiet', 'main');
    git(released, 'branch', '--quiet', '-D', 'hotfix');
    git(origin, 'branch', '--quiet', '-D', 'hotfix');
    spaces.keepOnly(null, []);
    await until(() => !existsSync(squashed) && !existsSync(released) && spaces.pool([])[0]!.kept?.length === 3, 15_000 * PATIENCE);
    const kept: KeptClone[] = [
      { path: tagged, lost: [{ what: 'commits', kind: 'tag', name: 'tried', n: 1 }] },
      { path: deleted, lost: [{ what: 'commits', kind: 'branch', name: 'obeya/gone', n: 1 }] },
      { path: odd, lost: [{ what: 'commits', kind: 'branch', name: 'odd', n: WINDOWS ? 1 : 2 }] },
    ];
    const byPath = (a: KeptClone, b: KeptClone) => a.path.localeCompare(b.path);
    expect(spaces.pool([])[0]!.kept!.toSorted(byPath)).toEqual(kept.toSorted(byPath));
  }, 30_000 * PATIENCE);

  test('a branch of a thousand files squashed onto main counts as landed, asked in command lines Windows takes', async () => {
    const { paths } = await make(1);
    const clone = paths[0]!;
    const files = Array.from({ length: 1000 }, (_, i) => `generated/a-directory-with-a-long-name/file-${String(i).padStart(4, '0')}-with-a-long-name-too.txt`);
    // one fast-import, not `git add` of a thousand files: that took seconds on a busy machine
    let stream = 'commit refs/heads/obeya/generated\ncommitter Test <test@example.com> 0 +0000\ndata 9\nGenerated\nfrom refs/heads/main\n';
    for (const f of files) stream += `M 100644 inline ${f}\ndata ${f.length + 1}\n${f}\n\n`;
    const imported = Bun.spawnSync(['git', '-C', clone, 'fast-import', '--quiet'], { stdin: Buffer.from(stream), stderr: 'pipe' });
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    git(clone, 'checkout', '--quiet', 'obeya/generated');
    // the pull request squashed onto main (the branch's files on main's commit), and its branch deleted
    const squashed = git(clone, 'commit-tree', 'obeya/generated^{tree}', '-p', 'origin/main', '-m', 'Squashed');
    git(clone, 'push', '--quiet', 'origin', `${squashed}:refs/heads/main`);
    const lines: number[] = [];
    const stop = onStart((argv) => argv.some((a) => a.startsWith(':(literal)')) && lines.push(argv.filter((a) => a.startsWith(':(literal)')).join(' ').length));
    try {
      expect(await unlanded(clone)).toEqual([]);
    } finally {
      stop();
    }
    expect(lines.length).toBeGreaterThan(1);
    // the rule `listed` keeps: about 32,000 characters fit on a command line on Windows
    for (const n of lines) expect(n).toBeLessThan(24_000);
  });

  test('work not landed that merges cleanly into main is told after one merge, not one per commit of main', async () => {
    const { paths } = await make(1);
    const clone = paths[0]!;
    git(clone, 'checkout', '--quiet', '-b', 'obeya/open');
    commit(clone, 'a.txt');
    // main changed the same file in many commits since
    const other = gitRepo(join(dir, 'other'));
    git(other, 'remote', 'add', 'origin', origin);
    git(other, 'fetch', '--quiet', 'origin');
    git(other, 'reset', '--quiet', '--hard', 'origin/main');
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(other, `main-${i}.txt`), `${i}\n`);
      writeFileSync(join(other, 'a.txt'), '');
      git(other, 'add', '.');
      git(other, 'commit', '--quiet', '-m', `Main ${i}`);
      git(other, 'rm', '--quiet', 'a.txt');
      git(other, 'commit', '--quiet', '-m', `Main ${i} again`);
    }
    git(other, 'push', '--quiet', 'origin', 'main');
    let merges = 0;
    const stop = onStart((argv) => argv.includes('merge-tree') && merges++);
    try {
      expect(await unlanded(clone)).toEqual([{ what: 'commits', kind: 'branch', name: 'obeya/open', n: 1 }]);
    } finally {
      stop();
    }
    expect(merges).toBe(1);
  });

  test('a clone named again while its folder is looked at stays, with what a card does in it', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'sleep 0.3' });
    const [path] = (await spaces.ensureClones(origin, 1)) as [string];
    spaces.keepOnly(null, []);
    await Bun.sleep(150);
    expect(await spaces.ensureClones(origin, 1)).toEqual([path]);
    const a = board.create({ title: 'A', x: 0, y: 0 }).id;
    const lease = spaces.lease(a, 'obeya/a');
    expect(lease.path).toBe(path);
    await lease.ready;
    writeFileSync(join(path, 'new.txt'), 'work\n');
    await Bun.sleep(600);
    expect(readFileSync(join(path, 'new.txt'), 'utf8')).toBe('work\n');
    expect(spaces.leasedBy(a)).toBe(path);
  });

  // Windows ends a process without a signal it could save its state on
  test.skipIf(WINDOWS)('what the app writes as it is ended keeps the folder', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws });
    const [path] = (await spaces.ensureClones(origin, 1)) as [string];
    // an app that saves its state when asked to end, which no stop command knows of
    const script = `process.on('SIGTERM', () => { require('fs').writeFileSync('saved.txt', 'snapshot'); process.exit(0); }); setInterval(() => {}, 1000);`;
    const starter = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { cwd: ${JSON.stringify(path)}, detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);`;
    const app = Number((await new Response(Bun.spawn([process.execPath, '-e', starter], { stdout: 'pipe' }).stdout).text()).trim());
    try {
      await Bun.sleep(300);
      spaces.keepOnly(null, []);
      await until(() => spaces.pool([])[0]!.kept?.length === 1, 15_000);
      expect(readFileSync(join(path, 'saved.txt'), 'utf8')).toBe('snapshot');
      expect(alive(app)).toBe(false);
    } finally {
      if (alive(app)) process.kill(app, 'SIGKILL');
    }
  }, 30_000);

  test('what the stop command leaves behind keeps the folder', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, stop: 'echo snapshot> saved.txt' });
    const [path] = (await spaces.ensureClones(origin, 1)) as [string];
    spaces.keepOnly(null, []);
    await until(() => spaces.pool([])[0]!.kept?.length === 1);
    expect(readFileSync(join(path, 'saved.txt'), 'utf8')).toMatch(/^snapshot\r?\n$/);
  });

  test('a clone of another repository in its directory is not its to remove', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws, origins: [origin] });
    const stranger = gitRepo(join(dir, 'stranger'));
    gitClone(stranger, join(ws, '7'));
    const [mine] = (await spaces.ensureClones(origin, 1)) as [string];
    spaces.keepOnly(null, []);
    spaces.sweep();
    await until(() => !existsSync(mine));
    await Bun.sleep(100);
    expect(existsSync(join(ws, '7', '.git'))).toBe(true);
  });

  test('a folder that stayed is back in the pool once the number is raised again', async () => {
    const { spaces, paths } = await make(2);
    writeFileSync(join(paths[1]!, 'notes.txt'), 'mine\n');
    spaces.keepOnly(null, paths.slice(0, 1));
    await until(() => spaces.pool([])[0]!.kept?.length === 1);
    expect(await spaces.ensureClones(origin, 2)).toEqual(paths);
    expect(spaces.list().map((w) => w.path)).toEqual(paths);
    expect(spaces.pool([])[0]!.kept).toBeUndefined();
    expect(readFileSync(join(paths[1]!, 'notes.txt'), 'utf8')).toBe('mine\n');
  });

  test('a clone a card holds stays with it until the card gives it back, then goes', async () => {
    const { spaces, paths } = await make(2);
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
    expect(spaces.retake(a, paths[0]!, 'obeya/a')).toBeNull();
  });

  test('clones made after their pool no longer wants them stay out of it', async () => {
    const spaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: join(dir, 'main'), dir: ws });
    let wanted = true;
    const made = spaces.ensureClones(origin, 2, () => wanted);
    // a restart since wants other clones
    wanted = false;
    expect(await made).toHaveLength(2);
    expect(spaces.list()).toEqual([]);
  });

  test('a clone the owner listed only leaves the pool: Obeya never touches its folder', async () => {
    const own = join(dir, 'own');
    gitClone(origin, own);
    const { spaces, paths } = await make(1);
    spaces.register(own, [origin], { origin });
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
    gitClone(origin, own);
    const { spaces, paths } = await make(3);
    const [a, b, c] = ['A', 'B', 'C'].map((title) => board.create({ title, x: 0, y: 0 }).id) as [string, string, string];
    const held = spaces.lease(a, 'obeya/a');
    expect(held.path).toBe(paths[0]!);
    await held.ready;
    spaces.register(own, [origin], { origin });
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
    const other = spaces.lease(c, 'obeya/c');
    expect(other.path).not.toBe(again.path);
    // git is through with it before the test's folder goes
    await other.ready;
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
