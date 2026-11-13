import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Item } from '../core/types';
import { CardFace, Minimap } from './parts';

const ws: Item = { id: 'w', number: 7, kind: 'task', state: 'live', title: 'Cart model', body: '', x: 0, y: 0, parent: 'p', source: 'plan', repo: 'shop', label: 'W1' };
const face = (item: Item, chip?: boolean) => renderToStaticMarkup(createElement(CardFace, { item, chip }));

test('a delivered workstream keeps its label before its title as a chip', () => {
  expect(face(ws, true)).toContain('<div class="ttl"><span class="ws-no">W1</span>Cart model</div>');
  // at a task's size the kind line says it
  expect(face(ws)).toContain('<div class="ttl">Cart model</div>');
  expect(face(ws)).toContain('<span>W1</span>');
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
