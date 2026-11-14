// Which harness is at its usage limit (or cannot be reached) on this machine right now, as the
// agents' turns found out: one stopped by the limit says until when, one that works again says it
// lifted. Shared by all canvases, so a group's fallback (`AgentSetting.fallback`) takes over for
// every agent that starts while the limit holds, not only for the one that ran into it.

import type { Harness } from '../core/agents';
import { Listeners } from '../core/watched';

/** A harness's limit as last heard of: until when it holds (milliseconds), and whether it is an outage rather than the usage limit. */
export interface HarnessLimit {
  until: number;
  outage?: true;
}

export class HarnessLimits extends Listeners {
  /** By harness on this machine, or on a host (`<host> <harness>`), whose logins are its own. */
  private held = new Map<string, HarnessLimit>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** A turn on `harness` (on `host`, else here) stopped at its limit, which holds until `until`. */
  hit(harness: Harness, until: number, outage = false, host?: string | null) {
    const key = keyOf(harness, host);
    const before = this.held.get(key);
    this.held.set(key, { until, ...(outage ? { outage: true as const } : {}) });
    clearTimeout(this.timers.get(key));
    // a timer runs at most about 24 days
    const timer = setTimeout(() => this.lifted(harness, host), Math.min(Math.max(0, until - Date.now()), 2 ** 31 - 1));
    timer.unref?.();
    this.timers.set(key, timer);
    if (!before || before.until !== until || !!before.outage !== outage) this.emit();
  }

  /** An agent on `harness` (on `host`, else here) works: whatever held it has lifted. */
  lifted(harness: Harness, host?: string | null) {
    const key = keyOf(harness, host);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (this.held.delete(key)) this.emit();
  }

  /** The limit `harness` is at now on this machine, if any. */
  of(harness: Harness): HarnessLimit | undefined {
    const l = this.held.get(keyOf(harness));
    return l && l.until > Date.now() ? l : undefined;
  }

  /** Something that decides what runs where changed (the owner saved a fallback): who waits looks again. */
  changed() {
    this.emit();
  }
}

const keyOf = (harness: Harness, host?: string | null) => (host ? `${host} ${harness}` : harness);
