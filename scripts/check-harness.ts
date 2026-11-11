// What the check scripts (check-*.ts) share: one line per check, the failures counted, waiting for
// something to happen, a scratch repository, and the summary they end with.

import { type Subprocess } from 'bun';
import { spawnSync } from 'node:child_process';
import { messageOf } from '../src/core/text';
import { writeFiles } from './common';

/** How many checks failed so far; a script exits 1 when any did. */
export let failed = 0;

export const ok = (what: string, detail = '') => console.log(`✓ ${what}${detail ? `: ${detail}` : ''}`);

export const bad = (what: string, detail: string) => {
  failed++;
  console.log(`✗ ${what}: ${detail}`);
};

/** Runs one check and prints its line, with what it returned and how long it took; true when it passed. */
export const check = async (what: string, fn: () => Promise<string | void> | string | void) => {
  const started = performance.now();
  try {
    const detail = await fn();
    ok(what, [detail, `${((performance.now() - started) / 1000).toFixed(1)} s`].filter(Boolean).join(', '));
    return true;
  } catch (e) {
    bad(what, messageOf(e));
    return false;
  }
};

export const expect = (cond: unknown, why: string) => {
  if (!cond) throw new Error(why);
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What `fn` returns once it is truthy, asked every `every` ms; throws after `ms`. */
export async function until<T>(what: string, ms: number, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, every = 500): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${Math.round(ms / 1000)} s`);
    await sleep(every);
  }
}

/** The process's exit code once it ended, null when it did not within `ms`. */
export const exited = (p: Subprocess, ms: number) => Promise.race([p.exited, sleep(ms).then(() => null)]);

/** A git repository in `dir` holding `files`, committed on `main` as the checks' author. */
export function scratchRepo(dir: string, files: Record<string, string>) {
  writeFiles(dir, files);
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'init']]) {
    const r = spawnSync('git', ['-c', 'user.name=Check', '-c', 'user.email=check@example.com', '-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  }
  return dir;
}

/** Ends the script with how its checks went, and `note` when some failed: exit 1 when any did. */
export function finish(note = ''): never {
  console.log(failed ? `${failed} check(s) failed${note}` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}
