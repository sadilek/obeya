// A command of the `app` of a repository's settings (`stop`, `keep`), run in a workspace by Obeya itself (design: Parking).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { remote, sh } from './hosts';
import { messageOf } from '../core/text';
import { spawnOutput } from './spawn';
import { commandWords, programName, RUNTIMES, SHELLS } from './folder-processes';

/** An app's stop takes seconds; one that hangs this long counts as failed. */
const APP_TIMEOUT = 2 * 60_000;

/** The flags after which a runtime or shell runs no script of a file: code to run (`-e`, `-c`) or a module (`python -m`). */
const NO_SCRIPT = new Set(['-c', '-e', '-p', '-m', '--eval', '--print', '/c', '/k', '-command', '-encodedcommand']);

/** A runtime's or shell's flags that take the next word (`node --require ./setup.js stop.mjs`): not its script. */
const OPERANDS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--title', '-C', '--conditions', '--env-file', '-W', '-X', '-cp', '-classpath', '--class-path', '--init-file', '--rcfile', '-o', '-O']);

/**
 * The script `command` runs, where it names one by a relative path: the program itself
 * (`./scripts/stop.sh`), or what a runtime or shell runs (`.obeya/app.mjs` of `node .obeya/app.mjs stop`).
 * Only that: the other words may be anything (`curl localhost:3000/stop`, a log file the command
 * writes, `kill $(cat .run/app.pid)`), so a missing one says nothing.
 */
export function scriptOf(command: string): string | null {
  const words = commandWords(command);
  const end = words.findIndex((w) => /^(&&|\|\||;|\||&|[0-9]?>>?|<)$/.test(w));
  const [program, ...args] = words.slice(0, end < 0 ? undefined : end);
  if (!program) return null;
  const relative = (w: string) => !/^[-~$%]|^[a-zA-Z]:|^[\\/]|:|[=*?{}()`$;&|<>]/.test(w);
  if (/[\\/]/.test(program) && relative(program)) return program;
  const name = programName(program);
  if (!RUNTIMES.has(name) && !SHELLS.has(name)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // `--eval=…` as `--eval …`
    if (NO_SCRIPT.has(a.split('=')[0]!.toLowerCase())) return null;
    if (OPERANDS.has(a)) i++;
    if (a.startsWith('-')) continue;
    // a script by its path or its name (`node stop.mjs`), not a subcommand (`bun run stop`, `deno task stop`)
    return relative(a) && (/[\\/]/.test(a) || /\.[a-z]{1,4}$/i.test(a)) ? a : null;
  }
  return null;
}

/**
 * Runs `command` through the platform's shell in `cwd` (there, for a workspace on another machine):
 * whether it exited 0, and what it printed. A script it runs that the workspace lacks (`missing`,
 * `scriptOf`) means its branch is older than the command (the script came into the repository
 * later): nothing of it can run there, so there is nothing to stop, and the command does not run.
 */
export async function runAppCommand(cwd: string, command: string, timeout = APP_TIMEOUT): Promise<{ ok: boolean; output: string; missing?: string }> {
  const script = scriptOf(command);
  const there = remote(cwd);
  if (there) {
    if (script) {
      const r = await there.host.run(`[ -e ${sh(script)} ] || echo missing`, { cwd: there.path, timeout });
      if (r.code === 0 && r.stdout.trim() === 'missing') return { ok: true, output: '', missing: script };
    }
    const r = await there.host.run(command, { cwd: there.path, timeout });
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() || (r.code === 0 ? '' : `exit code ${r.code}`) };
  }
  if (script && !existsSync(join(cwd, script))) return { ok: true, output: '', missing: script };
  const shell = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
  try {
    const r = await spawnOutput(shell, { cwd, stdin: 'ignore', timeout });
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() || (r.code === 0 ? '' : r.signal ? `stopped (${r.signal})` : `exit code ${r.code}`) };
  } catch (e) {
    return { ok: false, output: messageOf(e) };
  }
}
