// What the tests of the workers share (workers.test.ts and workers-*.test.ts, split so that
// `bun test --parallel` runs them side by side): a checkout with a clone, a board and the workers
// on it, set up afresh for each test. Tests read the bindings below; they replace one with its setter.

import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { PlanDoc } from '../core/plan-doc';
import { Board } from './board';
import { Store } from './db';
import { ReadTree } from './read-tree';
import { FakeRuntime, gitClone, gitRepo, identify, removeDir } from './testing';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

export const ws = (key: string) => ({ key, label: key, title: `Title ${key}`, body: 'Body', done: false, inReview: false });
export const doc: PlanDoc = { file: 'docs/plan/a.md', title: 'A', goal: 'Goal', workstreams: [ws('W1')], markdown: '' };

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

/** The language of Obeya's interface in these tests. */
export let language: 'de' | 'en';
/** The owner's conversation language in these tests; the interface's where none is set. */
export let conversation: 'de' | 'en' | undefined;

export const setWorkers = (w: Workers) => void (workers = w);
export const setDocs = (d: PlanDoc[]) => void (docs = d);
export const setLanguage = (l: 'de' | 'en') => void (language = l);
export const setConversation = (l: 'de' | 'en') => void (conversation = l);

/** `withOrigin`: clones come from a bare `origin`, as from a remote, instead of from the checkout. */
export async function setup(adapter: RepoAdapter, withOrigin = false) {
  dir = mkdtempSync(join(tmpdir(), 'obeya-workers-'));
  main = join(dir, 'main');
  gitRepo(main);
  origin = join(dir, 'origin.git');
  if (withOrigin) gitClone(main, origin, { bare: true });
  store = new Store(':memory:');
  docs = [doc];
  // the checkout is the Lesestand: work lands on its main
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
  workers = new Workers({
    board,
    runtime,
    workspaces,
    adapter,
    onMerged: (cardId) => void merged.push(cardId),
    env: { OBEYA_URL: 'http://127.0.0.1:4417' },
    keptDemos: join(dir, 'kept'),
  });
}

/**
 * Sets each test of the calling file up afresh and removes it afterwards. Each file calls it: run
 * one after the other in one process, the files share this module, evaluated once.
 */
export function eachTest() {
  beforeEach(() =>
    setup({
      ...generic,
      land: 'main',
      workspaces: 'clones',
      setup: 'bun install',
      checks: ['bun test'],
      app: { run: 'Start it with `bun run stack`; after an API change, `bun run api:restart`. The URL is in `.stack.env` under WEB_URL.' },
    }),
  );
  afterEach(async () => {
    // git freeing a workspace in the background is done before its repository goes
    await workers?.freed();
    await removeDir(dir);
  });
}

export const manual = () => board.create({ title: 'Zählerstände exportieren', x: 0, y: 0 });
export const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};
export const flush = () => new Promise((r) => setTimeout(r, 0));
