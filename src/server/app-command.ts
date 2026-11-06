// A command of the `app` of a repository's settings (`stop`, `keep`), run in a workspace by Obeya itself (design: Parking).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { remote, sh } from './hosts';
import { messageOf } from '../core/text';
import { spawnOutput } from './spawn';

/** An app's stop takes seconds; one that hangs this long counts as failed. */
const APP_TIMEOUT = 2 * 60_000;

/**
 * The files `command` names by a relative path (`.obeya/app.mjs` of `node .obeya/app.mjs stop`),
 * up to its first shell operator: what it runs or reads in the workspace.
 */
export function namedFiles(command: string): string[] {
  const words = command.split(/\s+/);
  const end = words.findIndex((w) => /^(&&|\|\||;|\||&|[0-9]?>>?|<)$/.test(w));
  return words
    .slice(0, end < 0 ? undefined : end)
    .map((w) => w.replace(/^["']|["']$/g, ''))
    .filter((w) => /[\\/]/.test(w) && !/^[-~$%]|^[a-zA-Z]:|^[\\/]|:\/\/|[=*?{}`;&|<>]/.test(w));
}

/**
 * Runs `command` through the platform's shell in `cwd` (there, for a workspace on another machine):
 * whether it exited 0, and what it printed. A file it names that the workspace lacks (`missing`)
 * means its branch is older than the command (the script came into the repository later): nothing
 * of it can run there, so there is nothing to stop, and the command does not run.
 */
export async function runAppCommand(cwd: string, command: string, timeout = APP_TIMEOUT): Promise<{ ok: boolean; output: string; missing?: string }> {
  const files = namedFiles(command);
  const there = remote(cwd);
  if (there) {
    if (files.length) {
      const r = await there.host.run(`for f in ${files.map(sh).join(' ')}; do [ -e "$f" ] || echo "$f"; done`, { cwd: there.path, timeout });
      const missing = r.code === 0 ? r.stdout.split('\n')[0]!.trim() : '';
      if (missing) return { ok: true, output: '', missing };
    }
    const r = await there.host.run(command, { cwd: there.path, timeout });
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() || (r.code === 0 ? '' : `exit code ${r.code}`) };
  }
  const missing = files.find((f) => !existsSync(join(cwd, f)));
  if (missing) return { ok: true, output: '', missing };
  const shell = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['sh', '-c', command];
  try {
    const r = await spawnOutput(shell, { cwd, stdin: 'ignore', timeout });
    return { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() || (r.code === 0 ? '' : r.signal ? `stopped (${r.signal})` : `exit code ${r.code}`) };
  } catch (e) {
    return { ok: false, output: messageOf(e) };
  }
}
