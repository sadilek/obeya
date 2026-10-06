// The Koordinator's prompt against the real model: sentences said or typed with a card open, in
// each state an agent is on. Runs only with OBEYA_LIVE=1 (it uses the machine's Claude login and
// takes about a minute): `OBEYA_LIVE=1 bun test src/server/commands.live.test.ts`.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from './board';
import { type Command, Commander } from './commands';
import { Store } from './db';
import { type AgentRuntime, sdkRuntime } from './runtime';

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

/** State of the open card, what the owner says, whether typed, the actions expected, and whether it goes out at once. */
const CASES: [string, string, boolean, Command['do'][], boolean][] = [
  ['working', 'nimm lieber Semikolons als Trenner', false, ['note'], true],
  ['working', 'Kannst du die Spalten auch alphabetisch sortieren?', true, ['note'], true],
  ['working', 'mach eine Folgeaufgabe für den Excel-Export', false, ['newCard'], false],
  ['working', 'Merk dir: Exporte immer mit Kopfzeile', true, ['remember'], false],
  ['working', 'halt den Agenten an', false, ['stop'], false],
  ['working', 'Was ist seit gestern auf der Leinwand passiert?', true, [], false],
  ['question', 'CSV', false, ['answer'], true],
  ['question', 'Excel, aber mit Semikolon als Trenner', true, ['answer'], true],
  ['question', 'mach eine Folgeaufgabe: Import aus CSV', true, ['newCard'], false],
  ['demo', 'ja', false, ['answer'], true],
  ['demo', 'Der Button ist zu klein und die Farbe passt nicht', true, ['feedback'], false],
  ['demo', 'gib frei', false, ['approve'], false],
  ['demo', 'gib frei und mach eine Folgeaufgabe für die Auffälligkeit mit dem Datum', true, ['approve', 'newCard'], false],
  ['demo', 'Merk dir: Demos immer mit Ton', false, ['remember'], false],
  ['demo', 'Wenn ein Projekt noch keine Zählerstände hat, ist sichergestellt, dass trotzdem eine Datei mit Kopfzeile rauskommt?', true, ['feedback'], false],
  ['review', 'Was passiert beim Export mit Umlauten im Dateinamen?', false, ['feedback'], false],
  ['review', 'Die Spaltenüberschriften fehlen noch', true, ['feedback'], false],
  ['review', 'gib das frei', false, ['approve'], false],
  ['inPr', 'Rebase bitte auf main', false, ['note'], true],
  ['inPr', 'Merk dir: in diesem Repo nie force pushen', true, ['remember'], false],
  ['finishing', 'Räum danach den Branch auf', true, ['note'], true],
  ['working', 'pack das in die Gruppe Abrechnung', false, ['group'], false],
  ['review', 'Export und Login gehören zur Gruppe Konto', true, ['group'], false],
  ['working', 'Wie gehst du mit leeren Zeilen um?', false, ['note'], true],
  ['planned', 'Was würde der Agent hier machen, wenn ich starte?', false, [], false],
  ['queued', 'nimm das aus der Warteschlange', false, ['dequeue'], false],
  ['queued', 'Das soll doch noch nicht starten, lass es erst mal liegen', true, ['dequeue'], false],
  ['queued', 'starte das trotzdem', false, ['force'], false],
  ['proposal', 'Nimm den Excel-Export gleich mit dazu, und die Kodierung ist UTF-8', false, ['revise'], false],
  ['proposal', 'Ich glaube, das Problem liegt eher beim Import, der Export ist in Ordnung', true, ['revise'], false],
  ['proposal', 'übernimm das', false, ['accept'], false],
  ['proposal', 'das brauchen wir nicht, weg damit', false, ['dismiss'], false],
];

/** What the Koordinator makes of one sentence: the actions as they run, and whether it went out at once. */
async function hear(state: string, text: string, typed: boolean) {
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
  const heard = await k.hear(text, { card: card.id }, [], typed ? { typed: true } : {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), quiet: !!heard.quiet, executed, confirm: heard.confirm, said };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'with a card open, the Koordinator gives the agent what is for it and still knows Obeya’s commands',
  async () => {
    const results = await Promise.all(CASES.map(async ([state, text, typed, want, quiet]) => ({ state, text, typed, want, quiet, got: await hear(state, text, typed) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(r.want) || r.got.quiet !== r.quiet);
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} [${r.state}] ${r.typed ? 'getippt' : 'gesprochen'} „${r.text}“ → ${r.got.did.join(', ') || 'reply'}${r.got.quiet ? ' (sofort)' : ''} · ${JSON.stringify(r.got.executed.map((c) => ('text' in c ? c.text : 'title' in c ? c.title : 'name' in c ? c.name : '')))} · ${r.got.confirm}${r.got.confirm !== 'Das habe ich nicht verstanden.' ? '' : ` · Sitzung: ${r.got.said.join(' ').slice(0, 200)}`}`);
    expect(wrong.map((r) => `[${r.state}] ${r.text}`)).toEqual([]);
  },
  300_000,
);
