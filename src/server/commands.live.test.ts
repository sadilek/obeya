// The Koordinator's prompt against the real model: sentences said or typed with a card open, in
// each state an agent is on. Runs only with OBEYA_LIVE=1 (it uses the machine's Claude login and
// takes about a minute): `OBEYA_LIVE=1 bun test src/server/commands.live.test.ts`.

import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from './board';
import { type Command, Commander } from './commands';
import { Store } from './db';
import { sdkRuntime } from './runtime';

const DEMO = JSON.stringify({ dir: '/d', chapters: [], shown: [], notShown: [], findings: ['Das Datum im Dateinamen ist amerikanisch formatiert.'], question: 'Alte Projekte nachtragen?' });
const STATES: Record<string, Record<string, string>> = {
  working: { state: 'working' },
  question: { state: 'waiting', need: 'question', detail: JSON.stringify({ question: { text: 'CSV oder Excel?', options: ['CSV', 'Excel'] } }) },
  demo: { state: 'waiting', need: 'demo', demo: DEMO },
  review: { state: 'waiting', need: 'review' },
  inPr: { state: 'inPr' },
  finishing: { state: 'live', workspace: '/w', landed: '{}' },
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
  ['review', 'Die Spaltenüberschriften fehlen noch', true, ['feedback'], false],
  ['review', 'gib das frei', false, ['approve'], false],
  ['inPr', 'Rebase bitte auf main', false, ['note'], true],
  ['inPr', 'Merk dir: in diesem Repo nie force pushen', true, ['remember'], false],
  ['finishing', 'Räum danach den Branch auf', true, ['note'], true],
];

/** What the Koordinator makes of one sentence: the actions as they run, and whether it went out at once. */
async function hear(state: string, text: string, typed: boolean) {
  const board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => []);
  board.create({ title: 'Login', x: 0, y: 0 });
  const card = board.create({ title: 'Export als CSV', x: 0, y: 0 });
  board.work(card.id, STATES[state]!);
  const executed: Command[] = [];
  const k = new Commander({ board, runtime: sdkRuntime, cwd: mkdtempSync(join(tmpdir(), 'obeya-live-')), execute: (c) => void executed.push(c), delayMs: 1 });
  const heard = await k.hear(text, { card: card.id }, [], typed ? { typed: true } : {});
  if (heard.token) k.arm(heard.token);
  await new Promise((r) => setTimeout(r, 20));
  return { did: executed.map((c) => c.do), quiet: !!heard.quiet, executed, confirm: heard.confirm };
}

test.skipIf(!process.env.OBEYA_LIVE)(
  'with a card open, the Koordinator gives the agent what is for it and still knows Obeya’s commands',
  async () => {
    const results = await Promise.all(CASES.map(async ([state, text, typed, want, quiet]) => ({ state, text, typed, want, quiet, got: await hear(state, text, typed) })));
    const wrong = results.filter((r) => JSON.stringify(r.got.did) !== JSON.stringify(r.want) || r.got.quiet !== r.quiet);
    for (const r of results)
      console.log(`${wrong.includes(r) ? '✗' : '✓'} [${r.state}] ${r.typed ? 'getippt' : 'gesprochen'} „${r.text}“ → ${r.got.did.join(', ') || 'reply'}${r.got.quiet ? ' (sofort)' : ''} · ${JSON.stringify(r.got.executed.map((c) => ('text' in c ? c.text : 'title' in c ? c.title : '')))} · ${r.got.confirm}`);
    expect(wrong.map((r) => `[${r.state}] ${r.text}`)).toEqual([]);
  },
  300_000,
);
