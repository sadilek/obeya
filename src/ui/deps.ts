// What a card waits for, and what waits for a card: each direct wait shows as a faint line at all
// times, and over every step while the pointer is on a card. A card in the queue waits for the cards
// the Coordinator holds it behind; a workstream not delivered yet also waits for the open workstreams
// it builds on, as the Coordinator read them from the plan doc, started or not; a card snoozed until
// another card gets somewhere waits for that card; and a card waits for those the owner drew an arrow
// from. A wait ends once the card waited for is finished.

import type { Bounds } from '../core/layout';
import { drawnWaits } from '../core/queue';
import type { Item } from '../core/types';
import { finished } from '../core/card';

export interface Deps {
  /** The cards the hovered one waits for, directly or through others. */
  before: Set<string>;
  /** The cards waiting for the hovered one, directly or through others. */
  after: Set<string>;
  /** Each wait on the way, from the card waited for to the card waiting. */
  edges: [from: string, to: string][];
  /** How many steps from the hovered card each of `edges` lies, by `from to`: 1 for its own waits. */
  steps: Map<string, number>;
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
  const steps = new Map<string, number>();
  // breadth first, so that each card and wait counts the fewest steps from the hovered card
  const walk = (next: (x: string) => string[], edge: (x: string, y: string) => [string, string]) => {
    const seen = new Set<string>();
    const depth = new Map([[id, 0]]);
    const todo = [id];
    while (todo.length) {
      const x = todo.shift()!;
      for (const y of next(x)) {
        const e = edge(x, y);
        const k = e.join(' ');
        edges.set(k, e);
        steps.set(k, Math.min(steps.get(k) ?? Infinity, depth.get(x)! + 1));
        if (y === id || seen.has(y)) continue;
        seen.add(y);
        depth.set(y, depth.get(x)! + 1);
        todo.push(y);
      }
    }
    return seen;
  };
  const before = walk((x) => behind(byId.get(x)!), (x, y) => [y, x]);
  const after = walk((x) => waiters.get(x) ?? [], (x, y) => [x, y]);
  if (!before.size && !after.size) return undefined;
  return { before, after, edges: [...edges.values()], steps };
}

/**
 * The loops among `waits` (`holdsAmong`): cards that wait for each other, directly or through others,
 * so that none of them can ever start or go on. Each loop with its cards and the waits that close it.
 */
export function loopsAmong(waits: [from: string, to: string][]): { cards: string[]; edges: [from: string, to: string][] }[] {
  const next = new Map<string, string[]>();
  for (const [a, b] of waits) next.set(a, [...(next.get(a) ?? []), b]);
  // Tarjan's strongly connected components
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const parts: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    on.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const part: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        part.push(w);
      } while (w !== v);
      if (part.length > 1) parts.push(part.reverse());
    }
  };
  for (const v of next.keys()) if (!index.has(v)) visit(v);
  return parts.map((cards) => {
    const of = new Set(cards);
    return { cards, edges: waits.filter(([a, b]) => of.has(a) && of.has(b)) };
  });
}

/** What makes one card wait for another. */
export type WaitKind = 'queue' | 'snooze' | 'arrow' | 'plan';

/**
 * What holds `waiting` back for `on` (among `items`): the kinds of wait between the two that keep it
 * from starting or going on. A card in the queue is held by those it queued behind, a snoozed one by
 * the card it sleeps on; the owner's arrows and the plan doc's order hold a card only until it starts
 * (`drawnWaits`), so a card at work shows those waits as lines but is not held by them.
 */
export function waitKinds(waiting: Item, on: string, items: Item[]): WaitKind[] {
  const drawn = waiting.queue && 'behind' in waiting.queue ? waiting.queue.manualWait ?? [] : [];
  // started once: at work, or in the queue only for a workspace or a paused canvas to go on
  const begun = waiting.state !== 'planned' || (!!waiting.queue && 'begun' in waiting.queue);
  return [
    ...(queued(waiting).includes(on) && !drawn.includes(on) ? (['queue'] as const) : []),
    ...(snoozedOn(waiting).includes(on) ? (['snooze'] as const) : []),
    ...((queued(waiting).includes(on) && drawn.includes(on)) || drawnWaits(waiting, items).includes(on) ? (['arrow'] as const) : []),
    ...(!begun && (waiting.buildsOn ?? []).includes(on) ? (['plan'] as const) : []),
  ];
}

/**
 * The waits among `items` that hold a card back (`waitKinds`), from the card waited for to the card
 * waiting: those of `waitsAmong` a loop is made of, since a loop through a card at work stalls nothing.
 */
export function holdsAmong(items: Item[]): [from: string, to: string][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.flatMap((i) => waitsFor(i, byId).filter((on) => waitKinds(i, on, items).length).map((on): [string, string] => [on, i.id]));
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
