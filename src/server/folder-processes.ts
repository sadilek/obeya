// The processes that run from a workspace's folder, ended before the folder goes (design: Parking).
// A repository's stop command finds only what its own bookkeeping names (a file of process IDs it
// wrote at the start, say): an app started some other way, or one whose bookkeeping went first,
// would run on with the folder half removed (on Windows the files it holds open keep the removal
// from finishing), and nothing would find it again.

import { realpathSync, statSync } from 'node:fs';
import { remote, sh } from './hosts';
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
 * How long before its folder was made a process may have started and still have been read first,
 * on Windows (`windows-processes.ts`): none can have started from it, but clocks and file times are
 * not that exact.
 */
const BORN_SLACK_MS = 60_000;

/** How long the Windows listing may take before the folder goes without it (`windows-processes.ts` reads as many as it can in less). */
const WINDOWS_LIST_MS = 30_000;

/** How long a process asked to end (POSIX: SIGTERM) has before it is killed. */
const GRACE_MS = 3000;

/** Programs that run the script their first argument names (`node /ws/server.js`): that script is what the process runs. */
export const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node', 'python', 'python3', 'pythonw', 'py', 'ruby', 'perl', 'php', 'java', 'javaw', 'dotnet']);

/** Shells: one with no command or script to run is someone's terminal, not an app (`interactive`). */
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'nu', 'cmd', 'powershell', 'pwsh']);

/** The flags with which a shell runs a command rather than waiting for one typed. */
const COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command', '-file', '-encodedcommand', '-ec']);

/** The program's name in `word`: no folder, no `.exe`, no login shell's `-`, lower case. */
export const programName = (word: string) =>
  word
    .replace(/^.*[\\/]/, '')
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();

/**
 * The words of a command line: quotes group (a Windows program in `C:\Program Files`) and go.
 * `ps` gives POSIX command lines without their quotes, so a path with a space comes apart there,
 * unless it is the folder's, which `runsFrom` takes out first.
 */
export function commandWords(cmd: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let any = false;
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (word || any) words.push(word);
      word = '';
      any = false;
    } else word += c;
  }
  if (word || any) words.push(word);
  return words;
}

/** Whether `p` is a shell waiting for what is typed into it (a terminal opened in the folder): someone's, not the app's. */
export function interactive(p: Running): boolean {
  const [program, ...args] = commandWords(p.cmd);
  if (!program || !SHELLS.has(programName(program))) return false;
  // a flag alone (`-l`, `-NoLogo`, cmd's `/q`); a command to run or a script (`/srv/run.sh`) makes it the app's
  return args.every((a) => /^-|^\/[a-z?]$/i.test(a) && !COMMAND_FLAGS.has(a.toLowerCase()));
}

/**
 * Whether `p` runs from the folder at one of `dirs` (its path, and the one its links lead to): its
 * program lies in it, its working directory, or what it runs (the program its command line starts
 * with, or the script a runtime installed elsewhere runs, `node /ws/node_modules/vite/bin/vite.js`).
 * A command line that only names a file there (an editor's, `ssh host 'cd /ws'`) is not the folder's;
 * nor is a shell waiting for input, whose working directory is the folder (someone's terminal).
 */
export function runsFrom(p: Running, dirs: string[], windows: boolean): boolean {
  const norm = (s: string) => (windows ? s.replace(/\//g, '\\').toLowerCase() : s);
  const sep = windows ? '\\' : '/';
  const bases = [...new Set(dirs.map((d) => norm(d).replace(/[\\/]+$/, '')).filter(Boolean))];
  if (!bases.length) return false;
  const inside = (s: string) => {
    const n = norm(s).replace(/[\\/]+$/, '');
    return bases.some((base) => n === base || n.startsWith(base + sep));
  };
  if (inside(p.exe)) return true;
  if (inside(p.cwd) && !interactive(p)) return true;
  // the folder's path as one word, though it has spaces and `ps` lost its quotes
  const HERE = '\u0000';
  let cmd = norm(p.cmd);
  for (const base of bases) cmd = cmd.split(base).join(HERE);
  const there = (w: string) => w === HERE || w.startsWith(HERE + sep);
  const [program, ...args] = commandWords(cmd);
  if (!program) return false;
  if (there(program)) return true;
  if (!RUNTIMES.has(programName(program))) return false;
  const script = args.find((a) => !a.startsWith('-'));
  return !!script && there(script);
}

/** The processes `pids` started, and what those started, down the line (`all` tells who started whom). */
export function descendants(all: Running[], pids: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const found = new Set<number>();
  const next = [...pids];
  while (next.length) {
    for (const c of children.get(next.pop()!) ?? []) {
      if (found.has(c)) continue;
      found.add(c);
      next.push(c);
    }
  }
  return found;
}

/**
 * `self`, the processes that started it, and those it started itself (git in the folder, say;
 * a worker's agent, whose session has ended by the time a folder goes): never ended here.
 */
export function ownLine(all: Running[], self: number): Set<number> {
  const parent = new Map(all.map((p) => [p.pid, p.ppid]));
  const own = new Set<number>([self]);
  for (let p = parent.get(self); p && !own.has(p); p = parent.get(p)) own.add(p);
  for (const p of all) if (p.ppid === self) own.add(p.pid);
  return own;
}

/** What is to end of `all` for the folder at `dirs`: what runs from it, with what each started, `spared` aside. */
export function toEnd(all: Running[], dirs: string[], windows: boolean, spared: Set<number>): number[] {
  const matched = all.filter((p) => !spared.has(p.pid) && runsFrom(p, dirs, windows)).map((p) => p.pid);
  const ending = new Set([...matched, ...descendants(all, matched)]);
  return [...ending].filter((p) => !spared.has(p));
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
    // the folder as the host's links resolve it, and the listing shell's own process to spare
    const listed = await there.host.run(`(cd ${sh(there.path)} 2>/dev/null && pwd -P); echo "--- self $$"; ${POSIX_LIST}`, { cwd: '/', timeout: 30_000 });
    if (listed.code !== 0) return [];
    const parsed = listing(listed.stdout);
    if (!parsed) return [];
    const { real, self, all } = parsed;
    const pids = toEnd(all, [there.path, real], false, ownLine(all, self));
    if (pids.length) await there.host.run(`kill -TERM ${pids.join(' ')} 2>/dev/null; sleep ${GRACE_MS / 1000}; kill -KILL ${pids.join(' ')} 2>/dev/null; true`, { timeout: 30_000 });
    return pids;
  }
  const windows = process.platform === 'win32';
  let born: number;
  let real: string;
  try {
    born = statSync(path).birthtimeMs;
    real = realpathSync.native(path);
  } catch {
    return [];
  }
  const all = await localProcesses(windows ? born - BORN_SLACK_MS : 0);
  const pids = toEnd(all, [path, real], windows, ownLine(all, process.pid));
  if (!pids.length) return [];
  if (windows) await spawnOutput(['taskkill', ...pids.flatMap((p) => ['/PID', String(p)]), '/T', '/F'], { stdin: 'ignore', timeout: 30_000 });
  else await endPosix(pids);
  return pids;
}

/**
 * The processes on this machine; on Windows with their program, command line and working
 * directory, those started since `since` (ms since the epoch) first, the older ones as long as
 * time remains (`windows-processes.ts`).
 */
export async function localProcesses(since = 0): Promise<Running[]> {
  if (process.platform === 'win32') {
    const worker = new Worker(new URL('./windows-processes.ts', import.meta.url).href);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Running[]>((done, fail) => {
        worker.onmessage = (e: MessageEvent<Running[]>) => done(e.data);
        worker.onerror = (e) => fail(new Error(e.message));
        worker.addEventListener('close', () => fail(new Error('the process listing ended without an answer')));
        // a listing that hangs (a read that never comes back) leaves the folder to go without it
        timer = setTimeout(() => fail(new Error(`the process listing took longer than ${WINDOWS_LIST_MS / 1000} s`)), WINDOWS_LIST_MS + 5000);
        worker.postMessage({ since, until: Date.now() + WINDOWS_LIST_MS });
      });
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  }
  return parsePosix((await spawnOutput(['sh', '-c', POSIX_LIST], { cwd: '/', stdin: 'ignore', timeout: 30_000 })).stdout);
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
 * programs from `/proc` (Linux), or from `lsof` and `ps` (macOS: its `comm` is the program's path),
 * in one call each rather than one per process. `lsof` asks only for the user's own processes where
 * Obeya does not run as root: it could end no others, and it answers in half the time.
 */
const POSIX_LIST = [
  'ps axww -o pid=,ppid=,args=',
  "echo '--- dirs'",
  'if [ -d /proc/self ]; then ls -l /proc/[0-9]*/cwd /proc/[0-9]*/exe 2>/dev/null',
  'elif [ "$(id -u)" = 0 ]; then lsof -nP -a -d cwd -Fpn 2>/dev/null',
  'else lsof -nP -a -d cwd -u "$(id -u)" -Fpn 2>/dev/null; fi',
  "[ -d /proc/self ] || { echo '--- programs'; ps ax -o pid=,comm=; }",
  'true',
].join('; ');

/** What a host's listing printed (`endProcessesIn`): the folder as its links resolve it, the listing shell's process, and the processes. */
export function listing(out: string): { real: string; self: number; all: Running[] } | null {
  // the line of its own: the listing's command line, in `ps`, names it again
  const at = /^--- self (\d+)$/m.exec(out);
  if (!at) return null;
  return { real: out.slice(0, at.index).trim(), self: Number(at[1]), all: parsePosix(out.slice(at.index + at[0].length + 1)) };
}

export function parsePosix(out: string): Running[] {
  // each section begins on a line of its own (the listing's own command line, in `ps`, names them too)
  const [listed = '', rest = ''] = out.split(/^--- dirs$/m);
  const [dirs = '', programs = ''] = rest.split(/^--- programs$/m);
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
  // macOS's `ps -o comm`: "  123 /the/program"
  for (const line of programs.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    const p = m && all.get(Number(m[1]));
    if (p && m[2]!.trim().startsWith('/')) p.exe = m[2]!.trim();
  }
  return [...all.values()];
}
