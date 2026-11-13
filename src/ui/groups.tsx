// Groups on the canvas: the territories behind the cards and their names, how a territory grows
// when cards change group (here, by voice or in another page alike), and the lasso and colour ring
// that assign a group.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type Bounds, centre, shapeOf } from '../core/layout';
import type { Group, Item } from '../core/types';
import { titleFrom } from '../core/card';
import { plain } from './markdown';
import { t } from './strings';
import { FAR } from './camera';
import { type Claim, type NameSpot, placeName, ringBounds, type Territory, Territories } from './territory';

type Placed = { item: Item; b: Bounds }[];
type Pt = { x: number; y: number };

/** How long a card takes to grow into its new group, once its turn in the wave has come. */
const GROW_MS = 1100;
/** The wave reaches the cards one after the other, by their distance from where it starts (ms per world px). */
const WAVE_SPEED = 0.9;
const WAVE_MAX_DELAY = 900;
/** How long a wave and the light along the edge are shown, after their delay. */
const WAVE_MS = 1700;
/** A computation of the territories longer than this makes the next one wait (ms). */
const SLOW_MS = 8;

interface Fade {
  from?: string;
  to?: string;
  t0: number;
  delay: number;
}
export interface Wave {
  key: number;
  x: number;
  y: number;
  hue: number;
  delay: number;
}
/** A light running once along the edge of a territory that cards came into. */
export interface Streak {
  key: number;
  group: string;
  delay: number;
}
export interface Shape {
  g: Group;
  t: Territory;
}

/** Where the owner just assigned a group: the change grows from there once the server has it. */
let origin: { ids: Set<string>; at: Pt; until: number } | null = null;
export function growFrom(ids: string[], at: Pt) {
  origin = { ids: new Set(ids), at, until: performance.now() + 5000 };
}

/** Springs past 1 a little and settles: the territory grows a bit too far and draws back. */
const spring = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.exp(-5 * x) * Math.cos(9 * x));

let effectKey = 0;

/**
 * The territories of the groups behind the cards on the canvas (a project counts as one card, its
 * workstreams inside), animated while cards change group.
 */
export function useTerritories(placed: Placed, groups: Group[]): { shapes: Shape[]; waves: Wave[]; streaks: Streak[] } {
  const [engine] = useState(() => new Territories());
  const [fades] = useState(() => new Map<string, Fade>());
  // groups seen so far: one that went with its last card still fades out in its colour
  const [known] = useState(() => new Map<string, Group>());
  for (const g of groups) known.set(g.id, g);
  const seen = useRef<Map<string, string | undefined> | null>(null);
  const [fx, setFx] = useState<{ waves: Wave[]; streaks: Streak[] }>({ waves: [], streaks: [] });
  const [tick, setTick] = useState(0);
  const top = useMemo(() => placed.filter((p) => !p.item.parent), [placed]);

  const signature = top.map((p) => `${p.item.id}:${p.item.group ?? ''}`).join(',');
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = new Map(top.map((p) => [p.item.id, p.item.group]));
    // what the page loads with is there at once
    if (!before) return;
    const changed = top.filter((p) => before.get(p.item.id) !== p.item.group);
    if (!changed.length) return;
    const now = performance.now();
    const mine = origin && origin.until > now && changed.some((p) => origin!.ids.has(p.item.id));
    const centres = changed.map((p) => centre(p.b));
    const from = mine ? origin!.at : { x: centres.reduce((s, c) => s + c.x, 0) / centres.length, y: centres.reduce((s, c) => s + c.y, 0) / centres.length };
    if (mine) origin = null;
    const waves: Wave[] = [];
    const streaks = new Map<string, Streak>();
    let last = 0;
    changed.forEach((p, n) => {
      const c = centres[n]!;
      const delay = Math.min(WAVE_MAX_DELAY, Math.hypot(c.x - from.x, c.y - from.y) * WAVE_SPEED);
      const to = p.item.group;
      fades.set(p.item.id, { from: before.get(p.item.id), to, t0: now, delay });
      last = Math.max(last, delay);
      const g = to ? known.get(to) : undefined;
      if (!g) return;
      waves.push({ key: ++effectKey, ...c, hue: g.hue, delay });
      const s = streaks.get(g.id);
      if (!s || s.delay > delay) streaks.set(g.id, { key: ++effectKey, group: g.id, delay: delay + 250 });
    });
    const added = new Set([...waves.map((w) => w.key), ...[...streaks.values()].map((s) => s.key)]);
    setFx((f) => ({ waves: [...f.waves, ...waves], streaks: [...f.streaks, ...streaks.values()] }));
    setTimeout(
      () => setFx((f) => ({ waves: f.waves.filter((w) => !added.has(w.key)), streaks: f.streaks.filter((s) => !added.has(s.key)) })),
      last + WAVE_MS + 300,
    );
    setTick((n) => n + 1);
  }, [signature]);

  // while cards grow, every frame; at rest, nothing
  useEffect(() => {
    if (!fades.size) return;
    const frame = requestAnimationFrame(() => {
      const now = performance.now();
      for (const [id, f] of fades) if (now - f.t0 - f.delay > GROW_MS) fades.delete(id);
      setTick((n) => n + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [tick]);

  // a computation that took long leaves the next frames to the cards: the territories follow a dragged
  // card a little less often, and catch up once it rests
  const last = useRef<{ at: number; shapes: Shape[]; later?: ReturnType<typeof setTimeout> }>({ at: -Infinity, shapes: [] });
  const shapes = useMemo(() => {
    const now = performance.now();
    const pause = engine.last.ms > SLOW_MS ? engine.last.ms * 1.5 : 0;
    clearTimeout(last.current.later);
    if (now - last.current.at < pause) {
      last.current.later = setTimeout(() => setTick((n) => n + 1), pause - (now - last.current.at));
      return last.current.shapes;
    }
    const fading = new Set<string>();
    const claims: Claim[] = top.map(({ item, b }) => {
      const f = fades.get(item.id);
      if (!f) return { id: item.id, b, w: item.group ? { [item.group]: 1 } : {} };
      const p = spring((now - f.t0 - f.delay) / GROW_MS);
      const w: Record<string, number> = {};
      if (f.to) w[f.to] = p;
      if (f.from) (w[f.from] = Math.max(0, 1 - p)), fading.add(f.from);
      return { id: item.id, b, w };
    });
    const ids = [...groups.map((g) => g.id), ...[...fading].filter((id) => !groups.some((g) => g.id === id) && known.has(id))];
    const shapes = engine.compute(claims, ids).map((x) => ({ g: known.get(x.group)!, t: x }));
    last.current = { at: now, shapes };
    return shapes;
  }, [top, groups, tick]);
  useEffect(() => () => clearTimeout(last.current.later), []);

  return { shapes, ...fx };
}

const hue = (h: number) => ({ '--h': h }) as React.CSSProperties;

/** The territories, in world coordinates under the cards; `selected`: the cards the colour ring is for. */
export function TerritoryLayer({ shapes, waves, streaks, selected }: { shapes: Shape[]; waves: Wave[]; streaks: Streak[]; selected: Bounds[] }) {
  return (
    <svg id="territories" width="1" height="1">
      {shapes.map(({ g, t: x }) => (
        <g key={g.id} className="terr" style={hue(g.hue)}>
          <path className="area" d={x.main} fillRule="evenodd" />
          <path className="glow" d={x.main} />
          <path className="edge" d={x.main} />
          <path className="inner" d={x.inner} />
          {streaks
            .filter((s) => s.group === g.id)
            .map((s) => (
              <path key={s.key} className="streak" d={x.main} pathLength={100} style={{ animationDelay: `${s.delay}ms` }} />
            ))}
        </g>
      ))}
      {waves.map((w) => (
        <circle key={w.key} className="wave" cx={w.x} cy={w.y} style={{ ...hue(w.hue), animationDelay: `${w.delay}ms` }} />
      ))}
      {selected.map((b, n) => (
        <rect key={n} className="sel" x={b.x - 7} y={b.y - 7} width={b.w + 14} height={b.h + 14} rx={4} />
      ))}
    </svg>
  );
}

/** A group's name closer in than FAR, in screen px; far out it is the territory's `labelSize`. */
const NEAR_PX = 13;
/** The two looks of a name, as `.gname.far` and `.gname.near` draw them: weight and letter spacing (em). */
const LOOK = { far: { weight: 800, spacing: 0.14 }, near: { weight: 700, spacing: 0.12 } } as const;
type Look = keyof typeof LOOK;
/** The height of the font's capitals, in em. */
const CAPS = 0.7;
/** Zoomed far out a task card shows only its title, from this far below its top, up to three lines of this height (world px, as `.z-far .card` sets them). */
const FAR_TITLE = { top: 18, line: 26 * 1.1, lines: 3, font: '600 100px Newsreader, Georgia, serif' };
/**
 * The names are placed anew once the zoom has changed by this factor, not on every frame of a
 * zoom: each for the smallest zoom of its step, where it is largest in the world, so that drawn at
 * any zoom within the step it covers no more than the box it was placed in.
 */
const STEP = 1.06;
const stepOf = (s: number) => Math.floor(Math.log(s) / Math.log(STEP));

/** Widths of texts in a font, in em, measured once. */
const widths = new Map<string, number>();
let canvas: CanvasRenderingContext2D | null | undefined;
function emWidth(text: string, font: string) {
  const k = `${font}|${text}`;
  let w = widths.get(k);
  if (w === undefined) {
    canvas ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    if (canvas) {
      canvas.font = font;
      w = canvas.measureText(text).width / 100;
    } else w = text.length * 0.6;
    widths.set(k, w);
  }
  return w;
}
let family: string | undefined;
const nameFont = (weight: number) => {
  family ??= (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue('--cond').trim()) || 'sans-serif';
  return `${weight} 100px ${family}`;
};

/** The part of a card its title takes zoomed far out (a project's or chip's: its top 45 %). */
function titleStrip(item: Item, b: Bounds): Bounds {
  if (shapeOf(item) !== 'task') return { ...b, h: b.h * 0.45 };
  const title = item.title ? plain(item.title) : titleFrom(item.body) || t.titlePlaceholder;
  const lines = Math.max(1, Math.min(FAR_TITLE.lines, Math.ceil((emWidth(title, FAR_TITLE.font) * 26 * 1.05) / (b.w - 28))));
  return { ...b, h: Math.min(b.h, FAR_TITLE.top + lines * FAR_TITLE.line + 4) };
}

/** The title strips of every card on the canvas, a project's workstreams included, which a name far out stays off where it can. */
export const titleStrips = (placed: Placed) => placed.map((p) => titleStrip(p.item, p.b));

/** Where a name stands (`box`, the box it was placed in, in world px) and its size drawn now. */
export type NameAt = NameSpot & { font: number };
export interface Named {
  g: Group;
  far?: NameAt;
  near?: NameAt;
}

/** What the names keep clear of: the cards and notes on the canvas, and the cards' title strips far out. */
export interface Ground {
  shapes: Shape[];
  cards: Bounds[];
  strips: Bounds[];
}
type Memo = Map<string, { key: string; spot: NameSpot }>;

/** A number for each ring, so that a key can tell whether a territory's outline is still the same. */
const ringIds = new WeakMap<object, number>();
let ringCount = 0;
const ringId = (r: object | undefined) => {
  if (!r) return 0;
  let n = ringIds.get(r);
  if (n === undefined) ringIds.set(r, (n = ++ringCount));
  return n;
};
const near = (b: Bounds, r: Bounds) => b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h;
const sig = (bs: Bounds[]) => bs.map((b) => `${b.x},${b.y},${b.w},${b.h}`).join(';');

/**
 * The names of all groups in `look` at zoom step `step`, one after the other, each clear of the
 * ones before it. A name is placed anew only where what is around it changed (with `memo`, which
 * also holds where it stood, so it holds still while cards move past it): a card dragged moves
 * the names near it, not all of them.
 */
export function placeAll({ shapes, cards, strips }: Ground, look: Look, step: number, memo?: Memo): Map<string, NameSpot> {
  const out = new Map<string, NameSpot>();
  const placed: Bounds[] = [];
  const font = (look === 'far' ? 1 : NEAR_PX) / STEP ** step;
  const others = shapes.flatMap(({ g, t: x }) => x.pieces.map((p) => ({ g: g.id, ring: p[0]!, b: ringBounds(p[0]!) })));
  for (const { g, t: x } of shapes) {
    if (!x.outline) continue;
    const px = look === 'far' ? x.labelSize * font : font;
    const { weight, spacing } = LOOK[look];
    const w = (emWidth(g.name.toUpperCase(), nameFont(weight)) + spacing * (g.name.length - 1)) * px;
    const h = CAPS * px;
    // only what lies within reach of the outline matters to it
    const ob = ringBounds(x.outline);
    const reach = w + 2 * h;
    const region = { x: ob.x - reach, y: ob.y - reach, w: ob.w + 2 * reach, h: ob.h + 2 * reach };
    const localCards = cards.filter((c) => near(c, region));
    const localStrips = look === 'far' ? strips.filter((c) => near(c, ob)) : undefined;
    const names = placed.filter((c) => near(c, region));
    const theirs = others.filter((o) => o.g !== g.id && near(o.b, region));
    const key = [step, w.toFixed(1), ringId(x.outline), ringId(x.holes), sig(localCards), sig(localStrips ?? []), sig(names), theirs.map((o) => ringId(o.ring)).join(',')].join('|');
    const id = `${g.id}:${look}`;
    const known = memo?.get(id);
    let spot = known?.key === key ? known.spot : undefined;
    if (!spot) {
      spot = placeName(x.outline, { w, h }, localCards, {
        ...(localStrips ? { strips: localStrips } : {}),
        ...(known ? { prev: known.spot } : {}),
        ...(x.holes ? { holes: x.holes } : {}),
        names,
        areas: theirs.map((o) => o.ring),
      });
      memo?.set(id, { key, spot });
    }
    out.set(g.id, spot);
    if (!spot.covered) placed.push(spot.box);
  }
  return out;
}

/**
 * Where each group's name stands at zoom `s` (see `placeName`): along its territory's edge where
 * no card (nor note, `notes`), other name or other territory covers it, far out with the last
 * resort over its cards below their titles. Only the look shown at `s` is placed; the other keeps
 * where it stood while it fades out. `boxesAt` tells where the names would stand at another
 * zoom, for a camera that frames the canvas.
 */
export function useGroupNames(shapes: Shape[], placed: Placed, notes: Bounds[], s: number): { names: Named[]; boxesAt: (s: number) => Bounds[] } {
  const memo = useRef<Memo>(new Map());
  const shown = useRef(new Map<string, { far?: NameSpot; near?: NameSpot }>());
  // widths measured before the fonts came are measured again once they are there
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (!live) return;
      widths.clear();
      family = undefined;
      memo.current.clear();
      setFonts((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  // what a name keeps clear of: the cards and the notes on the canvas; far out the titles of all cards, workstreams included
  const cards = useMemo(() => [...placed.filter((p) => !p.item.parent).map((p) => p.b), ...notes], [placed, notes]);
  const strips = useMemo(() => titleStrips(placed), [placed, fonts]);
  const look: Look = s < FAR ? 'far' : 'near';
  const step = stepOf(s);
  const spots = useMemo(() => {
    const now = placeAll({ shapes, cards, strips }, look, step, memo.current);
    const ids = new Set(shapes.map(({ g }) => g.id));
    for (const id of [...shown.current.keys()]) if (!ids.has(id)) shown.current.delete(id);
    for (const { g } of shapes) shown.current.set(g.id, { ...shown.current.get(g.id), [look]: now.get(g.id) });
    for (const id of [...memo.current.keys()]) if (!ids.has(id.slice(0, id.lastIndexOf(':')))) memo.current.delete(id);
    return new Map(shown.current);
  }, [shapes, cards, strips, look, step]);
  const names = shapes.map(({ g, t: x }) => {
    const at = spots.get(g.id);
    return {
      g,
      ...(at?.far ? { far: { ...at.far, font: x.labelSize / s } } : {}),
      ...(at?.near ? { near: { ...at.near, font: NEAR_PX / s } } : {}),
    };
  });
  const boxesAt = (to: number) => [...placeAll({ shapes, cards, strips }, to < FAR ? 'far' : 'near', stepOf(to)).values()].map((p) => p.box);
  return { names, boxesAt };
}

/** One name, centred in the box it was placed in; the letter spacing after the last letter is left out of the centring. */
function NameText({ g, at, look }: { g: Group; at: NameAt; look: Look }) {
  const { box, font } = at;
  return (
    <text className={`gname ${look}`} x={box.x + box.w / 2 + (LOOK[look].spacing * font) / 2} y={box.y + box.h / 2 + (CAPS * font) / 2} style={{ ...hue(g.hue), fontSize: font }}>
      {g.name}
    </text>
  );
}

/**
 * The groups' names under the cards, over the territories: far out pale and large, closer in small
 * in the group's colour, cross-fading at FAR; `over`: the names far out that stand inside their
 * territory, drawn over the cards.
 */
export function GroupNames({ names, over }: { names: Named[]; over?: boolean }) {
  return (
    <svg id={over ? 'gnames-over' : 'gnames'} width="1" height="1">
      {names.flatMap(({ g, far, near }) => [
        far && (far.side === 'inside') === !!over && <NameText key={`${g.id}:far`} g={g} at={far} look="far" />,
        !over && near && <NameText key={`${g.id}:near`} g={g} at={near} look="near" />,
      ])}
    </svg>
  );
}

// ------------------------------------------------------------------ lasso

/** The lasso the owner draws with Shift held, in screen coordinates. */
export function Lasso({ pts }: { pts: Pt[] }) {
  if (pts.length < 2) return null;
  const d = `M${pts.map((p) => `${p.x},${p.y}`).join('L')}Z`;
  const head = pts[pts.length - 1]!;
  return (
    <svg id="lasso">
      <path className="lfill" d={d} />
      <path className="lglow" d={d} />
      <path className="lline" d={d} />
      <circle className="lhead" cx={head.x} cy={head.y} r={5} />
    </svg>
  );
}

// ------------------------------------------------------------------ marked cards

/** Three colour balls, as in the ring. */
const RingIcon = () => (
  <svg className="ricon" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    {[200, 30, 140].map((h, n) => (
      <circle key={h} cx={8 + 4.6 * Math.sin((n * 2 * Math.PI) / 3)} cy={8.6 - 4.6 * Math.cos((n * 2 * Math.PI) / 3)} r={3} style={hue(h)} />
    ))}
  </svg>
);

/**
 * Over the top right corner of what is marked (`at`, screen; `below` its bottom right one): how many, the button that opens the
 * colour ring for them and, until the owner has once moved several together, how that goes.
 */
export function Marked({ at, below, count, hint, onGroup }: { at: Pt; below: boolean; count: number; hint: boolean; onGroup: (at: Pt) => void }) {
  return (
    <div id="marked" className={below ? 'below' : undefined} style={{ left: at.x, top: at.y }}>
      <div className="mrow">
        <span className="mcount">{t.marked.count(count)}</span>
        <button
          className="mgroup"
          title={t.marked.groupTip}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onGroup({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }}
        >
          <RingIcon />
          {t.marked.group}
        </button>
      </div>
      {hint && <p className="mhint">{t.marked.move}</p>}
    </div>
  );
}

/** After the owner moved a single card, until they have once marked cards: how to move several at once, at `at` (screen). */
export function MarkHint({ at }: { at: Pt }) {
  return (
    <p id="markhint" style={{ left: at.x, top: at.y }}>
      {t.marked.howTo}
    </p>
  );
}

/** Whether `p` lies inside the polygon. */
export function inside(p: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// ------------------------------------------------------------------ colour ring

type Ball = { kind: 'group'; g: Group } | { kind: 'new' } | { kind: 'none' };
const RADIUS = 84;
/** Where a group's name starts, out from the middle: just past its ball, also when that is picked and grows. */
const LABEL_RADIUS = 124;
/** How wide a group's name gets before it ends in "…" (the full name shows on hover). */
const LABEL_MAX = 140;
const RING_MARGIN = 120;

/**
 * A ring of colour balls around `at` (screen): the groups, each with its name and how many of its
 * cards are still to be done beside it, a new one, none. Moving towards a ball or onto its name picks it, a click takes it; a new group asks for its
 * name first. The picked group's name carries a × that deletes the group.
 */
export function Ring({
  at: pointer,
  count,
  groups,
  open: openCards,
  onPick,
  onCreate,
  onDelete,
  onClose,
}: {
  at: Pt;
  count: number;
  groups: Group[];
  /** How many cards of each group are still to be done. */
  open: Map<string, number>;
  onPick: (group: string | null) => void;
  onCreate: (name: string) => void;
  onDelete: (group: Group) => void;
  onClose: () => void;
}) {
  // the ring stays clear of the screen's edges and the bar, the groups' names with it
  const mx = groups.length ? LABEL_RADIUS + LABEL_MAX : RING_MARGIN;
  const my = groups.length ? LABEL_RADIUS + 24 : RING_MARGIN;
  const at = { x: Math.min(Math.max(pointer.x, mx), innerWidth - mx), y: Math.min(Math.max(pointer.y, my + 50), innerHeight - my) };
  const balls: Ball[] = [...groups.map((g) => ({ kind: 'group' as const, g })), { kind: 'new' }, { kind: 'none' }];
  const [hot, setHot] = useState(-1);
  const [naming, setNaming] = useState(false);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const angle = (k: number) => -Math.PI / 2 + (k * 2 * Math.PI) / balls.length;
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    // Escape closes the ring before anything else hears it
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    addEventListener('keydown', key, true);
    return () => (cancelAnimationFrame(frame), removeEventListener('keydown', key, true));
  }, []);
  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);
  /** The ball in the direction of the pointer; none near the middle. */
  function aimed(e: React.PointerEvent): number {
    const dx = e.clientX - at.x;
    const dy = e.clientY - at.y;
    if (Math.hypot(dx, dy) < 30) return -1;
    const a = Math.atan2(dy, dx);
    let best = 0;
    let bd = Infinity;
    balls.forEach((_, k) => {
      const d = Math.abs(Math.atan2(Math.sin(a - angle(k)), Math.cos(a - angle(k))));
      if (d < bd) [bd, best] = [d, k];
    });
    return best;
  }
  // a click picks where it is, also when no move came before it
  function pick(k: number) {
    const b = balls[k];
    if (!b) return onClose();
    if (b.kind === 'new') return setNaming(true);
    onPick(b.kind === 'group' ? b.g.id : null);
  }
  const hb = balls[hot];
  const caption = naming ? '' : !hb ? t.groups.cards(count) : hb.kind === 'group' ? hb.g.name : hb.kind === 'new' ? t.groups.create : t.groups.none;
  return (
    <div id="ringback" onPointerMove={(e) => naming || setHot(aimed(e))} onPointerDown={(e) => (e.preventDefault(), naming ? onClose() : pick(aimed(e)))} onContextMenu={(e) => e.preventDefault()}>
      <div className={`ring${open ? ' open' : ''}`} style={{ left: at.x, top: at.y }}>
        <div className="rhalo" />
        {balls.map((b, k) => (
          <div
            key={b.kind === 'group' ? b.g.id : b.kind}
            className={`ball ${b.kind}${k === hot ? ' hot' : ''}`}
            aria-label={b.kind === 'group' ? b.g.name : b.kind === 'new' ? t.groups.create : t.groups.none}
            style={
              {
                '--h': b.kind === 'group' ? b.g.hue : 0,
                '--bx': `${Math.cos(angle(k)) * RADIUS}px`,
                '--by': `${Math.sin(angle(k)) * RADIUS}px`,
                transitionDelay: `${k * 28}ms`,
              } as React.CSSProperties
            }
          >
            {b.kind === 'new' ? '+' : b.kind === 'none' ? '∅' : ''}
          </div>
        ))}
        {balls.map(
          (b, k) =>
            b.kind === 'group' && (
              // the name stands outside its ball, turned away from the middle
              <div
                key={`n-${b.g.id}`}
                className={`gtag${k === hot ? ' hot' : ''}${openCards.get(b.g.id) ? '' : ' vacant'}`}
                title={b.g.name}
                style={
                  {
                    '--h': b.g.hue,
                    maxWidth: LABEL_MAX,
                    left: Math.cos(angle(k)) * LABEL_RADIUS,
                    top: Math.sin(angle(k)) * LABEL_RADIUS,
                    transform: `translate(${((Math.cos(angle(k)) - 1) / 2) * 100}%, ${((Math.sin(angle(k)) - 1) / 2) * 100}%)`,
                    transitionDelay: `${k * 28 + 80}ms`,
                  } as React.CSSProperties
                }
                onPointerMove={(e) => (e.stopPropagation(), naming || setHot(k))}
                onPointerDown={(e) => (e.preventDefault(), e.stopPropagation(), naming ? onClose() : pick(k))}
              >
                <span>{b.g.name}</span>
                {k === hot && !naming && (
                  <button
                    className="gdel"
                    title={t.groups.remove}
                    aria-label={t.groups.remove}
                    onPointerDown={(e) => (e.preventDefault(), e.stopPropagation(), onDelete(b.g))}
                  >
                    ×
                  </button>
                )}
                <b className="gcount" title={t.groups.open(openCards.get(b.g.id) ?? 0)}>
                  {openCards.get(b.g.id) ?? 0}
                </b>
              </div>
            ),
        )}
        <div className="rcap">{caption}</div>
        {naming && (
          <input
            ref={input}
            className="rname"
            placeholder={t.groups.name}
            maxLength={60}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // typing, Space included, is for the name, not push-to-talk or the canvas's keys
              e.stopPropagation();
              const name = e.currentTarget.value.trim();
              if (e.key === 'Enter' && name) onCreate(name);
            }}
          />
        )}
      </div>
    </div>
  );
}
