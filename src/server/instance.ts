// One Obeya per home: two serving one database on one port would trip over each other. A running
// Obeya writes where it answers into its home (`server.json`), and a second start on that home
// finds it there: the checkout says where it runs and ends, the app (app/) opens a window on it.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What a running Obeya writes into its home. */
export interface Instance {
  /** The process that stays for as long as this Obeya runs: the supervisor, else the server. */
  pid: number;
  port: number;
  url: string;
  version: string;
  /** Started by the app, which then stops it when it quits; an Obeya started from a terminal it leaves running. */
  app: boolean;
  /** Its server ended to start again (new code, a saved configuration) and does not answer yet. */
  restarting?: boolean;
}

export const INSTANCE_FILE = 'server.json';

/** Writes that this Obeya answers in `home`. */
export function claim(home: string, instance: Instance) {
  const file = join(home, INSTANCE_FILE);
  // written whole or not at all: the app reads it while Obeya starts
  writeFileSync(`${file}.tmp`, `${JSON.stringify(instance, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Marks the entry of the supervisor `pid` while its server starts again, which can take a while
 * (new dependencies are installed first): a start meanwhile waits for it instead of serving the
 * home beside it.
 */
export function restarting(home: string, pid: number) {
  const i = recorded(home);
  if (i?.pid === pid) claim(home, { ...i, restarting: true });
}

/** How long a start waits for an Obeya that is starting again. */
export const RESTART_GRACE_MS = 90_000;

/** Removes the entry, if it is still the one process `pid` wrote. */
export function release(home: string, pid: number) {
  if (recorded(home)?.pid === pid) rmSync(join(home, INSTANCE_FILE), { force: true });
}

/** The entry in `home`, whether or not that Obeya still runs. */
export function recorded(home: string): Instance | null {
  try {
    const i = JSON.parse(readFileSync(join(home, INSTANCE_FILE), 'utf8')) as Instance;
    return typeof i.pid === 'number' && typeof i.url === 'string' ? i : null;
  } catch {
    return null;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // the process is there but belongs to someone else
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const answers = async (url: string) => {
  try {
    return (await fetch(`${url}/api/canvases`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

/**
 * The Obeya that runs on `home`, if one does: its process is alive and its URL answers. A process
 * that is alive but does not answer may be restarting, so it is given `graceMs` to come back
 * (`restartGraceMs` when its entry says so); one that stays silent is another program that got
 * the pid, and the entry is stale.
 */
export async function running(home: string, self = process.pid, graceMs = 5000, restartGraceMs = RESTART_GRACE_MS): Promise<Instance | null> {
  const first = recorded(home);
  if (!first || first.pid === self || !alive(first.pid)) return null;
  const start = Date.now();
  for (;;) {
    // read again each time: the restarted server writes its own entry, perhaps with another port
    const i = recorded(home);
    if (!i || i.pid !== first.pid || !alive(i.pid)) return null;
    if (await answers(i.url)) return i;
    if (Date.now() - start > (i.restarting ? restartGraceMs : graceMs)) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}
