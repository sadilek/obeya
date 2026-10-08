import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { Board } from './board';
import { Store } from './db';
import { FakeRuntime, type FakeSession, gitRepo } from './testing';
import { WorkRetro } from './work-retro';
import { Workers } from './workers';
import { Workspaces } from './workspaces';

const SAMPLE = join(import.meta.dir, 'fixtures', 'transcript.jsonl');

let dir: string;
let main: string;
let board: Board;
let runtime: FakeRuntime;
let retro: WorkRetro;
let workers: Workers;
/** The transcript file of each session id; the others have none. */
let files: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-wr-'));
  main = gitRepo(join(dir, 'main'));
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => []);
  runtime = new FakeRuntime();
  files = {};
  retro = new WorkRetro({ board, runtime, pathFor: () => main, transcript: (id) => files[id] ?? null, every: 3 });
  const workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') });
  workers = new Workers({ board, runtime, workspaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, onWorkEnded: (id, ws) => retro.ended(id, ws) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 5));
const noteSessions = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'note'));
const retroSessions = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'card'));

/** A card that ran in the given sessions and whose work ended. */
function ran(title: string, ...sessions: string[]) {
  const c = board.create({ title, x: 0, y: 0 });
  sessions.slice(0, -1).forEach((s) => board.log(c.id, 'state', 'obeya', `Von vorn gestartet. Der frühere Lauf (Sitzung ${s}) bleibt für die Arbeitsrückschau erhalten.`));
  if (sessions.length) board.work(c.id, { session_id: sessions.at(-1)! });
  retro.ended(c.id);
  return c;
}

/** Answers the open notes session with these notes. */
async function note(...notes: { what: string; cost?: string; fix?: string }[]) {
  await settle();
  const s = noteSessions().at(-1)! as FakeSession;
  for (const n of notes) s.call('note', { cost: 'a few steps', fix: 'a script', ...n });
  s.call('done', {});
  s.emit({ type: 'idle' });
  await settle();
}

describe('Arbeitsrückschau', () => {
  test('a finished card’s runs become friction notes, written as a small job from the excerpt', async () => {
    files = { s1: SAMPLE };
    const a = ran('A', 's1', 's2');
    await settle();
    const s = noteSessions()[0]!;
    expect(s.spec).toMatchObject({ readOnly: true, role: 'chores', cwd: main });
    // the earlier run's transcript is read too; the later one has none
    expect(s.inbox[0]).toContain('The card: "A"');
    expect(s.inbox[0]).toContain("unknown option '--port=4500'");
    await note({ what: 'bun run dev has no --port flag' }, { what: 'the demo script failed and was rewritten' });
    expect(board.friction('home', null)).toMatchObject([
      { cardId: a.id, title: 'A', what: 'bun run dev has no --port flag', cost: 'a few steps', fix: 'a script' },
      { cardId: a.id, what: 'the demo script failed and was rewritten' },
    ]);
    expect(board.events(a.id).at(-1)).toMatchObject({ author: 'koordinator', text: 'Arbeitsrückschau, Reibung notiert:\n– bun run dev has no --port flag Kosten: a few steps Verhindert hätte es: a script\n– the demo script failed and was rewritten Kosten: a few steps Verhindert hätte es: a script' });
  });

  test('a run without a transcript, or without anything gone wrong, gets no session; a card that never ran does not count', async () => {
    ran('Never ran');
    ran('No transcript', 's9');
    await settle();
    expect(noteSessions()).toHaveLength(0);
    expect(board.setting('work_retro_cards:home')).toBe('1');
  });

  test('every few finished cards a retrospective in the repository proposes cards and CLAUDE.md lines for friction on two cards or more', async () => {
    files = { a: SAMPLE, b: SAMPLE };
    ran('A', 'a');
    await note({ what: 'wrong flag for the dev server' });
    ran('B', 'b');
    await note({ what: 'wrong flag for the dev server again' });
    expect(retroSessions()).toHaveLength(0);
    ran('C', 'c');
    await settle();
    const s = retroSessions()[0]! as FakeSession;
    expect(s.spec).toMatchObject({ readOnly: true, cwd: main });
    expect(s.spec.model).toBeUndefined();
    expect(s.inbox[0]).toContain('K1 "A":\n- wrong flag for the dev server');
    expect(s.inbox[0]).toContain('K2 "B":');
    expect(board.setting('work_retro_cards:home')).toBe('0');

    expect(s.call('card', { title: 'Skript für den Dev-Server', body: 'Baue es.', basis: 'Nur A.', cards: ['K1'] })).toContain('at least two cards');
    expect(s.call('card', { title: 'Skript `scripts/dev.ts` für den Dev-Server', body: 'Ein Skript, das den Server startet.', basis: 'Auf „A“ und „B“ falsche Flags.', cards: ['K1', 'K2', 'K7'] })).toBe('Proposed.');
    expect(s.call('rule', { rule: 'Der Dev-Server startet mit -p <port>.', basis: 'Auf „A“ und „B“ falsche Flags.', cards: ['K1', 'K2'] })).toBe('Proposed.');
    s.call('card', { title: 'Noch eins', body: '…', basis: '…', cards: ['K1', 'K2'] });
    expect(s.call('card', { title: 'Zu viel', body: '…', basis: '…', cards: ['K1', 'K2'] })).toContain('At most 3');
    s.emit({ type: 'idle' });

    const card = board.snapshot().items.find((i) => i.title === 'Skript `scripts/dev.ts` für den Dev-Server')!;
    expect(card).toMatchObject({ state: 'proposal', retro: 'Auf „A“ und „B“ falsche Flags.', repo: 'home' });
    expect(card.from).toBeUndefined();
    expect(card.body).toContain('Ein Skript, das den Server startet.');
    expect(board.events(card.id).at(-1)!.text).toContain(`Karten: „A“, „B“.`);
    expect(board.preferences('proposed')).toMatchObject([{ text: 'Der Dev-Server startet mit -p <port>.', target: 'home', review: true }]);
  });

  test('the next retrospective reads only the newer notes, and hears of proposals dismissed before', async () => {
    files = { a: SAMPLE, b: SAMPLE, c: SAMPLE };
    ran('A', 'a');
    await note({ what: 'old friction' });
    retro.now('home');
    await settle();
    const first = retroSessions()[0]! as FakeSession;
    first.call('card', { title: 'Skill für Demos', body: '…', basis: 'Demos scheitern.', cards: ['K1', 'K1'] });
    first.emit({ type: 'idle' });
    await settle();
    // a proposal needs two different cards
    expect(board.snapshot().items.filter((i) => i.retro)).toHaveLength(0);
    const p = board.proposeRetro('home', { title: 'Skill für Demos', body: '…', basis: 'Demos scheitern auf A und B.' });
    board.remove(p.id);
    const q = board.proposeRetro('home', { title: 'Skript für Starts', body: '…', basis: 'Starts dauern.' });
    board.accept(q.id);

    ran('B', 'b');
    await note({ what: 'new friction' });
    retro.now('home');
    await settle();
    const second = retroSessions()[1]!;
    expect(second.inbox[0]).toContain('new friction');
    expect(second.inbox[0]).not.toContain('old friction');
    expect(second.inbox[0]).toContain('dismissed (do not propose them again, in other words either):\n- card "Skill für Demos" (Demos scheitern auf A und B.)');
    expect(second.inbox[0]).toContain('- card "Skript für Starts" (taken)');
  });

  test('asked for with nothing noted, the owner hears so', async () => {
    const notices: string[] = [];
    board.onNotice((n) => notices.push(n.text));
    board.setSetting('work_retro_cards:home', '2');
    retro.now('home');
    await retro.idle();
    expect(retroSessions()).toHaveLength(0);
    expect(notices).toEqual(['Arbeitsrückschau für Home: Seit der letzten gibt es keine Reibung zu lesen.']);
    expect(board.setting('work_retro_cards:home')).toBe('0');
  });

  test('a card started again from scratch keeps its earlier run, and its work ending reads both', async () => {
    files = { s1: SAMPLE, s2: SAMPLE };
    const c = board.create({ title: 'Neu gestartet', x: 0, y: 0 });
    workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 's1' });
    workers.stop(c.id);
    workers.start(c.id);
    expect(board.events(c.id).some((e) => e.text.includes('(Sitzung s1) bleibt für die Arbeitsrückschau erhalten'))).toBe(true);
    const worker = runtime.last;
    worker.emit({ type: 'session', id: 's2' });
    worker.call('ready_for_review', { summary: 'Fertig.' });
    worker.emit({ type: 'idle' });
    // approved without a change: nothing lands, and the card is done once its worker's turn ends
    await workers.approve(c.id);
    worker.emit({ type: 'idle' });
    await settle();
    const s = noteSessions()[0]!;
    expect(s.inbox[0]).toContain("The excerpt of its worker's 2 runs");
    expect(s.inbox[0]).toContain('Run 1 of 2');
  });
});
