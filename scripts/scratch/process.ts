// The scratch Obeyas' processes and ports, for scripts/scratch-obeya.ts: which port a staging takes,
// whether a scratch dir's server runs, stopping it with what it started, and the sweep of those
// whose code does not end them by itself.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, linkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findTailscale, type NamedEntry, Tailscale } from '../../src/server/tailscale';
import { alive, scratchBase, scratchDir, scratchPortIn, script } from '../common';

const { fail } = script('scratch-obeya');

/**
 * A port for a scratch Obeya staged without one. Staging afresh from the same stage file and code
 * stops the scratch Obeya staged from them before (the one in `givenDir`, if given) and takes its
 * port again; else the first from 4480 up that nothing listens on, whose scratch dir no running
 * server holds and that no other staging has claimed meanwhile (its server does not listen yet).
 */
export async function pickPort(givenDir: string | undefined, from: unknown): Promise<number> {
  const earlier = givenDir ? resolve(givenDir) : scratchDirs().find((d) => JSON.stringify(stagedIn(d)?.from) === JSON.stringify(from));
  const was = earlier ? stagedIn(earlier)?.port : undefined;
  if (earlier && !stop(earlier)) console.error(`scratch-obeya: the server of ${earlier} (process ${pidIn(earlier)}) still runs after the stop`);
  for (const p of [...(was ? [was] : []), ...Array.from({ length: 500 }, (_, i) => 4480 + i)]) {
    if (p === 4417 || serverIn(scratchDir(p)) || !claim(p)) continue;
    if (await (p === was ? freed(p) : free(p))) {
      // one whose port went to another meanwhile leaves no dir behind
      if (earlier && !givenDir && earlier !== scratchDir(p)) rmSync(earlier, { recursive: true, force: true });
      return p;
    }
    rmSync(claimOf(p), { force: true });
  }
  return fail('no free port from 4480 to 4979');
}

/** The scratch dirs there are, by their names. */
function scratchDirs() {
  return readdirSync(scratchBase())
    .map((n) => join(scratchBase(), n))
    .filter((d) => scratchPortIn(d) !== undefined && d === scratchDir(scratchPortIn(d)!));
}

/** What a staging prints, also kept in <dir>/staged.json. */
export type Staged = {
  url: string;
  port: number;
  dir: string;
  canvas?: string;
  repo?: string;
  pid: number;
  log: string;
  from: { stage: string; code?: string };
  endsItself: boolean;
  cards: Record<string, string>;
  canvasOf?: Record<string, string>;
  record?: string;
  replay?: string;
};

/** The staged.json of the scratch dir `d`, if there is one. */
export function stagedIn(d: string): Staged | undefined {
  try {
    return JSON.parse(readFileSync(join(d, 'staged.json'), 'utf8')) as Staged;
  } catch {
    return undefined;
  }
}

export function pidIn(d: string) {
  return pidOf(join(d, 'server.pid'));
}

function pidOf(file: string) {
  try {
    return Number(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The process number of the scratch server of `d`, while it runs. server.pid alone does not tell:
 * a scratch dir outlives a reboot and process numbers come again (on Windows soon), so by now it
 * may name another program. The server started right before server.pid was written; a process
 * with its number that started later is another one.
 */
function serverIn(d: string) {
  const file = join(d, 'server.pid');
  const pid = pidOf(file);
  if (!pid || !alive(pid)) return undefined;
  const started = startOf(pid!);
  // a second for the start's precision, one for the file time's
  return started !== undefined && started <= statSync(file).mtimeMs + 2000 ? pid : undefined;
}

/** When process `pid` started (ms since the epoch, to the second), unless it is gone or not ours to look at. */
function startOf(pid: number): number | undefined {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`], {
      encoding: 'utf8',
    });
    const ms = Number(r.stdout?.trim());
    return r.status === 0 && ms > 0 ? ms : undefined;
  }
  // the time since it started as [[dd-]hh:]mm:ss, which macOS and Linux both give
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout ?? '');
  if (r.status !== 0 || !m) return undefined;
  const [days, hours, minutes, seconds] = m.slice(1).map((n) => Number(n ?? 0));
  return Date.now() - (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
}


function claimOf(p: number) {
  return `${scratchDir(p)}.claim`;
}

/** Claims port `p` for this staging until it ends, unless another staging that still runs has. */
function claim(p: number): boolean {
  // linked in whole, so that another staging never reads a claim without its pid
  const mine = `${claimOf(p)}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (let i = 0; i < 3; i++)
      try {
        linkSync(mine, claimOf(p));
        process.on('exit', () => rmSync(claimOf(p), { force: true }));
        return true;
      } catch {
        const holder = pidOf(claimOf(p));
        if (holder && alive(holder)) return false;
        // a staging that was killed left it; one that let go of the port meanwhile left none
        if (holder) rmSync(claimOf(p), { force: true });
      }
    return false;
  } finally {
    rmSync(mine, { force: true });
  }
}

/** Whether port `p` of a server just stopped is free within a few seconds: Windows lets go of it a moment after the process is gone, later on a busy machine. */
async function freed(p: number) {
  for (const end = Date.now() + 5000; ; await Bun.sleep(100)) {
    if (await free(p)) return true;
    if (Date.now() > end) return false;
  }
}

/** Whether a server could listen on port `p` of the loopback and nothing answers there (one listening on every address, say). */
async function free(p: number) {
  try {
    Bun.serve({ port: p, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true);
  } catch {
    return false;
  }
  const answers = await Bun.connect({ hostname: '127.0.0.1', port: p, socket: { data() {} } }).then(
    (s) => (s.end(), true),
    () => false,
  );
  return !answers;
}

/** Ends the scratch Obeya that `dir` belongs to, and what it started, if it still runs; false if its server outlives the stop. */
export function stop(d: string) {
  const gone = stopServer(d);
  // one that was killed left its `tailscale serve` entry, which would serve whatever takes the port next
  const served = join(d, 'home', 'tailscale-serve.json');
  if (existsSync(served)) {
    const tailscale = findTailscale();
    const entry = JSON.parse(readFileSync(served, 'utf8')) as NamedEntry;
    if (tailscale) new Tailscale(tailscale).unserveSync(entry);
    rmSync(served, { force: true });
  }
  return gone;
}

/** Ends the scratch server of `d` with its process group (its tree on Windows); whether it is gone then. */
function stopServer(d: string) {
  const pid = serverIn(d);
  if (!pid) return true;
  if (process.platform === 'win32') stopTree(pid);
  else end(-pid);
  return serverIn(d) !== pid;
}


/**
 * Windows has no process groups to signal: ends the server's process tree, which a console process
 * without a window lets end only forcefully, and waits until it is gone and lets go of its files.
 */
function stopTree(pid: number) {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  for (let i = 0; i < 50 && alive(pid); i++) Bun.sleepSync(100);
}

/**
 * Stops the scratch Obeyas from code that does not end them by itself (from before it did, or
 * --code of such a commit, or started by hand on a scratch dir): those whose working directory is
 * gone (the workspace they ran from), and those running for more than 12 hours. Runs in the
 * background of every staging; says what it stopped in obeya-scratch-sweep.log beside the dirs.
 */
export async function sweep() {
  // how long one may run before it is stopped (design: Scratch Obeyas): it cannot tell when it was last used, and a take stages afresh
  const UNTOLD_MS = 12 * 3600_000;
  const { commandWords, descendants, localProcesses } = await import('../../src/server/folder-processes');
  const all = await localProcesses();
  const isServer = (cmd: string) => commandWords(cmd).some((w) => /(^|[\\/])src[\\/]server[\\/]main\.ts$/.test(w));
  const staged = new Map(scratchDirs().map((d) => [serverIn(d), d] as const).filter(([pid]) => pid !== undefined));
  const servers = all.filter((p) => staged.has(p.pid) || (isServer(p.cmd) && scratchPortIn(`${p.cmd} ${p.cwd}`) !== undefined));
  const lines: string[] = [];
  for (const p of servers) {
    // a supervised server's child goes with its supervisor
    if (servers.some((q) => q.pid === p.ppid)) continue;
    const d = staged.get(p.pid) ?? scratchDir(scratchPortIn(`${p.cmd} ${p.cwd}`)!);
    if (staged.get(p.pid) && stagedIn(d)?.endsItself) continue;
    const started = startOf(p.pid);
    const why = p.cwd && !existsSync(p.cwd) ? `${p.cwd}, which it ran from, is gone` : started !== undefined && Date.now() - started > UNTOLD_MS ? `it ran for ${Math.round((Date.now() - started) / 3600_000)} hours` : null;
    if (!why) continue;
    const below = descendants(all, [p.pid]);
    if (staged.get(p.pid)) stop(d);
    else if (process.platform === 'win32') stopTree(p.pid);
    else end(p.pid);
    // what it started that did not end with it (a sidecar of its own, an agent)
    for (const pid of below) if (pid !== p.pid && alive(pid)) process.platform === 'win32' ? stopTree(pid) : end(pid);
    lines.push(`${new Date().toISOString()} stopped the scratch Obeya of ${d} (process ${p.pid}): ${why}`);
  }
  if (lines.length) appendFileSync(join(scratchBase(), 'obeya-scratch-sweep.log'), `${lines.join('\n')}\n`);
}

/**
 * Ends process `pid` as Ctrl-C twice ends Obeya, `target` its group (`-pid`) or itself: SIGTERM,
 * again after 1.5 s (Obeya waits for workers in the middle of a turn, and an idle worker always
 * is), SIGKILL after 4 s; then waits up to 2 s for it to be gone.
 */
function end(target: number, pid = Math.abs(target)) {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(target, s);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal('SIGTERM')) return;
  for (let i = 1; i < 40 && alive(pid); i++) {
    if (i === 15) signal('SIGTERM');
    Bun.sleepSync(100);
  }
  // a group's other processes too, should its first have ended
  if (target < 0 || alive(pid)) signal('SIGKILL');
  for (let i = 0; i < 20 && alive(pid); i++) Bun.sleepSync(100);
}
