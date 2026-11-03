import { beforeEach, expect, test } from 'bun:test';
import { cardNumbersIn, cardTag, numberOfTag } from '../core/card-number';
import { Board } from './board';
import { Store } from './db';

let store: Store;
let board: Board;

beforeEach(() => {
  store = new Store(':memory:');
  board = new Board(store, { id: 'shop', name: 'Shop', repos: [{ id: 'home', name: 'Home', path: '/r', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
});

test('a text names cards by their numbers as typed or as speech recognition writes them', () => {
  expect(cardNumbersIn('archive K7 and k 12, then Ka 3; K7 again')).toEqual([7, 12, 3]);
  expect(cardNumbersIn('5k users, OK42, KK1, #42')).toEqual([]);
  expect([numberOfTag('K42'), numberOfTag(' k-42 '), numberOfTag('42'), numberOfTag('K'), numberOfTag('W2')]).toEqual([42, 42, 42, undefined, undefined]);
  expect(cardTag(42)).toBe('K42');
});

test("the card a number names is found wherever it is: on the canvas, archived, on another canvas, deleted", () => {
  const here = board.create({ title: 'Export orders', x: 0, y: 0 });
  const archived = board.create({ title: 'Old banner', x: 0, y: 200 });
  store.update(archived.id, { state: 'live' });
  board.archive([archived.id]);
  store.ensureCanvas('site', 'Website');
  const [there] = store.insert([{ canvas_id: 'site', kind: 'task', title: 'New footer', x: 0, y: 0 }]);
  const gone = board.create({ title: 'Typo', x: 0, y: 400 });
  board.remove(gone.id);

  expect(board.numbered(here.number)!.item!.id).toBe(here.id);
  expect(board.numbered(archived.number)!.item!.archivedAt).toBeDefined();
  expect(board.numbered(there!.number)).toMatchObject({ row: { id: there!.id }, canvasName: 'Website' });
  expect(board.numbered(there!.number)!.item).toBeUndefined();
  expect(board.numbered(gone.number)!.row.deleted_at).not.toBeNull();
  expect(board.numbered(999)).toBeUndefined();
  expect(board.tagOf(there!.id)).toBe(cardTag(there!.number));
});

test("an agent reading the owner's words hears which card each number in them names", () => {
  const own = board.create({ title: 'Export orders', x: 0, y: 0 });
  const other = board.create({ title: 'Old banner', x: 0, y: 200 });
  store.update(other.id, { state: 'live' });
  board.archive([other.id]);
  store.ensureCanvas('site', 'Website');
  const [there] = store.insert([{ canvas_id: 'site', kind: 'task', title: 'New footer', x: 0, y: 0 }]);

  const note = board.numbersNote(`Do it as in ${cardTag(other.number)}, not like ${cardTag(there!.number)}; this is ${cardTag(own.number)}, and K999 is none.`, own.id);
  expect(note).toBe(
    `\n\n(Card numbers in these words: ${cardTag(other.number)} is the card “Old banner”, archived. ${cardTag(there!.number)} is the card “New footer” (on the canvas “Website”). ${cardTag(own.number)} is the card “Export orders” (your own card), planned.)`,
  );
  expect(board.numbersNote('Nothing numbered here.')).toBe('');
});
