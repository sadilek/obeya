import { expect, test } from 'bun:test';
import { canvasPath, cardPath, named, queryWithout, readAddress } from './address';

const at = (url: string) => new URL(url, 'http://obeya');

test('the path names the canvas and the card open on it', () => {
  expect(readAddress(at('/c/shop'))).toEqual({ canvas: 'shop' });
  expect(readAddress(at('/c/shop/'))).toEqual({ canvas: 'shop' });
  expect(readAddress(at('/c/shop/card/a1b2c3?view=phone&talk'))).toEqual({ canvas: 'shop', card: 'a1b2c3' });
  expect(readAddress(at('/c/my%20shop/card/a1b2c3'))).toEqual({ canvas: 'my shop', card: 'a1b2c3' });
  expect(readAddress(at('/'))).toEqual({});
  expect(readAddress(at('/c/shop/project/x'))).toEqual({});
});

test('an address from before paths still names what it named', () => {
  expect(readAddress(at('/?c=shop&card=1234'))).toEqual({ canvas: 'shop', card: '1234' });
  expect(readAddress(at('/?card=1234'))).toEqual({ card: '1234' });
});

test('a card’s address has its short code, else its id', () => {
  expect(canvasPath('my shop')).toBe('/c/my%20shop');
  expect(cardPath('shop', { id: 'a1b2c3d4-0000', short: 'a1b2c3' })).toBe('/c/shop/card/a1b2c3');
  expect(cardPath('shop', { id: 'a1b2c3d4-0000' })).toBe('/c/shop/card/a1b2c3d4-0000');
  expect(cardPath('shop', 'a1b2c3d4-0000')).toBe('/c/shop/card/a1b2c3d4-0000');
});

test('a card is found by its short code or its whole id', () => {
  const items = [
    { id: 'a1b2c3d4-0000', short: 'a1b2c3' },
    { id: 'ffffff00-0000', short: 'ffffff' },
  ];
  expect(named(items, 'ffffff')).toBe(items[1]!);
  expect(named(items, 'FFFFFF')).toBe(items[1]!);
  expect(named(items, 'a1b2c3d4-0000')).toBe(items[0]!);
  expect(named(items, 'a1b2c')).toBeUndefined();
});

test('the query keeps what the path does not say, flags as bare names', () => {
  expect(queryWithout('?c=shop&card=1&view=phone&talk', 'c', 'card')).toBe('?view=phone&talk');
  expect(queryWithout('?c=shop', 'c')).toBe('');
});
