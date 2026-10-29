// The usage limits of the Claude plan Claude Code is logged in with on this machine (the five-hour
// session, the week, a model's week), for the bar while the owner has it show them (the settings'
// `usageMeter`) and a page of Obeya's is open. They come from the data behind Claude Code's
// `/usage`, which asks the plan's usage endpoint: one idle Claude Code session is asked about every
// minute and sends no prompt, so it uses none of what it reports. The session keeps an answer for a
// minute, so the rounds are a little longer apart and each gets a fresh one. A login without plan
// limits (an API key, a cloud provider) and a Claude Code too old to answer show nothing.

import { query, type SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { Usage, UsageLimit } from '../core/types';
import { claudeExecutable, cleanEnv, spawnHere } from './runtime';

/** How often the limits are fetched while the bar shows them: just over the minute Claude Code keeps an answer. */
export const USAGE_EVERY_MS = 65_000;
/** A fetch that has not answered after this long is given up, its session with it. */
const FETCH_TIMEOUT_MS = 30_000;
/** The most rounds left out after failures one after the other: a try every quarter of an hour or so. */
const MAX_SKIPPED = 14;
/** Limits not fetched again for this long (Claude Code failing meanwhile) are no longer shown. */
const STALE_MS = 5 * 60_000;
/** How long the session and its numbers outlast the last page: a reload or a switch to another canvas opens the next one sooner. */
export const USAGE_LINGER_MS = 30_000;

/** Where the limits come from: asked again each round, closed once the bar no longer shows them. */
export interface UsageSource {
  /** The limits now; `null` where the login has none. Throws when it could not ask. */
  fetch(): Promise<Usage | null>;
  close(): void;
}

/**
 * The limits for the bar: fetched now and every `everyMs` while the owner has the bar show them
 * (`setOn`) and a page is open (`watch`), from a source started for that and closed once neither
 * holds, a page closed `lingerMs` ago still counting as open (the page a reload or another canvas
 * opens next shows the numbers at once, without a session started anew). A source that fails is closed, and a later round starts a new one, after more rounds the
 * more often it failed (a Claude Code too old to answer would otherwise start a session a minute);
 * what it fetched last stands meanwhile, for a few minutes.
 */
export class UsageMeter {
  private last: Usage | null = null;
  private listeners = new Set<() => void>();
  private watchers = 0;
  private on: boolean;
  private source: UsageSource | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private fetching = false;
  /** Rounds failed one after the other, and how many rounds to leave out before the next try. */
  private failures = 0;
  private skip = 0;
  /** Pages closed less than `lingerMs` ago, each still counted among the watchers. */
  private leaving = new Set<ReturnType<typeof setTimeout>>();
  private readonly everyMs: number;
  private readonly lingerMs: number;

  constructor(
    private open: () => UsageSource,
    o: { on?: boolean; everyMs?: number; lingerMs?: number } = {},
  ) {
    this.on = !!o.on;
    this.everyMs = o.everyMs ?? USAGE_EVERY_MS;
    this.lingerMs = o.lingerMs ?? USAGE_LINGER_MS;
  }

  /** Whether the owner has the bar show the limits. */
  setOn(on: boolean) {
    this.on = on;
    this.update();
  }

  /** A page is open; returns what tells the meter it closed. */
  watch(): () => void {
    this.watchers++;
    this.update();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const leave = setTimeout(() => {
        this.leaving.delete(leave);
        this.watchers--;
        this.update();
      }, this.lingerMs);
      leave.unref?.();
      this.leaving.add(leave);
    };
  }

  /** The limits as last fetched, while the bar shows them. */
  current(): Usage | null {
    return this.last;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fetches the limits now, unless a fetch is under way or the bar does not show them. */
  async refresh(): Promise<void> {
    if (!this.running() || this.fetching) return;
    this.fetching = true;
    const source = (this.source ??= this.open());
    try {
      const usage = await withTimeout(source.fetch(), FETCH_TIMEOUT_MS);
      if (this.source === source) this.set(usage);
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.skip = Math.min(2 ** (this.failures - 1) - 1, MAX_SKIPPED);
      console.warn(`Obeya: the usage limits could not be fetched: ${e instanceof Error ? e.message : e}`);
      // a new session next round; what was fetched last stands a little longer
      if (this.source === source) this.source = null;
      source.close();
      if (this.last && Date.now() - Date.parse(this.last.at) > STALE_MS) this.set(null);
    } finally {
      this.fetching = false;
    }
  }

  /** Stops fetching for good: the server stops. */
  stop() {
    for (const leave of this.leaving) clearTimeout(leave);
    this.leaving.clear();
    this.on = false;
    this.update();
  }

  private running() {
    return this.on && this.watchers > 0;
  }

  private update() {
    if (this.running()) {
      if (this.timer) return;
      this.timer = setInterval(() => (this.skip > 0 ? this.skip-- : void this.refresh()), this.everyMs);
      this.timer.unref?.();
      void this.refresh();
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.source?.close();
    this.source = null;
    // numbers from before would show as now once a page opens again
    this.set(null);
  }

  private set(usage: Usage | null) {
    if (JSON.stringify(usage) === JSON.stringify(this.last)) return;
    this.last = usage;
    for (const fn of this.listeners) fn();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * An idle Claude Code session in `cwd` that is asked for the `/usage` data: without the owner's
 * settings, hooks and MCP servers, which it needs none of, and without a prompt.
 */
export function claudeUsage(cwd: string): UsageSource {
  const abort = new AbortController();
  // the session waits for a prompt that never comes, until it is closed
  const idle = (async function* () {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  })();
  const claude = claudeExecutable();
  const q = query({
    prompt: idle as AsyncIterable<never>,
    options: {
      cwd,
      abortController: abort,
      settingSources: [],
      env: cleanEnv(),
      ...(claude ? { pathToClaudeCodeExecutable: claude } : {}),
      spawnClaudeCodeProcess: spawnHere(() => {}),
    },
  });
  // what the session says unasked (its start, say) is not needed
  void (async () => {
    try {
      for await (const _ of q);
    } catch {}
  })();
  return {
    fetch: async () => usageOf(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })),
    close: () => abort.abort(),
  };
}

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;
/** A meter of the endpoint's `limits`, as Claude Code passes it on. */
type Row = { kind?: unknown; group?: unknown; percent?: unknown; resets_at?: unknown; severity?: unknown; scope?: { model?: { display_name?: unknown } | null; surface?: { display_name?: unknown } | null } | null };

/**
 * The limits of a `/usage` answer: the endpoint's meters as it sends them (which apply, their order
 * and grade are its own), or from a Claude Code that does not pass those on yet, its five-hour,
 * weekly and per-model windows. `null` where the login has no plan limits.
 */
export function usageOf(r: SDKControlGetUsageResponse, now = new Date()): Usage | null {
  const plan = r.rate_limits;
  if (!r.rate_limits_available || !plan) return null;
  const at = now.toISOString();
  const rows = (plan as { limits?: unknown }).limits;
  if (Array.isArray(rows)) {
    const limits = (rows as Row[]).flatMap((row): UsageLimit[] => {
      if (typeof row.kind !== 'string' || typeof row.percent !== 'number') return [];
      const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
      return [
        {
          kind: row.kind,
          group: typeof row.group === 'string' ? row.group : row.kind,
          ...(typeof scope === 'string' && scope ? { scope } : {}),
          percent: row.percent,
          ...(typeof row.resets_at === 'string' ? { resetsAt: row.resets_at } : {}),
          severity: typeof row.severity === 'string' ? row.severity : 'normal',
        },
      ];
    });
    return { limits, at };
  }
  const window = (kind: string, group: string, w: Window, scope?: string): UsageLimit[] =>
    w && typeof w.utilization === 'number'
      ? [{ kind, group, ...(scope ? { scope } : {}), percent: w.utilization, ...(w.resets_at ? { resetsAt: w.resets_at } : {}), severity: 'normal' }]
      : [];
  return {
    limits: [
      ...window('session', 'session', plan.five_hour),
      ...window('weekly_all', 'weekly', plan.seven_day),
      ...(plan.model_scoped ?? []).flatMap((m) => window('weekly_scoped', 'weekly', m, m.display_name)),
    ],
    at,
  };
}
