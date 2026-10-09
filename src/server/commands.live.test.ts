// The Koordinator's prompt against the real model: requests the agent of an open card passes on from
// the owner's words, in each state an agent is on; sentences said or typed with a card open that no
// agent works on; new tasks that start or wait; and questions with no card open (an opinion becomes
// an idea, a fact stays in the conversation). Runs only with OBEYA_LIVE=1 (it uses the machine's
// Claude login and takes about a minute): `OBEYA_LIVE=1 bun test src/server/commands.live.test.ts`.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from './board';
import { type Command, Commander } from './commands';
import { Store } from './db';
import { AGENT_DEFAULTS } from '../core/types';
import { type AgentRuntime, sdkRuntime, withAgentSetting } from './runtime';

// the sessions need the machine's Claude login, which the test setup hides behind a scratch config
const scratch = process.env.CLAUDE_CONFIG_DIR;
const machine = process.env.OBEYA_MACHINE_CLAUDE_CONFIG_DIR;
const setConfig = (dir: string | undefined) => (dir === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = dir));
beforeAll(() => void (process.env.OBEYA_LIVE && setConfig(machine)));
afterAll(() => void setConfig(scratch));

const DEMO = JSON.stringify({ dir: '/d', chapters: [], question: 'Alte Projekte nachtragen?' });
const STATES: Record<string, Record<string, string>> = {
  working: { state: 'working' },
  question: { state: 'waiting', need: 'question', detail: JSON.stringify({ question: { text: 'CSV oder Excel?', options: ['CSV', 'Excel'] } }) },
  demo: { state: 'waiting', need: 'demo', demo: DEMO },
  review: { state: 'waiting', need: 'review' },
  inPr: { state: 'inPr' },
  finishing: { state: 'live', workspace: '/w', landed: '{}' },
  planned: { state: 'planned' },
  // LOGIN: the card „Login“, which it waits for
  queued: { state: 'planned', queue: JSON.stringify({ behind: ['LOGIN'], reason: 'Beide ändern die Sitzungsverwaltung.' }) },
  proposal: { state: 'proposal', proposal: JSON.stringify({ reason: 'Beim Login aufgefallen.', questions: [{ text: 'Welche Kodierung?', options: ['UTF-8', 'Latin-1'] }] }) },
};

/**
 * State of the open card, what the owner says (or types), the request its agent passes on (`to_obeya`;
 * none: the card has no agent, and the words reach the Koordinator themselves), whether typed, and
 * the actions expected. What the owner says to an agent never comes back to it as a note, an answer or feedback.
 */
const CASES: [string, string, string | null, boolean, Command['do'][]][] = [
  ['working', 'mach eine Folgeaufgabe für den Excel-Export', 'Create a follow-up card for an Excel export of this card.', false, ['newCard']],
  ['working', 'Merk dir: Exporte immer mit Kopfzeile', 'The owner wants Obeya to remember: exports always with a header row.', true, ['remember']],
  ['working', 'halt an, ich will das anders angehen', 'Stop the agent on this card.', false, ['stop']],
  ['working', 'Was ist seit gestern auf der Leinwand passiert?', 'What happened on the canvas since yesterday?', true, []],
  ['working', 'starte auch gleich Login', 'Start the card Login.', false, ['start']],
  ['working', 'pack das in die Gruppe Abrechnung', 'Put this card into the group Abrechnung.', false, ['group']],
  ['question', 'mach eine Folgeaufgabe: Import aus CSV', 'Create a follow-up card: import from CSV.', true, ['newCard']],
  ['demo', 'gib frei', 'The owner approves my work.', false, ['approve']],
  ['demo', 'gib frei und mach eine Folgeaufgabe für die Auffälligkeit mit dem Datum', 'Approve my work, and create a follow-up card for the date anomaly from my summary.', true, ['approve', 'newCard']],
  ['demo', 'Merk dir: Demos immer mit Ton', 'Remember for all demos: always with sound.', false, ['remember']],
  ['review', 'gib das frei', 'Approve my work.', false, ['approve']],
  ['review', 'Export und Login gehören zur Gruppe Konto', 'Put the cards Export als CSV and Login into the group Konto.', true, ['group']],
  ['inPr', 'Merk dir: in diesem Repo nie force pushen', 'Remember for this repository: never force-push.', true, ['remember']],
  ['finishing', 'leg eine Aufgabe an: Branches nach dem Merge aufräumen', 'Create a new task: clean up branches after the merge.', false, ['newCard']],
  ['planned', 'Was würde der Agent hier machen, wenn ich starte?', null, false, []],
  ['queued', 'nimm das aus der Warteschlange', null, false, ['dequeue']],
  ['queued', 'Das soll doch noch nicht starten, lass es erst mal liegen', null, true, ['dequeue']],
  ['queued', 'starte das trotzdem', null, false, ['force']],
  ['proposal', 'Nimm den Excel-Export gleich mit dazu, und die Kodierung ist UTF-8', null, false, ['revise']],
  ['proposal', 'Ich glaube, das Problem liegt eher beim Import, der Export ist in Ordnung', null, true, ['revise']],
  ['proposal', 'übernimm das', null, false, ['accept']],
  ['proposal', 'das brauchen wir nicht, weg damit', null, false, ['dismiss']],
];

/** What the Koordinator makes of one sentence, or of a request passed on with it: the actions as they run. */
async function hear(state: string, text: string, request: string | null, typed: boolean) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => []);
  const login = board.create({ title: 'Login', x: 0, y: 0 });
  if (state === 'queued') board.work(login.id, { state: 'working' });
  const card = board.create({ title: 'Export als CSV', x: 0, y: 0 });
  board.work(card.id, Object.fromEntries(Object.entries(STATES[state]!).map(([k, v]) => [k, v.replace('LOGIN', login.id)])));
  const executed: Command[] = [];
  // what the session said: a command not understood shows why (not logged in, an API error)
  const said: string[] = [];
  const runtime: AgentRuntime = { start: (spec, ...rest) => sdkRuntime.start({ ...spec, onEvent: (e) => (e.type === 'text' && said.push(e.text), spec.onEvent(e)) }, ...rest) };
  const k = new Commander({ board, runtime, cwd: mkdtempSync(join(tmpdir(), 'obeya-live-')), execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = request ? await k.forward(card.id, request, { text, spoken: !typed }) : await k.hear(text, { card: card.id }, [], typed ? { typed: true } : {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), executed, confirm: heard.confirm, said };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'the Koordinator does what an agent passes on, and knows Obeya’s commands on a card without one',
  async () => {
    const results = await Promise.all(CASES.map(async ([state, text, request, typed, want]) => ({ state, text, request, typed, want, got: await hear(state, text, request, typed) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(r.want));
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} [${r.state}] ${r.typed ? 'getippt' : 'gesprochen'} „${r.text}“${r.request ? ` (vom Agenten: ${r.request})` : ''} → ${r.got.did.join(', ') || 'reply'} · ${JSON.stringify(r.got.executed.map((c) => ('text' in c ? c.text : 'title' in c ? c.title : 'name' in c ? c.name : '')))} · ${r.got.confirm}${r.got.confirm !== 'Das habe ich nicht verstanden.' ? '' : ` · Sitzung: ${r.got.said.join(' ').slice(0, 200)}`}`);
    expect(wrong.map((r) => `[${r.state}] ${r.text}`)).toEqual([]);
  },
  300_000,
);

/** What the owner says for a new task, in which language, and whether it starts. */
const NEW_TASKS: [string, 'de' | 'en', boolean][] = [
  ['Tipjar should split the bill Add a field for how many people there are and show what each person pays', 'en', true],
  ['Tipjar soll die Rechnung aufteilen ein Feld für die Personenzahl und zeig was jede Person zahlt', 'de', true],
  ['Das Trinkgeld soll man auch frei in Prozent eingeben können', 'de', true],
  ['Neue Aufgabe für später: Tipjar soll die Rechnung aufteilen', 'de', false],
  ['Just note it down for later: a field for how many people there are', 'en', false],
  ['Neue Aufgabe Export als PDF aber noch nicht starten', 'de', false],
];

/** The new card one sentence makes on a canvas like the one in the hero video: whether it starts. */
async function newTask(text: string, language: 'de' | 'en') {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'Tipjar', repos: [{ id: 'tipjar', name: 'Tipjar', path: '/r', branch: 'main' }] }, () => [], undefined, undefined, () => language);
  board.work(board.create({ title: 'Dark mode', x: 0, y: 0 }).id, { state: 'live' });
  board.work(board.create({ title: 'Run the tests on every push', x: 0, y: 0 }).id, { state: 'working' });
  board.create({ title: 'Round the total up', x: 0, y: 0 });
  const executed: Command[] = [];
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  const k = new Commander({ board, runtime, cwd: mkdtempSync(join(tmpdir(), 'obeya-live-')), execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = await k.hear(text, {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  const card = executed.find((c) => c.do === 'newCard');
  return { start: card && 'start' in card ? card.start : undefined, confirm: heard.confirm };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'a new task starts at once unless the owner says it should wait',
  async () => {
    const runs = NEW_TASKS.flatMap((c) => [c, c, c]);
    const results = await Promise.all(runs.map(async ([text, language, want]) => ({ text, want, got: await newTask(text, language) })));
    const wrong = results.filter((r) => r.got.start !== r.want);
    for (const r of results) console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got.start === undefined ? 'no new card' : r.got.start ? 'starts' : 'planned'} · ${r.got.confirm}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);

/** What the owner says with no card open, whether typed, and the actions expected (none: a reply or a look-up). */
const NO_CARD: [string, boolean, Command['do'][]][] = [
  ['Nochmal zu den nicht erlaubten Datenbankabfragen: das Skript steht in der eingecheckten Datei, reicht aber nicht. Was meinst du, was wir da jetzt machen sollen?', false, ['newIdea']],
  ['Wie sollten wir das Onboarding angehen?', true, ['newIdea']],
  ['Was hältst du davon, die Exporte nachts laufen zu lassen?', false, ['newIdea']],
  ['Was steht im Plan zu den Exporten?', true, []],
  ['Was ist seit gestern passiert?', false, []],
];

/** What the Koordinator makes of one sentence with no card open. */
async function noCard(text: string, typed: boolean) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => []);
  board.work(board.create({ title: 'Export als CSV', x: 0, y: 0 }).id, { state: 'live' });
  board.work(board.create({ title: 'Login', x: 0, y: 0 }).id, { state: 'working' });
  board.create({ title: 'Zählerstände nachtragen', x: 0, y: 0 });
  const executed: Command[] = [];
  const runtime = withAgentSetting(sdkRuntime, () => AGENT_DEFAULTS.koordinator);
  const k = new Commander({ board, runtime, cwd: mkdtempSync(join(tmpdir(), 'obeya-live-')), execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = await k.hear(text, {}, [], typed ? { typed: true } : {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), executed, confirm: heard.confirm };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'with no card open, a question for an opinion becomes an idea and a question of fact stays in the conversation',
  async () => {
    const results = await Promise.all(NO_CARD.map(async ([text, typed, want]) => ({ text, want, got: await noCard(text, typed) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(r.want));
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} „${r.text}“ → ${r.got.did.join(', ') || 'reply or look-up'} · ${JSON.stringify(r.got.executed.map((c) => ('title' in c ? `${c.title}: ${'body' in c ? c.body : ''}` : '')))} · ${r.got.confirm}`);
    expect(wrong.map((r) => r.text)).toEqual([]);
  },
  300_000,
);
