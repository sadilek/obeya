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
  softPaths: ['docs/'],
  demo: {
    required: true,
    howToRun: [
      'run a scratch Obeya from your worktree. Make a scratch git repository (git init, one commit) with a plan doc in docs/plan/ whose `## Workstreams` checklist fits the demo, then start',
      '`OBEYA_HOME=$(mktemp -d) bun src/server/main.ts <scratch repo> --adapter obeya --port <a free port>` in the background and record against http://127.0.0.1:<port>/.',
      'Create cards with `POST /api/cards` and put them into the states the demo needs with `PATCH /api/cards/:id` (`state`, `need`).',
      'Start real workers in the scratch instance only when the change is about agents; they take minutes.',
      'Stop the instance when the demo is rendered.',
    ].join(' '),
  },
};
