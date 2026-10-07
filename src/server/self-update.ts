// Obeya on its own checkout: work that lands there changes the code this very process runs. The
// supervisor in main.ts starts the server again when it exits with RESTART; this module tells
// when that is due, and installs what the new code depends on before it goes. Stopping Obeya
// (Ctrl-C, SIGTERM) waits for the workers the same way, and then nothing starts again.

import { dirname } from 'node:path';
import type { OwnerHold, RestartReason } from '../core/types';
import { COMPILED } from './resources';
import { GIT } from './workspaces';

/** The exit code that asks the supervisor for a fresh server. */
export const RESTART = 75;
/** The same, and from now on with the configuration file rather than the command line's repositories. */
export const RESTART_FROM_FILE = 76;

/** How long a restart waits for workers to finish their turns before it cuts them off. */
export const RESTART_PATIENCE_MS = 15 * 60_000;

/**
 * Calls `fn` once `busy` is false, or after `patienceMs` whatever it says; never while `held` (the
 * owner watching a video, say), which has no deadline.
 */
export function whenIdle(busy: () => boolean, fn: () => void, patienceMs = RESTART_PATIENCE_MS, intervalMs = 2000, held: () => boolean = () => false): () => void {
  const deadline = Date.now() + patienceMs;
  const check = () => {
    // both are asked every time: `busy` and `held` keep what the restart shows current
    const b = busy();
    if (held() || (b && Date.now() < deadline)) return;
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

/** A restart that is due and waits for the workers it would cut off, and for the owner. */
export interface Due {
  reason: RestartReason;
  since: number;
  deadline: number;
  waiting: Busy[];
  owner: OwnerHold[];
}

export interface RestarterOptions {
  /** The workers in the middle of a turn. */
  busy: () => Busy[];
  /** Stops the server so that it starts again, or for good when the reason is `stop`. */
  go: (reason: RestartReason) => void;
  patienceMs?: number;
  intervalMs?: number;
}

/**
 * Starts the server again once no worker is in the middle of a turn (`whenIdle`) and the owner
 * neither watches a demo video nor dictates in an open page, and tells while it waits: for whom,
 * and until when at most. The owner can have it go ahead at once. A stop waits for the workers
 * alone: the owner asked for it, and a page left playing a video does not hold it off.
 */
export class Restarter {
  private current: Due | null = null;
  private stopping = false;
  private gone = false;
  private stopWaiting = () => {};
  private listeners = new Set<() => void>();
  /** What the owner does in each open page (by connection), as the page last said. */
  private holds = new Map<string, OwnerHold[]>();

  constructor(private o: RestarterOptions) {}

  /** The restart that waits, if one does. */
  due(): Due | null {
    return this.current;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What the owner does in the open page `page` that a restart waits for; none, or `[]`, when the page closes. */
  hold(page: string, what: OwnerHold[] = []) {
    if (what.length) this.holds.set(page, what);
    else this.holds.delete(page);
    const owner = this.owner();
    if (this.current && owner.join() !== this.current.owner.join()) {
      this.current = { ...this.current, owner };
      this.emit();
    }
  }

  /** Asks for a restart; one that is due already covers the next reason too, and turns into a stop when asked for one. */
  request(reason: RestartReason) {
    if (this.gone) return;
    if (reason === 'stop') this.stopping = true;
    if (this.current) {
      if (reason === 'stop' && this.current.reason !== 'stop') {
        this.current = { ...this.current, reason, owner: [] };
        this.emit();
      }
      return;
    }
    const patience = this.o.patienceMs ?? RESTART_PATIENCE_MS;
    const since = Date.now();
    let waiting = this.o.busy();
    const owner = this.owner();
    if (!waiting.length && !owner.length) return this.go(reason);
    this.current = { reason, since, deadline: since + patience, waiting, owner };
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
      () => this.go(reason),
      patience,
      this.o.intervalMs,
      () => this.owner().length > 0,
    );
  }

  /** Goes ahead with the restart that waits, cutting off the workers it waits for; false when none waits. */
  now(): boolean {
    if (!this.current) return false;
    this.go(this.current.reason);
    return true;
  }

  private owner(): OwnerHold[] {
    if (this.stopping) return [];
    const all = new Set([...this.holds.values()].flat());
    return (['video', 'voice'] as const).filter((h) => all.has(h));
  }

  private go(reason: RestartReason) {
    if (this.gone) return;
    this.gone = true;
    this.stopWaiting();
    this.current = null;
    this.o.go(this.stopping ? 'stop' : reason);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

const key = (b: Busy[]) => b.map((x) => `${x.canvas}/${x.card}`).join(' ');

/** Paths whose change leaves the running code as it is: docs, the site for obeya.si and its workflow. */
const INERT = /(^docs\/|^design\/|^site\/|^\.github\/|\.md$)/;

const git = (cwd: string, ...args: string[]): string | null => {
  const r = Bun.spawnSync([GIT, '-C', cwd, ...args], { stderr: 'ignore' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

/** Whether the commits from `from` to `to` change code, not only docs (unknown counts as code). */
export function changesCode(checkout: string, from: string, to: string): boolean {
  const changed = git(checkout, 'diff', '--name-only', from, to);
  return changed === null || changed.split('\n').some((f) => f && !INERT.test(f));
}

/** The commit `checkout` stands at, if it is a git checkout. */
export function headOf(checkout: string): string | null {
  return git(checkout, 'rev-parse', 'HEAD');
}

/** What installing the dependencies before a restart came to. */
export type Install = { ran: false } | { ran: true; ok: boolean; output: string };

const INSTALL = [process.execPath, 'install', '--frozen-lockfile'];

/**
 * Installs the checkout's dependencies when the commits from `from` to where it stands now change
 * package.json or bun.lock (unknown counts as changed), so the new code finds what it imports.
 * Never throws: a failed install is for the log, and the restart goes ahead anyway.
 */
export function installDependencies(checkout: string, from: string, command = INSTALL): Install {
  const changed = git(checkout, 'diff', '--name-only', from, 'HEAD', '--', 'package.json', 'bun.lock');
  if (changed === '') return { ran: false };
  try {
    const r = Bun.spawnSync(command, { cwd: checkout, stdout: 'pipe', stderr: 'pipe' });
    return { ran: true, ok: r.exitCode === 0, output: (r.stdout.toString() + r.stderr.toString()).trim() };
  } catch (e) {
    return { ran: true, ok: false, output: String(e) };
  }
}

/** The git checkout this process's code comes from, if it is one; the compiled binary comes from none. */
export function ownCheckout(): string | null {
  if (COMPILED) return null;
  return git(dirname(import.meta.path), 'rev-parse', '--show-toplevel');
}

/**
 * Calls `fn` once when the checkout's HEAD has moved to commits that change code (not only docs),
 * after HEAD has held still for one interval, so a landing in progress finishes first.
 */
export function watchOwnCode(checkout: string, fn: (from: string, to: string) => void, intervalMs = 2000): () => void {
  const start = headOf(checkout);
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
