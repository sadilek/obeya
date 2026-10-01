import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import { MIGRATIONS, Store } from './db';
import { FakeRuntime, type FakeSession } from './testing';
import { git } from './workspaces';

let dir: string;
let main: string;
let store: Store;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;
let spoken: [string | undefined, string][];

const open = () =>
  new CanvasRuntime({ repos: [{ path: main, clones: 1 }] }, { store, home: dir, runtime, forge: { status: () => ({}) as never }, commandDelayMs: 10 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-ideas-'));
  main = join(dir, 'main');
  mkdirSync(join(main, 'docs/plan'), { recursive: true });
  Bun.spawnSync(['git', 'init', '--quiet', '-b', 'main', main]);
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
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
const idea = (title = 'Export für Vermieter', body = 'Vermieter wollen ihre Zählerstände.') => board().create({ kind: 'feature', idea: true, title, body, x: 0, y: 0 });
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
    const c = board().create({ kind: 'bugfix', title: 'Seite bricht um', x: 0, y: 0, images: [task] });
    board().patch(c.id, { state: 'idea' });
    canvas.act(c.id, { action: 'discuss', text: 'Wie gehen wir das an?' });
    const s = explorer();
    expect(s.images[0]).toEqual([canvas.images.path(task)!]);
    expect(s.inbox[0]).toContain('The owner attached a screenshot to the card');
    const shown = canvas.images.save(new Uint8Array([2]), 'image/png');
    turn(s, 'Zwei Wege.');
    canvas.act(c.id, { action: 'discuss', text: 'Und hier auf dem Handy', images: [shown] });
    turn(s, 'Verstehe.');
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

  test('an idea whose agent had the last word before the update waits for the owner', () => {
    const path = join(dir, 'obeya.db');
    const s = new Store(path);
    s.ensureCanvas('c', 'C');
    const idea = JSON.stringify({ status: 'open', brief: '' });
    const [answered, asked] = s.insert([0, 1].map((y) => ({ canvas_id: 'c', kind: 'feature' as const, state: 'idea' as const, idea, x: 0, y })));
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
    const learn = runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'remember'))!;
    expect(learn.inbox[0]).toContain('words in the discussion of an idea: Exporte immer als CSV.');
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

  test('a big idea becomes a card whose worker writes the plan doc', () => {
    const i = idea();
    board().setIdea(i.id, { brief: '**Ziel:** Vermieterportal.' });
    canvas.act(i.id, { action: 'planDoc' });
    const c = item(i.id);
    expect(c).toMatchObject({ state: 'planned', title: 'Plan-Doc: Export für Vermieter' });
    expect(c.body).toContain('`docs/plan/`');
    expect(c.body).toContain('## Workstreams');
    expect(c.body).toContain('**Ziel:** Vermieterportal.');
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
    expect(() => canvas.act(board().create({ kind: 'feature', title: 'X', x: 0, y: 0 }).id, { action: 'park' })).toThrow('not an idea');
  });

  test('a planned card of the owner’s can become an idea first', () => {
    const c = board().create({ kind: 'feature', title: 'Unklar', x: 0, y: 0 });
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
});

describe('a spike', () => {
  const demoDir = () => {
    const d = join(dir, 'demo');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'demo.mp4'), '0');
    writeFileSync(join(d, 'captions.vtt'), 'WEBVTT\n\n00:00:00.351 --> 00:00:10.000\nSo sähe es aus.\n');
    return d;
  };
  const worker = () => runtime.sessions.find((s) => s.spec.tools.some((t) => t.name === 'ready_for_review'))!;

  test('builds a throwaway prototype whose demo shows on the idea, and never lands', () => {
    const i = idea();
    board().setIdea(i.id, { brief: '**Ziel:** CSV-Export.' });
    canvas.act(i.id, { action: 'discuss', text: 'Zeig mal.' });
    turn(explorer(), 'Ein Spike hilft.');
    canvas.act(i.id, { action: 'spike', text: 'Den Export-Knopf' });
    const spike = board()
      .snapshot()
      .items.find((x) => x.spikeOf === i.id)!;
    expect(spike).toMatchObject({ state: 'working', title: 'Spike: Export für Vermieter', from: i.id, body: 'Den Export-Knopf' });
    expect(item(i.id).state).toBe('idea');
    const w = worker();
    expect(w.inbox[0]).toContain('throwaway prototype');
    expect(w.inbox[0]).toContain('**Ziel:** CSV-Export.');
    expect(w.inbox[0]).not.toContain('Before ready_for_review, run');
    // a spike never lands, so it holds no files for the Koordinator
    expect(canvas.koordinator.inProgress()).toEqual([]);
    expect(() => canvas.act(i.id, { action: 'spike' })).toThrow('still running');

    const ws = board().row(spike.id).workspace!;
    const branch = board().row(spike.id).branch!;
    w.call('ready_for_review', { summary: 'Knopf gebaut.', demo: { dir: demoDir(), chapters: ['Knopf'], shown: ['Knopf'], not_shown: [], findings: [] } });
    expect(item(i.id).demo).toMatchObject({ chapters: [[0, 'Knopf']] });
    expect(board().demoDir(i.id)).toBe(join(dir, 'demo'));
    expect(explorer().inbox.at(-1)).toContain('Knopf gebaut.');
    expect(item(spike.id)).toMatchObject({ state: 'waiting', need: 'demo' });

    canvas.act(spike.id, { action: 'approve' });
    expect(board().item(spike.id)).toBeUndefined();
    expect(git(ws, 'branch', '--list', branch)).toBe('');
    expect(canvas.repos[0]!.workspaces.leasedBy(spike.id)).toBeNull();
    // the idea keeps the demo
    expect(item(i.id).demo).toBeDefined();
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
    expect(reader().inbox[0]).toContain('[idea] feature "Export für Vermieter"');
    reader().call('act', { actions: [{ do: 'discuss', card: 'K1', text: 'Eher als PDF.' }], confirm: 'An die Idee weitergegeben.' });
    expect(await heard).toEqual({ confirm: 'An die Idee weitergegeben.', quiet: true });
    expect(talk(i.id)).toEqual([['owner', 'Eher als PDF.']]);
    expect(explorer().inbox[0]).toContain('Eher als PDF.');
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
