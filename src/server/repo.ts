import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from 'node:fs';
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
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      arm();
      fn();
    }, 150);
  };
  const arm = () => {
    watchers.forEach((w) => w.close());
    watchers = [];
    if (existsSync(dir))
      watchers.push(
        watch(dir, (_, file) => {
          if (file && !String(file).endsWith('.md')) return;
          fire();
        }),
      );
    // the nearest directory above, within the repository, for the next step down to the plan directory
    let below = dir;
    let above = dirname(dir);
    while (!existsSync(above) && above.length > repoPath.length) [below, above] = [above, dirname(above)];
    const name = basename(below);
    watchers.push(
      watch(above, (_, file) => {
        if (file && String(file) !== name) return;
        fire();
      }),
    );
  };
  arm();
  return () => {
    clearTimeout(timer);
    watchers.forEach((w) => w.close());
  };
}
