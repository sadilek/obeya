// What several scripts need: the checkout, their command line, failing with a message, running
// commands and git, Rust's tools on the PATH, files written and found, and where scratch Obeyas lie.
// Plain Node, so that the hero video's scripts, which Node runs, can import it too.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export { alive } from '../plugin/lib/process.ts';

/** The checkout the scripts run from. */
export const ROOT = resolve(import.meta.dirname, '..');

type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; quiet?: boolean };

/** A command as `run` shows it: arguments longer than a line (a JSON configuration) shortened. */
const shown = (cmd: string[]) => cmd.map((c) => (c.length > 80 ? `${c.slice(0, 77)}...` : c)).join(' ');

const spawn = (cmd: string[], { cwd = ROOT, env, quiet = false }: RunOptions) =>
  spawnSync(cmd[0]!, cmd.slice(1), { cwd, env: env && { ...process.env, ...env }, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', maxBuffer: 1 << 30 });

/**
 * What a script needs to end with a message and to run commands, its name in front of what it
 * says: `fail` says why and exits 1; `args` parses its command line (`parseArgs`, positionals
 * allowed), failing on an unknown option or a missing value; `run` runs a command, echoed with its
 * output shown, or `quiet` and returning what it printed, and fails when it does; `retry` runs one
 * again after each pause (seconds) while it fails, the last try through `run`.
 */
export function script(name: string) {
  const fail = (message: string): never => {
    console.error(`${name}: ${message}`);
    process.exit(1);
  };
  const args = <O extends ParseArgsOptionsConfig>(options: O, argv = process.argv.slice(2)) => {
    try {
      return parseArgs({ args: argv, options, allowPositionals: true });
    } catch (error) {
      return fail((error as Error).message);
    }
  };
  const run = (cmd: string[], o: RunOptions = {}): string => {
    if (!o.quiet) console.log(`$ ${shown(cmd)}`);
    const r = spawn(cmd, o);
    if (r.status !== 0) fail(o.quiet ? `${cmd.join(' ')}: ${r.error?.message ?? `${r.stdout}${r.stderr}`}` : `${cmd[0]} failed (${r.error?.message ?? `exit ${r.status}`})`);
    return r.stdout ?? '';
  };
  /** `cmd` gets the try's number (from 0), so a later try may ask for more (`--verbose`); `between` tidies up before the next. */
  const retry = (cmd: (attempt: number) => string[], pauses: number[], o: RunOptions & { between?: () => void } = {}) => {
    for (const [n, pause] of pauses.entries()) {
      const c = cmd(n);
      console.log(`$ ${shown(c)}`);
      const r = spawn(c, o);
      if (r.status === 0) return;
      console.warn(`${name}: ${shown(c.slice(0, 4))} failed (exit ${r.status}), again in ${pause} s`);
      o.between?.();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause * 1000);
    }
    run(cmd(pauses.length), o);
  };
  return { fail, args, run, retry };
}

/** What `git -C <cwd> <args>` prints, trimmed, or null when it fails. */
export const git = (cwd: string, ...args: string[]): string | null => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Writes `files` (by path, a text, or `{ from }` a file to copy) under `dir`, making their directories. */
export function writeFiles(dir: string, files: Record<string, string | { from: string }>) {
  for (const [path, what] of Object.entries(files)) {
    const to = join(dir, path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, typeof what === 'string' ? what : readFileSync(what.from));
  }
}

/** The PATH with rustup's ~/.cargo/bin added, for a shell that has not picked it up yet. */
export const cargoPath = () => {
  const cargoBin = join(homedir(), '.cargo', 'bin');
  return [process.env.PATH ?? '', ...(existsSync(cargoBin) ? [cargoBin] : [])].join(delimiter);
};

/** The file in `dir` whose name ends in `end` (a bundle Tauri built), if there is one. */
export const endingIn = (dir: string, end: string) => {
  const f = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(end));
  return f ? join(dir, f) : undefined;
};

/**
 * The folder scratch Obeyas keep their dirs and port claims in: /tmp on macOS and Linux, as docs
 * and demos name it; on Windows the system temp folder, since Bun reads /tmp there as \tmp on the
 * current drive, which a fresh machine does not have.
 */
export const scratchBase = (platform: NodeJS.Platform = process.platform, temp = tmpdir()) => (platform === 'win32' ? temp : '/tmp');

/** The name of a scratch Obeya's dir in `scratchBase()`, with its port as the one group. */
export const SCRATCH_NAME = /^obeya-scratch-(\d+)$/;

/** The dir a scratch Obeya on `port` is staged in when its stage gives none. */
export const scratchDir = (port: number) => join(scratchBase(), `obeya-scratch-${port}`);
