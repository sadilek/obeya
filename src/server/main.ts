// obeya [--config <canvases.json>]
// obeya <repo>… [--name <canvas>] [--adapter <name>] [--workspace <path>]… [--clones <n>]
//   [--port <n>] [--dev] [--permission-mode <mode>] [--idle-workers]
//
// Serves canvases at http://127.0.0.1:<port>. Without repositories: the canvases the JSON file
// lists, `[{ "name"?, "id"?, "repos": [{ "path", "adapter"?, "workspaces"?, "clones"? }] }]`, by default
// $OBEYA_HOME/canvases.json. With repositories: one canvas with them (the first is its home;
// --adapter, --workspace and --clones apply to it). Data lives in $OBEYA_HOME/obeya.db (default
// ~/.obeya).
//
// Without --dev the process supervises the server: it runs it as a child and starts it again
// when the server exits to pick up new code on Obeya's own checkout (self-update.ts), or a
// configuration the owner saved (config.ts). Saved while the canvases came from the command line,
// it starts the server from the file from then on.
//
// --idle-workers: no agent works on a started card (a scratch Obeya for a demo, scripts/scratch-obeya.ts).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RestartReason } from '../core/types';
import { type CanvasConfig, CanvasRuntime } from './canvas';
import { Config, CONFIG_FILE, expand, expandConfig, readConfigFile } from './config';
import { Store } from './db';
import { ghForge } from './forge';
import { idleRuntime, sdkRuntime } from './runtime';
import { ownCheckout, RESTART, RESTART_FROM_FILE, Restarter, watchOwnCode } from './self-update';
import { serve } from './server';
import { SpeechSidecar, WhisperSidecar } from './voice';

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
    'idle-workers': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const home = process.env.OBEYA_HOME ?? join(homedir(), '.obeya');
const configFile = values.config ? resolve(expand(values.config)) : join(home, CONFIG_FILE);

if (!values.dev && !process.env.OBEYA_SUPERVISED) {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child?.kill(sig));
  let args = process.argv.slice(1);
  for (;;) {
    child = Bun.spawn([process.execPath, ...args], {
      env: { ...process.env, OBEYA_SUPERVISED: '1' },
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const code = await child.exited;
    if (code === RESTART_FROM_FILE) {
      // the owner saved the configuration of canvases given on the command line: the file is it now
      args = [args[0]!, '--config', configFile, '--port', values.port, '--permission-mode', values['permission-mode']];
      console.log(`Obeya: starting again with ${configFile}`);
    } else if (code === RESTART) console.log('Obeya: starting again with the new code');
    else process.exit(code);
  }
}

let started: CanvasConfig[];
const source = values.config || !positionals.length ? 'file' : 'args';
if (source === 'file') {
  if (!existsSync(configFile)) {
    console.error(`usage: obeya [--config <file>] | <repo>… [--name <canvas>] [--adapter <name>] [--workspace <path>]… [--clones <n>]; [--port <n>] [--dev] [--permission-mode <mode>]
(without repositories Obeya reads ${configFile}, which does not exist)`);
    process.exit(2);
  }
  started = readConfigFile(configFile);
} else {
  started = [
    {
      ...(values.name ? { name: values.name } : {}),
      repos: positionals.map((path, i) =>
        i === 0
          ? {
              path: resolve(expand(path)),
              ...(values.adapter ? { adapter: values.adapter } : {}),
              ...(values.workspace.length ? { workspaces: values.workspace.map((w) => resolve(expand(w))) } : {}),
              ...(values.clones ? { clones: Number(values.clones) } : {}),
            }
          : { path: resolve(expand(path)) },
      ),
    },
  ];
}
const configs = expandConfig(started);

const store = new Store(join(home, 'obeya.db'));
// work that lands on the checkout this code comes from restarts the server, so what is live is what runs
const own = process.env.OBEYA_SUPERVISED ? ownCheckout() : null;
let canvases: CanvasRuntime[] = [];
let server: ReturnType<typeof serve> | undefined;
let exitCode = RESTART;
/** Starts the server again once no worker is in the middle of a turn, or when the owner says so. */
const busy = () => canvases.flatMap((c) => c.busy().map((card) => ({ canvas: c.id, card })));
const restarter = new Restarter({
  busy,
  go: () => {
    server?.stop(true);
    shutdown(exitCode);
  },
});
// workers in the middle of a turn hear of a restart that waits for them, and pause for it
restarter.onChange(() => {
  const due = restarter.due();
  for (const c of canvases) c.restartDue(due && { reason: due.reason, deadline: due.deadline });
});
const restart = (reason: RestartReason, why: string) => {
  if (!restarter.due()) console.log(`Obeya: ${why}; restarting${busy().length ? ' once no worker is in the middle of a turn' : ''}`);
  restarter.request(reason);
};
const config = new Config({
  file: configFile,
  source,
  started,
  store,
  running: () => canvases.map((c) => c.id),
  server: { port: Number(values.port), home, permissionMode: values['permission-mode'] },
  ...(process.env.OBEYA_SUPERVISED
    ? {
        restart: () => {
          // canvases from the command line come from the saved file from now on
          if (source === 'args') exitCode = RESTART_FROM_FILE;
          restart('config', 'the configuration changed');
        },
      }
    : {}),
});
canvases = configs.map(
  (c) =>
    new CanvasRuntime(c, {
      store,
      home,
      runtime: sdkRuntime,
      ...(values['idle-workers'] ? { workerRuntime: idleRuntime } : {}),
      forge: ghForge,
      permissionMode: values['permission-mode'] as 'auto',
      watch: true,
      ownCheckout: own,
      config,
    }),
);
const ids = canvases.map((c) => c.id);
if (new Set(ids).size !== ids.length) {
  console.error(`two canvases share an id: ${ids.join(', ')}; give them different names`);
  process.exit(2);
}
const transcriber = new WhisperSidecar();
const speaker = new SpeechSidecar();
const shutdown = (code: number) => {
  for (const c of canvases) c.shutdown();
  transcriber.stop();
  speaker.stop();
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => shutdown(0));

server = serve(canvases, { transcriber, speaker }, Number(values.port), values.dev, config, restarter);
console.log(`Obeya on ${server.url} (${source === 'file' ? configFile : 'canvases from the command line'})`);
if (own) watchOwnCode(own, (from, to) => restart('code', `${own} moved from ${from.slice(0, 7)} to ${to.slice(0, 7)}`));
for (const c of canvases) {
  console.log(`  ${c.board.canvas.name} (?c=${c.id})`);
  for (const r of c.repos)
    console.log(
      `    ${r.ref.id}: ${r.info.path} (${r.adapter.name} adapter; ${r.adapter.workspaces === 'worktrees' ? 'a worktree per card' : `clones: ${r.workspaces.list().map((w) => w.path).join(', ') || 'none (--workspace or --clones)'}`})`,
    );
}
