import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Busy, ownCheckout, Restarter, watchOwnCode, whenIdle } from './self-update';
import { gitRepo } from './testing';
import { git } from './workspaces';

let repo: string;
let stop = () => {};

const commit = (file: string, text: string) => {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'obeya-self-'));
  gitRepo(repo, { 'src/a.ts': 'a' });
});

afterEach(() => {
  stop();
  rmSync(repo, { recursive: true, force: true });
});

test('the code comes from a checkout', () => {
  expect(ownCheckout()).toBeTruthy();
});

test('a commit that changes code asks for a restart, once', async () => {
  const start = git(repo, 'rev-parse', 'HEAD');
  const calls: [string, string][] = [];
  stop = watchOwnCode(repo, (from, to) => calls.push([from, to]), 20);
  await wait(60);
  expect(calls).toEqual([]);
  const head = commit('src/a.ts', 'b');
  await wait(120);
  commit('src/b.ts', 'c');
  await wait(120);
  expect(calls).toEqual([[start, head]]);
});

test('docs alone change nothing that runs', async () => {
  const calls: string[] = [];
  stop = watchOwnCode(repo, (_, to) => calls.push(to), 20);
  commit('docs/plan.md', 'plan');
  commit('README.md', 'readme');
  await wait(120);
  expect(calls).toEqual([]);
  const head = commit('src/a.ts', 'b');
  await wait(120);
  expect(calls).toEqual([head]);
});

test('a restart waits until nothing is busy, or until its patience is out', async () => {
  let busy = true;
  let ran = 0;
  stop = whenIdle(() => busy, () => ran++, 10_000, 10);
  await wait(50);
  expect(ran).toBe(0);
  busy = false;
  await wait(50);
  expect(ran).toBe(1);
  stop = whenIdle(() => true, () => ran++, 40, 10);
  await wait(100);
  expect(ran).toBe(2);
});

test('a restart with no worker busy goes ahead at once and never waits', () => {
  let gone = 0;
  const r = new Restarter({ busy: () => [], go: () => gone++ });
  r.request('code');
  expect(gone).toBe(1);
  expect(r.due()).toBeNull();
  expect(r.now()).toBe(false);
});

test('a restart that waits tells for whom, follows them, and goes once they are done', async () => {
  let busy: Busy[] = [
    { canvas: 'c', card: 'a' },
    { canvas: 'c', card: 'b' },
  ];
  let gone = 0;
  let changes = 0;
  const r = new Restarter({ busy: () => busy, go: () => gone++, patienceMs: 10_000, intervalMs: 10 });
  r.onChange(() => changes++);
  r.request('config');
  r.request('code');
  expect(r.due()).toMatchObject({ reason: 'config', waiting: busy });
  expect(r.due()!.deadline - r.due()!.since).toBe(10_000);
  expect(changes).toBe(1);
  busy = [busy[1]!];
  await wait(50);
  expect(r.due()!.waiting).toEqual([{ canvas: 'c', card: 'b' }]);
  expect(changes).toBe(2);
  expect(gone).toBe(0);
  busy = [];
  await wait(50);
  expect(gone).toBe(1);
  expect(r.due()).toBeNull();
});

test('the owner has a waiting restart go ahead now, once', async () => {
  let gone = 0;
  const r = new Restarter({ busy: () => [{ canvas: 'c', card: 'a' }], go: () => gone++, patienceMs: 10_000, intervalMs: 10 });
  r.request('code');
  expect(r.now()).toBe(true);
  expect(gone).toBe(1);
  expect(r.due()).toBeNull();
  expect(r.now()).toBe(false);
  r.request('code');
  await wait(50);
  expect(gone).toBe(1);
});
