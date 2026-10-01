import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { Board } from './board';
import { Store } from './db';
import { Koordinator, overlaps } from './koordinator';
import { FakeRuntime, type FakeSession, gitRepo } from './testing';
import { Workers } from './workers';
import { git, parseChanges, Workspaces } from './workspaces';

let dir: string;
let board: Board;
let runtime: FakeRuntime;
let workers: Workers;
let workspaces: Workspaces;
let k: Koordinator;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-k-'));
  const main = join(dir, 'main');
  gitRepo(main);
  const store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: main, branch: 'main' }] }, () => []);
  const adapter = { ...generic, land: 'main' as const, workspaces: 'worktrees' as const, softPaths: ['docs/'] };
  workspaces = new Workspaces(store, 'c', { mode: 'worktrees', repoPath: main, dir: join(dir, 'ws') });
  runtime = new FakeRuntime();
  workers = new Workers({ board, runtime, workspaces, adapter });
  k = new Koordinator({ board, runtime, repoFor: () => ({ workers, workspaces, adapter, path: main }) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 5));
const card = (title: string) => board.create({ kind: 'feature', title, x: 0, y: 0 });
const item = (id: string) => board.item(id)!;
const estimates = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'scope'));
const workerOf = (id: string) => runtime.sessions.find((s) => s.spec.cwd === board.row(id).workspace)!;

/** Answers the latest open estimate. */
async function scope(files: string[], conflicts: string[] = [], reason = 'Grund.') {
  await settle();
  const s = estimates().at(-1) as FakeSession;
  s.call('scope', { files, conflicts_with: conflicts, reason });
  s.emit({ type: 'idle' });
  await settle();
}

describe('Koordinator', () => {
  test('a card with nothing in progress starts at once; its scope is estimated afterwards', async () => {
    const a = card('A');
    k.request(a.id);
    expect(item(a.id).queue).toMatchObject({ checking: true });
    await settle();
    expect(item(a.id).state).toBe('working');
    await scope(['src/a.ts']);
    expect(item(a.id)).toMatchObject({ state: 'working', scope: ['src/a.ts'] });
    expect(item(a.id).queue).toBeUndefined();
    expect(estimates()[0]!.spec).toMatchObject({ readOnly: true });
  });

  test('a card likely to conflict waits and starts when the other one has landed', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await settle();
    expect(estimates().at(-1)!.inbox[0]).toContain('"A"');
    await scope(['src/a.ts', 'src/b.ts'], ['K1'], 'Beide ändern decide() in src/a.ts.');
    expect(item(b.id)).toMatchObject({ state: 'planned', queue: { behind: [a.id], reason: 'Beide ändern decide() in src/a.ts.' } });

    const wa = board.row(a.id).workspace!;
    writeFileSync(join(wa, 'a.ts'), 'a');
    git(wa, 'add', '.');
    git(wa, 'commit', '--quiet', '-m', 'A');
    workerOf(a.id).call('ready_for_review', { summary: 'S' });
    await workers.approve(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('sharing a file is not enough: without a likely conflict the card starts, and says why', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/strings.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/strings.ts'], [], 'Beide ergänzen src/strings.ts, an verschiedenen Stellen.');
    expect(item(b.id).state).toBe('working');
    expect(board.events(b.id).some((e) => e.text.includes('Kein Merge-Konflikt') && e.text.includes('an verschiedenen Stellen'))).toBe(true);
  });

  test('the estimate sees where a card in progress has changed its files, without soft paths', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts', 'docs/plan.md']);
    const wa = board.row(a.id).workspace!;
    writeFileSync(join(wa, 'README.md'), 'hello\nworld\n');
    git(wa, 'add', '.');
    git(wa, 'commit', '--quiet', '-m', 'A');
    writeFileSync(join(wa, 'x.ts'), 'x');
    const b = card('B');
    k.request(b.id);
    await settle();
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('expected to change: src/a.ts\n');
    expect(brief).toContain('changed so far: README.md (lines 2 in hello), x.ts (new)');
    expect(brief).toContain('Changes under docs/ never count');
  });

  test('work approved into a pull request still holds its files until it is merged', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    board.work(a.id, { state: 'inPr' });
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], ['K1']);
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
    board.work(a.id, { state: 'live' });
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('an interrupted cut is taken up again after a restart', async () => {
    const a = card('A');
    board.work(a.id, { queue: JSON.stringify({ cutting: true }) });
    k.resume();
    await settle();
    expect(runtime.sessions.some((s) => s.spec.tools.some((t) => t.name === 'packages'))).toBe(true);
  });

  test('a waiting card is judged again against what started while it waited', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], ['K1']);
    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts']);
    expect(item(c.id).state).toBe('working');
    workers.stop(a.id);
    await settle();
    expect(item(b.id).queue).toMatchObject({ checking: true });
    expect(estimates().at(-1)!.inbox[0]).toContain('"C"');
    await scope(['src/a.ts'], ['K1'], 'Beide ändern dieselbe Funktion.');
    expect(item(b.id).queue).toMatchObject({ behind: [c.id] });
    workers.stop(c.id);
    await settle();
    expect(item(b.id).state).toBe('working');
  });

  test('two cards requested together are decided one after the other', async () => {
    const a = card('A');
    const b = card('B');
    k.request(a.id);
    k.request(b.id);
    await settle();
    expect(estimates()).toHaveLength(1);
    await scope(['src/shared.ts']);
    await scope(['src/shared.ts'], ['K1']);
    expect(item(a.id).state).toBe('working');
    expect(item(b.id).queue).toMatchObject({ behind: [a.id] });
  });

  test('force starts a waiting card, dequeue takes it out, stop frees the queue', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], ['K1']);
    k.dequeue(b.id);
    expect(item(b.id).queue).toBeUndefined();

    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts'], ['K1']);
    k.force(c.id);
    expect(item(c.id).state).toBe('working');

    const d = card('D');
    k.request(d.id);
    await scope(['src/a.ts'], ['K1', 'K2']);
    expect(item(d.id).queue).toMatchObject({ behind: [a.id, c.id] });
    workers.stop(a.id);
    await settle();
    expect(item(d.id).queue).toMatchObject({ behind: [c.id] });
    workers.stop(c.id);
    await settle();
    expect(item(d.id).state).toBe('working');
  });

  test('of the cards free to start, the one waiting longest goes first, and keeps its place while judged again', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    // the later card comes first on the board: its turn must still come second
    const later = card('Später');
    const first = card('Zuerst');
    k.request(first.id);
    await scope(['src/a.ts'], ['K1']);
    k.request(later.id);
    await scope(['src/a.ts'], ['K1']);
    expect(item(first.id).queue).toMatchObject({ behind: [a.id] });
    const since = item(later.id).queue!.since;
    expect(since! > item(first.id).queue!.since!).toBe(true);

    workers.stop(a.id);
    await settle();
    expect(item(first.id).state).toBe('working');
    expect(item(later.id).queue).toMatchObject({ checking: true, since });
    expect(estimates().at(-1)!.inbox[0]).toContain('"Zuerst"');
    await scope(['src/a.ts'], ['K1'], 'Beide ändern dieselbe Funktion.');
    expect(item(later.id).queue).toEqual({ behind: [first.id], reason: 'Beide ändern dieselbe Funktion.', since });

    workers.stop(first.id);
    await settle();
    expect(item(later.id).state).toBe('working');
  });

  test('a new card likely to conflict with a queued one waits behind it instead of overtaking it', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts', 'src/b.ts'], ['K1']);
    const c = card('C');
    k.request(c.id);
    await settle();
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('Cards queued ahead of this one');
    expect(brief).toContain('- K2: "B"\n  expected to change: src/a.ts, src/b.ts\n  waits for: "A"');
    await scope(['src/b.ts'], ['K2'], 'Beide ändern render() in src/b.ts.');
    expect(item(c.id).queue).toMatchObject({ behind: [b.id], reason: 'Beide ändern render() in src/b.ts.' });
    expect(board.events(c.id).some((e) => e.text.includes('„B“ (wartet selbst und ist vorher dran)'))).toBe(true);

    // B goes first; C waits for it to land, not only to start
    workers.stop(a.id);
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });
    workers.stop(b.id);
    await settle();
    expect(item(c.id).state).toBe('working');
  });

  test('a queued card judged again does not wait for cards queued after it', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts'], ['K1']);
    const d = card('D');
    k.request(d.id);
    await scope(['src/d.ts']);
    expect(item(d.id).state).toBe('working');
    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts'], ['K3']);
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });

    workers.stop(a.id);
    await settle();
    expect(item(b.id).queue).toMatchObject({ checking: true });
    const brief = estimates().at(-1)!.inbox[0]!;
    expect(brief).toContain('"D"');
    expect(brief).not.toContain('"C"');
    await scope(['src/a.ts']);
    expect(item(b.id).state).toBe('working');
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });
  });

  test('a card queued behind a waiting one starts when that one is taken out of the queue', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/a.ts', 'src/b.ts'], ['K1']);
    const c = card('C');
    k.request(c.id);
    await scope(['src/b.ts'], ['K2']);
    expect(item(c.id).queue).toMatchObject({ behind: [b.id] });
    k.dequeue(b.id);
    await settle();
    expect(item(c.id).queue).toMatchObject({ checking: true });
    await scope(['src/b.ts']);
    expect(item(c.id).state).toBe('working');
  });

  test('a card keeps its place in the queue while what it waits for changes', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await scope(['src/b.ts']);
    const c = card('C');
    k.request(c.id);
    await scope(['src/a.ts', 'src/b.ts'], ['K1', 'K2']);
    const since = item(c.id).queue!.since;
    expect(since).toBeString();
    workers.stop(a.id);
    await settle();
    expect(item(c.id).queue).toEqual({ behind: [b.id], reason: 'Grund.', since });
  });

  test('without an estimate the card still starts, and says why', async () => {
    const a = card('A');
    k.request(a.id);
    await scope(['src/a.ts']);
    const b = card('B');
    k.request(b.id);
    await settle();
    estimates().at(-1)!.emit({ type: 'idle' });
    await settle();
    expect(item(b.id).state).toBe('working');
    expect(board.events(b.id).some((e) => e.kind === 'error' && e.text.includes('nicht schätzen'))).toBe(true);
  });
});

describe('Koordinator cuts a card', () => {
  const cutSession = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'packages')).at(-1)!;

  test('into packages that replace it, each with its scope', async () => {
    const a = board.create({ kind: 'feature', title: 'Export', body: 'CSV und PDF', x: 100, y: 50 });
    k.split(a.id);
    expect(item(a.id).queue).toMatchObject({ cutting: true });
    await settle();
    expect(cutSession().inbox[0]).toContain('CSV und PDF');
    cutSession().call('packages', {
      packages: [
        { kind: 'feature', title: 'CSV-Export', body: 'CSV.', files: ['src/csv.ts'] },
        { kind: 'feature', title: 'PDF-Export', body: 'PDF.', files: ['src/pdf.ts'] },
      ],
      reason: 'Getrennte Dateien.',
    });
    cutSession().emit({ type: 'idle' });
    await settle();
    expect(board.item(a.id)).toBeUndefined();
    const made = board.snapshot().items.filter((i) => i.title.endsWith('-Export'));
    expect(made.map((m) => [m.title, m.state, m.scope])).toEqual([
      ['CSV-Export', 'planned', ['src/csv.ts']],
      ['PDF-Export', 'planned', ['src/pdf.ts']],
    ]);
    expect(made[0]).toMatchObject({ x: 100, y: 50 });
    expect(board.events(made[0]!.id)[0]!.text).toContain('Aus „Export“ aufgeteilt');
  });

  test('or keeps it whole, saying why', async () => {
    const a = card('Klein');
    k.split(a.id);
    await settle();
    cutSession().call('keep', { reason: 'Zu klein.' });
    cutSession().emit({ type: 'idle' });
    await settle();
    expect(item(a.id).queue).toBeUndefined();
    expect(board.events(a.id).at(-1)!.text).toBe('Nicht aufgeteilt: Zu klein.');
  });
});

describe('Koordinator answers questions of cards without a project', () => {
  test('from the decisions on such cards, in a session it resumes', async () => {
    const a = card('Export');
    board.decide({ project_id: null, card_id: a.id, question: 'Trennzeichen?', answer: 'Semikolon', by: 'owner' });
    const r1 = k.ask(item(a.id), { text: 'Kopfzeile?', options: [] });
    await settle();
    const s = runtime.last;
    expect(s.spec.readOnly).toBe(true);
    expect(s.inbox[0]).toContain('Trennzeichen? → Semikolon (owner)');
    s.emit({ type: 'session', id: 'k-1' });
    s.call('answer', { text: 'Ja.' });
    s.emit({ type: 'idle' });
    expect(await r1).toEqual({ answer: 'Ja.' });
    const r2 = k.ask(item(a.id), { text: 'Budget?', options: [] });
    await settle();
    expect(runtime.last.spec.resume).toBe('k-1');
    runtime.last.call('escalate', { question: 'Darf das Geld kosten?' });
    expect(await r2).toEqual({ escalate: { text: 'Darf das Geld kosten?', options: [] } });
  });

  test('a fresh session after a number of questions, after a restart, and after a failure', async () => {
    const repoFor = () => ({ workers, workspaces, adapter: { ...generic, land: 'main' as const, workspaces: 'worktrees' as const, softPaths: [] }, path: dir });
    k = new Koordinator({ board, runtime, repoFor, sessionQuestions: 2 });
    const a = card('Export');
    const answer = async (id: string, text: string) => {
      const r = k.ask(item(a.id), { text, options: [] });
      await settle();
      const s = runtime.last;
      s.emit({ type: 'session', id });
      s.call('answer', { text: 'Ja.' });
      s.emit({ type: 'idle' });
      await r;
      return s.spec.resume;
    };
    expect(await answer('k-1', 'Eins?')).toBeUndefined();
    expect(await answer('k-1', 'Zwei?')).toBe('k-1');
    expect(await answer('k-2', 'Drei?')).toBeUndefined();
    expect(await answer('k-2', 'Vier?')).toBe('k-2');

    // a restart: the session is not resumed
    k = new Koordinator({ board, runtime, repoFor });
    expect(await answer('k-3', 'Fünf?')).toBeUndefined();

    const r = k.ask(item(a.id), { text: 'Sechs?', options: [] });
    await settle();
    expect(runtime.last.spec.resume).toBe('k-3');
    runtime.last.emit({ type: 'error', message: 'kaputt' });
    await expect(r).rejects.toThrow('kaputt');
    expect(await answer('k-4', 'Sieben?')).toBeUndefined();
  });

  test('its answer reaches the worker and is marked as the Koordinator\u2019s', async () => {
    const w = new Workers({ board, runtime, workspaces, adapter: { ...generic, land: 'main', workspaces: 'worktrees', softPaths: [] }, advisor: (c) => ({ by: 'koordinator', ask: (q) => k.ask(c, q) }) });
    const a = card('A');
    w.start(a.id);
    workerOf(a.id).call('ask', { question: 'Farbe?' });
    await settle();
    runtime.last.call('answer', { text: 'Blau, wie bisher.' });
    await settle();
    expect(item(a.id).state).toBe('working');
    expect(board.events(a.id).at(-1)).toMatchObject({ kind: 'answer', author: 'koordinator' });
    expect(workerOf(a.id).inbox.at(-1)).toContain('from the Koordinator');
  });
});

describe('preference memory', () => {
  const learnSession = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'remember')).at(-1)!;

  test('a lasting preference becomes a rule; a refinement replaces it; a one-off does not', async () => {
    const a = card('Labels');
    k.learn(item(a.id), 'answer', 'Präzise, auch wenn es länger wird. Das gilt immer.', 'Kurz oder präzise?');
    await settle();
    expect(learnSession().inbox[0]).toContain('Kurz oder präzise?');
    learnSession().call('remember', { rule: 'Beschriftungen: präzise vor kurz.' });
    learnSession().emit({ type: 'idle' });
    await settle();
    expect(board.preferences().map((p) => p.text)).toEqual(['Beschriftungen: präzise vor kurz.']);
    expect(board.events(a.id).at(-1)!.text).toBe('Merkt sich: „Beschriftungen: präzise vor kurz.“');

    k.learn(item(a.id), 'feedback', 'Und immer mit Einheit.');
    await settle();
    expect(learnSession().inbox[0]).toContain('1. Beschriftungen: präzise vor kurz.');
    learnSession().call('remember', { rule: 'Beschriftungen: präzise vor kurz, immer mit Einheit.', replaces: 1 });
    learnSession().emit({ type: 'idle' });
    await settle();
    expect(board.preferences().map((p) => p.text)).toEqual(['Beschriftungen: präzise vor kurz, immer mit Einheit.']);

    k.learn(item(a.id), 'answer', 'Donnerstag.', 'Wann ist der Termin?');
    await settle();
    learnSession().call('nothing', {});
    learnSession().emit({ type: 'idle' });
    await settle();
    expect(board.preferences()).toHaveLength(1);
    expect(board.preferencesText()).toContain('- Beschriftungen: präzise vor kurz, immer mit Einheit.');
  });

  test('workers get the rules, and what the owner tells them is offered for learning', async () => {
    board.addPreference('Tests immer auf Deutsch benennen.');
    const heard: string[] = [];
    const w = new Workers({
      board,
      runtime,
      workspaces,
      adapter: { ...generic, land: 'main', workspaces: 'worktrees', softPaths: [] },
      preferences: () => board.preferencesText(),
      onOwnerInput: (_c, kind, text) => heard.push(`${kind}:${text}`),
    });
    const a = card('A');
    w.start(a.id);
    const s = workerOf(a.id);
    expect(s.spec.system).toContain('Tests immer auf Deutsch benennen.');
    s.call('ask', { question: 'Q?' });
    w.answer(a.id, 'Ja.');
    w.message(a.id, 'Bitte kleiner schneiden.');
    s.call('ready_for_review', { summary: 'S' });
    w.message(a.id, 'Noch die Einheit.');
    expect(heard).toEqual(['answer:Ja.', 'note:Bitte kleiner schneiden.', 'feedback:Noch die Einheit.']);
  });
});

test('parseChanges', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,2 +10,4 @@ function decide() {',
    '+--- a/not-a-file',
    '@@ -30 +32 @@',
    '@@ -40,3 +41,0 @@ class K {',
    'diff --git a/old.ts b/old.ts',
    'deleted file mode 100644',
    '--- a/old.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
  ].join('\n');
  expect(parseChanges(diff)).toEqual([
    { file: 'src/a.ts', regions: ['10-13 in function decide() {', '32', '41 (lines removed) in class K {'] },
    { file: 'old.ts', regions: ['deleted'] },
  ]);
});

test('overlaps', () => {
  expect(overlaps('src/a.ts', 'src/a.ts')).toBe(true);
  expect(overlaps('src/', 'src/a.ts')).toBe(true);
  expect(overlaps('src/ui/a.ts', 'src/')).toBe(true);
  expect(overlaps('src/a.ts', 'src/ab.ts')).toBe(false);
  expect(overlaps('src', 'src/a.ts')).toBe(false);
});
