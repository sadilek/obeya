// obeya <repo> [--adapter <name>] [--port <n>] [--dev] [--workspace <path>]… [--clones <n>]
//
// Serves the canvas of one repository at http://127.0.0.1:<port>. Data lives in
// $OBEYA_HOME/obeya.db (default ~/.obeya). Workers get a worktree per card, or lease clones from
// a pool (per adapter): given with --workspace, or --clones n created under
// $OBEYA_HOME/workspaces/<canvas>/.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pickAdapter } from '../adapters';
import { Board } from './board';
import { Store } from './db';
import { Koordinator } from './koordinator';
import { ProjectAgents } from './project-agents';
import { readPlanDocs, repoInfo, watchPlanDocs } from './repo';
import { sdkRuntime } from './runtime';
import { serve } from './server';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    adapter: { type: 'string' },
    port: { type: 'string', default: process.env.OBEYA_PORT ?? '4417' },
    dev: { type: 'boolean', default: false },
    workspace: { type: 'string', multiple: true, default: [] },
    clones: { type: 'string' },
    'permission-mode': { type: 'string', default: 'auto' },
  },
  allowPositionals: true,
});

const repoPath = positionals[0];
if (!repoPath) {
  console.error('usage: obeya <repo> [--adapter <name>] [--port <n>] [--dev] [--workspace <path>]… [--clones <n>] [--permission-mode <mode>]');
  process.exit(2);
}

const repo = repoInfo(resolve(repoPath));
const adapter = pickAdapter(repo, values.adapter);
const home = process.env.OBEYA_HOME ?? join(homedir(), '.obeya');
const store = new Store(join(home, 'obeya.db'));
const board = new Board(
  store,
  { id: adapter.canvasId(repo), name: adapter.canvasName(repo), repoPath: repo.path, branch: repo.branch },
  () => readPlanDocs(repo.path, adapter),
);
watchPlanDocs(repo.path, adapter, () => board.docsChanged());

const workspaces = new Workspaces(store, board.canvas.id, {
  mode: adapter.workspaces,
  repoPath: repo.path,
  dir: join(home, 'workspaces', board.canvas.id),
});
for (const w of values.workspace) workspaces.register(resolve(w));
if (values.clones) {
  // landing on main needs the clones to see the local main; otherwise they track the remote
  workspaces.ensureClones(adapter.land === 'main' || !repo.remote ? repo.path : repo.remote, Number(values.clones));
}
const projectAgents = new ProjectAgents(board, sdkRuntime, repo.path);
// the Koordinator needs the workers and answers their questions: created right after them
let koordinator!: Koordinator;
const workers = new Workers({
  board,
  runtime: sdkRuntime,
  workspaces,
  adapter,
  advisor: (card) => {
    const project = card.parent ? board.item(card.parent) : undefined;
    return project
      ? { by: 'project', ask: (q) => projectAgents.ask(project, card, q) }
      : { by: 'koordinator', ask: (q) => koordinator.ask(card, q) };
  },
  permissionMode: values['permission-mode'] as 'auto',
});
workers.resumeAll();
koordinator = new Koordinator({ board, runtime: sdkRuntime, workers, workspaces, adapter, repoPath: repo.path });
koordinator.resume();
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    workers.shutdown();
    process.exit(0);
  });

const server = serve(board, workers, koordinator, Number(values.port), values.dev);
console.log(`Obeya: ${board.canvas.name} (${adapter.name} adapter, ${repo.path}) on ${server.url}`);
console.log(
  adapter.workspaces === 'worktrees'
    ? `Workspaces: a worktree per card under ${join(home, 'workspaces', board.canvas.id)}`
    : `Workspaces: ${workspaces.list().map((w) => w.path).join(', ') || 'none (--workspace or --clones)'}`,
);
