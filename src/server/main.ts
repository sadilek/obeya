// obeya [--config <canvases.json>]
// obeya <repo>… [--name <canvas>] [--adapter <name>] [--workspace <path>]… [--clones <n>]
//   [--port <n>] [--dev] [--permission-mode <mode>] [--idle-workers]
//
// Serves canvases at http://127.0.0.1:<port>. Without repositories: the canvases the JSON file
// lists, `[{ "name"?, "id"?, "repos": [{ "path", "adapter"?, "workspaces"?, "clones"? }] }]`, by default
// $OBEYA_HOME/canvases.json; while that does not exist, none, and the page shows the setup
// assistant, which checks the machine and creates the first canvas (machine.ts). With repositories: one canvas with them (the first is its home;
// --adapter, --workspace and --clones apply to it). Data lives in $OBEYA_HOME/obeya.db (default
// ~/.obeya).
//
// Without --dev the process supervises the server: it runs it as a child and starts it again
// when the server exits to pick up new code on Obeya's own checkout (self-update.ts), or a
// configuration the owner saved (config.ts). Saved while the canvases came from the command line,
// it starts the server from the file from then on.
//
// Ctrl-C, SIGTERM or `POST /api/stop` (the app, app/, and Windows, which has no SIGTERM) stops
// Obeya the way a restart goes: workers in the middle of a turn hear of it and pause, and Obeya
// ends once none is (at most 15 minutes); a second Ctrl-C ends it at once. Workers it stopped are
// resumed when Obeya starts again.
//
// One Obeya per home (instance.ts): a start on a home where one runs says where and ends. The
// running one has its port and pid in $OBEYA_HOME/server.json.
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
import { NarrationHost } from './narration';
import { claudeExecutable, idleRuntime, sdkRuntime } from './runtime';
import { claim, release, running } from './instance';
import { extendPath, MachineSetup, welcome } from './machine';
import { headOf, installDependencies, ownCheckout, RESTART, RESTART_FROM_FILE, RESTART_PATIENCE_MS, Restarter, watchOwnCode } from './self-update';
import { COMPILED, resource, SELF, VERSION } from './resources';
import { serve } from './server';
import { PiperSpeaker, SpeechSidecar, voiceBackends, WhisperSidecar } from './voice';
import { VoiceSetup } from './voice-setup';
import { useLib } from '../../plugin/skills/demo/lib/here.ts';
import { qwen3Serve } from '../../plugin/skills/demo/lib/voices.ts';
import { agentSetting, ownerLanguage } from './settings';

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
// what the official installers and Homebrew install is found from a process the desktop started too
extendPath();
// the demo skill's modules this server carries inside the binary find their files among the resources
if (COMPILED) useLib(resource('plugin', 'skills', 'demo', 'lib'));
const configFile = values.config ? resolve(expand(values.config)) : join(home, CONFIG_FILE);

if (!process.env.OBEYA_SUPERVISED) {
  const other = await running(home);
  if (other) {
    console.error(`Obeya already runs on ${home}, at ${other.url} (pid ${other.pid}); one home serves one Obeya`);
    process.exit(1);
  }
}

if (!values.dev && !process.env.OBEYA_SUPERVISED) {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  // the server stops once its workers paused; whatever exit code it ends with, nothing starts again
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      stopping = true;
      child?.kill(sig);
    });
  let args = Bun.argv.slice(2);
  for (;;) {
    child = Bun.spawn([...SELF, ...args], {
      env: { ...process.env, OBEYA_SUPERVISED: '1' },
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const code = await child.exited;
    if (stopping || (code !== RESTART && code !== RESTART_FROM_FILE)) release(home, process.pid);
    if (stopping) process.exit(code === RESTART || code === RESTART_FROM_FILE ? 0 : code);
    if (code === RESTART_FROM_FILE) {
      // the owner saved the configuration of canvases given on the command line: the file is it now
      args = ['--config', configFile, '--port', values.port, '--permission-mode', values['permission-mode'], ...(values['idle-workers'] ? ['--idle-workers'] : [])];
      console.log(`Obeya: starting again with ${configFile}`);
    } else if (code === RESTART) console.log('Obeya: starting again with the new code');
    else process.exit(code);
  }
}

let started: CanvasConfig[];
const source = values.config || !positionals.length ? 'file' : 'args';
if (source === 'file' && !values.config && !existsSync(configFile)) {
  // the first start: the setup assistant creates the file
  started = [];
} else if (source === 'file') {
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
// the commit this server's code came from: what changed since decides what to install before a restart
const ranFrom = own && headOf(own);
let canvases: CanvasRuntime[] = [];
let server: ReturnType<typeof serve> | undefined;
let exitCode = RESTART;
/** Starts the server again once no worker is in the middle of a turn, or when the owner says so. */
const busy = () => canvases.flatMap((c) => c.busy().map((card) => ({ canvas: c.id, card })));
const restarter = new Restarter({
  busy,
  go: (reason) => {
    server?.stop(true);
    if (reason === 'stop') return shutdown(0);
    if (own && ranFrom) {
      const done = installDependencies(own, ranFrom);
      if (done.ran && done.ok) console.log(`Obeya: installed the new dependencies in ${own}`);
      else if (done.ran) console.error(`Obeya: installing the new dependencies in ${own} failed; starting again anyway\n${done.output}`);
    }
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
/** The commit the code runs from, for the settings beside the version; none for the compiled binary. */
const commitOf = () => {
  const checkout = own ?? ownCheckout();
  return ranFrom ?? (checkout && headOf(checkout));
};
// where this Obeya answers: a demo's narration asks it for the voice it holds loaded (narration.ts)
const url = `http://127.0.0.1:${values.port}`;
const narration = new NarrationHost({ argv: (voice, language) => qwen3Serve(voice, language, home), log: (line) => console.log(line) });
const config = new Config({
  file: configFile,
  source,
  started,
  store,
  running: () => canvases.map((c) => c.id),
  server: { port: Number(values.port), home, permissionMode: values['permission-mode'], commit: commitOf() },
  narrationUrl: url,
  ...(process.env.OBEYA_SUPERVISED
    ? {
        restart: () => {
          // canvases from the command line come from the saved file from now on
          if (source === 'args') exitCode = RESTART_FROM_FILE;
          // after the answer is out: a restart with no worker to wait for stops this server at once
          setTimeout(() => restart('config', 'the configuration changed'), 100);
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
      workerEnv: { OBEYA_URL: url },
      language: () => ownerLanguage(home),
      agents: (role) => agentSetting(home, role),
    }),
);
const ids = canvases.map((c) => c.id);
if (new Set(ids).size !== ids.length) {
  console.error(`two canvases share an id: ${ids.join(', ')}; give them different names`);
  process.exit(2);
}
const backends = voiceBackends();
const transcriber = new WhisperSidecar(backends.listen);
const speaker = backends.speech === 'macos' ? new SpeechSidecar() : new PiperSpeaker(home, () => ownerLanguage(home));
const voiceSetup = new VoiceSetup({ home, backends, prepare: () => transcriber.prepare() });
const machine = new MachineSetup({ home, config, voice: voiceSetup, restarts: !!process.env.OBEYA_SUPERVISED });
// the canvas the assistant created gets a first card that says what to try
welcome(home, canvases);
const shutdown = (code: number) => {
  for (const c of canvases) c.shutdown();
  transcriber.stop();
  speaker.stop();
  narration.stop();
  // the supervisor stays across a restart, and gives the entry up when it ends
  if (!process.env.OBEYA_SUPERVISED) release(home, process.pid);
  process.exit(code);
};
// stopping waits for the workers like a restart; a second Ctrl-C has it go ahead at once
const SAME_PRESS_MS = 1000;
let stopAsked = 0;
const stop = () => {
  if (!stopAsked) {
    stopAsked = Date.now();
    const n = busy().length;
    console.log(n ? `Obeya: stopping once no worker is in the middle of a turn (${n} ${n === 1 ? 'is' : 'are'}, at most ${RESTART_PATIENCE_MS / 60_000} minutes); Ctrl-C again stops at once` : 'Obeya: stopping');
    restarter.request('stop');
    return;
  }
  // Ctrl-C in the terminal reaches the supervisor too, which passes it on: one press arrives twice
  if (Date.now() - stopAsked < SAME_PRESS_MS) return;
  console.log('Obeya: stopping now');
  if (!restarter.now()) shutdown(0);
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, stop);

server = serve(canvases, { transcriber, speaker, setup: voiceSetup }, Number(values.port), values.dev, config, restarter, narration, machine, stop);
claim(home, { pid: process.env.OBEYA_SUPERVISED ? process.ppid : process.pid, port: server.port!, url: `http://127.0.0.1:${server.port}`, version: VERSION, app: !!process.env.OBEYA_APP });
console.log(`Obeya ${own ? `from ${own}` : VERSION} on ${server.url} (${source === 'file' ? configFile : 'canvases from the command line'}), agents on ${claudeExecutable() ?? 'the Claude Code the Agent SDK brings'}`);
if (own) watchOwnCode(own, (from, to) => restart('code', `${own} moved from ${from.slice(0, 7)} to ${to.slice(0, 7)}`));
if (!canvases.length) console.log(`  no canvas yet: the setup assistant on ${server.url} checks this machine and creates the first`);
for (const c of canvases) {
  console.log(`  ${c.board.canvas.name} (?c=${c.id})`);
  for (const r of c.repos)
    console.log(
      `    ${r.ref.id}: ${r.info.path} (${r.adapter.name} adapter; ${r.adapter.workspaces === 'worktrees' ? 'a worktree per card' : `clones: ${r.workspaces.list().map((w) => w.path).join(', ') || 'none (--workspace or --clones)'}`})`,
    );
}
