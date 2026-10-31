// Review cards: a pull request someone outside opened, reviewed by the card's worker on its head,
// with the owner's change requests going to the contributor or made by the worker, and merged by
// Obeya on approval, pinned to the head the worker reviewed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import { Board, type StoredContribution } from './board';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import type { ContributionInfo, Forge, PrStatus } from './forge';
import { PrWatcher } from './pr-watcher';
import { artifact, FakeRuntime, gitRepo, until } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

const URL_ = 'https://github.com/acme/app/pull/5';

/** A forge with one open pull request by a contributor, which records what Obeya does on it. */
function fakeForge(head: () => string) {
  const said = { comments: [] as string[], reviews: [] as string[], merges: [] as string[], refuse: undefined as string | undefined };
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
      said.reviews.push(body);
      return `${URL_}#pullrequestreview-${said.reviews.length}`;
    },
    merge: async (_cwd, _url, h) => {
      if (said.refuse) throw new Error(`gh pr merge ${URL_}: ${said.refuse}`);
      said.merges.push(h);
      status.state = 'MERGED';
      return 'merged0';
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
  fake = fakeForge(() => prHead);
  approvals = [];
  const settings: RepoAdapter = { ...generic, land: 'main', workspaces: 'clones', checks: ['bun test'] };
  workers = new Workers({ board, runtime, workspaces, adapter: settings, forge: fake.forge, repoPath: main, remote: origin, onApproval: (id) => (approvals.push(id), null) });
  watcher = new PrWatcher(board, workers, fake.forge, () => main, () => settings);
});
afterEach(() => {
  workers.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

/** A review card for PR #5, as „Review PR #5“ makes it, started and on the PR's head. */
async function reviewCard(canModify = true) {
  const card = board.create({ title: 'PR #5: Watcher polls gh in the background', body: 'Look at security especially.', x: 0, y: 0 });
  const c: StoredContribution = { url: URL_, number: 5, author: 'amerlander', title: 'Watcher polls gh in the background', canModify, headRepo: 'https://github.com/amerlander/app.git', headRef: 'bg-poll' };
  board.work(card.id, { contribution: JSON.stringify(c) });
  await workers.start(card.id);
  await until(() => runtime.sessions.length > 0);
  return card.id;
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

describe('a review card', () => {
  test('starts on the PR head, its worker told to read the diff before running any of it', async () => {
    const id = await reviewCard();
    const ws = board.row(id).workspace!;
    expect(git(ws, 'rev-parse', 'HEAD').trim()).toBe(prHead);
    const brief = runtime.last.inbox[0]!;
    expect(brief).toContain('pull request #5 by amerlander');
    expect(brief).toContain('Look at security especially.');
    expect(brief.indexOf('Before you run anything of it')).toBeLessThan(brief.indexOf('Review the code'));
    expect(brief).toContain('git push https://github.com/amerlander/app.git HEAD:bg-poll');
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

  test('the owner decides per finding, with their words; one sent to the contributor waits for them', async () => {
    const id = await reviewCard();
    await handOver();
    workers.message(id, 'Keep it short.', [], false, undefined, undefined, { 1: 'contributor', 2: 'self' });
    const told = runtime.last.inbox.at(-1)!;
    expect(told).toContain('To amerlander: #1 „Path in the file name“');
    expect(told).toContain('Yourself: #2 „No shortcut“');
    expect(told).toContain('Keep it short.');
    expect(board.events(id).at(-1)!.text).toContain('Befund 1 „Path in the file name“: an amerlander');
    expect(board.item(id)!.contribution!.findings!.map((f) => f.decided)).toEqual(['contributor', 'self']);
    // decided already: not again
    expect(() => workers.message(id, '', [], false, undefined, undefined, { 3: 'self' })).toThrow();
    runtime.last.emit({ type: 'idle' });
    expect(await runtime.last.call('request_changes', { body: 'Please keep the file in its folder.', findings: [1] })).toContain('waits for amerlander');
    expect(fake.said.reviews).toEqual(['Please keep the file in its folder.']);
    expect(board.item(id)!.state).toBe('inPr');
    const sent = board.item(id)!.contribution!.findings![0]!;
    expect(sent).toMatchObject({ status: 'sent', url: `${URL_}#pullrequestreview-1` });
    expect(sent.decided).toBeUndefined();
    // the worker keeps the list: what it changed itself is fixed, the number kept
    runtime.last.call('findings', { findings: [{ id: 1, title: 'Path in the file name', text: 'T', security: true }, { id: 2, title: 'No shortcut', text: 'T', status: 'fixed' }, { title: 'New one', text: 'T' }] });
    expect(board.item(id)!.contribution!.findings!.map((f) => [f.id, f.status])).toEqual([
      [1, 'sent'],
      [2, 'fixed'],
      [3, 'open'],
    ]);
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
