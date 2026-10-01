// Obeya on its own checkout: work that lands there changes the code this very process runs. The
// supervisor in main.ts starts the server again when it exits with RESTART; this module tells
// when that is due.

import { dirname } from 'node:path';
import type { RestartReason } from '../core/types';
import { GIT } from './workspaces';

/** The exit code that asks the supervisor for a fresh server. */
export const RESTART = 75;
/** The same, and from now on with the configuration file rather than the command line's repositories. */
export const RESTART_FROM_FILE = 76;

/** How long a restart waits for workers to finish their turns before it cuts them off. */
export const RESTART_PATIENCE_MS = 15 * 60_000;

/** Calls `fn` once `busy` is false, or after `patienceMs` whatever it says. */
export function whenIdle(busy: () => boolean, fn: () => void, patienceMs = RESTART_PATIENCE_MS, intervalMs = 2000): () => void {
  const deadline = Date.now() + patienceMs;
  const check = () => {
    if (busy() && Date.now() < deadline) return;
    clearInterval(timer);
    fn();
  };
  const timer = setInterval(check, intervalMs);
  check();
  return () => clearInterval(timer);
}

/** A worker a restart waits for. */
export interface Busy {
  canvas: string;
  card: string;
}

/** A restart that is due and waits for the workers it would cut off. */
export interface Due {
  reason: RestartReason;
  since: number;
  deadline: number;
  waiting: Busy[];
}

export interface RestarterOptions {
  /** The workers in the middle of a turn. */
  busy: () => Busy[];
  /** Stops the server so that it starts again. */
  go: () => void;
  patienceMs?: number;
  intervalMs?: number;
}

/**
 * Starts the server again once no worker is in the middle of a turn (`whenIdle`), and tells while
 * it waits: for whom, and until when at most. The owner can have it go ahead at once.
 */
export class Restarter {
  private current: Due | null = null;
  private gone = false;
  private stopWaiting = () => {};
  private listeners = new Set<() => void>();

  constructor(private o: RestarterOptions) {}

  /** The restart that waits, if one does. */
  due(): Due | null {
    return this.current;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Asks for a restart; one that is due already covers the next reason too. */
  request(reason: RestartReason) {
    if (this.current || this.gone) return;
    const patience = this.o.patienceMs ?? RESTART_PATIENCE_MS;
    const since = Date.now();
    let waiting = this.o.busy();
    if (!waiting.length) return this.go();
    this.current = { reason, since, deadline: since + patience, waiting };
    this.emit();
    this.stopWaiting = whenIdle(
      () => {
        const now = this.o.busy();
        if (key(now) !== key(waiting) && this.current) {
          waiting = now;
          this.current = { ...this.current, waiting };
          this.emit();
        }
        return now.length > 0;
      },
      () => this.go(),
      patience,
      this.o.intervalMs,
    );
  }

  /** Goes ahead with the restart that waits, cutting off the workers it waits for; false when none waits. */
  now(): boolean {
    if (!this.current) return false;
    this.go();
    return true;
  }

  private go() {
    if (this.gone) return;
    this.gone = true;
    this.stopWaiting();
    this.current = null;
    this.o.go();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

const key = (b: Busy[]) => b.map((x) => `${x.canvas}/${x.card}`).join(' ');

/** Paths whose change leaves the running code as it is. */
const INERT = /(^docs\/|^design\/|\.md$)/;

const git = (cwd: string, ...args: string[]): string | null => {
  const r = Bun.spawnSync([GIT, '-C', cwd, ...args], { stderr: 'ignore' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

/** Whether the commits from `from` to `to` change code, not only docs (unknown counts as code). */
export function changesCode(checkout: string, from: string, to: string): boolean {
  const changed = git(checkout, 'diff', '--name-only', from, to);
  return changed === null || changed.split('\n').some((f) => f && !INERT.test(f));
}

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
    if (!changesCode(checkout, base, head)) {
      base = head;
      return;
    }
    clearInterval(timer);
    fn(base, head);
  }, intervalMs);
  return () => clearInterval(timer);
}
