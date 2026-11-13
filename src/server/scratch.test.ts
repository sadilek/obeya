import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchOf, ScratchEnd } from './scratch';
import { gitRepo } from './testing';
import { git } from './git';

const tmp = mkdtempSync(join(tmpdir(), 'obeya-scratch-end-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function scratch(checkout: string, o: { pages?: () => number; working?: () => boolean } = {}) {
  let now = 0;
  const end = new ScratchEnd({ checkout, idleMs: 30 * 60_000, pages: o.pages ?? (() => 0), working: o.working ?? (() => false), end: () => {}, now: () => now });
  return { end, pass: (minutes: number) => (now += minutes * 60_000) };
}

test('ends once nothing used it for the idle time, and a request starts that time again', () => {
  const { end, pass } = scratch(gitRepo(join(tmp, 'idle')));
  pass(29);
  expect(end.why()).toBeNull();
  end.used();
  pass(29);
  expect(end.why()).toBeNull();
  pass(1);
  expect(end.why()).toBe('nothing used it for 30 minutes');
});

test('an open page or an agent of its own in a turn keeps it', () => {
  let pages = 1;
  let working = false;
  const { end, pass } = scratch(gitRepo(join(tmp, 'pages')), { pages: () => pages, working: () => working });
  pass(45);
  expect(end.why()).toBeNull();
  pages = 0;
  working = true;
  pass(45);
  expect(end.why()).toBeNull();
  working = false;
  pass(29);
  expect(end.why()).toBeNull();
  pass(1);
  expect(end.why()).not.toBeNull();
});

test('ends once the checkout it was staged from is on another branch, or gone', () => {
  const checkout = gitRepo(join(tmp, 'card'));
  git(checkout, 'checkout', '-q', '-b', 'obeya/a-card');
  const { end } = scratch(checkout);
  expect(branchOf(checkout)).toBe('refs/heads/obeya/a-card');
  expect(end.why()).toBeNull();
  git(checkout, 'checkout', '-q', 'main');
  expect(end.why()).toBe(`${checkout}, which it was staged from, is on main now`);
  rmSync(checkout, { recursive: true, force: true });
  expect(end.why()).toBe(`${checkout}, which it was staged from, is gone`);
});

test("a worktree's branch is read from its own git directory", () => {
  const repo = gitRepo(join(tmp, 'main'));
  const worktree = join(tmp, 'worktree');
  git(repo, 'worktree', 'add', '-q', '-b', 'obeya/b-card', worktree);
  expect(branchOf(worktree)).toBe('refs/heads/obeya/b-card');
  expect(branchOf(repo)).toBe('refs/heads/main');
});
