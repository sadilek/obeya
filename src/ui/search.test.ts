import { expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { findCards, recentCards } from './search';

const card = (title: string, more: Partial<Item> = {}) => ({ id: title, kind: 'task', state: 'done', title, body: '', x: 0, y: 0, source: 'manual', ...more }) as Item;
const titles = (q: string, cards: Item[]) => findCards(q, cards).map((h) => h.item.title);

test('a search finds cards holding every word, in any case and without accents', () => {
  const cards = [card('Über den Klon warten'), card('Voice recognition with Whisper'), card('Phone remote control')];
  expect(titles('whisp', cards)).toEqual(['Voice recognition with Whisper']);
  expect(titles('uber KLON', cards)).toEqual(['Über den Klon warten']);
  expect(titles('klon whisper', cards)).toEqual([]);
  expect(titles('  ', cards)).toEqual([]);
});

test('cards with every word in the title come before those that hold them in their text', () => {
  const cards = [
    card('Gift cards', { body: 'Redeem the code at the checkout.' }),
    card('Order mail', { summary: 'The invoice goes along as a PDF.' }),
    card('Checkout page shows shipping costs'),
  ];
  expect(titles('checkout', cards)).toEqual(['Checkout page shows shipping costs', 'Gift cards']);
  expect(titles('invoice', cards)).toEqual(['Order mail']);
});

test('words split between title and text find the card, after the title matches', () => {
  const cards = [card('Voice', { body: 'Parakeet through uv is the default.' }), card('Voice and Parakeet')];
  expect(titles('voice parakeet', cards)).toEqual(['Voice and Parakeet', 'Voice']);
});

test('before the first word, every card on the canvas is listed, the one changed last first', () => {
  const cards = [
    card('Old', { changedAt: '2026-10-01T08:00:00.000Z' }),
    card('Newest', { changedAt: '2026-10-31T17:00:00.000Z' }),
    card('Never changed'),
    card('', { body: '' }),
    card('Middle', { changedAt: '2026-10-15T12:00:00.000Z' }),
  ];
  expect(recentCards(cards).map((h) => h.item.title)).toEqual(['Newest', 'Middle', 'Old', 'Never changed']);
});
