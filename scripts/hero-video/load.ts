// How busy the machine is before a take. A take recorded while other work held the machine
// stuttered; `render.ts` measures before it starts and refuses on a busy machine unless told to go
// on. Measured on an M4 Pro (2026-11-09): the screencast kept its frame rate with every core busy and
// with the GPU at 99%, so neither stops a take below near-saturation; memory short enough to swap
// (local models of 15 GB and more beside the take) is what stalls every process, the browser's too.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Above this share of all cores in use, the take's own browser, server and agents wait for the cores. */
export const BUSY = 0.9;
/** Swap traffic above this many bytes per second: the machine is short of memory. */
export const SWAPPING = 10 * 2 ** 20;
/** How long the measurement looks: long enough that a moment's spike doesn't count. */
const SPAN = 5000;

type Times = os.CpuInfo['times'];
const total = (t: Times) => t.user + t.nice + t.sys + t.idle + t.irq;

/** The share of all cores' time between two readings of `os.cpus()` that was not idle. */
export function busyShare(before: Times[], after: Times[]): number {
  let busy = 0;
  let all = 0;
  after.forEach((t, i) => {
    const b = before[i];
    if (!b) return;
    const span = total(t) - total(b);
    all += span;
    busy += span - (t.idle - b.idle);
  });
  return all > 0 ? busy / all : 0;
}

/** Bytes swapped in and out so far, where the system tells (`vm_stat` on macOS, `/proc/vmstat` on Linux). */
export function swapped(): number | undefined {
  if (process.platform === 'darwin') {
    const out = spawnSync('vm_stat', { encoding: 'utf8' }).stdout ?? '';
    return swappedOf(out, Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384), /^Swap(?:ins|outs):\s+(\d+)/gm);
  }
  if (process.platform === 'linux') {
    try {
      return swappedOf(fs.readFileSync('/proc/vmstat', 'utf8'), 4096, /^pswp(?:in|out) (\d+)/gm);
    } catch {}
  }
  return undefined;
}

/** The pages counted by `counter` in a statistics text, in bytes. */
export function swappedOf(text: string, pageSize: number, counter: RegExp): number | undefined {
  const pages = [...text.matchAll(counter)].map((m) => Number(m[1]));
  return pages.length ? pages.reduce((a, b) => a + b, 0) * pageSize : undefined;
}

/** macOS's memory pressure: 1 normal, 2 warning, 4 critical. */
function pressure(): number | undefined {
  if (process.platform !== 'darwin') return undefined;
  const level = Number(spawnSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).stdout);
  return level > 0 ? level : undefined;
}

/** The processes using the most of `ps`'s first column, summed by name, from `ps` output (`<value> <command>` per line). */
export function busiest(ps: string, least: number, count = 5): { name: string; value: number }[] {
  const byName = new Map<string, number>();
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^([\d.]+)\s+(.+)$/);
    if (!m) continue;
    const name = path.basename(m[2]!);
    byName.set(name, (byName.get(name) ?? 0) + Number(m[1]!));
  }
  return [...byName]
    .map(([name, value]) => ({ name, value }))
    .filter((p) => p.value >= least)
    .sort((a, b) => b.value - a.value)
    .slice(0, count);
}

export type Load = {
  /** The share of all cores in use over the span. */
  cpu: number;
  cores: number;
  /** Bytes swapped per second over the span, where the system tells. */
  swap?: number;
  /** macOS's memory pressure level (1 normal, 2 warning, 4 critical). */
  pressure?: number;
  /** `ps -Ao pcpu=,comm=` and `ps -Ao rss=,comm=` (where there is a `ps`). */
  ps?: { cpu: string; memory: string };
};

/** Measures the machine over `SPAN`. */
export async function measure(): Promise<Load> {
  const before = os.cpus().map((c) => c.times);
  const swapBefore = swapped();
  await new Promise((r) => setTimeout(r, SPAN));
  const cpu = busyShare(before, os.cpus().map((c) => c.times));
  const swapAfter = swapped();
  const swap = swapBefore !== undefined && swapAfter !== undefined ? ((swapAfter - swapBefore) * 1000) / SPAN : undefined;
  const ps = (field: string) => spawnSync('ps', ['-Ao', `${field}=,comm=`], { encoding: 'utf8' }).stdout ?? '';
  return { cpu, cores: before.length, swap, pressure: pressure(), ps: process.platform === 'win32' ? undefined : { cpu: ps('pcpu'), memory: ps('rss') } };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mb = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MB`;
const gb = (kb: number) => `${(kb / 2 ** 20).toFixed(1)} GB`;

export type Reason = { kind: 'memory' | 'cpu'; text: string };

/** Why the machine is too busy for a take; none when it isn't. */
export function reasons(load: Load): Reason[] {
  const out: Reason[] = [];
  if (load.pressure !== undefined && load.pressure >= 2) out.push({ kind: 'memory', text: `memory pressure is ${load.pressure >= 4 ? 'critical' : 'high'}` });
  if (load.swap !== undefined && load.swap > SWAPPING) out.push({ kind: 'memory', text: `it swaps ${mb(load.swap)} a second (more than ${mb(SWAPPING)})` });
  if (load.cpu > BUSY) out.push({ kind: 'cpu', text: `${pct(load.cpu)} of its ${load.cores} cores are in use (more than ${pct(BUSY)})` });
  return out;
}

/** What `render.ts` prints when the machine is too busy for a take: why, what loads it, how to go on. */
export function warning(load: Load, why: Reason[]): string {
  const lines = [`The machine is too busy for a take, which is likely to stutter: ${why.map((r) => r.text).join('; ')}.`];
  if (load.ps && why.some((r) => r.kind === 'memory')) {
    const top = busiest(load.ps.memory, 2 ** 20);
    if (top.length) lines.push(`Using the most memory: ${top.map((p) => `${p.name} ${gb(p.value)}`).join(', ')}`);
  }
  if (load.ps && why.some((r) => r.kind === 'cpu')) {
    const top = busiest(load.ps.cpu, 10);
    if (top.length) lines.push(`Using the most CPU (100% is one core): ${top.map((p) => `${p.name} ${Math.round(p.value)}%`).join(', ')}`);
  }
  lines.push('Not started. Run it again once the machine is quieter, or with --ignore-load to render anyway.');
  return lines.join('\n');
}

/** The one line `render.ts` prints when the machine is quiet enough. */
export function quiet(load: Load): string {
  const swapped = load.swap === undefined ? undefined : load.swap === 0 ? 'nothing' : load.swap < 2 ** 20 ? 'under 1 MB a second' : `${mb(load.swap)} a second`;
  const memory = swapped ? `, ${swapped} swapped` : '';
  return `The machine is quiet enough: ${pct(load.cpu)} of its ${load.cores} cores in use${memory}.`;
}
