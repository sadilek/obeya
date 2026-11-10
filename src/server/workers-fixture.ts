// What the tests of the workers share (workers.test.ts and workers-*.test.ts, split so that
// `bun test --parallel` runs them side by side): a checkout with a clone, a board and the workers
// on it, set up afresh for each test. Tests read the bindings below; they replace one with its setter
// or, the workers, with `rebuild`.

import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { Item } from '../core/types';
import type { PlanDoc } from '../core/plan-doc';
import { Board } from './board';
import { Store } from './db';
import { ReadTree } from './read-tree';
import { artifact, commit, FakeRuntime, gitClone, gitRepo, identify, removeDir } from './testing';
import { type WorkerOptions, Workers } from './workers';
import { Workspaces } from './workspaces';

export const ws = (key: string) => ({ key, label: key, title: `Title ${key}`, body: 'Body', done: false, inReview: false });
export const doc: PlanDoc = { file: 'docs/plan/a.md', title: 'A', goal: 'Goal', workstreams: [ws('W1')], markdown: '' };

/** The repository's settings unless a test sets up with others: work lands on main from clones, with setup, checks and an app. */
export const defaultAdapter: RepoAdapter = {
  ...generic,
  land: 'main',
  workspaces: 'clones',
  setup: 'bun install',
  checks: ['bun test'],
  app: { run: 'Start it with `bun run stack`; after an API change, `bun run api:restart`. The URL is in `.stack.env` under WEB_URL.' },
};

export let dir: string;
export let main: string;
export let board: Board;
export let docs: PlanDoc[];
export let runtime: FakeRuntime;
export let workers: Workers;
export let spaces: Workspaces;
export let store: Store;
/** With `setup(adapter, true)`: the bare repository the clones come from and push to. */
export let origin: string;
/** The cards `onMerged` was called for. */
export let merged: string[];
/** What the workers were set up with: `rebuild` builds them again from it. */
let base: WorkerOptions;

/** The language of Obeya's interface in these tests. */
export let language: 'de' | 'en';
/** The owner's conversation language in these tests; the interface's where none is set. */
export let conversation: 'de' | 'en' | undefined;

/** Every `Workers` a test made here, the ones it replaced too: each is shut down after the test (`eachTest`). */
const made = new Set<Workers>();
export const setWorkers = (w: Workers) => void made.add((workers = w));
/** Workers a test makes beside the ones it works through (another canvas's, an Obeya started anew): shut down with them after the test. */
export const tracked = (w: Workers) => (made.add(w), w);
export const setDocs = (d: PlanDoc[]) => void (docs = d);
export const setLanguage = (l: 'de' | 'en') => void (language = l);
export const setConversation = (l: 'de' | 'en') => void (conversation = l);

/** `withOrigin`: clones come from a bare `origin`, as from a remote, instead of from the checkout. */
export async function setup(adapter: RepoAdapter = defaultAdapter, withOrigin = false) {
  // a test that sets up afresh is done with the setup before: it goes as after a test
  if (made.size) await tearDown();
  dir = mkdtempSync(join(tmpdir(), 'obeya-workers-'));
  main = join(dir, 'main');
  gitRepo(main);
  origin = join(dir, 'origin.git');
  if (withOrigin) gitClone(main, origin, { bare: true });
  store = new Store(':memory:');
  docs = [doc];
  // the checkout is the read tree: work lands on its main
  const read = new ReadTree({ repoPath: main, dir: null, remote: false, onChange: () => {} });
  const holds = (_repo: string, commit: string) => read.holds(commit, () => board.docsChanged());
  language = 'de';
  conversation = undefined;
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => ({ docs, dirs: [] }), undefined, holds, () => language, () => conversation ?? language);
  const workspaces = new Workspaces(store, 'c', { mode: adapter.workspaces, repoPath: main, dir: join(dir, 'ws') });
  spaces = workspaces;
  if (adapter.workspaces === 'clones') {
    // the clone ensureClones would make, without git's clone (`gitClone`)
    gitClone(withOrigin ? origin : main, join(dir, 'ws', '1'));
    await workspaces.ensureClones(withOrigin ? origin : main, 1);
    for (const w of workspaces.list()) identify(w.path);
  }
  runtime = new FakeRuntime();
  merged = [];
  base = {
    board,
    runtime,
    workspaces,
    adapter,
    onMerged: (cardId) => void merged.push(cardId),
    env: { OBEYA_URL: 'http://127.0.0.1:4417' },
    keptDemos: join(dir, 'kept'),
  };
  setWorkers(new Workers(base));
}

/** Workers built as the setup's, with `options` changed; shut down after the test with the others. */
export const newWorkers = (options: Partial<WorkerOptions> = {}) => tracked(new Workers({ ...base, ...options }));
/** Replaces `workers` with `newWorkers(options)`. */
export const rebuild = (options: Partial<WorkerOptions> = {}) => (workers = newWorkers(options));

/**
 * Sets each test in the calling scope up afresh, with `adapter` and `withOrigin` (see `setup`), and
 * removes it afterwards. A file calls it at its top, or in each describe where they differ; run one
 * after the other in one process, the files share this module, evaluated once.
 */
export function eachTest(adapter = defaultAdapter, withOrigin = false) {
  beforeEach(() => setup(adapter, withOrigin));
  afterEach(tearDown);
}

/** No timer of a test's workers outlives the setup; git freeing a workspace in the background is done before its repository goes. */
async function tearDown() {
  const all = [...made];
  made.clear();
  for (const w of all) w.shutdown();
  await Promise.all(all.map((w) => w.freed()));
  await removeDir(dir);
}

export const manual = () => board.create({ title: 'Zählerstände exportieren', x: 0, y: 0 });

/**
 * A card started and handed over as a worker hands over: with `commit` (a file name) a commit of
 * that file in its workspace, `ready_for_review` with `summary` and `demo`, and with `idle` the end
 * of the worker's turn. The card is a new one titled `title`, or `card`.
 */
export async function handedOver({
  card,
  title = 'Zählerstände exportieren',
  commit: file,
  summary = 'S',
  demo = artifact() as object,
  idle = true,
}: { card?: Item; title?: string; commit?: string; summary?: string; demo?: object; idle?: boolean } = {}) {
  card ??= board.create({ title, x: 0, y: 0 });
  await workers.start(card.id);
  const session = runtime.last;
  const workspace = board.row(card.id).workspace!;
  if (file) commit(workspace, file);
  await session.call('ready_for_review', { summary, demo });
  if (idle) session.emit({ type: 'idle' });
  return { card, session, workspace };
}

export const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};
export const flush = () => new Promise((r) => setTimeout(r, 0));
