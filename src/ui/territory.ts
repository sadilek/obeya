// The territories of groups behind the cards, as contours of an energy field (Bubble Sets): a
// group's cards and the near links between them attract, every other card repels, and where two
// groups meet the stronger one holds the ground. A card in another group's territory is an island.
//
// Each group gets its own grid around its cards, on one lattice shared by all, so the cost follows
// the territories' area rather than the canvas's; a group's field is computed again only when
// something within its reach changed, and its contour only when its field or a neighbour's did.

import { contours } from 'd3-contour';
import type { Bounds } from '../core/layout';

type Pt = { x: number; y: number };

/** A card as the territories see it: where it is, and how much it belongs to each group (fading between two). */
export interface Claim {
  id: string;
  b: Bounds;
  /** Group id → weight; 1 is a member, 0 (or absent) is a stranger. Up to a little over 1 while it springs. */
  w: Record<string, number>;
}

export interface Territory {
  group: string;
  /** SVG path of the territory, in world coordinates. */
  main: string;
  /** SVG path of the dotted line inside it, closer around the cards. */
  inner: string;
  /** The territory's outlines in world coordinates, each piece's rings (outer first). */
  pieces: [number, number][][][];
  /** Where its name goes: the middle of its largest piece. */
  label?: Pt;
  labelSize: number;
}

const CELL = 16;
/** How far a card's pull reaches, from its edge. */
const R_MEMBER = 100;
/** How far the link between two near cards of a group pulls. */
const R_EDGE = 54;
/** How far a stranger pushes back. */
const R_OBST = 40;
/** Thresholds of the territory and of the dotted line inside it, closer around the cards. */
const T_AREA = 0.16;
const T_INNER = 0.42;
/** Cards further apart than this are not linked: each has its own piece. */
const EDGE_MAX = 330;
/** Two cards facing each other across less than this fill the gap between them. */
const BRIDGE_MAX = 100;
const MARGIN = R_MEMBER + 2 * CELL;

// Math.hypot is several times slower, and this runs for every cell near a card
const len = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);
const rectDist = (x: number, y: number, b: Bounds) => len(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));
const gap = (a: Bounds, b: Bounds) => len(Math.max(a.x - b.x - b.w, 0, b.x - a.x - a.w), Math.max(a.y - b.y - b.h, 0, b.y - a.y - a.h));
const centre = (b: Bounds) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const near = (a: Bounds, b: Bounds, d: number) => a.x - d < b.x + b.w && b.x < a.x + a.w + d && a.y - d < b.y + b.h && b.y < a.y + a.h + d;

function segDist(x: number, y: number, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return len(x - a.x - t * dx, y - a.y - t * dy);
}

/** Does the segment pass close by one of `rs`? */
function blocked(a: Pt, b: Pt, rs: Bounds[]) {
  for (let k = 1; k < 24; k++) {
    const x = a.x + ((b.x - a.x) * k) / 24;
    const y = a.y + ((b.y - a.y) * k) / 24;
    if (rs.some((r) => rectDist(x, y, r) < 24)) return true;
  }
  return false;
}

/** A grid on the shared lattice: cell (i, j) of the lattice is `v[(j - j0) * nx + (i - i0)]`. */
interface Field {
  i0: number;
  j0: number;
  nx: number;
  ny: number;
  v: Float64Array;
}

type Member = { b: Bounds; w: number };
type Stranger = { b: Bounds; s: number };

/** A group's energy around its members. */
function field(members: Member[], strangers: Stranger[]): Field {
  const i0 = Math.floor((Math.min(...members.map((m) => m.b.x)) - MARGIN) / CELL);
  const j0 = Math.floor((Math.min(...members.map((m) => m.b.y)) - MARGIN) / CELL);
  const nx = Math.ceil((Math.max(...members.map((m) => m.b.x + m.b.w)) + MARGIN) / CELL) - i0;
  const ny = Math.ceil((Math.max(...members.map((m) => m.b.y + m.b.h)) + MARGIN) / CELL) - j0;
  const v = new Float64Array(nx * ny);
  // the members' pull, the strongest one's at each cell: summed, two cards side by side would push
  // the edge out over the gap between them
  const pull = new Float64Array(nx * ny);
  // each shape adds to the cells within its reach only (or, into `pull`, keeps the larger value)
  const splat = (bx0: number, by0: number, bx1: number, by1: number, f: (x: number, y: number) => number, into = v) => {
    const gx0 = Math.max(0, Math.floor(bx0 / CELL) - i0);
    const gx1 = Math.min(nx - 1, Math.ceil(bx1 / CELL) - i0);
    const gy0 = Math.max(0, Math.floor(by0 / CELL) - j0);
    const gy1 = Math.min(ny - 1, Math.ceil(by1 / CELL) - j0);
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = (j0 + gy + 0.5) * CELL;
      if (into === v) for (let gx = gx0; gx <= gx1; gx++) v[gy * nx + gx]! += f((i0 + gx + 0.5) * CELL, y);
      else
        for (let gx = gx0; gx <= gx1; gx++) {
          const e = f((i0 + gx + 0.5) * CELL, y);
          if (e > into[gy * nx + gx]!) into[gy * nx + gx] = e;
        }
    }
  };
  // links: a spanning tree over the members, only between near ones and not across a stranger
  const walls = strangers.filter((o) => o.s > 0.5).map((o) => o.b);
  const inTree = [0];
  const rest = members.map((_, i) => i).slice(1);
  while (rest.length) {
    let best: [number, number, number] | undefined;
    for (const a of inTree)
      for (const r of rest) {
        const d = gap(members[a]!.b, members[r]!.b);
        if (!best || d < best[2]) best = [a, r, d];
      }
    const [a, r, d] = best!;
    rest.splice(rest.indexOf(r), 1);
    inTree.push(r);
    const ca = centre(members[a]!.b);
    const cb = centre(members[r]!.b);
    if (d >= EDGE_MAX || blocked(ca, cb, walls)) continue;
    const w = Math.min(members[a]!.w, members[r]!.w) * 0.9;
    splat(Math.min(ca.x, cb.x) - R_EDGE, Math.min(ca.y, cb.y) - R_EDGE, Math.max(ca.x, cb.x) + R_EDGE, Math.max(ca.y, cb.y) + R_EDGE, (x, y) => {
      const e = segDist(x, y, ca, cb);
      return e < R_EDGE ? w * (1 - e / R_EDGE) ** 2 : 0;
    });
  }
  // two members facing each other across a narrow gap pull as one: the gap between them counts as a
  // member too, so the edge runs straight past it instead of dipping in
  const solid = [...members];
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!.b;
      const b = members[j]!.b;
      const x0 = Math.max(a.x, b.x);
      const x1 = Math.min(a.x + a.w, b.x + b.w);
      const y0 = Math.max(a.y, b.y);
      const y1 = Math.min(a.y + a.h, b.y + b.h);
      // side by side (the rows overlap) or one above the other (the columns do)
      const bridge =
        y1 > y0 && x0 > x1 && x0 - x1 < BRIDGE_MAX ? { x: x1, y: y0, w: x0 - x1, h: y1 - y0 } : x1 > x0 && y0 > y1 && y0 - y1 < BRIDGE_MAX ? { x: x0, y: y1, w: x1 - x0, h: y0 - y1 } : undefined;
      if (bridge && !walls.some((o) => near(o, bridge, 0))) solid.push({ b: bridge, w: Math.min(members[i]!.w, members[j]!.w) });
    }
  for (const m of solid)
    splat(m.b.x - R_MEMBER, m.b.y - R_MEMBER, m.b.x + m.b.w + R_MEMBER, m.b.y + m.b.h + R_MEMBER, (x, y) => {
      const d = rectDist(x, y, m.b);
      return d < R_MEMBER ? m.w * (1 - d / R_MEMBER) ** 2 : 0;
    }, pull);
  for (const o of strangers)
    splat(o.b.x - R_OBST, o.b.y - R_OBST, o.b.x + o.b.w + R_OBST, o.b.y + o.b.h + R_OBST, (x, y) => {
      const d = rectDist(x, y, o.b);
      return d === 0 ? -2 * o.s : d < R_OBST ? -0.9 * o.s * (1 - d / R_OBST) ** 2 : 0;
    });
  for (let k = 0; k < v.length; k++) v[k]! += pull[k]!;
  return { i0, j0, nx, ny, v };
}

const at = (f: Field, i: number, j: number) => (i < f.i0 || j < f.j0 || i >= f.i0 + f.nx || j >= f.j0 + f.ny ? 0 : f.v[(j - f.j0) * f.nx + (i - f.i0)]!);
const overlap = (a: Field, b: Field) => a.i0 < b.i0 + b.nx && b.i0 < a.i0 + a.nx && a.j0 < b.j0 + b.ny && b.j0 < a.j0 + a.ny;

/** Spacing of a contour's points after resampling, and how far its smoothing reaches (σ of a Gaussian). */
const STEP = 8;
const SOFT = 20;
/** How far a smoothed contour turns between the points kept of it (radians). */
const TURN = 0.08;
const KERNEL = (() => {
  const n = Math.ceil((3 * SOFT) / STEP);
  const k = Array.from({ length: 2 * n + 1 }, (_, i) => Math.exp(-(((i - n) * STEP) ** 2) / (2 * SOFT * SOFT)));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map((x) => x / sum);
})();

/**
 * A closed ring (without its repeated last point) resampled evenly along its length and smoothed
 * with a Gaussian: the grid's polygon has its points at uneven distances, and where territories
 * meet its corners are kinked, which a spline through those points shows as dents and facets.
 */
function soften(ring: [number, number][]): [number, number][] {
  const n = ring.length;
  const acc = [0];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % n]!;
    acc.push(acc[i]! + len(bx - ax, by - ay));
  }
  const total = acc[n]!;
  const m = Math.round(total / STEP);
  if (m < KERNEL.length) return ring;
  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  for (let k = 0, i = 0; k < m; k++) {
    const s = (k * total) / m;
    while (acc[i + 1]! < s) i++;
    const t = (s - acc[i]!) / (acc[i + 1]! - acc[i]! || 1);
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % n]!;
    xs[k] = ax + t * (bx - ax);
    ys[k] = ay + t * (by - ay);
  }
  const h = (KERNEL.length - 1) / 2;
  const sx = new Float64Array(m);
  const sy = new Float64Array(m);
  for (let k = 0; k < m; k++)
    for (let j = 0; j < KERNEL.length; j++) {
      const q = (k + j - h + m) % m;
      sx[k]! += KERNEL[j]! * xs[q]!;
      sy[k]! += KERNEL[j]! * ys[q]!;
    }
  // along a straight edge one point does: keep one wherever the direction has turned enough since the last
  const out: [number, number][] = [[sx[0]!, sy[0]!]];
  let turn = 0;
  let dir = Math.atan2(sy[1]! - sy[0]!, sx[1]! - sx[0]!);
  for (let k = 1; k < m; k++) {
    const next = Math.atan2(sy[(k + 1) % m]! - sy[k]!, sx[(k + 1) % m]! - sx[k]!);
    turn += ((next - dir + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    dir = next;
    if (Math.abs(turn) > TURN) {
      out.push([sx[k]!, sy[k]!]);
      turn = 0;
    }
  }
  return out.length < 3 ? Array.from(sx, (x, k) => [x, sy[k]!] as [number, number]) : out;
}

/** `v` to one decimal, built from integers: turning a fraction into a string is several times slower. */
function r1(v: number): string {
  const q = Math.round(v * 10);
  const a = Math.abs(q);
  const s = `${(a - (a % 10)) / 10}${a % 10 ? `.${a % 10}` : ''}`;
  return q < 0 ? `-${s}` : s;
}
/** A closed ring as a smooth SVG path: a quadratic B-spline through the middles of its sides. */
function smooth(ring: [number, number][]): string {
  const n = ring.length;
  if (n < 3) return '';
  const [lx, ly] = ring[n - 1]!;
  const [fx, fy] = ring[0]!;
  const parts = [`M${r1((lx + fx) / 2)},${r1((ly + fy) / 2)}`];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % n]!;
    parts.push(`Q${r1(ax)},${r1(ay)} ${r1((ax + bx) / 2)},${r1((ay + by) / 2)}`);
  }
  return `${parts.join('')}Z`;
}

/** The contours of a group's field, less the strongest neighbour's wherever that one reaches. */
function territory(group: string, f: Field, rivals: Field[]): Territory {
  const { i0, j0, nx, ny } = f;
  const u = new Float64Array(f.v);
  for (const r of rivals) {
    const gx0 = Math.max(0, r.i0 - i0);
    const gx1 = Math.min(nx, r.i0 + r.nx - i0);
    const gy0 = Math.max(0, r.j0 - j0);
    const gy1 = Math.min(ny, r.j0 + r.ny - j0);
    for (let gy = gy0; gy < gy1; gy++)
      for (let gx = gx0; gx < gx1; gx++) {
        const k = gy * nx + gx;
        u[k] = Math.min(u[k]!, f.v[k]! - Math.max(0, at(r, i0 + gx, j0 + gy)));
      }
  }
  // d3 sorts the thresholds: the lower one, the territory's edge, comes first
  const [main, inner] = contours().size([nx, ny]).thresholds([T_AREA, T_INNER])(u as unknown as number[]);
  // a ring from d3 ends where it begins; ours do not
  const world = (mp: typeof main) =>
    mp!.coordinates.map((poly) => poly.map((ring) => soften(ring.slice(0, -1).map(([gx, gy]) => [(i0 + gx!) * CELL, (j0 + gy!) * CELL] as [number, number]))));
  const pieces = world(main);
  const path = (ps: [number, number][][][]) => ps.map((poly) => poly.map((ring) => smooth(ring)).join('')).join('');
  // the name sits in the largest piece
  let label: Pt | undefined;
  let best = 0;
  for (const poly of pieces) {
    const r = poly[0]!;
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < r.length; k++) {
      const [ax, ay] = r[k]!;
      const [bx, by] = r[(k + 1) % r.length]!;
      const c = ax * by - bx * ay;
      a += c;
      cx += (ax + bx) * c;
      cy += (ay + by) * c;
    }
    if (Math.abs(a) > best) {
      best = Math.abs(a);
      label = { x: cx / (3 * a), y: cy / (3 * a) };
    }
  }
  const area = best / 2;
  return { group, main: path(pieces), inner: path(world(inner)), pieces, ...(label ? { label } : {}), labelSize: Math.max(40, Math.min(80, Math.sqrt(area) / 11)) };
}

const key = (b: Bounds, w: number) => `${b.x},${b.y},${b.w},${b.h},${w.toFixed(3)}`;

/**
 * Computes territories, reusing what has not changed since the previous call: one per group with
 * a member, in the order of `groups`.
 */
export class Territories {
  private fields = new Map<string, { key: string; f: Field }>();
  private shapes = new Map<string, { key: string; t: Territory }>();
  /** How many fields and contours the last call computed; for measuring. */
  last = { fields: 0, contours: 0, ms: 0 };

  compute(claims: Claim[], groups: string[]): Territory[] {
    const t0 = performance.now();
    const last = { fields: 0, contours: 0, ms: 0 };
    const fields: { g: string; f: Field; key: string }[] = [];
    for (const g of groups) {
      const members = claims.flatMap((c) => ((c.w[g] ?? 0) > 0.01 ? [{ b: c.b, w: c.w[g]! }] : []));
      if (!members.length) continue;
      // strangers matter only within the members' reach
      const reach: Bounds = {
        x: Math.min(...members.map((m) => m.b.x)) - MARGIN,
        y: Math.min(...members.map((m) => m.b.y)) - MARGIN,
        w: 0,
        h: 0,
      };
      reach.w = Math.max(...members.map((m) => m.b.x + m.b.w)) + MARGIN - reach.x;
      reach.h = Math.max(...members.map((m) => m.b.y + m.b.h)) + MARGIN - reach.y;
      const strangers = claims.flatMap((c) => {
        const s = 1 - Math.min(1, c.w[g] ?? 0);
        return s > 0.01 && near(c.b, reach, R_OBST) ? [{ b: c.b, s }] : [];
      });
      const k = `${members.map((m) => key(m.b, m.w)).join(';')}|${strangers.map((o) => key(o.b, o.s)).join(';')}`;
      let cached = this.fields.get(g);
      if (cached?.key !== k) {
        cached = { key: k, f: field(members, strangers) };
        this.fields.set(g, cached);
        last.fields++;
      }
      fields.push({ g, f: cached.f, key: k });
    }
    const out = fields.map(({ g, f, key: own }) => {
      const rivals = fields.filter((r) => r.g !== g && overlap(f, r.f));
      const k = [own, ...rivals.map((r) => r.key)].join('#');
      let cached = this.shapes.get(g);
      if (cached?.key !== k) {
        cached = { key: k, t: territory(g, f, rivals.map((r) => r.f)) };
        this.shapes.set(g, cached);
        last.contours++;
      }
      return cached.t;
    });
    const live = new Set(fields.map((x) => x.g));
    for (const g of this.fields.keys()) if (!live.has(g)) (this.fields.delete(g), this.shapes.delete(g));
    last.ms = performance.now() - t0;
    this.last = last;
    return out;
  }
}

/** Whether `p` lies in the territory (even-odd over all its rings). */
export function within(t: Pick<Territory, 'pieces'>, p: Pt): boolean {
  let c = false;
  for (const poly of t.pieces)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[i]!;
        const [bx, by] = ring[j]!;
        if (ay > p.y !== by > p.y && p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) c = !c;
      }
  return c;
}
