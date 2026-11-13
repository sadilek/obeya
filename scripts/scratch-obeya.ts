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
//   bun scripts/scratch-obeya.ts --sweep
//
// Prints one JSON line, also kept in <dir>/staged.json:
//   { "url", "port", "dir", "canvas", "pid", "log", "from", "endsItself", "cards": { "<key>": "<card id>" }, "canvasOf": { "<key>": "<canvas id>" }, "record"?, "replay"? }
// `canvas` is the canvas the url opens, the first; `canvasOf` the one each card is on.
// The port is --port, else the stage file's `port`; without either the script picks one: the
// first from 4480 up that nothing listens on and no other scratch Obeya holds (a running one, or
// one being staged at the same time), so that workers staging at once never collide. --stop,
// --login, --say and --artifact take the `port` it printed. Staging afresh from the same stage
// file with the same --code or --binary (`from`) replaces the scratch Obeya staged from them
// before and takes its port again while that is free; with another --code, the two run side by
// side. The dir is --dir, else the stage file's `dir`, else obeya-scratch-<port> in
// /tmp on macOS and Linux and in the system temp folder (%TEMP%) on Windows; the port claims lie
// beside it.
// A scratch Obeya ends by itself (`endsItself`, where its code does; design: Scratch Obeyas) once this
// checkout is gone or on another branch, or once nothing used it for 30 minutes (OBEYA_SCRATCH_IDLE,
// in seconds, sets another time): no page open, no request, no agent of its own in a turn. --login,
// --say and --artifact then say why. Every staging runs --sweep in the background, which stops the
// scratch Obeyas whose code does not end them so: those whose working directory is gone, and those
// running for more than 12 hours (noted in obeya-scratch-sweep.log beside the scratch dirs).
// `url` signs browsers in (design: Who may talk to it), until the scratch Obeya stops; --login
// prints it again. --stop ends only the server it staged, never another program that has its
// process number by now, and fails if the server still runs after it. The script itself talks to the API with the owner's key of the scratch home.
//
// With idle workers, --say and --artifact act as a card's agent (by its key in staged.json, on whichever canvas the card is), for a
// check of what the owner sees while an agent works: through the server, which runs the agent's own
// tools (`Workers.standIn`), so an open page gets the line at once, unread marker and notification
// as from a real agent. --say adds a line of the kind a stage file's `events` give: `say` (the
// agent's words between its steps), `report` (its status line), `talk` (a reply), `question` (it
// asks, and the card waits for the owner), `review` (a handover that keeps the card's demo); besides
// those, `to_obeya` (it passes the owner's words on to Obeya, whose Coordinator is real and answers
// on the card), `tool` (any other tool of the agent's, the text a JSON object `{ "tool", "args" }`)
// and `end` (the agent's turn ends, which an idle worker's never does by itself).
// --artifact copies the file into the card's HTML artifact (<dir>/artifacts/<key>, where staging
// put a copy of the stage's) and hands it over again, as an agent does after rewriting it, with the
// summary given or "Updated the artifact."; a card without one starts it with an index.html. Each
// prints what the agent would have read back, and fails on a refusal ("Not handed over: …").
//
// --record <dir> runs real workers, as --real-workers, and records every agent's session (the
// Coordinator's, the workers', any other) into <dir>, emptied first (it must be empty, new, or a
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
// Coordinator and voice are real. --code <commit> runs that commit's code (`git archive`, with
// this checkout's node_modules) in <dir>/code; that starts cold and on a busy machine takes well
// over half a minute, so the script waits up to 5 minutes for the server while its process lives.
// --binary <obeya> runs a compiled Obeya instead (`bun run build`), with the resources beside it.
// Bun's dev server answers for the page's scripts and styles only under the name it listens on: a
// phone reaching the scratch Obeya through `tailscale serve` gets a blank page from one with --dev,
// so stage with --restarts for that. Stopping a scratch Obeya removes its `tailscale serve` entry.
//
// The stage file (JSON; every field but `cards` optional; each is described at `Stage` and
// `StageCard` in scripts/scratch/stage.ts):
//   {
//     "name": "Shop", "canvases": ["Website"], "language": "en", "conversation": "de",
//     "agents": { "worker": { "harness": "codex" } },
//     "clones": 2, "mainBranch": "master",
//     "poolCheckout": true, "slots": 3,
//     "hosts": [{ "name": "Workhorse", "ssh": "me@workhorse.local", "clones": 2, "slots": 2 }],
//     "files": { "src/cli.ts": "…" },
//     "pulls": [{ "number": 5, "title": "…", "author": "…", "files": { "src/x.ts": "…" }, "canModify": true }],
//     "forgeClone": true, "origin": "git@github.com:acme/shop.git",
//     "plans": { "docs/plan/tooling.md": "# Tooling\n\n## Workstreams\n\n- [ ] **W1:** Configuration.\n" },
//     "cards": [
//       { "key": "A", "title": "…", "body": "…", "x": 40, "y": 300,
//         "state": "working", "statusLine": "Running tests", "createdAgo": "2h" },
//       { "key": "B", "title": "…", "queue": { "behind": ["A"], "reason": "Both change src/cli.ts." },
//         "scope": ["src/cli.ts"] },
//       { "key": "C", "title": "…", "state": "waiting", "need": "demo", "summary": "…",
//         "demo": { "dir": "/abs/demo", "chapters": [[0, "Starting point"]] } },
//       { "key": "H", "title": "…", "state": "waiting", "need": "demo", "summary": "…",
//         "demo": { "kind": "html", "dir": "/abs/artifact", "chapters": [] } },
//       { "key": "N", "title": "…", "state": "waiting", "need": "review", "summary": "…" },
//       { "key": "D", "title": "…", "state": "waiting", "need": "question", "question": { "text": "…", "options": ["Yes", "No"] } },
//       { "key": "E", "title": "…", "from": "C" },
//       { "key": "P", "project": "docs/plan/tooling.md", "x": 0, "y": 0 },
//       { "key": "W1", "workstream": "W1", "state": "working", "statusLine": "…" }
//     ],
//     "preferences": [
//       { "key": "R", "text": "Labels: precise over short." },
//       { "text": "…", "state": "proposed", "card": "A", "quote": "…", "replaces": "R" },
//       { "text": "…", "state": "proposed", "review": true },
//       { "text": "…", "state": "proposed", "target": "<repo id>" }
//     ],
//     "groups": [{ "name": "Abrechnung", "cards": ["A", "B", "P"] }],
//     "friction": [{ "card": "A", "what": "…", "cost": "…", "fix": "…", "ago": "1h" }],
//     "settingProposals": [{ "field": "run", "value": "bun run dev", "basis": "…", "cards": ["A", "B"] }],
//     "talk": [{ "said": "…", "reply": "…", "ago": "2h", "card": "A", "answer": "…" }]
//   }

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CanvasSnapshot, Item } from '../src/core/types';
import { loginLink, ownerHeaders } from '../src/server/owner';
import { scratchDir, script } from './common';
import { pidIn, stagedIn, stop, sweep } from './scratch/process';
import { artifactDir, stageObeya } from './scratch/stage';

const { fail, args } = script('scratch-obeya');
const argv = process.argv.slice(2);
// --say and --artifact take a text's words as given, those that start with `--` too: only the
// command, its port and --dir are options there
const command = argv.findIndex((a) => a === '--say' || a === '--artifact');
const words = command < 0 ? [] : argv.slice(command + 2).filter((a, i, all) => a !== '--dir' && all[i - 1] !== '--dir');
const { values: options, positionals } = args(
  {
    stop: { type: 'string' },
    login: { type: 'string' },
    say: { type: 'string' },
    artifact: { type: 'string' },
    sweep: { type: 'boolean' },
    dir: { type: 'string' },
    port: { type: 'string' },
    code: { type: 'string' },
    binary: { type: 'string' },
    'real-workers': { type: 'boolean' },
    record: { type: 'string' },
    replay: { type: 'string' },
    restarts: { type: 'boolean' },
  },
  command < 0 ? argv : argv.filter((a, i) => i < command + 2 || a === '--dir' || argv[i - 1] === '--dir'),
);

/** The scratch dir of the scratch Obeya on `port`: --dir, else where it is staged by default. */
const dirOf = (port: number) => options.dir ?? scratchDir(port);

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

if (options.stop) {
  const d = dirOf(Number(options.stop));
  if (!stop(d)) fail(`the server of ${d} (process ${pidIn(d)}) still runs after the stop`);
} else if (options.login) {
  const port = Number(options.login);
  const canvas = stagedIn(dirOf(port))?.canvas;
  console.log((await loginLink(`http://127.0.0.1:${port}`, join(dirOf(port), 'home'), canvas ? `/c/${canvas}` : '/')) ?? fail(silent(port)));
} else if (options.say) {
  const [key, kind, ...said] = words;
  const text = said.join(' ');
  const act = SAYS[kind as keyof typeof SAYS];
  if (!key || !act || (!text.trim() && kind !== 'end')) fail(`usage: bun scripts/scratch-obeya.ts --say <port> <card key> <${Object.keys(SAYS).join('|')}> <text>`);
  console.log(await standIn(Number(options.say), key!, act!(text)));
} else if (options.artifact) {
  const port = Number(options.artifact);
  const [key, from, ...summary] = words;
  if (!key || !from || !existsSync(from)) fail('usage: bun scripts/scratch-obeya.ts --artifact <port> <card key> <file> [<summary>]');
  const to = artifactDir(dirOf(port), key!);
  mkdirSync(to, { recursive: true });
  copyFileSync(from!, join(to, basename(from!)));
  // the page it may be shared on stays as the card's demo had it
  const { page } = (await stagedCard(port, key!)).demo ?? {};
  console.log(await standIn(port, key!, { tool: 'ready_for_review', args: { summary: summary.join(' ').trim() || 'Updated the artifact.', demo: { kind: 'html', dir: to, ...(page ? { page } : {}) } } }));
} else if (options.sweep) await sweep();
else {
  if (positionals.length !== 1)
    fail('usage: bun scripts/scratch-obeya.ts <stage.json> [--port <n>] [--code <commit> | --binary <obeya>] [--real-workers | --record <dir> | --replay <dir>] [--restarts] | --stop <port> | --login <port> | --say <port> … | --artifact <port> …');
  const staged = await stageObeya({ ...options, file: positionals[0]!, realWorkers: options['real-workers'] });
  console.log(JSON.stringify(staged));
}
process.exit(0);

/** What --login, --say and --artifact say when no scratch Obeya answers: why it ended, where it ended by itself. */
function silent(port: number) {
  const d = dirOf(port);
  const log = existsSync(join(d, 'server.log')) ? readFileSync(join(d, 'server.log'), 'utf8') : '';
  const why = [...log.matchAll(/^Obeya: ending this scratch Obeya: (.*)$/gm)].at(-1)?.[1];
  return `no scratch Obeya of ${d} answers on port ${port}${why ? `: it ended by itself (${why}); stage it afresh` : ''}`;
}

/** The card of `key` in the scratch Obeya on `port`, as its staged.json has it: its id, the API of the canvas it is on, and the owner's key of the home. */
function cardOf(port: number, key: string) {
  const d = dirOf(port);
  const staged = stagedIn(d) ?? fail(`no scratch Obeya staged in ${d}`);
  const id = staged.cards[key] ?? fail(`no card ${key} staged (${Object.keys(staged.cards).join(', ')})`);
  // a staged.json from before canvasOf has its cards on the first canvas
  const on = staged.canvasOf?.[key] ?? staged.canvas;
  return { base: `http://127.0.0.1:${port}/api/c/${on}`, id, headers: ownerHeaders(join(d, 'home')) };
}

async function stagedCard(port: number, key: string): Promise<Item> {
  const { base, headers, id } = cardOf(port, key);
  const r = await fetch(`${base}/canvas`, { headers }).catch(() => fail(silent(port)));
  return ((await r.json()) as CanvasSnapshot).items.find((i) => i.id === id) ?? fail(`card ${key} is not on the canvas`);
}

/** The card's agent says or does `act`, through the server (`Workers.standIn`); returns what the agent would have read back. */
async function standIn(port: number, key: string, act: { say: string } | { tool: string; args: Record<string, unknown> } | { end: true }): Promise<string> {
  const { base, headers, id } = cardOf(port, key);
  const r = await fetch(`${base}/cards/${id}/stand-in`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(act) }).catch(() => fail(silent(port)));
  const body = (await r.json()) as { result?: string; error?: string };
  if (!r.ok) fail(`card ${key}: ${body.error ?? r.status}`);
  // a tool's refusal ("Not shown: …", "Not handed over: …")
  if (/^Not [a-z ]+:/.test(body.result!)) fail(`card ${key}: ${body.result}`);
  return body.result!;
}
