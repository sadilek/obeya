// The PATH the programs Obeya checks and starts are looked up on: what a process started from the
// desktop may lack (on a Mac and on Linux the PATH a new terminal has, which the owner's login shell
// builds), and on Windows what an installer added since Obeya started (an installation Obeya ran,
// or one the owner ran by hand), which only a new process would get from the registry. And a path
// as the file system resolves it.

import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { shared } from '../core/one-at-a-time';
import { output } from '../../plugin/skills/demo/lib/setup.ts';

type Env = Record<string, string | undefined>;

/** A path as the file system resolves it (links followed); as given where it does not exist. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Where the official installers of Claude Code and uv put their programs. */
export const localBin = () => join(homedir(), '.local', 'bin');

/**
 * A copied Windows environment loses process.env's case-insensitive property lookup. Of several
 * spellings, the one that sorts first: the one a spawned process gets (`PATH` before `Path`).
 */
const pathKey = (env: Env) =>
  process.platform !== 'win32' ? 'PATH' : (Object.keys(env).filter((key) => key.toUpperCase() === 'PATH').sort()[0] ?? 'PATH');

/** Where `program` is on the PATH of `env`; null where it is on none. */
export const which = (program: string, env: Env = process.env) => Bun.which(program, { PATH: env[pathKey(env)] ?? '' });

/** Adds the directories to the PATH of `env` that it lacks, after those it has. */
export function addToPath(env: Env, dirs: string[]) {
  const key = pathKey(env);
  const parts = (env[key] ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) if (d && !parts.includes(d)) parts.push(d);
  env[key] = parts.join(delimiter);
}

/**
 * Puts the directories on the PATH that the programs Obeya checks and starts are installed in but
 * a process started from the desktop may lack: the official installers' `~/.local/bin`, and
 * Homebrew's on a Mac.
 */
export function extendPath(env: Env = process.env, platform: string = process.platform) {
  addToPath(env, [localBin(), ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])].filter((d) => existsSync(d)));
}

/** Puts the directories first on the PATH of `env`, in their order, each once; the others follow as they were. */
export function putFirst(env: Env, dirs: string[]) {
  const key = pathKey(env);
  env[key] = [...new Set([...dirs, ...(env[key] ?? '').split(delimiter)].filter(Boolean))].join(delimiter);
}

/** How long the login shell may take to say its PATH: one that takes longer is not waited for. */
export const SHELL_PATIENCE_MS = 10_000;

/**
 * The PATH a new terminal has: the owner's login shell (`SHELL`) started as a terminal starts it,
 * as a login shell and interactive, so that the system's directories (on a Mac `/etc/paths.d`
 * through `path_helper`) and the owner's profile and rc files count. It writes the PATH to a file
 * rather than to a pipe, which a program its rc files leave running would keep open. Null where
 * there is no shell or it fails or does not finish in time.
 */
export async function loginShellPath(env: Env = process.env, patience = SHELL_PATIENCE_MS): Promise<string[] | null> {
  const shell = env.SHELL;
  if (!shell || !(await Bun.file(shell).exists())) return null;
  const dir = await mkdtemp(join(tmpdir(), 'obeya-path-'));
  const file = join(dir, 'path');
  try {
    // without a terminal of its own (its own session), so an interactive shell takes none from Obeya's
    const p = Bun.spawn([shell, '-l', '-i', '-c', `printenv PATH > '${file}'`], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true });
    const late = setTimeout(() => {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        p.kill('SIGKILL');
      }
    }, patience);
    const code = await p.exited;
    clearTimeout(late);
    if (code !== 0) return null;
    const home = env.HOME || homedir();
    const dirs = (await readFile(file, 'utf8')).trim().split(':').filter(Boolean);
    // `/etc/paths.d` may name a directory under `~`, which no shell expands there
    return dirs.map((d) => (d === '~' ? home : d.startsWith('~/') ? join(home, d.slice(2)) : d));
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Obeya started from the desktop (by its app) on a Mac or Linux gets the session's bare PATH, not
 * the one a terminal has: the login shell's PATH goes first then, the rest after it. Started from a
 * terminal, Obeya has that PATH already, and keeps the one it was started with.
 */
export async function terminalPath(env: Env = process.env, platform: string = process.platform, fromApp = !!process.env.OBEYA_FROM_APP): Promise<void> {
  if (platform === 'win32' || !fromApp) return;
  const dirs = await loginShellPath(env);
  if (dirs) putFirst(env, dirs);
  else console.error(`Obeya: the login shell (${env.SHELL ?? 'none'}) did not tell its PATH; programs a terminal finds may be missing`);
}

/** On Windows, what installers added to the user's and the machine's PATH since Obeya started. */
async function windowsPath(env: Env) {
  const out = await output('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], env);
  if (out) addToPath(env, out.trim().split(';'));
}

/** The reading of the PATH under way (the registry, the login shell), which a check that starts meanwhile waits for too. */
const reading = new WeakMap<Env, Promise<void>>();

/**
 * The PATH as it is now: before every check, so what was installed meanwhile, by Obeya or by hand,
 * is found. On Windows as the registry has it, from the desktop on a Mac or Linux as a new terminal
 * has it.
 */
export function freshPath(env: Env = process.env, platform: string = process.platform, fromApp = !!process.env.OBEYA_FROM_APP): Promise<void> {
  if (platform === 'win32') return shared(reading, env, () => windowsPath(env));
  if (!fromApp) return Promise.resolve();
  return shared(reading, env, () => terminalPath(env, platform, fromApp));
}
