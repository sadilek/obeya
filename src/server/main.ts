// obeya [--config <canvases.json>]
// obeya <repo>… [--name <canvas>] [--workspace <path>]… [--clones <n>]
//   [--port <n>] [--dev] [--permission-mode <mode>] [--idle-workers]
//
// Serves canvases at http://127.0.0.1:<port>, to the owner alone (owner.ts): it prints a link that
// signs a browser in, and a second start while it runs prints a new one. Without repositories: the canvases the JSON file
// lists, `[{ "name"?, "id"?, "repos": [{ "path", "workspaces"?, "clones"? }] }]`, by default
// $OBEYA_HOME/canvases.json; while that does not exist, none, and the page shows the setup
// assistant, which checks the machine and creates the first canvas (machine.ts). With repositories: one canvas with them (the first is its home;
// --workspace and --clones apply to it). Data lives in $OBEYA_HOME/obeya.db (default
// ~/.obeya).
//
// Without --dev the process supervises the server: it runs it as a child and starts it again
// when the server exits to pick up new code on Obeya's own checkout (self-update.ts); new commits
// on that checkout's upstream show in the bar, for the owner to pull (source-update.ts). A
// configuration the owner saves applies while the server runs (config.ts, `Canvases`); saved while
// the canvases came from the command line, it starts the server again, from the file from then on.
//
// Ctrl-C, SIGTERM or `POST /api/stop` (the app, app/, and Windows, which has no SIGTERM) stops
// Obeya the way a restart goes: workers in the middle of a turn hear of it and pause, and Obeya
// ends once none is (at most 15 minutes); a second Ctrl-C ends it at once. Workers it stopped are
// resumed when Obeya starts again. Installing a newer version of the app (`POST
// /api/app-update/install`) goes the same way, and then Obeya ends with UPDATE for the app's shell,
// which installs it and starts the app again.
//
// One Obeya per home (instance.ts): a start on a home where one runs says where and ends. The
// running one has its port and pid in $OBEYA_HOME/server.json; while its server starts again, a
// start waits for it.
//
// --idle-workers: no agent works on a started card (a scratch Obeya for a demo, scripts/scratch-obeya.ts).
// OBEYA_PARK_GRACE=<seconds>: how long a waiting card's app runs on before Obeya stops it
// (Parking; 300 by default), shorter for a demo or a live check.

import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RestartReason } from '../core/types';
import { type CanvasConfig, Canvases } from './canvas';
import { Config, CONFIG_FILE, expandConfig, readConfigFile } from './config';
import { checkPlugin } from './demo';
import { Store, UnusableDatabase } from './db';
import { ghForge, routedForge } from './forge';
import { forgejoForge, originOf } from './forgejo';
import { NarrationHost } from './narration';
import { claudeExecutable, sdkRuntime } from './runtime';
import { claim, release, restarting, running } from './instance';
import { MachineSetup, welcome } from './machine';
import { extendPath } from './path';
import { ShellReports } from './push-key';
import { headOf, installDependencies, ownCheckout, RESTART, RESTART_FROM_FILE, RESTART_PATIENCE_MS, Restarter, UPDATE, watchOwnCode } from './self-update';
import { AppUpdates } from './app-update';
import { SourceUpdates } from './source-update';
import { COMPILED, resource, SELF, VERSION } from './resources';
import { oldLinuxBun, onGitHub } from './repo';
import { Access } from './remote';
import { Push } from './push';
import { Awake } from './awake';
import { serve, serveNarration } from './server';
import { LocalTranscriber, VoiceIn } from './voice';
import { VoiceSetup } from './voice-setup';
import { useLib } from '../../plugin/skills/demo/lib/here.ts';
import { expandHome } from '../../plugin/skills/demo/lib/settings.ts';
import { qwen3Serve } from '../../plugin/skills/demo/lib/voices.ts';
import { agentSetting, conversationLanguage, ownerLanguage } from './settings';
import { loginLink } from './owner';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: 'string' },
    name: { type: 'string' },
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
// the home holds the logins, the cards and the agents' transcripts: the owner's alone
mkdirSync(home, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32' && (statSync(home).mode & 0o077) !== 0 && statSync(home).uid === process.getuid?.()) chmodSync(home, 0o700);
// what the official installers and Homebrew install is found from a process the desktop started too
extendPath();
// the demo skill's modules this server carries inside the binary find their files among the resources
if (COMPILED) useLib(resource('plugin', 'skills', 'demo', 'lib'));
const configFile = values.config ? resolve(expandHome(values.config)) : join(home, CONFIG_FILE);

if (!process.env.OBEYA_SUPERVISED) {
  const other = await running(home);
  if (other) {
    // a new link to it, for a browser not signed in yet
    const link = await loginLink(other.url, home);
    console.error(`Obeya already runs on ${home}, at ${other.url} (pid ${other.pid}); one home serves one Obeya${link ? `\nOpen it signed in: ${link}` : ''}`);
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
    else restarting(home, process.pid);
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
    console.error(`usage: obeya [--config <file>] | <repo>… [--name <canvas>] [--workspace <path>]… [--clones <n>]; [--port <n>] [--dev] [--permission-mode <mode>]
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
              path: resolve(expandHome(path)),
              ...(values.workspace.length ? { workspaces: values.workspace.map((w) => resolve(expandHome(w))) } : {}),
              ...(values.clones ? { clones: Number(values.clones) } : {}),
            }
          : { path: resolve(expandHome(path)) },
      ),
    },
  ];
}
const configs = expandConfig(started);

const store = (() => {
  try {
    return new Store(join(home, 'obeya.db'));
  } catch (e) {
    if (!(e instanceof UnusableDatabase)) throw e;
    console.error(`Obeya: ${e.message}`);
    process.exit(1);
  }
})();
// work that lands on the checkout this code comes from restarts the server, so what is live is what runs
const own = process.env.OBEYA_SUPERVISED ? ownCheckout() : null;
// the commit this server's code came from: what changed since decides what to install before a restart
const ranFrom = own && headOf(own);
let canvases: Canvases | undefined;
let server: ReturnType<typeof serve> | undefined;
let exitCode = RESTART;
const live = () => canvases?.all() ?? [];
/** Starts the server again once no worker is in the middle of a turn, or when the owner says so. */
const busy = () => live().flatMap((c) => c.busy().map((card) => ({ canvas: c.id, card })));
const restarter = new Restarter({
  busy,
  // a command in its undo window holds a restart off even when the page that said it reloads
  held: () => (live().some((c) => c.commander.holding()) ? ['voice'] : []),
  go: (reason) => {
    server?.stop(true);
    if (reason === 'stop') return shutdown(0);
    if (reason === 'update') return shutdown(UPDATE);
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
  for (const c of live()) c.restartDue(due && { reason: due.reason, deadline: due.deadline });
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
const forge = routedForge(ghForge, forgejoForge, originOf, (remote) => onGitHub(remote));
const narration = new NarrationHost({ argv: (voice, language) => qwen3Serve(voice, language, home), log: (line) => console.log(line) });
// what a demo's narration reaches of Obeya, for the voice it holds loaded (narration.ts): the
// narration and nothing else, from a worker here as from one on another machine (design: Hosts)
const narrationServer = serveNarration(narration);
const narrationUrl = `http://127.0.0.1:${narrationServer.port}`;
const config = new Config({
  file: configFile,
  source,
  started,
  store,
  running: () => live().map((c) => c.id),
  server: { port: Number(values.port), home, permissionMode: values['permission-mode'], commit: commitOf() },
  narrationUrl,
  forge,
  onSettings: () => {
    for (const c of live()) c.settingsChanged();
  },
  apply: (configs, ids) => canvases?.apply(configs, ids),
  ...(process.env.OBEYA_SUPERVISED
    ? {
        restart: () => {
          // canvases from the command line come from the saved file from now on
          exitCode = RESTART_FROM_FILE;
          // after the answer is out: a restart with no worker to wait for stops this server at once
          setTimeout(() => restart('config', 'the configuration changed'), 100);
        },
      }
    : {}),
});
canvases = new Canvases(
  configs,
  {
    store,
    home,
    runtime: sdkRuntime,
    ...(values['idle-workers'] ? { idleWorkers: true } : {}),
    forge,
    permissionMode: values['permission-mode'] as 'auto',
    watch: true,
    ownCheckout: own,
    config,
    workerEnv: { OBEYA_URL: narrationUrl, OBEYA_NARRATION_URL: narrationUrl },
    ...(process.env.OBEYA_PARK_GRACE ? { parkGrace: Number(process.env.OBEYA_PARK_GRACE) * 1000 } : {}),
    language: () => ownerLanguage(home),
    conversation: () => conversationLanguage(home),
    agents: (role) => agentSetting(home, role),
    settings: (path) => config.repoSettings(path),
  },
  // the canvas the setup assistant created gets a first card that says what to try
  (c) => welcome(home, [c]),
);
const ids = canvases.all().map((c) => c.id);
if (new Set(ids).size !== ids.length) {
  console.error(`two canvases share an id: ${ids.join(', ')}; give them different names`);
  process.exit(2);
}
const transcriber = new VoiceIn(home, new LocalTranscriber());
const voiceSetup = new VoiceSetup({ home, local: transcriber.local });
const shells = new ShellReports();
const updates = new AppUpdates();
// run from a clone of Obeya's repository: new commits on its upstream, for the owner to pull
const sources = own ? new SourceUpdates(own) : undefined;
const machine = new MachineSetup({ home, config, voice: voiceSetup, shells });
// the canvas the assistant created gets a first card that says what to try
welcome(home, canvases.all());
const shutdown = (code: number) => {
  canvases?.shutdown();
  awake.stop();
  access.release();
  transcriber.stop();
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

// other devices, when the owner lets them: the phone over the owner's own network
const access = new Access({ store, home, language: () => ownerLanguage(home) });
// and what starts waiting for the owner, pushed to the phones that turned notifications on
const push = new Push({ store, home, language: () => ownerLanguage(home) });
// while other devices may reach Obeya, the machine stays awake as long as a worker works, or the whole time
const awake = new Awake({ wanted: () => access.awake() === 'always' || (access.awake() === 'works' && busy().length > 0) }).start();
server = serve(canvases, { transcriber, setup: voiceSetup }, Number(values.port), values.dev, config, restarter, narration, machine, stop, shells, updates, access, push, sources);
claim(home, { pid: process.env.OBEYA_SUPERVISED ? process.ppid : process.pid, port: server.port!, url: `http://127.0.0.1:${server.port}`, version: VERSION, app: !!process.env.OBEYA_APP });
// the address as a one-time link that signs a browser in (owner.ts)
const link = access.owner.link(`http://127.0.0.1:${server.port}`);
console.log(`Obeya ${own ? `from ${own}` : VERSION} on ${link} (${source === 'file' ? configFile : 'canvases from the command line'}), agents on ${claudeExecutable() ?? 'the Claude Code the Agent SDK brings'}`);
if (own) watchOwnCode(own, (from, to) => restart('code', `${own} moved from ${from.slice(0, 7)} to ${to.slice(0, 7)}`));
sources?.start();
if (!canvases.all().length) console.log(`  no canvas yet: the setup assistant there checks this machine and creates the first`);
for (const c of canvases.all()) {
  console.log(`  ${c.board.canvas.name} (?c=${c.id})`);
  for (const r of c.repos)
    console.log(
      `    ${r.ref.id}: ${r.info.path} (${r.info.folder ? 'a folder without git: every card works in it' : r.adapter.workspaces === 'worktrees' ? 'a worktree per card' : `clones: ${r.workspaces.list().map((w) => w.path).join(', ') || 'none (--workspace or --clones)'}`})`,
    );
}
const plugin = checkPlugin();
if (plugin) console.warn(`Obeya: warning: ${plugin}`);
// once the deadlock struck, the canvas does not load and cannot show its warning: the log says it too
if (oldLinuxBun())
  console.warn(
    `Obeya: warning: Bun ${Bun.version} is too old; Obeya needs Bun 1.3.14 or later. On Linux this Bun can deadlock a thread of its work pool when a file watch closes, and then the canvas stops loading. Upgrade it with \`bun upgrade\` and start Obeya again.`,
  );
