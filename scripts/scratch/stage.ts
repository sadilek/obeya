// Staging a scratch Obeya from a stage file, for scripts/scratch-obeya.ts (whose header describes
// the command line): the stage file's fields, each described where it is declared, and the staging
// in its steps. The cards' fields are written straight into the database rather than through the
// server's functions: with --code or --binary the server is another build than this script's, so
// the staging checks that the columns it writes exist.

import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { demoSettingsHere, obeyaHome } from '../../plugin/skills/demo/lib/settings.ts';
import { type Language, LANGUAGES } from '../../src/core/locale';
import type { CanvasSnapshot } from '../../src/core/types';
import { branchName } from '../../src/server/branches';
import { videoFacts } from '../../src/server/demo-files';
import { loginLink, ownerApi, ownerHeaders } from '../../src/server/owner';
import { mayRecordInto } from '../../src/server/replay';
import { ROOT, scratchDir, script, writeFiles } from '../common';
import { waitUp } from '../wait-up';
import { pickPort, type Staged, stop } from './process';

const { fail, run } = script('scratch-obeya');

/**
 * A card of the stage. It is created through the API (`title`, `body`, `x`, `y`, `idea`, `repo`,
 * `from` as POST /api/c/<canvas>/cards takes them; without `x` and `y` in rows of four below the plan
 * docs, a follow-up below its card) unless it names a plan doc's `project` or `workstream`, which
 * exist already. Then the other fields are written straight into the database. A time ago is
 * written "90s", "15m", "2h" or "3d".
 */
export interface StageCard {
  /** What the stage's other fields and staged.json's `cards` name it by; its place in `cards` without one. */
  key?: string;
  title?: string;
  body?: string;
  x?: number;
  y?: number;
  idea?: boolean;
  /** The id of one of `repos` the card works in, instead of the canvas's own repository. */
  repo?: string;
  /** The key of an earlier card this one follows up. */
  from?: string;
  /** A plan doc by its path (`docs/plan/tooling.md`): this card is its project. */
  project?: string;
  /** A workstream by its label (`W1`; with several plan docs `docs/plan/x.md#W1`). */
  workstream?: string;
  /** The name of one of `canvases` the card goes on, instead of the first canvas. */
  canvas?: string;
  state?: string;
  need?: string | null;
  statusLine?: string;
  summary?: string;
  question?: { text: string; options?: string[]; multiple?: boolean };
  /** A handover's demo: `{ dir, chapters, kind? }`, `kind` a video unless `html`; an HTML artifact is shown from a copy in the scratch dir, which --artifact may rewrite. */
  demo?: Record<string, unknown>;
  /** Waiting in the queue `behind` the cards of these keys; `since` defaults to now. */
  queue?: { behind?: string[]; reason?: string; since?: string; checking?: true };
  /** Snoozed by its agent until the card with key `on` gets to `state` (default done). */
  snoozed?: { on: string; state?: string; why?: string };
  /** The files it works on. */
  scope?: string[];
  /** In a folder without git (`"git": false`), what it changed there: the files are as `files` and `copy` leave them, a changed one without a copy from before; `from` for a move. */
  changes?: { kind: 'added' | 'modified' | 'deleted' | 'moved'; path: string; from?: string }[];
  /** Its branch. A working or waiting card without one gets the branch a start would have given it, which every started card has. */
  branch?: string;
  /** Files the card's branch commits (instead of a `scratch.txt`): by path, its text, or `{ from }` a file to copy (a PDF, say). */
  branchFiles?: Record<string, string | { from: string }>;
  /**
   * The card holds a workspace: the next free clone, for a repository whose settings say clones,
   * with its branch checked out there and, where `branch` names it, a commit of `branchFiles`
   * (else of a `scratch.txt`); for one that works in worktrees, a branch is required and the card
   * gets a worktree of its own on it. On a further canvas (`canvas`) a workspace of that canvas's
   * repository, with `repo` one of that repository. In a folder without git, the folder itself.
   */
  workspace?: boolean;
  /** A prototype of the idea with this key. */
  prototypeOf?: string;
  createdAgo?: string;
  /** What its agents cost so far, in US dollars, as one session of theirs; needs code that counts costs. */
  spent?: number;
  /** When something last happened at it. */
  changedAgo?: string;
  archivedAgo?: string;
  /**
   * Its conversation. An idea's reply with `mocks` needs code that has them, an error's `token`
   * (its session signed in with a token) too. `reply`: Obeya's reply that only answers the owner's
   * words, which stands in the conversation (with a `talk` entry on the card of the same reply, its
   * exchange). With events of kind `review`, the demos in `row.demos` and then `demo` go with those
   * handovers in order, and a `spot` (a comment's place in a demo video) names its `demo` by its
   * place in that order; earlier demos need code that has them.
   */
  events?: { kind: string; author: string; text: string; ago?: string; mocks?: { title: string; html: string }[]; spot?: { at: number; chapter?: string; demo?: number }; token?: boolean; reply?: boolean }[];
  /** Any other column of `cards`, objects stored as JSON. A review card's `contribution` naming one of `pulls` gets that PR's head as `reviewed` where it names none. */
  row?: Record<string, unknown>;
}

type StageEvent = NonNullable<StageCard['events']>[number];

/** A stage file (JSON): every field but `cards` optional. */
export interface Stage {
  /** What the canvas's own agents (the Coordinator's) cost so far, in US dollars; needs code that counts costs. */
  spent?: number;
  /** No canvas (no configuration, no repository given): Obeya's first start, with the setup assistant. The repository is still made, for the assistant to pick, and `cards` may be empty. */
  setup?: boolean;
  /** Keeps Obeya's proposal of a card that fills in the settings of a repository without any ("Set up Obeya for …"), which staging dismisses on every canvas without it. */
  setupProposals?: boolean;
  /** Names the canvas the cards go on. */
  name?: string;
  /**
   * The language of the scratch Obeya's interface (de or en); without it, the language of the demos
   * where the script runs (`DEMO_LANGUAGE`, which Obeya gives its workers from the repository's
   * `demo.language`, else the demo settings'), so that the screen a demo records matches its
   * narration. Card titles and conversations are not translated: write them in that language.
   */
  language?: Language;
  /** The language agents write the owner in before the owner's words say otherwise; `language` without it. */
  conversation?: Language;
  /**
   * `true`: the voice of the machine's Obeya (OBEYA_HOME where the script runs, else ~/.obeya), a
   * copy of its demo settings and a link to its installed voices, for what Obeya itself speaks (a
   * walkthrough). An object: demo settings over the machine's (`{ "voice": "kokoro" }`, another
   * voice than the owner's, so a demo tells what Obeya says apart from its own narration). Without
   * it the scratch home has the default settings and no voice installed.
   */
  voice?: boolean | Record<string, unknown>;
  /** What "Agents and models" sets per group, as `settings.json` keeps it under `agents` (Codex for workers, say). */
  agents?: Record<string, unknown>;
  /** The directory of the canvas's repository under the scratch directory, and so its id (default `repo`). */
  repoName?: string;
  /** Further repositories on the canvas the cards go on, each in a directory of its name, which is its id and what a card's `repo` names. */
  repos?: { name: string; files?: Record<string, string> }[];
  /** Further canvases by name, each over a repository of its own (<dir>/repo-2, …); a card goes on one by its `canvas`. */
  canvases?: string[];
  /** Without it (and without --port) the script picks a free one. */
  port?: number;
  dir?: string;
  /** The branch the repositories are on (default `main`). */
  mainBranch?: string;
  /** Clones for the workers, who then work in clones whatever the settings say: real workers need one each. */
  clones?: number;
  /** The repository's checkout is a workspace of the pool too (`workspaces` in the configuration), as a pool of clones often has it, with a bare origin in <dir>. */
  poolCheckout?: boolean;
  /** The repository's settings on this machine, in the configuration (a plan folder outside it, which only they may name). */
  settings?: Record<string, unknown>;
  /** Workers busy at once on this machine (an idle worker counts as busy). */
  slots?: number;
  /**
   * Other machines over SSH, as in the configuration (`root` defaults to <dir>/far there): the
   * repository gets a bare origin in <dir>, copied to each host at the same path, so that Obeya
   * clones it there as it would a remote; staging afresh removes <dir> there first. A host with
   * `gone` held its clones once and does not answer now (an `ssh` target nobody resolves, say):
   * nothing goes there, and its clones are registered as if Obeya had made them. `OBEYA_SSH` in the
   * script's environment names a program that stands for `ssh` in the server (`fakeSsh` in
   * src/server/testing.ts: a host that is this machine, with a home of its own), and nothing is
   * copied there.
   */
  hosts?: { name: string; ssh: string; root?: string; clones: number; slots?: number; gone?: boolean }[];
  /** The repository's files; `.obeya/settings.json` among them gives it settings of its own (a demo site, say). */
  files?: Record<string, string>;
  /** Plan docs by path, written as `files` are. */
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
  /**
   * The forge's repository is a clone of the repository (<dir>/forge, the PRs' heads in it) rather
   * than the repository itself: what lands on the local main is not on the forge until pushed. The
   * contributors' repositories are that one too, so a push onto a PR's branch moves its head.
   */
  forgeClone?: boolean;
  forgeViewer?: string;
  prPoll?: number;
  cards: StageCard[];
  /**
   * The canvas's rules, active unless `state` says otherwise; `card` and `replaces` name keys;
   * `target` is the repository whose CLAUDE.md a rule is for (the canvas id names the home one). A
   * learned rule's occasion (`card`, `quote`, `review`), `replaces` and `target` need code that has them.
   */
  preferences?: { key?: string; text: string; state?: string; card?: string; quote?: string; review?: boolean; replaces?: string; target?: string }[];
  /** Created through the API with their cards (keys; a workstream stands for its project), in their colours by order. */
  groups?: { name: string; cards: string[] }[];
  /** What the work retrospective noted on a card's runs (`card` a key), read by its next retrospective; `repo` defaults to the canvas's home repository. Needs code that has it. */
  friction?: { card: string; what: string; cost: string; fix: string; ago?: string; repo?: string }[];
  /** Values for a repository's settings the retrospective proposed (`field`: checks, setup, softPaths or run; `cards` keys; `repo` defaults to the canvas's home repository). Needs code that has them. */
  settingProposals?: { field: string; value: string | string[]; basis: string; cards: string[]; repo?: string }[];
  /** The conversation with the Coordinator, oldest first. */
  talk?: {
    said: string;
    reply: string;
    ago?: string;
    /** The key of the card it was about. */
    card?: string;
    /** With `answer` (and `answerBy`), a question it looked up. */
    question?: string;
    answer?: string;
    answerBy?: string;
    /** The index of the exchange whose answer it continues, in that one's thread. */
    follows?: number;
    /** The answer's files, each with `content` or a file to copy (`from`), written to the thread's output directory; needs code that has them. */
    files?: { name: string; caption: string; content?: string; from?: string }[];
    /** Its answer waits unread. */
    unread?: boolean;
    /** The reply only answers the words, no actions (what "Show as walkthrough" tells); needs code that has it. */
    replyOnly?: boolean;
    /** What a draft for Obeya's makers starts from, for the link under the reply. */
    wish?: { said: string; answer?: string };
    /** The key of the project whose sheet the words were written in, straight to its project agent, with an empty `reply`. */
    askedIn?: string;
  }[];
}

/** What the command line asks of a staging. */
export type Staging = {
  file: string;
  port?: string;
  dir?: string;
  code?: string;
  binary?: string;
  realWorkers?: boolean;
  record?: string;
  replay?: string;
  restarts?: boolean;
};

/** Where the card of `key` keeps its HTML artifact in the scratch Obeya of `d`. */
export const artifactDir = (d: string, key: string) => join(d, 'artifacts', key);

const git = (cwd: string, ...args: string[]) => run(['git', ...args], { cwd, quiet: true });

/** Stages a scratch Obeya as `o` asks, replacing the one staged in its dir before. */
export async function stageObeya(o: Staging): Promise<Staged> {
  const stage = JSON.parse(readFileSync(o.file, 'utf8')) as Stage;
  for (const k of ['language', 'conversation'] as const) if (stage[k] && !LANGUAGES.includes(stage[k])) fail(`"${k}" is ${LANGUAGES.join(' or ')}, not ${stage[k]}`);
  // what a scratch Obeya was staged from: staging afresh from it replaces that one
  const from = { stage: realpathSync(o.file), ...(o.code || o.binary ? { code: o.code ?? o.binary } : {}) };
  // scratch Obeyas from code that does not end them by itself, which this one does not wait for
  spawn(process.execPath, [join(ROOT, 'scripts', 'scratch-obeya.ts'), '--sweep'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const given = o.port ?? stage.port;
  const port = given !== undefined ? Number(given) : await pickPort(o.dir ?? stage.dir, from);
  const dir = resolve(o.dir ?? stage.dir ?? scratchDir(port));
  const base = `http://127.0.0.1:${port}`;
  stop(dir);
  // whatever answers there, with Obeya's key or without
  if (await fetch(base, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)) fail(`port ${port} is taken by another process (lsof -i :${port})`);
  rmSync(dir, { recursive: true, force: true });

  const home = join(dir, 'home');
  makeHome(stage, home);
  const repos = makeRepositories(stage, dir);
  const code = chooseCode(o, dir);
  const server = await startServer(stage, { dir, home, port, base, repos, code, supervised: !!o.restarts });
  const done = ({ url, cards, ...rest }: Pick<Staged, 'url' | 'cards'> & Partial<Staged>): Staged => {
    const { canvas: on, repo, ...more } = rest;
    const all = { url, port, dir, ...(on ? { canvas: on } : {}), ...(repo ? { repo } : {}), pid: server.pid, log: server.log, from, endsItself: server.endsItself, cards, ...more };
    writeFileSync(join(dir, 'staged.json'), JSON.stringify(all, null, 2));
    return all;
  };
  if (stage.setup) return done({ url: (await loginLink(base, home)) ?? `${base}/`, repo: repos.repo, cards: {} });

  const owner = ownerApi(base, home);
  const allCanvases = (await (await owner('/api/canvases')).json()) as Canvas[];
  const canvas = allCanvases[0]!.id;
  const api = async (method: string, path: string, json?: unknown, on = canvas) => {
    const text = await owner(`/api/c/${on}${path}`, { method, json }).then(
      (r) => r.text(),
      (e: Error) => fail(`${e.message} (${JSON.stringify(json)})`),
    );
    return text ? JSON.parse(text) : undefined;
  };
  if (!stage.setupProposals) await dismissSetupProposals(api, allCanvases);
  const cards = await createCards(stage, api, canvas, allCanvases);

  const db = new Database(join(home, 'obeya.db'), { strict: true });
  db.run('PRAGMA busy_timeout = 10000');
  const ctx: Context = { stage, dir, home, mainBranch: stage.mainBranch ?? 'main', repos, canvas, ...cards, columns: new Set((db.query('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name)) };
  holdGoneHosts(db, ctx);
  for (const [i, c] of stage.cards.entries()) await writeCard(db, ctx, c, i);
  if (stage.spent !== undefined) db.query("INSERT INTO spend (canvas_id, session, usd) VALUES ($c, 'staged', $usd)").run({ c: canvas, usd: stage.spent });
  writePreferences(db, ctx);
  writeTalk(db, ctx);
  writeRetrospective(db, ctx);
  const moves = refreshes(db, ctx, allCanvases);
  db.close();
  for (const [on, id, at] of moves) await api('PATCH', `/cards/${id}`, at, on);
  for (const g of stage.groups ?? []) await api('POST', '/groups', { name: g.name, cards: g.cards.map((k) => ctx.ids[k] ?? fail(`group ${g.name}: card ${k} does not exist`)) });

  return done({
    url: (await loginLink(base, home, `/c/${canvas}`)) ?? `${base}/c/${canvas}`,
    canvas,
    cards: ctx.ids,
    canvasOf: ctx.canvasOf,
    ...(code.record ? { record: code.record } : {}),
    ...(code.replay ? { replay: code.replay } : {}),
  });
}

type Canvas = { id: string; name: string };
type Api = (method: string, path: string, json?: unknown, on?: string) => Promise<any>;
type Repositories = ReturnType<typeof makeRepositories>;

/** What the database steps share: the stage, where it is staged, and the cards created. */
type Context = {
  stage: Stage;
  dir: string;
  home: string;
  mainBranch: string;
  repos: Repositories;
  /** The first canvas, which the url opens. */
  canvas: string;
  snapshot: CanvasSnapshot;
  /** Each card's id and the canvas it is on, by its key (its place in `cards` without one). */
  ids: Record<string, string>;
  canvasOf: Record<string, string>;
  /** The columns of `cards` in this code's database. */
  columns: Set<string>;
};

const keyOf = (c: StageCard, i: number) => c.key ?? String(i);

/** The home's settings: the languages and agents of the stage, and the machine's voice where it asks for it. */
function makeHome(stage: Stage, home: string) {
  mkdirSync(home, { recursive: true });
  // the languages of Obeya's interface and of its agents' conversation with the owner (src/server/settings.ts)
  writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ language: stage.language ?? demoSettingsHere().language, ...(stage.conversation ? { conversationLanguage: stage.conversation } : {}), ...(stage.agents ? { agents: stage.agents } : {}) })}\n`);
  if (stage.voice) {
    const machine = obeyaHome();
    const settings = existsSync(join(machine, 'demo.json')) ? (JSON.parse(readFileSync(join(machine, 'demo.json'), 'utf8')) as Record<string, unknown>) : {};
    writeFileSync(join(home, 'demo.json'), `${JSON.stringify({ ...settings, ...(typeof stage.voice === 'object' ? stage.voice : {}) }, null, 2)}\n`);
    if (existsSync(join(machine, 'voices')) && !existsSync(join(home, 'voices'))) symlinkSync(join(machine, 'voices'), join(home, 'voices'));
  }
}

/** A git repository at `path` with what is there committed on `branch`. */
function initRepo(path: string, branch: string) {
  git(path, 'init', '-q', '-b', branch);
  git(path, 'add', '-A');
  git(path, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', 'commit', '-qm', 'init');
}

/** The canvas's repository with its pull requests, origin and hosts, the further repositories of that canvas, and those of the further canvases. */
function makeRepositories(stage: Stage, dir: string) {
  const repo = join(dir, stage.repoName ?? 'repo');
  const mainBranch = stage.mainBranch ?? 'main';
  const folder = stage.git === false;
  const files = { ...(stage.files ?? {}), ...(stage.plans ?? {}) };
  mkdirSync(repo, { recursive: true });
  if (stage.copy) cpSync(resolve(stage.copy), repo, { recursive: true, preserveTimestamps: true });
  writeFiles(repo, Object.keys(files).length || stage.copy ? files : { 'README.md': '# Scratch\n' });
  if (!folder) initRepo(repo, mainBranch);
  // a workspace of the pool is a clone of the repository's origin, the checkout included
  if (stage.poolCheckout || stage.hosts?.length) {
    git(dir, 'clone', '-q', '--bare', repo, join(dir, 'scratch.git'));
    git(repo, 'remote', 'add', 'origin', join(dir, 'scratch.git'));
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '-q', '-u', `origin/${mainBranch}`);
  }
  const forge = { slug: stage.forgeRepo ?? `acme/${basename(repo)}`, repo: stage.forgeClone ? join(dir, 'forge') : repo };
  const prHeads = makePulls(stage, dir, repo, forge);
  const others = (stage.repos ?? []).map((r) => {
    const path = join(dir, r.name);
    writeFiles(path, r.files && Object.keys(r.files).length ? r.files : { 'README.md': `# ${r.name}\n` });
    initRepo(path, mainBranch);
    return { path, ...(stage.clones ? { clones: stage.clones } : {}) };
  });
  const further = (stage.canvases ?? []).map((name, i) => {
    const path = join(dir, `repo-${i + 2}`);
    writeFiles(path, { 'README.md': `# ${name}\n` });
    initRepo(path, mainBranch);
    return { name, repos: [{ path }] };
  });
  copyOrigin(stage, dir);
  return { repo, folder, forge, prHeads, others, further };
}

/** The pull requests of people outside, for the forge the file plays (<dir>/forge.json): each PR's head by its number. */
function makePulls(stage: Stage, dir: string, repo: string, forge: { slug: string; repo: string }) {
  const prHeads = new Map<number, string>();
  if (!stage.pulls?.length) return prHeads;
  const mainBranch = stage.mainBranch ?? 'main';
  const prs = stage.pulls.map((p) => {
    git(repo, 'checkout', '-q', '-b', `pr-${p.number}`);
    writeFiles(repo, p.files);
    git(repo, 'add', '-A');
    git(repo, '-c', `user.name=${p.author}`, '-c', `user.email=${p.author}@users.noreply`, 'commit', '-qm', p.title);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-ref', `refs/pull/${p.number}/head`, head);
    git(repo, 'checkout', '-q', mainBranch);
    git(repo, 'branch', '-q', '-D', `pr-${p.number}`);
    prHeads.set(p.number, head);
    return { url: `https://github.com/${forge.slug}/pull/${p.number}`, number: p.number, title: p.title, author: p.author, head, canModify: p.canModify ?? true, headRepo: `https://github.com/${p.author}/${basename(forge.slug)}.git`, headRef: `pr-${p.number}`, checks: p.checks ?? [], comments: [], ...(p.body ? { body: p.body } : {}) };
  });
  // a remote of its own, which what lands on the local main reaches only once pushed: a clone with the PRs' heads
  if (stage.forgeClone) {
    git(dir, 'clone', '-q', repo, forge.repo);
    // pushes onto its checked-out main go into its files too, as the forge's merges do
    git(forge.repo, 'config', 'receive.denyCurrentBranch', 'updateInstead');
    // a push onto a PR's branch moves its refs/pull head at once, as on the forge
    writeFileSync(join(forge.repo, '.git', 'hooks', 'post-receive'), '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/pr-*) git update-ref "refs/pull/${ref#refs/heads/pr-}/head" "$new";; esac; done\n', { mode: 0o755 });
    git(forge.repo, 'fetch', '-q', repo, '+refs/pull/*:refs/pull/*');
  }
  writeFileSync(join(dir, 'forge.json'), `${JSON.stringify({ repo: forge.repo, viewer: stage.forgeViewer ?? 'owner', prs }, null, 2)}\n`);
  // its origin is the forge's repository, which git of the scratch Obeya finds in the repository itself
  if (!stage.poolCheckout && !stage.hosts?.length) git(repo, 'remote', 'add', 'origin', `git@github.com:${forge.slug}.git`);
  return prHeads;
}

/** Where a host keeps the repository's clones. */
const rootOn = (h: { root?: string }, dir: string) => h.root ?? `${dir}/far`;

/** The origin at the same path on each host, which clones it from there. */
function copyOrigin(stage: Stage, dir: string) {
  for (const h of stage.hosts ?? []) {
    // a stand-in's host is this machine, which has it there already
    if (h.gone || process.env.OBEYA_SSH) continue;
    const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', h.ssh];
    // through ssh rather than scp, which takes no ssh://user@host:port target
    const tar = spawnSync('tar', ['-cf', '-', 'scratch.git'], { cwd: dir, maxBuffer: 1 << 30 });
    const r = spawnSync('ssh', [...ssh, `rm -rf '${dir}' && mkdir -p '${dir}' && tar --no-same-owner -xf - -C '${dir}'`], { input: tar.stdout, encoding: 'utf8' });
    if (tar.status !== 0 || r.status !== 0) fail(`copying the origin to ${h.name}: ${r.stderr || tar.stderr}`);
  }
}

/** The code the server runs: this checkout's, a commit's (--code) or a compiled Obeya (--binary); and whether its agents are idle, recorded or played back. */
function chooseCode(o: Staging, dir: string) {
  let code = ROOT;
  if (o.code) {
    code = join(dir, 'code');
    mkdirSync(code);
    const archive = spawnSync('git', ['-C', ROOT, 'archive', o.code], { maxBuffer: 1 << 30 });
    if (archive.status !== 0) fail(`git archive ${o.code}: ${archive.stderr}`);
    // tar in the directory rather than with -C, whose Windows path (D:\…) Git's MSYS tar takes for host D
    const tar = spawnSync('tar', ['-xf', '-'], { cwd: code, input: archive.stdout });
    if (tar.status !== 0) fail(`tar: ${tar.stderr}`);
    // a junction on Windows, which needs no developer mode; other systems ignore the type
    symlinkSync(join(ROOT, 'node_modules'), join(code, 'node_modules'), 'junction');
  }
  const binary = o.binary && resolve(o.binary);
  if (binary && !existsSync(binary)) fail(`${binary} does not exist`);
  const record = o.record && resolve(o.record);
  const replay = o.replay && resolve(o.replay);
  if (record && replay) fail('--record or --replay, not both');
  if (record && !mayRecordInto(record)) fail(`${record} holds something other than a recording; record into an empty or new directory`);
  if (replay && !existsSync(join(replay, 'meta.json'))) fail(`${replay} holds no recording (record one with --record)`);
  if ((record || replay) && (binary || !readFileSync(join(code, 'src/server/main.ts'), 'utf8').includes('replayRuntime'))) fail(`${binary ?? o.code} cannot record or play back its agents`);
  // a fresh take, recorded from its first session
  if (record) rmSync(record, { recursive: true, force: true });
  // a recording in a demo's directory takes the cuts of the take that recorded it, before a take played back writes its own
  const takeCuts = replay && join(dirname(replay), '.work', 'cuts.json');
  if (replay && takeCuts && !existsSync(join(replay, 'cuts.json')) && existsSync(takeCuts) && statSync(takeCuts).mtimeMs >= statSync(join(replay, 'meta.json')).mtimeMs)
    copyFileSync(takeCuts, join(replay, 'cuts.json'));
  return { code, binary, record, replay, idle: !o.realWorkers && !record && !replay, fromCommit: !!o.code };
}

/** Git configuration for the server's git calls, as environment variables. */
function gitConfig(pairs: (readonly [string, string])[]): Record<string, string> {
  return Object.fromEntries([['GIT_CONFIG_COUNT', String(pairs.length)], ...pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])]);
}

/** The configuration of the canvases, where the command line cannot give it (a pool's workspaces, say): its file, else none. */
function writeConfiguration(stage: Stage, dir: string, { repo, folder, others, further }: Repositories) {
  const configured = folder || !!stage.poolCheckout || !!stage.settings || stage.slots !== undefined || !!stage.hosts?.length || !!stage.name || further.length > 0 || others.length > 0;
  if (!configured) return undefined;
  const file = join(dir, 'canvases.json');
  const first = {
    path: repo,
    ...(folder ? { git: false } : {}),
    ...(stage.clones ? { clones: stage.clones } : {}),
    ...(stage.poolCheckout ? { workspaces: [repo] } : {}),
    ...(stage.settings ? { settings: stage.settings } : {}),
    ...(stage.slots !== undefined ? { slots: stage.slots } : {}),
    ...(stage.hosts?.length ? { hosts: stage.hosts.map(({ gone: _, ...h }) => ({ ...h, root: rootOn(h, dir) })) } : {}),
  };
  writeFileSync(file, JSON.stringify([{ ...(stage.name ? { name: stage.name } : {}), repos: [first, ...others] }, ...further], null, 2));
  return file;
}

/**
 * The server, in its own process group so --stop ends it with everything it started (on Windows,
 * which has none, its process tree), once it answers.
 */
async function startServer(
  stage: Stage,
  s: { dir: string; home: string; port: number; base: string; repos: Repositories; code: ReturnType<typeof chooseCode>; supervised: boolean },
) {
  const { code, binary, record, replay, idle } = s.code;
  // the owner's key, made before the server starts, which takes it from the home (owner.ts); code from before it has none and ignores it
  const owner = ownerHeaders(s.home);
  const log = join(s.dir, 'server.log');
  const out = openSync(log, 'a');
  // whether the server ends by itself once of no more use (src/server/scratch.ts); code from before that ignores OBEYA_SCRATCH
  const endsItself = (binary ? readFileSync(binary) : readFileSync(join(code, 'src/server/main.ts'))).includes('OBEYA_SCRATCH');
  const { repo, forge } = s.repos;
  const env = {
    // not supervised: a scratch Obeya restarts itself only when asked to
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'OBEYA_SUPERVISED')),
    OBEYA_HOME: s.home,
    OBEYA_SCRATCH: ROOT,
    ...(stage.pulls?.length
      ? {
          OBEYA_FORGE_FILE: join(s.dir, 'forge.json'),
          OBEYA_PR_POLL: String(stage.prPoll ?? 10),
          // the forge's repository is the remote's, and with a clone of its own the contributors' too: a push onto a PR's branch moves its head
          ...gitConfig(
            [`git@github.com:${forge.slug}.git`, ...(stage.forgeClone ? stage.pulls.map((p) => `https://github.com/${p.author}/${basename(forge.slug)}.git`) : [])].map((url) => [`url.${forge.repo}.insteadOf`, url] as const),
          ),
        }
      : {}),
  };
  const configFile = writeConfiguration(stage, s.dir, s.repos);
  const canvasArgs = stage.setup ? [] : configFile ? ['--config', configFile] : [repo, ...(stage.clones ? ['--clones', String(stage.clones)] : [])];
  const serverArgs = [
    ...canvasArgs,
    '--port',
    String(s.port),
    ...(s.supervised ? [] : ['--dev']),
    ...(idle ? ['--idle-workers'] : []),
    ...(record ? ['--record', record] : []),
    ...(replay ? ['--replay', replay] : []),
  ];
  const server = spawn(binary ?? process.execPath, binary ? serverArgs : ['src/server/main.ts', ...serverArgs], { cwd: binary ? s.dir : code, env, detached: true, stdio: ['ignore', out, out] });
  server.unref();
  writeFileSync(join(s.dir, 'server.pid'), String(server.pid));
  let exited: number | null = null;
  server.on('exit', (c) => (exited = c ?? -1));
  const started = await waitUp(`${s.base}/api/canvases`, {
    headers: owner,
    exited: () => exited,
    limit: 5 * 60_000,
    slowAfter: 15_000,
    onSlow: () => console.error(`scratch-obeya: the server takes long to start${s.code.fromCommit ? ' (code from git archive starts cold)' : ''}; waiting up to 5 min`),
  });
  if (!started.up) {
    if (started.exit === null) stop(s.dir);
    const after = `after ${Math.round(started.waited / 1000)} s`;
    fail(`the server did not come up ${started.exit !== null ? `(exit ${started.exit}) ${after}` : `${after}, so it was stopped`}; ${log}:\n${readFileSync(log, 'utf8').slice(-2000)}`);
  }
  return { pid: server.pid!, log, endsItself };
}

/** Obeya's proposal to fill in a repository's settings, on every canvas. */
async function dismissSetupProposals(api: Api, canvases: Canvas[]) {
  for (const c of canvases)
    for (const i of ((await api('GET', '/canvas', undefined, c.id)) as CanvasSnapshot).items)
      if (i.state === 'proposal' && i.proposal?.setup) await api('POST', `/cards/${i.id}/act`, { action: 'dismiss' }, c.id);
}

/** The cards: created through the API, the plan doc's looked up; their ids and canvases by key, and the first canvas as it was before. */
async function createCards(stage: Stage, api: Api, canvas: string, canvases: Canvas[]) {
  const snapshot = (await api('GET', '/canvas')) as CanvasSnapshot;
  const ids: Record<string, string> = {};
  // a project or workstream is on the first canvas, any other card where its `canvas` puts it
  const canvasOf: Record<string, string> = {};
  const below = Math.max(0, ...snapshot.items.map((x) => x.y)) + 400;
  let placed = 0;
  for (const [i, c] of stage.cards.entries()) {
    let id: string | undefined;
    let on = canvas;
    if (c.project) id = snapshot.items.find((x) => x.kind === 'project' && x.plan?.file === c.project)?.id;
    else if (c.workstream) {
      const [doc, label] = c.workstream.includes('#') ? c.workstream.split('#') : [undefined, c.workstream];
      const projects = new Set(snapshot.items.filter((x) => x.kind === 'project' && (!doc || x.plan?.file === doc)).map((x) => x.id));
      // code before short codes were labels (`4A Title`, --code) has the code at the start of the title
      id = snapshot.items.find((x) => (x.label ?? x.title.split(' ')[0]) === label && x.parent && projects.has(x.parent))?.id;
    } else {
      if (c.from && !ids[c.from]) fail(`card ${keyOf(c, i)}: "from" names ${c.from}, which comes later or does not exist`);
      // without a place: in rows of four below the plan docs (a follow-up goes below its card)
      const at = c.from || (c.x !== undefined && c.y !== undefined) ? {} : { x: 40 + 360 * (placed % 4), y: below + 220 * Math.floor(placed++ / 4) };
      on = c.canvas ? (canvases.find((x) => x.name === c.canvas)?.id ?? fail(`card ${keyOf(c, i)}: no canvas named ${c.canvas}`)) : canvas;
      const created = await api(
        'POST',
        '/cards',
        {
          title: c.title ?? '',
          ...(c.body !== undefined ? { body: c.body } : {}),
          ...at,
          ...(c.x !== undefined ? { x: c.x } : {}),
          ...(c.y !== undefined ? { y: c.y } : {}),
          ...(c.idea ? { idea: true } : {}),
          ...(c.repo ? { repo: c.repo } : {}),
          ...(c.from ? { from: ids[c.from] } : {}),
        },
        on,
      );
      id = created.id;
    }
    ids[keyOf(c, i)] = id ?? fail(`card ${keyOf(c, i)}: no ${c.project ? `project for ${c.project}` : `workstream ${c.workstream}`} on the canvas`);
    canvasOf[keyOf(c, i)] = on;
  }
  return { snapshot, ids, canvasOf };
}

/** The clones of hosts that are gone, registered as if Obeya had made them. */
function holdGoneHosts(db: Database, ctx: Context) {
  for (const h of ctx.stage.hosts ?? [])
    for (let n = 1; h.gone && n <= h.clones; n++)
      db.query('INSERT INTO workspaces (path, canvas_id, repo) VALUES ($path, $c, NULL) ON CONFLICT(path) DO NOTHING').run({ path: `ssh://${h.name}${rootOn(h, ctx.dir)}/${n}`, c: ctx.canvas });
}

function ago(s: string): string {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s) ?? fail(`"${s}" is no time ago (like "15m", "2h", "3d")`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(Date.now() - Number(m[1]) * unit * 1000).toISOString();
}

function copyArtifact(from: string, to: string) {
  if (!existsSync(join(from, 'index.html'))) fail(`${from} holds no index.html for an HTML artifact`);
  cpSync(from, to, { recursive: true });
  return to;
}

/** The card's fields written into its row, its workspace, costs and conversation. */
async function writeCard(db: Database, ctx: Context, c: StageCard, i: number) {
  const { stage, ids, columns } = ctx;
  const key = keyOf(c, i);
  const id = ids[key]!;
  const row: Record<string, unknown> = {};
  if ((c.project || c.workstream) && (c.x !== undefined || c.y !== undefined)) Object.assign(row, { x: c.x, y: c.y });
  if (c.state !== undefined) row.state = c.state;
  if (c.need !== undefined) row.need = c.need;
  if (c.statusLine !== undefined) row.status_line = c.statusLine;
  if (c.summary !== undefined) row.detail = { summary: c.summary };
  if (c.question !== undefined) row.detail = { question: { options: [], ...c.question } };
  // an HTML artifact is shown from a copy in <dir>, which --artifact may rewrite
  // a video as a handover keeps it, with what the player knows of it beforehand
  const demo = c.demo && (c.demo.kind === 'html' ? { ...c.demo, dir: copyArtifact(String(c.demo.dir), artifactDir(ctx.dir, key)) } : { ...(await videoFacts(String(c.demo.dir))), ...c.demo });
  if (demo !== undefined) row.demo = { kind: 'video', ...demo };
  if (c.queue !== undefined)
    row.queue = {
      ...c.queue,
      ...(c.queue.behind ? { behind: c.queue.behind.map((k) => ids[k] ?? fail(`card ${key}: queue names ${k}, which does not exist`)) } : {}),
      since: c.queue.since ?? new Date().toISOString(),
    };
  if (c.snoozed !== undefined) {
    const on = ids[c.snoozed.on] ?? fail(`card ${key}: snoozed names ${c.snoozed.on}, which does not exist`);
    const title = stage.cards.find((x) => x.key === c.snoozed!.on)?.title ?? '';
    row.snoozed = { on: { card: on, title, state: c.snoozed.state ?? 'done' }, by: 'agent', ...(c.snoozed.why ? { why: c.snoozed.why } : {}) };
  }
  if (c.scope !== undefined) row.scope = { files: c.scope, reason: '' };
  // a card at work or waiting for the owner has the branch its start gave it, as every started card
  // has: without one the card shows neither its conversation's field nor the question it waits on
  const branch = c.branch ?? (c.state === 'working' || c.state === 'waiting' ? branchName(c.title ?? ctx.snapshot.items.find((x) => x.id === id)?.title ?? '', id) : undefined);
  if (branch !== undefined) row.branch = branch;
  if (c.workspace) Object.assign(row, holdWorkspace(db, ctx, c, i, branch));
  if (c.prototypeOf !== undefined) row.prototype_of = ids[c.prototypeOf] ?? fail(`card ${key}: prototypeOf names ${c.prototypeOf}, which does not exist`);
  if (c.createdAgo !== undefined) row.created_at = ago(c.createdAgo);
  if (c.archivedAgo !== undefined) row.archived_at = ago(c.archivedAgo);
  // code from before `changed_at` ordered by `updated_at`
  if (c.changedAgo !== undefined) row[columns.has('changed_at') ? 'changed_at' : 'updated_at'] = ago(c.changedAgo);
  Object.assign(row, c.row ?? {});
  // a review card handed over has reviewed its PR's head, which is all Obeya merges
  const contribution = row.contribution as { number?: number; reviewed?: string } | undefined;
  const pull = contribution && !contribution.reviewed && ctx.repos.prHeads.get(contribution.number ?? -1);
  if (pull) row.contribution = { ...contribution, reviewed: pull };
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const missing = keys.filter((k) => !columns.has(k));
  if (missing.length) fail(`card ${key}: this code's database has no column ${missing.join(', ')}`);
  if (keys.length)
    db.query(`UPDATE cards SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({
      id,
      ...Object.fromEntries(keys.map((k) => [k, typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : (row[k] as string | number | null)])),
    } as Record<string, string | number | null>);
  if (c.spent !== undefined) {
    if (!columns.has('spent')) fail(`card ${key}: this code's database has no costs`);
    db.query("INSERT INTO spend (canvas_id, card_id, session, usd) SELECT canvas_id, id, 'staged:' || id, $usd FROM cards WHERE id = $id").run({ id, usd: c.spent });
    db.query('UPDATE cards SET spent = $usd WHERE id = $id').run({ id, usd: c.spent });
  }
  writeEvents(db, c, id, demo);
}

/** The workspace a card holds (`workspace`): the columns of its row that say so. */
function holdWorkspace(db: Database, ctx: Context, c: StageCard, i: number, branch: string | undefined): Record<string, unknown> {
  const { stage, home, repos } = ctx;
  const key = keyOf(c, i);
  const id = ctx.ids[key]!;
  if (repos.folder) {
    // every card works in the folder itself, with a record of what it changed there (folder.ts)
    db.query('INSERT INTO folder_cards (card_id, folder, state) VALUES ($id, $f, $s) ON CONFLICT(card_id) DO NOTHING').run({
      id,
      f: realpathSync(repos.repo),
      s: JSON.stringify({ held: true, undo: null, changes: c.changes ?? [] }),
    });
    return { workspace: repos.repo, branch: branch ?? `obeya/${id.slice(0, 6)}` };
  }
  // a card on a further canvas (`canvases`) works in a workspace of that canvas's repository, a card
  // on a further repository of the first canvas (`repos`) in a workspace of that one
  const on = ctx.canvasOf[key]!;
  const elsewhere = on !== ctx.canvas ? repos.further.find((f) => f.name === c.canvas)! : null;
  const other = c.repo && c.repo !== (elsewhere ? basename(elsewhere.repos[0]!.path) : (stage.repoName ?? 'repo')) ? c.repo : null;
  const checkout = other ? join(ctx.dir, other) : elsewhere ? elsewhere.repos[0]!.path : repos.repo;
  const free = db.query('SELECT path FROM workspaces WHERE card_id IS NULL AND canvas_id = $c AND repo IS $r ORDER BY path').get({ c: on, r: other }) as { path: string } | null;
  // no clones: the repository works in worktrees, one per card under Obeya's home (`clones` are the first canvas's)
  const tree = !free && !!branch && (!stage.clones || !!elsewhere);
  if (!free && !tree) fail(`card ${key}: no free clone for it ("clones" in the stage, settings that say clones), nor a branch for a worktree`);
  const path = tree ? join(home, 'workspaces', on, id.slice(0, 8)) : free!.path;
  if (tree) {
    mkdirSync(dirname(path), { recursive: true });
    git(checkout, 'worktree', 'add', '-q', '-b', branch!, path, ctx.mainBranch);
    db.query('INSERT INTO workspaces (path, canvas_id, card_id, repo) VALUES ($path, $c, $id, $r)').run({ path, c: on, id, r: other });
  } else {
    db.query('UPDATE workspaces SET card_id = $id WHERE path = $path').run({ id, path });
    if (branch) git(path, 'checkout', '-q', '-b', branch);
  }
  if (c.branch) {
    // a commit of its own, where the stage names no files for it
    writeFiles(path, c.branchFiles && Object.keys(c.branchFiles).length ? c.branchFiles : { 'scratch.txt': `${c.title ?? c.branch}\n` });
    git(path, 'add', '-A');
    git(path, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', 'commit', '-qm', c.title ?? c.branch);
  }
  return { workspace: path };
}

/** The card's conversation, with the demos of its handovers and the spots its comments name. */
function writeEvents(db: Database, c: StageCard, id: string, demo: Record<string, unknown> | undefined) {
  const reviews: { id: number; at: string }[] = [];
  const spots: [number, NonNullable<StageEvent['spot']>][] = [];
  for (const e of c.events ?? []) {
    // only code that has mocks (an error's token) has their column
    const at = ago(e.ago ?? '0s');
    const { lastInsertRowid } = db.query(`INSERT INTO events (card_id, at, kind, author, text${e.mocks ? ', mocks' : ''}${e.token ? ', token' : ''}${e.reply ? ', reply' : ''}) VALUES ($c, $at, $kind, $author, $text${e.mocks ? ', $mocks' : ''}${e.token ? ', 1' : ''}${e.reply ? ', 1' : ''})`).run({
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

/** Inserts `row` into `table`, returning its id. */
const insert = (db: Database, table: string, row: Record<string, string | number | null>) => {
  const keys = Object.keys(row);
  return (db.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `$${k}`).join(', ')}) RETURNING id`).get(row) as { id: number }).id;
};

function writePreferences(db: Database, { stage, canvas, ids }: Context) {
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
    const id = insert(db, 'preferences', row);
    if (p.key) prefIds[p.key] = id;
  }
}

function writeTalk(db: Database, { stage, canvas, ids, home }: Context) {
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
    if (x.replyOnly) row.reply_only = 1;
    if (x.wish) row.wish = JSON.stringify(x.wish);
    if (x.askedIn) row.asked_in = row.about = ids[x.askedIn] ?? fail(`talk ${i}: project ${x.askedIn} does not exist`);
    if (x.follows !== undefined) {
      const followed = talkIds[x.follows] ?? fail(`talk ${i}: follows ${x.follows}, which comes later or does not exist`);
      row.follows = followed;
      row.thread = threadOf.get(followed) ?? followed;
    }
    if (x.files?.length) row.files = JSON.stringify(x.files.map((f) => ({ name: f.name, caption: f.caption })));
    const id = insert(db, 'talk', row);
    talkIds.push(id);
    const thread = typeof row.thread === 'number' ? row.thread : id;
    threadOf.set(id, thread);
    for (const f of x.files ?? []) {
      const to = join(home, 'answers', canvas, String(thread), f.name);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.from ? readFileSync(f.from) : (f.content ?? ''));
    }
  }
}

/** What the work retrospective noted (`friction`) and proposed (`settingProposals`). */
function writeRetrospective(db: Database, { stage, canvas, ids }: Context) {
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
}

/**
 * The server keeps a snapshot of each canvas: a change through the API makes it read the database
 * anew. Per canvas with a staged card, that card moved to where it already is in the database (the
 * snapshot still has where it was).
 */
function refreshes(db: Database, { stage, canvas, ids }: Context, canvases: Canvas[]): [string, string, { x: number; y: number }][] {
  return canvases.flatMap((on) => {
    // a project or workstream is on the home canvas: a stage of plan cards alone has nothing else to move
    const i = stage.cards.findIndex((c) => (c.project || c.workstream ? on.id === canvas : c.canvas ? c.canvas === on.name : on.id === canvas));
    if (i < 0) return [];
    const id = ids[keyOf(stage.cards[i]!, i)]!;
    return [[on.id, id, db.query('SELECT x, y FROM cards WHERE id = $id').get({ id }) as { x: number; y: number }]];
  });
}
