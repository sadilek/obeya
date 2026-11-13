// Work that went onto pull requests open already instead of onto the card's branch (design: Card
// lifecycle, Live and done): the handover names them, and the approval follows them until they are
// merged instead of closing the card as done. And a pull request in another repository that work
// landed on main also needed (design: Landing, PR loop): reported after the landing, it is followed
// until it is merged, without landing anything again.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawnWaits } from '../core/queue';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { Board } from './board';
import { Store } from './db';
import { git } from './git';
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
  // a landed workspace the worker finished with is freed before its repository goes
  await workers.freed();
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

  test('a comment by the pull request’s author, someone other than the owner, reaches the worker', async () => {
    status = { ...status, author: 'boris', viewer: 'owner' };
    const { id, session } = await handOver({ pull_requests: [UPSTREAM] });
    await workers.approve(id);
    session.emit({ type: 'idle' });
    status.comments = [
      { id: 'c1', author: 'boris', body: 'Please also cover a reset to zero', at: '2026-11-12T10:00:00Z' },
      { id: 'c2', author: 'owner', body: 'Done in the latest commit', at: '2026-11-12T10:05:00Z' },
    ];
    await watcher.poll();
    expect(session.inbox.at(-1)).toContain('Please also cover a reset to zero');
    expect(session.inbox.at(-1)).not.toContain('Done in the latest commit');
  });

  test('approved after the branch took work since the handover, lands nothing and goes back to the worker', async () => {
    const { id, session } = await handOver({ pull_requests: [UPSTREAM] });
    commit(board.row(id).workspace!, 'late.ts', 'x\n', 'A late change');
    expect(await workers.approve(id).catch((e: Error) => e.message)).toContain('holds work since the handover');
    expect(state(id)).toBe('waiting:demo');
    expect(board.row(id).landed).toBeNull();
    expect(session.inbox.at(-1)).toContain('Nothing landed');
  });

  test('one of them reported again with pr_opened stays one of them, the others kept', async () => {
    const SECOND = 'https://github.com/owner/bridge/pull/8';
    const { id, session } = await handOver({ pull_requests: [OWN, SECOND] });
    await workers.approve(id);
    await session.call('pr_opened', { url: SECOND });
    expect(pr(id).url).toBe(OWN);
    expect(pr(id).more?.map((m) => m.url)).toEqual([SECOND]);
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

describe('a pull request in another repository, reported after the work landed on main', () => {
  /** One in another repository of the owner's that the work also needed. */
  const DOCS = 'https://github.com/owner/docs/pull/3';

  /** A task whose work landed on main, and a task the owner's arrow holds behind it. */
  async function landed() {
    const c = board.create({ title: 'Rename the setting, and in the docs too', x: 0, y: 0 });
    const after = board.create({ title: 'Build on the renamed setting', x: 0, y: 0 });
    board.connect(c.id, after.id);
    await workers.start(c.id);
    commit(board.row(c.id).workspace!, 'setting.ts', 'x\n', 'Rename the setting');
    const session = runtime.last;
    await session.call('ready_for_review', { summary: 'S', demo: artifact() });
    session.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    return { id: c.id, after: after.id, session, head: git(main, 'rev-parse', 'HEAD') };
  }
  const waitsFor = (id: string) => drawnWaits({ ...board.item(id)!, state: 'planned' }, board.items());

  test('puts the card in it until it is merged, without landing again, and what waits for the card waits no longer', async () => {
    const { id, after, session, head } = await landed();
    expect(waitsFor(after)).toEqual([]);
    const shipped = board.row(id).shipped;
    expect(await session.call('pr_opened', { url: DOCS })).toContain('Your work stays on main, and the card is in this pull request until it is merged');
    expect(state(id)).toBe('inPr');
    expect(pr(id)).toMatchObject({ url: DOCS, number: 3, repo: 'owner/docs', onMain: true });
    expect(board.item(id)).toMatchObject({ onMain: true, pr: { url: DOCS, repo: 'owner/docs' } });
    // the card's work is on main: the arrow does not hold the card behind it again, and taking back is not the card's while the pull request is out
    expect(waitsFor(after)).toEqual([]);
    expect(board.item(id)!.revocable).toBeUndefined();
    // its turn ends in the pull request: the session stays for what comes of it
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(false);
    status.comments = [{ id: 'c1', author: 'maintainer', body: 'Please mention the old name', at: '2026-11-13T10:00:00Z' }];
    await watcher.poll();
    expect(session.inbox.at(-1)).toContain('Please mention the old name');
    session.emit({ type: 'idle' });
    status.state = 'MERGED';
    status.mergeCommit = 'def5678';
    await watcher.poll();
    expect(state(id)).toBe('live');
    expect(session.inbox.at(-1)).toContain('Your pull request in owner/docs#3 was merged; your work is on main since its landing');
    // nothing landed again: main is where the landing left it, and the landing is the card's
    expect(git(main, 'rev-parse', 'HEAD')).toBe(head);
    expect(board.row(id).shipped).toBe(shipped);
    expect(fromJson(board.row(id).landed)!.commit).toBe(head);
    expect(board.item(id)!.revocable).toBeUndefined();
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(true);
  });

  test('closed without a merge, kept on main alone: the card is live, and its approval can be taken back by a revert again', async () => {
    const { id, session } = await landed();
    await session.call('pr_opened', { url: DOCS });
    session.emit({ type: 'idle' });
    status.state = 'CLOSED';
    await watcher.poll();
    expect(board.item(id)).toMatchObject({ state: 'waiting', need: 'question' });
    expect(board.item(id)!.question!.options).toEqual([board.t.worker.reopen, board.t.worker.keepOnMain('main')]);
    workers.answer(id, '', [], false, undefined, [board.t.worker.keepOnMain('main')]);
    expect(state(id)).toBe('live');
    expect(session.inbox.at(-1)).toContain('The owner keeps the work on main without the pull request owner/docs#3');
    expect(board.item(id)!.revocable).toEqual({ how: 'revert' });
  });

  test('closed and opened again, it is followed once reported again', async () => {
    const { id, session } = await landed();
    await session.call('pr_opened', { url: DOCS });
    session.emit({ type: 'idle' });
    status.state = 'CLOSED';
    await watcher.poll();
    workers.answer(id, '', [], false, undefined, [board.t.worker.reopen]);
    expect(state(id)).toBe('inPr');
    status.state = 'OPEN';
    await session.call('pr_opened', { url: DOCS });
    expect(pr(id).closed).toBeUndefined();
    status.state = 'MERGED';
    await watcher.poll();
    expect(state(id)).toBe('live');
  });

  test('one in the card’s own repository is refused: its work is on main already', async () => {
    const { id, session } = await landed();
    expect(await session.call('pr_opened', { url: OWN })).toContain("that pull request is in the card's own repository");
    expect(state(id)).toBe('live');
    expect(board.row(id).pr).toBeNull();
  });

  test('stopped while it asks about the pull request, the card is live with its landing', async () => {
    const { id, session } = await landed();
    await session.call('pr_opened', { url: DOCS });
    session.emit({ type: 'idle' });
    status.state = 'CLOSED';
    await watcher.poll();
    await workers.stop(id);
    expect(state(id)).toBe('live');
    expect(session.closed).toBe(true);
  });
});
