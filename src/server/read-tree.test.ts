import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { ReadTree } from './read-tree';
import { FakeRuntime, gitRepo, identify, noForge } from './testing';
import { git } from './workspaces';

const doc = (title: string, ticked = '') =>
  `# ${title}\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [${ticked.includes('W1') ? 'x' : ' '}] **W1:** Eins.\n- [${ticked.includes('W2') ? 'x' : ' '}] **W2:** Zwei.\n`;

let dir: string;
let origin: string;
/** The configured checkout: a pool clone, which cards lease. */
let checkout: string;
/** Another clone, from which work reaches `origin`. */
let other: string;
let canvas: CanvasRuntime | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-read-'));
  origin = gitRepo(join(dir, 'origin'), { 'docs/plan/export.md': doc('Export') });
  git(origin, 'config', 'receive.denyCurrentBranch', 'ignore');
  checkout = join(dir, 'checkout');
  other = join(dir, 'other');
  for (const c of [checkout, other]) {
    git(dir, 'clone', '--quiet', origin, c);
    identify(c);
  }
});
afterEach(() => {
  canvas?.shutdown();
  canvas = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A commit pushed to `origin`'s main from the other clone. */
function push(files: Record<string, string | null>) {
  git(other, 'pull', '--quiet', '--ff-only');
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(other, f));
    else {
      mkdirSync(join(other, f, '..'), { recursive: true });
      writeFileSync(join(other, f), text);
    }
  }
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', 'change');
  git(other, 'push', '--quiet', 'origin', 'main');
}

function open(adapter?: string) {
  canvas = new CanvasRuntime({ name: 'Shop', repos: [{ path: checkout, ...(adapter ? { adapter } : {}) }] }, { store: new Store(':memory:'), home: join(dir, 'home'), runtime: new FakeRuntime(), forge: noForge });
  return canvas;
}

const projects = (c: CanvasRuntime) =>
  c.board
    .snapshot()
    .items.filter((i) => i.kind === 'project')
    .map((p) => p.title)
    .sort();

describe('the Lesestand', () => {
  test("is a worktree on the default branch: a card's branch in the checkout without the plan doc leaves the project on the canvas", () => {
    git(checkout, 'checkout', '--quiet', '-b', 'obeya/card');
    git(checkout, 'rm', '--quiet', 'docs/plan/export.md');
    git(checkout, 'commit', '--quiet', '-m', 'card');
    const c = open();
    // named after the repository, which is named after its remote
    expect(c.repos[0]!.read.path).toBe(join(dir, 'home', 'read', 'shop', 'origin'));
    expect(projects(c)).toEqual(['Export']);
    // the checkout's working tree is the card's, untouched; leasing finds it clean
    expect(existsSync(join(checkout, 'docs/plan/export.md'))).toBe(false);
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    git(checkout, 'checkout', '--quiet', 'main');
    git(checkout, 'checkout', '--quiet', 'obeya/card');
    c.board.docsChanged();
    expect(projects(c)).toEqual(['Export']);
  });

  test('shows a doc that reached origin once it refreshes, and lets a deleted one go', async () => {
    const c = open();
    push({ 'docs/plan/import.md': doc('Import') });
    expect(projects(c)).toEqual(['Export']);
    await c.repos[0]!.read.refresh();
    expect(projects(c)).toEqual(['Export', 'Import']);
    push({ 'docs/plan/export.md': null });
    await c.repos[0]!.read.refresh();
    expect(projects(c)).toEqual(['Import']);
  });

  test('a workstream ticked off in a merged pull request goes live with the merge', async () => {
    const c = open();
    const ws = (label: string) => c.board.snapshot().items.find((i) => i.label === label)!;
    expect([ws('W1').state, ws('W2').state]).toEqual(['planned', 'planned']);
    c.board.work(ws('W1').id, { state: 'inPr', pr: JSON.stringify({ url: 'https://example.com/pr/1' }) });
    push({ 'docs/plan/export.md': doc('Export', 'W1 W2') });
    c.repos[0]!.workers.merged(ws('W1').id);
    // the merge started the refresh; a second call waits for the same one
    await c.repos[0]!.read.refresh();
    expect([ws('W1').state, ws('W2').state]).toEqual(['live', 'live']);
  });

  test('is the checkout itself where work lands on the local main, uncommitted docs included', () => {
    writeFileSync(join(checkout, 'docs/plan/draft.md'), doc('Entwurf'));
    const c = open('obeya');
    expect(c.repos[0]!.read.path).toBe(checkout);
    expect(projects(c)).toEqual(['Entwurf', 'Export']);
    expect(existsSync(join(dir, 'home', 'read'))).toBe(false);
  });

  test('takes the local main where it has everything of origin, else origin', async () => {
    const read = join(dir, 'read');
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
    writeFileSync(join(checkout, 'local.md'), 'x\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '--quiet', '-m', 'local');
    await tree.refresh();
    expect(existsSync(join(read, 'local.md'))).toBe(true);
    // origin moves on without it: the local main no longer has everything, so origin counts
    push({ 'remote.md': 'y\n' });
    await tree.refresh();
    expect([existsSync(join(read, 'local.md')), existsSync(join(read, 'remote.md'))]).toEqual([false, true]);
  });

  test('makes a missing, broken or foreign worktree afresh', () => {
    const read = join(dir, 'read');
    const make = () => new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => {} });
    const head = git(checkout, 'rev-parse', 'main');
    const on = () => git(read, 'rev-parse', 'HEAD');
    make();
    expect(on()).toBe(head);
    // reused as it is
    writeFileSync(join(read, 'marker'), '');
    make();
    expect(existsSync(join(read, 'marker'))).toBe(true);
    // gone
    rmSync(read, { recursive: true, force: true });
    expect(make().path).toBe(read);
    expect(on()).toBe(head);
    // broken: its link to the repository points nowhere
    writeFileSync(join(read, '.git'), 'gitdir: /nowhere\n');
    make();
    expect(on()).toBe(head);
    expect(git(checkout, 'worktree', 'list').split('\n')).toHaveLength(2);
    // another repository's
    rmSync(read, { recursive: true, force: true });
    git(origin, 'worktree', 'add', '--quiet', '--detach', read);
    make();
    expect(git(read, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  });

  test('keeps its commit when the fetch fails, and catches up once it works again', async () => {
    let changes = 0;
    const read = join(dir, 'read');
    const tree = new ReadTree({ repoPath: checkout, dir: read, remote: true, onChange: () => changes++ });
    push({ 'docs/plan/import.md': doc('Import') });
    renameSync(origin, `${origin}-away`);
    await tree.refresh();
    expect([changes, existsSync(join(read, 'docs/plan/import.md'))]).toEqual([0, false]);
    renameSync(`${origin}-away`, origin);
    await tree.refresh();
    expect([changes, existsSync(join(read, 'docs/plan/import.md'))]).toEqual([1, true]);
  });
});
