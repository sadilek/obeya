// Where a card's worker works, and how approved work lands.
//
// `clones`: a pool of full clones per canvas, leased one card at a time (OKE: tools that break in
// worktrees, one app stack per clone). `worktrees`: one worktree of the Obeya checkout per card,
// created on start, as many in parallel as there are cards; kept across stop and restart until
// the card's work has landed.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db';

export class WorkspaceError extends Error {}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

export interface WorkspaceOptions {
  mode: 'clones' | 'worktrees';
  /** The checkout Obeya runs on. */
  repoPath: string;
  /** Where worktrees and created clones go. */
  dir: string;
}

export class Workspaces {
  constructor(
    private store: Store,
    private canvasId: string,
    private o: WorkspaceOptions,
  ) {}

  get mode() {
    return this.o.mode;
  }

  register(path: string) {
    git(path, 'rev-parse', '--git-dir');
    this.store.addWorkspace(this.canvasId, path);
  }

  /** Makes sure `n` clones of `source` exist and are registered. */
  ensureClones(source: string, n: number) {
    mkdirSync(this.o.dir, { recursive: true });
    for (let i = 1; i <= n; i++) {
      const path = join(this.o.dir, String(i));
      if (!existsSync(path)) git(this.o.dir, 'clone', '--quiet', source, path);
      this.register(path);
    }
  }

  list() {
    return this.store.workspaces(this.canvasId);
  }

  leasedBy(cardId: string): string | null {
    return this.list().find((w) => w.card_id === cardId)?.path ?? null;
  }

  /** Gives the card a workspace on `branch` and returns its path. */
  lease(cardId: string, branch: string): string {
    const own = this.leasedBy(cardId);
    if (own) return own;
    return this.o.mode === 'worktrees' ? this.leaseWorktree(cardId, branch) : this.leaseClone(cardId, branch);
  }

  /** Frees the workspace for other cards; a worktree stays until the card's work has landed. */
  release(cardId: string) {
    const path = this.leasedBy(cardId);
    if (path) this.store.setLease(path, null);
  }

  /**
   * Lands the card's committed branch on the Obeya checkout's default branch by rebasing and
   * fast-forwarding; a worktree and its branch are removed afterwards. Returns what went wrong.
   */
  landOnMain(cardId: string, branch: string): string | null {
    const ws = this.leasedBy(cardId);
    if (!ws) return 'the card has no workspace';
    try {
      if (git(ws, 'status', '--porcelain')) return 'uncommitted changes in the workspace';
      const base = defaultBranch(this.o.mode === 'worktrees' ? this.o.repoPath : ws);
      const upstream = this.o.mode === 'worktrees' ? base : `origin/${base}`;
      if (this.o.mode === 'clones') git(ws, 'fetch', '--quiet', 'origin');
      try {
        git(ws, 'rebase', '--quiet', upstream);
      } catch (e) {
        git(ws, 'rebase', '--abort');
        return `rebase onto ${base} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (git(ws, 'rev-list', '--count', `${upstream}..HEAD`) === '0') return 'the branch has no commits';
      if (git(this.o.repoPath, 'branch', '--show-current') !== base) return `the Obeya checkout is not on ${base}`;
      if (this.o.mode === 'worktrees') {
        git(this.o.repoPath, 'merge', '--ff-only', '--quiet', branch);
        this.store.removeWorkspace(ws);
        git(this.o.repoPath, 'worktree', 'remove', ws);
        git(this.o.repoPath, 'branch', '--quiet', '-d', branch);
      } else {
        git(this.o.repoPath, 'fetch', '--quiet', ws, branch);
        git(this.o.repoPath, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD');
        this.release(cardId);
      }
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** Files the card's branch changes so far, committed or not, relative to the repository root. */
  changedFiles(cardId: string): string[] {
    const ws = this.leasedBy(cardId);
    if (!ws || !existsSync(ws)) return [];
    try {
      const base = this.o.mode === 'worktrees' ? defaultBranch(this.o.repoPath) : `origin/${defaultBranch(ws)}`;
      const committed = git(ws, 'diff', '--name-only', `${git(ws, 'merge-base', 'HEAD', base)}..HEAD`);
      const changed = git(ws, 'diff', '--name-only', 'HEAD');
      const untracked = git(ws, 'ls-files', '--others', '--exclude-standard');
      return [...new Set([committed, changed, untracked].flatMap((s) => s.split('\n')).filter(Boolean))];
    } catch {
      return [];
    }
  }

  private leaseClone(cardId: string, branch: string): string {
    const free = this.list().filter((w) => !w.card_id);
    if (!free.length) throw new WorkspaceError('no workspace registered or all are leased');
    const clean = free.find((w) => existsSync(w.path) && git(w.path, 'status', '--porcelain') === '');
    if (!clean) throw new WorkspaceError('every free workspace has uncommitted changes');
    const base = defaultBranch(clean.path);
    git(clean.path, 'fetch', '--quiet', 'origin');
    git(clean.path, 'checkout', '--quiet', '-B', branch, `origin/${base}`);
    this.store.setLease(clean.path, cardId);
    return clean.path;
  }

  private leaseWorktree(cardId: string, branch: string): string {
    const path = join(this.o.dir, cardId.slice(0, 8));
    if (!existsSync(path)) {
      mkdirSync(this.o.dir, { recursive: true });
      const exists = git(this.o.repoPath, 'branch', '--list', branch) !== '';
      if (exists) git(this.o.repoPath, 'worktree', 'add', '--quiet', path, branch);
      else git(this.o.repoPath, 'worktree', 'add', '--quiet', '-b', branch, path, defaultBranch(this.o.repoPath));
    }
    this.store.addWorkspace(this.canvasId, path);
    this.store.setLease(path, cardId);
    return path;
  }

}

/** The remote's default branch as the checkout knows it (`main` if origin has no HEAD). */
export function defaultBranch(path: string): string {
  try {
    return git(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/** `obeya/<slug>` from a card title, kept short and unique by the card id. */
export function branchName(title: string, cardId: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return `obeya/${slug || 'card'}-${cardId.slice(0, 6)}`;
}
