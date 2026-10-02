import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { MIGRATIONS, Store } from './db';
import { FakeRuntime, noForge, type FakeSession, gitRepo, identify } from './testing';
import { git } from './workspaces';

let dir: string;
let main: string;
let store: Store;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;
let spoken: [string | undefined, string][];

const open = (clones = 1) =>
  new CanvasRuntime({ repos: [{ path: main, clones }] }, { store, home: dir, runtime, forge: noForge, commandDelayMs: 10 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-ideas-'));
  main = join(dir, 'main');
  gitRepo(main);
  mkdirSync(join(main, 'docs/plan'), { recursive: true });
  store = new Store(':memory:');
  runtime = new FakeRuntime();
  canvas = open();
  spoken = [];
  canvas.board.onSpeak((id, text) => spoken.push([id, text]));
});
afterEach(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const board = () => canvas.board;
const item = (id: string) => board().item(id)!;
const idea = (title = 'Export für Vermieter', body = 'Vermieter wollen ihre Zählerstände.') => board().create({ idea: true, title, body, x: 0, y: 0 });
const explorer = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'update_brief')).at(-1)!;
const talk = (id: string) => board().events(id).filter((e) => e.kind === 'talk').map((e) => [e.author, e.text]);
const turn = (s: FakeSession, reply: string, extra?: () => void) => {
  s.emit({ type: 'session', id: 'sess-1' });
  extra?.();
  s.call('reply', { text: reply, spoken: `Kurz: ${reply}` });
  s.emit({ type: 'idle' });
};

describe('an idea', () => {
  test('starts as an idea: no worker, no workspace, nothing with the Koordinator', () => {
    const i = idea();
    expect(item(i.id)).toMatchObject({ state: 'idea', idea: { status: 'open', brief: '', thinking: false, yourTurn: false, questions: [] } });
    expect(runtime.sessions).toHaveLength(0);
    expect(() => canvas.act(i.id, { action: 'start' })).toThrow('only a planned card can be started');
  });

  test('is discussed with a read-only agent that keeps the brief and records decisions', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Lass uns das durchdenken.' });
    const s = explorer();
    expect(s.spec).toMatchObject({ readOnly: true, cwd: main });
    expect(s.spec.resume).toBeUndefined();
    expect(s.inbox[0]).toContain('The idea: “Export für Vermieter”.');
    expect(s.inbox[0]).toContain('Vermieter wollen ihre Zählerstände.');
    expect(s.inbox[0]).toContain('Lass uns das durchdenken.');
    expect(item(i.id).idea!.thinking).toBe(true);
    turn(s, 'CSV oder PDF?', () => {
      s.call('update_brief', { brief: '**Ziel:** Vermieter exportieren Zählerstände.' });
      s.call('record_decision', { question: 'Format?', answer: 'CSV' });
    });
    expect(s.closed).toBe(true);
    expect(item(i.id).idea).toEqual({ status: 'open', brief: '**Ziel:** Vermieter exportieren Zählerstände.', thinking: false, yourTurn: true, questions: [] });
    expect(talk(i.id)).toEqual([
      ['owner', 'Lass uns das durchdenken.'],
      ['explorer', 'CSV oder PDF?'],
    ]);
    expect(board().decisions(null)).toMatchObject([{ card_id: i.id, question: 'Format?', answer: 'CSV', by: 'owner' }]);
    // typed: nothing is spoken
    expect(spoken).toEqual([]);
  });

  test('keeps what its agent read and thought on the way to a reply, but not its words after it', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Was meinst du?' });
    const s = explorer();
    s.emit({ type: 'tool', name: 'Read', input: { file_path: '/repo/src/server/board.ts' } });
    s.emit({ type: 'text', text: 'Das Archiv nimmt keine Projekte auf.' });
    s.call('update_brief', { brief: '**Ziel:** Archiv für Projekte.' });
    s.emit({ type: 'tool', name: 'mcp__obeya__update_brief', input: {} });
    s.call('reply', { text: 'Ziel und Ist-Stand stehen im Stand. Eine offene Frage.', spoken: '' });
    s.emit({ type: 'text', text: 'Fertig.' });
    s.emit({ type: 'idle' });
    expect(board().events(i.id).filter((e) => e.author === 'explorer').map((e) => [e.kind, e.text])).toEqual([
      ['activity', 'Liest server/board.ts'],
      ['say', 'Das Archiv nimmt keine Projekte auf.'],
      ['activity', 'Aktualisiert den Stand der Idee'],
      ['talk', 'Ziel und Ist-Stand stehen im Stand. Eine offene Frage.'],
    ]);
  });

  test('its conversation goes on in the same session, and what the owner says during a turn waits for it', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Erstens.' });
    const first = explorer();
    first.emit({ type: 'session', id: 'sess-1' });
    canvas.act(i.id, { action: 'discuss', text: 'Zweitens.' });
    expect(first.inbox).toHaveLength(1);
    first.call('reply', { text: 'Zu erstens.', spoken: '' });
    first.emit({ type: 'idle' });
    // the queued message is the next turn of the same session
    expect(first.closed).toBe(false);
    expect(first.inbox[1]).toContain('Zweitens.');
    first.call('reply', { text: 'Zu zweitens.', spoken: '' });
    first.emit({ type: 'idle' });
    expect(first.closed).toBe(true);
    // days later
    canvas.act(i.id, { action: 'discuss', text: 'Drittens.' });
    const later = explorer();
    expect(later).not.toBe(first);
    expect(later.spec.resume).toBe('sess-1');
    expect(later.inbox).toEqual(['The owner says:\n\nDrittens.']);
  });

  test('screenshots the owner adds reach the agent and stay in the conversation', () => {
    const i = idea();
    const id = canvas.images.save(new Uint8Array([1, 2, 3]), 'image/png');
    canvas.act(i.id, { action: 'discuss', text: 'So sieht die Seite heute aus', images: [id] });
    const s = explorer();
    expect(s.images[0]).toEqual([canvas.images.path(id)!]);
    expect(board().events(i.id).at(-1)).toMatchObject({ kind: 'talk', author: 'owner', images: [id] });
    // a second one during the turn waits, with its screenshot, for the turn to end
    const id2 = canvas.images.save(new Uint8Array([4]), 'image/png');
    canvas.act(i.id, { action: 'discuss', text: '', images: [id2] });
    turn(s, 'Verstehe.');
    expect(s.images[1]).toEqual([canvas.images.path(id2)!]);
  });

  test("a planned card's screenshots reach its exploration agent; built, the discussion's go to the task", () => {
    const task = canvas.images.save(new Uint8Array([1]), 'image/png');
    const c = board().create({ title: 'Seite bricht um', x: 0, y: 0, images: [task] });
    board().patch(c.id, { state: 'idea' });
    canvas.act(c.id, { action: 'discuss', text: 'Wie gehen wir das an?' });
    const s = explorer();
    expect(s.images[0]).toEqual([canvas.images.path(task)!]);
    expect(s.inbox[0]).toContain('The owner attached a screenshot to the card');
    const shown = canvas.images.save(new Uint8Array([2]), 'image/png');
    turn(s, 'Zwei Wege.');
    canvas.act(c.id, { action: 'discuss', text: 'Und hier auf dem Handy', images: [shown] });
    turn(explorer(), 'Verstehe.');
    canvas.act(c.id, { action: 'build' });
    expect(item(c.id).images).toEqual([task, shown]);
  });

  test('a spoken message gets a spoken summary; a turn without reply still answers with its words', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Was kostet das?', spoken: true });
    turn(explorer(), 'Etwa zwei Tage.');
    expect(spoken).toEqual([[i.id, 'Kurz: Etwa zwei Tage.']]);
    canvas.act(i.id, { action: 'discuss', text: 'Und dann?' });
    const s = explorer();
    s.emit({ type: 'text', text: 'Dann ein Plan-Doc.' });
    s.emit({ type: 'idle' });
    expect(talk(i.id).at(-1)).toEqual(['explorer', 'Dann ein Plan-Doc.']);
  });

  test('once its agent has replied the owner is next, until they answer', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Erstens.' });
    const s = explorer();
    s.emit({ type: 'session', id: 'sess-1' });
    expect(item(i.id).idea).toMatchObject({ thinking: true, yourTurn: false });
    canvas.act(i.id, { action: 'discuss', text: 'Zweitens.' });
    s.call('reply', { text: 'Zu erstens.', spoken: '' });
    s.emit({ type: 'idle' });
    // the owner's second message is still to be answered
    expect(item(i.id).idea).toMatchObject({ thinking: true });
    s.call('reply', { text: 'Zu zweitens.', spoken: '' });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea).toMatchObject({ thinking: false, yourTurn: true, questions: [] });
    canvas.act(i.id, { action: 'discuss', text: 'Drittens.' });
    expect(item(i.id).idea).toMatchObject({ thinking: true, yourTurn: false });
    // a turn that ends without words leaves nothing to answer
    explorer().emit({ type: 'idle' });
    expect(item(i.id).idea).toMatchObject({ thinking: false, yourTurn: false, questions: [] });
  });

  test('its agent asks with answer options, which stand until the owner says something', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Los.' });
    const s = explorer();
    s.call('reply', {
      text: 'Zwei Fragen.',
      spoken: '',
      questions: [
        { question: 'Welches Format?', options: ['CSV', 'PDF', 'CSV'] },
        { question: 'Für wen?', options: ['Vermieter', 'Verwalter'], multiple: true },
        { question: 'Wann?', options: [], multiple: true },
        { question: ' ', options: ['x'] },
      ],
    });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea).toMatchObject({
      yourTurn: true,
      questions: [
        { text: 'Welches Format?', options: ['CSV', 'PDF'] },
        { text: 'Für wen?', options: ['Vermieter', 'Verwalter'], multiple: true },
        { text: 'Wann?', options: [] },
      ],
    });
    expect(item(i.id).idea!.questions[0]!.multiple).toBeUndefined();
    expect(item(i.id).idea!.questions[2]!.multiple).toBeUndefined();
    canvas.act(i.id, { action: 'discuss', text: '- **Welches Format?** CSV' });
    expect(item(i.id).idea).toMatchObject({ yourTurn: false, questions: [] });
    expect(explorer().inbox.at(-1)).toContain('- **Welches Format?** CSV');
  });

  test('its agent says what it would do in the owner’s place, which stands until the owner says something', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Los.' });
    let s = explorer();
    s.call('reply', {
      text: 'Eine Frage noch.',
      spoken: '',
      questions: [
        { question: 'Welches Format?', options: ['CSV', 'PDF'], pick: ['CSV '], pick_why: 'Vermieter rechnen in Excel weiter.' },
        { question: 'Für wen?', options: ['Vermieter', 'Verwalter'], multiple: true, pick: ['Vermieter', 'Mieter', 'Verwalter'], pick_why: 'Beide.' },
        { question: 'Wann?', options: ['Sofort', 'Später'], pick: ['Sofort', 'Später'], pick_why: 'Zwei sind eins zu viel.' },
        { question: 'Wie heißt es?', options: ['Export'], pick: ['Ausfuhr'], pick_why: 'Nicht unter den Optionen.' },
      ],
      next: { step: 'answer', why: 'Das Format entscheidet den Rest.' },
    });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea).toMatchObject({
      questions: [
        { text: 'Welches Format?', pick: { options: ['CSV'], why: 'Vermieter rechnen in Excel weiter.' } },
        { text: 'Für wen?', pick: { options: ['Vermieter', 'Verwalter'], why: 'Beide.' } },
        // one option only where only one may be chosen
        { text: 'Wann?', pick: { options: ['Sofort'] } },
        { text: 'Wie heißt es?' },
      ],
      next: { step: 'answer', why: 'Das Format entscheidet den Rest.' },
    });
    expect(item(i.id).idea!.questions[3]!.pick).toBeUndefined();
    canvas.act(i.id, { action: 'discuss', text: '- **Welches Format?** CSV' });
    expect(item(i.id).idea!.next).toBeUndefined();
    s = explorer();
    // answering without questions, or a step there is no button for, is no suggestion
    s.call('reply', { text: 'Danke.', spoken: '', next: { step: 'answer', why: '?' } });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea!.next).toBeUndefined();
    canvas.act(i.id, { action: 'discuss', text: 'Und jetzt?' });
    s = explorer();
    s.call('reply', { text: 'Bauen.', spoken: '', next: { step: 'deploy', why: '?' } });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea!.next).toBeUndefined();
    canvas.act(i.id, { action: 'discuss', text: 'Und jetzt?' });
    s = explorer();
    s.call('reply', { text: 'Bauen.', spoken: '', next: { step: 'build', why: 'Der Stand reicht als Auftrag.' } });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea!.next).toEqual({ step: 'build', why: 'Der Stand reicht als Auftrag.' });
  });

  test('an idea whose agent had the last word before the update waits for the owner', () => {
    const path = join(dir, 'obeya.db');
    const s = new Store(path);
    s.ensureCanvas('c', 'C');
    const idea = JSON.stringify({ status: 'open', brief: '' });
    const [answered, asked] = s.insert([0, 1].map((y) => ({ canvas_id: 'c', kind: 'card' as const, state: 'idea' as const, idea, x: 0, y })));
    const say = (card: string, author: 'owner' | 'explorer') => s.addEvent({ cardId: card, kind: 'talk', author, text: '…' });
    say(answered!.id, 'owner');
    say(answered!.id, 'explorer');
    say(asked!.id, 'explorer');
    say(asked!.id, 'owner');
    // the migration that came with it, as it ran on a store from before
    s.db.run(MIGRATIONS.find((m) => m.includes('yourTurn'))!);
    const yourTurn = (id: string) => (JSON.parse(s.card(id)!.idea!) as { yourTurn?: boolean }).yourTurn;
    expect(yourTurn(answered!.id)).toBe(true);
    expect(yourTurn(asked!.id)).toBeUndefined();
    s.db.close();
  });

  test('what the owner says is offered for learning preferences', async () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Exporte immer als CSV.' });
    await settle();
    const learn = runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'propose'))!;
    expect(learn.inbox[0]).toContain('words in the discussion of an idea: Exporte immer als CSV.');
  });

  test('a preference learned while its agent works reaches it once, with its next tool step', () => {
    board().addPreference('Antworten auf Deutsch.');
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Lass uns das durchdenken.' });
    const s = explorer();
    expect(s.spec.system).toContain('- Antworten auf Deutsch.');
    // what its instructions hold is nothing new
    expect(s.toolStep()).toBeUndefined();
    const id = board().addPreference('Varianten immer mit Aufwand.');
    expect(s.toolStep()).toContain('- Varianten immer mit Aufwand.');
    expect(s.toolStep()).toBeUndefined();
    board().setPreference(id, null);
    expect(s.toolStep()).not.toContain('Varianten immer mit Aufwand.');
    // silently: no message, no new turn
    expect(s.inbox).toHaveLength(1);
  });

  test('"So bauen" starts it with the brief as its task', async () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Los.' });
    turn(explorer(), 'Gut.', () => explorer().call('update_brief', { brief: '**Ziel:** CSV-Export.' }));
    canvas.act(i.id, { action: 'build' });
    expect(item(i.id)).toMatchObject({ state: 'planned', body: '**Ziel:** CSV-Export.', title: 'Export für Vermieter', queue: { checking: true } });
    expect(item(i.id).idea).toBeUndefined();
    await settle();
    expect(item(i.id).state).toBe('working');
    const worker = runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'ready_for_review'))!;
    expect(worker.inbox[0]).toContain('**Ziel:** CSV-Export.');
    expect(board().decisions(null).at(-1)).toMatchObject({ answer: 'So bauen, wie der Stand der Idee sagt.' });
    expect(() => canvas.act(i.id, { action: 'discuss', text: 'Noch was.' })).toThrow('not an idea');
  });

  test('a big idea becomes a project: a worker starts on its plan doc at once, on the idea’s card', async () => {
    const i = idea();
    board().setIdea(i.id, { brief: '**Ziel:** Vermieterportal.' });
    canvas.act(i.id, { action: 'planDoc' });
    const c = item(i.id);
    expect(c).toMatchObject({ state: 'planned', title: 'Export für Vermieter', becomesProject: true, brief: '**Ziel:** Vermieterportal.', queue: { checking: true } });
    expect(c.body).toContain('`docs/plan/`');
    expect(c.body).toContain('## Workstreams');
    expect(c.body).toContain('**Ziel:** Vermieterportal.');
    await settle();
    expect(item(i.id).state).toBe('working');
    const worker = runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'ready_for_review'))!;
    expect(worker.inbox[0]).toContain('**Ziel:** Vermieterportal.');
  });

  test('parked or dropped it keeps its brief; talking to it opens it again', () => {
    const i = idea();
    board().setIdea(i.id, { brief: 'Stand.' });
    canvas.act(i.id, { action: 'park' });
    expect(item(i.id)).toMatchObject({ state: 'idea', idea: { status: 'parked', brief: 'Stand.' } });
    canvas.act(i.id, { action: 'drop' });
    expect(item(i.id).idea!.status).toBe('dropped');
    canvas.act(i.id, { action: 'discuss', text: 'Doch nochmal.' });
    expect(item(i.id).idea!.status).toBe('open');
    expect(() => canvas.act(board().create({ title: 'X', x: 0, y: 0 }).id, { action: 'park' })).toThrow('not an idea');
  });

  test('a planned card of the owner’s can become an idea first', () => {
    const c = board().create({ title: 'Unklar', x: 0, y: 0 });
    board().patch(c.id, { state: 'idea' });
    expect(item(c.id).idea).toEqual({ status: 'open', brief: '', thinking: false, yourTurn: false, questions: [] });
  });

  test('after a restart an idea whose agent was answering gets its reply', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Frage.' });
    explorer().emit({ type: 'session', id: 'sess-9' });
    canvas.shutdown();
    canvas = open();
    const s = explorer();
    expect(s.spec.resume).toBe('sess-9');
    expect(s.inbox[0]).toContain('Obeya was restarted');
  });

  test('building and planning wait for its agent’s reply, which changes the brief they decide on', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Nimm noch den PDF-Export auf.' });
    const s = explorer();
    s.emit({ type: 'session', id: 'sess-1' });
    s.call('update_brief', { brief: '**Ziel:** CSV- und PDF-Export.' });
    expect(() => canvas.act(i.id, { action: 'build' })).toThrow('still working on its reply');
    expect(() => canvas.act(i.id, { action: 'planDoc' })).toThrow('still working on its reply');
    expect(item(i.id)).toMatchObject({ state: 'idea', idea: { thinking: true } });
    expect(s.closed).toBe(false);
    s.call('reply', { text: 'PDF ist im Stand.', spoken: '' });
    s.emit({ type: 'idle' });
    canvas.act(i.id, { action: 'build' });
    expect(item(i.id)).toMatchObject({ state: 'planned', body: '**Ziel:** CSV- und PDF-Export.' });
  });

  test('parked or dropped during a turn, what its agent has not answered goes to it first when the conversation goes on, across a restart', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Erstens.' });
    const first = explorer();
    first.emit({ type: 'session', id: 'sess-1' });
    const shot = canvas.images.save(new Uint8Array([1]), 'image/png');
    canvas.act(i.id, { action: 'discuss', text: 'Zweitens.', images: [shot] });
    canvas.act(i.id, { action: 'park' });
    expect(first.closed).toBe(true);
    expect(item(i.id).idea).toMatchObject({ status: 'parked', thinking: false });
    canvas.shutdown();
    canvas = open();
    expect(runtime.sessions.filter((x) => x.spec.tools.some((t) => t.name === 'update_brief'))).toHaveLength(1);
    canvas.act(i.id, { action: 'discuss', text: 'Drittens.' });
    const later = explorer();
    expect(later).not.toBe(first);
    expect(later.spec.resume).toBe('sess-1');
    expect(later.inbox[0]).toContain('The owner parked the idea while you were working on a reply');
    expect(later.inbox[0]!.indexOf('Erstens.')).toBeLessThan(later.inbox[0]!.indexOf('Zweitens.'));
    expect(later.inbox[0]!.indexOf('Zweitens.')).toBeLessThan(later.inbox[0]!.indexOf('Drittens.'));
    expect(later.images[0]).toEqual([canvas.images.path(shot)!]);
    // dropped in the middle of this turn, the three wait again, now as dropped
    canvas.act(i.id, { action: 'drop' });
    canvas.act(i.id, { action: 'discuss', text: 'Viertens.' });
    const again = explorer();
    expect(again.inbox[0]).toContain('The owner dropped the idea');
    expect(again.inbox[0]).toContain('Drittens.');
    turn(again, 'Zu allen vier.');
    // answered, nothing waits any more
    canvas.act(i.id, { action: 'discuss', text: 'Fünftens.' });
    expect(explorer().inbox).toEqual(['The owner says:\n\nFünftens.']);
  });

  test('a turn that ends with an error keeps what it did not answer', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Erstens.' });
    const s = explorer();
    s.emit({ type: 'session', id: 'sess-1' });
    canvas.act(i.id, { action: 'discuss', text: 'Zweitens.' });
    s.emit({ type: 'error', message: 'rate limit' });
    expect(item(i.id).idea).toMatchObject({ status: 'open', thinking: false });
    canvas.act(i.id, { action: 'discuss', text: 'Hallo?' });
    const next = explorer();
    expect(next.inbox[0]).toContain('Your last turn ended with an error');
    expect(next.inbox[0]).toContain('Erstens.');
    expect(next.inbox[0]).toContain('Zweitens.');
    expect(next.inbox[0]).toContain('Hallo?');
  });

  test('what waited for its agent’s turn when Obeya stopped reaches it after the restart', () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Frage.' });
    explorer().emit({ type: 'session', id: 'sess-9' });
    canvas.act(i.id, { action: 'discuss', text: 'Noch eine.' });
    canvas.shutdown();
    canvas = open();
    const s = explorer();
    expect(s.spec.resume).toBe('sess-9');
    expect(s.inbox[0]).toContain('Noch eine.');
    expect(s.inbox[0]).not.toContain('Frage.');
  });
});

describe('a prototype', () => {
  const demoDir = (name = 'demo') => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'demo.mp4'), '0');
    writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n\n00:00:00.351 --> 00:00:10.000\nSo sähe es aus.\n');
    return d;
  };
  const workers = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'ready_for_review'));
  const worker = () => workers()[0]!;
  const prototypes = (ideaId: string) =>
    board()
      .snapshot()
      .items.filter((x) => x.prototypeOf === ideaId);
  const archived = (id: string) => board().archived().find((i) => i.id === id);
  /** The prototype's worker commits something on its branch, as a real one would. */
  const commit = (cardId: string, file: string) => {
    const ws = board().row(cardId).workspace!;
    identify(ws);
    writeFileSync(join(ws, file), 'prototyp\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '--quiet', '-m', `Prototyp ${file}`);
  };
  /** The worker asks, and the Koordinator passes the question on to the owner. */
  const ask = async (s: FakeSession, question: string, options: string[]) => {
    s.call('ask', { question, options });
    await settle();
    const advisor = runtime.sessions.filter((x) => x.spec.tools.some((t) => t.name === 'escalate')).at(-1)!;
    advisor.call('escalate', { question, options });
    await settle();
  };
  const handOver = (s: FakeSession, summary: string, demo = 'demo') =>
    s.call('ready_for_review', { summary, demo: { dir: demoDir(demo), chapters: ['Knopf'], shown: ['Knopf'], not_shown: [], findings: [] } });

  test('builds a throwaway prototype whose demo shows on the idea; discarded, it goes into the archive', () => {
    const i = idea();
    board().setIdea(i.id, { brief: '**Ziel:** CSV-Export.' });
    canvas.act(i.id, { action: 'discuss', text: 'Zeig mal.' });
    turn(explorer(), 'Ein Prototyp hilft.');
    canvas.act(i.id, { action: 'prototype', text: 'Den Export-Knopf. Oben rechts in der Leiste.' });
    const [prototype] = prototypes(i.id);
    expect(prototype).toMatchObject({ state: 'working', title: 'Prototyp: Export für Vermieter – Den Export-Knopf', from: i.id, body: 'Den Export-Knopf. Oben rechts in der Leiste.' });
    expect(item(i.id).state).toBe('idea');
    // while the prototype is built, the owner waits for it, not the idea for the owner
    expect(item(i.id).idea).toMatchObject({ yourTurn: false, thinking: false });
    const w = worker();
    expect(w.inbox[0]).toContain('throwaway prototype');
    expect(w.inbox[0]).toContain('**Ziel:** CSV-Export.');
    expect(w.inbox[0]).not.toContain('Before ready_for_review, run');
    // a prototype never lands, so it holds no files for the Koordinator
    expect(canvas.koordinator.inProgress()).toEqual([]);

    const ws = board().row(prototype!.id).workspace!;
    const branch = board().row(prototype!.id).branch!;
    handOver(w, 'Knopf gebaut.');
    // the demo stays the prototype's, and shows on the idea under its title
    expect(item(i.id).demo).toBeUndefined();
    expect(item(i.id).prototypes).toMatchObject([{ id: prototype!.id, title: prototype!.title, demo: { chapters: [[0, 'Knopf']] } }]);
    expect(explorer().inbox.at(-1)).toContain('Knopf gebaut.');
    expect(explorer().inbox.at(-1)).toContain(prototype!.title);
    turn(explorer(), 'Der Knopf trägt; nimmst du ihn?');
    expect(item(i.id).idea).toMatchObject({ yourTurn: true });
    expect(item(prototype!.id)).toMatchObject({ state: 'waiting', need: 'demo' });

    // approving a prototype is having seen enough: it is discarded
    canvas.act(prototype!.id, { action: 'approve' });
    expect(board().item(prototype!.id)).toBeUndefined();
    expect(git(main, 'branch', '--list', branch)).toBe('');
    expect(git(ws, 'branch', '--list', branch)).toBe('');
    expect(canvas.repos[0]!.workspaces.leasedBy(prototype!.id)).toBeNull();
    // in the archive with its demo, summary and log, and it stays there
    expect(archived(prototype!.id)).toMatchObject({ prototypeEnd: 'discarded', summary: 'Knopf gebaut.', demo: { chapters: [[0, 'Knopf']] } });
    expect(board().demoFiles(prototype!.id)).toEqual({ dir: join(dir, 'demo'), kind: 'video' });
    expect(board().events(prototype!.id).at(-1)!.text).toContain('Verworfen');
    expect(() => board().unarchive(prototype!.id)).toThrow(expect.objectContaining({ code: 'prototypeEnded' }));
    // the idea still shows its demo
    expect(item(i.id).prototypes).toMatchObject([{ id: prototype!.id, prototypeEnd: 'discarded', demo: { chapters: [[0, 'Knopf']] } }]);
    expect(board().events(i.id).at(-1)!.text).toContain('verworfen');
  });

  test('several run side by side, each with its approach, and the idea shows every demo', () => {
    canvas.shutdown();
    canvas = open(3);
    const i = idea('Logo für Obeya');
    canvas.act(i.id, { action: 'prototype', text: 'Wortmarke: der Name in eigener Schrift' });
    canvas.act(i.id, { action: 'prototype', text: 'Bildmarke' });
    canvas.act(i.id, { action: 'prototype' });
    const all = prototypes(i.id);
    expect(all.map((p) => p.title)).toEqual(['Prototyp: Logo für Obeya – Wortmarke', 'Prototyp: Logo für Obeya – Bildmarke', 'Prototyp: Logo für Obeya']);
    expect(all.every((p) => p.state === 'working')).toBe(true);
    // side by side below the idea, not on top of each other
    expect(new Set(all.map((p) => p.y)).size).toBe(1);
    expect(all[1]!.x - all[0]!.x).toBeGreaterThan(200);
    handOver(workers()[0]!, 'Wortmarke.', 'a');
    handOver(workers()[1]!, 'Bildmarke.', 'b');
    expect(item(i.id).prototypes!.map((p) => [p.title, !!p.demo])).toEqual([
      ['Prototyp: Logo für Obeya – Wortmarke', true],
      ['Prototyp: Logo für Obeya – Bildmarke', true],
      ['Prototyp: Logo für Obeya', false],
    ]);
    // a running prototype keeps a dropped idea on the canvas
    canvas.act(i.id, { action: 'drop' });
    expect(() => board().archive([i.id])).toThrow(expect.objectContaining({ code: 'prototypeRunning' }));
  });

  test('a second prototype with the same approach is numbered', () => {
    canvas.shutdown();
    canvas = open(2);
    const i = idea();
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    canvas.act(prototypes(i.id)[0]!.id, { action: 'discard' });
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    expect(prototypes(i.id).map((p) => p.title)).toEqual(['Prototyp: Export für Vermieter – Knopf (2)']);
  });

  test('"Diesen Prototyp bauen" builds the idea on its branch; the others are discarded', async () => {
    canvas.shutdown();
    canvas = open(3);
    const i = idea();
    board().setIdea(i.id, { brief: '**Ziel:** CSV-Export.' });
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    canvas.act(i.id, { action: 'prototype', text: 'Menü' });
    const [chosen, other] = prototypes(i.id);
    const [w, wOther] = workers();
    commit(chosen!.id, 'knopf.txt');
    commit(other!.id, 'menu.txt');
    // the chosen one's worker asked the owner something on its card
    await ask(w!, 'Knopf oben oder unten?', ['oben', 'unten']);
    canvas.act(chosen!.id, { action: 'answer', text: 'oben' });
    handOver(w!, 'Knopf oben gebaut; Export als CSV.');
    const ws = board().row(chosen!.id).workspace!;
    const otherWs = board().row(other!.id).workspace!;
    const otherBranch = board().row(other!.id).branch!;
    // the idea's agent takes in the answer, then the handover
    explorer().emit({ type: 'idle' });
    explorer().emit({ type: 'idle' });

    canvas.act(chosen!.id, { action: 'buildPrototype' });
    // the idea is the feature now, in the prototype's workspace, on its branch under the idea's name
    const built = item(i.id);
    expect(built).toMatchObject({ state: 'planned', body: '**Ziel:** CSV-Export.', builtOn: chosen!.id });
    expect(built.idea).toBeUndefined();
    const row = board().row(i.id);
    expect(row.workspace).toBe(ws);
    expect(row.branch).toMatch(/^obeya\/export-fur-vermieter-/);
    expect(git(ws, 'branch', '--show-current')).toBe(row.branch!);
    expect(git(ws, 'log', '--format=%s', '-1')).toBe('Prototyp knopf.txt');
    expect(canvas.repos[0]!.workspaces.leasedBy(i.id)).toBe(ws);
    // the chosen prototype goes into the archive as built, its worker stopped
    expect(w!.closed).toBe(true);
    expect(archived(chosen!.id)).toMatchObject({ prototypeEnd: 'built', summary: 'Knopf oben gebaut; Export als CSV.' });
    expect(canvas.repos[0]!.workspaces.leasedBy(chosen!.id)).toBeNull();
    // the other one is discarded with its code
    expect(wOther!.closed).toBe(true);
    expect(archived(other!.id)).toMatchObject({ prototypeEnd: 'discarded' });
    expect(git(otherWs, 'branch', '--list', otherBranch)).toBe('');
    expect(prototypes(i.id)).toEqual([]);
    expect(board().decisions(null).at(-1)).toMatchObject({ card_id: i.id, answer: `So bauen, auf Prototyp „${chosen!.title}“.` });

    // its worker goes on from the branch: the brief, the prototype's handover and the owner's answers
    await settle();
    expect(item(i.id).state).toBe('working');
    const builder = workers().at(-1)!;
    expect(builder.spec.cwd).toBe(ws);
    const brief = builder.inbox[0]!;
    expect(brief).toContain('**Ziel:** CSV-Export.');
    expect(brief).toContain('throwaway prototype');
    expect(brief).toContain('production quality');
    expect(brief).toContain('Knopf oben gebaut; Export als CSV.');
    expect(brief).toContain('- Knopf oben oder unten? → oben');
    expect(brief).toContain(`You are on branch ${row.branch}, which holds the prototype's commits`);
    expect(builder.spec.tools.some((t) => t.name === 'propose_card')).toBe(true);
  });

  test("a prototype's worker proposes building the idea on it instead of making cards", () => {
    const i = idea();
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    const [prototype] = prototypes(i.id);
    const w = worker();
    expect(w.spec.tools.some((t) => t.name === 'propose_card')).toBe(false);
    expect(w.spec.system).toContain('propose_build');
    expect(w.call('propose_build', { reason: 'Der Owner hat den Knopf gewählt.' })).toContain('owner decides');
    expect(item(prototype!.id).buildProposal).toBe('Der Owner hat den Knopf gewählt.');
    expect(board().snapshot().items.filter((x) => x.state === 'proposal')).toEqual([]);
    // accepting it is "Diesen Prototyp bauen"
    canvas.act(prototype!.id, { action: 'buildPrototype' });
    expect(item(i.id)).toMatchObject({ state: 'planned', builtOn: prototype!.id });
    expect(archived(prototype!.id)!.buildProposal).toBeUndefined();
  });

  test("its questions and the owner's answers reach the idea's agent, for the brief only", async () => {
    const i = idea();
    canvas.act(i.id, { action: 'discuss', text: 'Los.' });
    turn(explorer(), 'Ein Prototyp?');
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    const [prototype] = prototypes(i.id);
    await ask(worker(), 'Welche Farbe?', ['Blau', 'Grün']);
    canvas.act(prototype!.id, { action: 'answer', text: 'Blau' });
    const s = explorer();
    expect(s.inbox.at(-1)).toContain('„Welche Farbe?“');
    expect(s.inbox.at(-1)).toContain('The owner answered: Blau');
    // what it says on the way is no reply: the owner is not asked again
    s.call('update_brief', { brief: '**Entscheidungen:** Blau.' });
    s.emit({ type: 'text', text: 'Im Stand festgehalten.' });
    s.emit({ type: 'idle' });
    expect(item(i.id).idea).toMatchObject({ brief: '**Entscheidungen:** Blau.', yourTurn: false, thinking: false });
    expect(talk(i.id).at(-1)).toEqual(['explorer', 'Ein Prototyp?']);
  });

  test('"So bauen" discards the prototypes still on the canvas', () => {
    const i = idea();
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    const [prototype] = prototypes(i.id);
    canvas.act(i.id, { action: 'build' });
    expect(archived(prototype!.id)).toMatchObject({ prototypeEnd: 'discarded' });
    expect(item(i.id).builtOn).toBeUndefined();
  });

  test('deleting a prototype discards it into the archive, workspace and all', () => {
    const i = idea();
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    const [prototype] = prototypes(i.id);
    canvas.remove(prototype!.id);
    expect(archived(prototype!.id)).toMatchObject({ prototypeEnd: 'discarded' });
    expect(canvas.repos[0]!.workspaces.leasedBy(prototype!.id)).toBeNull();
    expect(() => canvas.act(i.id, { action: 'buildPrototype' })).toThrow('not a prototype');
  });
});

describe('by voice', () => {
  const reader = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'act')).at(-1)!;

  test('"Ich will über … nachdenken" makes an idea whose agent opens the discussion', async () => {
    const heard = canvas.commander.hear('Ich will über Export für Vermieter nachdenken', {});
    await settle();
    reader().call('act', { actions: [{ do: 'new_idea', title: 'Export für Vermieter', body: 'Über Export für Vermieter nachdenken.' }], confirm: 'Neue Idee „Export für Vermieter“.' });
    const h = await heard;
    canvas.commander.arm(h.token!);
    await settle(30);
    const i = board()
      .snapshot()
      .items.find((x) => x.state === 'idea')!;
    expect(i.title).toBe('Export für Vermieter');
    expect(talk(i.id)).toEqual([['owner', 'Über Export für Vermieter nachdenken.']]);
    turn(explorer(), 'Für welche Vermieter?');
    expect(spoken).toEqual([[i.id, 'Kurz: Für welche Vermieter?']]);
  });

  test('talking to the open idea reaches its agent at once, and needs no confirmation', async () => {
    const i = idea();
    const heard = canvas.commander.hear('eher als PDF', { card: i.id });
    await settle();
    expect(reader().inbox[0]).toContain('[idea] "Export für Vermieter"');
    reader().call('act', { actions: [{ do: 'discuss', card: 'K1', text: 'Eher als PDF.' }], confirm: 'An die Idee weitergegeben.' });
    expect(await heard).toEqual({ confirm: 'An die Idee weitergegeben.', quiet: true });
    expect(talk(i.id)).toEqual([['owner', 'Eher als PDF.']]);
    expect(explorer().inbox[0]).toContain('Eher als PDF.');
  });

  test('"nimm noch X auf und bau es dann" only passes X on: building waits for the reply', async () => {
    const i = idea();
    const heard = canvas.commander.hear('nimm noch PDF auf und bau es dann', { card: i.id });
    await settle();
    const refused = reader().call('act', {
      actions: [
        { do: 'discuss', card: 'K1', text: 'Nimm noch PDF auf.' },
        { do: 'build', card: 'K1' },
      ],
      confirm: 'PDF kommt dazu, dann wird gebaut.',
    });
    expect(refused).toContain('Nothing recorded: action 2 (build on K1): the idea\'s agent starts on a reply with the discuss in this command');
    expect(talk(i.id)).toEqual([]);
    reader().call('act', { actions: [{ do: 'discuss', card: 'K1', text: 'Nimm noch PDF auf.' }], confirm: 'Weitergegeben. Bauen geht per Klick, sobald die Antwort da ist.' });
    reader().emit({ type: 'idle' });
    expect((await heard).token).toBeUndefined();
    expect(explorer().inbox[0]).toContain('Nimm noch PDF auf.');
    // while it thinks, building alone is refused too, and the card says so
    const again = canvas.commander.hear('bau es', { card: i.id });
    await settle();
    expect(reader().inbox.at(-1)).toContain('[idea, its agent is working on its reply]');
    expect(reader().call('act', { actions: [{ do: 'plan_doc', card: 'K1' }], confirm: 'Wird geplant.' })).toContain('is still working on its reply');
    reader().call('act', { actions: [{ do: 'discuss', card: 'K1', text: 'Bau es.' }], confirm: 'Weitergegeben.' });
    await again;
    expect(item(i.id).state).toBe('idea');
  });

  test('"bau diesen Prototyp" waits for the reply of its idea’s agent', () => {
    const i = idea();
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    const prototype = board()
      .snapshot()
      .items.find((x) => x.prototypeOf === i.id)!;
    canvas.act(i.id, { action: 'discuss', text: 'Schon was zu sehen?' });
    expect(() => canvas.act(prototype.id, { action: 'buildPrototype' })).toThrow('still working on its reply');
  });

  test('"bau diesen Prototyp" on a prototype builds its idea on it', async () => {
    const i = idea();
    canvas.act(i.id, { action: 'prototype', text: 'Knopf' });
    const prototype = board()
      .snapshot()
      .items.find((x) => x.prototypeOf === i.id)!;
    const heard = canvas.commander.hear('bau diesen Prototyp', { card: prototype.id });
    await settle();
    expect(reader().inbox[0]).toContain(`"${prototype.title}" (prototype of K`);
    const tag = reader().inbox[0]!.match(/(K\d+) \[working\] "Prototyp/)![1];
    reader().call('act', { actions: [{ do: 'build', card: tag }], confirm: 'Die Idee wird auf diesem Prototyp gebaut.' });
    canvas.commander.arm((await heard).token!);
    await settle(30);
    expect(item(i.id)).toMatchObject({ builtOn: prototype.id });
  });

  test('deciding on an idea waits for undo like any command', async () => {
    const i = idea();
    const heard = canvas.commander.hear('so bauen', { card: i.id });
    await settle();
    reader().call('act', { actions: [{ do: 'build', card: 'K1' }], confirm: '„Export für Vermieter“ wird gebaut.' });
    const h = await heard;
    expect(h.token).toBeTruthy();
    canvas.commander.arm(h.token!);
    expect(item(i.id).state).toBe('idea');
    await settle(30);
    expect(item(i.id).state).toBe('working');
  });
});
