// Where a card's worker works, and how approved work lands.
//
// `clones`: a pool of full clones per canvas, leased one card at a time (for repositories with tools
// that break in worktrees, or one app per clone), here and on other machines; a new card
// takes a clone on the first machine whose busy workers leave it a slot (design: Hosts). `worktrees`: one worktree of the Obeya checkout per card,
// created on start, as many in parallel as there are cards unless the repository has slots; kept
// across stop and restart until the card's work has landed.

import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type CardDiff, cardDiff } from '../core/diff';
import type { PoolHost, WorkspaceShortage } from '../core/types';
import type { Store } from './db';
import { HostError, hostName, LOST, onHost, remote, sh as shWord, type SshHost, TOKEN_HELPER, TOKEN_HELPER_ARGS } from './hosts';
import { runAppCommand } from './app-command';
import { messageOf } from '../core/text';
import { oneAtATime } from '../core/one-at-a-time';
import { demoFile } from './demo-page';
import { sameRemote } from './repo';
import { spawnOutput } from './spawn';

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: 'noWorkspace' | 'dirtyWorkspaces' | 'noSlot' | 'workspace' = 'workspace',
  ) {
    super(message);
  }
}

export interface LandProblem {
  code: 'landDirty' | 'landConflict' | 'landEmpty' | 'landCheckout' | 'landMerge' | 'landPush' | 'land';
  /** Whether the worker can fix it in its workspace; otherwise it is the owner's (the Obeya checkout, a push turned away). */
  worker: boolean;
  detail: string;
  files?: string[];
}

/** Work that landed: the default branch (of the Obeya checkout, or of `origin` when pushed) moved from `from` to `to`. */
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

/** The host of a workspace on another machine, as `remote` finds it; a host gone from the configuration is a workspace error. */
function remoteWorkspace(path: string) {
  try {
    return remote(path);
  } catch (e) {
    throw new WorkspaceError(messageOf(e));
  }
}

/** `git` in `cwd`, which may be a workspace on another machine (`ssh://<host>/…`, see `hosts.ts`). */
export function git(cwd: string, ...args: string[]): string {
  const there = remoteWorkspace(cwd);
  if (there) {
    const r = there.host.runSync(['git', ...TOKEN_HELPER_ARGS, '-C', there.path, ...args], there.path);
    if (r.code !== 0) throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
    return r.stdout.trim();
  }
  const r = Bun.spawnSync([GIT, '-C', cwd, ...args], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** `git` in `cwd`, or null where it fails (no repository there, a ref that does not exist). */
export function gitOrNull(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

/** Whether a workspace may be there, without asking its host: for one on another machine, the git call that follows finds out. */
function mayExist(path: string): boolean {
  try {
    return !!remote(path) || existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Whether a workspace's directory exists, here or on its host (where an unreachable host counts as
 * no); without blocking the server, since for a workspace on another machine it asks over SSH.
 */
async function existsAsync(path: string): Promise<boolean> {
  const there = remoteWorkspace(path);
  return there ? (await there.host.run(['test', '-e', there.path])).code === 0 : existsSync(path);
}

/**
 * `git` without blocking the server while it runs: landing approved work fetches, rebases and
 * pushes, over the network seconds in which the server would answer nothing else.
 */
export async function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitRun(cwd, args);
  if (r.code !== 0) throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
  return r.stdout.trim();
}

/** `git` in `cwd` without blocking, with its exit code: for commands whose exit code is an answer (`diff --no-index`). */
async function gitRun(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const there = remoteWorkspace(cwd);
  if (there) return there.host.run(['git', ...TOKEN_HELPER_ARGS, '-C', there.path, ...args], { cwd: there.path });
  return spawnOutput([GIT, '-C', cwd, ...args]);
}

/** `git diff` as Obeya shows it to the owner: plain, with renames found and file names unquoted. */
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M'];

/** How many new files not yet added a branch's diff shows; a worker's stray build output should not flood it. */
const NEW_FILES_SHOWN = 200;

/** How many of a branch's changed files the Koordinator learns the changed lines of (`changes`). */
const CHANGES_LISTED = 200;

/**
 * The first `CHANGES_LISTED` of `files` as git pathspecs, as many as fit on a command line: Windows
 * takes about 32,000 characters, which 200 long paths exceed.
 */
function listed(files: string[]): string[] {
  const out: string[] = [];
  let length = 0;
  for (const f of files.slice(0, CHANGES_LISTED)) {
    length += f.length + 12;
    if (length > 24_000) break;
    out.push(`:(literal)${f}`);
  }
  return out;
}

/** The whole diff from `base` to `to` (a commit; the working tree when left out), as `git diff` has it. */
export function gitDiff(cwd: string, base: string, to?: string): Promise<string> {
  return gitAsync(cwd, ...DIFF, base, ...(to ? [to] : []));
}

/** The landing under way per Obeya checkout: landings of one repository run one after the other. */
const landings = new Map<string, Promise<unknown>>();

/**
 * Puts the branch's whole change onto `upstream` as one commit, if it merges cleanly there; the
 * commits' messages are kept in order, their trailers once at the end. Returns whether it did.
 */
async function squashOnto(ws: string, upstream: string): Promise<boolean> {
  let tree: string;
  try {
    // exits non-zero on a conflict
    tree = (await gitAsync(ws, 'merge-tree', '--write-tree', upstream, 'HEAD')).split('\n')[0]!;
  } catch {
    return false;
  }
  const trailers: string[] = [];
  const bodies = (await gitAsync(ws, 'log', '--reverse', '--format=%B%x00', `${upstream}..HEAD`))
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
  const commit = await gitAsync(ws, 'commit-tree', tree, '-p', await gitAsync(ws, 'rev-parse', upstream), '-m', message);
  await gitAsync(ws, 'reset', '--quiet', '--hard', commit);
  return true;
}

/**
 * Rebases the workspace's branch onto `upstream`, or squashes it there when only the replay of its
 * commits conflicts. Returns the conflict if neither works, the branch then as it was.
 */
async function rebaseOnto(ws: string, upstream: string, base: string): Promise<LandProblem | null> {
  try {
    await gitAsync(ws, 'rebase', '--quiet', upstream);
    return null;
  } catch (e) {
    const files = (await gitAsync(ws, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    await gitAsync(ws, 'rebase', '--abort');
    // replayed one by one, the commits may conflict where the change as a whole does not
    if (await squashOnto(ws, upstream)) return null;
    return {
      code: 'landConflict',
      worker: true,
      files,
      detail: `rebase onto ${base} failed${files.length ? `; conflicts in ${files.join(', ')}` : ''}: ${messageOf(e)}`,
    };
  }
}

/**
 * Brings the workspace's committed branch onto `upstream` (`base`, or `origin`'s copy of it, fetched
 * first) as `rebaseOnto` does: what stands in the way of landing it, or null once it is ready.
 */
async function rebased(ws: string, base: string, upstream: string): Promise<LandProblem | null> {
  if (await gitAsync(ws, 'status', '--porcelain')) return { code: 'landDirty', worker: true, detail: 'uncommitted changes in the workspace' };
  if (upstream !== base) await gitAsync(ws, 'fetch', '--quiet', 'origin');
  const conflict = await rebaseOnto(ws, upstream, base);
  if (conflict) return conflict;
  if ((await gitAsync(ws, 'rev-list', '--count', `${upstream}..HEAD`)) === '0') return { code: 'landEmpty', worker: true, detail: 'the branch has no commits' };
  return null;
}

/**
 * Adds `trailer` (`Demo-Video: <url>`) to the message of the workspace's last commit, the one that
 * lands, unless it has it already (a landing tried before). A commit that cannot be amended lands
 * without it.
 */
async function withTrailer(ws: string, trailer: string | undefined) {
  if (!trailer) return;
  const message = await gitAsync(ws, 'log', '-1', '--format=%B');
  if (message.split('\n').includes(trailer)) return;
  // the worker's commit as it was, its author kept; its hooks ran when it was made
  try {
    await gitAsync(ws, 'commit', '--amend', '--quiet', '--no-verify', '--allow-empty', '--cleanup=verbatim', '-m', addTrailer(message, trailer));
  } catch (e) {
    // the link is a convenience: the work lands without it
    console.error(`landing without ${trailer}:`, messageOf(e));
  }
}

/** The commit message with `trailer` in its trailers: beside those it ends with (`Co-Authored-By: …`), else in a paragraph of its own. */
export function addTrailer(message: string, trailer: string): string {
  const text = message.trimEnd();
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs.at(-1)!.split('\n');
  const trailers = paragraphs.length > 1 && last.every((l) => /^[\w-]+:/.test(l) || /^\s+\S/.test(l)) && /^[\w-]+:/.test(last[0]!);
  return `${text}${trailers ? '\n' : '\n\n'}${trailer}\n`;
}

/** How long what a look at a free clone found (clean, dirty, not there) stands before it is looked at again. */
export const RECHECK_MS = 60_000;

export interface WorkspaceOptions {
  mode: 'clones' | 'worktrees';
  /** The checkout Obeya runs on. */
  repoPath: string;
  /** Where worktrees and created clones go. */
  dir: string;
  /** The repository on the canvas these workspaces belong to; null is its home repository. */
  repo?: string | null;
  /**
   * The machines its clones are on, in the order a new card looks for room (`host` null: this one),
   * each with how many of the repository's workers may be busy there at once (none: as many as
   * there are clones). Without it, this machine alone.
   */
  machines?: { host: string | null; slots?: number }[];
  /** How many of the repository's workers are in a turn on a machine now (null: this one). */
  busy?: (host: string | null) => number;
  /** The repository's command that stops its app (`app.stop`), run in a clone of Obeya's own before its folder goes. */
  stop?: string;
  /** What its clones are clones of (its remote, its checkout): a folder whose `origin` is none of them is not one of its clones, and stays. */
  origins?: string[];
  /** Called when what the pool shows changes outside a card's lease: a clone's folder kept or gone. */
  changed?: () => void;
}

/**
 * The folders of Obeya's own clones that left the pool and stay on disk since something in them
 * would be lost, by path (`ssh://<host>/…` on a host): what lies in them. Kept across a
 * repository's restarts, which make its `Workspaces` afresh; looked at again at each start.
 */
const kept = new Map<string, string>();
/** The clones whose folders are being looked at or removed now, settling once that is through. */
const retiring = new Map<string, Promise<void>>();
/** Clones registered again while their folders were looked at: those stay. */
const claimed = new Set<string>();
/** What runs on a clone's folder now, by path: `ensureHostClones` making it, `clearAway` removing it; each waits for the other. */
const busyPaths = new Map<string, Promise<unknown>>();

/** Runs `fn` once what runs on `path` (`busyPaths`) is through, and keeps others off it meanwhile. */
function onPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = busyPaths.get(path) ?? Promise.resolve();
  const run = before.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  busyPaths.set(path, settled);
  void settled.then(() => busyPaths.get(path) === settled && busyPaths.delete(path));
  return run;
}

/** The name of a clone Obeya makes, its number (`ensureClones`); a card's worktree is named by the card's id, 8 characters. */
const CLONE_NAME = /^\d{1,4}$/;
/** The name of a clone's folder moved aside to be removed (`clearAway`). */
const TRASH_NAME = /^\d{1,4}\.removing-\d+$/;

/** The path of a workspace on its machine, without `ssh://<host>`. */
const pathThere = (path: string) => {
  const host = hostName(path);
  return host === null ? path : path.slice(`ssh://${host}`.length) || '/';
};

/** The name of the machine Obeya runs on, as the Workspaces pill shows it. */
export const HERE = hostname().split('.')[0] || 'localhost';

/** The code `lease` refuses with for each reason it finds no workspace. */
const SHORT_CODE = { none: 'noWorkspace', dirty: 'dirtyWorkspaces', slots: 'noSlot' } as const;
/** Why `lease` found no workspace, by the code it refused with; none for any other refusal. */
export const shortageOf = (code: string) => (Object.keys(SHORT_CODE) as WorkspaceShortage[]).find((s) => SHORT_CODE[s] === code);
const SHORT_TEXT = { none: 'no workspace registered or all are leased', dirty: 'every free workspace has uncommitted changes', slots: 'every machine with a free workspace has as many busy workers as it has slots' };

/**
 * Where a repository's cards work, as the workers, the Koordinator and the canvas use it: clones or
 * worktrees of a git repository (`Workspaces`), or the folder itself where it has no git
 * (`FolderWorkspaces` in `folder.ts`, which has no branches and lands nothing).
 */
export interface CardWorkspaces {
  readonly mode: 'clones' | 'worktrees' | 'folder';
  readonly dir: string;
  readonly pooled: boolean;
  list(): { path: string; card_id: string | null }[];
  leasedBy(cardId: string): string | null;
  lease(cardId: string, branch: string, o?: { overSlots?: boolean }): Lease;
  leasable(overSlots?: boolean): boolean;
  pool(busy: string[]): PoolHost[];
  hasWork(cardId: string): Promise<boolean>;
  release(cardId: string): void;
  abandon(path: string): Promise<boolean>;
  retake(cardId: string, path: string): boolean;
  forkPoint(cardId: string): Promise<{ ws: string; base: string } | null>;
  addedFiles(cardId: string, dir: string): Promise<string[]>;
  landOnMain(cardId: string, branch: string, trailer?: string): Promise<LandProblem | Landed>;
  pushToMain(cardId: string, trailer?: string): Promise<LandProblem | Landed>;
  removeLanded(cardId: string, branch: string): Promise<void>;
  discard(cardId: string, branch: string): Promise<void>;
  transfer(from: string, to: string, branch: string, rename?: string): Promise<{ path: string; branch: string }>;
  followUpTree(cardId: string, branch: string): Lease;
  removeFollowUpTree(path: string): Promise<void>;
  changes(cardId: string): Promise<Change[]>;
  diff(cardId: string, full: boolean): Promise<CardDiff | null>;
  landedDiff(base: string, commit: string, full: boolean): Promise<CardDiff | null>;
  fileOf(cardId: string, path: string, ref?: string, local?: boolean): Promise<FileAt | null>;
  changedFiles(cardId: string, landed?: { base: string; commit: string }): Promise<string[]>;
}

/**
 * A workspace given to a card: where it is, taken at once, and git making it ready there (a worktree
 * added, a clone fetched and on the card's branch), which runs without blocking the server; null
 * when it is ready already. `ready` settles with where the workspace is: another clone than `path`
 * where that one turned out to have uncommitted changes. A failure rejects, the workspace then given
 * back; with a `WorkspaceError` whose code `shortageOf` knows where no clean clone was left.
 */
export interface Lease {
  path: string;
  ready: Promise<string> | null;
}

/** A file of a card's work: where it lies on this machine, or what it holds (read from a commit). */
export type FileAt = { path: string } | { data: Uint8Array<ArrayBuffer> };

/**
 * The file at `path` in `root` itself, null where it is a link (or lies in a linked directory): a
 * link the card made could otherwise stand for any file of the root it did not change.
 */
export function ownFile(root: string, path: string): FileAt | null {
  const at = demoFile(root, path);
  try {
    return at && at === join(realpathSync(root), path) ? { path: at } : null;
  } catch {
    return null;
  }
}

export class Workspaces implements CardWorkspaces {
  /**
   * What the last look at each free clone found (`look`), and when: whether it is clean, has
   * uncommitted changes, or is not there (its machine unreachable, say). `place` chooses by it
   * without asking git; the clone chosen is looked at again before a card works in it.
   */
  private looks = new Map<string, { found: Found; at: number }>();
  /** The looks at free clones under way, by path. */
  private looking = new Map<string, Promise<Found>>();
  /** Clones the configuration no longer names that a card still holds: they leave the pool once it gives them back (`keepOnly`). */
  private leaving = new Set<string>();
  /** The directory Obeya makes its clones in on each host, once it has made sure they are there (`ensureHostClones`). */
  private hostDirs = new Map<string, string>();
  /** The workspaces git is making ready, by the card they are leased to (`Lease.ready`). */
  private preparing = new Map<string, Promise<string>>();
  /** Cards that gave back their workspace while git was still making it ready: it is free once git is done. */
  private releasing = new Set<string>();
  /** Free clones git failed to make ready for a card, and when: not taken again before RECHECK_MS (a fetch that fails would fail again at once). */
  private failed = new Map<string, number>();
  /** Follow-ups' temporary worktrees git is adding, by path: removing one waits for it. */
  private trees = new Map<string, Promise<void>>();
  /**
   * What git does now to a card's workspace as it is freed, discarded or handed over, by path
   * (`clearing`): in the background, one after the other on the same workspace.
   */
  private clears = new Map<string, Promise<unknown>>();

  constructor(
    private store: Store,
    private canvasId: string,
    private o: WorkspaceOptions,
  ) {}

  get mode(): 'clones' | 'worktrees' {
    return this.o.mode;
  }

  /** The directory its clones or worktrees are made in (and follow-ups' temporary worktrees). */
  get dir() {
    return this.o.dir;
  }

  /** Registers a clone; with `origins`, only when its `origin` is one of them (or it is the repository itself). */
  register(path: string, origins?: string[]) {
    git(path, 'rev-parse', '--git-dir');
    if (origins?.length && resolve(path) !== resolve(this.o.repoPath)) {
      let origin = '';
      try {
        origin = git(path, 'remote', 'get-url', 'origin');
      } catch {}
      if (!origins.some((o) => sameRemote(o, origin))) throw new WorkspaceError(`${path} is not a clone of ${origins.join(' or ')} (its origin is ${origin || 'unset'})`);
    }
    this.store.addWorkspace(this.canvasId, path, this.o.repo ?? null);
    if (retiring.has(path)) claimed.add(path);
    // a folder that stayed is back in the pool
    if (kept.delete(path)) this.o.changed?.();
  }

  /** Makes sure `n` clones of `source` exist and are registered; returns their paths. */
  ensureClones(source: string, n: number): string[] {
    mkdirSync(this.o.dir, { recursive: true });
    const paths: string[] = [];
    for (let i = 1; i <= n; i++) {
      const path = join(this.o.dir, String(i));
      if (!existsSync(path)) git(this.o.dir, 'clone', '--quiet', source, path);
      this.register(path);
      paths.push(path);
    }
    return paths;
  }

  /**
   * Takes the clones on `host` (null: this machine) that are not among `named` out of the pool: the
   * configuration no longer names them (fewer clones to create, an existing one or a host taken out,
   * the repository gone over to worktrees). A free one leaves at once; one a card holds stays with
   * it and leaves once the card gives it back. A clone Obeya made goes from disk as it leaves where
   * nothing would be lost (`retire`); one the owner listed stays as it is. A workspace here whose
   * folder is gone leaves at once, clone or worktree, held or not (a card's own worktree aside, which
   * is no pool's): returns the cards that lost theirs that way, which take another at their next start.
   */
  keepOnly(host: string | null, named: string[]): { card: string; path: string }[] {
    const lost: { card: string; path: string }[] = [];
    for (const w of this.list()) {
      if (hostName(w.path) !== host || named.includes(w.path)) continue;
      if (this.gone(w.path, w.card_id)) {
        this.store.removeWorkspace(w.path);
        this.leaving.delete(w.path);
        if (w.card_id) lost.push({ card: w.card_id, path: w.path });
        continue;
      }
      if (!this.isClone(w.path)) continue;
      if (w.card_id) this.leaving.add(w.path);
      else {
        this.store.removeWorkspace(w.path);
        this.retire(w.path);
      }
    }
    for (const path of this.leaving) if (named.includes(path)) this.leaving.delete(path);
    return lost;
  }

  /**
   * Whether the folder of a workspace on this machine is gone (moved or deleted by hand), so that no
   * card can work in it again. A card's worktree where this repository makes them, and one git is
   * still making ready, are the card's to make.
   */
  private gone(path: string, card: string | null): boolean {
    if (hostName(path) !== null || existsSync(path)) return false;
    if (card && this.preparing.has(card)) return false;
    return !(this.o.mode === 'worktrees' && card && path === join(this.o.dir, card.slice(0, 8)));
  }

  /**
   * Looks again at the folders of Obeya's own clones on this machine that are not in the pool (left
   * it earlier, their folders kept since something in them would have been lost): those that lose
   * nothing now go.
   */
  sweep() {
    let names: string[] = [];
    try {
      names = readdirSync(this.o.dir);
    } catch {}
    const pool = new Set(this.list().map((w) => w.path));
    for (const name of names) {
      if (CLONE_NAME.test(name) && !pool.has(join(this.o.dir, name))) this.retire(join(this.o.dir, name));
      // one whose removal a stop of Obeya cut off
      if (TRASH_NAME.test(name) && !this.store.hasWorkspace(join(this.o.dir, name))) void rm(join(this.o.dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Whether a workspace is a clone rather than a card's worktree: on a host, or with a repository of its own. */
  private isClone(path: string): boolean {
    if (hostName(path) !== null) return true;
    try {
      return statSync(join(path, '.git')).isDirectory();
    } catch {
      return this.made(path);
    }
  }

  /** Whether a clone is one Obeya made in its own directory (on a host, in the one it makes them in there), not one the owner listed. */
  private made(path: string): boolean {
    const host = hostName(path);
    const dir = host === null ? this.o.dir : this.hostDirs.get(host);
    const there = pathThere(path);
    return !!dir && dirname(there) === dir && CLONE_NAME.test(basename(there));
  }

  /** Whether a workspace is a clone: this repository's mode, or a clone a card still holds after the repository went over to worktrees. */
  private cloned(ws: string): boolean {
    return this.o.mode === 'clones' || this.leaving.has(ws);
  }

  /**
   * A clone that left the pool: one Obeya made goes from disk, its app stopped first, unless
   * something in it would be lost (`unlanded`); then it stays, the log says once what lies in it,
   * and the pool shows it (`kept`) until a later start finds it can go. A host that does not
   * answer is asked again at the next start. One the owner listed is never touched.
   */
  private retire(path: string) {
    if (!this.made(path) || retiring.has(path) || this.store.hasWorkspace(path)) return;
    claimed.delete(path);
    retiring.set(
      path,
      onPath(path, () => this.clearAway(path))
        .catch((e) => console.error(`clone ${path}: ${messageOf(e)}`))
        .finally(() => {
          retiring.delete(path);
          claimed.delete(path);
        }),
    );
  }

  private async clearAway(path: string) {
    // registered again, on any canvas, while it was looked at: it is a workspace again
    const taken = () => claimed.has(path) || this.store.hasWorkspace(path);
    const o = { origins: this.o.origins ?? [], main: branchSetting(this.o.repoPath) || undefined };
    // what the stop command leaves behind (a snapshot it writes, say) counts too: looked at again after it
    for (const after of [false, true]) {
      const lost = await unlanded(path, o);
      // the host does not answer, origin cannot be asked, or it is not a clone of the repository: next time
      if (lost === null || taken()) return;
      if (lost === 'gone') {
        if (kept.delete(path)) this.o.changed?.();
        return;
      }
      if (lost.length) {
        const what = lost.join('; ');
        if (kept.get(path) !== what) {
          console.log(`clone ${path} left the pool and stays on disk: ${what}`);
          kept.set(path, what);
          this.o.changed?.();
        }
        return;
      }
      if (after || !this.o.stop) break;
      const stopped = await runAppCommand(path, this.o.stop);
      if (!stopped.ok) console.error(`clone ${path}: ${this.o.stop} failed: ${stopped.output}`);
      if (taken()) return;
    }
    // moved aside before it goes: once moved, nothing registers or leases the folder (here at once, on a host
    // `ensureHostClones` waits for it), and making the clone again makes a fresh one
    const trash = `${pathThere(path)}.removing-${Date.now()}`;
    const there = remote(path);
    if (there) {
      const r = await there.host.run(`mv ${shWord(there.path)} ${shWord(trash)} && rm -rf ${shWord(trash)}`);
      if (r.code !== 0) return console.error(`clone ${path}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
    } else {
      if (taken()) return;
      renameSync(path, trash);
      await rm(trash, { recursive: true, force: true });
    }
    console.log(`clone ${path} left the pool; its folder is removed`);
    kept.delete(path);
    this.o.changed?.();
  }

  /**
   * Makes sure `n` clones of `source` (the repository's remote) exist under `root` on `host` and
   * are registered (`ssh://<host>/<root>/<i>`), each with git's login through `GH_TOKEN`. Runs in
   * the background, so that an unreachable host does not hold up the start; a clone is leased only
   * once it is registered. `token` is the repository's GitHub login. Settles with what went wrong, if anything.
   */
  async ensureHostClones(host: SshHost, root: string, source: string, n: number, token: () => string | undefined): Promise<string | null> {
    try {
      const dir = await host.resolveDir(root);
      this.hostDirs.set(host.name, dir);
      host.tokenFor(dir, token);
      for (let i = 1; i <= n; i++) {
        const path = `${dir}/${i}`;
        // a folder being removed is made afresh once it is gone; one being made is not removed meanwhile
        await onPath(onHost(host.name, path), async () => {
          if ((await host.run(['test', '-d', `${path}/.git`])).code !== 0) {
            const r = await host.run(['git', ...TOKEN_HELPER_ARGS, 'clone', '--quiet', source, path], { cwd: dir });
            if (r.code !== 0) throw new HostError(`cloning ${source} on ${host.name}: ${(r.stderr || r.stdout).trim()}`);
          }
          // the worker's own push and gh go through the same login
          const helper = `git config --unset-all credential.helper; ${TOKEN_HELPER.map((h) => `git config --add credential.helper ${shWord(h)}`).join(' && ')}`;
          const c = await host.run(helper, { cwd: path });
          if (c.code !== 0) throw new HostError(`${host.name}: ${c.stderr.trim()}`);
          await host.trust(path);
          this.store.addWorkspace(this.canvasId, onHost(host.name, path), this.o.repo ?? null);
          kept.delete(onHost(host.name, path));
        });
      }
      // those of fewer clones there, or under another directory, leave the pool
      const named = Array.from({ length: n }, (_, i) => onHost(host.name, `${dir}/${i + 1}`));
      this.keepOnly(host.name, named);
      // and the folders of those that left it earlier go once nothing in them would be lost
      const ls = await host.run(['ls', '-1', dir]);
      if (ls.code === 0)
        for (const name of ls.stdout.split('\n')) {
          const path = onHost(host.name, `${dir}/${name}`);
          if (CLONE_NAME.test(name) && !named.includes(path) && !this.list().some((w) => w.path === path)) this.retire(path);
        }
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }

  list() {
    return this.store.workspaces(this.canvasId, this.o.repo ?? null);
  }

  leasedBy(cardId: string): string | null {
    return this.list().find((w) => w.card_id === cardId)?.path ?? null;
  }

  /**
   * Gives the card a workspace on `branch` and returns its path. A clone comes from the first
   * machine with a free slot, a worktree only while this machine has one; `overSlots` takes one on
   * a busy machine when none has a slot (an owner's question to a finished card, which should not wait).
   */
  lease(cardId: string, branch: string, o: { overSlots?: boolean } = {}): Lease {
    const own = this.leasedBy(cardId);
    // a worktree git is removing (its card deleted and brought back meanwhile) is added again once git is done
    if (own && !this.cloned(own) && this.clears.has(own)) return this.leaseWorktree(cardId, branch);
    if (own) {
      // given back while git was making it ready, and taken again before git was done: it stays the card's
      this.releasing.delete(cardId);
      return { path: own, ready: this.preparing.get(cardId) ?? null };
    }
    if (this.o.mode === 'clones') return this.leaseClone(cardId, branch, !!o.overSlots);
    if (!o.overSlots && !this.room(null)) throw new WorkspaceError(SHORT_TEXT.slots, SHORT_CODE.slots);
    return this.leaseWorktree(cardId, branch);
  }

  /**
   * The workspace at `path`, leased to the card already, as git makes it ready with `make`, which
   * settles with where it is then: in the background, the lease holding it meanwhile, so that no
   * other card takes it. Where git fails, `undo` gives back the workspace the card holds then.
   */
  private prepare(cardId: string, path: string, make: () => Promise<string>, undo: (at: string, e: WorkspaceError) => void): Lease {
    const ready = make().then(
      (at) => {
        this.preparing.delete(cardId);
        if (this.releasing.delete(cardId)) this.release(cardId);
        return at;
      },
      (e: unknown) => {
        this.preparing.delete(cardId);
        this.releasing.delete(cardId);
        const error = e instanceof WorkspaceError ? e : new WorkspaceError(messageOf(e));
        const at = this.leasedBy(cardId);
        if (at) undo(at, error);
        throw error;
      },
    );
    this.preparing.set(cardId, ready);
    return { path, ready };
  }

  /** Whether its pool is worth showing: clones, or worktrees capped by slots. */
  get pooled(): boolean {
    return this.o.mode === 'clones' || Number.isFinite(this.slots(null));
  }

  /**
   * Whether `lease` would find a workspace for a new card now. A worktree can always be made, while
   * there is a slot for its worker; a clone must be free and clean, on a machine with a free slot.
   * Cards waiting for one ask on every change of the board: it answers from the last looks at the
   * free clones (`place`), and a look that finds one clean now changes the board.
   * `overSlots`: whether `lease` with it would.
   */
  leasable(overSlots = false): boolean {
    if (this.o.mode === 'worktrees') return overSlots || this.room(null);
    return 'path' in this.place(overSlots);
  }

  /** The machines in the order a new card looks for room; a machine whose clones are registered but no longer configured comes last. */
  private machines(): (string | null)[] {
    const order = (this.o.machines ?? [{ host: null }]).map((m) => m.host);
    for (const w of this.list()) {
      const h = hostName(w.path);
      if (!order.includes(h)) order.push(h);
    }
    return order;
  }

  /** How many of the repository's workers may be busy on a machine at once; Infinity when its clones are the only cap. */
  private slots(host: string | null): number {
    const m = this.o.machines?.find((x) => x.host === host);
    if (!m) return this.o.machines ? 0 : Infinity;
    return m.slots ?? Infinity;
  }

  /** Whether a machine has a slot for one more busy worker. */
  private room(host: string | null): boolean {
    return (this.o.busy?.(host) ?? 0) < this.slots(host);
  }

  /**
   * The clean free clone a new card takes: on the first machine with a slot, else with `overSlots`
   * on the first busy one; or why there is none. It asks no git, which in a large repository or
   * over SSH takes a while: it goes by the last looks at the free clones (`looks`), one found clean
   * before one not looked at yet, and looks again in the background at those whose look is older
   * than RECHECK_MS or that were never looked at, a look that changes the answer changing the board.
   */
  private place(overSlots: boolean): { path: string } | { short: WorkspaceShortage } {
    const free = this.list().filter((w) => !w.card_id);
    if (!free.length) return { short: 'none' };
    const machines = this.machines();
    const roomy = machines.filter((m) => this.room(m));
    let full = false;
    let dirty = false;
    let found: string | null = null;
    for (const host of overSlots ? [...roomy, ...machines.filter((m) => !roomy.includes(m))] : machines) {
      const here = free.filter((w) => hostName(w.path) === host);
      if (!here.length) continue;
      if (!overSlots && !roomy.includes(host)) {
        full = true;
        continue;
      }
      let unknown: string | null = null;
      for (const w of here) {
        const look = this.looks.get(w.path);
        if (!look || Date.now() - look.at >= RECHECK_MS) void this.look(w.path);
        // an unreachable machine's clones count as missing, not as dirty, and so do those git just failed on
        if (Date.now() - (this.failed.get(w.path) ?? -Infinity) < RECHECK_MS || look?.found === 'missing') continue;
        if (look?.found === 'dirty') dirty = true;
        else if (look?.found === 'clean') {
          found ??= w.path;
          break;
        } else unknown ??= w.path;
      }
      found ??= unknown;
      if (found) break;
    }
    if (found) return { path: found };
    return { short: full ? 'slots' : dirty ? 'dirty' : 'none' };
  }

  /**
   * Looks at a free clone without blocking the server: whether it is clean, has uncommitted
   * changes, or is not there. Looks at one clone under way at once are one. A look that finds
   * otherwise than the one before changes the board: a card waiting for a clean clone may take it now.
   */
  private look(path: string): Promise<Found> {
    let looking = this.looking.get(path);
    if (looking) return looking;
    looking = cloneState(path).then((found) => {
      this.looking.delete(path);
      const before = this.looks.get(path)?.found;
      // taken meanwhile: the card it went to looks again before it works in it
      if (!this.list().some((w) => w.path === path && !w.card_id)) return found;
      this.looks.set(path, { found, at: Date.now() });
      if (before !== found) this.o.changed?.();
      return found;
    });
    this.looking.set(path, looking);
    return looking;
  }

  /**
   * The pool by machine for the Workspaces pill, `busy` the cards whose worker is in a turn. Worktrees
   * are never short, so their pool is this machine's slots, each taken while a worker is at work.
   * `kept`: the folders of clones Obeya made that left the pool and stay since something in them would be lost.
   */
  pool(busy: string[]): PoolHost[] {
    const all = this.list();
    const keptOn = (host: string | null) => {
      const paths = [...kept.keys()].filter((p) => hostName(p) === host && this.made(p)).map(pathThere);
      return paths.length ? { kept: paths } : {};
    };
    if (this.o.mode === 'worktrees') {
      const slots = this.slots(null);
      const cards = all.flatMap((w) => (w.card_id && busy.includes(w.card_id) ? [w.card_id] : []));
      return [{ name: HERE, here: true, worktrees: true, slots, total: slots, cards, busy: cards, ...keptOn(null) }];
    }
    return this.machines().map((host) => {
      const ws = all.filter((w) => hostName(w.path) === host);
      const cards = ws.flatMap((w) => (w.card_id ? [w.card_id] : []));
      const slots = this.slots(host);
      return {
        name: host ?? HERE,
        ...(host === null ? { here: true } : {}),
        slots: Number.isFinite(slots) ? slots : ws.length,
        total: ws.length,
        cards,
        busy: cards.filter((c) => busy.includes(c)),
        ...keptOn(host),
      };
    });
  }

  /**
   * Whether the card's workspace holds work: uncommitted changes or commits beyond the base. Asked
   * without blocking the server: `git status` in a large repository, or over SSH, takes a while.
   */
  async hasWork(cardId: string): Promise<boolean> {
    const ws = this.leasedBy(cardId);
    // one git is still making ready holds nothing of the card's yet
    if (!ws || this.preparing.has(cardId)) return false;
    try {
      if (!(await existsAsync(ws))) return false;
      if (await gitAsync(ws, 'status', '--porcelain')) return true;
      return (await gitAsync(ws, 'rev-list', '--count', `${await this.upstreamAsync(ws)}..HEAD`)) !== '0';
    } catch {
      return true;
    }
  }

  /** Frees the workspace for other cards; a worktree stays until the card's work has landed. A clone the configuration no longer names leaves the pool. */
  release(cardId: string) {
    const path = this.leasedBy(cardId);
    if (!path) return;
    if (this.preparing.has(cardId)) {
      this.releasing.add(cardId);
      return;
    }
    this.free(path);
  }

  /** Frees a clone or worktree for other cards; a clone the configuration no longer names leaves the pool, and its folder goes where nothing would be lost. */
  private free(path: string) {
    if (!this.leaving.delete(path)) {
      this.store.setLease(path, null);
      // what the card left in it decides whether the next one takes it
      if (this.cloned(path) && !this.looks.has(path)) void this.look(path);
      return;
    }
    this.store.removeWorkspace(path);
    this.retire(path);
  }

  /**
   * Frees the workspace at `path`, whose card will not work in it again (deleted, done with it, or
   * its workstream done without it), losing nothing: a clone keeps the card's branch and whatever
   * else it holds, and is free for other cards (one with uncommitted changes takes none until it is
   * clean); a clean worktree goes and its branch stays, a worktree with uncommitted changes stays as
   * it is (it takes no slot). Settles with whether it freed it: once git is done with the worktree,
   * and with what else git does to the workspace now (a discarded prototype's clone cleaned), so
   * that no other card takes it half cleaned. One freed meanwhile counts as freed.
   */
  abandon(path: string): Promise<boolean> {
    return this.clearing(path, async () => {
      const by = this.list().find((w) => w.path === path)?.card_id;
      if (!by) return true;
      // one git is still making ready is freed once git is done
      if (this.preparing.has(by)) return false;
      if (this.cloned(path)) {
        this.free(path);
        return true;
      }
      if (existsSync(path)) {
        if ((await gitAsync(path, 'status', '--porcelain').catch(() => null)) !== '') return false;
        if ((await gitAsync(this.o.repoPath, 'worktree', 'remove', path).catch(() => null)) === null) return false;
      }
      this.store.removeWorkspace(path);
      return true;
    });
  }

  /**
   * Runs `fn`, git's work on the workspace at `path` that frees, discards or hands it over, once
   * what git does there already is through: without blocking the server, which in a large
   * repository (a checkout of thousands of files) or over SSH would answer nothing meanwhile.
   */
  private clearing<T>(path: string, fn: () => Promise<T>): Promise<T> {
    return oneAtATime(this.clears, path, fn);
  }

  /** A deleted card restored takes back the clone it had, while that one is still free; a worktree is made again on its branch. */
  retake(cardId: string, path: string): boolean {
    if (this.leasedBy(cardId)) return true;
    if (this.o.mode !== 'clones' || !this.list().some((w) => w.path === path && !w.card_id)) return false;
    this.store.setLease(path, cardId);
    return true;
  }

  /**
   * The card's workspace and the commit its branch left the branch it lands on at, where it has
   * one: what the branch changes is told by comparing its `HEAD` with that commit.
   */
  async forkPoint(cardId: string): Promise<{ ws: string; base: string } | null> {
    const ws = this.leasedBy(cardId);
    if (!ws) return null;
    try {
      return { ws, base: await gitAsync(ws, 'merge-base', 'HEAD', await this.upstreamAsync(ws)) };
    } catch {
      return null;
    }
  }

  /** The files under `dir` that the card's branch adds, against the branch it lands on. */
  async addedFiles(cardId: string, dir: string): Promise<string[]> {
    const ws = this.leasedBy(cardId);
    if (!ws) return [];
    try {
      return (await gitAsync(ws, 'diff', '--name-only', '--diff-filter=A', `${await this.upstreamAsync(ws)}...HEAD`, '--', dir)).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Lands the card's committed branch on the Obeya checkout's default branch by rebasing (or,
   * when only the replay conflicts, squashing) and fast-forwarding. The workspace stays with the
   * card, so its worker can finish what remains; `removeLanded` frees it. Returns what went wrong
   * (`worker` problems are the worker's to fix, the others stop at the Obeya checkout), or how
   * the default branch moved. `trailer` goes into the message of the commit that lands last.
   */
  landOnMain(cardId: string, branch: string, trailer?: string): Promise<LandProblem | Landed> {
    return oneAtATime(landings, this.o.repoPath, () => this.land(cardId, branch, trailer));
  }

  private async land(cardId: string, branch: string, trailer?: string): Promise<LandProblem | Landed> {
    const ws = this.leasedBy(cardId);
    if (!ws) return { code: 'land', worker: false, detail: 'the card has no workspace' };
    try {
      const base = await this.mainAsync(ws);
      const problem = await rebased(ws, base, this.cloned(ws) ? `origin/${base}` : base);
      if (problem) return problem;
      await withTrailer(ws, trailer);
      if ((await gitAsync(this.o.repoPath, 'branch', '--show-current')) !== base) return { code: 'landCheckout', worker: false, detail: `the Obeya checkout is not on ${base}` };
    } catch (e) {
      return { code: 'land', worker: false, detail: messageOf(e) };
    }
    try {
      const from = await gitAsync(this.o.repoPath, 'rev-parse', 'HEAD');
      if (!this.cloned(ws)) await gitAsync(this.o.repoPath, 'merge', '--ff-only', '--quiet', branch);
      else {
        await gitAsync(this.o.repoPath, 'fetch', '--quiet', ws, branch);
        await gitAsync(this.o.repoPath, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD');
      }
      return { from, to: await gitAsync(this.o.repoPath, 'rev-parse', 'HEAD') };
    } catch (e) {
      // typically local changes in the Obeya checkout that the fast-forward would overwrite
      return { code: 'landMerge', worker: false, detail: messageOf(e) };
    }
  }

  /**
   * Lands the card's committed branch on the default branch of `origin` without a pull request:
   * rebased (or squashed) onto it as in `landOnMain`, then pushed there, never forced. When the
   * push is turned away because the default branch moved meanwhile, it fetches, rebases and pushes
   * once more. The Obeya checkout is left as it is; the workspace stays with the card. `trailer`
   * as in `landOnMain`.
   */
  pushToMain(cardId: string, trailer?: string): Promise<LandProblem | Landed> {
    return oneAtATime(landings, this.o.repoPath, () => this.push(cardId, trailer));
  }

  private async push(cardId: string, trailer?: string): Promise<LandProblem | Landed> {
    const ws = this.leasedBy(cardId);
    if (!ws) return { code: 'land', worker: false, detail: 'the card has no workspace' };
    for (let attempt = 0; ; attempt++) {
      let base: string;
      let from: string;
      try {
        base = await this.mainAsync(ws);
        const upstream = `origin/${base}`;
        const problem = await rebased(ws, base, upstream);
        if (problem) return problem;
        await withTrailer(ws, trailer);
        from = await gitAsync(ws, 'rev-parse', upstream);
      } catch (e) {
        return { code: 'landPush', worker: false, detail: messageOf(e) };
      }
      try {
        await gitAsync(ws, 'push', '--quiet', 'origin', `HEAD:refs/heads/${base}`);
        return { from, to: await gitAsync(ws, 'rev-parse', 'HEAD') };
      } catch (e) {
        const detail = messageOf(e);
        // the default branch moved since the fetch, or while pushing; anything else (a protected branch, say) is the owner's
        if (attempt === 0 && /non-fast-forward|fetch first|\[rejected\]|cannot lock ref|failed to update ref/.test(detail)) continue;
        return { code: 'landPush', worker: false, detail };
      }
    }
  }

  /**
   * Frees the workspace of work that has landed, once its worker is done: a worktree and its
   * branch are removed (a branch with commits that never landed stays), a clone is free again.
   * Settles once git is done; the card's worktree made again meanwhile waits for it.
   */
  async removeLanded(cardId: string, branch: string): Promise<void> {
    const ws = this.leasedBy(cardId);
    if (!ws) return;
    if (this.cloned(ws)) return this.release(cardId);
    this.store.removeWorkspace(ws);
    await this.clearing(ws, async () => {
      if (existsSync(ws)) await gitAsync(this.o.repoPath, 'worktree', 'remove', '--force', ws);
      try {
        if (await gitAsync(this.o.repoPath, 'branch', '--list', branch)) await gitAsync(this.o.repoPath, 'branch', '--quiet', '-d', branch);
      } catch (e) {
        console.error(`keeping branch ${branch}:`, messageOf(e));
      }
    });
  }

  /**
   * Throws the card's work away: a prototype never lands. A worktree and its branch are
   * removed; a clone goes back to its default branch, without the card's branch, and is free again
   * once git is done there (where git fails, it stays the card's). Settles once git is done.
   */
  async discard(cardId: string, branch: string): Promise<void> {
    const ws = this.leasedBy(cardId);
    if (!ws) return;
    if (!this.cloned(ws)) {
      this.store.removeWorkspace(ws);
      return this.clearing(ws, async () => {
        if (existsSync(ws)) await gitAsync(this.o.repoPath, 'worktree', 'remove', '--force', ws);
        if (await gitAsync(this.o.repoPath, 'branch', '--list', branch)) await gitAsync(this.o.repoPath, 'branch', '--quiet', '-D', branch);
      });
    }
    await this.clearing(ws, async () => {
      // handed over or given back while git was busy with it before
      if (this.leasedBy(cardId) !== ws) return;
      if (await existsAsync(ws)) {
        await gitAsync(ws, 'reset', '--quiet', '--hard');
        await gitAsync(ws, 'clean', '--quiet', '-fd');
        await gitAsync(ws, 'checkout', '--quiet', '--detach', `origin/${await this.mainAsync(ws)}`);
        if (await gitAsync(ws, 'branch', '--list', branch)) await gitAsync(ws, 'branch', '--quiet', '-D', branch);
      }
      this.release(cardId);
    });
  }

  /**
   * Hands card `from`'s workspace and branch to card `to`, which goes on with the work there (an
   * idea built on its prototype). The branch is renamed to `rename` when that name is free; the
   * worktree keeps its directory. Settles with the workspace and the branch as they are now, once
   * git has renamed it; the workspace stays `from`'s until then.
   */
  async transfer(from: string, to: string, branch: string, rename?: string): Promise<{ path: string; branch: string }> {
    const path = this.leasedBy(from);
    if (!path) throw new WorkspaceError('the card has no workspace', 'noWorkspace');
    return this.clearing(path, async () => {
      // handed over or given back while git was busy with it before
      if (this.leasedBy(from) !== path) throw new WorkspaceError('the card has no workspace', 'noWorkspace');
      if (this.preparing.has(from)) throw new WorkspaceError('git is still preparing the workspace of the card it comes from');
      if (this.leasedBy(to)) throw new WorkspaceError('the card it goes to has a workspace of its own');
      // in a worktree the branch lives in the Obeya checkout, in a clone in the clone
      const repo = this.cloned(path) ? path : this.o.repoPath;
      let now = branch;
      if (rename && rename !== branch && !(await gitAsync(repo, 'branch', '--list', rename))) {
        await gitAsync(repo, 'branch', '-m', branch, rename);
        now = rename;
      }
      // either card moved on while git renamed the branch (the one it comes from discarded, the one it goes to started): back as it was
      const moved = this.leasedBy(from) !== path ? 'the card it comes from gave its workspace up meanwhile' : this.leasedBy(to) ? 'the card it goes to took a workspace of its own meanwhile' : null;
      if (moved) {
        if (now !== branch) await gitAsync(repo, 'branch', '-m', now, branch).catch(() => {});
        throw new WorkspaceError(moved);
      }
      this.store.setLease(path, to);
      return { path, branch: now };
    });
  }

  /**
   * What the card's branch changes so far, committed or not: each file relative to the repository
   * root, with the changed line ranges and git's function context, so a judge can tell whether two
   * cards edit the same place. A new file has no ranges. Without blocking the server, and with
   * line ranges for the first `CHANGES_LISTED` files only: a branch that changes thousands of
   * files takes git minutes to diff in full, and the judge reads a few dozen.
   */
  async changes(cardId: string): Promise<Change[]> {
    const ws = this.leasedBy(cardId);
    if (!ws || !mayExist(ws)) return [];
    try {
      const base = await this.base(ws);
      const [names, untracked] = await Promise.all([gitAsync(ws, 'diff', '--name-only', '-z', base), gitAsync(ws, 'ls-files', '-z', '--others', '--exclude-standard')]);
      const files = names.split('\0').filter(Boolean);
      const only = files.length > CHANGES_LISTED ? ['--', ...listed(files)] : [];
      const diff = files.length ? await gitAsync(ws, 'diff', '-U0', '--no-color', '--no-ext-diff', base, ...only) : '';
      const added = untracked.split('\0').filter(Boolean).slice(0, Math.max(0, CHANGES_LISTED - files.length));
      return [...parseChanges(diff), ...added.map((file) => ({ file, regions: [] }))];
    } catch {
      return [];
    }
  }

  /**
   * The card's change in its workspace: its branch against where it left the branch it is built on,
   * committed or not, with new files not yet added; null without a workspace (or one git cannot read).
   */
  async diff(cardId: string, full: boolean): Promise<CardDiff | null> {
    const ws = this.leasedBy(cardId);
    if (!ws || !mayExist(ws)) return null;
    try {
      const base = await this.base(ws);
      const tracked = await gitDiff(ws, base);
      const untracked = (await gitAsync(ws, 'ls-files', '-z', '--others', '--exclude-standard')).split('\0').filter(Boolean);
      const added: string[] = [];
      // a new file against nothing; git answers 1 when there is a difference
      for (const file of untracked.slice(0, NEW_FILES_SHOWN)) {
        const r = await gitRun(ws, [...DIFF, '--no-index', '--', '/dev/null', file]);
        if (r.code === 1) added.push(r.stdout.trim());
      }
      return cardDiff('branch', [tracked, ...added].filter(Boolean).join('\n'), full);
    } catch {
      return null;
    }
  }

  /** What landed work changed on the default branch, from `base` to `commit`; null where the checkout does not hold them. */
  async landedDiff(base: string, commit: string, full: boolean): Promise<CardDiff | null> {
    try {
      return cardDiff('landed', await gitDiff(this.o.repoPath, base, commit), full);
    } catch {
      return null;
    }
  }

  /**
   * The files of the card's change as they are now (none deleted), as git names them: its branch
   * against where it left the branch it is built on, committed or not, with new files; with `landed`, what the landing
   * put on the default branch. Separated by NUL, so no name can pass for another, as a name with
   * ` b/` in it can in a diff's header; what `file` serves rests on this list. Empty where git
   * cannot tell.
   */
  async changedFiles(cardId: string, landed?: { base: string; commit: string }): Promise<string[]> {
    const names = async (cwd: string, args: string[]) => {
      const r = await gitRun(cwd, ['-c', 'core.quotePath=false', ...args]);
      if (r.code !== 0) throw new WorkspaceError(r.stderr);
      return r.stdout.split('\0').filter(Boolean);
    };
    try {
      if (landed) return await names(this.o.repoPath, ['diff', '--name-only', '-z', '-M', '--diff-filter=d', landed.base, landed.commit]);
      const ws = this.leasedBy(cardId);
      if (!ws || !mayExist(ws)) return [];
      const base = await this.base(ws);
      return [...(await names(ws, ['diff', '--name-only', '-z', '-M', '--diff-filter=d', base])), ...(await names(ws, ['ls-files', '-z', '--others', '--exclude-standard']))];
    } catch {
      return [];
    }
  }

  /**
   * A file of the card's work as it is now, by its path relative to the repository: in its workspace
   * while it has one here, else as `ref` (the commit it landed with, its branch) holds it in the
   * repository. `local`: only a file on disk, to open it; for `ref` the checkout's copy. Null where
   * none holds it; a link out of the workspace holds none.
   */
  async fileOf(cardId: string, path: string, ref?: string, local = false): Promise<FileAt | null> {
    const ws = this.leasedBy(cardId);
    if (ws && !remoteWorkspace(ws) && existsSync(ws)) return ownFile(ws, path);
    if (!ref) return null;
    if (local) return ownFile(this.o.repoPath, path);
    const p = Bun.spawn([GIT, 'show', `${ref}:${path}`], { cwd: this.o.repoPath, stdout: 'pipe', stderr: 'ignore' });
    const data = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    return (await p.exited) === 0 ? { data } : null;
  }

  /**
   * The commit the card's own work starts from: where its branch left the nearest branch that is not
   * a card's, which is the main branch or a long-lived branch the card was built on. Measured
   * against the main branch alone, a card on a branch hundreds of commits ahead of it counted all
   * of them as its own. Branches of other cards do not count: a card's branch that another card
   * was built on still holds the first card's work.
   */
  private async base(ws: string): Promise<string> {
    const [main, at] = await Promise.all([this.upstreamAsync(ws).then((up) => gitAsync(ws, 'merge-base', 'HEAD', up)), gitAsync(ws, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD')]);
    const [head, branch] = at.split('\n');
    // the card's branch here and in remotes, whatever its name
    const cards = [`${CARD_BRANCH}*`, ...(branch && branch !== 'HEAD' ? [branch] : [])];
    const own = (
      await gitAsync(ws, 'rev-list', '--first-parent', '--parents', 'HEAD', '--not', main, ...cards.map((b) => `--exclude=${b}`), '--branches', ...cards.map((b) => `--exclude=*/${b}`), '--remotes')
    )
      .split('\n')
      .filter(Boolean);
    if (!own.length) return head!;
    const fork = own.at(-1)!.split(' ')[1];
    if (!fork || fork === main) return main;
    const before = async (a: string, b: string) => (await gitRun(ws, ['merge-base', '--is-ancestor', a, b])).code === 0;
    // the main branch merged into the card's branch since it left it
    if (await before(fork, main)) return main;
    if (await before(main, fork)) return fork;
    // a card on a long-lived branch with the main branch merged in since: both, as one tree
    try {
      return (await gitAsync(ws, 'merge-tree', '--write-tree', fork, main)).split('\n')[0]!;
    } catch {
      return fork;
    }
  }

  /**
   * The main branch as a workspace sees it: the repository's for a worktree; for a clone the one the
   * owner set for the repository, else the one its `origin` has. Without blocking: finding a clone's
   * main branch asks git, over SSH for a clone on another machine.
   */
  private async mainAsync(ws: string): Promise<string> {
    return branchSetting(this.o.repoPath) || (await gitSteps(this.cloned(ws) ? ws : this.o.repoPath, detectingBranch()));
  }

  /** The branch the workspace's work goes onto as the workspace has it: the main branch itself in a worktree, `origin`'s copy in a clone. */
  private async upstreamAsync(ws: string): Promise<string> {
    const main = await this.mainAsync(ws);
    return this.cloned(ws) ? `origin/${main}` : main;
  }

  /**
   * A free clean clone, leased at once; in the background (over a slow network, or SSH, that takes
   * a while) looked at again, since `place` went by an earlier look, and fetched and put on the
   * card's branch. One that is not clean now gives way to the next `place` finds, the lease moving
   * there; where none is left, `ready` fails with the shortage.
   */
  private leaseClone(cardId: string, branch: string, overSlots: boolean): Lease {
    const found = this.place(overSlots);
    if ('short' in found) throw new WorkspaceError(SHORT_TEXT[found.short], SHORT_CODE[found.short]);
    this.take(found.path, cardId);
    return this.prepare(
      cardId,
      found.path,
      async () => {
        let path = found.path;
        for (let state = await cloneState(path); state !== 'clean'; state = await cloneState(path)) {
          // given back first: the shortage, where no other is left, counts it as the dirty clone it is
          this.free(path);
          this.looks.set(path, { found: state, at: Date.now() });
          const next = this.place(overSlots);
          if ('short' in next) throw new WorkspaceError(SHORT_TEXT[next.short], SHORT_CODE[next.short]);
          this.take(next.path, cardId);
          path = next.path;
        }
        const base = await this.mainAsync(path);
        await gitAsync(path, 'fetch', '--quiet', 'origin');
        // a branch that already exists holds work: check it out, never reset it
        if (await gitAsync(path, 'branch', '--list', branch)) await gitAsync(path, 'checkout', '--quiet', branch);
        else await gitAsync(path, 'checkout', '--quiet', '-b', branch, `origin/${base}`);
        return path;
      },
      (path, e) => {
        // a clone git failed on is not taken again at once; one found dirty is known as such already
        if (!shortageOf(e.code)) this.failed.set(path, Date.now());
        this.free(path);
      },
    );
  }

  /** Leases a free clone to the card; what was last seen of it while free no longer counts. */
  private take(path: string, cardId: string) {
    this.store.setLease(path, cardId);
    this.looks.delete(path);
  }

  /**
   * A temporary worktree for the owner's question to a finished card while no clone is free and
   * clean: detached at the head of the card's branch, made from the
   * clone on this machine that holds the branch (else from the configured checkout, at `origin`'s
   * copy of the branch or the default branch), as the Lesestand is made. It takes no clone and is
   * not in the pool; `removeFollowUpTree` removes it once the follow-up ends.
   */
  followUpTree(cardId: string, branch: string): Lease {
    const path = join(this.o.dir, 'follow-up', cardId.slice(0, 8));
    const ready = (async () => {
      await this.trees.get(path)?.catch(() => {});
      const commit = async (repo: string, ref: string) => (await gitAsync(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).catch(() => '')) || null;
      const clones = [...this.list().map((w) => w.path), this.o.repoPath].filter((p) => hostName(p) === null && existsSync(p));
      let own: string | undefined;
      for (const p of clones) if (await commit(p, `refs/heads/${branch}`)) {
        own = p;
        break;
      }
      let [repo, ref] = [this.o.repoPath, 'HEAD'];
      if (own) [repo, ref] = [own, `refs/heads/${branch}`];
      else for (const r of [`refs/remotes/origin/${branch}`, `origin/${await this.mainAsync(this.o.repoPath)}`]) if (await commit(repo, r)) {
        ref = r;
        break;
      }
      await removeTree(path);
      mkdirSync(dirname(path), { recursive: true });
      await gitAsync(repo, ...detachedTree(path, (await commit(repo, ref)) ?? ref));
      return path;
    })();
    const added = ready.then(() => {});
    this.trees.set(path, added);
    void added.catch(() => {}).then(() => this.trees.get(path) === added && this.trees.delete(path));
    return { path, ready };
  }

  /** Removes a follow-up's temporary worktree (`followUpTree`) and its entry in the clone it was made from. */
  async removeFollowUpTree(path: string) {
    // one git is still adding goes once it is there
    await this.trees.get(path)?.catch(() => {});
    await removeTree(path);
  }

  /**
   * The card's worktree, leased at once; added in the background, where it does not exist yet (in a
   * large repository that takes a minute), or once git has removed the one it had before.
   */
  private leaseWorktree(cardId: string, branch: string): Lease {
    const path = join(this.o.dir, cardId.slice(0, 8));
    this.store.addWorkspace(this.canvasId, path, this.o.repo ?? null);
    this.store.setLease(path, cardId);
    const removing = this.clears.get(path);
    if (!removing && existsSync(path)) return { path, ready: null };
    return this.prepare(
      cardId,
      path,
      async () => {
        await removing;
        // the card's again, where git removed it from the pool meanwhile; one git failed to remove is as it was
        this.store.addWorkspace(this.canvasId, path, this.o.repo ?? null);
        this.store.setLease(path, cardId);
        if (existsSync(path)) return path;
        mkdirSync(this.o.dir, { recursive: true });
        if ((await gitAsync(this.o.repoPath, 'branch', '--list', branch)) !== '') await gitAsync(this.o.repoPath, 'worktree', 'add', '--quiet', path, branch);
        else await gitAsync(this.o.repoPath, 'worktree', 'add', '--quiet', '-b', branch, path, await this.mainAsync(this.o.repoPath));
        return path;
      },
      () => this.store.removeWorkspace(path),
    );
  }

}


/**
 * The clones of a repository's pool (`rows`, as registered) that a configuration no longer names,
 * which leave the pool once it runs (`keepOnly`): with the repository in worktrees all of them;
 * else those here that are neither `listed` (resolved) nor among the first `clones` Obeya makes in
 * `dir`, and on a host those beyond its number, or all where it is no longer configured. Each with
 * its number where Obeya made it, and the card that holds it.
 */
export function leavingClones(
  rows: { path: string; card_id: string | null }[],
  o: { dir: string; mode: 'clones' | 'worktrees'; listed: string[]; clones: number; hosts: { name: string; clones: number }[] },
): { path: string; host?: string; made?: number; card?: string }[] {
  return rows.flatMap((w) => {
    const host = hostName(w.path);
    const there = pathThere(w.path);
    const n = CLONE_NAME.test(basename(there)) ? Number(basename(there)) : undefined;
    const made = host !== null ? n : dirname(w.path) === o.dir ? n : undefined;
    if (host === null) {
      // a card's worktree is no clone
      let clone = true;
      try {
        clone = statSync(join(w.path, '.git')).isDirectory();
      } catch {}
      if (!clone) return [];
    }
    if (o.mode === 'clones') {
      if (host === null && (o.listed.includes(w.path) || (made !== undefined && made <= o.clones))) return [];
      const h = o.hosts.find((x) => x.name === host);
      if (h && made !== undefined && made <= h.clones) return [];
    }
    return [{ path: there, ...(host !== null ? { host } : {}), ...(made !== undefined ? { made } : {}), ...(w.card_id ? { card: w.card_id } : {}) }];
  });
}

/**
 * What would be lost with a clone's folder: changes not committed, files git does not track (those
 * it ignores aside), a stash, submodules (not looked into), worktrees made from it that are in use
 * (a follow-up's), and commits of a branch, a tag or a detached HEAD that are on no branch of
 * `origin` (fetched with pruning: a branch deleted there counts as gone), unless the files it
 * changes are on `origin`'s main branch as it has them (so a branch squashed or rebased onto it
 * counts as landed). `origin` is where its work lands: the remote, or the Obeya checkout where work lands on
 * the local main. Empty where nothing would be lost; `gone` where the folder is gone already; null
 * where it cannot tell now (the host does not answer, `origin` cannot be fetched), or the folder is
 * no clone of `origins` (a worktree's `.git` is a file, a clone of another repository).
 */
export async function unlanded(path: string, o: { origins?: string[]; main?: string } = {}): Promise<string[] | 'gone' | null> {
  const run = async (...args: string[]) => {
    const r = await gitRun(path, args);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  let there: ReturnType<typeof remote>;
  try {
    there = remote(path);
  } catch {
    return null;
  }
  const has = async (sub: string) => {
    if (!there) return existsSync(join(path, sub)) ? 1 : 0;
    const r = await there.host.run(['test', '-e', `${there.path}/${sub}`]);
    return r.code === LOST ? null : r.code === 0 ? 1 : 0;
  };
  const dotGit = await has('.git');
  if (dotGit === null) return null;
  if (!dotGit) return (await has('')) === 0 ? 'gone' : null;
  if ((await run('rev-parse', '--git-dir')) !== '.git') return null;
  if (o.origins?.length) {
    const origin = (await run('remote', 'get-url', 'origin')) ?? '';
    if (!o.origins.some((x) => sameRemote(x, origin))) return null;
  }
  const lost: string[] = [];
  const modules = await has('.git/modules');
  if (modules === null) return null;
  const gitlinks = await run('ls-files', '--stage');
  if (gitlinks === null) return null;
  if (modules || gitlinks.split('\n').some((l) => l.startsWith('160000 '))) lost.push('submodules, whose work is not looked into');
  await run('worktree', 'prune');
  const trees = (await run('worktree', 'list', '--porcelain'))?.split('\n').filter((l) => l.startsWith('worktree ')).length ?? 1;
  if (trees > 1) lost.push(`${trees - 1} worktree(s) made from it`);
  const status = await run('status', '--porcelain');
  if (status === null) return null;
  if (status) lost.push(`changes not committed or files not in git: ${status.split('\n').length}`);
  if ((await run('rev-parse', '--verify', '--quiet', 'refs/stash')) !== null) lost.push('a stash');
  if ((await run('fetch', '--quiet', '--prune', 'origin')) === null) return null;
  const main = `refs/remotes/origin/${o.main || ((await run('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')) ?? 'origin/main').replace(/^origin\//, '')}`;
  const onMain = (await run('rev-parse', '--verify', '--quiet', main)) !== null;
  const refs = ((await run('for-each-ref', '--format=%(refname)')) ?? '').split('\n').filter((r) => r && !r.startsWith('refs/remotes/') && r !== 'refs/stash');
  if ((await run('symbolic-ref', '-q', 'HEAD')) === null) refs.push('HEAD');
  const landedOn = async (main: string, ref: string) => {
    const base = await run('merge-base', main, ref);
    if (base === null) return false;
    // the names as they are, NUL-separated: a name with a tab or a space at its end is no other file's
    const listed = await gitRun(path, ['diff', '-z', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', base, ref]);
    const files = listed.stdout.split('\0').filter(Boolean);
    if (listed.code !== 0 || files.length > 1000) return false;
    return !files.length || (await run('diff', '--quiet', '--no-ext-diff', '--no-textconv', main, ref, '--', ...files.map((f) => `:(literal)${f}`))) !== null;
  };
  for (const ref of refs) {
    const n = await run('rev-list', '--count', ref, '--not', '--remotes=origin');
    if (n === null) return null;
    if (n === '0') continue;
    // its changes are on the main branch already (squashed, rebased): each file it changed is there as it has it
    if (onMain && (await landedOn(main, ref))) continue;
    const name = ref === 'HEAD' ? 'a detached HEAD' : ref.startsWith('refs/heads/') ? `branch ${ref.slice(11)}` : ref.replace(/^refs\//, '');
    lost.push(`${name} with ${n} commit(s) not on origin`);
  }
  return lost;
}
/** What a look at a clone finds (`Workspaces.look`). */
type Found = 'clean' | 'dirty' | 'missing';

/** Whether a clone is clean, has uncommitted changes (or git fails in it), or is not there; without blocking the server. */
async function cloneState(path: string): Promise<Found> {
  try {
    if (!(await existsAsync(path))) return 'missing';
    return (await gitAsync(path, 'status', '--porcelain')) === '' ? 'clean' : 'dirty';
  } catch {
    return 'dirty';
  }
}

/** Removes the worktree at `path` and its entry in the repository it was made from. */
async function removeTree(path: string) {
  if (!existsSync(path)) return;
  const common = await gitAsync(path, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => null);
  await rm(path, { recursive: true, force: true });
  if (common) await gitAsync(common, 'worktree', 'prune');
}

/**
 * The git arguments that add a worktree at `path` detached at `commit`. The hooks are the repository's
 * (a post-checkout installing dependencies, say), not the worktree's: none run.
 */
export const detachedTree = (path: string, commit: string) => ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', '--force', path, commit];

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

/**
 * The main branches the owner set for repositories on this machine (`RepoSettings.branch`), by
 * the repository's path, each read when it is asked for: a running canvas registers its own.
 */
const branchSettings = new Map<string, () => string | undefined>();

/** Registers where the main branch the owner set for the repository at `repoPath` is read; returns what takes it back. */
export function useBranchSetting(repoPath: string, branch: () => string | undefined): () => void {
  const key = resolve(repoPath);
  branchSettings.set(key, branch);
  return () => {
    if (branchSettings.get(key) === branch) branchSettings.delete(key);
  };
}

/** The main branch the owner set on this machine for the repository at `path`; none where they set none. */
export const branchSetting = (path: string): string | undefined => branchSettings.get(resolve(path))?.()?.trim() || undefined;

/** The repository's main branch: the one the owner set for it on this machine, else the one detected (`detectedBranch`); none in a folder without git. */
export function defaultBranch(path: string): string {
  if (isFolder(path)) return '';
  return branchSetting(path) || detectedBranch(path);
}

/**
 * The folders without git in the configuration (`RepoConfig.git` false), by path: they have no
 * branch, and what Obeya reads of them (`.obeya/settings.json`, plan docs) it reads as the folder has
 * it. Marked whenever a configuration is resolved.
 */
const folders = new Set<string>();

/** Marks the path as a folder without git, or as a repository again. */
export function markFolder(path: string, folder: boolean) {
  if (folder) folders.add(resolve(path));
  else folders.delete(resolve(path));
}

/** Whether the path is a folder without git in the configuration. */
export const isFolder = (path: string): boolean => folders.has(resolve(path));

/**
 * The repository's main branch as git tells it, where cards start from and work lands: `origin`'s HEAD where the
 * checkout knows one. Else its only branch that is not a card's; else the one of them named as
 * git's `init.defaultBranch`, `main` or `master`, so that a branch the owner checks out for a
 * while does not take its place; else the branch the checkout is on, unless that is a card's;
 * else `init.defaultBranch`, else `main`.
 */
export const detectedBranch = (path: string): string => gitStepsSync(path, detectingBranch());

/** `detectedBranch` as git steps, from `branches` where they were read already. */
export function* detectingBranch(branches?: Branches | null): GitSteps<string> {
  const b = branches !== undefined ? branches : yield* readingBranches();
  if (b?.originHead) return b.originHead;
  const own = [...(b?.local.keys() ?? [])].filter((name) => !name.startsWith(CARD_BRANCH));
  if (own.length === 1) return own[0]!;
  const [init] = yield [['config', '--get', 'init.defaultBranch']];
  const usual = [init, 'main', 'master'].find((name) => name && own.includes(name));
  if (usual) return usual;
  const [current] = yield [['symbolic-ref', '--short', '-q', 'HEAD']];
  if (current && !current.startsWith(CARD_BRANCH)) return current;
  return init || 'main';
}

/** A repository's branches, what its main branch and that branch's commit are read from. */
export interface Branches {
  /** The branch `origin`'s HEAD names, where the checkout knows one. */
  originHead?: string;
  /** The local branches and their commits. */
  local: Map<string, string>;
  /** `origin`'s branches as the checkout last fetched them, and their commits. */
  remote: Map<string, string>;
}

/**
 * Reads `Branches` as git steps, all with one call: Obeya reads them each time it needs the main
 * branch, and each call of git takes a few milliseconds. Null where there is no git repository.
 */
export function* readingBranches(): GitSteps<Branches | null> {
  const [refs] = yield [['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/', 'refs/remotes/origin/']];
  if (refs == null) return null;
  const b: Branches = { local: new Map(), remote: new Map() };
  const ORIGIN = 'refs/remotes/origin/';
  for (const line of refs.split('\n')) {
    const [ref = '', commit = '', symref = ''] = line.split('\0');
    if (ref === `${ORIGIN}HEAD`) {
      if (symref.startsWith(ORIGIN)) b.originHead = symref.slice(ORIGIN.length);
    } else if (ref.startsWith('refs/heads/')) b.local.set(ref.slice('refs/heads/'.length), commit);
    else if (ref.startsWith(ORIGIN)) b.remote.set(ref.slice(ORIGIN.length), commit);
  }
  return b;
}

/**
 * What Obeya reads of a repository with git, written once for both ways it runs: batches of git
 * calls (their arguments) that do not depend on one another, each answered with the calls' output
 * (trimmed; null where git failed) before the next batch is asked.
 */
export type GitSteps<T> = Generator<string[][], T, (string | null)[]>;

/** Runs git steps in `cwd` one call after the other, the server waiting: for code that cannot wait otherwise. */
export function gitStepsSync<T>(cwd: string, steps: GitSteps<T>): T {
  for (let step = steps.next([]); ; step = steps.next(step.value.map((args) => gitOrNull(cwd, ...args)))) if (step.done) return step.value;
}

/** Runs git steps in `cwd` without blocking the server, the calls of each batch at once. */
export async function gitSteps<T>(cwd: string, steps: GitSteps<T>): Promise<T> {
  const one = async (args: string[]) => {
    const r = await gitRun(cwd, args).catch(() => null);
    return r?.code === 0 ? r.stdout.trim() : null;
  };
  for (let step = steps.next([]); ; step = steps.next(await Promise.all(step.value.map(one)))) if (step.done) return step.value;
}

/** Git steps of their own that run beside each other: each batch holds the next calls of both. */
export function* together<A, B>(a: GitSteps<A>, b: GitSteps<B>): GitSteps<[A, B]> {
  let x = a.next([]);
  let y = b.next([]);
  while (!x.done || !y.done) {
    const asked = x.done ? 0 : x.value.length;
    const got = yield [...(x.done ? [] : x.value), ...(y.done ? [] : y.value)];
    if (!x.done) x = a.next(got.slice(0, asked));
    if (!y.done) y = b.next(got.slice(asked));
  }
  return [x.value, y.value];
}

/** Git steps of one batch: these calls. */
export function* gitCalls(...calls: string[][]): GitSteps<(string | null)[]> {
  return yield calls;
}

/** What every card's branch begins with. */
const CARD_BRANCH = 'obeya/';

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
  return `${CARD_BRANCH}${slug || 'card'}-${cardId.slice(0, 6)}`;
}
