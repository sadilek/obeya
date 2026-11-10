import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceUpdates } from './source-update';
import { commit, gitClone, gitRepo, identify, removeDir } from './testing';
import { git } from './workspaces';

let dir: string;
/** Where Obeya's repository is published (`origin`), and the clone Obeya runs from. */
let up: string;
let clone: string;

/** A commit in `repo` that writes `file`, as "change <file>". */
const change = (repo: string, file: string, text: string) => commit(repo, file, text, `change ${file}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-source-'));
  up = gitRepo(join(dir, 'up'), { 'src/a.ts': 'a\n', 'docs/design.md': 'design\n' });
  clone = join(dir, 'clone');
  gitClone(up, clone);
  identify(clone);
});

afterEach(() => removeDir(dir));

test('a clone up to date with its upstream has nothing to pull', async () => {
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()).toBeNull();
});

test('new commits that change code wait upstream: fetched, counted and named, newest first', async () => {
  change(up, 'src/a.ts', 'b\n');
  change(up, 'src/b.ts', 'c\n');
  const s = new SourceUpdates(clone);
  const changes: unknown[] = [];
  s.onChange(() => changes.push(s.current()));
  await s.check();
  const u = s.current()!;
  expect(u).toMatchObject({ upstream: 'origin/main', checkout: clone, count: 2 });
  expect(u.commits.map((c) => c.subject)).toEqual(['change src/b.ts', 'change src/a.ts']);
  expect(u.commits[0]!.date).toBeGreaterThan(Date.now() - 60_000);
  expect(u.blocked).toBeUndefined();
  expect(changes).toHaveLength(1);
  // the same again tells no one
  await s.check();
  expect(changes).toHaveLength(1);
});

test('docs alone do not count, as for the self-update', async () => {
  change(up, 'docs/design.md', 'more design\n');
  change(up, 'README.md', 'readme\n');
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()).toBeNull();
  change(up, 'src/a.ts', 'b\n');
  await s.check();
  expect(s.current()?.count).toBe(3);
});

test('a branch that follows nothing, or a detached HEAD, has nothing to pull', async () => {
  change(up, 'src/a.ts', 'b\n');
  git(clone, 'switch', '--quiet', '-c', 'obeya/card');
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()).toBeNull();
  git(clone, 'switch', '--quiet', '--detach', 'main');
  await s.check();
  expect(s.current()).toBeNull();
});

test('a pull fast-forwards the clone to its upstream, and then nothing waits', async () => {
  const head = change(up, 'src/a.ts', 'b\n');
  const s = new SourceUpdates(clone);
  await s.check();
  await s.pull();
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  expect(s.current()).toBeNull();
});

test('the pull fetches first: a commit since the last look comes along', async () => {
  change(up, 'src/a.ts', 'b\n');
  const s = new SourceUpdates(clone);
  await s.check();
  const head = change(up, 'src/c.ts', 'c\n');
  await s.pull();
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
});

test('commits of the clone its own: no fast-forward, and the pull is refused', async () => {
  change(up, 'src/a.ts', 'b\n');
  const mine = change(clone, 'src/mine.ts', 'mine\n');
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()).toMatchObject({ count: 1, blocked: { why: 'diverged' } });
  await expect(s.pull()).rejects.toThrow('cannot be pulled');
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(mine);
});

test('uncommitted changes to a file the pull changes stand in the way; others do not', async () => {
  change(up, 'src/a.ts', 'b\n');
  writeFileSync(join(clone, 'docs/design.md'), 'my notes\n');
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()?.blocked).toBeUndefined();
  writeFileSync(join(clone, 'src/a.ts'), 'mine\n');
  await s.check();
  expect(s.current()?.blocked).toEqual({ why: 'local', files: ['src/a.ts'] });
});

test("a file whose timestamps alone changed stands in no one's way, and git writes no index while looking", async () => {
  change(up, 'src/a.ts', 'b\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(join(clone, 'src/a.ts'), later, later);
  const index = readFileSync(join(clone, '.git', 'index'));
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()).toMatchObject({ count: 1 });
  expect(s.current()?.blocked).toBeUndefined();
  expect(readFileSync(join(clone, '.git', 'index')).equals(index)).toBe(true);
});

test('what git refuses stays on the update for the bar, until a pull goes', async () => {
  const head = change(up, 'src/new.ts', 'theirs\n');
  // an untracked file the pull would overwrite: only git finds it
  writeFileSync(join(clone, 'src/new.ts'), 'mine\n');
  const s = new SourceUpdates(clone);
  await s.check();
  expect(s.current()?.blocked).toBeUndefined();
  await s.pull();
  expect(s.current()?.error).toContain('src/new.ts');
  await s.check();
  expect(s.current()?.error).toContain('src/new.ts');
  rmSync(join(clone, 'src/new.ts'));
  await s.pull();
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  expect(s.current()).toBeNull();
});

test('an upstream that cannot be reached keeps what was fetched', async () => {
  change(up, 'src/a.ts', 'b\n');
  const s = new SourceUpdates(clone);
  await s.check();
  git(clone, 'remote', 'set-url', 'origin', join(dir, 'gone'));
  await s.check();
  expect(s.current()?.count).toBe(1);
});
