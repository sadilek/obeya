// How Obeya runs git: the binary it calls, here or in a workspace on another machine
// (`ssh://<host>/…`, see `hosts.ts`), and how a failure reads.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { messageOf } from '../core/text';
import { remote, TOKEN_HELPER_ARGS } from './hosts';
import { failureText, spawnOutput } from './spawn';

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

/** What a git call answered: its exit code and its output, untrimmed. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The error of a git call that failed, naming the call and where it ran. */
const failed = (cwd: string, args: string[], r: GitResult) => new WorkspaceError(`git ${args.join(' ')} in ${cwd}: ${failureText(r)}`);

/**
 * The environment of a git call that may reach a remote (a fetch, a push) and that no one is there
 * to answer: a remote that asks for a password asks no one, and the call fails instead of waiting.
 */
export const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

/**
 * `git` in `cwd` without blocking the server, with its exit code: the one runner the others are
 * built on. `cwd` may be a workspace on another machine (`ssh://<host>/…`), where git runs over SSH
 * with the repository's GitHub login; `env` (on top of the server's) applies on this machine only.
 * `stdin`: the call's input; `timeout`: how long it may take, in ms.
 */
export async function gitRun(cwd: string, args: string[], o: { env?: Record<string, string>; stdin?: string; timeout?: number } = {}): Promise<GitResult> {
  const there = remoteWorkspace(cwd);
  if (there) return there.host.run(['git', ...TOKEN_HELPER_ARGS, '-C', there.path, ...args], { cwd: there.path, ...(o.stdin !== undefined ? { input: o.stdin } : {}), ...(o.timeout ? { timeout: o.timeout } : {}) });
  return spawnOutput([GIT, '-C', cwd, ...args], {
    ...(o.stdin !== undefined ? { stdin: new Blob([o.stdin]) } : {}),
    ...(o.env ? { env: { ...process.env, ...o.env } } : {}),
    ...(o.timeout ? { timeout: o.timeout } : {}),
  });
}

/**
 * `git` without blocking the server while it runs, its output trimmed; throws where it fails.
 * Landing approved work fetches, rebases and pushes, over the network seconds in which the server
 * would answer nothing else.
 */
export async function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitRun(cwd, args);
  if (r.code !== 0) throw failed(cwd, args, r);
  return r.stdout.trim();
}

/**
 * `git` in `cwd` without blocking, its output trimmed; null where git fails (no repository there, a
 * ref that does not exist) or cannot be run there.
 */
export async function gitTry(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await gitRun(cwd, args).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : null;
}

/** What a git call whose exit code 1 is an answer (no) answered: whether it exited 0; throws where it failed otherwise. */
async function yesOrNo(cwd: string, args: string[]): Promise<boolean> {
  const r = await gitRun(cwd, args);
  if (r.code === 0 || r.code === 1) return r.code === 0;
  throw failed(cwd, args, r);
}

/**
 * Whether commit `a` is an ancestor of `b` in `cwd`. Throws where git cannot tell (an unknown commit,
 * a broken repository): each caller decides what that means for it.
 */
export const isAncestor = (cwd: string, a: string, b: string): Promise<boolean> => yesOrNo(cwd, ['merge-base', '--is-ancestor', a, b]);

/** Whether `cwd` has the commit `c`. Throws where git cannot tell (a broken repository, a configuration it cannot read). */
export const hasCommit = (cwd: string, c: string): Promise<boolean> => yesOrNo(cwd, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);

/**
 * The names a git call lists separated by NUL (`-z`), as they are: a name with a tab or a space at
 * its end is no other file's. Throws where it fails.
 */
export async function gitNames(cwd: string, args: string[]): Promise<string[]> {
  const r = await gitRun(cwd, args);
  if (r.code !== 0) throw failed(cwd, args, r);
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * `git` in `cwd` on this machine, the caller waiting: for scripts, tests and startup. With the
 * environment as it is now: on Windows each check reads PATH afresh (path.ts).
 */
export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([GIT, '-C', cwd, ...args], { env: process.env, stderr: 'pipe' });
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
 * Put before a git command that only looks (`status`, `diff` against the working tree): git then
 * refreshes the index in memory without writing it. Writing it takes git's index lock, and a git
 * command that needs the lock meanwhile (a commit or checkout of the owner's or an agent's, Obeya's
 * own landing) fails. `diff` heeds only its own setting, and so names a file whose timestamps alone
 * changed as well (`worktreeNames`); its patches leave such a file out.
 */
export const LOOK = ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false'];
