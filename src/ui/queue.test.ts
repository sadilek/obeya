import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Item } from '../core/types';
import { QueueList, useQueueSort } from './queue';

const card = (id: string, more: Partial<Item>): Item => ({ id, number: 1, kind: 'task', state: 'planned', title: id, body: '', x: 0, y: 0, source: 'manual', repo: 'shop', ...more });

function List({ items }: { items: Item[] }) {
  const q = useQueueSort(items, { current: null });
  return createElement(QueueList, { items, q });
}

test('the queue names a workstream after its label, in its row and where another waits for it', () => {
  const items = [
    card('p', { kind: 'project', state: 'working', title: 'Shop', source: 'plan' }),
    card('w2', { parent: 'p', source: 'plan', label: 'W2', title: 'Cart model', queue: { since: '2026-11-14T08:00:00Z', checking: true } }),
    card('w3', { parent: 'p', source: 'plan', label: 'W3', title: 'Checkout page', queue: { since: '2026-11-14T08:01:00Z', behind: ['w2'], reason: 'It builds on it.' } }),
    card('t', { title: 'Fix the footer', queue: { since: '2026-11-14T08:02:00Z', checking: true } }),
  ];
  const html = renderToStaticMarkup(createElement(List, { items }));
  expect(html).toContain('W2: Cart model<br/>');
  expect(html).toContain('W3: Checkout page<br/>');
  expect(html).toMatch(/[„“]W2: Cart model“/);
  // a card of no project keeps its title alone
  expect(html).toContain('Fix the footer<br/>');
});
