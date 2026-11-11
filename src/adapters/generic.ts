import { basename } from 'node:path';
import type { RepoAdapter, RepoInfo } from './types';

/** Repository name from the `origin` URL (or its path, on Windows with backslashes), else the directory name. */
export function repoName(repo: RepoInfo): string {
  const fromRemote = repo.remote?.replace(/\.git$/, '').split(/[/\\:]/).pop();
  return fromRemote || basename(repo.path);
}

/**
 * Obeya's defaults, for what a repository's settings leave out: plan docs under `docs/plan/`, English
 * in git, no checks and no setup, pull requests merged by Obeya.
 */
export const generic: RepoAdapter = {
  planDocs: { dir: 'docs/plan', exclude: ['TEMPLATE.md'] },
  language: 'en',
  land: 'pr',
  autoMerge: true,
  checks: [],
  setup: '',
  workspaces: 'worktrees',
  softPaths: ['docs/plan/'],
  prNoise: [],
};
