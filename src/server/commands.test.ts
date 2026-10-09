import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentSetting, CanvasConfig, ConfigProblem, ConfigView } from '../core/types';
import { Board } from './board';
import { type Command, Commander } from './commands';
import { Store } from './db';
import { FakeRuntime, type FakeSession } from './testing';

let store: Store;
let board: Board;
let runtime: FakeRuntime;
let executed: Command[];

const settle = () => new Promise((r) => setTimeout(r, 5));
const commander = (sessionCommands?: number) =>
  new Commander({ board, runtime, cwd: '/r', execute: (c) => void executed.push(c), delayMs: 20, ...(sessionCommands ? { sessionCommands } : {}) });

/** Says `text`, lets the Koordinator answer with `tool`, and ends its turn. */
async function say(k: Commander, text: string, tool: string, args: Record<string, unknown>) {
  const heard = k.hear(text, {});
  await settle();
  const s = runtime.last;
  s.call(tool, args);
  s.emit({ type: 'idle' });
  return { heard: await heard, session: s, brief: s.inbox.at(-1)! };
}

beforeEach(() => {
  store = new Store(':memory:');
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => []);
  runtime = new FakeRuntime();
  executed = [];
});

describe("the owner's language", () => {
  test('the Koordinator confirms in the language Obeya speaks, in a new session once it changed', async () => {
    let language: 'de' | 'en' = 'en';
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => [], undefined, undefined, () => language);
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const first = await say(k, 'start the export', 'act', { actions: [{ do: 'start', card: 'K1' }], confirm: 'Starting “Export”.' });
    expect(first.session.spec.system).toContain('one short English sentence');
    expect(first.session.spec.system).toContain('a card is a “task”');
    // a turn without a decision is not understood, in English
    const heard = k.hear('hm', {});
    await settle();
    runtime.last.emit({ type: 'idle' });
    expect((await heard).confirm).toBe('I did not understand that.');
    language = 'de';
    const second = await say(k, 'starte Export', 'reply', { confirm: 'Schon gestartet.' });
    expect(second.session).not.toBe(first.session);
    expect(second.session.spec.system).toContain('one short German sentence');
    expect(k.vocabulary()).toStartWith('Obeya, Aufgabe');
  });
});

describe("the owner's choice of model and effort", () => {
  test('the Koordinator reads the next command in a new session once the owner chose another model or effort for it', async () => {
    let choice: AgentSetting = { model: 'default', effort: 'medium' };
    board.create({ title: 'Export', x: 0, y: 0 });
    const k = new Commander({ board, runtime, cwd: '/r', execute: (c) => void executed.push(c), delayMs: 20, agentSetting: () => choice });
    const first = await say(k, 'starte Export', 'reply', { confirm: 'Gleich.' });
    const same = await say(k, 'und?', 'reply', { confirm: 'Läuft.' });
    expect(same.session).toBe(first.session);
    choice = { model: 'haiku', effort: 'medium' };
    const second = await say(k, 'und jetzt?', 'reply', { confirm: 'Läuft.' });
    expect(second.session).not.toBe(first.session);
    expect(first.session.closed).toBe(true);
    expect(second.session.spec.role).toBe('koordinator');
  });
});

describe('the Koordinator remembers', () => {
  test('the conversation goes on in one session; card tags stay, and each command brings what happened since', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const first = await say(k, 'starte Export', 'act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    expect(first.brief).toContain('K1 [planned] "Export"');
    expect(first.brief).toContain('You have not talked with the owner before.');

    board.create({ title: 'Login', x: 0, y: 0 });
    board.log(a.id, 'question', 'worker', 'CSV oder Excel?');
    const second = await say(k, 'und die andere auch', 'act', { actions: [{ do: 'start', card: 'K2' }], confirm: '„Login“ startet.' });
    expect(second.session).toBe(first.session);
    expect(runtime.sessions).toHaveLength(1);
    // Export keeps K1, the new card gets the next tag
    expect(second.brief).toContain('K1 [planned] "Export"');
    expect(second.brief).toContain('K2 [planned] "Login"');
    expect(second.brief).toContain("What happened on the canvas since the owner's last command:");
    expect(second.brief).toContain('K1 "Export": the agent asked: CSV oder Excel?');
    expect(second.brief).toContain('K2 "Login": new card');
    expect(second.brief).not.toContain('You have not talked');
  });

  test('a command the owner takes back is told with the next one, and marked in the conversation', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const k = commander();
    const { heard } = await say(k, 'stopp Export', 'act', { actions: [{ do: 'stop', card: 'K1' }], confirm: '„Export“ angehalten.' });
    expect(k.undo(heard.token!)).toBe(true);
    const next = await say(k, 'was ist los?', 'reply', { confirm: 'Nichts.' });
    expect(next.brief).toContain('The owner took back what you confirmed with „„Export“ angehalten.“');
    expect(board.snapshot().talk.map((t) => [t.said, t.reply, !!t.undone])).toEqual([
      ['stopp Export', '„Export“ angehalten.', true],
      ['was ist los?', 'Nichts.', false],
    ]);
  });

  test('one sentence may hold several actions: one confirmation, one undo, run in order', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'waiting', need: 'review' });
    const k = commander();
    const { heard } = await say(k, 'gib das frei und mach ein Folge-Feature fürs Archiv', 'act', {
      actions: [
        { do: 'approve', card: 'K1' },
        { do: 'new_card', title: 'Archiv', body: 'Folge von Export', start: false },
      ],
      confirm: '„Export“ freigegeben, „Archiv“ angelegt.',
    });
    expect(heard.confirm).toBe('„Export“ freigegeben, „Archiv“ angelegt.');
    k.arm(heard.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'approve', card: a.id },
      { do: 'newCard', title: 'Archiv', body: 'Folge von Export', start: false },
    ]);
  });

  test('a new task starts at once, like "Agent starten", unless the owner says it should wait', async () => {
    const k = commander();
    const { heard, session } = await say(k, 'Tipjar soll die Rechnung aufteilen', 'act', {
      actions: [{ do: 'new_card', title: 'Rechnung aufteilen', body: 'Tipjar soll die Rechnung aufteilen.', start: true }],
      confirm: 'Neue Aufgabe „Rechnung aufteilen“, der Agent fängt an.',
    });
    // the field says what the Koordinator would otherwise decide either way
    expect(session.spec.tools.find((t) => t.name === 'act')!.description).toContain('start false only when the owner says it should wait („nur notieren“, „für später“, „noch nicht starten“), else true');
    k.arm(heard.token!);
    // left out, it starts too
    const { heard: bare } = await say(k, 'und eine für das Trinkgeld in Prozent', 'act', { actions: [{ do: 'new_card', title: 'Trinkgeld in Prozent', body: 'Trinkgeld frei in Prozent.' }], confirm: '…' });
    k.arm(bare.token!);
    const { heard: later } = await say(k, 'für später: Export als PDF', 'act', {
      actions: [{ do: 'new_card', title: 'Export als PDF', body: 'Export als PDF.', start: false }],
      confirm: 'Neue Aufgabe „Export als PDF“, sie startet noch nicht.',
    });
    k.arm(later.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed.map((c) => (c.do === 'newCard' ? [c.title, c.start] : c.do))).toEqual([
      ['Rechnung aufteilen', true],
      ['Trinkgeld in Prozent', true],
      ['Export als PDF', false],
    ]);
  });

  test('"ohne PR" approves directly where the repository allows it, and is refused with the reason where it does not', async () => {
    board = new Board(
      store,
      {
        id: 'c',
        name: 'C',
        repos: [
          { id: 'shop', name: 'Shop', path: '/r', branch: 'main', pullRequests: true, direct: true },
          { id: 'app', name: 'App', path: '/a', branch: 'main', pullRequests: true },
          { id: 'self', name: 'Self', path: '/s', branch: 'main' },
        ],
      },
      () => [],
    );
    const a = board.create({ title: 'Export', x: 0, y: 0, repo: 'shop' });
    const b = board.create({ title: 'Login', x: 0, y: 0, repo: 'app' });
    const c = board.create({ title: 'Logo', x: 0, y: 0, repo: 'self' });
    for (const card of [a, b, c]) board.work(card.id, { state: 'waiting', need: 'review' });
    const k = commander();
    const heard = k.hear('gib Export frei, direkt auf main ohne PR', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('shop (Shop; approved work goes out as a pull request, or directly onto main where the owner says so)');
    expect(s.inbox[0]).toContain('app (App; approved work goes out as a pull request)');
    const refused = await s.call('act', { actions: [{ do: 'approve', card: 'K2', direct: true }], confirm: '…' });
    expect(refused).toContain('the repository app lands approved work only through a pull request');
    // where work lands on main anyway, "direkt" is a plain approval
    s.call('act', {
      actions: [
        { do: 'approve', card: 'K1', direct: true },
        { do: 'approve', card: 'K3', direct: true },
      ],
      confirm: '„Export“ geht direkt auf main, „Logo“ ist freigegeben.',
    });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'approve', card: a.id, direct: true },
      { do: 'approve', card: c.id },
    ]);
  });

  test("the open card brings its whole summary, so a follow-up carries what it is about", async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const finding = 'Der `ambient`-Ton läuft nach dem Stopp weiter.';
    const summary = `Export schreibt jetzt CSV. ${'Viel Kontext. '.repeat(40)}${finding} Ende der Zusammenfassung.`;
    board.work(a.id, {
      state: 'waiting',
      need: 'demo',
      detail: JSON.stringify({ summary }),
      demo: JSON.stringify({ dir: '/d', chapters: [] }),
    });
    const k = commander();
    const heard = k.hear('Freigegeben und lege eine Folgekarte für den ambient-Ton an', { card: a.id });
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain(`Its worker's summary:\n${summary}`);
    expect(await s.call('act', { actions: [{ do: 'new_card', card: 'K9', title: 'x' }], confirm: '…' })).toContain('unknown tag K9');
    s.call('act', {
      actions: [
        { do: 'approve', card: 'K1' },
        { do: 'new_card', card: 'K1', title: 'ambient-Ton stoppen', body: finding, start: false },
      ],
      confirm: '„Export“ freigegeben, Folgekarte „ambient-Ton stoppen“ angelegt.',
    });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed[1]).toEqual({ do: 'newCard', title: 'ambient-Ton stoppen', body: finding, start: false, from: a.id });
  });

  test('an action that does not fit the card is refused in the turn, so the Koordinator can answer instead', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'live' });
    const k = commander();
    const heard = k.hear('Was heißt abgeschlossen? Auf main sehe ich es nicht.', { card: a.id });
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('The owner has this card open');
    const refused = await s.call('act', { actions: [{ do: 'note', card: 'K1', text: 'Was heißt abgeschlossen?' }], confirm: 'Weitergegeben.' });
    expect(refused).toContain('Nothing recorded: action 1 (note on K1): no agent works on this card (it is live)');
    s.call('reply', { confirm: '„Export“ ist seit gestern auf main.' });
    s.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: '„Export“ ist seit gestern auf main.' });
  });

  test('a question on a live card an agent worked on is a note: it resumes that agent', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'live', branch: 'obeya/export-1' });
    const k = commander();
    const heard = k.hear('Wie lade ich das hoch?', { card: a.id });
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain("[live, its agent's session has ended; a note resumes it to answer] \"Export\"");
    expect(await s.call('act', { actions: [{ do: 'note', card: 'K1', text: 'Wie lade ich das hoch?' }], confirm: 'Weitergegeben.' })).toContain('Done');
    s.emit({ type: 'idle' });
    await heard;
  });

  test("the question in a demo report is the card's open question: „ja“ to it answers it", async () => {
    const a = board.create({ title: 'Archiv', x: 0, y: 0 });
    board.work(a.id, { state: 'waiting', need: 'demo', demo: JSON.stringify({ dir: '/d', chapters: [], question: 'Alte Projekte nachtragen?' }) });
    const k = commander();
    const heard = k.hear('ja zum Archiv', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('[waiting: demo] "Archiv" — open question in its demo report: Alte Projekte nachtragen?');
    expect(await s.call('act', { actions: [{ do: 'answer', card: 'K1', text: 'ja' }], confirm: 'Antwort an „Archiv“.' })).toContain('Done');
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'answer', card: a.id, text: 'ja', spoken: true }]);
  });

  test("an idea's suggested next step, with its agent's own answers, is in its line: „mach, was du vorschlägst“ takes it", async () => {
    const a = board.create({ idea: true, title: 'Export', x: 0, y: 0 });
    board.setIdea(a.id, {
      yourTurn: true,
      questions: [{ text: 'Welches Format?', options: ['CSV', 'PDF'], pick: { options: ['CSV'], why: 'Excel.' } }],
      next: { step: 'answer', why: 'Das Format entscheidet den Rest.' },
    });
    const k = commander();
    const { brief } = await say(k, 'mach, was du vorschlägst', 'act', { actions: [{ do: 'discuss', card: 'K1', text: 'CSV' }], confirm: 'An „Export“: CSV.' });
    expect(brief).toContain(
      '"Export" — its agent would have the owner answer its open questions (discuss) next: Das Format entscheidet den Rest. (its own answers: "Welches Format?" → CSV)',
    );
    board.setIdea(a.id, { questions: [], next: { step: 'prototype', why: 'Erst sehen.' } });
    const second = await say(k, 'und?', 'reply', { confirm: '…' });
    expect(second.brief).toContain('"Export" — its agent would prototype next: Erst sehen.');
  });

  test('a landed card whose agent finishes what remains still takes notes', async () => {
    const a = board.create({ title: 'Archiv', x: 0, y: 0 });
    board.work(a.id, { state: 'live', workspace: '/w', landed: '{}' });
    const k = commander();
    const { brief, heard } = await say(k, 'sag Archiv, es soll auch die alten Karten nachtragen', 'act', {
      actions: [{ do: 'note', card: 'K1', text: 'Auch die alten Karten nachtragen.' }],
      confirm: 'Weitergegeben.',
    });
    expect(brief).toContain('K1 [live, its agent finishes what remains after the landing] "Archiv"');
    expect(heard.token).toBeDefined();
  });

  test('starting a queued card starts it now despite the likely conflict; one still being checked starts by itself', async () => {
    const running = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(running.id, { state: 'working' });
    const behind = board.create({ title: 'Archiv', x: 0, y: 0 });
    board.work(behind.id, { queue: JSON.stringify({ behind: [running.id], reason: 'beide ändern export.ts' }) });
    const checking = board.create({ title: 'Login', x: 0, y: 0 });
    board.work(checking.id, { queue: JSON.stringify({ checking: true }) });
    const k = commander();
    const heard = k.hear('starte alle wartenden Karten', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('K2 [queued behind "Export"] "Archiv"');
    expect(s.inbox[0]).toContain('K3 [queued: Obeya checks it for merge conflicts] "Login"');
    const refused = await s.call('act', { actions: [{ do: 'start', card: 'K2' }, { do: 'start', card: 'K3' }], confirm: 'Beide starten.' });
    expect(refused).toContain('action 2 (start on K3): Obeya is still checking the card');
    s.call('act', { actions: [{ do: 'start', card: 'K2' }], confirm: '„Archiv“ startet trotz Überschneidung.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'force', card: behind.id }]);
  });

  test('a queued card is taken out of the queue; one that waits for nothing is not', async () => {
    const running = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(running.id, { state: 'working' });
    const behind = board.create({ title: 'Archiv', x: 0, y: 0 });
    board.work(behind.id, { queue: JSON.stringify({ behind: [running.id], reason: 'beide ändern export.ts' }) });
    const k = commander();
    const heard = k.hear('nimm Archiv und Export aus der Warteschlange', {});
    await settle();
    const s = runtime.last;
    const refused = await s.call('act', { actions: [{ do: 'dequeue', card: 'K2' }, { do: 'dequeue', card: 'K1' }], confirm: 'Beide raus.' });
    expect(refused).toContain('action 2 (dequeue on K1): the card is not in the queue (it is working)');
    s.call('act', { actions: [{ do: 'dequeue', card: 'K2' }], confirm: '„Archiv“ ist aus der Warteschlange.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'dequeue', card: behind.id }]);
  });

  test('starting a project hands its planned workstreams to the Koordinator together', async () => {
    const ws = (key: string, done = false) => ({ key, label: key, title: `Titel ${key}`, body: '', done, inReview: false });
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => [
      { file: 'docs/plan/p.md', title: 'Export', goal: 'Ziel', workstreams: [ws('W1', true), ws('W2'), ws('W3')], markdown: '' },
      { file: 'docs/plan/q.md', title: 'Fertig', goal: 'Ziel', workstreams: [ws('W1', true)], markdown: '' },
    ]);
    const [project] = board.snapshot().items;
    const k = commander();
    const heard = k.hear('starte alle Workstreams', { project: project!.id });
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('The owner is looking at the project K1 "Export".');
    expect(s.inbox[0]).toContain('Projects with workstreams to start:\nK1 [project] "Export" — planned workstreams not yet started: W2, W3');
    expect(s.inbox[0]).not.toContain('"Fertig"');
    s.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: 'Obeya plant alle Workstreams von „Export“ ein.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'start', card: project!.id }]);
  });

  test("the exchange goes into the open card's log; without an open card into the sheet", async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const k = commander();
    const heard = k.hear('halt ihn an', { card: a.id });
    await settle();
    runtime.last.call('act', { actions: [{ do: 'stop', card: 'K1' }], confirm: '„Export“ wird angehalten.' });
    runtime.last.emit({ type: 'idle' });
    k.undo((await heard).token!);
    expect(board.events(a.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['say', 'owner', 'halt ihn an'],
      ['say', 'koordinator', '„Export“ wird angehalten.'],
      ['state', 'owner', 'Zurückgenommen.'],
    ]);
    expect(board.snapshot().talk).toEqual([]);
    await say(k, 'was läuft?', 'reply', { confirm: '„Export“.' });
    expect(board.snapshot().talk.map((t) => t.said)).toEqual(['was läuft?']);
    // the memory holds both, and knows which card was open
    const { brief } = await say(commander(), 'und?', 'reply', { confirm: 'Nichts.' });
    expect(brief).toContain('(with "Export" open) the owner: "halt ihn an" → you: "„Export“ wird angehalten." (the owner took it back)');
  });

  test('a new session, after a restart, starts from the stored conversation and the canvas history', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    await say(commander(), 'starte Export', 'act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    board.log(a.id, 'state', 'obeya', 'Agent gestartet auf obeya/export.');
    board.log(a.id, 'activity', 'worker', 'Read src/app.ts');

    // Obeya restarts: a new Commander on the same store
    const { brief } = await say(commander(), 'was habe ich vorhin gestartet?', 'reply', { confirm: '„Export“.' });
    expect(runtime.sessions).toHaveLength(2);
    expect(brief).toContain('Your conversation with the owner before this session');
    expect(brief).toContain('the owner: "starte Export" → you: "„Export“ startet."');
    expect(brief).toContain('K1 "Export": new card');
    expect(brief).toContain('K1 "Export": Agent gestartet auf obeya/export.');
    // the worker's steps are no history the Koordinator needs
    expect(brief).not.toContain('Read src/app.ts');
  });

  test('a long session makes way for a fresh one that starts from memory', async () => {
    board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander(2);
    const one = await say(k, 'eins', 'reply', { confirm: 'Eins.' });
    await say(k, 'zwei', 'reply', { confirm: 'Zwei.' });
    await settle();
    expect(one.session.closed).toBe(true);
    const three = await say(k, 'drei', 'reply', { confirm: 'Drei.' });
    expect(three.session).not.toBe(one.session);
    expect(three.brief).toContain('the owner: "zwei" → you: "Zwei."');
  });

  test('commands are read one at a time: the next waits until the turn has ended', async () => {
    const k = commander();
    const first = k.hear('eins', {});
    const second = k.hear('zwei', {});
    await settle();
    const s: FakeSession = runtime.last;
    expect(s.inbox).toHaveLength(1);
    s.call('reply', { confirm: 'Eins.' });
    expect(await first).toEqual({ confirm: 'Eins.' });
    await settle();
    // the turn is still running: the idle that ends it must not answer the next command
    expect(s.inbox).toHaveLength(1);
    s.emit({ type: 'idle' });
    await settle();
    expect(s.inbox).toHaveLength(2);
    expect(s.inbox[1]).toContain('"zwei"');
    s.call('reply', { confirm: 'Zwei.' });
    s.emit({ type: 'idle' });
    expect(await second).toEqual({ confirm: 'Zwei.' });
  });
});

describe('what the agent of a card passes on from the owner\'s words', () => {
  const DEMO = JSON.stringify({ dir: '/d', chapters: [], question: 'Alte Projekte nachtragen?' });
  /** A card in each state an agent is on, as `board.work` sets it. */
  const STATES: Record<string, Record<string, string>> = {
    working: { state: 'working' },
    question: { state: 'waiting', need: 'question', detail: JSON.stringify({ question: { text: 'CSV oder Excel?', options: ['CSV', 'Excel'] } }) },
    demo: { state: 'waiting', need: 'demo', demo: DEMO },
    review: { state: 'waiting', need: 'review' },
    inPr: { state: 'inPr' },
    finishing: { state: 'live', workspace: '/w', landed: '{}' },
  };
  const open = (state: string) => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, STATES[state]!);
    return a;
  };
  const said = (id: string) => board.events(id).filter((e) => e.kind === 'say').map((e) => [e.author, e.text]);

  for (const state of ['working', 'question', 'demo', 'review', 'inPr', 'finishing'])
    for (const spoken of [false, true])
      test(`on a card ${state}, ${spoken ? 'spoken' : 'typed'}: Obeya's commands wait for undo; the words do not go back to the agent`, async () => {
        const a = open(state);
        const k = commander();
        // a follow-up, a rule, a stop, an approval: confirmed, and taken back within the window
        const commands: [string, string, Record<string, unknown>[], Command][] = [
          ['mach eine Folgeaufgabe für Excel', 'A follow-up card for Excel', [{ do: 'new_card', card: 'K1', title: 'Excel-Export', body: 'Auch als Excel.' }], { do: 'newCard', title: 'Excel-Export', body: 'Auch als Excel.', start: true, from: a.id }],
          ['Merk dir: Exporte immer mit Kopfzeile', 'Remember: exports always with a header row', [{ do: 'remember', text: 'Exporte immer mit Kopfzeile.' }], { do: 'remember', text: 'Exporte immer mit Kopfzeile.', card: a.id }],
        ];
        // an agent in a pull request is not stopped
        if (state !== 'inPr') commands.push(['halt an', 'Stop me', [{ do: 'stop', card: 'K1' }], { do: 'stop', card: a.id }]);
        if (state === 'demo' || state === 'review') commands.push(['gib frei', 'Approve my work', [{ do: 'approve', card: 'K1' }], { do: 'approve', card: a.id }]);
        for (const [words, request, actions, command] of commands) {
          const heard = k.forward(a.id, request, { text: words, spoken });
          await settle();
          const s = runtime.last;
          const brief = s.inbox.at(-1)!;
          expect(brief).toContain(`The agent of the open card passes on a request from what the owner told it, asking Obeya for something: "${request}"`);
          expect(brief).toContain(`The owner's own words to it, ${spoken ? 'spoken (speech recognition, may contain errors)' : 'typed (as written, no recognition errors)'}: "${words}"`);
          expect(brief).toContain('The owner has this card open');
          // the agent has the words: nothing goes back to it
          expect(s.call('act', { actions: [{ do: state === 'question' ? 'answer' : 'note', card: 'K1', text: words }], confirm: 'Ok.' })).toContain("reached this card's agent already");
          expect(await s.call('act', { actions, confirm: 'Bestätigt.' })).toContain('Done');
          s.emit({ type: 'idle' });
          const h = await heard;
          expect(h.token).toBeDefined();
          k.arm(h.token!);
          expect(executed).toEqual([]);
          await new Promise((r) => setTimeout(r, 40));
          expect(executed).toEqual([command]);
          executed = [];
        }
        // the owner's words stand on the card as the agent got them; here only the Koordinator's confirmations
        expect(said(a.id)).toEqual(commands.map(() => ['koordinator', 'Bestätigt.']));
      });

  test("a reply is the agent's answer, and a question about the card itself is not refused as one for its agent", async () => {
    const a = open('working');
    const k = commander();
    const heard = k.forward(a.id, 'How many tasks are running?', { text: 'wie viele Aufgaben laufen gerade?', spoken: true });
    await settle();
    const s = runtime.last;
    expect(s.call('look_up', { question: 'What does Export change?', card: 'K1', confirm: 'Ich schaue nach.' })).toContain('Done');
    s.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: 'Ich schaue nach.' });
  });

  test('without the owner\'s words, the request alone is read', async () => {
    const a = open('working');
    const k = commander();
    const heard = k.forward(a.id, 'Start the card Login');
    await settle();
    const brief = runtime.last.inbox.at(-1)!;
    expect(brief).toContain('asking Obeya for something: "Start the card Login"');
    expect(brief).not.toContain("The owner's own words");
    runtime.last.call('reply', { confirm: 'Es gibt keine Karte Login.' });
    runtime.last.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: 'Es gibt keine Karte Login.' });
  });
});

describe('what the owner says or types to the Koordinator about a card with an agent', () => {
  const open = (state: Record<string, string>) => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, state);
    return a;
  };

  test('the Koordinator learns whether the words were spoken or typed, and in which field', async () => {
    const source = board.create({ title: 'Login', x: 0, y: 0 });
    const p = board.propose(source.id, { title: 'Export', task: 'CSV', reason: 'Fehlt.', idea: false, questions: [] });
    const k = commander();
    const spoken = await say(k, 'ja', 'reply', { confirm: 'Gut.' });
    expect(spoken.brief).toContain('The owner said (speech recognition, may contain errors): "ja"');
    const heard = k.hear('lieber als Excel', { card: p.id }, [], { typed: true, field: 'revise' });
    await settle();
    expect(runtime.last.inbox.at(-1)).toContain('The owner typed into the field for what should change in the proposal (as written, no recognition errors): "lieber als Excel"');
    runtime.last.call('reply', { confirm: 'Gut.' });
    runtime.last.emit({ type: 'idle' });
    await heard;
  });

  test('a question about the work of an agent goes to that agent, not to a look-up of main', async () => {
    open({ state: 'waiting', need: 'demo', demo: JSON.stringify({ dir: '/d', chapters: [] }) });
    const k = commander();
    const question = 'Ist bei Export sichergestellt, dass beim Anhalten alles committed ist?';
    const heard = k.hear(question, {}, [], { typed: true });
    await settle();
    const s = runtime.last;
    expect(await s.call('look_up', { question, card: 'K1', confirm: 'Ich schaue nach.' })).toContain('Pass the owner\'s words to it with act (feedback)');
    expect(await s.call('act', { actions: [{ do: 'feedback', card: 'K1', text: question }], confirm: 'An den Agenten von „Export“.' })).toContain('Done');
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed[0]).toMatchObject({ do: 'feedback', text: question, spoken: false });
    expect(board.lookingUp()).toEqual([]);
  });

  test('a note together with a command waits with it', async () => {
    const a = open({ state: 'waiting', need: 'review' });
    const k = commander();
    const heard = k.hear('gib Export frei und sag dem Agenten danke', {});
    await settle();
    runtime.last.call('act', { actions: [{ do: 'approve', card: 'K1' }, { do: 'note', card: 'K1', text: 'Danke.' }], confirm: 'Freigegeben.' });
    runtime.last.emit({ type: 'idle' });
    const { token } = await heard;
    expect(token).toBeDefined();
    expect(executed).toEqual([]);
    k.arm(token!);
    await new Promise((r) => setTimeout(r, 40));
    // said about a card, the Koordinator's words stand
    expect(executed).toEqual([{ do: 'approve', card: a.id }, { do: 'note', card: a.id, text: 'Danke.', spoken: true }]);
  });
});

describe('„Merk dir“', () => {
  test('records a rule after the undo window, with the open card as its occasion; undo takes it back', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const heard = k.hear('Merk dir: Demos immer mit Ton', { card: a.id });
    await settle();
    runtime.last.call('act', { actions: [{ do: 'remember', text: 'Demos immer mit Ton.' }], confirm: 'Gemerkt: Demos immer mit Ton.' });
    runtime.last.emit({ type: 'idle' });
    const { token } = await heard;
    k.arm(token!);
    expect(executed).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'remember', text: 'Demos immer mit Ton.', card: a.id }]);

    const { heard: again } = await say(k, 'merk dir, nie mehr auf Englisch', 'act', { actions: [{ do: 'remember', text: 'Nie auf Englisch.' }], confirm: 'Gemerkt.' });
    expect(k.undo(again.token!)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toHaveLength(1);
  });

  test('every command brings the rules, numbered; replaces names the rule a new one changes', async () => {
    const k = commander();
    const none = await say(k, 'was gibt es?', 'reply', { confirm: 'Nichts.' });
    expect(none.brief).toContain('The owner has recorded no rules yet.');

    board.addPreference('Beschriftungen: präzise vor kurz.');
    // a proposal the owner has not accepted is no rule yet
    board.proposePreference('Commits auf Englisch.', { quote: 'Commits bitte auf Englisch' });
    const ton = board.addPreference('Demos ohne Ton.');
    const heard = k.hear('merk dir, Demos doch mit Ton', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox.at(-1)).toContain("The owner's rules, which every agent follows (follow them yourself too):\n1. Beschriftungen: präzise vor kurz.\n2. Demos ohne Ton.");
    expect(s.inbox.at(-1)).not.toContain('Commits auf Englisch.');
    expect(s.call('act', { actions: [{ do: 'remember', text: 'Demos mit Ton.', replaces: 3 }], confirm: '…' })).toContain('there is no rule 3');
    expect(s.call('act', { actions: [{ do: 'remember', text: ' ' }], confirm: '…' })).toContain('the rule is missing');
    s.call('act', { actions: [{ do: 'remember', text: 'Demos mit Ton.', replaces: 2 }], confirm: 'Geändert: Demos mit Ton.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'remember', text: 'Demos mit Ton.', replaces: ton }]);
  });

  test('a rule about a repository is filed for its CLAUDE.md; the Koordinator knows the repositories', async () => {
    const k = commander();
    const heard = k.hear('merk dir: in Home Tests immer auf Deutsch', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox.at(-1)).toContain('Repositories on this canvas (the first is the default for a new card): home (Home)');
    expect(s.spec.tools.find((t) => t.name === 'act')!.description).toContain('„CLAUDE.md ergänzen“');
    expect(s.call('act', { actions: [{ do: 'remember', text: 'Tests auf Deutsch.', repos: ['web'] }], confirm: '…' })).toContain('unknown repository web; the canvas has home');
    s.call('act', { actions: [{ do: 'remember', text: 'Tests auf Deutsch.', repos: ['home', 'home'] }], confirm: 'Kommt in die CLAUDE.md von Home.' });
    s.emit({ type: 'idle' });
    const { token, confirm } = await heard;
    expect(confirm).toBe('Kommt in die CLAUDE.md von Home.');
    k.arm(token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'remember', text: 'Tests auf Deutsch.', repos: ['home'] }]);
  });
});

describe('what the owner says to the Koordinator is offered for learning', () => {
  test('a reply and a look-up at once; a command once it runs, not when taken back; words that reach the learner another way not again', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const heard: string[] = [];
    const k = new Commander({
      board,
      runtime,
      cwd: '/r',
      execute: (c) => void executed.push(c),
      delayMs: 20,
      onOwnerInput: (card, kind, text, reply) => heard.push(`${kind}${card ? ` on ${board.item(card)!.title}` : ''}: ${text} → ${reply}`),
    });
    await say(k, 'warum dauert das so lange?', 'reply', { confirm: 'Der Agent wartet auf die Tests.' });
    await say(k, 'was würde der Agent bei Export tun?', 'look_up', { question: 'Was würde der Agent tun?', confirm: 'Ich schaue nach.' });
    expect(heard).toEqual(['talk: warum dauert das so lange? → Der Agent wartet auf die Tests.', 'talk: was würde der Agent bei Export tun? → Ich schaue nach.']);

    const started = k.hear('mach eine Karte für den Import und fang gleich an, Tests immer zuerst', { card: a.id });
    await settle();
    runtime.last.call('act', { actions: [{ do: 'new_card', title: 'Import', body: 'Import, Tests zuerst', start: true }], confirm: 'Neue Karte „Import“.' });
    runtime.last.emit({ type: 'idle' });
    k.arm((await started).token!);
    expect(heard).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 40));
    expect(heard[2]).toBe('command on Export: mach eine Karte für den Import und fang gleich an, Tests immer zuerst → Neue Karte „Import“.');

    const { heard: back } = await say(k, 'stopp Export', 'act', { actions: [{ do: 'stop', card: 'K1' }], confirm: '„Export“ angehalten.' });
    k.undo(back.token!);
    // a note reaches the learner through the worker, a rule is one already
    const { heard: note } = await say(k, 'sag Export: immer mit Einheit', 'act', { actions: [{ do: 'note', card: 'K1', text: 'Immer mit Einheit.' }], confirm: 'Weitergegeben.' });
    k.arm(note.token!);
    const { heard: rule } = await say(k, 'merk dir: Demos mit Ton', 'act', { actions: [{ do: 'remember', text: 'Demos mit Ton.' }], confirm: 'Gemerkt.' });
    k.arm(rule.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(heard).toHaveLength(3);
    expect(executed.map((c) => c.do)).toEqual(['newCard', 'note', 'remember']);
  });
});

describe("the Koordinator and Obeya's configuration", () => {
  const view = { file: '/h/canvases.json', source: 'file', canvases: [{ name: 'Obeya', repos: [{ path: '/r' }] }], running: ['obeya'] } as unknown as ConfigView;
  const config = {
    view: () => view,
    check: (input: unknown) => {
      const canvases = input as CanvasConfig[];
      const problems: ConfigProblem[] = canvases.some((c) => c.repos.some((r) => r.path === '/nirgends'))
        ? [{ code: 'notRepo', canvas: 0, repo: 0, detail: '/nirgends is not a git repository' }]
        : [];
      return { canvases, resolved: [], problems };
    },
  };
  const withConfig = () => new Commander({ board, runtime, cwd: '/r', execute: (c) => void executed.push(c), delayMs: 20, config });

  test('reads it for a question and replies', async () => {
    const k = withConfig();
    const heard = k.hear('welche Leinwände gibt es?', {});
    await settle();
    expect(JSON.parse(runtime.last.call('config', {}) as string)).toMatchObject({ file: '/h/canvases.json', running: ['obeya'] });
    runtime.last.call('reply', { confirm: 'Eine: Obeya.' });
    runtime.last.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: 'Eine: Obeya.' });
  });

  test('changes it on the owner\'s word after the undo window; one that does not work goes back to it', async () => {
    const k = withConfig();
    const heard = k.hear('nimm das Repository nirgends dazu', {});
    await settle();
    const s = runtime.last;
    const bad = [{ name: 'Obeya', repos: [{ path: '/r' }, { path: '/nirgends' }] }];
    expect(s.call('configure', { canvases: bad, confirm: 'Ok.' })).toContain('/nirgends is not a git repository');
    const good = [{ name: 'Obeya', repos: [{ path: '/r' }, { path: '/r2' }] }];
    s.call('configure', { canvases: good, confirm: 'Das Repository r2 kommt dazu; Obeya startet danach neu.' });
    s.emit({ type: 'idle' });
    const h = await heard;
    expect(h.confirm).toBe('Das Repository r2 kommt dazu; Obeya startet danach neu.');
    k.arm(h.token!);
    expect(executed).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'configure', canvases: good }]);
  });

  test('without it, the Koordinator has no such tools', async () => {
    commander().warm();
    expect(runtime.last.spec.tools.map((t) => t.name)).not.toContain('configure');
  });
});

describe('Arbeitsrückschau on request', () => {
  test('runs for the repository the owner names, else the first; an unknown one is refused', async () => {
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }, { id: 'app', name: 'App', path: '/o', branch: 'main' }] }, () => []);
    const k = commander();
    const heard = k.hear('Mach eine Arbeitsrückschau für App', {});
    await settle();
    const s = runtime.last;
    expect(s.spec.tools.find((t) => t.name === 'act')!.description).toContain('- work_retro (no card)');
    expect(s.call('act', { actions: [{ do: 'work_retro', repo: 'shop' }], confirm: '…' })).toContain('unknown repository shop');
    s.call('act', { actions: [{ do: 'work_retro', repo: 'app' }, { do: 'work_retro' }], confirm: 'Ich mache die Arbeitsrückschau für App.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'workRetro', repo: 'app' },
      { do: 'workRetro', repo: 'home' },
    ]);
  });
});

describe('groups by voice', () => {
  test('the Koordinator sees the groups and puts cards into one, takes them out and renames one', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const b = board.create({ title: 'Rabatt', x: 400, y: 0 });
    const g = board.createGroup('Abrechnung', [a.id]);
    const k = commander();
    const heard = k.hear('Rabatt gehört auch zur Abrechnung, und benenne Abrechnung in Billing um', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('K1 [planned] "Export" (group "Abrechnung")');
    expect(s.inbox[0]).toContain('K2 [planned] "Rabatt"\n');
    expect(s.inbox[0]).toContain('Groups on the canvas: "Abrechnung"');
    expect(s.call('act', { actions: [{ do: 'group', cards: ['K2'] }], confirm: '…' })).toContain("the group's name is missing");
    expect(s.call('act', { actions: [{ do: 'group', cards: ['K9'], text: 'X' }], confirm: '…' })).toContain('unknown tag K9');
    expect(s.call('act', { actions: [{ do: 'rename_group', group: 'Einkauf', text: 'X' }], confirm: '…' })).toContain('there is no group Einkauf; the canvas has "Abrechnung"');
    s.call('act', {
      actions: [
        { do: 'group', cards: ['K2'], text: ' Abrechnung ' },
        { do: 'group', card: 'K1', group: 'Neu' },
        { do: 'ungroup', cards: ['K1', 'K2'] },
        { do: 'rename_group', group: 'abrechnung', text: 'Billing' },
      ],
      confirm: '„Rabatt“ gehört jetzt zur Abrechnung, die Billing heißt.',
    });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'group', cards: [b.id], name: 'Abrechnung' },
      { do: 'group', cards: [a.id], name: 'Neu' },
      { do: 'ungroup', cards: [a.id, b.id] },
      { do: 'renameGroup', group: g.id, name: 'Billing' },
    ]);
  });
});
