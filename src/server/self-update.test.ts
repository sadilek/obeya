import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownCheckout, watchOwnCode } from './self-update';
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
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  commit('src/a.ts', 'a');
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
