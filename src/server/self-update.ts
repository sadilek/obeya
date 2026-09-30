// Obeya on its own checkout: work that lands there changes the code this very process runs. The
// supervisor in main.ts starts the server again when it exits with RESTART; this module tells
// when that is due.

import { dirname } from 'node:path';

/** The exit code that asks the supervisor for a fresh server. */
export const RESTART = 75;

/** Paths whose change leaves the running code as it is. */
const INERT = /(^docs\/|^design\/|\.md$)/;

const git = (cwd: string, ...args: string[]): string | null => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'ignore' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

/** The git checkout this process's code comes from, if it is one. */
export function ownCheckout(): string | null {
  return git(dirname(import.meta.path), 'rev-parse', '--show-toplevel');
}

/**
 * Calls `fn` once when the checkout's HEAD has moved to commits that change code (not only docs),
 * after HEAD has held still for one interval, so a landing in progress finishes first.
 */
export function watchOwnCode(checkout: string, fn: (from: string, to: string) => void, intervalMs = 2000): () => void {
  const start = git(checkout, 'rev-parse', 'HEAD');
  if (!start) return () => {};
  let seen = start;
  let base = start;
  const timer = setInterval(() => {
    const head = git(checkout, 'rev-parse', 'HEAD');
    if (!head) return;
    if (head !== seen) {
      seen = head;
      return;
    }
    if (head === base) return;
    const changed = git(checkout, 'diff', '--name-only', base, head);
    if (changed !== null && changed.split('\n').every((f) => !f || INERT.test(f))) {
      base = head;
      return;
    }
    clearInterval(timer);
    fn(base, head);
  }, intervalMs);
  return () => clearInterval(timer);
}
