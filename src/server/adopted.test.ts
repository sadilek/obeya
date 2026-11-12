// A task that works on a branch of the owner's that existed before it (design: Landing, A branch of
// the owner's): which branches it may take, where its workspace starts, and how its approved work
// goes onto the branch's pull request (one from a fork against the original among them), or lands
// as any task's where the branch has none.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { AdoptedPr } from '../core/types';
import type { Board } from './board';
import { Store } from './db';
import type { Forge, PrStatus } from './forge';
import { git } from './git';
import { PrWatcher } from './pr-watcher';
import { fromJson } from './row';
import { artifact, commit, FakeRuntime, gitClone, gitRepo, identify, noContributions, primedClones, removeDir, stateOn, testBoard, until } from './testing';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

let dir: string;
/** The owner's repository on the forge (a fork, whose original is acme/app there). */
let origin: string;
/** The checkout Obeya runs the repository from. */
let main: string;
/** Another clone of origin, where the owner worked on the branch before. */
let elsewhere: string;
let store: Store;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let watcher: PrWatcher;
let status: PrStatus;
let merges: string[];
/** What the forge says of the branch's pull request. */
let found: AdoptedPr | null;
/** The commit the branch has on origin. */
let pushed: string;
let settings: RepoAdapter;
const URL_ = 'https://github.com/acme/app/pull/82';
const BRANCH = 'feature/monotonic-energy-counter';

function workersOn(workspaces: Workspaces) {
  workers?.shutdown();
  workers = new Workers({ board, runtime, workspaces, adapter: settings, forge: forgeFake(), repoPath: main });
  watcher = new PrWatcher(board, workers, forgeFake(), () => main, () => settings);
}

const forgeFake = (): Forge => ({
  ...noContributions,
  open: async () => '',
  status: async () => status,
  body: async () => '',
  setBody: async () => {},
  merge: async (_cwd, _url, head) => void merges.push(head),
  branchPr: async (_cwd, branch) => (branch === BRANCH ? found : null),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-adopted-'));
  const seed = gitRepo(join(dir, 'seed'));
  origin = gitClone(seed, join(dir, 'origin.git'), { bare: true });
  elsewhere = gitClone(origin, join(dir, 'elsewhere'));
  identify(elsewhere);
  git(elsewhere, 'switch', '--quiet', '-c', BRANCH);
  commit(elsewhere, 'counter.ts', 'monotonic\n', 'Keep the energy counter monotonic');
  pushed = commit(elsewhere, 'counter.test.ts', 'test\n', 'Test the counter');
  git(elsewhere, 'push', '--quiet', 'origin', BRANCH);
  main = gitClone(origin, join(dir, 'main'));
  identify(main);
  // a branch of the owner's that never went to origin
  git(main, 'branch', 'local-try');
  store = new Store(':memory:');
  board = testBoard({ store, path: main });
  runtime = new FakeRuntime();
  settings = { ...generic, land: 'main', workspaces: 'worktrees' };
  found = { url: URL_, number: 82, repo: 'acme/app', maintainers: true };
  status = { state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: '', author: 'owner', checks: [], comments: [] };
  merges = [];
  workersOn(new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') }));
});
afterEach(async () => {
  workers.shutdown();
  await removeDir(dir);
});

const state = (id: string) => stateOn(board, id);
const pr = (id: string) => fromJson(board.row(id).pr)!;
const onOrigin = () => git(origin, 'rev-parse', BRANCH);

/** A task on the owner's branch, started, with `file` committed and handed over. */
async function handedOver(file = 'demo.md') {
  const c = board.create({ title: 'Demo the energy counter', x: 0, y: 0 });
  await workers.adoptBranch(c.id, BRANCH);
  if (found) await until(() => board.item(c.id)!.adopted?.pr);
  await workers.start(c.id);
  const ws = board.row(c.id).workspace!;
  const head = commit(ws, file, 'demo\n', `Add ${file}`);
  const session = runtime.last;
  await session.call('ready_for_review', { summary: 'S', demo: artifact() });
  session.emit({ type: 'idle' });
  return { id: c.id, ws, head, session };
}

describe('the branches a task may take', () => {
  test('are the checkout’s and origin’s, but the main branch, Obeya’s own and those of other cards, which name their card', async () => {
    const other = board.create({ title: 'Other', x: 0, y: 0 });
    await workers.start(other.id);
    const names = await workers.branchChoices();
    expect(names).toEqual([
      { name: BRANCH, remoteOnly: true },
      { name: 'local-try' },
    ]);
    const c = board.create({ title: 'Demo', x: 0, y: 0 });
    await workers.adoptBranch(c.id, 'local-try');
    expect(board.item(c.id)!.adopted).toEqual({ branch: 'local-try' });
    expect((await workers.branchChoices()).find((b) => b.name === 'local-try')).toEqual({ name: 'local-try', card: { id: c.id, title: 'Demo' } });
    const d = board.create({ title: 'Again', x: 0, y: 0 });
    expect(await workers.adoptBranch(d.id, 'local-try').catch((e: Error) => e.message)).toContain('works on local-try already');
    expect(await workers.adoptBranch(d.id, 'main').catch((e: Error) => e.message)).toContain('there is no branch main');
    // taken back: a new branch from the main branch again
    await workers.adoptBranch(c.id, null);
    expect(board.item(c.id)!.adopted).toBeUndefined();
  });

  test('taking one looks up its open pull request, and a fork’s task takes it instead of the original’s main', async () => {
    const c = board.create({ title: 'Demo', x: 0, y: 0 });
    board.patch(c.id, { upstream: true });
    await workers.adoptBranch(c.id, BRANCH);
    expect(board.item(c.id)!.upstream).toBeUndefined();
    await until(() => board.item(c.id)!.adopted?.pr);
    expect(board.item(c.id)!.adopted).toEqual({ branch: BRANCH, remote: true, pr: found! });
  });

  test('once work has begun, the branch is the card’s', async () => {
    const c = board.create({ title: 'Demo', x: 0, y: 0 });
    await workers.start(c.id);
    expect(await workers.adoptBranch(c.id, BRANCH).catch((e: Error) => e.message)).toContain('only before work on it begins');
  });
});

describe('a task on a branch of the owner’s', () => {
  test('starts on the branch as origin has it, and its worker hears what is published there', async () => {
    const c = board.create({ title: 'Demo', x: 0, y: 0 });
    await workers.adoptBranch(c.id, BRANCH);
    await until(() => board.item(c.id)!.adopted?.pr);
    await workers.start(c.id);
    const ws = board.row(c.id).workspace!;
    expect(board.row(c.id).branch).toBe(BRANCH);
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(pushed);
    const brief = runtime.last.inbox[0]!;
    expect(brief).toContain(`You are on branch ${BRANCH}, a branch of the owner's that existed before this card`);
    expect(brief).toContain('never rewrite them');
    expect(brief).toContain(`It has the open pull request ${URL_} in acme/app. Do not push before the owner approves`);
  });

  test('a copy in the checkout behind origin’s is brought forward to it', async () => {
    git(main, 'branch', BRANCH, `origin/${BRANCH}~1`);
    const c = board.create({ title: 'Demo', x: 0, y: 0 });
    await workers.adoptBranch(c.id, BRANCH);
    await workers.start(c.id);
    expect(git(board.row(c.id).workspace!, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(git(main, 'rev-parse', BRANCH)).toBe(pushed);
  });

  test('in a clone, starts on origin’s branch too', async () => {
    workersOn(await primedClones(store, main, dir));
    const c = board.create({ title: 'Demo', x: 0, y: 0 });
    await workers.adoptBranch(c.id, BRANCH);
    await workers.start(c.id);
    const ws = board.row(c.id).workspace!;
    expect(git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(pushed);
  });
});

describe('approving a task whose branch has an open pull request', () => {
  test('pushes the work onto the branch and follows the pull request, which the original’s maintainers merge', async () => {
    const { id, head, session } = await handedOver();
    await workers.approve(id);
    expect(state(id)).toBe('inPr');
    expect(onOrigin()).toBe(head);
    // the main branch is not touched: the work goes to the original
    expect(git(main, 'rev-parse', 'main')).toBe(git(origin, 'rev-parse', 'main'));
    expect(pr(id)).toMatchObject({ url: URL_, number: 82, repo: 'acme/app', adopted: true, maintainers: true });
    expect(session.inbox.at(-1)).toContain(`pushed it onto ${BRANCH}, the branch of the open pull request acme/app#82`);
    expect(session.inbox.at(-1)).toContain('its maintainers in acme/app merge it, never Obeya');
    // nothing of it is the card's to take back
    expect(board.item(id)!.revocable).toBeUndefined();
    status.head = head;
    status.comments = [{ id: 'c1', author: 'boris', body: 'Looks good, will merge soon', at: '2026-11-12T10:00:00Z' }];
    session.emit({ type: 'idle' });
    await watcher.poll();
    // the maintainer's word goes to the worker, as on any pull request of the card's
    expect(session.inbox.at(-1)).toContain('Looks good, will merge soon');
    session.emit({ type: 'idle' });
    await watcher.poll();
    expect(merges).toEqual([]);
    expect(board.item(id)!.pr!.waits).toEqual(['maintainer']);
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
  });

  test('approved directly, refuses: the work goes onto the pull request', async () => {
    const { id } = await handedOver();
    expect(await workers.approve(id, { direct: true }).catch((e: Error) => e.message)).toContain('has an open pull request');
  });

  test('in the owner’s own repository, Obeya merges it once it is ready, as any', async () => {
    found = { url: 'https://github.com/owner/app/pull/5', number: 5 };
    const { id, head, session } = await handedOver();
    await workers.approve(id);
    status.head = head;
    session.emit({ type: 'idle' });
    await watcher.poll();
    expect(merges).toEqual([head]);
  });

  test('where origin’s branch moved meanwhile, goes back to the worker with the approval kept', async () => {
    const { id, ws, session } = await handedOver();
    git(elsewhere, 'pull', '--quiet', 'origin', BRANCH);
    const theirs = commit(elsewhere, 'note.md', 'note\n', 'A note pushed from elsewhere');
    git(elsewhere, 'push', '--quiet', 'origin', BRANCH);
    await workers.approve(id);
    expect(state(id)).toBe('working');
    expect(session.inbox.at(-1)).toContain('has commits your branch lacks');
    expect(onOrigin()).toBe(theirs);
    // the worker merges them in and hands over: pushed without a new approval
    git(ws, 'pull', '--quiet', '--no-rebase', '--no-edit', 'origin', BRANCH);
    await session.call('ready_for_review', { summary: 'Merged origin in' });
    session.emit({ type: 'idle' });
    await until(() => state(id) === 'inPr');
    expect(onOrigin()).toBe(git(ws, 'rev-parse', 'HEAD'));
  });

  test('a pull request closed since lands the work as any task of the repository', async () => {
    const { id } = await handedOver();
    found = null;
    await workers.approve(id);
    expect(state(id)).toBe('live');
    expect(git(main, 'ls-tree', '--name-only', 'main').split('\n')).toEqual(expect.arrayContaining(['counter.ts', 'demo.md']));
    // origin's copy of the branch stays as it was: nothing is force-pushed
    expect(onOrigin()).toBe(pushed);
    expect(board.item(id)!.adopted?.pr).toBeUndefined();
  });
});

test('without a pull request, where work goes out as one, the worker opens it from the branch', async () => {
  settings = { ...settings, land: 'pr' };
  workersOn(new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws2') }));
  found = null;
  const { id, session } = await handedOver();
  await workers.approve(id);
  expect(state(id)).toBe('inPr');
  expect(session.inbox.at(-1)).toContain(`open the pull request from it under that name, pushing onto origin's ${BRANCH} fast-forward only`);
});
