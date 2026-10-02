import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { needsYou } from '../core/types';
import { Board } from './board';
import { Store } from './db';
import type { Forge, PrStatus } from './forge';
import { PrWatcher } from './pr-watcher';
import { FakeRuntime, gitRepo } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let status: PrStatus;
let watcher: PrWatcher;
/** Cards whose PR the worker reported, as the canvas passes them to sharing. */
let opened: string[];
const URL_ = 'https://github.com/acme/app/pull/42';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-pr-'));
  const main = join(dir, 'main');
  gitRepo(main);
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => []);
  const workspaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: main, dir: join(dir, 'ws') });
  workspaces.ensureClones(main, 1);
  runtime = new FakeRuntime();
  opened = [];
  workers = new Workers({ board, runtime, workspaces, adapter: { ...generic, land: 'pr', workspaces: 'clones' }, onPrOpened: (id) => opened.push(id) });
  status = { state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', head: 'aaa', author: 'owner', checks: [], comments: [] };
  const forge: Forge = { status: () => status, body: () => '', setBody: () => {} };
  watcher = new PrWatcher(board, workers, forge, () => main, ['deploy-bot']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};

/** Work on the card's branch, so approving it goes out as a pull request. */
function commit(cardId: string) {
  const clone = board.row(cardId).workspace!;
  writeFileSync(join(clone, 'export.ts'), '');
  git(clone, 'add', '.');
  git(clone, 'commit', '--quiet', '-m', 'Export');
}

/** A card through review and approval, with its PR reported. */
async function inPr() {
  const c = board.create({ title: 'Export', x: 0, y: 0 });
  workers.start(c.id);
  commit(c.id);
  runtime.last.call('ready_for_review', { summary: 'S' });
  await workers.approve(c.id);
  return c.id;
}

describe('the PR phase', () => {
  test('approval asks the worker to open the PR; pr_opened records it', async () => {
    const id = await inPr();
    expect(state(id)).toBe('inPr');
    expect(runtime.last.inbox.at(-1)).toContain('goes out as a pull request');
    // without a shared demo, the approval says nothing about one
    expect(runtime.last.inbox.at(-1)).not.toContain('shared with the team');
    expect(runtime.last.closed).toBe(false);
    expect(runtime.last.call('pr_opened', { url: 'https://example.com/x' })).toContain('not a GitHub pull request');
    runtime.last.call('pr_opened', { url: URL_ });
    expect(board.item(id)!.pr).toMatchObject({ url: URL_, number: 42 });
    // with the PR open, ending the turn needs no nudge
    const n = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(n);
  });

  test('a demo shared before approval is linked in the PR by the worker; pr_opened passes the PR on', async () => {
    const c = board.create({ title: 'Export', x: 0, y: 0 });
    workers.start(c.id);
    commit(c.id);
    runtime.last.call('ready_for_review', { summary: 'S' });
    board.work(c.id, { share: JSON.stringify({ slug: 'export', url: 'https://demos.example/export/', dir: '/d' }) });
    await workers.approve(c.id);
    expect(runtime.last.inbox.at(-1)).toContain('shared with the team on a page of its own: https://demos.example/export/. Link it');
    runtime.last.call('pr_opened', { url: URL_ });
    expect(opened).toEqual([c.id]);
  });

  test('pr_opened before approval is refused', () => {
    const c = board.create({ title: 'X', x: 0, y: 0 });
    workers.start(c.id);
    expect(runtime.last.call('pr_opened', { url: URL_ })).toContain('not approved');
  });

  test('a turn in the PR phase without a PR is nudged', async () => {
    await inPr();
    // the turn that handed over ends, then the one the approval started
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.at(-1)).toContain('no pull request for this card yet');
  });
});

describe('watching', () => {
  test('new comments from others, failed checks and conflicts go to the worker once each', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    status.comments = [
      { id: 'i1', author: 'greptile', body: 'Null check missing.', path: 'src/a.ts', line: 3 },
      { id: 'c2', author: 'owner', body: 'Fixed in the latest push.' },
      { id: 'c3', author: 'deploy-bot', body: 'Deployed preview.' },
    ];
    status.checks = [{ name: 'build', state: 'failure', url: 'https://ci/1' }, { name: 'lint', state: 'success' }];
    status.mergeable = 'CONFLICTING';
    const before = runtime.last.inbox.length;
    watcher.poll();
    const sent = runtime.last.inbox.slice(before);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain('greptile on src/a.ts:3');
    expect(sent[0]).not.toContain('Fixed in the latest push');
    expect(sent[0]).not.toContain('Deployed preview');
    expect(sent[1]).toContain('- build: https://ci/1');
    expect(sent[2]).toContain('conflicts with its base branch');
    expect(board.item(id)!.pr).toMatchObject({ conflict: true, checks: status.checks });
    // the card shows the review, without the noise
    expect(board.item(id)!.pr!.review).toEqual([
      { author: 'greptile', at: '', threads: [{ author: 'greptile', body: 'Null check missing.', at: '', path: 'src/a.ts', line: 3, resolved: false, replies: [] }] },
      { author: 'owner', mine: true, body: 'Fixed in the latest push.', at: '' },
    ]);

    watcher.poll();
    expect(runtime.last.inbox.length).toBe(before + 3);
    // a new commit fails again: reported again
    status.head = 'bbb';
    watcher.poll();
    expect(runtime.last.inbox.at(-2)).toContain('Checks failed');
    expect(runtime.last.inbox.at(-1)).toContain('conflicts');
  });

  test('a PR with nothing left for the worker waits for the owner’s merge; new work takes that back', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    // the turn that handed over ends, then the one the approval started
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    status.checks = [{ name: 'Greptile Review', state: 'success' }];
    status.comments = [
      { id: 'cSUM', author: 'greptile', body: 'Confidence Score: 4/5', at: '2026-10-02T08:34:00Z' },
      { id: 'cPING', author: 'owner', body: '@greptile re-review', at: '2026-10-02T08:46:00Z' },
    ];
    watcher.poll();
    expect(board.item(id)!.pr!.ready).toBeUndefined();
    // the worker answers the summary
    runtime.last.emit({ type: 'idle' });
    watcher.poll();
    expect(board.item(id)!.pr!.ready).toBeUndefined();
    // the reviewer rewrites its summary, with no new comment
    status.comments[0] = { ...status.comments[0]!, body: 'Confidence Score: 5/5', edited: '2026-10-02T08:49:00Z' };
    const n = runtime.last.inbox.length;
    watcher.poll();
    expect(board.item(id)!.pr!.ready).toBe(true);
    expect(needsYou(board.item(id)!)).toBe(true);
    expect(board.events(id).at(-1)!.text).toStartWith('Bereit zum Mergen');
    expect(runtime.last.inbox.length).toBe(n);
    // said once
    const events = board.events(id).length;
    watcher.poll();
    expect(board.events(id).length).toBe(events);
    // a new comment is work for the worker again
    status.comments.push({ id: 'i3', author: 'lead', body: 'One more thing.', at: '2026-10-02T09:00:00Z' });
    watcher.poll();
    expect(board.item(id)!.pr!.ready).toBeUndefined();
    expect(needsYou(board.item(id)!)).toBe(false);
  });

  test('while the owner is asked, news waits; the answer returns the card to the PR', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.call('ask', { question: 'Soll ich dem Reviewer widersprechen?' });
    expect(state(id)).toBe('waiting:question');
    status.comments = [{ id: 'i9', author: 'reviewer', body: 'Rename this.' }];
    const n = runtime.last.inbox.length;
    watcher.poll();
    expect(runtime.last.inbox.length).toBe(n);
    workers.answer(id, 'Ja, mit Begründung.');
    expect(state(id)).toBe('inPr');
    watcher.poll();
    expect(runtime.last.inbox.at(-1)).toContain('Rename this.');
  });

  test('stopping during a PR question detaches the PR; a new start is a fresh run', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.call('ask', { question: 'Q?' });
    workers.stop(id);
    expect(board.item(id)!.pr).toBeUndefined();
    expect(board.events(id).at(-1)!.text).toContain('#42 bleibt auf GitHub offen');
    workers.start(id);
    runtime.last.call('ask', { question: 'Neu?' });
    workers.answer(id, 'Ja.');
    expect(state(id)).toBe('working');
    status.state = 'MERGED';
    watcher.poll();
    expect(state(id)).toBe('working');
  });

  test('the owner coming back looks at the PRs right away, but not again within the gap', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    let asked = 0;
    const counting = new PrWatcher(board, workers, { status: () => (asked++, status), body: () => '', setBody: () => {} }, () => dir);
    counting.soon();
    counting.soon();
    await Bun.sleep(5);
    expect(asked).toBe(1);

    // merged on GitHub: the owner back in Obeya sees it without waiting for the next round
    status.state = 'MERGED';
    counting.soon(0);
    expect(state(id)).toBe('inPr');
    await Bun.sleep(5);
    expect(asked).toBe(2);
    expect(state(id)).toBe('live');
  });

  test('a merge makes the card live and frees the clone; a close asks the owner', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    runtime.last.emit({ type: 'idle' });
    status.state = 'MERGED';
    watcher.poll();
    expect(state(id)).toBe('live');
    // the worker hears it and may finish what remains; the clone is free once its turn has ended
    expect(runtime.last.inbox.at(-1)).toContain('pull request was merged');
    expect(board.item(id)!.finishing).toBe(true);
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.closed).toBe(true);
    expect(board.row(id).workspace).toBeNull();

    status.state = 'OPEN';
    const other = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    status.state = 'CLOSED';
    watcher.poll();
    expect(state(other)).toBe('waiting:question');
    expect(board.item(other)!.question!.options).toEqual(['Neu eröffnen', 'Die Arbeit verwerfen']);
  });
});
