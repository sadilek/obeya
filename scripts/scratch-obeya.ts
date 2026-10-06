// A scratch Obeya for a demo or a live check, staged from one file: a fresh repository with plan
// docs, a fresh OBEYA_HOME, the server from this checkout (or from an earlier commit, for a before
// and after), and the cards in the states the demo needs. Running it again stages afresh, so a demo
// calls it before every take.
//
//   bun scripts/scratch-obeya.ts <stage.json> [--port <n>] [--code <commit>] [--real-workers] [--restarts]
//   bun scripts/scratch-obeya.ts --stop <port>
//
// Prints one JSON line, also kept in <dir>/staged.json:
//   { "url", "port", "dir", "canvas", "pid", "log", "cards": { "<key>": "<card id>" } }
//
// The server runs with --dev (it does not restart when the checkout commits; with --restarts it is
// supervised like a real Obeya and restarts once the configuration is saved, PUT /api/config, and
// for commits on this checkout when it runs this checkout's code) and, unless
// --real-workers, with --idle-workers: a started card is in progress without an agent. The
// Koordinator and voice are real. --code <commit> runs that commit's code (`git archive`, with
// this checkout's node_modules) in <dir>/code; that starts cold and on a busy machine takes well
// over half a minute, so the script waits up to 5 minutes for the server while its process lives.
//
// The stage file (JSON; every field but `cards` optional):
//   {
//     "port": 4480, "dir": "/tmp/obeya-scratch-4480", "adapter": "obeya", "clones": 2,
//     "share": "share.ts", "poolCheckout": true,
//     "files": { "src/cli.ts": "…" },
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
//       { "key": "N", "title": "…", "state": "waiting", "need": "review", "summary": "…", "noDemo": "…" },
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
//     "talk": [{ "said": "…", "reply": "…", "ago": "2h", "card": "A", "answer": "…" }]
//   }
// A card is created (x and y default to a free place; `idea`, `repo`, `from` as in
// POST /api/c/<canvas>/cards) unless it names a plan doc's `project` or `workstream` (label; with
// several plan docs "docs/plan/x.md#W1"), which exist already. Then its fields are written straight
// into the database:
// state, need, statusLine, summary, noDemo, question, demo, queue (`behind` by key; `since` defaults to
// now), scope (files), branch, createdAgo, archivedAgo, events ([{ kind, author, text, ago?, mocks? }]; an idea's reply with `mocks` needs code that has them),
// workspace (true: the card holds the next free clone, for an adapter that works in clones),
// and `row` for any other column of `cards` (objects are stored as JSON). Times: "90s", "15m", "2h",
// "3d" ago. `"adapter": ""` names none: the repository's own (`.obeya/adapter/` among `files`) or the generic one. `share` is the repository's share command as the configuration holds it (a script among
// `files`, say); `poolCheckout` makes the repository's checkout a workspace of the pool too
// (`workspaces` in the configuration), as a pool of clones often has it, with a bare origin in
// <dir>; with either, the server
// starts from a configuration file in <dir>. Preferences are active unless `state` says otherwise; `card` and `replaces` name keys;
// `target` is the repository whose CLAUDE.md a rule is for (the canvas id names the home one).
// What a learned rule's occasion is (card, quote, review), `replaces` and `target` need code that has them.
// Groups are created through the API with their cards (keys; a workstream stands for its project),
// in their colours by order. `talk` is the conversation with the Koordinator, oldest first (`card` a key;
// `question` and `answer`, `answerBy` for a question it looked up).

import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CanvasSnapshot, Item } from '../src/core/types';
import { answers, waitUp } from './wait-up';

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
  state?: string;
  need?: string | null;
  statusLine?: string;
  summary?: string;
  noDemo?: string;
  question?: { text: string; options?: string[]; multiple?: boolean };
  demo?: Record<string, unknown>;
  queue?: { behind?: string[]; reason?: string; since?: string; checking?: true; cutting?: true };
  scope?: string[];
  branch?: string;
  workspace?: boolean;
  createdAgo?: string;
  archivedAgo?: string;
  events?: { kind: string; author: string; text: string; ago?: string; mocks?: { title: string; html: string }[] }[];
  row?: Record<string, unknown>;
}

interface Stage {
  port?: number;
  dir?: string;
  adapter?: string;
  /** Clones for an adapter that works in clones (generic): real workers need one each. */
  clones?: number;
  /** The repository's share command, as in the configuration. */
  share?: string;
  /** The repository's checkout is a workspace of the pool too. */
  poolCheckout?: boolean;
  files?: Record<string, string>;
  plans?: Record<string, string>;
  cards: StageCard[];
  preferences?: { key?: string; text: string; state?: string; card?: string; quote?: string; review?: boolean; replaces?: string; target?: string }[];
  groups?: { name: string; cards: string[] }[];
  talk?: { said: string; reply: string; ago?: string; card?: string; question?: string; answer?: string; answerBy?: string }[];
}

const ROOT = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg: string): never => {
  console.error(`scratch-obeya: ${msg}`);
  process.exit(1);
};
const scratchDir = (port: number) => `/tmp/obeya-scratch-${port}`;

const stopPort = opt('stop');
if (stopPort) {
  stop(opt('dir') ?? scratchDir(Number(stopPort)));
  process.exit(0);
}

const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(port|code|dir)$/));
if (!file) fail('usage: bun scripts/scratch-obeya.ts <stage.json> [--port <n>] [--code <commit>] [--real-workers] [--restarts] | --stop <port>');
const stage = JSON.parse(readFileSync(file!, 'utf8')) as Stage;
const port = Number(opt('port') ?? stage.port ?? fail('no port: give "port" in the stage file or --port'));
const dir = resolve(opt('dir') ?? stage.dir ?? scratchDir(port));
const base = `http://127.0.0.1:${port}`;

stop(dir);
if (await answers(`${base}/api/canvases`)) fail(`port ${port} is taken by another process (lsof -i :${port})`);
rmSync(dir, { recursive: true, force: true });
const home = join(dir, 'home');
const repo = join(dir, 'repo');
mkdirSync(home, { recursive: true });

// the repository
const files = { ...(stage.files ?? {}), ...(stage.plans ?? {}) };
if (!Object.keys(files).length) files['README.md'] = '# Scratch\n';
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
run('git', ['init', '-q', '-b', 'main'], repo);
run('git', ['add', '-A'], repo);
run('git', ['-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', 'commit', '-qm', 'init'], repo);
// a workspace of the pool is a clone of the repository's origin, the checkout included
if (stage.poolCheckout) {
  run('git', ['clone', '-q', '--bare', repo, join(dir, 'scratch.git')], dir);
  run('git', ['remote', 'add', 'origin', join(dir, 'scratch.git')], repo);
  run('git', ['fetch', '-q', 'origin'], repo);
  run('git', ['branch', '-q', '-u', 'origin/main'], repo);
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
const idle = !args.includes('--real-workers');
const canIdle = readFileSync(join(code, 'src/server/main.ts'), 'utf8').includes("'idle-workers'");
if (idle && !canIdle) console.error(`scratch-obeya: ${commit} has no --idle-workers; a started card gets a real agent`);

// the server, in its own process group so --stop ends it with everything it started
const log = join(dir, 'server.log');
const out = openSync(log, 'a');
// not supervised: a scratch Obeya restarts itself only when asked to
const supervised = args.includes('--restarts');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'OBEYA_SUPERVISED')), OBEYA_HOME: home };
// a share command and a pool's workspaces live in the configuration, which the command line cannot give
const configFile = join(dir, 'canvases.json');
const configured = !!stage.share || !!stage.poolCheckout;
if (configured)
  writeFileSync(
    configFile,
    JSON.stringify(
      [
        {
          repos: [
            {
              path: repo,
              ...(stage.adapter === '' ? {} : { adapter: stage.adapter ?? 'obeya' }),
              ...(stage.clones ? { clones: stage.clones } : {}),
              ...(stage.poolCheckout ? { workspaces: [repo] } : {}),
              ...(stage.share ? { share: stage.share } : {}),
            },
          ],
        },
      ],
      null,
      2,
    ),
  );
const canvasArgs = configured ? ['--config', configFile] : [repo, ...(stage.adapter === '' ? [] : ['--adapter', stage.adapter ?? 'obeya']), ...(stage.clones ? ['--clones', String(stage.clones)] : [])];
const server = spawn(
  process.execPath,
  ['src/server/main.ts', ...canvasArgs, '--port', String(port), ...(supervised ? [] : ['--dev']), ...(idle && canIdle ? ['--idle-workers'] : [])],
  { cwd: code, env, detached: true, stdio: ['ignore', out, out] },
);
server.unref();
writeFileSync(join(dir, 'server.pid'), String(server.pid));
let exited: number | null = null;
server.on('exit', (c) => (exited = c ?? -1));
const started = await waitUp(`${base}/api/canvases`, {
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
const canvas = ((await (await fetch(`${base}/api/canvases`)).json()) as { id: string }[])[0]!.id;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api/c/${canvas}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) fail(`${method} ${path} ${JSON.stringify(body)}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
};

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
    });
    id = created.id;
  }
  if (!id) fail(`card ${c.key ?? i}: no ${c.project ? `project for ${c.project}` : `workstream ${c.workstream}`} on the canvas`);
  ids[c.key ?? String(i)] = id!;
}

const db = new Database(join(home, 'obeya.db'), { strict: true });
db.run('PRAGMA busy_timeout = 10000');
const columns = new Set((db.query('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name));
for (const [i, c] of stage.cards.entries()) {
  const id = idOf(c, i);
  const row: Record<string, unknown> = {};
  if ((c.project || c.workstream) && (c.x !== undefined || c.y !== undefined)) Object.assign(row, { x: c.x, y: c.y });
  if (c.state !== undefined) row.state = c.state;
  if (c.need !== undefined) row.need = c.need;
  if (c.statusLine !== undefined) row.status_line = c.statusLine;
  if (c.summary !== undefined) row.detail = { summary: c.summary, ...(c.noDemo ? { noDemo: c.noDemo } : {}) };
  if (c.question !== undefined) row.detail = { question: { options: [], ...c.question } };
  if (c.demo !== undefined) row.demo = c.demo;
  if (c.queue !== undefined)
    row.queue = {
      ...c.queue,
      ...(c.queue.behind ? { behind: c.queue.behind.map((k) => ids[k] ?? fail(`card ${c.key ?? i}: queue names ${k}, which does not exist`)) } : {}),
      since: c.queue.since ?? new Date().toISOString(),
    };
  if (c.scope !== undefined) row.scope = { files: c.scope, reason: '' };
  if (c.branch !== undefined) row.branch = c.branch;
  if (c.workspace) {
    const free = db.query('SELECT path FROM workspaces WHERE card_id IS NULL ORDER BY path').get() as { path: string } | null;
    if (!free) fail(`card ${c.key ?? i}: no free clone for it ("clones" in the stage, an adapter that works in clones)`);
    db.query('UPDATE workspaces SET card_id = $id WHERE path = $path').run({ id, path: free!.path });
    row.workspace = free!.path;
  }
  if (c.createdAgo !== undefined) row.created_at = ago(c.createdAgo);
  if (c.archivedAgo !== undefined) row.archived_at = ago(c.archivedAgo);
  Object.assign(row, c.row ?? {});
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const missing = keys.filter((k) => !columns.has(k));
  if (missing.length) fail(`card ${c.key ?? i}: this code's database has no column ${missing.join(', ')}`);
  if (keys.length)
    db.query(`UPDATE cards SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({
      id,
      ...Object.fromEntries(keys.map((k) => [k, typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : (row[k] as string | number | null)])),
    } as Record<string, string | number | null>);
  for (const e of c.events ?? [])
    // only code that has mocks has their column
    db.query(`INSERT INTO events (card_id, at, kind, author, text${e.mocks ? ', mocks' : ''}) VALUES ($c, $at, $kind, $author, $text${e.mocks ? ', $mocks' : ''})`).run({
      c: id,
      at: ago(e.ago ?? '0s'),
      kind: e.kind,
      author: e.author,
      text: e.text,
      ...(e.mocks ? { mocks: JSON.stringify(e.mocks) } : {}),
    });
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
for (const [i, x] of (stage.talk ?? []).entries())
  db.query('INSERT INTO talk (canvas_id, at, said, reply, card_id, question, answer, answer_by) VALUES ($c, $at, $said, $reply, $card, $question, $answer, $by)').run({
    c: canvas,
    at: ago(x.ago ?? '0s'),
    said: x.said,
    reply: x.reply,
    card: x.card ? (ids[x.card] ?? fail(`talk ${i}: card ${x.card} does not exist`)) : null,
    question: x.question ?? null,
    answer: x.answer ?? null,
    by: x.answerBy ?? null,
  });
db.close();
// the server keeps a snapshot of the canvas: a change through the API makes it read the database anew
const first = stage.cards.find((c) => !c.project && !c.workstream);
if (first) {
  const c = ((await api('GET', '/canvas')) as CanvasSnapshot).items.find((x: Item) => x.id === idOf(first, stage.cards.indexOf(first)))!;
  await api('PATCH', `/cards/${c.id}`, { x: c.x, y: c.y });
}

for (const g of stage.groups ?? [])
  await api('POST', '/groups', { name: g.name, cards: g.cards.map((k) => ids[k] ?? fail(`group ${g.name}: card ${k} does not exist`)) });

const staged = { url: `${base}/?c=${canvas}`, port, dir, canvas, pid: server.pid, log, cards: ids };
writeFileSync(join(dir, 'staged.json'), JSON.stringify(staged, null, 2));
console.log(JSON.stringify(staged));
process.exit(0);

function run(cmd: string, a: string[], cwd: string) {
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) fail(`${cmd} ${a.join(' ')}: ${r.stderr}`);
}

/** Ends the scratch Obeya that `dir` belongs to, and what it started, if it still runs. */
function stop(d: string) {
  const pidFile = join(d, 'server.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
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
}

function ago(s: string): string {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s) ?? fail(`"${s}" is no time ago (like "15m", "2h", "3d")`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(Date.now() - Number(m[1]) * unit * 1000).toISOString();
}
