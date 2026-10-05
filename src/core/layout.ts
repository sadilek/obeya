// Card sizes and default placement. Cards keep a fixed, readable size; a project wraps its children.

import { finished, type Item } from './types';

export type Shape = 'task' | 'chip' | 'project';

export const CARD_SIZE: Record<Exclude<Shape, 'project'>, readonly [number, number]> = {
  task: [300, 136],
  chip: [196, 64],
};

/** Inside a project: children start below the header, with this margin around them. */
export const PROJECT_PAD = 30;
export const PROJECT_HEAD = 78;
const PROJECT_MIN: readonly [number, number] = [420, 150];
const CHIPS_PER_ROW = 4;
const TASKS_PER_ROW = 3;
export const GAP = 20;
const PROJECT_GAP = 60;

/** A delivered workstream shrinks to a chip; every other card shows at the size of a task. */
export function shapeOf(i: Pick<Item, 'kind' | 'state' | 'parent'>): Shape {
  if (i.kind === 'project') return 'project';
  if (i.parent && finished(i.state)) return 'chip';
  return i.kind;
}

export function projectSize(children: Pick<Item, 'kind' | 'state' | 'parent' | 'x' | 'y'>[]): [number, number] {
  let w = PROJECT_MIN[0];
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
  if (shape === 'project') return projectSize(all.filter((c) => c.parent === i.id));
  const [w, h] = CARD_SIZE[shape];
  return [w, h];
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
