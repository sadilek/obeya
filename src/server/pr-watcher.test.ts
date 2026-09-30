import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { Board } from './board';
import { Store } from './db';
import type { Forge, PrStatus } from './forge';
import { PrWatcher } from './pr-watcher';
import { FakeRuntime } from './testing';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let status: PrStatus;
let watcher: PrWatcher;
const URL_ = 'https://github.com/acme/app/pull/42';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-pr-'));
  const main = join(dir, 'main');
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', main]);
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => []);
  const workspaces = new Workspaces(store, 'c', { mode: 'clones', repoPath: main, dir: join(dir, 'ws') });
  workspaces.ensureClones(main, 1);
  runtime = new FakeRuntime();
  workers = new Workers({ board, runtime, workspaces, adapter: { ...generic, land: 'pr', workspaces: 'clones' } });
  status = { state: 'OPEN', mergeable: 'MERGEABLE', head: 'aaa', author: 'owner', checks: [], comments: [] };
  const forge: Forge = { status: () => status };
  watcher = new PrWatcher(board, workers, forge, () => main, ['deploy-bot']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};

/** A card through review and approval, with its PR reported. */
async function inPr() {
  const c = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
  workers.start(c.id);
  runtime.last.call('ready_for_review', { summary: 'S' });
  await workers.approve(c.id);
  return c.id;
}

describe('the PR phase', () => {
  test('approval asks the worker to open the PR; pr_opened records it', async () => {
    const id = await inPr();
    expect(state(id)).toBe('inPr');
    expect(runtime.last.inbox.at(-1)).toContain('open the pull request the way this repository does it');
    expect(runtime.last.closed).toBe(false);
    expect(runtime.last.call('pr_opened', { url: 'https://example.com/x' })).toContain('not a GitHub pull request');
    runtime.last.call('pr_opened', { url: URL_ });
    expect(board.item(id)!.pr).toMatchObject({ url: URL_, number: 42 });
    // with the PR open, ending the turn needs no nudge
    const n = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(n);
  });

  test('pr_opened before approval is refused', () => {
    const c = board.create({ kind: 'feature', title: 'X', x: 0, y: 0 });
    workers.start(c.id);
    expect(runtime.last.call('pr_opened', { url: URL_ })).toContain('not approved');
  });

  test('a turn in the PR phase without a PR is nudged', async () => {
    await inPr();
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.at(-1)).toContain('call pr_opened');
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

    watcher.poll();
    expect(runtime.last.inbox.length).toBe(before + 3);
    // a new commit fails again: reported again
    status.head = 'bbb';
    watcher.poll();
    expect(runtime.last.inbox.at(-2)).toContain('Checks failed');
    expect(runtime.last.inbox.at(-1)).toContain('conflicts');
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

  test('a merge makes the card live and frees the clone; a close asks the owner', async () => {
    const id = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    status.state = 'MERGED';
    watcher.poll();
    expect(state(id)).toBe('live');
    expect(runtime.last.closed).toBe(true);

    status.state = 'OPEN';
    const other = await inPr();
    runtime.last.call('pr_opened', { url: URL_ });
    status.state = 'CLOSED';
    watcher.poll();
    expect(state(other)).toBe('waiting:question');
    expect(board.item(other)!.question!.options).toEqual(['Neu eröffnen', 'Die Arbeit verwerfen']);
  });
});
