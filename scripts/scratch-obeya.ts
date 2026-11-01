// A scratch Obeya for a demo or a live check, staged from one file: a fresh repository with plan
// docs, a fresh OBEYA_HOME, the server from this checkout (or from an earlier commit, for a before
// and after), and the cards in the states the demo needs. Running it again stages afresh, so a demo
// calls it before every take.
//
//   bun scripts/scratch-obeya.ts <stage.json> [--port <n>] [--code <commit> | --binary <obeya>] [--real-workers | --record <dir> | --replay <dir>] [--restarts]
//   bun scripts/scratch-obeya.ts --stop <port>
//   bun scripts/scratch-obeya.ts --login <port>
//   bun scripts/scratch-obeya.ts --say <port> <card key> <say|report|talk|question|review|to_obeya|tool|end> <text>
//   bun scripts/scratch-obeya.ts --artifact <port> <card key> <file> [<summary>]
//
// Prints one JSON line, also kept in <dir>/staged.json:
//   { "url", "port", "dir", "canvas", "pid", "log", "from", "cards": { "<key>": "<card id>" }, "record"?, "replay"? }
// The port is --port, else the stage file's `port`; without either the script picks one: the
// first from 4480 up that nothing listens on and no other scratch Obeya holds (a running one, or
// one being staged at the same time), so that workers staging at once never collide. --stop,
// --login, --say and --artifact take the `port` it printed. Staging afresh from the same stage
// file with the same --code or --binary (`from`) replaces the scratch Obeya staged from them
// before and takes its port again while that is free; with another --code, the two run side by
// side. The dir is --dir, else the stage file's `dir`, else /tmp/obeya-scratch-<port>.
// `url` signs browsers in (design: Who may talk to it), until the scratch Obeya stops; --login
// prints it again. --stop ends only the server it staged, never another program that has its
// process number by now, and fails if the server still runs after it. The script itself talks to the API with the owner's key of the scratch home.
//
// With idle workers, --say and --artifact act as a card's agent (by its key in staged.json), for a
// check of what the owner sees while an agent works: through the server, which runs the agent's own
// tools (`Workers.standIn`), so an open page gets the line at once, unread marker and notification
// as from a real agent. --say adds a line of the kind a stage file's `events` give: `say` (the
// agent's words between its steps), `report` (its status line), `talk` (a reply), `question` (it
// asks, and the card waits for the owner), `review` (a handover that keeps the card's demo); besides
// those, `to_obeya` (it passes the owner's words on to Obeya, whose Koordinator is real and answers
// on the card), `tool` (any other tool of the agent's, the text a JSON object `{ "tool", "args" }`)
// and `end` (the agent's turn ends, which an idle worker's never does by itself).
// --artifact copies the file into the card's HTML artifact (<dir>/artifacts/<key>, where staging
// put a copy of the stage's) and hands it over again, as an agent does after rewriting it, with the
// summary given or "Updated the artifact."; a card without one starts it with an index.html. Each
// prints what the agent would have read back, and fails on a refusal ("Not handed over: …").
//
// --record <dir> runs real workers, as --real-workers, and records every agent's session (the
// Koordinator's, the workers', any other) into <dir>, emptied first (it must be empty, new, or a
// recording). --replay <dir> plays such a recording back instead of running agents: each agent does
// what it did in the recorded take, through Obeya's own tools of this code, and its handovers bring
// the recorded commits and demo; card ids, branches and paths of the recording stand for those of
// this staging. A take played back comes out the same each time, in minutes and without Claude: it
// goes at the recorded pace, except what the recorded take cut out (`d.skip`), which goes by in a
// moment. Those cuts are the take's `.work/cuts.json` in <dir>: the demo copies it in after the
// recorded take, or, for a recording in the demo's directory (<demo dir>/recording), the first
// playback takes it from <demo dir>/.work while it is still the recorded take's; without them no wait
// of the recording lasts long. Once the agents' instructions or tools differ from the recording's,
// or a tool refuses what it took then, the playback refuses: the card shows the error, and the
// scratch Obeya's home/replay-refused.txt says why (record anew). What the agents hear must stay as
// recorded too: a changed command or comment needs a recorded take, since the recorded agents act
// on the old one (the server's log names what differs; src/server/replay.ts).
//
// The server runs with --dev (it does not restart when the checkout commits; with --restarts it is
// supervised like a real Obeya and restarts once the configuration is saved, PUT /api/config, and
// for commits on this checkout when it runs this checkout's code) and, unless
// --real-workers, with --idle-workers: a started card is in progress without an agent. The
// Koordinator and voice are real. --code <commit> runs that commit's code (`git archive`, with
// this checkout's node_modules) in <dir>/code; that starts cold and on a busy machine takes well
// over half a minute, so the script waits up to 5 minutes for the server while its process lives.
// --binary <obeya> runs a compiled Obeya instead (`bun run build`), with the resources beside it.
// Bun's dev server answers for the page's scripts and styles only under the name it listens on: a
// phone reaching the scratch Obeya through `tailscale serve` gets a blank page from one with --dev,
// so stage with --restarts for that. Stopping a scratch Obeya removes its `tailscale serve` entry.
//
// The stage file (JSON; every field but `cards` optional):
//   {
//     "name": "Shop", "canvases": ["Website"], "language": "en", "conversation": "de",
//     "clones": 2, "mainBranch": "master",
//     "poolCheckout": true, "slots": 3,
//     "hosts": [{ "name": "Workhorse", "ssh": "me@workhorse.local", "clones": 2, "slots": 2 }],
//     "files": { "src/cli.ts": "…" },
//     "pulls": [{ "number": 5, "title": "…", "author": "…", "files": { "src/x.ts": "…" }, "canModify": true }],
//     "plans": { "docs/plan/werkzeug.md": "# Werkzeug\n\n## Workstreams\n\n- [ ] **W1:** Konfiguration.\n" },
//     "cards": [
//       { "key": "A", "title": "…", "body": "…", "x": 40, "y": 300,
//         "state": "working", "statusLine": "Tests laufen", "createdAgo": "2h" },
//       { "key": "B", "title": "…", "queue": { "behind": ["A"], "reason": "Beide ändern src/cli.ts." },
//         "scope": ["src/cli.ts"] },
//       { "key": "C", "title": "…", "state": "waiting", "need": "demo", "summary": "…",
//         "demo": { "dir": "/abs/demo", "chapters": [[0, "Ausgangslage"]] } },
//       { "key": "H", "title": "…", "state": "waiting", "need": "demo", "summary": "…",
//         "demo": { "kind": "html", "dir": "/abs/artifact", "chapters": [] } },
//       { "key": "N", "title": "…", "state": "waiting", "need": "review", "summary": "…" },
//       { "key": "D", "title": "…", "state": "waiting", "need": "question", "question": { "text": "…", "options": ["Ja", "Nein"] } },
//       { "key": "E", "title": "…", "from": "C" },
//       { "key": "P", "project": "docs/plan/werkzeug.md", "x": 0, "y": 0 },
//       { "key": "W1", "workstream": "W1", "state": "working", "statusLine": "…" }
//     ],
//     "preferences": [
//       { "key": "R", "text": "Beschriftungen: präzise vor kurz." },
//       { "text": "…", "state": "proposed", "card": "A", "quote": "…", "replaces": "R" },
//       { "text": "…", "state": "proposed", "review": true },
//       { "text": "…", "state": "proposed", "target": "<repo id>" }
//     ],
//     "groups": [{ "name": "Abrechnung", "cards": ["A", "B", "P"] }],
//     "friction": [{ "card": "A", "what": "…", "cost": "…", "fix": "…", "ago": "1h" }],
//     "settingProposals": [{ "field": "run", "value": "bun run dev", "basis": "…", "cards": ["A", "B"] }],
//     "talk": [{ "said": "…", "reply": "…", "ago": "2h", "card": "A", "answer": "…" }]
//   }
// `language` is the language the scratch Obeya speaks (de or en); without it, the language of the
// demos where the script runs (`plugin/skills/demo/lib/settings.ts`: `DEMO_LANGUAGE`, which Obeya
// gives its workers from the repository's `demo.language`, else the demo settings'), so that the
// screen a demo records matches its narration. Card titles and conversations are not translated:
// write them in that language. `language` is the interface's; `conversation`, the language agents
// write the owner in before the owner's words say otherwise, follows it where left out.
// A card is created (x and y default to a free place; `idea`, `repo`, `from` as in
// POST /api/c/<canvas>/cards) unless it names a plan doc's `project` or `workstream` (label; with
// several plan docs "docs/plan/x.md#W1"), which exist already. Then its fields are written straight
// into the database:
// state, need, statusLine, summary, question, demo (`kind` defaults to video), queue (`behind` by key; `since` defaults to
// now), scope (files), branch (a working or waiting card without one gets the branch a start would
// have given it, which every started card has), createdAgo, changedAgo (when something last happened at it), archivedAgo, events ([{ kind, author, text, ago?, mocks?, spot?, token? }]; an idea's reply with `mocks` needs code that has them, an error's `token` (its session signed in with a token) too;
// with events of kind `review`, the demos in `row.demos` and then `demo` go with those handovers in order, and a `spot` (a comment's
// place in a demo video, `{ at, chapter?, demo? }`) names its demo by its place in that order; earlier demos need code that has them),
// workspace (true: the card holds the next free clone, for a repository whose settings say clones; with
// its branch checked out there, holding a commit where `branch` names it, of `branchFiles` too (by path, a text or `{ from }` a file to copy); for one that works in worktrees, a branch is
// required and the card gets a worktree of its own on it), prototypeOf (the key of the idea it is a prototype of),
// and `row` for any other column of `cards` (objects are stored as JSON). Times: "90s", "15m", "2h",
// "3d" ago. `mainBranch` is the branch the repositories are on (default `main`). `"setup": true` serves no canvas (no configuration, no repository given): the first start,
// which shows the setup assistant; the repository is still made, for the assistant to pick, and
// `cards` may be empty. `"git": false` makes the repository a folder without git (a card's `workspace: true` then
// is the folder itself, and its `changes`, as `[{ "kind": "added", "path": "…" }]` with `from` for a move, are what it
// changed there: the files are as `files` and `copy` leave them, a changed one without a copy from before), and `copy` copies a directory into it first (documents, binaries). The repository has settings of its own where `files` hold `.obeya/settings.json` (a demo site among them, say). `poolCheckout` makes the repository's checkout a workspace of the pool too
// (`workspaces` in the configuration), as a pool of clones often has it, with a bare origin in
// <dir>; with it, the server
// starts from a configuration file in <dir>. `slots` caps the workers busy at once on this machine
// (an idle worker counts as busy). `hosts` are other machines over SSH (as in the configuration;
// `root` defaults to <dir>/far there): the repository gets a bare origin in <dir>, copied to each
// host at the same path, so that Obeya clones it there as it would a remote; staging afresh
// removes <dir> there first. A host with `"gone": true` held its clones once and does not answer
// now (an `ssh` target nobody resolves, say): nothing goes there, and its clones are registered as if
// Obeya had made them. `name` names the canvas the cards go on; `repoName` names its repository's
// directory (<dir>/repo by default), and so its id; `repos` adds further repositories to that canvas,
// `[{ "name": "promo", "files": { … } }]`, each in <dir>/<name> with that id, which a card's `repo`
// names; `canvases` adds further ones by
// name, each over a repository of its own (<dir>/repo-2, …); a card goes on one of them by its `canvas` (the name). Preferences are active unless `state` says otherwise; `card` and `replaces` name keys;
// `target` is the repository whose CLAUDE.md a rule is for (the canvas id names the home one).
// What a learned rule's occasion is (card, quote, review), `replaces` and `target` need code that has them.
// Groups are created through the API with their cards (keys; a workstream stands for its project),
// in their colours by order. `talk` is the conversation with the Koordinator, oldest first (`card` a key;
// `question` and `answer`, `answerBy` for a question it looked up; `follows`: the index of the
// exchange whose answer it continues, in that one's thread; `files`: the answer's files, each with
// its name, caption and either `content` or a file to copy (`from`), written to the thread's output
// directory; needs code that has them; `unread`: its answer waits unread; `wish`: what a draft for
// Obeya's makers starts from, `{ said, answer? }`, for the link under the reply; `askedIn`: the key of
// the project whose sheet the words were written in, straight to its project agent, with an empty `reply`). `friction` is what the Arbeitsrückschau noted on a card's
// runs (`card` a key), read by its next retrospective; `settingProposals` are values for a
// repository's settings it proposed (`field`: checks, setup, softPaths or run; `cards` keys;
// `repo` defaults to the canvas's home repository); both need code that has them.
// Obeya proposes a card that fills in the settings of a repository without any („Obeya für …
// einrichten“); staging dismisses it on every canvas, unless `"setupProposals": true` keeps it.

import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { demoSettingsHere } from '../plugin/skills/demo/lib/settings.ts';
import { type Language, LANGUAGES } from '../src/core/locale';
import type { CanvasSnapshot, Item } from '../src/core/types';
import { loginLink, ownerHeaders } from '../src/server/owner';
import { findTailscale, type ServeEntry, Tailscale } from '../src/server/tailscale';
import { mayRecordInto } from '../src/server/replay';
import { branchName } from '../src/server/workspaces';
import { opt } from './common';
import { waitUp } from './wait-up';

type StageEvent = NonNullable<StageCard['events']>[number];

interface StageCard {
  key?: string;
  title?: string;
  body?: string;
  x?: number;
  y?: number;
  idea?: boolean;
  repo?: string;
  from?: string;
  project?: string;
  workstream?: string;
  /** The name of one of `canvases` the card goes on, instead of the first canvas. */
  canvas?: string;
  state?: string;
  need?: string | null;
  statusLine?: string;
  summary?: string;
  question?: { text: string; options?: string[]; multiple?: boolean };
  demo?: Record<string, unknown>;
  queue?: { behind?: string[]; reason?: string; since?: string; checking?: true };
  scope?: string[];
  changes?: { kind: 'added' | 'modified' | 'deleted' | 'moved'; path: string; from?: string }[];
  branch?: string;
  /** Files the card's branch commits beside `scratch.txt`: by path, its text, or `{ from }` a file to copy (a PDF, say). */
  branchFiles?: Record<string, string | { from: string }>;
  workspace?: boolean;
  /** A prototype of the idea with this key. */
  prototypeOf?: string;
  createdAgo?: string;
  changedAgo?: string;
  archivedAgo?: string;
  events?: { kind: string; author: string; text: string; ago?: string; mocks?: { title: string; html: string }[]; spot?: { at: number; chapter?: string; demo?: number }; token?: boolean }[];
  row?: Record<string, unknown>;
}

interface Stage {
  /** No canvas: Obeya's first start, with the setup assistant. */
  setup?: boolean;
  /** Keeps Obeya's proposal to fill in the settings of a repository that has none. */
  setupProposals?: boolean;
  /** Names the canvas the cards go on. */
  name?: string;
  /** The language of the scratch Obeya's interface; the demos' where the script runs without it. */
  language?: Language;
  /** The owner's conversation language; the interface's without it. */
  conversation?: Language;
  /** The directory of the canvas's repository under the scratch directory, and so its id (default `repo`). */
  repoName?: string;
  /** Further repositories on the canvas the cards go on, each in a directory of its name, which is its id. */
  repos?: { name: string; files?: Record<string, string> }[];
  /** Further canvases by name, each over a repository of its own, without cards: to switch between canvases. */
  canvases?: string[];
  /** Without it (and without --port) the script picks a free one. */
  port?: number;
  dir?: string;
  /** The branch the repositories are on (default `main`). */
  mainBranch?: string;
  /** Clones for the workers, who then work in clones whatever the settings say: real workers need one each. */
  clones?: number;
  /** The repository's checkout is a workspace of the pool too. */
  poolCheckout?: boolean;
  /** Workers busy at once on this machine. */
  slots?: number;
  /** Other machines over SSH, as in the configuration. */
  hosts?: { name: string; ssh: string; root?: string; clones: number; slots?: number; gone?: boolean }[];
  files?: Record<string, string>;
  plans?: Record<string, string>;
  /** `false`: the repository is a folder without git (design: Folders without git). */
  git?: false;
  /** A directory whose contents go into the repository first (a small folder of documents, binaries included). */
  copy?: string;
  /**
   * Pull requests someone outside opened on the canvas's repository, played by a forge in a file
   * (src/server/file-forge.ts): each a commit of `files` on the main branch, its head as
   * `refs/pull/<number>/head` in the repository. Their URLs are GitHub's for `forgeRepo` (default
   * `acme/<repoName>`), the repository's origin too, which git of the scratch Obeya reads as the
   * repository itself; the account Obeya acts as is `forgeViewer` (default `owner`); the watcher
   * looks at them every `prPoll` seconds (default 10). The file is <dir>/forge.json, which a demo
   * edits to play the contributor (a comment, a push).
   */
  pulls?: { number: number; title: string; author: string; files: Record<string, string>; canModify?: boolean; checks?: { name: string; state: 'pending' | 'success' | 'failure' }[]; body?: string }[];
  forgeRepo?: string;
  forgeViewer?: string;
  prPoll?: number;
  cards: StageCard[];
  preferences?: { key?: string; text: string; state?: string; card?: string; quote?: string; review?: boolean; replaces?: string; target?: string }[];
  groups?: { name: string; cards: string[] }[];
  friction?: { card: string; what: string; cost: string; fix: string; ago?: string; repo?: string }[];
  settingProposals?: { field: string; value: string | string[]; basis: string; cards: string[]; repo?: string }[];
  talk?: {
    said: string;
    reply: string;
    ago?: string;
    card?: string;
    question?: string;
    answer?: string;
    answerBy?: string;
    follows?: number;
    files?: { name: string; caption: string; content?: string; from?: string }[];
    unread?: boolean;
    wish?: { said: string; answer?: string };
    askedIn?: string;
  }[];
}

const ROOT = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const fail = (msg: string): never => {
  console.error(`scratch-obeya: ${msg}`);
  process.exit(1);
};
const scratchDir = (port: number) => `/tmp/obeya-scratch-${port}`;
/** What --say has the card's agent do for each kind of its lines in the conversation (as in a stage file's `events`). */
const SAYS = {
  say: (text: string) => ({ say: text }),
  report: (status: string) => ({ tool: 'report', args: { status } }),
  talk: (text: string) => ({ tool: 'reply', args: { text } }),
  question: (question: string) => ({ tool: 'ask', args: { question } }),
  review: (summary: string) => ({ tool: 'ready_for_review', args: { summary } }),
  to_obeya: (request: string) => ({ tool: 'to_obeya', args: { request } }),
  tool: (json: string) => ({ args: {}, ...(JSON.parse(json) as { tool: string; args?: Record<string, unknown> }) }) as { tool: string; args: Record<string, unknown> },
  end: () => ({ end: true as const }),
};

const stopPort = opt('stop');
if (stopPort) {
  const d = opt('dir') ?? scratchDir(Number(stopPort));
  if (!stop(d)) fail(`the server of ${d} (process ${pidIn(d)}) still runs after the stop`);
  process.exit(0);
}
const loginPort = opt('login');
if (loginPort) {
  const d = opt('dir') ?? scratchDir(Number(loginPort));
  const canvas = existsSync(join(d, 'staged.json')) ? (JSON.parse(readFileSync(join(d, 'staged.json'), 'utf8')) as { canvas?: string }).canvas : undefined;
  const link = await loginLink(`http://127.0.0.1:${loginPort}`, join(d, 'home'), canvas ? `/?c=${canvas}` : '/');
  if (!link) fail(`no scratch Obeya of ${d} answers on port ${loginPort}`);
  console.log(link);
  process.exit(0);
}

const sayPort = opt('say');
if (sayPort) {
  const [key, kind, ...words] = args.slice(args.indexOf('--say') + 2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--dir');
  const text = words.join(' ');
  const act = SAYS[kind as keyof typeof SAYS];
  if (!key || !act || (!text.trim() && kind !== 'end')) fail(`usage: bun scripts/scratch-obeya.ts --say <port> <card key> <${Object.keys(SAYS).join('|')}> <text>`);
  console.log(await standIn(Number(sayPort), key!, act!(text)));
  process.exit(0);
}
const artifactPort = opt('artifact');
if (artifactPort) {
  const [key, from, ...words] = args.slice(args.indexOf('--artifact') + 2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--dir');
  if (!key || !from || !existsSync(from)) fail('usage: bun scripts/scratch-obeya.ts --artifact <port> <card key> <file> [<summary>]');
  const d = opt('dir') ?? scratchDir(Number(artifactPort));
  const to = artifactDir(d, key!);
  mkdirSync(to, { recursive: true });
  copyFileSync(from!, join(to, basename(from!)));
  // the page it may be shared on stays as the card's demo had it
  const { page } = (await stagedCard(Number(artifactPort), key!)).demo ?? {};
  const summary = words.join(' ').trim() || 'Updated the artifact.';
  console.log(await standIn(Number(artifactPort), key!, { tool: 'ready_for_review', args: { summary, demo: { kind: 'html', dir: to, ...(page ? { page } : {}) } } }));
  process.exit(0);
}

const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(port|code|dir|binary|record|replay)$/));
if (!file) fail('usage: bun scripts/scratch-obeya.ts <stage.json> [--port <n>] [--code <commit> | --binary <obeya>] [--real-workers | --record <dir> | --replay <dir>] [--restarts] | --stop <port> | --login <port> | --say <port> … | --artifact <port> …');
const stage = JSON.parse(readFileSync(file!, 'utf8')) as Stage;
// what a scratch Obeya was staged from: staging afresh from it replaces that one
const from = { stage: realpathSync(file!), ...(opt('code') || opt('binary') ? { code: opt('code') ?? opt('binary') } : {}) };
const given = opt('port') ?? stage.port;
const port = given !== undefined ? Number(given) : await pickPort(opt('dir') ?? stage.dir);
const dir = resolve(opt('dir') ?? stage.dir ?? scratchDir(port));
const base = `http://127.0.0.1:${port}`;

stop(dir);
// whatever answers there, with Obeya's key or without
if (await fetch(base, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)) fail(`port ${port} is taken by another process (lsof -i :${port})`);
rmSync(dir, { recursive: true, force: true });
const home = join(dir, 'home');
/** Where a host keeps the repository's clones. */
const rootOn = (h: { root?: string }) => h.root ?? `${dir}/far`;
const repo = join(dir, stage.repoName ?? 'repo');
const mainBranch = stage.mainBranch ?? 'main';
mkdirSync(home, { recursive: true });
for (const k of ['language', 'conversation'] as const) if (stage[k] && !LANGUAGES.includes(stage[k])) fail(`"${k}" is ${LANGUAGES.join(' or ')}, not ${stage[k]}`);
// the languages of Obeya's interface and of its agents' conversation with the owner (src/server/settings.ts)
writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ language: stage.language ?? demoSettingsHere().language, ...(stage.conversation ? { conversationLanguage: stage.conversation } : {}) })}\n`);
// the owner's key, made before the server starts, which takes it from the home (owner.ts); code from before it has none and ignores it
const owner = ownerHeaders(home);

// the repository
const files = { ...(stage.files ?? {}), ...(stage.plans ?? {}) };
mkdirSync(repo, { recursive: true });
if (stage.copy) cpSync(resolve(stage.copy), repo, { recursive: true, preserveTimestamps: true });
if (!Object.keys(files).length && !stage.copy) files['README.md'] = '# Scratch\n';
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
const folder = stage.git === false;
if (!folder) initRepo(repo);
// a workspace of the pool is a clone of the repository's origin, the checkout included
if (stage.poolCheckout || stage.hosts?.length) {
  run('git', ['clone', '-q', '--bare', repo, join(dir, 'scratch.git')], dir);
  run('git', ['remote', 'add', 'origin', join(dir, 'scratch.git')], repo);
  run('git', ['fetch', '-q', 'origin'], repo);
  run('git', ['branch', '-q', '-u', `origin/${mainBranch}`], repo);
}
// pull requests of people outside, for the forge the file plays
if (stage.pulls?.length) {
  const slug = stage.forgeRepo ?? `acme/${basename(repo)}`;
  const prs = stage.pulls.map((p) => {
    run('git', ['checkout', '-q', '-b', `pr-${p.number}`], repo);
    for (const [path, text] of Object.entries(p.files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    run('git', ['add', '-A'], repo);
    run('git', ['-c', `user.name=${p.author}`, '-c', `user.email=${p.author}@users.noreply`, 'commit', '-qm', p.title], repo);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    run('git', ['update-ref', `refs/pull/${p.number}/head`, head], repo);
    run('git', ['checkout', '-q', mainBranch], repo);
    run('git', ['branch', '-q', '-D', `pr-${p.number}`], repo);
    return { url: `https://github.com/${slug}/pull/${p.number}`, number: p.number, title: p.title, author: p.author, head, canModify: p.canModify ?? true, headRepo: `https://github.com/${p.author}/${basename(slug)}.git`, headRef: `pr-${p.number}`, checks: p.checks ?? [], comments: [], ...(p.body ? { body: p.body } : {}) };
  });
  writeFileSync(join(dir, 'forge.json'), `${JSON.stringify({ repo, viewer: stage.forgeViewer ?? 'owner', prs }, null, 2)}\n`);
  // its origin is the forge's repository, which git of the scratch Obeya finds in the repository itself
  if (!stage.poolCheckout && !stage.hosts?.length) run('git', ['remote', 'add', 'origin', `git@github.com:${slug}.git`], repo);
}
// the further repositories of the canvas
const others = (stage.repos ?? []).map((r) => {
  const path = join(dir, r.name);
  mkdirSync(path, { recursive: true });
  const files = r.files && Object.keys(r.files).length ? r.files : { 'README.md': `# ${r.name}\n` };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), text);
  }
  initRepo(path);
  return { path, ...(stage.clones ? { clones: stage.clones } : {}) };
});
// the repositories of the further canvases
const further = (stage.canvases ?? []).map((name, i) => {
  const path = join(dir, `repo-${i + 2}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'README.md'), `# ${name}\n`);
  initRepo(path);
  return { name, repos: [{ path }] };
});
// the origin at the same path on each host, which clones it from there
for (const h of stage.hosts ?? []) {
  if (h.gone) continue;
  const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', h.ssh];
  // through ssh rather than scp, which takes no ssh://user@host:port target
  const tar = spawnSync('tar', ['-C', dir, '-cf', '-', 'scratch.git'], { maxBuffer: 1 << 30 });
  const r = spawnSync('ssh', [...ssh, `rm -rf '${dir}' && mkdir -p '${dir}' && tar --no-same-owner -xf - -C '${dir}'`], { input: tar.stdout, encoding: 'utf8' });
  if (tar.status !== 0 || r.status !== 0) fail(`copying the origin to ${h.name}: ${r.stderr || tar.stderr}`);
}

// the code it runs
let code = ROOT;
const commit = opt('code');
if (commit) {
  code = join(dir, 'code');
  mkdirSync(code);
  const archive = spawnSync('git', ['-C', ROOT, 'archive', commit], { maxBuffer: 1 << 30 });
  if (archive.status !== 0) fail(`git archive ${commit}: ${archive.stderr}`);
  const tar = spawnSync('tar', ['-x', '-C', code], { input: archive.stdout });
  if (tar.status !== 0) fail(`tar: ${tar.stderr}`);
  symlinkSync(join(ROOT, 'node_modules'), join(code, 'node_modules'));
}
const binary = opt('binary') && resolve(opt('binary')!);
if (binary && !existsSync(binary)) fail(`${binary} does not exist`);
const record = opt('record') && resolve(opt('record')!);
const replay = opt('replay') && resolve(opt('replay')!);
if (record && replay) fail('--record or --replay, not both');
if (record && !mayRecordInto(record)) fail(`${record} holds something other than a recording; record into an empty or new directory`);
if (replay && !existsSync(join(replay, 'meta.json'))) fail(`${replay} holds no recording (record one with --record)`);
if ((record || replay) && (binary || !readFileSync(join(code, 'src/server/main.ts'), 'utf8').includes('replayRuntime'))) fail(`${binary ?? commit} cannot record or play back its agents`);
// a fresh take, recorded from its first session
if (record) rmSync(record, { recursive: true, force: true });
// a recording in a demo's directory takes the cuts of the take that recorded it, before a take played back writes its own
const takeCuts = replay && join(dirname(replay), '.work', 'cuts.json');
if (replay && takeCuts && !existsSync(join(replay, 'cuts.json')) && existsSync(takeCuts) && statSync(takeCuts).mtimeMs >= statSync(join(replay, 'meta.json')).mtimeMs)
  copyFileSync(takeCuts, join(replay, 'cuts.json'));
const idle = !args.includes('--real-workers') && !record && !replay;
const canIdle = !!binary || readFileSync(join(code, 'src/server/main.ts'), 'utf8').includes("'idle-workers'");
if (idle && !canIdle) console.error(`scratch-obeya: ${commit} has no --idle-workers; a started card gets a real agent`);

// the server, in its own process group so --stop ends it with everything it started (on Windows,
// which has none, its process tree)
const log = join(dir, 'server.log');
const out = openSync(log, 'a');
// not supervised: a scratch Obeya restarts itself only when asked to
const supervised = args.includes('--restarts');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'OBEYA_SUPERVISED')),
  OBEYA_HOME: home,
  ...(stage.pulls?.length
    ? {
        OBEYA_FORGE_FILE: join(dir, 'forge.json'),
        OBEYA_PR_POLL: String(stage.prPoll ?? 10),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`,
        GIT_CONFIG_VALUE_0: `git@github.com:${stage.forgeRepo ?? `acme/${basename(repo)}`}.git`,
      }
    : {}),
};
// a pool's workspaces live in the configuration, which the command line cannot give
const configFile = join(dir, 'canvases.json');
const configured = folder || !!stage.poolCheckout || stage.slots !== undefined || !!stage.hosts?.length || !!stage.name || further.length > 0 || others.length > 0;
if (configured)
  writeFileSync(
    configFile,
    JSON.stringify(
      [
        {
          ...(stage.name ? { name: stage.name } : {}),
          repos: [
            {
              path: repo,
              ...(folder ? { git: false } : {}),
              ...(stage.clones ? { clones: stage.clones } : {}),
              ...(stage.poolCheckout ? { workspaces: [repo] } : {}),
              ...(stage.slots !== undefined ? { slots: stage.slots } : {}),
              ...(stage.hosts?.length ? { hosts: stage.hosts.map(({ gone: _, ...h }) => ({ ...h, root: rootOn(h) })) } : {}),
            },
            ...others,
          ],
        },
        ...further,
      ],
      null,
      2,
    ),
  );
const canvasArgs = stage.setup ? [] : configured ? ['--config', configFile] : [repo, ...(stage.clones ? ['--clones', String(stage.clones)] : [])];
const serverArgs = [
  ...canvasArgs,
  '--port',
  String(port),
  ...(supervised ? [] : ['--dev']),
  ...(idle && canIdle ? ['--idle-workers'] : []),
  ...(record ? ['--record', record] : []),
  ...(replay ? ['--replay', replay] : []),
];
const server = spawn(binary ?? process.execPath, binary ? serverArgs : ['src/server/main.ts', ...serverArgs], {
  cwd: binary ? dir : code,
  env,
  detached: true,
  stdio: ['ignore', out, out],
});
server.unref();
writeFileSync(join(dir, 'server.pid'), String(server.pid));
let exited: number | null = null;
server.on('exit', (c) => (exited = c ?? -1));
const started = await waitUp(`${base}/api/canvases`, {
  headers: owner,
  exited: () => exited,
  limit: 5 * 60_000,
  slowAfter: 15_000,
  onSlow: () => console.error(`scratch-obeya: the server takes long to start${commit ? ' (code from git archive starts cold)' : ''}; waiting up to 5 min`),
});
if (!started.up) {
  if (started.exit === null) stop(dir);
  const after = `after ${Math.round(started.waited / 1000)} s`;
  fail(`the server did not come up ${started.exit !== null ? `(exit ${started.exit}) ${after}` : `${after}, so it was stopped`}; ${log}:\n${readFileSync(log, 'utf8').slice(-2000)}`);
}
if (stage.setup) {
  const staged = { url: (await loginLink(base, home)) ?? `${base}/`, port, dir, repo, pid: server.pid, log, from, cards: {} };
  writeFileSync(join(dir, 'staged.json'), JSON.stringify(staged, null, 2));
  console.log(JSON.stringify(staged));
  process.exit(0);
}
const allCanvases = (await (await fetch(`${base}/api/canvases`, { headers: owner })).json()) as { id: string; name: string }[];
const canvas = allCanvases[0]!.id;
const api = async (method: string, path: string, body?: unknown, on = canvas) => {
  const r = await fetch(`${base}/api/c/${on}${path}`, {
    method,
    headers: { ...owner, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) fail(`${method} ${path} ${JSON.stringify(body)}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
};

// Obeya's proposal to fill in a repository's settings, on every canvas, unless the stage keeps it
if (!stage.setupProposals)
  for (const c of allCanvases)
    for (const i of ((await api('GET', '/canvas', undefined, c.id)) as CanvasSnapshot).items)
      if (i.state === 'proposal' && i.proposal?.setup) await api('POST', `/cards/${i.id}/act`, { action: 'dismiss' }, c.id);

// the cards: created through the API, the plan doc's looked up, then their fields written directly
const snapshot = (await api('GET', '/canvas')) as CanvasSnapshot;
const ids: Record<string, string> = {};
const below = Math.max(0, ...snapshot.items.map((x) => x.y)) + 400;
let placed = 0;
const idOf = (c: StageCard, i: number) => ids[c.key ?? String(i)]!;
for (const [i, c] of stage.cards.entries()) {
  let id: string | undefined;
  if (c.project) id = snapshot.items.find((x) => x.kind === 'project' && x.plan?.file === c.project)?.id;
  else if (c.workstream) {
    const [doc, label] = c.workstream.includes('#') ? c.workstream.split('#') : [undefined, c.workstream];
    const projects = new Set(snapshot.items.filter((x) => x.kind === 'project' && (!doc || x.plan?.file === doc)).map((x) => x.id));
    id = snapshot.items.find((x) => x.label === label && x.parent && projects.has(x.parent))?.id;
  } else {
    if (c.from && !ids[c.from]) fail(`card ${c.key ?? i}: "from" names ${c.from}, which comes later or does not exist`);
    // without a place: in rows of four below the plan docs (a follow-up goes below its card)
    const at = c.from || (c.x !== undefined && c.y !== undefined) ? {} : { x: 40 + 360 * (placed % 4), y: below + 220 * Math.floor(placed++ / 4) };
    const on = c.canvas ? (allCanvases.find((x) => x.name === c.canvas)?.id ?? fail(`card ${c.key ?? i}: no canvas named ${c.canvas}`)) : canvas;
    const created = await api('POST', '/cards', {
      // code before cards lost their kind (--code) still asks for one; later code ignores it
      kind: 'feature',
      title: c.title ?? '',
      ...(c.body !== undefined ? { body: c.body } : {}),
      ...at,
      ...(c.x !== undefined ? { x: c.x } : {}),
      ...(c.y !== undefined ? { y: c.y } : {}),
      ...(c.idea ? { idea: true } : {}),
      ...(c.repo ? { repo: c.repo } : {}),
      ...(c.from ? { from: ids[c.from] } : {}),
    }, on);
    id = created.id;
  }
  if (!id) fail(`card ${c.key ?? i}: no ${c.project ? `project for ${c.project}` : `workstream ${c.workstream}`} on the canvas`);
  ids[c.key ?? String(i)] = id!;
}

const db = new Database(join(home, 'obeya.db'), { strict: true });
db.run('PRAGMA busy_timeout = 10000');
for (const h of stage.hosts ?? [])
  for (let n = 1; h.gone && n <= h.clones; n++)
    db.query('INSERT INTO workspaces (path, canvas_id, repo) VALUES ($path, $c, NULL) ON CONFLICT(path) DO NOTHING').run({ path: `ssh://${h.name}${rootOn(h)}/${n}`, c: canvas });
const columns = new Set((db.query('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name));
for (const [i, c] of stage.cards.entries()) {
  const id = idOf(c, i);
  const row: Record<string, unknown> = {};
  if ((c.project || c.workstream) && (c.x !== undefined || c.y !== undefined)) Object.assign(row, { x: c.x, y: c.y });
  if (c.state !== undefined) row.state = c.state;
  if (c.need !== undefined) row.need = c.need;
  if (c.statusLine !== undefined) row.status_line = c.statusLine;
  if (c.summary !== undefined) row.detail = { summary: c.summary };
  if (c.question !== undefined) row.detail = { question: { options: [], ...c.question } };
  // an HTML artifact is shown from a copy in <dir>, which --artifact may rewrite
  const demo = c.demo && (c.demo.kind === 'html' ? { ...c.demo, dir: copyArtifact(String(c.demo.dir), artifactDir(dir, c.key ?? String(i))) } : c.demo);
  if (demo !== undefined) row.demo = { kind: 'video', ...demo };
  if (c.queue !== undefined)
    row.queue = {
      ...c.queue,
      ...(c.queue.behind ? { behind: c.queue.behind.map((k) => ids[k] ?? fail(`card ${c.key ?? i}: queue names ${k}, which does not exist`)) } : {}),
      since: c.queue.since ?? new Date().toISOString(),
    };
  if (c.scope !== undefined) row.scope = { files: c.scope, reason: '' };
  // a card at work or waiting for the owner has the branch its start gave it, as every started card
  // has: without one the card shows neither its conversation's field nor the question it waits on
  const branch = c.branch ?? (c.state === 'working' || c.state === 'waiting' ? branchName(c.title ?? snapshot.items.find((x) => x.id === id)?.title ?? '', id) : undefined);
  if (branch !== undefined) row.branch = branch;
  if (c.workspace && folder) {
    // every card works in the folder itself, with a record of what it changed there (folder.ts)
    row.workspace = repo;
    row.branch = branch ?? `obeya/${id.slice(0, 6)}`;
    db.query('INSERT INTO folder_cards (card_id, folder, state) VALUES ($id, $f, $s) ON CONFLICT(card_id) DO NOTHING').run({
      id,
      f: realpathSync(repo),
      s: JSON.stringify({ held: true, undo: null, changes: c.changes ?? [] }),
    });
  } else if (c.workspace) {
    // a card on a further repository of the canvas (`repos`) works in a workspace of that one
    const other = c.repo && c.repo !== (stage.repoName ?? 'repo') ? c.repo : null;
    const checkout = other ? join(dir, other) : repo;
    const free = db.query('SELECT path FROM workspaces WHERE card_id IS NULL AND repo IS $r ORDER BY path').get({ r: other }) as { path: string } | null;
    // no clones: the repository works in worktrees, one per card under Obeya's home
    const tree = !free && !!branch && !stage.clones;
    if (!free && !tree) fail(`card ${c.key ?? i}: no free clone for it ("clones" in the stage, settings that say clones), nor a branch for a worktree`);
    const path = tree ? join(home, 'workspaces', canvas, id.slice(0, 8)) : free!.path;
    if (tree) {
      mkdirSync(dirname(path), { recursive: true });
      run('git', ['worktree', 'add', '-q', '-b', branch!, path, mainBranch], checkout);
      if (other) db.query('INSERT INTO workspaces (path, canvas_id, card_id, repo) VALUES ($path, $c, $id, $r)').run({ path, c: canvas, id, r: other });
      else db.query('INSERT INTO workspaces (path, canvas_id, card_id) VALUES ($path, $c, $id)').run({ path, c: canvas, id });
    } else {
      db.query('UPDATE workspaces SET card_id = $id WHERE path = $path').run({ id, path });
      if (branch) run('git', ['checkout', '-q', '-b', branch], path);
    }
    row.workspace = path;
    if (c.branch) {
      writeFileSync(join(path, 'scratch.txt'), `${c.title ?? c.branch}\n`);
      for (const [file, what] of Object.entries(c.branchFiles ?? {})) {
        mkdirSync(dirname(join(path, file)), { recursive: true });
        if (typeof what === 'string') writeFileSync(join(path, file), what);
        else copyFileSync(what.from, join(path, file));
      }
      run('git', ['add', '-A'], path);
      run('git', ['-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', 'commit', '-qm', c.title ?? c.branch], path);
    }
  }
  if (c.prototypeOf !== undefined) row.prototype_of = ids[c.prototypeOf] ?? fail(`card ${c.key ?? i}: prototypeOf names ${c.prototypeOf}, which does not exist`);
  if (c.createdAgo !== undefined) row.created_at = ago(c.createdAgo);
  if (c.archivedAgo !== undefined) row.archived_at = ago(c.archivedAgo);
  if (c.changedAgo !== undefined) row.updated_at = ago(c.changedAgo);
  Object.assign(row, c.row ?? {});
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const missing = keys.filter((k) => !columns.has(k));
  if (missing.length) fail(`card ${c.key ?? i}: this code's database has no column ${missing.join(', ')}`);
  if (keys.length)
    db.query(`UPDATE cards SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({
      id,
      ...Object.fromEntries(keys.map((k) => [k, typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : (row[k] as string | number | null)])),
    } as Record<string, string | number | null>);
  const reviews: { id: number; at: string }[] = [];
  const spots: [number, NonNullable<StageEvent['spot']>][] = [];
  for (const e of c.events ?? []) {
    // only code that has mocks (an error's token) has their column
    const at = ago(e.ago ?? '0s');
    const { lastInsertRowid } = db.query(`INSERT INTO events (card_id, at, kind, author, text${e.mocks ? ', mocks' : ''}${e.token ? ', token' : ''}) VALUES ($c, $at, $kind, $author, $text${e.mocks ? ', $mocks' : ''}${e.token ? ', 1' : ''})`).run({
      c: id,
      at,
      kind: e.kind,
      author: e.author,
      text: e.text,
      ...(e.mocks ? { mocks: JSON.stringify(e.mocks) } : {}),
    });
    if (e.kind === 'review') reviews.push({ id: Number(lastInsertRowid), at });
    if (e.spot) spots.push([Number(lastInsertRowid), e.spot]);
  }
  // the earlier demos (`row.demos`) and then the demo go with the handovers among the events, in order; a spot's `demo` names one of them by its place in that order
  if (reviews.length && (demo || c.row?.demos)) {
    const earlier = (c.row?.demos ?? []) as Record<string, unknown>[];
    const handed = (d: Record<string, unknown>, i: number) => (reviews[i] ? { ...d, kind: d.kind ?? 'video', handover: reviews[i].id, at: reviews[i].at } : d);
    db.query('UPDATE cards SET demos = $demos, demo = $demo WHERE id = $id').run({
      id,
      demos: earlier.length ? JSON.stringify(earlier.map(handed)) : null,
      demo: demo ? JSON.stringify(handed({ kind: 'video', ...demo }, earlier.length)) : null,
    });
  }
  for (const [event, { demo, ...spot }] of spots)
    db.query('UPDATE events SET spot = $spot WHERE id = $id').run({ id: event, spot: JSON.stringify({ ...spot, ...(demo !== undefined && reviews[demo] ? { demo: reviews[demo].id } : {}) }) });
}
const prefIds: Record<string, number> = {};
for (const [i, p] of (stage.preferences ?? []).entries()) {
  const row: Record<string, string | number | null> = {
    canvas_id: canvas,
    text: p.text,
    created_at: new Date().toISOString(),
    card_id: p.card ? (ids[p.card] ?? fail(`preference ${p.key ?? i}: card ${p.card} does not exist`)) : null,
  };
  if (p.state !== undefined) row.state = p.state;
  if (p.quote !== undefined) row.quote = p.quote;
  if (p.review) row.review = 1;
  if (p.target !== undefined) row.target = p.target;
  if (p.replaces !== undefined) row.replaces = prefIds[p.replaces] ?? fail(`preference ${p.key ?? i}: replaces ${p.replaces}, which comes later or does not exist`);
  const keys = Object.keys(row);
  const r = db.query(`INSERT INTO preferences (${keys.join(', ')}) VALUES (${keys.map((k) => `$${k}`).join(', ')}) RETURNING id`).get(row) as { id: number };
  if (p.key) prefIds[p.key] = r.id;
}
const talkIds: number[] = [];
const threadOf = new Map<number, number>();
for (const [i, x] of (stage.talk ?? []).entries()) {
  const row: Record<string, string | number | null> = {
    canvas_id: canvas,
    at: ago(x.ago ?? '0s'),
    said: x.said,
    reply: x.reply,
    card_id: x.card ? (ids[x.card] ?? fail(`talk ${i}: card ${x.card} does not exist`)) : null,
    question: x.question ?? null,
    answer: x.answer ?? null,
    answer_by: x.answerBy ?? null,
  };
  if (x.unread) row.unread = 1;
  if (x.wish) row.wish = JSON.stringify(x.wish);
  if (x.askedIn) row.asked_in = row.about = ids[x.askedIn] ?? fail(`talk ${i}: project ${x.askedIn} does not exist`);
  if (x.follows !== undefined) {
    const followed = talkIds[x.follows] ?? fail(`talk ${i}: follows ${x.follows}, which comes later or does not exist`);
    row.follows = followed;
    row.thread = threadOf.get(followed) ?? followed;
  }
  if (x.files?.length) row.files = JSON.stringify(x.files.map((f) => ({ name: f.name, caption: f.caption })));
  const keys = Object.keys(row);
  const { id } = db.query(`INSERT INTO talk (${keys.join(', ')}) VALUES (${keys.map((k) => `$${k}`).join(', ')}) RETURNING id`).get(row) as { id: number };
  talkIds.push(id);
  const thread = typeof row.thread === 'number' ? row.thread : id;
  threadOf.set(id, thread);
  for (const f of x.files ?? []) {
    const to = join(home, 'answers', canvas, String(thread), f.name);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.from ? readFileSync(f.from) : (f.content ?? ''));
  }
}
const homeRepo = () => (db.query(`SELECT value FROM settings WHERE canvas_id = $c AND key = 'home_repo'`).get({ c: canvas }) as { value: string } | null)?.value ?? canvas;
for (const [i, f] of (stage.friction ?? []).entries())
  db.query('INSERT INTO friction (canvas_id, repo, card_id, at, what, cost, fix) VALUES ($c, $repo, $card, $at, $what, $cost, $fix)').run({
    c: canvas,
    repo: f.repo ?? homeRepo(),
    card: ids[f.card] ?? fail(`friction ${i}: card ${f.card} does not exist`),
    at: ago(f.ago ?? '0s'),
    what: f.what,
    cost: f.cost,
    fix: f.fix,
  });
for (const [i, p] of (stage.settingProposals ?? []).entries())
  db.query('INSERT INTO setting_proposals (canvas_id, repo, field, value, basis, cards, created_at) VALUES ($c, $repo, $field, $value, $basis, $cards, $at)').run({
    c: canvas,
    repo: p.repo ?? homeRepo(),
    field: p.field,
    value: JSON.stringify(p.value),
    basis: p.basis,
    cards: JSON.stringify(p.cards.map((k) => ids[k] ?? fail(`setting proposal ${i}: card ${k} does not exist`))),
    at: new Date().toISOString(),
  });
db.close();
// the server keeps a snapshot of the canvas: a change through the API makes it read the database anew
for (const on of allCanvases) {
  // a project or workstream is on the home canvas: a stage of plan cards alone has nothing else to move
  const first = stage.cards.find((c) => (c.project || c.workstream ? on.id === canvas : c.canvas ? c.canvas === on.name : on.id === canvas));
  if (!first) continue;
  const c = ((await api('GET', '/canvas', undefined, on.id)) as CanvasSnapshot).items.find((x: Item) => x.id === idOf(first, stage.cards.indexOf(first)))!;
  await api('PATCH', `/cards/${c.id}`, { x: c.x, y: c.y }, on.id);
}

for (const g of stage.groups ?? [])
  await api('POST', '/groups', { name: g.name, cards: g.cards.map((k) => ids[k] ?? fail(`group ${g.name}: card ${k} does not exist`)) });

const staged = { url: (await loginLink(base, home, `/?c=${canvas}`)) ?? `${base}/?c=${canvas}`, port, dir, canvas, pid: server.pid, log, from, cards: ids, ...(record ? { record } : {}), ...(replay ? { replay } : {}) };
writeFileSync(join(dir, 'staged.json'), JSON.stringify(staged, null, 2));
console.log(JSON.stringify(staged));
process.exit(0);

/** A git repository at `path` with what is there committed on the main branch. */
function initRepo(path: string) {
  run('git', ['init', '-q', '-b', mainBranch], path);
  run('git', ['add', '-A'], path);
  run('git', ['-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', 'commit', '-qm', 'init'], path);
}

function run(cmd: string, a: string[], cwd: string) {
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) fail(`${cmd} ${a.join(' ')}: ${r.stderr}`);
}

/**
 * A port for a scratch Obeya staged without one. Staging afresh from the same stage file and code
 * stops the scratch Obeya staged from them before (the one in `givenDir`, if given) and takes its
 * port again; else the first from 4480 up that nothing listens on, whose scratch dir no running
 * server holds and that no other staging has claimed meanwhile (its server does not listen yet).
 */
async function pickPort(givenDir: string | undefined): Promise<number> {
  const earlier = givenDir ? resolve(givenDir) : scratchDirs().find((d) => JSON.stringify(stagedIn(d)?.from) === JSON.stringify(from));
  const was = earlier ? stagedIn(earlier)?.port : undefined;
  if (earlier && !stop(earlier)) console.error(`scratch-obeya: the server of ${earlier} (process ${pidIn(earlier)}) still runs after the stop`);
  for (const p of [...(was ? [was] : []), ...Array.from({ length: 500 }, (_, i) => 4480 + i)]) {
    if (p === 4417 || serverIn(scratchDir(p)) || !claim(p)) continue;
    if (await free(p)) {
      // one whose port went to another meanwhile leaves no dir behind
      if (earlier && !givenDir && earlier !== scratchDir(p)) rmSync(earlier, { recursive: true, force: true });
      return p;
    }
    rmSync(claimOf(p), { force: true });
  }
  return fail('no free port from 4480 to 4979');
}

function scratchDirs() {
  return readdirSync('/tmp')
    .filter((n) => /^obeya-scratch-\d+$/.test(n))
    .map((n) => `/tmp/${n}`);
}

function stagedIn(d: string): { port?: number; from?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(d, 'staged.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function pidIn(d: string) {
  return pidOf(join(d, 'server.pid'));
}

function pidOf(file: string) {
  try {
    return Number(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The process number of the scratch server of `d`, while it runs. server.pid alone does not tell:
 * a scratch dir outlives a reboot and process numbers come again (on Windows soon), so by now it
 * may name another program. The server started right before server.pid was written; a process
 * with its number that started later is another one.
 */
function serverIn(d: string) {
  const file = join(d, 'server.pid');
  const pid = pidOf(file);
  if (!alive(pid)) return undefined;
  const started = startOf(pid!);
  // a second for the start's precision, one for the file time's
  return started !== undefined && started <= statSync(file).mtimeMs + 2000 ? pid : undefined;
}

/** When process `pid` started (ms since the epoch, to the second), unless it is gone or not ours to look at. */
function startOf(pid: number): number | undefined {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`], {
      encoding: 'utf8',
    });
    const ms = Number(r.stdout?.trim());
    return r.status === 0 && ms > 0 ? ms : undefined;
  }
  // the time since it started as [[dd-]hh:]mm:ss, which macOS and Linux both give
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout ?? '');
  if (r.status !== 0 || !m) return undefined;
  const [days, hours, minutes, seconds] = m.slice(1).map((n) => Number(n ?? 0));
  return Date.now() - (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
}

function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimOf(p: number) {
  return `${scratchDir(p)}.claim`;
}

/** Claims port `p` for this staging until it ends, unless another staging that still runs has. */
function claim(p: number): boolean {
  // linked in whole, so that another staging never reads a claim without its pid
  const mine = `${claimOf(p)}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (let i = 0; i < 3; i++)
      try {
        linkSync(mine, claimOf(p));
        process.on('exit', () => rmSync(claimOf(p), { force: true }));
        return true;
      } catch {
        const holder = pidOf(claimOf(p));
        if (alive(holder)) return false;
        // a staging that was killed left it; one that let go of the port meanwhile left none
        if (holder) rmSync(claimOf(p), { force: true });
      }
    return false;
  } finally {
    rmSync(mine, { force: true });
  }
}

/** Whether a server could listen on port `p` of the loopback and nothing answers there (one listening on every address, say). */
async function free(p: number) {
  try {
    Bun.serve({ port: p, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true);
  } catch {
    return false;
  }
  const answers = await Bun.connect({ hostname: '127.0.0.1', port: p, socket: { data() {} } }).then(
    (s) => (s.end(), true),
    () => false,
  );
  return !answers;
}

/** Ends the scratch Obeya that `dir` belongs to, and what it started, if it still runs; false if its server outlives the stop. */
function stop(d: string) {
  const gone = stopServer(d);
  // one that was killed left its `tailscale serve` entry, which would serve whatever takes the port next
  const served = join(d, 'home', 'tailscale-serve.json');
  if (existsSync(served)) {
    const tailscale = findTailscale();
    const entry = JSON.parse(readFileSync(served, 'utf8')) as ServeEntry & { name: string };
    if (tailscale) new Tailscale(tailscale).unserveSync(entry.name, entry);
    rmSync(served, { force: true });
  }
  return gone;
}

/** Ends the scratch server of `d` with its process group (its tree on Windows); whether it is gone then. */
function stopServer(d: string) {
  const pid = serverIn(d);
  if (!pid) return true;
  if (process.platform === 'win32') stopTree(pid);
  else signalGroup(pid);
  return serverIn(d) !== pid;
}

function signalGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return;
    // Obeya waits for workers in the middle of a turn (an idle worker always is); a second signal ends it at once
    if (i === 15)
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
    Bun.sleepSync(100);
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
  for (let i = 0; i < 20 && alive(pid); i++) Bun.sleepSync(100);
}

/**
 * Windows has no process groups to signal: ends the server's process tree, which a console process
 * without a window lets end only forcefully, and waits until it is gone and lets go of its files.
 */
function stopTree(pid: number) {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  for (let i = 0; i < 50 && alive(pid); i++) Bun.sleepSync(100);
}

function ago(s: string): string {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s) ?? fail(`"${s}" is no time ago (like "15m", "2h", "3d")`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(Date.now() - Number(m[1]) * unit * 1000).toISOString();
}

/** Where the card of `key` keeps its HTML artifact in the scratch Obeya of `d`. */
function artifactDir(d: string, key: string) {
  return join(d, 'artifacts', key);
}

function copyArtifact(from: string, to: string) {
  if (!existsSync(join(from, 'index.html'))) fail(`${from} holds no index.html for an HTML artifact`);
  cpSync(from, to, { recursive: true });
  return to;
}

/** The scratch Obeya on `port` as its staged.json has it, and the owner's key of its home. */
function scratchAt(port: number) {
  const d = opt('dir') ?? scratchDir(port);
  if (!existsSync(join(d, 'staged.json'))) fail(`no scratch Obeya staged in ${d}`);
  const staged = JSON.parse(readFileSync(join(d, 'staged.json'), 'utf8')) as { canvas: string; cards: Record<string, string> };
  return { base: `http://127.0.0.1:${port}/api/c/${staged.canvas}`, cards: staged.cards, headers: ownerHeaders(join(d, 'home')) };
}

function cardOf(port: number, key: string) {
  const s = scratchAt(port);
  return { ...s, id: s.cards[key] ?? fail(`no card ${key} staged (${Object.keys(s.cards).join(', ')})`) };
}

async function stagedCard(port: number, key: string): Promise<Item> {
  const { base, headers, id } = cardOf(port, key);
  const r = await fetch(`${base}/canvas`, { headers }).catch(() => fail(`no scratch Obeya answers on port ${port}`));
  return ((await r.json()) as CanvasSnapshot).items.find((i) => i.id === id) ?? fail(`card ${key} is not on the canvas`);
}

/** The card's agent says or does `act`, through the server (`Workers.standIn`); returns what the agent would have read back. */
async function standIn(port: number, key: string, act: { say: string } | { tool: string; args: Record<string, unknown> } | { end: true }): Promise<string> {
  const { base, headers, id } = cardOf(port, key);
  const r = await fetch(`${base}/cards/${id}/stand-in`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(act) }).catch(() =>
    fail(`no scratch Obeya answers on port ${port}`),
  );
  const body = (await r.json()) as { result?: string; error?: string };
  if (!r.ok) fail(`card ${key}: ${body.error ?? r.status}`);
  // a tool's refusal ("Not shown: …", "Not handed over: …")
  if (/^Not [a-z ]+:/.test(body.result!)) fail(`card ${key}: ${body.result}`);
  return body.result!;
}
