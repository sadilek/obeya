import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RepoAdapter, RepoInfo } from '../adapters/types';
import { type PlanDoc, parsePlanDoc } from '../core/plan-doc';
import { GIT } from './workspaces';

export function repoInfo(path: string): RepoInfo {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync([GIT, '-C', path, ...args], { stderr: 'ignore' });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  if (git('rev-parse', '--git-dir') === null) throw new Error(`${path} is not a git repository`);
  return { path, remote: git('remote', 'get-url', 'origin'), branch: git('branch', '--show-current') || 'HEAD' };
}

/** The plan docs in the working tree that describe a project. */
export function readPlanDocs(repoPath: string, adapter: RepoAdapter): PlanDoc[] {
  const dir = join(repoPath, adapter.planDocs.dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !adapter.planDocs.exclude.includes(f))
    .sort()
    .flatMap((f) => {
      const doc = parsePlanDoc(`${adapter.planDocs.dir}/${f}`, readFileSync(join(dir, f), 'utf8'));
      return doc ? [doc] : [];
    });
}

/**
 * Calls `fn` (debounced) whenever a plan doc changes. Git removes the plan directory with its last
 * doc, and the directory's own watch reports nothing then, so the nearest directory above it that
 * exists is watched too: the plan directory going or coming re-arms the watches.
 */
export function watchPlanDocs(repoPath: string, adapter: RepoAdapter, fn: () => void): () => void {
  const dir = join(repoPath, adapter.planDocs.dir);
  let stops: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      arm();
      fn();
    }, 150);
  };
  const arm = () => {
    stops.forEach((stop) => stop());
    stops = [];
    for (let d = dir; d.length > repoPath.length; d = dirname(d)) if (!existsSync(d) && watchedInodes.has(d)) recreated.add(d);
    if (existsSync(dir))
      stops.push(
        watchDir(dir, (file) => {
          if (file && !file.endsWith('.md')) return;
          fire();
        }),
      );
    // the nearest directory above, within the repository, for the next step down to the plan directory
    let below = dir;
    let above = dirname(dir);
    while (!existsSync(above) && above.length > repoPath.length) [below, above] = [above, dirname(above)];
    const name = basename(below);
    stops.push(
      watchDir(above, (file) => {
        if (file && file !== name) return;
        fire();
      }),
    );
  };
  arm();
  return () => {
    clearTimeout(timer);
    stops.forEach((stop) => stop());
  };
}

/**
 * Bun before 1.3.14 on Linux delivers no events for a directory at a path that was watched before
 * and has since been removed and created again, even to a new watch
 * (https://github.com/oven-sh/bun/issues/42570). Such a directory is polled instead.
 */
const watchIsInertAfterRecreate = process.platform === 'linux' && Bun.semver.order(Bun.version, '1.3.14') < 0;
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
