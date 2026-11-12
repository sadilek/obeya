// A fork's cards that go to the original repository as a pull request too (`RepoSettings.upstream`):
// where their branch starts, how the approval lands them on the fork's main branch, and how the
// watcher merges what is pushed onto the pull request into that branch until the maintainers merge it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { UpstreamRef } from '../core/types';
import type { Board } from './board';
import { detectUpstream } from './branches';
import { Store } from './db';
import type { Forge, PrStatus } from './forge';
import { git } from './git';
import { PrWatcher } from './pr-watcher';
import { fromJson } from './row';
import { artifact, commit, FakeRuntime, gitRepo, identify, noContributions, removeDir, stateOn, testBoard, until } from './testing';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

let dir: string;
/** The original repository. */
let orig: string;
/** The fork's checkout, on its main branch `mine`, with the original as its remote `upstream`. */
let main: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let watcher: PrWatcher;
let status: PrStatus;
let merges: string[];
/** The newest commit of the original that `mine` holds, and one it does not. */
let shared: string;
let newer: string;
const settings: RepoAdapter = { ...generic, land: 'main', workspaces: 'worktrees' };
const UP: UpstreamRef = { ref: 'upstream/main', remote: 'upstream', branch: 'main', name: 'acme/app', into: 'mine' };
const URL_ = 'https://github.com/acme/app/pull/7';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-upstream-'));
  orig = join(dir, 'orig');
  gitRepo(orig);
  shared = commit(orig, 'up.ts', 'up\n', 'Upstream work');
  main = join(dir, 'main');
  git(dir, 'clone', '--quiet', '--origin', 'upstream', orig, main);
  identify(main);
  git(main, 'switch', '--quiet', '-c', 'mine');
  git(main, 'branch', '-D', 'main');
  commit(main, 'own.ts', 'own\n', 'The fork’s own work');
  newer = commit(orig, 'later.ts', 'later\n', 'Upstream work the fork lacks');
  git(main, 'fetch', '--quiet', 'upstream');
  const store = new Store(':memory:');
  board = testBoard({ store, path: main });
  runtime = new FakeRuntime();
  UP.url = 'git@github.com:acme/app.git';
  workers = new Workers({ board, runtime, workspaces: new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') }), adapter: settings, upstream: () => UP });
  status = { state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: '', author: 'owner', checks: [], comments: [] };
  merges = [];
  const forge: Forge = {
    ...noContributions,
    open: async () => '',
    status: async () => status,
    body: async () => '',
    setBody: async () => {},
    merge: async (_cwd, _url, head) => void merges.push(head),
  };
  watcher = new PrWatcher(board, workers, forge, () => main, () => settings);
});
afterEach(async () => {
  workers.shutdown();
  await removeDir(dir);
});

const state = (id: string) => stateOn(board, id);
const pr = (id: string) => fromJson(board.row(id).pr)!;
const tip = () => git(main, 'rev-parse', 'mine');
const files = (rev: string) => git(main, 'ls-tree', '--name-only', rev).split('\n');

/** A card started (going to the original where `upstream`), with `file` committed on its branch and handed over. */
async function handedOver(upstream: boolean, file = 'fix.ts', text = 'fix\n') {
  const c = board.create({ title: 'Fix the banner', x: 0, y: 0 });
  if (upstream) board.patch(c.id, { upstream: true });
  await workers.start(c.id);
  const ws = board.row(c.id).workspace!;
  const head = commit(ws, file, text, `Add ${file}`);
  const session = runtime.last;
  await session.call('ready_for_review', { summary: 'S', demo: artifact() });
  session.emit({ type: 'idle' });
  return { id: c.id, ws, head, session };
}

/** Approved, its pull request reported, and its worker's turn over. */
async function opened(upstream = true) {
  const h = await handedOver(upstream);
  await workers.approve(h.id);
  await h.session.call('pr_opened', { url: URL_ });
  h.session.emit({ type: 'idle' });
  return h;
}

test('a fork is told by its remote upstream', async () => {
  expect(await detectUpstream(main)).toBe('upstream/main');
  expect(await detectUpstream(orig)).toBeUndefined();
});

test('a card for the original starts from the newest commit of it that the main branch holds, and its worker hears why', async () => {
  const c = board.create({ title: 'Fix the banner', x: 0, y: 0 });
  board.patch(c.id, { upstream: true });
  expect(board.item(c.id)!.upstream).toBe(true);
  await workers.start(c.id);
  const ws = board.row(c.id).workspace!;
  expect(git(ws, 'rev-parse', 'HEAD')).toBe(shared);
  expect(runtime.last.inbox[0]).toContain(`fresh from ${shared.slice(0, 7)}: the newest commit of upstream/main`);
  expect(runtime.last.inbox[0]).toContain('Do not merge mine into it');
  // a card for the fork alone starts from its main branch, as ever
  const own = board.create({ title: 'Kupa board', x: 0, y: 0 });
  await workers.start(own.id);
  expect(git(board.row(own.id).workspace!, 'rev-parse', 'HEAD')).toBe(tip());
});

test('the choice is the owner’s until the approval', async () => {
  const { id } = await handedOver(true);
  board.patch(id, { upstream: false });
  expect(board.item(id)!.upstream).toBeUndefined();
  await workers.approve(id);
  expect(() => board.patch(id, { upstream: true })).toThrow('only until the approval');
});

describe('approving a card for the original', () => {
  test('merges its branch into the main branch as it is and sends the worker to open the pull request there', async () => {
    const { id, ws, head, session } = await handedOver(true);
    const before = tip();
    await workers.approve(id);
    expect(state(id)).toBe('inPr');
    // a merge commit, the branch never rebased: it is the pull request's branch
    expect(git(main, 'rev-list', '--parents', '-1', 'mine').split(' ').slice(1)).toEqual([before, head]);
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(head);
    expect(files('mine')).toEqual(expect.arrayContaining(['fix.ts', 'own.ts', 'up.ts']));
    expect(files('mine')).not.toContain('later.ts');
    expect(pr(id).upstream).toMatchObject({ ref: 'upstream/main', into: 'mine', merged: head, start: shared });
    expect(pr(id).upstream!.ported).toBeUndefined();
    expect(session.inbox.at(-1)).toContain('Obeya merged your branch into mine as it is');
    expect(session.inbox.at(-1)).toContain('gh pr create --repo acme/app --base main');
    expect(session.inbox.at(-1)).toContain('never merge mine into it');
    // public on the original: it cannot be taken back from the card
    expect(board.item(id)!.revocable).toBeUndefined();
  });

  test('a card that started from the main branch lands as usual, and its worker ports it for the pull request', async () => {
    const { id, session } = await handedOver(false);
    await workers.approve(id, { upstream: true });
    expect(board.item(id)!.upstream).toBe(true);
    expect(state(id)).toBe('inPr');
    // rebased onto the main branch: no merge commit
    expect(git(main, 'rev-list', '--parents', '-1', 'mine').split(' ')).toHaveLength(2);
    expect(pr(id).upstream).toMatchObject({ ported: true, start: shared });
    expect(session.inbox.at(-1)).toContain(`make the pull request's branch anew from ${shared.slice(0, 7)}`);
  });

  test('“for me only” on a card for the original lands it on the main branch alone', async () => {
    const { id } = await handedOver(true);
    await workers.approve(id, { upstream: false });
    expect(state(id)).toBe('live');
    expect(board.row(id).upstream).toBeNull();
  });

  test('a branch that conflicts with the main branch goes back to its worker, with the way to merge it without touching the branch', async () => {
    commit(main, 'banner.css', 'mine\n', 'Fork banner');
    const { id, ws, session } = await handedOver(true, 'banner.css', 'upstream\n');
    await workers.approve(id);
    expect(state(id)).toBe('working');
    expect(session.inbox.at(-1)).toContain('conflicts in banner.css');
    const branch = board.row(id).branch!;
    expect(session.inbox.at(-1)).toContain(`git switch -c ${branch}-into-mine mine`);
    // the worker merges it on a branch of its own and hands over again: it lands without a new approval
    git(ws, 'switch', '--quiet', '-c', `${branch}-into-mine`, 'mine');
    git(ws, 'merge', '--quiet', '-X', 'ours', branch, '-m', 'Merge the fix into mine');
    git(ws, 'switch', '--quiet', branch);
    await session.call('ready_for_review', { summary: 'Merged by hand' });
    session.emit({ type: 'idle' });
    await until(() => state(id) === 'inPr');
    expect(git(main, 'rev-parse', 'mine')).toBe(git(ws, 'rev-parse', `${branch}-into-mine`));
  });
});

describe('the pull request to the original', () => {
  test('is the card’s own, waits for its maintainers and is never merged by Obeya', async () => {
    const { id, head } = await opened();
    expect(pr(id)).toMatchObject({ url: URL_, number: 7, repo: 'acme/app' });
    expect(pr(id).more).toBeUndefined();
    status.head = head;
    await watcher.poll();
    expect(merges).toEqual([]);
    expect(board.item(id)!.pr!.waits).toEqual(['maintainer']);
    expect(board.item(id)!.pr!.into).toEqual({ branch: 'mine' });
    // the owner has nothing to do meanwhile
    expect(state(id)).toBe('inPr');
  });

  test('what is pushed onto it merges into the main branch too; once merged there, the card is live', async () => {
    const { id, ws } = await opened();
    const fix = commit(ws, 'review.ts', 'r\n', 'Address review');
    status.head = fix;
    await watcher.poll();
    expect(git(main, 'rev-list', '--parents', '-1', 'mine').split(' ')[2]).toBe(fix);
    expect(files('mine')).toContain('review.ts');
    expect(pr(id).upstream!.merged).toBe(fix);
    expect(board.events(id).some((e) => e.text.includes('Neuer Stand des Pull Requests in mine gemergt'))).toBe(true);
    // the maintainers merge it, with a last fix pushed just before
    const last = commit(ws, 'last.ts', 'l\n', 'Last fix');
    status.head = last;
    status.state = 'MERGED';
    await watcher.poll();
    expect(files('mine')).toContain('last.ts');
    expect(state(id)).toBe('live');
    expect(fromJson(board.row(id).shipped)?.upstream).toBe(true);
  });

  test('a push that conflicts with the main branch goes to the worker once, and its own merge is taken', async () => {
    const { id, ws, session } = await opened();
    commit(main, 'clash.ts', 'mine\n', 'Fork change');
    const fix = commit(ws, 'clash.ts', 'theirs\n', 'Review fix');
    status.head = fix;
    await watcher.poll();
    expect(pr(id).upstream!.conflict).toBe(fix);
    expect(board.item(id)!.pr!.into).toEqual({ branch: 'mine', conflict: true });
    expect(session.inbox.at(-1)).toContain('conflicts in clash.ts');
    const told = session.inbox.length;
    session.emit({ type: 'idle' });
    await watcher.poll();
    expect(session.inbox.length).toBe(told);
    const branch = board.row(id).branch!;
    git(ws, 'switch', '--quiet', '-c', `${branch}-into-mine`, 'mine');
    git(ws, 'merge', '--quiet', '-X', 'ours', fix, '-m', 'Merge the review fix');
    git(ws, 'switch', '--quiet', branch);
    await watcher.poll();
    expect(git(main, 'rev-parse', 'mine')).toBe(git(ws, 'rev-parse', `${branch}-into-mine`));
    expect(pr(id).upstream!.merged).toBe(fix);
    expect(pr(id).upstream!.conflict).toBeUndefined();
  });

  test('a port opened as the pull request counts as on the main branch already; only what comes later merges', async () => {
    const { id, ws, session } = await handedOver(false);
    await workers.approve(id, { upstream: true });
    const landed = tip();
    // the worker carries the change over onto a branch from where the original and the fork meet
    git(ws, 'switch', '--quiet', '-c', 'port', shared);
    const port = commit(ws, 'fix.ts', 'fix, ported\n', 'Port the fix');
    await session.call('pr_opened', { url: URL_ });
    // recorded at once, while the worker's turn still goes on: what it pushes later is not taken for the port
    status.head = port;
    await watcher.poll();
    session.emit({ type: 'idle' });
    expect(git(main, 'rev-parse', 'mine^{tree}')).toBe(git(main, 'rev-parse', `${landed}^{tree}`));
    expect(git(main, 'rev-list', '--parents', '-1', 'mine').split(' ').slice(1)).toEqual([landed, port]);
    expect(board.events(id).some((e) => e.text.includes('trägt die Arbeit, die schon auf mine ist'))).toBe(true);
    const fix = commit(ws, 'review.ts', 'r\n', 'Review fix');
    status.head = fix;
    await watcher.poll();
    expect(files('mine')).toContain('review.ts');
    expect(git(main, 'show', 'mine:fix.ts')).toBe('fix');
  });

  test('a port that builds on commits of the original the main branch lacks is not taken as merged', async () => {
    const { id, ws, session } = await handedOver(false);
    await workers.approve(id, { upstream: true });
    const landed = tip();
    git(ws, 'fetch', '--quiet', orig, 'main');
    git(ws, 'switch', '--quiet', '-c', 'port', newer);
    status.head = commit(ws, 'fix.ts', 'fix, ported\n', 'Port the fix');
    await session.call('pr_opened', { url: URL_ });
    session.emit({ type: 'idle' });
    await watcher.poll();
    expect(tip()).toBe(landed);
    expect(session.inbox.at(-1)).toContain(`builds on commits of upstream/main that mine does not hold yet`);
  });

  test('closed by the maintainers, the owner may keep the work on the main branch alone', async () => {
    const { id, head } = await opened();
    status.head = head;
    status.state = 'CLOSED';
    await watcher.poll();
    expect(state(id)).toBe('waiting:question');
    const q = board.item(id)!.question!;
    expect(q.options).toEqual([board.t.worker.reopen, board.t.worker.keepOnMain('mine')]);
    workers.answer(id, '', [], false, undefined, [board.t.worker.keepOnMain('mine')]);
    expect(state(id)).toBe('live');
  });
});

test('a settings value that is no <remote>/<branch> does not count', async () => {
  const { checkShared } = await import('../adapters/schema');
  expect(checkShared({ upstream: 'upstream' }).problems).toEqual([expect.stringContaining('upstream')]);
  expect(checkShared({ upstream: 'upstream/main' }).problems).toEqual([]);
});
