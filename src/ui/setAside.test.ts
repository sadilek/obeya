import { describe, expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { asideMark, staysAside } from './setAside';

const card = (over: Partial<Item>): Item => ({ id: 'a', kind: 'task', title: 'A', state: 'working', ...over }) as Item;

describe('staysAside', () => {
  test('a card set aside while it waits stays aside while it still waits the same wait', () => {
    const waits = card({ state: 'waiting', waitingSince: '2026-11-06T10:00:00Z' });
    const aside = { a: asideMark(waits) };
    expect(staysAside(aside, waits)).toBe(true);
  });
  test('it stays aside while it runs after the owner went on at the desk, and comes back with its next wait', () => {
    const aside = { a: '2026-11-06T10:00:00Z' };
    expect(staysAside(aside, card({ state: 'working' }))).toBe(true);
    expect(staysAside(aside, card({ state: 'waiting', waitingSince: '2026-11-06T11:00:00Z' }))).toBe(false);
  });
  test('a card set aside while it runs comes back once it needs the owner', () => {
    const runs = card({ state: 'working' });
    const aside = { a: asideMark(runs) };
    expect(aside.a).toBeNull();
    expect(staysAside(aside, runs)).toBe(true);
    expect(staysAside(aside, card({ state: 'waiting', waitingSince: '2026-11-06T11:00:00Z' }))).toBe(false);
  });
  test('a card never set aside is not', () => {
    expect(staysAside({}, card({}))).toBe(false);
  });
});
