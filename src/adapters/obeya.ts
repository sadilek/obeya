import { generic } from './generic';
import type { RepoAdapter } from './types';

/** This repository: Obeya is developed on its own canvas, and approved work goes straight onto `main`. */
export const obeya: RepoAdapter = {
  ...generic,
  name: 'obeya',
  matches: (repo) => /sadilek\/obeya(\.git)?$/i.test(repo.remote ?? ''),
  canvasId: () => 'obeya',
  canvasName: () => 'Obeya',
  setup: 'bun install',
  checks: ['bun test', 'bun run typecheck'],
  land: 'main',
  workspaces: 'worktrees',
};
