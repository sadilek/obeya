// Where a card's worker works, and how approved work lands.
//
// `clones`: a pool of full clones per canvas, leased one card at a time (Acme: tools that break in
// worktrees, one app stack per clone). `worktrees`: one worktree of the Obeya checkout per card,
// created on start, as many in parallel as there are cards; kept across stop and restart until
// the card's work has landed.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db';

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: 'noWorkspace' | 'dirtyWorkspaces' | 'workspace' = 'workspace',
  ) {
    super(message);
  }
}

export interface LandProblem {
  code: 'landDirty' | 'landConflict' | 'landEmpty' | 'landCheckout' | 'landMerge' | 'land';
  /** Whether the worker can fix it in its workspace; otherwise it is the owner's (the Obeya checkout). */
  worker: boolean;
  detail: string;
  files?: string[];
}

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
  /** The repository on the canvas these workspaces belong to; null is its home repository. */
  repo?: string | null;
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

  /** Registers a clone; with `origins`, only when its `origin` is one of them. */
  register(path: string, origins?: string[]) {
    git(path, 'rev-parse', '--git-dir');
    if (origins?.length) {
      let origin = '';
      try {
        origin = git(path, 'remote', 'get-url', 'origin');
      } catch {}
      const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
      if (!origins.some((o) => norm(o) === norm(origin))) throw new WorkspaceError(`${path} is not a clone of ${origins.join(' or ')} (its origin is ${origin || 'unset'})`);
    }
    this.store.addWorkspace(this.canvasId, path, this.o.repo ?? null);
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
    return this.store.workspaces(this.canvasId, this.o.repo ?? null);
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

  /** Whether the card's workspace holds work: uncommitted changes or commits beyond the base. */
  hasWork(cardId: string): boolean {
    const ws = this.leasedBy(cardId);
    if (!ws || !existsSync(ws)) return false;
    try {
      if (git(ws, 'status', '--porcelain')) return true;
      const base = this.o.mode === 'worktrees' ? defaultBranch(this.o.repoPath) : `origin/${defaultBranch(ws)}`;
      return git(ws, 'rev-list', '--count', `${base}..HEAD`) !== '0';
    } catch {
      return true;
    }
  }

  /** Frees the workspace for other cards; a worktree stays until the card's work has landed. */
  release(cardId: string) {
    const path = this.leasedBy(cardId);
    if (path) this.store.setLease(path, null);
  }

  /**
   * Lands the card's committed branch on the Obeya checkout's default branch by rebasing and
   * fast-forwarding; a worktree and its branch are removed afterwards. Returns what went wrong:
   * `worker` problems are the worker's to fix, the others stop at the Obeya checkout.
   */
  landOnMain(cardId: string, branch: string): LandProblem | null {
    const ws = this.leasedBy(cardId);
    if (!ws) return { code: 'land', worker: false, detail: 'the card has no workspace' };
    let base = 'main';
    try {
      if (git(ws, 'status', '--porcelain')) return { code: 'landDirty', worker: true, detail: 'uncommitted changes in the workspace' };
      base = defaultBranch(this.o.mode === 'worktrees' ? this.o.repoPath : ws);
      const upstream = this.o.mode === 'worktrees' ? base : `origin/${base}`;
      if (this.o.mode === 'clones') git(ws, 'fetch', '--quiet', 'origin');
      try {
        git(ws, 'rebase', '--quiet', upstream);
      } catch (e) {
        const files = git(ws, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        git(ws, 'rebase', '--abort');
        return {
          code: 'landConflict',
          worker: true,
          files,
          detail: `rebase onto ${base} failed${files.length ? `; conflicts in ${files.join(', ')}` : ''}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (git(ws, 'rev-list', '--count', `${upstream}..HEAD`) === '0') return { code: 'landEmpty', worker: true, detail: 'the branch has no commits' };
      if (git(this.o.repoPath, 'branch', '--show-current') !== base) return { code: 'landCheckout', worker: false, detail: `the Obeya checkout is not on ${base}` };
    } catch (e) {
      return { code: 'land', worker: false, detail: e instanceof Error ? e.message : String(e) };
    }
    try {
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
      // typically local changes in the Obeya checkout that the fast-forward would overwrite
      return { code: 'landMerge', worker: false, detail: e instanceof Error ? e.message : String(e) };
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
    if (!free.length) throw new WorkspaceError('no workspace registered or all are leased', 'noWorkspace');
    const clean = free.find((w) => existsSync(w.path) && git(w.path, 'status', '--porcelain') === '');
    if (!clean) throw new WorkspaceError('every free workspace has uncommitted changes', 'dirtyWorkspaces');
    const base = defaultBranch(clean.path);
    git(clean.path, 'fetch', '--quiet', 'origin');
    // a branch that already exists holds work: check it out, never reset it
    if (git(clean.path, 'branch', '--list', branch)) git(clean.path, 'checkout', '--quiet', branch);
    else git(clean.path, 'checkout', '--quiet', '-b', branch, `origin/${base}`);
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
    this.store.addWorkspace(this.canvasId, path, this.o.repo ?? null);
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
