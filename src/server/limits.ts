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
  private held = new Map<Harness, HarnessLimit>();
  private timers = new Map<Harness, ReturnType<typeof setTimeout>>();

  /** A turn on `harness` stopped at its limit, which holds until `until`. */
  hit(harness: Harness, until: number, outage = false) {
    const before = this.held.get(harness);
    this.held.set(harness, { until, ...(outage ? { outage: true as const } : {}) });
    clearTimeout(this.timers.get(harness));
    const timer = setTimeout(() => this.lifted(harness), Math.max(0, until - Date.now()));
    timer.unref?.();
    this.timers.set(harness, timer);
    if (!before || before.until !== until || !!before.outage !== outage) this.emit();
  }

  /** An agent on `harness` works: whatever held it has lifted. */
  lifted(harness: Harness) {
    clearTimeout(this.timers.get(harness));
    this.timers.delete(harness);
    if (this.held.delete(harness)) this.emit();
  }

  /** The limit `harness` is at now, if any. */
  of(harness: Harness): HarnessLimit | undefined {
    const l = this.held.get(harness);
    return l && l.until > Date.now() ? l : undefined;
  }

  /** Something that decides what runs where changed (the owner saved a fallback): who waits looks again. */
  changed() {
    this.emit();
  }
}
