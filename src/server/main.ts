// obeya <repo>… [--name <canvas>] [--adapter <name>] [--workspace <path>]… [--clones <n>]
// obeya --config <canvases.json>
//   [--port <n>] [--dev] [--permission-mode <mode>]
//
// Serves canvases at http://127.0.0.1:<port>. Without --config: one canvas with the given
// repositories (the first is its home; --adapter, --workspace and --clones apply to it). With
// --config: the canvases the JSON file lists, `[{ "name"?, "repos": [{ "path", "adapter"?,
// "workspaces"?, "clones"? }] }]`. Data lives in $OBEYA_HOME/obeya.db (default ~/.obeya).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type CanvasConfig, CanvasRuntime } from './canvas';
import { Store } from './db';
import { ghForge } from './forge';
import { sdkRuntime } from './runtime';
import { serve } from './server';
import { WhisperSidecar } from './voice';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: 'string' },
    name: { type: 'string' },
    adapter: { type: 'string' },
    port: { type: 'string', default: process.env.OBEYA_PORT ?? '4417' },
    dev: { type: 'boolean', default: false },
    workspace: { type: 'string', multiple: true, default: [] },
    clones: { type: 'string' },
    'permission-mode': { type: 'string', default: 'auto' },
  },
  allowPositionals: true,
});

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

let configs: CanvasConfig[];
if (values.config) {
  configs = (JSON.parse(readFileSync(expand(values.config), 'utf8')) as CanvasConfig[]).map((c) => ({
    ...c,
    repos: c.repos.map((r) => ({ ...r, path: expand(r.path), ...(r.workspaces ? { workspaces: r.workspaces.map(expand) } : {}) })),
  }));
} else if (positionals.length) {
  configs = [
    {
      ...(values.name ? { name: values.name } : {}),
      repos: positionals.map((path, i) =>
        i === 0
          ? {
              path,
              ...(values.adapter ? { adapter: values.adapter } : {}),
              ...(values.workspace.length ? { workspaces: values.workspace } : {}),
              ...(values.clones ? { clones: Number(values.clones) } : {}),
            }
          : { path },
      ),
    },
  ];
} else {
  console.error('usage: obeya <repo>… [--name <canvas>] [--adapter <name>] [--workspace <path>]… [--clones <n>] | --config <file>; [--port <n>] [--dev] [--permission-mode <mode>]');
  process.exit(2);
}

const home = process.env.OBEYA_HOME ?? join(homedir(), '.obeya');
const store = new Store(join(home, 'obeya.db'));
const canvases = configs.map(
  (c) => new CanvasRuntime(c, { store, home, runtime: sdkRuntime, forge: ghForge, permissionMode: values['permission-mode'] as 'auto', watch: true }),
);
const ids = canvases.map((c) => c.id);
if (new Set(ids).size !== ids.length) {
  console.error(`two canvases share an id: ${ids.join(', ')}; give them different names`);
  process.exit(2);
}
const transcriber = new WhisperSidecar();
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    for (const c of canvases) c.shutdown();
    transcriber.stop();
    process.exit(0);
  });

const server = serve(canvases, transcriber, Number(values.port), values.dev);
console.log(`Obeya on ${server.url}`);
for (const c of canvases) {
  console.log(`  ${c.board.canvas.name} (?c=${c.id})`);
  for (const r of c.repos)
    console.log(
      `    ${r.ref.id}: ${r.info.path} (${r.adapter.name} adapter; ${r.adapter.workspaces === 'worktrees' ? 'a worktree per card' : `clones: ${r.workspaces.list().map((w) => w.path).join(', ') || 'none (--workspace or --clones)'}`})`,
    );
}
