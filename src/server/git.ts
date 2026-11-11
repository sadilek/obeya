// How Obeya runs git: the binary it calls, here or in a workspace on another machine
// (`ssh://<host>/…`, see `hosts.ts`), and how a failure reads.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { messageOf } from '../core/text';
import { remote, TOKEN_HELPER_ARGS } from './hosts';
import { spawnOutput } from './spawn';

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: 'noWorkspace' | 'dirtyWorkspaces' | 'noSlot' | 'workspace' = 'workspace',
  ) {
    super(message);
  }
}

/**
 * The git binary. On macOS `/usr/bin/git` is a shim that asks xcrun for the real one on every
 * call, which more than doubles what a call costs; Obeya calls git often, so it asks once. On
 * Windows the `git` on the PATH is usually Git for Windows' `cmd\git.exe`, a launcher that starts
 * the real one as a second process: starting a process costs a lot there (a virus scanner looks at
 * each), so it is the real one in git's exec path, which finds its helpers (sh, ssh) by itself.
 */
export const GIT = gitBinary();

function gitBinary(): string {
  if (process.platform === 'win32') {
    const r = Bun.spawnSync(['git', '--exec-path'], { stderr: 'ignore', windowsHide: true });
    const path = r.exitCode === 0 ? join(r.stdout.toString().trim(), 'git.exe') : '';
    return path && existsSync(path) ? path : 'git';
  }
  if (process.platform !== 'darwin' || Bun.which('git') !== '/usr/bin/git') return 'git';
  const r = Bun.spawnSync(['xcrun', '--find', 'git'], { stderr: 'ignore' });
  const path = r.exitCode === 0 ? r.stdout.toString().trim() : '';
  return path && existsSync(path) ? path : 'git';
}

/** The host of a workspace on another machine, as `remote` finds it; a host gone from the configuration is a workspace error. */
export function remoteWorkspace(path: string) {
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

/**
 * `git` without blocking the server while it runs: landing approved work fetches, rebases and
 * pushes, over the network seconds in which the server would answer nothing else.
 */
export async function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitRun(cwd, args);
  if (r.code !== 0) throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
  return r.stdout.trim();
}

/**
 * Whether commit `a` is an ancestor of `b` in `cwd`. Throws where git cannot tell (an unknown commit,
 * a broken repository): each caller decides what that means for it.
 */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  const args = ['merge-base', '--is-ancestor', a, b];
  const r = await gitRun(cwd, args);
  if (r.code === 0 || r.code === 1) return r.code === 0;
  throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
}

/** Whether `cwd` has the commit `c`. Throws where git cannot tell (a broken repository, a configuration it cannot read). */
export async function hasCommit(cwd: string, c: string): Promise<boolean> {
  const args = ['rev-parse', '--verify', '--quiet', `${c}^{commit}`];
  const r = await gitRun(cwd, args);
  if (r.code === 0 || r.code === 1) return r.code === 0;
  throw new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
}

/** `git` in `cwd` without blocking, with its exit code: for commands whose exit code is an answer (`diff --no-index`). */
export async function gitRun(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const there = remoteWorkspace(cwd);
  if (there) return there.host.run(['git', ...TOKEN_HELPER_ARGS, '-C', there.path, ...args], { cwd: there.path });
  return spawnOutput([GIT, '-C', cwd, ...args]);
}

/**
 * Put before a git command that only looks (`status`, `diff` against the working tree): git then
 * refreshes the index in memory without writing it. Writing it takes git's index lock, and a git
 * command that needs the lock meanwhile (a commit or checkout of the owner's or an agent's, Obeya's
 * own landing) fails. `diff` heeds only its own setting, and so names a file whose timestamps alone
 * changed as well (`worktreeNames`); its patches leave such a file out.
 */
export const LOOK = ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false'];

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
