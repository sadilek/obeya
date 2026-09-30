import { basename } from 'node:path';
import type { RepoAdapter, RepoInfo } from './types';

/** Repository name from the `origin` URL, else the directory name. */
export function repoName(repo: RepoInfo): string {
  const fromRemote = repo.remote?.replace(/\.git$/, '').split(/[/:]/).pop();
  return fromRemote || basename(repo.path);
}

/** Any repository that keeps plan docs under `docs/plan/`. */
export const generic: RepoAdapter = {
  name: 'generic',
  matches: () => true,
  canvasId: repoName,
  canvasName: repoName,
  planDocs: { dir: 'docs/plan', exclude: ['TEMPLATE.md'] },
};
