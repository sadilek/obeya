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
};
