import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { type AgentSetting, type CanvasConfig, type ConfigProblem, type ConfigView, type Notice, waitingOn } from '../core/types';
import { Board } from './board';
import { type Command, Commander } from './commands';
import { Store } from './db';
import { FakeRuntime, type FakeSession, until } from './testing';

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
  board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
  runtime = new FakeRuntime();
  executed = [];
});

describe("the owner's language", () => {
  test("the Koordinator confirms in the language of the owner's words, else the conversation language; Obeya's own words follow the interface; either changed takes a new session", async () => {
    let language: 'de' | 'en' = 'en';
    let conversation: 'de' | 'en' = 'en';
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }), undefined, undefined, () => language, () => conversation);
    board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const first = await say(k, 'start the export', 'act', { actions: [{ do: 'start', card: 'K1' }], confirm: 'Starting “Export”.' });
    expect(first.session.spec.system).toContain("one short sentence in the owner's language");
    expect(first.session.spec.system).toContain('until they have said anything, English.');
    expect(first.session.spec.system).toContain('"New task “Meter readings as CSV”');
    // it knows the owner's words for its cards in either language
    expect(first.session.spec.system).toContain('a card is a “task”');
    expect(first.session.spec.system).toContain('a card is an „Aufgabe“');
    expect(first.session.spec.system).toContain('the repository\'s card “Add to CLAUDE.md”');
    // a turn without a decision is not understood, in English
    const heard = k.hear('hm', {});
    await settle();
    runtime.last.emit({ type: 'idle' });
    expect((await heard).confirm).toBe('I did not understand that.');
    conversation = 'de';
    const second = await say(k, 'starte Export', 'reply', { confirm: 'Schon gestartet.' });
    expect(second.session).not.toBe(first.session);
    expect(second.session.spec.system).toContain('until they have said anything, German.');
    expect(second.session.spec.system).toContain('"Neue Aufgabe „Zählerstände als CSV“');
    // the interface stays English: Obeya's own words and the names of its cards
    expect(second.session.spec.system).toContain('the repository\'s card “Add to CLAUDE.md”');
    expect(k.vocabulary()).toStartWith('Obeya, task');
    language = 'de';
    const third = await say(k, 'starte Export', 'reply', { confirm: 'Schon gestartet.' });
    expect(third.session).not.toBe(second.session);
    expect(third.session.spec.system).toContain('the repository\'s card „CLAUDE.md ergänzen“');
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

  test('what happens in the millisecond of a command, or after the clock went back, comes with the next one', async () => {
    const at = new Date('2026-10-21T12:40:07.650Z');
    setSystemTime(at);
    try {
      const a = board.create({ title: 'Export', x: 0, y: 0 });
      const k = commander();
      await say(k, 'starte Export', 'reply', { confirm: 'Gleich.' });
      // in the same millisecond as the brief
      board.log(a.id, 'question', 'worker', 'CSV oder Excel?');
      const second = await say(k, 'und?', 'reply', { confirm: 'Es fragt.' });
      expect(second.brief).toContain('K1 "Export": the agent asked: CSV oder Excel?');
      // the clock steps back, as a machine's may when it is set
      setSystemTime(new Date(at.getTime() - 50));
      board.create({ title: 'Login', x: 0, y: 0 });
      const third = await say(k, 'und jetzt?', 'reply', { confirm: 'Neue Karte.' });
      expect(third.brief).toContain('K2 "Login": new card');
      expect(third.brief).not.toContain('CSV oder Excel?');
    } finally {
      setSystemTime();
    }
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

  test('a command in its undo window outlives a restart: the next server runs it once the window is over', async () => {
    const k = new Commander({ board, runtime, cwd: '/r', execute: () => {}, delayMs: 2000 });
    const { heard } = await say(k, 'Spracheinstellung: „unten“ stimmt nicht mehr', 'act', {
      actions: [{ do: 'new_card', title: 'Hinweis „unten“ korrigieren', body: 'Die Demo-Einstellungen stehen links.' }],
      confirm: 'Neue Aufgabe „Hinweis „unten“ korrigieren“, der Agent fängt an.',
    });
    expect(k.holding()).toBe(false);
    k.arm(heard.token!);
    // a restart waits for it, and a page that opens offers "Rückgängig" again for what is left of the window
    expect(k.holding()).toBe(true);
    expect(k.undoable()).toEqual([{ text: heard.confirm, token: heard.token!, undoMs: expect.any(Number) }]);
    expect(k.undoable()[0]!.undoMs).toBeGreaterThan(1000);
    // Obeya stops before the window is over; the next server finds the command on the same database
    const later = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const ran: Command[] = [];
    const next = new Commander({ board: later, runtime, cwd: '/r', execute: (c) => void ran.push(c), delayMs: 20 });
    store.db.query("UPDATE commands SET due = '2000-01-01T00:00:00.000Z'").run();
    next.resume();
    expect(next.holding()).toBe(true);
    await settle();
    expect(ran).toEqual([{ do: 'newCard', title: 'Hinweis „unten“ korrigieren', body: 'Die Demo-Einstellungen stehen links.', start: true }]);
    expect(next.holding()).toBe(false);
    expect(later.heldCommands()).toEqual([]);
    // it runs once: a third start finds nothing
    const third = new Commander({ board: later, runtime, cwd: '/r', execute: (c) => void ran.push(c), delayMs: 20 });
    third.resume();
    await settle();
    expect(ran).toHaveLength(1);
  });

  test('a command taken back is gone for the next server too, and one that runs cannot be taken back', async () => {
    const k = commander();
    const { heard } = await say(k, 'neue Aufgabe Archiv', 'act', { actions: [{ do: 'new_card', title: 'Archiv', body: 'Archiv.' }], confirm: 'Neue Aufgabe „Archiv“.' });
    k.arm(heard.token!);
    expect(board.heldCommands()).toHaveLength(1);
    expect(k.undo(heard.token!)).toBe(true);
    expect(board.heldCommands()).toEqual([]);
    expect(k.holding()).toBe(false);

    let release = () => {};
    const slow = new Commander({ board, runtime, cwd: '/r', execute: () => new Promise<void>((r) => (release = r)), delayMs: 5 });
    const again = await say(slow, 'neue Aufgabe Export', 'act', { actions: [{ do: 'new_card', title: 'Export', body: 'Export.' }], confirm: 'Neue Aufgabe „Export“.' });
    slow.arm(again.heard.token!);
    await new Promise((r) => setTimeout(r, 20));
    // running: too late to take back, and a restart still waits for it
    expect(slow.undo(again.heard.token!)).toBe(false);
    expect(slow.holding()).toBe(true);
    expect(slow.undoable()).toEqual([]);
    release();
    await settle();
    expect(slow.holding()).toBe(false);
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

  test('a new card for a named later time is planned to start then („Folgekarte für Anfang Dezember“); a time passed or no time is refused', async () => {
    const k = commander();
    const p = (n: number) => String(n).padStart(2, '0');
    const local = (days: number) => {
      const d = new Date(Date.now() + days * 86_400_000);
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T08:00`;
    };
    const { heard, session } = await say(k, 'Leg eine Folgekarte an, dass ich mich Anfang Dezember um die Depots kümmere', 'act', {
      actions: [{ do: 'new_card', title: 'Depots einrichten', body: 'Anfang Dezember die Depots einrichten.', until: local(40) }],
      confirm: 'Neue Aufgabe „Depots einrichten“, sie startet am 1. Dezember um 8 Uhr.',
    });
    expect(session.spec.tools.find((t) => t.name === 'act')!.description).toContain('until when the owner names a time for the work');
    k.arm(heard.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'newCard', title: 'Depots einrichten', body: 'Anfang Dezember die Depots einrichten.', start: true, until: new Date(local(40)).toISOString() }]);
    // a day without an hour is 08:00 that day, local
    const day = local(40).slice(0, 10);
    const { heard: dated } = await say(k, 'und eine fürs Trinkgeld, auch Anfang Dezember', 'act', { actions: [{ do: 'new_card', title: 'Trinkgeld', body: 'Trinkgeld.', until: day }], confirm: '…' });
    k.arm(dated.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed[1]).toMatchObject({ do: 'newCard', until: new Date(`${day}T08:00`).toISOString() });
    for (const [until, why] of [
      [local(-1), 'that time has passed'],
      [local(400), 'more than a year ahead'],
      ['Anfang Dezember', 'until is no time'],
    ])
      expect(String(runtime.last.call('act', { actions: [{ do: 'new_card', title: 'X', body: 'Y', until }], confirm: 'x' }))).toContain(why!);
  });

  test('approval by word goes the way the repository sets: "ohne PR" gets a reply, never a push past the pull request', async () => {
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
      () => ({ docs: [], dirs: [] }),
    );
    const a = board.create({ title: 'Export', x: 0, y: 0, repo: 'shop' });
    const b = board.create({ title: 'Login', x: 0, y: 0, repo: 'app' });
    const c = board.create({ title: 'Logo', x: 0, y: 0, repo: 'self' });
    for (const card of [a, b, c]) board.work(card.id, { state: 'waiting', need: 'review' });
    const k = commander();
    const heard = k.hear('gib Export frei, direkt auf main ohne PR', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain("shop (Shop; approved work goes out as a pull request, or directly onto main by the card's button)");
    expect(s.inbox[0]).toContain('app (App; approved work goes out as a pull request)');
    // where the repository allows a direct push, the words still approve nothing: the button does it
    const refused = await s.call('act', { actions: [{ do: 'approve', card: 'K1', direct: true }], confirm: '…' });
    expect(refused).toContain('nothing was approved');
    expect(refused).toContain('„Direkt auf main“');
    const notAllowed = await s.call('act', { actions: [{ do: 'approve', card: 'K2', direct: true }], confirm: '…' });
    expect(notAllowed).toContain('the repository app lands approved work only through a pull request');
    // a plain approval goes out as the repository sets; where work lands on main anyway, "direkt" is a plain approval
    s.call('act', {
      actions: [
        { do: 'approve', card: 'K1' },
        { do: 'approve', card: 'K3', direct: true },
      ],
      confirm: '„Export“ geht als Pull Request raus, „Logo“ ist freigegeben.',
    });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'approve', card: a.id },
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
      demo: JSON.stringify({ kind: 'video', dir: '/d', chapters: [] }),
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
    board.work(a.id, { state: 'waiting', need: 'demo', demo: JSON.stringify({ kind: 'video', dir: '/d', chapters: [], question: 'Alte Projekte nachtragen?' }) });
    const k = commander();
    const heard = k.hear('ja zum Archiv', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('[waiting: demo] "Archiv" — open question in its demo report: "Alte Projekte nachtragen?"');
    expect(await s.call('act', { actions: [{ do: 'answer', card: 'K1', text: 'ja' }], confirm: 'Antwort an „Archiv“.' })).toContain('Done');
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'answer', card: a.id, text: 'ja', spoken: true }]);
  });

  test('„plane das als Projekt“ on a planned task of the owner’s plans its doc; on one with work, it is refused', async () => {
    const a = board.create({ title: 'Mandanten', x: 0, y: 0 });
    const k = commander();
    const heard = k.hear('plane das als Projekt', { card: a.id });
    await settle();
    const s = runtime.last;
    expect(s.spec.tools.find((t) => t.name === 'act')!.description).toContain('plan_doc also on a planned task');
    expect(await s.call('act', { actions: [{ do: 'plan_doc', card: 'K1' }], confirm: 'Plan-Doc für „Mandanten“.' })).toContain('Done');
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'planDoc', card: a.id }]);

    board.work(a.id, { branch: 'obeya/mandanten' });
    const again = k.hear('plane das als Projekt', { card: a.id });
    await settle();
    expect(await runtime.last.call('act', { actions: [{ do: 'plan_doc', card: 'K1' }], confirm: '…' })).toContain('only an idea, or a planned task of the owner');
    runtime.last.emit({ type: 'idle' });
    await again;
  });

    test("an idea's suggested next step, and its open questions with its agent's picks, are in its line: „mach, was du vorschlägst“ takes it", async () => {
    const a = board.create({ idea: true, title: 'Export', x: 0, y: 0 });
    board.setIdea(a.id, {
      yourTurn: true,
      questions: [{ text: 'Welches Format?', options: ['CSV', 'PDF'], pick: { options: ['CSV'], why: 'Excel.' } }],
      next: { step: 'answer', why: 'Das Format entscheidet den Rest.' },
    });
    const k = commander();
    const { brief } = await say(k, 'mach, was du vorschlägst', 'act', { actions: [{ do: 'discuss', card: 'K1', text: 'CSV' }], confirm: 'An „Export“: CSV.' });
    expect(brief).toContain(
      '"Export" — open question: "Welches Format?" (its agent would pick: CSV) — its agent would have the owner answer its open questions (discuss) next: Das Format entscheidet den Rest.',
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
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({
      docs: [
        { file: 'docs/plan/p.md', title: 'Export', goal: 'Ziel', workstreams: [ws('W1', true), ws('W2'), ws('W3')], markdown: '' },
        { file: 'docs/plan/q.md', title: 'Fertig', goal: 'Ziel', workstreams: [ws('W1', true)], markdown: '' },
      ],
      dirs: [],
    }));
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

  test("on a card, a reply that only answers is marked to stand in its conversation, a confirmation of actions is not; so is one to a request its agent passed on", async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const asked = k.hear('überlappt die mit Login?', { card: a.id }, [], { typed: true });
    await settle();
    runtime.last.call('reply', { confirm: 'Nein, Login ändert nur die Anmeldung.' });
    runtime.last.emit({ type: 'idle' });
    await asked;
    const started = k.hear('starte sie', { card: a.id }, [], { typed: true });
    await settle();
    runtime.last.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    runtime.last.emit({ type: 'idle' });
    await started;
    const forwarded = k.forward(a.id, 'Does this overlap with Login?', { text: 'überlappt die mit Login?', spoken: false });
    await settle();
    runtime.last.call('reply', { confirm: 'Nein.' });
    runtime.last.emit({ type: 'idle' });
    await forwarded;
    // the reply to what the card's agent passed on is marked, to stand under the agent's message
    expect(board.events(a.id).filter((e) => e.author === 'koordinator').map((e) => [e.text, !!e.reply, !!e.forwarded])).toEqual([
      ['Nein, Login ändert nur die Anmeldung.', true, false],
      ['„Export“ startet.', false, false],
      ['Nein.', true, true],
    ]);
  });

  test('a long reply stands whole in the sheet and on the card', async () => {
    const long = `${'Der Chatverlauf steht jetzt in einem eigenen Bereich. '.repeat(12)}Sag mir Bescheid, dann lege ich eine Aufgabe dafür an.`;
    const k = commander();
    expect((await say(k, 'wo ist der Chatverlauf?', 'reply', { confirm: long })).heard.confirm).toBe(long);
    expect(board.snapshot().talk.at(-1)!.reply).toBe(long);
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const heard = k.hear('und hier?', { card: a.id });
    await settle();
    runtime.last.call('reply', { confirm: long });
    runtime.last.emit({ type: 'idle' });
    await heard;
    expect(board.events(a.id).at(-1)!.text).toBe(long);
  });

  test('a reply that only answers waits in the sheet until the owner sees it; a confirmation of actions and a reply on a card do not', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    // it may come once the owner has closed the sheet: Obeya's button counts it until they see it
    await say(k, 'wie zerlegt Obeya Anforderungen?', 'reply', { confirm: 'In Stufen: Idee, Plan-Doc, Projekt.' });
    expect(board.snapshot().talk.at(-1)).toMatchObject({ reply: 'In Stufen: Idee, Plan-Doc, Projekt.', unread: true });
    expect(waitingOn(board.snapshot())).toBe(1);
    board.readTalk();
    expect(board.snapshot().talk.at(-1)!.unread).toBeUndefined();
    await say(k, 'starte Export', 'act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    expect(board.snapshot().talk.at(-1)!.unread).toBeUndefined();
    const heard = k.hear('was macht er?', { card: a.id });
    await settle();
    runtime.last.call('reply', { confirm: 'Er wartet.' });
    runtime.last.emit({ type: 'idle' });
    await heard;
    expect(board.talk().at(-1)!.unread).toBeUndefined();
  });

  test('words in reply to a message of the sheet stand with its quote, and the Koordinator reads the message whole', async () => {
    const k = commander();
    await say(k, 'wie viele Karten laufen?', 'reply', { confirm: 'Zwei: „Export“ und „Login“.' });
    const [first] = board.snapshot().talk;
    const reply = async (text: string, replyTo: unknown) => {
      const heard = k.hear(text, {}, [], { typed: true, replyTo: replyTo as never });
      await settle();
      const brief = runtime.last.inbox.at(-1)!;
      runtime.last.call('reply', { confirm: 'Ok.' });
      runtime.last.emit({ type: 'idle' });
      await heard;
      return brief;
    };
    expect(await reply('und welche davon wartet?', { talk: first!.id, part: 'reply' })).toContain(
      'The owner typed (as written, no recognition errors): "und welche davon wartet?"\n\n[In reply to your reply: „Zwei: „Export“ und „Login“.“]',
    );
    expect(board.snapshot().talk.at(-1)!.replyTo).toEqual({ talk: first!.id, part: 'reply', by: 'koordinator', text: 'Zwei: „Export“ und „Login“.' });
    expect(await reply('nochmal', { talk: first!.id, part: 'said' })).toContain('[In reply to their own earlier message: „wie viele Karten laufen?“]');
    // a looked-up answer goes by its tag, to follow up on it
    store.answerTalk(first!.id, 'Export wartet auf dich.', 'project');
    expect(await reply('warum?', { talk: first!.id, part: 'answer' })).toContain(`[In reply to the answer A${first!.id} the project's agent looked up: „Export wartet auf dich.“]`);
    // what is no message of the sheet is dropped, and the words go alone
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    await say(k, 'hallo', 'reply', { confirm: 'Hallo.' });
    const onCard = board.addTalk('starte ihn', 'Startet.', a.id);
    for (const ref of [{ talk: first!.id + 99, part: 'reply' }, { talk: onCard, part: 'reply' }, { talk: first!.id, part: 'nothing' }, 7]) {
      expect(await reply('so?', ref)).not.toContain('In reply to');
      expect(board.snapshot().talk.at(-1)!.replyTo).toBeUndefined();
    }
  });

  test("the owner's words stand in the conversation at once; the reply follows once the Koordinator has read them", async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const heard = k.hear('hallo nochmal', {});
    const onCard = k.hear('starte ihn', { card: a.id });
    await settle();
    // both wait: the first is being read, the second waits for its turn
    expect(board.snapshot().talk.map((t) => [t.said, t.reply])).toEqual([['hallo nochmal', undefined]]);
    expect(board.events(a.id).map((e) => [e.kind, e.author, e.text])).toEqual([['say', 'owner', 'starte ihn']]);
    // the words being read are not part of what the Koordinator remembers
    expect(runtime.last.inbox.at(-1)).toContain('You have not talked with the owner before.');
    runtime.last.call('reply', { confirm: 'Hallo!' });
    runtime.last.emit({ type: 'idle' });
    await heard;
    expect(board.snapshot().talk.map((t) => [t.said, t.reply])).toEqual([['hallo nochmal', 'Hallo!']]);
    await settle();
    runtime.last.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    runtime.last.emit({ type: 'idle' });
    await onCard;
    expect(board.events(a.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['say', 'owner', 'starte ihn'],
      ['say', 'koordinator', '„Export“ startet.'],
    ]);
  });

  test('words being read when Obeya stopped get a reply that says so, in the sheet and on the card', () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.addTalk('hallo', '');
    board.addTalk('starte ihn', '', a.id);
    board.log(a.id, 'say', 'owner', 'starte ihn');
    board.interruptTalk();
    expect(board.snapshot().talk.map((t) => t.reply)).toEqual(['Obeya startete neu, bevor ich das gelesen hatte. Bitte noch einmal.']);
    expect(board.events(a.id).at(-1)).toMatchObject({ kind: 'say', author: 'koordinator', text: 'Obeya startete neu, bevor ich das gelesen hatte. Bitte noch einmal.' });
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
    expect(await first).toEqual({ confirm: 'Eins.', talk: 1 });
    await settle();
    // the turn is still running: the idle that ends it must not answer the next command
    expect(s.inbox).toHaveLength(1);
    s.emit({ type: 'idle' });
    await settle();
    expect(s.inbox).toHaveLength(2);
    expect(s.inbox[1]).toContain('"zwei"');
    s.call('reply', { confirm: 'Zwei.' });
    s.emit({ type: 'idle' });
    expect(await second).toEqual({ confirm: 'Zwei.', talk: 2 });
  });
});

describe('the usage limit', () => {
  const hit = "You've hit your session limit · resets 7:20pm (Europe/Berlin)";
  const limited = () => new Commander({ board, runtime, cwd: '/r', execute: (c) => void executed.push(c), delayMs: 20, limitMargin: 10 });
  const lifts = (ms: number) => runtime.last.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + ms } });

  test('words the limit kept the Koordinator from reading wait and are read by themselves once it lifts; the reply comes with „Rückgängig“', async () => {
    board.create({ title: 'Export', x: 0, y: 0 });
    const notices: Notice[] = [];
    board.onNotice((n) => void notices.push(n));
    const k = limited();
    const heard = k.hear('starte Export', {});
    await settle();
    lifts(60);
    const { confirm } = await heard;
    expect(confirm).toStartWith('Das Nutzungslimit ist erreicht. Ich lese das um ');
    const [x] = board.snapshot().talk;
    // the sheet says when it reads them, not that it reads them now
    expect(x).toMatchObject({ said: 'starte Export' });
    expect(x!.reply).toBeUndefined();
    expect(Date.parse(x!.heldUntil!)).toBeGreaterThan(Date.now());
    expect(runtime.sessions).toHaveLength(1);

    await until(() => runtime.sessions.length === 2);
    // read now: „liest …“ under them again
    expect(board.snapshot().talk[0]!.heldUntil).toBeUndefined();
    expect(runtime.last.inbox.at(-1)).toContain("the account's usage limit kept you from reading it until now");
    runtime.last.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => notices.length);
    expect(notices[0]).toMatchObject({ text: '„Export“ startet.', undoMs: 20, talk: x!.id });
    expect(notices[0]!.token).toBeString();
    expect(board.snapshot().talk[0]!.reply).toBe('„Export“ startet.');
    await until(() => executed.length);
    expect(executed).toEqual([{ do: 'start', card: board.snapshot().items[0]!.id }]);
  });

  test('later words try the held ones first and, while the limit holds, wait behind them; on a card the wait is said once', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = limited();
    const first = k.hear('hallo', {});
    await settle();
    lifts(10_000);
    await first;
    // the owner says more before the limit lifts: the held words are tried at once, and the limit still holds
    const second = k.hear('starte ihn', { card: a.id });
    await settle();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.inbox.at(-1)).toContain('"hallo"');
    lifts(80);
    expect((await second).confirm).toStartWith('Das Nutzungslimit ist erreicht.');
    // not tried itself: the limit held the words before it
    expect(runtime.sessions).toHaveLength(2);
    expect(board.snapshot().talk.map((t) => !!t.heldUntil)).toEqual([true]);
    expect(store.heldTalk('c').map((t) => t.said)).toEqual(['hallo', 'starte ihn']);
    expect(board.events(a.id).map((e) => [e.author, e.text.slice(0, 30)])).toEqual([
      ['owner', 'starte ihn'],
      ['koordinator', 'Das Nutzungslimit ist erreicht'],
    ]);

    // it lifts: read in the order they were said
    await until(() => runtime.sessions.length === 3);
    expect(runtime.last.inbox.at(-1)).toContain('"hallo"');
    runtime.last.call('reply', { confirm: 'Hallo!' });
    runtime.last.emit({ type: 'idle' });
    await until(() => runtime.last.inbox.length === 2);
    expect(runtime.last.inbox.at(-1)).toContain('"starte ihn"');
    runtime.last.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => board.events(a.id).length === 3);
    expect(board.events(a.id).at(-1)).toMatchObject({ author: 'koordinator', text: '„Export“ startet.' });
    expect(store.heldTalk('c')).toEqual([]);
  });

  test('held words survive a restart and are read once the limit lifts', async () => {
    const k = limited();
    const heard = k.hear('was läuft?', {});
    await settle();
    lifts(10_000);
    await heard;
    // Obeya restarts, shortly before the limit lifts: the words are not cut off, and a new Commander reads them
    const [x] = store.heldTalk('c');
    store.holdTalk(x!.id, { ...x!.held, until: new Date(Date.now() + 30).toISOString() });
    board.interruptTalk();
    expect(board.snapshot().talk[0]!.reply).toBeUndefined();
    limited().resume();
    await until(() => runtime.sessions.length === 2);
    runtime.last.call('reply', { confirm: 'Nichts.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => board.snapshot().talk[0]!.reply === 'Nichts.');
    expect(store.heldTalk('c')).toEqual([]);
  });
});

describe('what the agent of a card passes on from the owner\'s words', () => {
  const DEMO = JSON.stringify({ kind: 'video', dir: '/d', chapters: [], question: 'Alte Projekte nachtragen?' });
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
    open({ state: 'waiting', need: 'demo', demo: JSON.stringify({ kind: 'video', dir: '/d', chapters: [] }) });
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
    check: async (input: unknown) => {
      const canvases = input as CanvasConfig[];
      const problems: ConfigProblem[] = canvases.some((c) => c.repos.some((r) => r.path === '/nirgends'))
        ? [{ code: 'notRepo', canvas: 0, repo: 0, detail: '/nirgends is not a git repository' }]
        : [];
      return { canvases, resolved: [], problems };
    },
    checkSaved: () => config.check(view.canvases),
  };
  const withConfig = () => new Commander({ board, runtime, cwd: '/r', execute: (c) => void executed.push(c), delayMs: 20, config });

  test('reads it for a question and replies', async () => {
    const k = withConfig();
    const heard = k.hear('welche Leinwände gibt es?', {});
    await settle();
    expect(JSON.parse(await runtime.last.call('config', {}))).toMatchObject({ file: '/h/canvases.json', running: ['obeya'], problems: [] });
    runtime.last.call('reply', { confirm: 'Eine: Obeya.' });
    runtime.last.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: 'Eine: Obeya.', talk: 1 });
  });

  test('changes it on the owner\'s word after the undo window; one that does not work goes back to it', async () => {
    const k = withConfig();
    const heard = k.hear('nimm das Repository nirgends dazu', {});
    await settle();
    const s = runtime.last;
    const bad = [{ name: 'Obeya', repos: [{ path: '/r' }, { path: '/nirgends' }] }];
    expect(await s.call('configure', { canvases: bad, confirm: 'Ok.' })).toContain('/nirgends is not a git repository');
    const good = [{ name: 'Obeya', repos: [{ path: '/r' }, { path: '/r2' }] }];
    await s.call('configure', { canvases: good, confirm: 'Das Repository r2 kommt dazu; Obeya startet danach neu.' });
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
    board = new Board(store, { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }, { id: 'app', name: 'App', path: '/o', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
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

describe('merging and deleting planned tasks by voice', () => {
  test('the Koordinator merges planned tasks of one repository nobody has worked on, the first staying, and deletes one; it is refused for others', async () => {
    const a = board.create({ title: 'Login error', x: 0, y: 0 });
    const b = board.create({ title: 'Sign in again', x: 400, y: 0 });
    const c = board.create({ title: 'Same again', x: 800, y: 0 });
    const started = board.create({ title: 'Started', x: 1200, y: 0 });
    board.work(started.id, { state: 'working', branch: 'obeya/started' });
    const stopped = board.create({ title: 'Stopped', x: 1600, y: 0 });
    board.work(stopped.id, { branch: 'obeya/stopped' });
    const k = commander();
    const heard = k.hear('fass Login error und Sign in again zusammen und lösch Same again', {});
    await settle();
    const s = runtime.last;
    expect(s.spec.tools.find((t) => t.name === 'act')!.description).toContain('- merge:');
    const act = (actions: Record<string, unknown>[]) => s.call('act', { actions, confirm: '…' });
    expect(act([{ do: 'merge', cards: ['K1'], title: 'X' }])).toContain('at least two cards');
    expect(act([{ do: 'merge', cards: ['K1', 'K2'] }])).toContain('title is missing');
    expect(act([{ do: 'merge', cards: ['K1', 'K4'], title: 'X' }])).toContain('K4 "Started" is working');
    expect(act([{ do: 'delete', card: 'K5' }])).toContain('K5 "Stopped" was worked on already');
    expect(act([{ do: 'delete', cards: ['K2', 'K3'] }])).toContain('one delete action for each');
    s.call('act', {
      actions: [
        { do: 'merge', cards: ['K1', 'K2'], title: ' Sign in again:  when and where ' },
        { do: 'delete', card: 'K3' },
      ],
      confirm: 'Zusammengeführt und gelöscht.',
    });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'merge', card: a.id, others: [b.id], title: 'Sign in again: when and where' },
      { do: 'delete', card: c.id },
    ]);
  });
});

describe("wishes for Obeya's makers", () => {
  test('a reply that Obeya cannot do something carries what the owner asked and the answer, for a draft', async () => {
    const k = commander();
    const { heard } = await say(k, 'sortier die Karten nach Datum', 'reply', { confirm: 'Karten nach Datum sortieren kann ich nicht; das gibt es in Obeya nicht.', wish: true });
    expect(heard).toEqual({ confirm: 'Karten nach Datum sortieren kann ich nicht; das gibt es in Obeya nicht.', cannot: true, talk: 1 });
    expect(board.snapshot().talk.at(-1)!.wish).toEqual({ said: 'sortier die Karten nach Datum', answer: 'Karten nach Datum sortieren kann ich nicht; das gibt es in Obeya nicht.' });
  });

  test('a reply for words that are unclear, or that failed just now, offers nothing', async () => {
    const k = commander();
    const { heard } = await say(k, 'mach das Ding da', 'reply', { confirm: 'Welche Aufgabe meinst du?' });
    expect(heard).toEqual({ confirm: 'Welche Aufgabe meinst du?', talk: 1 });
    expect(board.snapshot().talk.at(-1)!.wish).toBeUndefined();
  });

  test('a question looked up is never a wish, even flagged', async () => {
    const k = commander();
    const heard = k.hear('kann Obeya Karten nach Datum sortieren?', {});
    await settle();
    runtime.last.call('look_up', { question: 'Kann Obeya Karten nach Datum sortieren?', confirm: 'Ich schaue nach.' });
    runtime.last.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: 'Ich schaue nach.', talk: 1 });
    expect(board.snapshot().talk.at(-1)!.wish).toBeUndefined();
  });

  test('what the owner wants the makers told opens a draft at once: nothing runs, nothing to take back', async () => {
    const k = commander();
    const { heard } = await say(k, 'Obeya, Feedback: die Leiste soll sich ausblenden lassen', 'act', {
      actions: [{ do: 'wish', text: 'Die Leiste soll sich ausblenden lassen.' }],
      confirm: 'Der Entwurf für die Entwickler ist offen.',
    });
    expect(heard).toEqual({ confirm: 'Der Entwurf für die Entwickler ist offen.', wish: { said: 'Die Leiste soll sich ausblenden lassen.' }, talk: 1 });
    expect(board.snapshot().talk.at(-1)!.wish).toEqual({ said: 'Die Leiste soll sich ausblenden lassen.' });
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([]);
  });

  test('a wish beside another action: the other one waits for undo as usual', async () => {
    board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const { heard } = await say(k, 'starte Export und sag den Entwicklern, dass der Start zu lange dauert', 'act', {
      actions: [
        { do: 'start', card: 'K1' },
        { do: 'wish', text: 'Der Start dauert zu lange.' },
      ],
      confirm: '„Export“ startet; der Entwurf für die Entwickler ist offen.',
    });
    expect(heard.token).toBeDefined();
    expect(heard.wish).toEqual({ said: 'Der Start dauert zu lange.' });
    k.arm(heard.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed.map((c) => c.do)).toEqual(['start']);
  });

  test("a wish without text is sent back", async () => {
    const k = commander();
    const heard = k.hear('Feedback', {});
    await settle();
    expect(runtime.last.call('act', { actions: [{ do: 'wish' }], confirm: 'Offen.' })).toContain('Nothing recorded');
    runtime.last.call('reply', { confirm: 'Was sollen die Entwickler erfahren?' });
    runtime.last.emit({ type: 'idle' });
    expect((await heard).wish).toBeUndefined();
  });

  test("passed on by a card's agent: the answer on the card carries the flag", async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const k = commander();
    const heard = k.forward(a.id, 'Sort the cards by date.', { text: 'sortier die Karten nach Datum', spoken: true });
    await settle();
    runtime.last.call('reply', { confirm: 'Das kann Obeya nicht.', wish: true });
    runtime.last.emit({ type: 'idle' });
    expect(await heard).toEqual({ confirm: 'Das kann Obeya nicht.', cannot: true });
    const answer = board.events(a.id).find((e) => e.author === 'koordinator')!;
    expect(answer.wish).toEqual({ said: 'sortier die Karten nach Datum', answer: 'Das kann Obeya nicht.' });
  });
});

describe('snoozing by voice', () => {
  test('„stell das bis morgen früh zurück“ snoozes the card until that local time; wake brings a snoozed one back; the card list says it is snoozed', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'waiting', need: 'question', detail: JSON.stringify({ question: { text: 'CSV?', options: [] } }) });
    const k = commander();
    const next = new Date(Date.now() + 86_400_000);
    const p = (n: number) => String(n).padStart(2, '0');
    const local = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}T08:00`;
    const { heard, brief } = await say(k, 'stell Export bis morgen früh zurück', 'act', { actions: [{ do: 'snooze', card: 'K1', until: local }], confirm: '„Export“ bis morgen 8 Uhr zurückgestellt.' });
    expect(brief).toContain('Now: ');
    k.arm(heard.token!);
    await until(() => executed.length > 0);
    expect(executed).toEqual([{ do: 'snooze', card: a.id, until: new Date(local).toISOString() }]);

    board.snooze(a.id, { until: new Date(local).toISOString(), by: 'owner', waiting: true });
    const back = await say(k, 'hol Export zurück', 'act', { actions: [{ do: 'wake', card: 'K1' }], confirm: '„Export“ ist zurück.' });
    expect(back.brief).toContain('snoozed by the owner until');
    k.arm(back.heard.token!);
    await until(() => executed.length > 1);
    expect(executed[1]).toEqual({ do: 'wake', card: a.id });
  });

  test('„erst am Montag starten“ snoozes a planned card, which the card list then says starts at the time', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const k = commander();
    const { heard } = await say(k, 'Export erst am Montag starten', 'act', { actions: [{ do: 'snooze', card: 'K1', until: '2030-01-07T08:00' }], confirm: '„Export“ startet Montag um 8.' });
    k.arm(heard.token!);
    await until(() => executed.length > 0);
    expect(executed).toEqual([{ do: 'snooze', card: a.id, until: new Date('2030-01-07T08:00').toISOString() }]);
    board.snooze(a.id, { until: new Date('2030-01-07T08:00').toISOString(), by: 'owner', start: true });
    const { brief } = await say(k, 'was ist mit Export?', 'reply', { confirm: 'Startet Montag.' });
    expect(brief).toContain('it starts then; start or wake starts it now');
  });

  test('a time that passed, or a card neither planned, at work nor waiting, is refused', async () => {
    const done = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(done.id, { state: 'live' });
    const k = commander();
    const s = k.hear('stell Export zurück', {});
    await settle();
    const r = runtime.last.call('act', { actions: [{ do: 'snooze', card: 'K1', until: '2030-01-01T08:00' }], confirm: 'x' });
    expect(String(r)).toContain('nothing to snooze');
    runtime.last.call('reply', { confirm: 'Geht nicht.' });
    runtime.last.emit({ type: 'idle' });
    await s;
  });
});

describe('a step the Koordinator takes once a card gets somewhere', () => {
  /** Runs commands as the canvas does: a new card is created, and its id comes back for a wait on it. */
  const making = () =>
    new Commander({
      board,
      runtime,
      cwd: '/r',
      delayMs: 20,
      execute: (c) => {
        executed.push(c);
        if (c.do === 'newCard') return board.create({ title: c.title, x: 0, y: 0 }).id;
      },
    });

  test('it waits on the new card of the same command, and once that is done takes the step up by itself, with „Rückgängig“', async () => {
    const other = board.create({ title: 'Leserina einrichten', x: 0, y: 0 });
    const notices: Notice[] = [];
    board.onNotice((n) => void notices.push(n));
    const k = making();
    const { heard, session } = await say(k, 'Leg eine Aufgabe an, die das Repo erstellt, und dann die Leinwand', 'act', {
      actions: [
        { do: 'new_card', title: 'Repository ~/dev/leserina anlegen', body: 'git init in ~/dev/leserina' },
        { do: 'wait_for', on: 'Repository ~/dev/leserina anlegen', text: 'Start K1, then tell K1 “Leserina einrichten” and „Leserina einrichten“ (K1).' },
      ],
      confirm: 'Neue Aufgabe „Repository ~/dev/leserina anlegen“; sobald sie erledigt ist, starte ich „Leserina einrichten“.',
    });
    expect(session.spec.system).toContain('wait_for in the same act');
    k.arm(heard.token!);
    await until(() => board.snapshot().talk[0]!.waits);
    const card = board.snapshot().items.find((i) => i.title === 'Repository ~/dev/leserina anlegen')!;
    expect(board.snapshot().talk[0]!.waits).toEqual([{ card: card.id, title: card.title, state: 'done' }]);

    // the next command knows what it waits on
    const next = await say(k, 'was läuft?', 'reply', { confirm: 'Das Repository wird angelegt.' });
    expect(next.brief).toMatch(/Cards you wait on.*\n- K\d "Repository ~\/dev\/leserina anlegen" until it is done \(since .*\), then: Start "Leserina einrichten", then tell “Leserina einrichten” and „Leserina einrichten“\./);

    // still at work: nothing happens
    board.work(card.id, { state: 'working' });
    k.due(board.snapshot().items);
    expect(board.snapshot().talk).toHaveLength(2);

    board.work(card.id, { state: 'done' });
    k.due(board.snapshot().items);
    // a second look while the step is being taken does not take it twice
    k.due(board.snapshot().items);
    await until(() => runtime.last.inbox.length === 3);
    const brief = runtime.last.inbox.at(-1)!;
    expect(brief).toContain("No words of the owner's this time");
    expect(brief).toContain('the card "Repository ~/dev/leserina anlegen" is done');
    expect(brief).toContain('to then: Start "Leserina einrichten", then tell “Leserina einrichten” and „Leserina einrichten“.');
    const [, , after] = board.snapshot().talk;
    // the exchange stands with what became of the card in place of the owner's words
    expect(after).toMatchObject({ said: '', after: { title: card.title, state: 'done', met: 'reached', from: board.snapshot().talk[0]!.id } });
    runtime.last.call('act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Leserina einrichten“ startet.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => notices.length);
    expect(notices[0]).toMatchObject({ text: '„Leserina einrichten“ startet.', talk: after!.id, undoMs: 20 });
    // decided: it no longer waits
    expect(board.snapshot().talk[0]!.waits).toBeUndefined();
    await until(() => executed.length === 2);
    expect(executed[1]).toEqual({ do: 'start', card: other.id });
    expect(board.snapshot().talk).toHaveLength(3);
    // the owner said none of it: nothing to learn from
    expect(store.utterances('c', '2000-01-01', 10).map((u) => u.text)).toEqual(['Leg eine Aufgabe an, die das Repo erstellt, und dann die Leinwand', 'was läuft?']);
  });

  test('a card that no longer gets there wakes it too, to tell the owner; a fresh session remembers the exchange', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const k = making();
    const { heard } = await say(k, 'wenn Export wartet, sag ihm, es soll CSV nehmen', 'act', {
      actions: [{ do: 'wait_for', on: 'K1', state: 'waits_for_owner', text: 'Tell its agent to use CSV (note).' }],
      confirm: 'Sobald „Export“ auf dich wartet, sage ich ihm, es soll CSV nehmen.',
    });
    k.arm(heard.token!);
    await until(() => board.snapshot().talk[0]!.waits);
    expect(board.snapshot().talk[0]!.waits).toEqual([{ card: a.id, title: 'Export', state: 'waitsForOwner' }]);
    board.work(a.id, { state: 'planned', branch: 'obeya/export' });
    k.due(board.snapshot().items);
    await until(() => runtime.last.inbox.length === 2);
    expect(runtime.last.inbox.at(-1)).toContain('the card "Export" was stopped by the owner');
    expect(runtime.last.inbox.at(-1)).toContain('tell the owner with reply');
    runtime.last.call('reply', { confirm: '„Export“ wurde gestoppt; ich habe ihm nichts gesagt.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => board.snapshot().talk[1]?.reply);

    // after a restart, the new session reads the exchange as one it took up by itself
    const fresh = making();
    const later = await say(fresh, 'und?', 'reply', { confirm: 'Nichts weiter.' });
    expect(later.brief).toContain('the card "Export" was stopped by the owner (planned again), and you took up the step you had waited on it for → you: "„Export“ wurde gestoppt; ich habe ihm nichts gesagt."');
  });

  test('a wait names its new card by title, whatever else the command holds; several steps on one card each stand', async () => {
    const k = making();
    const { heard } = await say(k, 'zwei Aufgaben, und danach je etwas', 'act', {
      actions: [
        { do: 'new_card', title: 'Erste', body: '' },
        { do: 'new_card', title: 'Zweite', body: '' },
        { do: 'wait_for', on: 'erste', text: 'Tell the owner Erste is done.' },
        { do: 'wait_for', on: 'Erste', state: 'waits_for_owner', text: 'Pass on: use CSV.' },
      ],
      confirm: 'Zwei Aufgaben; danach melde ich mich.',
    });
    k.arm(heard.token!);
    await until(() => board.snapshot().talk[0]!.waits?.length === 2);
    const first = board.snapshot().items.find((i) => i.title === 'Erste')!;
    expect(board.snapshot().talk[0]!.waits).toEqual([
      { card: first.id, title: 'Erste', state: 'done' },
      { card: first.id, title: 'Erste', state: 'waitsForOwner' },
    ]);
  });

  test('a card that got done counts as done for a wait until it waits for the owner', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const k = making();
    const { heard } = await say(k, 'wenn Export wartet, sag Bescheid', 'act', { actions: [{ do: 'wait_for', on: 'K1', state: 'waits_for_owner', text: 'Tell the owner.' }], confirm: 'Gut.' });
    k.arm(heard.token!);
    await until(() => board.snapshot().talk[0]!.waits);
    board.work(a.id, { state: 'live' });
    k.due(board.snapshot().items);
    await until(() => runtime.last.inbox.length === 2);
    expect(runtime.last.inbox.at(-1)).toContain('Now the card "Export" is done.');
    expect(board.snapshot().talk[1]!.after).toMatchObject({ state: 'done', met: 'reached' });
  });

  test('the wait stands while the step is read: a restart takes it up again, and dropping it then takes back what was decided', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const b = board.create({ title: 'Login', x: 0, y: 0 });
    board.work(a.id, { state: 'working' });
    const k = making();
    const { heard } = await say(k, 'wenn Export fertig ist, starte Login', 'act', { actions: [{ do: 'wait_for', on: 'K1', text: 'Start „Login“.' }], confirm: 'Mache ich.' });
    k.arm(heard.token!);
    await until(() => board.snapshot().talk[0]!.waits);
    board.work(a.id, { state: 'live' });
    k.due(board.snapshot().items);
    await until(() => runtime.last.inbox.length === 2);
    expect(board.snapshot().talk[0]!.waits).toHaveLength(1);
    // the owner drops it while it is read: the start it decides is taken back
    expect(k.unwait(board.snapshot().talk[0]!.id, a.id)).toBe(true);
    runtime.last.call('act', { actions: [{ do: 'start', card: 'K2' }], confirm: '„Login“ startet.' });
    runtime.last.emit({ type: 'idle' });
    await until(() => board.snapshot().talk[1]!.undone);
    await settle();
    expect(executed.filter((c) => c.do === 'start')).toEqual([]);
    expect(b.id).toBeString();
  });

  test('a card there already is refused; stop_waiting and „Nicht mehr warten“ drop the step, and it hears of the latter', async () => {
    const a = board.create({ title: 'Export', x: 0, y: 0 });
    const b = board.create({ title: 'Login', x: 0, y: 0 });
    board.work(a.id, { state: 'live' });
    board.work(b.id, { state: 'working' });
    const k = making();
    const s = k.hear('wenn Export fertig ist, starte Login', {});
    await settle();
    expect(String(runtime.last.call('act', { actions: [{ do: 'wait_for', on: 'K1', text: 'start K2' }], confirm: 'x' }))).toContain('is done already: take the step now');
    expect(String(runtime.last.call('act', { actions: [{ do: 'wait_for', on: 'K2' }], confirm: 'x' }))).toContain('the step you take then is missing');
    expect(String(runtime.last.call('act', { actions: [{ do: 'wait_for', on: 'Gibt es nicht', text: 'x' }], confirm: 'x' }))).toContain('no card Gibt es nicht: give with on the tag of the card to wait on');
    expect(String(runtime.last.call('act', { actions: [{ do: 'stop_waiting', card: 'K2' }], confirm: 'x' }))).toContain('you do not wait on K2');
    runtime.last.call('act', { actions: [{ do: 'wait_for', on: 'K2', text: 'Tell the owner Login is done.' }], confirm: 'Ich sage dir, wenn Login fertig ist.' });
    runtime.last.emit({ type: 'idle' });
    k.arm((await s).token!);
    await until(() => board.snapshot().talk[0]!.waits);

    const { heard } = await say(k, 'vergiss das mit Login', 'act', { actions: [{ do: 'stop_waiting', on: 'K2' }], confirm: 'Ich warte nicht mehr auf „Login“.' });
    k.arm(heard.token!);
    await until(() => !board.snapshot().talk[0]!.waits);

    const again = await say(k, 'doch, sag Bescheid', 'act', { actions: [{ do: 'wait_for', on: 'K2', text: 'Tell the owner Login is done.' }], confirm: 'Gut.' });
    k.arm(again.heard.token!);
    await until(() => board.snapshot().talk[2]!.waits);
    const talk = board.snapshot().talk[2]!.id;
    expect(k.unwait(talk, 'nope')).toBe(false);
    expect(k.unwait(talk, b.id)).toBe(true);
    expect(board.snapshot().talk[2]!.waits).toBeUndefined();
    const next = await say(k, 'und?', 'reply', { confirm: 'Nichts.' });
    expect(next.brief).toContain('The owner told you to stop waiting on „Login“');
    expect(next.brief).not.toContain('Cards you wait on');
    board.work(b.id, { state: 'live' });
    k.due(board.snapshot().items);
    await settle();
    expect(board.snapshot().talk).toHaveLength(4);
  });
});

describe('a step the Koordinator takes once it has looked something up', () => {
  /** Runs commands as the canvas does; a question it looks up is answered when the test says. */
  const looking = (asked: number[] = []) =>
    new Commander({
      board,
      runtime,
      cwd: '/r',
      delayMs: 20,
      lookUp: (talk) => void asked.push(talk),
      execute: (c) => {
        executed.push(c);
        if (c.do === 'newCard') return board.create({ title: c.title, x: 0, y: 0 }).id;
      },
    });

  test('a task for each open issue: it looks them up, then creates the tasks itself, with „Rückgängig“', async () => {
    const notices: Notice[] = [];
    board.onNotice((n) => void notices.push(n));
    const asked: number[] = [];
    const k = looking(asked);
    const { session } = await say(k, 'Es gibt drei offene Issues bei GitHub, erstelle für jedes eine eigene Karte.', 'look_up', {
      question: 'Welche Issues sind auf GitHub offen, jeweils mit Nummer, Titel, Link und worum es geht?',
      then: 'Create a task for each open issue, its title from the issue, its body naming the issue with its link.',
      confirm: 'Ich lese die offenen Issues auf GitHub und lege dann für jedes eine Aufgabe an.',
    });
    expect(session.spec.system).toContain('look_up with then');
    const [asking] = board.snapshot().talk;
    expect(asked).toEqual([asking!.id]);
    expect(asking).toMatchObject({ question: 'Welche Issues sind auf GitHub offen, jeweils mit Nummer, Titel, Link und worum es geht?', then: 'Create a task for each open issue, its title from the issue, its body naming the issue with its link.' });
    // no answer yet: nothing to take up
    expect(k.answerIn(asking!.id)).toBe(false);

    board.answerTalk(asking!.id, '- #27 Skills per „/“ (https://github.com/o/r/issues/27)\n- #25 Freigabe scheitert (https://github.com/o/r/issues/25)', 'koordinator');
    expect(k.answerIn(asking!.id)).toBe(true);
    // a second call while it is taken up takes it up once
    expect(k.answerIn(asking!.id)).toBe(false);
    await until(() => runtime.last.inbox.length === 2);
    const brief = runtime.last.inbox.at(-1)!;
    expect(brief).toContain("No words of the owner's this time");
    expect(brief).toContain('to then: Create a task for each open issue');
    expect(brief).toContain(`The answer A${asking!.id} is in (the owner sees it too): - #27 Skills per „/“`);
    const after = board.snapshot().talk[1]!;
    // the exchange stands without words of the owner's, after the one whose answer came in
    expect(after).toMatchObject({ said: '', answered: asking!.id });
    runtime.last.call('act', {
      actions: [
        { do: 'new_card', title: 'Skills per „/“', body: 'GitHub-Issue #27: https://github.com/o/r/issues/27' },
        { do: 'new_card', title: 'Freigabe scheitert', body: 'GitHub-Issue #25: https://github.com/o/r/issues/25' },
      ],
      confirm: 'Zwei neue Aufgaben: „Skills per „/““ und „Freigabe scheitert“.',
    });
    runtime.last.emit({ type: 'idle' });
    await until(() => notices.length);
    expect(notices[0]).toMatchObject({ text: 'Zwei neue Aufgaben: „Skills per „/““ und „Freigabe scheitert“.', talk: after.id, undoMs: 20 });
    // decided: the step is no longer to take
    expect(board.snapshot().talk[0]!.then).toBeUndefined();
    expect(board.answeredSteps()).toEqual([]);
    await until(() => executed.length === 2);
    expect(executed.map((c) => c.do === 'newCard' && c.title)).toEqual(['Skills per „/“', 'Freigabe scheitert']);
    // the owner said it once: nothing more to learn from
    expect(store.utterances('c', '2000-01-01', 10).map((u) => u.text)).toEqual(['Es gibt drei offene Issues bei GitHub, erstelle für jedes eine eigene Karte.']);

    // a fresh session reads the exchange as one it took up by itself
    const fresh = looking();
    const later = await say(fresh, 'und?', 'reply', { confirm: 'Nichts weiter.' });
    expect(later.brief).toContain(`the answer A${asking!.id} came in, and you took up the step you had looked it up for → you: "Zwei neue Aufgaben`);
  });

  test('a question looked up without a step is only answered', async () => {
    const k = looking();
    await say(k, 'welche Issues sind offen?', 'look_up', { question: 'Welche Issues sind offen?', confirm: 'Ich schaue nach.' });
    const [asking] = board.snapshot().talk;
    expect(asking!.then).toBeUndefined();
    board.answerTalk(asking!.id, 'Zwei.', 'koordinator');
    expect(k.answerIn(asking!.id)).toBe(false);
  });

  test('an answer that came in before a restart, its step not decided, is taken up by the next start', async () => {
    const k = looking();
    await say(k, 'leg für jedes offene Issue eine Aufgabe an', 'look_up', { question: 'Welche Issues sind offen?', then: 'Create a task for each.', confirm: 'Ich lese nach und lege sie dann an.' });
    const [asking] = board.snapshot().talk;
    board.answerTalk(asking!.id, '#3 Login', 'koordinator');
    expect(board.answeredSteps().map((x) => x.id)).toEqual([asking!.id]);
    // the server stops before it takes the step up; the next one does
    looking().resume();
    await until(() => runtime.last.inbox.length === 1);
    expect(runtime.last.inbox[0]).toContain('to then: Create a task for each.');
    expect(runtime.last.inbox[0]).toContain('is in (the owner sees it too): #3 Login');
  });
});

describe('other canvases and new repositories', () => {
  test('a new card or idea goes onto another canvas the owner names; one the Obeya does not have is refused with those it has', async () => {
    const k = new Commander({ board, runtime, cwd: '/r', execute: (c) => void executed.push(c), delayMs: 20, canvases: () => [{ id: 'super59', name: 'Super 59' }] });
    const heard = k.hear('leg auf Super 59 eine Aufgabe Termine an', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox.at(-1)).toContain('Other canvases of this Obeya (new_card and new_idea go there with canvas): "Super 59"');
    expect(s.call('act', { actions: [{ do: 'new_idea', title: 'X', canvas: 'Shop' }], confirm: '…' })).toContain('unknown canvas Shop; the other canvases are "Super 59"');
    s.call('act', { actions: [{ do: 'new_card', title: 'Termine', body: 'Termine.', canvas: 'Super 59' }, { do: 'new_idea', title: 'Hier', canvas: 'C' }], confirm: 'Lege „Termine“ auf Super 59 an.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await until(() => executed.length === 2);
    expect(executed[0]).toMatchObject({ do: 'newCard', title: 'Termine', canvas: 'super59' });
    // this canvas by its name is no other one
    expect(executed[1]).not.toHaveProperty('canvas');
  });

  test('„bau das in einem neuen Repo unter …“ builds an idea, or starts a planned task, in a new repository; a card already at work is refused', async () => {
    const idea = board.create({ idea: true, title: 'Termine', x: 0, y: 0 });
    const task = board.create({ title: 'Export', x: 0, y: 0 });
    board.work(task.id, { state: 'working' });
    const k = commander();
    const heard = k.hear('bau das in einem neuen Repo unter ~/dev/super59', { card: idea.id });
    await settle();
    const s = runtime.last;
    expect(s.call('act', { actions: [{ do: 'build', card: 'K1', path: 'dev/super59' }], confirm: '…' })).toContain('give it absolute or from ~');
    expect(s.call('act', { actions: [{ do: 'start', card: 'K2', path: '~/dev/export', own_canvas: false }], confirm: '…' })).toContain('only an idea, or a planned task');
    s.call('act', { actions: [{ do: 'build', card: 'K1', path: '~/dev/super59' }], confirm: 'Baue es in ~/dev/super59.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await until(() => executed.length);
    expect(executed[0]).toEqual({ do: 'newRepo', card: idea.id, path: '~/dev/super59', canvas: true });
  });
});
