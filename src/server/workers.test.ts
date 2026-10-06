import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import type { RepoAdapter } from '../adapters/types';
import type { PlanDoc } from '../core/plan-doc';
import { BadRequest, Board } from './board';
import { Store } from './db';
import { DEMO_SKILL, OBEYA_PLUGIN } from './demo';
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
let docs: PlanDoc[];
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
  docs = [doc];
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => docs);
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
    env: { OBEYA_URL: 'http://127.0.0.1:4417' },
  });
}

beforeEach(() => setup({ ...generic, land: 'main', workspaces: 'clones', setup: 'bun install', checks: ['bun test'] }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const manual = () => board.create({ title: 'Zählerstände exportieren', x: 0, y: 0 });
const state = (id: string) => {
  const i = board.item(id)!;
  return i.need ? `${i.state}:${i.need}` : i.state;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('workers', () => {
  test("a follow-up's worker hears which card it comes from and that card's summary", () => {
    const src = manual();
    board.work(src.id, { state: 'live', detail: JSON.stringify({ summary: 'CSV-Export gebaut; Excel fehlt noch.' }) });
    const c = board.create({ title: 'Excel-Export', body: 'Excel fehlt.', from: src.id });
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
    // a repository without demos gets no demo skill
    expect(runtime.last.spec.plugins).toBeUndefined();
    // the only clone is taken
    const d = manual();
    expect(() => workers.start(d.id)).toThrow(BadRequest);
  });

  test('the screenshots of the task go with it when the worker starts', () => {
    const images = new Images(join(dir, 'images'));
    const shot = images.save(new Uint8Array([1, 2, 3]), 'image/png');
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: generic, imageFiles: (ids = []) => ids.flatMap((i) => images.path(i) ?? []) });
    const c = board.create({ title: 'Seite bricht um', x: 0, y: 0, images: [shot] });
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
    runtime.last.emit({ type: 'text', text: 'Dann CSV.' });
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

  test('stopping Obeya is announced like a restart, and the worker pauses until Obeya runs again', () => {
    const c = manual();
    workers.start(c.id);
    const busy = runtime.last;
    workers.restartDue({ reason: 'stop', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.at(-1)).toContain('Obeya is about to stop (the owner is shutting it down)');
    expect(busy.inbox.at(-1)).toContain('Obeya resumes you once it runs again');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Beenden von Obeya angekündigt; der Agent pausiert beim nächsten sicheren Punkt.' });
    busy.emit({ type: 'idle' });
    expect(workers.busy()).toBe(false);
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert, bis Obeya wieder läuft.' });
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

  test('a long option reaches the owner whole', () => {
    const c = manual();
    workers.start(c.id);
    const long = 'Die Prototypen bleiben stehen, „Diesen Prototyp bauen“ gibt es nach der Umwandlung aber nicht mehr. Sie lassen sich nur noch ansehen und verwerfen.';
    runtime.last.call('ask', { question: 'Was passiert mit den Prototypen?', options: [long, 'Verwerfen'] });
    expect(board.item(c.id)!.question!.options).toEqual([long, 'Verwerfen']);
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

  test('a note instead of an answer takes the question back: the worker goes on or asks anew', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    workers.message(c.id, 'Exportier erst mal gar nichts, ich kläre das.');
    expect(state(c.id)).toBe('working');
    expect(board.item(c.id)!.question).toBeUndefined();
    expect(runtime.last.inbox.at(-1)).toContain('withdraws your question („CSV oder Excel?“)');
    expect(runtime.last.inbox.at(-1)).toContain('Exportier erst mal gar nichts');
    // a remark is not a decision
    expect(board.decisionsOn(c.id)).toEqual([]);
    expect(() => workers.answer(c.id, 'CSV')).toThrow(BadRequest);
  });

  test('reply answers a note in the conversation, and the worker works on', () => {
    const c = manual();
    workers.start(c.id);
    workers.message(c.id, 'Bitte auch Excel.');
    expect(runtime.last.inbox.at(-1)).toContain('Bitte auch Excel.');
    expect(runtime.last.call('reply', { text: 'Mache ich: Excel kommt als zweites Format dazu.' })).toBe('Shown to the owner. Carry on.');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'talk', author: 'worker', text: 'Mache ich: Excel kommt als zweites Format dazu.' });
    expect(state(c.id)).toBe('working');
    // a reply is no handover: the turn ending after it is nudged
    runtime.last.emit({ type: 'text', text: 'Excel ist eingebaut.' });
    const before = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(before + 1);
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

  test('a session that fails again after the nudge goes to the owner with the reason', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich fange an.' });
    runtime.last.emit({ type: 'error', message: 'Not logged in · Please run /login' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    runtime.last.emit({ type: 'error', message: 'Not logged in · Please run /login' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question!.text).toContain('nicht angemeldet');
  });

  test('a worker the usage limit stopped goes on by itself once the limit lifts', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, limitMargin: 30 });
    const c = manual();
    workers.start(c.id);
    runtime.last.call('report', { status: 'Exporter steht' });
    runtime.last.emit({ type: 'text', text: 'Ich schreibe die Tests.' });
    const hit = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";
    runtime.last.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + 20 } });
    runtime.last.emit({ type: 'idle' });
    const sent = runtime.last.inbox.length;
    // no nudge, no question to the owner: the card waits for the limit, and a restart need not wait for it
    expect(state(c.id)).toBe('working');
    expect(workers.busy()).toBe(false);
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya' });
    expect(board.events(c.id).at(-1)!.text).toContain('automatisch weiter');
    await Bun.sleep(60);
    expect(runtime.last.inbox.length).toBe(sent + 1);
    expect(runtime.last.inbox.at(-1)).toContain('usage limit');
    expect(workers.busy()).toBe(true);
    // the limit still holds: it waits again, and its status line stays what it was before
    runtime.last.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + 10_000 } });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    runtime.last.emit({ type: 'text', text: 'Weiter mit den Tests.' });
    expect(board.item(c.id)!.statusLine).toBe('Exporter steht');
    workers.stop(c.id);
  });

  test('a worker the usage limit stopped is not woken once stopped', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, limitMargin: 10 });
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 20 } });
    runtime.last.emit({ type: 'idle' });
    const session = runtime.last;
    const sent = session.inbox.length;
    workers.stop(c.id);
    await Bun.sleep(40);
    expect(session.inbox.length).toBe(sent);
    expect(runtime.sessions.length).toBe(1);
  });

  test('a turn in which the worker did nothing does not use up its nudge', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 });
    const c = manual();
    workers.start(c.id);
    const before = runtime.last.inbox.length;
    // a resumed session first ends a turn over what the previous one left, before the worker's own
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(before);
    expect(workers.busy()).toBe(true);
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'node demo.ts' } });
    runtime.last.emit({ type: 'text', text: 'Die Demo wird neu gerendert.' });
    runtime.last.emit({ type: 'idle', background: 1 });
    await Bun.sleep(20);
    // the render outlasted the wait: the worker is nudged, its status is no question to the owner
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
  });

  test('a turn in which the worker did nothing counts as ended after a while', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 });
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'idle' });
    await Bun.sleep(20);
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
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

  test('a preference learned while a worker runs reaches it once, with its next tool step', () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, preferences: () => board.preferencesText() });
    board.addPreference('Antworten auf Deutsch.');
    const c = manual();
    workers.start(c.id);
    const s = runtime.last;
    expect(s.spec.system).toContain('- Antworten auf Deutsch.');
    expect(s.spec.system).toContain('Never wait with sleep or a polling loop in the foreground');
    // what its instructions hold is nothing new
    expect(s.toolStep()).toBeUndefined();
    const id = board.addPreference('Keine Commits ohne Tests.');
    expect(s.toolStep()).toContain('- Keine Commits ohne Tests.');
    expect(s.toolStep()).toBeUndefined();
    board.setPreference(id, null);
    expect(s.toolStep()).not.toContain('Keine Commits ohne Tests.');
    // silently: no message, no new turn
    expect(s.inbox).toHaveLength(1);
  });

  test('a worker that stopped and then works on by itself takes its question back', () => {
    const c = manual();
    workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich komme nicht weiter.' });
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
    runtime.last.call('propose_card', {
      title: 'Falsches Label',
      task: 'Der Knopf „Export“ heißt in src/ui/strings.ts noch „Exportieren“.',
      reason: 'Gesehen beim Testen.',
      questions: [{ question: 'Welches Wort?', options: ['Export', 'Exportieren'] }],
    });
    const p = board.snapshot().items.find((i) => i.state === 'proposal')!;
    // the text is for the agent that takes the card on; why stays with the proposal, for the owner
    expect(p).toMatchObject({
      title: 'Falsches Label',
      from: c.id,
      body: 'Der Knopf „Export“ heißt in src/ui/strings.ts noch „Exportieren“.',
      proposal: { reason: 'Gesehen beim Testen.', questions: [{ text: 'Welches Wort?', options: ['Export', 'Exportieren'] }] },
    });
    expect(p.y).toBeGreaterThan(c.y);
    board.accept(p.id);
    expect(state(p.id)).toBe('planned');
    expect(board.item(p.id)!.proposal).toBeUndefined();
    expect(board.item(p.id)!.body).toBe('Der Knopf „Export“ heißt in src/ui/strings.ts noch „Exportieren“.\n\nOffene Fragen:\n- Welches Wort? (Export / Exportieren)');
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
  const demo = (d: string, chapters = ['Vorher', 'Nachher']) => ({ dir: d, chapters, question: 'Semikolon oder Komma?' });

  test('the worker gets the demo skill from the plugin that comes with Obeya, its brief names it, and it knows where Obeya is', () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones', demo: { required: true, howToRun: 'bun start' } });
    const c = manual();
    workers.start(c.id);
    expect(runtime.last.spec.plugins).toEqual([OBEYA_PLUGIN]);
    // a demo's narration finds Obeya, which holds the voice across renders
    expect(runtime.last.spec.env).toEqual({ OBEYA_URL: 'http://127.0.0.1:4417' });
    expect(existsSync(join(OBEYA_PLUGIN, 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(runtime.last.inbox[0]).toContain(`recorded with the demo skill (\`${DEMO_SKILL}\`)`);
  });

  test('the card waits with the demo; its files are found; feedback leaves the demo to the worker', () => {
    const c = manual();
    workers.start(c.id);
    const d = demoDir();
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: demo(d) })).toContain('End your turn');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.demo).toEqual({ kind: 'video', chapters: [[0, 'Vorher'], [6, 'Nachher']], question: 'Semikolon oder Komma?' });
    expect(board.item(c.id)!.summary).toBe('S');
    expect(board.demoFiles(c.id)).toEqual({ dir: d, kind: 'video' });
    workers.message(c.id, 'Bitte mit Kopfzeile.');
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('your demo stays on it');
    // the demo stays with the card while it is reworked and after it is done
    expect(board.demoFiles(c.id)).toEqual({ dir: d, kind: 'video' });
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

  test('where demos are shared, a video or an artifact comes with its page for colleagues, kept with the demo', () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones', demo: { required: true, howToRun: 'bun start', share: ['share'] } });
    const c = manual();
    workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('share the demo, a video or an HTML artifact, with colleagues');
    const d = demoDir();
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: demo(d) })).toContain('needs its page');
    expect(state(c.id)).toBe('working');
    const page = { title: 'Zählerstände als CSV', text: 'Vermieter laden die Zählerstände jetzt als CSV herunter.' };
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: { ...demo(d), page } })).toContain('End your turn');
    expect(board.item(c.id)!.demo!.page).toEqual(page);

    const a = join(dir, 'auswertung');
    Bun.spawnSync(['mkdir', '-p', a]);
    writeFileSync(join(a, 'index.html'), '<h2>Graph</h2>');
    const html = { kind: 'html', dir: a, shown: ['Graph'], not_shown: [], findings: [] };
    workers.message(c.id, 'Bitte als Auswertung.');
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: html })).toContain('needs its page');
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: { ...html, page } })).toContain('End your turn');
    // its index.html alone: it also goes out as one HTML file
    expect(board.item(c.id)!.demo).toMatchObject({ kind: 'html', page, single: true });
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

  test('an HTML artifact instead of a video: it needs its page', () => {
    const c = manual();
    workers.start(c.id);
    const d = join(dir, 'logos');
    Bun.spawnSync(['mkdir', '-p', join(d, 'img')]);
    const html = { kind: 'html', dir: d };
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: html })).toContain('index.html is missing');
    expect(state(c.id)).toBe('working');
    writeFileSync(join(d, 'index.html'), '<img src="img/a.svg">');
    writeFileSync(join(d, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: html })).toContain('End your turn');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.demo).toEqual({ kind: 'html', chapters: [] });
    expect(board.demoFiles(c.id)).toEqual({ dir: d, kind: 'html' });
  });

  test('without anything to show, the worker says why: the card waits for review without a demo', () => {
    rmSync(dir, { recursive: true, force: true });
    setup({ ...generic, land: 'main', workspaces: 'clones', demo: { required: true, howToRun: 'bun start' } });
    const c = manual();
    workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('no_demo');
    runtime.last.call('ready_for_review', { summary: 'S', demo: demo(demoDir()) });
    workers.message(c.id, 'Das gibt es doch schon?');
    expect(runtime.last.call('ready_for_review', { summary: 'S', demo: demo(demoDir()), no_demo: 'x' })).toContain('either');
    expect(runtime.last.call('ready_for_review', { summary: 'Gibt es schon.', no_demo: 'Das Feature ist bereits implementiert.' })).toContain('End your turn');
    expect(state(c.id)).toBe('waiting:review');
    expect(board.item(c.id)).toMatchObject({ summary: 'Gibt es schon.', noDemo: 'Das Feature ist bereits implementiert.' });
    // the earlier demo was of other work: it does not stay on the card
    expect(board.item(c.id)!.demo).toBeUndefined();
    expect(board.events(c.id).at(-1)!.text).toContain('Ohne Demo: Das Feature ist bereits implementiert.');
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
    expect(board.item(c.id)!.noChange).toBeUndefined();
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    expect(board.row(c.id).branch).toBeTruthy();
  });

  test('approving work that changed nothing makes the card done: no pull request, the worker hears so and finishes', async () => {
    const c = manual();
    workers.start(c.id);
    const s = runtime.last;
    s.call('ready_for_review', { summary: 'Demo aufgenommen, keine Code-Änderung.' });
    // the owner sees before approving that approval ends the card
    expect(board.item(c.id)!.noChange).toBe(true);
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(board.item(c.id)!.noChange).toBeUndefined();
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(s.inbox.at(-1)).toContain('nothing lands and there is no pull request: the card is done');
    expect(board.events(c.id).at(-1)!.text).toContain('erledigt');
    // a question while it finishes, answered, returns the card to done, not live
    s.call('ask', { question: 'Stack stoppen?' });
    s.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(s.closed).toBe(false);
    workers.answer(c.id, 'Ja.');
    expect(state(c.id)).toBe('done');
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
    expect(spaces.list().every((w) => !w.card_id)).toBe(true);
    // done counts as finished: it can be archived
    board.archive([c.id]);
    expect(board.item(c.id)).toBeUndefined();
  });

  test('a worker whose approved work turns out to change nothing closes the card itself instead of opening a pull request', async () => {
    const c = manual();
    workers.start(c.id);
    const s = runtime.last;
    expect(s.call('close_unchanged', {})).toContain('only work the owner approved');
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'x.ts'), '');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'X');
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('inPr');
    // with work on the branch, it goes out as a pull request
    expect(s.call('close_unchanged', {})).toContain('holds commits');
    git(clone, 'reset', '--quiet', '--hard', 'HEAD~1');
    expect(s.call('close_unchanged', {})).toContain('the card is done');
    expect(state(c.id)).toBe('done');
    expect(board.item(c.id)!.pr).toBeUndefined();
    expect(board.events(c.id).at(-1)).toMatchObject({ author: 'worker', text: 'Ohne Änderung am Code abgeschlossen: erledigt.' });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.row(c.id).workspace).toBeNull();
  });
});

describe('a prototype built on in a clone', () => {
  test('the idea takes over the clone and the branch, renamed; the clone is busy until it is done', () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' } });
    const idea = board.create({ idea: true, title: 'Logo', x: 0, y: 0 });
    const prototype = board.addPrototype(idea.id, 'Prototyp: Logo', 'zeigen');
    workers.start(prototype.id);
    const path = board.row(prototype.id).workspace!;
    const old = board.row(prototype.id).branch!;
    writeFileSync(join(path, 'logo.svg'), '<svg/>');
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', 'Prototyp');
    const moved = workers.buildOn(prototype.id, board.item(idea.id)!);
    expect(moved.path).toBe(path);
    expect(git(path, 'branch', '--show-current')).toBe(moved.branch);
    expect(git(path, 'branch', '--list', old)).toBe('');
    expect(git(path, 'log', '--format=%s', '-1')).toBe('Prototyp');
    expect(spaces.leasedBy(idea.id)).toBe(path);
    // the only clone is the idea's now
    expect(() => spaces.lease(board.create({ title: 'X', x: 0, y: 0 }).id, 'obeya/x')).toThrow('all are leased');
    // a prototype without a workspace has nothing to build on
    const bare = board.addPrototype(idea.id, 'Prototyp: leer', 'zeigen');
    expect(() => workers.buildOn(bare.id, board.item(idea.id)!)).toThrow(expect.objectContaining({ code: 'noWorkspace' }));
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
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
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

  test("an idea built on a prototype takes over its worktree and branch, and lands from there", async () => {
    const idea = board.create({ idea: true, title: 'Logo', x: 0, y: 0 });
    const prototype = board.addPrototype(idea.id, 'Prototyp: Logo – Wortmarke', 'Wortmarke');
    workers.start(prototype.id);
    const path = board.row(prototype.id).workspace!;
    const old = board.row(prototype.id).branch!;
    commitIn(path, 'logo.svg', 'Prototyp Wortmarke');
    const moved = workers.buildOn(prototype.id, board.item(idea.id)!);
    // the worktree stays where it is; its branch now has the idea's name
    expect(moved.path).toBe(path);
    expect(moved.branch).toMatch(/^obeya\/logo-/);
    expect(git(path, 'branch', '--show-current')).toBe(moved.branch);
    expect(git(main, 'branch', '--list', old)).toBe('');
    expect(spaces.leasedBy(idea.id)).toBe(path);
    expect(spaces.leasedBy(prototype.id)).toBeNull();
    expect(board.item(prototype.id)).toBeUndefined();
    expect(board.archived().find((i) => i.id === prototype.id)).toMatchObject({ prototypeEnd: 'built' });

    board.work(idea.id, { state: 'planned', workspace: moved.path, branch: moved.branch, built_on: prototype.id });
    workers.start(idea.id);
    expect(board.row(idea.id).workspace).toBe(path);
    const session = runtime.last;
    expect(session.spec.cwd).toBe(path);
    commitIn(path, 'logo.test.ts', 'Logo mit Tests');
    session.call('ready_for_review', { summary: 'S' });
    session.emit({ type: 'idle' });
    await workers.approve(idea.id);
    expect(state(idea.id)).toBe('live');
    session.emit({ type: 'idle' });
    // the prototype's commits are part of what landed; worktree and branch are gone
    expect(git(main, 'log', '--format=%s', '-3').split('\n')).toEqual(['Logo mit Tests', 'Prototyp Wortmarke', 'init']);
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', 'obeya/*')).toBe('');
  });

  test('a rebase conflict goes back to the worker with the files; a blocked checkout stays with the owner', async () => {
    const a = manual();
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
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
    const c = board.create({ title: 'Dritte', x: 0, y: 0 });
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
    const handOver = { summary: 'S', demo: { dir: demo, chapters: ['Eins'] } };
    const a = manual();
    const b = board.create({ title: 'Zweite Karte', x: 0, y: 0 });
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

  test('approving work without commits lands nothing: the card is done, main untouched, worktree and branch go', async () => {
    const c = manual();
    workers.start(c.id);
    const branch = board.row(c.id).branch!;
    const s = runtime.last;
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('done');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('init');
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(git(main, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(main, 'branch', '--list', branch)).toBe('');
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

  test('a turn after the landing that an error cut off is tried once more, then goes to the owner; the card does not finish', async () => {
    const c = manual();
    workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(false);
    expect(workers.busy()).toBe(true);
    expect(s.inbox.at(-1)).toContain('go on with what remained after the landing');
    s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
    s.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question!.text).toContain('529 Overloaded');
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(s.closed).toBe(false);
    // the question is no reason to put off a restart
    expect(workers.busy()).toBe(false);
    // the owner's answer has the worker try again; once it gets through, the card finishes
    workers.answer(c.id, 'Nochmal versuchen');
    expect(state(c.id)).toBe('live');
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/backfill.ts' } });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
  });

  test('a worker that works on by itself after its failed turn went to the owner takes the question back, and the card stays live', async () => {
    const c = manual();
    workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    for (let i = 0; i < 2; i++) {
      s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
      s.emit({ type: 'idle' });
    }
    expect(state(c.id)).toBe('waiting:question');
    s.emit({ type: 'text', text: 'Weiter.' });
    expect(state(c.id)).toBe('live');
  });

  test('a turn after the landing that an error cut off while a restart is due waits for the restart, which resumes it', async () => {
    const c = manual();
    workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    s.emit({ type: 'session', id: 'sess-1' });
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    workers.restartDue({ reason: 'code', deadline: Date.now() + 60_000 });
    const sent = s.inbox.length;
    s.emit({ type: 'error', message: 'API Error: 529 Overloaded' });
    s.emit({ type: 'idle' });
    // no second try that holds off the restart, and no end of the card either
    expect(s.inbox).toHaveLength(sent);
    expect(workers.busy()).toBe(false);
    expect(s.closed).toBe(false);
    expect(board.item(c.id)!.finishing).toBe(true);
    workers.shutdown();
    const after = new Workers({ board: new Board(store, board.canvas, () => [doc]), runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' } });
    after.resumeAll();
    expect(runtime.last).not.toBe(s);
    expect(runtime.last.spec.resume).toBe('sess-1');
  });

  test('a turn after the landing that the usage limit stopped waits for the limit and goes on; the card does not finish', async () => {
    workers = new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, limitMargin: 30 });
    const c = manual();
    workers.start(c.id);
    commitIn(board.row(c.id).workspace!, 'c.ts', 'C');
    const s = runtime.last;
    s.call('ready_for_review', { summary: 'S' });
    s.emit({ type: 'idle' });
    await workers.approve(c.id);
    const hit = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";
    s.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + 20 } });
    s.emit({ type: 'idle' });
    const sent = s.inbox.length;
    // no try that runs into the limit again, no question to the owner, and no end of the card either
    expect(state(c.id)).toBe('live');
    expect(s.closed).toBe(false);
    expect(workers.busy()).toBe(false);
    expect(board.item(c.id)!.finishing).toBe(true);
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    await Bun.sleep(60);
    expect(s.inbox).toHaveLength(sent + 1);
    expect(s.inbox.at(-1)).toContain('usage limit');
    expect(workers.busy()).toBe(true);
    // once it has done what remained, the card finishes
    s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun scripts/backfill.ts' } });
    expect(board.item(c.id)!.statusLine).toBeUndefined();
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
    expect(board.item(c.id)!.finishing).toBeUndefined();
  });

  test("an idea's plan doc that lands is remembered for the project it becomes", async () => {
    const i = board.create({ idea: true, title: 'Groß', x: 0, y: 0 });
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
    // the project takes the idea's place; the idea goes once its worker is done after the landing
    docs = [doc, { file: 'docs/plan/gross.md', title: 'Groß', goal: 'G', workstreams: [ws('W1')], markdown: '' }];
    board.docsChanged();
    expect(board.snapshot().items.find((p) => p.title === 'Groß' && p.kind === 'project')).toMatchObject({ origin: i.id, x: 0, y: 0 });
    expect(board.item(i.id)).toBeDefined();
    runtime.last.emit({ type: 'idle' });
    expect(board.item(i.id)).toMatchObject({ finishing: true });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(i.id)).toBeUndefined();
    expect(board.archived().map((a) => a.id)).toContain(i.id);
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
