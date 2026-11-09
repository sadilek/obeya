// The disk space demos take in the demo directory, and the frames of old renders that Obeya
// deletes: a render keeps the frames it was cut from in its work directory (`.work/frames`, about
// half a gigabyte a demo), which only re-voicing needs once the video is made (design: Demos, Disk
// space of demos).

import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DemoSpaceView } from '../core/types';
import { type DemoSettings, demoDirectory } from '../../plugin/skills/demo/lib/settings.ts';

/** Days after a demo's last render that its frames are kept, where the demo settings name nothing. */
export const DEFAULT_KEEP_DAYS = 14;

const DAY_MS = 24 * 3600_000;
/** How often Obeya looks for frames to delete. */
const SWEEP_EVERY_MS = 6 * 3600_000;
/** The first look after Obeya starts: not in the middle of its start. */
const FIRST_SWEEP_MS = 60_000;
/** Demos whose work directories are looked for at the same time. */
const DEMOS_AT_ONCE = 16;
/** Counts older than this are counted again when the owner looks. */
const STALE_MS = 10 * 60_000;

/**
 * The days that apply: the settings', else the default, which only the Obeya in the default home
 * (`~/.obeya`) applies. Another home (a scratch Obeya, a test, a render's own Obeya) shares the demo
 * directory without sharing the owner's demo settings, so it deletes only where its own say so.
 */
export function keepDays(s: Pick<DemoSettings, 'keepFrames'>, home: string): number | null {
  if (s.keepFrames === 'always') return null;
  if (typeof s.keepFrames === 'number') return s.keepFrames;
  return defaultDays(home);
}

export const defaultDays = (home: string): number | null => (resolve(home) === resolve(homedir(), '.obeya') ? DEFAULT_KEEP_DAYS : null);

/**
 * The work directories of the renders in the demo directory: `<demo>/.work`, and `<demo>/<voice>/.work`
 * of a render in another voice. Asynchronous, like everything the deletion looks at: the demo
 * directory holds a thousand demos and more, and looked through synchronously they held the server
 * up for half a second.
 */
export async function workDirs(dir: string): Promise<string[]> {
  const subdirs = async (d: string) => {
    try {
      return (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== '.work').map((e) => join(d, e.name));
    } catch {
      return [];
    }
  };
  const ofDemo = async (demo: string) => {
    const dirs = [demo, ...(await subdirs(demo))].map((d) => join(d, '.work'));
    const real = await Promise.all(dirs.map(realDir));
    return dirs.filter((_, i) => real[i]);
  };
  const demos = await subdirs(dir);
  const found: string[] = [];
  // a few demos at a time, so the answers for all of them do not come back in one turn of the event loop
  for (let i = 0; i < demos.length; i += DEMOS_AT_ONCE) {
    for (const works of await Promise.all(demos.slice(i, i + DEMOS_AT_ONCE).map(ofDemo))) found.push(...works);
  }
  return found;
}

/** A directory itself, not a link to one: deleting in a linked one would reach wherever it points. */
const realDir = (p: string): Promise<boolean> => lstat(p).then((s) => s.isDirectory(), () => false);

/** When a render last wrote into its work directory: the newest of it and what lies directly in it. */
export async function lastRender(work: string): Promise<number> {
  const names = await readdir(work);
  // what is gone meanwhile counts for nothing
  const times = await Promise.all([work, ...names.map((n) => join(work, n))].map((p) => lstat(p).then((s) => s.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}

/** A render that still runs holds `render.pid` with its process (the director's `holdRenderLock`). */
async function rendering(work: string): Promise<boolean> {
  try {
    const pid = Number(await readFile(join(work, 'render.pid'), 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // a process of another user still runs
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A file is there, or a link to one. */
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/** What a file takes on disk: its blocks where the system says (a sparse or compressed file), else its size. */
const onDisk = (s: { blocks?: number; size: number }) => (s.blocks ? s.blocks * 512 : s.size);

/**
 * The bytes under `dir`, and those under work directories (`.work`) among them; symbolic links are
 * not followed. Directories one after the other, the files of one in parallel: a demo directory
 * holds millions of frames, and all of them at once took memory for nothing.
 */
export async function usage(dir: string): Promise<{ bytes: number; work: number }> {
  const sum = { bytes: 0, work: 0 };
  const walk = async (d: string, inWork: boolean) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    const sizes = await Promise.all(entries.filter((e) => !e.isDirectory()).map((e) => lstat(join(d, e.name)).then(onDisk, () => 0)));
    const here = sizes.reduce((a, b) => a + b, 0);
    sum.bytes += here;
    if (inWork) sum.work += here;
    for (const e of entries) if (e.isDirectory()) await walk(join(d, e.name), inWork || e.name === '.work');
  };
  await walk(dir, false);
  return sum;
}

/**
 * Deletes the frames (`frames/`, `frames.txt`) of every render in the demo directory last rendered
 * more than `days` ago, unless a render of it still runs. The rest of the work directory stays: the
 * narration's clips (a re-render with the same words pays no hosted voice again) and the take's cuts
 * are small.
 */
export async function sweep(dir: string, days: number, now = Date.now()): Promise<{ demos: number; bytes: number }> {
  const freed = { demos: 0, bytes: 0 };
  for (const work of await workDirs(dir)) {
    const frames = join(work, 'frames');
    const list = join(work, 'frames.txt');
    if (!(await realDir(frames)) && !(await exists(list))) continue;
    const due = async () => now - (await lastRender(work)) >= days * DAY_MS && !(await rendering(work));
    if (!(await due())) continue;
    const { bytes } = await usage(frames);
    // a render may have started while they were counted
    if (!(await due())) continue;
    if (await realDir(frames)) await rm(frames, { recursive: true, force: true });
    await rm(list, { force: true });
    freed.demos++;
    freed.bytes += bytes;
  }
  return freed;
}

/**
 * The demo directory's space for the configuration's Demos section, and the deletion of old frames:
 * a while after Obeya starts, every few hours after that, and at once when the owner changes how
 * long they are kept. One job at a time; each deletion is followed by a count, and the section
 * opened counts again when the last count is old.
 */
export class DemoSpace {
  /** The last count and the last deletion, each of the demo directory it was of. */
  private used?: DemoSpaceView['used'] & { dir: string };
  private freed?: DemoSpaceView['freed'] & { dir: string };
  /** The jobs queued or running, one after the other. */
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  /** A job queued and not started yet, which a request for the same (a count: or a sweep, which counts too) joins. */
  private ahead: { sweep?: Promise<void>; count?: Promise<void> } = {};
  private timers: ReturnType<typeof setTimeout>[] = [];

  /**
   * `settings` are the demo settings as read; `file` is where they are saved, so a file that does
   * not read (which `settings` then gives as the defaults) deletes nothing, whatever it said.
   */
  constructor(private readonly o: { home: string; settings: () => DemoSettings; file?: string; log?: (line: string) => void }) {}

  start(): this {
    this.timers.push(setTimeout(() => this.sweepSoon(), FIRST_SWEEP_MS), setInterval(() => this.sweepSoon(), SWEEP_EVERY_MS));
    return this;
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** What the Demos section shows; counts again in the background when the last count is old. */
  view(): DemoSpaceView {
    const s = this.o.settings();
    const dir = demoDirectory(s);
    // what was counted and deleted in another directory than the settings name now is not shown
    const used = this.used?.dir === dir ? this.used : undefined;
    const freed = this.freed?.dir === dir ? this.freed : undefined;
    if (!this.pending && (!used || Date.now() - Date.parse(used.at) > STALE_MS)) void this.queue(false);
    return {
      keepDays: keepDays(s, this.o.home),
      defaultDays: defaultDays(this.o.home),
      busy: this.pending > 0,
      ...(used ? { used: { bytes: used.bytes, work: used.work, at: used.at } } : {}),
      ...(freed ? { freed: { demos: freed.demos, bytes: freed.bytes, at: freed.at } } : {}),
    };
  }

  /** Deletes what is due, then counts; resolves once done. */
  sweepSoon(): Promise<void> {
    return this.queue(true);
  }

  private queue(sweeping: boolean): Promise<void> {
    const joined = sweeping ? this.ahead.sweep : (this.ahead.count ?? this.ahead.sweep);
    if (joined) return joined;
    const kind = sweeping ? 'sweep' : 'count';
    this.pending++;
    const job = this.tail.then(() => {
      this.ahead[kind] = undefined;
      return this.job(sweeping);
    });
    this.ahead[kind] = this.tail = job.finally(() => this.pending--);
    return this.tail;
  }

  private async job(sweeping: boolean) {
    const unreadable = await this.unreadable().catch(() => true);
    // the settings as the file stands once it was found to read, not as it stood before
    const s = this.o.settings();
    const dir = demoDirectory(s);
    try {
      const days = unreadable ? null : keepDays(s, this.o.home);
      // an Obeya that keeps every frame has nothing to delete, and counts only for the owner looking
      // (or for a directory it has no count of)
      if (sweeping && days === null && this.used?.dir === dir) return;
      if (sweeping && days !== null) {
        const freed = await sweep(dir, days);
        if (freed.demos) {
          this.freed = { at: new Date().toISOString(), ...freed, dir };
          this.o.log?.(`Obeya: deleted the frames of ${freed.demos} demo${freed.demos === 1 ? '' : 's'} in ${dir} last rendered more than ${days} days ago (${(freed.bytes / 1e9).toFixed(1)} GB)`);
        }
      }
      this.used = { ...(await usage(dir)), at: new Date().toISOString(), dir };
    } catch (e) {
      this.o.log?.(`Obeya: counting or tidying the demos in ${dir} failed: ${(e as Error).message}`);
    }
  }

  /** The settings file is there and does not read: its `keepFrames` is unknown. */
  private async unreadable(): Promise<boolean> {
    const file = this.o.file;
    if (!file) return false;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // a file that is not there reads as the defaults; one that is there and cannot be read does not read
      return (await exists(file)) && this.notRead(file);
    }
    try {
      JSON.parse(text);
      return false;
    } catch {
      return this.notRead(file);
    }
  }

  private notRead(file: string): true {
    this.o.log?.(`Obeya: ${file} does not read; no demo frames are deleted until it does`);
    return true;
  }
}
