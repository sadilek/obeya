// Review cards: a pull request someone outside opened, reviewed by the card's worker on its head,
// with the owner's change requests going to the contributor or made by the worker, and merged by
// Obeya on approval, pinned to the head the worker reviewed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import { Board, type StoredContribution } from './board';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import type { ContributionInfo, Forge, PrStatus } from './forge';
import { PrWatcher } from './pr-watcher';
import { artifact, FakeRuntime, gitRepo, identify, until } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

const URL_ = 'https://github.com/acme/app/pull/5';

/** A forge with one open pull request by a contributor, which records what Obeya does on it. */
function fakeForge(head: () => string) {
  const said = { comments: [] as string[], reviews: [] as string[], merges: [] as string[], refuse: undefined as string | undefined, refusePost: undefined as string | undefined };
  const status: PrStatus = { state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: '', author: 'amerlander', viewer: 'owner', checks: [{ name: 'test', state: 'success' }], comments: [] };
  const info: ContributionInfo = { title: 'Watcher polls gh in the background', author: 'amerlander', state: 'OPEN', head: '', canModify: true, headRepo: 'https://github.com/amerlander/app.git', headRef: 'bg-poll' };
  const forge: Forge = {
    status: async () => ({ ...status, head: status.head || head() }),
    body: async () => '',
    setBody: async () => {},
    open: async () => '',
    urlOf: async (_cwd, n) => `https://github.com/acme/app/pull/${n}`,
    contribution: async () => ({ ...info, head: head() }),
    comment: async (_cwd, _url, body) => {
      said.comments.push(body);
      return `${URL_}#issuecomment-${said.comments.length}`;
    },
    requestChanges: async (_cwd, _url, body) => {
      if (said.refusePost) throw new Error(said.refusePost);
      said.reviews.push(body);
      return `${URL_}#pullrequestreview-${said.reviews.length}`;
    },
    merge: async (_cwd, _url, h) => {
      if (said.refuse) throw new Error(`gh pr merge ${URL_}: ${said.refuse}`);
      said.merges.push(h);
      status.state = 'MERGED';
      // squashed onto the remote's main, as GitHub does
      git(origin, 'merge', '--quiet', '--squash', h);
      git(origin, 'commit', '--quiet', '-m', 'Watcher polls gh in the background (#5)');
      return git(origin, 'rev-parse', 'HEAD').trim();
    },
  };
  return { forge, said, status, info };
}

let dir: string;
let main: string;
let origin: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let watcher: PrWatcher;
let fake: ReturnType<typeof fakeForge>;
let approvals: string[];
/** The follow-up tasks made, each with its review card, as the Koordinator hears of them. */
let followed: [string, string][];
let prHead: string;

/** A commit on the contributor's side, published as the PR's head in `origin`. */
function push(file: string) {
  git(origin, 'checkout', '--quiet', '-B', 'contrib', prHead || 'main');
  writeFileSync(join(origin, file), `${file}\n`);
  git(origin, 'add', '.');
  git(origin, 'commit', '--quiet', '-m', file);
  prHead = git(origin, 'rev-parse', 'HEAD').trim();
  git(origin, 'update-ref', 'refs/pull/5/head', prHead);
  git(origin, 'checkout', '--quiet', 'main');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-review-'));
  origin = gitRepo(join(dir, 'acme', 'app'));
  main = join(dir, 'main');
  git(dir, 'clone', '--quiet', origin, main);
  prHead = '';
  push('poll.ts');
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  const workspaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: main, dir: join(dir, 'ws') });
  workspaces.ensureClones(main, 1);
  runtime = new FakeRuntime();
  // the PR's branch in the contributor's repository, where Obeya pushes the worker's own commits
  fake = fakeForge(() => git(origin, 'rev-parse', 'contrib'));
  approvals = [];
  followed = [];
  const settings: RepoAdapter = { ...generic, land: 'main', workspaces: 'clones', checks: ['bun test'] };
  workers = new Workers({ board, runtime, workspaces, adapter: settings, forge: fake.forge, repoPath: main, remote: origin, pulls: workspaces, pushHold: 10, pushSettle: 1, onApproval: (id) => (approvals.push(id), null), onFollowUpTask: (task, review) => followed.push([task, review]) });
  watcher = new PrWatcher(board, workers, fake.forge, () => main, () => settings);
});
afterEach(() => {
  workers.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

/** A review card for PR #5, as „Review PR #5“ makes it, started and on the PR's head. */
async function reviewCard(canModify = true) {
  const card = board.create({ title: 'PR #5: Watcher polls gh in the background', body: 'Look at security especially.', x: 0, y: 0 });
  const c: StoredContribution = { url: URL_, number: 5, author: 'amerlander', title: 'Watcher polls gh in the background', canModify, headRepo: origin, headRef: 'contrib' };
  board.work(card.id, { contribution: JSON.stringify(c) });
  await workers.start(card.id);
  await until(() => runtime.sessions.length > 0);
  return card.id;
}

/** The worker's own change on its branch: a commit of `file` on top of the PR's head; returns the branch's head. */
function commitOwn(id: string, file: string) {
  const ws = board.row(id).workspace!;
  identify(ws);
  writeFileSync(join(ws, file), `${file}\n`);
  git(ws, 'add', '.');
  git(ws, 'commit', '--quiet', '-m', file);
  return git(ws, 'rev-parse', 'HEAD').trim();
}

/** The worker records its findings and hands over, and its turn ends. */
async function handOver(demo = true) {
  runtime.last.call('findings', { findings: FINDINGS });
  const r = await runtime.last.call('ready_for_review', { summary: 'S', ...(demo ? { demo: artifact() } : {}), review: results });
  runtime.last.emit({ type: 'idle' });
  return r;
}

const results = { checks: [{ name: 'bun test', passed: true }], mergeable: true };
const FINDINGS = [
  { title: 'Path in the file name', text: 'The title goes into the file name unchecked.', security: true },
  { title: 'No shortcut', text: 'The menu entry has no keyboard shortcut.' },
];
const contribution = (id: string) => JSON.parse(board.row(id).contribution!) as StoredContribution;

/**
 * A card whose work landed on the local main and was never pushed: a commit of `file` there, the
 * card done and its agent's session over.
 */
function landedLocally(file: string, subject: string) {
  identify(main);
  const base = git(main, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(main, file), `${subject}\n`);
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', subject);
  const card = board.create({ title: 'Poll more often', x: 400, y: 0 });
  board.work(card.id, { state: 'live', branch: 'obeya/poll-more-often', session_id: 'session-x', shipped: JSON.stringify({ commit: git(main, 'rev-parse', 'HEAD').trim(), base }) });
  return card.id;
}

/** Once the probes of the card's PR against the local main started so far are through. */
const probed = (id: string) => (workers as unknown as { probeClash(id: string): Promise<unknown> }).probeClash(id);

describe('a review card', () => {
  test('starts on the PR head, its worker told to read the diff before running any of it', async () => {
    const id = await reviewCard();
    const ws = board.row(id).workspace!;
    expect(git(ws, 'rev-parse', 'HEAD').trim()).toBe(prHead);
    const brief = runtime.last.inbox[0]!;
    expect(brief).toContain('pull request #5 by amerlander');
    expect(brief).toContain('Look at security especially.');
    expect(brief.indexOf('Before you run anything of it')).toBeLessThan(brief.indexOf('Review the code'));
    // the worker pushes nothing itself: Obeya does, on the owner's approval
    expect(brief).not.toContain('git push');
    expect(runtime.last.spec.system).toContain('Do not push (Obeya pushes your commits');
    // watched from the start
    expect(board.item(id)!.pr).toMatchObject({ url: URL_, number: 5 });
    expect(board.item(id)!.contribution).toMatchObject({ number: 5, author: 'amerlander', canModify: true });
  });

  test('its session reads none of the PR’s Claude Code settings, and the default branch’s CLAUDE.md', async () => {
    git(main, 'checkout', '-q', 'main');
    writeFileSync(join(main, 'CLAUDE.md'), 'Reviews bring in a second reviewer.\n');
    git(main, 'add', '.');
    git(main, 'commit', '--quiet', '-m', 'notes');
    await reviewCard();
    expect(runtime.last.spec.untrusted).toBe(true);
    expect(runtime.last.spec.system).toContain('Reviews bring in a second reviewer.');
  });

  test('a branch name a shell would run is not handed to the worker as a command', async () => {
    const card = board.create({ title: 'PR #5', x: 0, y: 0 });
    const c: StoredContribution = { url: URL_, number: 5, author: 'amerlander', title: 'T', canModify: true, headRepo: 'https://github.com/amerlander/app.git', headRef: 'topic$(id)' };
    board.work(card.id, { contribution: JSON.stringify(c) });
    await workers.start(card.id);
    await until(() => runtime.sessions.length > 0);
    expect(runtime.last.inbox[0]).not.toContain('$(id)');
  });

  test('hands over with what the review found, and the head it reviewed', async () => {
    const id = await reviewCard();
    expect(await runtime.last.call('ready_for_review', { summary: 'Two findings.', demo: artifact() })).toContain('review');
    expect(await runtime.last.call('ready_for_review', { summary: 'Two findings.', demo: artifact(), review: results })).toContain('findings first');
    expect(runtime.last.call('findings', { findings: FINDINGS })).toContain('2 findings');
    await runtime.last.call('ready_for_review', { summary: 'Two findings.', demo: artifact(), review: results });
    expect(board.item(id)!.state).toBe('waiting');
    expect(board.item(id)!.contribution!.results).toEqual(results);
    expect(board.item(id)!.contribution!.findings!.map((f) => [f.id, f.status, !!f.security])).toEqual([
      [1, 'open', true],
      [2, 'open', false],
    ]);
    expect(contribution(id).reviewed).toBe(prHead);
    // a review card is merged, never closed as needing no change
    expect(board.item(id)!.noChange).toBeUndefined();
  });

  test('the owner decides per finding, with their words; a request alone goes to the contributor at once', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, 'Keep it short.', [], false, undefined, undefined, { 1: 'contributor' });
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('To amerlander: #1 „Path in the file name“');
    expect(told).toContain('request_changes');
    expect(told).toContain('Keep it short.');
    expect(board.events(id).at(-1)!.text).toContain('Befund 1 „Path in the file name“: an amerlander');
    expect(board.item(id)!.contribution!.findings!.map((f) => [f.decided, f.withChanges])).toEqual([
      ['contributor', undefined],
      [undefined, undefined],
    ]);
    // decided already: not again
    expect(() => workers.message(id, '', [], false, undefined, undefined, { 3: 'self' })).toThrow();
    runtime.last.emit({ type: 'idle' });
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('waits for amerlander');
    expect(fake.said.reviews).toEqual(['Please keep the file in its folder.']);
    expect(board.item(id)!.state).toBe('inPr');
    const sent = board.item(id)!.contribution!.findings![0]!;
    expect(sent).toMatchObject({ status: 'sent', url: `${URL_}#pullrequestreview-1` });
    expect(sent.decided).toBeUndefined();
    // the worker keeps the list, the numbers kept
    runtime.last.call('findings', { findings: [{ id: 1, title: 'Path in the file name', text: 'T', security: true }, { id: 2, title: 'No shortcut', text: 'T', status: 'dropped' }, { title: 'New one', text: 'T' }] });
    expect(board.item(id)!.contribution!.findings!.map((f) => [f.id, f.status])).toEqual([
      [1, 'sent'],
      [2, 'dropped'],
      [3, 'open'],
    ]);
  });

  test('its own change stays on the card: approving pushes it, comments what it changed and merges that head', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 2: 'self' });
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('Yourself: #2 „No shortcut“');
    expect(told).toContain('commit it on your branch');
    expect(told).not.toContain('push it onto');
    runtime.last.emit({ type: 'idle' });
    const head = commitOwn(id, 'shortcut.ts');
    runtime.last.call('findings', { findings: [{ id: 1, title: 'Path in the file name', text: 'T', security: true }, { id: 2, title: 'No shortcut', text: 'T', status: 'fixed' }] });
    // the text that goes with it is the owner's to see first
    expect(await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results })).toContain('Give pr_draft');
    await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results, pr_draft: 'Thanks! I added the shortcut on top of your branch.' });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(id)!.contribution!.held).toEqual({ body: 'Thanks! I added the shortcut on top of your branch.', commits: 1, asks: [] });
    // nothing went out yet
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(prHead);
    expect(fake.said.comments).toEqual([]);
    await workers.approve(id);
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(head);
    expect(fake.said.comments).toEqual(['Thanks! I added the shortcut on top of your branch.']);
    expect(fake.said.merges).toEqual([head]);
    expect(approvals).toEqual([id]);
    expect(board.item(id)!.state).toBe('live');
    expect(board.item(id)!.contribution!.held).toBeUndefined();
    expect(board.item(id)!.contribution!.findings![1]).toMatchObject({ status: 'fixed', url: `${URL_}#issuecomment-1` });
    expect(board.events(id).some((e) => e.text.startsWith(board.t.worker.pushedHeld(5, 1)))).toBe(true);
  });

  test('„Nur pushen“ pushes and comments, and the card waits for „Mergen“ again', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 2: 'self' });
    runtime.last.emit({ type: 'idle' });
    const head = commitOwn(id, 'shortcut.ts');
    await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results, pr_draft: 'I added the shortcut.' });
    runtime.last.emit({ type: 'idle' });
    await workers.pushContribution(id);
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(head);
    expect(fake.said.comments).toEqual(['I added the shortcut.']);
    expect(fake.said.merges).toEqual([]);
    expect(approvals).toEqual([]);
    expect(board.item(id)).toMatchObject({ state: 'waiting', need: 'demo' });
    expect(board.item(id)!.contribution!.held).toBeUndefined();
    // nothing held any more: only „Mergen“ is left
    await expect(workers.pushContribution(id)).rejects.toMatchObject({ code: 'notReady' });
    await workers.approve(id);
    expect(fake.said.merges).toEqual([head]);
    expect(fake.said.comments).toEqual(['I added the shortcut.']);
  });

  test('with requests to the contributor beside its own change, approving pushes and sends both as one review, and the card waits for them', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 1: 'contributor', 2: 'self' });
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('To amerlander: #1 „Path in the file name“. They go with your own changes below');
    expect(board.item(id)!.contribution!.findings![0]).toMatchObject({ decided: 'contributor', withChanges: true });
    runtime.last.emit({ type: 'idle' });
    // the request does not go out on its own
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('Not sent: your own changes');
    expect(fake.said.reviews).toEqual([]);
    const head = commitOwn(id, 'shortcut.ts');
    runtime.last.call('findings', { findings: [{ id: 1, title: 'Path in the file name', text: 'T', security: true }, { id: 2, title: 'No shortcut', text: 'T', status: 'fixed' }] });
    await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results, pr_draft: 'I pushed a shortcut. Please keep the file in its folder (#1).' });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(id)!.contribution!.held).toEqual({ body: 'I pushed a shortcut. Please keep the file in its folder (#1).', commits: 1, asks: [1] });
    expect(board.item(id)!.contribution!.findings![0]).toMatchObject({ status: 'open', decided: 'contributor', withChanges: true });
    await workers.approve(id);
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(head);
    expect(fake.said.reviews).toEqual(['I pushed a shortcut. Please keep the file in its folder (#1).']);
    expect(fake.said.comments).toEqual([]);
    expect(fake.said.merges).toEqual([]);
    expect(approvals).toEqual([]);
    expect(board.item(id)!.state).toBe('inPr');
    const [asked, fixed] = board.item(id)!.contribution!.findings!;
    expect(asked).toMatchObject({ status: 'sent', url: `${URL_}#pullrequestreview-1` });
    expect(asked!.decided).toBeUndefined();
    expect(asked!.withChanges).toBeUndefined();
    expect(fixed).toMatchObject({ status: 'fixed', url: `${URL_}#pullrequestreview-1` });
    // its own push is no push of the contributor's
    await watcher.poll();
    expect(board.item(id)!.state).toBe('inPr');
  });

  test('a request decided while its own change waits for the owner goes into the same text', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 2: 'self' });
    runtime.last.emit({ type: 'idle' });
    commitOwn(id, 'shortcut.ts');
    await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results, pr_draft: 'I added the shortcut.' });
    runtime.last.emit({ type: 'idle' });
    workers.message(id, '', [], false, undefined, undefined, { 1: 'contributor' });
    expect(runtime.last.inbox.at(-1)).toContain('Your own changes wait for the owner’s approval, and these go with them');
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('Not sent');
    // handed over again without a new demo, the text rewritten
    await runtime.last.call('ready_for_review', { summary: 'Both in one.', review: results, pr_draft: 'I added the shortcut. Please keep the file in its folder.' });
    expect(board.item(id)!.contribution!.held).toEqual({ body: 'I added the shortcut. Please keep the file in its folder.', commits: 1, asks: [1] });
  });

  test('with no commit of its own after all, a request that waited for one goes out alone', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 1: 'contributor', 2: 'self' });
    runtime.last.emit({ type: 'idle' });
    runtime.last.call('findings', { findings: [{ id: 1, title: 'Path in the file name', text: 'T', security: true }, { id: 2, title: 'No shortcut', text: 'T', status: 'dropped' }] });
    expect(await runtime.last.call('ready_for_review', { summary: 'S', review: results })).toContain('Send it now with request_changes');
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('waits for amerlander');
    expect(fake.said.reviews).toEqual(['Please keep the file in its folder.']);
  });

  test('the worker bundles findings that would be one follow-up task, in both directions and across a chain', async () => {
    const id = await reviewCard();
    runtime.last.call('findings', {
      findings: [
        { title: 'A', text: 'T', with: [3] },
        { title: 'B', text: 'T' },
        { title: 'C', text: 'T', with: [4] },
        { title: 'D', text: 'T' },
        { title: 'E', text: 'T', with: [9] },
      ],
    });
    expect(board.item(id)!.contribution!.findings!.map((f) => [f.id, f.with])).toEqual([
      [1, [3, 4]],
      [2, undefined],
      [3, [1, 4]],
      [4, [1, 3]],
      [5, undefined],
    ]);
  });

  test('a finding chosen as a follow-up task waits for the worker, which makes the task as it bundled it, the owner’s words first', async () => {
    const id = await reviewCard(false);
    runtime.last.call('findings', {
      findings: [
        { title: 'Re-login does not help remotely', text: 'T' },
        { title: 'Detection misses messages', text: 'T', with: [4] },
        { title: 'Terminal opens on the Mac', text: 'T' },
        { title: 'Two buttons for one error', text: 'T' },
      ],
    });
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact(), review: results });
    runtime.last.emit({ type: 'idle' });
    workers.message(id, 'Combine them as you see fit.', [], false, undefined, undefined, { 1: 'later', 2: 'later', 4: 'later' });
    // nothing made yet: each waits for the worker, which hears the bundle among those chosen and the owner's words
    expect(board.items().filter((i) => i.from === id)).toEqual([]);
    expect(board.item(id)!.contribution!.findings!.map((f) => [f.id, f.status, f.decided])).toEqual([
      [1, 'open', 'later'],
      [2, 'open', 'later'],
      [3, 'open', undefined],
      [4, 'open', 'later'],
    ]);
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('As follow-up tasks: #1 „Re-login does not help remotely“, #2 „Detection misses messages“, #4 „Two buttons for one error“');
    expect(told).toContain('as you bundled them (findings 2 + 4)');
    expect(told).toContain('Combine them as you see fit.');
    expect(board.events(id).at(-1)!.text).toContain('Befund 2 „Detection misses messages“: als Folgeaufgabe');
    // not chosen again
    expect(() => workers.message(id, '', [], false, undefined, undefined, { 2: 'later' })).toThrow();
    // neither a reply nor a handover while one has no task
    expect(runtime.last.call('reply', { text: 'Done.' })).toContain('first make the follow-up tasks the owner chose, for findings #1');
    expect(await runtime.last.call('ready_for_review', { summary: 'S', review: results })).toContain('Not handed over: first make the follow-up tasks');
    expect(runtime.last.call('follow_up_task', { findings: [9], title: 'X', task: 'Y' })).toContain('there is no finding 9');
    expect(runtime.last.call('follow_up_task', { findings: [2, 4], title: 'Re-login button: when and where', task: 'The button shows on the wrong messages, and twice on a failed start. See src/ui/login.tsx.' })).toContain(
      'Still to make: finding #1',
    );
    const findings = () => board.item(id)!.contribution!.findings!;
    const task = board.item(findings()[1]!.card!)!;
    expect(task).toMatchObject({ title: 'Re-login button: when and where', state: 'planned', from: id });
    expect(task.body).toBe(`The button shows on the wrong messages, and twice on a failed start. See src/ui/login.tsx.\n\nAus dem Review von PR #5: ${URL_}`);
    expect(board.events(task.id).at(-1)!.text).toBe('Als Folgeaufgabe aus dem Review von PR #5 angelegt.');
    // it goes to the Koordinator at once, to wait in the queue for the PR's merge
    expect(followed).toEqual([[task.id, id]]);
    // a finding settled already makes none
    expect(runtime.last.call('follow_up_task', { findings: [1, 2], title: 'X', task: 'Y' })).toContain('finding 2 is later (a follow-up task already)');
    runtime.last.call('follow_up_task', { findings: [1], title: 'Re-login on remote machines', task: `Re-login runs on the wrong machine: ${URL_}` });
    expect(board.item(findings()[0]!.card!)!.body).toBe(`Re-login runs on the wrong machine: ${URL_}`);
    expect(findings().map((f) => [f.id, f.status, f.decided, f.card === task.id])).toEqual([
      [1, 'later', undefined, false],
      [2, 'later', undefined, true],
      [3, 'open', undefined, false],
      [4, 'later', undefined, true],
    ]);
    expect(runtime.last.call('reply', { text: 'Made two tasks.' })).toBe('Shown to the owner.');
    // it stays one when the worker rewrites its list, which cannot make one later itself
    runtime.last.call('findings', { findings: [{ id: 1, title: 'A', text: 'T', status: 'open' }, { id: 2, title: 'B', text: 'T' }, { id: 3, title: 'C', text: 'T', status: 'later' }, { id: 4, title: 'D', text: 'T' }] });
    expect(findings().map((f) => [f.id, f.status])).toEqual([
      [1, 'later'],
      [2, 'later'],
      [3, 'open'],
      [4, 'later'],
    ]);
  });

  test('request_changes waits for the follow-up tasks the owner chose with it', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 1: 'contributor', 2: 'later' });
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('Not sent: first make the follow-up tasks');
    expect(fake.said.reviews).toEqual([]);
    runtime.last.call('follow_up_task', { findings: [2], title: 'Shortcut for the menu entry', task: 'Add one.' });
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('waits for amerlander');
  });

  test('„Selbst ändern“ only where the contributor allows maintainers’ edits', async () => {
    const id = await reviewCard(false);
    await handOver();
    expect(() => workers.message(id, '', [], false, undefined, undefined, { 1: 'self' })).toThrow();
    expect(runtime.last.inbox[0]).toContain('does not allow maintainers');
  });

  test('while it waits, the contributor’s answers and pushes reach the worker; the owner’s own comments do not', async () => {
    const id = await reviewCard();
    await handOver();
    await runtime.last.call('request_changes', { body: 'Please rename it.' });
    const later = new Date(Date.now() + 60_000).toISOString();
    fake.status.comments = [
      { id: 'c1', author: 'owner', body: 'Ping', at: later },
      { id: 'c2', author: 'amerlander', body: 'Done, renamed it.', at: later },
    ];
    await watcher.poll();
    expect(board.item(id)!.state).toBe('working');
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('Done, renamed it.');
    expect(told).not.toContain('Ping');
    // the worker reviews again, hands over, sends another request, and the contributor pushes
    await handOver(false);
    await runtime.last.call('request_changes', { body: 'One more thing.' });
    push('stop.ts');
    await watcher.poll();
    expect(runtime.last.inbox.at(-1)).toContain('pushed to the pull request');
    const n = runtime.last.inbox.length;
    await watcher.poll();
    expect(runtime.last.inbox.length).toBe(n);
  });

  test('approval publishes the demo and merges the reviewed head; the card is live', async () => {
    const id = await reviewCard();
    await handOver();
    await workers.approve(id);
    expect(approvals).toEqual([id]);
    expect(fake.said.merges).toEqual([prHead]);
    expect(board.item(id)!.state).toBe('live');
    expect(runtime.last.inbox.at(-1)).toContain('Obeya merged the pull request');
  });

  test('where the PR collides with unpushed commits on the local main, the card says so before the merge, naming the card that landed them', async () => {
    const x = landedLocally('poll.ts', 'Polls every minute');
    const id = await reviewCard();
    await handOver();
    await until(() => !!board.item(id)!.contribution!.clash);
    expect(board.item(id)!.contribution!.clash).toMatchObject({ subject: 'Polls every minute', files: ['poll.ts'], unpushed: 1, card: { id: x, title: 'Poll more often' } });
    // shown already: the owner merges anyway
    await workers.approve(id);
    expect(fake.said.merges).toEqual([prHead]);
  });

  test('a collision the card does not show yet holds the merge back once, and shows it', async () => {
    const id = await reviewCard();
    await handOver();
    await probed(id);
    expect(board.item(id)!.contribution!.clash).toBeUndefined();
    landedLocally('poll.ts', 'Polls every minute');
    await expect(workers.approve(id)).rejects.toMatchObject({ code: 'pullClash' });
    expect(fake.said.merges).toEqual([]);
    expect(approvals).toEqual([]);
    expect(board.item(id)!.state).toBe('waiting');
    expect(board.item(id)!.contribution!.clash).toMatchObject({ subject: 'Polls every minute' });
    await workers.approve(id);
    expect(fake.said.merges).toEqual([prHead]);
  });

  test('a pull that stops on the conflict goes to the agent of the card whose commit conflicts, which rebases main and lands it', async () => {
    const x = landedLocally('poll.ts', 'Polls every minute');
    const id = await reviewCard();
    const review = runtime.last;
    await handOver();
    await until(() => !!board.item(id)!.contribution!.clash);
    const before = git(main, 'rev-parse', 'HEAD').trim();
    await workers.approve(id);
    await until(() => runtime.sessions.length === 2);
    const resolver = runtime.last;
    expect(resolver).not.toBe(review);
    const told = resolver.inbox[0]!;
    expect(told).toContain('pull request #5');
    expect(told).toContain('“Polls every minute”');
    expect(told).toContain('rewrites no published history');
    // the local main is as it was
    expect(git(main, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(board.events(id).some((e) => e.text === board.t.worker.pullStopped('Polls every minute', 'Poll more often'))).toBe(true);
    expect(board.item(x)!.statusLine).toBe(board.t.worker.resolvingStatus(5));
    // the worker rebases the unpushed commit onto origin's main with the merge, the conflict resolved
    const ws = board.row(x).workspace!;
    const upstream = git(origin, 'rev-parse', 'main').trim();
    git(ws, 'fetch', '--quiet', main, before, upstream);
    git(ws, 'checkout', '--quiet', '-B', 'resolve', before);
    expect(() => git(ws, 'rebase', '--quiet', upstream)).toThrow();
    writeFileSync(join(ws, 'poll.ts'), 'both\n');
    git(ws, 'add', 'poll.ts');
    git(ws, '-c', 'core.editor=true', 'rebase', '--continue');
    expect(await resolver.call('ready_for_review', { summary: 'Kept both.' })).toContain('Landed');
    expect(git(main, 'rev-parse', 'HEAD~1').trim()).toBe(upstream);
    expect(git(main, 'log', '-1', '--format=%s').trim()).toBe('Polls every minute');
    expect(board.events(id).some((e) => e.text.startsWith(board.t.worker.pulledMain('').slice(0, 10)))).toBe(true);
    expect(board.item(x)!.statusLine).toBeUndefined();
    // its session ends with its turn
    resolver.emit({ type: 'idle' });
    await until(() => !board.row(x).workspace && !existsSync(ws));
  });

  test('„main pushen“ puts the unpushed commits on the remote after its undo window, and the agent brings the PR up to date', async () => {
    landedLocally('poll.ts', 'Polls every minute');
    const id = await reviewCard();
    const review = runtime.last;
    await handOver();
    await until(() => !!board.item(id)!.contribution!.clash);
    git(origin, 'config', 'receive.denyCurrentBranch', 'updateInstead');
    workers.pushMainFor(id);
    // taken back within the window: nothing happens
    workers.keepMainFor(id);
    await new Promise((r) => setTimeout(r, 30));
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).not.toBe('Polls every minute');
    workers.pushMainFor(id);
    await until(() => board.item(id)!.state === 'working');
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('Polls every minute');
    expect(board.item(id)!.contribution!.clash).toBeUndefined();
    const told = review.inbox.at(-1)!;
    expect(told).toContain('push the local main to origin');
    expect(told).toContain('amerlander allows maintainers');
    expect(told).toContain('poll.ts');
  });

  test('an agent that ends its turn twice without resolving the pull leaves it to the owner', async () => {
    const x = landedLocally('poll.ts', 'Polls every minute');
    const id = await reviewCard();
    await handOver();
    await until(() => !!board.item(id)!.contribution!.clash);
    await workers.approve(id);
    await until(() => runtime.sessions.length === 2);
    const resolver = runtime.last;
    const ws = board.row(x).workspace!;
    resolver.call('report', { status: 'Looking' });
    resolver.emit({ type: 'idle' });
    expect(resolver.inbox.at(-1)).toContain('still stopped');
    resolver.emit({ type: 'idle' });
    expect(board.events(id).at(-1)!.text).toBe(board.t.worker.pullUnresolved('Polls every minute', 'poll.ts', board.t.worker.resolverGaveUp));
    await until(() => !board.row(x).workspace && !existsSync(ws));
  });

  test('a head pushed after the handover is not merged: the worker reviews it', async () => {
    const id = await reviewCard();
    await handOver();
    push('later.ts');
    await expect(workers.approve(id)).rejects.toMatchObject({ code: 'prMoved' });
    expect(fake.said.merges).toEqual([]);
    expect(approvals).toEqual([]);
    expect(board.item(id)!.state).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('did not merge it');
  });

  test('a push of the contributor’s after the handover: Obeya pushes, posts and merges nothing, and the worker puts its commits on top', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 2: 'self' });
    runtime.last.emit({ type: 'idle' });
    commitOwn(id, 'shortcut.ts');
    await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results, pr_draft: 'I added the shortcut.' });
    runtime.last.emit({ type: 'idle' });
    push('later.ts');
    await expect(workers.approve(id)).rejects.toMatchObject({ code: 'prMoved' });
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(prHead);
    expect([...fake.said.comments, ...fake.said.reviews, ...fake.said.merges]).toEqual([]);
    expect(board.item(id)!.state).toBe('working');
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('Obeya pushed, posted and merged nothing');
    expect(told).toContain('Put your own commits on top of the new head');
    // not fetched yet: its branch does not build on the PR's head, so it cannot hand over
    expect(await runtime.last.call('ready_for_review', { summary: 'S', review: results })).toContain('does not build on it');
    // put on top, it hands over again, and approving pushes onto the new head
    const ws = board.row(id).workspace!;
    git(ws, 'fetch', '--quiet', origin, 'refs/pull/5/head');
    git(ws, 'rebase', '--quiet', 'FETCH_HEAD');
    const head = git(ws, 'rev-parse', 'HEAD').trim();
    await runtime.last.call('ready_for_review', { summary: 'S', review: results });
    expect(board.item(id)!.contribution!.held).toMatchObject({ body: 'I added the shortcut.', commits: 1 });
    await workers.approve(id);
    expect(fake.said.merges).toEqual([head]);
  });

  test('a push the contributor’s repository rejects is a push of theirs: nothing is posted or merged', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 2: 'self' });
    runtime.last.emit({ type: 'idle' });
    commitOwn(id, 'shortcut.ts');
    await runtime.last.call('ready_for_review', { summary: 'Fixed 2.', demo: artifact(), review: results, pr_draft: 'I added the shortcut.' });
    runtime.last.emit({ type: 'idle' });
    // the forge has not seen the contributor's push yet when Obeya reads the PR
    const before = prHead;
    push('later.ts');
    fake.status.head = before;
    await expect(workers.approve(id)).rejects.toMatchObject({ code: 'prMoved' });
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(prHead);
    expect([...fake.said.comments, ...fake.said.reviews, ...fake.said.merges]).toEqual([]);
    expect(board.item(id)!.state).toBe('working');
  });

  test('a text the forge refuses after the push stops there: nothing merged, the requests open again', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, '', [], false, undefined, undefined, { 1: 'contributor', 2: 'self' });
    runtime.last.emit({ type: 'idle' });
    const head = commitOwn(id, 'shortcut.ts');
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact(), review: results, pr_draft: 'I added a shortcut. Please keep the file in its folder.' });
    runtime.last.emit({ type: 'idle' });
    fake.said.refusePost = 'HTTP 502';
    await expect(workers.approve(id)).rejects.toMatchObject({ code: 'mergeRefused' });
    expect(git(origin, 'rev-parse', 'contrib').trim()).toBe(head);
    expect(fake.said.merges).toEqual([]);
    expect(board.item(id)).toMatchObject({ state: 'waiting', need: 'demo' });
    expect(board.item(id)!.contribution!.held).toBeUndefined();
    expect(board.item(id)!.contribution!.findings![0]).toMatchObject({ status: 'open' });
    expect(board.item(id)!.contribution!.findings![0]!.decided).toBeUndefined();
    expect(board.events(id).at(-1)!.text).toContain('HTTP 502');
  });

  test('a merge the forge refuses leaves the card with the owner, saying why', async () => {
    const id = await reviewCard();
    await handOver();
    fake.said.refuse = 'base branch policy prohibits the merge';
    await expect(workers.approve(id)).rejects.toMatchObject({ code: 'mergeRefused' });
    expect(board.item(id)!.state).toBe('waiting');
    expect(board.events(id).at(-1)!.text).toContain('base branch policy prohibits the merge');
  });

  test('a PR closed without a merge asks the owner whether the card can go', async () => {
    const id = await reviewCard();
    await handOver();
    fake.status.state = 'CLOSED';
    await watcher.poll();
    expect(board.item(id)!.need).toBe('question');
    expect(board.item(id)!.question!.options).toEqual([board.t.worker.closeCard, board.t.worker.keepCard]);
    await watcher.poll();
    expect(board.events(id).filter((e) => e.text === board.t.worker.prClosed)).toHaveLength(1);
    workers.answer(id, board.t.worker.closeCard);
    expect(await runtime.last.call('close_unchanged', {})).toContain('done');
    expect(board.item(id)!.state).toBe('done');
  });

  test('closed while a tool call of the worker waits for permission, the call is refused and the owner asked about the card', async () => {
    const id = await reviewCard();
    const answer = runtime.last.permission('Bash', { command: 'gh pr checkout 5' });
    await new Promise((r) => setTimeout(r, 0));
    expect(board.item(id)!.need).toBe('question');
    fake.status.state = 'CLOSED';
    await watcher.poll();
    const refused = await answer;
    expect(refused.allow).toBe(false);
    expect('message' in refused && refused.message).toContain('closed without a merge');
    expect(board.item(id)!.question!.options).toEqual([board.t.worker.closeCard, board.t.worker.keepCard]);
  });
});

describe('„Review PR #5“ on a canvas', () => {
  let canvas: CanvasRuntime;
  beforeEach(() => {
    const store = new Store(':memory:');
    const home = join(dir, 'home');
    mkdirSync(home);
    canvas = new CanvasRuntime({ name: 'Produkt', repos: [{ path: main, clones: 1, settings: { land: 'main' } }] }, { store, home, runtime, forge: fake.forge });
  });
  afterEach(() => canvas.shutdown());

  test('makes a review card with the owner’s words and starts it; asked again, the card it has gets the words', async () => {
    const id = (await canvas.reviewPr({ do: 'reviewPr', pr: '5', text: 'Look at security especially.' }))!;
    const card = canvas.board.item(id)!;
    expect(card.title).toBe('PR #5: Watcher polls gh in the background');
    expect(card.body).toBe('Look at security especially.');
    expect(card.contribution).toMatchObject({ url: URL_, author: 'amerlander', canModify: true });
    // started: with no other card at work, at once
    await until(() => canvas.board.row(id).state === 'working');
    expect(await canvas.reviewPr({ do: 'reviewPr', pr: URL_, text: 'And the demo on the phone only.' })).toBe(id);
    expect(canvas.board.events(id).some((e) => e.text === 'And the demo on the phone only.')).toBe(true);
  });

  test('a PR one of Obeya’s workers opened opens that card', async () => {
    const own = canvas.board.create({ title: 'Export', x: 0, y: 0 });
    canvas.board.work(own.id, { state: 'inPr', pr: JSON.stringify({ url: URL_, number: 5, seen: [], reported: [] }) });
    expect(await canvas.reviewPr({ do: 'reviewPr', pr: '5', text: '' })).toBe(own.id);
    expect(canvas.board.snapshot().items.some((i) => i.contribution)).toBe(false);
  });

  test('a PR recorded in another form (a slash at the end, the host in capitals) opens its card too', async () => {
    const own = canvas.board.create({ title: 'Export', x: 0, y: 0 });
    canvas.board.work(own.id, { state: 'inPr', pr: JSON.stringify({ url: 'https://GitHub.com/acme/app/pull/5/', number: 5, seen: [], reported: [] }) });
    expect(await canvas.reviewPr({ do: 'reviewPr', pr: URL_, text: '' })).toBe(own.id);
    expect(canvas.board.snapshot().items.some((i) => i.contribution)).toBe(false);
  });

  test('a closed PR gets no card', async () => {
    fake.info.state = 'CLOSED';
    expect(await canvas.reviewPr({ do: 'reviewPr', pr: '5', text: '' })).toBeUndefined();
    expect(canvas.board.snapshot().items.some((i) => i.contribution)).toBe(false);
  });
});
