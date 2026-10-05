// What a card in the queue waits for, and what waits for a card, over every step: shown while the
// pointer is on a card.

import type { Item } from '../core/types';

export interface Deps {
  /** The cards the hovered one waits for, directly or through others. */
  before: Set<string>;
  /** The cards waiting for the hovered one, directly or through others. */
  after: Set<string>;
  /** Each wait on the way, from the card waited for to the card waiting. */
  edges: [from: string, to: string][];
}

const behind = (i: Item) => (i.queue && 'behind' in i.queue ? i.queue.behind : []);

/** The waits around `id` among `items`, both ways; undefined when there are none. */
export function depsOf(id: string, items: Item[]): Deps | undefined {
  const byId = new Map(items.map((i) => [i.id, i]));
  const waiters = new Map<string, string[]>();
  for (const i of items) for (const b of behind(i)) if (byId.has(b)) waiters.set(b, [...(waiters.get(b) ?? []), i.id]);
  const edges = new Map<string, [string, string]>();
  const walk = (next: (x: string) => string[], edge: (x: string, y: string) => [string, string]) => {
    const seen = new Set<string>();
    const todo = [id];
    while (todo.length) {
      const x = todo.pop()!;
      for (const y of next(x)) {
        const e = edge(x, y);
        edges.set(e.join(' '), e);
        if (y === id || seen.has(y)) continue;
        seen.add(y);
        todo.push(y);
      }
    }
    return seen;
  };
  const before = walk((x) => behind(byId.get(x)!).filter((b) => byId.has(b)), (x, y) => [y, x]);
  const after = walk((x) => waiters.get(x) ?? [], (x, y) => [x, y]);
  if (!before.size && !after.size) return undefined;
  return { before, after, edges: [...edges.values()] };
}
