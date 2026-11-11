// The PATH the programs Obeya checks and starts are looked up on: what a process started from the
// desktop may lack, and on Windows what an installer added since Obeya started (an installation
// Obeya ran, or one the owner ran by hand), which only a new process would get from the registry.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { output } from '../../plugin/skills/demo/lib/setup.ts';

type Env = Record<string, string | undefined>;

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

/** On Windows, what installers added to the user's and the machine's PATH since Obeya started. */
async function windowsPath(env: Env) {
  const out = await output('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], env);
  if (out) addToPath(env, out.trim().split(';'));
}

/** The reading of the registry under way, which a check that starts meanwhile waits for too. */
const reading = new WeakMap<Env, Promise<void>>();

/** On Windows, the PATH as the registry has it now: before every check, so what was installed meanwhile, by Obeya or by hand, is found. */
export function freshPath(env: Env = process.env, platform: string = process.platform): Promise<void> {
  if (platform !== 'win32') return Promise.resolve();
  let read = reading.get(env);
  if (!read) {
    read = windowsPath(env).finally(() => reading.delete(env));
    reading.set(env, read);
  }
  return read;
}
