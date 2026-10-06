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
  const { shown, pending } = talkTurns([owner, read, thought, decided, reply, err, restart, again, reading]);
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

test('a note the worker did not reply to is answered by the first words it says after it', () => {
  const read = ev('activity', 'worker', 'Liest server/export.ts');
  const note = ev('hint', 'owner', 'Bitte auch Excel.');
  const edit = ev('activity', 'worker', 'Ändert server/export.ts');
  const ok = ev('say', 'worker', 'Verstanden, ich baue Excel ein.');
  const later = ev('say', 'worker', 'Excel ist drin, die Tests laufen.');
  const review = ev('review', 'worker', 'CSV und Excel.');
  expect(talkTurns([read, note, edit, ok, later], {}).shown).toEqual([
    { e: note, steps: [] },
    { e: ok, steps: [read, edit] },
  ]);
  expect(talkTurns([read, note, edit, ok, later, review]).shown.at(-1)).toEqual({ e: review, steps: [later] });
  // words from before anything was said to the worker are no reply
  expect(talkTurns([ev('say', 'worker', 'Ich lese mich ein.'), read]).shown).toEqual([]);
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

test('a conversation nobody works on ends with its last message or line, the steps without a message where they happened', () => {
  const review = ev('review', 'worker', 'Gesprächsverlauf steht.');
  const approved = ev('state', 'owner', 'Freigegeben und auf main.');
  const landed = ev('state', 'obeya', 'Nach der Freigabe auf main gelandet.');
  const restart = ev('state', 'obeya', 'Neustart von Obeya angekündigt; der Agent pausiert beim nächsten sicheren Punkt.');
  const err = ev('error', 'obeya', 'API Error: 529 Overloaded');
  const events = [review, approved, landed, restart, err];
  // while the agent works, its steps wait for its next message
  expect(talkTurns(events).pending).toEqual([restart]);
  // once it is over, what only Obeya noted goes
  expect(talkTurns(events, { over: true })).toEqual({
    shown: [
      { e: review, steps: [] },
      { e: approved, steps: [], line: true },
      { e: landed, steps: [], line: true },
      { e: err, steps: [], line: true },
    ],
    pending: [],
  });
  // the agent's last words in a turn without a message are its message, before the line that came later
  const read = ev('activity', 'worker', 'Liest docs/design.md');
  const done = ev('say', 'worker', 'Die Änderung ist auf main. Es ist nichts mehr offen.');
  const retro = ev('state', 'koordinator', 'Arbeitsrückschau, Reibung notiert.');
  expect(talkTurns([review, approved, landed, restart, read, done, retro], { over: true }).shown.slice(3)).toEqual([
    { e: done, steps: [restart, read] },
    { e: retro, steps: [], line: true },
  ]);
  // a turn the agent ended without words stands as its steps
  const edit = ev('activity', 'worker', 'Ändert server/export.ts');
  expect(talkTurns([review, restart, edit, err], { over: true }).shown).toEqual([
    { e: review, steps: [] },
    { e: edit, steps: [restart, edit], quiet: true },
    { e: err, steps: [], line: true },
  ]);
  // the steps that led to the question the card waits on stay with it
  const q = ev('question', 'worker', 'Auch PDF?');
  const asked = talkTurns([read, q, restart], { asking: { text: 'Auch PDF?', options: [] }, over: true });
  expect(asked.asked).toEqual({ e: q, steps: [read] });
  expect(asked.pending).toEqual([restart]);
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
