// A scratch Obeya (scripts/scratch-obeya.ts, for a demo, a live check or a prototype) ends by
// itself (design: Scratch Obeyas): once the checkout it was staged from is gone or on another
// branch (its card's work is done, or the workspace went to another card), or once nothing has used
// it for a while: no page open, no request, no agent of its own in a turn. A demo's take or a
// worker's checks keep it, since each opens a page or calls its API.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitDirs } from './read-tree';
import { symbolicTarget } from './self-update';

/** How long a scratch Obeya nothing uses runs on (`OBEYA_SCRATCH_IDLE`, in seconds, sets another). */
export const SCRATCH_IDLE_MS = 30 * 60_000;

/** The branch `checkout` has checked out, or null where it cannot be told (a detached HEAD, no git directory). */
export function branchOf(checkout: string): string | null {
  const dirs = gitDirs(checkout);
  if (!dirs) return null;
  try {
    const head = readFileSync(join(dirs.own, 'HEAD'), 'utf8');
    return head.startsWith('ref:') ? symbolicTarget(head) : null;
  } catch {
    return null;
  }
}

export interface ScratchOptions {
  /** The checkout scripts/scratch-obeya.ts ran from. */
  checkout: string;
  idleMs?: number;
  /** How many pages are open on it now. */
  pages(): number;
  /** Whether an agent of its own is in a turn (an idle worker's card never is). */
  working(): boolean;
  /** Ends this Obeya, saying why. */
  end(why: string): void;
  now?: () => number;
}

export class ScratchEnd {
  private last: number;
  private branch: string | null;
  private timer?: ReturnType<typeof setInterval>;
  readonly idleMs: number;

  constructor(private o: ScratchOptions) {
    this.idleMs = o.idleMs ?? SCRATCH_IDLE_MS;
    this.last = this.now();
    this.branch = branchOf(o.checkout);
  }

  private now = () => (this.o.now ?? Date.now)();

  /** A request came in. */
  used() {
    this.last = this.now();
  }

  /** Why this scratch Obeya is to end now, or null while it is still of use. */
  why(): string | null {
    if (!existsSync(this.o.checkout)) return `${this.o.checkout}, which it was staged from, is gone`;
    const branch = this.branch && branchOf(this.o.checkout);
    if (branch && branch !== this.branch) return `${this.o.checkout}, which it was staged from, is on ${branch.replace(/^refs\/heads\//, '')} now`;
    // what is in use now counts as just used
    if (this.o.pages() > 0 || this.o.working()) this.used();
    const idle = this.now() - this.last;
    if (idle < this.idleMs) return null;
    const [n, unit] = idle >= 60_000 ? [Math.round(idle / 60_000), 'minute'] : [Math.round(idle / 1000), 'second'];
    return `nothing used it for ${n} ${unit}${n === 1 ? '' : 's'}`;
  }

  /** Looks every minute (sooner for a short idle time), and ends it once there is a reason. */
  start(): this {
    this.timer = setInterval(() => {
      const why = this.why();
      if (why) {
        this.stop();
        this.o.end(why);
      }
    }, Math.min(60_000, Math.max(1000, this.idleMs / 4)));
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }
}
