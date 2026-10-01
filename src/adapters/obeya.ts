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
      'a scratch Obeya from your worktree, staged by `bun scripts/scratch-obeya.ts <stage.json>` (its header describes the stage file): a fresh repository with plan docs, a fresh OBEYA_HOME and the cards in the states the demo needs, in about a second.',
      "Stage afresh before every take: call it from the demo's `login` and record against the `url` it prints.",
      'Its workers are idle: a started card is in progress without an agent. Give it `--real-workers` only when the change is about what agents do; they take minutes.',
      'For a before and after, stage a second instance from the earlier commit with `--code <commit> --port <another port>`.',
      'Stop each instance with `--stop <port>` when the demo is rendered.',
    ].join(' '),
  },
};
