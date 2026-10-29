// Putting a new build of the app's shell where the installed one is, also while that one runs (a
// shell installed from a checkout installs its own new build, scripts/app.ts).
//
// On a Mac the bundle of a shell that still runs is moved aside, never removed: the system decides
// on the microphone by the file the running program was started from, and with that file gone it
// denies it, so the window got no sound from it until the app started again (2026-10-29). An aside is
// removed by a later install once nothing has it open any more.

import { copyFileSync, chmodSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Puts `from` at `to` in one step for whoever starts it, also while the app at `to` runs: copied beside it first, then renamed into its place. */
export function replace(from: string, to: string, inUse: (dir: string) => boolean = opened) {
  const fresh = `${to}.new`;
  rmSync(fresh, { recursive: true, force: true });
  // ditto keeps the bundle's signature and extended attributes as they are
  const copy = process.platform === 'darwin' ? Bun.spawnSync(['ditto', from, fresh]).exitCode === 0 : (copyFileSync(from, fresh), true);
  if (!copy) throw new Error(`could not copy ${from}`);
  if (process.platform === 'darwin') {
    // a directory does not rename over another: the old one goes aside first, under a name of its own
    // (a bundle aside from an earlier install may still run); a name that does not end in .app is no app to the system
    if (existsSync(to)) renameSync(to, `${to}.old-${Date.now().toString(36)}`);
    renameSync(fresh, to);
    for (const old of asides(to)) if (!inUse(old)) rmSync(old, { recursive: true, force: true });
  } else if (process.platform === 'win32') {
    // Windows renames a running program but does not overwrite it
    const old = to.replace(/\.exe$/, '.old.exe');
    rmSync(old, { force: true });
    if (existsSync(to)) renameSync(to, old);
    renameSync(fresh, to);
    try {
      rmSync(old, { force: true });
    } catch {
      // still running: the next install removes it
    }
  } else {
    // the running program keeps the file it was started from, which the rename only unlinks
    chmodSync(fresh, 0o755);
    renameSync(fresh, to);
  }
}

/** The bundles earlier installs moved aside from `to`. */
export function asides(to: string): string[] {
  const dir = dirname(to);
  const name = `${basename(to)}.old`;
  return readdirSync(dir)
    .filter((f) => f === name || f.startsWith(`${name}-`))
    .map((f) => join(dir, f));
}

/** Whether a process has a file in `dir` open (a shell started from it, its program); yes when there is no lsof to ask. */
function opened(dir: string): boolean {
  try {
    return Bun.spawnSync(['lsof', '-t', '+D', dir], { stderr: 'ignore' }).stdout.toString().trim() !== '';
  } catch {
    return true;
  }
}
