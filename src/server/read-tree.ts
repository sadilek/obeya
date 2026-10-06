// The Lesestand of a repository: the directory on its default branch that the canvas reads plan
// docs from and the agents that only read work in. Where work lands on the local main (Obeya's own
// checkout), that is the checkout itself; otherwise the checkout is one of the pool's clones, on
// whatever card's branch leased it last, and the Lesestand is a detached worktree of it under
// Obeya's home, kept on the default branch as `origin` has it.

import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { GIT } from './workspaces';

type Git = (...args: string[]) => string | null;

const gitIn =
  (path: string): Git =>
  (...args) => {
    const r = Bun.spawnSync([GIT, '-C', path, ...args], { stderr: 'ignore' });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };

/**
 * The default branch's commit as Obeya reads it: the local branch where it has everything
 * `origin`'s has (work lands there first), else `origin`'s; HEAD in a repository with neither.
 */
export function defaultBranchCommit(repoPath: string): { branch: string; commit: string } {
  const git = gitIn(repoPath);
  const branch = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') ?? 'main';
  const local = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  const remote = git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
  const commit = local && remote ? (git('merge-base', '--is-ancestor', remote, local) !== null ? local : remote) : (local ?? remote ?? 'HEAD');
  return { branch, commit };
}

export interface ReadTreeOptions {
  /** The repository's configured checkout. */
  repoPath: string;
  /** Where the worktree goes; null where the checkout itself is on the default branch. */
  dir: string | null;
  /** Whether the checkout has an `origin` to fetch from. */
  remote: boolean;
  /** The Lesestand moved to another commit. */
  onChange: () => void;
}

export class ReadTree {
  /** The directory to read from: the worktree, or the checkout where it could not be made. */
  path: string;
  private refreshing: Promise<void> | null = null;
  private stopped = false;

  constructor(private o: ReadTreeOptions) {
    this.path = o.repoPath;
    if (o.dir) this.sync();
  }

  /**
   * Fetches the default branch from `origin` and moves the Lesestand to the commit it now reads.
   * A fetch that fails (offline, a lock held by a lease at the same moment) is logged; the next
   * call tries again, and the Lesestand keeps its commit meanwhile. Calls while one runs share it.
   */
  refresh(): Promise<void> {
    if (!this.o.dir || this.stopped) return Promise.resolve();
    return (this.refreshing ??= this.fetch()
      .then(() => {
        if (!this.stopped && this.sync()) this.o.onChange();
      })
      .finally(() => (this.refreshing = null)));
  }

  stop() {
    this.stopped = true;
  }

  private async fetch() {
    if (!this.o.remote) return;
    const { branch } = defaultBranchCommit(this.o.repoPath);
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

  /**
   * Puts the worktree on the commit the default branch has now, making it afresh where it is
   * missing, broken or another repository's. Returns whether it moved. Where no worktree can be
   * made, the checkout is read instead.
   */
  private sync(): boolean {
    const dir = this.o.dir!;
    const repo = gitIn(this.o.repoPath);
    const { commit } = defaultBranchCommit(this.o.repoPath);
    const target = repo('rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
    if (!target) return false;
    // the hooks are the checkout's (a post-checkout installing dependencies, say), not the Lesestand's
    const quiet = ['-c', 'core.hooksPath=/dev/null'];
    if (this.valid(dir)) {
      const tree = gitIn(dir);
      if (tree('rev-parse', 'HEAD') === target) {
        this.path = dir;
        return false;
      }
      if (tree(...quiet, 'checkout', '--quiet', '--detach', '--force', target) !== null) {
        this.path = dir;
        return true;
      }
    }
    rmSync(dir, { recursive: true, force: true });
    repo('worktree', 'prune');
    mkdirSync(dirname(dir), { recursive: true });
    if (repo(...quiet, 'worktree', 'add', '--quiet', '--detach', '--force', dir, target) === null) {
      console.error(`Lesestand: no worktree of ${this.o.repoPath} at ${dir}; reading the checkout`);
      const moved = this.path !== this.o.repoPath;
      this.path = this.o.repoPath;
      return moved;
    }
    this.path = dir;
    return true;
  }

  /** Whether `dir` is a worktree of the checkout's repository, at its top. */
  private valid(dir: string): boolean {
    if (!existsSync(dir)) return false;
    const tree = gitIn(dir);
    const top = tree('rev-parse', '--show-toplevel');
    const common = tree('rev-parse', '--path-format=absolute', '--git-common-dir');
    const own = gitIn(this.o.repoPath)('rev-parse', '--path-format=absolute', '--git-common-dir');
    return !!top && !!common && !!own && real(top) === real(dir) && real(common) === real(own);
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
