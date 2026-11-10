import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Item } from '../core/types';
import { CardFace, Links, linkPath, linkShifts, linkSpot, Minimap } from './parts';

const ws: Item = { id: 'w', number: 7, kind: 'task', state: 'live', title: 'Cart model', body: '', x: 0, y: 0, parent: 'p', source: 'plan', repo: 'shop', label: 'W1' };
const face = (item: Item, chip?: boolean) => renderToStaticMarkup(createElement(CardFace, { item, chip }));

test('a follow-up shows the dashed line to its card only while no wait joins the two', () => {
  const origin: Item = { id: 'o', number: 1, kind: 'task', state: 'waiting', title: 'Origin', body: '', x: 0, y: 0, source: 'manual', repo: 'shop' };
  const next: Item = { id: 'n', number: 2, kind: 'task', state: 'planned', title: 'Follow-up', body: '', x: 0, y: 300, source: 'manual', repo: 'shop', from: 'o' };
  const placed = [origin, next].map((item) => ({ item, b: { x: item.x, y: item.y, w: 300, h: 136 } }));
  const lines = (waits: [string, string][]) => (renderToStaticMarkup(createElement(Links, { placed, waits, standsFor: (id: string) => id })).match(/<path/g) ?? []).length;
  expect(lines([])).toBe(1);
  // whichever of the two waits for the other, its arrow already joins them
  expect(lines([['o', 'n']])).toBe(0);
  expect(lines([['n', 'o']])).toBe(0);
  expect(lines([['x', 'n']])).toBe(1);
});

test('a delivered workstream keeps its label before its title as a chip', () => {
  expect(face(ws, true)).toContain('<div class="ttl"><span class="ws-no">W1</span>Cart model</div>');
  // at a task's size the kind line says it
  expect(face(ws)).toContain('<div class="ttl">Cart model</div>');
  expect(face(ws)).toContain('<span>W1</span>');
});

/** The numbers of a path `M x1,y1 C c1 c2 x2,y2`, as points. */
const points = (d: string) => (d.match(/-?[\d.]+,-?[\d.]+/g) ?? []).map((p) => p.split(',').map(Number) as [number, number]) as [[number, number], [number, number], [number, number], [number, number]];

test('a link with a head stops at its base and runs into it square to the card, however short or bent', () => {
  const a = { x: 0, y: 0, w: 300, h: 136 };
  // beside each other, close and far apart sideways: ends 15 short of the left side, last leg level
  for (const b of [{ x: 330, y: 110, w: 300, h: 136 }, { x: 380, y: 130, w: 300, h: 136 }, { x: 1000, y: 0, w: 300, h: 136 }]) {
    const [start, c1, c2, end] = points(linkPath(a, b, 15));
    expect(start).toEqual([300, 68]);
    expect(end).toEqual([b.x - 15, b.y + 68]);
    expect(c1[1]).toBe(start[1]);
    expect(c2[1]).toBe(end[1]);
    expect(c2[0]).toBeLessThan(end[0]);
    expect(c1[0]).toBeGreaterThan(start[0]);
  }
  // above each other, the waiting card above and to the left: ends 15 below its bottom, last leg upward
  const [start, , c2, end] = points(linkPath(a, { x: -200, y: -170, w: 300, h: 136 }, 15));
  expect(start).toEqual([150, 0]);
  expect(end).toEqual([-50, -34 + 15]);
  expect(c2[0]).toBe(end[0]);
  expect(c2[1]).toBeGreaterThan(end[1]);
});

test("an arrow's button sits in its middle, or beside a card the arrow passes under", () => {
  const a = { x: 0, y: 0, w: 300, h: 136 };
  const b = { x: 680, y: 340, w: 300, h: 136 };
  const mid = linkSpot(a, b, 15, [a, b], 14);
  expect(mid.x).toBeCloseTo((300 + 680) / 2 - 7.5, 0);
  expect(mid.y).toBeCloseTo((68 + 408) / 2, 0);
  // a third card right on the middle: the button moves along the arrow until it is clear of it
  const c = { x: 340, y: 170, w: 300, h: 136 };
  const p = linkSpot(a, b, 15, [a, b, c], 14);
  expect(p.x < c.x - 14 || p.x > c.x + c.w + 14 || p.y < c.y - 14 || p.y > c.y + c.h + 14).toBe(true);
});

test('links meeting one side of a card spread along it, in the order of the cards at their other ends', () => {
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {
    hub: { x: 0, y: 200, w: 300, h: 136 },
    up: { x: 500, y: 0, w: 300, h: 136 },
    level: { x: 500, y: 200, w: 300, h: 136 },
    down: { x: 500, y: 400, w: 300, h: 136 },
  };
  // one line out of the hub to each card on its right, and one back in from the middle one
  const shifts = linkShifts([['hub', 'down'], ['hub', 'up'], ['hub', 'level'], ['level', 'hub']], (id) => boxes[id]);
  const out = (to: string) => shifts.get(`hub ${to}`)!.from;
  expect(out('up')).toBeLessThan(out('level'));
  expect(out('level')).toBeLessThan(out('down'));
  // the arrow coming back in ends apart from the line going out to the same card
  expect(shifts.get('level hub')!.to).not.toBe(out('level'));
  // all within the side, the spread centred on its middle
  const ends = [out('up'), out('level'), out('down'), shifts.get('level hub')!.to].sort((a, b) => a - b);
  expect(ends[0]! + ends[3]!).toBeCloseTo(0);
  expect(Math.max(...ends.map(Math.abs))).toBeLessThan(136 / 2);
  // a side with a single link keeps it in the middle
  expect(shifts.get('hub up')!.to).toBe(0);
});

test('two cards waiting for each other get two lines side by side, not crossing', () => {
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {
    a: { x: 0, y: 0, w: 300, h: 136 },
    b: { x: 500, y: 0, w: 300, h: 136 },
  };
  const shifts = linkShifts([['a', 'b'], ['b', 'a']], (id) => boxes[id]);
  const [ab, ba] = [shifts.get('a b')!, shifts.get('b a')!];
  // the line from a to b is on the same side of the other line at both cards
  expect(ab.from).not.toBe(ba.to);
  expect(Math.sign(ab.from - ba.to)).toBe(Math.sign(ab.to - ba.from));
});

test('the minimap colours a card as the canvas does: a Question card as a question, one taking in an answer as at work, a snoozed one muted', () => {
  const card = (id: string, more: Partial<Item>): Item => ({ id, number: 1, kind: 'task', state: 'waiting', title: id, body: '', x: 0, y: 0, source: 'manual', repo: 'shop', ...more });
  const items = [card('q', { kind: 'question', state: 'live' }), card('a', { need: 'demo', answering: true }), card('s', { snoozed: { until: '2026-11-11T08:00:00Z', by: 'agent' } as Item['snoozed'] }), card('w', { state: 'working' })];
  const cam = { x: 0, y: 0, s: 1 };
  const side = { left: 0, right: 0 } as never;
  // the window the minimap's frame stands for
  Object.assign(globalThis, { innerWidth: 1600, innerHeight: 1000 });
  const html = renderToStaticMarkup(createElement(Minimap, { cam, side, all: { x: 0, y: 0, w: 1000, h: 600 }, placed: items.map((item, n) => ({ item, b: { x: n * 250, y: 0, w: 200, h: 100 } })), territories: [], onJump: () => {}, onFollow: () => {} }));
  delete (globalThis as Record<string, unknown>).innerWidth;
  delete (globalThis as Record<string, unknown>).innerHeight;
  expect(html.match(/fill:var\(--[a-z]+\)/g)).toEqual(['fill:var(--question)', 'fill:var(--working)', 'fill:var(--muted)', 'fill:var(--working)']);
});
