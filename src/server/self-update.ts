// Obeya on its own checkout: work that lands there changes the code this very process runs. The
// supervisor in main.ts starts the server again when it exits with RESTART; this module tells
// when that is due, and installs what the new code depends on before it goes. Stopping Obeya
// (Ctrl-C, SIGTERM) waits for the workers the same way, and then nothing starts again; so does
// installing a new version of the app, after which the app's shell starts it again (UPDATE).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inert } from '../core/inert';
import type { OwnerHold, RestartReason } from '../core/types';
import { gitDirs } from './read-tree';
import { COMPILED } from './resources';
import { gitAsync, gitOrNull } from './workspaces';

/** The exit code that asks the supervisor for a fresh server. */
export const RESTART = 75;
/** The same, and from now on with the configuration file rather than the command line's repositories. */
export const RESTART_FROM_FILE = 76;
/** The server ended for the app's shell to install a new version of the app and start it again (app/src/update.rs). */
export const UPDATE = 77;
/** The server ended for the app's shell to start it again under itself (app/src/main.rs, `orphaned`). */
export const TAKEOVER = 78;

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
  /** Stops the server so that it starts again, or for good when the reason is `stop`, or for the app to be updated. */
  go: (reason: RestartReason) => void;
  /** What the owner did that the server itself finishes first, whether or not a page is open: commands in their undo window. */
  held?: () => OwnerHold[];
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
  private updating = false;
  private taking = false;
  private gone = false;
  private stopWaiting = () => {};
  private listeners = new Set<() => void>();
  /** What the owner does in each open page (by connection), as the page last said, and in each request the server answers. */
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

  /** What the owner does in the open page `page` (or a request the server answers) that a restart waits for; none, or `[]`, when the page closes. */
  hold(page: string, what: OwnerHold[] = []) {
    if (what.length) this.holds.set(page, what);
    else this.holds.delete(page);
    const owner = this.owner();
    if (this.current && owner.join() !== this.current.owner.join()) {
      this.current = { ...this.current, owner };
      this.emit();
    }
  }

  /**
   * Asks for a restart; one that is due already covers the next reason too, and turns into an
   * update when asked for one (the update restarts too), into a takeover by the app (which starts
   * it again), or into a stop (nothing starts again).
   */
  request(reason: RestartReason) {
    if (this.gone) return;
    if (reason === 'stop') this.stopping = true;
    if (reason === 'update' && !this.stopping) this.updating = true;
    if (reason === 'takeover') this.taking = true;
    if (this.current) {
      if (reason === 'stop' && this.current.reason !== 'stop') {
        this.current = { ...this.current, reason, owner: [] };
        this.emit();
      } else if (OUTRANKS[reason] > OUTRANKS[this.current.reason]) {
        this.current = { ...this.current, reason };
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
        const owner = this.owner();
        if ((key(now) !== key(waiting) || owner.join() !== this.current?.owner.join()) && this.current) {
          waiting = now;
          this.current = { ...this.current, waiting, owner };
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

  /** What the owner does that a restart waits for: watching a demo video, dictating; nothing while Obeya stops. */
  owner(): OwnerHold[] {
    if (this.stopping) return [];
    const all = new Set([...this.holds.values(), this.o.held?.() ?? []].flat());
    return (['video', 'voice'] as const).filter((h) => all.has(h));
  }

  private go(reason: RestartReason) {
    if (this.gone) return;
    this.gone = true;
    this.stopWaiting();
    this.current = null;
    this.o.go(this.stopping ? 'stop' : this.updating ? 'update' : this.taking ? 'takeover' : reason);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Which reason a restart that is due turns into when asked for another: the one that ends more of this server. */
const OUTRANKS: Record<RestartReason, number> = { code: 0, config: 0, repository: 0, takeover: 1, update: 2, stop: 3 };

const key = (b: Busy[]) => b.map((x) => `${x.canvas}/${x.card}`).join(' ');

/** Whether the commits from `from` to `to` change code, not only docs (unknown counts as code); without the server waiting for git. */
export async function changesCode(checkout: string, from: string, to: string): Promise<boolean> {
  const changed = await gitAsync(checkout, 'diff', '--name-only', from, to).catch(() => null);
  return changed === null || changed.split('\n').some((f) => f && !inert(f));
}

/** The commit `checkout` stands at, if it is a git checkout. */
export function headOf(checkout: string): string | null {
  return gitOrNull(checkout, 'rev-parse', 'HEAD');
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
  const changed = gitOrNull(checkout, 'diff', '--name-only', from, 'HEAD', '--', 'package.json', 'bun.lock');
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
  return gitOrNull(dirname(import.meta.path), 'rev-parse', '--show-toplevel');
}

/**
 * Calls `fn` once (again the next round where it threw) when the checkout's HEAD has moved from
 * `start` (the commit the server's code came from) to commits that change code (not only docs),
 * after HEAD has held still for one interval, so a landing in progress finishes first. Each round takes the seal of what HEAD stands
 * on (`headSeal`) and asks git only once it changed: on Windows, starting a process holds up the
 * server from 50 ms to over a second on a busy machine, even started without waiting for it, and
 * every two seconds that held up every request it answers. `afterRound` hears of each round ended.
 */
export function watchOwnCode(checkout: string, start: string, fn: (from: string, to: string) => void, intervalMs = 2000, afterRound?: () => void): () => void {
  // HEAD as last read, and the seal it was read under; none yet, so the first round asks git: HEAD
  // may have moved since the server started
  let read: { seal: string | null; head: string } = { seal: null, head: start };
  /** HEAD now: as last read while its seal holds, else from git (null where git failed). */
  const look = async (): Promise<string | null> => {
    // the seal is taken before git is asked, so a move between the two is seen next round
    const seal = headSeal(checkout);
    if (seal !== null && seal === read.seal) return read.head;
    const head = await gitAsync(checkout, 'rev-parse', 'HEAD').catch(() => null);
    if (head) read = { seal, head };
    return head;
  };
  let seen = start;
  let base = start;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // the next round starts an interval after this one ended, so two never run at once; whatever
  // a round throws, the next one comes all the same
  const round = async () => {
    let done = false;
    try {
      const head = await look();
      if ((done = stopped)) return;
      if (head && head !== seen) seen = head;
      else if (head && head !== base) {
        const code = await changesCode(checkout, base, head);
        // a commit while git diffed has not held still for a round (it may be a landing under way): the next round tells
        const still = code && (await look()) === head;
        if ((done = stopped)) return;
        // done once fn went through: one that threw restarted nothing, so the next round calls it again
        if (still) {
          fn(base, head);
          done = true;
          return;
        }
        if (!code) base = head;
      }
      afterRound?.();
    } catch (e) {
      console.error('Obeya: watching for new code:', e);
    } finally {
      if (!done) timer = setTimeout(round, intervalMs);
    }
  };
  timer = setTimeout(round, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The refs each worktree keeps of its own, in its own git directory; the others are in the one they share. */
const OWN_REFS = ['refs/worktree/', 'refs/bisect/', 'refs/rewritten/'];

/**
 * A seal of what the checkout's HEAD stands on, taken without git, by a few `stat`s: HEAD, each ref
 * it names on the way to a commit (a branch may name another branch), each by the file git wrote it
 * in last (git writes a ref anew beside it, then renames it into place), and the packed refs. While
 * it is the same, so is HEAD. Null where it cannot be told (refs in a reftable, no git directory
 * found, a symbolic ref whose target cannot be read safely): git tells HEAD then.
 */
export function headSeal(checkout: string): string | null {
  const dirs = gitDirs(checkout);
  if (!dirs || existsSync(join(dirs.common, 'reftable'))) return null;
  const seal: string[] = [];
  const at = (path: string) => {
    const s = statSync(path, { bigint: true, throwIfNoEntry: false });
    seal.push(`${path} ${s ? `${s.ino}:${s.size}:${s.mtimeNs}` : '-'}`);
    return s;
  };
  try {
    at(join(dirs.common, 'packed-refs'));
    let ref = 'HEAD';
    // a few steps at most: refs that name each other in a circle stop git as well
    for (let step = 0; step < 5; step++) {
      const path = join(ref === 'HEAD' || OWN_REFS.some((r) => ref.startsWith(r)) ? dirs.own : dirs.common, ref);
      // a ref without a file of its own is in the packed refs, or has no commit yet
      if (!at(path)) return seal.join('\n');
      const text = readFileSync(path, 'utf8');
      // a commit, or what git would not take for a ref either
      if (!text.startsWith('ref:')) return seal.join('\n');
      const target = symbolicTarget(text);
      if (!target) return null;
      ref = target;
    }
  } catch {
    // a ref that cannot be read (a directory in its place, say)
  }
  return null;
}

/**
 * The ref a symbolic ref's file (`ref: refs/heads/main`) names, read as git reads it: the rest of
 * the file without the whitespace git trims around it, so a name with other whitespace in it (a
 * no-break space) stays whole. Null for a target outside `refs/`, one git-check-ref-format refuses
 * (which keeps it a path inside the git directory), and one that is no valid UTF-8.
 */
export function symbolicTarget(text: string): string | null {
  const target = text.slice('ref:'.length).replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
  if (!target.startsWith('refs/') || target.includes('\uFFFD')) return null;
  // control characters, space and ~^:?*[\ ; "..", "@{", "//"; a part starting with "." or ending in ".lock"; a "." or "/" at the end
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|(^|\/)\.|\.lock(\/|$)|[./]$/.test(target)) return null;
  return target;
}
