import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { PlanDoc } from '../core/plan-doc';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { FakeRuntime } from './testing';
import type { Reply } from './advisor';
import { Workers } from './workers';
import { git, Workspaces } from './workspaces';

const ws = (key: string) => ({ key, label: key, title: `Title ${key}`, body: 'Body', done: false, inReview: false });
const doc: PlanDoc = { file: 'docs/plan/a.md', title: 'A', goal: 'Goal', workstreams: [ws('W1')] };

let dir: string;
let main: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let projectReply: Reply | null;
let spaces: Workspaces;

function setup(adapter: RepoAdapter) {
  dir = mkdtempSync(join(tmpdir(), 'obeya-workers-'));
  main = join(dir, 'main');
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', main]);
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => [doc]);
  const workspaces = new Workspaces(store, 'c', { mode: adapter.workspaces, repoPath: main, dir: join(dir, 'ws') });
  spaces = workspaces;
  if (adapter.workspaces === 'clones') {
    workspaces.ensureClones(main, 1);
    for (const w of workspaces.list()) {
      git(w.path, 'config', 'user.email', 't@example.com');
      git(w.path, 'config', 'user.name', 'T');
    }
  }
  runtime = new FakeRuntime();
  projectReply = null;
  workers = new Workers({
    board,
    runtime,
    workspaces,
    adapter,
    advisor: (card) => (card.parent ? { by: 'project', ask: async () => projectReply! } : null),
  });
}

beforeEach(() => setup({ ...generic, land: 'main', workspaces: 'clones', setup: 'bun install', checks: ['bun test'] }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const manual = () => board.create({ kind: 'feature', title: 'Zählerstände exportieren', x: 0, y: 0 });
const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('workers', () => {
  test('start leases a clean clone, branches and briefs the worker', () => {
    const c = manual();
    workers.start(c.id);
    const row = board.row(c.id);
    expect(state(c.id)).toBe('working');
    expect(row.branch).toMatch(/^obeya\/zahlerstande-exportieren-/);
    expect(git(row.workspace!, 'branch', '--show-current')).toBe(row.branch!);
    expect(runtime.last.spec.cwd).toBe(row.workspace!);
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
    expect(runtime.last.inbox[0]).toContain('`bun install`');
    // the only clone is taken
    const d = manual();
    expect(() => workers.start(d.id)).toThrow(BadRequest);
  });

  test('report shows on the card and in the log', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('report', { status: 'Tests grün' });
    expect(board.item(c.id)!.statusLine).toBe('Tests grün');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'report', text: 'Tests grün' });
  });

  test('a standalone card asks the owner; the answer goes back to the worker', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question).toEqual({ text: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    workers.answer(c.id, 'CSV');
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('CSV');
  });

  test('a workstream asks its project agent first', async () => {
    const w = board.snapshot().items.find((i) => i.label === 'W1')!;
    workers.start(w.id);
    projectReply = { answer: 'Laut Plan: CSV.' };
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    await flush();
    expect(state(w.id)).toBe('working');
    expect(board.events(w.id).at(-1)).toMatchObject({ kind: 'answer', author: 'project', text: 'Laut Plan: CSV.' });
    expect(runtime.last.inbox.at(-1)).toContain('project agent');

    projectReply = { escalate: { text: 'Budget freigeben?', options: ['Ja', 'Nein'] } };
    runtime.last.call('ask', { question: 'Darf ich den Dienst X buchen?' });
    await flush();
    expect(state(w.id)).toBe('waiting:question');
    expect(board.item(w.id)!.question!.text).toBe('Budget freigeben?');
  });

  test('a turn that ends without handing over is nudged once, then goes to the owner', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich komme nicht an die Datenbank.' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question!.text).toBe('Ich komme nicht an die Datenbank.');
  });

  test('handing over ends the turn without a nudge', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'Q?' });
    const before = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(before);
  });

  test('review, feedback, approval: the work lands on main and the clone is free again', async () => {
    const c = manual();
    workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    runtime.last.call('ready_for_review', { summary: 'Export gebaut.' });
    expect(state(c.id)).toBe('waiting:review');
    expect(board.item(c.id)!.summary).toBe('Export gebaut.');

    workers.message(c.id, 'Bitte mit Kopfzeile.');
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('Bitte mit Kopfzeile.');

    runtime.last.call('ready_for_review', { summary: 'Mit Kopfzeile.' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Export');
    expect(runtime.last.closed).toBe(true);
    const d = manual();
    workers.start(d.id);
    expect(board.row(d.id).workspace).toBe(clone);
  });

  test('approval with uncommitted work sends the worker back', async () => {
    const c = manual();
    workers.start(c.id);
    writeFileSync(join(board.row(c.id).workspace!, 'loose.ts'), '');
    runtime.last.call('ready_for_review', { summary: 'Fertig.' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('uncommitted changes');
  });

  test('stop releases the clone and plans the card again', () => {
    const c = manual();
    workers.start(c.id);
    workers.stop(c.id);
    expect(state(c.id)).toBe('planned');
    expect(runtime.last.closed).toBe(true);
    const d = manual();
    expect(() => workers.start(d.id)).not.toThrow();
  });

  test('stopping keeps committed work: the clone stays with the card, starting again goes on on the same branch', () => {
    const c = manual();
    workers.start(c.id);
    const { workspace, branch } = board.row(c.id);
    writeFileSync(join(workspace!, 'work.ts'), 'x');
    git(workspace!, 'add', '.');
    git(workspace!, 'commit', '--quiet', '-m', 'Work');
    workers.stop(c.id);
    expect(board.row(c.id).workspace).toBe(workspace);
    board.patch(c.id, { title: 'Neuer Titel' });
    workers.start(c.id);
    expect(board.row(c.id)).toMatchObject({ workspace, branch });
    expect(git(workspace!, 'log', '--format=%s', '-1')).toBe('Work');
    expect(runtime.last.inbox[0]).toContain('already holds earlier work');
  });

  test("a late advisor reply or a stopped session's tool call changes nothing", async () => {
    const w = board.snapshot().items.find((i) => i.label === 'W1')!;
    let reply!: (r: Reply) => void;
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, advisor: () => ({ by: 'project', ask: () => new Promise((r) => (reply = r)) }) });
    workers.start(w.id);
    const old = runtime.last;
    old.call('ask', { question: 'Q?' });
    workers.stop(w.id);
    reply({ answer: 'Zu spät.' });
    await flush();
    expect(state(w.id)).toBe('planned');
    expect(old.call('report', { status: 'noch da' })).toContain('session has ended');
    expect(board.item(w.id)!.statusLine).not.toBe('noch da');
  });

  test('after a restart, a worker that never reported a session starts again with its card', () => {
    const c = manual();
    workers.start(c.id);
    workers.shutdown();
    const n = runtime.sessions.length;
    workers.resumeAll();
    expect(runtime.sessions.length).toBe(n + 1);
    expect(runtime.last.spec.resume).toBeUndefined();
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
  });

  test('a proposal lands below its source card', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('propose_card', { kind: 'bugfix', title: 'Falsches Label', reason: 'Gesehen beim Testen.', suggestion: 'Umbenennen.' });
    const p = board.snapshot().items.find((i) => i.state === 'proposal')!;
    expect(p).toMatchObject({ kind: 'bugfix', title: 'Falsches Label', from: c.id });
    expect(p.y).toBeGreaterThan(c.y);
    board.accept(p.id);
    expect(state(p.id)).toBe('planned');
  });

  test('a delivery to a worker that never reported a session starts one with the card', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'Q?' });
    workers.shutdown();
    workers.answer(c.id, 'A');
    expect(runtime.last.spec.resume).toBeUndefined();
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
    expect(runtime.last.inbox[0]).toContain('Answer to your question');
  });

  test('after a restart a working card resumes its session; a delivery to an ended session resumes it', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 'sess-1' });
    workers.shutdown();
    workers.resumeAll();
    expect(runtime.last.spec.resume).toBe('sess-1');
    runtime.last.call('ask', { question: 'Q?' });
    workers.shutdown();
    workers.answer(c.id, 'A');
    expect(runtime.last.spec.resume).toBe('sess-1');
    expect(runtime.last.inbox[0]).toContain('A');
  });
});

describe('handing over with a demo', () => {
  const demoDir = () => {
    const d = join(dir, 'demo');
    Bun.spawnSync(['mkdir', '-p', d]);
    writeFileSync(join(d, 'demo.mp4'), 'x');
    writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n\n00:00:00.350 --> 00:00:05.000\nA.\n\n00:00:06.350 --> 00:00:09.000\nB.\n');
    return d;
  };
  const demo = (d: string, chapters = ['Vorher', 'Nachher']) => ({ dir: d, chapters, shown: ['Export'], not_shown: ['PDF: nicht betroffen'], findings: [], question: 'Semikolon oder Komma?' });

  test('the card waits with the demo; its files are found; feedback asks for a new render', () => {
    const c = manual();
    workers.start(c.id);
    const d = demoDir();
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: demo(d) })).toContain('End your turn');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.demo).toEqual({ chapters: [[0, 'Vorher'], [6, 'Nachher']], shown: ['Export'], notShown: ['PDF: nicht betroffen'], findings: [], question: 'Semikolon oder Komma?' });
    expect(board.item(c.id)!.summary).toBe('S');
    expect(board.demoDir(c.id)).toBe(d);
    workers.message(c.id, 'Bitte mit Kopfzeile.');
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('render the demo again');
    // the demo stays with the card while it is reworked and after it is done
    expect(board.demoDir(c.id)).toBe(d);
    expect(board.item(c.id)!.demo!.chapters).toHaveLength(2);
  });

  test('a broken demo or a missing required one is refused, and the worker keeps the card', () => {
    const c = manual();
    workers.start(c.id);
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: demo(demoDir(), ['Nur eins']) })).toContain('Not handed over');
    expect(state(c.id)).toBe('working');
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones', demo: { required: true, howToRun: 'bun start' } });
    const d = manual();
    workers.start(d.id);
    expect(runtime.last.inbox[0]).toContain('How to run the app for the demo: bun start');
    expect(runtime.last.call('ready_for_review', { summary: 'S' })).toContain('requires a demo');
    expect(state(d.id)).toBe('working');
  });
});

describe('landing through a pull request', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'pr', workspaces: 'clones' });
  });

  test('approval starts the PR phase: the branch stays in the clone, main is left alone', async () => {
    const c = manual();
    workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'x.ts'), '');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'X');
    runtime.last.call('ready_for_review', { summary: 'S' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    expect(board.row(c.id).branch).toBeTruthy();
  });
});

describe('a worktree per card', () => {
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'worktrees' });
  });

  const commitIn = (path: string, file: string, msg: string) => {
    writeFileSync(join(path, file), msg);
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', msg);
  };

  test('cards work in parallel and land one after the other on main', async () => {
    const a = manual();
    const b = board.create({ kind: 'bugfix', title: 'Zweite Karte', x: 0, y: 0 });
    workers.start(a.id);
    workers.start(b.id);
    const wa = board.row(a.id).workspace!;
    const wb = board.row(b.id).workspace!;
    expect(wa).not.toBe(wb);
    commitIn(wa, 'a.ts', 'A');
    commitIn(wb, 'b.ts', 'B');
    for (const c of [a, b]) {
      runtime.sessions.find((s) => s.spec.cwd === board.row(c.id).workspace)!.call('ready_for_review', { summary: 'S' });
      await workers.approve(c.id);
      expect(state(c.id)).toBe('live');
    }
    // B was rebased onto A before the fast-forward
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['B', 'A', 'init']);
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', 'obeya/*')).toBe('');
  });

  test('a rebase conflict goes back to the worker with the files; a blocked checkout stays with the owner', async () => {
    const a = manual();
    const b = board.create({ kind: 'bugfix', title: 'Zweite Karte', x: 0, y: 0 });
    workers.start(a.id);
    workers.start(b.id);
    commitIn(board.row(a.id).workspace!, 'same.ts', 'A');
    commitIn(board.row(b.id).workspace!, 'same.ts', 'B');
    const sa = runtime.sessions.find((s) => s.spec.cwd === board.row(a.id).workspace)!;
    const sb = runtime.sessions.find((s) => s.spec.cwd === board.row(b.id).workspace)!;
    sa.call('ready_for_review', { summary: 'S' });
    await workers.approve(a.id);
    sb.call('ready_for_review', { summary: 'S' });
    await workers.approve(b.id);
    expect(state(b.id)).toBe('working');
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'error', code: 'landConflict' });
    expect(sb.inbox.at(-1)).toContain('conflicts in same.ts');

    // the owner has local edits in the Obeya checkout on a file the card changes
    const c = board.create({ kind: 'feature', title: 'Dritte', x: 0, y: 0 });
    workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'mine.ts', 'C');
    writeFileSync(join(main, 'mine.ts'), 'local edit');
    runtime.sessions.find((s) => s.spec.cwd === board.row(c.id).workspace)!.call('ready_for_review', { summary: 'S' });
    const err = await workers.approve(c.id).catch((e) => e);
    expect(err).toMatchObject({ code: 'landMerge' });
    expect(state(c.id)).toBe('waiting:review');
  });

  test('a stopped card keeps its worktree and picks it up again', () => {
    const a = manual();
    workers.start(a.id);
    const wa = board.row(a.id).workspace!;
    writeFileSync(join(wa, 'draft.ts'), 'draft');
    workers.stop(a.id);
    workers.start(a.id);
    expect(board.row(a.id).workspace).toBe(wa);
    expect(git(wa, 'status', '--porcelain')).toContain('draft.ts');
  });
});
