// obeya <repo> [--adapter <name>] [--port <n>] [--dev]
//
// Serves the canvas of one repository at http://127.0.0.1:<port>. Data lives in
// $OBEYA_HOME/obeya.db (default ~/.obeya).

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pickAdapter } from '../adapters';
import { Board } from './board';
import { Store } from './db';
import { readPlanDocs, repoInfo, watchPlanDocs } from './repo';
import { serve } from './server';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    adapter: { type: 'string' },
    port: { type: 'string', default: process.env.OBEYA_PORT ?? '4417' },
    dev: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const repoPath = positionals[0];
if (!repoPath) {
  console.error('usage: obeya <repo> [--adapter <name>] [--port <n>] [--dev]');
  process.exit(2);
}

const repo = repoInfo(resolve(repoPath));
const adapter = pickAdapter(repo, values.adapter);
const store = new Store(join(process.env.OBEYA_HOME ?? join(homedir(), '.obeya'), 'obeya.db'));
const board = new Board(
  store,
  { id: adapter.canvasId(repo), name: adapter.canvasName(repo), repoPath: repo.path, branch: repo.branch },
  () => readPlanDocs(repo.path, adapter),
);
watchPlanDocs(repo.path, adapter, () => board.changed());

const server = serve(board, Number(values.port), values.dev);
console.log(`Obeya: ${board.canvas.name} (${adapter.name} adapter, ${repo.path}) on ${server.url}`);
