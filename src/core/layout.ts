// Card sizes and default placement. Cards keep a fixed, readable size; a project wraps its children.

import { plain } from './plain';
import { finished, finishingUp, type Item, type PlanDir } from './types';

export type Shape = 'task' | 'chip' | 'project';

export const CARD_SIZE: Record<Exclude<Shape, 'project'>, readonly [number, number]> = {
  task: [300, 136],
  chip: [196, 64],
};

/** Inside a project: children start below the header, with this margin around them. */
export const PROJECT_PAD = 30;
export const PROJECT_HEAD = 78;
const PROJECT_MIN: readonly [number, number] = [420, 150];
/** A project the owner collapsed: its head, and a row of marks for its workstreams. */
export const PROJECT_COLLAPSED: readonly [number, number] = [440, 84];

// A project's title wraps in its head, kind, progress and number flowing after its last word. Only
// two lines fit above its workstreams, so a project is at least as wide as its title needs for
// two; a collapsed one grows a line taller instead where its title takes two. The canvas measures
// nothing here, which the server has to place projects as well: the title's width is estimated,
// on the generous side (a line of the serif title averages 8–9.5 px a character).
const TITLE_CHAR = 10;
/** Kind, progress and number after the title, with a word's worth lost where each line breaks. */
const HEAD_META = 160;
const LINE_LOSS = 40;
/** Left of the title the fold button, right of it the room of the "…" button. */
const HEAD_SIDES = 12 + 30 + 36;
const TITLE_LINE = 24;
const titleWidth = (title: string) => plain(title).length * TITLE_CHAR + HEAD_META;
/** The width a project needs for its title to take at most two lines. */
const titleMin = (title: string) => Math.ceil(HEAD_SIDES + titleWidth(title) / 2 + LINE_LOSS);

/** A collapsed project: one line taller where its title takes two. */
export function collapsedSize(title: string): [number, number] {
  const [w, h] = PROJECT_COLLAPSED;
  return titleWidth(title) + LINE_LOSS > w - HEAD_SIDES ? [Math.max(w, titleMin(title)), h + TITLE_LINE] : [w, h];
}
const CHIPS_PER_ROW = 4;
const TASKS_PER_ROW = 3;
export const GAP = 20;
const PROJECT_GAP = 60;

/**
 * A delivered workstream shrinks to a chip once its agent is done; every other card shows at the
 * size of a task, so its state and status line show.
 */
export function shapeOf(i: Pick<Item, 'kind' | 'state' | 'parent' | 'finishing'>): Shape {
  if (i.kind === 'project') return 'project';
  if (i.parent && finished(i.state) && !finishingUp(i)) return 'chip';
  // a Question card too: it has a task's size, and a look of its own
  return 'task';
}

export function projectSize(children: Pick<Item, 'kind' | 'state' | 'parent' | 'finishing' | 'x' | 'y'>[], title = ''): [number, number] {
  let w = Math.max(PROJECT_MIN[0], titleMin(title));
  let h = PROJECT_MIN[1];
  for (const c of children) {
    const [cw, ch] = CARD_SIZE[shapeOf(c) as Exclude<Shape, 'project'>];
    w = Math.max(w, c.x + cw + PROJECT_PAD);
    h = Math.max(h, c.y + ch + PROJECT_PAD);
  }
  return [w, h];
}

export function sizeOf(i: Item, all: Item[]): [number, number] {
  const shape = shapeOf(i);
  if (shape === 'project') return i.collapsed ? collapsedSize(i.title) : projectSize(all.filter((c) => c.parent === i.id), i.title);
  const [w, h] = CARD_SIZE[shape];
  return [w, h];
}

/** The items the canvas shows: all but the workstreams of a collapsed project. */
export function onCanvas(items: Item[]): Item[] {
  const collapsed = new Set(items.flatMap((i) => (i.collapsed ? [i.id] : [])));
  return collapsed.size ? items.filter((i) => !i.parent || !collapsed.has(i.parent)) : items;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Absolute bounds of an item; children are stored relative to their project. */
export function boundsOf(i: Item, all: Item[]): Bounds {
  const parent = i.parent ? all.find((p) => p.id === i.parent) : undefined;
  const [w, h] = sizeOf(i, all);
  return { x: i.x + (parent?.x ?? 0), y: i.y + (parent?.y ?? 0), w, h };
}

/** The middle of `b`. */
export const centre = (b: Bounds) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function unionBounds(bs: Bounds[]): Bounds | null {
  if (!bs.length) return null;
  const x1 = Math.min(...bs.map((b) => b.x));
  const y1 = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.w));
  const y2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Places new workstreams inside a project, below `startY`: delivered ones as rows of chips first,
 * then the open ones as rows of cards, each group in the given order.
 */
export function placeWorkstreams(ws: { done: boolean }[], startY = PROJECT_HEAD): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = new Array(ws.length);
  let y = startY;
  for (const [done, perRow, shape] of [
    [true, CHIPS_PER_ROW, 'chip'],
    [false, TASKS_PER_ROW, 'task'],
  ] as const) {
    const [w, h] = CARD_SIZE[shape];
    const idx = ws.map((_, i) => i).filter((i) => ws[i]!.done === done);
    idx.forEach((i, n) => {
      out[i] = { x: PROJECT_PAD + (n % perRow) * (w + GAP), y: y + Math.floor(n / perRow) * (h + GAP) };
    });
    if (idx.length) y += Math.ceil(idx.length / perRow) * (h + GAP);
  }
  return out;
}

/** What arranging a project's workstreams needs of each, in the plan's order. */
export type Arrangeable = Pick<Item, 'id' | 'kind' | 'state' | 'parent' | 'finishing' | 'buildsOn'>;

/** Between two columns of workstreams there is room for the arrows from one to the next. */
const COLUMN_GAP = 70;
/** A column holds this many cards; more of one depth go into a second column beside it. */
const ROWS_PER_COLUMN = 4;

/**
 * A project's open workstreams in columns by their dependencies (`layers`: the columns of each
 * depth). A workstream's depth is the length of the longest chain of open workstreams it builds on,
 * so what can start at once stands left and what builds on it right of it. Within a column the cards follow the rows of what they
 * build on, so arrows cross little, else the plan's order. Delivered ones (chips) are no step on
 * a chain: they stay in rows above. A cycle (a doc misread) is cut where it closes.
 */
export function dependencyColumns(ws: Arrangeable[]): { chips: string[]; layers: string[][][] } {
  const open = ws.filter((w) => shapeOf(w) !== 'chip');
  const byId = new Map(open.map((w) => [w.id, w]));
  const on = (w: Arrangeable) => (w.buildsOn ?? []).filter((d) => d !== w.id && byId.has(d));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (w: Arrangeable): number => {
    const known = depth.get(w.id);
    if (known !== undefined) return known;
    visiting.add(w.id);
    let d = 0;
    for (const b of on(w)) if (!visiting.has(b)) d = Math.max(d, depthOf(byId.get(b)!) + 1);
    visiting.delete(w.id);
    depth.set(w.id, d);
    return d;
  };
  const layers: Arrangeable[][] = [];
  for (const w of open) (layers[depthOf(w)] ??= []).push(w);
  const row = new Map<string, number>();
  const arranged = layers
    .filter(Boolean)
    .map((layer) => {
      const mean = (w: Arrangeable) => {
        const rows = on(w).flatMap((b) => (row.has(b) ? [row.get(b)!] : []));
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity;
      };
      const sorted = layer.map((w, n) => ({ w, n, m: mean(w) })).sort((a, b) => (a.m === b.m ? a.n - b.n : a.m - b.m)).map((x) => x.w);
      sorted.forEach((w, n) => row.set(w.id, n % ROWS_PER_COLUMN));
      // a depth with more cards than a column holds goes on in a column beside it
      return Array.from({ length: Math.ceil(sorted.length / ROWS_PER_COLUMN) }, (_, n) => sorted.slice(n * ROWS_PER_COLUMN, (n + 1) * ROWS_PER_COLUMN).map((w) => w.id));
    });
  return { chips: ws.filter((w) => shapeOf(w) === 'chip').map((w) => w.id), layers: arranged };
}

/** The workstreams as `dependencyColumns` arranges them, read row by row of chips, then column by column. */
export function dependencyOrder(ws: Arrangeable[]): string[] {
  const { chips, layers } = dependencyColumns(ws);
  return [...chips, ...layers.flat(2)];
}

/**
 * Where each workstream of a project stands once arranged by its dependencies (relative to the
 * project): rows of chips below the head, then the columns of `dependencyColumns`, a wider gap
 * between one depth and the next for the arrows.
 */
export function arrangeWorkstreams(ws: Arrangeable[]): Map<string, { x: number; y: number }> {
  const { chips, layers } = dependencyColumns(ws);
  const out = new Map<string, { x: number; y: number }>();
  const [cw, ch] = CARD_SIZE.chip;
  chips.forEach((id, n) => out.set(id, { x: PROJECT_PAD + (n % CHIPS_PER_ROW) * (cw + GAP), y: PROJECT_HEAD + Math.floor(n / CHIPS_PER_ROW) * (ch + GAP) }));
  const top = PROJECT_HEAD + Math.ceil(chips.length / CHIPS_PER_ROW) * (ch + GAP);
  const [w, h] = CARD_SIZE.task;
  let x = PROJECT_PAD;
  for (const layer of layers) {
    for (const ids of layer) {
      ids.forEach((id, r) => out.set(id, { x, y: top + r * (h + GAP) }));
      x += w + GAP;
    }
    x += COLUMN_GAP - GAP;
  }
  return out;
}

/**
 * The spot nearest `want` where a card of `size` keeps GAP clear of everything in `taken`. Besides
 * `want` itself, the candidates are the positions flush beside the edges of what is taken; right of
 * everything there is always room. With `within` (the part of the canvas the owner has in view),
 * `want` moves inside it first and a free spot wholly inside it wins over a nearer one partly out.
 */
export function freeSpotNear(want: { x: number; y: number }, size: readonly [number, number], taken: Bounds[], within?: Bounds): { x: number; y: number } {
  const [w, h] = size;
  const free = (x: number, y: number) =>
    taken.every((b) => x + w + GAP <= b.x || b.x + b.w + GAP <= x || y + h + GAP <= b.y || b.y + b.h + GAP <= y);
  const view = within && within.w >= w + 2 * GAP && within.h >= h + 2 * GAP ? within : undefined;
  const inside = (x: number, y: number) => !view || (x >= view.x && y >= view.y && x + w <= view.x + view.w && y + h <= view.y + view.h);
  if (view) {
    want = {
      x: Math.min(Math.max(want.x, view.x + GAP), view.x + view.w - w - GAP),
      y: Math.min(Math.max(want.y, view.y + GAP), view.y + view.h - h - GAP),
    };
  }
  const xs = [want.x, ...taken.flatMap((b) => [b.x + b.w + GAP, b.x - w - GAP]), ...(view ? [view.x + GAP, view.x + view.w - w - GAP] : [])];
  const ys = [want.y, ...taken.flatMap((b) => [b.y + b.h + GAP, b.y - h - GAP]), ...(view ? [view.y + GAP, view.y + view.h - h - GAP] : [])];
  let best = want;
  let bestD = Infinity;
  let bestIn = false;
  for (const x of xs)
    for (const y of ys) {
      if (!free(x, y)) continue;
      const d = (x - want.x) ** 2 + (y - want.y) ** 2;
      const isIn = inside(x, y);
      if ((isIn && !bestIn) || (isIn === bestIn && d < bestD)) [best, bestD, bestIn] = [{ x, y }, d, isIn];
    }
  return best;
}

/** Where a new card should go: centred as near this point as there is room, inside `view` (the canvas the owner has in view) if there is room there. */
export interface Place {
  x: number;
  y: number;
  view?: Bounds;
}

/** A place as a request carries it (`?place=`): `x,y`, then the view's `x,y,w,h`. */
export const placeParam = (p: Place) => [p.x, p.y, ...(p.view ? [p.view.x, p.view.y, p.view.w, p.view.h] : [])].map(Math.round).join(',');

/** The place in a request's `?place=`; anything else is none. */
export function parsePlace(s: string | null | undefined): Place | undefined {
  const n = s?.split(',').map(Number) ?? [];
  if ((n.length !== 2 && n.length !== 6) || !n.every(Number.isFinite)) return undefined;
  const [x, y, vx, vy, vw, vh] = n as [number, number, number?, number?, number?, number?];
  return { x, y, ...(vw !== undefined && vw > 0 && vh! > 0 ? { view: { x: vx!, y: vy!, w: vw, h: vh! } } : {}) };
}

/** How wide the note on a plan directory is (`PlanDir`). */
export const PLAN_DIR_NOTE_W = 380;

/** How tall the note on a plan directory is, about: it has a row for each doc it lists. */
export function planDirNoteHeight(d: PlanDir): number {
  const mixed = new Set(d.others.map((o) => o.reason)).size > 1;
  return d.empty ? 92 : 64 + d.others.length * (mixed ? 48 : 34);
}

/** Where the owner put the note on a plan directory, about; none while it stands beside the projects. */
export const planDirNoteBox = (d: PlanDir): Bounds | undefined => d.at && { ...d.at, w: PLAN_DIR_NOTE_W, h: planDirNoteHeight(d) };

/** Places new projects in a roughly square grid of columns below everything already on the canvas. */
export function placeProjects(existing: Bounds | null, sizes: [number, number][]): { x: number; y: number }[] {
  const x0 = existing?.x ?? 0;
  let y = existing ? existing.y + existing.h + PROJECT_GAP * 2 : 0;
  const colW = Math.max(...sizes.map(([w]) => w), 0) + PROJECT_GAP;
  const cols = Math.max(2, Math.ceil(Math.sqrt(sizes.length)));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < sizes.length; i += cols) {
    const row = sizes.slice(i, i + cols);
    row.forEach((_, j) => out.push({ x: x0 + j * colW, y }));
    y += Math.max(...row.map(([, h]) => h)) + PROJECT_GAP;
  }
  return out;
}
