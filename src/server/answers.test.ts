import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pagePolicy } from '../core/frame';
import { type Notice, waitingOn } from '../core/types';
import { inform } from './advisor';
import { answersDir } from './answers';
import { CanvasRuntime } from './canvas';
import { serveAnswerFile } from './demo';
import type { Focus } from './commands';
import { Store } from './db';
import { FakeRuntime, type FakeSession, fakeVoicing, gitRepo, noForge, removeDir, until } from './testing';
import { BadRequest } from './board';

let dir: string;
let main: string;
let store: Store;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;
let notices: Notice[];
let voice: ReturnType<typeof fakeVoicing>;

const open = async () => {
  const c = await CanvasRuntime.start({ repos: [{ path: main, clones: 1 }] }, { store, home: dir, runtime, forge: noForge, commandDelayMs: 10, permissionMode: 'acceptEdits', limitMargin: 10, voicing: voice.voicing });
  c.board.onNotice((n) => notices.push(n));
  return c;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-answers-'));
  main = join(dir, 'main');
  gitRepo(main, { 'docs/plan/pr-loop.md': '# PR-Loop\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [x] **W1:** PR-Phase.\n- [ ] **W4:** Live im Shop. Mit dem Go des Owners.\n' });
  store = new Store(':memory:');
  runtime = new FakeRuntime();
  notices = [];
  voice = fakeVoicing();
  canvas = await open();
});
afterEach(async () => {
  canvas.shutdown();
  await removeDir(dir);
});

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const board = () => canvas.board;
const workstream = () => board().snapshot().items.find((i) => i.label === 'W4')!;
const isCoordinator = (s: FakeSession) => s.spec.tools.some((t) => t.name === 'look_up');
const answerer = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'answer_owner')).at(-1)!;

/** Says `text` with `focus`; the Coordinator reads it with `tool`. */
async function say(text: string, focus: Focus, tool: string, args: Record<string, unknown>) {
  const heard = canvas.commander.hear(text, focus);
  await settle();
  const s = runtime.sessions.filter(isCoordinator).at(-1)!;
  s.call(tool, args);
  s.emit({ type: 'idle' });
  return { heard: await heard, brief: s.inbox.at(-1)! };
}

describe('a question the Coordinator looks up', () => {
  test('looked up for an action: the answer brings what the step needs, and the Coordinator takes the step with it', async () => {
    await say('Es gibt drei offene Issues bei GitHub, erstelle für jedes eine eigene Karte.', {}, 'look_up', {
      question: 'Welche Issues sind auf GitHub offen, mit Nummer, Titel und Link?',
      then: 'Create a task for each open issue.',
      confirm: 'Ich lese die offenen Issues und lege dann für jedes eine Aufgabe an.',
    });
    const a = answerer();
    expect(a.inbox[0]).toContain('Obeya takes this step itself once your answer is in: Create a task for each open issue.');
    a.call('answer_owner', { text: '- #27 Skills (https://github.com/o/r/issues/27)' });
    a.emit({ type: 'idle' });
    // the Coordinator hears the answer with the step it takes now, not as news for the next command
    const k = runtime.sessions.filter(isCoordinator).at(-1)!;
    await until(() => k.inbox.length === 2);
    expect(k.inbox[1]).toContain("No words of the owner's this time");
    expect(k.inbox[1]).toContain('is in (the owner sees it too): - #27 Skills');
    k.call('act', { actions: [{ do: 'new_card', title: 'Skills', body: 'GitHub-Issue #27: https://github.com/o/r/issues/27', start: false }], confirm: 'Neue Aufgabe „Skills“.' });
    k.emit({ type: 'idle' });
    await until(() => board().snapshot().items.some((i) => i.title === 'Skills'));
    const talk = board().snapshot().talk;
    expect(talk.map((x) => [x.said, x.reply, x.answer])).toEqual([
      ['Es gibt drei offene Issues bei GitHub, erstelle für jedes eine eigene Karte.', 'Ich lese die offenen Issues und lege dann für jedes eine Aufgabe an.', '- #27 Skills (https://github.com/o/r/issues/27)'],
      ['', 'Neue Aufgabe „Skills“.', undefined],
    ]);
    expect(notices.some((n) => n.text === 'Neue Aufgabe „Skills“.' && n.token)).toBe(true);
    // the next command does not hear the answer again as news
    const next = await say('danke', {}, 'reply', { confirm: 'Gern.' });
    expect(next.brief).not.toContain('came in and was shown to them');
  });

  test("about a workstream: its project agent answers from the start task, in the open card's log and aloud", async () => {
    const w4 = workstream();
    const { heard } = await say('Was würde der Agent hier machen, wenn ich starte?', { card: w4.id }, 'look_up', {
      question: 'What would the worker do on W4 if the owner started it now?',
      confirm: 'Ich schaue im Plan nach.',
    });
    // nothing to take back; the acknowledgement is what the owner hears now
    expect(heard).toEqual({ confirm: 'Ich schaue im Plan nach.' });
    const a = answerer();
    // with a worker's tools, in the workers' permission mode, to check what it says
    expect(a.spec.readOnly).toBeUndefined();
    expect(a.spec.permissionMode).toBe('acceptEdits');
    expect(a.spec.system).toContain('project agent of the project "PR-Loop"');
    expect(a.inbox[0]).toContain('What would the worker do on W4');
    expect(a.inbox[0]).toContain('The task its worker would get if the owner started it now');
    expect(a.inbox[0]).toContain('Your card: “Live im Shop”.');
    expect(a.inbox[0]).toContain('Read its plan doc docs/plan/pr-loop.md first');
    expect(board().snapshot().talk).toEqual([]);

    a.emit({ type: 'session', id: 'project-1' });
    a.emit({ type: 'tool', name: 'Read', input: { file_path: `${main}/docs/plan/pr-loop.md` } });
    a.call('answer_owner', { text: '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.' });
    a.emit({ type: 'idle' });
    await settle();

    expect(board().events(w4.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['say', 'owner', 'Was würde der Agent hier machen, wenn ich starte?'],
      ['say', 'coordinator', 'Ich schaue im Plan nach.'],
      ['activity', 'project', 'Liest plan/pr-loop.md'],
      ['say', 'project', '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.'],
    ]);
    // above the microphone too, written
    expect(notices).toEqual([{ cardId: w4.id, text: '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.', inTalk: true }]);
    // the project agent keeps its session: it knows the plan and the history
    expect(board().row(w4.parent!).session_id).toBe('project-1');
    expect(board().talk().at(-1)).toMatchObject({ question: 'What would the worker do on W4 if the owner started it now?', answer: '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.', answerBy: 'project' });
    // it is read on the card, so the sheet does not wait with it
    expect(board().talk().at(-1)!.unread).toBeUndefined();

    // the Coordinator hears the answer with the next command
    const next = await say('und dann?', { card: w4.id }, 'reply', { confirm: 'Dann wartet er.' });
    expect(next.brief).toContain('The answer A1 you looked up for the owner\'s question “What would the worker do on W4');
  });

  test('about a card without a project: a thorough Coordinator turn answers, in the sheet when no card is open', async () => {
    board().create({ title: 'Login', body: 'Login hängt.', x: 0, y: 0 });
    const first = await say('was steht im plan zu login?', {}, 'reply', { confirm: 'Welche Karte?' });
    const tag = /(K\d+) \[planned\] "Login"/.exec(first.brief)![1];
    await say('was würde der agent bei login machen?', {}, 'look_up', { question: 'What would the worker do on Login?', card: tag, confirm: 'Moment, ich lese nach.' });
    const a = answerer();
    expect(a.spec.system).toContain('You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya.');
    expect(a.spec.role).toBe('coordinator');
    expect(a.spec.readOnly).toBeUndefined();
    expect(a.spec.permissionMode).toBe('acceptEdits');
    expect(a.spec.system).toContain('You have the tools a worker has');
    expect(a.inbox[0]).toContain('Your card: “Login”.');
    expect(board().snapshot().talk.at(-1)).toMatchObject({ said: 'was würde der agent bei login machen?', reply: 'Moment, ich lese nach.', question: 'What would the worker do on Login?' });
    expect(board().snapshot().talk.at(-1)!.answer).toBeUndefined();

    a.call('answer_owner', { text: 'Er sucht den Hänger.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().snapshot().talk.at(-1)).toMatchObject({ answer: 'Er sucht den Hänger.', answerBy: 'coordinator', unread: true });
    // the sheet shows it in full: a page with the sheet open needs no line above the microphone for it
    expect(notices).toEqual([{ text: 'Er sucht den Hänger.', talk: board().snapshot().talk.at(-1)!.id }]);
    // Obeya waits for the owner with it, like a card that needs them, until they see the sheet
    expect(waitingOn(board().snapshot())).toBe(1);
    board().readTalk();
    expect(board().snapshot().talk.at(-1)!.unread).toBeUndefined();
    expect(waitingOn(board().snapshot())).toBe(0);
  });

  test('an unknown card tag goes back to the Coordinator', async () => {
    const heard = canvas.commander.hear('was macht X?', {});
    await settle();
    const s = runtime.sessions.find(isCoordinator)!;
    expect(s.call('look_up', { question: 'X?', card: 'K9', confirm: 'Moment.' })).toContain('No card K9 on this canvas');
    s.call('reply', { confirm: 'Welche Karte meinst du?' });
    s.emit({ type: 'idle' });
    expect((await heard).confirm).toBe('Welche Karte meinst du?');
  });

  test('the Coordinator hears a long answer to its end, in its running session and in a fresh one', async () => {
    const asked = (said: string, answer: string) => board().answerTalk(board().addTalk(said, 'Moment.', null, { question: `${said}?`, about: null }), answer, 'coordinator');
    asked('alte frage', `${'Alt. '.repeat(200)}ENDE-ALT`);
    const answer = `${'Die Datenbankregel gilt für jeden Zugriff. '.repeat(80)}Soll ich eine Karte für Tool-Verwendungen anlegen?`;
    await say('wie ist die datenbankregel?', {}, 'look_up', { question: 'What is the database rule?', confirm: 'Ich lese nach.' });
    const a = answerer();
    a.call('answer_owner', { text: answer });
    a.emit({ type: 'idle' });
    await settle();
    const running = await say('ja, leg eine an', {}, 'reply', { confirm: 'Mache ich.' });
    expect(running.brief).toContain(answer);

    // a fresh session gets the newest five answers in full, older ones clipped
    for (let n = 1; n <= 4; n++) asked(`frage ${n}`, `Antwort ${n}.`);
    canvas.shutdown();
    canvas = await open();
    const fresh = await say('und?', {}, 'reply', { confirm: 'Ja.' });
    expect(fresh.brief).toContain(answer);
    expect(fresh.brief).toContain('Antwort 4.');
    expect(fresh.brief).toContain('Alt. Alt.');
    expect(fresh.brief).not.toContain('ENDE-ALT');
  });

  test('a question still being looked up when Obeya restarts is looked up again', async () => {
    const w4 = workstream();
    await say('was würde der agent tun?', { card: w4.id }, 'look_up', { question: 'What would the worker do?', confirm: 'Ich schaue nach.' });
    canvas.shutdown();
    const before = runtime.sessions.length;
    canvas = await open();
    await settle();
    expect(runtime.sessions.length).toBe(before + 1);
    expect(answerer().inbox[0]).toContain('What would the worker do?');
  });

  test('a turn that ends without the tool answers with its last words; one that fails says so', async () => {
    const w4 = workstream();
    await say('was würde der agent tun?', { card: w4.id }, 'look_up', { question: 'Q1', confirm: 'Ich schaue nach.' });
    let a = answerer();
    a.emit({ type: 'text', text: 'Er fragt zuerst nach dem Go.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(w4.id).at(-1)).toMatchObject({ kind: 'say', author: 'project', text: 'Er fragt zuerst nach dem Go.' });

    await say('und warum?', { card: w4.id }, 'look_up', { question: 'Q2', confirm: 'Ich schaue nach.' });
    await settle();
    a = answerer();
    a.emit({ type: 'error', message: 'boom' });
    await settle();
    expect(board().events(w4.id).at(-1)!.text).toContain('Ich konnte die Frage nicht beantworten (boom)');
  });

  test('a turn that ends while its background work runs is no answer: the agent answers once that work wakes it', async () => {
    const login = board().create({ title: 'Login', body: 'Login hängt.', x: 0, y: 0 });
    await say('wie oft hängt login?', { card: login.id }, 'look_up', { question: 'How often does login hang?', confirm: 'Moment.' });
    const a = answerer();
    a.emit({ type: 'background', tasks: [{ id: 'b1', description: 'Download the server logs' }] });
    a.emit({ type: 'text', text: 'Still downloading the logs.' });
    a.emit({ type: 'idle', background: 1 });
    await settle();
    // its words so far are no answer, and its session runs on with the download
    expect(a.closed).toBe(false);
    expect(board().talk().at(-1)!.answer).toBeUndefined();
    expect(board().events(login.id).at(-1)).toMatchObject({ kind: 'say', author: 'coordinator', text: 'Moment.' });
    // the download ends and wakes the agent for a turn of its own
    a.emit({ type: 'background', tasks: [] });
    a.emit({ type: 'tool', name: 'Bash', input: { command: 'grep -c timeout logs/*.log' } });
    a.call('answer_owner', { text: '37 Mal im September.' });
    a.emit({ type: 'idle', background: 0 });
    await settle();
    expect(a.closed).toBe(true);
    expect(board().talk().at(-1)).toMatchObject({ answer: '37 Mal im September.' });
    expect(board().events(login.id).at(-1)).toMatchObject({ kind: 'say', text: '37 Mal im September.' });
  });

  test('it waits for its background work no longer than its limit, nor long after that work ended without waking it', async () => {
    const ask = () => inform({ runtime, cwd: main, system: 'S', message: 'Q?', language: 'de', onLimit: () => {}, backgroundGrace: 5, backgroundLimit: 30 });
    const one = ask();
    const a = runtime.last;
    a.emit({ type: 'text', text: 'Still downloading.' });
    a.emit({ type: 'idle', background: 1 });
    a.emit({ type: 'background', tasks: [] });
    // its last words are the answer after all
    expect(await one).toEqual({ text: 'Still downloading.' });
    expect(a.closed).toBe(true);
    const two = ask();
    const b = runtime.last;
    b.emit({ type: 'idle', background: 1 });
    await settle(15);
    expect(b.closed).toBe(false);
    expect(two).rejects.toThrow('no answer');
    await until(() => b.closed);
  });
});

const HIT = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";

/** The usage limit stops the turn of `s`, until `ms` from now. */
function limit(s: FakeSession, ms: number) {
  s.emit({ type: 'error', message: HIT, limit: { resetsAt: Date.now() + ms } });
  s.emit({ type: 'idle' });
}

describe('a look-up the usage limit stops', () => {
  test('waits under its question in the sheet and answers once the limit lifts, after a restart too', async () => {
    await say('was steht im plan zu login?', {}, 'look_up', { question: 'What does the plan say about login?', confirm: 'Moment.' });
    let a = answerer();
    limit(a, 20);
    await settle();
    // no answer that it failed: the sheet says when it goes on
    const talk = () => board().snapshot().talk.at(-1)!;
    expect(talk().answer).toBeUndefined();
    expect(Date.parse(talk().limitedUntil!)).toBeGreaterThan(Date.now());
    expect(a.closed).toBe(false);
    // Obeya restarts: the question is looked up again, runs into the limit again and waits anew
    canvas.shutdown();
    canvas = await open();
    await settle();
    expect(answerer()).not.toBe(a);
    a = answerer();
    expect(talk().limitedUntil).toBeUndefined();
    limit(a, 20);
    expect(talk().limitedUntil).toBeDefined();
    await settle(60);
    expect(a.inbox.at(-1)).toContain('The usage limit that stopped your last turn has reset');
    expect(talk().limitedUntil).toBeUndefined();
    a.call('answer_owner', { text: 'Der Plan sagt nichts dazu.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(talk().answer).toBe('Der Plan sagt nichts dazu.');
    expect(notices).toEqual([{ text: 'Der Plan sagt nichts dazu.', talk: talk().id }]);
  });

  test("a workstream's project agent waits the same way", async () => {
    const w4 = workstream();
    await say('was würde der agent tun?', { card: w4.id }, 'look_up', { question: 'What would the worker do?', confirm: 'Ich schaue nach.' });
    const a = answerer();
    expect(a.spec.system).toContain('project agent');
    limit(a, 20);
    await settle();
    // in the card's conversation, without the error
    expect(board().events(w4.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya' });
    expect(board().events(w4.id).at(-1)!.text).toStartWith('Das Nutzungslimit ist erreicht. Obeya schlägt das um ');
    expect(board().events(w4.id).some((e) => e.text.includes('hit your'))).toBe(false);
    await settle(60);
    a.call('answer_owner', { text: 'Er fragt nach dem Go.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(w4.id).at(-1)).toMatchObject({ author: 'project', text: 'Er fragt nach dem Go.' });
  });
});

/** A question looked up in the sheet, answered by its agent in session `session`; returns the exchange's id. */
async function lookedUp(said: string, question: string, answer: string, session: string, extra: Record<string, unknown> = {}) {
  await say(said, {}, 'look_up', { question, confirm: 'Moment.', ...extra });
  const a = answerer();
  a.emit({ type: 'session', id: session });
  a.call('answer_owner', { text: answer });
  a.emit({ type: 'idle' });
  await settle();
  return board().talk().at(-1)!.id;
}

describe('a looked-up answer goes on', () => {
  test('a follow-up resumes the agent that found the answer, and stands in the sheet as continuing it', async () => {
    const first = await lookedUp('stimmen die Septembergutschriften?', 'Are the September credits right?', 'Ja, sie stimmen.', 'look-1');
    expect(board().talk().at(-1)).toMatchObject({ thread: first, answer: 'Ja, sie stimmen.' });
    const sessions = runtime.sessions.length;
    await say('und im Oktober?', {}, 'look_up', { question: 'And the October credits so far?', follows: `A${first}`, confirm: 'Ich schaue nach.' });
    // one agent, resumed: it still has everything it read and computed
    const a = answerer();
    expect(runtime.sessions.length).toBe(sessions + 1);
    expect(a.spec.resume).toBe('look-1');
    expect(a.inbox[0]).toContain('The owner follows up on your answer. They said: "und im Oktober?"');
    expect(a.inbox[0]).toContain(answersDir(dir, canvas.id, first));
    expect(a.spec.dirs).toEqual([answersDir(dir, canvas.id, first)]);
    expect(board().talk().at(-1)).toMatchObject({ thread: first, follows: first, continues: 'Are the September credits right?' });
    a.call('answer_owner', { text: 'Oktober bisher auch.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().talk().at(-1)).toMatchObject({ answer: 'Oktober bisher auch.', unread: true });
  });

  test('an unknown answer tag goes back to the Coordinator', async () => {
    canvas.commander.hear('und weiter?', {});
    await settle();
    const s = runtime.sessions.filter(isCoordinator).at(-1)!;
    expect(s.call('look_up', { question: 'More?', follows: 'A99', confirm: 'Moment.' })).toContain('Unknown answer A99');
  });

  test('follow-ups to one thread wait for each other', async () => {
    const first = await lookedUp('frage', 'Q?', 'A.', 'look-1');
    await say('und das?', {}, 'look_up', { question: 'Q2?', follows: `A${first}`, confirm: 'Moment.' });
    const second = answerer();
    const before = runtime.sessions.length;
    await say('und jenes?', {}, 'look_up', { question: 'Q3?', follows: `A${first}`, confirm: 'Moment.' });
    // the Coordinator read it, but its agent waits for the turn before
    expect(runtime.sessions.length).toBe(before);
    second.emit({ type: 'session', id: 'look-2' });
    second.call('answer_owner', { text: 'Zwei.' });
    second.emit({ type: 'idle' });
    await settle();
    const third = answerer();
    expect(third).not.toBe(second);
    expect(third.spec.resume).toBe('look-1');
    expect(third.inbox[0]).toContain('und jenes?');
  });

  test('a session that cannot be resumed is replaced by a fresh agent that gets the thread so far', async () => {
    const first = await lookedUp('stimmen die gutschriften?', 'Are the credits right?', 'Ja, 16,6 ct.', 'gone');
    await say('und im oktober?', {}, 'look_up', { question: 'October?', follows: `A${first}`, confirm: 'Moment.' });
    answerer().emit({ type: 'error', message: 'No conversation found with session ID: gone' });
    await settle();
    const fresh = answerer();
    expect(fresh.spec.resume).toBeUndefined();
    expect(fresh.inbox[0]).toContain('The question, as you understood it then: Are the credits right?');
    expect(fresh.inbox[0]).toContain('You: Ja, 16,6 ct.');
    expect(fresh.inbox[0]).toContain('They said: "und im oktober?"');
    fresh.call('answer_owner', { text: 'Oktober: 12 ct.' });
    fresh.emit({ type: 'idle' });
    await settle();
    expect(board().talk().at(-1)!.answer).toBe('Oktober: 12 ct.');
  });

  test("an answer comes with files in its thread's directory; a path outside it is refused", async () => {
    await say('mach mir eine tabelle', {}, 'look_up', { question: 'A table of the credits?', confirm: 'Moment.' });
    const thread = board().talk().at(-1)!.id;
    const out = answersDir(dir, canvas.id, thread);
    const a = answerer();
    writeFileSync(join(out, 'credits.csv'), 'a,b\n');
    mkdirSync(join(out, 'charts'));
    writeFileSync(join(out, 'charts', 'price.html'), '<p>chart</p>');
    writeFileSync(join(dir, 'secret.txt'), 'no');
    expect(a.call('answer_owner', { text: 'Hier.', files: [{ path: join(dir, 'secret.txt'), caption: 'x' }] })).toContain('is not in');
    expect(a.call('answer_owner', { text: 'Hier.', files: [{ path: '../secret.txt', caption: 'x' }] })).toContain('is not in');
    expect(a.call('answer_owner', { text: 'Hier.', files: [{ path: 'missing.xlsx', caption: 'x' }] })).toContain('is no file');
    expect(board().talk().at(-1)!.answer).toBeUndefined();
    a.call('answer_owner', {
      text: 'Hier.',
      files: [
        { path: join(out, 'credits.csv'), caption: 'Die Gutschriften je Monat' },
        { path: 'charts/price.html', caption: 'Preis je Stunde' },
      ],
    });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().talk().at(-1)!.files).toEqual([
      { name: 'credits.csv', caption: 'Die Gutschriften je Monat' },
      { name: 'charts/price.html', caption: 'Preis je Stunde' },
    ]);
    // served from the directory, a page sandboxed and reporting its height and allowed to read the
    // files beside it (under its directory's key, see demo.test.ts); nothing outside it
    const files = 'http://127.0.0.1:4417/api/c/c1/threads/7/files/';
    const sentOn = serveAnswerFile(out, 'credits.csv', false, new Request(`${files}credits.csv`));
    expect(sentOn.status).toBe(302);
    const key = /\/(~[0-9a-f]{32})\//.exec(sentOn.headers.get('location')!)![1];
    const serve = (name: string, download = false) => serveAnswerFile(out, `${key}/${name}`, download, new Request(`${files}${key}/${name}`));
    const page = serve('charts/price.html');
    expect(page.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${pagePolicy('http://127.0.0.1:4417')}`);
    expect(page.headers.get('connection-allowlist')).toBe('(response-origin)');
    expect(page.headers.get('access-control-allow-origin')).toBe('null');
    expect(await page.text()).toContain('obeyaHeight');
    expect(serve('credits.csv', true).headers.get('content-disposition')).toContain('credits.csv');
    expect(serve('../secret.txt').status).toBe(404);
    expect(() => canvas.answerDir(thread + 100)).toThrow();
  });

  test("an answer in a card's log carries its thread, and a follow-up there resumes its agent", async () => {
    const login = board().create({ title: 'Login', body: 'Login hängt.', x: 0, y: 0 });
    await say('warum hängt login?', { card: login.id }, 'look_up', { question: 'Why does login hang?', confirm: 'Moment.' });
    const thread = board().talk().at(-1)!.id;
    let a = answerer();
    a.emit({ type: 'session', id: 'login-1' });
    a.call('answer_owner', { text: 'Ein Timeout.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(login.id).at(-1)).toMatchObject({ kind: 'say', author: 'coordinator', text: 'Ein Timeout.', answer: { thread } });
    await say('welcher?', { card: login.id }, 'look_up', { question: 'Which timeout?', follows: `A${thread}`, confirm: 'Moment.' });
    a = answerer();
    expect(a.spec.resume).toBe('login-1');
    a.call('answer_owner', { text: 'Der der Session.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(login.id).at(-1)).toMatchObject({ text: 'Der der Session.', answer: { thread, continues: 'Why does login hang?' } });
  });
});

describe('a thread on a Question card', () => {
  /** A thread of two answers in the sheet, moved onto a card. */
  async function moved() {
    const first = await lookedUp('stimmen die septembergutschriften?', 'September feed-in credits: correct?', 'Ja.', 'look-1');
    const out = answersDir(dir, canvas.id, first);
    await say('mach ein excel', {}, 'look_up', { question: 'An Excel of the numbers?', follows: `A${first}`, confirm: 'Moment.' });
    const a = answerer();
    writeFileSync(join(out, 'numbers.xlsx'), 'x');
    a.call('answer_owner', { text: 'Hier die Tabelle.', files: [{ path: 'numbers.xlsx', caption: 'Die Viertelstunden' }] });
    a.emit({ type: 'idle' });
    await settle();
    const card = canvas.answers.toCard(first);
    return { first, card };
  }

  test('"Make it a card" moves the thread with its files onto a card that goes on with the same agent', async () => {
    const { first, card } = await moved();
    expect(card).toMatchObject({ kind: 'question', state: 'done', title: 'September feed-in credits: correct?', thread: { talk: first, answers: 2, files: 1 } });
    expect(board().row(card.id).session_id).toBe('look-1');
    expect(board().events(card.id).map((e) => [e.author, e.text, e.answer?.files?.length ?? 0])).toEqual([
      ['owner', 'stimmen die septembergutschriften?', 0],
      ['coordinator', 'Ja.', 0],
      ['owner', 'mach ein excel', 0],
      ['coordinator', 'Hier die Tabelle.', 1],
    ]);
    // the sheet points to the card instead
    expect(board().talk().filter((x) => x.thread === first).every((x) => x.movedTo === card.id)).toBe(true);
    // moved again, it is the same card
    expect(canvas.answers.toCard(first).id).toBe(card.id);

    // the owner's words on the card go straight to that agent, with to_obeya for what asks Obeya
    canvas.tell(card.id, 'und im Oktober?', [], false);
    expect(board().item(card.id)!.thread!.thinking).toBe(true);
    const a = answerer();
    expect(a.spec.resume).toBe('look-1');
    expect(a.spec.tools.map((t) => t.name)).toContain('to_obeya');
    expect(a.inbox[0]).toContain('und im Oktober?');
    // what comes while it reads waits for its turn, unread until then, and can be taken back
    canvas.tell(card.id, 'und November?', [], true);
    canvas.tell(card.id, 'und Dezember?', [], false);
    const [november, december] = board().events(card.id).slice(-2);
    expect([november!.unread, december!.unread]).toEqual([true, true]);
    canvas.press(card.id, { action: 'unsay', id: december!.id });
    const sessions = runtime.sessions.length;
    a.call('answer_owner', { text: 'Oktober: 12 ct.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(runtime.sessions.length).toBe(sessions + 1);
    const b = answerer();
    expect(b.inbox[0]).toContain('und November?');
    expect(b.inbox[0]).not.toContain('und Dezember?');
    // read once its turn starts: after the answer it waited for
    const answered = board().events(card.id).find((e) => e.text === 'Oktober: 12 ct.')!;
    expect(board().events(card.id).find((e) => e.id === november!.id)).toMatchObject({ readAfter: answered.id });
    b.call('answer_owner', { text: 'November: noch nichts.' });
    b.emit({ type: 'idle' });
    await settle();
    expect(board().item(card.id)!.thread).toEqual({ talk: first, answers: 4, files: 1 });
    expect(board().events(card.id).filter((e) => e.kind === 'talk').map((e) => e.text).slice(-4)).toEqual(['und im Oktober?', 'und November?', 'Oktober: 12 ct.', 'November: noch nichts.']);
  });

  test('"Show as walkthrough" on one of its answers asks the card\'s agent, its player in the conversation at once', async () => {
    const { first, card } = await moved();
    const answer = board().events(card.id).find((e) => e.text === 'Ja.')!;
    const asked = canvas.answers.showEventAsWalkthrough(card.id, answer.id);
    expect(asked).toEqual({ thread: first, file: 'stimmen-die-septembergutschriften.walkthrough.json' });
    expect(voice.warmed).toEqual(['de']);
    const words = board().events(card.id).findLast((e) => e.author === 'owner')!;
    expect(words).toMatchObject({ kind: 'talk', text: 'Als Walkthrough zeigen', replyTo: answer.id });
    expect(board().events(card.id).at(-1)).toMatchObject({ kind: 'talk', text: '', answer: { thread: first, live: true, files: [{ name: asked.file, caption: '' }] } });
    // its agent, in its session, hears the answer clicked with the words it answered
    const a = answerer();
    expect(a.spec.resume).toBe('look-1');
    expect(a.inbox[0]).toContain('Tell this answer of yours as a walkthrough');
    expect(a.inbox[0]).toContain('The question: stimmen die septembergutschriften?');
    expect(a.inbox[0]).toContain('<answer>\nJa.\n</answer>');
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Die Gutschriften', language: 'de', narration: 'So.' } });
    a.call('answer_owner', { text: 'Der Walkthrough zeigt die Gutschriften.' });
    a.emit({ type: 'idle' });
    await settle();
    const told = board().events(card.id).filter((e) => e.answer && e.id > words.id);
    expect(told.map((e) => [e.text, e.answer!.live, e.answer!.files])).toEqual([['Der Walkthrough zeigt die Gutschriften.', undefined, [{ name: asked.file, caption: 'Die Gutschriften' }]]]);
    expect(canvas.answers.walkthrough(first, asked.file)).toMatchObject({ title: 'Die Gutschriften', done: true });
  });

  test('a follow-up asked in the sheet after the move goes to the card and stands there', async () => {
    const { first, card } = await moved();
    await say('und dezember?', {}, 'look_up', { question: 'December?', follows: `A${first}`, confirm: 'Moment.' });
    const talk = board().talk().at(-1)!;
    expect(talk.movedTo).toBe(card.id);
    const a = answerer();
    expect(a.spec.resume).toBe('look-1');
    a.call('answer_owner', { text: 'Dezember: offen.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(card.id).filter((e) => e.kind === 'talk').map((e) => e.text).slice(-2)).toEqual(['und dezember?', 'Dezember: offen.']);
    // the Coordinator hears it, and the sheet does not wait with it
    expect(board().talk().at(-1)).toMatchObject({ answer: 'Dezember: offen.' });
    expect(board().talk().at(-1)!.unread).toBeUndefined();
  });

  test('its agent paused at a safe point gives its answer first, and is paused then', async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'und im Oktober?', [], false);
    const a = answerer();
    canvas.act(card.id, { action: 'pause', safePoint: true });
    expect(a.closed).toBe(false);
    expect(board().item(card.id)).toMatchObject({ pausing: true, thread: { thinking: true } });
    a.call('answer_owner', { text: 'Oktober: 12 ct.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(card.id).filter((e) => e.kind === 'talk').at(-1)!.text).toBe('Oktober: 12 ct.');
    expect(board().item(card.id)).toMatchObject({ paused: true, thread: { answers: 3 } });
    expect(board().item(card.id)!.pausing).toBeUndefined();
    canvas.act(card.id, { action: 'resume' });
    expect(board().item(card.id)!.paused).toBeUndefined();
  });

  test('its agent paused while it reads keeps what it was asked, stays paused across a restart, and answers it once resumed', async () => {
    const { card } = await moved();
    expect(() => canvas.act(card.id, { action: 'pause' })).toThrow('not working on anything');
    canvas.tell(card.id, 'und im Oktober?', [], false);
    const a = answerer();
    canvas.act(card.id, { action: 'pause' });
    expect(a.closed).toBe(true);
    await settle();
    expect(board().item(card.id)).toMatchObject({ paused: true, thread: { answers: 2 } });
    expect(board().item(card.id)!.thread!.thinking).toBeUndefined();
    // nothing answered it: the question stands last
    expect(board().events(card.id).filter((e) => e.kind === 'talk').at(-1)!.text).toBe('und im Oktober?');
    canvas.shutdown();
    canvas = await open();
    await settle();
    expect(answerer()).toBe(a);
    expect(board().item(card.id)!.paused).toBe(true);
    canvas.act(card.id, { action: 'resume' });
    await settle();
    const b = answerer();
    expect(b).not.toBe(a);
    expect(b.spec.resume).toBe('look-1');
    expect(b.inbox[0]).toContain('The owner paused you while you worked on your answer and has now let you go on');
    expect(b.inbox[0]).toContain('und im Oktober?');
    expect(board().item(card.id)).toMatchObject({ thread: { thinking: true } });
    expect(board().item(card.id)!.paused).toBeUndefined();
    b.call('answer_owner', { text: 'Oktober: 12 ct.' });
    b.emit({ type: 'idle' });
    await settle();
    expect(board().item(card.id)!.thread).toEqual({ talk: board().item(card.id)!.thread!.talk, answers: 3, files: 1 });
  });

  test('asked more while paused, its agent goes on with that and what it was asked before', async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'und im Oktober?', [], false);
    canvas.act(card.id, { action: 'pause' });
    await settle();
    canvas.tell(card.id, 'und November?', [], false);
    await settle();
    const b = answerer();
    expect(b.inbox[0]).toContain('The owner paused you');
    expect(b.inbox[0]!.indexOf('und im Oktober?')).toBeLessThan(b.inbox[0]!.indexOf('und November?'));
    expect(board().item(card.id)!.paused).toBeUndefined();
  });

  test('its agent goes on reading while its background work runs, answers once that work wakes it, and can be paused meanwhile', async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'und im Oktober?', [], false);
    const a = answerer();
    a.emit({ type: 'background', tasks: [{ id: 'b1', description: 'Query October' }] });
    a.emit({ type: 'text', text: 'The October query runs.' });
    a.emit({ type: 'idle', background: 1 });
    await settle();
    expect(a.closed).toBe(false);
    expect(board().item(card.id)!.thread).toMatchObject({ thinking: true, answers: 2 });
    a.emit({ type: 'background', tasks: [] });
    a.call('answer_owner', { text: 'Oktober: 12 ct.' });
    a.emit({ type: 'idle', background: 0 });
    await settle();
    expect(a.closed).toBe(true);
    expect(board().item(card.id)!.thread).toEqual({ talk: card.thread!.talk, answers: 3, files: 1 });
    expect(board().events(card.id).filter((e) => e.kind === 'talk').at(-1)!.text).toBe('Oktober: 12 ct.');

    // paused while it waits for the work: what it was asked stays for when it goes on
    canvas.tell(card.id, 'und November?', [], false);
    const b = answerer();
    b.emit({ type: 'idle', background: 1 });
    canvas.act(card.id, { action: 'pause' });
    expect(b.closed).toBe(true);
    await settle();
    expect(board().item(card.id)).toMatchObject({ paused: true, thread: { answers: 3 } });
    expect(board().thread(card.id).pending).toEqual([expect.objectContaining({ text: expect.stringContaining('und November?') })]);
  });

  test("while its agent waits for its background work, the owner's words go into its session at once, and its answer answers them too", async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'lade die Daten für 2024', [], false);
    const a = answerer();
    const sessions = runtime.sessions.length;
    a.emit({ type: 'background', tasks: [{ id: 'b1', description: 'Download 2024' }] });
    // what comes while it works on its turn waits, unread
    canvas.tell(card.id, 'mit Dezember', [], false);
    expect(board().events(card.id).at(-1)!.unread).toBe(true);
    expect(a.inbox).toHaveLength(1);
    // its turn ends waiting for the download: those words go in now
    a.emit({ type: 'text', text: 'The download runs.' });
    a.emit({ type: 'idle', background: 1 });
    await settle();
    expect(a.inbox).toHaveLength(2);
    expect(a.inbox[1]).toContain('mit Dezember');
    expect(board().events(card.id).find((e) => e.text === 'mit Dezember')!.unread).toBeUndefined();
    // the agent takes them in and waits again; what the owner writes now goes in at once, read
    a.emit({ type: 'idle', background: 1 });
    canvas.tell(card.id, 'stopp, nimm 2023', [], false);
    const stop = board().events(card.id).at(-1)!;
    expect(stop.unread).toBeFalsy();
    expect(a.inbox).toHaveLength(3);
    expect(a.inbox[2]).toContain('stopp, nimm 2023');
    expect(() => canvas.press(card.id, { action: 'unsay', id: stop.id })).toThrow('read these words already');
    // one answer answers all of it, in the same session, and nothing waits for another turn
    a.emit({ type: 'background', tasks: [] });
    a.call('answer_owner', { text: '2023 mit Dezember: 14 ct.' });
    a.emit({ type: 'idle', background: 0 });
    await settle();
    expect(a.closed).toBe(true);
    expect(runtime.sessions.length).toBe(sessions);
    expect(board().item(card.id)!.thread).toEqual({ talk: card.thread!.talk, answers: 3, files: 1 });
    expect(board().thread(card.id).pending).toEqual([]);
    expect(board().events(card.id).filter((e) => e.kind === 'talk').map((e) => e.text).slice(-4)).toEqual(['lade die Daten für 2024', 'mit Dezember', 'stopp, nimm 2023', '2023 mit Dezember: 14 ct.']);
  });

  test('words wait for the next turn once the work ended, and a session that fails after it heard them hands them to the fresh one', async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'lade die Daten für 2024', [], false);
    const a = answerer();
    a.emit({ type: 'idle', background: 1 });
    canvas.tell(card.id, 'stopp, nimm 2023', [], false);
    expect(a.inbox).toHaveLength(2);
    // the work ended and is about to wake the agent: what comes now waits for its turn, unread
    a.emit({ type: 'idle', background: 1 });
    a.emit({ type: 'background', tasks: [] });
    canvas.tell(card.id, 'und Dezember?', [], false);
    expect(board().events(card.id).at(-1)!.unread).toBe(true);
    expect(a.inbox).toHaveLength(2);
    // a message still to come keeps the turn going
    a.emit({ type: 'idle', background: 0, more: true });
    await settle();
    expect(a.closed).toBe(false);
    // the resumed session fails, and reports more after its error: the fresh session gets what the failed one heard
    const sessions = runtime.sessions.length;
    a.emit({ type: 'error', message: 'boom' });
    a.emit({ type: 'idle', background: 1 });
    await settle();
    expect(runtime.sessions.length).toBe(sessions + 1);
    const b = answerer();
    expect(b.spec.resume).toBeUndefined();
    expect(b.inbox[0]).toContain('lade die Daten für 2024');
    expect(b.inbox[0]).toContain('stopp, nimm 2023');
    expect(b.inbox[0]).not.toContain('und Dezember?');
    canvas.tell(card.id, 'und Januar?', [], false);
    expect(a.inbox).toHaveLength(2);
    expect(board().events(card.id).at(-1)!.unread).toBe(true);
    b.call('answer_owner', { text: '2023: 14 ct.' });
    b.emit({ type: 'idle', background: 0 });
    await settle();
    // what waited goes in with the next turn
    const c = answerer();
    expect(c.inbox[0]).toContain('und Dezember?');
    expect(c.inbox[0]).toContain('und Januar?');
  });

  test('its agent the usage limit stops waits on the card and answers once the limit lifts; paused meanwhile, it waits no more', async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'und im Oktober?', [], false);
    const a = answerer();
    limit(a, 20);
    await settle();
    expect(board().item(card.id)).toMatchObject({ thread: { thinking: true } });
    expect(board().item(card.id)!.limitedUntil).toBeDefined();
    await settle(60);
    expect(board().item(card.id)!.limitedUntil).toBeUndefined();
    expect(a.inbox.at(-1)).toContain('usage limit');
    a.call('answer_owner', { text: 'Oktober: 12 ct.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().events(card.id).filter((e) => e.kind === 'talk').at(-1)!.text).toBe('Oktober: 12 ct.');

    canvas.tell(card.id, 'und November?', [], false);
    const b = answerer();
    limit(b, 10_000);
    await settle();
    expect(board().item(card.id)!.limitedUntil).toBeDefined();
    canvas.act(card.id, { action: 'pause' });
    expect(b.closed).toBe(true);
    expect(board().item(card.id)!.limitedUntil).toBeUndefined();
  });

  test('what the card asked when Obeya stopped is asked again', async () => {
    const { card } = await moved();
    canvas.tell(card.id, 'und im Oktober?', [], false);
    canvas.shutdown();
    canvas = await open();
    await settle();
    const a = answerer();
    expect(a.inbox[0]).toContain('und im Oktober?');
    a.call('answer_owner', { text: 'Oktober: 12 ct.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().item(card.id)!.thread!.thinking).toBeUndefined();
  });

  test('"Discuss as idea" makes it an idea whose exploration agent starts from the thread; "Done" archives it', async () => {
    const { first, card } = await moved();
    canvas.act(card.id, { action: 'asIdea' });
    const idea = board().item(card.id)!;
    expect(idea).toMatchObject({ kind: 'task', state: 'idea' });
    const explorer = runtime.sessions.at(-1)!;
    expect(explorer.spec.role).toBe('explorer');
    expect(explorer.spec.resume).toBeUndefined();
    expect(explorer.inbox[0]).toContain('Obeya: Hier die Tabelle.');
    expect(explorer.inbox[0]).toContain('numbers.xlsx – Die Viertelstunden');
    expect(explorer.inbox[0]).toContain(answersDir(dir, canvas.id, first));
    // the thread is where it starts, once: it is no idea discussed before
    expect(explorer.inbox[0]).not.toContain('discussed before');

    const other = await lookedUp('noch eine frage', 'Another?', 'Ja.', 'look-9');
    const done = canvas.answers.toCard(other);
    board().archive([done.id]);
    expect(board().item(done.id)).toBeUndefined();
    // put back by moving the thread again
    expect(canvas.answers.toCard(other).id).toBe(done.id);
    expect(board().item(done.id)).toBeDefined();
  });

  test('its agent tells a walkthrough that plays in its conversation from the first slide on, until the answer takes its place; paused, the turn takes it along', async () => {
    const { first, card } = await moved();
    canvas.tell(card.id, 'wie entsteht die tabelle?', [], false);
    let a = answerer();
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Die Tabelle', language: 'de', narration: 'So entsteht sie.' } });
    const live = board().events(card.id).at(-1)!;
    expect(live).toMatchObject({ kind: 'talk', author: 'coordinator', text: '', answer: { thread: first, live: true, files: [{ name: 'die-tabelle.walkthrough.json' }] } });
    a.call('answer_owner', { text: 'Der Walkthrough zeigt, wie die Tabelle entsteht.' });
    a.emit({ type: 'idle' });
    await settle();
    const talk = board().events(card.id).filter((e) => e.kind === 'talk');
    expect(talk.filter((e) => e.answer?.files?.some((f) => f.name === 'die-tabelle.walkthrough.json'))).toHaveLength(1);
    expect(talk.at(-1)).toMatchObject({ text: 'Der Walkthrough zeigt, wie die Tabelle entsteht.', answer: { thread: first, files: [{ name: 'die-tabelle.walkthrough.json', caption: 'Die Tabelle' }] } });
    expect(talk.at(-1)!.answer!.live).toBeUndefined();
    expect(board().item(card.id)!.thread).toMatchObject({ answers: 3, files: 2 });

    canvas.tell(card.id, 'und die summen?', [], false);
    a = answerer();
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Die Summen', language: 'de', narration: 'Eins.' } });
    expect(board().events(card.id).at(-1)!.answer?.live).toBe(true);
    canvas.act(card.id, { action: 'pause' });
    await settle();
    expect(board().events(card.id).some((e) => e.answer?.live)).toBe(false);
  });
});

describe("a question asked in a project's sheet", () => {
  const project = () => board().snapshot().items.find((i) => i.kind === 'project')!;
  /** Asks in the project's sheet; the project agent answers it in session `session`. */
  async function asked(text: string, answer: string, session = 'project-1', extra: { images?: string[]; replyTo?: { talk: number; part: 'said' | 'answer' } } = {}) {
    canvas.press(project().id, { action: 'consult', text, ...extra });
    await settle();
    const a = answerer();
    a.emit({ type: 'session', id: session });
    a.call('answer_owner', { text: answer });
    a.emit({ type: 'idle' });
    await settle();
    return { a, talk: board().talk().at(-1)! };
  }

  test('goes straight to its project agent, with its screenshots, and stands in the sheet with the answer', async () => {
    const shot = canvas.images.save(new Uint8Array([1, 2, 3]), 'image/png');
    const { a, talk } = await asked('Warum wartet W4 auf das Go?', 'Weil der Shop live geht.', 'project-1', { images: [shot] });
    // no Coordinator read the words first
    expect(runtime.sessions.some(isCoordinator)).toBe(false);
    expect(a.spec.system).toContain('project agent of the project "PR-Loop"');
    expect(a.spec.tools.map((t) => t.name)).toContain('to_obeya');
    expect(a.inbox[0]).toContain("The owner wrote to you in the project's sheet in Obeya");
    expect(a.inbox[0]).toContain('Warum wartet W4 auf das Go?');
    expect(a.images[0]).toEqual([canvas.images.path(shot)!]);
    expect(board().row(project().id).session_id).toBe('project-1');
    expect(talk).toMatchObject({ said: 'Warum wartet W4 auf das Go?', askedIn: project().id, question: 'Warum wartet W4 auf das Go?', answer: 'Weil der Shop live geht.', answerBy: 'project', images: [shot] });
    expect(talk.reply).toBeUndefined();
    expect(board().projectHistory(project().id).talk.map((x) => x.id)).toEqual([talk.id]);
    // the sheet shows it in full: a page with it open needs no line above the microphone
    expect(notices).toEqual([{ talk: talk.id, project: project().id, text: 'Weil der Shop live geht.' }]);
    // seen there, it waits nowhere else
    expect(talk.unread).toBe(true);
    board().readTalk([talk.id]);
    expect(board().talk().at(-1)!.unread).toBeUndefined();
  });

  test("a reply to a message there follows up on its thread, in the project's session; a question asked of Obeya about the project stands there too", async () => {
    const first = await asked('Was macht W4?', 'Es geht live.');
    const { a, talk } = await asked('Und wann?', 'Nach dem Go.', 'project-1', { replyTo: { talk: first.talk.id, part: 'answer' } });
    expect(a.spec.resume).toBe('project-1');
    expect(a.inbox[0]).toContain('The owner follows up on your answer. They said: "Und wann?"');
    expect(a.inbox[0]).not.toContain('as Obeya understood it');
    expect(talk).toMatchObject({ thread: first.talk.id, follows: first.talk.id, replyTo: { talk: first.talk.id, part: 'answer' } });

    // asked of Obeya with the project open, or with one of its workstreams open
    await say('was sagt der plan zu W1?', { project: project().id }, 'look_up', { question: 'What does the plan say about W1?', confirm: 'Ich schaue im Plan nach.' });
    const viaObeya = board().talk().at(-1)!;
    await say('und hier?', { card: workstream().id }, 'look_up', { question: 'What is left on W4?', confirm: 'Moment.' });
    const onWorkstream = board().talk().at(-1)!;
    expect(board().projectHistory(project().id).talk.map((x) => x.id)).toEqual([first.talk.id, talk.id, viaObeya.id, onWorkstream.id]);
    expect(viaObeya.askedIn).toBeUndefined();
  });

  test("passes on with to_obeya what asks Obeya, which reads it with the project open", async () => {
    canvas.press(project().id, { action: 'consult', text: 'Starte bitte W4.' });
    await settle();
    const a = answerer();
    const passed = a.call('to_obeya', { request: 'Start W4.' });
    await settle();
    const k = runtime.sessions.filter(isCoordinator).at(-1)!;
    expect(k.inbox.at(-1)).toContain('Starte bitte W4.');
    k.call('reply', { confirm: 'Mache ich gleich.' });
    k.emit({ type: 'idle' });
    expect(await passed).toBe('Obeya: Mache ich gleich.');
    // Obeya's reply stands in its sheet, not in a card's log
    expect(board().talk().at(-1)).toMatchObject({ said: 'Starte bitte W4.', reply: 'Mache ich gleich.' });
    expect(board().talk().at(-1)!.cardId).toBeUndefined();
  });

  test('still being answered when Obeya restarts, it is asked again; "Make it a card" puts its card beside the project', async () => {
    canvas.press(project().id, { action: 'consult', text: 'Was fehlt noch?' });
    await settle();
    canvas.shutdown();
    canvas = await open();
    await settle();
    const talk = board().talk().at(-1)!;
    // Obeya never read the words, so they get no reply of its own at the restart
    expect(talk.reply).toBeUndefined();
    const a = answerer();
    expect(a.inbox[0]).toContain('Was fehlt noch?');
    a.call('answer_owner', { text: 'Nur W4.' });
    a.emit({ type: 'idle' });
    await settle();
    const card = canvas.answers.toCard(talk.id);
    expect(card).toMatchObject({ kind: 'question', title: 'Was fehlt noch?' });
    const p = project();
    expect(Math.abs(card.x - p.x) + Math.abs(card.y - p.y)).toBeLessThan(2000);
  });
});

describe('an answer told as a walkthrough', () => {
  test('shows under its question from the first slide on, and its words come in above it, the walkthrough first among its files', async () => {
    await say('wie landet eine karte?', {}, 'look_up', { question: 'How does an approved card land on main?', confirm: 'Moment.' });
    const a = answerer();
    expect(a.spec.system).toContain('Walkthroughs: an answer that explains how something works or what happens when');
    expect(a.spec.tools.map((t) => t.name)).toContain('walkthrough_slide');
    const talk = board().talk().at(-1)!;
    expect(a.call('walkthrough_slide', { slide: { type: 'title', title: 'Wie eine Karte landet', language: 'de', narration: 'Drei Schritte.' } })).toStartWith('Slide 1 is shown');
    await settle();
    expect(board().exchange(talk.id)).toMatchObject({ files: [{ name: 'wie-eine-karte-landet.walkthrough.json', caption: 'Wie eine Karte landet' }] });
    expect(board().exchange(talk.id)!.answer).toBeUndefined();
    a.call('walkthrough_slide', { slide: { type: 'flow', title: 'Der Weg', steps: ['Rebase', 'Checks', { label: 'Merge', note: 'auf main' }], narration: 'Erst rebasen, dann prüfen, dann mergen.' } });
    // the player reads it as it grows, and says which slide it plays
    const shown = canvas.answers.walkthrough(talk.id, 'wie-eine-karte-landet.walkthrough.json', 0)!;
    expect(shown.slides.map((x) => x.type)).toEqual(['title', 'flow']);
    expect(shown.done).toBe(false);
    const out = answersDir(dir, canvas.id, talk.id);
    writeFileSync(join(out, 'flow.png'), 'png');
    a.call('answer_owner', { text: 'Der Walkthrough zeigt die drei Schritte.', files: [{ path: 'flow.png', caption: 'Der Weg' }] });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().exchange(talk.id)).toMatchObject({
      answer: 'Der Walkthrough zeigt die drei Schritte.',
      files: [
        { name: 'wie-eine-karte-landet.walkthrough.json', caption: 'Wie eine Karte landet' },
        { name: 'flow.png', caption: 'Der Weg' },
      ],
    });
    expect(canvas.answers.walkthrough(talk.id, 'wie-eine-karte-landet.walkthrough.json')!.done).toBe(true);
    // in the voice of the demo settings, sentence by sentence, the title first
    await until(() => voice.said.length === 3);
    expect(voice.said).toEqual(['de:Wie eine Karte landet.', 'de:Drei Schritte.', 'de:Erst rebasen, dann prüfen, dann mergen.']);
  });

  test("asked with a card open, it plays in that card's log before the answer, which takes its place", async () => {
    const login = board().create({ title: 'Login', body: 'Login hängt.', x: 0, y: 0 });
    await say('wie läuft der login ab?', { card: login.id }, 'look_up', { question: 'How does login go?', confirm: 'Moment.' });
    const thread = board().talk().at(-1)!.id;
    const a = answerer();
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Der Login', language: 'de', narration: 'Er geht so.' } });
    expect(board().events(login.id).at(-1)).toMatchObject({ kind: 'say', author: 'coordinator', text: '', answer: { thread, live: true } });
    a.call('answer_owner', { text: 'So läuft er ab.' });
    a.emit({ type: 'idle' });
    await settle();
    const said = board().events(login.id).filter((e) => e.answer);
    expect(said.map((e) => [e.text, e.answer!.live, e.answer!.files?.map((f) => f.name)])).toEqual([['So läuft er ab.', undefined, ['der-login.walkthrough.json']]]);
  });

  test('"Show as walkthrough" asks the agent of its thread again, in its session, its player there at once and the voice loading meanwhile', async () => {
    const first = await lookedUp('ideenkarte oder fragekarte?', 'Idea card or Question card?', 'Eine Ideenkarte, wenn …', 'look-1');
    expect(canvas.answers.showAsWalkthrough(first)).toEqual({ thread: first, file: 'idea-card-or-question-card.walkthrough.json' });
    const asked = board().talk().at(-1)!.id;
    expect(board().exchange(asked)).toMatchObject({ said: 'Als Walkthrough zeigen', reply: 'Ich erzähle die Antwort als Walkthrough.', thread: first, follows: first });
    expect(voice.warmed).toEqual(['de']);
    const a = answerer();
    expect(a.spec.resume).toBe('look-1');
    expect(a.inbox[0]).toContain('Tell this answer of yours as a walkthrough, as your instructions describe, rather than as text');
    // the answer the owner clicked, which need not be the thread's last
    expect(a.inbox[0]).toContain('The question: Idea card or Question card?');
    expect(a.inbox[0]).toContain('<answer>\nEine Ideenkarte, wenn …\n</answer>');
    // its player stands there at once, empty until the title slide, named after the question
    const pending = 'idea-card-or-question-card.walkthrough.json';
    expect(board().exchange(asked)!.files).toEqual([{ name: pending, caption: '' }]);
    expect(canvas.answers.walkthrough(first, pending)).toMatchObject({ title: '', slides: [], done: false });
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Ideenkarte oder Fragekarte', language: 'de', narration: 'So.' } });
    expect(board().exchange(asked)!.files).toEqual([{ name: pending, caption: 'Ideenkarte oder Fragekarte' }]);
    expect(canvas.answers.walkthrough(first, pending)).toMatchObject({ title: 'Ideenkarte oder Fragekarte', slides: [{ type: 'title' }] });
    a.call('answer_owner', { text: 'Der Walkthrough zeigt den Unterschied.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().exchange(asked)).toMatchObject({ answer: 'Der Walkthrough zeigt den Unterschied.', files: [{ name: pending, caption: 'Ideenkarte oder Fragekarte' }] });
    // a confirmation of actions is no answer to tell
    await say('mach eine karte "Login"', {}, 'act', { actions: [{ do: 'new_card', title: 'Login', body: 'Login hängt.', start: false }], confirm: 'Neue Aufgabe „Login“.' });
    expect(() => canvas.answers.showAsWalkthrough(board().talk().at(-1)!.id)).toThrow(BadRequest);
  });

  test('"Show as walkthrough" on a direct answer starts a look-up thread for it, quoting the answer it tells', async () => {
    await say('was ist eine fragekarte?', {}, 'reply', { confirm: 'Eine Fragekarte hält einen nachgeschlagenen Faden mit seinen Antworten und Dateien.' });
    const direct = board().talk().at(-1)!;
    expect(direct.replyOnly).toBe(true);
    const asked = canvas.answers.showAsWalkthrough(direct.id);
    const x = board().talk().at(-1)!;
    expect(asked).toEqual({ thread: x.id, file: 'was-ist-eine-fragekarte.walkthrough.json' });
    expect(x).toMatchObject({ said: 'Als Walkthrough zeigen', reply: 'Ich erzähle die Antwort als Walkthrough.', thread: x.id, replyTo: { talk: direct.id, part: 'reply' } });
    expect(x.follows).toBeUndefined();
    expect(x.files).toEqual([{ name: asked.file, caption: '' }]);
    expect(voice.warmed).toEqual(['de']);
    // a fresh look-up, told what Obeya answered
    const a = answerer();
    expect(a.spec.resume).toBeUndefined();
    expect(a.inbox[0]).toContain('The owner said to Obeya: "was ist eine fragekarte?". Obeya answered straight away, without looking anything up:');
    expect(a.inbox[0]).toContain('<answer>\nEine Fragekarte hält einen nachgeschlagenen Faden mit seinen Antworten und Dateien.\n</answer>');
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Die Fragekarte', language: 'de', narration: 'So.' } });
    a.call('answer_owner', { text: 'Der Walkthrough zeigt die Fragekarte.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().exchange(x.id)).toMatchObject({ answer: 'Der Walkthrough zeigt die Fragekarte.', files: [{ name: asked.file, caption: 'Die Fragekarte' }] });
  });

  test('"Show as walkthrough" in a card\'s conversation: its words, the player and the answer stand in that card\'s log', async () => {
    const login = board().create({ title: 'Login', body: 'Login hängt.', x: 0, y: 0 });
    // a direct answer on the card
    await say('was macht diese karte?', { card: login.id }, 'reply', { confirm: 'Sie behebt den hängenden Login.' });
    const reply = board().events(login.id).findLast((e) => e.author === 'coordinator')!;
    expect(reply).toMatchObject({ text: 'Sie behebt den hängenden Login.', reply: true });
    const asked = canvas.answers.showEventAsWalkthrough(login.id, reply.id);
    const x = board().talk().at(-1)!;
    expect(board().exchange(x.id)).toMatchObject({ cardId: login.id, thread: asked.thread, about: login.id });
    const log = () => board().events(login.id).filter((e) => e.id > reply.id);
    expect(log().map((e) => [e.author, e.text, e.replyTo, e.answer?.live, e.answer?.files])).toEqual([
      ['owner', 'Als Walkthrough zeigen', reply.id, undefined, undefined],
      ['coordinator', 'Ich erzähle die Antwort als Walkthrough.', undefined, undefined, undefined],
      ['coordinator', '', undefined, true, [{ name: asked.file, caption: '' }]],
    ]);
    // the look-up hears about the card, and its answer takes the player's place
    const a = answerer();
    expect(a.inbox[0]).toContain('It is about the task "Login"');
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'Der Login', language: 'de', narration: 'So.' } });
    a.call('answer_owner', { text: 'Der Walkthrough zeigt die Karte.' });
    a.emit({ type: 'idle' });
    await settle();
    const answer = log().at(-1)!;
    expect(log().filter((e) => e.answer)).toHaveLength(1);
    expect(answer).toMatchObject({ kind: 'say', text: 'Der Walkthrough zeigt die Karte.', answer: { thread: asked.thread, files: [{ name: asked.file, caption: 'Der Login' }] } });

    // that looked-up answer goes on in its thread, from the card's log
    const again = canvas.answers.showEventAsWalkthrough(login.id, answer.id);
    expect(again.thread).toBe(asked.thread);
    expect(board().talk().at(-1)).toMatchObject({ cardId: login.id, follows: x.id, thread: asked.thread });
    expect(answerer().inbox[0]).toContain('<answer>\nDer Walkthrough zeigt die Karte.\n</answer>');
    // the owner's own words are no answer
    const own = log().find((e) => e.author === 'owner')!;
    expect(() => canvas.answers.showEventAsWalkthrough(login.id, own.id)).toThrow(BadRequest);
  });

  test('"Show as walkthrough" loads the voice for the language of the answer it tells, which the title slide then names', async () => {
    // the conversation language is German here, the answer English
    const first = await lookedUp('idea card or question card?', 'Idea card or Question card?', 'An idea card, when the owner wants to think it through with an agent first.', 'look-1');
    canvas.answers.showAsWalkthrough(first);
    expect(voice.warmed).toEqual(['en']);
    answerer().call('walkthrough_slide', { slide: { type: 'title', title: 'Idea card or Question card', language: 'en', narration: 'Two kinds of card.' } });
    await until(() => voice.said.length === 2);
    expect(voice.said).toEqual(['en:Idea card or Question card.', 'en:Two kinds of card.']);
  });

  test('asked for with the button and answered as text after all, the empty walkthrough goes', async () => {
    const first = await lookedUp('ideenkarte oder fragekarte?', 'Idea card or Question card?', 'Eine Ideenkarte, wenn …', 'look-1');
    canvas.answers.showAsWalkthrough(first);
    const asked = board().talk().at(-1)!.id;
    const a = answerer();
    a.call('answer_owner', { text: 'Das lässt sich nicht gut zeigen.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().exchange(asked)!.files).toBeUndefined();
  });

  test("a project's agent tells walkthroughs too", async () => {
    const p = board().snapshot().items.find((i) => i.kind === 'project')!;
    canvas.press(p.id, { action: 'consult', text: 'Wie läuft W4 ab?' });
    await settle();
    const a = answerer();
    expect(a.spec.system).toContain('project agent of the project "PR-Loop"');
    expect(a.spec.system).toContain('Walkthroughs:');
    expect(a.spec.tools.map((t) => t.name)).toEqual(['answer_owner', 'walkthrough_slide', 'to_obeya']);
    a.call('walkthrough_slide', { slide: { type: 'title', title: 'W4', language: 'de', narration: 'So.' } });
    await settle();
    expect(board().talk().at(-1)!.files).toEqual([{ name: 'w4.walkthrough.json', caption: 'W4' }]);
  });

  test('one begun when Obeya restarts makes way for the one the look-up tells anew', async () => {
    await say('wie landet eine karte?', {}, 'look_up', { question: 'How does a card land?', confirm: 'Moment.' });
    answerer().call('walkthrough_slide', { slide: { type: 'title', title: 'Landen', language: 'de', narration: 'So.' } });
    const talk = board().talk().at(-1)!.id;
    expect(board().exchange(talk)!.files).toHaveLength(1);
    canvas.shutdown();
    canvas = await open();
    await settle();
    expect(board().exchange(talk)!.files).toBeUndefined();
    expect(answerer().inbox[0]).toContain('How does a card land?');
  });
});
