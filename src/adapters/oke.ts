import { generic } from './generic';
import type { RepoAdapter } from './types';

/** OK Energy's platform repository (`OK-Energy-Group/oke`) and its clones. */
export const oke: RepoAdapter = {
  ...generic,
  name: 'oke',
  matches: (repo) => /OK-Energy-Group\/oke(\.git)?$/i.test(repo.remote ?? ''),
  canvasId: () => 'oke',
  canvasName: () => 'OKE',
  stack: {
    start: './scripts/app-host.sh --background',
    refresh: './scripts/restart-api.ts',
    urls: { file: '.apphost.urls', frontendKey: 'FRONTEND' },
  },
  checks: ['scripts/ci.ts'],
  demo: {
    required: true,
    howToRun:
      'use the AppHost of your clone: `.apphost.urls` names its FRONTEND; if none runs in this clone, start one with `./scripts/app-host.sh --background` (seeded, random ports). The demo skill has the OKE recipe (login, QA data, migrations).',
  },
  land: 'pr',
  // csharpier finds no files inside a worktree, and each clone runs its own app stack
  workspaces: 'clones',
};
