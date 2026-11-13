// How Obeya runs git: the binary it calls, here or in a workspace on another machine
// (`ssh://<host>/…`, see `hosts.ts`), and how a failure reads.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { messageOf } from '../core/text';
import { type GithubLogin, remote, TOKEN_HELPER_ARGS } from './hosts';
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

/** How long a login read from git or gh is taken as it stands, before it is read again. */
export const LOGIN_TTL = 10 * 60_000;

/**
 * The login git has for what `input` names (`url=…`, or `protocol=…` and `host=…`), as `git
 * credential fill` in `cwd` finds it: the keychain, the credential manager, whatever the machine set
 * up, a repository's own helper too. Its fields by name (`username`, `password`); null where git has
 * none. Asks nobody: no terminal, no askpass program (an empty one ends git's search for one), no
 * dialog of Git Credential Manager; a keyring that opens one anyway is cut off. `git`: the program,
 * a stand-in in tests.
 */
export async function gitCredential(cwd: string, input: string, git = GIT): Promise<Map<string, string> | null> {
  const r = await spawnOutput([git, '-C', cwd, 'credential', 'fill'], {
    stdin: new Blob([`${input}\n\n`]),
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' },
    timeout: 15_000,
  });
  if (r.code !== 0) return null;
  const fields = r.stdout.split('\n').filter((l) => l.includes('='));
  return new Map(fields.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

/**
 * The GitHub login git uses for a repository here (`gitCredential` in its checkout, so the account
 * its own configuration picks), for its clones on a host; none for a remote not on HTTPS. Read in
 * the background, without the server waiting for git: from the start, and again once it is older
 * than `LOGIN_TTL`, the login read before standing meanwhile.
 */
export function githubToken(repoPath: string, remoteUrl: string | undefined, git = GIT): GithubLogin {
  const url = remoteUrl?.match(/^https:\/\/([^/]+)\//);
  let cached: { token: string | undefined; at: number } | undefined;
  let reading: Promise<void> | undefined;
  const read = () =>
    (reading ??= (async () => {
      const fields = await gitCredential(repoPath, `protocol=https\nhost=${url![1]}`, git).catch(() => null);
      cached = { token: fields?.get('password'), at: Date.now() };
    })().finally(() => (reading = undefined)));
  if (url) void read();
  const login: GithubLogin = () => {
    if (url && (!cached || Date.now() - cached.at >= LOGIN_TTL)) void read();
    return cached?.token;
  };
  login.ready = () => (url && !cached ? read() : Promise.resolve());
  return login;
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

/**
 * What a git call whose exit code 1 is an answer (no) answered: whether it exited 0. Where it failed
 * otherwise, `unsure` where given, else it throws.
 */
async function yesOrNo(cwd: string, args: string[], unsure?: boolean): Promise<boolean> {
  const r = await gitRun(cwd, args);
  if (r.code === 0 || r.code === 1) return r.code === 0;
  if (unsure !== undefined) return unsure;
  throw failed(cwd, args, r);
}

/**
 * Whether commit `a` is an ancestor of `b` in `cwd`. Where git cannot tell (an unknown commit, a
 * broken repository) it is `unsure` where the caller gives what that means for it, else it throws.
 */
export const isAncestor = (cwd: string, a: string, b: string, unsure?: boolean): Promise<boolean> => yesOrNo(cwd, ['merge-base', '--is-ancestor', a, b], unsure);

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

/** Put before a git command that makes a commit of Obeya's own, with no identity of the owner's. */
export const AS_OBEYA = ['-c', 'user.name=Obeya', '-c', 'user.email=obeya@localhost'];

/**
 * Put before a git command that only looks (`status`, `diff` against the working tree): git then
 * refreshes the index in memory without writing it. Writing it takes git's index lock, and a git
 * command that needs the lock meanwhile (a commit or checkout of the owner's or an agent's, Obeya's
 * own landing) fails. `diff` heeds only its own setting, and so names a file whose timestamps alone
 * changed as well (`worktreeNames`); its patches leave such a file out.
 */
export const LOOK = ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false'];
