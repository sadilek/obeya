// obeya [--config <canvases.json>]
// obeya <repo>… [--name <canvas>] [--workspace <path>]… [--clones <n>]
//   [--port <n>] [--dev] [--permission-mode <mode>] [--idle-workers | --record <dir> | --replay <dir>]
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
// which installs it and starts the app again. So does the Mac app taking over an Obeya that runs
// without the app that started it (`POST /api/app-takeover`): Obeya ends with TAKEOVER, marks its
// entry so, and the app starts it again. The app starts Obeya with OBEYA_FROM_APP, which its entry
// records (`app`).
//
// One Obeya per home (instance.ts): a start on a home where one runs says where and ends. The
// running one has its port and pid in $OBEYA_HOME/server.json; while its server starts again, a
// start waits for it.
//
// --idle-workers: no agent works on a started card (a scratch Obeya for a demo, scripts/scratch-obeya.ts).
// --record <dir>: every agent's session is recorded into <dir>; --replay <dir> plays such a recording
// back instead of running agents (replay.ts; why it refuses goes into $OBEYA_HOME/replay-refused.txt).
// OBEYA_PARK_GRACE=<seconds>: how long a waiting card's app runs on before Obeya stops it
// (Parking; 300 by default), shorter for a demo or a live check.
// OBEYA_FORGE_FILE=<file.json>: pull requests come from that file instead of GitHub or Forgejo
// (file-forge.ts), for a scratch Obeya whose demo plays a forge; OBEYA_PR_POLL=<seconds>: how often
// the watcher looks at open pull requests (120 by default).

import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type RestartReason } from '../core/types';
import { type CanvasConfig, Canvases } from './canvas';
import { Config, CONFIG_FILE, expandConfig, readConfigFile } from './config';
import { checkPlugin } from './demo';
import { Store, UnusableDatabase } from './db';
import { ghForge, routedForge } from './forge';
import { forgejoForge, originOf } from './forgejo';
import { fileForge } from './file-forge';
import { NarrationHost } from './narration';
import { byHarness, claudeExecutable, endAgentsHere, CODEX_REST_AFTER_MS, sdkRuntime, withRest } from './runtime';
import { claim, release, restarting, running, takenOver } from './instance';
import { recordingRuntime, replayRuntime } from './replay';
import { findClaude, MachineSetup, welcome } from './machine';
import { codexRuntime, codexUsage } from './codex';
import { Harnesses } from './harnesses';
import { addToPath, extendPath } from './path';
import { headOf, installDependencies, ownCheckout, RESTART, RESTART_FROM_FILE, RESTART_PATIENCE_MS, Restarter, TAKEOVER, UPDATE, watchOwnCode } from './self-update';
import { AppUpdates } from './app-update';
import { SourceUpdates } from './source-update';
import { claudeUsage, UsageMeter, UsageMeters } from './usage';
import { COMPILED, resource, SELF, VERSION } from './resources';
import { oldLinuxBun, onGitHub } from './repo';
import { Access } from './remote';
import { Push } from './push';
import { Awake } from './awake';
import { claudeToken } from './hosts';
import { serve, serveNarration } from './server';
import { LocalTranscriber, VoiceIn } from './voice';
import { cloudInUse } from './voice-cloud';
import { VoiceSetup } from './voice-setup';
import { useLib } from '../../plugin/skills/demo/lib/here.ts';
import { DEMO_SETTINGS_FILE, expandHome, inLanguage, readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { DemoSpace } from './demo-space';
import { qwen3Serve, speak, voiceSpec } from '../../plugin/skills/demo/lib/voices.ts';
import { Voicing } from './walkthrough';
import type { Language } from '../core/locale';
import { agentSetting, conversationLanguage, ownerLanguage, usageMeterView } from './settings';
import { loginLink } from './owner';
import { Stalls } from './stalls';
import { hideConsoleWindows, oneStartAtATime } from './spawn';

// before anything starts a program: git and the rest flash no window on Windows, and start one at a time there
hideConsoleWindows();
oneStartAtATime();

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
    record: { type: 'string' },
    replay: { type: 'string' },
  },
  allowPositionals: true,
});

const home = process.env.OBEYA_HOME ?? join(homedir(), '.obeya');
// the home holds the logins, the cards and the agents' transcripts: the owner's alone
mkdirSync(home, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32' && (statSync(home).mode & 0o077) !== 0 && statSync(home).uid === process.getuid?.()) chmodSync(home, 0o700);
// a machine that runs on a token runs on the newest one the owner gave Obeya (claude-token), not one its environment kept since
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = claudeToken(home) ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
// what the official installers and Homebrew install is found from a process the desktop started too
extendPath();
// and from a checkout the bun this runs on, for the workers' and scripts' `bun` (the app's shell names it by its path)
if (!COMPILED) addToPath(process.env, [dirname(process.execPath)]);
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
    if (code === TAKEOVER && !stopping) takenOver(home, process.pid);
    else if (stopping || (code !== RESTART && code !== RESTART_FROM_FILE)) release(home, process.pid);
    else restarting(home, process.pid);
    if (stopping) process.exit(code === RESTART || code === RESTART_FROM_FILE ? 0 : code);
    if (code === RESTART_FROM_FILE) {
      // the owner saved the configuration of canvases given on the command line: the file is it now
      args = [
        '--config', configFile, '--port', values.port, '--permission-mode', values['permission-mode'],
        ...(values['idle-workers'] ? ['--idle-workers'] : []),
        ...(values.record ? ['--record', values.record] : []),
        ...(values.replay ? ['--replay', values.replay] : []),
      ];
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
const leave = (reason: RestartReason) => {
  server?.stop(true);
  if (reason === 'stop') return shutdown(0);
  if (reason === 'update') return shutdown(UPDATE);
  if (own && ranFrom) {
    const done = installDependencies(own, ranFrom);
    if (done.ran && done.ok) console.log(`Obeya: installed the new dependencies in ${own}`);
    else if (done.ran) console.error(`Obeya: installing the new dependencies in ${own} failed; starting again anyway\n${done.output}`);
  }
  // after a takeover the app starts it again, not the supervisor
  shutdown(reason === 'takeover' ? TAKEOVER : exitCode);
};
const restarter = new Restarter({
  busy,
  // a command in its undo window holds a restart off even when the page that said it reloads
  held: () => (live().some((c) => c.commander.holding()) ? ['voice'] : []),
  go: (reason) => {
    // the app that asked hears the answer first, which may be the request that goes at once
    if (reason === 'takeover') return void setTimeout(() => leave(reason), 100);
    leave(reason);
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
const forge = process.env.OBEYA_FORGE_FILE ? fileForge(process.env.OBEYA_FORGE_FILE) : routedForge(ghForge, forgejoForge, originOf, (remote) => onGitHub(remote));
const narration = new NarrationHost({
  argv: (voice) => qwen3Serve(voice, home),
  log: (line) => console.log(line),
  // a render's clips heard back as a walkthrough's sentences are, below
  hear: (wav, language) => (cloudInUse(home) ? Promise.resolve('voice in runs through a cloud service, which gives no times of words') : transcriber.local.timed(wav, language)),
});
// what a demo's narration reaches of Obeya, for the voice it holds loaded (narration.ts): the
// narration and nothing else, from a worker here as from one on another machine (design: Hosts)
const narrationServer = serveNarration(narration);
const narrationUrl = `http://127.0.0.1:${narrationServer.port}`;
// looked-up answers told as walkthroughs, in the voice of the demo settings, through the voice held above where it can stay loaded
const narrator = (language: Language) => inLanguage(readDemoSettings(home), language);
const voicing = new Voicing({
  speak: (text, out, language) => speak(narrator(language), text, out, home, narrationUrl),
  // demo settings without a voice: the walkthrough plays as captions
  silent: (language) => narrator(language).voice === 'none',
  warm: (language) => {
    const spec = voiceSpec(narrator(language), home);
    if (spec.kind === 'command' && spec.host) narration.load(spec.host);
    // the recognition that hears its sentences back for the times of their words
    if (!cloudInUse(home)) transcriber.local.warm();
  },
  // heard back with voice in's recognition on this machine; with voice in through a cloud service, none is there to hear with
  hear: (wav, language) => (cloudInUse(home) ? Promise.resolve([]) : transcriber.local.timed(wav, language)),
  log: (line) => console.log(line),
});
// the disk space demos take, and the frames of old renders deleted (demo-space.ts)
const demoSpace = new DemoSpace({ home, settings: () => readDemoSettings(home), file: join(home, DEMO_SETTINGS_FILE), log: (line) => console.log(line) }).start();
const config = new Config({
  file: configFile,
  source,
  started,
  store,
  running: () => live().map((c) => c.id),
  server: { port: Number(values.port), home, permissionMode: values['permission-mode'], commit: commitOf() },
  narrationUrl,
  forge,
  space: demoSpace,
  onSettings: () => {
    for (const c of live()) c.settingsChanged();
  },
  apply: (configs, ids) => canvases?.apply(configs, ids),
  failures: () => canvases?.failures() ?? [],
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
// Claude Code and Codex on this machine: which one a group runs on when the owner chose none, and what the Configuration offers
const harnesses = new Harnesses({
  cwd: home,
  claude: async () => {
    const c = await findClaude(process.env, COMPILED, process.platform, process.arch);
    return c.version ? { version: c.version, loggedIn: c.loggedIn } : null;
  },
});
// the agents that start right away (a canvas's cards resuming) start on what is there; a slow look is not waited for long
await Promise.race([harnesses.refresh().catch((e) => console.warn(`Obeya: looking at the harnesses failed: ${e instanceof Error ? e.message : e}`)), Bun.sleep(5000)]);
canvases = await Canvases.start(
  configs,
  {
    store,
    home,
    runtime: agentRuntime(),
    ...(values['idle-workers'] && !values.record && !values.replay ? { idleWorkers: true } : {}),
    forge,
    permissionMode: values['permission-mode'] as 'auto',
    watch: true,
    setupProposals: true,
    ownCheckout: own,
    config,
    workerEnv: { OBEYA_URL: narrationUrl, OBEYA_NARRATION_URL: narrationUrl },
    voicing,
    ...(process.env.OBEYA_PARK_GRACE ? { parkGrace: Number(process.env.OBEYA_PARK_GRACE) * 1000 } : {}),
    ...(process.env.OBEYA_PR_POLL ? { prPollMs: Number(process.env.OBEYA_PR_POLL) * 1000 } : {}),
    language: () => ownerLanguage(home),
    conversation: () => conversationLanguage(home),
    agents: (role) => agentSetting(home, role, harnesses.preferred()),
    settings: (path) => config.repoSettings(path),
  },
  // the canvas the setup assistant created gets a first card that says what to try
  (c) => welcome(home, [c]),
);
/** The agents' runtime: Claude Code's through the Agent SDK or Codex's app server, recorded (`--record`), or a recording played back (`--replay`). */
function agentRuntime() {
  // a session waiting longer than its prompt cache lives gives up its process, and its next message resumes it
  // (`OBEYA_REST_AFTER`, in seconds, for demos and live checks)
  const rest = process.env.OBEYA_REST_AFTER ? Number(process.env.OBEYA_REST_AFTER) * 1000 : undefined;
  const live = byHarness({ claude: withRest(sdkRuntime, rest), codex: withRest(codexRuntime, rest ?? CODEX_REST_AFTER_MS) });
  if (values.record) return recordingRuntime(live, resolve(values.record), home);
  if (!values.replay) return live;
  const refusedFile = join(home, 'replay-refused.txt');
  rmSync(refusedFile, { force: true });
  return replayRuntime(resolve(values.replay), { home, refused: (why) => writeFileSync(refusedFile, `${why}\n`) });
}
const ids = canvases.all().map((c) => c.id);
if (new Set(ids).size !== ids.length) {
  console.error(`two canvases share an id: ${ids.join(', ')}; give them different names`);
  process.exit(2);
}
const transcriber = new VoiceIn(home, new LocalTranscriber());
const voiceSetup = new VoiceSetup({ home, local: transcriber.local });
const updates = new AppUpdates();
// run from a clone of Obeya's repository: new commits on its upstream, for the owner to pull
const sources = own ? new SourceUpdates(own) : undefined;
// the plan's usage limits in the bar, while the owner has it show them and a page is open
const usage = new UsageMeters(
  [
    { harness: 'claude', meter: new UsageMeter(() => claudeUsage(home)) },
    { harness: 'codex', meter: new UsageMeter(() => codexUsage(home)) },
  ],
  { on: usageMeterView(home).on, ready: (h) => harnesses.ready(h) },
);
harnesses.onChange(() => (usage.update(), usage.changed()));
const machine = new MachineSetup({ home, config, voice: voiceSetup, harnesses });
// the canvas the assistant created gets a first card that says what to try
welcome(home, canvases.all());
const shutdown = (code: number) => {
  canvases?.shutdown();
  usage.stop();
  demoSpace.stop();
  endAgentsHere();
  awake.stop();
  // what it counted of a page's stalls, before it goes
  stalls.stop();
  access.release();
  transcriber.stop();
  narration.stop();
  // the supervisor stays across a restart, and gives the entry up when it ends
  if (!process.env.OBEYA_SUPERVISED) (code === TAKEOVER ? takenOver : release)(home, process.pid);
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
// what held the server up, or a page, for the owner to notice: in this log and in the home's stalls.log
const stalls = new Stalls({ home }).start();
server = serve(canvases, { transcriber, setup: voiceSetup }, Number(values.port), values.dev, config, restarter, narration, machine, stop, updates, access, push, sources, usage, stalls, harnesses);
claim(home, { pid: process.env.OBEYA_SUPERVISED ? process.ppid : process.pid, port: server.port!, url: `http://127.0.0.1:${server.port}`, version: VERSION, ...(process.env.OBEYA_FROM_APP ? { app: true } : {}) });
// the address as a one-time link that signs a browser in (owner.ts)
const link = access.owner.link(`http://127.0.0.1:${server.port}`);
console.log(`Obeya ${own ? `from ${own}` : VERSION} on ${link} (${source === 'file' ? configFile : 'canvases from the command line'}), agents on ${claudeExecutable() ?? 'the Claude Code the Agent SDK brings'}`);
// from the commit the server started from: a landing since is new code to it, not where it started
if (own && ranFrom) watchOwnCode(own, ranFrom, (from, to) => restart('code', `${own} moved from ${from.slice(0, 7)} to ${to.slice(0, 7)}`));
sources?.start();
if (!canvases.all().length) console.log(`  no canvas yet: the setup assistant there checks this machine and creates the first`);
for (const c of canvases.all()) {
  console.log(`  ${c.board.canvas.name} (/c/${c.id})`);
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
