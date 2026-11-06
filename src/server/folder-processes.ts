// The processes that run from a workspace's folder, ended before the folder goes (design: Parking).
// A repository's stop command finds only what its own bookkeeping names (a file of process IDs it
// wrote at the start, say): an app started some other way, or one whose bookkeeping went first,
// would run on with the folder half removed (on Windows the files it holds open keep the removal
// from finishing), and nothing would find it again.

import { statSync } from 'node:fs';
import { remote } from './hosts';
import { spawnOutput } from './spawn';

/** A process as the machine lists it: its program, its command line and its working directory, where it lets Obeya read them. */
export interface Running {
  pid: number;
  ppid: number;
  exe: string;
  cmd: string;
  cwd: string;
}

/**
 * How long before its folder was made a process may have started and still run from it, on Windows
 * (`windows-processes.ts`): none can, but clocks and file times are not that exact.
 */
const BORN_SLACK_MS = 60_000;

/** How long a process asked to end (POSIX: SIGTERM) has before it is killed. */
const GRACE_MS = 3000;

/**
 * Whether `p` runs from the folder `dir`: its program lies in it, its working directory, or its
 * command line names a path in it (a dev server's script, run by a runtime installed elsewhere).
 */
export function runsFrom(p: Running, dir: string, windows: boolean): boolean {
  const norm = (s: string) => (windows ? s.replace(/\//g, '\\').toLowerCase() : s);
  const base = norm(dir).replace(/[\\/]+$/, '');
  if (!base) return false;
  const sep = windows ? '\\' : '/';
  const inside = (s: string) => {
    const n = norm(s).replace(/[\\/]+$/, '');
    return n === base || n.startsWith(base + sep);
  };
  if (inside(p.exe) || inside(p.cwd)) return true;
  const cmd = norm(p.cmd);
  for (let at = cmd.indexOf(base); at >= 0; at = cmd.indexOf(base, at + 1)) {
    const after = cmd[at + base.length];
    const before = at === 0 ? undefined : cmd[at - 1];
    if ((after === undefined || after === sep || after === '"' || after === "'" || /\s/.test(after)) && (before === undefined || /[\s"'=]/.test(before))) return true;
  }
  return false;
}

/**
 * Ends every process that runs from the folder at `path` (`runsFrom`; there, for a workspace on
 * another machine), with what each started: Obeya itself, what started it, and what Obeya runs
 * there itself (git) excepted. Returns the process IDs it ended. Best effort: a machine that does
 * not tell (a process of another user) keeps those.
 */
export async function endProcessesIn(path: string): Promise<number[]> {
  const there = remote(path);
  if (there) {
    const listed = await there.host.run(POSIX_LIST, { cwd: '/', timeout: 30_000 });
    if (listed.code !== 0) return [];
    const pids = parsePosix(listed.stdout)
      .filter((p) => runsFrom(p, there.path, false))
      .map((p) => p.pid);
    if (pids.length) await there.host.run(`kill -TERM ${pids.join(' ')} 2>/dev/null; sleep ${GRACE_MS / 1000}; kill -KILL ${pids.join(' ')} 2>/dev/null; true`, { timeout: 30_000 });
    return pids;
  }
  const windows = process.platform === 'win32';
  let born: number;
  try {
    born = statSync(path).birthtimeMs;
  } catch {
    return [];
  }
  const all = await localProcesses(windows ? born - BORN_SLACK_MS : 0);
  const spared = ownLine(all);
  const pids = all.filter((p) => !spared.has(p.pid) && runsFrom(p, path, windows)).map((p) => p.pid);
  if (!pids.length) return [];
  if (windows) await spawnOutput(['taskkill', ...pids.flatMap((p) => ['/PID', String(p)]), '/T', '/F'], { stdin: 'ignore', timeout: 30_000 });
  else await endPosix(pids);
  return pids;
}

/**
 * The processes on this machine; on Windows those started since `since` (ms since the epoch) with
 * their program, command line and working directory, the others without (`windows-processes.ts`).
 */
export async function localProcesses(since = 0): Promise<Running[]> {
  if (process.platform === 'win32') {
    const worker = new Worker(new URL('./windows-processes.ts', import.meta.url).href);
    try {
      return await new Promise<Running[]>((done, fail) => {
        worker.onmessage = (e: MessageEvent<Running[]>) => done(e.data);
        worker.onerror = (e) => fail(new Error(e.message));
        worker.postMessage(since);
      });
    } finally {
      worker.terminate();
    }
  }
  return parsePosix((await spawnOutput(['sh', '-c', POSIX_LIST], { cwd: '/', stdin: 'ignore', timeout: 30_000 })).stdout);
}

/** Obeya's own process, those it was started by, and those it started itself (git in the folder, say): never ended here. */
function ownLine(all: Running[]): Set<number> {
  const parent = new Map(all.map((p) => [p.pid, p.ppid]));
  const own = new Set<number>([process.pid]);
  for (let p = parent.get(process.pid); p && !own.has(p); p = parent.get(p)) own.add(p);
  for (const p of all) if (p.ppid === process.pid) own.add(p.pid);
  return own;
}

async function endPosix(pids: number[]) {
  const signal = (pid: number, s: NodeJS.Signals | 0) => {
    try {
      process.kill(pid, s);
      return true;
    } catch {
      return false;
    }
  };
  for (const pid of pids) signal(pid, 'SIGTERM');
  for (let waited = 0; waited < GRACE_MS && pids.some((p) => signal(p, 0)); waited += 100) await Bun.sleep(100);
  for (const pid of pids) signal(pid, 'SIGKILL');
}

/**
 * Lists the processes on a POSIX machine: their command lines from `ps`; working directories and
 * programs from `/proc` (Linux) or `lsof` (macOS), in one call each rather than one per process.
 */
const POSIX_LIST = [
  'ps axww -o pid=,ppid=,args=',
  "echo '--- dirs'",
  'if [ -d /proc/self ]; then ls -l /proc/[0-9]*/cwd /proc/[0-9]*/exe 2>/dev/null; else lsof -nP -a -d cwd -Fpn 2>/dev/null; fi',
  'true',
].join('; ');

export function parsePosix(out: string): Running[] {
  const [listed = '', dirs = ''] = out.split('--- dirs\n');
  const all = new Map<number, Running>();
  for (const line of listed.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) all.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), exe: '', cmd: m[3]!.trim(), cwd: '' });
  }
  let pid = 0;
  for (const line of dirs.split('\n')) {
    // `ls -l` of /proc: "… /proc/123/cwd -> /the/folder"
    const link = /\/proc\/(\d+)\/(cwd|exe) -> (.*)$/.exec(line);
    if (link) {
      const p = all.get(Number(link[1]));
      if (p) p[link[2] as 'cwd' | 'exe'] = link[3]!.replace(/ \(deleted\)$/, '');
      continue;
    }
    // `lsof -Fpn`: "p123", then "n/the/folder"
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const p = all.get(pid);
      if (p) p.cwd = line.slice(1);
    }
  }
  return [...all.values()];
}
