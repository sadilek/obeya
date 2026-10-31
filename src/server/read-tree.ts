// The Lesestand of a repository: the directory on its default branch that the canvas reads plan
// docs from and the agents that only read work in. Where work lands on the local main (Obeya's own
// checkout), that is the checkout itself; otherwise the checkout is one of the pool's clones, on
// whatever card's branch leased it last, and the Lesestand is a detached worktree of it under
// Obeya's home, kept on the default branch as `origin` has it.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { branchSetting, type Branches, CARD_BRANCH, detachedTree, detectingBranch, GIT, type GitSteps, gitOrNull, gitSteps, gitStepsSync, isFolder, readingBranches } from './workspaces';

const gitIn =
  (path: string) =>
  (...args: string[]) =>
    gitOrNull(path, ...args);

/**
 * The default branch (`defaultBranch`) and its commit as Obeya reads it: the local branch where it
 * has everything `origin`'s has (work lands there first), else `origin`'s; HEAD in a repository
 * with neither.
 */
export function defaultBranchCommit(repoPath: string): { branch: string; commit: string } {
  // a folder without git has neither
  if (isFolder(repoPath)) return { branch: '', commit: '' };
  return gitStepsSync(repoPath, readingDefaultBranch(repoPath));
}

/** `defaultBranchCommit` as git steps. */
export function* readingDefaultBranch(repoPath: string): GitSteps<{ branch: string; commit: string }> {
  const branches = yield* readingBranches();
  const branch = branchSetting(repoPath) || (yield* detectingBranch(branches));
  return { branch, commit: yield* branchCommit(branch, branches) };
}

/**
 * A seal of what the default branch and its commit are read from (`defaultBranchCommit`), taken
 * without git, by a few `stat`s: while it is the same, so is that commit, and what was read there
 * holds. The repository's own branches and `origin`'s, each by its name and the file git wrote it
 * in last (git writes a branch anew beside it, then renames it into place), the packed refs, the
 * main branch the owner set, and the branch the checkout is on where that is no card's (the main
 * branch may be told by it); not
 * the cards' branches, which change all the time and decide nothing of it. Null where it cannot be
 * told (refs in a reftable, a branch that names a card's or another ref, no git directory found):
 * git reads it then.
 */
export function refsSeal(repoPath: string): string | null {
  const dirs = gitDirs(repoPath);
  if (!dirs || existsSync(join(dirs.common, 'reftable'))) return null;
  const { common } = dirs;
  const seal: string[] = [];
  const sealed = ['refs/heads/', 'refs/remotes/origin/'];
  const cards = sealed.map((r) => `${r}${CARD_BRANCH}`);
  // a branch that names another ref (`ref: <name>`) moves with that one
  const followsSealed = (text: string) => {
    const target = text.match(/^ref: (\S+)\s*$/)?.[1];
    return !!target && sealed.some((r) => target.startsWith(r)) && !cards.some((r) => target.startsWith(r));
  };
  try {
    const at = (path: string, ref = true) => {
      const s = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (!s) return;
      // a branch holds a commit's hash, or names the ref it follows
      if (ref) {
        const text = readFileSync(path, 'utf8');
        if (text.startsWith('ref:') && !followsSealed(text)) throw new Error(`${path} follows a ref Obeya does not seal`);
      }
      seal.push(`${path.slice(common.length)} ${s.ino}:${s.size}:${s.mtimeNs}`);
    };
    const refs = (dir: string, top: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          // the cards' branches, not a branch of the repository's own that has the word in its name
          if (path !== join(top, CARD_REFS)) refs(path, top);
        } else at(path);
      }
    };
    for (const r of sealed) refs(join(common, r), join(common, r));
    at(join(common, 'packed-refs'), false);
    // where no other rule tells the main branch, the branch the checkout is on does (`detectingBranch`)
    const head = readFileSync(join(dirs.own, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ') && !head.startsWith(`ref: refs/heads/${CARD_BRANCH}`)) seal.push(`HEAD ${head}`);
    // the main branch the owner set takes the place of the one detected
    seal.push(`branch ${branchSetting(repoPath) ?? ''}`);
  } catch {
    return null;
  }
  return seal.sort().join('\n');
}

/** The directory the cards' branches are in, under a repository's branches and `origin`'s. */
const CARD_REFS = CARD_BRANCH.slice(0, -1);

/** By the repository's path: its own git directory and the one its worktrees share, as `gitDirs` found them. */
const knownDirs = new Map<string, { own: string; common: string }>();

/**
 * The git directories of the checkout at `repoPath`, from its `.git` without git: its own (`--git-dir`,
 * where its HEAD is) and the one its worktrees share (`--git-common-dir`, where the refs are); null
 * where none is found.
 */
export function gitDirs(repoPath: string): { own: string; common: string } | null {
  const known = knownDirs.get(repoPath);
  if (known) return known;
  let own = join(repoPath, '.git');
  let common: string;
  try {
    if (statSync(own).isFile()) {
      const m = readFileSync(own, 'utf8').match(/^gitdir: (.+)$/m);
      if (!m) return null;
      own = resolve(repoPath, m[1]!.trim());
    }
    const commondir = join(own, 'commondir');
    common = existsSync(commondir) ? resolve(own, readFileSync(commondir, 'utf8').trim()) : own;
    if (!statSync(join(common, 'refs')).isDirectory()) return null;
  } catch {
    return null;
  }
  const dirs = { own, common };
  knownDirs.set(repoPath, dirs);
  return dirs;
}

/** The commit of the default branch `branch` by `defaultBranchCommit`'s rule, as git steps, from `branches` where they were read already. */
export function* branchCommit(branch: string, branches?: Branches | null): GitSteps<string> {
  const b = branches !== undefined ? branches : yield* readingBranches();
  const local = b?.local.get(branch);
  const remote = b?.remote.get(branch);
  if (!local || !remote) return local ?? remote ?? 'HEAD';
  if (local === remote) return local;
  const [ahead] = yield [['merge-base', '--is-ancestor', remote, local]];
  return ahead != null ? local : remote;
}

export interface ReadTreeOptions {
  /** The repository's configured checkout. */
  repoPath: string;
  /** Where the worktree goes; null where the checkout itself is on the default branch. */
  dir: string | null;
  /** Whether the checkout has an `origin` to fetch from. */
  remote: boolean;
  /** The Lesestand moved to another commit; a move settles once what this returns does. */
  onChange: () => void | Promise<void>;
}

export class ReadTree {
  /** The directory to read from: the worktree, or the checkout where it could not be made. */
  path: string;
  /**
   * Whether git is changing the worktree's files now (moving it to another commit, making it
   * afresh): what is read there meanwhile may be half the one commit and half the other.
   */
  moving = false;
  private refreshing: Promise<void> | null = null;
  /** The moves of the worktree, one after the other, and how many have not begun yet or run. */
  private moves: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private stopped = false;

  /**
   * Makes the worktree, or brings it up to date, before the canvas reads from it: the checkout,
   * read meanwhile, may be on a card's branch. Only this first time does the server wait for git.
   */
  constructor(private o: ReadTreeOptions) {
    this.path = o.repoPath;
    if (o.dir) this.syncNow(o.dir);
  }

  /**
   * Fetches the default branch from `origin` and moves the Lesestand to the commit it now reads,
   * without blocking the server: in a repository of thousands of files a checkout takes a while.
   * A fetch that fails (offline, a lock held by a lease at the same moment) is logged; the next
   * call tries again, and the Lesestand keeps its commit meanwhile. Calls while one runs share it.
   */
  refresh(): Promise<void> {
    if (!this.o.dir || this.stopped) return Promise.resolve();
    return (this.refreshing ??= this.fetch()
      .then(() => this.move())
      .finally(() => (this.refreshing = null)));
  }

  stop() {
    this.stopped = true;
  }

  /**
   * Moves the Lesestand where it now belongs, once work lands elsewhere: the checkout (`null`), or
   * the worktree at `dir`, made or brought up to date in the background, the Lesestand staying
   * where it was until then. Tells `onChange` where it moved.
   */
  retarget(dir: string | null): Promise<void> {
    if (dir === this.o.dir || this.stopped) return Promise.resolve();
    this.o.dir = dir;
    if (dir) return this.move();
    const read = () => {
      const was = this.path;
      this.path = this.o.repoPath;
      if (this.path !== was && !this.stopped) this.o.onChange();
    };
    if (!this.queued) {
      read();
      return Promise.resolve();
    }
    // after the moves under way, which would otherwise put it back into the worktree
    const moved = this.moves.then(read);
    this.moves = moved.catch(() => {});
    return moved;
  }

  /** The commit the Lesestand is on. */
  head(): string {
    return gitIn(this.path)('rev-parse', 'HEAD') ?? '';
  }

  /** Whether the Lesestand holds `commit`: it is the commit the Lesestand is on, or an ancestor of it. */
  holds(commit: string): boolean {
    return gitIn(this.path)('merge-base', '--is-ancestor', commit, 'HEAD') !== null;
  }

  private async fetch() {
    if (!this.o.remote) return;
    const { branch } = await gitSteps(this.o.repoPath, readingDefaultBranch(this.o.repoPath));
    // only the default branch, and no FETCH_HEAD: what a lease fetching in the same clone touches stays its own
    const p = Bun.spawn([GIT, '-C', this.o.repoPath, 'fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    if (code !== 0) console.error(`Lesestand: git fetch origin in ${this.o.repoPath}: ${err.trim()}`);
  }

  /** Puts the worktree where `sync` says, after the moves before it; tells `onChange` where the Lesestand moved. */
  private move(): Promise<void> {
    this.queued++;
    const moved = this.moves
      .then(async () => {
        if (this.stopped || !this.o.dir) return;
        this.moving = true;
        let moved: boolean;
        try {
          moved = await this.sync(this.o.dir);
        } finally {
          this.moving = false;
        }
        if (moved && !this.stopped) await this.o.onChange();
      })
      .finally(() => this.queued--);
    this.moves = moved.catch(() => {});
    return moved;
  }

  /**
   * Puts the worktree at `dir` on the commit the default branch has now, making it afresh where it
   * is missing, broken or another repository's. Returns whether the Lesestand moved (to another
   * commit or directory). Where no worktree can be made, the checkout is read instead.
   */
  private async sync(dir: string): Promise<boolean> {
    const found = await gitSteps(this.o.repoPath, checking(this.o.repoPath, dir));
    if (found.state !== 'afresh') return this.settled(dir, found.state);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      return this.kept(dir, e);
    }
    mkdirSync(dirname(dir), { recursive: true });
    return this.made(dir, await gitSteps(this.o.repoPath, making(dir, found.target)));
  }

  /** `sync` with the server waiting for git, at the start. */
  private syncNow(dir: string): boolean {
    const found = gitStepsSync(this.o.repoPath, checking(this.o.repoPath, dir));
    if (found.state !== 'afresh') return this.settled(dir, found.state);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      return this.kept(dir, e);
    }
    mkdirSync(dirname(dir), { recursive: true });
    return this.made(dir, gitStepsSync(this.o.repoPath, making(dir, found.target)));
  }

  /** The worktree at `dir` is on the default branch's commit (`same`: was already), or there is no such commit. */
  private settled(dir: string, state: 'same' | 'moved' | 'none'): boolean {
    if (state === 'none') return false;
    const was = this.path;
    this.path = dir;
    return state === 'moved' || was !== dir;
  }

  /** On Windows a process working in the directory (an agent reading there) keeps it: the server died of that EBUSY; this time the checkout is read, and the next refresh tries again. */
  private kept(dir: string, e: unknown): boolean {
    console.error(`Lesestand: ${dir} cannot be made afresh now (${(e as NodeJS.ErrnoException).code ?? e}); reading the checkout`);
    return this.readCheckout();
  }

  /** The worktree at `dir` was made afresh, unless `ok` says git could not. */
  private made(dir: string, ok: boolean): boolean {
    if (!ok) {
      console.error(`Lesestand: no worktree of ${this.o.repoPath} at ${dir}; reading the checkout`);
      return this.readCheckout();
    }
    this.path = dir;
    return true;
  }

  /** The checkout is read where no worktree can be made; returns whether that moved the Lesestand. */
  private readCheckout(): boolean {
    const moved = this.path !== this.o.repoPath;
    this.path = this.o.repoPath;
    return moved;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Where the worktree at `dir` stands against the commit the default branch of `repoPath` has now,
 * as git steps in `repoPath`: on it already (`same`), moved onto it (`moved`), or to be made afresh
 * (missing, broken, another repository's, or the checkout failed); `none` where there is no such commit.
 */
function* checking(repoPath: string, dir: string): GitSteps<{ state: 'same' | 'moved' | 'none' } | { state: 'afresh'; target: string }> {
  const { commit } = yield* readingDefaultBranch(repoPath);
  const [target] = yield [['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]];
  if (!target) return { state: 'none' };
  if (existsSync(dir)) {
    const [top, common, own, head] = yield [
      ['-C', dir, 'rev-parse', '--show-toplevel'],
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['-C', dir, 'rev-parse', 'HEAD'],
    ];
    // a worktree of the checkout's repository, at its top
    if (top && common && own && real(top) === real(dir) && real(common) === real(own)) {
      if (head === target) return { state: 'same' };
      // the hooks are the checkout's (a post-checkout installing dependencies, say), not the Lesestand's
      const [checkedOut] = yield [['-C', dir, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', '--force', target]];
      if (checkedOut !== null) return { state: 'moved' };
    }
  }
  return { state: 'afresh', target };
}

/** Adds the worktree at `dir` detached at `target`, as git steps in the checkout's repository; whether git could. */
function* making(dir: string, target: string): GitSteps<boolean> {
  yield [['worktree', 'prune']];
  const [added] = yield [detachedTree(dir, target)];
  return added !== null;
}
