import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { PlanDoc } from '../core/plan-doc';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { Images } from './images';
import { FakeRuntime, gitRepo, identify } from './testing';
import type { Reply } from './advisor';
import { Restarter } from './self-update';
import { Workers } from './workers';
import { GIT, git, Workspaces } from './workspaces';

const ws = (key: string) => ({ key, label: key, title: `Title ${key}`, body: 'Body', done: false, inReview: false });
const doc: PlanDoc = { file: 'docs/plan/a.md', title: 'A', goal: 'Goal', workstreams: [ws('W1')], markdown: '' };

let dir: string;
let main: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let projectReply: Reply | null;
let spaces: Workspaces;
let store: Store;

function setup(adapter: RepoAdapter) {
  dir = mkdtempSync(join(tmpdir(), 'obeya-workers-'));
  main = join(dir, 'main');
  gitRepo(main);
  store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => [doc]);
  const workspaces = new Workspaces(store, 'c', { mode: adapter.workspaces, repoPath: main, dir: join(dir, 'ws') });
  spaces = workspaces;
  if (adapter.workspaces === 'clones') {
    workspaces.ensureClones(main, 1);
    for (const w of workspaces.list()) identify(w.path);
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
  test("a follow-up's worker hears which card it comes from and that card's summary", () => {
    const src = manual();
    board.work(src.id, { state: 'live', detail: JSON.stringify({ summary: 'CSV-Export gebaut; Excel fehlt noch.' }) });
    const c = board.create({ kind: 'bugfix', title: 'Excel-Export', body: 'Excel fehlt.', from: src.id });
    workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('Excel fehlt.');
    expect(runtime.last.inbox[0]).toContain('This card follows up on the card “Zählerstände exportieren”. Its worker handed it over with this summary:\n\nCSV-Export gebaut; Excel fehlt noch.');
  });

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

  test('the screenshots of the task go with it when the worker starts', () => {
    const images = new Images(join(dir, 'images'));
    const shot = images.save(new Uint8Array([1, 2, 3]), 'image/png');
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: generic, imageFiles: (ids = []) => ids.flatMap((i) => images.path(i) ?? []) });
    const c = board.create({ kind: 'bugfix', title: 'Seite bricht um', x: 0, y: 0, images: [shot] });
    workers.start(c.id);
    expect(runtime.last.images[0]).toEqual([images.path(shot)!]);
    expect(runtime.last.inbox[0]).toContain(`The owner attached a screenshot to the card (shown with this message; files: ${images.path(shot)})`);
  });

  test('a worker is busy from a message to the end of the turn it starts', () => {
    const c = manual();
    workers.start(c.id);
    expect(workers.busy()).toBe(true);
    expect(workers.busyCards()).toEqual([c.id]);
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'idle' });
    expect(workers.busy()).toBe(false);
    expect(workers.busyCards()).toEqual([]);
    workers.answer(c.id, 'CSV');
    expect(workers.busy()).toBe(true);
    runtime.last.emit({ type: 'idle' });
    // the nudge starts a turn as well
    expect(workers.busy()).toBe(true);
    runtime.last.emit({ type: 'idle' });
    expect(workers.busy()).toBe(false);
    // a turn Obeya did not start, e.g. after a background command finished
    runtime.last.emit({ type: 'text', text: 'Fertig gerendert.' });
    expect(workers.busy()).toBe(true);
  });

  test('a due restart is announced to busy workers, who pause for it instead of being nudged', () => {
    const c = manual();
    workers.start(c.id);
    const busy = runtime.last;
    busy.emit({ type: 'text', text: 'Ich lasse die Tests laufen.' });
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.at(-1)).toContain('Obeya is about to restart (new code landed on main)');
    expect(busy.inbox.at(-1)).toContain('at most 15 more minutes');
    // heard once, however often the restart's waiting list changes
    const told = busy.inbox.length;
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.length).toBe(told);
    // the worker ends its turn without handing over: it paused, the owner is not asked
    busy.emit({ type: 'idle' });
    expect(workers.busy()).toBe(false);
    expect(busy.inbox.length).toBe(told);
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert bis zum Neustart von Obeya.' });
  });

  test('a restart goes ahead once the workers it announced itself to have paused', async () => {
    const c = manual();
    workers.start(c.id);
    let gone = 0;
    const restarter = new Restarter({ busy: () => workers.busyCards().map((card) => ({ canvas: 'c', card })), go: () => gone++, intervalMs: 5 });
    restarter.onChange(() => {
      const due = restarter.due();
      workers.restartDue(due && { reason: due.reason, deadline: due.deadline });
    });
    restarter.request('code');
    expect(runtime.last.inbox.at(-1)).toContain('Obeya is about to restart');
    await Bun.sleep(20);
    expect(gone).toBe(0);
    runtime.last.emit({ type: 'idle' });
    await Bun.sleep(20);
    expect(gone).toBe(1);
  });

  test('a turn that starts while a restart is due hears of it with its message', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'idle' });
    // not in a turn: nothing to pause
    workers.restartDue({ reason: 'config', deadline: Date.now() + 60_000 });
    const before = runtime.last.inbox.length;
    expect(runtime.last.inbox.at(-1)).not.toContain('about to restart');
    workers.answer(c.id, 'CSV');
    expect(runtime.last.inbox.length).toBe(before + 1);
    expect(runtime.last.inbox.at(-1)).toContain('Answer to your question');
    expect(runtime.last.inbox.at(-1)).toContain('Obeya is about to restart (the owner saved a new configuration)');
    expect(runtime.last.inbox.at(-1)).toContain('at most 1 more minute.');
  });

  test('a worker started while a restart is due hears of it in its briefing', () => {
    workers.restartDue({ reason: 'code', deadline: Date.now() + 10 * 60_000 });
    const c = manual();
    workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
    expect(runtime.last.inbox[0]).toContain('Obeya is about to restart');
  });

  test('without a restart due, a turn that ends without handing over is nudged as before', () => {
    const c = manual();
    workers.start(c.id);
    workers.restartDue(null);
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
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

  test('a question may let the owner choose several options', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'Welche Spalten?', options: ['Datum', 'Stand', 'Zähler'], multiple: true });
    expect(board.item(c.id)!.question).toEqual({ text: 'Welche Spalten?', options: ['Datum', 'Stand', 'Zähler'], multiple: true });
    expect(board.events(c.id).at(-1)!.text).toContain('Mehrfachauswahl');
    workers.answer(c.id, 'Datum, Stand');
    expect(runtime.last.inbox.at(-1)).toContain('Datum, Stand');
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

  test('a turn that ends while background work runs waits for it, not for the owner', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Das Video rendert noch, ich warte darauf.' });
    const before = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle', background: 1 });
    runtime.last.emit({ type: 'idle', background: 1 });
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.length).toBe(before);
    // a restart now would cut the render off
    expect(workers.busy()).toBe(true);
    // the render ends and wakes the worker, which hands over
    runtime.last.emit({ type: 'text', text: 'Video fertig.' });
    runtime.last.call('ready_for_review', { summary: 'Fertig.' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:review');
  });

  test('background work that never wakes the worker counts as an ended turn after a while', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 });
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich warte auf den Server.' });
    runtime.last.emit({ type: 'idle', background: 1 });
    await Bun.sleep(20);
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
    runtime.last.emit({ type: 'idle', background: 1 });
    await Bun.sleep(20);
    expect(state(c.id)).toBe('waiting:question');
    expect(workers.busy()).toBe(false);
    expect(board.item(c.id)!.question!.text).toBe('Ich warte auf den Server.');
  });

  test('a worker that asks while its background work runs counts as busy until the work wakes it', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 });
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'Soll das Video Ton haben?' });
    runtime.last.emit({ type: 'idle', background: 1 });
    // the question reaches the owner at once, but a restart now would cut the render off
    expect(state(c.id)).toBe('waiting:question');
    expect(workers.busy()).toBe(true);
    await Bun.sleep(20);
    // a watcher nobody stopped does not keep a restart away for good
    expect(workers.busy()).toBe(false);
    expect(state(c.id)).toBe('waiting:question');
  });

  test('a note to a worker waiting for its background work starts a turn of its own', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 });
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'idle', background: 1 });
    const before = runtime.last.inbox.length;
    workers.message(c.id, 'Nimm die dunkle Variante.');
    await Bun.sleep(20);
    // the wait ended with the note, not with a nudge in the middle of the note's turn
    expect(runtime.last.inbox.length).toBe(before + 1);
    expect(workers.busy()).toBe(true);
  });

  test('a worker that stopped and then works on by itself takes its question back', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'ls' } });
    expect(state(c.id)).toBe('working');
    // a question it asks itself stays with the owner
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'text', text: 'Ich warte auf die Antwort.' });
    expect(state(c.id)).toBe('waiting:question');
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
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Export');
    // the worker hears that its work is on main; its session ends with that turn
    expect(runtime.last.inbox.at(-1)).toContain('is on main now');
    expect(runtime.last.closed).toBe(false);
    runtime.last.emit({ type: 'idle' });
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

  test('the card waits with the demo; its files are found; feedback leaves the demo to the worker', () => {
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
    expect(runtime.last.inbox.at(-1)).toContain('your demo stays on it');
    // the demo stays with the card while it is reworked and after it is done
    expect(board.demoDir(c.id)).toBe(d);
    expect(board.item(c.id)!.demo!.chapters).toHaveLength(2);
  });

  test('the question in the demo report is answered on the card; the demo still waits for approval', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ready_for_review', { summary: 'S', demo: demo(demoDir()) });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(c.id)!.question).toEqual({ text: 'Semikolon oder Komma?', options: [] });
    const n = runtime.last.inbox.length;
    workers.answer(c.id, 'Semikolon.');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.question).toBeUndefined();
    expect(board.item(c.id)!.demo!.answer).toBe('Semikolon.');
    expect(runtime.last.inbox.at(-1)).toContain('answered the question in your demo report');
    expect(runtime.last.inbox.at(-1)).toContain('Semikolon.');
    // the worker takes note and ends its turn: no nudge, the card keeps waiting
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox).toHaveLength(n + 1);
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.decisions(null).at(-1)).toMatchObject({ question: 'Semikolon oder Komma?', answer: 'Semikolon.', by: 'owner' });
    expect(() => workers.answer(c.id, 'Komma.')).toThrow(BadRequest);
  });

  test('after feedback, the worker may hand over again without a new demo: the one on the card stands', () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones', demo: { required: true, howToRun: 'bun start' } });
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ready_for_review', { summary: 'S', demo: demo(demoDir()) });
    workers.message(c.id, 'Nur den Text ändern.');
    expect(runtime.last.call('ready_for_review', { summary: 'Text geändert.' })).toContain('End your turn');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.summary).toBe('Text geändert.');
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
      const session = runtime.sessions.find((s) => s.spec.cwd === board.row(c.id).workspace)!;
      session.call('ready_for_review', { summary: 'S' });
      session.emit({ type: 'idle' });
      await workers.approve(c.id);
      expect(state(c.id)).toBe('live');
      session.emit({ type: 'idle' });
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

  test('an approval that could not land holds: the worker brings the branch up to date and it lands', async () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'worktrees', demo: { required: true, howToRun: 'bun start' } });
    const demo = join(dir, 'demo');
    mkdirSync(demo);
    writeFileSync(join(demo, 'demo.mp4'), '0');
    writeFileSync(join(demo, 'captions.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEins.\n');
    const handOver = { summary: 'S', demo: { dir: demo, chapters: ['Eins'], shown: [], not_shown: [], findings: [] } };
    const a = manual();
    const b = board.create({ kind: 'bugfix', title: 'Zweite Karte', x: 0, y: 0 });
    workers.start(a.id);
    workers.start(b.id);
    const wb = board.row(b.id).workspace!;
    commitIn(board.row(a.id).workspace!, 'same.ts', 'A');
    commitIn(wb, 'same.ts', 'B');
    const sa = runtime.sessions.find((s) => s.spec.cwd === board.row(a.id).workspace)!;
    const sb = runtime.sessions.find((s) => s.spec.cwd === wb)!;
    sa.call('ready_for_review', handOver);
    await workers.approve(a.id);
    sb.call('ready_for_review', handOver);
    await workers.approve(b.id);
    expect(state(b.id)).toBe('working');
    expect(sb.inbox.at(-1)).toContain('without asking the owner again');

    // the worker resolves the conflict and hands over again, without a new demo
    expect(() => git(wb, 'rebase', '--quiet', 'main')).toThrow();
    writeFileSync(join(wb, 'same.ts'), 'A and B');
    git(wb, 'add', '.');
    Bun.spawnSync([GIT, '-C', wb, '-c', 'core.editor=true', 'rebase', '--continue']);
    expect(sb.call('ready_for_review', { summary: 'Konflikt gelöst' })).toContain('lands your work');
    expect(state(b.id)).toBe('working');
    sb.emit({ type: 'idle' });
    expect(state(b.id)).toBe('live');
    expect(git(main, 'show', 'HEAD:same.ts')).toBe('A and B');
    expect(board.events(b.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya', text: 'Nach der Freigabe auf main gelandet.' });
    expect(board.row(b.id).approved_at).toBeNull();
  });

  test('feedback instead of an approval is reviewed again; a blocked checkout waits for the owner', async () => {
    const c = manual();
    workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    commitIn(main, 'c.ts', 'main');
    const sc = runtime.last;
    sc.call('ready_for_review', { summary: 'S' });
    await workers.approve(c.id);
    expect(board.row(c.id).approved_at).toBeTruthy();
    git(wc, 'reset', '--quiet', '--hard', 'main');
    commitIn(wc, 'c.ts', 'C on main');

    // the Obeya checkout moved off main in the meantime: the card waits and needs a new approval
    git(main, 'checkout', '--quiet', '-b', 'elsewhere');
    sc.call('ready_for_review', { summary: 'S' });
    expect(state(c.id)).toBe('working');
    sc.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:review');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'error', code: 'landCheckout' });
    expect(board.row(c.id).approved_at).toBeNull();

    // feedback while it waits: what comes back is reviewed, not landed
    git(main, 'checkout', '--quiet', 'main');
    workers.message(c.id, 'Bitte noch anders.');
    sc.call('ready_for_review', { summary: 'S' });
    sc.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:review');
  });

  test('commits that conflict one by one but not as a whole land as one commit', async () => {
    const c = manual();
    workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    const trailer = 'Co-Authored-By: W <w@example.com>';
    writeFileSync(join(wc, 'same.ts'), 'C draft');
    git(wc, 'add', '.');
    git(wc, 'commit', '--quiet', '-m', 'C draft', '-m', trailer);
    git(wc, 'rm', '--quiet', 'same.ts');
    writeFileSync(join(wc, 'c.ts'), 'C');
    git(wc, 'add', '.');
    git(wc, 'commit', '--quiet', '-m', 'C', '-m', trailer);
    commitIn(main, 'same.ts', 'main');
    runtime.last.call('ready_for_review', { summary: 'S' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['C draft', 'main', 'init']);
    expect(git(main, 'log', '--format=%B', '-1')).toBe(`C draft\n\nC\n\n${trailer}`);
    expect(git(main, 'show', 'HEAD:same.ts')).toBe('main');
    expect(git(main, 'show', 'HEAD:c.ts')).toBe('C');
  });

  test('after landing, the worker finishes what remains in its worktree; then worktree and branch go', async () => {
    const c = manual();
    workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    const branch = board.row(c.id).branch!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(s.inbox.at(-1)).toContain('is on main now');
    expect(s.inbox.at(-1)).not.toContain('after_restart');
    // its worktree is still there, at what landed
    expect(git(wc, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'HEAD'));
    expect(s.call('ready_for_review', { summary: 'S' })).toContain('on main already');
    // the owner can still reach it, and it works on
    workers.message(c.id, 'Auch die alten Karten nachtragen.');
    expect(s.inbox.at(-1)).toContain('Auch die alten Karten nachtragen.');
    expect(s.call('after_restart', {})).toContain('does not start again');
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/backfill.ts' } });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
    expect(board.row(c.id).workspace).toBeNull();
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', branch)).toBe('');
  });

  test('a worker whose remaining work needs the new code waits for the restart and goes on after it', async () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'worktrees' });
    const restarting = (b: Board) =>
      new Workers({ board: b, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, restartsFor: () => true });
    workers = restarting(board);
    const c = manual();
    workers.start(c.id);
    const wc = board.row(c.id).workspace!;
    commitIn(wc, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(s.inbox.at(-1)).toContain('call after_restart');
    expect(s.call('after_restart', {})).toContain('Recorded');
    s.emit({ type: 'idle' });
    // it waits, and is no reason to put off the restart
    expect(s.closed).toBe(false);
    expect(workers.busy()).toBe(false);
    expect(board.item(c.id)!.finishing).toBe(true);

    // Obeya starts again: the worker resumes its session in the worktree it had
    workers.shutdown();
    const after = restarting(new Board(store, board.canvas, () => [doc]));
    after.resumeAll();
    const resumed = runtime.last;
    expect(resumed).not.toBe(s);
    expect(resumed.spec.resume).toBe('sess-1');
    expect(resumed.spec.cwd).toBe(wc);
    expect(resumed.inbox[0]).toContain('runs main with your change now');
    resumed.emit({ type: 'idle' });
    expect(resumed.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
    expect(board.row(c.id).landed).toBeNull();
  });

  test('stopping a worker that finishes after the landing frees its worktree; the card stays live', async () => {
    const c = manual();
    workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    runtime.last.call('ready_for_review', { summary: 'S' });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    workers.stop(c.id);
    expect(state(c.id)).toBe('live');
    expect(runtime.last.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test("an idea's plan doc that lands is remembered for the project it becomes", async () => {
    const i = board.create({ kind: 'feature', idea: true, title: 'Groß', x: 0, y: 0 });
    board.work(i.id, { state: 'planned' });
    workers.start(i.id);
    const wi = board.row(i.id).workspace!;
    mkdirSync(join(wi, 'docs/plan'), { recursive: true });
    writeFileSync(join(wi, 'docs/plan/README.md'), 'x');
    commitIn(wi, 'docs/plan/gross.md', '# Groß');
    runtime.last.call('ready_for_review', { summary: 'S' });
    await workers.approve(i.id);
    expect(state(i.id)).toBe('live');
    expect(JSON.parse(board.row(i.id).plan_docs!)).toEqual(['docs/plan/README.md', 'docs/plan/gross.md']);
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
