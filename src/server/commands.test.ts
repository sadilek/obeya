import { beforeEach, describe, expect, test } from 'bun:test';
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

describe('the Koordinator remembers', () => {
  test('the conversation goes on in one session; card tags stay, and each command brings what happened since', async () => {
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
    const k = commander();
    const first = await say(k, 'starte Export', 'act', { actions: [{ do: 'start', card: 'K1' }], confirm: '„Export“ startet.' });
    expect(first.brief).toContain('K1 [planned] feature "Export"');
    expect(first.brief).toContain('You have not talked with the owner before.');

    board.create({ kind: 'bugfix', title: 'Login', x: 0, y: 0 });
    board.log(a.id, 'question', 'worker', 'CSV oder Excel?');
    const second = await say(k, 'und die andere auch', 'act', { actions: [{ do: 'start', card: 'K2' }], confirm: '„Login“ startet.' });
    expect(second.session).toBe(first.session);
    expect(runtime.sessions).toHaveLength(1);
    // Export keeps K1, the new card gets the next tag
    expect(second.brief).toContain('K1 [planned] feature "Export"');
    expect(second.brief).toContain('K2 [planned] bugfix "Login"');
    expect(second.brief).toContain("What happened on the canvas since the owner's last command:");
    expect(second.brief).toContain('K1 "Export": the agent asked: CSV oder Excel?');
    expect(second.brief).toContain('K2 "Login": new card');
    expect(second.brief).not.toContain('You have not talked');
  });

  test('a command the owner takes back is told with the next one, and marked in the conversation', async () => {
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
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
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
    board.work(a.id, { state: 'waiting', need: 'review' });
    const k = commander();
    const { heard } = await say(k, 'gib das frei und mach ein Folge-Feature fürs Archiv', 'act', {
      actions: [
        { do: 'approve', card: 'K1' },
        { do: 'new_card', kind: 'feature', title: 'Archiv', body: 'Folge von Export', start: false },
      ],
      confirm: '„Export“ freigegeben, „Archiv“ angelegt.',
    });
    expect(heard.confirm).toBe('„Export“ freigegeben, „Archiv“ angelegt.');
    k.arm(heard.token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([
      { do: 'approve', card: a.id },
      { do: 'newCard', kind: 'feature', title: 'Archiv', body: 'Folge von Export', start: false },
    ]);
  });

  test("the open card brings its whole summary and its demo's findings, so a follow-up carries what it is about", async () => {
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
    const summary = `Export schreibt jetzt CSV. ${'Viel Kontext. '.repeat(40)}Ende der Zusammenfassung.`;
    const finding = 'Der `ambient`-Ton läuft nach dem Stopp weiter.';
    board.work(a.id, {
      state: 'waiting',
      need: 'demo',
      detail: JSON.stringify({ summary }),
      demo: JSON.stringify({ dir: '/d', chapters: [], shown: [], notShown: [], findings: [finding, 'Zweite Auffälligkeit.'] }),
    });
    const k = commander();
    const heard = k.hear('Freigegeben und lege eine Folgekarte für die ambient-Auffälligkeit an', { card: a.id });
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain(`Its worker's summary:\n${summary}`);
    expect(s.inbox[0]).toContain(`Findings of its demo (things the worker noticed beyond the task):\n1. ${finding}\n2. Zweite Auffälligkeit.`);
    expect(await s.call('act', { actions: [{ do: 'new_card', card: 'K9', title: 'x' }], confirm: '…' })).toContain('unknown tag K9');
    s.call('act', {
      actions: [
        { do: 'approve', card: 'K1' },
        { do: 'new_card', card: 'K1', kind: 'bugfix', title: 'ambient-Ton stoppen', body: finding, start: false },
      ],
      confirm: '„Export“ freigegeben, Folgekarte „ambient-Ton stoppen“ angelegt.',
    });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed[1]).toEqual({ do: 'newCard', kind: 'bugfix', title: 'ambient-Ton stoppen', body: finding, start: false, from: a.id });

    // once a finding has its card, the Koordinator hears which
    board.create({ kind: 'bugfix', title: 'ambient-Ton stoppen', body: finding, from: a.id });
    const next = k.hear('und die zweite auch', { card: a.id });
    await settle();
    expect(runtime.last.inbox.at(-1)).toContain(`1. ${finding} (follow-up card: K2 "ambient-Ton stoppen")`);
    expect(runtime.last.inbox.at(-1)).toContain('2. Zweite Auffälligkeit.\n');
    runtime.last.call('reply', { confirm: 'Gut.' });
    runtime.last.emit({ type: 'idle' });
    await next;
  });

  test('an action that does not fit the card is refused in the turn, so the Koordinator can answer instead', async () => {
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
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

  test("the question in a demo report is the card's open question: a bare „ja“ answers it", async () => {
    const a = board.create({ kind: 'feature', title: 'Archiv', x: 0, y: 0 });
    board.work(a.id, { state: 'waiting', need: 'demo', demo: JSON.stringify({ dir: '/d', chapters: [], shown: [], notShown: [], findings: [], question: 'Alte Projekte nachtragen?' }) });
    const k = commander();
    const heard = k.hear('ja', { card: a.id });
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('[waiting: demo] feature "Archiv" — open question in its demo report: Alte Projekte nachtragen?');
    expect(await s.call('act', { actions: [{ do: 'answer', card: 'K1', text: 'ja' }], confirm: 'Antwort an „Archiv“.' })).toContain('Done');
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'answer', card: a.id, text: 'ja' }]);
  });

  test('a landed card whose agent finishes what remains still takes notes', async () => {
    const a = board.create({ kind: 'feature', title: 'Archiv', x: 0, y: 0 });
    board.work(a.id, { state: 'live', workspace: '/w', landed: '{}' });
    const k = commander();
    const { brief, heard } = await say(k, 'sag Archiv, es soll auch die alten Karten nachtragen', 'act', {
      actions: [{ do: 'note', card: 'K1', text: 'Auch die alten Karten nachtragen.' }],
      confirm: 'Weitergegeben.',
    });
    expect(brief).toContain('K1 [live, its agent finishes what remains after the landing] feature "Archiv"');
    expect(heard.token).toBeDefined();
  });

  test('starting a queued card starts it now despite the overlap; one still being checked starts by itself', async () => {
    const running = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
    board.work(running.id, { state: 'working' });
    const behind = board.create({ kind: 'feature', title: 'Archiv', x: 0, y: 0 });
    board.work(behind.id, { queue: JSON.stringify({ behind: [running.id], reason: 'beide ändern export.ts' }) });
    const checking = board.create({ kind: 'bugfix', title: 'Login', x: 0, y: 0 });
    board.work(checking.id, { queue: JSON.stringify({ checking: true }) });
    const k = commander();
    const heard = k.hear('starte alle wartenden Karten', {});
    await settle();
    const s = runtime.last;
    expect(s.inbox[0]).toContain('K2 [queued behind "Export"] feature "Archiv"');
    expect(s.inbox[0]).toContain('K3 [queued: the Koordinator checks it for overlaps] bugfix "Login"');
    const refused = await s.call('act', { actions: [{ do: 'start', card: 'K2' }, { do: 'start', card: 'K3' }], confirm: 'Beide starten.' });
    expect(refused).toContain('action 2 (start on K3): the Koordinator is still checking the card');
    s.call('act', { actions: [{ do: 'start', card: 'K2' }], confirm: '„Archiv“ startet trotz Überschneidung.' });
    s.emit({ type: 'idle' });
    k.arm((await heard).token!);
    await new Promise((r) => setTimeout(r, 40));
    expect(executed).toEqual([{ do: 'force', card: behind.id }]);
  });

  test("the exchange goes into the open card's log; without an open card into the sheet", async () => {
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
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
    const a = board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
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
    board.create({ kind: 'feature', title: 'Export', x: 0, y: 0 });
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
