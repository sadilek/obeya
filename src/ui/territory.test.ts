import { describe, expect, test } from 'bun:test';
import { type Claim, Territories, within } from './territory';

const card = (id: string, x: number, y: number, w: Record<string, number> = {}): Claim => ({ id, b: { x, y, w: 300, h: 140 }, w });
const mid = (c: Claim) => ({ x: c.b.x + c.b.w / 2, y: c.b.y + c.b.h / 2 });

describe('territories', () => {
  test("cover their group's cards, linked when near, and leave strangers out", () => {
    const a1 = card('a1', 0, 0, { A: 1 });
    const a2 = card('a2', 360, 0, { A: 1 });
    const far = card('a3', 2000, 0, { A: 1 });
    const stranger = card('s', 180, 220);
    const [t] = new Territories().compute([a1, a2, far, stranger], ['A']);
    expect(t!.group).toBe('A');
    for (const c of [a1, a2, far]) expect(within(t!, mid(c))).toBe(true);
    // the two near cards share a piece, the far one has its own
    expect(within(t!, { x: 330, y: 70 })).toBe(true);
    expect(within(t!, { x: 1000, y: 70 })).toBe(false);
    expect(t!.pieces).toHaveLength(2);
    expect(within(t!, mid(stranger))).toBe(false);
    expect(t!.main.startsWith('M')).toBe(true);
    expect(t!.label).toBeDefined();
  });

  test('exclude each other: a card amid another group is an island in its own colour', () => {
    const as = [card('a1', 0, 0, { A: 1 }), card('a2', 360, 0, { A: 1 }), card('a3', 720, 0, { A: 1 })];
    const island = card('b', 360, 0, { B: 1 });
    as[1] = card('a2', 0, 220, { A: 1 });
    const claims = [...as, card('a4', 720, 220, { A: 1 }), island];
    const [a, b] = new Territories().compute(claims, ['A', 'B']);
    expect(within(b!, mid(island))).toBe(true);
    expect(within(a!, mid(island))).toBe(false);
    for (const c of claims.filter((c) => c.w.A)) expect(within(a!, mid(c))).toBe(true);
  });

  test('a card fading out of a group shrinks its territory; none is left without members', () => {
    const t = new Territories();
    const lone = card('a', 0, 0, { A: 1 });
    expect(t.compute([lone], ['A', 'B'])).toHaveLength(1);
    const [half] = t.compute([{ ...lone, w: { A: 0.5 } }], ['A']);
    expect(within(half!, { x: -50, y: 70 })).toBe(false);
    expect(within(t.compute([lone], ['A'])[0]!, { x: -50, y: 70 })).toBe(true);
    expect(t.compute([{ ...lone, w: {} }], ['A'])).toEqual([]);
  });

  test('only what changed is computed again', () => {
    const t = new Territories();
    const claims = [card('a1', 0, 0, { A: 1 }), card('a2', 360, 0, { A: 1 }), card('b1', 3000, 0, { B: 1 }), card('b2', 3360, 0, { B: 1 })];
    const first = t.compute(claims, ['A', 'B']);
    expect(t.last).toMatchObject({ fields: 2, contours: 2 });
    expect(t.compute(claims, ['A', 'B'])).toEqual(first);
    expect(t.last).toMatchObject({ fields: 0, contours: 0 });
    // moving a card of B leaves A as it was
    claims[3] = card('b2', 3360, 60, { B: 1 });
    const second = t.compute(claims, ['A', 'B']);
    expect(t.last).toMatchObject({ fields: 1, contours: 1 });
    expect(second[0]).toBe(first[0]!);
  });
});
