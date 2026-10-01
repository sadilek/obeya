import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRuntime } from './canvas';
import type { Focus } from './commands';
import { Store } from './db';
import { FakeRuntime, type FakeSession, gitRepo } from './testing';

let dir: string;
let main: string;
let store: Store;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;
let spoken: [string | undefined, string][];

const open = () => {
  const c = new CanvasRuntime({ repos: [{ path: main, clones: 1 }] }, { store, home: dir, runtime, forge: { status: () => ({}) as never }, commandDelayMs: 10 });
  c.board.onSpeak((id, text) => spoken.push([id, text]));
  return c;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-answers-'));
  main = join(dir, 'main');
  gitRepo(main, { 'docs/plan/pr-loop.md': '# PR-Loop\n\n## Goal\n\nG.\n\n## Workstreams\n\n- [x] **W1:** PR-Phase.\n- [ ] **W4:** Live auf Acme. Mit dem Go des Owners.\n' });
  store = new Store(':memory:');
  runtime = new FakeRuntime();
  spoken = [];
  canvas = open();
});
afterEach(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const board = () => canvas.board;
const workstream = () => board().snapshot().items.find((i) => i.label === 'W4')!;
const isKoordinator = (s: FakeSession) => s.spec.tools.some((t) => t.name === 'look_up');
const answerer = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'answer_owner')).at(-1)!;

/** Says `text` with `focus`; the Koordinator reads it with `tool`. */
async function say(text: string, focus: Focus, tool: string, args: Record<string, unknown>) {
  const heard = canvas.commander.hear(text, focus);
  await settle();
  const s = runtime.sessions.filter(isKoordinator).at(-1)!;
  s.call(tool, args);
  s.emit({ type: 'idle' });
  return { heard: await heard, brief: s.inbox.at(-1)! };
}

describe('a question the Koordinator looks up', () => {
  test("about a workstream: its project agent answers from the start task, in the open card's log and aloud", async () => {
    const w4 = workstream();
    const { heard } = await say('Was würde der Agent hier machen, wenn ich starte?', { card: w4.id }, 'look_up', {
      question: 'What would the worker do on W4 if the owner started it now?',
      confirm: 'Ich schaue im Plan nach.',
    });
    // nothing to take back; the acknowledgement is what the owner hears now
    expect(heard).toEqual({ confirm: 'Ich schaue im Plan nach.' });
    const a = answerer();
    expect(a.spec.readOnly).toBe(true);
    expect(a.spec.system).toContain('project agent of the project "PR-Loop"');
    expect(a.inbox[0]).toContain('What would the worker do on W4');
    expect(a.inbox[0]).toContain('The task its worker would get if the owner started it now');
    expect(a.inbox[0]).toContain('Your card: feature “Live auf Acme”.');
    expect(a.inbox[0]).toContain('Read its plan doc docs/plan/pr-loop.md first');
    expect(board().snapshot().talk).toEqual([]);

    a.emit({ type: 'session', id: 'project-1' });
    a.emit({ type: 'tool', name: 'Read', input: { file_path: `${main}/docs/plan/pr-loop.md` } });
    a.call('answer_owner', { text: '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.', spoken: 'Er würde zuerst nach deinem Go fragen.' });
    a.emit({ type: 'idle' });
    await settle();

    expect(board().events(w4.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['say', 'owner', 'Was würde der Agent hier machen, wenn ich starte?'],
      ['say', 'koordinator', 'Ich schaue im Plan nach.'],
      ['activity', 'project', 'Liest plan/pr-loop.md'],
      ['say', 'project', '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.'],
    ]);
    expect(spoken).toEqual([[undefined, 'Er würde zuerst nach deinem Go fragen.']]);
    // the project agent keeps its session: it knows the plan and the history
    expect(board().row(w4.parent!).session_id).toBe('project-1');
    expect(board().talk().at(-1)).toMatchObject({ question: 'What would the worker do on W4 if the owner started it now?', answer: '1. Liest das Plan-Doc.\n2. Fragt nach dem Go.', answerBy: 'project' });

    // the Koordinator hears the answer with the next command
    const next = await say('und dann?', { card: w4.id }, 'reply', { confirm: 'Dann wartet er.' });
    expect(next.brief).toContain('The answer you looked up for the owner\'s question „What would the worker do on W4');
  });

  test('about a card without a project: a thorough Koordinator turn answers, in the sheet when no card is open', async () => {
    board().create({ kind: 'bugfix', title: 'Login', body: 'Login hängt.', x: 0, y: 0 });
    const first = await say('was steht im plan zu login?', {}, 'reply', { confirm: 'Welche Karte?' });
    const tag = /(K\d+) \[planned\] bugfix "Login"/.exec(first.brief)![1];
    await say('was würde der agent bei login machen?', {}, 'look_up', { question: 'What would the worker do on Login?', card: tag, confirm: 'Moment, ich lese nach.' });
    const a = answerer();
    expect(a.spec.system).toContain('You are the Koordinator of Obeya');
    expect(a.spec.effort).toBe('medium');
    expect(a.inbox[0]).toContain('Your card: bugfix “Login”.');
    expect(board().snapshot().talk.at(-1)).toMatchObject({ said: 'was würde der agent bei login machen?', reply: 'Moment, ich lese nach.', question: 'What would the worker do on Login?' });
    expect(board().snapshot().talk.at(-1)!.answer).toBeUndefined();

    a.call('answer_owner', { text: 'Er sucht den Hänger.', spoken: 'Er sucht den Hänger.' });
    a.emit({ type: 'idle' });
    await settle();
    expect(board().snapshot().talk.at(-1)).toMatchObject({ answer: 'Er sucht den Hänger.', answerBy: 'koordinator' });
    expect(spoken).toEqual([[undefined, 'Er sucht den Hänger.']]);
  });

  test('an unknown card tag goes back to the Koordinator', async () => {
    const heard = canvas.commander.hear('was macht X?', {});
    await settle();
    const s = runtime.sessions.find(isKoordinator)!;
    expect(s.call('look_up', { question: 'X?', card: 'K9', confirm: 'Moment.' })).toContain('Unknown tag K9');
    s.call('reply', { confirm: 'Welche Karte meinst du?' });
    s.emit({ type: 'idle' });
    expect((await heard).confirm).toBe('Welche Karte meinst du?');
  });

  test('a question still being looked up when Obeya restarts is looked up again', async () => {
    const w4 = workstream();
    await say('was würde der agent tun?', { card: w4.id }, 'look_up', { question: 'What would the worker do?', confirm: 'Ich schaue nach.' });
    canvas.shutdown();
    const before = runtime.sessions.length;
    canvas = open();
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
});
