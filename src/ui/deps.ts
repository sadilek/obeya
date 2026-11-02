// What a card waits for, and what waits for a card: each direct wait shows as a faint line at all
// times, and over every step while the pointer is on a card. A card in the queue waits for the cards
// the Koordinator holds it behind; a workstream not delivered yet also waits for the open workstreams
// it builds on, as the Koordinator read them from the plan doc, started or not; a card snoozed until
// another card gets somewhere waits for that card; and a card waits for those the owner drew an arrow
// from. A wait ends once the card waited for is finished.

import type { Bounds } from '../core/layout';
import { finished, type Item } from '../core/types';

export interface Deps {
  /** The cards the hovered one waits for, directly or through others. */
  before: Set<string>;
  /** The cards waiting for the hovered one, directly or through others. */
  after: Set<string>;
  /** Each wait on the way, from the card waited for to the card waiting. */
  edges: [from: string, to: string][];
}

const queued = (i: Item) => (i.queue && 'behind' in i.queue ? i.queue.behind : []);
const snoozedOn = (i: Item) => (i.snoozed?.on ? [i.snoozed.on.card] : []);

/** The cards among `byId` that `i` waits for directly. */
function waitsFor(i: Item, byId: Map<string, Item>): string[] {
  const open = (x: string) => byId.has(x) && !finished(byId.get(x)!.state);
  if (!open(i.id)) return [];
  return [...new Set([...queued(i), ...snoozedOn(i), ...(i.manualDependsOn ?? []), ...(i.buildsOn ?? [])])].filter(open);
}

/** Every direct wait among `items`, from the card waited for to the card waiting. */
export function waitsAmong(items: Item[]): [from: string, to: string][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.flatMap((i) => waitsFor(i, byId).map((b): [string, string] => [b, i.id]));
}

/** The waits around `id` among `items`, both ways; undefined when there are none or `id` is gone
 *  (a card archived under the pointer stays hovered). */
export function depsOf(id: string, items: Item[]): Deps | undefined {
  const byId = new Map(items.map((i) => [i.id, i]));
  if (!byId.has(id)) return undefined;
  const behind = (i: Item) => waitsFor(i, byId);
  const waiters = new Map<string, string[]>();
  for (const i of items) for (const b of behind(i)) waiters.set(b, [...(waiters.get(b) ?? []), i.id]);
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
  const before = walk((x) => behind(byId.get(x)!), (x, y) => [y, x]);
  const after = walk((x) => waiters.get(x) ?? [], (x, y) => [x, y]);
  if (!before.size && !after.size) return undefined;
  return { before, after, edges: [...edges.values()] };
}

// ---------------------------------------------------------------- the dots an owner draws an arrow from

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

/** The middle of a card's edge, where its dot for that side sits. */
export function handleAt(b: Bounds, side: Side): { x: number; y: number } {
  if (side === 'top') return { x: b.x + b.w / 2, y: b.y };
  if (side === 'bottom') return { x: b.x + b.w / 2, y: b.y + b.h };
  if (side === 'left') return { x: b.x, y: b.y + b.h / 2 };
  return { x: b.x + b.w, y: b.y + b.h / 2 };
}

/** The dot nearest to world point `at` within `reach` (world units), among the cards `cards`; null when none is that close. */
export function nearestHandle(cards: { id: string; b: Bounds }[], at: { x: number; y: number }, reach: number): { id: string; side: Side } | null {
  let best: { id: string; side: Side } | null = null;
  let bestD = Infinity;
  for (const { id, b } of cards) {
    // a card whose edges all lie farther away has no dot in reach
    if (at.x < b.x - reach || at.x > b.x + b.w + reach || at.y < b.y - reach || at.y > b.y + b.h + reach) continue;
    for (const side of SIDES) {
      const h = handleAt(b, side);
      const d = Math.hypot(h.x - at.x, h.y - at.y);
      if (d <= reach && d < bestD) {
        best = { id, side };
        bestD = d;
      }
    }
  }
  return best;
}
