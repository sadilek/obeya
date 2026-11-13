// Work that went onto pull requests open already instead of onto the card's branch (design: Card
// lifecycle, Live and done): the handover names them, and the approval follows them until they are
// merged instead of closing the card as done.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { Board } from './board';
import { Store } from './db';
import type { Forge, PrStatus } from './forge';
import { PrWatcher } from './pr-watcher';
import { fromJson } from './row';
import { artifact, commit, FakeRuntime, gitClone, gitRepo, identify, noContributions, removeDir, stateOn, testBoard } from './testing';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

let dir: string;
let main: string;
let store: Store;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let watcher: PrWatcher;
let status: PrStatus;
let merges: string[];
/** The repositories the owner's account may merge in, as the forge says. */
let mayMergeIn: string[];
let settings: RepoAdapter;
/** A fork's pull request to the original, which the worker pushed onto. */
const UPSTREAM = 'https://github.com/boris/bridge/pull/82';
/** One in the owner's own repository. */
const OWN = 'https://github.com/owner/bridge/pull/7';

const forgeFake = (): Forge => ({
  ...noContributions,
  open: async () => '',
  status: async () => status,
  body: async () => '',
  setBody: async () => {},
  merge: async (_cwd, _url, head) => void merges.push(head),
  mayMerge: async (_cwd, url) => mayMergeIn.some((r) => url.includes(`/${r}/`)),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-follows-'));
  const seed = gitRepo(join(dir, 'seed'));
  const origin = gitClone(seed, join(dir, 'origin.git'), { bare: true });
  main = gitClone(origin, join(dir, 'main'));
  identify(main);
  store = new Store(':memory:');
  board = testBoard({ store, path: main });
  runtime = new FakeRuntime();
  settings = { ...generic, land: 'main', workspaces: 'worktrees' };
  status = { state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: 'abc1234', author: 'owner', checks: [], comments: [] };
  merges = [];
  mayMergeIn = ['owner/bridge'];
  const workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') });
  workers = new Workers({ board, runtime, workspaces, adapter: settings, forge: forgeFake(), repoPath: main, remote: 'https://github.com/owner/bridge.git' });
  watcher = new PrWatcher(board, workers, forgeFake(), () => main, () => settings);
});
afterEach(async () => {
  workers.shutdown();
  await removeDir(dir);
});

const state = (id: string) => stateOn(board, id);
const pr = (id: string) => fromJson(board.row(id).pr)!;

/** A started task whose worker hands over with `args` (and `file` committed, where given); returns what the handover answered. */
async function handOver(args: Record<string, unknown>, file?: string) {
  const c = board.create({ title: 'Take over upstream PR #82 and demo it', x: 0, y: 0 });
  await workers.start(c.id);
  if (file) commit(board.row(c.id).workspace!, file, 'x\n', `Add ${file}`);
  const session = runtime.last;
  const answer = await session.call('ready_for_review', { summary: 'S', demo: artifact(), ...args });
  session.emit({ type: 'idle' });
  return { id: c.id, session, answer };
}

describe('a handover whose work went onto a pull request instead of the branch', () => {
  test('approved, follows the pull request until its maintainers merged it, instead of closing the card', async () => {
    const { id, session, answer } = await handOver({ pull_requests: [UPSTREAM] });
    expect(answer).toContain(`approving follows pull request ${UPSTREAM} until it is merged`);
    expect(board.item(id)).toMatchObject({ noChange: true, followsPrs: [{ url: UPSTREAM, number: 82, repo: 'boris/bridge', maintainers: true }] });
    await workers.approve(id);
    expect(state(id)).toBe('inPr');
    expect(pr(id)).toMatchObject({ url: UPSTREAM, number: 82, repo: 'boris/bridge', adopted: true, maintainers: true });
    expect(session.inbox.at(-1)).toContain('the card follows the pull request your work went onto until it is merged');
    expect(session.inbox.at(-1)).toContain('its maintainers in boris/bridge merge it, never Obeya');
    expect(board.events(id).some((e) => e.text === board.t.worker.approvedFollows(['boris/bridge#82']))).toBe(true);
    // the work is public in the pull request: nothing of it is the card's to take back
    expect(board.item(id)!.revocable).toBeUndefined();
    status.comments = [{ id: 'c1', author: 'boris', body: 'Please rename the setting', at: '2026-11-12T10:00:00Z' }];
    await watcher.poll();
    expect(session.inbox.at(-1)).toContain('Please rename the setting');
    session.emit({ type: 'idle' });
    await watcher.poll();
    expect(merges).toEqual([]);
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
  });

  test('in a repository the owner’s account may merge in, Obeya merges it once it is ready, as any', async () => {
    const { id, session } = await handOver({ pull_requests: [OWN] });
    expect(board.item(id)!.followsPrs).toEqual([{ url: OWN, number: 7 }]);
    await workers.approve(id);
    session.emit({ type: 'idle' });
    await watcher.poll();
    expect(merges).toEqual(['abc1234']);
    expect(state(id)).toBe('live');
  });

  test('several are followed side by side, and the card is live once all are merged', async () => {
    const { id } = await handOver({ pull_requests: [UPSTREAM, OWN] });
    await workers.approve(id);
    expect(pr(id)).toMatchObject({ url: UPSTREAM, more: [{ url: OWN, number: 7, adopted: true }] });
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
  });

  test('without them, approving closes the card as done, as before', async () => {
    const { id, answer } = await handOver({});
    expect(answer).toContain('approving closes the card, and nothing lands');
    expect(board.item(id)!.followsPrs).toBeUndefined();
    await workers.approve(id);
    expect(state(id)).toBe('done');
  });

  test('is refused where the branch holds work, which lands with the approval instead', async () => {
    const { id, answer } = await handOver({ pull_requests: [UPSTREAM] }, 'fix.ts');
    expect(answer).toContain('Not handed over: your branch holds commits or uncommitted changes');
    expect(state(id)).toBe('working');
  });

  test('is refused for a URL that is no pull request’s', async () => {
    const { answer } = await handOver({ pull_requests: ['https://github.com/boris/bridge/issues/82'] });
    expect(answer).toContain('is not the URL of a pull request');
  });
});

describe('reporting a pull request with pr_opened', () => {
  test('before the approval points to the handover, which names one the work went onto', async () => {
    const c = board.create({ title: 'T', x: 0, y: 0 });
    await workers.start(c.id);
    expect(await runtime.last.call('pr_opened', { url: UPSTREAM })).toContain('name in ready_for_review (pull_requests)');
  });

  test('on a card closed without a change says it is finished, not that it waits for the approval', async () => {
    const { id, session } = await handOver({});
    await workers.approve(id);
    expect(await session.call('pr_opened', { url: UPSTREAM })).toContain('the card is finished');
  });
});
