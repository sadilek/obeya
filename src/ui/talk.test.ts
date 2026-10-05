import { expect, test } from 'bun:test';
import { type CardEvent, formatQuestion } from '../core/types';
import { parseQuestion, talkTurns } from './talk';

let id = 0;
const ev = (kind: CardEvent['kind'], author: CardEvent['author'], text: string): CardEvent => ({ id: ++id, cardId: 'c', at: '2026-10-01T10:00:00Z', kind, author, text });

test("an idea's conversation folds the agent's steps under the reply they led to", () => {
  const owner = ev('talk', 'owner', 'Was meinst du?');
  const read = ev('activity', 'explorer', 'Liest server/board.ts');
  const thought = ev('say', 'explorer', 'Das Archiv nimmt keine Projekte auf.');
  const decided = ev('state', 'explorer', 'Entscheidung: Format? → CSV');
  const reply = ev('talk', 'explorer', 'Varianten ergänzt. Zwei offene Fragen, siehe Stand.');
  const err = ev('error', 'obeya', 'kaputt');
  const restart = ev('state', 'obeya', 'Neu gestartet');
  const again = ev('talk', 'owner', 'Und weiter?');
  const reading = ev('activity', 'explorer', 'Liest ui/detail.tsx');
  const { shown, pending } = talkTurns([owner, read, thought, decided, reply, err, restart, again, reading], { working: true });
  expect(shown).toEqual([
    { e: owner, steps: [] },
    { e: reply, steps: [read, thought, decided] },
    { e: err, steps: [], line: true },
    { e: again, steps: [] },
  ]);
  expect(pending).toEqual([restart, reading]);
});

test('a turn without reply does not show its last words twice', () => {
  const thought = ev('say', 'explorer', 'Ich lese nach.');
  const last = ev('say', 'explorer', 'Dann ein Plan-Doc.');
  const reply = ev('talk', 'explorer', 'Dann ein Plan-Doc.');
  expect(talkTurns([thought, last, reply]).shown).toEqual([{ e: reply, steps: [thought] }]);
});

test("a task's conversation: the owner's words, the worker's replies and handover; state changes as lines, the rest folded", () => {
  const started = ev('state', 'obeya', 'Agent gestartet auf obeya/export.');
  const read = ev('activity', 'worker', 'Liest server/export.ts');
  const status = ev('report', 'worker', 'Export steht');
  const note = ev('hint', 'owner', 'Bitte auch Excel.');
  const reply = ev('talk', 'worker', 'Mache ich: Excel kommt dazu.');
  const session = ev('state', 'obeya', 'Neue Sitzung. Frühere Sitzung: abc');
  const edit = ev('activity', 'worker', 'Ändert server/export.ts');
  const review = ev('review', 'worker', 'CSV und Excel exportierbar.');
  const approved = ev('state', 'owner', 'Freigegeben und auf main.');
  const { shown, pending } = talkTurns([started, read, status, note, reply, session, edit, review, approved]);
  expect(shown).toEqual([
    { e: started, steps: [], line: true },
    { e: note, steps: [] },
    { e: reply, steps: [read, status] },
    { e: review, steps: [session, edit] },
    { e: approved, steps: [], line: true },
  ]);
  expect(pending).toEqual([]);
});

test("a note the worker did not reply to is answered by its last words before the owner's next message", () => {
  const note = ev('hint', 'owner', 'Bitte auch Excel.');
  const ok = ev('say', 'worker', 'Verstanden, ich baue Excel ein.');
  const edit = ev('activity', 'worker', 'Ändert server/export.ts');
  const last = ev('say', 'worker', 'Excel ist drin, die Tests laufen.');
  const test1 = ev('activity', 'worker', '$ bun test');
  const next = ev('hint', 'owner', 'Und PDF?');
  const thinking = ev('say', 'worker', 'Prüfe, ob es eine PDF-Bibliothek gibt.');
  const events = [note, ok, edit, last, test1, next, thinking];
  expect(talkTurns(events, { working: true })).toEqual({
    shown: [
      { e: note, steps: [] },
      { e: last, steps: [ok, edit] },
      { e: next, steps: [] },
    ],
    pending: [test1, thinking],
  });
  // once the worker no longer works, its last words are the reply too
  expect(talkTurns(events).shown.at(-1)).toEqual({ e: thinking, steps: [test1] });
  // words from before anything was said to the worker are no reply
  const start = [ev('say', 'worker', 'Ich lese mich ein.'), ev('activity', 'worker', 'Liest README.md')];
  expect(talkTurns(start).shown).toEqual([]);
});

test('a spoken note stands once; the Koordinator confirms in the steps and answers what it looked up in the conversation', () => {
  const said = ev('say', 'owner', 'Sag ihm, er soll auch Excel können.');
  const confirm = ev('say', 'koordinator', 'Geht an den Agenten.');
  const note = ev('hint', 'owner', 'Sag ihm, er soll auch Excel können.');
  const asked = ev('say', 'owner', 'Wie weit ist das?');
  const looking = ev('say', 'koordinator', 'Ich schaue nach.');
  const found = ev('say', 'koordinator', 'Der Export steht, Excel fehlt noch.');
  const reply = ev('talk', 'worker', 'Excel kommt dazu.');
  expect(talkTurns([said, confirm, note, asked, looking, found, reply]).shown).toEqual([
    { e: note, steps: [] },
    { e: asked, steps: [] },
    { e: found, steps: [] },
    { e: reply, steps: [confirm, looking] },
  ]);
});

test('questions carry their answer; a note instead of an answer settles one; the open one stands apart', () => {
  const q1 = ev('question', 'worker', formatQuestion({ text: 'CSV oder Excel?', options: ['CSV', 'Excel'] }));
  const a1 = ev('answer', 'owner', 'CSV');
  const q2 = ev('question', 'worker', 'Welches Trennzeichen?');
  const note = ev('hint', 'owner', 'Nimm, was Excel öffnet.');
  const work = ev('activity', 'worker', 'Ändert server/export.ts');
  const q3 = ev('question', 'worker', formatQuestion({ text: 'Auch PDF?', options: ['Ja', 'Nein'] }));
  const events = [q1, a1, q2, note, work, q3];
  const { shown, asked } = talkTurns(events, { asking: { text: 'Auch PDF?', options: ['Ja', 'Nein'] } });
  expect(shown).toEqual([{ e: q1, steps: [], answer: 'CSV' }, { e: a1, steps: [] }, { e: q2, steps: [], settled: true }, { e: note, steps: [] }]);
  expect(asked).toEqual({ e: q3, steps: [work] });
  // a question answered on the owner's behalf is no longer open, whatever the card says
  expect(talkTurns([...events, ev('answer', 'project', 'Nein')], { asking: { text: 'Auch PDF?', options: [] } }).asked).toBeUndefined();
  // a card from before notes took questions back still waits on its question after a note
  const old = talkTurns([q2, note], { asking: { text: 'Welches Trennzeichen?', options: [] } });
  expect(old.asked).toEqual({ e: q2, steps: [] });
  expect(old.shown).toEqual([{ e: note, steps: [] }]);
});

test('a question reads back from the log with its options', () => {
  expect(parseQuestion(formatQuestion({ text: 'Welche Spalten?', options: ['Datum', 'Stand'], multiple: true }))).toEqual({ text: 'Welche Spalten?', options: ['Datum', 'Stand'] });
  expect(parseQuestion('Weiter so?')).toEqual({ text: 'Weiter so?', options: [] });
});
