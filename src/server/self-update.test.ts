import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Busy, headSeal, installDependencies, ownCheckout, Restarter, watchOwnCode, whenIdle } from './self-update';
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
/** Waits until `done` holds: the watch's git calls take their time, on Windows far longer than the interval (so do its tests: 20 s each). */
const until = async (done: () => boolean) => {
  for (const end = Date.now() + 10_000; !done() && Date.now() < end; ) await wait(10);
};

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
  stop = watchOwnCode(repo, start, (from, to) => calls.push([from, to]), 20);
  const head = commit('src/a.ts', 'b');
  await until(() => calls.length > 0);
  commit('src/b.ts', 'c');
  await wait(120);
  expect(calls).toEqual([[start, head]]);
}, 20_000);

test('a commit between the server starting and the watch is new code to it', async () => {
  const start = git(repo, 'rev-parse', 'HEAD');
  const head = commit('src/a.ts', 'b');
  const calls: [string, string][] = [];
  stop = watchOwnCode(repo, start, (from, to) => calls.push([from, to]), 20);
  await until(() => calls.length > 0);
  expect(calls).toEqual([[start, head]]);
}, 20_000);

test('docs, the site and its workflow alone change nothing that runs', async () => {
  const calls: string[] = [];
  stop = watchOwnCode(repo, git(repo, 'rev-parse', 'HEAD'), (_, to) => calls.push(to), 20);
  commit('docs/plan.md', 'plan');
  commit('README.md', 'readme');
  commit('site/index.html', '<!doctype html>');
  commit('.github/workflows/pages.yml', 'name: Pages');
  await wait(120);
  expect(calls).toEqual([]);
  const head = commit('src/a.ts', 'b');
  await until(() => calls.length > 0);
  expect(calls).toEqual([head]);
}, 20_000);

test('a commit while git looks at what changed has not held still: the restart waits for a round of its own', async () => {
  const start = git(repo, 'rev-parse', 'HEAD');
  const first = commit('src/a.ts', 'b');
  let second = '';
  const spawn = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    if (!second && (args[0] as string[]).includes('diff')) second = commit('src/b.ts', 'c');
    return spawn(...args);
  }) as typeof Bun.spawn;
  const calls: [string, string][] = [];
  try {
    stop = watchOwnCode(repo, start, (from, to) => calls.push([from, to]), 20);
    await until(() => calls.length > 0);
  } finally {
    Bun.spawn = spawn;
  }
  expect(second).not.toBe('');
  expect(calls).toEqual([[start, second]]);
  expect(first).not.toBe(second);
}, 20_000);

test('while HEAD stands still, the watch starts no git', async () => {
  const spawn = Bun.spawn;
  let started = 0;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => (started++, spawn(...args))) as typeof Bun.spawn;
  const calls: string[] = [];
  let rounds = 0;
  try {
    stop = watchOwnCode(repo, git(repo, 'rev-parse', 'HEAD'), (_, to) => calls.push(to), 20, () => rounds++);
    // the first round asks git: HEAD may have moved since the server started
    await until(() => rounds >= 1);
    started = 0;
    const from = rounds;
    await until(() => rounds >= from + 5);
    expect(rounds).toBeGreaterThanOrEqual(from + 5);
  } finally {
    Bun.spawn = spawn;
  }
  expect(started).toBe(0);
  // and it still watches
  const head = commit('src/a.ts', 'b');
  await until(() => calls.length > 0);
  expect(calls).toEqual([head]);
}, 20_000);

test('a checkout that is a worktree is watched too', async () => {
  const tree = `${repo}-tree`;
  git(repo, 'worktree', 'add', '--quiet', '-b', 'side', tree);
  try {
    const calls: string[] = [];
    stop = watchOwnCode(tree, git(tree, 'rev-parse', 'HEAD'), (_, to) => calls.push(to), 20);
    writeFileSync(join(tree, 'src/a.ts'), 'b');
    git(tree, 'commit', '--quiet', '-am', 'a');
    const head = git(tree, 'rev-parse', 'HEAD');
    await until(() => calls.length > 0);
    expect(calls).toEqual([head]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}, 20_000);

test('the seal of HEAD moves with a branch that HEAD reaches through another', () => {
  const branch = git(repo, 'symbolic-ref', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/heads/alias', branch);
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
  const before = headSeal(repo);
  expect(before).not.toBeNull();
  commit('src/a.ts', 'b');
  expect(headSeal(repo)).not.toBe(before);
}, 20_000);

test("the seal of HEAD moves with a ref of the worktree's own", () => {
  const tree = `${repo}-tree`;
  const start = git(repo, 'rev-parse', 'HEAD');
  const next = commit('src/a.ts', 'b');
  git(repo, 'worktree', 'add', '--quiet', '--detach', tree);
  try {
    git(tree, 'update-ref', 'refs/worktree/own', start);
    git(tree, 'symbolic-ref', 'HEAD', 'refs/worktree/own');
    const before = headSeal(tree);
    expect(before).not.toBeNull();
    git(tree, 'update-ref', 'refs/worktree/own', next);
    expect(headSeal(tree)).not.toBe(before);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}, 20_000);

test('the seal of HEAD moves with packed refs written anew in the same size and millisecond', () => {
  const start = git(repo, 'rev-parse', 'HEAD');
  const next = commit('src/a.ts', 'b');
  git(repo, 'pack-refs', '--all');
  const packed = join(repo, '.git', 'packed-refs');
  const was = statSync(packed, { bigint: true });
  const before = headSeal(repo);
  expect(before).not.toBeNull();
  // in place, the same size, a moment later within the same millisecond
  writeFileSync(packed, readFileSync(packed, 'utf8').replace(next, start));
  const ns = (was.mtimeNs / 1_000_000n) * 1_000_000n + ((was.mtimeNs % 1_000_000n) + 500_000n) % 1_000_000n;
  utimesSync(packed, Number(was.atimeNs) / 1e9, Number(ns) / 1e9);
  const now = statSync(packed, { bigint: true });
  expect([now.ino, now.size, now.mtimeNs / 1_000_000n]).toEqual([was.ino, was.size, was.mtimeNs / 1_000_000n]);
  expect(headSeal(repo)).not.toBe(before);
}, 20_000);

test('a restart installs the dependencies only when package.json or bun.lock changed', () => {
  const start = git(repo, 'rev-parse', 'HEAD');
  const install = [process.execPath, '-e', "require('fs').writeFileSync('installed', '')"];
  commit('src/a.ts', 'b');
  commit('docs/package.json', '{}');
  expect(installDependencies(repo, start, install)).toEqual({ ran: false });
  expect(existsSync(join(repo, 'installed'))).toBe(false);
  commit('bun.lock', '{}');
  expect(installDependencies(repo, start, install)).toMatchObject({ ran: true, ok: true });
  expect(existsSync(join(repo, 'installed'))).toBe(true);
  const after = commit('package.json', '{}');
  expect(installDependencies(repo, after, install)).toEqual({ ran: false });
});

test('an install that fails is told, not thrown', () => {
  const start = git(repo, 'rev-parse', 'HEAD');
  commit('package.json', '{}');
  const failed = installDependencies(repo, start, [process.execPath, '-e', "console.error('no network'); process.exit(1)"]);
  expect(failed).toEqual({ ran: true, ok: false, output: 'no network' });
  expect(installDependencies(repo, start, [join(repo, 'no-such-bun')])).toMatchObject({ ran: true, ok: false });
  // a commit that is not there any more counts as changed
  expect(installDependencies(repo, 'f'.repeat(40), [process.execPath, '-e', '']).ran).toBe(true);
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

test('a restart waits while the owner watches a video or dictates, past its patience too, and not for a page that let go', async () => {
  let gone = 0;
  let changes = 0;
  const r = new Restarter({ busy: () => [{ canvas: 'c', card: 'a' }], go: () => gone++, patienceMs: 30, intervalMs: 10 });
  r.onChange(() => changes++);
  r.hold('page1', ['video']);
  r.hold('page2', ['voice', 'video']);
  r.hold('page3', ['voice']);
  r.hold('page3');
  r.request('code');
  expect(r.due()).toMatchObject({ waiting: [{ canvas: 'c', card: 'a' }], owner: ['video', 'voice'] });
  await wait(80);
  expect(gone).toBe(0);
  r.hold('page2', ['voice']);
  expect(r.due()!.owner).toEqual(['video', 'voice']);
  r.hold('page1', []);
  expect(r.due()!.owner).toEqual(['voice']);
  expect(changes).toBe(2);
  r.hold('page2');
  await wait(50);
  expect(gone).toBe(1);
});

test("a restart waits for what the server holds for the owner (a command in its undo window), with no page open", async () => {
  let gone = 0;
  let held: ('voice' | 'video')[] = ['voice'];
  const r = new Restarter({ busy: () => [], go: () => gone++, held: () => held, intervalMs: 10 });
  r.hold('page', ['voice']);
  r.request('code');
  // the page that said it reloads and lets go
  r.hold('page');
  await wait(40);
  expect(gone).toBe(0);
  expect(r.due()).toMatchObject({ owner: ['voice'] });
  held = [];
  await wait(40);
  expect(gone).toBe(1);
});

test('a restart with no worker busy waits for the owner alone', async () => {
  let gone = 0;
  const r = new Restarter({ busy: () => [], go: () => gone++, intervalMs: 10 });
  r.hold('page', ['voice']);
  r.request('config');
  expect(r.due()).toMatchObject({ waiting: [], owner: ['voice'] });
  r.hold('page');
  await wait(50);
  expect(gone).toBe(1);
});

test('a stop waits for the workers like a restart, but not for the owner, and goes as a stop', async () => {
  let busy: Busy[] = [{ canvas: 'c', card: 'a' }];
  const gone: string[] = [];
  const r = new Restarter({ busy: () => busy, go: (reason) => gone.push(reason), patienceMs: 10_000, intervalMs: 10 });
  r.hold('page', ['video']);
  r.request('stop');
  expect(r.due()).toMatchObject({ reason: 'stop', waiting: busy, owner: [] });
  r.request('code');
  expect(r.due()!.reason).toBe('stop');
  await wait(50);
  expect(gone).toEqual([]);
  busy = [];
  await wait(50);
  expect(gone).toEqual(['stop']);
});

test('a stop turns a restart that waits into a stop', async () => {
  const gone: string[] = [];
  let changes = 0;
  const r = new Restarter({ busy: () => [{ canvas: 'c', card: 'a' }], go: (reason) => gone.push(reason), patienceMs: 10_000, intervalMs: 10 });
  r.onChange(() => changes++);
  r.hold('page', ['voice']);
  r.request('code');
  r.request('stop');
  expect(r.due()).toMatchObject({ reason: 'stop', owner: [] });
  expect(changes).toBe(2);
  expect(r.now()).toBe(true);
  expect(gone).toEqual(['stop']);
});

test('a stop with no worker busy goes at once, even while the owner watches a video', () => {
  const gone: string[] = [];
  const r = new Restarter({ busy: () => [], go: (reason) => gone.push(reason) });
  r.hold('page', ['video']);
  r.request('stop');
  expect(gone).toEqual(['stop']);
  expect(r.due()).toBeNull();
});

test('installing an update turns a restart that waits into an update, which waits for the owner too', async () => {
  const gone: string[] = [];
  let busy: Busy[] = [{ canvas: 'c', card: 'a' }];
  const r = new Restarter({ busy: () => busy, go: (reason) => gone.push(reason), patienceMs: 10_000, intervalMs: 10 });
  r.request('code');
  r.request('update');
  r.hold('page', ['video']);
  expect(r.due()).toMatchObject({ reason: 'update', owner: ['video'] });
  // new code meanwhile is covered by the update, which restarts too
  r.request('code');
  expect(r.due()?.reason).toBe('update');
  busy = [];
  await wait(50);
  expect(gone).toEqual([]);
  r.hold('page');
  await wait(50);
  expect(gone).toEqual(['update']);
});

test('an update or a stop wins over a takeover by the app that waits, and new code does not', () => {
  const gone: string[] = [];
  const r = new Restarter({ busy: () => [{ canvas: 'c', card: 'a' }], go: (reason) => gone.push(reason), patienceMs: 10_000, intervalMs: 10 });
  r.request('takeover');
  r.request('config');
  expect(r.due()?.reason).toBe('takeover');
  r.request('update');
  expect(r.due()?.reason).toBe('update');
  r.request('takeover');
  expect(r.due()?.reason).toBe('update');
  expect(r.now()).toBe(true);
  expect(gone).toEqual(['update']);
});

test('a stop wins over an update that waits', () => {
  const gone: string[] = [];
  const r = new Restarter({ busy: () => [{ canvas: 'c', card: 'a' }], go: (reason) => gone.push(reason), patienceMs: 10_000, intervalMs: 10 });
  r.request('update');
  r.request('stop');
  expect(r.due()?.reason).toBe('stop');
  r.request('update');
  expect(r.now()).toBe(true);
  expect(gone).toEqual(['stop']);
});
