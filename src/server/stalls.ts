// Stalls: moments Obeya's server did nothing else (a synchronous git call, a long computation), so
// that no page got an answer meanwhile, and moments a page froze; each goes into the server's log
// and into `stalls.log` in the home, with where the time went (design: Running Obeya, Stalls).

import * as jsc from 'bun:jsc';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PageStall } from '../core/types';

/** A stall from this long on is logged: a pause of half a second is one the owner notices. */
export const STALL_MS = 500;
/** How often the server looks whether it was held up. */
const TICK_MS = 100;
/** A process the server waited for this long is named in the stall it falls into. */
const SLOW_PROCESS_MS = 50;
/** The places a stall names: the few where most of its time went. */
const PLACES = 3;
/** Frames of Obeya's own code a place names, innermost first. */
const FRAMES = 4;
/** `stalls.log` grows to this size, then starts afresh beside the one before (`stalls.previous.log`). */
const KEPT_BYTES = 1_000_000;
/** Below this share of the stall covered by samples, the thread did not run: the machine slept, or the process was suspended. */
const RAN_SHARE = 0.25;
/** The coarsest timer a system samples by, in ms (Windows' 15.6 ms, with room). */
const COARSEST_TIMER_MS = 20;
/** How often the profiler samples the thread's stack, in microseconds: 250 samples in the shortest stall logged. */
const SAMPLE_US = 2000;
/** A page's stalls of one kind that come no further apart than this are one run, logged together. */
const RUN_GAP_MS = 60_000;
/** A run that goes on is logged at least this often. */
const RUN_LOGGED_MS = 3600_000;
/** JavaScriptCore's line and column of a frame it knows no source position of. */
const NO_POSITION = 4294967295;

export const STALLS_FILE = 'stalls.log';

/** A stack the sampling profiler took, innermost frame first. */
export interface Trace {
  timestamp: number;
  frames: { name: string; sourceURL?: string | null; line: number; column: number }[];
}

/** A process run synchronously, and how long the server waited for it. */
export interface Waited {
  argv: string[];
  ms: number;
}

/** A frame of code, as a place names it: the function and where it is. */
function frame(f: Trace['frames'][number]): string {
  const name = f.name || '(anonymous)';
  return f.sourceURL && f.line !== NO_POSITION ? `${name} (${basename(f.sourceURL)}:${f.line})` : name;
}

/** Where a sample was: the runtime's own function it was in (`spawnSync`, `stringify`), then the code that called it. */
export function placeOf(t: Trace): string {
  if (!t.frames.length) return '(no JavaScript: garbage collection or the runtime itself)';
  const native = t.frames[0]!.sourceURL ? null : t.frames[0]!.name;
  // the timing of synchronous processes (`Stalls.start`) is not where the time went
  const sourced = t.frames.filter((f) => f.sourceURL && f.name !== 'timedSpawnSync');
  // Obeya's own code says more than a library's; a stall entirely inside one names the library's
  const own = sourced.filter((f) => !f.sourceURL!.includes('/node_modules/'));
  const shown = (own.length ? own : sourced).slice(0, FRAMES).map(frame);
  return [...(native ? [native] : []), ...shown].join(' ← ') || native || '(unknown)';
}

/** A command as the log shows it: the program by its name, not its path, and long ones shortened. */
function command(argv: string[]): string {
  const [program = '', ...args] = argv;
  const text = [basename(program), ...args].join(' ');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * How many ms apart the samples were taken: the interval asked for, or longer where the system's
 * timer is coarser (Windows: about 15.6 ms), but never longer than the coarsest timer: of a few
 * samples around a pause the machine slept in, the gap of the pause would pass for the interval.
 */
function sampledEvery(traces: Trace[], intervalMs: number): number {
  const gaps = traces.slice(1).map((t, i) => (t.timestamp - traces[i]!.timestamp) * 1000).sort((a, b) => a - b);
  return Math.max(intervalMs, Math.min(COARSEST_TIMER_MS, gaps[gaps.length >> 1] ?? 0));
}

/**
 * The lines a server stall of `ms` gets: where the samples taken meanwhile were, by share, and the
 * processes it waited for. Null where the samples cover too little of it for the server to have
 * run at all; `traces` null where there is no profiler to ask. Where the profiler takes no samples
 * while the thread waits for a process (`blindWhileWaiting`: Windows), the processes it waited for
 * count as covered; elsewhere they do not, so a machine that slept while one ran logs no stall.
 */
export function describeStall(ms: number, traces: Trace[] | null, waited: Waited[], intervalMs = 1, blindWhileWaiting = process.platform === 'win32'): string[] | null {
  const inProcesses = blindWhileWaiting ? waited.reduce((sum, w) => sum + w.ms, 0) : 0;
  if (traces && traces.length * sampledEvery(traces, intervalMs) < ms * RAN_SHARE && inProcesses < ms * RAN_SHARE) return null;
  const counts = new Map<string, number>();
  for (const t of traces ?? []) {
    const p = placeOf(t);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const places = [...counts].sort((a, b) => b[1] - a[1]).slice(0, PLACES);
  return [
    `Obeya: the server stalled for ${seconds(ms)}; meanwhile it answered no page and heard no agent`,
    ...places.map(([p, n]) => `  ${String(Math.round((100 * n) / traces!.length)).padStart(3)}% ${p}`),
    ...waited.map((w) => `  waited ${seconds(w.ms)} for: ${command(w.argv)}`),
  ];
}

/** How long ago, as the log says it. */
function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

/** What a page's stall ran in, as far as the page told: its browser, its window in use or not, and when the owner last used it. */
function contextOf(s: PageStall): string {
  if (s.active === undefined) return '';
  const used = s.usedMs === undefined ? 'not used since it loaded' : `last used ${ago(s.usedMs)} before`;
  return `; ${[s.browser, s.active ? 'its window active' : 'its window in the background', used].filter(Boolean).join(', ')}`;
}

/** The lines a page's stall gets. */
export function describePageStall(s: PageStall, where: string): string[] {
  return [
    `Obeya: a page (${where}${contextOf(s)}) stalled for ${seconds(s.ms)}; meanwhile it took no click or key`,
    ...s.scripts.map((x) => `  ${seconds(x.ms)} ${x.what}`),
    ...(s.before.length ? [`  before it: ${s.before.join('; ')}`] : []),
  ];
}

/** A run of a page's stalls of one kind: the first logged, those after it counted until the run is logged. */
interface Run {
  where: string;
  /** When the first was logged. */
  first: string;
  /** Since when the run counts, and when the last of it came. */
  since: number;
  last: number;
  count: number;
  least: number;
  most: number;
}

/** The line a run gets. */
export function describeRun(r: Run): string {
  const s = Math.round((r.last - r.since) / 1000);
  const span = s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
  const each = r.least === r.most ? seconds(r.least) : `${(r.least / 1000).toFixed(1)}–${seconds(r.most)}`;
  return `Obeya: a page (${r.where}) stalled ${r.count} more ${r.count === 1 ? 'time' : 'times'} in ${span} like the one logged at ${r.first}, for ${each} each`;
}

/** What a page sent of its stall, if it is one: the server takes nothing else from it, and no more than it logs. */
export function pageStall(msg: unknown): PageStall | null {
  const m = msg as Partial<PageStall> | null;
  const length = (n: unknown, least: number): n is number => typeof n === 'number' && n >= least && n <= 3600_000;
  if (!m || !length(m.ms, STALL_MS)) return null;
  // one line each, without what a terminal would take for a command
  const text = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 200) : '');
  const scripts = (Array.isArray(m.scripts) ? m.scripts : []).slice(0, PLACES).flatMap((x) => (x && length(x.ms, 0) && text(x.what) ? [{ ms: x.ms, what: text(x.what) }] : []));
  const before = (Array.isArray(m.before) ? m.before : []).slice(-8).map(text).filter(Boolean);
  const browser = text(m.browser).slice(0, 60);
  return {
    ms: m.ms,
    scripts,
    before,
    ...(browser ? { browser } : {}),
    ...(typeof m.active === 'boolean' ? { active: m.active } : {}),
    // a page left alone overnight was last used long before
    ...(typeof m.usedMs === 'number' && m.usedMs >= 0 && m.usedMs < 1e10 ? { usedMs: m.usedMs } : {}),
  };
}

export interface StallOptions {
  /** Obeya's home, where `stalls.log` is kept. */
  home: string;
  /** The server's log. */
  log?: (line: string) => void;
}

/** The profiler's samples since the last look, which it hands out once each; null for a Bun whose `bun:jsc` lacks the call (its types leave it out). */
function drain(): { traces: Trace[]; intervalMs: number } | null {
  const take = (jsc as unknown as { samplingProfilerStackTraces?: () => { traces: Trace[]; interval: number } }).samplingProfilerStackTraces;
  if (!take) return null;
  const { traces, interval } = take();
  return { traces, intervalMs: interval * 1000 };
}

/**
 * The watcher the samples go to. The profiler, once started, runs for the rest of the process, so
 * its samples are taken out on every tick, and dropped while no watcher is there to look at them.
 */
let watching: Stalls | null = null;
let ticking: ReturnType<typeof setInterval> | undefined;
let last = 0;

function tick() {
  const now = performance.now();
  const since = last;
  last = now;
  const samples = drain();
  watching?.tick(since, now, samples);
  watching?.flush();
}

/**
 * Watches the server's thread for stalls and logs them. The JavaScript engine's sampling profiler
 * samples the thread's stack on a thread of its own, also while the thread waits in a synchronous
 * call, so the samples taken during a stall say where it went; the processes run synchronously are
 * timed by their command.
 */
export class Stalls {
  private waited: (Waited & { end: number })[] = [];
  /** The runs of page stalls, by the page and where their time went. */
  private runs = new Map<string, Run>();
  private spawnSync: typeof Bun.spawnSync | undefined;

  constructor(private readonly o: StallOptions) {}

  start(): this {
    if (!ticking) {
      jsc.startSamplingProfiler(undefined, SAMPLE_US);
      ticking = setInterval(tick, TICK_MS);
      ticking.unref?.();
    }
    drain();
    last = performance.now();
    watching = this;
    const spawnSync = (this.spawnSync = Bun.spawnSync);
    const waited = this.waited;
    // by its name, the stall's places leave this frame out: the time went to the process
    Bun.spawnSync = function timedSpawnSync(...args: Parameters<typeof Bun.spawnSync>) {
      const start = performance.now();
      try {
        return spawnSync(...args);
      } finally {
        const end = performance.now();
        const first = args[0] as string[] | { cmd: string[] };
        if (end - start >= SLOW_PROCESS_MS) waited.push({ argv: Array.isArray(first) ? first : first.cmd, ms: end - start, end });
      }
    } as typeof Bun.spawnSync;
    return this;
  }

  stop() {
    this.flush(Infinity);
    if (watching === this) watching = null;
    if (this.spawnSync) Bun.spawnSync = this.spawnSync;
  }

  /**
   * A page's stall, from the page `page` on `where` (this machine, or a paired device), at `at` (on
   * the monotonic clock). One like those the page reported just before (where the time went the
   * same, and its window in use or not alike; the length aside) is only counted: a page that stalls
   * again and again would push everything else out of `stalls.log`.
   */
  page(s: PageStall, where: string, page = '', at = performance.now()) {
    this.flush(at);
    const key = JSON.stringify([page, where, s.active, s.scripts.map((x) => x.what)]);
    const run = this.runs.get(key);
    if (run) {
      Object.assign(run, { last: at, count: run.count + 1, least: Math.min(run.least, s.ms), most: Math.max(run.most, s.ms) });
      return;
    }
    const first = new Date().toISOString();
    this.runs.set(key, { where, first, since: at, last: at, count: 0, least: Infinity, most: 0 });
    this.write(describePageStall(s, where), first);
  }

  /** Logs the runs that ended by `at` (none like them for a minute), and those that went on for an hour. */
  flush(at = performance.now()) {
    for (const [key, r] of this.runs) {
      const ended = at - r.last >= RUN_GAP_MS;
      if (!ended && at - r.since < RUN_LOGGED_MS) continue;
      if (r.count) this.write([describeRun(r)]);
      if (ended) this.runs.delete(key);
      else Object.assign(r, { since: at, count: 0, least: Infinity, most: 0 });
    }
  }

  /**
   * A tick that came at `now`, the one before at `since`. Late by half a second, the thread was held
   * up; how long, the samples' span says more precisely than the ticks, which see a stall up to a
   * tick short.
   */
  tick(since: number, now: number, samples: { traces: Trace[]; intervalMs: number } | null) {
    const waited = this.waited.splice(0).filter((w) => w.end >= since);
    if (now - since < STALL_MS) return;
    const traces = samples?.traces ?? [];
    const span = traces.length > 1 ? (traces.at(-1)!.timestamp - traces[0]!.timestamp) * 1000 : 0;
    const ms = Math.max(now - since - TICK_MS, Math.min(span, now - since));
    if (ms < STALL_MS) return;
    const lines = describeStall(ms, samples?.traces ?? null, waited, samples?.intervalMs);
    if (lines) this.write(lines);
  }

  private write(lines: string[], time = new Date().toISOString()) {
    const log = this.o.log ?? ((line: string) => console.log(line));
    for (const line of lines) log(line);
    const file = join(this.o.home, STALLS_FILE);
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > KEPT_BYTES) renameSync(file, join(this.o.home, 'stalls.previous.log'));
      appendFileSync(file, `${time}\n${lines.join('\n')}\n\n`);
    } catch {}
  }
}
