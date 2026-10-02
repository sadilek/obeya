// Where a card's worker works, and how approved work lands.
//
// `clones`: a pool of full clones per canvas, leased one card at a time (OKE: tools that break in
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

/** Work that landed: the default branch moved from `from` to `to`. */
export interface Landed {
  from: string;
  to: string;
}

/**
 * The git binary. On macOS `/usr/bin/git` is a shim that asks xcrun for the real one on every
 * call, which more than doubles what a call costs; Obeya calls git often, so it asks once.
 */
export const GIT = gitBinary();

function gitBinary(): string {
  if (process.platform !== 'darwin' || Bun.which('git') !== '/usr/bin/git') return 'git';
  const r = Bun.spawnSync(['xcrun', '--find', 'git'], { stderr: 'ignore' });
  const path = r.exitCode === 0 ? r.stdout.toString().trim() : '';
  return path && existsSync(path) ? path : 'git';
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([GIT, '-C', cwd, ...args], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/**
 * Puts the branch's whole change onto `upstream` as one commit, if it merges cleanly there; the
 * commits' messages are kept in order, their trailers once at the end. Returns whether it did.
 */
function squashOnto(ws: string, upstream: string): boolean {
  let tree: string;
  try {
    // exits non-zero on a conflict
    tree = git(ws, 'merge-tree', '--write-tree', upstream, 'HEAD').split('\n')[0]!;
  } catch {
    return false;
  }
  const trailers: string[] = [];
  const bodies = git(ws, 'log', '--reverse', '--format=%B%x00', `${upstream}..HEAD`)
    .split('\0')
    .map((m) =>
      m
        .split('\n')
        .filter((line) => !(/^[\w-]+-by: /i.test(line) && trailers.push(line)))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
  const message = [...bodies, [...new Set(trailers)].join('\n')].filter(Boolean).join('\n\n');
  const commit = git(ws, 'commit-tree', tree, '-p', git(ws, 'rev-parse', upstream), '-m', message);
  git(ws, 'reset', '--quiet', '--hard', commit);
  return true;
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

  /** The files under `dir` that the card's branch adds, against the branch it lands on. */
  addedFiles(cardId: string, dir: string): string[] {
    const ws = this.leasedBy(cardId);
    if (!ws) return [];
    try {
      const base = defaultBranch(this.o.mode === 'worktrees' ? this.o.repoPath : ws);
      const upstream = this.o.mode === 'worktrees' ? base : `origin/${base}`;
      return git(ws, 'diff', '--name-only', '--diff-filter=A', `${upstream}...HEAD`, '--', dir).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Lands the card's committed branch on the Obeya checkout's default branch by rebasing (or,
   * when only the replay conflicts, squashing) and fast-forwarding. The workspace stays with the
   * card, so its worker can finish what remains; `removeLanded` frees it. Returns what went wrong
   * (`worker` problems are the worker's to fix, the others stop at the Obeya checkout), or how
   * the default branch moved.
   */
  landOnMain(cardId: string, branch: string): LandProblem | Landed {
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
        // replayed one by one, the commits may conflict where the change as a whole does not
        if (!squashOnto(ws, upstream)) {
          return {
            code: 'landConflict',
            worker: true,
            files,
            detail: `rebase onto ${base} failed${files.length ? `; conflicts in ${files.join(', ')}` : ''}: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      if (git(ws, 'rev-list', '--count', `${upstream}..HEAD`) === '0') return { code: 'landEmpty', worker: true, detail: 'the branch has no commits' };
      if (git(this.o.repoPath, 'branch', '--show-current') !== base) return { code: 'landCheckout', worker: false, detail: `the Obeya checkout is not on ${base}` };
    } catch (e) {
      return { code: 'land', worker: false, detail: e instanceof Error ? e.message : String(e) };
    }
    try {
      const from = git(this.o.repoPath, 'rev-parse', 'HEAD');
      if (this.o.mode === 'worktrees') git(this.o.repoPath, 'merge', '--ff-only', '--quiet', branch);
      else {
        git(this.o.repoPath, 'fetch', '--quiet', ws, branch);
        git(this.o.repoPath, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD');
      }
      return { from, to: git(this.o.repoPath, 'rev-parse', 'HEAD') };
    } catch (e) {
      // typically local changes in the Obeya checkout that the fast-forward would overwrite
      return { code: 'landMerge', worker: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Frees the workspace of work that has landed, once its worker is done: a worktree and its
   * branch are removed (a branch with commits that never landed stays), a clone is free again.
   */
  removeLanded(cardId: string, branch: string) {
    const ws = this.leasedBy(cardId);
    if (!ws) return;
    if (this.o.mode === 'clones') return this.release(cardId);
    this.store.removeWorkspace(ws);
    if (existsSync(ws)) git(this.o.repoPath, 'worktree', 'remove', '--force', ws);
    try {
      if (git(this.o.repoPath, 'branch', '--list', branch)) git(this.o.repoPath, 'branch', '--quiet', '-d', branch);
    } catch (e) {
      console.error(`keeping branch ${branch}:`, e instanceof Error ? e.message : e);
    }
  }

  /**
   * Throws the card's work away: a prototype never lands. A worktree and its branch are
   * removed; a clone goes back to its default branch, without the card's branch, and is free again.
   */
  discard(cardId: string, branch: string) {
    const ws = this.leasedBy(cardId);
    if (!ws) return;
    if (this.o.mode === 'worktrees') {
      this.store.removeWorkspace(ws);
      if (existsSync(ws)) git(this.o.repoPath, 'worktree', 'remove', '--force', ws);
      if (git(this.o.repoPath, 'branch', '--list', branch)) git(this.o.repoPath, 'branch', '--quiet', '-D', branch);
      return;
    }
    if (existsSync(ws)) {
      git(ws, 'reset', '--quiet', '--hard');
      git(ws, 'clean', '--quiet', '-fd');
      git(ws, 'checkout', '--quiet', '--detach', `origin/${defaultBranch(ws)}`);
      if (git(ws, 'branch', '--list', branch)) git(ws, 'branch', '--quiet', '-D', branch);
    }
    this.release(cardId);
  }

  /**
   * Hands card `from`'s workspace and branch to card `to`, which goes on with the work there (an
   * idea built on its prototype). The branch is renamed to `rename` when that name is free; the
   * worktree keeps its directory. Returns the workspace and the branch as they are now.
   */
  transfer(from: string, to: string, branch: string, rename?: string): { path: string; branch: string } {
    const path = this.leasedBy(from);
    if (!path) throw new WorkspaceError('the card has no workspace', 'noWorkspace');
    if (this.leasedBy(to)) throw new WorkspaceError('the card it goes to has a workspace of its own');
    // in a worktree the branch lives in the Obeya checkout, in a clone in the clone
    const repo = this.o.mode === 'worktrees' ? this.o.repoPath : path;
    let now = branch;
    if (rename && rename !== branch && !git(repo, 'branch', '--list', rename)) {
      git(repo, 'branch', '-m', branch, rename);
      now = rename;
    }
    this.store.setLease(path, to);
    return { path, branch: now };
  }

  /**
   * What the card's branch changes so far, committed or not: each file relative to the repository
   * root, with the changed line ranges and git's function context, so a judge can tell whether two
   * cards edit the same place. A new file has no ranges.
   */
  changes(cardId: string): Change[] {
    const ws = this.leasedBy(cardId);
    if (!ws || !existsSync(ws)) return [];
    try {
      const base = this.o.mode === 'worktrees' ? defaultBranch(this.o.repoPath) : `origin/${defaultBranch(ws)}`;
      const diff = git(ws, 'diff', '-U0', '--no-color', '--no-ext-diff', git(ws, 'merge-base', 'HEAD', base));
      const untracked = git(ws, 'ls-files', '--others', '--exclude-standard');
      return [...parseChanges(diff), ...untracked.split('\n').filter(Boolean).map((file) => ({ file, regions: [] }))];
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
export interface Change {
  file: string;
  /** Changed ranges in the new file, as git's hunk header has them: "120-134 in function decide". */
  regions: string[];
}

/** Files and their hunks from a `git diff -U0`. */
export function parseChanges(diff: string): Change[] {
  const out: Change[] = [];
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      out.push({ file: '', regions: [] });
      header = true;
      continue;
    }
    const cur = out.at(-1);
    if (!cur) continue;
    // the file names come before the first hunk; later lines like these are content
    if (header && line.startsWith('--- a/')) cur.file = line.slice(6);
    else if (header && line.startsWith('+++ b/')) cur.file = line.slice(6);
    else if (header && line === '+++ /dev/null') cur.regions.push('deleted');
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (!hunk) continue;
    header = false;
    if (cur.regions[0] === 'deleted') continue;
    const start = Number(hunk[1]);
    const n = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const at = n === 0 ? `${start} (lines removed)` : n === 1 ? `${start}` : `${start}-${start + n - 1}`;
    cur.regions.push(hunk[3] ? `${at} in ${hunk[3].trim()}` : at);
  }
  return out.filter((c) => c.file);
}

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
