import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { cardTag } from '../core/card-number';
import { Board } from './board';
import { Store } from './db';
import { artifact, FakeRuntime, type FakeSession, gitRepo } from './testing';
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
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  runtime = new FakeRuntime();
  files = {};
  retro = new WorkRetro({ board, runtime, pathFor: () => main, transcript: (id) => files[id] ?? null, every: 3, ramp: [] });
  const workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') });
  workers = new Workers({ board, runtime, workspaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees' }, onWorkEnded: (id, ws) => retro.ended(id, ws) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 5));
/** The number a card goes by, as the retrospective names it. */
const tag = (c: { number: number }) => cardTag(c.number);
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

  test("a card whose earlier run was on Codex has that thread's excerpt read too", async () => {
    files = { 'codex:01a1a634-1526-77c0-b3ba-30c136b024f5': join(import.meta.dir, 'fixtures', 'codex-thread.jsonl') };
    ran('On Codex', 'codex:01a1a634-1526-77c0-b3ba-30c136b024f5', 's2');
    await settle();
    expect(noteSessions()[0]!.inbox[0]).toContain('The script fails; I write it anew.');
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
    const a = ran('A', 'a');
    await note({ what: 'wrong flag for the dev server' });
    const b = ran('B', 'b');
    await note({ what: 'wrong flag for the dev server again' });
    expect(retroSessions()).toHaveLength(0);
    ran('C', 'c');
    await settle();
    const s = retroSessions()[0]! as FakeSession;
    expect(s.spec).toMatchObject({ readOnly: true, cwd: main });
    expect(s.spec.model).toBeUndefined();
    expect(s.inbox[0]).toContain(`${tag(a)} "A":\n- wrong flag for the dev server`);
    expect(s.inbox[0]).toContain(`${tag(b)} "B":`);
    expect(board.setting('work_retro_cards:home')).toBe('0');

    expect(s.call('card', { title: 'Skript für den Dev-Server', body: 'Baue es.', basis: 'Nur A.', cards: [tag(a)] })).toContain('at least two cards');
    expect(s.call('card', { title: 'Skript `scripts/dev.ts` für den Dev-Server', body: 'Ein Skript, das den Server startet.', basis: 'Auf „A“ und „B“ falsche Flags.', cards: [tag(a), tag(b), 'K7'] })).toBe('Proposed.');
    expect(s.call('rule', { rule: 'Der Dev-Server startet mit -p <port>.', basis: 'Auf „A“ und „B“ falsche Flags.', cards: [tag(a), tag(b)] })).toBe('Proposed.');
    s.call('card', { title: 'Noch eins', body: '…', basis: '…', cards: [tag(a), tag(b)] });
    expect(s.call('card', { title: 'Zu viel', body: '…', basis: '…', cards: [tag(a), tag(b)] })).toContain('At most 3');
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
    const a = ran('A', 'a');
    await note({ what: 'old friction' });
    retro.now('home');
    await settle();
    const first = retroSessions()[0]! as FakeSession;
    first.call('card', { title: 'Skill für Demos', body: '…', basis: 'Demos scheitern.', cards: [tag(a), tag(a)] });
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

  test('workers who each worked out how to run the app: the retrospective proposes the recipe for „So läuft die App“', async () => {
    const now = { checks: ['bun test'], setup: '', softPaths: ['docs/'], run: '' };
    retro = new WorkRetro({ board, runtime, pathFor: () => main, transcript: (id) => files[id] ?? null, every: 2, ramp: [], settingsFor: () => now });
    board.showSettings(() => now);
    files = { a: SAMPLE, b: SAMPLE };
    const a = ran('Login-Seite', 'a');
    await settle();
    // the notes see what the repository's settings say, so a recipe worked out shows as friction with its value
    expect(noteSessions()[0]!.inbox[0]).toContain('- run ("How to run the app": the recipe every worker reads, in prose: how to start the app, what to do after which kind of change, where it gives its address, the login and test data for a demo): (empty)');
    await note({ what: 'searched how to start the app', fix: 'set run: bun run dev -p 4500' });
    const b = ran('Warenkorb', 'b');
    await note({ what: 'tried three ways to start the app', fix: 'set run: bun run dev -p 4500, log in as demo' });
    await settle();
    const s = retroSessions()[0]! as FakeSession;
    expect(s.inbox[0]).toContain("The repository's settings in Obeya now");
    expect(s.inbox[0]).toContain('- checks (the commands a worker runs before it hands its work over): "bun test"');
    expect(s.inbox[0]).toContain('- run ("How to run the app": the recipe every worker reads, in prose: how to start the app, what to do after which kind of change, where it gives its address, the login and test data for a demo): (empty)');

    expect(s.call('setting', { field: 'run', value: 'bun run dev -p 4500', basis: 'Nur einer.', cards: [tag(a)] })).toContain('at least two cards');
    expect(s.call('setting', { field: 'run', value: '  ', basis: '…', cards: [tag(a), tag(b)] })).toContain('value is missing');
    const recipe = 'bun run dev -p 4500\nAnmelden als demo@example.com';
    expect(s.call('setting', { field: 'run', value: recipe, basis: 'Auf „Login-Seite“ und „Warenkorb“ suchten die Agenten, wie die App startet.', cards: [tag(a), tag(b)] })).toBe('Proposed.');
    expect(s.call('setting', { field: 'run', value: 'anders', basis: '…', cards: [tag(a), tag(b)] })).toContain('already waits');
    expect(s.call('setting', { field: 'checks', value: 'bun test\nbun run typecheck\n', basis: '…', cards: [tag(a), tag(b)] })).toBe('Proposed.');
    s.emit({ type: 'idle' });

    expect(board.snapshot().settingProposals).toEqual([
      {
        id: expect.any(Number),
        repo: 'home',
        field: 'run',
        value: recipe,
        basis: 'Auf „Login-Seite“ und „Warenkorb“ suchten die Agenten, wie die App startet.',
        cards: [
          { id: a.id, title: 'Login-Seite' },
          { id: b.id, title: 'Warenkorb' },
        ],
        now: '',
      },
      expect.objectContaining({ field: 'checks', value: ['bun test', 'bun run typecheck'], now: ['bun test'] }),
    ]);
    // no card on the canvas: it waits with Obeya beside the rules
    expect(board.snapshot().items.filter((i) => i.state === 'proposal')).toHaveLength(0);

    // the next retrospective hears what became of them
    const [run, checks] = board.snapshot().settingProposals!;
    board.decideSetting(run!.id, 'rejected');
    board.decideSetting(checks!.id, 'repository');
    ran('Suche', 'a');
    await note({ what: 'again' });
    retro.now('home');
    await settle();
    const next = retroSessions()[1]!;
    expect(next.inbox[0]).toContain(`- setting run = ${JSON.stringify(recipe)} (Auf „Login-Seite“ und „Warenkorb“ suchten die Agenten, wie die App startet.)`);
    expect(next.inbox[0]).toContain('- setting checks = ["bun test","bun run typecheck"] (taken)');
  });

  test('a new repository’s first retrospectives come after its first finished card, 2 more and 4 more, then at the usual beat', async () => {
    retro = new WorkRetro({ board, runtime, pathFor: () => main, transcript: () => null, every: 3 });
    const runs: number[] = [];
    for (let i = 1; i <= 13; i++) {
      ran(`Karte ${i}`, `s${i}`);
      await retro.idle();
      if (board.setting('work_retro_runs:home') !== String(runs.length)) runs.push(i);
    }
    expect(runs).toEqual([1, 3, 7, 10, 13]);
    // the owner's own retrospective counts as one, and the count starts again
    retro.now('home');
    await retro.idle();
    expect([board.setting('work_retro_runs:home'), board.setting('work_retro_cards:home')]).toEqual(['6', '0']);
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
    await workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 's1' });
    await workers.stop(c.id);
    await workers.start(c.id);
    expect(board.events(c.id).some((e) => e.text.includes('(Sitzung s1) bleibt für die Arbeitsrückschau erhalten'))).toBe(true);
    const worker = runtime.last;
    worker.emit({ type: 'session', id: 's2' });
    await worker.call('ready_for_review', { summary: 'Fertig.', demo: artifact() });
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
