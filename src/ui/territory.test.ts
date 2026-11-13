import { describe, expect, test } from 'bun:test';
import type { Group, Item } from '../core/types';
import { inside, placeAll, titleStrips } from './groups';
import { type Claim, type NameSpot, placeName, Territories, type Territory } from './territory';

const card = (id: string, x: number, y: number, w: Record<string, number> = {}): Claim => ({ id, b: { x, y, w: 300, h: 140 }, w });
const mid = (c: Claim) => ({ x: c.b.x + c.b.w / 2, y: c.b.y + c.b.h / 2 });
/** Whether `p` lies in the territory (even-odd over all its rings). */
const within = (t: Territory, p: { x: number; y: number }) => t.pieces.flat().filter((ring) => inside(p, ring.map(([x, y]) => ({ x, y })))).length % 2 === 1;

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
    expect(t!.outline).toBe(t!.pieces[0]![0]!);
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

  test('run straight past the gap between cards side by side, round at the corners', () => {
    const [t] = new Territories().compute([card('a1', 0, 0, { A: 1 }), card('a2', 330, 0, { A: 1 })], ['A']);
    // the territory's top edge above x
    const top = (x: number) => {
      let y = -150;
      while (!within(t!, { x, y })) y++;
      return y;
    };
    const overCard = top(150);
    expect(Math.abs(top(315) - overCard)).toBeLessThanOrEqual(1);
    expect(Math.abs(top(480) - overCard)).toBeLessThanOrEqual(1);
    // the corner is a curve that the edge leaves evenly on both sides: as far in from the left as from the top
    const left = (y: number) => {
      let x = -150;
      while (!within(t!, { x, y })) x++;
      return x;
    };
    const side = left(70);
    expect(Math.abs(top(-20) - overCard - (left(-20) - side))).toBeLessThanOrEqual(2);
  });
});

describe('beside a stranger', () => {
  // how far down (or up, with dir -1) from y the territory reaches above x
  const edge = (t: Parameters<typeof within>[0], x: number, y: number, dir: 1 | -1) => {
    while (within(t, { x, y: y + dir })) y += dir;
    return y;
  };

  test('a stranger below closes the territory with a round corner, not a tip beside it', () => {
    const below = card('s', 0, 170);
    const [t] = new Territories().compute([card('a1', 0, 0, { A: 1 }), card('a2', 330, 0, { A: 1 }), card('a3', 660, 0, { A: 1 }), below], ['A']);
    // the edge runs along the middle of the gap, beside the stranger too
    const gap = (140 + 170) / 2;
    expect(Math.abs(edge(t!, 150, 70, 1) - gap)).toBeLessThanOrEqual(6);
    expect(edge(t!, -10, 70, 1)).toBeLessThanOrEqual(gap);
    expect(within(t!, { x: -20, y: below.b.y + 5 })).toBe(false);
    // and turns round: the left side is where it is elsewhere, the corner in between
    const left = (y: number) => {
      let x = 150;
      while (within(t!, { x: x - 1, y })) x--;
      return x;
    };
    expect(left(70)).toBeLessThan(-50);
    expect(left(gap - 5)).toBeGreaterThan(left(70) + 10);
  });

  test('a stranger above and beside: no tip runs up past it', () => {
    const above = card('s', 0, 0);
    const [t] = new Territories().compute([above, card('a1', 0, 170, { A: 1 }), card('a2', 330, 170, { A: 1 }), card('a3', 330, 0, { A: 1 })], ['A']);
    const gap = (140 + 170) / 2;
    expect(edge(t!, -10, 240, -1)).toBeGreaterThanOrEqual(gap);
    expect(within(t!, { x: -20, y: above.b.y + above.b.h - 5 })).toBe(false);
    // beside it, a3's left side runs along the middle of that gap up to its top
    expect(within(t!, { x: 310, y: -20 })).toBe(false);
    expect(within(t!, { x: 320, y: 20 })).toBe(true);
  });
});

describe('group names', () => {
  /** A name's capitals, `font` world px high. */
  const size = (name: string, font: number) => ({ w: name.length * 0.75 * font, h: 0.72 * font });
  const boxes = (cs: Claim[]) => cs.map((c) => c.b);
  const middle = (s: NameSpot) => ({ x: s.box.x + s.box.w / 2, y: s.box.y + s.box.h / 2 });
  const over = (s: NameSpot, cs: Claim[]) => cs.filter((c) => s.box.x < c.b.x + c.b.w && c.b.x < s.box.x + s.box.w && s.box.y < c.b.y + c.b.h && c.b.y < s.box.y + s.box.h);

  test('stand on the top edge of the largest piece, centred, the same for one card and for many', () => {
    const lone = card('a', 0, 0, { A: 1 });
    const [one] = new Territories().compute([lone], ['A']);
    const spot = placeName(one!.outline!, size('Search', 20), [lone.b]);
    expect(spot.side).toBe('top');
    expect(middle(spot).x).toBeCloseTo(mid(lone).x, 0);
    expect(spot.box.y + spot.box.h).toBeLessThan(lone.b.y);
    const row = [card('b1', 0, 0, { B: 1 }), card('b2', 360, 100, { B: 1 }), card('b3', 720, 0, { B: 1 })];
    const [many] = new Territories().compute(row, ['B']);
    const header = placeName(many!.outline!, size('Search', 20), boxes(row));
    expect(middle(header).x).toBeCloseTo(510, -1);
    // the edge it stands on is the one right below it, over the lower card in the middle
    expect(header.box.y + header.box.h).toBeLessThan(100);
    expect(over(header, row)).toEqual([]);
  });

  test('slide along the top edge to the free spot nearest the middle, out from under a card', () => {
    const row = [card('a1', 0, 200, { A: 1 }), card('a2', 320, 200, { A: 1 }), card('a3', 640, 200, { A: 1 })];
    // a stranger right above the middle of the row, a little apart from it
    const above = card('s', 320, 200 - 136 - 50);
    const claims = [...row, above];
    const [t] = new Territories().compute(claims, ['A']);
    const spot = placeName(t!.outline!, size('Search', 20), boxes(claims));
    expect(spot.side).toBe('top');
    expect(over(spot, claims)).toEqual([]);
    expect(Math.abs(middle(spot).x - 470)).toBeLessThan(260);
  });

  // the maintainer's case: a 3 × 3 grid, blue on the first row's left two, orange on the second
  // row's right two, green on the middle of the third, zoomed far out
  const grid = () => {
    const at = (col: number, row: number, g?: string) => card(`${col}${row}`, col * 320, row * 156, g ? { [g]: 1 } : {});
    const groups: Record<string, string> = { '00': 'blue', '10': 'blue', '11': 'orange', '21': 'orange', '12': 'green' };
    return [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => at(col, row, groups[`${col}${row}`])));
  };

  test("in a grid: a name goes below or beside its group when the row above covers the top edge", () => {
    const claims = grid();
    const ts = new Territories().compute(claims, ['blue', 'orange', 'green']);
    const font = 40 / 0.55;
    const spots = Object.fromEntries(ts.map((t) => [t.group, placeName(t.outline!, size(t.group, font), boxes(claims))]));
    expect(spots.blue!.side).toBe('top');
    expect(spots.green!.side).toBe('bottom');
    expect(spots.orange!.side).toBe('right');
    for (const s of Object.values(spots)) expect(over(s, claims)).toEqual([]);
    // closer in (13 px on screen at zoom 0.8), a small name finds the same spots
    const near = Object.fromEntries(ts.map((t) => [t.group, placeName(t.outline!, size(t.group, 13 / 0.8), boxes(claims))]));
    expect(near.green!.side).toBe('bottom');
    expect(near.orange!.side).toBe('right');
    // at 1, it fits in the gap between the rows, above its own edge
    for (const t of ts) expect(over(placeName(t.outline!, size(t.group, 13), boxes(claims)), claims)).toEqual([]);
  });

  test('surrounded on all sides: inside over the cards below their titles far out; closer in, on the top edge under the cards', () => {
    const claims = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => card(`${col}${row}`, col * 320, row * 156, col === 1 && row === 1 ? { A: 1 } : {})));
    const [t] = new Territories().compute(claims, ['A']);
    const strips = claims.map((c) => ({ ...c.b, h: 50 }));
    const font = 40 / 0.55;
    const spot = placeName(t!.outline!, size('Search', font), boxes(claims), { strips });
    expect(spot.side).toBe('inside');
    expect(spot.box.y).toBeGreaterThanOrEqual(156 + 50);
    expect(spot.box.y + spot.box.h).toBeLessThanOrEqual(156 + 136);
    const covered = placeName(t!.outline!, size('Search', 13 / 0.8), boxes(claims));
    expect(covered).toMatchObject({ side: 'top', covered: true });
    expect(middle(covered).x).toBeCloseTo(470, -1);
  });

  test('a card dragged to and fro over the name does not make it flicker from side to side, and once it is gone the name returns', () => {
    const row = [card('a1', 0, 200, { A: 1 }), card('a2', 320, 200, { A: 1 }), card('a3', 640, 200, { A: 1 })];
    const [t] = new Territories().compute(row, ['A']);
    const name = size('Search', 20);
    const free = placeName(t!.outline!, name, boxes(row));
    // the stranger wobbles a pixel or two around the middle of the top edge, just above it
    let prev: NameSpot | undefined;
    const sides = new Set<number>();
    for (const dx of [0, 1, -1, 2, -2, 1, 0, -1]) {
      const stranger = { x: 470 - 150 + dx, y: free.box.y - 100, w: 300, h: 136 + 40 };
      prev = placeName(t!.outline!, name, [...boxes(row), stranger], { prev });
      expect(prev.side).toBe('top');
      sides.add(Math.sign(middle(prev).x - 470));
    }
    expect(sides.size).toBe(1);
    // the stranger leaves: the name slides back to the middle
    prev = placeName(t!.outline!, name, boxes(row), { prev });
    expect(middle(prev).x).toBeCloseTo(470, 0);
  });

  test('a spot at the border of a card is kept while it is still free', () => {
    const lone = card('a', 0, 200, { A: 1 });
    const [t] = new Territories().compute([lone], ['A']);
    const name = size('Search', 20);
    const free = placeName(t!.outline!, name, [lone.b]);
    // a card that ends right at the name's left edge: too close for a new spot, not for the one taken
    const beside = { x: free.box.x - 300, y: free.box.y - 10, w: 300, h: 30 };
    const fresh = placeName(t!.outline!, name, [lone.b, beside]);
    expect(fresh.box).not.toEqual(free.box);
    expect(placeName(t!.outline!, name, [lone.b, beside], { prev: free }).box).toEqual(free.box);
  });
});

describe('group names together', () => {
  const group = (id: string): Group => ({ id, name: id, hue: 200 }) as Group;
  const shapesOf = (claims: Claim[], ids: string[]) => new Territories().compute(claims, ids).map((t) => ({ g: group(t.group), t }));
  const crossing = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const mid = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

  test("a name does not stand in another group's territory where a spot clear of it is free", () => {
    // B's card stands up and to the left of A's, so the free spot just above A lies in B's territory
    const a = card('a', 0, 0, { A: 1 });
    const b = card('b', -100, -176, { B: 1 });
    const shapes = shapesOf([a, b], ['A', 'B']);
    const spots = placeAll({ shapes, cards: [a.b, b.b], strips: [] }, 'near', 0);
    const box = spots.get('A')!.box;
    const tb = shapes.find((s) => s.g.id === 'B')!.t;
    expect(within(tb, mid(box))).toBe(false);
    expect(within(tb, { x: box.x, y: box.y })).toBe(false);
    expect(within(tb, { x: box.x + box.w, y: box.y + box.h })).toBe(false);
  });

  test('names of groups side by side do not run into each other', () => {
    const left = card('l', 0, 0, { Left: 1 });
    const right = card('r', 330, 0, { Right: 1 });
    const shapes = shapesOf([left, right], ['Left', 'Right']).map((s) => ({ ...s, g: { ...s.g, name: 'Billing and invoices' } }));
    // far out, each name is far wider than its card
    const spots = placeAll({ shapes, cards: [left.b, right.b], strips: [] }, 'far', Math.floor(Math.log(0.55) / Math.log(1.06)));
    const [p, q] = [spots.get('Left')!, spots.get('Right')!];
    expect(crossing(p.box, q.box)).toBe(false);
  });

  test("far out, the last resort stays off the card in a ring group's middle, which is another group's", () => {
    // B's cards make a ring around A's card in the middle of a 5 × 5 grid of strangers
    const claims = [0, 1, 2, 3, 4].flatMap((row) =>
      [0, 1, 2, 3, 4].map((col) => {
        const ring = Math.max(Math.abs(col - 2), Math.abs(row - 2)) === 1;
        return card(`${col}${row}`, col * 320, row * 156, col === 2 && row === 2 ? { A: 1 } : ring ? { B: 1 } : {});
      }),
    );
    const shapes = shapesOf(claims, ['B', 'A']);
    const strips = claims.map((c) => ({ ...c.b, h: 50 }));
    const spots = placeAll({ shapes, cards: claims.map((c) => c.b), strips }, 'far', Math.floor(Math.log(0.55) / Math.log(1.06)));
    const b = spots.get('B')!;
    expect(b.side).toBe('inside');
    const middle = claims.find((c) => c.id === '22')!.b;
    expect(crossing(b.box, middle)).toBe(false);
  });

  test("far out, the last resort keeps off a project's workstream titles", () => {
    const item = (id: string, kind: Item['kind'], extra: Partial<Item> = {}) => ({ id, kind, state: 'planned', title: id, body: '', ...extra }) as Item;
    const project = { item: item('p', 'project'), b: { x: 0, y: 0, w: 1640, h: 400 } };
    const ws = [0, 1, 2, 3].map((k) => ({ item: item(`w${k}`, 'task', { parent: 'p' }), b: { x: 40 + k * 400, y: 234, w: 300, h: 136 } }));
    const strips = titleStrips([project, ...ws]);
    for (const w of ws) expect(strips.some((s) => s.x === w.b.x && s.y === w.b.y)).toBe(true);
  });

  test('a name is placed once per zoom step, in a box that holds it at every zoom of that step', () => {
    const lone = card('a', 0, 0, { A: 1 });
    const shapes = shapesOf([lone], ['A']);
    const step = Math.floor(Math.log(0.9) / Math.log(1.06));
    const box = placeAll({ shapes, cards: [lone.b], strips: [] }, 'near', step).get('A')!.box;
    // drawn 13 px high on screen: at the step's smallest zoom it is largest in the world
    for (const s of [1.06 ** step, 0.9, 1.06 ** (step + 1) - 1e-9]) expect(0.7 * (13 / s)).toBeLessThanOrEqual(box.h + 1e-6);
  });
});

