import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
import type { RepoAdapter, RepoInfo } from '../adapters/types';
import { type OtherDoc, type PlanDoc, parsePlanDoc, type Workstream } from '../core/plan-doc';
import { defaultBranch, gitOrNull } from './workspaces';

export function repoInfo(path: string): RepoInfo {
  if (gitOrNull(path, 'rev-parse', '--git-dir') === null) throw new Error(`${path} is not a git repository`);
  return { path, remote: gitOrNull(path, 'remote', 'get-url', 'origin'), branch: defaultBranch(path) };
}

/**
 * The host of a git remote URL (`https://host/…`, `ssh://user@host:22/…`, `user@host:path`); null
 * for a repository on this machine (a path, `file://`, a Windows drive).
 */
export function remoteHost(url: string): string | null {
  const m = url.includes('://') ? /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) : /^(?:[^@/\\]+@)?([^/\\:]{2,}):/.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Whether two git remote URLs name the same repository, in whichever form git takes each: https,
 * `ssh://` and `user@host:path` of one repository are the same (user, port, `.git` and case aside);
 * paths of this machine are compared as they are written.
 */
export function sameRemote(a: string, b: string): boolean {
  const key = (url: string) => {
    const u = url.trim();
    const host = remoteHost(u);
    const path = host ? u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^[^/\\:]*:/, '') : u;
    return `${host ?? ''}|${path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, host ? '' : '/')}`.toLowerCase();
  };
  return key(a) === key(b);
}

/**
 * Whether gh takes a host's token from `GH_ENTERPRISE_TOKEN` rather than `GH_TOKEN`: a GitHub
 * Enterprise server, unlike github.com and Enterprise Cloud's `*.ghe.com`.
 */
export const enterpriseServer = (host: string) => host !== 'github.com' && !host.endsWith('.ghe.com') && host !== 'github.localhost';

/**
 * The hosts the GitHub CLI is logged into, from its `hosts.yml` (its config directory as gh finds
 * it: `GH_CONFIG_DIR`, `XDG_CONFIG_HOME/gh`, on Windows `%AppData%\GitHub CLI`, else `~/.config/gh`),
 * and the host `GH_HOST` names where the environment holds a token gh reads for it. Read from
 * the file rather than asked of `gh auth status`, which checks each login over the network.
 */
export function ghHosts(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const dir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'gh') : platform === 'win32' && env.AppData ? join(env.AppData, 'GitHub CLI') : join(homedir(), '.config', 'gh'));
  const host = env.GH_HOST?.trim().toLowerCase();
  const token = host && (enterpriseServer(host) ? env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN : env.GH_TOKEN || env.GITHUB_TOKEN);
  const fromEnv = host && token ? [host] : [];
  try {
    return [...readFileSync(join(dir, 'hosts.yml'), 'utf8').matchAll(/^([^\s#:][^:]*):\s*$/gm)].map((m) => m[1]!.trim().toLowerCase()).concat(fromEnv);
  } catch {
    return fromEnv;
  }
}

/**
 * Whether a remote is on GitHub: github.com and its subdomains, Enterprise Cloud's `*.ghe.com`
 * (which gh may reach through a token in the environment alone), or a host the GitHub CLI is
 * logged into (a GitHub Enterprise server).
 */
export function onGitHub(url: string, hosts: () => string[] = ghHosts): boolean {
  const host = remoteHost(url);
  return !!host && (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.ghe.com') || hosts().includes(host));
}

/**
 * The plan directory where it is a folder of this machine outside the repository (an absolute path,
 * or one from `~`), as an absolute path with forward slashes, which is how its docs are referred to;
 * null for a directory in the repository.
 */
export function outsidePlanDir(dir: string, home: string = homedir()): string | null {
  const path = dir === '~' ? home : dir.startsWith('~/') || dir.startsWith('~\\') ? join(home, dir.slice(2)) : dir;
  // forward slashes: a plan reference `C:\…` would read as one of the repository `C`
  // without a slash at the end, but a root keeps its own (`/`, `C:/`)
  return isAbsolute(path) ? path.replaceAll('\\', '/').replace(/([^:/])\/+$/, '$1') : null;
}

/** The plan directory of the repository read at `repoPath`, and the directory its watch reaches up to. */
function planDirOf(repoPath: string, adapter: RepoAdapter): { dir: string; root: string } {
  const outside = outsidePlanDir(adapter.planDocs.dir);
  return outside ? { dir: outside, root: parse(outside).root } : { dir: join(repoPath, adapter.planDocs.dir), root: repoPath };
}

/**
 * The docs in the plan directory of the working tree, or of the folder outside the repository it
 * names: those that describe a project, and the others with the reason they are not one (none
 * without the directory).
 */
export function readPlanDocs(repoPath: string, adapter: RepoAdapter): { docs: PlanDoc[]; others: OtherDoc[] } {
  const { dir } = planDirOf(repoPath, adapter);
  const named = outsidePlanDir(adapter.planDocs.dir) ?? adapter.planDocs.dir;
  const docs: PlanDoc[] = [];
  const others: OtherDoc[] = [];
  if (!existsSync(dir)) return { docs, others };
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !adapter.planDocs.exclude.includes(f))
    .sort()) {
    const file = `${named}/${f}`;
    let markdown: string;
    try {
      markdown = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue; // a directory named *.md, or gone since
    }
    const doc = parsePlanDoc(file, markdown);
    if ('reason' in doc) others.push(doc);
    else docs.push(doc);
  }
  return { docs, others };
}

/**
 * Every workstream the plan doc at `path` in the repository at `repoPath` had in its last `max`
 * commits, the newest first, each as the doc read when a commit left it; none where git has no
 * history of it. A card whose workstream the doc no longer lists takes its title from here.
 */
export function planHistory(repoPath: string, path: string, max = 200): Workstream[] {
  // with all of the doc as context, each commit's one hunk is the whole doc as the commit left it
  const log = gitOrNull(repoPath, 'log', '-p', `--max-count=${max}`, '--unified=1000000', '--no-color', '--no-ext-diff', '--format=%x01', '--', path);
  if (!log) return [];
  return log.split('\x01').flatMap((commit) => {
    const at = commit.search(/^@@.*$/m);
    if (at < 0) return [];
    const lines = commit
      .slice(at)
      .split('\n')
      .slice(1)
      .flatMap((l) => (l.startsWith('+') || l.startsWith(' ') ? [l.slice(1)] : []));
    const doc = parsePlanDoc(path, `${lines.join('\n')}\n`);
    return 'reason' in doc ? [] : doc.workstreams;
  });
}

/**
 * Calls `fn` (debounced) whenever a plan doc changes. Git removes the plan directory with its last
 * doc, and the directory's own watch reports nothing then, so the nearest directory above it that
 * exists is watched too: the plan directory going or coming re-arms the watches. Every `poll` ms
 * (0: never) the plan directory is also compared with what it was at the last call, which catches
 * the changes the watches miss; `watches: false` leaves only that.
 */
export function watchPlanDocs(
  repoPath: string,
  adapter: RepoAdapter,
  fn: () => void,
  { watches = true, poll = safetyNetPoll }: { watches?: boolean; poll?: number } = {},
): () => void {
  const { dir, root } = planDirOf(repoPath, adapter);
  /** The open watches, by directory and what of it they report. */
  const open = new Map<string, () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seen = poll ? planDirState(dir) : null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (poll) seen = planDirState(dir);
      arm();
      fn();
    }, 150);
  };
  const interval = poll
    ? setInterval(() => {
        if (!timer && planDirState(dir) !== seen) fire();
      }, poll)
    : undefined;
  const arm = () => {
    if (!watches) return;
    for (let d = dir; d.length > root.length; d = dirname(d)) if (!existsSync(d) && watchedInodes.has(d)) recreated.add(d);
    const wanted = new Map<string, () => () => void>();
    if (existsSync(dir))
      wanted.set(`${dir}/*.md`, () =>
        watchDir(dir, (file) => {
          if (file && !file.endsWith('.md')) return;
          fire();
        }),
      );
    // the nearest directory above, within the repository (or the folder's drive), for the next step down to the plan directory
    let below = dir;
    let above = dirname(dir);
    while (!existsSync(above) && above.length > root.length) [below, above] = [above, dirname(above)];
    const name = basename(below);
    wanted.set(below, () =>
      watchDir(above, (file) => {
        if (file && file !== name) return;
        fire();
      }),
    );
    for (const [key, stop] of open)
      if (!watchKeepsPath || !wanted.has(key)) {
        stop();
        open.delete(key);
      }
    for (const [key, start] of wanted) if (!open.has(key)) open.set(key, start());
  };
  arm();
  return () => {
    clearTimeout(timer);
    clearInterval(interval);
    open.forEach((stop) => stop());
  };
}

/**
 * On macOS a saturated fseventsd delivers events seconds late or not at all, even to a watch that
 * is live: it coalesces what it dropped into one event for a directory above, and Bun passes on
 * only events under the watched path. The plan directory is polled every few seconds there as a
 * safety net behind the watches.
 */
const safetyNetPoll = process.platform === 'darwin' ? 2000 : 0;

/** The plan docs' names, mtimes and sizes; null without the plan directory. */
function planDirState(dir: string): string | null {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => {
        const s = statSync(join(dir, f), { throwIfNoEntry: false });
        return `${f}:${s?.mtimeMs}:${s?.size}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * On macOS a watch follows its path, so it stays good when its directory is removed and created
 * again, and is kept open while it is wanted: Bun has one FSEvents stream for all watches of the
 * process and starts it afresh for each new one, which drops the events of every watch until the
 * new stream is live (up to 200 ms on a busy machine, more when many open at once). Elsewhere a
 * watch belongs to the directory itself and is live at once, so it is opened afresh.
 */
const watchKeepsPath = process.platform === 'darwin';

/**
 * Bun before 1.3.14 on Linux, whose watches misbehave: closing one while Bun still lists its
 * directory can deadlock a thread of Bun's work pool, after which no page bundles any more
 * (docs/design/distribution.md, Builds), so Obeya warns of it in the log and on the canvas; and
 * see below.
 */
export function oldLinuxBun(platform: string = process.platform, version: string = Bun.version): boolean {
  return platform === 'linux' && Bun.semver.order(version, '1.3.14') < 0;
}

/**
 * Bun before 1.3.14 on Linux delivers no events for a directory at a path that was watched before
 * and has since been removed and created again, even to a new watch
 * (https://github.com/oven-sh/bun/issues/42570). Such a directory is polled instead.
 */
const watchIsInertAfterRecreate = oldLinuxBun();
/** Each directory watched so far, with its inode then; and those seen gone since. */
const watchedInodes = new Map<string, number>();
const recreated = new Set<string>();

/** Calls `onChange` with the name of an entry of `path` that changed (or none); returns the stop. */
function watchDir(path: string, onChange: (file?: string) => void): () => void {
  const ino = statSync(path).ino;
  if (watchedInodes.get(path) !== undefined && watchedInodes.get(path) !== ino) recreated.add(path);
  watchedInodes.set(path, ino);
  if (watchIsInertAfterRecreate && recreated.has(path)) return pollDir(path, onChange);
  const watcher = watch(path, (_, file) => onChange(file ? String(file) : undefined));
  return () => watcher.close();
}

function pollDir(path: string, onChange: (file?: string) => void): () => void {
  const entries = () => {
    const seen = new Map<string, string>();
    try {
      for (const name of readdirSync(path)) {
        const s = statSync(join(path, name), { throwIfNoEntry: false });
        seen.set(name, s ? `${s.mtimeMs}:${s.size}` : '');
      }
    } catch {}
    return seen;
  };
  let last = entries();
  const interval = setInterval(() => {
    const now = entries();
    const changed = [...new Set([...last.keys(), ...now.keys()])].filter((name) => last.get(name) !== now.get(name));
    last = now;
    if (!existsSync(path)) onChange();
    else changed.forEach((name) => onChange(name));
  }, 500);
  return () => clearInterval(interval);
}
