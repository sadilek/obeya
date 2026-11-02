// What a card waits for, and what waits for a card: each direct wait shows as a faint line at all
// times, and over every step while the pointer is on a card. A card in the queue waits for the cards
// the Koordinator holds it behind; a workstream not delivered yet also waits for the open workstreams
// it builds on, as the Koordinator read them from the plan doc, started or not; a card snoozed until
// another card gets somewhere waits for that card; and a card waits for those the owner drew an arrow
// from. A wait ends once the card waited for is finished.

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
