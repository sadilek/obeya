import { expect, test } from 'bun:test';
import type { CardEvent } from '../core/types';
import { talkTurns } from './talk';

let id = 0;
const ev = (kind: CardEvent['kind'], author: CardEvent['author'], text: string): CardEvent => ({ id: ++id, cardId: 'c', at: '2026-10-01T10:00:00Z', kind, author, text });

test("an idea's conversation folds the agent's steps under the reply they led to", () => {
  const owner = ev('talk', 'owner', 'Was meinst du?');
  const read = ev('activity', 'explorer', 'Liest server/board.ts');
  const thought = ev('say', 'explorer', 'Das Archiv nimmt keine Projekte auf.');
  const decided = ev('state', 'explorer', 'Entscheidung: Format? → CSV');
  const reply = ev('talk', 'explorer', 'Varianten ergänzt. Zwei offene Fragen, siehe Stand.');
  const err = ev('error', 'obeya', 'kaputt');
  const koordinator = ev('say', 'koordinator', 'Notiert.');
  const restart = ev('state', 'obeya', 'Neu gestartet');
  const again = ev('talk', 'owner', 'Und weiter?');
  const reading = ev('activity', 'explorer', 'Liest ui/detail.tsx');
  const { shown, pending } = talkTurns([owner, read, thought, decided, reply, err, koordinator, restart, again, reading]);
  expect(shown).toEqual([
    { e: owner, steps: [] },
    { e: reply, steps: [read, thought, decided] },
    { e: err, steps: [] },
    { e: again, steps: [] },
  ]);
  expect(pending).toEqual([reading]);
});

test('a turn without reply does not show its last words twice', () => {
  const thought = ev('say', 'explorer', 'Ich lese nach.');
  const last = ev('say', 'explorer', 'Dann ein Plan-Doc.');
  const reply = ev('talk', 'explorer', 'Dann ein Plan-Doc.');
  expect(talkTurns([thought, last, reply]).shown).toEqual([{ e: reply, steps: [thought] }]);
});
