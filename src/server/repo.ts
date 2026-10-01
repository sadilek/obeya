import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
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

/** Calls `fn` (debounced) whenever a plan doc changes. */
export function watchPlanDocs(repoPath: string, adapter: RepoAdapter, fn: () => void): () => void {
  const dir = join(repoPath, adapter.planDocs.dir);
  if (!existsSync(dir)) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const w = watch(dir, (_, file) => {
    if (file && !String(file).endsWith('.md')) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 150);
  });
  return () => w.close();
}
