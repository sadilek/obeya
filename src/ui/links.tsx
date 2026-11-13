// The lines between cards: links between a project's cards, and the waits drawn as arrows.

import type { ReactNode } from 'react';
import type { Bounds } from '../core/layout';
import type { Item } from '../core/types';

/**
 * A curve between the facing sides of two cards: left and right when they stand more beside each
 * other than above each other, else bottom and top. It leaves and enters the cards square to their
 * sides. With a `head`, it stops that far short of `b`, where the base of an arrow head drawn along
 * its last direction goes, so the head ends on `b`'s side however sharply the curve bends. `shift`
 * moves its ends along their sides from the middle (`linkShifts`).
 */
export function linkPath(a: Bounds, b: Bounds, head = 0, shift?: Shift): string {
  const [p0, p1, p2, p3] = linkCurve(a, b, head, shift);
  return `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
}

type Pt = { x: number; y: number };
/** How far a link's ends sit from the middle of their sides, along them. */
export type Shift = { from: number; to: number };

/** Whether the link from `a` to `b` runs between their left and right sides, and which way along that axis. */
function facing(a: Bounds, b: Bounds): { across: boolean; dir: number } {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const across = gapX > gapY;
  const dir = across ? Math.sign(b.x + b.w / 2 - (a.x + a.w / 2)) || 1 : Math.sign(b.y + b.h / 2 - (a.y + a.h / 2)) || 1;
  return { across, dir };
}

/** The cubic Bézier curve `linkPath` draws: its start, its two control points and its end. */
function linkCurve(a: Bounds, b: Bounds, head: number, shift: Shift = { from: 0, to: 0 }): [Pt, Pt, Pt, Pt] {
  // The direction of travel along the axis the cards face each other on, and the ends on it.
  const { across, dir } = facing(a, b);
  const [x1, y1] = across ? [dir > 0 ? a.x + a.w : a.x, a.y + a.h / 2 + shift.from] : [a.x + a.w / 2 + shift.from, dir > 0 ? a.y + a.h : a.y];
  const [x2, y2] = across ? [(dir > 0 ? b.x : b.x + b.w) - dir * head, b.y + b.h / 2 + shift.to] : [b.x + b.w / 2 + shift.to, (dir > 0 ? b.y : b.y + b.h) - dir * head];
  // How far the control points reach out from the cards: half the way, but with a head at least its
  // length (less where the curve hardly goes sideways), so that a short link still runs square into
  // the head instead of meeting it from the side.
  const along = across ? x2 - x1 : y2 - y1;
  const aside = across ? y2 - y1 : x2 - x1;
  const reach = dir * Math.max(dir * along / 2, Math.min(Math.abs(aside) / 2, head));
  const [c1, c2] = across ? [{ x: x1 + reach, y: y1 }, { x: x2 - reach, y: y2 }] : [{ x: x1, y: y1 + reach }, { x: x2, y: y2 - reach }];
  return [{ x: x1, y: y1 }, c1, c2, { x: x2, y: y2 }];
}

/** The widest gap between the ends of two links on one side of a card, in canvas pixels. */
const PORT_GAP = 26;

/**
 * Where the ends of `links` sit on their cards' sides, by `from to`: several links meeting one side
 * spread along it instead of all ending in its middle, ordered by where the card at their other end
 * stands, so that they do not cross on the way, and an arrow coming in stays apart from a line going out.
 */
export function linkShifts(links: [from: string, to: string][], at: (id: string) => Bounds | undefined): Map<string, Shift> {
  const sides = new Map<string, { key: string; end: 'from' | 'to'; other: number; tie: number }[]>();
  for (const [from, to] of links) {
    const a = at(from);
    const b = at(to);
    if (!a || !b) continue;
    const { across, dir } = facing(a, b);
    const key = `${from} ${to}`;
    // the other card's middle along the side; for the two lines between one pair of cards, their
    // direction, the same at both ends, so that the two run side by side instead of crossing
    const mid = (c: Bounds) => (across ? c.y + c.h / 2 : c.x + c.w / 2);
    const add = (id: string, side: number, end: 'from' | 'to', other: Bounds, tie: number) => {
      const k = `${id} ${across ? 'x' : 'y'}${side}`;
      sides.set(k, [...(sides.get(k) ?? []), { key, end, other: mid(other), tie }]);
    };
    add(from, dir, 'from', b, dir);
    add(to, -dir, 'to', a, dir);
  }
  const shifts = new Map<string, Shift>();
  for (const [k, ends] of sides) {
    const card = at(k.slice(0, k.lastIndexOf(' ')))!;
    const length = k.slice(k.lastIndexOf(' ') + 1).startsWith('x') ? card.h : card.w;
    const gap = Math.min(PORT_GAP, (length * 0.7) / ends.length);
    ends.sort((p, q) => p.other - q.other || p.tie - q.tie);
    ends.forEach((e, i) => {
      const s = shifts.get(e.key) ?? { from: 0, to: 0 };
      s[e.end] = (i - (ends.length - 1) / 2) * gap;
      shifts.set(e.key, s);
    });
  }
  return shifts;
}

/**
 * Where on the link from `a` to `b` its button goes: the middle, or the point nearest the middle that
 * keeps `room` clear of every card in `cards`, so that a card the link passes under never covers it.
 */
export function linkSpot(a: Bounds, b: Bounds, head: number, cards: Bounds[], room: number, shift?: Shift): Pt {
  const [p0, p1, p2, p3] = linkCurve(a, b, head, shift);
  const at = (t: number) => {
    const u = 1 - t;
    const [k0, k1, k2, k3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return { x: k0 * p0.x + k1 * p1.x + k2 * p2.x + k3 * p3.x, y: k0 * p0.y + k1 * p1.y + k2 * p2.y + k3 * p3.y };
  };
  const clear = (p: Pt) => !cards.some((c) => p.x > c.x - room && p.x < c.x + c.w + room && p.y > c.y - room && p.y < c.y + c.h + room);
  for (let step = 0; step <= 20; step++) {
    for (const t of step ? [0.5 - step * 0.02, 0.5 + step * 0.02] : [0.5]) {
      const p = at(t);
      if (clear(p)) return p;
    }
  }
  return at(0.5);
}

/**
 * A dashed line from each proposal and each follow-up not yet started to the card it came from, and
 * from each prototype to its idea, or to the project that took the idea's place; none where a wait
 * between the two cards (`waits`, as `standsFor` shows them) already draws its arrow there.
 */
export function Links({ placed, waits, standsFor }: { placed: { item: Item; b: Bounds }[]; waits: [string, string][]; standsFor: (id: string) => string }) {
  const byId = new Map(placed.map((p) => [p.item.id, p]));
  const projectOf = new Map(placed.flatMap((p) => (p.item.kind === 'project' && p.item.origin ? [[p.item.origin, p]] : [])));
  // both ways: the arrow joins the same two cards whichever of them waits
  const joined = new Set(waits.flatMap(([from, to]) => [`${standsFor(from)} ${standsFor(to)}`, `${standsFor(to)} ${standsFor(from)}`]));
  const paths = placed.flatMap(({ item, b }) => {
    const src =
      (item.state === 'proposal' || item.state === 'planned' || item.prototypeOf) && item.from ? (byId.get(item.from) ?? (item.prototypeOf ? projectOf.get(item.prototypeOf) : undefined)) : undefined;
    if (!src || joined.has(`${src.item.id} ${item.id}`)) return [];
    return [<path key={item.id} d={linkPath(src.b, b)} />];
  });
  return (
    <svg id="links" width="1" height="1">
      {paths}
    </svg>
  );
}

/**
 * The width of a wait's line in canvas pixels at zoom `s`, the same faint or highlighted, so that
 * the pointer on a card only changes its colour; never thinner on screen than a hair when zoomed out.
 */
export const depWidth = (s: number) => Math.max(2, 1.6 / s);
/** The length of the arrow head at the end of a wait's line, in canvas pixels: six widths of its line. */
export const depHead = (s: number) => 6 * depWidth(s);

/** How strongly a wait shows under the pointer, by its steps from the card there: its own waits fully, those further along fainter. */
const stepOpacity = (step: number) => [1, 1, 0.6, 0.42][step] ?? 0.3;

/**
 * The head of a wait's arrow, measured in the line's width as `depHead` is. By default the line stops
 * at the head's base (`refX` a hair inside 0, so no seam shows) and the head points on to the card;
 * `refX` 9 puts the tip at the line's end.
 */
export function ArrowMarker({ id, className, refX = 0.3 }: { id: string; className?: string; refX?: number }) {
  return (
    <marker id={id} className={className} viewBox="0 0 9 8" refX={refX} refY="4" markerUnits="strokeWidth" markerWidth={6} markerHeight={(6 * 8) / 9} orient="auto">
      <path d="M0,0 L9,4 L0,8 z" />
    </marker>
  );
}

/**
 * Every direct wait between cards on the canvas as a faint line, from the card waited for to the
 * card waiting, fading in towards its arrow head, so that the end it points to shows even where lines
 * meet; while the pointer is on a card, the waits around it (`lit`) in the waiting colour instead,
 * fainter the more `steps` they lie from it. Waits that close a loop (`loops`) are red at all times.
 * A workstream of a collapsed project stands for its project (`standsFor`). `children` go on top:
 * what the pointer can reach on a line, placed with the shift of the line's ends.
 */
export function DepLinks({
  placed,
  waits,
  lit,
  steps,
  loops = [],
  standsFor,
  s,
  children,
}: {
  placed: { item: Item; b: Bounds }[];
  waits: [string, string][];
  lit: [string, string][];
  steps?: Map<string, number>;
  loops?: [string, string][];
  standsFor: (id: string) => string;
  s: number;
  children?: (shift: (from: string, to: string) => Shift | undefined) => ReactNode;
}) {
  const byId = new Map(placed.map((p) => [p.item.id, p.b]));
  // each wait once between the cards that show it, none from a project to its own workstream; the
  // fewest steps of the waits it shows
  const shown = (edges: [string, string][]) => {
    const out = new Map<string, { e: [string, string]; step: number }>();
    for (const [from, to] of edges) {
      const e: [string, string] = [standsFor(from), standsFor(to)];
      if (e[0] === e[1] || !byId.has(e[0]) || !byId.has(e[1])) continue;
      const k = e.join(' ');
      const step = steps?.get(`${from} ${to}`) ?? 1;
      out.set(k, { e, step: Math.min(step, out.get(k)?.step ?? Infinity) });
    }
    return out;
  };
  const hot = shown(lit);
  const red = shown(loops);
  const all = shown(waits);
  const shifts = linkShifts([...all.values()].map((x) => x.e), (id) => byId.get(id));
  const head = depHead(s);
  const lines = [...all].map(([k, { e }], i) => {
    const cls = red.has(k) ? 'loop' : hot.has(k) ? 'lit' : 'faint';
    const [a, b] = [byId.get(e[0])!, byId.get(e[1])!];
    const shift = shifts.get(k);
    const [p0, , , p3] = linkCurve(a, b, head, shift);
    return { k, cls, i, a, b, shift, p0, p3, opacity: cls === 'lit' ? stepOpacity(hot.get(k)!.step) : 1 };
  });
  // the loops, then those under the pointer, over the faint ones
  const order = { faint: 0, lit: 1, loop: 2 } as const;
  lines.sort((x, y) => order[x.cls as keyof typeof order] - order[y.cls as keyof typeof order]);
  return (
    <svg id="deps" width="1" height="1">
      <defs>
        {['lit', 'faint', 'loop'].map((cls) => (
          <ArrowMarker key={cls} id={`${cls}-arrow`} className={cls} />
        ))}
        {lines.map(({ k, cls, i, p0, p3 }) => (
          <linearGradient key={k} id={`dep-fade-${i}`} className={cls} gradientUnits="userSpaceOnUse" x1={p0.x} y1={p0.y} x2={p3.x} y2={p3.y}>
            <stop offset="0" stopOpacity={0.3} />
            <stop offset="1" />
          </linearGradient>
        ))}
      </defs>
      {lines.map(({ k, cls, i, a, b, shift, opacity }) => (
        <path key={`${cls} ${k}`} className={cls} d={linkPath(a, b, head, shift)} strokeWidth={depWidth(s)} markerEnd={`url(#${cls}-arrow)`} style={{ stroke: `url(#dep-fade-${i})`, ...(opacity < 1 && { opacity }) }} />
      ))}
      {children?.((from, to) => shifts.get(`${standsFor(from)} ${standsFor(to)}`))}
    </svg>
  );
}
