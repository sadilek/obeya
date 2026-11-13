import { afterEach, describe, expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { asideMark, changeAside, forgotten, loadAside, staysAside } from './setAside';
import { memoryStorage, testItem } from './testing';

const card = (over: Partial<Item>) => testItem({ id: 'a', title: 'A', state: 'working', ...over });

describe('staysAside', () => {
  test('a card set aside while it waits stays aside while it still waits the same wait', () => {
    const waits = card({ state: 'waiting', waitingSince: '2026-11-06T10:00:00Z' });
    const aside = { a: asideMark(waits, 'shop') };
    expect(staysAside(aside, waits)).toBe(true);
  });
  test('it stays aside while it runs after the owner went on at the desk, and comes back with its next wait', () => {
    const aside = { a: { canvas: 'shop', since: '2026-11-06T10:00:00Z' } };
    expect(staysAside(aside, card({ state: 'working' }))).toBe(true);
    expect(staysAside(aside, card({ state: 'waiting', waitingSince: '2026-11-06T11:00:00Z' }))).toBe(false);
  });
  test('a card set aside while it runs comes back once it needs the owner', () => {
    const runs = card({ state: 'working' });
    const aside = { a: asideMark(runs, 'shop') };
    expect(aside.a.since).toBeNull();
    expect(staysAside(aside, runs)).toBe(true);
    expect(staysAside(aside, card({ state: 'waiting', waitingSince: '2026-11-06T11:00:00Z' }))).toBe(false);
  });
  test('a card never set aside is not', () => {
    expect(staysAside({}, card({}))).toBe(false);
  });
});

describe('forgotten', () => {
  const aside = { a: { canvas: 'shop', since: null }, b: { canvas: 'web', since: null } };
  test('a card stays noted while its canvas is not held, stopped or not loaded yet', () => {
    expect(forgotten(aside, { shop: [card({ id: 'a' })] })).toEqual([]);
  });
  test('a card gone from its canvas, or back by itself, is forgotten', () => {
    expect(forgotten(aside, { shop: [], web: [card({ id: 'b', state: 'waiting', waitingSince: '2026-11-06T11:00:00Z' })] })).toEqual(['a', 'b']);
  });
});

describe('changeAside', () => {
  globalThis.localStorage ??= memoryStorage();
  afterEach(() => localStorage.removeItem('obeya-phone-aside'));
  test('changes what the browser keeps, so that a change from another tab stays', () => {
    const tab1 = changeAside((a) => ({ ...a, x: { canvas: 'shop', since: null } }));
    expect(Object.keys(tab1)).toEqual(['x']);
    // a second tab that loaded before the first set x aside
    changeAside((a) => ({ ...a, y: { canvas: 'shop', since: null } }));
    expect(Object.keys(loadAside()).sort()).toEqual(['x', 'y']);
  });
});
