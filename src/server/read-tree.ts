// The read tree of a repository: the directory on its default branch that the canvas reads plan
// docs from and the agents that only read work in. Where work lands on the local main (Obeya's own
// checkout), that is the checkout itself; otherwise the checkout is one of the pool's clones, on
// whatever card's branch leased it last, and the read tree is a detached worktree of it under
// Obeya's home, kept on the default branch as `origin` has it.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { branchSetting, CARD_BRANCH, defaultBranchCommit } from './branches';
import { gitAsync, gitRun, gitTry, isAncestor, NO_PROMPT, pastWorktreeRace } from './git';
import { realPath } from './path';
import { detachedTree } from './workspaces';

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

/**
 * A seal of the commit the checkout at `repoPath` is on, taken without git: its HEAD, and where
 * that names a branch, the file git wrote the branch in last and the packed refs. Null where it
 * cannot be told (refs in a reftable, a branch that names another ref, no git directory found).
 */
export function headSeal(repoPath: string): string | null {
  const dirs = gitDirs(repoPath);
  if (!dirs || existsSync(join(dirs.common, 'reftable'))) return null;
  try {
    const head = readFileSync(join(dirs.own, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: (\S+)$/)?.[1];
    if (!ref) return head;
    const at = (path: string) => {
      const s = statSync(path, { bigint: true, throwIfNoEntry: false });
      return s ? `${s.ino}:${s.size}:${s.mtimeNs}` : '-';
    };
    const loose = join(dirs.common, ref);
    if (existsSync(loose) && readFileSync(loose, 'utf8').startsWith('ref:')) return null;
    return `${head} ${at(loose)} ${at(join(dirs.common, 'packed-refs'))}`;
  } catch {
    return null;
  }
}

/**
 * What git keeps in a checkout's own git directory while it writes the checkout's files or stands
 * in the middle of an operation there: the index's lock (a checkout, merge, reset or pull writing
 * files), a rebase, a merge, cherry-pick or revert stopped on a conflict or running commit after
 * commit, a bisect.
 */
const AT_WORK = ['index.lock', 'rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_START'];

/**
 * Whether git is at work in the checkout at `path` (`AT_WORK`), told without git: its files are then
 * no finished state of its branch, but half the one commit and half the other (a rebase's files are
 * the upstream's until the local commits are put back on top).
 */
export function gitAtWork(path: string): boolean {
  const dirs = gitDirs(path);
  return !!dirs && AT_WORK.some((f) => existsSync(join(dirs.own, f)));
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

export interface ReadTreeOptions {
  /** The repository's configured checkout. */
  repoPath: string;
  /** Where the worktree goes; null where the checkout itself is on the default branch. */
  dir: string | null;
  /** Whether the checkout has an `origin` to fetch from. */
  remote: boolean;
  /** The read tree moved to another commit; a move settles once what this returns does. */
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
  /** Who hears once git is done in the read tree (`afterGit`), and the look every so often whether it is. */
  private gitWait: { then: () => void; since: number; warned: boolean; timer: ReturnType<typeof setInterval> } | null = null;
  private refreshing: Promise<void> | null = null;
  /** The moves of the worktree, one after the other, and how many have not begun yet or run. */
  private moves: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private stopped = false;

  /** Settles once the worktree was first put in place (`sync`), which `onChange` does not hear of; the read tree is the checkout until then where there was none. */
  readonly ready: Promise<void>;

  /**
   * Makes the worktree, or brings it up to date, without blocking the server: a worktree already
   * there is read from at once, and moves as `sync` says. Made ahead (`prepareReadTree`) as a
   * canvas starts, it is in place before the canvas reads from it: the checkout, read meanwhile,
   * may be on a card's branch.
   */
  constructor(private o: ReadTreeOptions) {
    this.path = o.dir && existsSync(join(o.dir, '.git')) ? o.dir : o.repoPath;
    // no move to tell of: what was read so far was not the read tree's
    this.ready = o.dir ? this.move(false) : Promise.resolve();
  }

  /**
   * Fetches the default branch from `origin` and moves the read tree to the commit it now reads,
   * without blocking the server: in a repository of thousands of files a checkout takes a while.
   * A fetch that fails (offline, a lock held by a lease at the same moment) is logged; the next
   * call tries again, and the read tree keeps its commit meanwhile. Calls while one runs share it.
   */
  refresh(): Promise<void> {
    if (!this.o.dir || this.stopped) return Promise.resolve();
    return (this.refreshing ??= this.fetch()
      .then(() => this.move())
      .finally(() => (this.refreshing = null)));
  }

  stop() {
    this.stopped = true;
    this.endGitWait();
  }

  /**
   * Whether git is changing the read tree's files now or stands in the middle of an operation there:
   * Obeya moving the worktree (`moving`), or git at work in the directory read (`gitAtWork`), such as
   * a pull, rebase or landing in the checkout, by Obeya or by hand. What is read meanwhile may be
   * half the one state and half the other.
   */
  busy(): boolean {
    return this.moving || gitAtWork(this.path);
  }

  /**
   * Calls `then` once git is done in the read tree (`busy`), looked at every 100 ms. Calls while it
   * waits share the wait, the last one's `then` called. Git still at work after a minute (a rebase
   * stopped on a conflict, a lock left behind by a git that crashed) is logged once.
   */
  afterGit(then: () => void) {
    if (this.stopped) return;
    if (this.gitWait) {
      this.gitWait.then = then;
      return;
    }
    const wait: NonNullable<ReadTree['gitWait']> = {
      then,
      since: Date.now(),
      warned: false,
      timer: setInterval(() => {
        if (this.busy()) {
          if (!wait.warned && Date.now() - wait.since > 60_000) {
            wait.warned = true;
            console.warn(`Read tree: git has been at work in ${this.path} for a minute (a rebase or merge stopped on a conflict, or a lock left behind); its plan docs are read again once it is done`);
          }
          return;
        }
        this.endGitWait();
        wait.then();
      }, 100),
    };
    wait.timer.unref?.();
    this.gitWait = wait;
  }

  private endGitWait() {
    if (this.gitWait) clearInterval(this.gitWait.timer);
    this.gitWait = null;
  }

  /**
   * Moves the read tree where it now belongs, once work lands elsewhere: the checkout (`null`), or
   * the worktree at `dir`, made or brought up to date in the background, the read tree staying
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

  /** The commit the read tree is on. */
  async head(): Promise<string> {
    return (await gitTry(this.path, 'rev-parse', 'HEAD')) ?? '';
  }

  /**
   * Whether the read tree holds `commit` (it is the commit the read tree is on, or an ancestor of
   * it), as far as known already: git is asked in the background what is not, which counts as not
   * held meanwhile, and `then` hears once it is. What was found stands while the read tree does
   * (`standing`); where that cannot be told, only what is held stands, and what is not is asked again.
   */
  holds(commit: string, then?: () => void): boolean {
    const at = this.standing();
    if (at === null) {
      // a checkout whose HEAD cannot be sealed moves unseen: a commit it holds it keeps (bar a force-push), one it lacks it may hold by now
      if (this.heldAt !== null) this.held.clear();
      this.heldAt = null;
    } else if (at !== this.heldAt) {
      this.held.clear();
      this.heldAt = at;
    }
    const known = this.held.get(commit);
    if (typeof known === 'boolean') return known;
    if (!known) {
      const asked = isAncestor(this.path, commit, 'HEAD', false).catch(() => false);
      this.held.set(commit, asked);
      void asked.then((held) => {
        // the read tree moved meanwhile: what it holds now is asked afresh
        if (this.held.get(commit) !== asked) return;
        if (held || this.heldAt !== null) this.held.set(commit, held);
        else this.held.delete(commit);
        if (held && !this.stopped) then?.();
      });
    }
    return false;
  }

  /** By commit, what `holds` found (or is finding) while the read tree stood at `heldAt`. */
  private held = new Map<string, boolean | Promise<boolean>>();
  private heldAt: string | null | undefined;
  /** How often the worktree moved: only this tree moves it. */
  private moved = 0;

  /**
   * Where the read tree stands, without git: the worktree by its moves, the checkout by its HEAD
   * and the branch that names (`headSeal`), which work landing there moves; null where the
   * checkout's cannot be told.
   */
  private standing(): string | null {
    if (this.path !== this.o.repoPath) return `${this.path}\n${this.moved}`;
    const head = headSeal(this.path);
    return head === null ? null : `${this.path}\n${head}`;
  }

  private async fetch() {
    if (!this.o.remote) return;
    const { branch } = await defaultBranchCommit(this.o.repoPath);
    // only the default branch, and no FETCH_HEAD: what a lease fetching in the same clone touches stays its own
    const r = await gitRun(this.o.repoPath, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env: NO_PROMPT });
    if (r.code !== 0) console.error(`Read tree: git fetch origin in ${this.o.repoPath}: ${r.stderr.trim()}`);
  }

  /** Puts the worktree where `sync` says, after the moves before it; tells `onChange` where the read tree moved (`tell`). */
  private move(tell = true): Promise<void> {
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
        if (moved && tell && !this.stopped) await this.o.onChange();
      })
      .finally(() => this.queued--);
    this.moves = moved.catch(() => {});
    return moved;
  }

  /**
   * Puts the worktree at `dir` on the commit the default branch has now, making it afresh where it
   * is missing, broken or another repository's. Returns whether the read tree moved (to another
   * commit or directory). Where no worktree can be made, the checkout is read instead.
   */
  private async sync(dir: string): Promise<boolean> {
    const state = await putWorktree(this.o.repoPath, dir);
    if (state === 'none') return false;
    if (state === 'failed') return this.readCheckout();
    const was = this.path;
    this.path = dir;
    if (state !== 'same') this.moved++;
    return state !== 'same' || was !== dir;
  }

  /** The checkout is read where no worktree can be made; returns whether that moved the read tree. */
  private readCheckout(): boolean {
    const moved = this.path !== this.o.repoPath;
    this.path = this.o.repoPath;
    return moved;
  }
}

/**
 * Puts the worktree at `dir` on the commit the default branch of `repoPath` has now, making it
 * afresh where it is missing, broken or another repository's: on it already (`same`), moved onto it
 * (`moved`), made afresh (`made`), or not (`failed`: the log says why); `none` where there is no such
 * commit.
 */
async function putWorktree(repoPath: string, dir: string): Promise<'same' | 'moved' | 'made' | 'failed' | 'none'> {
  const found = await checkWorktree(repoPath, dir);
  if (found.state !== 'afresh') return found.state;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    // on Windows a process working in the directory (an agent reading there) keeps it: the server died of that EBUSY; this time the checkout is read, and the next refresh tries again
    console.error(`Read tree: ${dir} cannot be made afresh now (${(e as NodeJS.ErrnoException).code ?? e}); reading the checkout`);
    return 'failed';
  }
  mkdirSync(dirname(dir), { recursive: true });
  if (await addWorktree(repoPath, dir, found.target)) return 'made';
  console.error(`Read tree: no worktree of ${repoPath} at ${dir}; reading the checkout`);
  return 'failed';
}

/** Puts a read tree's worktree in place ahead of its `ReadTree` (`putWorktree`), as a canvas starts: the tree then reads from it at once. */
export const prepareReadTree = (repoPath: string, dir: string): Promise<unknown> => putWorktree(repoPath, dir);

/**
 * Where the worktree at `dir` stands against the commit the default branch of `repoPath` has now:
 * on it already (`same`), moved onto it (`moved`), or to be made afresh (missing, broken, another
 * repository's, or the checkout failed); `none` where there is no such commit.
 */
async function checkWorktree(repoPath: string, dir: string): Promise<{ state: 'same' | 'moved' | 'none' } | { state: 'afresh'; target: string }> {
  const { commit } = await defaultBranchCommit(repoPath);
  const target = await gitTry(repoPath, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
  if (!target) return { state: 'none' };
  if (existsSync(dir)) {
    const [top, common, own, head] = await Promise.all([
      gitTry(dir, 'rev-parse', '--show-toplevel'),
      gitTry(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      gitTry(repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      gitTry(dir, 'rev-parse', 'HEAD'),
    ]);
    // a worktree of the checkout's repository, at its top
    if (top && common && own && realPath(top) === realPath(dir) && realPath(common) === realPath(own)) {
      if (head === target) return { state: 'same' };
      // the hooks are the checkout's (a post-checkout installing dependencies, say), not the read tree's
      const checkedOut = await gitTry(dir, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', '--force', target);
      if (checkedOut !== null) return { state: 'moved' };
    }
  }
  return { state: 'afresh', target };
}

/** Adds the worktree at `dir` detached at `target` to the checkout `repoPath`'s repository; whether git could. */
async function addWorktree(repoPath: string, dir: string, target: string): Promise<boolean> {
  await gitTry(repoPath, 'worktree', 'prune');
  return pastWorktreeRace(() => gitAsync(repoPath, ...detachedTree(dir, target))).then(
    () => true,
    () => false,
  );
}
